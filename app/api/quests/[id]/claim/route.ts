import { type NextRequest, NextResponse } from "next/server";
import { errorResponse, playerSession, readJson, withPlayerCookie } from "@/lib/api";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { getProviders } from "@/lib/providers";
import { getClaimStatus, reserveWinnerSlot } from "@/lib/quests/service";

// Consumes the claim token and reserves the winner slot. The winner then picks a
// reward via /rewards, which runs guarded fulfillment.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = playerSession(req);
  try {
    const { id } = await params;
    const body = await readJson<{ claimToken?: unknown }>(req);
    if (typeof body.claimToken !== "string") {
      throw new DomainError("invalid_token", 400, "claimToken is required");
    }
    const db = getDb();
    const reserved = reserveWinnerSlot(db, id, body.claimToken, session.id);
    if ("error" in reserved) {
      const status = reserved.error === "quest_exhausted" || reserved.error === "already_claimed" ? 409 : 400;
      return withPlayerCookie(NextResponse.json({ error: reserved.error }, { status }), session);
    }
    return withPlayerCookie(NextResponse.json(getClaimStatus(db, id, session.id), { status: 200 }), session);
  } catch (err) {
    return withPlayerCookie(errorResponse(err), session);
  }
}

// The player's own claim status. Redemption details are fetched live, never stored.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = playerSession(req);
  try {
    const { id } = await params;
    const db = getDb();
    const status = getClaimStatus(db, id, session.id);
    if (!status) return withPlayerCookie(NextResponse.json({ claim: null }), session);

    const { bitrefill } = getProviders();
    let redemptionData: string | undefined;
    if (status.claimStatus === "delivered" && status.purchase?.invoiceId) {
      const order = await bitrefill.getOrderStatus(status.purchase.invoiceId);
      redemptionData = order.redemptionData;
    }
    const logoUrl = status.purchase ? bitrefill.productLogo?.(status.purchase.productId) ?? null : null;
    return withPlayerCookie(
      NextResponse.json({ claim: status, redemptionData, logoUrl }, { headers: { "cache-control": "no-store" } }),
      session,
    );
  } catch (err) {
    return withPlayerCookie(errorResponse(err), session);
  }
}
