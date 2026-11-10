"use server";

// Server actions for clients, contacts and holds. Each export authenticates first, validates its
// own input and then calls the engine, which enforces ownership and the state rules.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { systemClock } from "@/lib/clock";
import {
  createClient,
  getClientDetail,
  removeContact,
  resumeClient,
  resumeContact,
  setAutoSend,
  updateClient,
  upsertContact,
} from "@/lib/engine";
import { describeEngineError, listStandardSequenceChoices } from "@/lib/queries/invoices";
import { requireUserId } from "@/lib/session";
import { failedState, isUuidText, readText, readTexts, valuesFrom, type FormState } from "@/components/invoices/form-state";

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const BAD_CLIENT = "That client could not be found. Refresh the page and try again.";

function validZone(zone: string): boolean {
  return DateTime.utc().setZone(zone).isValid;
}

// Engine messages that concern one field. The rest stay at form level.
function fieldForEngineMessage(message: string): string | null {
  if (message.includes("email already exists") || message.includes("already uses that address") || message.includes("already has a contact")) {
    return "email";
  }
  if (message.includes("Client name")) return "name";
  return null;
}

// Checks the name, email, timezone and sequence fields shared by create and update.
function checkClientFields(formData: FormData, sequenceIds: Set<string>, errors: Record<string, string>) {
  const name = readText(formData, "name").trim();
  if (!name) errors.name = "Enter the client's name.";
  else if (name.length > 200) errors.name = "Use 200 characters or fewer.";

  const email = readText(formData, "email").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) errors.email = "Enter a valid email address.";

  const timezone = readText(formData, "timezone").trim();
  if (timezone !== "" && !validZone(timezone)) errors.timezone = "Choose a timezone from the list.";

  const sequenceId = readText(formData, "sequenceId").trim();
  if (sequenceId !== "" && !sequenceIds.has(sequenceId)) errors.sequenceId = "Choose a sequence from the list.";

  return { name, email, timezone: timezone === "" ? null : timezone, sequenceId: sequenceId === "" ? null : sequenceId };
}

export async function createClientAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const values = valuesFrom(formData, ["name", "email", "timezone", "sequenceId", "autoSend"]);
  const errors: Record<string, string> = {};
  const sequenceIds = new Set((await listStandardSequenceChoices(userId)).map((s) => s.id));
  const fields = checkClientFields(formData, sequenceIds, errors);
  if (Object.keys(errors).length > 0) return failedState("Check the highlighted fields.", errors, values);

  let clientId = "";
  try {
    const created = await createClient(
      userId,
      {
        name: fields.name,
        email: fields.email,
        timezone: fields.timezone,
        sequenceId: fields.sequenceId,
        autoSend: readText(formData, "autoSend") === "on",
      },
      systemClock,
    );
    clientId = created.clientId;
  } catch (err) {
    const message = describeEngineError(err);
    const field = fieldForEngineMessage(message);
    return failedState(message, field === "email" ? { email: message } : field === "name" ? { name: message } : {}, values);
  }
  revalidatePath("/", "layout");
  redirect(`/clients/${clientId}`);
}

export async function updateClientAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const clientId = readText(formData, "clientId").trim();
  const values = valuesFrom(formData, ["name", "email", "timezone", "sequenceId"]);
  if (!isUuidText(clientId)) return failedState(BAD_CLIENT, {}, values);
  const errors: Record<string, string> = {};
  const sequenceIds = new Set((await listStandardSequenceChoices(userId)).map((s) => s.id));
  const fields = checkClientFields(formData, sequenceIds, errors);
  if (Object.keys(errors).length > 0) return failedState("Check the highlighted fields.", errors, values);

  try {
    await updateClient(
      userId,
      clientId,
      { name: fields.name, email: fields.email, timezone: fields.timezone, sequenceId: fields.sequenceId },
      systemClock,
    );
  } catch (err) {
    const message = describeEngineError(err);
    const field = fieldForEngineMessage(message);
    return failedState(message, field === "email" ? { email: message } : field === "name" ? { name: message } : {}, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved.", fieldErrors: {}, values: {} };
}

export async function setAutoSendAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const clientId = readText(formData, "clientId").trim();
  const value = readText(formData, "autoSend");
  if (!isUuidText(clientId)) return failedState(BAD_CLIENT, {}, {});
  if (value !== "on" && value !== "off") return failedState("Choose on or off.", {}, {});
  try {
    await setAutoSend(userId, clientId, value === "on", systemClock);
  } catch (err) {
    return failedState(describeEngineError(err), {}, {});
  }
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: value === "on"
      ? "Auto-send is on. The first reminder to this client goes out in the send window without waiting for approval."
      : "Auto-send is off. The first reminder to this client waits for your approval.",
    fieldErrors: {},
    values: {},
  };
}

