// Sender cron endpoint. runSender is mocked: these tests cover authorization, the
// dependencies the route passes in, and the JSON summary returned.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ENV } from "../helpers/env";

const SUMMARY = { claimed: 2, sent: 1, deferred: 1, cancelled: 0, held: 0, failed: 0, needsCheck: 0 };
const DIGEST = { sent: 1, skipped: 0, failed: 0, skips: [], errors: [] };

vi.mock("@/lib/engine", () => ({
  runSender: vi.fn(async () => ({ claimed: 2, sent: 1, deferred: 1, cancelled: 0, held: 0, failed: 0, needsCheck: 0 })),
}));
vi.mock("@/lib/digest", () => ({
  runDigests: vi.fn(async () => ({ sent: 1, skipped: 0, failed: 0, skips: [], errors: [] })),
}));
vi.mock("@/lib/providers/factory", () => ({
  emailFor: vi.fn(async () => ({ name: "fake" })),
  paymentsFor: vi.fn(async () => null),
}));

import { GET, POST } from "@/app/api/cron/send/route";
import { runSender } from "@/lib/engine";
import { runDigests } from "@/lib/digest";
import { emailFor, paymentsFor } from "@/lib/providers/factory";

const URL_UNDER_TEST = "http://localhost:3000/api/cron/send";

function request(method: "GET" | "POST", authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return new Request(URL_UNDER_TEST, { method, headers });
}

describe("cron /api/cron/send authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runSender).mockResolvedValue(SUMMARY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["GET", undefined],
    ["POST", undefined],
    ["GET", ""],
    ["POST", "Bearer "],
    ["POST", "Bearer wrong-secret"],
    ["GET", "Bearer test-cron-secret-extra"],
    ["POST", "test-cron-secret"],
    ["GET", "Basic dGVzdDp0ZXN0"],
  ] as const)("returns 401 and runs nothing for %s with authorization %j", async (method, auth) => {
    const res = await (method === "GET" ? GET : POST)(request(method, auth));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(runSender).not.toHaveBeenCalled();
  });

  it("returns 401 when CRON_SECRET is not configured, even for an empty bearer token", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await GET(request("GET", "Bearer "));
    expect(res.status).toBe(401);
    expect(runSender).not.toHaveBeenCalled();
  });

  it("accepts the correct secret via GET, the method Vercel Cron uses", async () => {
    const res = await GET(request("GET", `Bearer ${TEST_ENV.CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sender: SUMMARY, digest: DIGEST });
    expect(runSender).toHaveBeenCalledTimes(1);
  });

  it("accepts the correct secret via POST", async () => {
    const res = await POST(request("POST", `Bearer ${TEST_ENV.CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sender: SUMMARY, digest: DIGEST });
    expect(runSender).toHaveBeenCalledTimes(1);
  });
});

describe("cron /api/cron/send dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runSender).mockResolvedValue(SUMMARY);
  });

  it("passes the system clock, APP_URL and the provider factories to runSender", async () => {
    await GET(request("GET", `Bearer ${TEST_ENV.CRON_SECRET}`));

    expect(runSender).toHaveBeenCalledTimes(1);
    const [deps] = vi.mocked(runSender).mock.calls[0] as unknown as [
      { appUrl: string; emailFor: unknown; paymentsFor: unknown; clock: { now(): Date } },
    ];
    expect(deps.appUrl).toBe(TEST_ENV.APP_URL);
    expect(deps.emailFor).toBe(emailFor);
    expect(deps.paymentsFor).toBe(paymentsFor);
    // The clock is the real one, so "now" tracks wall time.
    const before = Date.now();
    const now = deps.clock.now().getTime();
    expect(Math.abs(now - before)).toBeLessThan(5_000);
  });

  it("returns 500 without running when APP_URL is missing", async () => {
    vi.stubEnv("APP_URL", "");
    const res = await GET(request("GET", `Bearer ${TEST_ENV.CRON_SECRET}`));
    expect(res.status).toBe(500);
    expect(runSender).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("passes the clock, APP_URL and provider factories to runDigests, after the sender", async () => {
    await GET(request("GET", `Bearer ${TEST_ENV.CRON_SECRET}`));
    expect(runDigests).toHaveBeenCalledTimes(1);
    const [deps] = vi.mocked(runDigests).mock.calls[0] as unknown as [
      { appUrl: string; emailFor: unknown; clock: { now(): Date } },
    ];
    expect(deps.appUrl).toBe(TEST_ENV.APP_URL);
    expect(deps.emailFor).toBe(emailFor);
    const senderOrder = vi.mocked(runSender).mock.invocationCallOrder[0];
    const digestOrder = vi.mocked(runDigests).mock.invocationCallOrder[0];
    expect(senderOrder).toBeLessThan(digestOrder);
  });

  it("reports a digest failure in the response and still returns the sender result", async () => {
    vi.mocked(runDigests).mockRejectedValueOnce(new Error("digest query failed"));
    const res = await GET(request("GET", `Bearer ${TEST_ENV.CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sender: SUMMARY, digest: { error: "digest query failed" } });
    expect(runSender).toHaveBeenCalledTimes(1);
  });

  it("lets a runSender failure surface as an error so the run is visible", async () => {
    vi.mocked(runSender).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(GET(request("GET", `Bearer ${TEST_ENV.CRON_SECRET}`))).rejects.toThrow("database unavailable");
  });
});
