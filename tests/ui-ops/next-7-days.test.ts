// Next 7 days: grouping by local day, the window edges, holds, and the client-level lookup
// used by "Cancel held reminders".
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import { holdMessage, NotFoundError, recordReply } from "@/lib/engine";
import { heldMessageIdsForClient, loadNextSevenDays } from "@/lib/queries/ops";
import { adminQuery } from "../helpers/db";
import { messageFor, newClient, newInvoice, newUser, NEXT7_ISO, PLAN_ISO, resetDb } from "./fixtures";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

async function invoiceByNumber(userId: string, number: string): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>("select id from invoices where user_id = $1 and invoice_number = $2", [userId, number]);
  return rows[0].id;
}

describe("loadNextSevenDays", () => {
  it("groups reminders by local day, labels today and tomorrow, and shows times in the user's timezone", async () => {
    const userId = await newUser({ timezone: "UTC" });
    const auto = await newClient(userId, { autoSend: true });
    await newInvoice(userId, auto.clientId, { number: "A-1", due: "2030-01-10" }); // step on 10 Jan 09:00
    const manual = await newClient(userId, { autoSend: false });
    await newInvoice(userId, manual.clientId, { number: "M-1", due: "2030-01-12" }); // steps on 9, 12, 19, 26 Jan

    // The clock is 9 Jan 12:00 UTC, so "today" is 9 January.
    const view = await loadNextSevenDays(userId, fixedClock(NEXT7_ISO));
    expect(view.timezone).toBe("UTC");
    expect(view.groups.map((g) => g.label)).toEqual(["Today", "Tomorrow", "Saturday 12 Jan"]);
    expect(view.groups.map((g) => g.day)).toEqual(["2030-01-09", "2030-01-10", "2030-01-12"]);

    const tomorrow = view.groups.find((g) => g.day === "2030-01-10")!;
    expect(tomorrow.reminders[0].clientName).toBe("Acme Ltd");
    expect(tomorrow.reminders[0].contactEmail).toBe(auto.email);
    expect(tomorrow.reminders[0].invoiceNumber).toBe("A-1");
    expect(tomorrow.reminders[0].timeLabel).toBe("9:00 AM");
    expect(tomorrow.reminders[0].stepLabel).toBe("Friendly reminder, on the due date");
    expect(view.count).toBe(view.groups.reduce((n, g) => n + g.reminders.length, 0));
  });

  it("uses the user's timezone for the day boundary", async () => {
    const userId = await newUser({ timezone: "Asia/Tokyo" });
    const client = await newClient(userId, { autoSend: true });
    await newInvoice(userId, client.clientId, { number: "T-1", due: "2030-01-10" });

    // 9 Jan 20:00 UTC is already 10 Jan in Tokyo, so the 10 Jan 09:00 (Tokyo) step is "today".
    const view = await loadNextSevenDays(userId, fixedClock("2030-01-09T20:00:00.000Z"));
    expect(view.groups[0].day).toBe("2030-01-10");
    expect(view.groups[0].label).toBe("Today");
    expect(view.groups[0].reminders[0].timeLabel).toBe("9:00 AM");
  });

  it("leaves out reminders planned after the seven days", async () => {
    const userId = await newUser({ timezone: "UTC" });
    const client = await newClient(userId, { autoSend: true });
    await newInvoice(userId, client.clientId, { number: "L-1", due: "2030-01-30" }); // steps after 16 Jan

    const view = await loadNextSevenDays(userId, fixedClock(NEXT7_ISO));
    expect(view.count).toBe(0);
    expect(view.groups).toEqual([]);
  });

  it("shows held reminders, so they can be resumed from here", async () => {
    const userId = await newUser({ timezone: "UTC" });
    const client = await newClient(userId, { autoSend: true });
    await newInvoice(userId, client.clientId, { number: "H-1", due: "2030-01-10" });
    const messageId = await messageFor(await invoiceByNumber(userId, "H-1"));
    await holdMessage(userId, messageId, fixedClock(PLAN_ISO));

    const view = await loadNextSevenDays(userId, fixedClock(NEXT7_ISO));
    const row = view.groups.flatMap((g) => g.reminders).find((r) => r.id === messageId)!;
    expect(row.status).toBe("held");
  });

  it("never shows another user's reminders", async () => {
    const owner = await newUser({ timezone: "UTC" });
    const other = await newUser({ timezone: "UTC" });
    const client = await newClient(owner, { autoSend: true });
    await newInvoice(owner, client.clientId, { due: "2030-01-10" });

    expect((await loadNextSevenDays(owner, fixedClock(NEXT7_ISO))).count).toBeGreaterThan(0);
    expect((await loadNextSevenDays(other, fixedClock(NEXT7_ISO))).count).toBe(0);
  });
});

describe("heldMessageIdsForClient", () => {
  it("returns the held reminders for one client, and only those", async () => {
    const userId = await newUser();
    const client = await newClient(userId, { autoSend: true });
    await newInvoice(userId, client.clientId, { number: "R-1", due: "2030-01-12" });
    const other = await newClient(userId, { autoSend: true });
    await newInvoice(userId, other.clientId, { number: "R-2", due: "2030-01-12" });
    await recordReply({ userId, clientId: client.clientId, clock: fixedClock(PLAN_ISO) });

    const held = await heldMessageIdsForClient(userId, client.clientId);
    expect(held.length).toBeGreaterThan(0);
    expect(await heldMessageIdsForClient(userId, other.clientId)).toEqual([]);
  });

  it("refuses another user's client, and a malformed id", async () => {
    const owner = await newUser();
    const other = await newUser();
    const client = await newClient(owner, { autoSend: true });

    await expect(heldMessageIdsForClient(other, client.clientId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(heldMessageIdsForClient(owner, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });
});
