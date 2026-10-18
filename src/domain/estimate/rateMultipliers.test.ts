import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { computeAssurance } from "@/domain/estimate/assurance";
import { applyBillEdits, type BillEdit } from "@/domain/estimate/billEdits";
import { buildEstimate } from "@/domain/estimate/calculate";
import { evaluateCustomerConditions, summarizeCustomerConditions } from "@/domain/estimate/customerCoefficients";
import { parseCustomerLsr, type CustomerPosition, type CustomerRate } from "@/domain/estimate/customerLsr";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { OVERHEAD_MULTIPLIERS } from "@/domain/estimate/normatives";
import { resolveRateMultipliers } from "@/domain/estimate/rateMultipliers";
import type { BillOfWorkItem, CustomerConditions, LineCoefficients, NormRecord, WorkConditionsApplication } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_GRADING,
  NORM_MANUAL_GRADING,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";
import { DOCUMENTS_1118 } from "@/test/t1118Fixtures";

/*
  Множители заказчика к НР и СП: 0,9 к НР (812/пр п. 25) и 0,85 к СП (774/пр п. 16) при капремонте по ГЭСН с п. 58.
  Живые позиции — ЛСР 02-02-12 закупки 0302300048726001118; граничные случаи — синтетические.
*/

const set = buildLsrSet(parseCustomerLsr(DOCUMENTS_1118).estimates);
const positionOf = (number: string, label: string): CustomerPosition => {
  const entry = set.entries.find((candidate) => candidate.number === number);
  return [...(entry?.estimate.positions ?? []), ...(entry?.estimate.subPositions ?? [])].find((position) => position.label === label) as CustomerPosition;
};

const rate = (ref: string, base: number, coefficient: number | null, amount = 1000): CustomerRate => ({
  ref: null,
  rawRef: ref,
  basePercent: base,
  coefficient,
  percent: coefficient === null ? base : base * coefficient,
  amount,
});
const P58_NOTE = { ref: "421/пр_2020_п.58_пп.б", text: "аналогичных технологическим процессам в новом строительстве, с применением коэффициентов 1,15 к затратам труда и 1,25 к нормам времени" };
const OVERHEAD_REF = "Пр/812-016.0-1, Приказ № 812/пр от 21.12.2020 п.25";
const PROFIT_REF = "Пр/774-016.0, Приказ № 774/пр от 11.12.2020 п.16";

function synthetic(patch: Partial<CustomerPosition>): CustomerPosition {
  return {
    number: 1,
    label: "1",
    code: "ГЭСН15-01-050-04",
    rawJustification: "ГЭСН15-01-050-04",
    book: "GESN",
    coefficients: null,
    hasCoefficients: false,
    name: "Облицовка стен",
    unit: "100 м2",
    quantity: 1,
    section: null,
    ownUnitPrice: null,
    ownTotal: null,
    ownBasePrice: null,
    ownIndex: null,
    ownPriceCoefficient: null,
    resources: [],
    groupTotals: { labour: 1000, machines: 200, machinistLabour: 100, materials: 0 },
    directTotal: 1300,
    wageFund: 1100,
    overhead: rate(OVERHEAD_REF, 100, 0.9),
    profit: rate(PROFIT_REF, 60, 0.85),
    perUnit: null,
    total: 3000,
    truncated: false,
    notes: [P58_NOTE],
    ...patch,
  };
}

