// The Sign-in section's data and actions, against the real database. Only the Next.js request context
// (session, redirect, cache refresh) is replaced, so the real passkey module and row-level security run.
import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminQuery, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { listPasskeys } from "@/lib/passkeys";
import { removePasskeyAction } from "@/app/actions/settings";
import { IDLE_FORM_STATE } from "@/components/settings/state";
import { setupOwner, sessionTokenFor } from "./fixtures";

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return { RedirectSignal, state: { userId: null as string | null }, refreshCalls: { count: 0 } };
});

vi.mock("@/lib/session", () => ({
  SESSION_COOKIE: "ic_session",
  requireUserId: async () => {
    if (!mocks.state.userId) throw new mocks.RedirectSignal("/login");
    return mocks.state.userId;
  },
  getUserId: async () => mocks.state.userId,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.RedirectSignal(url);
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof mocks.RedirectSignal) throw err;
  },
}));

vi.mock("next/cache", () => ({
  refresh: () => {
    mocks.refreshCalls.count += 1;
  },
}));

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
  mocks.state.userId = null;
  mocks.refreshCalls.count = 0;
});

// Inserts a passkey row the way the registration flow does, without any WebAuthn ceremony.
async function addPasskey(userId: string, label: string): Promise<string> {
  const { rows } = await adminQuery<{ id: string }>(
    "insert into passkeys (user_id, credential_id, public_key, label) values ($1, $2, 'cHVibGljLWtleQ', $3) returning id",
    [userId, `cred-${randomBytes(8).toString("hex")}`, label],
  );
  return rows[0].id;
}

async function passkeyCount(userId: string): Promise<number> {
  const { rows } = await adminQuery<{ n: string }>("select count(*)::text as n from passkeys where user_id = $1", [userId]);
  return Number(rows[0].n);
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.append(name, value);
  return data;
}

describe("the list shows only the signed-in user's passkeys", () => {
  it("returns the caller's passkeys with their labels and last-used times, and none of another user's", async () => {
    const alice = await setupOwner();
    const bob = await setupOwner();
    await addPasskey(alice.userId, "Maya's laptop");
    await addPasskey(alice.userId, "Phone");
    await addPasskey(bob.userId, "Bob's tablet");
    await adminQuery("update passkeys set last_used_at = now() where user_id = $1 and label = 'Phone'", [alice.userId]);

    const list = await listPasskeys(alice.userId);

    expect(list.map((p) => p.label).sort()).toEqual(["Maya's laptop", "Phone"]);
    const phone = list.find((p) => p.label === "Phone");
    expect(phone?.lastUsedAt).toBeInstanceOf(Date);
    expect(list.find((p) => p.label === "Maya's laptop")?.lastUsedAt).toBeNull();
  });
});

describe("removePasskeyAction", () => {
  it("refuses a request with no session and removes nothing", async () => {
    const owner = await setupOwner();
    const passkeyId = await addPasskey(owner.userId, "Phone");

    await expect(removePasskeyAction(IDLE_FORM_STATE, form({ passkeyId }))).rejects.toMatchObject({ url: "/login" });
    expect(await passkeyCount(owner.userId)).toBe(1);
  });

  it("refuses a malformed id with a calm error and removes nothing", async () => {
    const owner = await setupOwner();
    await addPasskey(owner.userId, "Phone");
    mocks.state.userId = owner.userId;

    const result = await removePasskeyAction(IDLE_FORM_STATE, form({ passkeyId: "not-an-id" }));

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/no longer on this account/);
    expect(await passkeyCount(owner.userId)).toBe(1);
  });

  it("refuses another user's passkey, even when its id is known", async () => {
    const alice = await setupOwner();
    const bob = await setupOwner();
    const bobsPasskey = await addPasskey(bob.userId, "Bob's tablet");
    mocks.state.userId = alice.userId;

    const result = await removePasskeyAction(IDLE_FORM_STATE, form({ passkeyId: bobsPasskey }));

    expect(result.status).toBe("error");
    expect(await passkeyCount(bob.userId)).toBe(1);
    expect(mocks.refreshCalls.count).toBe(0);
  });

  it("removes the caller's own passkey and refreshes the list", async () => {
    const owner = await setupOwner();
    const keep = await addPasskey(owner.userId, "Laptop");
    const remove = await addPasskey(owner.userId, "Phone");
    mocks.state.userId = owner.userId;

    const result = await removePasskeyAction(IDLE_FORM_STATE, form({ passkeyId: remove }));

    expect(result).toEqual({ status: "saved", message: "Passkey removed. Sign-in with the email link still works.", fieldErrors: {} });
    const remaining = await listPasskeys(owner.userId);
    expect(remaining.map((p) => p.id)).toEqual([keep]);
    expect(mocks.refreshCalls.count).toBe(1);
  });

  it("allows removing the last passkey, and the account and its sessions stay in place", async () => {
    const owner = await setupOwner();
    const only = await addPasskey(owner.userId, "Phone");
    await sessionTokenFor(owner.userId);
    mocks.state.userId = owner.userId;

    const result = await removePasskeyAction(IDLE_FORM_STATE, form({ passkeyId: only }));

    expect(result.status).toBe("saved");
    expect(await passkeyCount(owner.userId)).toBe(0);
    // The email link path depends on the user row and the session, not on passkeys.
    const { rows: users } = await adminQuery("select 1 from users where id = $1", [owner.userId]);
    expect(users).toHaveLength(1);
    const { rows: sessions } = await adminQuery("select 1 from sessions where user_id = $1", [owner.userId]);
    expect(sessions).toHaveLength(1);
  });

  it("shows a missing-id refusal when the form carries no passkey id", async () => {
    const owner = await setupOwner();
    mocks.state.userId = owner.userId;
    const result = await removePasskeyAction(IDLE_FORM_STATE, form({}));
    expect(result.status).toBe("error");
  });
});
