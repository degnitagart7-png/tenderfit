import { describe, expect, it } from "vitest";

import { STALE_PLANNED_DAYS, isClosedLongAgo } from "@/domain/staleTender";

/**
 * Давно закрытые закупки в плановом сборе.
 *
 * ЕИС держит давние извещения (2014, 2019) со статусом «Подача заявок»: их никто
 * не закрыл. Они попадают в выдачу, занимают лимит и выглядят как свежие находки.
 * Недавно закрытые закупки остаются: их показывают с пометкой, и человеку
 * полезно видеть, что закрылось только что.
 */

const NOW = Date.parse("2026-10-05T12:00:00Z");

describe("isClosedLongAgo", () => {
  it("закрыта месяц назад — давно", () => {
    expect(isClosedLongAgo("2026-09-01T00:00:00.000Z", NOW)).toBe(true);
  });

  it("закрыта в 2014 году — давно", () => {
    expect(isClosedLongAgo("2014-06-11T00:00:00.000Z", NOW)).toBe(true);
  });

  it("закрылась три дня назад — не давно", () => {
    expect(isClosedLongAgo("2026-10-02T00:00:00.000Z", NOW)).toBe(false);
  });

  it("срок в будущем — не давно", () => {
    expect(isClosedLongAgo("2026-10-20T00:00:00.000Z", NOW)).toBe(false);
  });

  it("граница — ровно неделя", () => {
    expect(STALE_PLANNED_DAYS).toBe(7);
    expect(isClosedLongAgo("2026-09-28T12:00:00.000Z", NOW)).toBe(false);
    expect(isClosedLongAgo("2026-09-28T11:59:00.000Z", NOW)).toBe(true);
  });

  it("срок неизвестен или не читается — не давно: срок неизвестен, а не прошёл", () => {
    expect(isClosedLongAgo("", NOW)).toBe(false);
    expect(isClosedLongAgo("не дата", NOW)).toBe(false);
  });
});
