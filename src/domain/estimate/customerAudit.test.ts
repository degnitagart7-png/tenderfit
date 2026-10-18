import { describe, expect, it } from "vitest";

import {
  auditCustomerLsr,
  MIN_RELIABLE_COVERAGE,
  type AuditReport,
} from "@/domain/estimate/customerAudit";
import { parseCustomerLsr, type CustomerLsr } from "@/domain/estimate/customerLsr";
import { lsrDocument, lsrHead, lsrRow, lsrTotals, type PositionSpec } from "@/domain/estimate/customerLsr.builders";
import { REAL_A_WITH_TOTALS, REAL_B_ROWS, REAL_SUPPLY_CABLES, REAL_SUPPLY_MOSCOW } from "@/domain/estimate/customerLsr.fixtures";
import type { WageAnchor } from "@/domain/estimate/types";
import { ANCHORS, machine, makeBook, SOURCE } from "@/test/auditPriceBook";

function parse(text: string): CustomerLsr {
  const { estimates } = parseCustomerLsr([{ name: "смета.xlsx", text }]);
  expect(estimates).toHaveLength(1);
  return estimates[0] as CustomerLsr;
}

/** Части разницы складываются в целое до копейки — главный инвариант аудита. */
function groupsSum(report: AuditReport): number {
  return Object.values(report.impacts).reduce((sum, entry) => sum + entry.amount, 0);
}

function expectGroupsToMatchDiff(report: AuditReport): void {
  expect(Math.abs(groupsSum(report) - report.diff)).toBeLessThan(0.01);
}

const A = parse(REAL_A_WITH_TOTALS);

/** Заменяет в тексте строку, начинающуюся с префикса: так портится одна цифра заказчика. */
function replaceLine(text: string, startsWith: string, change: (line: string) => string): string {
  let hit = false;
  const lines = text.split("\n").map((line) => {
    if (!hit && line.startsWith(startsWith)) {
      hit = true;
      return change(line);
    }
    return line;
  });
  expect(hit).toBe(true);
  return lines.join("\n");
}

describe("аудит сметы A против нашей книги, совпадающей с её ценами", () => {
  const report = auditCustomerLsr(A, { priceBook: makeBook() });

  it("арифметики заказчика нет: ни одной находки ARITHMETIC на реальных четырёх позициях", () => {
    expect(report.findings.filter((finding) => finding.type === "ARITHMETIC")).toEqual([]);
    // Остаётся только округление копеек в НР и СП самого заказчика.
    expect(Math.abs(report.impacts.ARITHMETIC.amount)).toBeLessThan(0.05);
  });

  it("разницы нет: итог сходится, вердикт MATCH, покрытие полное", () => {
    expect(report.customerTotal).toBe(17055.47);
    expect(Math.abs(report.diff)).toBeLessThan(0.5);
    expect(report.verdict).toBe("MATCH");
    expect(report.coverage).toBeGreaterThan(0.99);
    expect(report.vat).toMatchObject({ included: true, customerPercent: 22, ourPercent: 22 });
    expect(report.findings.filter((finding) => finding.severity === "WARNING")).toEqual([]);
    expectGroupsToMatchDiff(report);
  });

  it("«Н»-строки в проверку и в покрытие не входят: прямые затраты — только оценённые строки", () => {
    const first = A.positions[0]!;
    const priced = first.resources.filter((resource) => !resource.unaccounted).reduce((sum, resource) => sum + (resource.currentTotal ?? 0), 0);
    expect(priced).toBeCloseTo(3286.84 + 19.93 + 0.82, 2);
    expect(report.positions[0]!.checkedShare).toBe(1);
    expect(report.unchecked).toEqual([]);
  });
});

