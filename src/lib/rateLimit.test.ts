import { describe, expect, it } from "vitest";

import { clientKey, createRateLimiter } from "@/lib/rateLimit";

/**
 * Лимит запросов на адрес.
 *
 * Ручки, которые пересылают текст языковой модели, открыты без входа, и без
 * лимита любой, кто узнает адрес, получил бы бесплатный доступ к платному
 * шлюзу. Лимит скользящий: «двадцать за десять минут», а не «в начале часа».
 */
describe("createRateLimiter", () => {
  const limiter = () => createRateLimiter({ limit: 3, windowMs: 1000 });

  it("пропускает в пределах лимита", () => {
    const l = limiter();

    expect(l.check("ip", 0).allowed).toBe(true);
    expect(l.check("ip", 1).allowed).toBe(true);
    expect(l.check("ip", 2).allowed).toBe(true);
  });

  it("сверх лимита отказывает и называет, через сколько секунд повторить", () => {
    const l = limiter();
    l.check("ip", 0);
    l.check("ip", 100);
    l.check("ip", 200);
    const fourth = l.check("ip", 300);

    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("окно скользит: старые обращения выпадают", () => {
    const l = limiter();
    l.check("ip", 0);
    l.check("ip", 100);
    l.check("ip", 200);

    expect(l.check("ip", 1050).allowed).toBe(true);
  });

  it("адреса считаются раздельно", () => {
    const l = limiter();
    l.check("a", 0);
    l.check("a", 1);
    l.check("a", 2);

    expect(l.check("b", 3).allowed).toBe(true);
  });

  it("отказанное обращение лимит не продлевает", () => {
    const l = limiter();
    l.check("ip", 0);
    l.check("ip", 1);
    l.check("ip", 2);
    for (let i = 0; i < 50; i += 1) l.check("ip", 500);

    expect(l.check("ip", 1001).allowed).toBe(true);
  });
});

describe("clientKey", () => {
  it("берёт адрес из X-Real-IP, который выставляет nginx", () => {
    expect(clientKey(new Headers({ "x-real-ip": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("иначе — первый адрес из X-Forwarded-For", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" }))).toBe("5.6.7.8");
  });

  it("без заголовков — общий ключ, а не пропуск проверки", () => {
    expect(clientKey(new Headers())).toBe("unknown");
  });
});
