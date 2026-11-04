import { type NextRequest, NextResponse } from "next/server";
import { clientIp, errorResponse, playerSession, readJson, withPlayerCookie } from "@/lib/api";
import { getDb } from "@/lib/db";
import { submitCheckpoint } from "@/lib/quests/service";

// Player enters the six-digit checkpoint code. Success returns a single-use claim token.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = playerSession(req);
  try {
    const { id } = await params;
    const body = await readJson<{ code?: unknown }>(req);
    if (typeof body.code !== "string" || body.code.length > 16) {
      return withPlayerCookie(
        NextResponse.json({ error: "invalid_code", message: "Enter the six-digit code" }, { status: 400 }),
        session,
      );
    }
    const result = submitCheckpoint(getDb(), id, body.code, session.id, { ip: clientIp(req) });
    return withPlayerCookie(NextResponse.json(result), session);
  } catch (err) {
    return withPlayerCookie(errorResponse(err), session);
  }
}