describe("цены ресурсов: наша цена против цены заказчика при его количестве", () => {
  it("труд дороже на 10 %: влияние = Δцены × его часы, плюс НР и СП по его процентам, части = разница", () => {
    const ours = makeBook({ anchors: ANCHORS.map((anchor) => (anchor.rank === 2.3 ? { ...anchor, salary: 672.16 } : anchor)) });
    const report = auditCustomerLsr(A, { priceBook: ours });
    const delta = 5.379 * (672.16 - 611.05);
    const finding = report.findings.find((entry) => entry.type === "RESOURCE_PRICE" && entry.subject === "1-100-23")!;
    expect(finding.impact).toBeCloseTo(delta, 4);
    expect(finding.customerValue).toBe(611.05);
    expect(finding.ourValue).toBeCloseTo(672.16, 2);
    expect(finding.quantity).toBe(5.379);
    // Группа «труд» вместе с НР (90 %) и СП (47 %) на него и с НДС 22 % по нашей ставке.
    expect(report.impacts.LABOUR.amount).toBeCloseTo(delta * (1 + 1.37) * 1.22, 2);
    expect(report.impacts.LABOUR.count).toBe(1);
    expect(report.impacts.MACHINES.amount).toBeCloseTo(0, 6);
    expect(report.verdict).toBe("UNDERSTATED");
    expect(report.conclusion).toContain("НМЦК занижена");
    expectGroupsToMatchDiff(report);
  });

  it("машина дешевле нашей: группа MACHINES, позиция в топе, находка с кодом и количеством", () => {
    const ours = makeBook({ current: [machine("91.18.01-508", 200), machine("91.21.10-002", 3.44)] });
    const report = auditCustomerLsr(A, { priceBook: ours });
    const delta = 0.1191 * (200 - 167.37);
    expect(report.impacts.MACHINES.amount).toBeCloseTo(delta * 1.22, 4);
    expect(report.top[0]!.number).toBe(1);
    expect(report.top[0]!.flags).toContain("RESOURCE_PRICE");
    expect(report.top.length).toBeLessThanOrEqual(10);
    expectGroupsToMatchDiff(report);
  });

  it("машинисты: цена машины зоны — без оплаты звена, она сравнивается со строкой «ЭМ» заказчика как есть, с строкой «4-100-*» и без неё", () => {
    const spec: PositionSpec = {
      n: 1,
      justification: "ГЭСН01-01-001-01",
      name: "Работа машины",
      unit: "100 м3",
      qty: 1,
      resources: [
        { code: "4-100-040", name: "Машинист", unit: "чел.-ч", qty: 10, price: 700 },
        { code: "91.18.01-508", name: "Компрессор", unit: "маш.-ч", qty: 10, price: 70 },
      ],
    };
    // «Сметная цена» ФГИС ЦС 70 ₽/маш.-ч — без оплаты машинистов 30 ₽; у заказчика те же 70 ₽, а оплата — строкой ОТм.
    const book = makeBook({
      current: [machine("91.18.01-508", 70, 30)],
      machinists: [{ rank: 4.0, salary: 700, source: SOURCE }],
    });
    const withCrew = auditCustomerLsr(parse(lsrDocument({ positions: [spec] })), { priceBook: book });
    expect(withCrew.findings.filter((finding) => finding.type === "RESOURCE_PRICE")).toEqual([]);

    // Без строки машиниста цена сравнивается так же: оплата звена из нашей цены не вычитается и к ней не прибавляется.
    const alone: PositionSpec = { ...spec, resources: [spec.resources[1]!] };
    const without = auditCustomerLsr(parse(lsrDocument({ positions: [alone] })), { priceBook: book });
    expect(without.findings.filter((finding) => finding.type === "RESOURCE_PRICE")).toEqual([]);

    // Цена зоны 80 при 70 у заказчика: расхождение 10 ₽ × 10 маш.-ч, а не 10 × (80 − 30 − 70).
    const dearer = makeBook({
      current: [machine("91.18.01-508", 80, 30)],
      machinists: [{ rank: 4.0, salary: 700, source: SOURCE }],
    });
    const differs = auditCustomerLsr(parse(lsrDocument({ positions: [spec] })), { priceBook: dearer });
    expect(differs.findings.find((finding) => finding.type === "RESOURCE_PRICE")?.impact).toBeCloseTo(10 * (80 - 70), 6);
  });

  it("разные единицы — не сравниваются, а называются: UNIT_MISMATCH и непроверенная сумма", () => {
    const spec: PositionSpec = {
      ...baseSpec(),
      resources: [{ code: "91.21.10-002", name: "Молотки", unit: "шт", qty: 2, price: 50 }],
    };
    const report = auditCustomerLsr(parse(lsrDocument({ positions: [spec] })), { priceBook: makeBook() });
    expect(report.findings.some((finding) => finding.type === "UNIT_MISMATCH")).toBe(true);
    expect(report.unchecked[0]).toMatchObject({ kind: "UNIT_MISMATCH", code: "91.21.10-002", amount: 100 });
    expect(report.coverage).toBe(0);
  });

  it("цена заказчика по КП без нашей цены: CUSTOMER_PRICE_NO_COMPARE и непроверенное", () => {
    const spec: PositionSpec = {
      ...baseSpec(),
      resources: [{ code: "Цена поставщика", name: "Кабель по КП", unit: "м", qty: 10, price: 200 }],
    };
    const report = auditCustomerLsr(parse(lsrDocument({ positions: [spec] })), { priceBook: makeBook() });
    expect(report.findings.some((finding) => finding.type === "CUSTOMER_PRICE_NO_COMPARE")).toBe(true);
    expect(report.unchecked[0]).toMatchObject({ kind: "CUSTOMER_PRICE", amount: 2000 });
  });
});

function baseSpec(): PositionSpec {
  return {
    n: 1,
    justification: "ГЭСН01-01-001-01",
    name: "Работа",
    unit: "100 м3",
    qty: 1,
    resources: [{ code: "1-100-20", name: "Рабочий", unit: "чел.-ч", qty: 10, price: 594.68 }],
    overhead: { ref: "Пр/812-090.0", base: 90 },
    profit: { ref: "Пр/774-090.0", base: 47 },
  };
}

