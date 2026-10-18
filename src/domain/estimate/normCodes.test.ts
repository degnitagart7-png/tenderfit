import { describe, expect, it } from "vitest";

import {
  gesnBookOfPrefix,
  parseNormCodeHint,
  resolveNormCode,
  unitsCompatible,
  type CatalogNorm,
  type NormCatalog,
} from "@/domain/estimate/normCodes";

/** Каталог из нескольких норм: «подменённая база», где 46-06-009-03 есть, а 46-06-909-03 нет. */
function catalogOf(norms: readonly CatalogNorm[]): NormCatalog {
  return {
    lookup(code, baseType) {
      return norms.filter(
        (norm) => norm.code === code && (baseType === null || norm.baseType === baseType),
      );
    },
  };
}

const DEMOLITION: CatalogNorm = {
  baseType: "ГЭСН",
  code: "46-06-009-03",
  unit: "100 м3 строительного объема",
};
const GRADING: CatalogNorm = { baseType: "ГЭСН", code: "01-02-027-02", unit: "1000 м2" };

describe("gesnBookOfPrefix", () => {
  it.each([
    ["F9CH", "ГЭСН"],
    ["F3CH", "ГЭСН"],
    ["ГЗСН", "ГЭСН"],
    ["I'ЭСН", "ГЭСН"],
    ["ГЭСН", "ГЭСН"],
    ["ГЭСНм", "ГЭСНм"],
    ["ГЭСНр", "ГЭСНр"],
    ["ГЭСНп", "ГЭСНп"],
    ["ГЭСНмр", "ГЭСНмр"],
    ["FЭСН", "ГЭСН"],
  ])("префикс «%s» читается как %s", (raw, book) => {
    expect(gesnBookOfPrefix(raw)).toBe(book);
  });

  it("чужой префикс книгой ГЭСН не считается", () => {
    expect(gesnBookOfPrefix("®CBU")).toBeNull();
    expect(gesnBookOfPrefix("ФСБЦ")).toBeNull();
    expect(gesnBookOfPrefix("ТСН")).toBeNull();
    expect(gesnBookOfPrefix("")).toBeNull();
  });
});

describe("parseNormCodeHint", () => {
  it("«F9CH46-06-909-03» — ГЭСН, код как прочитан", () => {
    expect(parseNormCodeHint("F9CH46-06-909-03")).toEqual({
      baseType: "ГЭСН",
      code: "46-06-909-03",
      raw: "F9CH46-06-909-03",
    });
  });

  it("«F3CH01-02-027-02» — ГЭСН", () => {
    expect(parseNormCodeHint("F3CH01-02-027-02")?.baseType).toBe("ГЭСН");
    expect(parseNormCodeHint("F3CH01-02-027-02")?.code).toBe("01-02-027-02");
  });

  it("книга с суффиксом и пробелом", () => {
    expect(parseNormCodeHint("ГЭСНм 08-03-596-01")).toMatchObject({ baseType: "ГЭСНм", code: "08-03-596-01" });
    expect(parseNormCodeHint("Обоснование: ГЭСН-09-03-002-01")).toMatchObject({ baseType: "ГЭСН", code: "09-03-002-01" });
  });

  it("код без префикса: книга неизвестна", () => {
    expect(parseNormCodeHint("46-06-009-03")).toMatchObject({ baseType: null, code: "46-06-009-03" });
  });

  it("ресурсы, перевозки и прочее шифром ГЭСН не считаются", () => {
    expect(parseNormCodeHint("ФСБЦ-02.2.04.03-0013")).toBeNull();
    expect(parseNormCodeHint("ФСБЦ-02.2.04.03-0013_02-15")).toBeNull();
    expect(parseNormCodeHint("42-1")).toBeNull();
    expect(parseNormCodeHint("02-15-1-01-0047")).toBeNull();
    expect(parseNormCodeHint("Прайс-лист поставщика")).toBeNull();
    expect(parseNormCodeHint(undefined)).toBeNull();
  });
});

