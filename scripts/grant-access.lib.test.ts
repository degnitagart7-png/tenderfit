import { describe, expect, it } from "vitest";

import { GrantArgsError, extendPaidUntil, formatUserLine, parseGrantArgs } from "./grant-access.lib";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const D = 24 * 3_600_000;

describe("parseGrantArgs", () => {
  it("продление: почта, дни, пакет", () => {
    expect(parseGrantArgs(["--email", "Ivan@Firma.ru", "--days", "30", "--plan", "calc"])).toEqual({
      kind: "grant",
      email: "ivan@firma.ru",
      days: 30,
      plan: "calc",
    });
  });

  it("пакет необязателен", () => {
    expect(parseGrantArgs(["--email", "a@b.ru", "--days", "7"])).toMatchObject({ plan: null });
  });

  it("--list и --help обходятся без остального", () => {
    expect(parseGrantArgs(["--list"])).toEqual({ kind: "list" });
    expect(parseGrantArgs(["--help"])).toEqual({ kind: "help" });
  });

  it.each([
    [["--days", "30"]],
    [["--email", "a@b.ru"]],
    [["--email", "не-почта", "--days", "5"]],
    [["--email", "a@b.ru", "--days", "0"]],
    [["--email", "a@b.ru", "--days", "abc"]],
    [["--email", "a@b.ru", "--days", "30", "--plan", "gold"]],
    [["--email", "a@b.ru", "--days"]],
    [["--wat"]],
  ])("ошибка в аргументах %j", (argv) => {
    expect(() => parseGrantArgs(argv)).toThrow(GrantArgsError);
  });
});

describe("extendPaidUntil", () => {
  it("оплаты не было или она кончилась — от сегодня", () => {
    expect(extendPaidUntil(null, NOW, 30)).toBe(NOW + 30 * D);
    expect(extendPaidUntil(NOW - 5 * D, NOW, 30)).toBe(NOW + 30 * D);
  });

  it("оплачено вперёд — срок добавляется к текущему, а не сгорает", () => {
    expect(extendPaidUntil(NOW + 10 * D, NOW, 30)).toBe(NOW + 40 * D);
  });
});

describe("formatUserLine", () => {
  it("статус и срок", () => {
    const paid = formatUserLine({ email: "a@b.ru", record: { trialEndsAt: 1, paidUntil: NOW + D, plan: "calc" } }, NOW, {});
    expect(paid).toMatch(/a@b\.ru\s+оплачено\s+2026-10-12 12:00 UTC\s+calc/);

    const trial = formatUserLine({ email: "t@b.ru", record: { trialEndsAt: NOW + D, paidUntil: null, plan: null } }, NOW, {});
    expect(trial).toMatch(/пробный\s+2026-10-12 12:00 UTC\s+—/);

    const expired = formatUserLine({ email: "e@b.ru", record: { trialEndsAt: NOW - D, paidUntil: null, plan: null } }, NOW, {});
    expect(expired).toMatch(/истёк/);

    const admin = formatUserLine({ email: "o@b.ru", record: { trialEndsAt: null, paidUntil: null, plan: null } }, NOW, { ADMIN_EMAILS: "o@b.ru" });
    expect(admin).toMatch(/админ/);
  });
});
