// GET /api/export. The real session path runs (cookie -> session row -> user id). Only the request
// cookie jar and the redirect are replaced, so an anonymous request is refused before any data is read.
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../helpers/db";
import { closeDb } from "@/lib/db";
import { addInvoice, sessionTokenFor, seedStripeConnection, setupOwner } from "./fixtures";

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  return { RedirectSignal, cookieToken: { value: undefined as string | undefined } };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ic_session" && mocks.cookieToken.value ? { name, value: mocks.cookieToken.value } : undefined),
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

import { GET } from "@/app/api/export/route";

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
  mocks.cookieToken.value = undefined;
});

async function zipEntries(response: Response): Promise<Record<string, string>> {
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, strFromU8(bytes)]));
}

describe("authorization", () => {
  it("redirects an anonymous request to sign-in and returns no data", async () => {
    await setupOwner();
    await expect(GET()).rejects.toBeInstanceOf(mocks.RedirectSignal);
    await expect(GET()).rejects.toMatchObject({ url: "/login" });
  });

  it("refuses a cookie that matches no live session", async () => {
    await setupOwner();
    mocks.cookieToken.value = "not-a-real-session-token";
    await expect(GET()).rejects.toMatchObject({ url: "/login" });
  });
});

describe("a signed-in download", () => {
  it("returns a zip attachment, never cached, named with the local date", async () => {
    const owner = await setupOwner();
    mocks.cookieToken.value = await sessionTokenFor(owner.userId);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="invoice-chaser-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
  });

  it("contains the user's own rows, one CSV per table", async () => {
    const owner = await setupOwner();
    await addInvoice(owner.userId, { invoiceNumber: "INV-EXPORT-1" });
    mocks.cookieToken.value = await sessionTokenFor(owner.userId);

    const files = await zipEntries(await GET());

    expect(Object.keys(files)).toEqual(expect.arrayContaining(["users.csv", "settings.csv", "invoices.csv", "events.csv"]));
    expect(files["invoices.csv"]).toContain("INV-EXPORT-1");
    expect(files["users.csv"]).toContain(owner.email);
  });

  it("contains none of another user's rows", async () => {
    const alice = await setupOwner();
    const bob = await setupOwner();
    await addInvoice(bob.userId, { invoiceNumber: "BOB-ONLY-0001", clientEmail: "bob-client@example.test" });
    mocks.cookieToken.value = await sessionTokenFor(alice.userId);

    const files = await zipEntries(await GET());

    const everything = Object.values(files).join("\n");
    expect(everything).not.toContain(bob.email);
    expect(everything).not.toContain("BOB-ONLY-0001");
    expect(everything).not.toContain("bob-client@example.test");
    expect(files["users.csv"]).toContain(alice.email);
  });

  it("never includes the Stripe key or its ciphertext", async () => {
    const owner = await setupOwner();
    await seedStripeConnection(owner.userId, "rk_live_EXPORTSECRET_9999");
    mocks.cookieToken.value = await sessionTokenFor(owner.userId);

    const files = await zipEntries(await GET());

    const everything = Object.values(files).join("\n");
    expect(everything).not.toContain("EXPORTSECRET");
    expect(everything).not.toContain("rk_live");
    expect(files["connected_accounts.csv"]).not.toContain("secret_ciphertext");
    expect(files["connected_accounts.csv"]).toContain("Restricted key ending 9999");
  });

  it("marks spreadsheet formulas so they are not run", async () => {
    const owner = await setupOwner();
    await addInvoice(owner.userId, { invoiceNumber: "=HYPERLINK(\"https://evil.example.test\")" });
    mocks.cookieToken.value = await sessionTokenFor(owner.userId);

    const files = await zipEntries(await GET());

    expect(files["invoices.csv"]).toContain("'=HYPERLINK");
    expect(files["invoices.csv"]).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});
