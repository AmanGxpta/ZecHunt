import { type NextRequest, NextResponse } from "next/server";
import { creatorTokenFrom, errorResponse, readJson } from "@/lib/api";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { getProviders } from "@/lib/providers";
import { controlQuest, type QuestControl } from "@/lib/quests/service";

const ACTIONS: readonly QuestControl[] = ["pause", "resume", "cancel"];

// Creator-only: pause, resume or cancel a quest. Never moves money.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ action?: unknown }>(req);
    if (!ACTIONS.includes(body.action as QuestControl)) throw new DomainError("invalid_action", 400, "Unknown action");
    const quest = controlQuest(getDb(), id, creatorTokenFrom(req), body.action as QuestControl);
    return NextResponse.json({ quest, modes: getProviders().modes, syncing: false });
  } catch (err) {
    return errorResponse(err);
  }
}
