#!/usr/bin/env node
/**
 * One-off: encrypts the user_ai_settings.api_key values saved before
 * src/lib/ai/keyCrypto.ts existed (same format: enc:v1:<iv>:<tag>:<ct>).
 * Idempotent: rows already encrypted are skipped, and each update only
 * applies if the row still holds the plaintext it read.
 *
 * Env (web/.env.local is loaded if present; explicit env vars win):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  -- target project
 *   AI_SETTINGS_ENCRYPTION_KEY                           -- the SAME value the
 *                                                           app uses there
 * Usage (from web/):
 *   node scripts/encrypt-ai-keys.mjs           # dry run: counts only
 *   node scripts/encrypt-ai-keys.mjs --apply   # encrypt and verify
 * Never prints a key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

nextEnv.loadEnvConfig(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

const PREFIX = "enc:v1:";
const apply = process.argv.includes("--apply");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const rawKey = process.env.AI_SETTINGS_ENCRYPTION_KEY;

if (!url || !serviceKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
if (!rawKey) throw new Error("Missing AI_SETTINGS_ENCRYPTION_KEY");
const key = Buffer.from(rawKey, "base64");
if (key.length !== 32) throw new Error("AI_SETTINGS_ENCRYPTION_KEY must be 32 bytes, base64-encoded");

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ciphertext].map((p) => p.toString("base64url")).join(":");
}

function decrypt(stored) {
  const [iv, tag, ciphertext] = stored.slice(PREFIX.length).split(":").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
console.log(`Target: ${new URL(url).host}${apply ? "" : " (dry run)"}`);

const { data: rows, error } = await db.from("user_ai_settings").select("user_id, api_key");
if (error) throw error;
const plain = rows.filter((r) => !r.api_key.startsWith(PREFIX));
console.log(`Rows: ${rows.length}, already encrypted: ${rows.length - plain.length}, to encrypt: ${plain.length}`);
if (!apply) process.exit(0);

let done = 0;
for (const row of plain) {
  const stored = encrypt(row.api_key);
  if (decrypt(stored) !== row.api_key) throw new Error(`Round trip failed for user ${row.user_id}`);
  const { data, error: updateError } = await db
    .from("user_ai_settings")
    .update({ api_key: stored })
    .eq("user_id", row.user_id)
    .eq("api_key", row.api_key)
    .select("user_id");
  if (updateError) throw updateError;
  done += data.length;
}

const { data: after, error: afterError } = await db.from("user_ai_settings").select("user_id, api_key");
if (afterError) throw afterError;
const stillPlain = after.filter((r) => !r.api_key.startsWith(PREFIX)).length;
const undecryptable = after.filter((r) => {
  if (!r.api_key.startsWith(PREFIX)) return false;
  try {
    decrypt(r.api_key);
    return false;
  } catch {
    return true;
  }
}).length;
console.log(`Encrypted now: ${done}. Left in clear: ${stillPlain}. Not decryptable with this key: ${undecryptable}.`);
if (stillPlain || undecryptable) process.exit(1);
