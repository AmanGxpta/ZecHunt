import { type NextRequest, NextResponse } from "next/server";
import { creatorTokenFrom, errorResponse, readJson } from "@/lib/api";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { getProviders } from "@/lib/providers";
import { MockZcashAdapter } from "@/lib/providers/mock";
import { getCreatorQuest } from "@/lib/quests/service";

// MOCK ONLY. Pretends a shielded output arrived. Refused in any non-mock provider mode.
export async function POST(req: NextRequest) {
  try {
    const providers = getProviders();
    if (providers.mode !== "mock" || !(providers.zcash instanceof MockZcashAdapter)) {
      throw new DomainError("not_available", 404);
    }
    const body = await readJson<{ questId?: unknown; amountZatoshis?: unknown }>(req);
    if (typeof body.questId !== "string") throw new DomainError("invalid_quest", 400);
    // The creator must own the quest before anything is simulated for it.
    getCreatorQuest(getDb(), body.questId, creatorTokenFrom(req));
    const amount = BigInt(typeof body.amountZatoshis === "number" ? body.amountZatoshis : 1_000_000);
    const event = providers.zcash.simulateFunding(body.questId, amount);
    return NextResponse.json({ simulated: true, mock: true, txid: event.txid });
  } catch (err) {
    return errorResponse(err);
  }
}
