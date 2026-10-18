import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { getUser: vi.fn() };

vi.mock("@/services/authRuntime", () => ({
  SESSION_COOKIE: "tf_session",
  getAuthService: () => auth,
}));
vi.mock("@/services/notificationService", () => ({
  defaultNotificationDeps: vi.fn(() => ({ marker: "deps" })),
  sendDigestNow: vi.fn(),
}));

import { POST } from "@/app/api/notifications/test/route";
import { EXPIRED_MESSAGE, LOGIN_REQUIRED_MESSAGE } from "@/app/api/auth/requireAccess";
import { sendDigestNow } from "@/services/notificationService";

/**
 * «Прислать пробную сводку сейчас»: письмо уходит на почту вошедшего, а не на адрес из запроса.
 */

const send = vi.mocked(sendDigestNow);
const H = 3_600_000;

function post(): NextRequest {
  return new NextRequest("http://localhost/api/notifications/test", {
    method: "POST",
    headers: { cookie: "tf_session=tok", "x-real-ip": "10.7.0.1" },
  });
}

const signedIn = (email: string, access = { trialEndsAt: Date.now() + H, paidUntil: null, plan: null }) =>
  auth.getUser.mockResolvedValue({ id: "u1", email, access });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_EMAILS", "");
  auth.getUser.mockResolvedValue(null);
});

describe("POST /api/notifications/test", () => {
  it("без сессии — 401, письмо не собирается", async () => {
    const response = await POST(post());

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe(LOGIN_REQUIRED_MESSAGE);
    expect(send).not.toHaveBeenCalled();
  });

  it("пробный период закончился — 402", async () => {
    signedIn("old@firma.ru", { trialEndsAt: Date.now() - H, paidUntil: null, plan: null });

    const response = await POST(post());

    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe(EXPIRED_MESSAGE);
    expect(send).not.toHaveBeenCalled();
  });

  it("вошедший: сводка уходит на его почту из сессии; ответ — sent и число строк", async () => {
    signedIn("Ivan@Firma.ru");
    send.mockResolvedValue({ sent: true, items: 4 });

    const response = await POST(post());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true, items: 4 });
    expect(send).toHaveBeenCalledWith("ivan@firma.ru", { marker: "deps" });
  });

  it("нечего сообщить — 200 с sent: false и причиной для страницы", async () => {
    signedIn("empty@firma.ru");
    send.mockResolvedValue({ sent: false, items: 0, reason: "Сейчас сообщить нечего." });

    const response = await POST(post());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: false, items: 0, reason: "Сейчас сообщить нечего." });
  });

  it("не больше пяти писем за десять минут на человека", async () => {
    signedIn("spam@firma.ru");
    send.mockResolvedValue({ sent: true, items: 1 });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await POST(post())).status);

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(send).toHaveBeenCalledTimes(5);
  });
});
