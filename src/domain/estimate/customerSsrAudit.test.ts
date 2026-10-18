import { describe, expect, it } from "vitest";

import { parseCustomerSsr } from "@/domain/estimate/customerSsr";
import { SSR_377_CSV, SSR_377_FLAT, SSR_BAD, SSR_THOUSANDS } from "@/domain/estimate/customerSsr.fixtures";
import { auditCustomerSsr, SSR_FINDING_TITLES, type SsrAuditContext, type SsrAuditFinding } from "@/domain/estimate/customerSsrAudit";
import { computeForecastInflation } from "@/domain/estimate/forecastInflation";
import { buildSsr, resolvePurpose } from "@/domain/estimate/ssr";
import type { ObjectPurpose } from "@/domain/estimate/ssrTypes";
import { ssrEstimate } from "@/test/ssrFixtures";

/*
  Находки аудита ССР заказчика. Фикстуры сконструированы (см. customerSsr.fixtures.ts): 377 — «чистый» расчёт, который
  сходится с НМЦК; SSR_BAD — расчёт со всеми ошибками, которые проверяет аудит.
*/

const NMC_377 = 2_032_153.32;
const NO_PERIOD = computeForecastInflation({ period: null, priceDate: "2026-10-01", today: "2026-10-09" });
const OCT_NOV = computeForecastInflation({ period: { kind: "DATES", start: "2026-10-01", end: "2026-11-30" }, priceDate: "2026-10-01", today: "2026-10-09" });

function context(over: Omit<Partial<SsrAuditContext>, "purpose"> & { purpose?: ObjectPurpose | null } = {}): SsrAuditContext {
  const { purpose = null, ...rest } = over;
  return {
    purpose: resolvePurpose(purpose, null),
    vatPercent: 22,
    nmc: NMC_377,
    nmcIncludesVat: true,
    ourInflation: NO_PERIOD,
    priceDate: "2026-10-01",
    today: "2026-10-09",
    ourSsr: null,
    ...rest,
  };
}

function audit(text: string, ctx: SsrAuditContext) {
  const [ssr] = parseCustomerSsr([{ name: "ССРСС.xlsx", text }]);
  return auditCustomerSsr(ssr!, ctx);
}

/** Intl печатает неразрывные пробелы в разрядах: в сообщениях для сверки со строкой теста — обычные. */
const plain = (finding: SsrAuditFinding): SsrAuditFinding => ({ ...finding, message: finding.message.replace(/[\u00a0\u202f]/gu, " ") });

const types = (findings: readonly SsrAuditFinding[], severity?: SsrAuditFinding["severity"]): string[] =>
  findings.filter((finding) => severity === undefined || finding.severity === severity).map((finding) => finding.type);
const one = (findings: readonly SsrAuditFinding[], type: SsrAuditFinding["type"]): SsrAuditFinding => plain(findings.find((finding) => finding.type === type)!);

describe("ССР закупки 377: расчёт заказчика сходится", () => {
  const report = audit(SSR_377_CSV, context());

  it("замечаний нет: резерв 2 % для непроизводственного, НДС 22 %, арифметика сходится", () => {
    expect(report.warnings).toBe(0);
    expect(report.conclusion).toContain("сходится");
    expect(types(report.findings, "WARNING")).toEqual([]);
  });

  it("индекс 1,0045 против нашего 1,0047 за октябрь-ноябрь 2026: в пределах допуска 0,005 — справка, не находка", () => {
    const finding = one(report.findings, "INFLATION_INDEX");
    expect(finding.severity).toBe("INFO");
    expect(finding.message).toContain("1,0045 сходится с нашим 1,0047");
    expect(finding.message).toContain("(1,0000 + 1,0095) / 2 = 1,0047");
    expect(report.ourInflation?.index).toBe(1.0047);
    expect(report.inflationPeriod).toBe("октябрь-ноябрь 2026");
  });

  it("тот же результат по плоскому тексту", () => {
    const flat = audit(SSR_377_FLAT, context());
    expect(flat.warnings).toBe(0);
    expect(flat.customer).toMatchObject({ reservePercent: 2, inflationIndex: 1.0045, vatPercent: 22 });
  });

  it("ключевые цифры заказчика", () => {
    expect(report.customer).toMatchObject({ chaptersTotal: 1_625_720, reservePercent: 2, inflationIndex: 1.0045, vatPercent: 22, total: 2_032_149.67, unitMultiplier: 1 });
  });
});

