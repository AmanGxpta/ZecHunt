import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { getDb } from "@/lib/db";
import { getProviders } from "@/lib/providers";
import { getPublicQuest } from "@/lib/quests/service";

// Public view only: no funding address, no creator data, no checkpoint material.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ quest: getPublicQuest(getDb(), id), modes: getProviders().modes });
  } catch (err) {
    return errorResponse(err);
  }
}