describe("арифметика заказчика", () => {
  it("испорченное число: стоимость строки не равна количество × цена — ARITHMETIC с правильной суммой расхождения", () => {
    const broken = replaceLine(REAL_A_WITH_TOTALS, ",1-100-23,", (line) => line.replace('"3,286.84"', '"3,386.84"'));
    const report = auditCustomerLsr(parse(broken), { priceBook: makeBook() });
    const finding = report.findings.find((entry) => entry.type === "ARITHMETIC" && entry.message.includes("1-100-23"))!;
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("WARNING");
    expect(finding.discrepancy).toBeCloseTo(100, 1);
    expect(finding.message).toContain("3386.84");
    expect(report.positions[0]!.flags).toContain("ARITHMETIC");
    expect(report.impacts.ARITHMETIC.count).toBeGreaterThan(0);
    expect(report.impacts.ARITHMETIC.discrepancy).toBeGreaterThanOrEqual(100);
    expectGroupsToMatchDiff(report);
  });

  it("«Всего по позиции» не равно прямым + НР + СП — расхождение названо и вошло в группу ARITHMETIC", () => {
    const spec: PositionSpec = { ...baseSpec(), override: { total: 7000 } };
    const report = auditCustomerLsr(parse(lsrDocument({ positions: [spec] })), { priceBook: makeBook() });
    const finding = report.findings.find((entry) => entry.type === "ARITHMETIC" && entry.message.includes("Всего по позиции"))!;
    // 5 946,80 прямых + НР 90 % + СП 47 % = 14 086,... : напечатано 7 000.
    const honest = 5946.8 * 2.37;
    expect(finding.discrepancy).toBeCloseTo(honest - 7000, 1);
    // Пересчёт по его же цифрам даёт «правильную» стоимость, разница ушла в арифметику.
    expect(report.impacts.ARITHMETIC.amount).toBeCloseTo(honest - 7000, 1);
    expectGroupsToMatchDiff(report);
  });
});

describe("нормативы НР и СП против приказов 812/пр и 774/пр", () => {
  it("совпали — находок нет", () => {
    const report = auditCustomerLsr(A, { priceBook: makeBook() });
    expect(report.findings.some((finding) => finding.type === "OVERHEAD_RATE" || finding.type === "PROFIT_RATE")).toBe(false);
  });

  it("расходятся: СП без суффикса — WARNING, НР с суффиксом «-1» — INFO с просьбой проверить; суммы идут в группы", () => {
    const ours = makeBook({
      rates: { "Пр/812-090.0": 85, "Пр/774-090.0": 40, "Пр/812-091.0": 89, "Пр/774-091.0": 49 },
    });
    const report = auditCustomerLsr(A, { priceBook: ours });
    const overhead = report.findings.find((finding) => finding.type === "OVERHEAD_RATE")!;
    const profit = report.findings.find((finding) => finding.type === "PROFIT_RATE")!;
    expect(overhead.severity).toBe("INFO");
    expect(overhead.message).toContain("(-1)");
    expect(overhead.customerValue).toBe(90);
    expect(overhead.ourValue).toBe(85);
    expect(profit.severity).toBe("WARNING");
    // Позиции 1–3 на «Проемах»: ФОТ 3286,84 + 1667,58 + 395,18.
    const fot = 3286.84 + 1667.58 + 395.18;
    expect(report.impacts.OVERHEAD.amount).toBeCloseTo(((85 - 90) / 100) * fot * 1.22, 3);
    expect(report.impacts.PROFIT.amount).toBeCloseTo(((40 - 47) / 100) * fot * 1.22, 3);
    expect(report.impacts.OVERHEAD.count).toBe(3);
    expect(report.verdict).toBe("OVERSTATED");
    expectGroupsToMatchDiff(report);
  });

  it("указателя нет в справочнике — RATE_NOT_CHECKED, а не догадка", () => {
    const report = auditCustomerLsr(A, { priceBook: makeBook({ rates: {} }) });
    expect(report.findings.some((finding) => finding.type === "RATE_NOT_CHECKED")).toBe(true);
    expect(report.impacts.OVERHEAD.amount).toBe(0);
  });
});

describe("коэффициенты, уровень цен, зона, сумма разделов", () => {
  it("коэффициенты в обосновании — INFO COEFFICIENTS с их текстом", () => {
    const spec: PositionSpec = { ...baseSpec(), justification: "ГЭСНм11-03-001-01{(К Кзтр=1.2; Кзтм=1.2)}" };
    const report = auditCustomerLsr(parse(lsrDocument({ positions: [spec] })), { priceBook: makeBook() });
    const finding = report.findings.find((entry) => entry.type === "COEFFICIENTS")!;
    expect(finding.severity).toBe("INFO");
    expect(finding.message).toContain("Кзтр=1.2");
  });

  it("смета в ценах более раннего квартала — OUTDATED_PRICE_LEVEL; в тех же — нет", () => {
    const old = auditCustomerLsr(A, { priceBook: makeBook({ period: "3 квартал 2026 г." }) });
    const outdated = old.findings.find((finding) => finding.type === "OUTDATED_PRICE_LEVEL")!;
    expect(outdated.severity).toBe("WARNING");
    expect(outdated.message).toContain("2 кв. 2026");
    expect(outdated.message).toContain("устарела на квартал");
    const later = auditCustomerLsr(A, { priceBook: makeBook({ period: "1 квартал 2027 г." }) });
    expect(later.findings.find((finding) => finding.type === "OUTDATED_PRICE_LEVEL")!.message).toContain("устарела на 3 квартала");
    const same = auditCustomerLsr(A, { priceBook: makeBook() });
    expect(same.findings.some((finding) => finding.type === "OUTDATED_PRICE_LEVEL")).toBe(false);
  });

  it("расхождение суммы позиций с итогом разделов — INFO SECTIONS_SUM", () => {
    const text = lsrDocument({ positions: [baseSpec()], totals: { sectionTotal: 1000, total: 1000 } });
    const report = auditCustomerLsr(parse(text), { priceBook: makeBook() });
    expect(report.findings.some((finding) => finding.type === "SECTIONS_SUM")).toBe(true);
  });
});

