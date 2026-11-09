// Server actions for the settings and onboarding screens, run against the real database. Only the
// Next.js request context (session, redirect, cache refresh) is replaced. Every action is called
// the way a form submission calls it: a FormData, plus the previous state for form-state actions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminQuery, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import {
  saveOnboardingProfileAction,
  saveOnboardingSendingAction,
  saveSenderSettingsAction,
  saveSendingDomainAction,
  updateStripeConnectionAction,
  confirmSequenceReviewAction,
  finishOnboardingAction,
} from "@/app/actions/settings";
import { IDLE_FORM_STATE, type FormState } from "@/components/settings/state";
import { addInvoice, plannedRowCount, setupOwner, connectionCount } from "./fixtures";

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return { RedirectSignal, state: { userId: null as string | null }, refreshCalls: { count: 0 } };
});

vi.mock("@/lib/session", () => ({
  SESSION_COOKIE: "ic_session",
  requireUserId: async () => {
    if (!mocks.state.userId) throw new mocks.RedirectSignal("/login");
    return mocks.state.userId;
  },
  getUserId: async () => mocks.state.userId,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.RedirectSignal(url);
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof mocks.RedirectSignal) throw err;
  },
}));

vi.mock("next/cache", () => ({
  refresh: () => {
    mocks.refreshCalls.count += 1;
  },
}));

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.append(name, value);
  return data;
}

// A complete sender section, as the browser submits it (the digest switch is sent as "on" when on).
// Overrides change one or two fields; a key set to undefined is left out of the form.
function senderForm(overrides: Record<string, string | undefined> = {}): FormData {
  const base: Record<string, string | undefined> = {
    senderName: "Eve",
    businessName: "Eve Co",
    postalAddress: "9 Road",
    timezone: "Asia/Tokyo",
    windowStart: "10",
    windowEnd: "12",
    dailyCap: "30",
    digestEnabled: "on",
    digestHour: "7",
    ...overrides,
  };
  const data = new FormData();
  for (const [name, value] of Object.entries(base)) if (value !== undefined) data.append(name, value);
  return data;
}

function asUser(userId: string | null): void {
  mocks.state.userId = userId;
}

// Resolves to the redirect target, or fails the test if the action did not redirect.
async function redirectTarget(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof mocks.RedirectSignal) return err.url;
    throw err;
  }
  throw new Error("expected the action to redirect");
}

// Every settings column the screens can change, without the timestamp.
async function snapshot(userId: string): Promise<Record<string, unknown>> {
  const { rows } = await adminQuery<Record<string, unknown>>(
    `select sender_name, business_name, postal_address, timezone, send_window_start, send_window_end,
            daily_cap, digest_enabled, digest_hour, sending_domain, onboarding_done
       from settings where user_id = $1`,
    [userId],
  );
  return rows[0];
}

function previous(): FormState {
  return IDLE_FORM_STATE;
}

beforeEach(async () => {
  await resetDb();
  asUser(null);
  mocks.refreshCalls.count = 0;
});

describe("authorization: every action refuses a request with no session", () => {
  it.each([
    ["sender section", () => saveSenderSettingsAction(previous(), senderForm())],
    ["sending domain", () => saveSendingDomainAction(previous(), form({ sendingDomain: "mail.eve.test" }))],
    ["stripe connect", () => updateStripeConnectionAction(previous(), form({ stripeKey: "rk_live_valid_0001" }))],
    ["stripe disconnect", () => updateStripeConnectionAction(previous(), form({ intent: "disconnect" }))],
    ["onboarding profile", () => saveOnboardingProfileAction(previous(), form({ senderName: "Eve" }))],
    ["onboarding sending", () => saveOnboardingSendingAction(previous(), form({ sendingDomain: "mail.eve.test" }))],
    ["review confirmation", () => confirmSequenceReviewAction(form({}))],
    ["finish setup", () => finishOnboardingAction(previous(), form({}))],
  ])("%s redirects to /login and changes nothing", async (_name, run) => {
    const owner = await setupOwner({ profile: false, domain: null });
    const before = await snapshot(owner.userId);
    expect(await redirectTarget(run)).toBe("/login");
    expect(await snapshot(owner.userId)).toEqual(before);
    expect(mocks.refreshCalls.count).toBe(0);
  });
});

// Each refusal is sent through the action that owns it, from a form that is otherwise valid.
const refusals: Record<string, (overrides: Record<string, string | undefined>) => Promise<FormState>> = {
  section: (overrides) => saveSenderSettingsAction(previous(), senderForm(overrides)),
  domain: (overrides) => saveSendingDomainAction(previous(), form(overrides as Record<string, string>)),
  stripe: (overrides) => updateStripeConnectionAction(previous(), form(overrides as Record<string, string>)),
};

