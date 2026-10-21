import { describe, expect, it } from "vitest";

import { auditBidBase, auditBidInput } from "@/domain/estimate/bidAuditBase";
import { computeBidEconomics } from "@/domain/estimate/bidEconomics";
import {
  buildAuditConclusion,
  isNontrivialDiff,
  NO_ESTIMATE_ADVICE,
  positionReason,
  TOP_POSITIONS,
  TOP_REASONS,
} from "@/domain/estimate/auditConclusion";
import { auditCustomerBim } from "@/domain/estimate/customerBimAudit";
import type { AuditPosition, AuditReport } from "@/domain/estimate/customerAudit";
import { auditReasons, uncheckedSummary } from "@/domain/estimate/customerAuditText";
import { reportLowCoverage, reportMatching, reportWithFindings } from "@/test/auditReports";
import { BELGOROD, CONTEXT, estimate, position } from "@/test/bimAuditFixtures";

/*
  Заключение по смете заказчика строится из настоящих отчётов `auditCustomerLsr` / `auditCustomerBim`; для порогов вывода
  (±5 %) у отчёта подменяются итоги: так порог проверяется точно, а не подбором цен.
*/

function withTotals(report: AuditReport, customerTotal: number, repricedTotal: number, coverage = 1): AuditReport {
  const diff = repricedTotal - customerTotal;
  return { ...report, customerTotal, repricedTotal, diff, diffPercent: (diff * 100) / customerTotal, coverage };
}

const base = reportWithFindings();

describe("вывод: занижена / завышена / в пределах ±5 %", () => {
  it("пересчёт дороже заказчика больше чем на 5 % — смета занижена, денег может не хватить", () => {
    const conclusion = buildAuditConclusion({ report: withTotals(base, 1_000_000, 1_120_000) });
    expect(conclusion.verdict).toBe("UNDERSTATED");
    expect(conclusion.headline).toMatch(/^Смета заказчика занижена на 120\s000\s₽ \(12,0\s%\) — денег на работы может не хватить$/);
  });

  it("пересчёт дешевле больше чем на 5 % — смета завышена, в цене есть запас", () => {
    const conclusion = buildAuditConclusion({ report: withTotals(base, 1_000_000, 900_000) });
    expect(conclusion.verdict).toBe("OVERSTATED");
    expect(conclusion.headline).toContain("завышена на 100 000");
    expect(conclusion.headline).toContain("запас на снижение");
  });

  it("ровно ±5 % — ещё в пределах; 5,1 % — уже вывод", () => {
    expect(buildAuditConclusion({ report: withTotals(base, 1_000_000, 1_050_000) }).verdict).toBe("WITHIN");
    expect(buildAuditConclusion({ report: withTotals(base, 1_000_000, 950_000) }).verdict).toBe("WITHIN");
    expect(buildAuditConclusion({ report: withTotals(base, 1_000_000, 1_051_000) }).verdict).toBe("UNDERSTATED");
    expect(buildAuditConclusion({ report: withTotals(base, 1_000_000, 949_000) }).verdict).toBe("OVERSTATED");
    expect(buildAuditConclusion({ report: withTotals(base, 1_000_000, 1_020_000) }).headline).toContain("в пределах ±5 %");
  });

  it("в пределах, но почти ничего не переоценено — «расхождений нет» не утверждается", () => {
    const conclusion = buildAuditConclusion({ report: reportLowCoverage() });
    expect(conclusion.verdict).toBe("WITHIN");
    expect(conclusion.coverageLow).toBe(true);
    expect(conclusion.headline).toContain("об остальном судить нельзя");
    expect(conclusion.headline).not.toContain("существенных расхождений нет");
  });

  it("нулевой итог заказчика не ломает расчёт процента", () => {
    const report: AuditReport = { ...base, customerTotal: 0, diffPercent: null, diff: 500, repricedTotal: 500 };
    const conclusion = buildAuditConclusion({ report });
    expect(conclusion.verdict).toBe("UNDERSTATED");
    expect(conclusion.headline).toContain("занижена на 500");
  });
});

