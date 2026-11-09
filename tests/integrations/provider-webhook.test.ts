// Email-provider delivery webhook. Signature checks, routing to the engine, and fail-closed
// behaviour. The engine is mocked: these tests cover the route, not the state changes.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ENV } from "../helpers/env";

vi.mock("@/lib/engine", () => ({
  recordDeliveryStatus: vi.fn(async () => undefined),
  recordBounce: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/webhooks/provider/route";
import { recordBounce, recordDeliveryStatus } from "@/lib/engine";

const URL_UNDER_TEST = "http://localhost:3000/api/webhooks/provider";

function sign(body: string, secret = TEST_ENV.PROVIDER_WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function post(body: string, signature: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-webhook-signature"] = signature;
  return new Request(URL_UNDER_TEST, { method: "POST", body, headers });
}

function eventBody(type: string, providerMessageId = "re_abc123"): string {
  return JSON.stringify({ type, provider: "resend", provider_message_id: providerMessageId });
}

describe("provider webhook: signature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a correctly signed delivered event", async () => {
    const body = eventBody("delivered");
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(recordDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(recordDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "resend", providerMessageId: "re_abc123", status: "delivered" }),
    );
  });

  it("accepts the hex signature in upper case", async () => {
    const body = eventBody("delivered");
    const res = await POST(post(body, sign(body).toUpperCase()));
    expect(res.status).toBe(200);
  });

  it("returns 401 and touches nothing when the signature header is missing", async () => {
    const res = await POST(post(eventBody("delivered"), null));
    expect(res.status).toBe(401);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
    expect(recordBounce).not.toHaveBeenCalled();
  });

  it("returns 401 for a signature made with a different secret", async () => {
    const body = eventBody("delivered");
    const res = await POST(post(body, sign(body, "some-other-secret")));
    expect(res.status).toBe(401);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
  });

  it("returns 401 for a signature of the wrong length without comparing content", async () => {
    const body = eventBody("delivered");
    const res = await POST(post(body, "abc123"));
    expect(res.status).toBe(401);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
  });

  it("returns 401 when the body is tampered with after signing", async () => {
    const original = eventBody("delivered");
    const signature = sign(original);
    const tampered = eventBody("bounced");
    const res = await POST(post(tampered, signature));
    expect(res.status).toBe(401);
    expect(recordBounce).not.toHaveBeenCalled();
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
  });

  it("returns 500 and touches nothing when the secret is not configured, so an empty key cannot forge a signature", async () => {
    vi.stubEnv("PROVIDER_WEBHOOK_SECRET", "");
    const body = eventBody("delivered");
    const forged = createHmac("sha256", "").update(body).digest("hex");
    const res = await POST(post(body, forged));
    expect(res.status).toBe(500);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body before reading signatures", async () => {
    const body = JSON.stringify({ type: "delivered", provider: "resend", provider_message_id: "x".repeat(70_000) });
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(413);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
  });
});

describe("provider webhook: routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes failed to recordDeliveryStatus", async () => {
    const body = eventBody("failed", "re_fail");
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(200);
    expect(recordDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "resend", providerMessageId: "re_fail", status: "failed" }),
    );
    expect(recordBounce).not.toHaveBeenCalled();
  });

  it("routes bounced to recordBounce, not to recordDeliveryStatus", async () => {
    const body = eventBody("bounced", "re_bounce");
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(200);
    expect(recordBounce).toHaveBeenCalledTimes(1);
    expect(recordBounce).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "resend", providerMessageId: "re_bounce" }),
    );
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
  });

  it("acknowledges a valid but unused event type with 200 and no engine calls", async () => {
    const body = eventBody("opened");
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(200);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
    expect(recordBounce).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed body that is not JSON", async () => {
    const body = "not json {";
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(400);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed event from a provider this route does not handle", async () => {
    const body = JSON.stringify({ type: "delivered", provider: "postmark", provider_message_id: "pm_1" });
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(400);
    expect(recordDeliveryStatus).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed event with no provider_message_id", async () => {
    const body = JSON.stringify({ type: "delivered", provider: "resend" });
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(400);
  });

  it("lets an engine error propagate so the provider receives a 5xx and retries", async () => {
    vi.mocked(recordDeliveryStatus).mockRejectedValueOnce(new Error("database unavailable"));
    const body = eventBody("delivered");
    await expect(POST(post(body, sign(body)))).rejects.toThrow("database unavailable");
  });
});
