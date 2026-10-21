import { describe, expect, it } from "vitest";

import { auditBidBase, auditBidBaseTotal } from "@/domain/estimate/bidAuditBase";
import { estimateSubtitle, estimateTitle, estimateTitles, isNormsBaseName } from "@/domain/estimate/auditEstimateTitle";
import { buildAuditOverall } from "@/domain/estimate/auditOverall";
import type { AuditReport } from "@/domain/estimate/customerAudit";
import { reportLowCoverage, reportMatching, reportWithFindings } from "@/test/auditReports";

/*
  Название сметы и итог по всем сметам закупки. Названия тринадцати смет не должны совпадать, строка про базу норм
  не бывает названием, итог — сумма по сметам с покрытием, взвешенным по прямым затратам.
*/

const named = (patch: Partial<AuditReport>): AuditReport => ({ ...reportMatching(), ...patch });

describe("название сметы", () => {
  const base = { documentName: "Смета 02-01.xlsx", estimateName: "Смета по ФСНБ 421+557прРИМ", estimateNumber: null, title: null };

  it("номер и наименование работ: «ЛСР 02-01-01 · Ремонт кровли»", () => {
    expect(estimateTitle({ ...base, estimateNumber: "02-01-01", title: "Ремонт кровли" })).toBe("ЛСР 02-01-01 · Ремонт кровли");
  });

  it("только номер или только наименование", () => {
    expect(estimateTitle({ ...base, estimateNumber: "02-01-01" })).toBe("ЛСР 02-01-01");
    expect(estimateTitle({ ...base, title: "Ремонт кровли" })).toBe("Ремонт кровли");
  });

  it("лист, названный по базе норм, названием не бывает: берётся имя файла", () => {
    expect(estimateTitle(base)).toBe("Смета 02-01.xlsx");
    expect(estimateTitle({ ...base, documentName: "папка/Кровля.xlsx" })).toBe("Кровля.xlsx");
  });

  it("обычное имя листа годится как запасное", () => {
    expect(estimateTitle({ ...base, estimateName: "Электроснабжение" })).toBe("Электроснабжение");
  });

  it("база норм уходит в подзаголовок вместе с файлом", () => {
    expect(estimateSubtitle({ ...base, estimateNumber: "02-01-01", title: "Ремонт кровли" })).toBe("Смета 02-01.xlsx · Смета по ФСНБ 421+557прРИМ");
    expect(estimateSubtitle({ ...base, estimateName: "Электроснабжение", estimateNumber: "1" })).toBe("Смета 02-01.xlsx");
  });

  it("узнаёт строки про базу норм и метод", () => {
    for (const name of ["Смета по ФСНБ 421+557прРИМ", "ЛСР по Методике 2020", "Ресурсно-индексный метод", "ТСН-2001"]) expect(isNormsBaseName(name)).toBe(true);
    for (const name of ["Ремонт кровли", "Электроснабжение", null]) expect(isNormsBaseName(name)).toBe(false);
  });

  it("одинаковые названия различаются именем файла или номером по порядку", () => {
    const a = { ...base, estimateNumber: "1", title: "Кровля", documentName: "a.xlsx" };
    const b = { ...base, estimateNumber: "1", title: "Кровля", documentName: "b.xlsx" };
    expect(estimateTitles([a, b])).toEqual(["ЛСР 1 · Кровля (a.xlsx)", "ЛСР 1 · Кровля (b.xlsx)"]);
    const c = { ...base, documentName: "x.xlsx" };
    expect(estimateTitles([c, c])).toEqual(["x.xlsx (1)", "x.xlsx (2)"]);
    expect(estimateTitles([a])).toEqual(["ЛСР 1 · Кровля"]);
  });

  it("из реального отчёта: номер сметы, а не строка про методику", () => {
    expect(estimateTitle(reportWithFindings())).toBe("ЛСР 701-702");
  });
});