describe("resolveNormCode", () => {
  const catalog = catalogOf([DEMOLITION, GRADING]);

  it("код, который есть в базе как написан, принимается без исправлений", () => {
    const hint = parseNormCodeHint("F3CH01-02-027-02");
    expect(hint).not.toBeNull();
    const result = resolveNormCode(hint!, ["1000 м2"], catalog);

    expect(result.status).toBe("EXACT");
  });

  it("46-06-909-03 восстанавливается в 46-06-009-03: 9→0, вариант единственный, единица сошлась", () => {
    const hint = parseNormCodeHint("F9CH46-06-909-03");
    const result = resolveNormCode(hint!, ["100 m3"], catalog);

    expect(result.status).toBe("RESTORED");
    if (result.status === "RESTORED") {
      expect(result.norm.code).toBe("46-06-009-03");
      expect(result.from).toBe("46-06-909-03");
      expect(result.substitutions).toBe(1);
    }
  });

  it("вариант с другой единицей не принимается", () => {
    const hint = parseNormCodeHint("F9CH46-06-909-03");
    const result = resolveNormCode(hint!, ["т"], catalog);

    expect(result.status).toBe("NOT_FOUND");
  });

  it("соседний код в двух цифрах не мешает варианту в одной", () => {
    const twins = catalogOf([
      { baseType: "ГЭСН", code: "46-06-009-03", unit: "100 м3" },
      { baseType: "ГЭСН", code: "46-06-008-03", unit: "100 м3" },
    ]);
    const result = resolveNormCode(parseNormCodeHint("ГЭСН46-06-909-03")!, ["м3"], twins);

    // 909 → 009 — одна замена; 909 → 008 — две, и до них очередь не доходит.
    expect(result.status).toBe("RESTORED");
    if (result.status === "RESTORED") expect(result.norm.code).toBe("46-06-009-03");
  });

  it("два подходящих варианта в одной цифре — это выбор, а не восстановление", () => {
    const ambiguous = catalogOf([
      { baseType: "ГЭСН", code: "46-06-009-03", unit: "100 м3" },
      { baseType: "ГЭСН", code: "46-06-909-08", unit: "100 м3" },
      { baseType: "ГЭСН", code: "46-06-909-93", unit: "100 м3" },
    ]);
    const result = resolveNormCode(parseNormCodeHint("ГЭСН46-06-909-03")!, ["м3"], ambiguous);

    expect(result.status).toBe("AMBIGUOUS");
    if (result.status === "AMBIGUOUS") expect(result.candidates).toHaveLength(3);
  });

  it("замена в двух цифрах — только когда в одной варианта нет", () => {
    const cat = catalogOf([{ baseType: "ГЭСН", code: "46-06-009-08", unit: "100 м3" }]);
    const hint = parseNormCodeHint("ГЭСН46-06-909-03");
    const result = resolveNormCode(hint!, ["м3"], cat);

    expect(result.status).toBe("RESTORED");
    if (result.status === "RESTORED") expect(result.substitutions).toBe(2);
  });

  it("без единицы строки цифры не исправляются: нечем отличить настоящий вариант", () => {
    const hint = parseNormCodeHint("F9CH46-06-909-03");
    expect(resolveNormCode(hint!, [], catalog).status).toBe("NOT_FOUND");
  });

  it("кода нет и похожих нет — NOT_FOUND", () => {
    const hint = parseNormCodeHint("ГЭСН11-11-111-11");
    expect(resolveNormCode(hint!, ["м3"], catalog).status).toBe("NOT_FOUND");
  });

  it("код есть в двух книгах, книга не прочитана: сужаем единицей строки", () => {
    const books = catalogOf([
      { baseType: "ГЭСН", code: "01-01-001-01", unit: "1000 м3" },
      { baseType: "ГЭСНм", code: "01-01-001-01", unit: "шт" },
    ]);
    const hint = parseNormCodeHint("01-01-001-01");
    const byUnit = resolveNormCode(hint!, ["м3"], books);
    expect(byUnit.status).toBe("EXACT");
    if (byUnit.status === "EXACT") expect(byUnit.norm.baseType).toBe("ГЭСН");

    expect(resolveNormCode(hint!, ["км"], books).status).toBe("AMBIGUOUS");
  });
});

describe("unitsCompatible", () => {
  it("единица нормы с множителем и хвостом совпадает по величине", () => {
    expect(unitsCompatible("100 м3 строительного объема", ["100 m3"])).toBe(true);
    expect(unitsCompatible("1000 м2", ["м2"])).toBe(true);
    expect(unitsCompatible("т", ["м3", "т"])).toBe(true);
  });

  it("разные величины несовместимы", () => {
    expect(unitsCompatible("100 м3", ["т"])).toBe(false);
    expect(unitsCompatible("шт", ["м"])).toBe(false);
  });
});