describe("validation: each card's rule refuses its own field and writes nothing", () => {
  // The key form only runs in internal-testing mode, so these rows set that mode for their duration.
  beforeEach(() => {
    vi.stubEnv("STRIPE_KEY_MODE", "restricted");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["sender name is empty", "section", { senderName: "" }, "senderName"],
    ["business name is empty", "section", { businessName: "" }, "businessName"],
    ["postal address is empty", "section", { postalAddress: "" }, "postalAddress"],
    ["timezone is unknown", "section", { timezone: "Mars/Base" }, "timezone"],
    ["window starts at 08:00", "section", { windowStart: "8" }, "windowStart"],
    ["window starts at 17:00", "section", { windowStart: "17", windowEnd: "17" }, "windowStart"],
    ["window ends at 18:00", "section", { windowEnd: "18" }, "windowEnd"],
    ["window ends before it starts", "section", { windowStart: "14", windowEnd: "12" }, "windowEnd"],
    ["daily limit of 0", "section", { dailyCap: "0" }, "dailyCap"],
    ["daily limit of 501", "section", { dailyCap: "501" }, "dailyCap"],
    ["digest at 24:00", "section", { digestHour: "24" }, "digestHour"],
    ["domain with a scheme", "domain", { sendingDomain: "https://yourbusiness.test" }, "sendingDomain"],
    ["free mail domain", "domain", { sendingDomain: "gmail.com" }, "sendingDomain"],
    ["secret key instead of restricted", "stripe", { stripeKey: "sk_live_0123456789" }, "stripeKey"],
  ])("%s", async (_name, kind, overrides, field) => {
    const owner = await setupOwner();
    asUser(owner.userId);
    const before = await snapshot(owner.userId);

    const result = await refusals[kind](overrides);

    expect(result.status).toBe("error");
    expect(Object.keys(result.fieldErrors)).toEqual([field]);
    expect(await snapshot(owner.userId)).toEqual(before);
    expect(mocks.refreshCalls.count).toBe(0);
  });

  it("refuses the whole sender section when one card is wrong, so the valid cards save nothing", async () => {
    const owner = await setupOwner();
    asUser(owner.userId);
    const before = await snapshot(owner.userId);

    const result = await saveSenderSettingsAction(previous(), senderForm({ dailyCap: "0", senderName: "Changed" }));

    expect(result.status).toBe("error");
    expect(Object.keys(result.fieldErrors).sort()).toEqual(["dailyCap"]);
    expect(await snapshot(owner.userId)).toEqual(before);
  });

  it("refuses to disconnect Stripe when nothing is connected, without calling Stripe", async () => {
    const owner = await setupOwner();
    asUser(owner.userId);
    const result = await updateStripeConnectionAction(previous(), form({ intent: "disconnect" }));
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/No Stripe key was connected/);
    expect(await connectionCount(owner.userId)).toBe(0);
  });
});

describe("success: one Save writes every card in its section", () => {
  it("saves the sender section in one go and confirms", async () => {
    const owner = await setupOwner();
    asUser(owner.userId);

    const result = await saveSenderSettingsAction(previous(), senderForm());

    expect(result).toEqual({
      status: "saved",
      message: "Saved. Reminders sent from now on use these details and settings.",
      fieldErrors: {},
    });
    expect(await snapshot(owner.userId)).toMatchObject({
      sender_name: "Eve",
      business_name: "Eve Co",
      postal_address: "9 Road",
      timezone: "Asia/Tokyo",
      send_window_start: 10,
      send_window_end: 12,
      daily_cap: 30,
      digest_enabled: true,
      digest_hour: 7,
    });
    expect(mocks.refreshCalls.count).toBe(1);
  });

  it("treats an unchecked digest switch as off, and saves the rest of the section", async () => {
    const owner = await setupOwner();
    asUser(owner.userId);
    const result = await saveSenderSettingsAction(previous(), senderForm({ digestEnabled: undefined }));
    expect(result.status).toBe("saved");
    expect(await snapshot(owner.userId)).toMatchObject({ digest_enabled: false, daily_cap: 30 });
  });

  it("saves the sending domain in lower case", async () => {
    const owner = await setupOwner({ domain: null });
    asUser(owner.userId);
    const result = await saveSendingDomainAction(previous(), form({ sendingDomain: " Mail.Example.TEST " }));
    expect(result.status).toBe("saved");
    expect((await snapshot(owner.userId)).sending_domain).toBe("mail.example.test");
  });
});

describe("authorization: the session user is the only user an action can change", () => {
  it("ignores a user_id smuggled into the form and changes only the session user", async () => {
    const alice = await setupOwner();
    const bob = await setupOwner();
    asUser(alice.userId);
    const bobBefore = await snapshot(bob.userId);

    const result = await saveSenderSettingsAction(previous(), senderForm({ user_id: bob.userId }));

    expect(result.status).toBe("saved");
    expect((await snapshot(alice.userId)).daily_cap).toBe(30);
    expect(await snapshot(bob.userId)).toEqual(bobBefore);
  });
});

