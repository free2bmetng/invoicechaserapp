// Daily digest against the real database and the real engine queues. The clock is fixed and
// the email provider is the in-memory fake, so nothing is sent.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminQuery, createUser, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { fixedClock } from "@/lib/clock";
import { runDigests, type DigestDeps } from "@/lib/digest";
import { FOOTER_LINES } from "@/lib/templates";
import { FakeEmailProvider } from "@/lib/providers/fake";
import { seedClientAndInvoice, seedScheduledMessage, seedSettings } from "./fixtures";

type SettingsOpts = Parameters<typeof seedSettings>[1];

const APP_URL = "https://app.example.test";
const DAY_1_0800_UTC = "2026-11-09T08:00:00.000Z";
const DAY_1_0805_UTC = "2026-11-09T08:05:00.000Z";
const DAY_1_0855_UTC = "2026-11-09T08:55:00.000Z";
const DAY_1_0900_UTC = "2026-11-09T09:00:00.000Z";
const DAY_2_0800_UTC = "2026-11-10T08:00:00.000Z";

async function seedUser(
  email: string,
  opts: {
    settings?: SettingsOpts;
    disputedInvoice?: string;
    upcoming?: Array<{ plannedAt: string; invoiceNumber: string }>;
  } = {},
): Promise<string> {
  const userId = await createUser(email);
  await seedSettings(userId, opts.settings);
  if (opts.disputedInvoice) {
    await seedClientAndInvoice(userId, { invoiceNumber: opts.disputedInvoice, status: "disputed" });
  }
  for (const item of opts.upcoming ?? []) {
    const { clientId, invoiceId } = await seedClientAndInvoice(userId, { invoiceNumber: item.invoiceNumber });
    await seedScheduledMessage(userId, invoiceId, clientId, new Date(item.plannedAt));
  }
  return userId;
}

function deps(
  iso: string,
  provider: FakeEmailProvider,
  emailFor?: DigestDeps["emailFor"],
): { clock: ReturnType<typeof fixedClock>; appUrl: string; emailFor: DigestDeps["emailFor"] } {
  return {
    clock: fixedClock(iso),
    appUrl: APP_URL,
    emailFor: emailFor ?? (async () => provider),
  };
}

async function digestRows(userId: string): Promise<string[]> {
  const { rows } = await adminQuery<{ d: string }>(
    "select digest_date::text as d from digests where user_id = $1 order by digest_date",
    [userId],
  );
  return rows.map((r) => r.d);
}

beforeEach(async () => {
  await resetDb();
});

describe("digest: once per local day", () => {
  it("sends at the digest hour, stays silent for the rest of that day, and sends again the next day", async () => {
    const userId = await seedUser("ada@example.test", { disputedInvoice: "INV-1001" });
    const provider = new FakeEmailProvider();

    const first = await runDigests(deps(DAY_1_0800_UTC, provider));
    expect(first).toMatchObject({ sent: 1, skipped: 0, failed: 0 });

    // Later runs in the digest hour, and runs after it, send nothing more that day.
    expect((await runDigests(deps(DAY_1_0805_UTC, provider))).sent).toBe(0);
    expect((await runDigests(deps(DAY_1_0855_UTC, provider))).sent).toBe(0);
    expect((await runDigests(deps(DAY_1_0900_UTC, provider))).sent).toBe(0);
    expect(provider.calls).toHaveLength(1);

    expect((await runDigests(deps(DAY_2_0800_UTC, provider))).sent).toBe(1);
    expect(provider.calls).toHaveLength(2);
    expect(await digestRows(userId)).toEqual(["2026-11-09", "2026-11-10"]);
    expect(provider.calls[0].idempotencyKey).toBe(`digest:${userId}:2026-11-09`);
  });

  it("does not send twice when two runs overlap at the digest hour", async () => {
    await seedUser("ada@example.test", { disputedInvoice: "INV-1001" });
    const provider = new FakeEmailProvider();
    const [a, b] = await Promise.all([
      runDigests(deps(DAY_1_0800_UTC, provider)),
      runDigests(deps(DAY_1_0800_UTC, provider)),
    ]);
    expect(a.sent + b.sent).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });
});

