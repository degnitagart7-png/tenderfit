import { describe, expect, it, vi } from "vitest";

import type { ZoneAutoServices } from "@/domain/estimate/autoServices";
import { anchorOf, applyBillEdits, billSignature } from "@/domain/estimate/billEdits";
import { generatedBadge } from "@/domain/estimate/billReview";
import { GENERATED_DEBRIS_SECTION, GENERATED_IMPLIED_SECTION } from "@/domain/estimate/generatedItems";
import type { ImpliedProposer, RawAddition } from "@/domain/estimate/impliedWorks";
import { NO_ESTIMATE_OPTIONS } from "@/domain/estimate/estimateOptions";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { NormPicker } from "@/domain/estimate/normPick";
import type { BillOfWorkItem, NormRecord } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { recalculateEstimate } from "@/services/estimateRecalc";
import { buildEstimateFromDocuments, withGeneratedSections, type EstimateDeps } from "@/services/estimateService";
import { AMUR_WAGE_ANCHORS, AMUR_ZONE, NORM_MANUAL_GRADING, makeBillItem, makeParameters, makePriceBook } from "@/test/estimateFixtures";

/**
 * Строки сверх ведомости в сборке сметы: мусор по тоннажу из норм (без ИИ) и работы по технологии от ИИ (леса).
 *
 * Эталон — закупка 0134300025826000377 (ремонт утепления фасада): в ведомости только фасадные работы, а у заказчика «ГЭСН08-07-001-02 Установка и
 * разборка наружных инвентарных лесов» и строки про мусор. Нормы синтетические (труд — от настоящей нормы, чтобы деньги были видны), у разборки
 * есть ресурс «999-9900 Строительный мусор». Модель подменена: предлагает и выбирает то, что скажет тест.
 */

const DEBRIS = { code: "999-9900", kind: "UNKNOWN" as const, name: "Строительный мусор", quantity: 0.867, unit: "т", quantityNote: null, projectSpecific: true, technologyGroup: null };

const DISMANTLE: NormRecord = {
  ...NORM_MANUAL_GRADING,
  code: "46-04-010-01",
  tableCode: "46-04-010",
  fullName: "Разборка облицовки стен из металлического сайдинга",
  endName: "Разборка облицовки стен из металлического сайдинга",
  unit: "100 м2",
  collectionCode: "46",
  collectionName: "Работы при реконструкции зданий и сооружений",
  resources: [...NORM_MANUAL_GRADING.resources, DEBRIS],
};
const INSULATION: NormRecord = {
  ...NORM_MANUAL_GRADING,
  code: "26-01-041-01",
  tableCode: "26-01-041",
  fullName: "Изоляция стен изделиями из минераловатных плит",
  endName: "Изоляция стен изделиями из минераловатных плит",
  unit: "100 м2",
  collectionCode: "26",
  collectionName: "Теплоизоляционные работы",
};
const SCAFFOLD: NormRecord = {
  ...NORM_MANUAL_GRADING,
  code: "08-07-001-02",
  tableCode: "08-07-001",
  fullName: "Установка и разборка наружных инвентарных лесов высотой до 16 м: трубчатых для прочих отделочных работ",
  endName: "трубчатых для прочих отделочных работ",
  unit: "100 м2",
  collectionCode: "08",
  collectionName: "Отделочные работы",
};
/** Постоянная конструкция: козырёк над входом — элемент здания, а не временная мера. */
const CANOPY: NormRecord = {
  ...NORM_MANUAL_GRADING,
  code: "10-05-001-01",
  tableCode: "10-05-001",
  fullName: "Устройство козырьков над входами",
  endName: "Устройство козырьков над входами",
  unit: "м2",
  collectionCode: "10",
  collectionName: "Деревянные конструкции",
};
const NORMS: readonly NormRecord[] = [DISMANTLE, INSULATION, SCAFFOLD, CANOPY];

