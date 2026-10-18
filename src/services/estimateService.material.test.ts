import { describe, expect, it } from "vitest";

import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { NormPicker, RawNormPick } from "@/domain/estimate/normPick";
import { RES, VOR_RESOURCES, vorBook } from "@/domain/estimate/resourceCandidates.fixtures";
import type { BillOfWorkItem, NormRecord } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import { buildEstimateFromDocuments, resolveNormFor } from "@/services/estimateService";
import { AMUR_WAGE_ANCHORS, AMUR_ZONE, NORM_MANUAL_GRADING, makeParameters, makePriceBook } from "@/test/estimateFixtures";

/**
 * Материалы ведомости (ВОР закупки 0891200000626010037) от таблицы до строки сметы: таблицу читает код, классификатор отделяет материалы от
 * работ, код собирает ресурсы-кандидаты из справочника цен, «ИИ-сметчик» (подменён) выбирает, код проверяет выбор, расчёт считает поставку.
 *
 * Норма «Установка задвижек клиновых» (ГЭСНм 12-12-001-09) лежит в базе нарочно: по словам она подходит и работе «Установка задвижек», и
 * материалу «Задвижка клиновая …» — ровно та ошибка, ради которой материалы и выделены: монтаж уже стоит строкой 13.
 */

const GATE_MOUNT: NormRecord = {
  ...NORM_MANUAL_GRADING,
  code: "12-12-001-09",
  tableCode: "12-12-001",
  fullName: "Установка задвижек клиновых с выдвижным шпинделем",
  endName: "диаметром до 100 мм",
  unit: "шт",
  baseType: "ГЭСНм",
  collectionCode: "12",
  collectionName: "Трубопроводная арматура",
};

