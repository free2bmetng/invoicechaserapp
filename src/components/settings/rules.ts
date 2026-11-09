// Settings rules shared by the forms (client) and the server actions (server).
// Pure on purpose: no database, no server-only imports, so client components can use it.
// Every check returns field-keyed errors. The keys match the form input names.
import { DateTime } from "luxon";

// Users may narrow the 09:00-17:00 send window, never widen it.
export const WINDOW_EARLIEST_START = 9;
export const WINDOW_LATEST_END = 17;
export const DAILY_CAP_MIN = 1;
export const DAILY_CAP_MAX = 500;
export const DAILY_CAP_DEFAULT = 20;
export const DIGEST_HOUR_DEFAULT = 8;
export const RESTRICTED_KEY_PREFIX = "rk_";

export const SENDER_NAME_LIMIT = 100;
export const BUSINESS_NAME_LIMIT = 150;
export const POSTAL_ADDRESS_LIMIT = 400;

export type FieldErrors = Record<string, string>;
export type Checked<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

export const START_HOURS = range(WINDOW_EARLIEST_START, WINDOW_LATEST_END - 1); // 09..16
export const END_HOURS = range(WINDOW_EARLIEST_START + 1, WINDOW_LATEST_END); // 10..17
export const DIGEST_HOURS = range(0, 23);

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

// ---------------------------------------------------------------- timezones

let zoneOptions: string[] | undefined;
let zoneSet: Set<string> | undefined;

function zones(): Set<string> {
  if (!zoneSet) {
    zoneSet = new Set<string>(Intl.supportedValuesOf("timeZone"));
    // UTC is always offered, even on runtimes whose Intl list leaves it out.
    zoneSet.add("UTC");
  }
  return zoneSet;
}

// Every IANA zone the runtime knows, plus UTC, sorted for the timezone list.
export function timeZoneOptions(): string[] {
  if (!zoneOptions) zoneOptions = [...zones()].sort((a, b) => a.localeCompare(b));
  return zoneOptions;
}

export function isKnownTimeZone(zone: string): boolean {
  return zones().has(zone) && DateTime.utc().setZone(zone).isValid;
}

// ---------------------------------------------------------------- helpers

// Form values arrive as strings. Anything else counts as empty.
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Whole numbers typed as digits only. Signs, decimals and words are refused.
function wholeNumber(value: unknown, maxDigits: number): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!new RegExp(`^\\d{1,${maxDigits}}$`).test(trimmed)) return null;
  return Number(trimmed);
}

// Tabs and other control characters are refused. Line breaks only where allowed.
function hasControlCharacters(value: string, allowLineBreaks: boolean): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code === 10 || code === 13) && allowLineBreaks) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

// Keeps line breaks, trims each line, drops blank lines.
function normalizeAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

function ok<T>(value: T): Checked<T> {
  return { ok: true, value };
}

function fail(field: string, message: string): { ok: false; errors: FieldErrors } {
  return { ok: false, errors: { [field]: message } };
}

function finish<T>(errors: FieldErrors, value: T): Checked<T> {
  return Object.keys(errors).length > 0 ? { ok: false, errors } : ok(value);
}

// ---------------------------------------------------------------- sender profile

export interface SenderProfileInput {
  senderName: string;
  businessName: string;
  postalAddress: string;
}

export function checkSenderProfile(raw: {
  senderName: unknown;
  businessName: unknown;
  postalAddress: unknown;
}): Checked<SenderProfileInput> {
  const errors: FieldErrors = {};
  const senderName = text(raw.senderName);
  const businessName = text(raw.businessName);
  const postalAddress = normalizeAddress(raw.postalAddress);

  if (senderName === "") {
    errors.senderName = "Enter your name. Clients see it in the From line and in the footer.";
  } else if (senderName.length > SENDER_NAME_LIMIT || hasControlCharacters(senderName, false)) {
    errors.senderName = `Use one line of plain text, up to ${SENDER_NAME_LIMIT} characters.`;
  }

  if (businessName === "") {
    errors.businessName = "Enter your business name. It appears in the footer of every reminder.";
  } else if (businessName.length > BUSINESS_NAME_LIMIT || hasControlCharacters(businessName, false)) {
    errors.businessName = `Use one line of plain text, up to ${BUSINESS_NAME_LIMIT} characters.`;
  }

  if (postalAddress === "") {
    errors.postalAddress =
      "Enter your postal address. Every reminder's footer includes it, and nothing is sent without it.";
  } else if (postalAddress.length > POSTAL_ADDRESS_LIMIT || hasControlCharacters(postalAddress, true)) {
    errors.postalAddress = `Use plain text, up to ${POSTAL_ADDRESS_LIMIT} characters. Put each line of the address on its own line.`;
  }

  return finish(errors, { senderName, businessName, postalAddress });
}

// ---------------------------------------------------------------- timezone

export function checkTimezone(raw: unknown): Checked<string> {
  const zone = text(raw);
  if (zone === "") return fail("timezone", "Choose a timezone.");
  if (!isKnownTimeZone(zone)) return fail("timezone", "Choose a timezone from the list, for example Europe/London.");
  return ok(zone);
}

// ---------------------------------------------------------------- send window

