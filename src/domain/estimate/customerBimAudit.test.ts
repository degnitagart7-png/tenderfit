import { describe, expect, it } from "vitest";

import { auditCustomerBim, normativeRef } from "@/domain/estimate/customerBimAudit";
import type { AuditFinding, AuditReport, ImpactGroup } from "@/domain/estimate/customerAudit";
import type { BimPosition } from "@/domain/estimate/customerBim";
import { auditBreakdown, auditHeadline, bimDetailLines, notRecognizedLine } from "@/domain/estimate/customerAuditText";
import { BELGOROD, CONTEXT, charge, amounts, estimate, position } from "@/test/bimAuditFixtures";

/*
  Аудит сметы БИМ на синтетической смете одной позиции, цифры которой считаются в уме:
  расценка ФЕР 01-01-001-01 (100 м3), объём 2; ОЗП 1000, ЭМ 500 (в т. ч. ЗПМ 100), М 300 за единицу.
  В базисных ценах: ОЗП 2000, ЭМ 1000, ЗПМ 200, М 600; ФОТ = ОЗП + ЗПМ = 2200; НР 100 % = 2200, СП 50 % = 1100.
  Письмо Минстроя на III кв. 2026 для Белгородской области, «Многоквартирные жилые дома: Кирпичные», ФЕР: ОТ 47,58, ЭМ 15,15, М 9,58.
*/

const find = (report: AuditReport, type: AuditFinding["type"]): AuditFinding[] => report.findings.filter((finding) => finding.type === type);
const groupsSum = (report: AuditReport): number =>
  (Object.keys(report.impacts) as ImpactGroup[]).reduce((sum, group) => sum + report.impacts[group].amount, 0);