describe("НДС", () => {
  const sectionTotal = 13979.89;

  it("НДС 20 % в смете заказчика — VAT_RATE на его базу: (22−20)% × база", () => {
    const withVat20 = REAL_A_WITH_TOTALS.replace("НДС 22%", "НДС 20%").replace('"3,075.58"', '"2,795.98"').replace('"17,055.47"', '"16,775.87"');
    const lsr = parse(withVat20);
    expect(lsr.vatPercent).toBe(20);
    const report = auditCustomerLsr(lsr, { priceBook: makeBook() });
    const finding = report.findings.find((entry) => entry.type === "VAT_RATE")!;
    expect(finding.severity).toBe("WARNING");
    expect(finding.impact).toBeCloseTo(0.02 * sectionTotal, 1);
    expect(finding.customerValue).toBe(20);
    expect(finding.ourValue).toBe(22);
    expect(report.impacts.VAT.amount).toBeCloseTo(0.02 * sectionTotal, 1);
    expect(report.impacts.VAT.count).toBe(1);
    // Цены наши и его совпадают, значит вся разница — НДС.
    expect(report.diff).toBeCloseTo(0.02 * sectionTotal, 0);
    expect(report.verdict).toBe("UNDERSTATED");
    expectGroupsToMatchDiff(report);
  });

  it("ставка выведена по итогу ×1,22 и равна нашей — находки VAT_RATE нет", () => {
    const withoutVatRow = REAL_A_WITH_TOTALS.split("\n").filter((line) => !line.includes("НДС 22%")).join("\n");
    const lsr = parse(withoutVatRow);
    expect(lsr.vatInferred).toBe(true);
    const report = auditCustomerLsr(lsr, { priceBook: makeBook() });
    expect(report.findings.some((finding) => finding.type === "VAT_RATE")).toBe(false);
    expect(report.vat).toMatchObject({ included: true, inferred: true, customerPercent: 22 });
  });

  it("ставка выведена как 20 % — находка есть и говорит, что ставка выведена по итогу", () => {
    const withoutVatRow = REAL_A_WITH_TOTALS.split("\n")
      .filter((line) => !line.includes("НДС 22%"))
      .join("\n")
      .replace('"17,055.47"', '"16,775.87"');
    const lsr = parse(withoutVatRow);
    expect(lsr).toMatchObject({ vatPercent: 20, vatInferred: true });
    const finding = auditCustomerLsr(lsr, { priceBook: makeBook() }).findings.find((entry) => entry.type === "VAT_RATE")!;
    expect(finding.message).toContain("выведена по итогу");
  });

  it("НДС за итогом (итог сметы без НДС): база восстановлена по сумме НДС, разница считается с НДС", () => {
    const text = lsrDocument({
      positions: [baseSpec()],
      totals: { sectionTotal: 14086.9, total: 14086.9, vatAfterTotal: { percent: 22, amount: 3099.12 } },
    });
    const lsr = parse(text);
    expect(lsr.vatPercent).toBe(22);
    const report = auditCustomerLsr(lsr, { priceBook: makeBook({ anchors: ANCHORS.map((anchor) => (anchor.rank === 2.0 ? { ...anchor, salary: 700 } : anchor)) }) });
    expect(report.vat.included).toBe(true);
    // Итог заказчика — это база плюс его НДС.
    expect(report.customerTotal).toBeCloseTo(14086.9 + 3099.12, 0);
    expectGroupsToMatchDiff(report);
  });
});

describe("покрытие и оговорка", () => {
  it("всё проверено — вывод без оговорки", () => {
    const report = auditCustomerLsr(A, { priceBook: makeBook() });
    expect(report.coverage).toBeGreaterThanOrEqual(MIN_RELIABLE_COVERAGE);
    expect(report.conclusion).not.toContain("вывод неполный");
  });

  it("нашей цены на труд нет — покрытие ниже 70 %, ресурсы в непроверенном, вывод с оговоркой", () => {
    const noWages = makeBook({ anchors: [] });
    const report = auditCustomerLsr(A, { priceBook: noWages });
    expect(report.coverage).toBeLessThan(MIN_RELIABLE_COVERAGE);
    expect(report.conclusion).toMatch(/проверено \d+ % сметы — вывод неполный/);
    expect(report.findings.some((finding) => finding.type === "OUR_PRICE_MISSING")).toBe(true);
    expect(report.unchecked.map((item) => item.kind)).toContain("OUR_PRICE_MISSING");
    expect(report.unchecked[0]!.amount).toBeGreaterThan(0);
  });

  it("позиция без ресурсов (цена в строке позиции) — NO_RESOURCES в непроверенном", () => {
    const text = lsrDocument({ positions: [{ ...baseSpec(), resources: [], override: { total: 5000 } }] });
    const report = auditCustomerLsr(parse(text), { priceBook: makeBook() });
    expect(report.coverage).toBe(0);
    expect(report.unchecked[0]).toMatchObject({ kind: "NO_RESOURCES", amount: 5000 });
    expect(report.diff).toBe(0);
  });
});

