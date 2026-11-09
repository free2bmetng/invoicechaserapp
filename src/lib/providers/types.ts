// Contracts shared by the sender, the Stripe adapter and the email adapters.

export interface OutgoingEmail {
  from: { name: string; address: string };
  replyTo: string;
  to: string;
  cc: string[];
  subject: string;
  text: string;
  // Stable per scheduled message. Providers that support idempotency keys use it.
  idempotencyKey: string;
}

export interface SendResult {
  providerMessageId: string;
}

// The provider definitely did not accept the message. Safe to mark failed.
export class ProviderRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRefusedError";
  }
}

// The outcome is unknown (timeout, dropped connection after the request left).
// The message must go to needs_check and must never be resent automatically.
export class ProviderAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAmbiguousError";
  }
}

export interface EmailProvider {
  readonly name: "fake" | "resend" | "postmark";
  send(email: OutgoingEmail): Promise<SendResult>;
}

export interface PaymentLink {
  id: string;
  url: string;
}

export interface PaymentLinkRequest {
  amountMinor: number;
  currency: string;
  metadata: { payable_id: string; invoice_id: string; user_id: string };
}

export interface PaymentProvider {
  createPaymentLink(req: PaymentLinkRequest): Promise<PaymentLink>;
  deactivatePaymentLink(id: string): Promise<void>;
}
