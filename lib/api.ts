import { NextResponse, type NextRequest } from "next/server";
import { randomId } from "./crypto";
import { DomainError } from "./errors";

export const PLAYER_COOKIE = "zechunt_player";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Maps domain failures to HTTP responses. Unknown errors never leak details. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof DomainError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

export async function readJson<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new DomainError("invalid_json", 400, "Request body must be JSON");
  }
}

/** Anonymous per-browser identity for players. Not a wallet or an account. */
export function playerSession(req: NextRequest): { id: string; isNew: boolean } {
  const existing = req.cookies.get(PLAYER_COOKIE)?.value;
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return { id: existing, isNew: false };
  return { id: randomId(), isNew: true };
}

export function withPlayerCookie(res: NextResponse, session: { id: string; isNew: boolean }): NextResponse {
  if (session.isNew) {
    res.cookies.set(PLAYER_COOKIE, session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: ONE_YEAR_SECONDS,
    });
  }
  return res;
}

export function creatorTokenFrom(req: NextRequest): string | null {
  return req.headers.get("x-creator-token");
}
