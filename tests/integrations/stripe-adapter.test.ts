/* eslint-disable @typescript-eslint/no-unused-vars -- test fakes mirror the Stripe method signatures */
// Stripe Payment Links adapter with an injected fake client. No network, no real key.
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  PAYMENT_LINK_PRODUCT_NAME,
  StripeLinksClient,
  StripePaymentProvider,
} from "@/lib/providers/stripe";

const IDS = {
  payable_id: "11111111-1111-4111-8111-111111111111",
  invoice_id: "22222222-2222-4222-8222-222222222222",
  user_id: "33333333-3333-4333-8333-333333333333",
};

function fakeClient() {
  const create = vi.fn(async (params: Stripe.PaymentLinkCreateParams, _options?: unknown) => ({
    id: "plink_test_1",
    url: "https://pay.example.test/plink_test_1",
    params,
  }));
  const update = vi.fn(async (_id: string, _params: unknown, _options?: unknown) => ({}));
  const client = { paymentLinks: { create, update } } as unknown as StripeLinksClient;
  return { client, create, update };
}

describe("StripePaymentProvider.createPaymentLink", () => {
  it("creates a one-off price in the exact amount and currency with the payable metadata", async () => {
    const { client, create } = fakeClient();
    const provider = new StripePaymentProvider(client);

    const link = await provider.createPaymentLink({
      amountMinor: 123450,
      currency: "USD",
      metadata: { ...IDS },
    });

    expect(link).toEqual({ id: "plink_test_1", url: "https://pay.example.test/plink_test_1" });
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0];
    expect(params).toEqual({
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 123450,
            product_data: { name: PAYMENT_LINK_PRODUCT_NAME },
          },
        },
      ],
      metadata: IDS,
    });
  });

  it("sends no destination, transfer or application-fee fields, so money settles to the user's account", async () => {
    const { client, create } = fakeClient();
    await new StripePaymentProvider(client).createPaymentLink({
      amountMinor: 500,
      currency: "EUR",
      metadata: { ...IDS },
    });
    const serialized = JSON.stringify(create.mock.calls[0][0]);
    expect(serialized).not.toMatch(/transfer|destination|application_fee|on_behalf_of/);
  });

  it("rejects a non-positive or fractional amount before calling Stripe", async () => {
    const { client, create } = fakeClient();
    const provider = new StripePaymentProvider(client);
    await expect(
      provider.createPaymentLink({ amountMinor: 0, currency: "USD", metadata: { ...IDS } }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      provider.createPaymentLink({ amountMinor: 10.5, currency: "USD", metadata: { ...IDS } }),
    ).rejects.toThrow(/positive integer/);
    expect(create).not.toHaveBeenCalled();
  });

  it("propagates Stripe errors so the caller can leave the message unsent", async () => {
    const create = vi.fn(async () => {
      throw new Error("Stripe is down");
    });
    const client = { paymentLinks: { create, update: vi.fn() } } as unknown as StripeLinksClient;
    await expect(
      new StripePaymentProvider(client).createPaymentLink({
        amountMinor: 100,
        currency: "USD",
        metadata: { ...IDS },
      }),
    ).rejects.toThrow("Stripe is down");
  });
});

describe("StripePaymentProvider.deactivatePaymentLink", () => {
  it("sets the link inactive", async () => {
    const { client, update } = fakeClient();
    await new StripePaymentProvider(client).deactivatePaymentLink("plink_old");
    expect(update).toHaveBeenCalledWith("plink_old", { active: false });
  });
});

describe("StripePaymentProvider acting for a connected account", () => {
  it("passes stripeAccount on create and on deactivate", async () => {
    const { client, create, update } = fakeClient();
    const provider = new StripePaymentProvider(client, { stripeAccount: "acct_123" });

    await provider.createPaymentLink({ amountMinor: 500, currency: "USD", metadata: { ...IDS } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ line_items: expect.any(Array) }), {
      stripeAccount: "acct_123",
    });

    await provider.deactivatePaymentLink("plink_x");
    expect(update).toHaveBeenCalledWith("plink_x", { active: false }, { stripeAccount: "acct_123" });
  });
});
