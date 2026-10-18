import { describe, expect, it } from "vitest";

import { evaluateCustomerConditions, hasConfirmedConditions, statedFactors, summarizeCustomerConditions } from "@/domain/estimate/customerCoefficients";
import { parseCustomerLsr, type CustomerPosition } from "@/domain/estimate/customerLsr";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { hasStarFactors, starFactors } from "@/domain/estimate/smetaRu";
import { RIM_DEMOLITION_NAME, RIM_DEMOLITION_TEXT } from "@/test/smetaRuFixtures";

/*
  Поправка на разборку и демонтаж без ссылки на строку (Методика 571/пр, п. 83 таблица 2 — ГЭСН, п. 84 таблица 3 — ГЭСНм):
  Smeta.RU печатает «ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7» и ссылки на приказ не даёт. Если труд, машины и машинисты умножены на одно число k,
  материалы — на 0, в наименовании «Демонтаж» или «Разборка», а k есть в таблице книги позиции — коэффициент применяется автоматически,
  строки таблицы с этим значением названы все. Иначе — «неподтверждённый коэффициент заказчика», как и раньше.
*/

const parsed = parseCustomerLsr([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }]).estimates[0];
const real = (label: string): CustomerPosition => {
  const found = parsed?.positions.find((item) => item.label === label);
  if (found === undefined) throw new Error(`позиции ${label} нет`);
  return found;
};

function synthetic(patch: Partial<CustomerPosition>): CustomerPosition {
  return {
    number: 1,
    label: "1",
    code: "ГЭСН09-04-012-01",
    rawJustification: "ГЭСН 09-04-012-01",
    book: "GESN",
    coefficients: null,
    hasCoefficients: false,
    name: "Установка металлических дверных блоков в готовые проемы \\ Демонтаж",
    unit: "м2",
    quantity: 3.759,
    section: null,
    ownUnitPrice: null,
    ownTotal: null,
    ownBasePrice: null,
    ownIndex: null,
    ownPriceCoefficient: null,
    resources: [],
    groupTotals: { labour: 4813.38, machines: 320.33, machinistLabour: 331.07, materials: 0 },
    directTotal: 5464.78,
    wageFund: 5144.45,
    overhead: null,
    profit: null,
    perUnit: null,
    total: 13_438.68,
    truncated: false,
    notes: [{ ref: "", text: "ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7" }],
    ...patch,
  };
}
const star = (k: string, extra = ""): { ref: string; text: string }[] => [{ ref: "", text: `ЭМ *${k}; М *0; ЗТ *${k}; ЗТм *${k}${extra}` }];

describe("разбор поправок вида «ЗТ *0,7»", () => {
  it("труд, машины, машинисты, материалы и начисления — по своим группам", () => {
    const factors = starFactors("ЭМ *1,25; М *0; ЗТ *1,15; ЗТм *1,25; НР *0,9; СП *0,85");
    expect(factors).toEqual({ labour: [1.15], machines: [1.25], machinist: [1.25], materials: [0], accruals: [0.9, 0.85] });
    expect(hasStarFactors("Коэффициент к заработной плате ОЗП=1,2")).toBe(false);
    expect(hasStarFactors("ЗТ *0,7")).toBe(true);
    // «=»-форма Гранд-Сметы и звёздочка читаются одним разбором заявленных значений.
    expect(statedFactors("ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7")).toMatchObject({ labour: 0.7, machines: 0.7, materials: 0 });
    expect(statedFactors("ОЗП=1,2; ЭМ=1,2").all).toEqual([1.2, 1.2]);
  });

  it("слово «м *2» внутри текста — не поправка к материалам", () => {
    expect(starFactors("диаметром 5 мм *2").materials).toEqual([]);
  });
});

