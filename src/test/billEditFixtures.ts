import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { NormRecord } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments } from "@/services/estimateService";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAGLINE_15,
  NORM_DRAINAGE_100,
  NORM_MANUAL_GRADING,
  makeParameters,
  makePriceBook,
} from "@/test/estimateFixtures";

/**
 * Данные тестов правки ведомости: нормы с настоящими ресурсами (чтобы стоимость была ненулевой и
 * отличалась у разных норм) и документ, из которого модель «извлекает» три позиции.
 *
 * Нормы «Демонтаж опалубки наружных стен» и «Разборка кирпичных наружных стен» — копии настоящих
 * норм из фикстур с другим названием и единицей: их цена различается, поэтому смена нормы видна
 * в итоге. Первая — ловушка подбора («Демонтаж наружных стен» → опалубка).
 */

export const WRONG_NORM: NormRecord = {
  ...NORM_DRAGLINE_15,
  code: "06-01-001-01",
  tableCode: "06-01-001",
  fullName: "Демонтаж опалубки наружных стен",
  endName: "Демонтаж опалубки наружных стен",
  unit: "100 м2",
  collectionCode: "06",
  collectionName: "Бетонные и железобетонные конструкции монолитные",
};

export const RIGHT_NORM: NormRecord = {
  ...NORM_DRAINAGE_100,
  code: "46-04-010-01",
  tableCode: "46-04-010",
  fullName: "Разборка кирпичных наружных стен",
  endName: "Разборка кирпичных наружных стен",
  unit: "100 м2",
  collectionCode: "46",
  collectionName: "Работы при реконструкции зданий и сооружений",
};

export const NORMS: readonly NormRecord[] = [NORM_MANUAL_GRADING, NORM_DRAGLINE_15, WRONG_NORM, RIGHT_NORM];

export function makeEditBase(): EstimateBase {
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

export const EDIT_DOC_TEXT = [
  "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
  "1 | Демонтаж наружных стен | м2 | 120",
  "2 | Планировка вручную дна и откосов выемок каналов | м2 | 800",
  "3 | Разработка грунта экскаваторами драглайн | 1000 м3 | 1,2",
  "4 | Монтаж ограждения | пм | 15",
  "5 | Разработка грунта и планировка откосов | м3 | 300",
].join("\n");

const ROWS = [
  { workName: "Демонтаж наружных стен", quantity: "120", unit: "м2", evidenceQuote: "1 | Демонтаж наружных стен | м2 | 120" },
  {
    workName: "Планировка вручную дна и откосов выемок каналов",
    quantity: "800",
    unit: "м2",
    evidenceQuote: "2 | Планировка вручную дна и откосов выемок каналов | м2 | 800",
  },
  {
    workName: "Разработка грунта экскаваторами драглайн",
    quantity: "1,2",
    unit: "1000 м3",
    evidenceQuote: "3 | Разработка грунта экскаваторами драглайн | 1000 м3 | 1,2",
  },
  {
    workName: "Монтаж ограждения",
    quantity: "15",
    unit: "пм",
    evidenceQuote: "4 | Монтаж ограждения | пм | 15",
  },
  {
    workName: "Разработка грунта и планировка откосов",
    quantity: "300",
    unit: "м3",
    evidenceQuote: "5 | Разработка грунта и планировка откосов | м3 | 300",
  },
];

/** Счётчик обращений к «модели»: пересчёт обязан оставить его неизменным. */
export const modelCalls = { count: 0 };

export const editFetcher: BillRowsFetcher = async () => {
  modelCalls.count += 1;
  return { rows: ROWS, hasBill: true, tokens: 100, malformed: 0, truncated: false };
};

/** Расчёт «воркера»: результат с ведомостью, из которой правят и пересчитывают. */
export async function buildEditResult(base: EstimateBase = makeEditBase()) {
  return buildEstimateFromDocuments(
    {
      regNumber: "0123",
      subject: "Реконструкция",
      documents: [{ name: "ВОР.docx", text: EDIT_DOC_TEXT }],
      parameters: makeParameters(),
      priceZoneId: 282,
      priceZoneChoice: { basis: "USER", matched: null, northZone: "TERRITORY" },
      now: new Date("2026-09-28T00:00:00.000Z"),
    },
    { base, fetcher: editFetcher },
  );
}
