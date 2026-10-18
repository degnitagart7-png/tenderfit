import { describe, expect, it } from "vitest";

import { loginUrlWithNext, safeNextPath } from "@/domain/loginRedirect";

describe("safeNextPath", () => {
  it("свой путь с запросом проходит", () => {
    expect(safeNextPath("/tenders")).toBe("/tenders");
    expect(safeNextPath("/tenders/123?tab=docs#top")).toBe("/tenders/123?tab=docs#top");
    expect(safeNextPath("/estimate?tenderId=1&mode=audit")).toBe("/estimate?tenderId=1&mode=audit");
  });

  it.each([
    "//evil.ru",
    "///evil.ru",
    "https://evil.ru",
    "http://evil.ru/x",
    "javascript:alert(1)",
    "/\\evil.ru",
    "\\\\evil.ru",
    "/%2F/evil.ru",
    "/%5Cevil.ru",
    "/a\nb",
    "tenders",
    "",
    "/login",
    "/login?next=/tenders",
    "/%E0%A4%A",
  ])("опасное или пустое %j отклоняется", (value) => {
    expect(safeNextPath(value)).toBeNull();
  });

  it("не строка — null", () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });

  it("слишком длинное отклоняется", () => {
    expect(safeNextPath(`/${"a".repeat(600)}`)).toBeNull();
  });
});

describe("loginUrlWithNext", () => {
  it("кодирует путь в параметр", () => {
    expect(loginUrlWithNext("/tenders/1?tab=docs")).toBe("/login?next=%2Ftenders%2F1%3Ftab%3Ddocs");
  });

  it("небезопасный путь — просто /login", () => {
    expect(loginUrlWithNext("//evil.ru")).toBe("/login");
  });
});