describe("аудит БИМ: индексы заказчика против письма Минстроя", () => {
  it("индексы совпали с письмом: находок по индексам нет, разницы нет", () => {
    const report = auditCustomerBim(estimate({ positions: [position({ index: BELGOROD })] }), CONTEXT);
    expect(report.method).toBe("BASE_INDEX");
    expect(find(report, "INDEX_VALUE")).toEqual([]);
    expect(report.bim?.indexStatus).toBe("CHECKED");
    expect(report.bim?.subject).toBe("Белгородская область");
    expect(report.bim?.object).toBe("Многоквартирные жилые дома: Кирпичные");
    expect(report.bim?.letterIndices).toMatchObject({ labour: 47.58, machines: 15.15, materials: 9.58, letterNumber: "46728-ИФ/09" });
    expect(report.diff).toBeCloseTo(0, 2);
    expect(find(report, "INDEX_NOT_CHECKED")[0]?.message).toMatch(/совпали/);
  });

  it("ОЗП занижен (45,0 вместо 47,58): текст находки по заданию и сумма с НР и СП на труд", () => {
    const report = auditCustomerBim(estimate({ positions: [position({ index: { ...BELGOROD, labour: 45 } })] }), CONTEXT);
    const [finding] = find(report, "INDEX_VALUE") as [AuditFinding];
    // (47,58 − 45,0) × (ОЗП 2000 + НР 2200 + СП 1100) = 2,58 × 5300
    expect(finding.impact).toBeCloseTo(13674, 2);
    expect(finding.message).toContain("Заказчик применил индекс к ОЗП 45,00");
    expect(finding.message).toContain("по письму письмо Минстроя России от 30.07.2026 № 46728-ИФ/09");
    expect(finding.message).toContain("для Белгородская область, Многоквартирные жилые дома: Кирпичные — 47,58");
    expect(finding.message).toMatch(/занижено на 13[\s ]674 ₽/u);
    expect(report.diff).toBeCloseTo(13674, 2);
    expect(report.bim?.indexDeviations).toEqual([{ element: "LABOUR", customer: 45, letter: 47.58, impact: expect.closeTo(13674, 2) as number }]);
    expect(report.bim?.impactBySource.indices).toBeCloseTo(13674, 2);
    // Только индекс: цены, нормативы и арифметика в порядке.
    expect(report.bim?.impactBySource.basePrices).toBeCloseTo(0, 6);
    expect(report.bim?.impactBySource.norms).toBeCloseTo(0, 6);
    expect(report.bim?.impactBySource.arithmetic).toBeCloseTo(0, 6);
  });

  it("индекс завышен: «завышено», разница отрицательная, сумма групп равна разнице", () => {
    const report = auditCustomerBim(estimate({ positions: [position({ index: { ...BELGOROD, materials: 12 } })] }), CONTEXT);
    const [finding] = find(report, "INDEX_VALUE") as [AuditFinding];
    // (9,58 − 12) × 600 материалов
    expect(finding.impact).toBeCloseTo(-1452, 2);
    expect(finding.message).toMatch(/индекс к материалам 12,00.*9,58: завышено на 1[\s ]452 ₽/u);
    expect(report.diff).toBeCloseTo(-1452, 2);
    expect(report.impacts.MATERIALS.amount).toBeCloseTo(-1452, 2);
    expect(report.repricedTotal).toBeCloseTo(report.customerTotal - 1452, 2);
  });

  it("несколько элементов сразу: сумма групп влияния равна разнице итога", () => {
    const report = auditCustomerBim(estimate({ positions: [position({ index: { labour: 45, machines: 14, materials: 12 } })] }), CONTEXT);
    expect(find(report, "INDEX_VALUE")).toHaveLength(3);
    expect(groupsSum(report)).toBeCloseTo(report.diff, 4);
    expect(report.impacts.LABOUR.amount).toBeCloseTo(13674, 2);
    expect(report.impacts.MACHINES.amount).toBeCloseTo((15.15 - 14) * 1000, 2);
    expect(report.impacts.MATERIALS.amount).toBeCloseTo((9.58 - 12) * 600, 2);
  });

  it("ТЕР: индексы берутся из нижней строки письма (ТЕР-2001: ОТ 50,75), а не из верхней", () => {
    const terEstimate = estimate({ positions: [position({ index: { labour: 47.58, machines: 14.22, materials: 12.09 }, code: "ТЕР01-01-001-01" })] });
    const report = auditCustomerBim(terEstimate, CONTEXT);
    expect(report.bim?.base).toBe("TER");
    expect(report.bim?.letterIndices).toMatchObject({ labour: 50.75, machines: 14.22, materials: 12.09 });
    const [finding] = find(report, "INDEX_VALUE") as [AuditFinding];
    expect(finding.message).toContain("47,58");
    expect(finding.message).toContain("50,75");
  });
});

