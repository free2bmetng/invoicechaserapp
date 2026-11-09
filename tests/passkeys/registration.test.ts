// Passkey registration and management: options, storage, the label, and per-user isolation.
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import {
  beginRegistration,
  DEFAULT_PASSKEY_LABEL,
  finishRegistration,
  listPasskeys,
  PASSKEY_LABEL_MAX_LENGTH,
  PasskeyRegistrationError,
  removePasskey,
  sanitizePasskeyLabel,
} from "@/lib/passkeys";
import { adminQuery, createUser } from "../helpers/db";
import { attestationFor, insertPasskey, resetPasskeyDb, T0, verifiedAttestation } from "./helpers";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(actual.verifyAuthenticationResponse),
    verifyRegistrationResponse: vi.fn(actual.verifyRegistrationResponse),
  };
});

const clock = fixedClock(T0);

beforeEach(async () => {
  await resetPasskeyDb();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

describe("beginRegistration", () => {
  it("asks for a discoverable credential with user verification, and excludes the passkeys already on the account", async () => {
    const userId = await createUser("options@example.test");
    await insertPasskey(userId, { credentialId: "cred-old-1" });
    await insertPasskey(userId, { credentialId: "cred-old-2" });

    const options = await beginRegistration(userId, clock);

    expect(options.rp).toEqual({ name: "Invoice Chaser", id: "localhost" });
    expect(options.user.name).toBe("options@example.test");
    expect(Buffer.from(options.user.id, "base64url").toString("utf8")).toBe(userId);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(options.excludeCredentials?.map((c) => c.id).sort()).toEqual(["cred-old-1", "cred-old-2"]);
  });

  it("does not exclude another user's passkeys", async () => {
    const owner = await createUser("owner-excl@example.test");
    const other = await createUser("other-excl@example.test");
    await insertPasskey(owner, { credentialId: "cred-owner" });

    const options = await beginRegistration(other, clock);
    expect(options.excludeCredentials ?? []).toEqual([]);
  });
});

describe("finishRegistration", () => {
  it("stores the passkey for the user with its public key, transports and label", async () => {
    const userId = await createUser("store@example.test");
    const options = await beginRegistration(userId, clock);
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce(verifiedAttestation("cred-laptop", new Uint8Array([1, 2, 3]), 0));

    const saved = await finishRegistration(userId, attestationFor(options.challenge, "cred-laptop", ["internal"]), "  MacBook  ", clock);

    expect(saved).toEqual({ id: expect.any(String), label: "MacBook" });
    const { rows } = await adminQuery<{ user_id: string; public_key: string; transports: string[]; label: string; counter: string }>(
      "select user_id, public_key, transports, label, counter::text as counter from passkeys where credential_id = 'cred-laptop'",
    );
    expect(rows).toEqual([
      { user_id: userId, public_key: Buffer.from([1, 2, 3]).toString("base64url"), transports: ["internal"], label: "MacBook", counter: "0" },
    ]);
  });

  it("defaults the label when none is given", async () => {
    const userId = await createUser("default-label@example.test");
    const options = await beginRegistration(userId, clock);
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce(verifiedAttestation("cred-x", new Uint8Array([4])));

    await expect(finishRegistration(userId, attestationFor(options.challenge, "cred-x"), undefined, clock)).resolves.toMatchObject({
      label: DEFAULT_PASSKEY_LABEL,
    });
  });

  it("refuses a response the library does not verify, with the generic message, and stores nothing", async () => {
    const userId = await createUser("unverified@example.test");
    const options = await beginRegistration(userId, clock);
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({ verified: false });

    await expect(finishRegistration(userId, attestationFor(options.challenge), "Phone", clock)).rejects.toBeInstanceOf(
      PasskeyRegistrationError,
    );
    expect((await adminQuery("select 1 from passkeys")).rowCount).toBe(0);
  });

  it("a passkey cannot be registered for another user, and the refused attempt does not spend the owner's challenge", async () => {
    const owner = await createUser("owner-reg@example.test");
    const intruder = await createUser("intruder-reg@example.test");
    const options = await beginRegistration(owner, clock);
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce(verifiedAttestation("cred-theirs", new Uint8Array([8])));

    await expect(finishRegistration(intruder, attestationFor(options.challenge, "cred-theirs"), "Mine now", clock)).rejects.toBeInstanceOf(
      PasskeyRegistrationError,
    );
    expect((await adminQuery("select 1 from passkeys")).rowCount).toBe(0);

    await expect(finishRegistration(owner, attestationFor(options.challenge, "cred-theirs"), "Owner", clock)).resolves.toMatchObject({
      label: "Owner",
    });
    const { rows } = await adminQuery<{ user_id: string }>("select user_id from passkeys");
    expect(rows).toEqual([{ user_id: owner }]);
  });
});

describe("sanitizePasskeyLabel", () => {
  it("keeps at most 40 characters, counting emoji as one character", () => {
    const label = sanitizePasskeyLabel("🔐".repeat(60));
    expect(Array.from(label)).toHaveLength(PASSKEY_LABEL_MAX_LENGTH);
    expect(label).toBe("🔐".repeat(PASSKEY_LABEL_MAX_LENGTH));
  });

  it("removes control and bidi-override characters and collapses whitespace", () => {
    expect(sanitizePasskeyLabel("Work\u0000‮ laptop\n\t  ")).toBe("Work laptop");
  });

  it("falls back to the default for blank or non-string input", () => {
    expect(sanitizePasskeyLabel("   \t ")).toBe(DEFAULT_PASSKEY_LABEL);
    expect(sanitizePasskeyLabel(undefined)).toBe(DEFAULT_PASSKEY_LABEL);
    expect(sanitizePasskeyLabel({ label: "x" })).toBe(DEFAULT_PASSKEY_LABEL);
  });
});

describe("listPasskeys and removePasskey", () => {
  it("lists only the signed-in user's passkeys", async () => {
    const alice = await createUser("alice-list@example.test");
    const bob = await createUser("bob-list@example.test");
    await insertPasskey(alice, { credentialId: "cred-alice", label: "Alice phone" });
    await insertPasskey(bob, { credentialId: "cred-bob", label: "Bob phone" });

    const listed = await listPasskeys(alice);
    expect(listed.map((p) => p.label)).toEqual(["Alice phone"]);
  });

  it("removes only the caller's own passkey: another user's id matches nothing", async () => {
    const alice = await createUser("alice-rm@example.test");
    const bob = await createUser("bob-rm@example.test");
    await insertPasskey(alice, { credentialId: "cred-alice" });
    const bobsId = await insertPasskey(bob, { credentialId: "cred-bob" });

    await expect(removePasskey(alice, bobsId)).resolves.toBe(false);
    const { rows } = await adminQuery<{ credential_id: string }>("select credential_id from passkeys order by credential_id");
    expect(rows).toEqual([{ credential_id: "cred-alice" }, { credential_id: "cred-bob" }]);
  });

  it("removes the caller's own passkey, and removing the last one is allowed", async () => {
    const alice = await createUser("alice-last@example.test");
    const id = await insertPasskey(alice, { credentialId: "cred-only" });

    await expect(removePasskey(alice, id)).resolves.toBe(true);
    await expect(listPasskeys(alice)).resolves.toEqual([]);
  });

  it("treats a malformed id as not found", async () => {
    const alice = await createUser("alice-bad-id@example.test");
    await expect(removePasskey(alice, "not-a-uuid")).resolves.toBe(false);
  });
});