describe("причины разницы и позиции", () => {
  const conclusion = buildAuditConclusion({ report: base });

  it("причины — по убыванию модуля суммы, не больше пяти, с суммой у каждой", () => {
    expect(conclusion.reasons.length).toBeGreaterThan(0);
    expect(conclusion.reasons.length).toBeLessThanOrEqual(TOP_REASONS);
    const amounts = conclusion.reasons.map((line) => Math.abs(line.amount ?? 0));
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(conclusion.reasons.every((line) => line.amount !== null)).toBe(true);
  });

  it("тексты причин те же, что в «откуда разница» карточки: экран и Word говорят одно", () => {
    const breakdownTexts = new Set(conclusion.breakdown.map((line) => line.text));
    for (const reason of conclusion.reasons) expect(breakdownTexts.has(reason.text)).toBe(true);
  });

  it("позиции — по убыванию модуля разницы, с объёмом, единицей и причиной", () => {
    expect(conclusion.topPositions.length).toBeGreaterThan(0);
    expect(conclusion.topPositions.length).toBeLessThanOrEqual(TOP_POSITIONS);
    const diffs = conclusion.topPositions.map((item) => Math.abs(item.diff));
    expect([...diffs].sort((a, b) => b - a)).toEqual(diffs);
    const first = conclusion.topPositions[0]!;
    expect(first.quantity).toBeGreaterThan(0);
    expect(first.unit).not.toBe("");
    expect(first.reason).toMatch(/цены труда/);
  });

  it("позиций больше двадцати — берутся двадцать самых тяжёлых", () => {
    const many: AuditPosition[] = Array.from({ length: 30 }, (_, index) => ({
      number: index + 1,
      code: `К${String(index)}`,
      name: "Работа",
      section: null,
      customerTotal: 1000,
      ourTotal: 1000 + (index + 1) * 10,
      diff: (index + 1) * 10,
      flags: ["RESOURCE_PRICE"],
      checkedShare: 1,
    }));
    const result = buildAuditConclusion({ report: { ...base, positions: many } });
    expect(result.topPositions).toHaveLength(TOP_POSITIONS);
    expect(result.topPositions[0]!.diff).toBe(300);
  });

  it("копеечные и нулевые разницы в позиции не попадают: нужно не меньше рубля и 0,5 % стоимости позиции", () => {
    expect(isNontrivialDiff({ diff: 0, customerTotal: 1000 })).toBe(false);
    expect(isNontrivialDiff({ diff: 0.9, customerTotal: 10 })).toBe(false);
    expect(isNontrivialDiff({ diff: 4, customerTotal: 1000 })).toBe(false);
    expect(isNontrivialDiff({ diff: 5, customerTotal: 1000 })).toBe(true);
    expect(isNontrivialDiff({ diff: -5, customerTotal: 1000 })).toBe(true);
    expect(isNontrivialDiff({ diff: 2, customerTotal: 0 })).toBe(true);
  });

  it("причина позиции: по находкам с суммой; без находок — по флагам; без того и другого — пусто", () => {
    const position1 = base.positions[0]!;
    expect(positionReason(base, position1)).toMatch(/цены труда/);
    const flagged: AuditPosition = { ...position1, number: 999, flags: ["ARITHMETIC", "OVERHEAD_RATE"] };
    expect(positionReason(base, flagged)).toBe("арифметика, норматив НР");
    expect(positionReason(base, { ...flagged, flags: [] })).toBe("");
  });
});

describe("не переоценено и оговорки", () => {
  it("всё переоценено — нулевая сводка", () => {
    const summary = uncheckedSummary(reportMatching());
    expect(summary.positions).toBe(0);
    expect(summary.byReason).toEqual([]);
  });

  it("нашей цены нет: позиции, рубли, доля и причина словами", () => {
    const report = reportLowCoverage();
    const conclusion = buildAuditConclusion({ report });
    expect(conclusion.unrepriced.positions).toBeGreaterThan(0);
    expect(conclusion.unrepriced.amount).toBeGreaterThan(0);
    expect(conclusion.unrepriced.share).toBeGreaterThan(0.3);
    expect(conclusion.unrepriced.byReason[0]!.label).toBe("нашей цены нет");
  });

  it("всегда есть оговорка «без ИИ»; малое покрытие добавляет оговорку про неполный вывод", () => {
    const full = buildAuditConclusion({ report: reportMatching() });
    expect(full.caveats[0]).toContain("без участия ИИ");
    expect(full.caveats.some((line) => line.includes("вывод неполный"))).toBe(false);
    const low = buildAuditConclusion({ report: reportLowCoverage() });
    expect(low.caveats.some((line) => line.includes("вывод неполный"))).toBe(true);
  });

  it("несверенные сметы (ТСН, не форма 421/пр) названы в оговорках с причиной", () => {
    const conclusion = buildAuditConclusion({
      report: base,
      notRecognized: [{ documentName: "ТСН.xlsx", estimateName: null, reason: "смета по ТСН-2001 (Москва): норм этой базы у нас нет" }],
    });
    expect(conclusion.caveats.some((line) => line.includes("ТСН.xlsx") && line.includes("ТСН-2001"))).toBe(true);
  });

  it("зона и квартал названы в подписи цен", () => {
    const conclusion = buildAuditConclusion({ report: base });
    expect(conclusion.pricesLabel).toBe("Республика Бурятия, 1 зона, 2 кв. 2026");
    expect(conclusion.figures).toContain(conclusion.pricesLabel);
  });

  it("советы на случай «смета не распознана» называют выгрузку из Гранд-Сметы и Smeta.RU в Excel и риск сканов", () => {
    const text = NO_ESTIMATE_ADVICE.join(" ");
    expect(text).toContain("Гранд-Смета");
    expect(text).toContain("Smeta.RU");
    expect(text).toContain("Excel");
    expect(text).toMatch(/скан/);
  });
});

