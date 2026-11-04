import { createHmac } from "node:crypto";
import { keyedHash, normalizeCode } from "../crypto";

/** A checkpoint code is valid for one window plus one window of grace. */
export const CODE_WINDOW_MS = 60_000;

function secretFor(questId: string, nonce: string): string {
  return keyedHash(`checkpoint-secret:${questId}:${nonce}`);
}

function codeForWindow(secret: string, window: number): string {
  const digest = createHmac("sha256", secret).update(String(window)).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** The code the checkpoint volunteer currently displays. */
export function currentCode(questId: string, nonce: string, now = Date.now()) {
  const window = Math.floor(now / CODE_WINDOW_MS);
  return {
    code: codeForWindow(secretFor(questId, nonce), window),
    expiresAt: (window + 1) * CODE_WINDOW_MS,
  };
}

/** Accepts the current code or the previous window's (someone walking back from the checkpoint). */
export function verifyCode(questId: string, nonce: string, input: string, now = Date.now()): boolean {
  const code = normalizeCode(input);
  if (code.length !== 6) return false;
  const secret = secretFor(questId, nonce);
  const window = Math.floor(now / CODE_WINDOW_MS);
  let ok = false;
  for (const w of [window, window - 1]) {
    // Evaluate both windows so timing does not reveal which one matched.
    if (codeForWindow(secret, w) === code) ok = true;
  }
  return ok;
}
