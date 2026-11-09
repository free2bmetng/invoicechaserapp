// Notes on an invoice (a dispute reason, a phone call, a promise to pay). A note is an
// "invoice_note" event, so it sits in the invoice's activity timeline with everything else.
// Written through withUser under the user lock, like every other engine write.
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { ValidationError } from "./errors";
import * as S from "./store";

export const INVOICE_NOTE_MAX = 2000;

export async function addInvoiceNote(userId: string, invoiceId: string, note: string, clock: Clock): Promise<void> {
  const text = typeof note === "string" ? note.replace(/\r\n?/g, "\n").trim() : "";
  if (text === "") throw new ValidationError("Write the note first.");
  if (text.length > INVOICE_NOTE_MAX) throw new ValidationError(`Notes must be ${INVOICE_NOTE_MAX.toLocaleString("en-US")} characters or fewer.`);
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    // Throws NotFoundError for an invoice that does not exist or belongs to someone else.
    const invoice = await S.loadInvoice(c, userId, invoiceId);
    await S.logEvent(c, {
      userId,
      invoiceId,
      clientId: invoice.client_id,
      type: "invoice_note",
      detail: { note: text },
      at: clock.now(),
    });
  });
}
