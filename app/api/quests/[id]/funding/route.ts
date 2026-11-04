import { type NextRequest, NextResponse } from "next/server";
import { creatorTokenFrom, errorResponse } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getCreatorQuest, syncFunding } from "@/lib/quests/service";
import { getProviders } from "@/lib/providers";

// Creator view: funding address and funding progress. Requires the creator token.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const quest = getCreatorQuest(getDb(), id, creatorTokenFrom(req));
    return NextResponse.json({ quest, providerMode: getProviders().mode });
  } catch (err) {
    return errorResponse(err);
  }
}

// Pulls provider funding events and activates the quest when confirmed funds suffice.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { zcash } = getProviders();
    const quest = await syncFunding(getDb(), zcash, id, creatorTokenFrom(req));
    return NextResponse.json({ quest, providerMode: getProviders().mode });
  } catch (err) {
    return errorResponse(err);
  }
}