describe("реальная смета B (пусконаладка, специалисты)", () => {
  it("инженер и рабочий по нашей шкале, НР 74 % и СП 36 % совпали — разницы нет", () => {
    const lsr = parse(REAL_B_ROWS);
    const report = auditCustomerLsr(lsr, { priceBook: makeBook() });
    expect(report.vat.included).toBe(false);
    expect(report.customerTotal).toBe(189772.38);
    expect(Math.abs(report.diff)).toBeLessThan(1);
    expect(report.findings.filter((finding) => finding.type === "ARITHMETIC")).toEqual([]);
    expect(report.coverage).toBe(1);
  });

  it("у инженера нашей ставки нет в справочнике — OUR_PRICE_MISSING, труд специалиста не угадывается", () => {
    const lsr = parse(REAL_B_ROWS);
    const book = makeBook();
    const poor = { ...book, wageScale: { ...book.wageScale, specialists: [] } };
    const report = auditCustomerLsr(lsr, { priceBook: poor });
    expect(report.findings.some((finding) => finding.type === "OUR_PRICE_MISSING" && finding.subject === "3-200-03")).toBe(true);
    expect(report.coverage).toBeLessThan(0.5);
  });
});

describe("зона", () => {
  it("смета заказчика названа по другой зоне — ZONE_MISMATCH", () => {
    const lsr: CustomerLsr = { ...A, priceLevel: { zone: 2, quarter: 3, year: 2026 } };
    const report = auditCustomerLsr(lsr, { priceBook: makeBook() });
    expect(report.findings.some((finding) => finding.type === "ZONE_MISMATCH")).toBe(true);
    const same = auditCustomerLsr({ ...A, priceLevel: { zone: 1, quarter: 3, year: 2026 } }, { priceBook: makeBook() });
    expect(same.findings.some((finding) => finding.type === "ZONE_MISMATCH")).toBe(false);
  });

  it("зона и период отчёта — те, по которым шло сравнение", () => {
    const report = auditCustomerLsr(A, { priceBook: makeBook() });
    expect(report.zone).toBe("Республика Бурятия (1 зона)");
    expect(report.period).toBe("2 квартал 2026 г.");
  });
});

