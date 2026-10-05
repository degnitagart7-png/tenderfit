import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, codeLoginEnabled, getAuthService } from "@/services/authRuntime";

/**
 * Кто вошёл: GET отдаёт почту или null. Вход выключен или базы нет — тоже null:
 * страница при этом работает как для гостя, а не падает.
 */
export const runtime = "nodejs";
// Ответ зависит от куки и окружения: без этого Next.js отдавал бы снимок, сделанный при сборке.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = getAuthService();
  const codeLogin = codeLoginEnabled();
  if (auth === null) return NextResponse.json({ user: null, loginEnabled: false, codeLoginEnabled: false });

  try {
    const user = await auth.getUser(request.cookies.get(SESSION_COOKIE)?.value);
    return NextResponse.json({
      user: user === null ? null : { email: user.email },
      loginEnabled: true,
      codeLoginEnabled: codeLogin,
    });
  } catch (error) {
    console.error("Сессия не прочитана:", error instanceof Error ? error.message : error);
    return NextResponse.json({ user: null, loginEnabled: true, codeLoginEnabled: codeLogin });
  }
}
