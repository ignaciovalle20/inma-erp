import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption at rest of the AI provider keys in user_ai_settings.api_key.
 *
 * AES-256-GCM with a 32-byte key from AI_SETTINGS_ENCRYPTION_KEY (base64),
 * set per environment in Vercel and never sent to the browser. The database
 * (and every backup of it) only holds the ciphertext; decryption happens in
 * the server-only code that calls the provider (lib/ai/settings.ts).
 *
 * Stored format: `enc:v1:<iv>:<auth tag>:<ciphertext>`, each part base64url.
 * scripts/encrypt-ai-keys.mjs writes the same format for the rows saved
 * before this existed. A value without the prefix is one of those legacy
 * plaintext rows: it is still read, so the app keeps working between the
 * deploy and running that script.
 */
const PREFIX = "enc:v1:";

function encryptionKey(): Buffer {
  const raw = process.env.AI_SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("Missing AI_SETTINGS_ENCRYPTION_KEY env var");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("AI_SETTINGS_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

export function isEncryptedApiKey(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptApiKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(":");
}

export function decryptApiKey(stored: string): string {
  if (!isEncryptedApiKey(stored)) {
    return stored;
  }
  const [iv, tag, ciphertext] = stored.slice(PREFIX.length).split(":").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !ciphertext) {
    throw new Error("Malformed encrypted API key");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