describe("справочник множителей: значения сверены с текстом приказа", () => {
  const sourceText = (file: string): string => readFileSync(resolve("data/fsnb/normatives/sources", file), "utf8").replace(/\s+/gu, " ");

  it("п. 25 (0,9), п. 27 (1,03 и 1,15) и исключения п. 26 дословно есть в сохранённом тексте 812/пр", () => {
    const text = sourceText("812-pr-nakladnye-rashody.txt");
    for (const item of OVERHEAD_MULTIPLIERS.multipliers.filter((entry) => entry.textVerified)) {
      expect(text, item.id).toContain((item.fragment as string).replace(/\s+/gu, " "));
    }
    for (const item of OVERHEAD_MULTIPLIERS.exclusions) expect(text, item.id).toContain(item.fragment.replace(/\s+/gu, " "));
  });

  it("текст 774/пр в источниках не сохранён — множитель СП п. 16 помечен несверенным, и это сказано", () => {
    const profit = OVERHEAD_MULTIPLIERS.multipliers.find((item) => item.id === "SP-P16");
    expect(profit).toMatchObject({ value: 0.85, normative: "PROFIT", order: "774/пр", point: "п. 16", textVerified: false });
    expect(OVERHEAD_MULTIPLIERS.sources.find((source) => source.id === "774-pr")?.notes.join(" ")).toContain("не сверялся");
    expect(OVERHEAD_MULTIPLIERS.multipliers.filter((item) => !item.textVerified).map((item) => item.id)).toEqual(["SP-P16"]);
  });

  it("копия для приложения совпадает с data/fsnb/normatives (data/ на сервер не выкладывается)", () => {
    const name = "overhead-multipliers.json";
    expect(readFileSync(resolve("src/domain/estimate/normativesData", name), "utf8")).toBe(readFileSync(resolve("data/fsnb/normatives", name), "utf8"));
  });

  it("п. 25 применим только вместе с п. 58, п. 27 — только для особо опасных объектов", () => {
    expect(OVERHEAD_MULTIPLIERS.multipliers.filter((item) => item.requires === "P58").map((item) => item.id)).toEqual(["NR-P25", "SP-P16"]);
    expect(OVERHEAD_MULTIPLIERS.multipliers.filter((item) => item.requires === "SPECIAL_OBJECT")).toHaveLength(2);
  });
});

describe("разбор ЛСР: графа 6 строки НР и СП", () => {
  it("коэффициент заказчика к нормативу прочитан: «% 100 0,9 90»", () => {
    const position = positionOf("02-02-12", "2");
    expect(position.overhead?.coefficient).toBe(0.9);
    expect(position.profit?.coefficient).toBe(0.85);
    // Графы 5, 6, 7: норматив, коэффициент, применённый процент.
    expect((position.overhead?.basePercent ?? 0) * 0.9).toBeCloseTo(position.overhead?.percent ?? 0, 6);
  });

  it("позиция без коэффициента — null", () => {
    expect(positionOf("02-02-12", "1").overhead?.coefficient ?? null).toBeNull();
  });
});

