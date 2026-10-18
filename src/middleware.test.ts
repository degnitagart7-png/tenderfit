import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { config, middleware } from "@/middleware";

/**
 * Вход обязателен для страниц приложения.
 *
 * Матчер проверяется регуляркой из конфига: именно ею Next решает, звать ли
 * middleware, и ошибка в ней открыла бы приложение или закрыла /login.
 */

const MATCHER = new RegExp(`^${(config.matcher[0] ?? "").replace(/^\/\(/, "/(")}$`);
const matched = (path: string): boolean => MATCHER.test(path);

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, cookie ? { headers: { cookie } } : {});
}

describe("matcher", () => {
  it.each(["/tenders", "/tenders/32616426639", "/estimate", "/billing", "/settings/profile", "/onboarding", "/admin/jobs"])(
    "страница приложения %s проверяется",
    (path) => expect(matched(path)).toBe(true),
  );

  it.each([
    "/",
    "/demo",
    "/demo/",
    "/login",
    "/login/",
    "/legal/offer",
    "/legal/privacy",
    "/poleznoe",
    "/poleznoe/",
    "/poleznoe/srok-oplaty-po-44-fz",
    "/llms.txt",
    "/llms-full.txt",
    "/robots.txt",
    "/sitemap.xml",
    "/icon.svg",
    "/favicon.ico",
    "/apple-icon",
    "/opengraph-image",
    "/_next/static/chunks/main.js",
    "/api/auth/me",
    "/api/analysis/worker",
    "/api/sync-jobs",
    "/some/file.png",
  ])("%s открыт", (path) => expect(matched(path)).toBe(false));

  it("похожие на открытые пути не открываются: /loginfo и /apis — страницы приложения", () => {
    expect(matched("/loginfo")).toBe(true);
    expect(matched("/demonstration")).toBe(true);
    expect(matched("/apis")).toBe(true);
    expect(matched("/poleznoe-admin")).toBe(true);
    expect(matched("/poleznoeX/page")).toBe(true);
    expect(matched("/llms.txt/extra")).toBe(true);
  });
});

describe("middleware", () => {
  it("без куки — на /login с возвратом на страницу", async () => {
    const response = middleware(request("/tenders/123?tab=docs"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login?next=%2Ftenders%2F123%3Ftab%3Ddocs");
  });

  it("с кукой — пропускает", () => {
    const response = middleware(request("/tenders", "tf_session=abc"));

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("пустая кука — как её отсутствие", () => {
    expect(middleware(request("/tenders", "tf_session=")).status).toBe(307);
  });

  it("главная открыта без куки: это промо-страница, а не кабинет", () => {
    expect(matched("/")).toBe(false);
  });
});
