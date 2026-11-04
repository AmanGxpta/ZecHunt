import { type NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/lib/api";
import { getDb } from "@/lib/db";
import { createQuest, type CreateQuestInput } from "@/lib/quests/service";
import { getProviders } from "@/lib/providers";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<CreateQuestInput>(req);
    const { zcash, modes } = getProviders();
    const result = await createQuest(getDb(), zcash, body, { zcashMode: modes.zcash });
    // Secrets are shown exactly once, here. The server keeps only keyed hashes.
    return NextResponse.json(
      { quest: result.quest, creatorToken: result.creatorToken, checkpointKey: result.checkpointKey, modes },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