describe("аудит БИМ: объект строительства и квартал", () => {
  it("жилой дом без материала стен: объект не назначается, вывод по индексам не делается, названы кандидаты", () => {
    const report = auditCustomerBim(
      estimate({ positions: [position({ index: { ...BELGOROD, labour: 45 } })], constructionName: "Строительство многоквартирного жилого дома по ул. Садовой" }),
      CONTEXT,
    );
    expect(find(report, "INDEX_VALUE")).toEqual([]);
    expect(report.bim?.indexStatus).toBe("NOT_CHECKED");
    expect(report.bim?.object).toBeNull();
    expect(report.bim?.objectCandidates).toContain("Многоквартирные жилые дома: Кирпичные");
    expect(report.bim?.objectCandidates.length).toBeGreaterThan(1);
    const [note] = find(report, "INDEX_NOT_CHECKED") as [AuditFinding];
    expect(note.message).toMatch(/не сверены с письмом Минстроя/);
    expect(note.message).toMatch(/без материала стен/);
    expect(report.diff).toBeCloseTo(0, 2);
  });

  it("две несовместимых стройки в одном наименовании — тоже справка", () => {
    const report = auditCustomerBim(
      estimate({ positions: [position({ index: BELGOROD })], constructionName: "Строительство школы и котельной", workName: null }),
      CONTEXT,
    );
    expect(report.bim?.object).toBeNull();
    expect(report.bim?.objectReason).toMatch(/несколько объектов/);
  });

  it("смета в ценах III кв. 2026 с индексами из письма II кв. — находка о квартале индексов", () => {
    const report = auditCustomerBim(
      estimate({
        positions: [position({ index: BELGOROD })],
        indexStatements: [
          { kind: "LETTER", text: "письмо Минстроя России от 20.05.2026 № 30000-ИФ/09", letterNumber: "30000-ИФ/09", letterDate: "2026-05-20" },
        ],
      }),
      CONTEXT,
    );
    const [finding] = find(report, "INDEX_QUARTER") as [AuditFinding];
    expect(finding.severity).toBe("WARNING");
    expect(finding.message).toContain("III кв. 2026");
    expect(finding.message).toContain("30000-ИФ/09");
    expect(finding.message).toContain("II кв. 2026");
    expect(finding.message).toMatch(/1 квартал назад/);
  });

  it("смета ссылается и на письмо своего квартала, и на более раннее (например, по проектным работам) — это не «индексы прошлого квартала»", () => {
    const report = auditCustomerBim(
      estimate({
        positions: [position({ index: BELGOROD })],
        indexStatements: [
          { kind: "LETTER", text: "письмо", letterNumber: "8980-ИФ/09", letterDate: "2026-02-19" },
          { kind: "LETTER", text: "письмо", letterNumber: "46728-ИФ/09", letterDate: "2026-07-30" },
        ],
      }),
      CONTEXT,
    );
    expect(find(report, "INDEX_QUARTER")).toEqual([]);
  });

  it("несколько писем прошлых кварталов — в находке названо самое позднее", () => {
    const report = auditCustomerBim(
      estimate({
        positions: [position({ index: BELGOROD })],
        indexStatements: [
          { kind: "LETTER", text: "письмо", letterNumber: "8980-ИФ/09", letterDate: "2026-02-19" },
          { kind: "LETTER", text: "письмо", letterNumber: "30000-ИФ/09", letterDate: "2026-05-20" },
        ],
      }),
      CONTEXT,
    );
    expect(find(report, "INDEX_QUARTER")[0]?.message).toContain("30000-ИФ/09");
  });

  it("квартал письма совпадает с кварталом сметы — находки о квартале нет", () => {
    const report = auditCustomerBim(
      estimate({
        positions: [position({ index: BELGOROD })],
        indexStatements: [{ kind: "LETTER", text: "письмо", letterNumber: "46728-ИФ/09", letterDate: "2026-07-30" }],
      }),
      CONTEXT,
    );
    expect(find(report, "INDEX_QUARTER")).toEqual([]);
  });

  it("цены II кв. 2026: письма за этот квартал у нас нет — справка без вывода и пометка об устаревшем уровне цен", () => {
    const report = auditCustomerBim(estimate({ positions: [position({ index: { ...BELGOROD, labour: 40 } })], quarter: { quarter: 2, year: 2026 } }), CONTEXT);
    expect(find(report, "INDEX_VALUE")).toEqual([]);
    expect(report.bim?.indexStatus).toBe("NOT_CHECKED");
    expect(report.bim?.indexNote).toMatch(/писем Минстроя за II кв\. 2026 в справочнике нет \(есть: III кв\. 2026\)/);
    const [outdated] = find(report, "OUTDATED_PRICE_LEVEL") as [AuditFinding];
    expect(outdated.message).toMatch(/II кв\. 2026.*III кв\. 2026.*устарела на квартал/);
  });

  it("субъект берётся из зоны закупки, когда смета его не называет", () => {
    const report = auditCustomerBim(estimate({ positions: [position({ index: { ...BELGOROD, labour: 45 } })], subjectText: null }), { ...CONTEXT, subject: "Белгородская область" });
    expect(report.bim?.subjectSource).toBe("ZONE");
    expect(find(report, "INDEX_VALUE")).toHaveLength(1);
  });

  it("субъект неизвестен вовсе — индексы не сверяются и это сказано", () => {
    const report = auditCustomerBim(estimate({ positions: [position({ index: BELGOROD })], subjectText: null }), CONTEXT);
    expect(report.bim?.indexStatus).toBe("NOT_CHECKED");
    expect(report.bim?.indexNote).toMatch(/субъект РФ в смете не назван/);
  });
});

