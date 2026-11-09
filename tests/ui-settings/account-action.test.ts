// The delete-account server action, against the real database. The request context (session,
// cookies, redirect) is replaced. Stripe is never reached: these accounts have no connection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminQuery, resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { deleteAccountAction } from "@/app/actions/account";
import { IDLE_FORM_STATE } from "@/components/settings/state";
import { addInvoice, setupOwner } from "./fixtures";

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return {
    RedirectSignal,
    state: { userId: null as string | null },
    cookieDeletes: [] as string[],
  };
});

vi.mock("@/lib/session", () => ({
  SESSION_COOKIE: "ic_session",
  requireUserId: async () => {
    if (!mocks.state.userId) throw new mocks.RedirectSignal("/login");
    return mocks.state.userId;
  },
  getUserId: async () => mocks.state.userId,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    delete: (name: string) => {
      mocks.cookieDeletes.push(name);
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.RedirectSignal(url);
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof mocks.RedirectSignal) throw err;
  },
}));

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.append(name, value);
  return data;
}

async function userExists(userId: string): Promise<boolean> {
  const { rows } = await adminQuery("select 1 from users where id = $1", [userId]);
  return rows.length > 0;
}

beforeEach(async () => {
  await resetDb();
  mocks.state.userId = null;
  mocks.cookieDeletes.length = 0;
});

describe("deleteAccountAction", () => {
  it("refuses a request with no session and deletes nothing", async () => {
    const owner = await setupOwner();
    await expect(deleteAccountAction(IDLE_FORM_STATE, form({ confirmEmail: owner.email }))).rejects.toMatchObject({
      url: "/login",
    });
    expect(await userExists(owner.userId)).toBe(true);
    expect(mocks.cookieDeletes).toHaveLength(0);
  });

  it("returns a field error for a mismatched address, keeps the account and the cookie", async () => {
    const owner = await setupOwner();
    await addInvoice(owner.userId);
    mocks.state.userId = owner.userId;

    const result = await deleteAccountAction(IDLE_FORM_STATE, form({ confirmEmail: "someone-else@example.test" }));

    expect(result.status).toBe("error");
    expect(result.fieldErrors.confirmEmail).toMatch(/does not match your sign-in address/);
    expect(await userExists(owner.userId)).toBe(true);
    expect(mocks.cookieDeletes).toHaveLength(0);
  });

  it("ignores a user_id in the form: only the session user can be deleted", async () => {
    const alice = await setupOwner();
    const bob = await setupOwner();
    mocks.state.userId = alice.userId;

    const result = await deleteAccountAction(IDLE_FORM_STATE, form({ confirmEmail: bob.email, user_id: bob.userId }));

    expect(result.fieldErrors.confirmEmail).toBeTruthy();
    expect(await userExists(bob.userId)).toBe(true);
    expect(await userExists(alice.userId)).toBe(true);
  });

  it("deletes the account, clears the session cookie, and redirects to sign-in", async () => {
    const owner = await setupOwner();
    mocks.state.userId = owner.userId;

    await expect(deleteAccountAction(IDLE_FORM_STATE, form({ confirmEmail: owner.email }))).rejects.toMatchObject({
      url: "/login",
    });

    expect(await userExists(owner.userId)).toBe(false);
    expect(mocks.cookieDeletes).toEqual(["ic_session"]);
  });
});