describe("смета БИМ", () => {
  const bim = auditCustomerBim(estimate({ positions: [position({ index: { ...BELGOROD, labour: 45 } })] }), CONTEXT);

  it("причины — по источникам (индексы, базисные цены, нормативы), а не по двум нарезкам сразу", () => {
    const reasons = auditReasons(bim);
    expect(reasons[0]!.group).toBe("SOURCE_INDEX");
    expect(reasons.some((line) => ["LABOUR", "MACHINES", "MATERIALS"].includes(line.group))).toBe(false);
    const sum = reasons.reduce((total, line) => total + (line.amount ?? 0), 0);
    expect(sum).toBeCloseTo(bim.diff, 1);
  });

  it("оговорка называет метод, ФЕР-2020 и письмо Минстроя; метод в заключении — базисно-индексный", () => {
    const conclusion = buildAuditConclusion({ report: bim });
    expect(conclusion.method).toBe("BASE_INDEX");
    const text = conclusion.caveats.join(" ");
    expect(text).toContain("базисно-индексным методом");
    expect(text).toContain("ФЕР-2020");
    expect(text).toContain("письмом Минстроя");
    expect(text).toContain("ТЕР региона");
  });

  it("основа для «Экономики участия» — одной суммой, без групп затрат", () => {
    const baseOfBim = auditBidBase(bim);
    expect(baseOfBim.costBase.origin).toBe("AUDIT_LUMP");
    expect(baseOfBim.costBase.other).toBeCloseTo(bim.repricedTotal, 2);
  });
});

describe("основа «Экономики участия» из проверки сметы", () => {
  it("группы ourCosts складываются в пересчитанный итог без НДС", () => {
    const report = base;
    const costs = report.ourCosts!;
    const sum = costs.labour + costs.machines + costs.materials + costs.other + costs.overhead + costs.profit;
    const beforeVat = report.vat.included ? report.repricedTotal / (1 + report.vat.ourPercent / 100) : report.repricedTotal;
    expect(sum).toBeCloseTo(beforeVat, 1);
    expect(auditBidBase(report).costBase.origin).toBe("AUDIT");
  });

  it("НМЦК — итог сметы заказчика, с НДС по признаку сметы; непереоценённая доля — из покрытия", () => {
    const b = auditBidBase(reportLowCoverage());
    expect(b.nmc).toBe(reportLowCoverage().customerTotal);
    expect(b.nmcIncludesVat).toBe(true);
    expect(b.unverifiedPercent).toBeGreaterThan(90);
  });

  it("экономика по проверке считается: цена участия, себестоимость без сметной прибыли, пометка об основе", () => {
    const economics = computeBidEconomics(auditBidInput(base, { taxSystem: "OSNO", minMarginPercent: 10 }));
    expect(economics.status).toBe("COMPUTED");
    expect(economics.baseOrigin).toBe("AUDIT");
    const costs = base.ourCosts!;
    expect(economics.basis.cost).toBeCloseTo(costs.labour + costs.machines + costs.materials + costs.other + costs.overhead, 1);
    expect(economics.basis.estimatedProfit).toBeCloseTo(costs.profit, 1);
    expect(economics.nmc).toBe(base.customerTotal);
    expect(economics.assumptions.nmcIncludesVat).toBe(true);
    expect(economics.breakEvenPrice).not.toBeNull();
  });

  it("свою НМЦК (цена закупки) можно подставить вместо итога сметы", () => {
    const economics = computeBidEconomics(auditBidInput(base, { taxSystem: "OSNO", minMarginPercent: 10 }, { nmc: 50_000, law: "FZ_44" }));
    expect(economics.nmc).toBe(50_000);
    expect(economics.law).toBe("FZ_44");
  });
});
