// Client, contact and hold server actions: authorization, validation, ownership and resume.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class NextRedirect extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return { session: { userId: null as string | null }, NextRedirect };
});

vi.mock("@/lib/session", () => ({
  requireUserId: async () => {
    if (!h.session.userId) throw new h.NextRedirect("/login");
    return h.session.userId;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, updateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.NextRedirect(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { closeDb } from "@/lib/db";
import { listClients, recordReply, type ClientListItem } from "@/lib/engine";
import { filterClients, loadClientFigures, outstandingBars, parseClientSort, sortClients } from "@/app/(app)/clients/client-data";
import {
  createClientAction,
  removeContactAction,
  resumeClientAction,
  resumeContactAction,
  saveClientContactsAction,
  setAutoSendAction,
  updateClientAction,
  upsertContactAction,
} from "@/app/actions/clients";
import { IDLE_FORM_STATE } from "@/components/invoices/form-state";
import { resetDb } from "../helpers/db";
import { clock, form, makeClient, makeInvoice, makeUser, scalar, statusCount, type TestUser } from "./fixtures";

async function redirectTarget(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof h.NextRedirect) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

let owner: TestUser;

beforeEach(async () => {
  await resetDb();
  owner = await makeUser();
  h.session.userId = owner.userId;
});

afterAll(async () => {
  await closeDb();
});

describe("authorization", () => {
  it("refuses every client action without a session and changes nothing", async () => {
    const client = await makeClient(owner.userId);
    h.session.userId = null;
    await expect(createClientAction(IDLE_FORM_STATE, form({}))).rejects.toMatchObject({ url: "/login" });
    await expect(updateClientAction(IDLE_FORM_STATE, form({ clientId: client.clientId, name: "X" }))).rejects.toMatchObject({ url: "/login" });
    await expect(setAutoSendAction(IDLE_FORM_STATE, form({ clientId: client.clientId, autoSend: "on" }))).rejects.toMatchObject({ url: "/login" });
    await expect(upsertContactAction(IDLE_FORM_STATE, form({ clientId: client.clientId, email: "x@y.test" }))).rejects.toMatchObject({ url: "/login" });
    await expect(removeContactAction(IDLE_FORM_STATE, form({ contactId: client.contactId }))).rejects.toMatchObject({ url: "/login" });
    await expect(resumeClientAction(IDLE_FORM_STATE, form({ clientId: client.clientId }))).rejects.toMatchObject({ url: "/login" });
    await expect(resumeContactAction(IDLE_FORM_STATE, form({ contactId: client.contactId }))).rejects.toMatchObject({ url: "/login" });
    expect(await scalar("select auto_send::text from clients where id = $1", [client.clientId])).toBe("false");
  });
});

describe("createClientAction", () => {
  it("reports each bad field beside its message and creates nothing", async () => {
    const state = await createClientAction(
      IDLE_FORM_STATE,
      form({ name: "  ", email: "not-an-email", timezone: "Mars/Olympus", sequenceId: "", autoSend: "" }),
    );
    expect(state.ok).toBe(false);
    expect(state.fieldErrors.name).toBe("Enter the client's name.");
    expect(state.fieldErrors.email).toBe("Enter a valid email address.");
    expect(state.fieldErrors.timezone).toBe("Choose a timezone from the list.");
    expect(await scalar("select count(*)::text from clients where user_id = $1", [owner.userId])).toBe("0");
  });

  it("refuses a sequence override that is not one of the user's standard sequences", async () => {
    const state = await createClientAction(
      IDLE_FORM_STATE,
      form({ name: "Acme", email: "a@acme.test", timezone: "", sequenceId: "00000000-0000-4000-8000-000000000000", autoSend: "" }),
    );
    expect(state.fieldErrors.sequenceId).toBe("Choose a sequence from the list.");
  });

  it("reports a duplicate email on the email field", async () => {
    await makeClient(owner.userId, { email: "taken@acme.test" });
    const state = await createClientAction(IDLE_FORM_STATE, form({ name: "Other", email: "TAKEN@acme.test", timezone: "", sequenceId: "", autoSend: "" }));
    expect(state.fieldErrors.email).toMatch(/already exists/);
  });

  it("creates the client with a lower-cased email and redirects to it", async () => {
    const target = await redirectTarget(
      createClientAction(IDLE_FORM_STATE, form({ name: "Northwind", email: "Billing@Northwind.test", timezone: "Europe/London", sequenceId: "", autoSend: "on" })),
    );
    const clientId = await scalar<string>("select id::text from clients where name = 'Northwind'");
    expect(target).toBe(`/clients/${clientId}`);
    expect(await scalar("select email from clients where id = $1", [clientId])).toBe("billing@northwind.test");
    expect(await scalar("select timezone from clients where id = $1", [clientId])).toBe("Europe/London");
    expect(await scalar("select auto_send::text from clients where id = $1", [clientId])).toBe("true");
    expect(await scalar("select count(*)::text from contacts where client_id = $1 and is_primary", [clientId])).toBe("1");
  });
});

describe("updateClientAction", () => {
  it("saves a timezone and a sequence override for the user's client", async () => {
    const client = await makeClient(owner.userId);
    const seq = await scalar<string>("select id::text from sequences where user_id = $1 and kind = 'standard' and is_default", [owner.userId]);
    const state = await updateClientAction(
      IDLE_FORM_STATE,
      form({ clientId: client.clientId, name: "Acme Ltd", email: client.email, timezone: "America/New_York", sequenceId: seq }),
    );
    expect(state.ok).toBe(true);
    expect(await scalar("select timezone from clients where id = $1", [client.clientId])).toBe("America/New_York");
    expect(await scalar("select sequence_id::text from clients where id = $1", [client.clientId])).toBe(seq);
  });

  it("refuses another user's client as not found", async () => {
    const other = await makeUser();
    const theirs = await makeClient(other.userId, { name: "Theirs" });
    const state = await updateClientAction(IDLE_FORM_STATE, form({ clientId: theirs.clientId, name: "Mine now", email: theirs.email, timezone: "", sequenceId: "" }));
    expect(state.ok).toBe(false);
    expect(state.message).toMatch(/not found/i);
    expect(await scalar("select name from clients where id = $1", [theirs.clientId])).toBe("Theirs");
  });

  it("refuses a malformed client id", async () => {
    const state = await updateClientAction(IDLE_FORM_STATE, form({ clientId: "nope", name: "X", email: "x@y.test", timezone: "", sequenceId: "" }));
    expect(state.ok).toBe(false);
  });
});

describe("setAutoSendAction", () => {
  it("turns auto-send on and off, and explains what it does", async () => {
    const client = await makeClient(owner.userId);
    const on = await setAutoSendAction(IDLE_FORM_STATE, form({ clientId: client.clientId, autoSend: "on" }));
    expect(on.ok).toBe(true);
    expect(on.message).toMatch(/without waiting for approval/);
    expect(await scalar("select auto_send::text from clients where id = $1", [client.clientId])).toBe("true");

    const off = await setAutoSendAction(IDLE_FORM_STATE, form({ clientId: client.clientId, autoSend: "off" }));
    expect(off.message).toMatch(/waits for your approval/);
    expect(await scalar("select auto_send::text from clients where id = $1", [client.clientId])).toBe("false");
  });

  it("rejects an unknown value and another user's client", async () => {
    const client = await makeClient(owner.userId);
    expect((await setAutoSendAction(IDLE_FORM_STATE, form({ clientId: client.clientId, autoSend: "maybe" }))).ok).toBe(false);

    const other = await makeUser();
    const theirs = await makeClient(other.userId);
    const state = await setAutoSendAction(IDLE_FORM_STATE, form({ clientId: theirs.clientId, autoSend: "on" }));
    expect(state.ok).toBe(false);
    expect(await scalar("select auto_send::text from clients where id = $1", [theirs.clientId])).toBe("false");
  });
});

describe("contacts", () => {
  it("adds a contact, and refuses a second contact with the same address", async () => {
    const client = await makeClient(owner.userId);
    const added = await upsertContactAction(IDLE_FORM_STATE, form({ clientId: client.clientId, name: "Pat", email: "pat@acme.test" }));
    expect(added.ok).toBe(true);
    const again = await upsertContactAction(IDLE_FORM_STATE, form({ clientId: client.clientId, name: "Pat", email: "PAT@acme.test" }));
    expect(again.ok).toBe(false);
    expect(again.fieldErrors.email).toMatch(/already has a contact/);
  });

  it("makes another contact primary, and refuses to remove the primary", async () => {
    const client = await makeClient(owner.userId);
    const added = await upsertContactAction(IDLE_FORM_STATE, form({ clientId: client.clientId, name: "Pat", email: "pat@acme.test" }));
    expect(added.ok).toBe(true);
    const patId = await scalar<string>("select id::text from contacts where client_id = $1 and email = 'pat@acme.test'", [client.clientId]);

    const promoted = await upsertContactAction(IDLE_FORM_STATE, form({ clientId: client.clientId, contactId: patId, name: "Pat", email: "pat@acme.test", isPrimary: "on" }));
    expect(promoted.ok).toBe(true);
    expect(await scalar("select id::text from contacts where client_id = $1 and is_primary", [client.clientId])).toBe(patId);

    const removePrimary = await removeContactAction(IDLE_FORM_STATE, form({ contactId: patId }));
    expect(removePrimary.ok).toBe(false);
    expect(removePrimary.message).toMatch(/Choose another primary contact/);
  });

  it("removes a non-primary contact that has no sent messages", async () => {
    const client = await makeClient(owner.userId);
    await upsertContactAction(IDLE_FORM_STATE, form({ clientId: client.clientId, name: "Old", email: "old@acme.test" }));
    const oldId = await scalar<string>("select id::text from contacts where client_id = $1 and email = 'old@acme.test'", [client.clientId]);
    const state = await removeContactAction(IDLE_FORM_STATE, form({ contactId: oldId }));
    expect(state.ok).toBe(true);
    expect(await scalar("select count(*)::text from contacts where id = $1", [oldId])).toBe("0");
  });
});

describe("holds and resume", () => {
  it("a reply holds every unsent reminder for the client, and resuming the client releases them", async () => {
    const client = await makeClient(owner.userId);
    await makeInvoice(owner.userId, client.clientId, { number: "INV-A" });
    await makeInvoice(owner.userId, client.clientId, { number: "INV-B" });
    expect(await scalar("select count(*)::text from scheduled_messages where user_id = $1 and status = 'held'", [owner.userId])).toBe("0");

    await recordReply({ userId: owner.userId, clientId: client.clientId, clock });
    expect(await scalar("select reply_held_at is not null from clients where id = $1", [client.clientId])).toBe(true);
    const heldBefore = Number(await scalar("select count(*)::text from scheduled_messages where user_id = $1 and status = 'held'", [owner.userId]));
    expect(heldBefore).toBeGreaterThan(0);

    const state = await resumeClientAction(IDLE_FORM_STATE, form({ clientId: client.clientId }));
    expect(state.ok).toBe(true);
    expect(await scalar("select reply_held_at is null from clients where id = $1", [client.clientId])).toBe(true);
    expect(await scalar("select count(*)::text from scheduled_messages where user_id = $1 and status = 'held'", [owner.userId])).toBe("0");
  });

  it("a bounced address stays on hold until its contact is resumed", async () => {
    const client = await makeClient(owner.userId);
    const invoice = await makeInvoice(owner.userId, client.clientId);
    await upsertContactAction(IDLE_FORM_STATE, form({ clientId: client.clientId, name: "Bounced", email: "bounce@acme.test" }));
    const bounceId = await scalar<string>("select id::text from contacts where client_id = $1 and email = 'bounce@acme.test'", [client.clientId]);
    // Set the hold the way a provider bounce does, without touching any other state.
    await scalar("update contacts set hold = 'bounced' where id = $1 returning id", [bounceId]);

    const state = await resumeContactAction(IDLE_FORM_STATE, form({ contactId: bounceId }));
    expect(state.ok).toBe(true);
    expect(await scalar("select hold is null from contacts where id = $1", [bounceId])).toBe(true);
    expect(await statusCount(invoice.invoiceId, "held")).toBe(0);
  });

  it("refuses to resume another user's client or contact", async () => {
    const other = await makeUser();
    const theirs = await makeClient(other.userId);
    await recordReply({ userId: other.userId, clientId: theirs.clientId, clock });
    // The owner's session cannot see the other user's client or contact, so nothing is changed.
    const client = await resumeClientAction(IDLE_FORM_STATE, form({ clientId: theirs.clientId }));
    expect(client.ok).toBe(false);
    const contact = await resumeContactAction(IDLE_FORM_STATE, form({ contactId: theirs.contactId }));
    expect(contact.ok).toBe(false);
    expect(await scalar("select reply_held_at is not null from clients where id = $1", [theirs.clientId])).toBe(true);
  });
});

// The one-Save contact block: validation keeps every write back, and a save touches only what changed.
describe("saveClientContactsAction", () => {
  function blockFields(clientId: string, contactId: string, contactEmail: string, extra: Record<string, string> = {}) {
    return {
      clientId,
      name: "Acme Ltd",
      email: "acme@acme.test",
      timezone: "",
      sequenceId: "",
      primaryId: contactId,
      contactId,
      [`contactName_${contactId}`]: "Accounts",
      [`contactEmail_${contactId}`]: contactEmail,
      // The name the contact was loaded with: makeClient names the primary contact after the client.
      [`originalName_${contactId}`]: "Acme Ltd",
      [`originalEmail_${contactId}`]: "acme@acme.test",
      ...extra,
    };
  }

  it("refuses without a session", async () => {
    const client = await makeClient(owner.userId);
    h.session.userId = null;
    await expect(saveClientContactsAction(IDLE_FORM_STATE, form(blockFields(client.clientId, client.contactId, "acme@acme.test")))).rejects.toMatchObject({ url: "/login" });
  });

  it("reports a bad contact address beside its field and changes nothing", async () => {
    const client = await makeClient(owner.userId, { name: "Acme Ltd", email: "acme@acme.test" });
    const state = await saveClientContactsAction(IDLE_FORM_STATE, form(blockFields(client.clientId, client.contactId, "not-an-email")));
    expect(state.ok).toBe(false);
    expect(state.fieldErrors[`contactEmail_${client.contactId}`]).toBe("Enter a valid email address.");
    expect(await scalar("select email from contacts where id = $1", [client.contactId])).toBe("acme@acme.test");
  });

  it("saves a changed contact and adds a new one, and leaves an untouched contact alone", async () => {
    const client = await makeClient(owner.userId, { name: "Acme Ltd", email: "acme@acme.test" });
    await upsertContactAction(IDLE_FORM_STATE, form({ clientId: client.clientId, name: "Second", email: "second@acme.test" }));
    const secondId = await scalar<string>("select id::text from contacts where client_id = $1 and email = 'second@acme.test'", [client.clientId]);

    const state = await saveClientContactsAction(
      IDLE_FORM_STATE,
      form({
        ...blockFields(client.clientId, client.contactId, "acme@acme.test"),
        contactId: [client.contactId, secondId],
        [`contactName_${secondId}`]: "Second",
        [`contactEmail_${secondId}`]: "second@acme.test",
        [`originalName_${secondId}`]: "Second",
        [`originalEmail_${secondId}`]: "second@acme.test",
        newContactName: "Newcomer",
        newContactEmail: "new@acme.test",
      }),
    );
    expect(state.ok).toBe(true);
    expect(await scalar("select name from contacts where id = $1", [client.contactId])).toBe("Accounts");
    expect(await scalar("select count(*)::text from events where type = 'contact_updated' and detail->>'contact_id' = $1", [secondId])).toBe("0");
    expect(await scalar("select count(*)::text from contacts where client_id = $1 and email = 'new@acme.test'", [client.clientId])).toBe("1");
  });
});

function listItem(name: string, extra: Partial<ClientListItem> = {}): ClientListItem {
  return {
    id: name, name, email: `${name.toLowerCase()}@example.test`, timezone: null, sequenceId: null, autoSend: false, replyHeldAt: null,
    contactCount: 1, outstanding: [], overdue: [], lastContactAt: null, averageDaysToPay: null, avgDaysLate: null, ...extra,
  };
}

describe("clients list sorting and search", () => {
  const rows = [
    listItem("Bravo", { outstanding: [{ currency: "USD", amountMinor: 5000 }], overdue: [{ currency: "USD", amountMinor: 1000 }], avgDaysLate: 3, lastContactAt: new Date("2026-11-01T10:00:00Z") }),
    listItem("alpha", { outstanding: [{ currency: "GBP", amountMinor: 9000 }], overdue: [], avgDaysLate: null }),
    listItem("Charlie", { outstanding: [{ currency: "USD", amountMinor: 2000 }], overdue: [{ currency: "USD", amountMinor: 2000 }], avgDaysLate: 30, lastContactAt: new Date("2026-11-09T10:00:00Z") }),
    listItem("Delta"),
  ];
  const names = (list: ClientListItem[]) => list.map((c) => c.name);

  it("sorts by each column, keeps clients without a value last, and breaks ties by name", () => {
    expect(names(sortClients(rows, "overdue", "desc"))).toEqual(["Charlie", "Bravo", "alpha", "Delta"]);
    expect(names(sortClients(rows, "outstanding", "desc"))).toEqual(["alpha", "Bravo", "Charlie", "Delta"]);
    expect(names(sortClients(rows, "name", "asc"))).toEqual(["alpha", "Bravo", "Charlie", "Delta"]);
    expect(names(sortClients(rows, "name", "desc"))).toEqual(["Delta", "Charlie", "Bravo", "alpha"]);
    expect(names(sortClients(rows, "pays", "desc"))).toEqual(["Charlie", "Bravo", "alpha", "Delta"]);
    expect(names(sortClients(rows, "pays", "asc"))).toEqual(["Bravo", "Charlie", "alpha", "Delta"]);
    expect(names(sortClients(rows, "contact", "desc"))).toEqual(["Charlie", "Bravo", "alpha", "Delta"]);
    expect(names(sortClients(rows, "contact", "asc"))).toEqual(["Bravo", "Charlie", "alpha", "Delta"]);
    // The input is not changed.
    expect(names(rows)).toEqual(["Bravo", "alpha", "Charlie", "Delta"]);
  });

  it("reads the sort from the query string with a sensible default direction", () => {
    expect(parseClientSort(undefined, undefined)).toEqual({ key: "overdue", dir: "desc" });
    expect(parseClientSort("name", undefined)).toEqual({ key: "name", dir: "asc" });
    expect(parseClientSort("contact", "asc")).toEqual({ key: "contact", dir: "asc" });
    expect(parseClientSort("drop table", "sideways")).toEqual({ key: "overdue", dir: "desc" });
  });

  it("searches names and emails, and sizes each outstanding bar within its currency", () => {
    expect(names(filterClients(rows, "CHAR"))).toEqual(["Charlie"]);
    expect(names(filterClients(rows, "delta@"))).toEqual(["Delta"]);
    expect(names(filterClients(rows, "  "))).toHaveLength(4);
    const bars = outstandingBars(rows);
    expect(bars.get("Bravo")).toMatchObject({ currency: "USD", share: 1, overdueMinor: 1000 });
    expect(bars.get("Charlie")?.share).toBeCloseTo(0.4);
    expect(bars.get("alpha")?.share).toBe(1);
    expect(bars.has("Delta")).toBe(false);
  });

  it("sorts the real list from listClients by overdue amount", async () => {
    const small = await makeClient(owner.userId, { name: "Small Co" });
    const big = await makeClient(owner.userId, { name: "Big Co" });
    await makeInvoice(owner.userId, small.clientId, { amountMinor: 10000, due: "2026-10-01" });
    await makeInvoice(owner.userId, big.clientId, { amountMinor: 90000, due: "2026-10-01" });
    await makeClient(owner.userId, { name: "Quiet Co" });
    const list = await listClients(owner.userId, clock);
    expect(names(sortClients(list, "overdue", "desc"))).toEqual(["Big Co", "Small Co", "Quiet Co"]);
  });
});

describe("client header figures", () => {
  it("reports outstanding, overdue, how late the client pays, and the last reply", async () => {
    const client = await makeClient(owner.userId, { name: "Figures Ltd" });
    await makeInvoice(owner.userId, client.clientId, { amountMinor: 50000, due: "2026-10-01" });
    await makeInvoice(owner.userId, client.clientId, { amountMinor: 20000, due: "2027-01-15" });
    await makeInvoice(owner.userId, client.clientId, { amountMinor: 30000, issue: "2026-10-01", due: "2026-10-20", status: "paid" });

    const before = await loadClientFigures(owner.userId, client.clientId, clock);
    expect(before).not.toBeNull();
    expect(before!.outstanding).toEqual([{ currency: "USD", amountMinor: 70000 }]);
    expect(before!.overdue).toEqual([{ currency: "USD", amountMinor: 50000 }]);
    // Paid on 10 Nov, due 20 Oct: 21 days late. 40 days from issue.
    expect(before!.avgDaysLate).toBe(21);
    expect(before!.averageDaysToPay).toBe(40);
    expect(before!.lastReplyAt).toBeNull();

    await recordReply({ userId: owner.userId, clientId: client.clientId, clock });
    const after = await loadClientFigures(owner.userId, client.clientId, clock);
    expect(after!.lastReplyAt?.toISOString()).toBe("2026-11-10T12:00:00.000Z");
  });

  it("shows nothing owed and no history for a new client, and nothing for another user's client", async () => {
    const client = await makeClient(owner.userId);
    const figures = await loadClientFigures(owner.userId, client.clientId, clock);
    expect(figures).toMatchObject({ outstanding: [], overdue: [], avgDaysLate: null, lastReplyAt: null, lastContactAt: null });
    const other = await makeUser();
    expect(await loadClientFigures(other.userId, client.clientId, clock)).toBeNull();
  });
});

describe("editing the primary contact", () => {
  it("moves the client's email with the primary contact's address", async () => {
    const client = await makeClient(owner.userId, { email: "old@acme.test" });
    const state = await upsertContactAction(
      IDLE_FORM_STATE,
      form({ clientId: client.clientId, contactId: client.contactId, name: "Accounts", email: "new@acme.test", isPrimary: "on" }),
    );
    expect(state.ok).toBe(true);
    expect(await scalar("select email from clients where id = $1", [client.clientId])).toBe("new@acme.test");
    expect(await scalar("select email from contacts where id = $1", [client.contactId])).toBe("new@acme.test");
    expect(await scalar("select name from contacts where id = $1", [client.contactId])).toBe("Accounts");
  });
});