// Creates a contact, or updates one when contactId is given. isPrimary makes it the client's primary.
export async function upsertContactAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const clientId = readText(formData, "clientId").trim();
  const contactId = readText(formData, "contactId").trim();
  const values = valuesFrom(formData, ["name", "email"]);
  if (!isUuidText(clientId)) return failedState(BAD_CLIENT, {}, values);
  if (contactId !== "" && !isUuidText(contactId)) return failedState("That contact could not be found.", {}, values);

  const errors: Record<string, string> = {};
  const name = readText(formData, "name").trim();
  if (name.length > 200) errors.name = "Use 200 characters or fewer.";
  const email = readText(formData, "email").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) errors.email = "Enter a valid email address.";
  if (Object.keys(errors).length > 0) return failedState("Check the highlighted fields.", errors, values);

  try {
    // The client's billing email is its primary contact's address. Editing that contact's address
    // moves the client's email with it, so the two never drift apart.
    if (contactId) {
      const detail = await getClientDetail(userId, clientId);
      const existing = detail.contacts.find((ct) => ct.id === contactId);
      if (existing?.isPrimary && existing.email === detail.email && email !== existing.email) {
        await updateClient(userId, clientId, { email }, systemClock);
      }
    }
    await upsertContact(
      userId,
      clientId,
      { id: contactId || undefined, email, name, isPrimary: readText(formData, "isPrimary") === "on" },
      systemClock,
    );
  } catch (err) {
    const message = describeEngineError(err);
    const field = fieldForEngineMessage(message);
    return failedState(message, field === "email" ? { email: message } : {}, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: contactId ? "Contact saved." : "Contact added.", fieldErrors: {}, values: {} };
}

export async function removeContactAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const contactId = readText(formData, "contactId").trim();
  if (!isUuidText(contactId)) return failedState("That contact could not be found.", {}, {});
  try {
    await removeContact(userId, contactId, systemClock);
  } catch (err) {
    return failedState(describeEngineError(err), {}, {});
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Contact removed.", fieldErrors: {}, values: {} };
}

export async function resumeContactAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const contactId = readText(formData, "contactId").trim();
  if (!isUuidText(contactId)) return failedState("That contact could not be found.", {}, {});
  try {
    await resumeContact({ userId, contactId, clock: systemClock });
  } catch (err) {
    return failedState(describeEngineError(err), {}, {});
  }
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: "Address resumed. Reminders can go to it again. Any whose planned time has passed were skipped, not sent late.",
    fieldErrors: {},
    values: {},
  };
}

export async function resumeClientAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const clientId = readText(formData, "clientId").trim();
  if (!isUuidText(clientId)) return failedState(BAD_CLIENT, {}, {});
  try {
    await resumeClient({ userId, clientId, clock: systemClock });
  } catch (err) {
    return failedState(describeEngineError(err), {}, {});
  }
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: "Reminders resumed. Any whose planned time has passed were skipped, not sent late.",
    fieldErrors: {},
    values: {},
  };
}

// One save for the whole contact block: the client's details, then each contact whose name or
// address changed, then a new contact if one was typed. Each contact is checked against the values
// it was loaded with, so an untouched contact is never rewritten.
export async function saveClientContactsAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const clientId = readText(formData, "clientId").trim();
  const values = valuesFrom(formData, ["name", "email", "timezone", "sequenceId", "newContactName", "newContactEmail"]);
  if (!isUuidText(clientId)) return failedState(BAD_CLIENT, {}, values);

  const errors: Record<string, string> = {};
  const sequenceIds = new Set((await listStandardSequenceChoices(userId)).map((s) => s.id));
  const fields = checkClientFields(formData, sequenceIds, errors);
  const primaryId = readText(formData, "primaryId").trim();

  const changes: { id: string; name: string; email: string }[] = [];
  for (const id of readTexts(formData, "contactId").filter(isUuidText)) {
    const name = readText(formData, `contactName_${id}`).trim();
    const email = readText(formData, `contactEmail_${id}`).trim().toLowerCase();
    values[`contactName_${id}`] = name;
    values[`contactEmail_${id}`] = email;
    const unchanged =
      name === readText(formData, `originalName_${id}`).trim() &&
      email === readText(formData, `originalEmail_${id}`).trim().toLowerCase();
    if (unchanged) continue;
    if (name.length > 200) errors[`contactName_${id}`] = "Use 200 characters or fewer.";
    if (!EMAIL.test(email) || email.length > 254) errors[`contactEmail_${id}`] = "Enter a valid email address.";
    changes.push({ id, name, email });
  }

  const newName = readText(formData, "newContactName").trim();
  const newEmail = readText(formData, "newContactEmail").trim().toLowerCase();
  const addNew = newName !== "" || newEmail !== "";
  if (addNew && (!EMAIL.test(newEmail) || newEmail.length > 254)) {
    errors.newContactEmail = "Enter a valid email address, or leave both new-contact fields empty.";
  }
  if (!fields || Object.keys(errors).length > 0) {
    return failedState("Check the highlighted fields.", errors, values);
  }

  try {
    await updateClient(
      userId,
      clientId,
      { name: fields.name, email: fields.email, timezone: fields.timezone, sequenceId: fields.sequenceId },
      systemClock,
    );
    for (const change of changes) {
      await upsertContact(
        userId,
        clientId,
        { id: change.id, name: change.name, email: change.email, isPrimary: change.id === primaryId },
        systemClock,
      );
    }
    if (addNew) {
      await upsertContact(userId, clientId, { name: newName, email: newEmail, isPrimary: false }, systemClock);
    }
  } catch (err) {
    const message = describeEngineError(err);
    const field = fieldForEngineMessage(message);
    return failedState(message, field === "email" ? { email: message } : field === "name" ? { name: message } : {}, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved.", fieldErrors: {}, values: {} };
}
