// Invoice server actions: authorization, field validation, success paths and the stop rules.
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
import {
  createInvoiceAction,
  setInvoiceContactsAction,
  setInvoiceStatusAction,
  setPaymentPlanAction,
  updateInvoiceAction,
} from "@/app/actions/invoices";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";
import { resetDb } from "../helpers/db";
import { adminQuery, form, makeClient, makeInvoice, makeUser, scalar, statusCount, unsentCount, type TestUser } from "./fixtures";

async function redirectTarget(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof h.NextRedirect) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

function createFields(clientId: string, contactId: string, overrides: Record<string, string | string[]> = {}) {
  return {
    clientChoice: clientId,
    invoiceNumber: "INV-100",
    amount: "1250.00",
    currency: "USD",
    issueDate: "2026-10-01",
    dueDate: "2027-06-15",
    notes: "",
    sequenceId: "",
    primaryContactId: contactId,
    ccContactIds: [] as string[],
    ...overrides,
  };
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
  it("refuses every invoice action without a session and changes nothing", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId);
    h.session.userId = null;

    await expect(createInvoiceAction(IDLE_FORM_STATE, form({}))).rejects.toMatchObject({ url: "/login" });
    await expect(updateInvoiceAction(IDLE_FORM_STATE, form({ invoiceId: invoice.invoiceId }))).rejects.toMatchObject({ url: "/login" });
    await expect(setInvoiceStatusAction(IDLE_FORM_STATE, form({ invoiceId: invoice.invoiceId, status: "paused" }))).rejects.toMatchObject({ url: "/login" });
    await expect(setInvoiceContactsAction(IDLE_FORM_STATE, form({ invoiceId: invoice.invoiceId }))).rejects.toMatchObject({ url: "/login" });
    await expect(setPaymentPlanAction(IDLE_FORM_STATE, form({ invoiceId: invoice.invoiceId }))).rejects.toMatchObject({ url: "/login" });

    // Offsets of 14 days or less need no approval, but the first message to a client does, so the rows wait as pending approval.
    expect(await unsentCount(invoice.invoiceId)).toBeGreaterThan(0);
    expect(await scalar("select status from invoices where id = $1", [invoice.invoiceId])).toBe("open");
  });
});

describe("createInvoiceAction validation", () => {
  it("reports each bad field beside its own message", async () => {
    const client = await makeClient(owner.userId);
    const state = await createInvoiceAction(
      IDLE_FORM_STATE,
      form(createFields(client.clientId, client.contactId, {
        invoiceNumber: "   ",
        amount: "12.345",
        currency: "USD",
        issueDate: "2026-02-30",
        dueDate: "2027-06-15",
        notes: "x".repeat(2001),
      })),
    );
    expect(state.ok).toBe(false);
    expect(state.fieldErrors.invoiceNumber).toBe("Enter the invoice number.");
    expect(state.fieldErrors.amount).toMatch(/decimal place/);
    expect(state.fieldErrors.issueDate).toMatch(/real issue date/);
    expect(state.fieldErrors.notes).toMatch(/2,000/);
    expect(state.values.invoiceNumber).toBe("   ");
    expect(await scalar("select count(*)::text from invoices")).toBe("0");

    const badCurrency = await createInvoiceAction(IDLE_FORM_STATE, form(createFields(client.clientId, client.contactId, { currency: "QQQ" })));
    expect(badCurrency.fieldErrors.currency).toBe("Choose a currency from the list.");
  });

  it("rejects a due date before the issue date on the due date field", async () => {
    const client = await makeClient(owner.userId);
    const state = await createInvoiceAction(
      IDLE_FORM_STATE,
      form(createFields(client.clientId, client.contactId, { issueDate: "2026-10-10", dueDate: "2026-10-01" })),
    );
    expect(state.fieldErrors.dueDate).toBe("The due date cannot be before the issue date.");
  });

  it("refuses a client that belongs to another user, without revealing it", async () => {
    const other = await makeUser();
    const theirs = await makeClient(other.userId);
    const state = await createInvoiceAction(IDLE_FORM_STATE, form(createFields(theirs.clientId, theirs.contactId)));
    expect(state.ok).toBe(false);
    expect(state.fieldErrors.clientChoice).toBe("Choose a client from the list.");
    expect(await scalar("select count(*)::text from invoices where user_id = $1", [other.userId])).toBe("0");
  });

  it("rejects a new client whose email is already taken, pointing at the existing client", async () => {
    const existing = await makeClient(owner.userId, { email: "accounts@acme.test" });
    const state = await createInvoiceAction(
      IDLE_FORM_STATE,
      form(createFields(existing.clientId, existing.contactId, {
        clientChoice: "__new__",
        clientName: "Acme again",
        clientEmail: "ACCOUNTS@acme.test",
      })),
    );
    expect(state.fieldErrors.clientEmail).toMatch(/already exists/);
    expect(await scalar("select count(*)::text from clients where user_id = $1", [owner.userId])).toBe("1");
  });

  it("rejects a primary contact that is not one of the chosen client's contacts", async () => {
    const a = await makeClient(owner.userId);
    const b = await makeClient(owner.userId);
    const state = await createInvoiceAction(IDLE_FORM_STATE, form(createFields(a.clientId, b.contactId)));
    expect(state.fieldErrors.primaryContactId).toBe("Choose the contact this invoice is sent to.");
  });

  it("rejects a sequence override that is not a standard sequence of the user", async () => {
    const client = await makeClient(owner.userId);
    const state = await createInvoiceAction(
      IDLE_FORM_STATE,
      form(createFields(client.clientId, client.contactId, { sequenceId: "00000000-0000-4000-8000-000000000000" })),
    );
    expect(state.fieldErrors.sequenceId).toBe("Choose a sequence from the list.");
  });
});

