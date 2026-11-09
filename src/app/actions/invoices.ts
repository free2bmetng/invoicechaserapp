"use server";

// Server actions for invoices. A server action is a public endpoint, so every export calls
// requireUserId() first, validates its own input, and then calls the engine, which enforces
// ownership and the state rules. Results are FormState values so each field can show its error.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { systemClock } from "@/lib/clock";
import {
  addInvoiceNote,
  createClient,
  createInvoice,
  getInvoiceDetail,
  recordPayment,
  setInvoiceContacts,
  setInvoiceStatus,
  setPaymentPlan,
  updateInvoice,
  type InvoiceContacts,
  type PlanInstallmentInput,
} from "@/lib/engine";
import type { InvoiceStatus } from "@/lib/types";
import { isKnownCurrency, normalizeCurrency } from "@/lib/money";
import { parseTypedMoney } from "@/components/invoices/money-input";
import { describeEngineError, listClientChoices, listStandardSequenceChoices, type ClientChoice } from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";
import { failedState, isUuidText, readText, readTexts, valuesFrom, type FormState } from "@/components/invoices/form-state";
import { INVOICE_STATUS_LABEL } from "@/components/invoices/format";

const NEW_CLIENT = "__new__";
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const INVOICE_FIELDS = ["invoiceNumber", "amount", "currency", "issueDate", "dueDate", "notes", "sequenceId"] as const;
const CREATE_FIELDS = [
  "clientChoice", "clientName", "clientEmail", ...INVOICE_FIELDS, "primaryContactId", "ccContactIds",
] as const;

interface InvoiceFieldValues {
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  sequenceId: string | null;
}

function isoDateOk(value: string): boolean {
  return ISO_DATE.test(value) && DateTime.fromISO(value, { zone: "utc" }).isValid;
}

// Checks the invoice fields shared by create and edit. Fills errors; returns null when any failed.
function checkInvoiceFields(formData: FormData, sequenceIds: Set<string>, errors: Record<string, string>): InvoiceFieldValues | null {
  const before = Object.keys(errors).length;

  const invoiceNumber = readText(formData, "invoiceNumber").trim();
  if (!invoiceNumber) errors.invoiceNumber = "Enter the invoice number.";
  else if (invoiceNumber.length > 64) errors.invoiceNumber = "Use 64 characters or fewer.";

  const currency = normalizeCurrency(readText(formData, "currency"));
  const currencyKnown = isKnownCurrency(currency);
  if (!currencyKnown) errors.currency = "Choose a currency from the list.";

  let amountMinor = 0;
  const amountText = readText(formData, "amount").trim();
  if (!amountText) {
    errors.amount = "Enter the amount.";
  } else if (currencyKnown) {
    try {
      // People type "1,234.50". The strict parser takes "1234.50", so the form layer normalises first.
      amountMinor = parseTypedMoney(amountText, currency);
      if (amountMinor <= 0) errors.amount = "The amount must be greater than zero.";
    } catch (err) {
      errors.amount = err instanceof Error ? err.message : "Enter a valid amount.";
    }
  }

  const issueDate = readText(formData, "issueDate").trim();
  const dueDate = readText(formData, "dueDate").trim();
  if (!isoDateOk(issueDate)) errors.issueDate = "Enter a real issue date.";
  if (!isoDateOk(dueDate)) errors.dueDate = "Enter a real due date.";
  if (isoDateOk(issueDate) && isoDateOk(dueDate) && dueDate < issueDate) {
    errors.dueDate = "The due date cannot be before the issue date.";
  }

  const notes = readText(formData, "notes");
  if (notes.length > 2000) errors.notes = "Notes must be 2,000 characters or fewer.";

  const sequenceRaw = readText(formData, "sequenceId").trim();
  if (sequenceRaw !== "" && !sequenceIds.has(sequenceRaw)) errors.sequenceId = "Choose a sequence from the list.";

  if (Object.keys(errors).length > before) return null;
  return {
    invoiceNumber,
    amountMinor,
    currency,
    issueDate,
    dueDate,
    notes,
    sequenceId: sequenceRaw === "" ? null : sequenceRaw,
  };
}

// Maps an engine message to the field it concerns, when there is one.
function fieldForEngineMessage(message: string): string | null {
  if (message.includes("already has invoice")) return "invoiceNumber";
  if (message.includes("primary contact")) return "primaryContactId";
  if (message.includes("cc contact") || message.includes("Cc contact")) return "ccContactIds";
  return null;
}

