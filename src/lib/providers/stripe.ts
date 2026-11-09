// Stripe Payment Links adapter. Money settles straight into the user's own Stripe account:
// no destination charges, transfers or application fees. With Connect OAuth, pass the connected
// account id as the account option so each call acts for that account.
import type Stripe from "stripe";
import { PaymentLink, PaymentLinkRequest, PaymentProvider } from "./types";

export const PAYMENT_LINK_PRODUCT_NAME = "Invoice payment";

export interface StripeRequestOptions {
  stripeAccount?: string;
}

// The subset of the Stripe client this adapter uses. The real client satisfies it,
// and tests inject a fake one so nothing touches the network.
export interface StripeLinksClient {
  paymentLinks: {
    create(
      params: Stripe.PaymentLinkCreateParams,
      options?: StripeRequestOptions,
    ): Promise<Pick<Stripe.PaymentLink, "id" | "url">>;
    update(id: string, params: Stripe.PaymentLinkUpdateParams, options?: StripeRequestOptions): Promise<unknown>;
  };
}

export class StripePaymentProvider implements PaymentProvider {
  constructor(
    private readonly client: StripeLinksClient,
    private readonly account?: StripeRequestOptions,
  ) {}

  async createPaymentLink(req: PaymentLinkRequest): Promise<PaymentLink> {
    if (!Number.isSafeInteger(req.amountMinor) || req.amountMinor <= 0) {
      throw new Error("Payment link amount must be a positive integer in minor units");
    }
    const params: Stripe.PaymentLinkCreateParams = {
      line_items: [
        {
          quantity: 1,
          price_data: {
            // Stripe requires a lowercase ISO 4217 code; invoices store uppercase.
            currency: req.currency.toLowerCase(),
            unit_amount: req.amountMinor,
            product_data: { name: PAYMENT_LINK_PRODUCT_NAME },
          },
        },
      ],
      metadata: { ...req.metadata },
    };
    const link = this.account
      ? await this.client.paymentLinks.create(params, this.account)
      : await this.client.paymentLinks.create(params);
    return { id: link.id, url: link.url };
  }

  async deactivatePaymentLink(id: string): Promise<void> {
    const params: Stripe.PaymentLinkUpdateParams = { active: false };
    if (this.account) {
      await this.client.paymentLinks.update(id, params, this.account);
    } else {
      await this.client.paymentLinks.update(id, params);
    }
  }
}
