import { describe, expect, it } from "vitest";

import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import {
  buildEstimateFromDocuments,
  EstimatePriceLevelError,
} from "@/services/estimateService";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeParameters,
  makePriceBook,
} from "@/test/estimateFixtures";

/**
 * Проверяется связка, а не арифметика: расчёт и извлечение ведомости покрыты
 * своими тестами. Здесь важно, что позиция доезжает от текста документа до
 * строки сметы и что делитель единиц назначается по единице найденной нормы.
 */

const NORMS = [NORM_MANUAL_GRADING, NORM_DRAGLINE_15];

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
      counts: {
        norms: NORMS.length,
        basePrices: 0,
        currentPrices: 0,
        wages: 0,
        zones: 1,
      },
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

/** Модель, отвечающая заранее заданными строками ведомости. */
function fetcherFor(
  rows: readonly Record<string, unknown>[],
): BillRowsFetcher {
  return async () => ({
    rows: rows.map((row) => ({
      workName: String(row["work_name"]),
      quantity: row["quantity"] as string,
      unit: String(row["unit"]),
      evidenceQuote: String(row["evidence_quote"]),
      quantityQuote: row["quantity_quote"] as string | undefined,
    })),
    hasBill: true,
    tokens: 100,
    malformed: 0,
    truncated: false,
  });
}

const TEXT = [
  "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
  "1 Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
  "2 Планировка площадей ручным способом | м2 | 450",
].join("\n");

async function run(rows: readonly Record<string, unknown>[]) {
  return buildEstimateFromDocuments(
    {
      regNumber: "32616404800",
      subject: "Реконструкция запорных колодцев",
      documents: [{ name: "ВОР.docx", text: TEXT }],
      parameters: makeParameters(),
      now: new Date("2026-09-28T00:00:00.000Z"),
    },
    { base: makeBase(), fetcher: fetcherFor(rows) },
  );
}

describe("buildEstimateFromDocuments", () => {
  it("доводит позицию от текста документа до строки сметы", async () => {
    const result = await run([
      {
        work_name: "Разработка грунта в отвал экскаваторами",
        quantity: "1,2405",
        unit: "1000 м3",
        evidence_quote:
          "Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
      },
    ]);

    expect(result.billItems).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(result.document.sections[0]?.lines).toHaveLength(1);
    expect(result.document.totals.workCost).toBeGreaterThan(0);
  });

  it("раздел сметы называется именем документа: по нему проверяют", async () => {
    const result = await run([
      {
        work_name: "Разработка грунта в отвал экскаваторами",
        quantity: "1,2405",
        unit: "1000 м3",
        evidence_quote:
          "Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
      },
    ]);

    expect(result.document.sections[0]?.title).toBe("ВОР.docx");
  });

  it("неподтверждённую строку в смету не пускает", async () => {
    const result = await run([
      {
        work_name: "Монтаж металлоконструкций",
        quantity: "42",
        unit: "т",
        evidence_quote: "Монтаж металлоконструкций | т | 42",
      },
    ]);

    expect(result.billItems).toBe(0);
    expect(result.rejected[0]?.reason).toBe("QUOTE_NOT_FOUND");
    expect(result.document.sections).toEqual([]);
  });

  it("оговорка уезжает внутри документа, а не остаётся на экране", async () => {
    const result = await run([
      {
        work_name: "Разработка грунта в отвал экскаваторами",
        quantity: "1,2405",
        unit: "1000 м3",
        evidence_quote:
          "Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
      },
    ]);

    expect(result.document.disclaimer).toContain("не является сметной");
    expect(result.document.disclaimer).toContain("требуют проверки");
  });

  it("считает потраченные токены модели", async () => {
    const result = await run([
      {
        work_name: "Разработка грунта в отвал экскаваторами",
        quantity: "1,2405",
        unit: "1000 м3",
        evidence_quote:
          "Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
      },
    ]);

    expect(result.tokensUsed).toBe(100);
  });
});

/**
 * Документ, объявивший свой уровень цен, обязан совпасть с индексом.
 *
 * На живом прогоне смета 02-01-02-КМ1 была посчитана сметчиком по 2 зоне за
 * 1 квартал 2026, а индекс нёс 1 зону за 3 квартал 2026. Расчёт прошёл молча и
 * выдал внутренне верную смету, сравнивать которую с приложенной нельзя:
 * расходятся цены каждого ресурса.
 *
 * Отказ идёт до вызова модели: считать в чужом уровне всё равно не выйдет, а
 * токены за извлечение ведомости платные.
 */
describe("уровень цен документа", () => {
  const LEVELLED = [
    "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЁТ № 02-01-02-КМ1",
    "Амурская область (2 зона), цены на 1 квартал 2026 года",
    "1 Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
  ].join("\n");

  it("зона и квартал документа расходятся с индексом — расчёт отказывает", async () => {
    await expect(
      buildEstimateFromDocuments(
        {
          regNumber: "32616404800",
          subject: "Строительство АБК",
          documents: [{ name: "Смета.csv", text: LEVELLED }],
          parameters: makeParameters(),
        },
        { base: makeBase(), fetcher: fetcherFor([]) },
      ),
    ).rejects.toThrow(EstimatePriceLevelError);
  });

  it("отказ называет оба уровня цен", async () => {
    const error = await buildEstimateFromDocuments(
      {
        regNumber: "32616404800",
        subject: "Строительство АБК",
        documents: [{ name: "Смета.csv", text: LEVELLED }],
        parameters: makeParameters(),
      },
      { base: makeBase(), fetcher: fetcherFor([]) },
    ).catch((thrown: unknown) => thrown);

    expect(String(error)).toContain("2 зона");
    expect(String(error)).toContain(AMUR_ZONE.zone);
    expect(String(error)).toContain("1 квартал 2026");
  });

  it("модель не вызывается: за отказ токены не платятся", async () => {
    let called = 0;
    const counting: BillRowsFetcher = async (request) => {
      called += 1;
      return fetcherFor([])(request);
    };

    await buildEstimateFromDocuments(
      {
        regNumber: "32616404800",
        subject: "Строительство АБК",
        documents: [{ name: "Смета.csv", text: LEVELLED }],
        parameters: makeParameters(),
      },
      { base: makeBase(), fetcher: counting },
    ).catch(() => undefined);

    expect(called).toBe(0);
  });

  it("документ об уровне цен молчит — расчёт идёт как прежде", async () => {
    const result = await run([
      {
        work_name: "Разработка грунта в отвал экскаваторами",
        quantity: "1,2405",
        unit: "1000 м3",
        evidence_quote: "Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
      },
    ]);

    expect(result.billItems).toBe(1);
  });
});