describe("позиции-поставки (материал, оборудование, цена по КП в строке позиции)", () => {
  const cables = parse(REAL_SUPPLY_CABLES);
  const CABLE_PRICES = [
    machine("21.1.07.02-0097", 813163.36, null, "1000 м"),
    machine("21.1.07.02-0099", 1443481.79, null, "1000 м"),
    machine("21.1.07.05-0116", 5405647.46, null, "1000 м"),
  ];
  const cableBook = (patch: { current?: ReturnType<typeof machine>[] } = {}) => makeBook({ current: patch.current ?? CABLE_PRICES });
  const CABLES_TOTAL = 215488.29 + 459027.21 + 843281.0 + 747240.98;

  it("кабель ФСБЦ переоценивается как один ресурс: цены совпали — разницы нет, арифметики нет, стоимость в проверенном", () => {
    const report = auditCustomerLsr(cables, { priceBook: cableBook() });
    expect(report.findings.filter((finding) => finding.type === "ARITHMETIC" || finding.type === "RESOURCE_PRICE")).toEqual([]);
    expect(Math.abs(report.diff)).toBeLessThan(0.5);
    // Совпавшие строки входят в «проверено»: три кабеля ФСБЦ, КП-кабель — нет (цена заказчика).
    expect(report.checkedDirect).toBeCloseTo(215488.29 + 459027.21 + 843281.0, 2);
    expect(report.totalDirect).toBeCloseTo(CABLES_TOTAL, 2);
    expect(report.coverage).toBeCloseTo((215488.29 + 459027.21 + 843281.0) / CABLES_TOTAL, 6);
    expect(report.positions.find((position) => position.number === 16)!.checkedShare).toBe(1);
    expectGroupsToMatchDiff(report);
  });

  it("наша цена выше на 10 %: влияние = Δцены × объём в MATERIALS, НР и СП нет, части = разница", () => {
    const pricier = CABLE_PRICES.map((price) => (price.code === "21.1.07.05-0116" ? { ...price, price: Math.round(price.price * 1.1 * 100) / 100 } : price));
    const report = auditCustomerLsr(cables, { priceBook: cableBook({ current: pricier }) });
    const delta = 0.156 * (5946212.21 - 5405647.46);
    const finding = report.findings.find((entry) => entry.type === "RESOURCE_PRICE")!;
    expect(finding.subject).toBe("21.1.07.05-0116");
    expect(finding.quantity).toBe(0.156);
    expect(finding.impact).toBeCloseTo(delta, 0);
    expect(report.impacts.MATERIALS.amount).toBeCloseTo(delta, 0);
    expect(report.impacts.MATERIALS.count).toBe(1);
    expect(report.impacts.OVERHEAD.amount).toBe(0);
    expect(report.impacts.PROFIT.amount).toBe(0);
    expect(report.top[0]).toMatchObject({ number: 16 });
    expect(report.verdict).toBe("UNDERSTATED");
    expectGroupsToMatchDiff(report);
  });

  it("единица у нас «м», у заказчика «1000 м»: цена приводится к его единице, это не UNIT_MISMATCH", () => {
    const perMetre = CABLE_PRICES.map((price) => ({ ...price, unit: "м", price: price.price / 1000 }));
    const report = auditCustomerLsr(cables, { priceBook: cableBook({ current: perMetre }) });
    expect(report.findings.filter((finding) => finding.type === "UNIT_MISMATCH" || finding.type === "RESOURCE_PRICE")).toEqual([]);
    expect(report.unchecked.some((item) => item.kind === "UNIT_MISMATCH")).toBe(false);
    expect(report.checkedDirect).toBeGreaterThan(1_500_000);
  });

  it("нашей цены на кабель нет — OUR_PRICE_MISSING с суммой в непроверенном, а не NO_RESOURCES", () => {
    const report = auditCustomerLsr(cables, { priceBook: cableBook({ current: [] }) });
    expect(report.unchecked.find((item) => item.code === "21.1.07.05-0116")).toMatchObject({ kind: "OUR_PRICE_MISSING", amount: 843281 });
    expect(report.unchecked.some((item) => item.kind === "NO_RESOURCES")).toBe(false);
    expect(report.coverage).toBe(0);
    expect(report.conclusion).toContain("вывод неполный");
  });

  it("кабель по КП без обоснования: CUSTOMER_PRICE, а не NO_RESOURCES; арифметика с коэффициентом 1,02 сходится", () => {
    const report = auditCustomerLsr(cables, { priceBook: cableBook() });
    expect(report.unchecked).toEqual([
      expect.objectContaining({ kind: "CUSTOMER_PRICE", code: "Кабель ПвПу-10-1х300/70", amount: 747240.98 }),
    ]);
    expect(report.findings.some((finding) => finding.type === "CUSTOMER_PRICE_NO_COMPARE")).toBe(true);
    // 245 × 2 990,16 × 1,02 = 747 240,98: расхождения нет.
    expect(report.findings.some((finding) => finding.type === "ARITHMETIC")).toBe(false);
  });

  it("порча арифметики поставки: цена × объём ≠ стоимость — ARITHMETIC на кабеле", () => {
    const broken = REAL_SUPPLY_CABLES.replace('"843,281.00",,', '"900,000.00",,').replace(/"843,281.00"/g, '"900,000.00"');
    const report = auditCustomerLsr(parse(broken), { priceBook: cableBook() });
    const finding = report.findings.find((entry) => entry.type === "ARITHMETIC" && entry.message.includes("21.1.07.05-0116"))!;
    expect(finding.discrepancy).toBeCloseTo(900000 - 843281, 0);
  });

  it("Москва: голый код 04.3.02.13-0022 сверяется с нашей ценой; ТЦ с группой «06.2.01.02» без номера не сравнивается", () => {
    const moscow = parse(REAL_SUPPLY_MOSCOW);
    const book = makeBook({
      current: [machine("04.3.02.13-0022", 36.08, null, "кг"), machine("06.2.01.02", 1000, null, "м2")],
      period: "2 квартал 2026 г.",
    });
    const report = auditCustomerLsr(moscow, { priceBook: book });
    const delta = 4224 * (36.08 - 33.71);
    expect(report.findings.find((entry) => entry.type === "RESOURCE_PRICE")).toMatchObject({ subject: "04.3.02.13-0022", quantity: 4224 });
    expect(report.impacts.MATERIALS.amount).toBeCloseTo(delta, 1);
    // Плитка — только цена заказчика: группа без номера не код ресурса, хотя у нас «06.2.01.02» есть.
    expect(report.unchecked).toEqual([expect.objectContaining({ kind: "CUSTOMER_PRICE", amount: 1773735.22 })]);
    expect(report.coverage).toBeCloseTo(142391.04 / (142391.04 + 1773735.22), 6);
    expectGroupsToMatchDiff(report);
  });

  it("ТЦ_ с полным кодом 06.2.01.02-0012 внутри — сравнивается как цена заказчика", () => {
    const rows = [
      ...lsrHead({ date: "01.04.2026" }),
      "Раздел 1. Отделка",
      lsrRow({ 1: "1", 2: "ТЦ_06.2.01.02-0012_77_7743136928_10.08.2026", 3: "Плитка керамическая", 4: "м2", 5: "10", 6: "1", 7: "10", 10: "1000", 12: "10,000.00" }),
      lsrRow({ 3: "Всего по позиции", 12: "10,000.00" }),
      ...lsrTotals({ sectionTotal: 10000, total: 10000 }),
    ].join("\n");
    const book = makeBook({ current: [machine("06.2.01.02-0012", 800, null, "м2")] });
    const report = auditCustomerLsr(parse(rows), { priceBook: book });
    const finding = report.findings.find((entry) => entry.type === "RESOURCE_PRICE")!;
    expect(finding.subject).toBe("06.2.01.02-0012");
    expect(finding.message).toContain("цена заказчика по КП");
    expect(finding.impact).toBeCloseTo(10 * (800 - 1000), 6);
    expect(report.coverage).toBe(1);
    expectGroupsToMatchDiff(report);
  });

  it("позиция ГЭСН без ресурсов остаётся NO_RESOURCES: её состав неизвестен", () => {
    const rows = [
      ...lsrHead(),
      "Раздел 1. Работы",
      lsrRow({ 1: "1", 2: "ГЭСН01-01-001-01", 3: "Разработка грунта", 4: "100 м3", 5: "1", 6: "1", 7: "1", 12: "5,000.00" }),
      lsrRow({ 3: "Всего по позиции", 12: "5,000.00" }),
      ...lsrTotals({ sectionTotal: 5000, total: 5000 }),
    ].join("\n");
    const report = auditCustomerLsr(parse(rows), { priceBook: makeBook() });
    expect(report.unchecked).toEqual([expect.objectContaining({ kind: "NO_RESOURCES", amount: 5000 })]);
  });
});

