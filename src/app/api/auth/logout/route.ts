import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, getAuthService } from "@/services/authRuntime";

/** Выход: закрывает сессию в базе и стирает куку. */
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = getAuthService();
  if (auth !== null) {
    try {
      await auth.logout(request.cookies.get(SESSION_COOKIE)?.value);
    } catch (error) {
      console.error("Выход: сессия не закрыта в базе:", error instanceof Error ? error.message : error);
    }
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