describe("аудит БИМ: базисные цены расценок", () => {
  it("цена ФЕР совпала с ФЕР-2020: одна справка «совпало», расхождений нет", () => {
    const report = auditCustomerBim(estimate({ positions: [position({ index: BELGOROD })] }), CONTEXT);
    expect(report.bim?.baseChecks).toMatchObject({ compared: 1, matched: 1, mismatched: 0 });
    const [finding] = find(report, "FER_PRICE") as [AuditFinding];
    expect(finding.severity).toBe("INFO");
    expect(finding.message).toMatch(/расценка ФЕР01-01-001-01: у заказчика 1800,00 ₽, в ФЕР-2020 1800,00 ₽ — совпало/);
    expect(report.bim?.rows[0]).toMatchObject({ code: "ФЕР01-01-001-01", status: "MATCH", customerPrice: 1800, ferPrice: 1800 });
  });

  it("цена ФЕР не совпала (ОЗП 1100 вместо 1000): находка, разница уходит в базисные цены, сумма групп равна разнице", () => {
    // Заказчик взял ОЗП 1100, объём и итоги посчитаны от неё: 2200 × 47,58 + начисления от ФОТ 2400.
    const wrong: BimPosition = {
      ...position({ index: BELGOROD, baseWage: 2200, unitWage: 1100 }),
      overhead: charge("Пр/812-001.1", 100, 2400),
      profit: charge("Пр/774-001.1", 50, 1200),
      positionCurrentTotal: (2200 + 2400 + 1200) * 47.58 + 1000 * 15.15 + 600 * 9.58,
      currentTotal: amounts({ wage: 2200 * 47.58, machines: 1000 * 15.15, materials: 600 * 9.58 }),
    };
    const report = auditCustomerBim(estimate({ positions: [wrong] }), CONTEXT);
    const [finding] = find(report, "FER_PRICE").filter((item) => item.severity === "WARNING") as [AuditFinding];
    expect(finding.message).toMatch(/ОЗП 1100,00 ₽, в ФЕР-2020 1000,00 ₽/);
    expect(report.bim?.baseChecks).toMatchObject({ matched: 0, mismatched: 1 });
    // ФОТ меньше на 200 ₽: (ОЗП 200 + НР 200 + СП 100) × 47,58 с другим знаком
    expect(report.diff).toBeCloseTo(-500 * 47.58, 2);
    expect(report.bim?.impactBySource.basePrices).toBeCloseTo(-500 * 47.58, 2);
    expect(groupsSum(report)).toBeCloseTo(report.diff, 4);
  });

  it("ТЕР региона: справка «базисные цены не проверены, нет открытой базы», итог не меняется", () => {
    const report = auditCustomerBim(estimate({ positions: [position({ index: { labour: 50.75, machines: 14.22, materials: 12.09 }, code: "ТЕР01-01-001-01" })] }), CONTEXT);
    expect(report.bim?.baseChecks).toMatchObject({ compared: 0, terNotChecked: 1 });
    const [note] = find(report, "BASE_NOT_CHECKED") as [AuditFinding];
    expect(note.message).toMatch(/^ТЕР Белгородская область — базисные цены не проверены, нет открытой базы/);
    expect(report.unchecked[0]).toMatchObject({ kind: "TER_NO_BASE", code: "ТЕР01-01-001-01" });
    expect(report.diff).toBeCloseTo(0, 2);
    expect(report.coverage).toBe(0);
  });

  it("корпоративная расценка и шифр, которого нет в ФЕР-2020: не сверяются и названы отдельно", () => {
    const corporate: BimPosition = { ...position({ index: BELGOROD }), number: "2", code: "КОЕР08-01-001-08", family: "OTHER", book: null, rateCode: null };
    const missing: BimPosition = { ...position({ index: BELGOROD }), number: "3", code: "ФЕР99-99-999-99", rateCode: "99-99-999-99" };
    const report = auditCustomerBim(estimate({ positions: [position({ index: BELGOROD }), corporate, missing] }), CONTEXT);
    expect(report.bim?.baseChecks).toMatchObject({ compared: 1, otherNotChecked: 1, notFound: 1 });
    expect(report.unchecked.map((item) => item.kind).sort()).toEqual(["OTHER_BASE", "RATE_NOT_FOUND"]);
    expect(find(report, "BASE_NOT_CHECKED")).toHaveLength(2);
  });
});

