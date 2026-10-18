import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { computeAssurance } from "@/domain/estimate/assurance";
import { estimateDocumentSchema } from "@/domain/estimate/schema";
import type { EstimateLine } from "@/domain/estimate/types";
import {
  DEFAULT_INDEX_DIR,
  loadEstimateBase,
  loadZoneAuditPrices,
  loadZoneAutoServices,
  type EstimateBase,
} from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments, type ZoneExtras } from "@/services/estimateService";
import { makeParameters } from "@/test/estimateFixtures";
import { DOCUMENTS_001 } from "@/test/volumeSourceFixtures";

/**
 * Закупка 0134600012126000001 (снос дома, зона 246 «Иркутская область (1 зона)») на реальной базе
 * зоны: перевозка 505,94 т на 47 км, погрузка мусора и гравия — нашими ценами из таблиц ФГИС ЦС,
 * ПГС — по индексу сплит-формы. Объёмы и тексты — фикстуры прошлых тестов, ответ модели подставлен.
 *
 * Тест читает настоящий индекс (нормы 185 МБ, цены зоны) и поэтому честно пропускается, если на машине
 * нет зоны 246 с таблицами перевозки (`transport-auto.jsonl`, `load-auto.jsonl`) и всех цен сплит-формы
 * (`prices-split-all.jsonl`): индекс в поставку не входит.
 */

const zoneDir = resolve(DEFAULT_INDEX_DIR, "zones/246");
const hasRealZone = [
  resolve(DEFAULT_INDEX_DIR, "norms.jsonl"),
  resolve(zoneDir, "zone.json"),
  resolve(zoneDir, "prices-split-all.jsonl"),
  resolve(zoneDir, "transport-auto.jsonl"),
  resolve(zoneDir, "load-auto.jsonl"),
].every((path) => existsSync(path));

const fetcher: BillRowsFetcher = async ({ documentName }) => ({
  rows: [...(DOCUMENTS_001.find((document) => document.name === documentName)?.rows ?? [])],
  hasBill: true,
  tokens: 0,
  malformed: 0,
  truncated: false,
});

const PARAMETERS = makeParameters({
  vatPercent: 22,
  overhead: { overheadPercent: 100, profitPercent: 65, workType: "резерв документа", source: "резерв" },
});

/** «Строительные работы» из сметы заказчика, без НДС. */
const CUSTOMER_WORKS = 1_175_228.08;

