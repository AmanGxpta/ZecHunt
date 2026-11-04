import { type NextRequest, NextResponse } from "next/server";
import { creatorTokenFrom, errorResponse } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getCheckpointCode } from "@/lib/quests/service";

// The rotating code for the checkpoint display. Needs the checkpoint key or creator token.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = getCheckpointCode(getDb(), id, {
      checkpointKey: req.headers.get("x-checkpoint-key"),
      creatorToken: creatorTokenFrom(req),
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