describe("digest: nothing to report", () => {
  it("is skipped when nothing is waiting or planned, and sends once something appears in the same hour", async () => {
    const userId = await seedUser("ada@example.test");
    const provider = new FakeEmailProvider();

    const quiet = await runDigests(deps(DAY_1_0800_UTC, provider));
    expect(quiet).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    expect(quiet.skips).toEqual([{ userId, reason: "nothing to report" }]);
    expect(provider.calls).toHaveLength(0);
    expect(await digestRows(userId)).toEqual([]);

    await seedClientAndInvoice(userId, { invoiceNumber: "INV-2001", status: "disputed" });
    const later = await runDigests(deps(DAY_1_0805_UTC, provider));
    expect(later.sent).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });
});

describe("digest: user timezone", () => {
  it("uses the user's local hour: nothing at 07:00 Los Angeles time, the digest at 08:00", async () => {
    const userId = await seedUser("ada@example.test", {
      disputedInvoice: "INV-1001",
      settings: { timezone: "America/Los_Angeles", digestHour: 8 },
    });
    const provider = new FakeEmailProvider();

    // 9 Nov 2026 is in Pacific Standard Time (UTC-8): 15:00Z is 07:00 local, 16:00Z is 08:00 local.
    expect((await runDigests(deps("2026-11-09T15:00:00.000Z", provider))).sent).toBe(0);
    expect(provider.calls).toHaveLength(0);

    expect((await runDigests(deps("2026-11-09T16:00:00.000Z", provider))).sent).toBe(1);
    expect(await digestRows(userId)).toEqual(["2026-11-09"]);
  });

  it("evaluates each user in their own zone at the same instant", async () => {
    const la = await seedUser("la@example.test", {
      disputedInvoice: "INV-1001",
      settings: { timezone: "America/Los_Angeles", digestHour: 8 },
    });
    const utc = await seedUser("utc@example.test", { disputedInvoice: "INV-2001", settings: { timezone: "UTC", digestHour: 8 } });
    const provider = new FakeEmailProvider();

    const result = await runDigests(deps("2026-11-09T16:00:00.000Z", provider));
    expect(result.sent).toBe(1);
    expect(provider.calls.map((c) => c.to)).toEqual(["la@example.test"]);
    expect(await digestRows(la)).toEqual(["2026-11-09"]);
    expect(await digestRows(utc)).toEqual([]);
  });

  it("shows planned times in the user's timezone", async () => {
    await seedUser("ada@example.test", {
      settings: { timezone: "America/Los_Angeles", digestHour: 8 },
      upcoming: [{ plannedAt: "2026-11-09T17:30:00.000Z", invoiceNumber: "INV-3001" }],
    });
    const provider = new FakeEmailProvider();
    await runDigests(deps("2026-11-09T16:00:00.000Z", provider));
    // 17:30Z is 09:30 Pacific.
    expect(provider.calls[0].text).toContain("9 Nov 2026 09:30");
    expect(provider.calls[0].text).not.toContain("17:30");
  });
});

describe("digest: disabled users", () => {
  it("sends nothing to a user with the digest switched off, and resumes once it is switched on", async () => {
    const userId = await seedUser("ada@example.test", {
      disputedInvoice: "INV-1001",
      settings: { digestEnabled: false },
    });
    const provider = new FakeEmailProvider();

    expect((await runDigests(deps(DAY_1_0800_UTC, provider))).sent).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(await digestRows(userId)).toEqual([]);

    await adminQuery("update settings set digest_enabled = true where user_id = $1", [userId]);
    expect((await runDigests(deps(DAY_1_0805_UTC, provider))).sent).toBe(1);
  });
});