function makeBase(): EstimateBase {
  const norms = [GATE_MOUNT];
  const resources = vorBook();
  return {
    info: {
      indexDir: "data/fsnb/index",
      builtAt: "2026-09-28T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: AMUR_ZONE.region,
      priceZone: AMUR_ZONE.zone,
      period: AMUR_ZONE.period,
      decree: "Приказ Минстроя России от 30.12.2021 № 1046/пр",
      counts: { norms: norms.length, basePrices: resources.base.size, currentPrices: resources.current.size, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    // Справочник цен — только ресурсы теста: настоящий песок «II класс» из общих фикстур сдвинул бы выбор по наименованию.
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE), { current: resources.current, base: resources.base }),
    searchIndex: createNormSearchIndex(norms),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

const VOR = [
  "Ведомость объемов работ",
  "№ п/п\tНаименование\tЕд. изм.\tКол-во",
  "10\tУстройство основания под трубопроводы: песчаного\tм3\t22,5",
  "10.1\tПесок природный для строительных работ II класс, средний\tм3\t24,75",
  "11\tУкладка стальных водопроводных труб диаметром: 75 мм Наружный диаметр трубопровода 89 мм\tкм\t0,675",
  "11.1\tТрубы стальные электросварные прямошовные из стали марок Ст2, 10, наружный диаметр 89 мм, толщина стенки 5 мм\tм\t681,75",
  "12\tУстановка фасонных частей стальных сварным соединением диаметром до 100 мм\tшт\t26",
  "12.1\tОтвод 90° с радиусом кривизны R=1,5 Ду на давление до 16 МПа\tшт\t26",
  "13\tУстановка задвижек диаметром до 100 мм\tшт\t2",
  "13.1\tЗадвижка клиновая с выдвижным шпинделем 30с41нж\tшт\t2",
  "15\tШтуцер стальной приварной, диаметр 50 мм\tшт\t4",
].join("\n");

const NO_BILL = async () => ({ rows: [], hasBill: false, tokens: 0, malformed: 0, truncated: false });

function run(normPicker?: NormPicker, text = VOR) {
  return buildEstimateFromDocuments(
    {
      regNumber: "0891200000626010037",
      subject: "Строительство водопровода",
      documents: [{ name: "ВОР.xlsx", text }],
      parameters: makeParameters(),
      now: new Date("2026-09-28T00:00:00.000Z"),
    },
    { base: makeBase(), fetcher: NO_BILL, ...(normPicker === undefined ? {} : { normPicker }) },
  );
}

type Result = Awaited<ReturnType<typeof run>>;
const itemsOf = (result: Result): BillOfWorkItem[] => result.bill.sections.flatMap((section) => section.items);
const byPosition = (result: Result, position: string): BillOfWorkItem => {
  const found = itemsOf(result).find((item) => item.positionNumber === position);
  if (found === undefined) throw new Error(`в ведомости нет позиции ${position}`);
  return found;
};
const lineOf = (result: Result, item: BillOfWorkItem) => result.document.sections.flatMap((section) => section.lines).find((line) => line.itemId === item.id);

/** Что «модель» выбирает для каждой строки-материала; работам отвечает «нормы нет». */
const TRUE_RESOURCE: readonly (readonly [RegExp, string])[] = [
  [/^Песок/u, RES.sand],
  [/^Трубы стальные/u, RES.pipe89],
  [/^Отвод/u, RES.elbow90],
  [/^Задвижка/u, RES.gate50],
  [/^Штуцер/u, RES.nipple50],
];

function picker(choose: (item: { workName: string; kind?: string }) => Partial<RawNormPick> | null, seen?: Parameters<NormPicker>[0][]): NormPicker {
  return async (batch) => {
    seen?.push(batch);
    return {
      picks: batch.items.flatMap((item) => {
        const choice = choose(item);
        return choice === null ? [] : [{ id: item.id, pick: null, demolition: false, confidence: "high" as const, reason: "причина", ...choice }];
      }),
      tokens: 700,
      malformed: 0,
    };
  };
}

const truthful = (item: { workName: string; kind?: string }): Partial<RawNormPick> => {
  if (item.kind !== "material") return { pick: null, reason: "нормы нет" };
  const code = TRUE_RESOURCE.find(([pattern]) => pattern.test(item.workName))?.[1];
  return { pick: code === undefined ? null : `РЕСУРС|${code}`, reason: "диаметр, толщина стенки и марка совпали" };
};

describe("материалы ВОР: ИИ выбирает ресурс из кандидатов, код проверяет", () => {
  it("по-прежнему: «Задвижка клиновая» без пометки материала подбирается по словам к норме монтажа ГЭСНм 12-12-001-09 — ошибка, ради которой материалы выделены", () => {
    const plain: BillOfWorkItem = { id: "x", workName: "Задвижка клиновая с выдвижным шпинделем 30с41нж", quantity: 2, quantityUnit: "шт", unitDivisor: 1, normCode: null, normBaseType: null, resourceCode: null, sourceQuote: null, sourceDocument: null };
    expect(resolveNormFor(plain, makeBase())?.norm.code).toBe("12-12-001-09");
    const material = { ...plain, materialRow: { reason: "подстрока 13.1", pick: null, review: true, coverage: null, note: "n" } } satisfies BillOfWorkItem;
    expect(resolveNormFor(material, makeBase())).toBeNull();
    // Норма, названная человеком, важнее пометки.
    expect(resolveNormFor({ ...material, normCode: "12-12-001-09", normBaseType: "ГЭСНм" }, makeBase())?.norm.code).toBe("12-12-001-09");
  });

  it("модели уходят пять материалов с кандидатами-ресурсами и без норм; работы «Установка …» — с нормами и без ресурсов", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    await run(picker(truthful, batches));
    const sent = batches.flatMap((batch) => batch.items);

    const materials = sent.filter((item) => item.kind === "material");
    expect(materials.map((item) => item.workName.split(" ")[0])).toEqual(["Песок", "Трубы", "Отвод", "Задвижка", "Штуцер"]);
    for (const item of materials) {
      expect(item.candidates).toEqual([]);
      expect(item.resources?.length).toBeGreaterThan(0);
      expect(item.resources?.length).toBeLessThanOrEqual(15);
    }
    const codesFor = (name: string) => materials.find((item) => item.workName.startsWith(name))?.resources?.map((resource) => resource.code) ?? [];
    expect(codesFor("Трубы")).toContain(RES.pipe89);
    // Та же труба с ценой за тонну не предлагается: «м» в «т» без массы метра не переводится.
    expect(codesFor("Трубы")).not.toContain(RES.pipe89PerTonne);
    expect(codesFor("Песок")).toContain(RES.sand);
    expect(codesFor("Задвижка")).toEqual(expect.arrayContaining([RES.gate50, RES.gate80]));

    const work = sent.find((item) => item.workName.startsWith("Установка задвижек"));
    expect(work?.kind).toBeUndefined();
    expect(work?.resources).toBeUndefined();
    expect(work?.candidates.some((candidate) => candidate.code === "12-12-001-09")).toBe(true);
    // Работы по другим словам нормам в базе не соответствуют и модели не уходят: уходят только две «Установка …», и ресурсов у них нет.
    const works = sent.filter((item) => item.kind !== "material");
    expect(works.map((item) => item.workName.split(" ").slice(0, 2).join(" "))).toEqual(["Установка фасонных", "Установка задвижек"]);
    expect(works.every((item) => item.resources === undefined)).toBe(true);
  });

  it("принятый выбор: resourceCode в позиции, строка сметы — поставка по цене ресурса, без труда, НР и СП", async () => {
    const result = await run(picker(truthful));

    const pipe = byPosition(result, "11.1");
    expect(pipe).toMatchObject({ resourceCode: RES.pipe89, quantity: 681.75, quantityUnit: "м" });
    expect(pipe.materialRow).toMatchObject({ pick: "AI", review: false });
    expect(pipe.materialRow?.note).toContain("материал подобран ИИ: диаметр, толщина стенки и марка совпали");

    const line = lineOf(result, pipe);
    expect(line).toMatchObject({ normCode: RES.pipe89, normBaseType: "ФСБЦ", normUnit: "м", quantity: 681.75, billQuantity: 681.75, labourCost: 0, machineCost: 0, overheadCost: 0, profitCost: 0 });
    expect(line?.directCost).toBeCloseTo(681.75 * 703.4, 2);
    expect(line?.materialCost).toBe(line?.directCost);
    expect(line?.resources[0]).toMatchObject({ code: RES.pipe89, unitPrice: 703.4, source: "CURRENT_ZONE" });

    const sand = lineOf(result, byPosition(result, "10.1"));
    expect(sand).toMatchObject({ normCode: RES.sand, normUnit: "м3", overheadCost: 0, profitCost: 0 });
    expect(sand?.directCost).toBeCloseTo(24.75 * 612, 2);
    expect(lineOf(result, byPosition(result, "12.1"))?.directCost).toBeCloseTo(26 * 1890, 2);
    expect(lineOf(result, byPosition(result, "13.1"))?.directCost).toBeCloseTo(2 * 14800, 2);
    expect(lineOf(result, byPosition(result, "15"))?.directCost).toBeCloseTo(4 * 214, 2);
  });

  it("норма монтажа задвижек одна — у работы «Установка задвижек»; строка материала нормы работы не получает", async () => {
    const result = await run(picker(truthful));
    const lines = result.document.sections.flatMap((section) => section.lines);
    const normBased = lines.filter((line) => line.normBaseType === "ГЭСНм");
    expect(normBased).toHaveLength(1);
    expect(normBased[0]?.itemId).toBe(byPosition(result, "13").id);
    expect(lineOf(result, byPosition(result, "13.1"))?.normBaseType).toBe("ФСБЦ");
  });

  it("подпись в таблице «Ведомость и нормы»: подобрано ИИ, обоснование модели, ресурс и цена", async () => {
    const result = await run(picker(truthful));
    const pipe = byPosition(result, "11.1");
    const info = result.bill.rows.find((row) => row.itemId === pipe.id);
    expect(info).toMatchObject({ basis: "AI", review: false });
    expect(info?.reviewReason).toContain("материал подобран ИИ");
    expect(info?.reviewReason).toContain(`ресурс ${RES.pipe89}`);
  });

  it("счётчики: пять материалов отправлено и принято; токены общие", async () => {
    const result = await run(picker(truthful));
    expect(result.normPick).toMatchObject({
      materialRows: 5,
      ambiguousRows: 0,
      materialRequested: 5,
      materialPicked: 5,
      materialRejected: 0,
      materialFallback: 0,
      materialUnpriced: 0,
      requested: 7,
      picked: 5,
      declined: 2,
    });
  });

  it("ответы, не прошедшие проверку: ресурс вне кандидатов, норма для материала, «нет ресурса» — строка без цены, а не чужая расценка", async () => {
    const result = await run(
      picker((item) => {
        if (item.kind !== "material") return { pick: null };
        if (item.workName.startsWith("Трубы")) return { pick: `РЕСУРС|${RES.pipe89PerTonne}`, reason: "та же труба, цена за тонну" };
        if (item.workName.startsWith("Задвижка")) return { pick: "ГЭСНм|12-12-001-09", reason: "монтаж задвижки" };
        if (item.workName.startsWith("Песок")) return { pick: null, reason: "нет ресурса с классом II" };
        return truthful(item);
      }),
    );

    for (const position of ["11.1", "13.1", "10.1"]) {
      const item = byPosition(result, position);
      expect(item.resourceCode, position).toBeNull();
      expect(item.materialRow, position).toMatchObject({ pick: null, review: true });
      expect(item.materialRow?.note, position).toContain("нет цены, проверьте");
      expect(lineOf(result, item), position).toBeUndefined();
    }
    // Задвижка: монтаж не подставлен, хотя модель его предлагала.
    expect(result.document.sections.flatMap((section) => section.lines).filter((line) => line.normBaseType === "ГЭСНм")).toHaveLength(1);
    const noPrice = result.document.gaps.filter((gap) => gap.kind === "NO_PRICE" && gap.message.includes("материал или оборудование"));
    expect(noPrice).toHaveLength(3);
    expect(noPrice.map((gap) => gap.message).join("\n")).toContain("Норма работы для материала не подбирается");

    expect(result.normPick).toMatchObject({ materialRequested: 5, materialPicked: 2, materialRejected: 2, materialUnpriced: 3, declined: 3 });
    expect(result.normPick.notes.join("\n")).toContain("вне списка кандидатов");
    expect(result.normPick.notes.join("\n")).toContain("для материала выбрана норма работы");
  });

  it("ресурс для работы не принимается: «Установка задвижек» не получит цену задвижки", async () => {
    const result = await run(picker((item) => (item.kind === "material" ? truthful(item) : { pick: `РЕСУРС|${RES.gate50}`, reason: "задвижка" })));
    const work = byPosition(result, "13");
    expect(work.resourceCode).toBeNull();
    expect(work.materialRow).toBeUndefined();
    // Обе работы «Установка …» получили в ответ ресурс — оба отклонены.
    expect(result.normPick.rejected).toBe(2);
    expect(byPosition(result, "12").resourceCode).toBeNull();
    expect(result.normPick.notes.join("\n")).toContain("ресурс для работы не принимается");
  });

  it("пачка не получена: материалы считаются запасным выбором по наименованию (явный лидер), остальные — без цены; работы — как раньше", async () => {
    const failing: NormPicker = async () => {
      throw new Error("Прод не отдал подбор норм (HTTP 502)");
    };
    const result = await run(failing);
    expect(result.normPick).toMatchObject({ failedBatches: 1, fallback: 7, materialRows: 5, materialFallback: 2, materialUnpriced: 3, materialPicked: 0 });
    expect(byPosition(result, "15")).toMatchObject({ resourceCode: RES.nipple50 });
    expect(byPosition(result, "15").materialRow).toMatchObject({ pick: "NAME", review: true });
    expect(byPosition(result, "12.1")).toMatchObject({ resourceCode: RES.elbow90 });
    // Труба («Ст2, 10» — числа «10» нет в названии), песок («II класс») и задвижка (два одинаковых Ду) без лидера: цены нет.
    for (const position of ["10.1", "11.1", "13.1"]) expect(byPosition(result, position).resourceCode, position).toBeNull();
  });

  it("модель пропустила материал — запасной выбор для него; пропущенную неясную строку и работу не трогаем", async () => {
    const result = await run(picker((item) => (item.workName.startsWith("Штуцер") ? null : truthful(item))));
    expect(result.normPick.fallback).toBe(1);
    expect(byPosition(result, "15").materialRow).toMatchObject({ pick: "NAME" });
    expect(byPosition(result, "15").resourceCode).toBe(RES.nipple50);
  });
});

describe("материалы без ИИ (подборщика нет)", () => {
  it("ресурс по наименованию только при явном лидере; остальные материалы — без цены и без нормы работы; работы не меняются", async () => {
    const result = await run();
    expect(result.normPick).toMatchObject({ requested: 0, batches: 0, tokens: 0, materialRows: 5, materialRequested: 0, materialFallback: 2, materialUnpriced: 3 });
    expect(byPosition(result, "15").resourceCode).toBe(RES.nipple50);
    expect(byPosition(result, "12.1").resourceCode).toBe(RES.elbow90);
    for (const position of ["10.1", "11.1", "13.1"]) {
      const item = byPosition(result, position);
      expect(item.resourceCode, position).toBeNull();
      expect(lineOf(result, item), position).toBeUndefined();
    }
    // Работа «Установка задвижек» по-прежнему подбирается по наименованию к норме монтажа.
    expect(lineOf(result, byPosition(result, "13"))?.normCode).toBe("12-12-001-09");
    expect(result.document.sections.flatMap((section) => section.lines).filter((line) => line.normBaseType === "ГЭСНм")).toHaveLength(1);
  });

  it("выбор по наименованию подсвечен «проверьте» и подписан: выбран кодом, без модели", async () => {
    const result = await run();
    const nipple = byPosition(result, "15");
    const info = result.bill.rows.find((row) => row.itemId === nipple.id);
    expect(info).toMatchObject({ basis: "NAME", review: true });
    expect(info?.reviewReason).toContain("без ИИ");
  });
});

describe("труба с ценой за тонну при объёме в метрах", () => {
  const MASS_VOR = [
    "Ведомость объемов работ",
    "№ п/п\tНаименование\tЕд. изм.\tКол-во\tПримечание",
    "1\tУкладка стальных водопроводных труб\tм\t100\t",
    "1.1\tТрубы стальные электросварные прямошовные, наружный диаметр 89 мм, толщина стенки 5 мм\tм\t100\tмасса 1 м — 10,36 кг",
    "2\tУстановка задвижек диаметром до 100 мм\tшт\t2\t",
  ].join("\n");
  const tonne = picker((item) => (item.kind === "material" ? { pick: `РЕСУРС|${RES.pipe89PerTonne}`, reason: "труба 89×5, цена за тонну" } : { pick: null }));

  it("масса метра названа в документе: объём пересчитывается в килограммы, считается в тоннах, строка подсвечена «проверьте»", async () => {
    const result = await run(tonne, MASS_VOR);
    const pipe = byPosition(result, "1.1");
    expect(pipe).toMatchObject({ resourceCode: RES.pipe89PerTonne, quantityUnit: "кг" });
    expect(pipe.quantity).toBeCloseTo(1036, 6);
    expect(pipe.materialRow).toMatchObject({ pick: "AI", review: true });
    expect(pipe.materialRow?.note).toContain("по массе 1 м = 10,36 кг");

    const line = lineOf(result, pipe);
    expect(line).toMatchObject({ normUnit: "т", overheadCost: 0, profitCost: 0 });
    expect(line?.quantity).toBeCloseTo(1.036, 6);
    expect(line?.directCost).toBeCloseTo(1.036 * 86000, 2);
    expect(line?.gaps.some((gap) => gap.kind === "UNIT_MISMATCH")).toBe(false);
    expect(result.normPick.materialPicked).toBe(1);
  });

  it("массы метра в документе нет: трубу за тонну модели не показывают, а выбор «из головы» отклоняется — цены нет, плотность не выдумываем", async () => {
    const seen: Parameters<NormPicker>[0][] = [];
    const withoutMass = MASS_VOR.replace("масса 1 м — 10,36 кг", "");
    const result = await run(
      async (batch) => {
        seen.push(batch);
        return tonne(batch);
      },
      withoutMass,
    );
    const resources = seen.flatMap((batch) => batch.items).find((item) => item.kind === "material")?.resources ?? [];
    expect(resources.map((resource) => resource.code)).not.toContain(RES.pipe89PerTonne);
    const pipe = byPosition(result, "1.1");
    expect(pipe.resourceCode).toBeNull();
    expect(pipe.materialRow).toMatchObject({ pick: null });
    expect(lineOf(result, pipe)).toBeUndefined();
    expect(result.normPick).toMatchObject({ materialRejected: 1, materialUnpriced: 1 });
    expect(result.normPick.notes.join("\n")).toContain("вне списка кандидатов");
  });
});

describe("справочник цен не нужен тем, кому материалов нет", () => {
  it("ВОР из одних работ: этап ничего не меняет, счётчики материалов нулевые", async () => {
    const text = ["Ведомость объемов работ", "№ п/п\tНаименование\tЕд. изм.\tКол-во", "1\tУстановка задвижек диаметром до 100 мм\tшт\t2", "2\tДемонтаж ограждения\tм\t30", "3\tРазборка покрытий\tм2\t12"].join("\n");
    const result = await run(picker(() => ({ pick: null })), text);
    expect(result.normPick).toMatchObject({ materialRows: 0, ambiguousRows: 0, materialRequested: 0, materialPicked: 0, materialUnpriced: 0 });
  });

  it("справочник ресурсов в тесте непустой", () => {
    expect(VOR_RESOURCES.length).toBeGreaterThan(10);
  });
});