describe("аудит БИМ: арифметика и нормативы НР и СП", () => {
  it("арифметика: сумма «Всего по позиции» не сходится с составляющими — находка и разница", () => {
    const wrong: BimPosition = { ...position({ index: BELGOROD }), positionCurrentTotal: position({ index: BELGOROD }).positionCurrentTotal! + 10_000 };
    const report = auditCustomerBim(estimate({ positions: [wrong] }), CONTEXT);
    const arithmetic = find(report, "ARITHMETIC");
    expect(arithmetic.length).toBeGreaterThan(0);
    expect(arithmetic[0]?.message).toMatch(/сумма составляющих .* не равна «Всего по позиции»/);
    expect(report.impacts.ARITHMETIC.count).toBeGreaterThan(0);
    expect(report.diff).toBeCloseTo(-10_000, 2);
    expect(report.bim?.impactBySource.arithmetic).toBeCloseTo(-10_000, 2);
    expect(groupsSum(report)).toBeCloseTo(report.diff, 4);
  });

  it("арифметика: итого в текущих не равно итого в базисных × индекс", () => {
    const base = position({ index: BELGOROD });
    const wrong: BimPosition = { ...base, currentTotal: { ...base.currentTotal!, wage: base.currentTotal!.wage! + 500 } };
    const report = auditCustomerBim(estimate({ positions: [wrong] }), CONTEXT);
    expect(find(report, "ARITHMETIC").some((item) => /ОЗП: 2000,00 × индекс 47,58/.test(item.message))).toBe(true);
  });

  it("НР ниже норматива приказа 812/пр: находка WARNING, разница уходит в «накладные»", () => {
    const base = position({ index: BELGOROD });
    // Заказчик применил НР 90 % вместо 100 %: 1980 вместо 2200.
    const low: BimPosition = {
      ...base,
      overhead: charge("Пр/812-001.1", 90, 1980),
      positionCurrentTotal: base.positionCurrentTotal! - 220 * 47.58,
    };
    const report = auditCustomerBim(estimate({ positions: [low] }), CONTEXT);
    const [finding] = find(report, "OVERHEAD_RATE") as [AuditFinding];
    expect(finding.severity).toBe("WARNING");
    expect(finding.message).toMatch(/НР Пр\/812-001\.1 — у заказчика 90 %, по приказу 100 %/);
    expect(report.impacts.OVERHEAD.amount).toBeCloseTo(220 * 47.58, 2);
    expect(report.bim?.impactBySource.norms).toBeCloseTo(220 * 47.58, 2);
    expect(groupsSum(report)).toBeCloseTo(report.diff, 4);
  });

  it("НР и СП по МДС 81-33.2004: проценты не проверяются, и сказано почему", () => {
    const base = position({ index: BELGOROD });
    const low: BimPosition = { ...base, overhead: charge("Пр/812-001.1", 90, 1980), positionCurrentTotal: base.positionCurrentTotal! - 220 * 47.58 };
    const report = auditCustomerBim(estimate({ positions: [low], overheadNorms: "MDS" }), CONTEXT);
    expect(find(report, "OVERHEAD_RATE")).toEqual([]);
    expect(report.bim?.overheadChecked).toBe(false);
    expect(report.bim?.overheadNote).toMatch(/МДС 81-33\.2004.*нет в открытых данных|нормативов в открытых данных ФГИС ЦС нет/);
    expect(find(report, "RATE_NOT_CHECKED")[0]?.message).toMatch(/не проверялись/);
    expect(report.impacts.OVERHEAD.amount).toBeCloseTo(0, 6);
  });
});