describe("демонтаж без ссылки: значение k опознаётся по таблице книги позиции", () => {
  it("ГЭСН 09-04-012-01 «\\ Демонтаж», 0,7 на труд, машины и машинистов, материалы 0 → таблица 2 п. 83, строка 4 (металлические конструкции)", () => {
    const conditions = evaluateCustomerConditions(real("3"));

    expect(conditions?.rejected).toEqual([]);
    expect(conditions?.special).toMatchObject({ id: "M571-P83-T2-R4", labour: 0.7, machines: 0.7, materials: 0, valueVerified: true });
    expect(conditions?.special?.label).toContain("571/пр п. 83, таблица 2, строка 4");
    expect(conditions?.special?.label).toContain("Металлические, металлокомпозитные, композитные конструкции");
    expect(conditions?.special?.label).toContain("ссылки на строку в смете нет — коэффициент опознан по значению");
    expect(conditions?.label).toContain("как у заказчика");
    expect(conditions?.enabled).toBe(true);
    expect(hasConfirmedConditions(conditions ?? undefined)).toBe(true);
  });

  it("ГЭСНм 10-08-002-02 «\\ Демонтаж (с сохранением)», 0,6 → таблица 3 п. 84, строка 2 (оборудование, пригодное для использования, без хранения)", () => {
    const conditions = evaluateCustomerConditions(real("8"));
    expect(conditions?.rejected).toEqual([]);
    expect(conditions?.special).toMatchObject({ id: "M571-P84-T3-R2", labour: 0.6, machines: 0.6, materials: 0 });
    expect(conditions?.special?.label).toContain("571/пр п. 84, таблица 3, строка 2");
  });

  it("ГЭСН 20-04-002-01 «\\ Демонтаж (с сохранением)», 0,7 → та же строка 4 таблицы 2", () => {
    expect(evaluateCustomerConditions(real("9"))?.special?.id).toBe("M571-P83-T2-R4");
  });

  it("значение стоит в нескольких строках таблицы (0,8 — строки 1 и 2) — значение достоверно, названы обе строки", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: star("0,8") }));

    expect(conditions?.special).toMatchObject({ id: "M571-P83-T2-R1+M571-P83-T2-R2", labour: 0.8, machines: 0.8, materials: 0 });
    expect(conditions?.special?.label).toContain("строки 1 и 2");
    expect(conditions?.special?.label).toContain("Сборные бетонные и железобетонные строительные конструкции");
    expect(conditions?.special?.label).toContain("Сборные деревянные конструкции");
    expect(conditions?.rejected).toEqual([]);
  });

  it("таблица 3 для ГЭСНм: 0,5 → строка 3, 0,3 → строка 4, 0,7 → строка 1", () => {
    const gesnm = (k: string) => evaluateCustomerConditions(synthetic({ book: "GESNM", code: "ГЭСНм10-08-002-02", notes: star(k) }));
    expect(gesnm("0,5")?.special?.id).toBe("M571-P84-T3-R3");
    expect(gesnm("0,3")?.special?.id).toBe("M571-P84-T3-R4");
    expect(gesnm("0,7")?.special?.id).toBe("M571-P84-T3-R1");
  });

  it("то же без звёздочки: «ОЗП=0,7; ЭМ=0,7; ЗПМ=0,7; ТЗ=0,7; ТЗМ=0,7; МАТ=0» (Гранд-Смета) и в фигурных скобках", () => {
    const grand = "ОЗП=0,7; ЭМ=0,7; ЗПМ=0,7; ТЗ=0,7; ТЗМ=0,7; МАТ=0";
    expect(evaluateCustomerConditions(synthetic({ notes: [{ ref: "", text: grand }] }))?.special?.id).toBe("M571-P83-T2-R4");
    expect(evaluateCustomerConditions(synthetic({ notes: undefined, coefficients: grand, hasCoefficients: true }))?.special?.id).toBe("M571-P83-T2-R4");
  });

  it("«Разборка» в наименовании — тот же маркер", () => {
    const conditions = evaluateCustomerConditions(synthetic({ name: "Разборка облицовки стен из гранитных плит", notes: star("0,6") }));
    expect(conditions?.special?.id).toBe("M571-P83-T2-R5");
  });
});

