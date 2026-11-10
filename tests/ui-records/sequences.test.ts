// Sequence save and live-preview actions: authorization, template and final-notice validation,
// preset text, replanning, ownership, and the rule that a preview never creates a payment link.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class NextRedirect extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return { session: { userId: null as string | null }, NextRedirect };
});

vi.mock("@/lib/session", () => ({
  requireUserId: async () => {
    if (!h.session.userId) throw new h.NextRedirect("/login");
    return h.session.userId;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, updateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.NextRedirect(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { closeDb } from "@/lib/db";
import { listSequences } from "@/lib/engine";
import { previewStepAction, saveSequenceAction, createSequenceAction, duplicateSequenceAction, makeDefaultSequenceAction } from "@/app/actions/sequences";
import { sequenceUsage, sequenceUsers } from "@/lib/queries/sequences";
import { IDLE_SAVE_RESULT } from "@/components/sequences/state";
import { TONE_PRESETS } from "@/lib/templates";
import { resetDb } from "../helpers/db";
import { adminQuery, form, makeClient, makeInvoice, makeUser, scalar, type TestUser } from "./fixtures";

interface StepPayload {
  id: string | null;
  offsetDays: number;
  tone: "friendly" | "neutral" | "firm" | "custom";
  subject: string;
  body: string;
  requiresApproval: boolean;
  isFinalNotice: boolean;
}

async function defaultStandard(userId: string) {
  const all = await listSequences(userId);
  const found = all.find((s) => s.kind === "standard" && s.isDefault);
  if (!found) throw new Error("no default standard sequence");
  return found;
}

function stepsOf(seq: Awaited<ReturnType<typeof defaultStandard>>): StepPayload[] {
  return seq.steps.map((s) => ({
    id: s.id,
    offsetDays: s.offsetDays,
    tone: s.tone as StepPayload["tone"],
    subject: s.subject,
    body: s.body,
    requiresApproval: s.requiresApproval,
    isFinalNotice: s.isFinalNotice,
  }));
}

function payload(seqId: string, overrides: Partial<{ name: string; isDefault: boolean; steps: StepPayload[] }> = {}): string {
  return JSON.stringify({ sequenceId: seqId, name: "Default reminders", kind: "standard", isDefault: true, steps: [], ...overrides });
}

let owner: TestUser;

beforeEach(async () => {
  await resetDb();
  owner = await makeUser();
  h.session.userId = owner.userId;
});

afterAll(async () => {
  await closeDb();
});

describe("authorization", () => {
  it("refuses sequence actions and the preview without a session", async () => {
    const seq = await defaultStandard(owner.userId);
    h.session.userId = null;
    await expect(saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: payload(seq.id) }))).rejects.toMatchObject({ url: "/login" });
    await expect(createSequenceAction(
      { ok: null, message: null }, form({}),
    )).rejects.toMatchObject({ url: "/login" });
    await expect(makeDefaultSequenceAction({ ok: null, message: null }, form({ sequenceId: seq.id }))).rejects.toMatchObject({ url: "/login" });
    await expect(previewStepAction({ kind: "standard", payableId: seq.id, tone: "neutral", subject: "", body: "", offsetDays: 0 })).rejects.toMatchObject({ url: "/login" });
  });
});

describe("saveSequenceAction validation", () => {
  it("rejects a final notice that is not the last step, on that step", async () => {
    const seq = await defaultStandard(owner.userId);
    const steps = stepsOf(seq).slice(0, 2);
    steps[0] = { ...steps[0], offsetDays: 0, isFinalNotice: true };
    steps[1] = { ...steps[1], offsetDays: 7, isFinalNotice: false };
    const result = await saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: payload(seq.id, { steps }) }));
    expect(result.ok).toBe(false);
    expect(result.stepErrors["0"]?.join(" ")).toMatch(/final-notice step must be the last step/);
    expect(await scalar("select offset_days::text from sequence_steps where id = $1", [seq.steps[0].id])).toBe(String(seq.steps[0].offsetDays));
  });

  it("rejects an unknown merge field in custom text, beside its step", async () => {
    const seq = await defaultStandard(owner.userId);
    const steps = stepsOf(seq).slice(0, 1);
    steps[0] = { ...steps[0], tone: "custom", subject: "Hi", body: "Please pay {amount_due} today." };
    const result = await saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: payload(seq.id, { steps }) }));
    expect(result.ok).toBe(false);
    expect(result.stepErrors["0"]?.join(" ")).toMatch(/Unknown field \{amount_due\}/);
  });

  it("replaces preset text with the TONE_PRESETS wording, so a preset cannot store edited copy", async () => {
    const seq = await defaultStandard(owner.userId);
    const steps = stepsOf(seq).slice(0, 1);
    steps[0] = { ...steps[0], tone: "friendly", subject: "Pay now or else", body: "Your legal fees will apply {client_name}." };
    const result = await saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: payload(seq.id, { steps }) }));
    expect(result.ok).toBe(true);
    const stored = await adminQuery<{ subject: string; body: string }>("select subject, body from sequence_steps where sequence_id = $1 order by position limit 1", [seq.id]);
    expect(stored.rows[0].subject).toBe(TONE_PRESETS.friendly.subject);
    expect(stored.rows[0].body).toBe(TONE_PRESETS.friendly.body);
  });

  it("allows custom text to mention legal wording, because the user wrote it", async () => {
    const seq = await defaultStandard(owner.userId);
    const steps = stepsOf(seq).slice(0, 1);
    steps[0] = { ...steps[0], tone: "custom", subject: "Final request", body: "Our lawyers may need to be involved, {client_name}." };
    const result = await saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: payload(seq.id, { steps }) }));
    expect(result.ok).toBe(true);
  });

  it("rejects an unreadable payload with a form-level message", async () => {
    const seq = await defaultStandard(owner.userId);
    const result = await saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: "{not json" }));
    expect(result.ok).toBe(false);
    expect(result.formError).toMatch(/could not be read/);
    const shape = await saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: JSON.stringify({ sequenceId: seq.id, name: "", kind: "standard", isDefault: true, steps: [] }) }));
    expect(shape.formError).toMatch(/could not be read/);
  });

  it("refuses another user's sequence as not found", async () => {
    const other = await makeUser();
    const theirs = await defaultStandard(other.userId);
    const result = await saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: payload(theirs.id, { name: "Hijacked" }) }));
    expect(result.ok).toBe(false);
    expect(result.formError).toMatch(/not found/i);
    expect(await scalar("select name from sequences where id = $1", [theirs.id])).toBe("Default reminders");
  });
});