describe("итог по всем сметам", () => {
  const over = named({ estimateNumber: "2", customerTotal: 1000, repricedTotal: 1200, diff: 200, diffPercent: 20, coverage: 1, checkedDirect: 800, totalDirect: 800 });
  const ok = named({ estimateNumber: "3", customerTotal: 3000, repricedTotal: 3030, diff: 30, diffPercent: 1, coverage: 1, checkedDirect: 2000, totalDirect: 2000 });
  const low = named({ estimateNumber: "4", customerTotal: 1000, repricedTotal: 1000, diff: 0, diffPercent: 0, coverage: 0.2, checkedDirect: 100, totalDirect: 500 });
  const overall = buildAuditOverall([over, ok, low]);

  it("суммы, разница и процент; заголовок с числом смет", () => {
    expect(overall.count).toBe(3);
    expect(overall.customerTotal).toBe(5000);
    expect(overall.repricedTotal).toBe(5230);
    expect(overall.diff).toBe(230);
    expect(overall.diffPercent).toBeCloseTo(4.6, 1);
    expect(overall.verdict).toBe("WITHIN");
    expect(overall.headline).toContain("Итого по всем сметам (3)");
  });

  it("покрытие взвешено по прямым затратам, а не среднее арифметическое", () => {
    // (800 + 2000 + 100) / (800 + 2000 + 500) = 87,9 %; среднее арифметическое было бы 73 %
    expect(overall.coverage).toBeCloseTo(2900 / 3300, 6);
    expect(overall.coverageText).toBe("проверено 88 % прямых затрат");
    expect(overall.coverageLow).toBe(false);
  });

  it("требуют внимания только сметы с разницей больше 5 % или покрытием ниже 70 %", () => {
    expect(overall.rows.map((row) => row.attention)).toEqual([true, false, true]);
    expect(overall.attention.map((row) => row.index)).toEqual([0, 2]);
    expect(overall.rows[0]!.verdictText).toBe("занижена");
    expect(overall.rows[1]!.verdictText).toBe("в пределах ±5 %");
    expect(overall.rows[2]!.verdictText).toContain("проверена частично");
  });

  it("порог 5 % включительно ещё не внимание", () => {
    const edge = named({ customerTotal: 1000, repricedTotal: 1050, diff: 50, diffPercent: 5, coverage: 1 });
    expect(buildAuditOverall([edge, edge]).attention).toEqual([]);
  });

  it("заниженный итог — вывод «занижено»; завышенный — «завышено»", () => {
    const under = buildAuditOverall([named({ customerTotal: 1000, repricedTotal: 1500, diff: 500, diffPercent: 50 }), over]);
    expect(under.verdict).toBe("UNDERSTATED");
    expect(under.headline).toContain("занижено на");
    const dear = buildAuditOverall([named({ customerTotal: 1000, repricedTotal: 500, diff: -500, diffPercent: -50 }), named({ customerTotal: 1000, repricedTotal: 900, diff: -100, diffPercent: -10 })]);
    expect(dear.headline).toContain("завышено на");
  });

  it("сметы с НДС и без — суммы приводятся к НДС, и это сказано", () => {
    const withVat = named({ customerTotal: 1220, repricedTotal: 1220, diff: 0, diffPercent: 0 });
    const noVat = named({ customerTotal: 1000, repricedTotal: 1000, diff: 0, diffPercent: 0, vat: { ...withVat.vat, included: false } });
    const mixed = buildAuditOverall([withVat, noVat]);
    expect(mixed.vatNormalized).toBe(true);
    expect(mixed.customerTotal).toBeCloseTo(1220 + 1220, 2);
    expect(buildAuditOverall([withVat, withVat]).vatNormalized).toBe(false);
  });

  it("непереоценённые позиции суммируются по сметам", () => {
    expect(buildAuditOverall([reportLowCoverage(), reportLowCoverage()]).unrepricedPositions).toBe(6);
  });
});

describe("основа «Экономики участия» по всем сметам", () => {
  it("группы затрат и НМЦК складываются; непереоценённая доля — взвешенная", () => {
    const a = reportWithFindings();
    const b = reportMatching();
    const total = auditBidBaseTotal([a, b])!;
    const baseA = auditBidBase(a);
    const baseB = auditBidBase(b);
    expect(total.nmc).toBeCloseTo(a.customerTotal + b.customerTotal, 2);
    expect(total.costBase.labour).toBeCloseTo(baseA.costBase.labour + baseB.costBase.labour, 2);
    expect(total.costBase.beforeVat).toBeCloseTo(baseA.costBase.beforeVat + baseB.costBase.beforeVat, 2);
    expect(total.costBase.origin).toBe("AUDIT");
    expect(total.nmcIncludesVat).toBe(true);
    expect(total.billItems).toBe(a.positions.length + b.positions.length);
  });

  it("ни у одной сметы нет разбивки — основа одной суммой; пусто — null", () => {
    const lump = { ...reportMatching(), ourCosts: undefined };
    expect(auditBidBaseTotal([lump, lump])!.costBase.origin).toBe("AUDIT_LUMP");
    expect(auditBidBaseTotal([])).toBeNull();
  });
});