describe("не подтверждается: остаётся находкой «неподтверждённый коэффициент заказчика»", () => {
  it("ГЭСН 15-01-047-15 «\\ Демонтаж», 0,3: в таблице 2 такого значения нет — называются значения таблицы, сумма в прямых затратах — минус", () => {
    const conditions = evaluateCustomerConditions(real("6"));

    expect(conditions?.special).toBeUndefined();
    expect(conditions?.confirmed).toBeNull();
    expect(conditions?.rejected).toHaveLength(1);
    const claim = conditions?.rejected[0];
    expect(claim?.text).toBe("ЭМ *0,3; М *0; ЗТ *0,3; ЗТм *0,3");
    expect(claim?.reason).toContain("в таблице 2 Методики 571/пр (п. 83) такого значения нет: 0,8; 0,8; 0,4; 0,7; 0,6");
    expect(claim?.labour).toBe(0.3);
    expect(claim?.machines).toBe(0.3);
    expect(claim?.amount).toBeLessThan(0);
    expect(hasConfirmedConditions(conditions ?? undefined)).toBe(false);
  });

  it("позиция 17 «Поправки к: ЭМ *1,25; ЗТ *1,15; ЗТм *1,25; НР *0,9; СП *0,85» (ремонт, п. 58 без ссылки) — не демонтаж, ссылки на пункт нет", () => {
    const conditions = evaluateCustomerConditions(real("17"));

    expect(conditions?.special).toBeUndefined();
    expect(conditions?.confirmed).toBeNull();
    const reasons = conditions?.rejected.map((claim) => claim.reason) ?? [];
    expect(reasons[0]).toContain("ссылки на пункт приложения 10 к 421/пр или п. 58 в смете нет");
    expect(conditions?.rejected[0]).toMatchObject({ labour: 1.15, machines: 1.25 });
    // Множители 0,9 к НР (812/пр п. 25) и 0,85 к СП (774/пр п. 16) читаются со ссылкой, но без подтверждённого п. 58 не применяются.
    const multipliers = conditions?.rejected.filter((claim) => claim.overheadMultiplier != null || claim.profitMultiplier != null) ?? [];
    expect(multipliers).toHaveLength(2);
    expect(multipliers.every((claim) => claim.reason.includes("у позиции п. 58 не подтверждён"))).toBe(true);
  });

  it("в наименовании нет «Демонтаж» и «Разборка» — это не поправка на разборку", () => {
    const conditions = evaluateCustomerConditions(synthetic({ name: "Установка металлических дверных блоков в готовые проемы", notes: star("0,7") }));
    expect(conditions?.special).toBeUndefined();
    expect(conditions?.rejected).toHaveLength(1);
    expect(conditions?.rejected[0]?.reason).toContain("ссылки на пункт приложения 10 к 421/пр или п. 58 в смете нет");
  });

  it("смешанные множители: машины не равны труду, материалы не 0, лишний НР, нет машинистов — не подтверждается", () => {
    const rejectedOf = (text: string) => evaluateCustomerConditions(synthetic({ notes: [{ ref: "", text }] }));
    for (const text of [
      "ЭМ *0,7; М *0; ЗТ *0,6; ЗТм *0,7",
      "ЭМ *0,6; М *0; ЗТ *0,7; ЗТм *0,7",
      "ЭМ *0,7; М *0,5; ЗТ *0,7; ЗТм *0,7",
      "ЭМ *0,7; ЗТ *0,7; ЗТм *0,7",
      "ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7; НР *0,9",
      "ЭМ *0,7; М *0; ЗТ *0,7",
    ]) {
      const conditions = rejectedOf(text);
      expect(conditions?.special, text).toBeUndefined();
      expect(conditions?.rejected, text).toHaveLength(1);
    }
  });

  it("другая книга: ГЭСНр и ГЭСНп в таблицах 2 и 3 не названы; для ГЭСНм значение таблицы 2 (0,8) не подходит", () => {
    const gesnr = evaluateCustomerConditions(synthetic({ book: "GESNR", code: "ГЭСНр58-01-003-01", notes: star("0,7") }));
    expect(gesnr?.special).toBeUndefined();
    expect(gesnr?.rejected[0]?.reason).toContain("к нормам другой книги такие коэффициенты не даёт");

    const gesnm = evaluateCustomerConditions(synthetic({ book: "GESNM", code: "ГЭСНм10-08-002-02", notes: star("0,8") }));
    expect(gesnm?.special).toBeUndefined();
    expect(gesnm?.rejected[0]?.reason).toContain("в таблице 3 Методики 571/пр (п. 84) такого значения нет: 0,7; 0,6; 0,5; 0,3");
  });

  it("второе такое же заявление у позиции второй раз не применяется", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [...star("0,7"), ...star("0,7")] }));
    expect(conditions?.special?.id).toBe("M571-P83-T2-R4");
    expect(conditions?.rejected).toHaveLength(1);
    expect(conditions?.rejected[0]?.reason).toContain("второй раз не применяется");
  });

  it("ссылка на 571/пр, если она есть, главнее значения: чужая строка таблицы отклоняется, как раньше", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [{ ref: "571/пр_2022_п.83_т.2_стр.5_стб.3", text: "ОЗП=0,7; ЭМ=0,7; ЗПМ=0,7; МАТ=0; ТЗ=0,7; ТЗМ=0,7" }] }));
    expect(conditions?.special).toBeUndefined();
    expect(conditions?.rejected[0]?.reason).toContain("не совпадают со строкой 5 таблицы 2");
  });
});

describe("демонтаж Smeta.RU в ведомости: подтверждённый коэффициент идёт в позицию, неподтверждённый — подсказкой", () => {
  const set = buildLsrSet(parseCustomerLsr([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }]).estimates);
  const bill = lsrBillSection(set.entries[0] as (typeof set.entries)[number], 1);
  const item = (label: string) => bill.section.items.find((candidate) => candidate.positionNumber === label);

  it("в цитате строки сказано, какая строка таблицы названа и что применено", () => {
    expect(item("3")?.customerConditions?.special?.id).toBe("M571-P83-T2-R4");
    expect(item("3")?.sourceQuote).toContain("применены, как у заказчика: 571/пр п. 83, таблица 2, строка 4");
    expect(item("3")?.customerCoefficients).toBe("ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7");
    expect(item("6")?.sourceQuote).toContain("в расчёт не включены: приложением 10 к 421/пр не подтверждены");
  });

  it("свод: подтверждено у позиций 3, 8 и 9; отклонено у 6 и 17, причина названа", () => {
    const summary = summarizeCustomerConditions(bill.section.items, "ЛСР");
    expect(summary).toMatchObject({ positions: 5, confirmed: 3, rejected: 2, disabled: 0 });
    expect(summary.notes.some((note) => note.includes("поз. 6") && note.includes("такого значения нет"))).toBe(true);
    expect(summary.notes[0]).toContain("коэффициенты заказчика применены к 3 из");
  });
});