describe("покрытие: совпавшие строки считаются проверенными", () => {
  it("реальная смета A при ценах, равных ценам заказчика, — checkedDirect равен всем оцениваемым прямым затратам", () => {
    const report = auditCustomerLsr(A, { priceBook: makeBook() });
    expect(report.findings.filter((finding) => finding.type === "RESOURCE_PRICE")).toEqual([]);
    expect(report.checkedDirect).toBeGreaterThan(0);
    expect(report.checkedDirect).toBeCloseTo(report.totalDirect, 6);
    expect(report.coverage).toBe(1);
  });

  it("реальная смета B («нр КЛ»): цены совпали, покрытие 100 %", () => {
    const report = auditCustomerLsr(parse(REAL_B_ROWS), { priceBook: makeBook() });
    expect(report.checkedDirect).toBeCloseTo(90367.8, 2);
    expect(report.coverage).toBe(1);
  });
});

describe("цены из «всех цен сплит-формы» (auditPrices)", () => {
  const cables = parse(REAL_SUPPLY_CABLES);
  // В основной книге кабелей нет (она режется по нормам), в auditPrices — есть, по индексу.
  const auditPrices = new Map([
    ["21.1.07.02-0097", { price: 813163.36, unit: "1000 м", indexed: true }],
    ["21.1.07.02-0099", { price: 1443481.79, unit: "1000 м", indexed: true }],
    ["21.1.07.05-0116", { price: 5580023.18, unit: "1000 м", indexed: true }],
  ]);
  const bare = () => makeBook({ current: [] });

  it("без auditPrices кабели не проверены — как раньше; с ними — найдены и переоценены", () => {
    const without = auditCustomerLsr(cables, { priceBook: bare() });
    expect(without.unchecked.filter((item) => item.kind === "OUR_PRICE_MISSING")).toHaveLength(3);
    expect(auditCustomerLsr(cables, { priceBook: bare(), auditPrices: null }).coverage).toBe(without.coverage);

    const withPrices = auditCustomerLsr(cables, { priceBook: bare(), auditPrices });
    expect(withPrices.unchecked.some((item) => item.kind === "OUR_PRICE_MISSING")).toBe(false);
    const delta = 0.156 * (5580023.18 - 5405647.46);
    const finding = withPrices.findings.find((entry) => entry.type === "RESOURCE_PRICE")!;
    expect(finding).toMatchObject({ subject: "21.1.07.05-0116", ourSource: "INDEXED" });
    expect(finding.impact).toBeCloseTo(delta, 1);
    expect(withPrices.impacts.MATERIALS.amount).toBeCloseTo(delta, 1);
    expectGroupsToMatchDiff(withPrices);
    // Покрытие выросло с нуля до доли кабелей ФСБЦ (КП-кабель по-прежнему цена заказчика).
    expect(withPrices.coverage).toBeCloseTo((215488.29 + 459027.21 + 843281) / (215488.29 + 459027.21 + 843281 + 747240.98), 6);
  });

  it("источник цены назван в находке: «по индексу сплит-формы» и «текущая цена зоны»", () => {
    const indexed = auditCustomerLsr(cables, { priceBook: bare(), auditPrices }).findings.find((entry) => entry.type === "RESOURCE_PRICE")!;
    expect(indexed.message).toContain("(по индексу сплит-формы)");

    const measured = new Map([["21.1.07.05-0116", { price: 5580023.18, unit: "1000 м", indexed: false }]]);
    const direct = auditCustomerLsr(cables, { priceBook: bare(), auditPrices: measured }).findings.find((entry) => entry.type === "RESOURCE_PRICE")!;
    expect(direct).toMatchObject({ ourSource: "CURRENT_ZONE" });
    expect(direct.message).toContain("(текущая цена зоны)");

    // Цена из основной книги с источником «по индексу» (BASE_2022_INDEXED) подписана так же.
    const book = makeBook({ current: [{ ...machine("21.1.07.05-0116", 5580023.18, null, "1000 м"), source: "BASE_2022_INDEXED" }] });
    const fromBook = auditCustomerLsr(cables, { priceBook: book }).findings.find((entry) => entry.type === "RESOURCE_PRICE")!;
    expect(fromBook.ourSource).toBe("INDEXED");
  });

  it("основная книга важнее auditPrices", () => {
    const book = makeBook({ current: [machine("21.1.07.05-0116", 5405647.46, null, "1000 м")] });
    const report = auditCustomerLsr(cables, { priceBook: book, auditPrices });
    // По книге цена совпала с заказчиком: находки нет, хотя в auditPrices цена выше.
    expect(report.findings.some((finding) => finding.type === "RESOURCE_PRICE" && finding.subject === "21.1.07.05-0116")).toBe(false);
  });

  it("машина из auditPrices при строках машинистов оценивается: цена «всех цен» — без оплаты звена, как и строка «ЭМ» заказчика", () => {
    const spec: PositionSpec = {
      n: 1,
      justification: "ГЭСН01-01-001-01",
      name: "Работа машины",
      unit: "100 м3",
      qty: 1,
      resources: [
        { code: "4-100-040", name: "Машинист", unit: "чел.-ч", qty: 10, price: 700 },
        { code: "91.18.01-508", name: "Компрессор", unit: "маш.-ч", qty: 10, price: 70 },
      ],
    };
    const only = new Map([["91.18.01-508", { price: 100, unit: "маш.-ч", indexed: false }]]);
    const book = makeBook({ current: [], machinists: [{ rank: 4.0, salary: 700, source: SOURCE }] });
    const report = auditCustomerLsr(parse(lsrDocument({ positions: [spec] })), { priceBook: book, auditPrices: only });
    // Обе цены без оплаты машинистов: 100 против 70, расхождение 10 маш.-ч × 30 ₽.
    expect(report.findings.find((finding) => finding.type === "RESOURCE_PRICE" && finding.subject === "91.18.01-508")?.impact).toBeCloseTo(10 * (100 - 70), 6);
    expect(report.unchecked.some((item) => item.code === "91.18.01-508" && item.kind === "OUR_PRICE_MISSING")).toBe(false);
  });
});

