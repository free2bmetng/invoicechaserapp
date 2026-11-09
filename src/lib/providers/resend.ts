// Resend transactional email adapter. One POST per message, plain text only.
// Error mapping follows the provider contract in ./types.ts:
//   - definitely not accepted (4xx other than 408/429, connection never opened) -> ProviderRefusedError
//   - outcome unknown (408, 429, 5xx, timeout, dropped connection, unreadable 2xx) -> ProviderAmbiguousError
import {
  EmailProvider,
  OutgoingEmail,
  ProviderAmbiguousError,
  ProviderRefusedError,
  SendResult,
} from "./types";

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 10_000;

// Codes that mean the TCP connection or DNS lookup failed before any request was sent.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND"]);

export interface ResendOptions {
  apiKey: string;
  // Injected in tests so no network call is made.
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend" as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ResendOptions) {
    if (!opts.apiKey) throw new Error("Resend API key is required");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const from = formatFrom(email.from);

    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [email.to],
          cc: email.cc.length > 0 ? email.cc : undefined,
          reply_to: email.replyTo,
          subject: email.subject,
          text: email.text,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const status = response.status;
    if (status >= 200 && status < 300) {
      const providerMessageId = await readAcceptedId(response);
      return { providerMessageId };
    }

    const errorName = await readErrorName(response);
    const detail = errorName ? `${status} ${errorName}` : String(status);
    if (status === 408 || status === 429 || status >= 500) {
      throw new ProviderAmbiguousError(`Resend returned HTTP ${detail}; outcome unknown`);
    }
    if (status >= 400) {
      throw new ProviderRefusedError(`Resend refused the message (HTTP ${detail})`);
    }
    throw new ProviderAmbiguousError(`Resend returned unexpected HTTP ${detail}`);
  }
}

// Builds the RFC 5322 "Name <address>" form. Refuses no-reply senders outright.
export function formatFrom(from: { name: string; address: string }): string {
  const address = from.address.trim();
  if (!address.includes("@")) {
    throw new ProviderRefusedError("From address is not a valid email address");
  }
  if (/^(no-?reply|do-?not-?reply)@/i.test(address)) {
    throw new ProviderRefusedError("Refusing to send from a no-reply address");
  }
  const name = from.name.replace(/[\r\n]+/g, " ").trim();
  if (name === "") return address;
  if (/^[A-Za-z0-9 ._-]+$/.test(name)) return `${name} <${address}>`;
  const quoted = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${quoted}" <${address}>`;
}

async function readAcceptedId(response: Response): Promise<string> {
  // A 2xx whose body we cannot read means the message may have been accepted,
  // so the outcome is unknown and the caller must not resend.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProviderAmbiguousError("Resend accepted the request but returned an unreadable body");
  }
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id === "") {
    throw new ProviderAmbiguousError("Resend accepted the request but returned no message id");
  }
  return id;
}

async function readErrorName(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { name?: unknown };
    return typeof body?.name === "string" && body.name.length <= 64 ? body.name : null;
  } catch {
    return null;
  }
}

function classifyNetworkError(err: unknown): Error {
  const name = (err as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new ProviderAmbiguousError("Resend request timed out; outcome unknown");
  }
  if (errorCodes(err).some((code) => NOT_SENT_CODES.has(code))) {
    return new ProviderRefusedError("Could not connect to Resend; the message was not sent");
  }
  return new ProviderAmbiguousError("Resend request failed after it may have been sent; outcome unknown");
}

// fetch() wraps socket errors in a TypeError whose cause carries the errno code.
function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}
