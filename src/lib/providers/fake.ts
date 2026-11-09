// Deterministic fake providers for tests and the seeded demo. No network.
import { randomUUID } from "node:crypto";
import {
  EmailProvider,
  OutgoingEmail,
  PaymentLink,
  PaymentLinkRequest,
  PaymentProvider,
  ProviderAmbiguousError,
  ProviderRefusedError,
  SendResult,
} from "./types";

export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake" as const;
  // Every call, including failed ones. Tests assert "exactly one call per step" against this.
  readonly calls: OutgoingEmail[] = [];
  // Messages the fake accepted, keyed by idempotency key (duplicates return the same id).
  readonly accepted = new Map<string, { providerMessageId: string; email: OutgoingEmail }>();
  // One-shot failure to inject on the next call.
  nextFailure: "refused" | "ambiguous" | null = null;

  async send(email: OutgoingEmail): Promise<SendResult> {
    this.calls.push(email);
    if (this.nextFailure) {
      const kind = this.nextFailure;
      this.nextFailure = null;
      if (kind === "refused") throw new ProviderRefusedError("fake provider refused the message");
      throw new ProviderAmbiguousError("fake provider timed out");
    }
    const existing = this.accepted.get(email.idempotencyKey);
    if (existing) return { providerMessageId: existing.providerMessageId };
    const providerMessageId = `fake_${randomUUID()}`;
    this.accepted.set(email.idempotencyKey, { providerMessageId, email });
    return { providerMessageId };
  }

  reset(): void {
    this.calls.length = 0;
    this.accepted.clear();
    this.nextFailure = null;
  }
}

export class FakePaymentProvider implements PaymentProvider {
  readonly createdLinks: Array<PaymentLinkRequest & PaymentLink> = [];
  readonly deactivated: string[] = [];
  nextFailure = false;
  private seq = 0;

  async createPaymentLink(req: PaymentLinkRequest): Promise<PaymentLink> {
    if (this.nextFailure) {
      this.nextFailure = false;
      throw new Error("fake payment provider failed to create a link");
    }
    const id = `plink_fake_${++this.seq}`;
    const link = { id, url: `https://pay.example.test/${id}` };
    this.createdLinks.push({ ...req, ...link });
    return link;
  }

  async deactivatePaymentLink(id: string): Promise<void> {
    this.deactivated.push(id);
  }

  reset(): void {
    this.createdLinks.length = 0;
    this.deactivated.length = 0;
    this.nextFailure = false;
  }
}