describe("базис заказчика против ФСБЦ-2022 (INFO)", () => {
  const cables = parse(REAL_SUPPLY_CABLES);
  const auditPrices = new Map([["21.1.07.05-0116", { price: 5405647.46, unit: "1000 м", indexed: true }]]);
  const federal = (code: string, price: number) => machine(code, price, null, "1000 м");

  it("базис совпал: одна сводная строка, поштучных замечаний нет", () => {
    const book = makeBook({ current: [], base: [federal("21.1.07.05-0116", 4359393.11), federal("21.1.07.02-0099", 1586243.72)] });
    const report = auditCustomerLsr(cables, { priceBook: book, auditPrices });
    const info = report.findings.filter((finding) => finding.type === "BASE_PRICE");
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ severity: "INFO", positionNumber: null });
    expect(info[0]!.message).toContain("у 2 ресурсов: совпал у 2, расходится у 0");
  });

  it("базис не совпал: INFO по ресурсу с обеими ценами и сводка", () => {
    const book = makeBook({ current: [], base: [federal("21.1.07.05-0116", 4000000)] });
    const report = auditCustomerLsr(cables, { priceBook: book, auditPrices });
    const rows = report.findings.filter((finding) => finding.type === "BASE_PRICE" && finding.positionNumber !== null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "INFO", subject: "21.1.07.05-0116", customerValue: 4359393.11, ourValue: 4000000 });
    expect(rows[0]!.message).toContain("базис заказчика 4359393.11 ₽, по ФСБЦ-2022 4000000.00 ₽");
    expect(report.findings.find((finding) => finding.type === "BASE_PRICE" && finding.positionNumber === null)!.message).toContain("совпал у 0, расходится у 1");
    // Это замечание, а не WARNING: на итог оно не влияет.
    expect(report.findings.filter((finding) => finding.severity === "WARNING" && finding.type === "BASE_PRICE")).toEqual([]);
  });

  it("у одной из сторон базиса нет — не сверяется; машины и труд не сверяются никогда", () => {
    expect(auditCustomerLsr(cables, { priceBook: makeBook({ current: [] }), auditPrices }).findings.some((finding) => finding.type === "BASE_PRICE")).toBe(false);
    // Реальная A: у машин базис без оплаты машинистов (37,32 против 336,09 в ФСБЦ) — это не расхождение.
    const book = makeBook({ base: [machine("91.06.06-048", 336.09, null, "маш.-ч"), machine("91.18.01-508", 115.43, null, "маш.-ч")] });
    expect(auditCustomerLsr(A, { priceBook: book }).findings.some((finding) => finding.type === "BASE_PRICE")).toBe(false);
  });
});