describe("digest: content and envelope", () => {
  it("lists Needs you items and planned messages in the next 24 hours only, as plain text with the footer", async () => {
    await seedUser("ada@example.test", {
      disputedInvoice: "INV-1001",
      upcoming: [
        { plannedAt: "2026-11-10T07:00:00.000Z", invoiceNumber: "INV-3001" }, // 23 hours out: included
        { plannedAt: "2026-11-10T14:00:00.000Z", invoiceNumber: "INV-3002" }, // 30 hours out: excluded
      ],
    });
    const provider = new FakeEmailProvider();
    await runDigests(deps(DAY_1_0800_UTC, provider));

    const [email] = provider.calls;
    expect(email.from).toEqual({ name: "Ada Books", address: "digests@invoices.example.test" });
    expect(email.to).toBe("ada@example.test");
    expect(email.replyTo).toBe("ada@example.test");
    expect(email.cc).toEqual([]);
    expect(email.subject).toBe("Invoice Chaser digest: 1 need you, 1 planned in the next 24 hours");

    expect(email.text).toContain("Needs you (1)");
    expect(email.text).toContain("INV-1001");
    expect(email.text).toContain("Planned in the next 24 hours (1)");
    expect(email.text).toContain("INV-3001");
    expect(email.text).not.toContain("INV-3002");
    expect(email.text).toContain(`Open Invoice Chaser: ${APP_URL}`);
    expect(email.text.endsWith(FOOTER_LINES({
      senderName: "Ada Books",
      businessName: "Ada Books Ltd",
      postalAddress: "1 Harbour Road\nBristol BS1 4XY",
    }))).toBe(true);
    expect(email.text).not.toMatch(/<[a-z][^>]*>/i);
  });

  it("formats each planned amount in its invoice currency", async () => {
    await seedUser("ada@example.test", {
      upcoming: [{ plannedAt: "2026-11-10T07:00:00.000Z", invoiceNumber: "INV-3001" }],
    });
    const provider = new FakeEmailProvider();
    await runDigests(deps(DAY_1_0800_UTC, provider));
    expect(provider.calls[0].text).toMatch(/INV-3001 for .*, \$1,000\.00, to /);
  });
});

describe("digest: gating and failures", () => {
  it("is skipped, not sent, when the sender profile is incomplete", async () => {
    const userId = await seedUser("ada@example.test", {
      disputedInvoice: "INV-1001",
      settings: { businessName: "" },
    });
    const provider = new FakeEmailProvider();
    const result = await runDigests(deps(DAY_1_0800_UTC, provider));
    expect(result).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    expect(result.skips).toEqual([{ userId, reason: "sender profile incomplete" }]);
    expect(provider.calls).toHaveLength(0);
    expect(await digestRows(userId)).toEqual([]);
  });

  it("is skipped when the user has no sending domain", async () => {
    const userId = await seedUser("ada@example.test", {
      disputedInvoice: "INV-1001",
      settings: { sendingDomain: null },
    });
    const provider = new FakeEmailProvider();
    const result = await runDigests(deps(DAY_1_0800_UTC, provider));
    expect(result.skips).toEqual([{ userId, reason: "no sending domain" }]);
    expect(provider.calls).toHaveLength(0);
  });

  it("releases the day's claim after a refused send, so a retry in the same hour succeeds", async () => {
    const userId = await seedUser("ada@example.test", { disputedInvoice: "INV-1001" });
    const provider = new FakeEmailProvider();
    provider.nextFailure = "refused";

    const failed = await runDigests(deps(DAY_1_0800_UTC, provider));
    expect(failed).toMatchObject({ sent: 0, failed: 1 });
    expect(failed.errors[0].userId).toBe(userId);
    expect(await digestRows(userId)).toEqual([]);

    const retry = await runDigests(deps(DAY_1_0805_UTC, provider));
    expect(retry.sent).toBe(1);
    expect(await digestRows(userId)).toEqual(["2026-11-09"]);
  });

  it("keeps the day's claim after an ambiguous send, so the digest is never sent twice", async () => {
    const userId = await seedUser("ada@example.test", { disputedInvoice: "INV-1001" });
    const provider = new FakeEmailProvider();
    provider.nextFailure = "ambiguous";

    const failed = await runDigests(deps(DAY_1_0800_UTC, provider));
    expect(failed).toMatchObject({ sent: 0, failed: 1 });
    expect(await digestRows(userId)).toEqual(["2026-11-09"]);

    expect((await runDigests(deps(DAY_1_0805_UTC, provider))).sent).toBe(0);
    expect(provider.calls).toHaveLength(1);
  });

  it("keeps going for other users when one user's provider cannot be created", async () => {
    const broken = await seedUser("broken@example.test", { disputedInvoice: "INV-1001" });
    const fine = await seedUser("fine@example.test", { disputedInvoice: "INV-2001" });
    const provider = new FakeEmailProvider();
    const result = await runDigests(
      deps(DAY_1_0800_UTC, provider, async (userId) => {
        if (userId === broken) throw new Error("RESEND_API_KEY is not set");
        return provider;
      }),
    );
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(result.errors).toEqual([{ userId: broken, error: "RESEND_API_KEY is not set" }]);
    expect(provider.calls.map((c) => c.to)).toEqual(["fine@example.test"]);
    expect(await digestRows(fine)).toEqual(["2026-11-09"]);
  });
});

afterAll(async () => {
  await closeDb();
});