describe("createInvoiceAction success", () => {
  it("creates the invoice for an existing client, plans its reminders and redirects to it", async () => {
    const client = await makeClient(owner.userId);
    const target = await redirectTarget(createInvoiceAction(IDLE_FORM_STATE, form(createFields(client.clientId, client.contactId))));
    const invoiceId = await scalar<string>("select id::text from invoices where invoice_number = 'INV-100'");
    expect(target).toBe(`/invoices/${invoiceId}`);
    expect(await scalar("select amount_minor::text from invoices where id = $1", [invoiceId])).toBe("125000");
    expect(await scalar("select currency from invoices where id = $1", [invoiceId])).toBe("USD");
    expect(await unsentCount(invoiceId)).toBeGreaterThan(0);
  });

  it("creates an inline client with a lower-cased email and sends to its primary contact", async () => {
    const dummy = await makeClient(owner.userId);
    const target = await redirectTarget(
      createInvoiceAction(
        IDLE_FORM_STATE,
        form(createFields(dummy.clientId, dummy.contactId, {
          clientChoice: "__new__",
          clientName: "Northwind",
          clientEmail: "Billing@Northwind.test",
          primaryContactId: "",
        })),
      ),
    );
    const invoiceId = await scalar<string>("select id::text from invoices where invoice_number = 'INV-100'");
    expect(target).toBe(`/invoices/${invoiceId}`);
    expect(await scalar("select email from clients where name = 'Northwind' and user_id = $1", [owner.userId])).toBe("billing@northwind.test");
    expect(await scalar("select count(*)::text from invoice_contacts where invoice_id = $1 and role = 'primary'", [invoiceId])).toBe("1");
  });

  it("reports a duplicate invoice number on the number field and creates nothing", async () => {
    const client = await makeClient(owner.userId);
    await makeInvoice(owner.userId, client.clientId, { number: "INV-100" });
    const state = await createInvoiceAction(IDLE_FORM_STATE, form(createFields(client.clientId, client.contactId)));
    expect(state.ok).toBe(false);
    expect(state.fieldErrors.invoiceNumber).toMatch(/already has invoice INV-100/);
    expect(await scalar("select count(*)::text from invoices where user_id = $1", [owner.userId])).toBe("1");
  });
});

