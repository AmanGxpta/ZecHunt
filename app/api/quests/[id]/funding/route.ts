import { type NextRequest, NextResponse } from "next/server";
import { creatorTokenFrom, errorResponse } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getProviders } from "@/lib/providers";
import { isSyncing, syncOnce } from "@/lib/quests/funding-sync";
import { getCreatorQuest } from "@/lib/quests/service";

// Creator view: funding address and funding progress. Requires the creator token.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const quest = getCreatorQuest(getDb(), id, creatorTokenFrom(req));
    return NextResponse.json({ quest, modes: getProviders().modes, syncing: isSyncing(id) });
  } catch (err) {
    return errorResponse(err);
  }
}

// Starts (or joins) a wallet scan for this quest. A live scan can take minutes,
// so we wait briefly and otherwise return the current state with syncing: true.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    getCreatorQuest(db, id, creatorTokenFrom(req));
    const { zcash, modes } = getProviders();
    if (getCreatorQuest(db, id, creatorTokenFrom(req)).status === "awaiting_funding") {
      const scan = syncOnce(db, zcash, id).catch((e: unknown) => {
        console.error(`[funding] quest ${id}:`, e instanceof Error ? e.message : e);
      });
      await Promise.race([scan, new Promise((r) => setTimeout(r, 4_000))]);
    }
    const quest = getCreatorQuest(db, id, creatorTokenFrom(req));
    return NextResponse.json({ quest, modes, syncing: isSyncing(id) });
  } catch (err) {
    return errorResponse(err);
  }
}