export function checkSendWindow(rawStart: unknown, rawEnd: unknown): Checked<{ start: number; end: number }> {
  const errors: FieldErrors = {};
  const start = wholeNumber(rawStart, 2);
  const end = wholeNumber(rawEnd, 2);

  if (start === null || start < WINDOW_EARLIEST_START || start > WINDOW_LATEST_END - 1) {
    errors.windowStart = `Choose a start between ${hourLabel(WINDOW_EARLIEST_START)} and ${hourLabel(WINDOW_LATEST_END - 1)}.`;
  }
  if (end === null || end < WINDOW_EARLIEST_START + 1 || end > WINDOW_LATEST_END) {
    errors.windowEnd = `Choose an end between ${hourLabel(WINDOW_EARLIEST_START + 1)} and ${hourLabel(WINDOW_LATEST_END)}.`;
  }
  if (start !== null && end !== null && !errors.windowStart && !errors.windowEnd && end <= start) {
    errors.windowEnd = "The window must end after it starts.";
  }
  return finish(errors, { start: start ?? WINDOW_EARLIEST_START, end: end ?? WINDOW_LATEST_END });
}

// ---------------------------------------------------------------- daily cap

export function checkDailyCap(raw: unknown): Checked<number> {
  const value = wholeNumber(raw, 4);
  if (value === null || value < DAILY_CAP_MIN || value > DAILY_CAP_MAX) {
    return fail(
      "dailyCap",
      `Enter a whole number from ${DAILY_CAP_MIN} to ${DAILY_CAP_MAX}. The default is ${DAILY_CAP_DEFAULT}.`,
    );
  }
  return ok(value);
}

// ---------------------------------------------------------------- digest

export function checkDigestHour(raw: unknown): Checked<number> {
  const value = wholeNumber(raw, 2);
  if (value === null || value > 23) return fail("digestHour", "Choose an hour from 00:00 to 23:00.");
  return ok(value);
}

// ---------------------------------------------------------------- sending domain

// Free mail providers are refused: reminders must come from a domain the user controls.
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Returns the lower-cased domain for display, or null when the input is not a domain.
export function normalizeDomain(raw: unknown): string | null {
  const value = text(raw).toLowerCase().replace(/\.$/, "");
  if (value === "" || value.length > 253 || !DOMAIN_PATTERN.test(value)) return null;
  return value;
}

export function checkSendingDomain(raw: unknown): Checked<string> {
  const input = text(raw);
  if (input === "") return fail("sendingDomain", "Enter the domain you send from, for example yourbusiness.com.");
  if (/[@/:\s]/.test(input)) {
    return fail(
      "sendingDomain",
      "Enter only the domain, for example yourbusiness.com. Leave out https://, paths and email addresses.",
    );
  }
  const domain = normalizeDomain(input);
  if (domain === null) {
    return fail("sendingDomain", "That does not look like a domain. Check the spelling, for example yourbusiness.com.");
  }
  if (FREE_MAIL_DOMAINS.has(domain)) {
    return fail(
      "sendingDomain",
      "Use a domain you own. Free email services such as gmail.com cannot send reminders for you.",
    );
  }
  return ok(domain);
}

// ---------------------------------------------------------------- Stripe key

export function checkRestrictedKey(raw: unknown): Checked<string> {
  const key = text(raw);
  if (key === "") return fail("stripeKey", "Paste your restricted key. It starts with rk_.");
  if (!key.startsWith(RESTRICTED_KEY_PREFIX) || /\s/.test(key) || key.length < 12 || key.length > 255) {
    return fail(
      "stripeKey",
      "Paste a restricted key. It starts with rk_. Secret keys that start with sk_ are not accepted.",
    );
  }
  return ok(key);
}

// ---------------------------------------------------------------- onboarding step 1

export interface ProfileAndSettingsInput extends SenderProfileInput {
  timezone: string;
  windowStart: number;
  windowEnd: number;
  dailyCap: number;
  digestEnabled: boolean;
  digestHour: number;
}

// The raw values as they arrive from the form. Each one is checked before use.
export interface ProfileAndSettingsRaw {
  senderName: unknown;
  businessName: unknown;
  postalAddress: unknown;
  timezone: unknown;
  windowStart: unknown;
  windowEnd: unknown;
  dailyCap: unknown;
  digestEnabled: boolean;
  digestHour: unknown;
}

// Step 1 of onboarding saves the sender profile and the settings that have defaults,
// so one check covers all of them and reports every error at once.
export function checkProfileAndSettings(raw: ProfileAndSettingsRaw): Checked<ProfileAndSettingsInput> {
  const profile = checkSenderProfile({
    senderName: raw.senderName,
    businessName: raw.businessName,
    postalAddress: raw.postalAddress,
  });
  const zone = checkTimezone(raw.timezone);
  const window = checkSendWindow(raw.windowStart, raw.windowEnd);
  const cap = checkDailyCap(raw.dailyCap);
  const hour = checkDigestHour(raw.digestHour);

  if (!profile.ok || !zone.ok || !window.ok || !cap.ok || !hour.ok) {
    return {
      ok: false,
      errors: {
        ...(profile.ok ? {} : profile.errors),
        ...(zone.ok ? {} : zone.errors),
        ...(window.ok ? {} : window.errors),
        ...(cap.ok ? {} : cap.errors),
        ...(hour.ok ? {} : hour.errors),
      },
    };
  }
  return ok({
    ...profile.value,
    timezone: zone.value,
    windowStart: window.value.start,
    windowEnd: window.value.end,
    dailyCap: cap.value,
    digestEnabled: raw.digestEnabled,
    digestHour: hour.value,
  });
}