describe.skipIf(!hasRealZone)("закупка 001 на реальной базе зоны 246", () => {
  let base: EstimateBase;
  let extras: ZoneExtras;

  const calculate = (zoneExtras: ZoneExtras) =>
    buildEstimateFromDocuments(
      {
        regNumber: "0134600012126000001",
        subject: "Снос дома",
        documents: DOCUMENTS_001.map(({ name, text }) => ({ name, text })),
        parameters: PARAMETERS,
        priceZoneId: 246,
        now: new Date("2026-10-08T00:00:00.000Z"),
      },
      { base, fetcher, loadZoneExtras: async () => zoneExtras },
    );
  const lines = (result: Awaited<ReturnType<typeof calculate>>): EstimateLine[] => result.document.sections.flatMap((section) => section.lines);
  const total = (line: EstimateLine | undefined): number | undefined =>
    line === undefined ? undefined : Math.round((line.directCost + line.overheadCost + line.profitCost) * 100) / 100;

  beforeAll(async () => {
    base = await loadEstimateBase({ priceZoneId: 246 });
    extras = { splitAll: await loadZoneAuditPrices(246), services: await loadZoneAutoServices(246) };
  }, 120_000);

  it("перевозка 505,94 т × 619,94 = 313 652,44 — нашей ценой, а не заказчика, без НР и СП", async () => {
    const result = await calculate(extras);
    const transport = lines(result).find((line) => line.normCode === "02-15-1-01-0047");

    expect(transport).toMatchObject({ priceSource: "FGIS_SERVICE", normBaseType: "ФГИС ЦС перевозка", overheadCost: 0, profitCost: 0, billQuantity: 505.94 });
    expect(total(transport)).toBe(313652.44);
    expect(transport?.priceNote).toBe(
      "ФГИС ЦС, сметные цены на перевозку, Иркутская область (1 зона), 3 квартал 2026 г., код 02-15-1-01-0047",
    );
  });

  it("погрузка мусора 49-1 = 47 882,16 и погрузка гравия 42-1 = 5 254,41 — нашими ценами", async () => {
    const result = await calculate(extras);

    const debris = lines(result).find((line) => line.normCode === "49-1");
    const gravel = lines(result).find((line) => line.normCode === "42-1");
    expect(debris).toMatchObject({ priceSource: "FGIS_SERVICE", normBaseType: "ФГИС ЦС ПРР" });
    expect(total(debris)).toBe(47882.16);
    expect(gravel).toMatchObject({ priceSource: "FGIS_SERVICE" });
    expect(total(gravel)).toBe(5254.41);
    expect(debris?.resources[0]).toMatchObject({ unitPrice: 94.64, source: "FGIS_SERVICE" });
  });

  it("ПГС ФСБЦ-02.2.04.03-0013 — по индексу сплит-формы: 34,7 × 1 682,96 = 58 398,71, не база 2022", async () => {
    const result = await calculate(extras);
    const gravel = lines(result).find((line) => line.normCode === "02.2.04.03-0013");

    expect(gravel?.resources[0]).toMatchObject({ unitPrice: 1682.96, source: "SPLIT_INDEXED" });
    expect(total(gravel)).toBe(58398.71);
    expect(result.document.gaps.some((gap) => gap.kind === "NO_CURRENT_PRICE")).toBe(false);
    expect(result.document.gaps.find((gap) => gap.kind === "INDEXED_PRICE")?.message).toContain("02.2.04.03-0013");
  });

  it("по цене заказчика остаются размещение на полигоне (региональный тариф) и перевозка ПГС без километража", async () => {
    const result = await calculate(extras);
    const byCustomer = lines(result).filter((line) => line.priceSource === "CUSTOMER_PRICE");

    expect(byCustomer.map((line) => [line.normName.slice(0, 20), total(line)])).toEqual([
      ["Перевозка Грузов | к", 16378.96],
      ["Размещение (захороне", 420775.12],
    ]);
    expect(result.document.totals.customerPricedCount).toBe(2);
    expect(result.document.totals.customerPriced).toBe(437154.08);
  });

  it("итог против сметы заказчика: без допущения «база 2022», доля цен заказчика — 38,8 %", async () => {
    const result = await calculate(extras);
    const { totals } = result.document;
    const assurance = computeAssurance(result.document);

    // Объёмы и работы те же, что в смете заказчика (1 175 228,08 без НДС); расхождение — цены и нормативы расценок.
    expect(totals.workCost).toBeGreaterThan(CUSTOMER_WORKS * 0.9);
    expect(totals.workCost).toBeLessThan(CUSTOMER_WORKS * 1.1);
    expect(assurance.assumptions.map((assumption) => assumption.kind)).toEqual(["CUSTOMER_PRICE"]);
    expect(assurance.assumedPercent).toBeCloseTo((437154.08 * 100) / totals.workCost, 1);
    expect(assurance.indexedPrices?.cost).toBeGreaterThan(58398.71);
    expect(assurance.droppedPositions).toBe(0);
  });

  it("документ проходит схему целиком", async () => {
    const result = await calculate(extras);

    expect(() => estimateDocumentSchema.parse(JSON.parse(JSON.stringify(result.document)))).not.toThrow();
  });

  it("зона собрана по-старому (нет ни сплит-формы, ни таблиц): прежний результат — пять позиций по цене заказчика, ПГС по базе 2022", async () => {
    const result = await calculate({ splitAll: null, services: null });
    const byCustomer = lines(result).filter((line) => line.priceSource === "CUSTOMER_PRICE");

    expect(byCustomer.map((line) => total(line)).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([5254.41, 16378.96, 47882.16, 313652.44, 420775.12]);
    const gravel = lines(result).find((line) => line.normCode === "02.2.04.03-0013");
    expect(gravel?.resources[0]).toMatchObject({ unitPrice: 1912.45, source: "BASE_2022" });
    expect(total(gravel)).toBe(66362.02 /* 34,7 × 1 912,45 */);
    expect(computeAssurance(result.document).assumptions.map((assumption) => assumption.kind)).toEqual(["CUSTOMER_PRICE", "BASE_PRICE"]);
  });
});
