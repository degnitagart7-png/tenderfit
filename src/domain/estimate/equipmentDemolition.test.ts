import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { auditCustomerLsr } from "@/domain/estimate/customerAudit";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { buildEstimate } from "@/domain/estimate/calculate";
import { evaluateCustomerConditions } from "@/domain/estimate/customerCoefficients";
import { EQUIPMENT_DEMOLITION } from "@/domain/estimate/normatives";
import type { BillOfWorkItem, CustomerConditions } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_GRADING,
  NORM_DRAINAGE_100,
  NORM_MANUAL_GRADING,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";
import { makeBook } from "@/test/auditPriceBook";
import { DOCUMENTS_1118 } from "@/test/t1118Fixtures";

/*
  Коэффициент заказчика 0,3 при демонтаже оборудования в лом без разборки и резки: источник — Методика применения сметных норм
  571/пр, п. 84, таблица 3, строка 4 (числа сверены по официальному PDF). Ссылку «648/пр п. 145, таблица 3» (методика по ФЕР) заказчики
  ресурсно-индексных ЛСР пишут вместо неё: справочник читает её как ту же строку. 0,65 при наладке («Прил. 3.3 п. 2», ГЭСНп) не
  подтверждается — техчасть недоступна. Плюс проверка, что аудит не принимает его арифметику ОТ + ЭМ + ОТм + М за двойной счёт ОТм.
  Полная проверка таблиц 2 и 3 (все строки, ссылки, расчёт) — в customerCoefficients.571.test.ts.
*/

describe("справочник демонтажа: строки 571/пр, алиасы 648/пр, копии данных совпадают", () => {
  const text571 = readFileSync(resolve("data/fsnb/normatives/sources", "571-pr-metodika-primeneniya-smetnyh-norm-official-ocr.txt"), "utf8").replace(/\s+/gu, " ");
  const text648 = readFileSync(resolve("data/fsnb/normatives/sources", "648-pr-metodika-fer-official.txt"), "utf8").replace(/\s+/gu, " ");

  it("фрагменты записей дословно есть в сохранённом тексте 571/пр, а подписи алиасов — в тексте 648/пр", () => {
    for (const entry of EQUIPMENT_DEMOLITION.equipmentDemolition.filter((item) => item.textVerified)) {
      for (const fragment of entry.fragments) expect(text571, entry.id).toContain(fragment.replace(/\s+/gu, " "));
      for (const alias of entry.aliases ?? []) for (const fragment of alias.fragments) expect(text648, `${entry.id} ← ${alias.point}`).toContain(fragment.replace(/\s+/gu, " "));
    }
  });

  it("строка «в лом, без разборки и резки» — таблица 3, строка 4: 0,3, значение сверено, книга ГЭСНм; Прил. 3.3 названа недоступной и не применяется", () => {
    const row = EQUIPMENT_DEMOLITION.equipmentDemolition.find((entry) => entry.table === 3 && entry.row === 4);
    expect(row).toMatchObject({ id: "M571-P84-T3-R4", labour: 0.3, machines: 0.3, materials: 0, valueVerified: true, textVerified: true, books: ["GESNM"] });
    expect(row?.aliases?.[0]).toMatchObject({ order: "648/пр", table: 3, row: 4 });
    expect(EQUIPMENT_DEMOLITION.unavailable[0]).toMatchObject({ ref: "Прил.3.3" });
    expect(EQUIPMENT_DEMOLITION.unavailable[0]?.reason).toContain("проверьте вручную");
  });

  it("данные в data/fsnb и в src/domain совпадают", () => {
    const left = readFileSync(resolve("data/fsnb/normatives/equipment-demolition.json"), "utf8");
    const right = readFileSync(resolve("src/domain/estimate/normativesData/equipment-demolition.json"), "utf8");
    expect(left).toBe(right);
  });
});

