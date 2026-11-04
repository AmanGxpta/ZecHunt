import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEV_SECRET = "dev-only-secret-do-not-use-in-production";

function serverSecret(): string {
  const secret = process.env.ZECHUNT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ZECHUNT_SECRET must be set in production");
  }
  return DEV_SECRET;
}

/** Keyed hash for anything stored server-side that must not be readable if the DB leaks. */
export function keyedHash(value: string): string {
  return createHmac("sha256", serverSecret()).update(value).digest("hex");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function randomId(): string {
  return randomBytes(9).toString("base64url");
}

export function normalizeCode(input: string): string {
  return input.replace(/\D/g, "");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