describe("процент непредвиденных против норматива (п. 179)", () => {
  const withReserve = (percent: number, purpose: ObjectPurpose | null) =>
    audit(SSR_377_CSV.replace(/- 2%/u, `- ${String(percent)}%`).replace("32514.40", String(Math.round(1_625_720 * percent) / 100)), context({ purpose }));

  it("3 % для непроизводственного объекта по выбору пользователя — находка с деньгами (минус: НМЦК завышена)", () => {
    const report = withReserve(3, "NON_PRODUCTION");
    const finding = one(report.findings, "RESERVE_PERCENT");
    expect(finding.severity).toBe("WARNING");
    expect(finding.message).toContain("3 % выше предела 2 %");
    expect(finding.impact).toBeLessThan(0);
    // (3 − 2) % × 1 625 720 × 1,0045 × 1,22
    expect(finding.impact).toBeCloseTo(-(0.01 * 1_625_720 * 1.0045 * 1.22), 0);
    expect(finding.ref).toBe("421/пр, п. 179, подп. «а»");
  });

  it("3 % для производственного или линейного объекта — в пределах, находки нет", () => {
    expect(types(withReserve(3, "PRODUCTION").findings)).not.toContain("RESERVE_PERCENT");
  });

  it("3 % при неизвестном назначении — справка с просьбой уточнить, без суммы", () => {
    const finding = one(withReserve(3, null).findings, "RESERVE_PERCENT");
    expect(finding.severity).toBe("INFO");
    expect(finding.impact).toBeNull();
    expect(finding.message).toContain("Назначение объекта не указано");
  });

  it("5 % — больше любого предела, кроме уникальных: находка даже при неизвестном назначении", () => {
    expect(one(withReserve(5, null).findings, "RESERVE_PERCENT").severity).toBe("WARNING");
    expect(types(withReserve(5, "UNIQUE").findings)).not.toContain("RESERVE_PERCENT");
    expect(one(withReserve(11, "UNIQUE").findings, "RESERVE_PERCENT").message).toContain("выше предела 10 %");
  });

  it("2 % — ровно предел, находки нет", () => {
    expect(types(withReserve(2, "NON_PRODUCTION").findings)).not.toContain("RESERVE_PERCENT");
  });
});

