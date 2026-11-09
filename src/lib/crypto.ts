// AES-256-GCM for secrets at rest (Stripe keys, OAuth tokens).
// Format: base64(iv):base64(tag):base64(ciphertext). A fresh random 12-byte IV is
// used for every call. The key is read from ENCRYPTION_KEY, which must be base64
// for exactly 32 bytes. It is read on each call, so rotating the env value takes effect
// without a restart.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function loadKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(`ENCRYPTION_KEY is not set. Set it to ${KEY_BYTES} random bytes, base64-encoded.`);
  }
  const key = Buffer.from(raw, "base64");
  // Buffer.from ignores bad characters, so check that the value round-trips.
  if (key.length !== KEY_BYTES || key.toString("base64") !== raw) {
    throw new Error(
      `ENCRYPTION_KEY must be base64 for exactly ${KEY_BYTES} bytes (for example: openssl rand -base64 ${KEY_BYTES}).`,
    );
  }
  return key;
}

export function encryptSecret(plain: string): string {
  if (typeof plain !== "string") throw new TypeError("encryptSecret expects a string.");
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64")).join(":");
}

// Throws on any tampering, a wrong key or a malformed value. The message never
// includes the ciphertext or the key.
export function decryptSecret(cipher: string): string {
  const key = loadKey();
  const parts = typeof cipher === "string" ? cipher.split(":") : [];
  if (parts.length !== 3 || !parts.every((part) => BASE64.test(part))) {
    throw new Error("Stored secret is malformed.");
  }
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64"));
  // Reject a short IV or tag. GCM would accept a truncated tag, which weakens
  // authentication.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Stored secret is malformed.");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Stored secret could not be decrypted. It may be tampered with, or ENCRYPTION_KEY may be wrong.");
  }
}
