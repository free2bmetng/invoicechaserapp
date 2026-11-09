import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;
const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY_A;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

// Flips one bit of a base64 part and returns the new base64 value.
function flipBit(b64: string, byteIndex = 0): string {
  const bytes = Buffer.from(b64, "base64");
  bytes[byteIndex % bytes.length] ^= 0x01;
  return bytes.toString("base64");
}

describe("encryptSecret and decryptSecret", () => {
  it("round-trips ASCII and Unicode text", () => {
    for (const plain of ["rk_live_example_key", "pässwörd €🔑", "x".repeat(4096)]) {
      expect(decryptSecret(encryptSecret(plain))).toBe(plain);
    }
  });

  it("round-trips the empty string", () => {
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });

  it("writes base64(iv):base64(tag):base64(ciphertext) with a 12-byte IV and 16-byte tag", () => {
    const parts = encryptSecret("hello").split(":");
    expect(parts).toHaveLength(3);
    expect(Buffer.from(parts[0], "base64")).toHaveLength(12);
    expect(Buffer.from(parts[1], "base64")).toHaveLength(16);
    expect(Buffer.from(parts[2], "base64")).toHaveLength(5);
  });

  it("never stores the plaintext", () => {
    const secret = "sk_restricted_SUPER_SECRET_VALUE";
    const cipher = encryptSecret(secret);
    expect(cipher).not.toContain("SUPER_SECRET");
    expect(Buffer.from(cipher.split(":")[2], "base64").toString("utf8")).not.toContain("SUPER_SECRET");
  });

  it("uses a fresh random IV, so the same plaintext encrypts differently each time", () => {
    const first = encryptSecret("same");
    const second = encryptSecret("same");
    expect(first).not.toBe(second);
    expect(first.split(":")[0]).not.toBe(second.split(":")[0]);
  });

  it("uses a 32-byte key from ENCRYPTION_KEY, so a different key cannot decrypt", () => {
    const cipher = encryptSecret("secret");
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(() => decryptSecret(cipher)).toThrow(/could not be decrypted/);
  });

  it("detects a changed ciphertext byte", () => {
    const [iv, tag, ct] = encryptSecret("attack at dawn").split(":");
    expect(() => decryptSecret([iv, tag, flipBit(ct)].join(":"))).toThrow(/could not be decrypted/);
  });

  it("detects a changed authentication tag", () => {
    const [iv, tag, ct] = encryptSecret("attack at dawn").split(":");
    expect(() => decryptSecret([iv, flipBit(tag), ct].join(":"))).toThrow(/could not be decrypted/);
  });

  it("detects a changed IV", () => {
    const [iv, tag, ct] = encryptSecret("attack at dawn").split(":");
    expect(() => decryptSecret([flipBit(iv), tag, ct].join(":"))).toThrow(/could not be decrypted/);
  });

  it("detects a truncated tag, which GCM would accept if the length were not checked", () => {
    const [iv, tag, ct] = encryptSecret("attack at dawn").split(":");
    const shortTag = Buffer.from(tag, "base64").subarray(0, 8).toString("base64");
    expect(() => decryptSecret([iv, shortTag, ct].join(":"))).toThrow(/malformed/);
  });

  it("detects appended ciphertext bytes", () => {
    const [iv, tag, ct] = encryptSecret("attack at dawn").split(":");
    const extended = Buffer.concat([Buffer.from(ct, "base64"), Buffer.from("X")]).toString("base64");
    expect(() => decryptSecret([iv, tag, extended].join(":"))).toThrow(/could not be decrypted/);
  });

  it.each([
    ["an empty string", ""],
    ["two parts", "aaaa:bbbb"],
    ["four parts", "a:b:c:d"],
    ["non-base64 characters", "!!:@@:##"],
    ["a wrong-length IV", `${randomBytes(8).toString("base64")}:${randomBytes(16).toString("base64")}:${randomBytes(4).toString("base64")}`],
  ])("rejects a malformed value (%s)", (_label, value) => {
    expect(() => decryptSecret(value)).toThrow(/malformed/);
  });

  it("encrypts with the key from the environment at call time", () => {
    const cipher = encryptSecret("rotate me");
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(decryptSecret(encryptSecret("rotate me"))).toBe("rotate me");
    expect(() => decryptSecret(cipher)).toThrow();
  });
});

describe("ENCRYPTION_KEY validation", () => {
  it("throws a clear error when the key is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/ENCRYPTION_KEY is not set/);
  });

  it("throws when the key is blank", () => {
    process.env.ENCRYPTION_KEY = "   ";
    expect(() => encryptSecret("x")).toThrow(/ENCRYPTION_KEY is not set/);
  });

  it("requires exactly 32 bytes (a 16-byte key is refused)", () => {
    process.env.ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/exactly 32 bytes/);
  });

  it("requires exactly 32 bytes (a 33-byte key is refused)", () => {
    process.env.ENCRYPTION_KEY = randomBytes(33).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/exactly 32 bytes/);
  });

  it("refuses text that is not base64", () => {
    process.env.ENCRYPTION_KEY = "this is not base64 at all!!";
    expect(() => encryptSecret("x")).toThrow(/exactly 32 bytes/);
  });

  it("does not echo the key in the error message", () => {
    const badKey = randomBytes(16).toString("base64");
    process.env.ENCRYPTION_KEY = badKey;
    try {
      encryptSecret("x");
      expect.unreachable("encryptSecret should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(badKey);
    }
  });

  it("accepts a valid key with trailing whitespace from a pasted env value", () => {
    process.env.ENCRYPTION_KEY = `${KEY_A}\n`;
    expect(decryptSecret(encryptSecret("pasted"))).toBe("pasted");
  });

  it("fails decryption with the same clear error when the key is missing", () => {
    const cipher = encryptSecret("x");
    delete process.env.ENCRYPTION_KEY;
    expect(() => decryptSecret(cipher)).toThrow(/ENCRYPTION_KEY is not set/);
  });
});

describe("argument checks", () => {
  it("rejects non-string plaintext", () => {
    expect(() => encryptSecret(42 as unknown as string)).toThrow(TypeError);
  });
});