describe("ошибочный ССР: все проверки", () => {
  const ctx = context({ purpose: "NON_PRODUCTION", nmc: 1_813_280.4, ourInflation: OCT_NOV });
  const report = audit(SSR_BAD, ctx);

  it("находки по типам: арифметика главы, резерв (процент и база), инфляция, НДС, затраты заказчика", () => {
    expect(types(report.findings, "WARNING")).toEqual(["CHAPTER_SUM", "RESERVE_PERCENT", "RESERVE_BASE", "INFLATION_INDEX", "VAT_RATE", "CUSTOMER_SCOPE"]);
    expect(report.warnings).toBe(6);
    for (const finding of report.findings) expect(SSR_FINDING_TITLES[finding.type]).toBeTruthy();
  });

  it("арифметика главы: итог 1 010 000, строки 1 000 000", () => {
    const finding = one(report.findings, "CHAPTER_SUM");
    expect(finding.message).toContain("Глава 2");
    expect(finding.message).toContain("1 010 000");
    expect(finding.message).toContain("1 000 000");
    expect(finding.ref).toContain("п. 141");
  });

  it("база резерва: 3 % от глав 1-12 (1 350 000) = 40 500, а напечатано 36 300 — цифра сходится с итогом глав 1-7", () => {
    const finding = one(report.findings, "RESERVE_BASE");
    expect(finding.message).toContain("40 500");
    expect(finding.message).toContain("36 300");
    expect(finding.message).toContain("итого по главам 1-7");
    expect(finding.impact).toBeCloseTo((40_500 - 36_300) * 1.09 * 1.2, 0);
  });

  it("индекс 1,09 вместо 1,0047 за октябрь-ноябрь: НМЦК завышена на разницу индексов × итог с резервом × НДС", () => {
    const finding = one(report.findings, "INFLATION_INDEX");
    expect(finding.severity).toBe("WARNING");
    expect(finding.message).toContain("1,0900");
    expect(finding.message).toContain("наш 1,0047");
    expect(finding.impact).toBeCloseTo((1.0047 - 1.09) * 1_386_300 * 1.2, 0);
    expect(finding.ref).toContain("841/пр");
  });

  it("НДС 20 % вместо 22 %: НМЦК занижена на 2 % от базы НДС", () => {
    const finding = one(report.findings, "VAT_RATE");
    expect(finding.message).toContain("НДС 20 % вместо 22 %");
    expect(finding.impact).toBeCloseTo(0.02 * 1_511_067, 0);
  });

  it("глава 10 (строительный контроль) в цене: НМЦК равна итогу ССР целиком — находка, деньги = глава 10 × резерв × индекс × НДС", () => {
    const finding = one(report.findings, "CUSTOMER_SCOPE");
    expect(finding.severity).toBe("WARNING");
    expect(finding.message).toContain("включает затраты заказчика: глава 10 50 000");
    expect(finding.message).toContain("841/пр, п. 21");
    expect(finding.impact).toBeCloseTo(-(50_000 * 1.03 * 1.09 * 1.2), 0);
  });

  it("итог и НДС заказчика между собой согласованы — арифметических находок по ним нет", () => {
    expect(types(report.findings)).not.toContain("VAT_ARITHMETIC");
    expect(types(report.findings)).not.toContain("TOTAL_ARITHMETIC");
    expect(types(report.findings)).not.toContain("INFLATION_ARITHMETIC");
  });

  it("при неизвестном назначении 3 % — справка, а не находка", () => {
    const unknown = audit(SSR_BAD, context({ purpose: null, nmc: 1_813_280.4, ourInflation: OCT_NOV }));
    expect(one(unknown.findings, "RESERVE_PERCENT").severity).toBe("INFO");
  });
});

describe("главы 10-12 и затраты заказчика: попадают ли в НМЦК", () => {
  const exclusive = 1_813_280.4 - 50_000 * 1.03 * 1.09 * 1.2;

  it("НМЦК равна итогу без главы 10 — так и должно быть (справка)", () => {
    const finding = one(audit(SSR_BAD, context({ nmc: exclusive, ourInflation: OCT_NOV })).findings, "CUSTOMER_SCOPE");
    expect(finding.severity).toBe("INFO");
    expect(finding.impact).toBeNull();
    expect(finding.message).toContain("они не вошли");
  });

  it("НМЦК не сходится ни с тем, ни с другим — определить нельзя", () => {
    const finding = one(audit(SSR_BAD, context({ nmc: 5_000_000, ourInflation: OCT_NOV })).findings, "CUSTOMER_SCOPE");
    expect(finding.severity).toBe("INFO");
    expect(finding.message).toContain("определить нельзя");
  });

  it("НМЦК не объявлена — справка со ссылкой на 841/пр", () => {
    const finding = one(audit(SSR_BAD, context({ nmc: null, ourInflation: OCT_NOV })).findings, "CUSTOMER_SCOPE");
    expect(finding.severity).toBe("INFO");
    expect(finding.message).toContain("НМЦК не объявлена");
  });

  it("НМЦК без НДС: сравнение с итогом без НДС", () => {
    const report = audit(SSR_BAD, context({ nmc: 1_813_280.4 / 1.2, nmcIncludesVat: false, ourInflation: OCT_NOV }));
    expect(one(report.findings, "CUSTOMER_SCOPE").severity).toBe("WARNING");
  });

  it("строка «Строительный контроль» в главе 9 — тоже затраты заказчика (приложение 9, строка 2.32)", () => {
    const text = SSR_377_CSV.replace(
      "2;Расчёт;Размещение строительного мусора на полигоне ТБО;0;0;0;2330;2330",
      "2;Расчёт;Дополнительный строительный контроль заказчика;0;0;0;2330;2330",
    );
    const finding = one(audit(text, context()).findings, "CUSTOMER_SCOPE");
    expect(finding.message).toContain("«Дополнительный строительный контроль заказчика» (глава 9)");
    expect(finding.severity).toBe("WARNING");
  });

  it("ССР без глав 10-12 и строк заказчика — находки нет", () => {
    expect(types(audit(SSR_377_CSV, context()).findings)).not.toContain("CUSTOMER_SCOPE");
  });
});

