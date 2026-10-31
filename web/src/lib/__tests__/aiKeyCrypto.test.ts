import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("server-only", () => ({}));

import { decryptApiKey, encryptApiKey, isEncryptedApiKey } from "@/lib/ai/keyCrypto";

describe("AI key encryption", () => {
  const original = process.env.AI_SETTINGS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.AI_SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  afterEach(() => {
    process.env.AI_SETTINGS_ENCRYPTION_KEY = original;
  });

  it("round-trips a key and never stores it in clear", () => {
    const stored = encryptApiKey("sk-ant-test-123");
    expect(isEncryptedApiKey(stored)).toBe(true);
    expect(stored).not.toContain("sk-ant-test-123");
    expect(decryptApiKey(stored)).toBe("sk-ant-test-123");
  });

  it("uses a new IV every time", () => {
    expect(encryptApiKey("same")).not.toBe(encryptApiKey("same"));
  });

  it("reads a legacy plaintext row as is", () => {
    expect(decryptApiKey("sk-legacy")).toBe("sk-legacy");
  });

  it("refuses a tampered value or another key", () => {
    const stored = encryptApiKey("sk-ant-test-123");
    const parts = stored.split(":");
    const ct = Buffer.from(parts[4], "base64url");
    ct[0] ^= 1;
    parts[4] = ct.toString("base64url");
    expect(() => decryptApiKey(parts.join(":"))).toThrow();

    process.env.AI_SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptApiKey(stored)).toThrow();
  });

  it("refuses to work without a valid 32-byte key", () => {
    delete process.env.AI_SETTINGS_ENCRYPTION_KEY;
    expect(() => encryptApiKey("x")).toThrow(/AI_SETTINGS_ENCRYPTION_KEY/);
    process.env.AI_SETTINGS_ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    expect(() => encryptApiKey("x")).toThrow(/32 bytes/);
  });
});
