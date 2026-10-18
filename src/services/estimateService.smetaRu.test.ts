import { describe, expect, it, vi } from "vitest";

import { compareWithCustomerEstimate } from "@/domain/estimate/customerComparison";
import { parseCustomerEstimates } from "@/domain/estimate/customerEstimate";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments } from "@/services/estimateService";
import { AMUR_WAGE_ANCHORS, AMUR_ZONE, NORM_DRAGLINE_15, NORM_MANUAL_GRADING, makeParameters, makePriceBook } from "@/test/estimateFixtures";
import {
  RIM_DEMOLITION_NAME,
  RIM_DEMOLITION_TEXT,
  RIM_DEMOLITION_TOTALS,
  RIM_SUPPLY_NAME,
  RIM_SUPPLY_TEXT,
  TSN_2001_NAME,
  TSN_2001_TEXT,
} from "@/test/smetaRuFixtures";

/**
 * Связка на выгрузках Smeta.RU: ЛСР заказчика → ведомость кодом → расчёт → раздел на каждую ЛСР → сравнение по каждой ЛСР.
 *
 * База тестовая (две нормы), поэтому у позиций ресурсно-индексной сметы нашей нормы и цены нет и они входят по цене заказчика — деньги не
 * теряются. Смета по ТСН-2001 Москвы несёт одну пометку документа о другой базе норм; позиции без уверенного подбора по наименованию идут
 * по цене заказчика и помечены «проверьте».
 */

const NORMS = [NORM_MANUAL_GRADING, NORM_DRAGLINE_15];
const ZONE = { region: "город Москва", priceZone: "город Москва (1 зона)", period: "3 квартал 2026 г." } as const;