describe("индекс инфляции: нет индекса, нет срока, другой срок", () => {
  const withoutInflationRow = SSR_377_CSV.split("\n").filter((line) => !line.includes("Индекс прогнозной инфляции")).join("\n");

  it("в расчёте нет индекса, а срок известен — находка с деньгами (НМЦК занижена)", () => {
    const report = audit(withoutInflationRow, context({ ourInflation: OCT_NOV, nmc: 2_000_000 }));
    const finding = one(report.findings, "INFLATION_MISSING");
    expect(finding.severity).toBe("WARNING");
    expect(finding.impact).toBeCloseTo(1_658_234.4 * 0.0047 * 1.22, 0);
    expect(finding.message).toContain("наш индекс 1,0047");
    expect(finding.ref).toContain("841/пр");
  });

  it("в расчёте нет индекса и срока нет — молчим: проверять нечем", () => {
    expect(types(audit(withoutInflationRow, context({ ourInflation: NO_PERIOD })).findings)).not.toContain("INFLATION_MISSING");
  });

  it("у заказчика период не назван, срока пользователя нет — справка «проверить нечем»", () => {
    const text = SSR_377_CSV.replace(" (октябрь-ноябрь 2026 г)", "");
    const finding = one(audit(text, context({ ourInflation: NO_PERIOD })).findings, "INFLATION_INDEX");
    expect(finding.severity).toBe("INFO");
    expect(finding.message).toContain("проверить нечем");
  });

  it("у заказчика период не назван, срок задан пользователем — проверка по срокам пользователя", () => {
    const text = SSR_377_CSV.replace(" (октябрь-ноябрь 2026 г)", "");
    const finding = one(audit(text, context({ ourInflation: OCT_NOV })).findings, "INFLATION_INDEX");
    expect(finding.message).toContain("по срокам из блока «Условия работ»");
    expect(finding.severity).toBe("INFO");
  });

  it("период заказчика — два года: сверка идёт с индексом через границу года", () => {
    const text = SSR_377_CSV.replace("(октябрь-ноябрь 2026 г) И=1,0045", "(с октября 2026 по сентябрь 2028) И=1,0045");
    const finding = one(audit(text, context()).findings, "INFLATION_INDEX");
    expect(finding.severity).toBe("WARNING");
    expect(finding.message).toContain("1,0045");
    expect(finding.message).toMatch(/наш 1,08\d\d/u);
  });

  it("сумма инфляции не равна итог × (индекс − 1) — арифметика", () => {
    const text = SSR_377_CSV.replace("7462.05", "9462.05");
    const finding = one(audit(text, context()).findings, "INFLATION_ARITHMETIC");
    expect(finding.message).toContain("не равна");
  });
});