describe("аудит БИМ: смета в базисных ценах 2001 года", () => {
  it("индексов в смете нет: статус «не применяются», разница только от цен ФЕР", () => {
    const base = position({ index: BELGOROD });
    const flat: BimPosition = { ...base, indices: null, currentTotal: null, positionCurrentTotal: null };
    const report = auditCustomerBim(estimate({ positions: [flat], priceLevel: "BASE", quarter: null, quarterSource: null, total: 7900, positionsTotal: 7900 }), CONTEXT);
    expect(report.bim?.indexStatus).toBe("NOT_APPLIED");
    expect(report.bim?.indexNote).toMatch(/базисных ценах 2001/);
    expect(report.period).toBe("базисные цены 01.01.2000");
    expect(find(report, "INDEX_VALUE")).toEqual([]);
    expect(find(report, "OUTDATED_PRICE_LEVEL")).toEqual([]);
    expect(report.bim?.baseChecks.matched).toBe(1);
    expect(report.diff).toBeCloseTo(0, 2);
  });
});

describe("указатели нормативов", () => {
  it("указатель расценки ФЕР-2020 приводится к виду справочника НР и СП", () => {
    expect(normativeRef("812/пр-054.0")).toBe("Пр/812-054.0");
    expect(normativeRef("774/пр-001.1")).toBe("Пр/774-001.1");
    expect(normativeRef("Пр/812-051.2-1")).toBe("Пр/812-051.2");
    expect(normativeRef("МДС 81-33")).toBeNull();
    expect(normativeRef(null)).toBeNull();
  });
});

describe("подписи аудита БИМ (экран и отчёт Word)", () => {
  const under = auditCustomerBim(estimate({ positions: [position({ index: { ...BELGOROD, labour: 45 } })] }), CONTEXT);

  it("шапка называет метод, базу и квартал; вывод — та же формулировка, что у ресурсной сметы", () => {
    const headline = auditHeadline(under);
    expect(headline).toContain("базисно-индексный метод");
    expect(headline).toContain("по ФЕР-2020 и индексам Минстроя (Белгородская область, III кв. 2026)");
    expect(headline).toContain(under.conclusion);
  });

  it("«откуда разница»: труд и «из них индексы» названы суммами, которые сходятся с разницей", () => {
    const lines = auditBreakdown(under);
    expect(lines.map((line) => line.group)).toEqual(["LABOUR", "SOURCE_INDEX"]);
    expect(lines[0]?.text).toMatch(/Труд \(с НР и СП на него\): \+13[\s ]674 ₽/u);
    expect(lines[1]?.text).toMatch(/Из них индексы \(письмо Минстроя\): \+13[\s ]674 ₽/u);
  });

  it("строки о проверенном: находка по индексу первой, затем индексы, объект, базисные цены, НР и СП", () => {
    const lines = bimDetailLines(under);
    expect(lines[0]).toMatch(/^Заказчик применил индекс к ОЗП 45,00/);
    expect(lines.some((line) => line.startsWith("Объект строительства по наименованию стройки: Многоквартирные жилые дома: Кирпичные"))).toBe(true);
    expect(lines.some((line) => /^Базисные цены расценок: сверено с ФЕР-2020 1 \(совпало 1, расходится 0\)/.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/^НР и СП: НР и СП — по приказам 812\/пр и 774\/пр/);
  });

  it("ТЕР: подпись для региона — «базисные цены не проверены, нет открытой базы»", () => {
    const ter = auditCustomerBim(estimate({ positions: [position({ index: { labour: 50.75, machines: 14.22, materials: 12.09 }, code: "ТЕР01-01-001-01" })] }), CONTEXT);
    expect(bimDetailLines(ter).some((line) => line.includes("ТЕР Белгородская область — базисные цены не проверены, нет открытой базы: 1"))).toBe(true);
  });

  it("смета БИМ, которую нечем проверить, не называется «не форма 421/пр»", () => {
    expect(notRecognizedLine({ documentName: "ЛС.xlsx", estimateName: "ЛС-1", reason: "смета по базисно-индексному методу, но ФЕР-2020 не собраны" })).toBe(
      "Смета «ЛС-1» — построчно не проверена (смета по базисно-индексному методу, но ФЕР-2020 не собраны)",
    );
    expect(notRecognizedLine({ documentName: "x.xlsx", estimateName: null, reason: "нет граф" })).toContain("не форма 421/пр");
  });
});