function makeBase(): EstimateBase {
  return {
    info: {
      indexDir: "data/fsnb/index",
      builtAt: "2026-10-01T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: ZONE.region,
      priceZone: ZONE.priceZone,
      period: ZONE.period,
      decree: "Приказ Минстроя России от 30.12.2021 № 1046/пр",
      counts: { norms: NORMS.length, basePrices: 0, currentPrices: 0, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE), ZONE),
    searchIndex: createNormSearchIndex(NORMS),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

const modelNotAllowed = (): BillRowsFetcher =>
  vi.fn(async () => {
    throw new Error("модель по документам с ЛСР звать нельзя");
  }) as unknown as BillRowsFetcher;

const run = (documents: readonly { name: string; text: string }[]) =>
  buildEstimateFromDocuments(
    {
      regNumber: "32616406367",
      subject: "Реконструкция выносного РП-10кВ",
      documents,
      parameters: makeParameters({ vatPercent: 22 }),
      now: new Date("2026-10-10T00:00:00.000Z"),
    },
    { base: makeBase(), fetcher: modelNotAllowed() },
  );

const baseGaps = (result: Awaited<ReturnType<typeof run>>) => result.document.gaps.filter((gap) => gap.kind === "CUSTOMER_BASE_DIFFERS");

describe("расчёт по ЛСР Smeta.RU (ресурсно-индексный метод)", () => {
  it("раздел на ЛСР; деньги заказчика не теряются: сумма раздела — итог сметы без НДС; пометки о другой базе нет", async () => {
    const result = await run([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }]);

    expect(result.tokensUsed).toBe(0);
    expect(result.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(result.document.sections).toHaveLength(1);
    expect(result.document.sections[0]?.workCost).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 0);
    expect(result.customerLsrs[0]?.totalExVat).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
    expect(baseGaps(result)).toEqual([]);
    expect(result.customerLsrs[0]?.base).toBeUndefined();
  });

  it("сравнение по ЛСР: у заказчика 63 235,86 ₽ без НДС (не за вычетом НДС), у нас то же", async () => {
    const documents = [{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }];
    const result = await run(documents);
    const comparison = compareWithCustomerEstimate(result.document, parseCustomerEstimates(documents), result.customerLsrs);

    const [row] = comparison.perLsr ?? [];
    expect(row?.customerAmount).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
    expect(row?.customerPositions).toBe(8);
    expect(Math.abs(row?.diffPercent ?? 100)).toBeLessThan(0.01);
    expect(row?.verdict).toBe("CLOSE");
  });

  it("другая ресурсная смета Smeta.RU: остаток позиций по подстрокам входит в раздел, итог сходится", async () => {
    const result = await run([{ name: RIM_SUPPLY_NAME, text: RIM_SUPPLY_TEXT }]);
    expect(result.document.sections[0]?.workCost).toBeCloseTo(503_149.79, 0);
  });
});

describe("расчёт по смете ТСН-2001 Москвы", () => {
  const documents = [{ name: TSN_2001_NAME, text: TSN_2001_TEXT }];

  it("позиции, объёмы и итоги читаются: два раздела, итоги — в текущем уровне цен; модель не вызвана", async () => {
    const result = await run(documents);

    expect(result.tokensUsed).toBe(0);
    expect(result.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(result.customerLsrs.map((entry) => entry.number)).toEqual(["02-01-01", "09-01-01"]);
    expect(result.customerLsrs.map((entry) => entry.base)).toEqual(["TSN_2001_MOSCOW", "TSN_2001_MOSCOW"]);
    expect(result.customerLsrs.map((entry) => entry.totalExVat)).toEqual([2_995_912.9, 200_277]);
    expect(result.document.sections).toHaveLength(2);
    expect(result.billItems).toBe(4);
  });

  it("одна пометка документа: смета заказчика в ТСН-2001 Москвы, наша — ФСНБ-2022, построчное сравнение норм не like-for-like", async () => {
    const result = await run(documents);

    const gaps = baseGaps(result);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.message).toContain("ТСН-2001 (Москва)");
    expect(gaps[0]?.message).toContain("ФСНБ-2022");
    expect(gaps[0]?.message).toContain("like-for-like");
    expect(gaps[0]?.code).toBeNull();
  });

  it("случайного ГЭСН по шифру нет: норм ТСН у нас нет, уверенного подбора по наименованию тоже — позиции по цене заказчика, помечены «проверьте»", async () => {
    const result = await run(documents);

    const lines = result.document.sections.flatMap((section) => section.lines);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.priceSource === "CUSTOMER_PRICE")).toBe(true);
    expect(lines.some((line) => line.normBaseType === "ГЭСН")).toBe(false);
    const sum = lines.reduce((total, line) => total + line.directCost + line.overheadCost + line.profitCost, 0);
    expect(sum).toBeCloseTo(2_995_912.9 + 200_277, 0);
    const reviewed = result.bill.rows.filter((row) => row.review);
    expect(reviewed).toHaveLength(4);
  });

  it("сравнение по каждой ЛСР: итог заказчика — в текущем уровне цен без НДС (у ТСН его нет), разница с нашим расчётом нулевая", async () => {
    const result = await run(documents);
    const comparison = compareWithCustomerEstimate(result.document, parseCustomerEstimates(documents), result.customerLsrs);

    expect(comparison.perLsr?.map((row) => row.customerAmount)).toEqual([2_995_912.9, 200_277]);
    for (const row of comparison.perLsr ?? []) {
      expect(Math.abs(row.diffPercent ?? 100)).toBeLessThan(0.01);
      expect(row.verdict).toBe("CLOSE");
    }
    // По разделам такая смета не сравнивается: база не наша.
    expect(comparison.status).toBe("BASE_PRICES_ONLY");
    expect(comparison.baseEstimates).toHaveLength(2);
  });

  it("позиция ТСН с наименованием, уверенно найденным в нашей базе, считается нормой по наименованию и помечена «проверьте» — шифр ТСН при этом не читается", async () => {
    const renamed = TSN_2001_TEXT.replace(
      "1,4.8-61-4,Монтаж сборной камеры распределительных устройств с выключателем нагрузки серии КСО,1  ШТ.,1,",
      '1,13-02-004-01,"Планировка вручную: дна и откосов выемок каналов, группа грунтов 1",1000  М2,1,',
    );
    expect(renamed).not.toBe(TSN_2001_TEXT);
    const result = await run([{ name: TSN_2001_NAME, text: renamed }]);

    const line = result.document.sections.flatMap((section) => section.lines).find((candidate) => candidate.normCode === NORM_MANUAL_GRADING.code);
    expect(line).toBeDefined();
    expect(line?.priceSource).toBeUndefined();
    expect(result.normHints).toEqual([]);
    const row = result.bill.rows.find((candidate) => candidate.itemId === line?.itemId);
    expect(row).toMatchObject({ basis: "NAME", review: true });
    expect(row?.reviewReason).toContain("ТСН-2001 (Москва)");
    expect(baseGaps(result)).toHaveLength(1);
  });
});