describe("updateInvoiceAction", () => {
  it("refuses to edit a paid invoice and leaves it unchanged", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId, { status: "paid" });
    const state = await updateInvoiceAction(
      IDLE_FORM_STATE,
      form({
        invoiceId: invoice.invoiceId, invoiceNumber: "CHANGED", amount: "1.00", currency: "USD",
        issueDate: "2026-10-01", dueDate: "2027-06-15", notes: "", sequenceId: "",
      }),
    );
    expect(state.ok).toBe(false);
    expect(state.message).toMatch(/cannot be edited/);
    expect(await scalar("select invoice_number from invoices where id = $1", [invoice.invoiceId])).toBe(invoice.number);
  });

  it("refuses another user's invoice as not found", async () => {
    const other = await makeUser();
    const theirs = await makeClient(other.userId);
    const invoice = await makeInvoice(other.userId, theirs.clientId);
    const state = await updateInvoiceAction(
      IDLE_FORM_STATE,
      form({
        invoiceId: invoice.invoiceId, invoiceNumber: "HACKED", amount: "9.00", currency: "USD",
        issueDate: "2026-10-01", dueDate: "2027-06-15", notes: "", sequenceId: "",
      }),
    );
    expect(state.ok).toBe(false);
    expect(state.message).toMatch(/not found/i);
    expect(await scalar("select invoice_number from invoices where id = $1", [invoice.invoiceId])).toBe(invoice.number);
  });

  it("saves a valid edit", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId);
    const state = await updateInvoiceAction(
      IDLE_FORM_STATE,
      form({
        invoiceId: invoice.invoiceId, invoiceNumber: "INV-EDIT", amount: "300.5", currency: "USD",
        issueDate: "2026-10-01", dueDate: "2027-07-01", notes: "Net 30", sequenceId: "",
      }),
    );
    expect(state.ok).toBe(true);
    expect(await scalar("select invoice_number || ' ' || amount_minor::text || ' ' || due_date::text from invoices where id = $1", [invoice.invoiceId]))
      .toBe("INV-EDIT 30050 2027-07-01");
  });
});

describe("setInvoiceStatusAction", () => {
  it("pausing cancels every unsent reminder in the same action", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId);
    const before = await unsentCount(invoice.invoiceId);
    expect(before).toBeGreaterThan(0);

    const state = await setInvoiceStatusAction(IDLE_FORM_STATE, form({ invoiceId: invoice.invoiceId, status: "paused" }));
    expect(state.ok).toBe(true);
    expect(state.message).toMatch(/Unsent reminders were cancelled/);
    expect(await unsentCount(invoice.invoiceId)).toBe(0);
    expect(await statusCount(invoice.invoiceId, "cancelled")).toBe(before);
  });

  it("marks an invoice paid and leaves no unsent reminders", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId);
    const state = await setInvoiceStatusAction(IDLE_FORM_STATE, form({ invoiceId: invoice.invoiceId, status: "paid" }));
    expect(state.ok).toBe(true);
    expect(await scalar("select status from invoices where id = $1", [invoice.invoiceId])).toBe("paid");
    expect(await unsentCount(invoice.invoiceId)).toBe(0);
  });

  it("refuses payment_plan, which only the plan panel can set", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId);
    const state = await setInvoiceStatusAction(IDLE_FORM_STATE, form({ invoiceId: invoice.invoiceId, status: "payment_plan" }));
    expect(state.ok).toBe(false);
    expect(state.message).toBe("Choose a status from the list.");
    expect(await scalar("select status from invoices where id = $1", [invoice.invoiceId])).toBe("open");
  });

  it("refuses another user's invoice", async () => {
    const other = await makeUser();
    const theirs = await makeClient(other.userId);
    const invoice = await makeInvoice(other.userId, theirs.clientId);
    const state = await setInvoiceStatusAction(IDLE_FORM_STATE, form({ invoiceId: invoice.invoiceId, status: "paused" }));
    expect(state.ok).toBe(false);
    expect(await scalar("select status from invoices where id = $1", [invoice.invoiceId])).toBe("open");
  });
});