describe("подтверждённый множитель", () => {
  it("живая позиция: ГЭСН с п. 58 — 0,9 к НР (812/пр п. 25) и 0,85 к СП (774/пр п. 16) подтверждены", () => {
    const conditions = evaluateCustomerConditions(positionOf("02-02-12", "2"));

    expect(conditions?.confirmed?.p58).toBe(true);
    expect(conditions?.rates?.overhead).toMatchObject({ id: "NR-P25", value: 0.9, label: "812/пр п. 25 (0,9)" });
    expect(conditions?.rates?.profit).toMatchObject({ id: "SP-P16", value: 0.85, label: "774/пр п. 16 (0,85)" });
    expect(conditions?.label).toContain("812/пр п. 25 (0,9) к нормативу НР");
    expect(conditions?.rejected).toEqual([]);
  });

  it("применён к нашим нормативам: проценты строки — с множителем, указатели и базовые проценты сохранены", () => {
    const conditions = evaluateCustomerConditions(synthetic({}));
    const line = lineOf(conditions as CustomerConditions);
    const base = lineOf(undefined);

    expect(line?.rateMultipliers).toMatchObject({ applied: ["NR-P25", "SP-P16"], skipped: [], manual: false });
    expect(line?.overheadPercent).toBeCloseTo((base?.overheadPercent ?? 0) * 0.9, 4);
    expect(line?.profitPercent).toBeCloseTo((base?.profitPercent ?? 0) * 0.85, 4);
    expect(line?.rateMultipliers?.baseOverheadPercent).toBe(base?.overheadPercent);
    expect(line?.overheadRef).toBe(base?.overheadRef);
    // НР и СП считаются от ФОТ строки: фонд тот же (труд ×1,15 от п. 58), начисление — по проценту с множителем.
    expect(line?.overheadCost).toBeCloseTo(((line?.wageFund ?? 0) * (line?.overheadPercent ?? 0)) / 100, 2);
    expect(line?.rateMultipliers?.label).toBe("как у заказчика: 812/пр п. 25 (0,9); 774/пр п. 16 (0,85)");
  });

  it("сочетание с коэффициентами условий работ: труд ×1,15 (п. 58) и НР ×0,9 — оба на одной позиции", () => {
    const line = lineOf(evaluateCustomerConditions(synthetic({})) as CustomerConditions);
    const plain = lineOf(undefined);

    expect(line?.labourHours).toBeCloseTo((plain?.labourHours ?? 0) * 1.15, 6);
    expect(line?.coefficients?.adjustmentIds).toEqual(["P58"]);
    expect(line?.overheadCost).toBeLessThan(((line?.wageFund ?? 0) * (plain?.overheadPercent ?? 0)) / 100);
  });

  it("человек уже выбрал п. 58 глобально: п. 58 один раз, множители к НР и СП — как у заказчика", () => {
    const app: WorkConditionsApplication = { phase: "CAPITAL_REPAIR", conditionIds: [], newConstructionNorms: true };
    const line = lineOf(evaluateCustomerConditions(synthetic({})) as CustomerConditions, makeParameters({ workConditions: app }));
    const plain = lineOf(undefined);

    expect(line?.labourHours).toBeCloseTo((plain?.labourHours ?? 0) * 1.15, 6);
    expect(line?.rateMultipliers?.applied).toEqual(["NR-P25", "SP-P16"]);
  });

  it("надёжность: подтверждённые множители допущением не считаются", () => {
    const conditions = evaluateCustomerConditions(synthetic({})) as CustomerConditions;
    const document = documentOf(conditions);

    expect(computeAssurance(document).assumptions.some((item) => item.kind === "CUSTOMER_COEFFICIENT_MANUAL")).toBe(false);
    expect(document.appliedNormatives?.find((item) => item.code === "CUSTOMER_COEFFICIENTS")?.value).toContain("множители к нормативам НР и СП применены к 1 позициям");
  });
});

describe("неподтверждённый множитель — находка с суммой, расчёт не меняется", () => {
  it("0,9 к НР без п. 58 (живая ЛСР 02-02-08, поз. 12): п. 25 применим вместе с п. 58", () => {
    const conditions = evaluateCustomerConditions(positionOf("02-02-08", "12"));
    const claim = conditions?.rejected.find((item) => item.overheadMultiplier === 0.9);

    expect(conditions?.rates?.overhead ?? null).toBeNull();
    expect(claim?.reason).toContain("п. 58 не подтверждён");
    // Заказчик уменьшил начисление: сумма отрицательная.
    expect(claim?.amount).toBeLessThan(0);
  });

  it("значение не совпадает с пунктом: 0,8 вместо 0,9", () => {
    const conditions = evaluateCustomerConditions(synthetic({ overhead: rate(OVERHEAD_REF, 100, 0.8) }));

    expect(conditions?.rates?.overhead ?? null).toBeNull();
    expect(conditions?.rates?.profit?.id).toBe("SP-P16");
    expect(conditions?.rejected.find((item) => item.overheadMultiplier === 0.8)?.reason).toContain("в смете 0,8, а 812/пр п. 25 даёт 0,9");
  });

  it("ссылки на приказ нет или пункт чужой", () => {
    const none = evaluateCustomerConditions(synthetic({ overhead: rate("Пр/812-016.0-1", 100, 0.9) }));
    expect(none?.rejected.find((item) => item.overheadMultiplier === 0.9)?.reason).toContain("ссылки на приказ и пункт");

    const foreign = evaluateCustomerConditions(synthetic({ overhead: rate("Пр/812-016.0-1, Приказ № 812/пр п.22", 100, 0.9) }));
    expect(foreign?.rejected.find((item) => item.overheadMultiplier === 0.9)?.reason).toContain("множителей к нормативам");
  });

  it("множитель к СП под пунктом НР и наоборот не принимается", () => {
    const swapped = evaluateCustomerConditions(synthetic({ profit: rate("Пр/774-016.0, Приказ № 812/пр п.25", 60, 0.9) }));

    expect(swapped?.rates?.profit ?? null).toBeNull();
    expect(swapped?.rejected.some((item) => item.profitMultiplier === 0.9)).toBe(true);
  });

  it("1,03 по п. 27 (особо опасные объекты) по смете не проверить — не применяется", () => {
    const conditions = evaluateCustomerConditions(synthetic({ overhead: rate("Пр/812-016.0-1, Приказ № 812/пр п.27", 100, 1.03) }));

    expect(conditions?.rates?.overhead ?? null).toBeNull();
    expect(conditions?.rejected.find((item) => item.overheadMultiplier === 1.03)?.reason).toContain("особо опасных");
  });

  it("не применён в расчёте: проценты — норматив по указателю, находка в сводке", () => {
    const rejectedOnly = evaluateCustomerConditions(synthetic({ notes: [], overhead: rate(OVERHEAD_REF, 100, 0.9), profit: null })) as CustomerConditions;
    const line = lineOf(rejectedOnly);
    const plain = lineOf(undefined);

    expect(line?.rateMultipliers).toBeUndefined();
    expect(line?.overheadPercent).toBe(plain?.overheadPercent);
  });

  it("находка видна в сводке источника; множитель СП назван несверенным", () => {
    const entry = set.entries.find((candidate) => candidate.number === "02-02-12");
    const items = lsrBillSection(entry as NonNullable<typeof entry>, 1).section.items;
    const summary = summarizeCustomerConditions(items, "ЛСР 02-02-12");

    expect(summary.notes.some((note) => note.includes("774/пр п. 16") && note.includes("текст приказа 774/пр в источниках отсутствует"))).toBe(true);
    expect(summary.notes[0]).toContain("812/пр п. 25 (0,9)");
  });
});