describe("saveSequenceAction success", () => {
  it("saves steps in the new order, renames the sequence, and reports the replanned invoices", async () => {
    const client = await makeClient(owner.userId);
    await makeInvoice(owner.userId, client.clientId);
    const seq = await defaultStandard(owner.userId);
    const steps = stepsOf(seq).slice(0, 2);
    steps[0] = { ...steps[0], offsetDays: -5 };
    steps[1] = { ...steps[1], offsetDays: 3 };
    const result = await saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: payload(seq.id, { name: "Gentle first", steps }) }));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Saved\. 1 invoice was re-planned\./);
    expect(result.sequence?.name).toBe("Gentle first");
    expect(result.sequence?.steps.map((s) => s.offsetDays)).toEqual([-5, 3]);
    expect(await scalar("select count(*)::text from sequence_steps where sequence_id = $1", [seq.id])).toBe("2");
  });
});

describe("createSequenceAction and makeDefaultSequenceAction", () => {
  it("copies the default into a new non-default sequence", async () => {
    await expect(createSequenceAction({ ok: null, message: null }, form({}))).rejects.toMatchObject({ url: expect.stringMatching(/^\/sequences\//) });
    const copies = await scalar("select count(*)::text from sequences where user_id = $1 and name = 'New sequence' and not is_default", [owner.userId]);
    expect(copies).toBe("1");
  });

  it("makes another standard sequence the default", async () => {
    const copy = await scalar<string>("select id::text from sequences where user_id = $1 and name = 'New sequence'", [owner.userId]).catch(() => "");
    const newId = copy || (await (async () => {
      await createSequenceAction({ ok: null, message: null }, form({})).catch(() => undefined);
      return scalar<string>("select id::text from sequences where user_id = $1 and name = 'New sequence'", [owner.userId]);
    })());
    const state = await makeDefaultSequenceAction({ ok: null, message: null }, form({ sequenceId: newId }));
    expect(state.ok).toBe(true);
    expect(await scalar("select id::text from sequences where user_id = $1 and kind = 'standard' and is_default", [owner.userId])).toBe(newId);
  });
});

describe("previewStepAction", () => {
  it("renders the merge fields, the footer and the preset wording for a real invoice", async () => {
    const client = await makeClient(owner.userId, { name: "Acme Ltd" });
    const invoice = await makeInvoice(owner.userId, client.clientId, { number: "INV-7", amountMinor: 125000, currency: "USD", due: "2027-06-15" });
    const outcome = await previewStepAction({
      kind: "standard", payableId: invoice.invoiceId, tone: "neutral", subject: "ignored draft", body: "ignored draft", offsetDays: 0,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.subject).toBe("Invoice INV-7 is still open");
    expect(outcome.text).toContain("Hello Acme Ltd,");
    expect(outcome.text).toContain("Invoice INV-7 for $1,250.00 is still open. Its due date is 15 Jun 2027.");
    expect(outcome.text).toContain("Ada Lovelace");
    expect(outcome.text).toMatch(/---\nAda Lovelace, Ada Studio\n1 Main St, Springfield$/);
    expect(outcome.placeholderSender).toBe(false);
  });

  it("never creates a payment link, never writes a row and never records an event, even with Stripe connected", async () => {
    const stripeOwner = await makeUser({ stripe: true });
    h.session.userId = stripeOwner.userId;
    const client = await makeClient(stripeOwner.userId);
    const invoice = await makeInvoice(stripeOwner.userId, client.clientId);

    const before = {
      events: await scalar("select count(*)::text from events where user_id = $1", [stripeOwner.userId]),
      scheduled: await scalar("select string_agg(id::text || status, ',' order by id) from scheduled_messages where user_id = $1", [stripeOwner.userId]),
      sent: await scalar("select count(*)::text from message_log where user_id = $1", [stripeOwner.userId]),
    };

    const outcome = await previewStepAction({
      kind: "standard", payableId: invoice.invoiceId, tone: "firm", subject: "", body: "", offsetDays: 14,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stripeConnected).toBe(true);
    expect(outcome.text).toContain("You can pay online here: [payment link]");
    // A template without a {pay_link} token gets the link on its own line before the footer.
    const bare = await previewStepAction({
      kind: "standard", payableId: invoice.invoiceId, tone: "custom", subject: "Invoice", body: "Hello {client_name}, thanks.", offsetDays: 0,
    });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.text).toContain("Pay online: [payment link]");
    expect(bare.text.indexOf("Pay online:")).toBeLessThan(bare.text.indexOf("---"));

    expect(await scalar("select stripe_payment_link_id is null from invoices where id = $1", [invoice.invoiceId])).toBe(true);
    expect(await scalar("select stripe_payment_link_url is null from invoices where id = $1", [invoice.invoiceId])).toBe(true);
    expect(await scalar("select count(*)::text from events where user_id = $1 and type = 'payment_link_created'", [stripeOwner.userId])).toBe("0");
    expect(await scalar("select count(*)::text from events where user_id = $1", [stripeOwner.userId])).toBe(before.events);
    expect(await scalar("select count(*)::text from message_log where user_id = $1", [stripeOwner.userId])).toBe(before.sent);
    expect(await scalar("select string_agg(id::text || status, ',' order by id) from scheduled_messages where user_id = $1", [stripeOwner.userId])).toBe(before.scheduled);
  });

  it("removes a {pay_link} line when Stripe is not connected", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId);
    const outcome = await previewStepAction({
      kind: "standard", payableId: invoice.invoiceId, tone: "custom", subject: "Invoice", body: "Hello {client_name}.\nYou can pay here: {pay_link}\nThanks.", offsetDays: 0,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stripeConnected).toBe(false);
    expect(outcome.text).not.toContain("pay here");
    expect(outcome.text).not.toContain("[payment link]");
  });

  it("shows bracketed placeholders for an incomplete sender profile", async () => {
    const bare = await makeUser({ profile: false });
    h.session.userId = bare.userId;
    const client = await makeClient(bare.userId);
    const invoice = await makeInvoice(bare.userId, client.clientId);
    const outcome = await previewStepAction({ kind: "standard", payableId: invoice.invoiceId, tone: "friendly", subject: "", body: "", offsetDays: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.placeholderSender).toBe(true);
    expect(outcome.text).toContain("[Your name]");
    expect(outcome.text).toContain("[Business name]");
    expect(outcome.text).toContain("[Postal address]");
  });

  it("reports unknown merge fields in a custom draft", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId);
    const outcome = await previewStepAction({ kind: "standard", payableId: invoice.invoiceId, tone: "custom", subject: "Hi", body: "Pay {total}", offsetDays: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors.join(" ")).toMatch(/Unknown field \{total\}/);
  });

  it("refuses another user's invoice and invalid input", async () => {
    const other = await makeUser();
    const theirs = await makeClient(other.userId);
    const invoice = await makeInvoice(other.userId, theirs.clientId);
    const foreign = await previewStepAction({ kind: "standard", payableId: invoice.invoiceId, tone: "neutral", subject: "", body: "", offsetDays: 0 });
    expect(foreign.ok).toBe(false);
    const fractional = await previewStepAction({ kind: "standard", payableId: invoice.invoiceId, tone: "neutral", subject: "", body: "", offsetDays: 1.5 });
    expect(fractional.ok).toBe(false);
    const unknownTone = await previewStepAction({ kind: "standard", payableId: invoice.invoiceId, tone: "savage", subject: "", body: "", offsetDays: 0 });
    expect(unknownTone.ok).toBe(false);
  });

  it("previews a plan step against an installment", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId, { amountMinor: 125000 });
    await adminQuery(
      "insert into payment_plan_installments (user_id, invoice_id, position, due_date, amount_minor, currency) values ($1, $2, 1, '2027-06-15', 50000, 'USD'), ($1, $2, 2, '2027-07-15', 75000, 'USD')",
      [owner.userId, invoice.invoiceId],
    );
    await adminQuery("update invoices set status = 'payment_plan' where id = $1", [invoice.invoiceId]);
    const installmentId = await scalar<string>("select id::text from payment_plan_installments where invoice_id = $1 and position = 2", [invoice.invoiceId]);
    const outcome = await previewStepAction({ kind: "plan", payableId: installmentId, tone: "friendly", subject: "", body: "", offsetDays: 0 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payableLabel).toMatch(/installment 2/);
    expect(outcome.text).toContain("$750.00");
    expect(outcome.text).toContain("15 Jul 2027");
  });
});

describe("duplicateSequenceAction", () => {
  it("copies every step into a new sequence that is not the default, and opens it", async () => {
    const source = await defaultStandard(owner.userId);
    const steps = stepsOf(source);
    // Make the source distinctive: one custom step that waits for approval.
    steps[0] = { ...steps[0], tone: "custom", subject: "Custom {invoice_number}", body: "Hello {client_name}", requiresApproval: true };
    const saved = await saveSequenceAction(IDLE_SAVE_RESULT, form({ payload: payload(source.id, { steps }) }));
    expect(saved.ok).toBe(true);

    let target = "";
    try {
      await duplicateSequenceAction({ ok: null, message: null }, form({ sequenceId: source.id }));
    } catch (err) {
      target = (err as { url?: string }).url ?? "";
    }
    expect(target).toMatch(/^\/sequences\/[0-9a-f-]{36}$/);
    const copyId = target.split("/").pop()!;
    expect(copyId).not.toBe(source.id);

    const all = await listSequences(owner.userId);
    const copy = all.find((s) => s.id === copyId)!;
    const original = all.find((s) => s.id === source.id)!;
    expect(copy.name).toBe("Default reminders (copy)");
    expect(copy.kind).toBe("standard");
    expect(copy.isDefault).toBe(false);
    expect(original.isDefault).toBe(true);
    const shape = (x: typeof copy) =>
      x.steps.map((st) => ({ o: st.offsetDays, t: st.tone, s: st.subject, b: st.body, a: st.requiresApproval, f: st.isFinalNotice }));
    expect(shape(copy)).toEqual(shape(original));
    // The copy has its own step rows.
    expect(copy.steps.map((st) => st.id).some((id) => original.steps.some((o) => o.id === id))).toBe(false);
    // Nothing moved to the copy: the default still serves the open invoices.
    const client = await makeClient(owner.userId);
    await makeInvoice(owner.userId, client.clientId);
    const usage = await sequenceUsage(owner.userId);
    expect(usage.get(source.id)).toBe(1);
    expect(usage.get(copyId) ?? 0).toBe(0);
    expect((await sequenceUsers(owner.userId)).get(source.id)?.[0]?.clientName).toBe("Acme Ltd");
  });

  it("refuses another user's sequence and a malformed id", async () => {
    const source = await defaultStandard(owner.userId);
    const other = await makeUser();
    h.session.userId = other.userId;
    const state = await duplicateSequenceAction({ ok: null, message: null }, form({ sequenceId: source.id }));
    expect(state.ok).toBe(false);
    expect((await duplicateSequenceAction({ ok: null, message: null }, form({ sequenceId: "nope" }))).ok).toBe(false);
    h.session.userId = null;
    await expect(duplicateSequenceAction({ ok: null, message: null }, form({ sequenceId: source.id }))).rejects.toMatchObject({ url: "/login" });
  });
});