describe("onboarding actions", () => {
  it("refuses an incomplete step 1 without redirecting, and keeps the errors by field", async () => {
    const owner = await setupOwner({ profile: false, domain: null });
    asUser(owner.userId);
    const before = await snapshot(owner.userId);
    const result = await saveOnboardingProfileAction(
      previous(),
      form({ senderName: "", businessName: "Ada Co", postalAddress: "1 Road", timezone: "UTC", windowStart: "9", windowEnd: "18", dailyCap: "20", digestHour: "8" }),
    );
    expect(result.status).toBe("error");
    expect(Object.keys(result.fieldErrors).sort()).toEqual(["senderName", "windowEnd"]);
    expect(await snapshot(owner.userId)).toEqual(before);
  });

  it("saves step 1 and moves on to step 2", async () => {
    const owner = await setupOwner({ profile: false, domain: null });
    asUser(owner.userId);
    const target = await redirectTarget(() =>
      saveOnboardingProfileAction(
        previous(),
        form({
          senderName: "Ada",
          businessName: "Ada Co",
          postalAddress: "1 Road",
          timezone: "Europe/London",
          windowStart: "9",
          windowEnd: "17",
          dailyCap: "30",
          digestEnabled: "on",
          digestHour: "7",
        }),
      ),
    );
    expect(target).toBe("/onboarding/sending");
    expect(await snapshot(owner.userId)).toMatchObject({
      sender_name: "Ada",
      timezone: "Europe/London",
      daily_cap: 30,
      digest_enabled: true,
      digest_hour: 7,
    });
  });

  it("refuses a bad domain at step 2 and saves a good one, then moves on to step 3", async () => {
    const owner = await setupOwner({ domain: null });
    asUser(owner.userId);
    const refused = await saveOnboardingSendingAction(previous(), form({ sendingDomain: "https://bad" }));
    expect(refused.fieldErrors.sendingDomain).toBeTruthy();
    expect((await snapshot(owner.userId)).sending_domain).toBeNull();

    const target = await redirectTarget(() => saveOnboardingSendingAction(previous(), form({ sendingDomain: "mail.example.test" })));
    expect(target).toBe("/onboarding/invoices");
    expect((await snapshot(owner.userId)).sending_domain).toBe("mail.example.test");
  });

  it("records the review and returns to the overview", async () => {
    const owner = await setupOwner();
    asUser(owner.userId);
    expect(await redirectTarget(() => confirmSequenceReviewAction(form({})))).toBe("/onboarding");
    const { rows } = await adminQuery<{ n: string }>(
      "select count(*)::text as n from events where user_id = $1 and type = 'onboarding_sequence_reviewed'",
      [owner.userId],
    );
    expect(rows[0].n).toBe("1");
  });

  it("refuses to finish while a required step is open, and plans nothing", async () => {
    const owner = await setupOwner({ domain: null });
    await addInvoice(owner.userId);
    asUser(owner.userId);
    const result = await finishOnboardingAction(previous(), form({}));
    expect(result.status).toBe("error");
    expect(result.message).toContain("Connect sending");
    expect(result.message).toContain("Review the default reminders");
    expect(await plannedRowCount(owner.userId)).toBe(0);
    expect((await snapshot(owner.userId)).onboarding_done).toBe(false);
  });

  it("finishes when steps 1, 2 and 4 are done, plans open invoices and redirects to the dashboard", async () => {
    const owner = await setupOwner({ reviewed: true });
    await addInvoice(owner.userId);
    asUser(owner.userId);
    expect(await redirectTarget(() => finishOnboardingAction(previous(), form({})))).toBe("/");
    expect((await snapshot(owner.userId)).onboarding_done).toBe(true);
    expect(await plannedRowCount(owner.userId)).toBeGreaterThan(0);
  });
});

describe("Stripe connect: the key path is internal-testing only", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to connect a key outside restricted mode, even a well-formed one, and stores nothing", async () => {
    vi.stubEnv("STRIPE_KEY_MODE", "oauth");
    const owner = await setupOwner();
    asUser(owner.userId);

    const result = await updateStripeConnectionAction(previous(), form({ stripeKey: "rk_live_valid_0001" }));

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/Connect with Stripe instead/);
    expect(await connectionCount(owner.userId)).toBe(0);
    expect(mocks.refreshCalls.count).toBe(0);
  });

  it("still lets the signed-in user disconnect when the key path is off", async () => {
    vi.stubEnv("STRIPE_KEY_MODE", "oauth");
    const owner = await setupOwner();
    asUser(owner.userId);

    const result = await updateStripeConnectionAction(previous(), form({ intent: "disconnect" }));

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/No Stripe key was connected/);
  });
});