describe("п. 58 к строке не применён или действует п. 26 — множитель пропущен и назван", () => {
  const coefficientsWithP58: LineCoefficients = { labour: 1.15, machines: 1.25, wage: 1, conditionIds: [], adjustmentIds: ["P58"] };
  const confirmed = evaluateCustomerConditions(synthetic({})) as CustomerConditions;

  it("п. 58 не применён к строке (например, выбран другой вид работ)", () => {
    const resolved = resolveRateMultipliers(confirmed, null, { baseType: "ГЭСН", collectionCode: "15" });

    expect(resolved?.applied).toEqual([]);
    expect(resolved?.skipped[0]).toContain("п. 58 к строке не применён");
  });

  it("капремонт дорог и сетей (сборники 22–25, 27–34, 36–44): п. 26 отменяет множитель", () => {
    for (const collection of ["27", "22", "33"]) {
      const resolved = resolveRateMultipliers(confirmed, coefficientsWithP58, { baseType: "ГЭСН", collectionCode: collection });
      expect(resolved?.applied, collection).toEqual([]);
      expect(resolved?.skipped.some((line) => line.includes("п. 26")), collection).toBe(true);
    }
    expect(resolveRateMultipliers(confirmed, coefficientsWithP58, { baseType: "ГЭСН", collectionCode: "15" })?.applied).toEqual(["NR-P25", "SP-P16"]);
  });

  it("человек выбрал вид работ «строительство»: п. 58 не действует — множитель не применён на живой строке", () => {
    const app: WorkConditionsApplication = { phase: "CONSTRUCTION", conditionIds: [], newConstructionNorms: false };
    const line = lineOf(confirmed, makeParameters({ workConditions: app }));

    expect(line?.rateMultipliers?.applied).toEqual([]);
    expect(line?.rateMultipliers?.overhead).toBe(1);
    expect(line?.overheadPercent).toBe(lineOf(undefined)?.overheadPercent);
  });
});

