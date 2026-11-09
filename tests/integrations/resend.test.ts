// Resend adapter: request shape, idempotency header and error mapping. The fetch is
// injected, so no request leaves the process.
import { describe, expect, it, vi } from "vitest";
import { ResendEmailProvider, formatFrom } from "@/lib/providers/resend";
import {
  OutgoingEmail,
  ProviderAmbiguousError,
  ProviderRefusedError,
} from "@/lib/providers/types";

const API_KEY = "re_test_key_do_not_use";

function email(overrides: Partial<OutgoingEmail> = {}): OutgoingEmail {
  return {
    from: { name: "Ada Books", address: "billing@invoices.example.test" },
    replyTo: "ada@studio.example.test",
    to: "client@acme.example.test",
    cc: ["accounts@acme.example.test"],
    subject: "Invoice INV-1001 is due",
    text: "Hello,\n\nInvoice INV-1001 is due on 8 Nov 2026.",
    idempotencyKey: "sm-0001",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ResendEmailProvider.send", () => {
  it("posts a plain-text message and returns the provider id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "re_123" }));
    const provider = new ResendEmailProvider({ apiKey: API_KEY, fetch: fetchMock as unknown as typeof fetch });

    const result = await provider.send(email());

    expect(result).toEqual({ providerMessageId: "re_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["Idempotency-Key"]).toBe("sm-0001");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      from: "Ada Books <billing@invoices.example.test>",
      to: ["client@acme.example.test"],
      cc: ["accounts@acme.example.test"],
      reply_to: "ada@studio.example.test",
      subject: "Invoice INV-1001 is due",
      text: "Hello,\n\nInvoice INV-1001 is due on 8 Nov 2026.",
    });
    expect(body).not.toHaveProperty("html");
  });

  it("omits cc when there are none", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "re_9" }));
    const provider = new ResendEmailProvider({ apiKey: API_KEY, fetch: fetchMock as unknown as typeof fetch });
    await provider.send(email({ cc: [] }));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty("cc");
  });

  it("sends the same idempotency key on a retry of the same scheduled message", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["Idempotency-Key"]);
      return jsonResponse(200, { id: "re_same" });
    });
    const provider = new ResendEmailProvider({ apiKey: API_KEY, fetch: fetchMock as unknown as typeof fetch });
    await provider.send(email({ idempotencyKey: "sm-42" }));
    await provider.send(email({ idempotencyKey: "sm-42" }));
    expect(seen).toEqual(["sm-42", "sm-42"]);
  });

  it("maps a 422 to ProviderRefusedError without leaking the key or the recipient", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(422, { name: "validation_error", message: "to: client@acme.example.test is invalid" }),
    );
    const provider = new ResendEmailProvider({ apiKey: API_KEY, fetch: fetchMock as unknown as typeof fetch });

    const err = await provider.send(email()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRefusedError);
    expect((err as Error).message).toContain("422");
    expect((err as Error).message).not.toContain(API_KEY);
    expect((err as Error).message).not.toContain("client@acme.example.test");
  });

  it.each([
    ["408", 408],
    ["429", 429],
    ["500", 500],
    ["503", 503],
  ])("maps HTTP %s to ProviderAmbiguousError", async (_label, status) => {
    const fetchMock = vi.fn(async () => jsonResponse(status, { name: "application_error" }));
    const provider = new ResendEmailProvider({ apiKey: API_KEY, fetch: fetchMock as unknown as typeof fetch });
    await expect(provider.send(email())).rejects.toBeInstanceOf(ProviderAmbiguousError);
  });

  it("maps a timeout to ProviderAmbiguousError", async () => {
    // Honour the abort signal the way fetch does: reject with the signal's reason.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const provider = new ResendEmailProvider({
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 20,
    });
    await expect(provider.send(email())).rejects.toBeInstanceOf(ProviderAmbiguousError);
  });

  it("maps a connection reset after the request left to ProviderAmbiguousError", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    });
    const provider = new ResendEmailProvider({ apiKey: API_KEY, fetch: fetchMock as unknown as typeof fetch });
    await expect(provider.send(email())).rejects.toBeInstanceOf(ProviderAmbiguousError);
  });

  it("maps a refused connection, where nothing was sent, to ProviderRefusedError", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });
    const provider = new ResendEmailProvider({ apiKey: API_KEY, fetch: fetchMock as unknown as typeof fetch });
    await expect(provider.send(email())).rejects.toBeInstanceOf(ProviderRefusedError);
  });

  it("treats a 2xx with no message id as ambiguous, because the message may have gone out", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const provider = new ResendEmailProvider({ apiKey: API_KEY, fetch: fetchMock as unknown as typeof fetch });
    await expect(provider.send(email())).rejects.toBeInstanceOf(ProviderAmbiguousError);
  });

  it("refuses to send from a no-reply address and never calls the network", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "re_x" }));
    const provider = new ResendEmailProvider({ apiKey: API_KEY, fetch: fetchMock as unknown as typeof fetch });
    await expect(
      provider.send(email({ from: { name: "Ada", address: "no-reply@invoices.example.test" } })),
    ).rejects.toBeInstanceOf(ProviderRefusedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an API key", () => {
    expect(() => new ResendEmailProvider({ apiKey: "" })).toThrow(/API key/);
  });
});

describe("formatFrom", () => {
  it("uses a plain display name when it is safe", () => {
    expect(formatFrom({ name: "Ada Books", address: "billing@invoices.example.test" })).toBe(
      "Ada Books <billing@invoices.example.test>",
    );
  });

  it("quotes display names with punctuation and escapes quotes and backslashes", () => {
    expect(formatFrom({ name: 'Smith, "Ada" \\ Co', address: "a@x.example.test" })).toBe(
      '"Smith, \\"Ada\\" \\\\ Co" <a@x.example.test>',
    );
  });

  it("drops line breaks from the display name", () => {
    expect(formatFrom({ name: "Ada\r\nBcc: victim@x", address: "a@x.example.test" })).not.toMatch(/[\r\n]/);
  });

  it("falls back to the bare address when the name is empty", () => {
    expect(formatFrom({ name: "  ", address: "a@x.example.test" })).toBe("a@x.example.test");
  });
});
