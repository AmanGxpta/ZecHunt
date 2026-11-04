import { type NextRequest, NextResponse } from "next/server";
import { errorResponse, playerSession, readJson, withPlayerCookie } from "@/lib/api";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { getProviders } from "@/lib/providers";
import { fulfillClaim, listRewardOptions, reservedClaimFor } from "@/lib/quests/service";

// The winner's reward options and the agent's recommendation. Winner session only.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = playerSession(req);
  try {
    const { id } = await params;
    const result = await listRewardOptions(getDb(), getProviders().bitrefill, id, session.id);
    return withPlayerCookie(NextResponse.json(result, { headers: { "cache-control": "no-store" } }), session);
  } catch (err) {
    return withPlayerCookie(errorResponse(err), session);
  }
}

// The winner confirms one option. The spend guard decides; the agent never buys.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = playerSession(req);
  try {
    const { id } = await params;
    const body = await readJson<{ productId?: unknown }>(req);
    if (typeof body.productId !== "string" || !body.productId) {
      throw new DomainError("invalid_product", 400, "productId is required");
    }
    const db = getDb();
    const { bitrefill, modes } = getProviders();
    const claimId = reservedClaimFor(db, id, session.id);
    const outcome = await fulfillClaim(db, bitrefill, claimId, { bitrefillMode: modes.bitrefill, productId: body.productId });
    return withPlayerCookie(NextResponse.json(outcome), session);
  } catch (err) {
    return withPlayerCookie(errorResponse(err), session);
  }
}
