// Settings data layer: reads and writes behind the settings and onboarding screens.
// Callers pass the signed-in user's id from requireUserId(). Every query runs through
// withUser, so row-level security also keeps it to that user's rows.
// Nothing here returns a Stripe key. The view carries only the account label.
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { completeOnboarding } from "@/lib/engine";
import { connectStripe, disconnectStripe, type StripeConnectionDeps } from "@/lib/providers/stripe-connection";
import { isSenderProfileComplete } from "@/lib/templates";
import type { ProfileAndSettingsInput, SenderProfileInput } from "@/components/settings/rules";

export const SEQUENCE_REVIEWED_EVENT = "onboarding_sequence_reviewed";

// Thrown when this installation is missing configuration the action needs (APP_URL for Stripe).
export class SettingsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsConfigError";
  }
}

export interface SettingsRecord {
  senderName: string;
  businessName: string;
  postalAddress: string;
  timezone: string;
  sendWindowStart: number;
  sendWindowEnd: number;
  dailyCap: number;
  digestEnabled: boolean;
  digestHour: number;
  sendingDomain: string | null;
  onboardingDone: boolean;
}

export interface SequenceStepSummary {
  offsetDays: number;
  subject: string;
  tone: string;
  requiresApproval: boolean;
  isFinalNotice: boolean;
}

export interface SettingsView {
  email: string;
  settings: SettingsRecord;
  stripe: { connected: boolean; accountLabel: string | null };
  // The default standard sequence, in the order its steps are sent.
  steps: SequenceStepSummary[];
  invoiceCount: number;
  sequenceReviewed: boolean;
  sendingEnabled: boolean;
  appUrlConfigured: boolean;
  // Stripe Connect (OAuth) needs STRIPE_CONNECT_CLIENT_ID. Pasting a restricted key is for internal testing only,
  // and is available only when STRIPE_KEY_MODE is "restricted".
  stripeOauthConfigured: boolean;
  stripeRestrictedKeyMode: boolean;
}

interface SettingsRow {
  sender_name: string;
  business_name: string;
  postal_address: string;
  timezone: string;
  send_window_start: number;
  send_window_end: number;
  daily_cap: number;
  digest_enabled: boolean;
  digest_hour: number;
  sending_domain: string | null;
  onboarding_done: boolean;
}

interface StepRow {
  offset_days: number;
  subject: string;
  tone: string;
  requires_approval: boolean;
  is_final_notice: boolean;
}

function defaultRecord(): SettingsRecord {
  return {
    senderName: "",
    businessName: "",
    postalAddress: "",
    timezone: "UTC",
    sendWindowStart: 9,
    sendWindowEnd: 17,
    dailyCap: 20,
    digestEnabled: true,
    digestHour: 8,
    sendingDomain: null,
    onboardingDone: false,
  };
}

function toRecord(row: SettingsRow): SettingsRecord {
  return {
    senderName: row.sender_name,
    businessName: row.business_name,
    postalAddress: row.postal_address,
    timezone: row.timezone,
    sendWindowStart: row.send_window_start,
    sendWindowEnd: row.send_window_end,
    dailyCap: row.daily_cap,
    digestEnabled: row.digest_enabled,
    digestHour: row.digest_hour,
    sendingDomain: row.sending_domain,
    onboardingDone: row.onboarding_done,
  };
}

export async function getSettingsView(userId: string): Promise<SettingsView> {
  return withUser(userId, async (c) => {
    const user = await c.query<{ email: string }>("select email from users where id = $1", [userId]);
    const settings = await c.query<SettingsRow>(
      `select sender_name, business_name, postal_address, timezone, send_window_start, send_window_end,
              daily_cap, digest_enabled, digest_hour, sending_domain, onboarding_done
         from settings where user_id = $1`,
      [userId],
    );
    const account = await c.query<{ account_label: string }>(
      "select account_label from connected_accounts where user_id = $1 and provider = 'stripe'",
      [userId],
    );
    const steps = await c.query<StepRow>(
      `select st.offset_days, st.subject, st.tone, st.requires_approval, st.is_final_notice
         from sequence_steps st join sequences sq on sq.id = st.sequence_id
        where st.user_id = $1 and sq.user_id = $1 and sq.kind = 'standard' and sq.is_default
        order by st.offset_days, st.position`,
      [userId],
    );
    const invoices = await c.query<{ n: string }>("select count(*)::text as n from invoices where user_id = $1", [userId]);
    const reviewed = await c.query(
      "select 1 from events where user_id = $1 and type = $2 limit 1",
      [userId, SEQUENCE_REVIEWED_EVENT],
    );

    const row = settings.rows[0];
    const connection = account.rows[0];
    return {
      email: user.rows[0]?.email ?? "",
      settings: row ? toRecord(row) : defaultRecord(),
      stripe: { connected: !!connection, accountLabel: connection?.account_label ?? null },
      steps: steps.rows.map((s) => ({
        offsetDays: s.offset_days,
        subject: s.subject,
        tone: s.tone,
        requiresApproval: s.requires_approval,
        isFinalNotice: s.is_final_notice,
      })),
      invoiceCount: Number(invoices.rows[0]?.n ?? 0),
      sequenceReviewed: (reviewed.rowCount ?? 0) > 0,
      sendingEnabled: process.env.SEND_ENABLED === "true",
      appUrlConfigured: !!process.env.APP_URL?.trim(),
      stripeOauthConfigured: !!process.env.STRIPE_CONNECT_CLIENT_ID?.trim(),
      stripeRestrictedKeyMode: process.env.STRIPE_KEY_MODE === "restricted",
    };
  });
}