describe("setPaymentPlanAction", () => {
  function planFields(invoiceId: string, rows: { date: string; amount: string }[]) {
    const fields: Record<string, string> = { invoiceId, installmentCount: String(rows.length) };
    rows.forEach((row, i) => {
      fields[`installmentDate_${i}`] = row.date;
      fields[`installmentAmount_${i}`] = row.amount;
    });
    return form(fields);
  }

  it("refuses installments that do not add up to the amount", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId, { amountMinor: 125000 });
    const state = await setPaymentPlanAction(
      IDLE_FORM_STATE,
      planFields(invoice.invoiceId, [{ date: "2027-06-15", amount: "600.00" }, { date: "2027-07-15", amount: "600.00" }]),
    );
    expect(state.ok).toBe(false);
    expect(state.message).toMatch(/add up to 120000/);
    expect(await scalar("select count(*)::text from payment_plan_installments where invoice_id = $1", [invoice.invoiceId])).toBe("0");
  });

  it("reports a bad date or amount beside its installment", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId, { amountMinor: 125000 });
    const state = await setPaymentPlanAction(
      IDLE_FORM_STATE,
      planFields(invoice.invoiceId, [{ date: "not-a-date", amount: "600.00" }, { date: "2027-07-15", amount: "-1" }]),
    );
    expect(state.fieldErrors.installmentDate_0).toBe("Enter a real date.");
    expect(state.fieldErrors.installmentAmount_1).toBeDefined();
  });

  it("requires at least two installments", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId);
    const state = await setPaymentPlanAction(IDLE_FORM_STATE, planFields(invoice.invoiceId, [{ date: "2027-06-15", amount: "1250.00" }]));
    expect(state.ok).toBe(false);
    expect(state.message).toMatch(/between 2 and 60/);
  });

  it("saves a plan, and the plan invoice has no default-sequence rows", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId, { amountMinor: 125000 });
    const state = await setPaymentPlanAction(
      IDLE_FORM_STATE,
      planFields(invoice.invoiceId, [{ date: "2027-06-15", amount: "500.00" }, { date: "2027-07-15", amount: "750.00" }]),
    );
    expect(state.ok).toBe(true);
    expect(await scalar("select status from invoices where id = $1", [invoice.invoiceId])).toBe("payment_plan");
    // Default-sequence rows that were still unsent are skipped when the plan replaces them. None stays unsent.
    expect(await scalar("select count(*)::text from scheduled_messages where invoice_id = $1 and installment_id is null and status in ('pending_approval','scheduled','held')", [invoice.invoiceId])).toBe("0");
    expect(Number(await scalar("select count(*)::text from scheduled_messages where invoice_id = $1 and installment_id is not null", [invoice.invoiceId]))).toBeGreaterThan(0);
  });
});

describe("setInvoiceContactsAction", () => {
  it("refuses a primary contact that belongs to another client", async () => {
    const a = await makeClient(owner.userId);
    const b = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, a.clientId);
    const state = await setInvoiceContactsAction(IDLE_FORM_STATE, form({ invoiceId: invoice.invoiceId, primaryContactId: b.contactId }));
    expect(state.ok).toBe(false);
    expect(state.message).toMatch(/belong to this client/);
  });

  it("moves the primary contact and never copies the primary", async () => {
    const client = await makeClient(owner.userId);
    const second = await adminQuery<{ id: string }>(
      "insert into contacts (user_id, client_id, email, name, is_primary) values ($1, $2, 'ap@acme.test', 'AP', false) returning id",
      [owner.userId, client.clientId],
    );
    const secondId = second.rows[0].id;
    const invoice = await makeInvoice(owner.userId, client.clientId);
    const state = await setInvoiceContactsAction(
      IDLE_FORM_STATE,
      form({ invoiceId: invoice.invoiceId, primaryContactId: secondId, ccContactIds: [secondId, client.contactId] }),
    );
    expect(state.ok).toBe(true);
    expect(await scalar("select contact_id::text from invoice_contacts where invoice_id = $1 and role = 'primary'", [invoice.invoiceId])).toBe(secondId);
    expect(await scalar("select count(*)::text from invoice_contacts where invoice_id = $1 and role = 'cc'", [invoice.invoiceId])).toBe("1");
  });
});
