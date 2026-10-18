import { describe, expect, it } from "vitest";

import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, clampLimit, searchNorms, unitFits } from "@/domain/estimate/normSearch";
import { SEARCH_NORMS } from "@/test/estimateFixtures";

const index = createNormSearchIndex(SEARCH_NORMS);

describe("поиск нормы по шифру и словам", () => {
  it("полный шифр — точная норма; книга в начале запроса учитывается", () => {
    const result = searchNorms(index, { query: "ГЭСН 01-01-111-01" });
    expect(result.mode).toBe("CODE");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ code: "01-01-111-01", baseType: "ГЭСН", exact: true });
  });

  it("код, который есть в нескольких книгах, возвращает все книги; с книгой — одну", () => {
    const all = searchNorms(index, { query: "01-01-001-01" });
    expect(all.items.length).toBeGreaterThan(1);
    expect(all.note).toMatch(/нескольких книгах/);
    expect(new Set(all.items.map((item) => item.baseType)).size).toBe(all.items.length);

    const gesnM = searchNorms(index, { query: "ГЭСНм 01-01-001-01" });
    expect(gesnM.items.map((item) => item.baseType)).toEqual(["ГЭСНм"]);
  });

  it("шифра нет в базе: соседние строки таблицы с пометкой, что точной нет", () => {
    const result = searchNorms(index, { query: "01-01-111-99" });
    expect(result.mode).toBe("CODE");
    expect(result.items.every((item) => !item.exact)).toBe(true);
    expect(result.note).toMatch(/в базе нет/);
  });

  it("код таблицы — строки таблицы; начало шифра — всё, что с него начинается", () => {
    const table = searchNorms(index, { query: "01-01-001" });
    expect(table.mode).toBe("TABLE");
    expect(table.items.length).toBeGreaterThanOrEqual(3);
    expect(table.items.every((item) => item.code.startsWith("01-01-001"))).toBe(true);

    const prefix = searchNorms(index, { query: "01-02" });
    expect(prefix.items.every((item) => item.code.startsWith("01-02"))).toBe(true);
  });

  it("слова: топ N по покрытию, лучшее первым", () => {
    const result = searchNorms(index, { query: "планировка откосов каналов", limit: 3 });
    expect(result.mode).toBe("WORDS");
    expect(result.items.length).toBeLessThanOrEqual(3);
    expect(result.items[0]?.code).toBe("01-01-111-01");
    expect(result.items[0]?.coverage).toBeGreaterThan(0.5);
  });

  it("пустой и слишком короткий запрос — пустая выдача, не ошибка", () => {
    expect(searchNorms(index, { query: "" })).toMatchObject({ mode: "EMPTY", items: [] });
    expect(searchNorms(index, { query: "   " }).items).toEqual([]);
    expect(searchNorms(index, { query: "а" }).items).toEqual([]);
  });

  it("ничего не нашлось по словам — пустая выдача с подсказкой", () => {
    const result = searchNorms(index, { query: "абракадабра квазар" });
    expect(result.items).toEqual([]);
    expect(result.note).toMatch(/не нашлось/);
  });

  it("лимит: по умолчанию 10, не больше 30, мусор заменяется умолчанием", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(1000)).toBe(MAX_SEARCH_LIMIT);
    expect(searchNorms(index, { query: "01-01", limit: 2 }).items.length).toBeLessThanOrEqual(2);
  });

  it("выдача — только записи базы", () => {
    const codes = new Set(SEARCH_NORMS.map((norm) => `${norm.baseType}|${norm.code}`));
    for (const query of ["разработка грунта", "01-01-001", "ГЭСН 01-01-001-02", "дренаж"]) {
      for (const hit of searchNorms(index, { query, limit: 30 }).items) {
        expect(codes.has(`${hit.baseType}|${hit.code}`)).toBe(true);
      }
    }
  });

  it("единица нормы сходится с единицей позиции: «м3» и «1000 м3» — да, «т» и «1000 м3» — нет", () => {
    expect(unitFits("м3", "1000 м3")).toBe(true);
    expect(unitFits("т", "1000 м3")).toBe(false);
  });
});