function makeBase(): EstimateBase {
  return {
    info: {
      indexDir: "data/fsnb/index",
      builtAt: "2026-09-28T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: AMUR_ZONE.region,
      priceZone: AMUR_ZONE.zone,
      period: AMUR_ZONE.period,
      decree: "Приказ Минстроя России от 30.12.2021 № 1046/пр",
      counts: { norms: NORMS.length, basePrices: 0, currentPrices: 0, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE)),
    searchIndex: createNormSearchIndex(NORMS),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

/** Таблицы услуг зоны: погрузка мусора 49-1 (94,64 ₽/т) и перевозка самосвалами 02-15-1-01 (600 + км − 1 ₽/т). */
const SERVICES: ZoneAutoServices = {
  transport: new Map([
    ["02-15-1-01", { prefix: "02-15-1-01", vehicle: "02", capacity: 15, capacityUnit: "т", cls: 1, road: "01", vehicleName: "Автомобили-самосвалы", roadName: null, prices: Array.from({ length: 100 }, (_, index) => 600 + index) }],
  ]),
  load: new Map([["49-1", { code: "49-1", group: 49, groupName: "Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", operation: "LOAD" as const, price: 94.64 }]]),
};

const TEXT = [
  "Техническое задание. Ремонт утепления фасада 4-этажного здания. Высота здания до 12 м.",
  "Вывоз мусора выполняется на полигон на расстояние 51 км.",
  "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
  "1 Демонтаж профлиста | м2 | 199,1",
  "2 Монтаж утеплителя | м2 | 56,5",
].join("\n");

const ROWS = [
  { workName: "Демонтаж профлиста", quantity: "199,1", unit: "м2", evidenceQuote: "1 Демонтаж профлиста | м2 | 199,1" },
  { workName: "Монтаж утеплителя", quantity: "56,5", unit: "м2", evidenceQuote: "2 Монтаж утеплителя | м2 | 56,5" },
];

const fetcher: BillRowsFetcher = async () => ({ rows: ROWS, hasBill: true, tokens: 100, malformed: 0, truncated: false });

/** Норму выбирает «модель»: разборке — разборку, утеплителю — изоляцию, лесам — леса. */
const normPicker: NormPicker = async (batch) => ({
  picks: batch.items.map((item) => {
    const pick = /демонтаж/iu.test(item.workName) ? "ГЭСН|46-04-010-01" : /утеплител/iu.test(item.workName) ? "ГЭСН|26-01-041-01" : /лес/iu.test(item.workName) ? "ГЭСН|08-07-001-02" : null;
    return { id: item.id, pick, demolition: false, confidence: "high" as const, reason: "по смыслу" };
  }),
  tokens: 50,
  malformed: 0,
});

const SCAFFOLD_ADDITION: RawAddition = {
  workName: "Устройство и разборка наружных трубчатых инвентарных лесов для отделочных работ",
  category: "SCAFFOLD",
  unit: "м2",
  formula: "max(#1, #2)",
  reason: "Фасадные работы на высоте более 1,8 м ведутся с лесов",
};

const proposing = (additions: readonly RawAddition[]): ImpliedProposer => vi.fn(async () => ({ additions, tokens: 200, malformed: 0 }));

function run(deps: Partial<EstimateDeps> = {}, options = NO_ESTIMATE_OPTIONS, text = TEXT) {
  return buildEstimateFromDocuments(
    {
      regNumber: "0134300025826000377",
      subject: "Ремонт утепления фасада",
      documents: [{ name: "ТЗ.docx", text }],
      parameters: makeParameters(),
      now: new Date("2026-09-28T00:00:00.000Z"),
      options,
    },
    { base: makeBase(), fetcher, normPicker, loadZoneExtras: async () => ({ splitAll: null, services: SERVICES }), ...deps },
  );
}

const itemsOf = (result: Awaited<ReturnType<typeof run>>): BillOfWorkItem[] => result.bill.sections.flatMap((section) => section.items);
const generatedOf = (result: Awaited<ReturnType<typeof run>>, kind: "AI_IMPLIED" | "DEBRIS"): BillOfWorkItem[] => itemsOf(result).filter((item) => item.generated === kind);
const lineOf = (result: Awaited<ReturnType<typeof run>>, id: string) => result.document.sections.flatMap((section) => section.lines).find((line) => line.itemId === id);

describe("мусор: строки, добавленные расчётом по нормам", () => {
  it("тоннаж по норме разборки × объём; погрузка и перевозка (51 км из документа) по ценам ФГИС ЦС, размещение без тарифа — без цены и с пробелом", async () => {
    const result = await run();

    const [load, transport, disposal] = generatedOf(result, "DEBRIS");
    expect(result.bill.sections.at(-1)?.title).toBe(GENERATED_DEBRIS_SECTION);
    // 0,867 т на 100 м2 × 1,991 = 1,726197 → 1,726 т; мусор даёт только разборка: норма утеплителя ресурса не несёт.
    expect(load).toMatchObject({ workName: "Погрузка строительного мусора", quantity: 1.726, quantityUnit: "т", generated: "DEBRIS" });
    expect(load?.sourceQuote).toContain("мусор по нормам: 1,726 т (ГЭСН 46-04-010-01 × 1,991)");
    expect(transport).toMatchObject({ workName: "Перевозка строительного мусора на 51 км", serviceCode: "02-15-1-01-0051" });
    expect(disposal).toMatchObject({ workName: "Размещение (утилизация) строительного мусора", generatedUnpricedReason: "тариф полигона не известен — укажите свою цену" });

    // Цена — сметные цены услуг зоны: 1,726 × 94,64 и 1,726 × 650.
    expect(lineOf(result, load?.id ?? "")).toMatchObject({ normBaseType: "ФГИС ЦС ПРР", normCode: "49-1", priceSource: "FGIS_SERVICE", directCost: 163.35 });
    expect(lineOf(result, transport?.id ?? "")).toMatchObject({ normBaseType: "ФГИС ЦС перевозка", normCode: "02-15-1-01-0051", directCost: 1121.9 });
    // Размещения в смете нет, а пробел называет причину словами.
    expect(lineOf(result, disposal?.id ?? "")).toBeUndefined();
    const gap = result.document.gaps.find((candidate) => candidate.message.includes("Размещение (утилизация) строительного мусора"));
    expect(gap).toMatchObject({ kind: "NO_NORM" });
    expect(gap?.message).toContain("тариф полигона не известен — укажите свою цену");

    expect(result.generated.debris).toMatchObject({ enabled: true, rows: 3, tons: 1.726, distanceKm: 51, unpriced: 1, skipped: null });
    expect(result.generated.debris.rub).toBeCloseTo(163.35 + 1121.9, 2);
  });

  it("расстояния в документах нет — перевозка добавлена без цены с пробелом «расстояние до полигона не указано», километраж не придуман", async () => {
    const result = await run({}, NO_ESTIMATE_OPTIONS);
    // Тот же расчёт, но документ без километров.
    const without = await buildEstimateFromDocuments(
      { regNumber: "R", subject: "Ремонт", documents: [{ name: "ТЗ.docx", text: TEXT.replace("на расстояние 51 км", "силами подрядчика") }], parameters: makeParameters(), now: new Date("2026-09-28T00:00:00.000Z") },
      { base: makeBase(), fetcher, normPicker, loadZoneExtras: async () => ({ splitAll: null, services: SERVICES }) },
    );
    expect(result.generated.debris.distanceKm).toBe(51);
    const transport = generatedOf(without, "DEBRIS").find((item) => item.id === "gen-debris-transport");
    expect(transport).toMatchObject({ workName: "Перевозка строительного мусора", generatedUnpricedReason: "расстояние до полигона не указано" });
    expect(lineOf(without, transport?.id ?? "")).toBeUndefined();
    expect(without.document.gaps.some((gap) => gap.message.includes("расстояние до полигона не указано"))).toBe(true);
    expect(without.generated.debris).toMatchObject({ distanceKm: null, unpriced: 2 });
  });

  it("таблиц услуг зоны нет — погрузка и перевозка тоже без цены, расчёт не падает", async () => {
    const result = await run({ loadZoneExtras: async () => ({ splitAll: null, services: null }) });
    expect(result.generated.debris.unpriced).toBe(3);
    expect(generatedOf(result, "DEBRIS").every((item) => lineOf(result, item.id) === undefined)).toBe(true);
    expect(result.document.gaps.some((gap) => gap.message.includes("таблиц сметных цен ФГИС ЦС"))).toBe(true);
  });

  it("в ведомости уже есть «Вывоз мусора» — дублей нет", async () => {
    const rows = [...ROWS, { workName: "Вывоз строительного мусора", quantity: "5", unit: "т", evidenceQuote: "3 Вывоз строительного мусора | т | 5" }];
    const result = await run({ fetcher: async () => ({ rows, hasBill: true, tokens: 1, malformed: 0, truncated: false }) }, NO_ESTIMATE_OPTIONS, `${TEXT}\n3 Вывоз строительного мусора | т | 5`);
    expect(itemsOf(result).some((item) => item.workName === "Вывоз строительного мусора")).toBe(true);
    expect(generatedOf(result, "DEBRIS")).toHaveLength(0);
    expect(result.generated.debris.skipped).toContain("в ведомости уже есть вывоз мусора");
  });

  it("опция «Добавлять вывоз строительного мусора» снята — строк нет, этап не идёт", async () => {
    const result = await run({}, { ...NO_ESTIMATE_OPTIONS, generateDebris: false });
    expect(generatedOf(result, "DEBRIS")).toHaveLength(0);
    expect(result.generated.debris).toMatchObject({ enabled: false, rows: 0, tons: 0 });
    expect(result.bill.sections.some((section) => section.title === GENERATED_DEBRIS_SECTION)).toBe(false);
  });
});

describe("работы по технологии: предложение ИИ проверено и добавлено", () => {
  it("леса: объём — формула max(#1, #2) = 199,1 м2, норма 08-07-001-02 выбрана ИИ-сметчиком; пометка, пояснение, «проверьте», деньги в смете", async () => {
    const proposer = proposing([SCAFFOLD_ADDITION]);
    const result = await run({ impliedProposer: proposer });

    const [scaffold] = generatedOf(result, "AI_IMPLIED");
    expect(result.bill.sections.some((section) => section.title === GENERATED_IMPLIED_SECTION)).toBe(true);
    expect(scaffold).toMatchObject({ generated: "AI_IMPLIED", normCode: "08-07-001-02", normBaseType: "ГЭСН", quantity: 199.1, quantityUnit: "м2", unitDivisor: 100, billSection: GENERATED_IMPLIED_SECTION });
    expect(scaffold?.generatedNote).toContain("добавлено ИИ: Фасадные работы на высоте более 1,8 м ведутся с лесов");
    expect(scaffold?.generatedNote).toContain("объём = max(#1, #2) = 199,1 м2");
    expect(scaffold?.generatedNote).toContain("#1 — «Демонтаж профлиста» 199,1 м2");
    expect(scaffold?.sourceQuote).toBe(scaffold?.generatedNote);
    expect(scaffold?.aiNormPick).toBeDefined();

    // Модель видела позиции ведомости с нормами и факты об объекте.
    const request = vi.mocked(proposer).mock.calls[0]?.[0];
    expect(request?.items.map((item) => `${item.id}:${item.name}:${item.quantity}`)).toEqual(["1:Демонтаж профлиста:199.1", "2:Монтаж утеплителя:56.5"]);
    expect(request?.items[0]?.norm).toMatchObject({ book: "ГЭСН", code: "46-04-010-01" });
    expect(request?.facts).toMatchObject({ heightM: 12, floors: 4 });

    const line = lineOf(result, scaffold?.id ?? "");
    expect(line).toMatchObject({ normCode: "08-07-001-02", billQuantity: 199.1 });
    expect((line?.directCost ?? 0) > 0).toBe(true);
    const info = result.bill.rows.find((row) => row.itemId === scaffold?.id);
    expect(info).toMatchObject({ basis: "AI", review: true });
    expect(info?.reviewReason).toContain("добавлено ИИ:");

    expect(result.generated.implied).toMatchObject({ enabled: true, proposed: 1, accepted: 1, rejected: 0, failed: 0 });
    expect(result.generated.implied.tokens).toBe(250);
    expect(result.generated.implied.rub).toBeCloseTo((line?.directCost ?? 0) + (line?.overheadCost ?? 0) + (line?.profitCost ?? 0), 1);
  });

  it("мусор считается и по нормам принятых дополнений, а строки ведомости остаются как были", async () => {
    const result = await run({ impliedProposer: proposing([SCAFFOLD_ADDITION]) });
    const original = itemsOf(result).filter((item) => item.generated === undefined);
    expect(original.map((item) => item.workName)).toEqual(["Демонтаж профлиста", "Монтаж утеплителя"]);
    expect(generatedOf(result, "DEBRIS")[0]?.quantity).toBe(1.726);
  });

  it("формула со ссылкой на несуществующую позицию отклонена: строки нет, счётчик и причина названы", async () => {
    const result = await run({ impliedProposer: proposing([{ ...SCAFFOLD_ADDITION, formula: "max(#1, #9)" }]) });
    expect(generatedOf(result, "AI_IMPLIED")).toHaveLength(0);
    expect(result.generated.implied).toMatchObject({ proposed: 1, accepted: 0, rejected: 1 });
    expect(result.generated.implied.notes.join(" ")).toContain("#9");
  });

  it("формула из чисел без ссылок и единицы разных величин отклоняются", async () => {
    const result = await run({ impliedProposer: proposing([{ ...SCAFFOLD_ADDITION, formula: "250" }, { ...SCAFFOLD_ADDITION, workName: "Защитный козырёк над входом", category: "PROTECTION", unit: "шт", formula: "#1" }]) });
    expect(generatedOf(result, "AI_IMPLIED")).toHaveLength(0);
    expect(result.generated.implied).toMatchObject({ proposed: 2, accepted: 0, rejected: 2 });
  });

  it("ИИ-сметчик не выбрал норму — строка не добавляется", async () => {
    const picksNothing: NormPicker = async (batch) => ({
      picks: batch.items.map((item) => ({ id: item.id, pick: /лес/iu.test(item.workName) ? null : /демонтаж/iu.test(item.workName) ? "ГЭСН|46-04-010-01" : null, demolition: false, confidence: "high" as const, reason: "нет" })),
      tokens: 10,
      malformed: 0,
    });
    const result = await run({ impliedProposer: proposing([SCAFFOLD_ADDITION]), normPicker: picksNothing });
    expect(generatedOf(result, "AI_IMPLIED")).toHaveLength(0);
    expect(result.generated.implied).toMatchObject({ proposed: 1, accepted: 0, rejected: 1 });
  });

  it("строка ведомости уже по той же таблице норм (08-07-001) — леса отклонены как дубль, хотя слов «леса» в её наименовании нет", async () => {
    const sameTable: NormPicker = async (batch) => ({
      picks: batch.items.map((item) => ({
        id: item.id,
        pick: /демонтаж/iu.test(item.workName) ? "ГЭСН|46-04-010-01" : /утеплител|лес/iu.test(item.workName) ? "ГЭСН|08-07-001-02" : null,
        demolition: false,
        confidence: "high" as const,
        reason: "по смыслу",
      })),
      tokens: 50,
      malformed: 0,
    });
    const result = await run({ impliedProposer: proposing([SCAFFOLD_ADDITION]), normPicker: sameTable });
    expect(generatedOf(result, "AI_IMPLIED")).toHaveLength(0);
    expect(result.generated.implied).toMatchObject({ proposed: 1, accepted: 0, rejected: 1 });
    expect(result.generated.implied.notes.join(" ")).toContain("по той же таблице норм ГЭСН 08-07-001");
  });

  it("выбрана норма постоянной конструкции (козырьки над входами) — не принято, как бы ни назвала работу модель", async () => {
    const canopyPicker: NormPicker = async (batch) => ({
      picks: batch.items.map((item) => ({
        id: item.id,
        pick: /демонтаж/iu.test(item.workName) ? "ГЭСН|46-04-010-01" : /утеплител/iu.test(item.workName) ? "ГЭСН|26-01-041-01" : /козыр/iu.test(item.workName) ? "ГЭСН|10-05-001-01" : null,
        demolition: false,
        confidence: "high" as const,
        reason: "по смыслу",
      })),
      tokens: 50,
      malformed: 0,
    });
    const addition: RawAddition = { workName: "Устройство защитного козырька над входом", category: "PROTECTION", unit: "м2", formula: "#2", reason: "Защита входа" };
    const result = await run({ impliedProposer: proposing([addition]), normPicker: canopyPicker });
    expect(generatedOf(result, "AI_IMPLIED")).toHaveLength(0);
    expect(result.generated.implied).toMatchObject({ proposed: 1, accepted: 0, rejected: 1 });
    expect(result.generated.implied.notes.join(" ")).toContain("постоянная конструкция");
  });

  it("сбой модели — не сбой расчёта: ведомость как была, failed = 1", async () => {
    const result = await run({ impliedProposer: vi.fn(async () => Promise.reject(new Error("Прод не отдал работы по технологии (HTTP 502)"))) });
    expect(generatedOf(result, "AI_IMPLIED")).toHaveLength(0);
    expect(result.generated.implied).toMatchObject({ failed: 1, accepted: 0 });
    expect(result.generated.implied.notes[0]).toContain("HTTP 502");
    expect(result.document.totals.workCost).toBeGreaterThan(0);
  });

  it("опция «Добавлять работы по технологии» снята — модель не зовётся, строк нет", async () => {
    const proposer = proposing([SCAFFOLD_ADDITION]);
    const result = await run({ impliedProposer: proposer }, { ...NO_ESTIMATE_OPTIONS, generateImplied: false });
    expect(proposer).not.toHaveBeenCalled();
    expect(generatedOf(result, "AI_IMPLIED")).toHaveLength(0);
    expect(result.generated.implied).toMatchObject({ enabled: false, proposed: 0 });
    // Мусор при этом добавляется: опции независимы.
    expect(generatedOf(result, "DEBRIS")).toHaveLength(3);
  });

  it("обе опции сняты — смета как до этих этапов: ни строк, ни вызова модели", async () => {
    const proposer = proposing([SCAFFOLD_ADDITION]);
    const result = await run({ impliedProposer: proposer }, { ...NO_ESTIMATE_OPTIONS, generateDebris: false, generateImplied: false });
    const baseline = await run({}, { ...NO_ESTIMATE_OPTIONS, generateDebris: false });
    expect(proposer).not.toHaveBeenCalled();
    expect(itemsOf(result).every((item) => item.generated === undefined)).toBe(true);
    expect(result.document.totals.workCost).toBe(baseline.document.totals.workCost);
  });

  it("без предложения работ (нет подборщика у воркера) этап пропущен с причиной; без подборщика норм — тоже", async () => {
    const withoutProposer = await run({});
    expect(withoutProposer.generated.implied).toMatchObject({ enabled: true, proposed: 0 });
    expect(withoutProposer.generated.implied.skipped).toContain("недоступно");
    const withoutPicker = await run({ impliedProposer: proposing([SCAFFOLD_ADDITION]), normPicker: undefined });
    expect(withoutPicker.generated.implied.skipped).toContain("нет подборщика норм");
    expect(generatedOf(withoutPicker, "AI_IMPLIED")).toHaveLength(0);
  });
});

describe("не для смет по ЛСР заказчика", () => {
  it("источник объёмов — смета заказчика или смета контракта: ни мусор, ни работы по технологии не добавляются, модель не зовётся", async () => {
    const proposer = proposing([SCAFFOLD_ADDITION]);
    const input = { regNumber: "R", subject: "Ремонт", documents: [{ name: "ТЗ.docx", text: TEXT }], parameters: makeParameters() };
    const item = makeBillItem({ id: "x", workName: "Демонтаж профлиста", quantity: 100, quantityUnit: "м2", unitDivisor: 100, normCode: "46-04-010-01", normBaseType: "ГЭСН" });
    for (const volumeLevel of ["CUSTOMER_ESTIMATE", "CONTRACT_ESTIMATE"] as const) {
      const out = await withGeneratedSections([{ title: "ЛСР", items: [item] }], {
        base: makeBase(),
        deps: { impliedProposer: proposer, normPicker },
        options: NO_ESTIMATE_OPTIONS,
        volumeLevel,
        input,
        services: SERVICES,
      });
      expect(out.sections).toHaveLength(1);
      expect(out.stats.debris).toMatchObject({ enabled: false, rows: 0 });
      expect(out.stats.implied).toMatchObject({ enabled: false, proposed: 0 });
      expect(out.stats.debris.skipped).toContain("смета заказчика");
    }
    expect(proposer).not.toHaveBeenCalled();

    // Тот же вход с источником «ведомость» — мусор добавляется.
    const bill = await withGeneratedSections([{ title: "ВОР", items: [item] }], { base: makeBase(), deps: {}, options: NO_ESTIMATE_OPTIONS, volumeLevel: "BILL", input, services: SERVICES });
    expect(bill.sections).toHaveLength(2);
    expect(bill.stats.debris.rows).toBe(3);
  });
});

describe("добавленные строки в таблице ведомости и правках", () => {
  const zoned = {
    priceZoneId: 282,
    priceZoneChoice: { basis: "USER" as const, matched: null, northZone: "TERRITORY" as const },
  };

  function runZoned() {
    return buildEstimateFromDocuments(
      { regNumber: "R", subject: "Ремонт утепления фасада", documents: [{ name: "ТЗ.docx", text: TEXT }], parameters: makeParameters(), now: new Date("2026-09-28T00:00:00.000Z"), ...zoned },
      { base: makeBase(), fetcher, normPicker, impliedProposer: proposing([SCAFFOLD_ADDITION]), loadZoneExtras: async () => ({ splitAll: null, services: SERVICES }) },
    );
  }

  it("подпись: «добавлено ИИ» и «добавлено расчётом (мусор)»; у строки из документа подписи нет", async () => {
    const result = await runZoned();
    const ai = generatedOf(result, "AI_IMPLIED")[0] as BillOfWorkItem;
    const debris = generatedOf(result, "DEBRIS")[0] as BillOfWorkItem;
    const original = itemsOf(result)[0] as BillOfWorkItem;
    expect(generatedBadge(ai)).toMatchObject({ text: "добавлено ИИ", tone: "mustard", note: ai.generatedNote });
    expect(generatedBadge(debris)).toMatchObject({ text: "добавлено расчётом (мусор)", tone: "accent" });
    expect(generatedBadge(original)).toBeNull();
  });

  it("строка убирается обычной правкой «удалить»: смета пересчитывается без неё, в пометках — «удалена из расчёта»; без модели", async () => {
    const result = await runZoned();
    const scaffold = generatedOf(result, "AI_IMPLIED")[0] as BillOfWorkItem;
    const load = generatedOf(result, "DEBRIS")[0] as BillOfWorkItem;
    const edits = [{ kind: "remove" as const, anchor: anchorOf(scaffold) }, { kind: "remove" as const, anchor: anchorOf(load) }];

    const applied = applyBillEdits(result.bill.sections, edits);
    expect(applied.removed.map((item) => item.id)).toEqual([scaffold.id, load.id]);
    expect(applied.sections.flatMap((section) => section.items).some((item) => item.id === scaffold.id)).toBe(false);

    const recalculated = await recalculateEstimate({ document: result.document, bill: result.bill }, edits, { base: makeBase(), loadZoneExtras: async () => ({ splitAll: null, services: SERVICES }) });
    expect(recalculated.tokensUsed).toBe(0);
    expect(recalculated.document.sections.flatMap((section) => section.lines).some((line) => line.itemId === scaffold.id)).toBe(false);
    expect(recalculated.document.totals.workCost).toBeLessThan(result.document.totals.workCost);
    expect(recalculated.applied.marks.map((mark) => mark.notes.join(" "))).toEqual(["удалена из расчёта", "удалена из расчёта"]);
  });

  it("у размещения без тарифа правка «своя цена» даёт деньги: строка идёт по цене человека, пробел снимается", async () => {
    const result = await runZoned();
    const disposal = generatedOf(result, "DEBRIS").find((item) => item.id === "gen-debris-disposal") as BillOfWorkItem;
    expect(lineOf(result, disposal.id)).toBeUndefined();
    const recalculated = await recalculateEstimate(
      { document: result.document, bill: result.bill },
      [{ kind: "price", anchor: anchorOf(disposal), unitPrice: 1000 }],
      { base: makeBase(), loadZoneExtras: async () => ({ splitAll: null, services: SERVICES }) },
    );
    const line = recalculated.document.sections.flatMap((section) => section.lines).find((candidate) => candidate.itemId === disposal.id);
    expect(line).toMatchObject({ priceSource: "OWN_PRICE", directCost: 1726 });
    expect(recalculated.document.gaps.some((gap) => gap.message.includes("Размещение (утилизация) строительного мусора"))).toBe(false);
  });

  it("отпечаток ведомости добавленных строк не учитывает: другое предложение модели не сбрасывает правки", async () => {
    const result = await runZoned();
    const withGenerated = result.bill.sections;
    const withoutGenerated = withGenerated.map((section) => ({ ...section, items: section.items.filter((item) => item.generated === undefined) })).filter((section) => section.items.length > 0);
    expect(billSignature(withGenerated)).toBe(billSignature(withoutGenerated));
  });
});
