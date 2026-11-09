"use server";

// Server actions for the settings and onboarding screens. Each one is a public endpoint, so each
// one: (1) takes the user id from requireUserId(), never from the form, (2) validates every
// field before any write, and (3) returns field-keyed errors instead of throwing for bad input.
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { systemClock } from "@/lib/clock";
import { removePasskey } from "@/lib/passkeys";
import { StripeConnectionError } from "@/lib/providers/stripe-connection";
import * as Q from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";
import {
  checkProfileAndSettings,
  checkRestrictedKey,
  checkSendingDomain,
  type ProfileAndSettingsRaw,
} from "@/components/settings/rules";
import { errorState, savedState, warningState, type FormState } from "@/components/settings/state";

const SAVE_FAILED = "That did not save. Nothing was changed. Try again in a moment.";

const ENDPOINT_NOT_DELETED =
  "Your key was removed from Invoice Chaser, but Stripe did not let us delete the webhook endpoint. " +
  "Delete it yourself: in the Stripe Dashboard, open Developers, then Webhooks. Find the endpoint whose " +
  "address starts with your Invoice Chaser address followed by /api/webhooks/stripe/, and delete it. " +
  "Until you do, Stripe keeps sending events there and Invoice Chaser rejects them.";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

// The sender section and onboarding step 1 share one set of fields, so they share one mapping.
function profileFromForm(formData: FormData): ProfileAndSettingsRaw {
  return {
    senderName: field(formData, "senderName"),
    businessName: field(formData, "businessName"),
    postalAddress: field(formData, "postalAddress"),
    timezone: field(formData, "timezone"),
    windowStart: field(formData, "windowStart"),
    windowEnd: field(formData, "windowEnd"),
    dailyCap: field(formData, "dailyCap"),
    digestEnabled: formData.get("digestEnabled") === "on",
    digestHour: field(formData, "digestHour"),
  };
}

function errorName(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? `${err.name} ${code}` : err.name;
  }
  return "unknown error";
}

// Runs a write. Next's own control-flow errors (redirect, notFound) are rethrown. Anything else
// is logged by name only, so no values or secrets reach the log, and the user sees a calm message.
async function attempt(label: string, work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (err) {
    unstable_rethrow(err);
    console.error(`[settings] ${label} failed: ${errorName(err)}`);
    return errorState({}, SAVE_FAILED);
  }
}

// ---------------------------------------------------------------- settings: sender section

// One Save for the whole sender section: sender details, timezone, send window, daily limit and
// digest. Every field is checked before anything is written, so a refused field saves nothing.
export async function saveSenderSettingsAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const checked = checkProfileAndSettings(profileFromForm(formData));
  if (!checked.ok) return errorState(checked.errors, "Check the highlighted fields. Nothing was saved.");
  const { value } = checked;
  return attempt("sender settings", async () => {
    await Q.saveProfileAndSettings(userId, value, systemClock);
    refresh();
    return savedState("Saved. Reminders sent from now on use these details and settings.");
  });
}

// ---------------------------------------------------------------- settings: sending section

// Shared by the settings card and onboarding step 2. Returns the state to show, or null on success.
async function storeSendingDomain(userId: string, formData: FormData): Promise<FormState | null> {
  const checked = checkSendingDomain(field(formData, "sendingDomain"));
  if (!checked.ok) return errorState(checked.errors);
  const { value } = checked;
  const failure = await attempt("sending domain", async () => {
    await Q.saveSendingDomain(userId, value, systemClock);
    return savedState("");
  });
  return failure.status === "error" ? failure : null;
}

export async function saveSendingDomainAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const failure = await storeSendingDomain(userId, formData);
  if (failure) return failure;
  refresh();
  return savedState("Saved. Add the DNS records shown below at the host where your domain is managed.");
}

// ---------------------------------------------------------------- settings: payments section

// Stripe connect and disconnect share one action and one state, so a disconnect warning stays on
// screen after the connection card switches to its "not connected" view.
export async function updateStripeConnectionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();

  if (field(formData, "intent") === "disconnect") {
    return attempt("stripe disconnect", async () => {
      const result = await Q.disconnectStripeFor(userId);
      refresh();
      if (!result.removed) return errorState({}, "No Stripe key was connected, so there was nothing to remove.");
      if (!result.endpointDeleted) return warningState(ENDPOINT_NOT_DELETED);
      return savedState("Stripe is disconnected. Invoice Chaser no longer holds your key.");
    });
  }

  // Pasting a key is for internal testing only. Everyone else connects through Stripe's own page, so the
  // key path refuses unless STRIPE_KEY_MODE is "restricted". Disconnect is allowed in every mode.
  if (process.env.STRIPE_KEY_MODE !== "restricted") {
    return errorState({}, "Connect with Stripe instead. Pasting a key is only used for internal testing on this installation.");
  }

  const checked = checkRestrictedKey(field(formData, "stripeKey"));
  if (!checked.ok) return errorState(checked.errors);
  const { value } = checked;

  try {
    await Q.connectStripeFor(userId, value, { appUrl: process.env.APP_URL });
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof StripeConnectionError || err instanceof Q.SettingsConfigError) {
      return errorState({}, err.message);
    }
    console.error(`[settings] stripe connect failed: ${errorName(err)}`);
    return errorState({}, "Stripe could not be connected. Nothing was saved, so you can try again.");
  }
  refresh();
  return savedState("Stripe is connected. Reminders now include a payment link.");
}

// ---------------------------------------------------------------- settings: sign-in section

// Removes one of the signed-in user's own passkeys. removePasskey only deletes a row that belongs to this
// user, so an id from another account matches nothing. Removing the last passkey is allowed: the email
// link still signs the user in.
export async function removePasskeyAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const passkeyId = field(formData, "passkeyId");
  return attempt("remove passkey", async () => {
    const removed = await removePasskey(userId, passkeyId);
    if (!removed) return errorState({}, "That passkey is no longer on this account. Reload the page and check the list.");
    refresh();
    return savedState("Passkey removed. Sign-in with the email link still works.");
  });
}

// ---------------------------------------------------------------- onboarding

export async function saveOnboardingProfileAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const checked = checkProfileAndSettings(profileFromForm(formData));
  if (!checked.ok) return errorState(checked.errors, "Check the highlighted fields. Nothing was saved.");
  const { value } = checked;
  const failure = await attempt("onboarding profile", async () => {
    await Q.saveProfileAndSettings(userId, value, systemClock);
    return savedState("");
  });
  if (failure.status === "error") return failure;
  redirect("/onboarding/sending");
}

export async function saveOnboardingSendingAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const failure = await storeSendingDomain(userId, formData);
  if (failure) return failure;
  redirect("/onboarding/invoices");
}

// Records that the default reminders were reviewed (onboarding step 4). A plain server form.
export async function confirmSequenceReviewAction(_formData: FormData): Promise<void> {
  const userId = await requireUserId();
  await Q.markSequenceReviewed(userId, systemClock);
  redirect("/onboarding");
}

// Finish is idempotent. The button is disabled until steps 1, 2 and 4 are done, and the server
// checks again, so a stale page cannot finish setup early.
export async function finishOnboardingAction(_previous: FormState, _formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  let result: Q.FinishResult;
  try {
    result = await Q.finishOnboarding(userId, systemClock);
  } catch (err) {
    unstable_rethrow(err);
    console.error(`[settings] finish onboarding failed: ${errorName(err)}`);
    return errorState({}, SAVE_FAILED);
  }
  if (result.status === "incomplete") {
    return errorState({}, `Finish needs these steps first: ${result.missing.join(", ")}.`);
  }
  redirect("/");
}
