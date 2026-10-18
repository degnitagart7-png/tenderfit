import { describe, expect, it, vi } from "vitest";

import { compareWithCustomerEstimate } from "@/domain/estimate/customerComparison";
import { parseCustomerEstimates } from "@/domain/estimate/customerEstimate";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments } from "@/services/estimateService";
import { auditEstimateArithmetic, parseEstimateDocument } from "@/domain/estimate/schema";
import { computeAssurance } from "@/domain/estimate/assurance";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeParameters,
  makePriceBook,
} from "@/test/estimateFixtures";
import { hasEstimateOptions, NO_ESTIMATE_OPTIONS, normalizeEstimateOptions, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { CONTRACT_NAME, CONTRACT_TEXT, DOCUMENTS_1118, TOTALS_EX_VAT } from "@/test/t1118Fixtures";

/**
 * Связка на закупке 0302300048726001118: ЛСР заказчика → ведомость кодом → расчёт → раздел на каждую ЛСР →
 * сравнение «у заказчика / у нас» по каждой ЛСР.
 *
 * База тестовая (две нормы, цен ресурсов нет), поэтому нашей нормы и нашей цены у позиций ЛСР нет, и все они
 * входят по цене заказчика — это проверяет главное свойство ведомости из ЛСР: деньги не теряются, включая
 * оборудование, поставки и исключения материалов. Расчёт по настоящей базе — в отчёте о прогоне.
 */

const NORMS = [NORM_MANUAL_GRADING, NORM_DRAGLINE_15];
/** Зона закупки: ЛСР заказчика составлены в её уровне цен; иначе расчёт несёт пробел `PRICE_LEVEL_DIFFERS`. */
const BURYATIA = { region: "Республика Бурятия", priceZone: "Республика Бурятия (5 зона)", period: "3 квартал 2026 г." } as const;

function makeBase(): EstimateBase {
  return {
    info: {
      indexDir: "data/fsnb/index",
      builtAt: "2026-09-28T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: BURYATIA.region,
      priceZone: BURYATIA.priceZone,
      period: BURYATIA.period,
      decree: "Приказ Минстроя России от 30.12.2021 № 1046/пр",
      counts: { norms: NORMS.length, basePrices: 0, currentPrices: 0, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE), BURYATIA),
    searchIndex: createNormSearchIndex(NORMS),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

function modelNotAllowed(): BillRowsFetcher {
  return vi.fn(async () => {
    throw new Error("модель по документам с ЛСР звать нельзя");
  }) as unknown as BillRowsFetcher;
}

const run = (documents: readonly { name: string; text: string }[], options?: EstimateOptions) =>
  buildEstimateFromDocuments(
    {
      regNumber: "0302300048726001118",
      subject: "Устранение замечаний по МКП ГКШП",
      documents,
      parameters: makeParameters({ vatPercent: 22 }),
      now: new Date("2026-10-09T00:00:00.000Z"),
      ...(options === undefined ? {} : { options }),
    },
    { base: makeBase(), fetcher: modelNotAllowed() },
  );

describe("расчёт по ЛСР заказчика: раздел на каждую ЛСР", () => {
  it("разделы нашей сметы — ЛСР заказчика с номером и названием; модель не вызвана", async () => {
    const result = await run(DOCUMENTS_1118);

    const titles = result.document.sections.map((section) => section.title);
    expect(titles).toHaveLength(3);
    expect(titles.every((title) => title.startsWith("ЛСР 02-02-"))).toBe(true);
    expect(result.tokensUsed).toBe(0);
    expect(result.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(result.customerLsrs.map((entry) => entry.number).sort()).toEqual(["02-02-05/13", "02-02-08", "02-02-12"]);
  });

  it("деньги заказчика не теряются: оборудование по ТЦ, поставки и исключения входят в раздел", async () => {
    const result = await run(DOCUMENTS_1118);
    const bySection = new Map(result.document.sections.map((section) => [section.title.split(". ")[0], section.workCost]));

    expect(bySection.get("ЛСР 02-02-08")).toBeCloseTo(TOTALS_EX_VAT["02-02-08"], 0);
    expect(bySection.get("ЛСР 02-02-12")).toBeCloseTo(TOTALS_EX_VAT["02-02-12"], 0);
    expect(bySection.get("ЛСР 02-02-05/13")).toBeCloseTo(TOTALS_EX_VAT["02-02-05/13"], 0);
    // Оборудование входит по цене заказчика и помечено допущением; исключения — со знаком минус.
    const lines = result.document.sections.flatMap((section) => section.lines);
    expect(lines.some((line) => line.priceSource === "CUSTOMER_PRICE" && /Насос центробежный RV80-200\/2/.test(line.normName))).toBe(true);
    expect(lines.filter((line) => line.deduction === true)).toHaveLength(2);
  });

  it("документ проходит схему; исключения не считаются ошибкой арифметики (отрицательные затраты)", async () => {
    const result = await run(DOCUMENTS_1118);

    const problems = auditEstimateArithmetic(parseEstimateDocument(result.document));
    expect(problems.filter((problem) => problem.includes("отрицательные"))).toEqual([]);
    // Строки по цене заказчика ресурсов не несут — единственное, что сверка находит в этом документе.
    expect(problems.every((problem) => problem.startsWith("Позиция Цена заказчика"))).toBe(true);
  });

  it("сравнение по каждой ЛСР: у заказчика / у нас / разница / %", async () => {
    const result = await run(DOCUMENTS_1118);
    const comparison = compareWithCustomerEstimate(result.document, parseCustomerEstimates(DOCUMENTS_1118), result.customerLsrs);

    expect(comparison.perLsr).toHaveLength(3);
    for (const row of comparison.perLsr ?? []) {
      expect(row.ourAmount).not.toBeNull();
      expect(Math.abs(row.diffPercent ?? 100)).toBeLessThan(0.01);
      expect(row.verdict).toBe("CLOSE");
      expect(row.foundIn).toHaveLength(2);
    }
    const ventilation = comparison.perLsr?.find((row) => row.number === "02-02-08");
    expect(ventilation?.customerAmount).toBeCloseTo(TOTALS_EX_VAT["02-02-08"], 2);
    expect(ventilation?.customerPositions).toBe(27);
    expect(ventilation?.ourPositions).toBe(27);
    expect(comparison.perLsrTotal?.diffPercent).toBeCloseTo(0, 2);
  });

  it("если нашего раздела у ЛСР нет — строка сравнения говорит об этом", async () => {
    const result = await run(DOCUMENTS_1118);
    const withoutOne = { ...result.document, sections: result.document.sections.slice(1) };
    const comparison = compareWithCustomerEstimate(withoutOne, [], result.customerLsrs);

    const missing = comparison.perLsr?.filter((row) => row.verdict === "MISSING_IN_OURS") ?? [];
    expect(missing).toHaveLength(1);
    expect(missing[0]?.ourAmount).toBeNull();
    expect(comparison.perLsrTotal).not.toBeNull();
  });
});

describe("смета контракта как единственный источник — допущение в Надёжности", () => {
  it("весь расчёт держится на допущении, и это сказано", async () => {
    const result = await run([{ name: CONTRACT_NAME, text: CONTRACT_TEXT }]);
    const assurance = computeAssurance(result.document, { volumeSource: result.volumeSource });

    expect(result.volumeSource?.level).toBe("CONTRACT_ESTIMATE");
    // Позиции контракта без цен и без норм в тестовой базе: считать нечем — но допущение названо независимо от суммы.
    expect(assurance.assumptions.some((assumption) => assumption.kind === "CONTRACT_ESTIMATE_VOLUMES")).toBe(result.document.totals.workCost > 0);
  });

  it("при ЛСР допущения о смете контракта нет: она только сверка", async () => {
    const result = await run(DOCUMENTS_1118);
    const assurance = computeAssurance(result.document, { volumeSource: result.volumeSource });

    expect(assurance.assumptions.some((assumption) => assumption.kind === "CONTRACT_ESTIMATE_VOLUMES")).toBe(false);
  });
});

describe("коэффициенты заказчика: переключатель «Применять коэффициенты заказчика»", () => {
  const confirmedItems = (result: Awaited<ReturnType<typeof run>>) =>
    result.bill.sections.flatMap((section) => section.items).filter((item) => item.customerConditions?.confirmed != null);

  it("по умолчанию включено: подтверждённые коэффициенты применяются, источник называет сколько позиций", async () => {
    const result = await run(DOCUMENTS_1118);

    expect(confirmedItems(result)).toHaveLength(7);
    expect(confirmedItems(result).every((item) => item.customerConditions?.enabled === true)).toBe(true);
    const notes = result.volumeSource?.details ?? [];
    expect(notes.some((line) => line.startsWith("ЛСР 02-02-08: коэффициенты заказчика применены к 6 из 27 позиций"))).toBe(true);
    expect(notes.some((line) => line.includes("не подтверждается приложением 10"))).toBe(true);
  });

  it("снято: у всех позиций enabled = false, источник говорит об этом", async () => {
    const result = await run(DOCUMENTS_1118, { ...NO_ESTIMATE_OPTIONS, applyCustomerCoefficients: false });

    expect(confirmedItems(result).every((item) => item.customerConditions?.enabled === false)).toBe(true);
    const notes = result.volumeSource?.details ?? [];
    expect(notes).toContain("Применение коэффициентов заказчика отключено в «Условиях работ»: расчёт по нормам без его коэффициентов");
    expect(notes.some((line) => line.includes("применены к"))).toBe(false);
  });

  it("настройка хранится и передаётся воркеру только в снятом виде", () => {
    expect(hasEstimateOptions(NO_ESTIMATE_OPTIONS)).toBe(false);
    expect(hasEstimateOptions({ ...NO_ESTIMATE_OPTIONS, applyCustomerCoefficients: false })).toBe(true);
    expect(normalizeEstimateOptions({ applyCustomerCoefficients: false }).applyCustomerCoefficients).toBe(false);
    expect(normalizeEstimateOptions({ applyCustomerCoefficients: true }).applyCustomerCoefficients).toBeUndefined();
  });
});
