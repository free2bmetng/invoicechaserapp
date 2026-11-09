// Daily digest (spec 3.7). One email to the user's login address at digest_hour in the user's
// timezone. It lists the Needs you items and the messages planned in the next 24 hours. It goes
// out only when there is something to report, once per local day, and it is not subject to the
// send window or the daily cap.
//
// Once-per-day: the digests row for (user, local date) is claimed before the send. A refused
// send releases the claim, so a later run in the same hour retries. An ambiguous send keeps the
// claim, so a digest is never sent twice. A crash between the claim and the send loses that
// day's digest, which is the accepted trade-off.
import { DateTime } from "luxon";
import type { Clock } from "@/lib/clock";
import { withService } from "@/lib/db";
import { listNeedsYou, listNextSevenDays, type NeedsYouItem, type UpcomingMessage } from "@/lib/engine";
import { formatMoney } from "@/lib/money";
import {
  ProviderAmbiguousError,
  type EmailProvider,
  type OutgoingEmail,
} from "@/lib/providers/types";
import { FOOTER_LINES, isSenderProfileComplete } from "@/lib/templates";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCALE = "en-GB";
const FROM_LOCAL_PART = "digests";

export interface DigestDeps {
  clock: Clock;
  appUrl: string;
  emailFor(userId: string): Promise<EmailProvider>;
}

export interface DigestResult {
  sent: number;
  skipped: number;
  failed: number;
  skips: Array<{ userId: string; reason: string }>;
  errors: Array<{ userId: string; error: string }>;
}

type Candidate = {
  user_id: string;
  email: string;
  timezone: string;
  digest_hour: number;
  sender_name: string;
  business_name: string;
  postal_address: string;
  sending_domain: string | null;
};

type Outcome =
  | { kind: "not_due" }
  | { kind: "already_sent" }
  | { kind: "skipped"; reason: string }
  | { kind: "sent" };

const NOT_DUE: Outcome = { kind: "not_due" };
const ALREADY_SENT: Outcome = { kind: "already_sent" };
const SENT: Outcome = { kind: "sent" };

// Runs for every user whose digest is enabled. Each user is handled on its own, so one
// failure does not stop the others. The service role lists users here, and each user's
// content is read through the per-user queue functions.
export async function runDigests(deps: DigestDeps): Promise<DigestResult> {
  const now = deps.clock.now();
  const result: DigestResult = { sent: 0, skipped: 0, failed: 0, skips: [], errors: [] };
  const { rows } = await withService((c) =>
    c.query<Candidate>(
      `select u.id as user_id, u.email, s.timezone, s.digest_hour, s.sender_name, s.business_name,
              s.postal_address, s.sending_domain
         from settings s join users u on u.id = s.user_id
        where s.digest_enabled`,
    ),
  );

  for (const row of rows) {
    try {
      const outcome = await digestFor(row, now, deps);
      if (outcome.kind === "sent") result.sent += 1;
      if (outcome.kind === "skipped") {
        result.skipped += 1;
        result.skips.push({ userId: row.user_id, reason: outcome.reason });
      }
    } catch (err) {
      result.failed += 1;
      result.errors.push({ userId: row.user_id, error: describeError(err) });
    }
  }
  return result;
}