describe("арифметика итогов", () => {
  it("итог по главам 1-9 не равен сумме глав", () => {
    const text = SSR_377_CSV.replace("Итого по главам 1-9;1623390;0;0;2330;1625720", "Итого по главам 1-9;1623390;0;0;2330;1635720");
    const finding = one(audit(text, context()).findings, "GROUP_SUM");
    expect(finding.message).toContain("Итого по главам 1-9");
    expect(finding.message).toContain("1 635 720");
  });

  it("сумма НДС не равна ставке от итога", () => {
    const text = SSR_377_CSV.replace("366453.22", "336453.22");
    const finding = one(audit(text, context()).findings, "VAT_ARITHMETIC");
    expect(finding.message).toContain("22 %");
    expect(finding.impact).toBeCloseTo(30_000, 0);
  });

  it("итог расчёта не сходится с цепочкой", () => {
    const text = SSR_377_CSV.replace("2032149.67", "2062149.67");
    const finding = one(audit(text, context({ nmc: 2_062_149.67 })).findings, "TOTAL_ARITHMETIC");
    expect(finding.message).toContain("не сходится с цепочкой");
    expect(finding.impact).toBeCloseTo(-30_000, 0);
  });

  it("резерв: сумма не равна проценту от итога глав 1-12", () => {
    const text = SSR_377_CSV.replace("32514.40", "30514.40").replace("1658234.40", "1656234.40");
    const finding = one(audit(text, context()).findings, "RESERVE_BASE");
    expect(finding.message).toContain("30 514");
  });
});

describe("единицы: тысячи рублей", () => {
  it("«тыс. руб.» в шапке — суммы в рублях, расчёт сходится", () => {
    const report = audit(SSR_THOUSANDS, context({ nmc: 14_932_800, ourInflation: NO_PERIOD }));
    expect(report.customer.unitMultiplier).toBe(1000);
    expect(report.customer.total).toBe(14_932_800);
    expect(report.warnings).toBe(0);
  });

  it("единица не названа, суммы в 1000 раз меньше НМЦК — принято «тыс. руб.» с пометкой", () => {
    const report = audit(SSR_THOUSANDS.replace("тыс. руб.", "руб."), context({ nmc: 14_932_800 }));
    expect(report.findings.find((finding) => finding.type === "UNIT_ASSUMED")?.message).toContain("в тысячах рублей");
    expect(report.customer.total).toBe(14_932_800);
    expect(report.customer.unitMultiplier).toBe(1000);
  });
});

describe("сравнение с нашим расчётом по строкам", () => {
  const ours = buildSsr({
    document: ssrEstimate({ sections: [{ title: "Фасад", workCost: 1_623_390 }] }),
    purpose: null,
    workKind: "CR_FACADE",
    period: { kind: "DATES", start: "2026-10-01", end: "2026-11-30" },
    priceDate: "2026-10-01",
    today: "2026-10-09",
  });
  const report = audit(SSR_377_CSV, context({ ourSsr: ours, ourInflation: ours.nmc.inflation }));

  it("строки: локальные сметы, временные, зимнее, непредвиденные, инфляция, НДС — у нас против заказчика, где строки известны", () => {
    expect(report.rows.map((row) => row.id)).toEqual(["LOCAL", "TEMPORARY", "WINTER", "RESERVE", "INFLATION", "VAT"]);
    const row = (id: string) => report.rows.find((item) => item.id === id)!;
    expect(row("LOCAL")).toMatchObject({ ours: 1_623_390, customer: 1_623_390, diff: 0 });
    // Строк «временные» и «зимнее» у заказчика нет: ни сравнения, ни разницы.
    expect(row("TEMPORARY").customer).toBeNull();
    expect(row("WINTER").customer).toBeNull();
    expect(row("TEMPORARY").diff).toBeNull();
    expect(row("RESERVE").customer).toBe(32_514.4);
    expect(row("RESERVE").diff).toBeCloseTo(32_467.8 - 32_514.4, 2);
    expect(row("INFLATION").customer).toBe(7_462.05);
    expect(row("VAT").customer).toBe(366_453.22);
  });

  it("без нашего расчёта строк сравнения нет, находки остаются", () => {
    const withoutOurs = audit(SSR_377_CSV, context({ ourSsr: null }));
    expect(withoutOurs.rows).toEqual([]);
    expect(withoutOurs.customer.reservePercent).toBe(2);
  });
});