describe("отключение — тем же переключателем и той же галочкой позиции", () => {
  const confirmed = evaluateCustomerConditions(synthetic({})) as CustomerConditions;

  it("глобально (enabled = false у всех позиций): ни коэффициентов условий, ни множителей", () => {
    const line = lineOf({ ...confirmed, enabled: false });

    expect(line?.rateMultipliers).toBeUndefined();
    expect(line?.coefficients).toBeUndefined();
    expect(line?.overheadPercent).toBe(lineOf(undefined)?.overheadPercent);
  });

  it("по позиции: правка coefficients снимает и условия, и множители; для позиции только с множителями включение — подтверждённое", () => {
    const onlyRates = { ...confirmed, confirmed: null } as CustomerConditions;
    const sections = [makeBillSection("ЛСР", [{ ...BILL_GRADING, customerConditions: onlyRates }])];
    const anchor = { itemId: BILL_GRADING.id, workName: BILL_GRADING.workName, quantity: 800, unit: "м2", positionNumber: null, normCode: null, section: null };
    const off: BillEdit = { kind: "coefficients", anchor, apply: false };
    const on: BillEdit = { kind: "coefficients", anchor, apply: true };

    expect(applyBillEdits(sections, [off]).sections[0]?.items[0]?.customerConditions?.enabled).toBe(false);
    // Подтверждённые множители есть: включение не тянет неподтверждённые значения.
    expect(applyBillEdits(sections, [on]).sections[0]?.items[0]?.customerConditions?.forceUnconfirmed).toBe(false);
  });

  it("неподтверждённые значения, включённые вручную, применяются и считаются допущением", () => {
    const rejectedOnly = evaluateCustomerConditions(synthetic({ notes: [], profit: null })) as CustomerConditions;
    const forced = { ...rejectedOnly, forceUnconfirmed: true };
    const line = lineOf(forced);
    const plain = lineOf(undefined);

    expect(line?.rateMultipliers).toMatchObject({ manual: true, overhead: 0.9 });
    expect(line?.overheadPercent).toBeCloseTo((plain?.overheadPercent ?? 0) * 0.9, 4);
    expect(computeAssurance(documentOf(forced)).assumptions.some((item) => item.kind === "CUSTOMER_COEFFICIENT_MANUAL")).toBe(true);
  });
});

/* ------------------------------ расчёт ------------------------------ */

const PRICE_BOOK = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE));
const RESOLVE = makeResolver([NORM_MANUAL_GRADING as NormRecord]);

function documentOf(conditions: CustomerConditions | undefined, parameters = makeParameters()) {
  const item: BillOfWorkItem = { ...BILL_GRADING, ...(conditions === undefined ? {} : { customerConditions: conditions }) };
  return buildEstimate({
    title: "Тест",
    sections: [makeBillSection("ЛСР", [item])],
    priceBook: PRICE_BOOK,
    parameters,
    resolveNorm: RESOLVE,
    sources: [],
    generatedAt: "2026-10-09T00:00:00.000Z",
    disclaimer: "тест",
  });
}

const lineOf = (conditions: CustomerConditions | undefined, parameters = makeParameters()) => documentOf(conditions, parameters).sections[0]?.lines[0];

describe("аудит: находка по множителям заказчика", () => {
  it("подтверждённые — справка, неподтверждённые — предупреждение с суммой", async () => {
    const { auditCustomerLsr } = await import("@/domain/estimate/customerAudit");
    const { makeBook } = await import("@/test/auditPriceBook");
    const lsr = (number: string) => set.entries.find((entry) => entry.number === number)?.estimate as NonNullable<(typeof set.entries)[number]>["estimate"];

    const confirmed = auditCustomerLsr(lsr("02-02-12"), { priceBook: makeBook() });
    expect(confirmed.findings.some((item) => item.type === "COEFFICIENTS" && item.severity === "INFO" && item.message.includes("812/пр п. 25 (0,9)"))).toBe(true);

    const rejected = auditCustomerLsr(lsr("02-02-08"), { priceBook: makeBook() });
    const warning = rejected.findings.find((item) => item.type === "COEFFICIENTS" && item.severity === "WARNING" && item.message.includes("множитель 0,9 к нормативу НР"));
    expect(warning?.message).toContain("не подтверждается приложением 10 и приказами 812/пр, 774/пр");
    expect(warning?.message).toContain("уменьшает затраты позиции на");
    expect(warning?.impact).toBeLessThan(0);
  });
});
