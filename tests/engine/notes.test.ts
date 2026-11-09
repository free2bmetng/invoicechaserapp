// Invoice notes: an "invoice_note" event with the text, written under the owner's lock,
// refused for another user's invoice and for an empty or oversized note.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminQuery, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { addInvoiceNote, NotFoundError, ValidationError } from "@/lib/engine";
import { NOW, addClient, addInvoice, clockAt, eventTypes, setupUser } from "./fixtures";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
});

async function notesOf(invoiceId: string) {
  const { rows } = await adminQuery<{ user_id: string; client_id: string | null; detail: { note: string }; created_at: Date }>(
    "select user_id, client_id, detail, created_at from events where invoice_id = $1 and type = 'invoice_note' order by id",
    [invoiceId],
  );
  return rows;
}

describe("addInvoiceNote", () => {
  it("records an invoice_note event with the trimmed text, the client and the clock time", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId);
    const invoiceId = await addInvoice(owner.userId, client.clientId);

    await addInvoiceNote(owner.userId, invoiceId, "  Client says the hours were billed twice.\r\nCalled on Tuesday.  ", clockAt(NOW));

    const notes = await notesOf(invoiceId);
    expect(notes).toHaveLength(1);
    expect(notes[0].detail.note).toBe("Client says the hours were billed twice.\nCalled on Tuesday.");
    expect(notes[0].user_id).toBe(owner.userId);
    expect(notes[0].client_id).toBe(client.clientId);
    expect(notes[0].created_at.toISOString()).toBe(NOW);
    expect(await eventTypes(invoiceId, "invoice_note")).toEqual(["invoice_note"]);
  });

  it("refuses another user's invoice as not found and records nothing", async () => {
    const owner = await setupUser();
    const intruder = await setupUser();
    const client = await addClient(owner.userId);
    const invoiceId = await addInvoice(owner.userId, client.clientId);

    await expect(addInvoiceNote(intruder.userId, invoiceId, "Not mine", clockAt(NOW))).rejects.toBeInstanceOf(NotFoundError);
    expect(await notesOf(invoiceId)).toHaveLength(0);
  });

  it("refuses an empty note and one over 2,000 characters", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId);
    const invoiceId = await addInvoice(owner.userId, client.clientId);

    await expect(addInvoiceNote(owner.userId, invoiceId, "   \n ", clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    await expect(addInvoiceNote(owner.userId, invoiceId, "x".repeat(2001), clockAt(NOW))).rejects.toBeInstanceOf(ValidationError);
    expect(await notesOf(invoiceId)).toHaveLength(0);
  });

  it("works on a closed invoice, so a paid or written-off invoice can still carry notes", async () => {
    const owner = await setupUser();
    const client = await addClient(owner.userId);
    const invoiceId = await addInvoice(owner.userId, client.clientId, { status: "paid" });
    await addInvoiceNote(owner.userId, invoiceId, "Paid by bank transfer.", clockAt(NOW));
    expect((await notesOf(invoiceId)).map((n) => n.detail.note)).toEqual(["Paid by bank transfer."]);
  });
});