export async function createInvoiceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const values = valuesFrom(formData, CREATE_FIELDS);
  const errors: Record<string, string> = {};

  const clients = await listClientChoices(userId);
  const sequenceIds = new Set((await listStandardSequenceChoices(userId)).map((s) => s.id));

  const choice = readText(formData, "clientChoice").trim();
  const isNew = choice === NEW_CLIENT;
  const existing: ClientChoice | undefined = isNew ? undefined : clients.find((c) => c.id === choice);

  const newName = readText(formData, "clientName").trim();
  const newEmail = readText(formData, "clientEmail").trim().toLowerCase();
  if (isNew) {
    if (!newName) errors.clientName = "Enter the client's name.";
    else if (newName.length > 200) errors.clientName = "Use 200 characters or fewer.";
    if (!EMAIL.test(newEmail) || newEmail.length > 254) {
      errors.clientEmail = "Enter a valid email address.";
    } else if (clients.some((c) => c.email === newEmail)) {
      errors.clientEmail = "A client with this email already exists. Choose that client from the list instead.";
    }
  } else if (!existing) {
    errors.clientChoice = "Choose a client from the list.";
  }

  const fields = checkInvoiceFields(formData, sequenceIds, errors);

  const primaryContactId = readText(formData, "primaryContactId").trim();
  const ccContactIds = readTexts(formData, "ccContactIds").filter((id) => isUuidText(id) && id !== primaryContactId);
  if (existing && !existing.contacts.some((ct) => ct.id === primaryContactId)) {
    errors.primaryContactId = "Choose the contact this invoice is sent to.";
  }

  if (!fields || Object.keys(errors).length > 0) {
    return failedState("Check the highlighted fields.", errors, values);
  }

  let invoiceId = "";
  let createdClient: { clientId: string; contactId: string } | null = null;
  try {
    let clientId: string;
    let contacts: InvoiceContacts;
    if (existing) {
      clientId = existing.id;
      contacts = { primaryContactId, ccContactIds };
    } else {
      createdClient = await createClient(
        userId,
        { name: newName, email: newEmail, timezone: null, sequenceId: null, autoSend: false },
        systemClock,
      );
      clientId = createdClient.clientId;
      contacts = { primaryContactId: createdClient.contactId, ccContactIds: [] };
    }
    const created = await createInvoice(
      userId,
      {
        clientId,
        invoiceNumber: fields.invoiceNumber,
        amountMinor: fields.amountMinor,
        currency: fields.currency,
        issueDate: fields.issueDate,
        dueDate: fields.dueDate,
        notes: fields.notes,
        sequenceId: fields.sequenceId,
        contacts,
      },
      systemClock,
    );
    invoiceId = created.invoiceId;
  } catch (err) {
    const message = describeEngineError(err);
    const field = fieldForEngineMessage(message);
    // The new client exists even though the invoice did not. Switch the form to that client
    // so a retry does not try to create it again.
    const nextValues = createdClient
      ? { ...values, clientChoice: createdClient.clientId, clientName: "", clientEmail: "", primaryContactId: createdClient.contactId }
      : values;
    return failedState(message, field ? { [field]: message } : {}, nextValues);
  }

  revalidatePath("/", "layout");
  redirect(`/invoices/${invoiceId}`);
}

const BAD_INVOICE = "That invoice could not be found. Refresh the page and try again.";

export async function updateInvoiceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const values = valuesFrom(formData, ["invoiceId", ...INVOICE_FIELDS]);
  const invoiceId = readText(formData, "invoiceId").trim();
  if (!isUuidText(invoiceId)) return failedState(BAD_INVOICE, {}, values);

  const errors: Record<string, string> = {};
  const sequenceIds = new Set((await listStandardSequenceChoices(userId)).map((s) => s.id));
  const fields = checkInvoiceFields(formData, sequenceIds, errors);
  if (!fields || Object.keys(errors).length > 0) return failedState("Check the highlighted fields.", errors, values);

  try {
    await updateInvoice(
      userId,
      invoiceId,
      {
        invoiceNumber: fields.invoiceNumber,
        amountMinor: fields.amountMinor,
        currency: fields.currency,
        issueDate: fields.issueDate,
        dueDate: fields.dueDate,
        notes: fields.notes,
        sequenceId: fields.sequenceId,
      },
      systemClock,
    );
  } catch (err) {
    const message = describeEngineError(err);
    const field = fieldForEngineMessage(message);
    return failedState(message, field ? { [field]: message } : {}, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved.", fieldErrors: {}, values: {} };
}

// The statuses a user can choose directly. payment_plan is set by the payment plan panel.
const STATUS_CHOICES: readonly InvoiceStatus[] = ["open", "paused", "disputed", "paid", "written_off"];
const STATUS_SUCCESS: Record<string, string> = {
  open: "Set to open. Reminders are planned again.",
  paused: "Paused. Unsent reminders were cancelled.",
  disputed: "Marked as disputed. Unsent reminders were cancelled.",
  paid: "Marked as paid. Unsent reminders were cancelled.",
  written_off: "Written off. Unsent reminders were cancelled.",
};

export async function setInvoiceStatusAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const invoiceId = readText(formData, "invoiceId").trim();
  const status = readText(formData, "status").trim();
  if (!isUuidText(invoiceId)) return failedState(BAD_INVOICE, {}, {});
  if (!(STATUS_CHOICES as readonly string[]).includes(status)) return failedState("Choose a status from the list.", {}, {});
  // Marking an invoice disputed can carry the client's reason, saved as a note in the timeline.
  const note = status === "disputed" ? readText(formData, "note").trim() : "";
  if (note.length > 2000) return failedState("Keep the reason under 2,000 characters.", { note: "Use 2,000 characters or fewer." }, { note });
  try {
    await setInvoiceStatus(userId, invoiceId, status as InvoiceStatus, systemClock);
    if (note) await addInvoiceNote(userId, invoiceId, note, systemClock);
  } catch (err) {
    return failedState(describeEngineError(err), {}, {});
  }
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: STATUS_SUCCESS[status] ?? `Status set to ${INVOICE_STATUS_LABEL[status as InvoiceStatus]}.`,
    fieldErrors: {},
    values: {},
  };
}