describe("коэффициент демонтажа оборудования в расчёте", () => {
  const special = (patch: Partial<NonNullable<CustomerConditions["special"]>> = {}): CustomerConditions => ({
    confirmed: null,
    rejected: [],
    label: "571/пр п. 84, табл. 3",
    enabled: true,
    forceUnconfirmed: false,
    special: { id: "M571-P84-T3-R4", labour: 0.3, machines: 0.3, materials: 0, valueVerified: true, label: "571/пр п. 84, табл. 3, стр. 4 (К = 0,3)", ...patch },
  });
  const book = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE));
  const calc = (norm: typeof NORM_MANUAL_GRADING, item: BillOfWorkItem) =>
    buildEstimate({
      title: "Тест",
      sections: [makeBillSection("ЛСР", [item])],
      priceBook: book,
      parameters: makeParameters(),
      resolveNorm: makeResolver([norm]),
      sources: [],
      generatedAt: "2026-10-10T00:00:00.000Z",
      disclaimer: "тест",
    }).sections[0]?.lines[0];

  it("труд ×0,3: часы и оплата труда уменьшены, пометка называет пункт 571/пр", () => {
    const plain = calc(NORM_MANUAL_GRADING, BILL_GRADING);
    const applied = calc(NORM_MANUAL_GRADING, { ...BILL_GRADING, customerConditions: special() });

    expect(applied?.labourHours).toBeCloseTo((plain?.labourHours ?? 0) * 0.3, 6);
    expect(applied?.labourCost).toBeCloseTo((plain?.labourCost ?? 0) * 0.3, 2);
    expect(applied?.coefficients?.customer?.applied).toContain("M571-P84-T3-R4");
  });

  it("материалы не учитываются: стоимость материалов позиции равна нулю", () => {
    const item = makeBillItem({ id: "d", workName: "Демонтаж", quantity: 1000, quantityUnit: "м", unitDivisor: 1000, normCode: "01-01-129-11", normBaseType: "ГЭСН" });
    const plain = calc(NORM_DRAINAGE_100, item);
    const applied = calc(NORM_DRAINAGE_100, { ...item, customerConditions: special() });

    expect(plain?.materialCost).toBeGreaterThan(0);
    expect(applied?.materialCost).toBe(0);
  });

  it("снятие применения (enabled = false) возвращает расход нормы", () => {
    const plain = calc(NORM_MANUAL_GRADING, BILL_GRADING);
    const off = calc(NORM_MANUAL_GRADING, { ...BILL_GRADING, customerConditions: { ...special(), enabled: false } });

    expect(off?.labourHours).toBeCloseTo(plain?.labourHours ?? 0, 6);
  });
});

describe("«Прил. 3.3 п. 2» (0,65 к наладке): первоисточник недоступен", () => {
  it("не применяется и названа причина: проверьте вручную", () => {
    const entry = parseCustomerLsr(DOCUMENTS_1118).estimates.find((estimate) => estimate.positions.some((position) => position.label === "3" && position.rawJustification.includes("ГЭСНп")));
    expect(entry).toBeDefined();
    const position = entry?.positions.find((candidate) => candidate.label === "3");
    const conditions = evaluateCustomerConditions(position as NonNullable<typeof position>);

    expect(conditions?.confirmed).toBeNull();
    expect(conditions?.special).toBeUndefined();
    expect(conditions?.rejected[0]?.reason).toContain("проверьте вручную");
  });
});

describe("аудит: «Итого прямые затраты» = ОТ + ЭМ + ОТм + М — арифметика формы 421/пр, а не двойной счёт ОТм", () => {
  it("на ЛСР 02-02-08 нет находки «ОТм учтена дважды»: ЭМ печатается без ОТм, ОТм идёт отдельными строками", () => {
    const lsr = parseCustomerLsr(DOCUMENTS_1118).estimates.find((estimate) => estimate.positions.some((position) => (position.groupTotals.machinistLabour ?? 0) > 0));
    const report = auditCustomerLsr(lsr as NonNullable<typeof lsr>, { priceBook: makeBook() });

    // Позиции с ОТм на этой ЛСР есть, и «Итого прямые затраты» у них сложены из ОТ, ЭМ, ОТм и М — это верно.
    const withOtm = (lsr?.positions ?? []).filter((position) => (position.groupTotals.machinistLabour ?? 0) > 0.5 && position.directTotal !== null);
    expect(withOtm.length).toBeGreaterThan(0);
    expect(report.findings.filter((finding) => finding.type === "ARITHMETIC" && finding.message.includes("дважды"))).toEqual([]);
    expect(report.findings.filter((finding) => finding.message.includes("значит, ЭМ уже включает ОТм"))).toEqual([]);
  });
});