async function digestFor(row: Candidate, now: Date, deps: DigestDeps): Promise<Outcome> {
  const local = DateTime.fromJSDate(now, { zone: row.timezone }).setLocale(LOCALE);
  if (!local.isValid) throw new Error(`Unknown timezone "${row.timezone}"`);
  if (local.hour !== row.digest_hour) return NOT_DUE;

  const localDate = local.toISODate();
  if (!localDate) throw new Error("Could not compute the local date");
  if (await alreadySent(row.user_id, localDate)) return ALREADY_SENT;

  const needsYou = await listNeedsYou(row.user_id);
  const upcoming = (await listNextSevenDays(row.user_id, deps.clock)).filter(
    (m) => m.plannedAt.getTime() >= now.getTime() && m.plannedAt.getTime() < now.getTime() + DAY_MS,
  );
  if (needsYou.length === 0 && upcoming.length === 0) return { kind: "skipped", reason: "nothing to report" };

  const sender = {
    senderName: row.sender_name,
    businessName: row.business_name,
    postalAddress: row.postal_address,
  };
  if (!isSenderProfileComplete(sender)) return { kind: "skipped", reason: "sender profile incomplete" };
  if (!row.sending_domain) return { kind: "skipped", reason: "no sending domain" };

  const { subject, text } = renderDigest({
    zone: row.timezone,
    local,
    needsYou,
    upcoming,
    appUrl: deps.appUrl,
    sender,
  });
  const email: OutgoingEmail = {
    from: { name: row.sender_name, address: `${FROM_LOCAL_PART}@${row.sending_domain}` },
    replyTo: row.email,
    to: row.email,
    cc: [],
    subject,
    text,
    idempotencyKey: `digest:${row.user_id}:${localDate}`,
  };

  const provider = await deps.emailFor(row.user_id);
  if (!(await claim(row.user_id, localDate))) return ALREADY_SENT;
  try {
    await provider.send(email);
  } catch (err) {
    // An ambiguous outcome may have delivered the digest, so its claim stays and it is not resent.
    if (!(err instanceof ProviderAmbiguousError)) await release(row.user_id, localDate);
    throw err;
  }
  return SENT;
}

export function renderDigest(opts: {
  zone: string;
  local: DateTime;
  needsYou: NeedsYouItem[];
  upcoming: UpcomingMessage[];
  appUrl: string;
  sender: { senderName: string; businessName: string; postalAddress: string };
}): { subject: string; text: string } {
  const { zone, local, needsYou, upcoming, appUrl, sender } = opts;
  const when = (d: Date) => DateTime.fromJSDate(d, { zone }).setLocale(LOCALE).toFormat("d LLL yyyy HH:mm");

  const subject = `Invoice Chaser digest: ${needsYou.length} need you, ${upcoming.length} planned in the next 24 hours`;
  const needsLines =
    needsYou.length === 0
      ? ["- Nothing is waiting for you."]
      : needsYou.map((item) => `- ${oneLine(item.title)}: ${oneLine(item.detail)}`);
  const upcomingLines =
    upcoming.length === 0
      ? ["- Nothing is planned in the next 24 hours."]
      : upcoming.map((m) => {
          const approval = m.requiresApproval ? " (needs your approval)" : "";
          return `- ${when(m.plannedAt)}: ${oneLine(m.invoiceNumber)} for ${oneLine(m.clientName)}, ${formatMoney(
            m.amountMinor,
            m.currency,
          )}, to ${oneLine(m.contactEmail)}${approval}`;
        });

  const text = [
    `Your Invoice Chaser digest for ${local.toFormat("cccc d LLL yyyy")}.`,
    "",
    `Needs you (${needsYou.length})`,
    ...needsLines,
    "",
    `Planned in the next 24 hours (${upcoming.length})`,
    ...upcomingLines,
    "",
    `Open Invoice Chaser: ${appUrl}`,
    "",
    FOOTER_LINES(sender),
  ].join("\n");
  return { subject, text };
}

async function alreadySent(userId: string, localDate: string): Promise<boolean> {
  const { rowCount } = await withService((c) =>
    c.query("select 1 from digests where user_id = $1 and digest_date = $2::date", [userId, localDate]),
  );
  return (rowCount ?? 0) > 0;
}

// Returns true when this call created the row, so only one run per user and local day sends.
async function claim(userId: string, localDate: string): Promise<boolean> {
  const { rowCount } = await withService((c) =>
    c.query(
      `insert into digests (user_id, digest_date) values ($1, $2::date)
       on conflict (user_id, digest_date) do nothing`,
      [userId, localDate],
    ),
  );
  return (rowCount ?? 0) > 0;
}

async function release(userId: string, localDate: string): Promise<void> {
  await withService((c) =>
    c.query("delete from digests where user_id = $1 and digest_date = $2::date", [userId, localDate]),
  );
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}
