import type { DatabaseSync } from "node:sqlite";
import type { ZcashAdapter } from "../providers/types";
import { syncQuestFunding } from "./service";

const g = globalThis as unknown as { __zechuntSyncs?: Map<string, Promise<unknown>> };
const inflight = (g.__zechuntSyncs ??= new Map());

/**
 * At most one funding scan per quest at a time in this process. A live wallet
 * sync can take minutes, so callers get the in-flight promise instead of a second scan.
 */
export function syncOnce(db: DatabaseSync, zcash: ZcashAdapter, questId: string) {
  const existing = inflight.get(questId);
  if (existing) return existing as ReturnType<typeof syncQuestFunding>;
  const run = syncQuestFunding(db, zcash, questId).finally(() => inflight.delete(questId));
  inflight.set(questId, run);
  return run;
}

export function isSyncing(questId: string): boolean {
  return inflight.has(questId);
}
