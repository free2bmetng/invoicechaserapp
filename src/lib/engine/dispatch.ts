// Records a provider call that was accepted (or may have been). One message_log
// row per scheduled message, and the first dispatch to a client releases rule (b).
import type { PoolClient } from "pg";
import * as S from "./store";

export interface DispatchInput {
  userId: string;
  message: S.MessageRow;
  clientId: string;
  provider: string;
  providerMessageId: string | null;
  recipient: string;
  cc: string[];
  subject: string;
  bodyText: string;
  manual: boolean;
  at: Date;
}

export async function recordDispatchTx(c: PoolClient, input: DispatchInput): Promise<void> {
  const { userId, message, clientId, at } = input;
  const first = !(await S.hasDispatched(c, userId, clientId));
  await c.query(
    `insert into message_log (user_id, scheduled_message_id, invoice_id, contact_id, recipient_email, cc_emails,
       subject, body_snapshot, provider, provider_message_id, sent_at, delivery_status, manual)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'sent', $12)
     on conflict do nothing`,
    [
      userId,
      message.id,
      message.invoice_id,
      message.contact_id,
      input.recipient,
      input.cc,
      input.subject,
      input.bodyText,
      input.provider,
      input.providerMessageId,
      at,
      input.manual,
    ],
  );
  await S.updateMessage(c, userId, message.id, { status: "sent" }, at);
  await S.logEvent(c, {
    userId,
    invoiceId: message.invoice_id,
    clientId,
    type: "message_sent",
    detail: { scheduled_message_id: message.id, provider: input.provider, manual: input.manual },
    at,
  });
  if (first) await S.releaseRuleB(c, userId, clientId, at);
}