export async function getUserTimezone(userId: string): Promise<string> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ timezone: string }>("select timezone from settings where user_id = $1", [userId]);
    return rows[0]?.timezone ?? "UTC";
  });
}

// ---------------------------------------------------------------- writes

// Creates the settings row if it is missing (it normally exists from sign-in), then writes
// the given statement. The statement's first placeholder is the user id, the last is updated_at.
async function writeSettings(userId: string, at: Date, statement: string, values: unknown[]): Promise<void> {
  await withUser(userId, async (c) => {
    await c.query("insert into settings (user_id, updated_at) values ($1, $2) on conflict (user_id) do nothing", [
      userId,
      at,
    ]);
    await c.query(statement, [userId, ...values, at]);
  });
}

export async function saveSendingDomain(userId: string, domain: string, clock: Clock): Promise<void> {
  await writeSettings(
    userId,
    clock.now(),
    "update settings set sending_domain = $2, updated_at = $3 where user_id = $1",
    [domain],
  );
}

// The sender section and onboarding step 1 save the sender profile and its settings in one statement,
// so one Save can never leave the section half-written.
export async function saveProfileAndSettings(
  userId: string,
  input: ProfileAndSettingsInput,
  clock: Clock,
): Promise<void> {
  await writeSettings(
    userId,
    clock.now(),
    `update settings set sender_name = $2, business_name = $3, postal_address = $4, timezone = $5,
            send_window_start = $6, send_window_end = $7, daily_cap = $8, digest_enabled = $9,
            digest_hour = $10, updated_at = $11
      where user_id = $1`,
    [
      input.senderName,
      input.businessName,
      input.postalAddress,
      input.timezone,
      input.windowStart,
      input.windowEnd,
      input.dailyCap,
      input.digestEnabled,
      input.digestHour,
    ],
  );
}

// ---------------------------------------------------------------- Stripe

export interface StripeDeps {
  appUrl: string | undefined;
  stripe?: StripeConnectionDeps;
}

// Validates the key with Stripe and stores it encrypted. Stripe's own errors pass through
// unchanged; they are written to be shown to the user and never contain the key.
export async function connectStripeFor(userId: string, key: string, deps: StripeDeps): Promise<void> {
  const appUrl = deps.appUrl?.trim();
  if (!appUrl) {
    throw new SettingsConfigError(
      "This installation has no APP_URL set, so Stripe cannot send payment events back. Ask the person who runs Invoice Chaser to set it.",
    );
  }
  await connectStripe(userId, key, appUrl, deps.stripe);
}

export async function disconnectStripeFor(
  userId: string,
  deps: { stripe?: StripeConnectionDeps } = {},
): Promise<{ removed: boolean; endpointDeleted: boolean }> {
  return disconnectStripe(userId, deps.stripe);
}

// ---------------------------------------------------------------- onboarding

export type OnboardingStepKey = "profile" | "sending" | "invoices" | "review";

export interface OnboardingStep {
  key: OnboardingStepKey;
  title: string;
  done: boolean;
  // Steps 1, 2 and 4 must be done before setup can finish (spec 3.8). Step 3 is optional.
  required: boolean;
}

export function onboardingSteps(view: Pick<SettingsView, "settings" | "invoiceCount" | "sequenceReviewed">): OnboardingStep[] {
  const s = view.settings;
  const profileDone = isSenderProfileComplete({
    senderName: s.senderName,
    businessName: s.businessName,
    postalAddress: s.postalAddress,
  });
  return [
    { key: "profile", title: "Sender details and settings", done: profileDone, required: true },
    { key: "sending", title: "Connect sending", done: !!s.sendingDomain, required: true },
    { key: "invoices", title: "Add or import invoices", done: view.invoiceCount > 0, required: false },
    { key: "review", title: "Review the default reminders", done: view.sequenceReviewed, required: true },
  ];
}

export function missingRequiredSteps(steps: OnboardingStep[]): string[] {
  return steps.filter((step) => step.required && !step.done).map((step) => step.title);
}

// Records that the user looked at the default reminders. One event row at most.
export async function markSequenceReviewed(userId: string, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await c.query(
      `insert into events (user_id, type, detail, created_at)
       select $1::uuid, $2::text, '{}'::jsonb, $3::timestamptz
        where not exists (select 1 from events where user_id = $1::uuid and type = $2::text)`,
      [userId, SEQUENCE_REVIEWED_EVENT, clock.now()],
    );
  });
}

export type FinishResult =
  | { status: "finished" }
  | { status: "already_done" }
  | { status: "incomplete"; missing: string[] };


// Finishes setup. This screen checks the four steps, including the sequence review. The engine
// then plans every open invoice and sets the flag in one call, and that call is idempotent.
export async function finishOnboarding(userId: string, clock: Clock): Promise<FinishResult> {
  const view = await getSettingsView(userId);
  if (view.settings.onboardingDone) return { status: "already_done" };

  const missing = missingRequiredSteps(onboardingSteps(view));
  if (missing.length > 0) return { status: "incomplete", missing };

  const result = await completeOnboarding(userId, clock);
  return { status: result.alreadyDone ? "already_done" : "finished" };
}