// Records one installment of a payment plan as paid, by hand. When it is the last open one,
// the engine marks the whole invoice paid.
export async function recordInstallmentAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const invoiceId = readText(formData, "invoiceId").trim();
  const installmentId = readText(formData, "installmentId").trim();
  if (!isUuidText(invoiceId) || !isUuidText(installmentId)) return failedState(BAD_INVOICE, {}, {});
  try {
    await recordPayment({ userId, invoiceId, installmentId, paidAt: systemClock.now(), source: "manual", clock: systemClock });
  } catch (err) {
    return failedState(describeEngineError(err), {}, {});
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Installment recorded as paid. Its reminders are cancelled.", fieldErrors: {}, values: {} };
}

// Adds a note to the invoice's activity timeline: a dispute reason, a call, a promise to pay.
export async function addInvoiceNoteAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const invoiceId = readText(formData, "invoiceId").trim();
  const note = readText(formData, "note");
  if (!isUuidText(invoiceId)) return failedState(BAD_INVOICE, {}, { note });
  if (note.trim() === "") return failedState(null, { note: "Write the note first." }, { note });
  if (note.trim().length > 2000) return failedState(null, { note: "Use 2,000 characters or fewer." }, { note });
  try {
    await addInvoiceNote(userId, invoiceId, note, systemClock);
  } catch (err) {
    return failedState(describeEngineError(err), {}, { note });
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Note added.", fieldErrors: {}, values: {} };
}

export async function setInvoiceContactsAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const invoiceId = readText(formData, "invoiceId").trim();
  const primaryContactId = readText(formData, "primaryContactId").trim();
  const values = { primaryContactId, ccContactIds: readTexts(formData, "ccContactIds").join(",") };
  if (!isUuidText(invoiceId)) return failedState(BAD_INVOICE, {}, values);
  if (!isUuidText(primaryContactId)) {
    return failedState("Choose the contact this invoice is sent to.", { primaryContactId: "Choose a contact." }, values);
  }
  const ccContactIds = [...new Set(readTexts(formData, "ccContactIds").filter((id) => isUuidText(id) && id !== primaryContactId))];
  try {
    await setInvoiceContacts(userId, invoiceId, { primaryContactId, ccContactIds }, systemClock);
  } catch (err) {
    const message = describeEngineError(err);
    return failedState(message, {}, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Contacts saved. Reminders are planned for the new contacts.", fieldErrors: {}, values: {} };
}

const MAX_INSTALLMENTS = 60;

export async function setPaymentPlanAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const invoiceId = readText(formData, "invoiceId").trim();
  if (!isUuidText(invoiceId)) return failedState(BAD_INVOICE, {}, {});

  const count = Number.parseInt(readText(formData, "installmentCount"), 10);
  const values: Record<string, string> = { installmentCount: String(Number.isFinite(count) ? count : "") };
  if (!Number.isInteger(count) || count < 2 || count > MAX_INSTALLMENTS) {
    return failedState(`A payment plan needs between 2 and ${MAX_INSTALLMENTS} installments.`, {}, values);
  }

  let currency: string;
  try {
    currency = (await getInvoiceDetail(userId, invoiceId)).invoice.currency;
  } catch (err) {
    return failedState(describeEngineError(err), {}, values);
  }

  const errors: Record<string, string> = {};
  const installments: PlanInstallmentInput[] = [];
  for (let i = 0; i < count; i++) {
    const date = readText(formData, `installmentDate_${i}`).trim();
    const amountText = readText(formData, `installmentAmount_${i}`).trim();
    values[`installmentDate_${i}`] = date;
    values[`installmentAmount_${i}`] = amountText;
    if (!isoDateOk(date)) errors[`installmentDate_${i}`] = "Enter a real date.";
    let amountMinor = 0;
    try {
      amountMinor = parseTypedMoney(amountText, currency);
      if (amountMinor <= 0) errors[`installmentAmount_${i}`] = "Enter an amount greater than zero.";
    } catch (err) {
      errors[`installmentAmount_${i}`] = err instanceof Error ? err.message : "Enter a valid amount.";
    }
    installments.push({ dueDate: date, amountMinor });
  }
  if (Object.keys(errors).length > 0) return failedState("Check the installments.", errors, values);

  try {
    await setPaymentPlan(userId, invoiceId, installments, systemClock);
  } catch (err) {
    return failedState(describeEngineError(err), {}, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Payment plan saved. Its reminders follow the installment dates.", fieldErrors: {}, values: {} };
}
