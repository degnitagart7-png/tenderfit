import { describe, expect, it } from "vitest";

import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { buildEstimateFromDocuments } from "@/services/estimateService";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { parseEstimateDocument } from "@/domain/estimate/schema";
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

  describe("документы без объёмов", () => {
    /** Модель прочитала документ и ведомости в нём не нашла. */
    const noBillFetcher: BillRowsFetcher = async () => ({
      rows: [],
      hasBill: false,
      tokens: 10,
      malformed: 0,
      truncated: false,
    });

    const spec = {
      name: "Техническое задание.docx",
      text: "Техническое задание на выполнение работ по реконструкции колодцев. Работы выполнить в соответствии с проектом.",
    };

    it("пустая смета несёт пробел с тем, что просмотрено и что делать", async () => {
      const result = await buildEstimateFromDocuments(
        {
          regNumber: "32616404800",
          subject: "Реконструкция запорных колодцев",
          documents: [spec],
          parameters: makeParameters(),
          now: new Date("2026-09-28T00:00:00.000Z"),
        },
        { base: makeBase(), fetcher: noBillFetcher },
      );

      expect(result.billItems).toBe(0);
      expect(result.volumeSource).toBeNull();
      const gap = result.document.gaps.find((item) => item.kind === "NO_VOLUME_SOURCE");
      expect(gap).toBeDefined();
      expect(gap?.message).toContain("Просмотрено 1 документ.");
      expect(gap?.message).toContain("«Техническое задание.docx»");
      expect(gap?.message).toContain("ВОР, дефектную ведомость или смету заказчика");
      expect(gap?.message).toContain(".gsfx");
      // Документ с таким пробелом проходит схему, по которой сметы читаются из базы.
      expect(() => parseEstimateDocument(JSON.parse(JSON.stringify(result.document)))).not.toThrow();
    });

    it("смета с позициями пробела не получает", async () => {
      const result = await run([
        {
          work_name: "Разработка грунта в отвал экскаваторами",
          quantity: "1,2405",
          unit: "1000 м3",
          evidence_quote: "Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
        },
      ]);

      expect(result.document.gaps.some((item) => item.kind === "NO_VOLUME_SOURCE")).toBe(false);
    });

    it("все строки модели отвергнуты проверкой цитат — подтверждённых объёмов нет, пробел есть, отказы названы отдельно", async () => {
      const result = await run([
        { work_name: "Монтаж металлоконструкций", quantity: "42", unit: "т", evidence_quote: "Монтаж металлоконструкций | т | 42" },
      ]);

      expect(result.billItems).toBe(0);
      expect(result.rejected[0]?.reason).toBe("QUOTE_NOT_FOUND");
      expect(result.document.gaps.some((item) => item.kind === "NO_VOLUME_SOURCE")).toBe(true);
    });
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
 * Уровень цен заказчика и наш: расхождение — пробел документа, а не отказ.
 *
 * На живом прогоне смета 02-01-02-КМ1 была посчитана сметчиком по 2 зоне за 1 квартал 2026, а индекс нёс 1 зону за
 * 3 квартал 2026. Расчёт тогда отказывал, но отказ срабатывал и от случайной фразы договора («работы выполняются в
 * IV квартале 2026»), а сметы заказчика в более раннем квартале (мы собираем только последний) делали функцию
 * непригодной. Теперь расчёт идёт в нашем уровне цен, а расхождение с ЛСР заказчика (только шапка) названо в пробелах.
 */
describe("уровень цен документа", () => {
  const ROW = {
    work_name: "Разработка грунта в отвал экскаваторами",
    quantity: "1,2405",
    unit: "1000 м3",
    evidence_quote: "Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
  };

  /** Шапка ЛСР (форма 421/пр) и строка ведомости, которую найдёт модель. */
  const lsr = (zone: string, quarter: string): string =>
    [
      "Наименование субъекта Российской Федерации ,,,,,,28. Амурская область,,,",
      `Наименование зоны субъекта Российской Федерации ,,,,,,${zone},,,`,
      "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01-02-КМ1,,,,,,,,,,,,,,,",
      `Составлен(а) в текущем уровне цен ,,${quarter},,,,,,,,,,,,,`,
      "№ п/п,Обоснование,Наименование работ и затрат",
      "1 Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
    ].join("\n");

  const calc = (text: string) =>
    buildEstimateFromDocuments(
      {
        regNumber: "32616404800",
        subject: "Строительство АБК",
        documents: [{ name: "Смета.csv", text }],
        parameters: makeParameters(),
        now: new Date("2026-09-28T00:00:00.000Z"),
      },
      { base: makeBase(), fetcher: fetcherFor([ROW]) },
    );

  const levelGaps = (result: Awaited<ReturnType<typeof calc>>) => result.document.gaps.filter((gap) => gap.kind === "PRICE_LEVEL_DIFFERS");

  it("договор с «IV квартале 2026» и «1 зона», сметы заказчика нет — не отказ и не пробел", async () => {
    const result = await calc(
      [
        "Работы выполняются в IV квартале 2026 года, цены 2 зона.",
        "Санитарно-защитная 1 зона, срок — 1 квартал 2027.",
        "1 Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
      ].join("\n"),
    );

    expect(result.billItems).toBe(1);
    expect(levelGaps(result)).toEqual([]);
  });

  it("ЛСР заказчика совпала с нашим уровнем — пробела нет", async () => {
    const result = await calc(lsr("Амурская область (1 зона)", "III квартал 2026 года"));

    expect(result.billItems).toBe(1);
    expect(levelGaps(result)).toEqual([]);
  });

  it("ЛСР в II квартале 2026, цены у нас на 3 квартал — пробел PRICE_LEVEL_DIFFERS, смета посчитана", async () => {
    const result = await calc(lsr("Амурская область (1 зона)", "II квартал 2026 года"));

    expect(result.billItems).toBe(1);
    expect(result.document.totals.workCost).toBeGreaterThan(0);
    // Новый вид пробела проходит схему документа.
    expect(() => parseEstimateDocument(result.document)).not.toThrow();
    expect(levelGaps(result).map((gap) => gap.message)).toEqual([
      "Смета заказчика составлена в уровне цен II квартала 2026 г., наш расчёт — в уровне 3 квартала 2026 г.: " +
        "цены ресурсов различаются на индексацию между кварталами, построчное сравнение цен неточно.",
    ]);
  });

  it("ЛСР в зоне 2, наш расчёт в зоне 1 — пробел называет обе зоны, смета посчитана", async () => {
    const result = await calc(lsr("Амурская область (2 зона)", "III квартал 2026 года"));

    expect(result.billItems).toBe(1);
    const [gap, ...rest] = levelGaps(result);
    expect(rest).toEqual([]);
    expect(gap?.message).toContain("«Амурская область (2 зона)»");
    expect(gap?.message).toContain(`«${AMUR_ZONE.zone}»`);
    expect(gap?.message).toContain("не равнозначно");
  });

  it("OCR «lil квартал 2026» читается как III: наш уровень, пробела нет", async () => {
    const result = await calc(lsr("Амурская область (1 зона)", "lil квартал 2026 года"));

    expect(levelGaps(result)).toEqual([]);
  });

  it("модель вызывается: отказа до извлечения ведомости больше нет", async () => {
    let called = 0;
    const counting: BillRowsFetcher = async (request) => {
      called += 1;
      return fetcherFor([ROW])(request);
    };

    await buildEstimateFromDocuments(
      {
        regNumber: "32616404800",
        subject: "Строительство АБК",
        documents: [{ name: "Смета.csv", text: lsr("Амурская область (2 зона)", "I квартал 2026 года") }],
        parameters: makeParameters(),
      },
      { base: makeBase(), fetcher: counting },
    );

    expect(called).toBe(1);
  });

  it("зона из сметы заказчика отвергнута при выборе — причина идёт в пробелы документа", async () => {
    const result = await buildEstimateFromDocuments(
      {
        regNumber: "1",
        subject: "Объект",
        documents: [{ name: "ВОР.docx", text: TEXT }],
        parameters: makeParameters(),
        priceZoneId: 282,
        priceZoneChoice: {
          basis: "CAPITAL",
          matched: "Благовещенск",
          northZone: "TERRITORY",
          notes: ["Зона из сметы заказчика «Иркутская область (1 зона)» не использована: её субъект не совпадает с регионом закупки."],
        },
        now: new Date("2026-09-28T00:00:00.000Z"),
      },
      { base: makeBase(), fetcher: fetcherFor([ROW]) },
    );

    expect(levelGaps(result).map((gap) => gap.message)).toEqual([
      "Зона из сметы заказчика «Иркутская область (1 зона)» не использована: её субъект не совпадает с регионом закупки.",
    ]);
  });
});

describe("buildEstimateFromDocuments: ценовая зона", () => {
  const rows = [
    {
      work_name: "Планировка площадей ручным способом",
      quantity: "450",
      unit: "м2",
      evidence_quote: "Планировка площадей ручным способом | м2 | 450",
    },
  ];

  it("основание выбора зоны попадает в документ сметы", async () => {
    const result = await buildEstimateFromDocuments(
      {
        regNumber: "1",
        subject: "Объект",
        documents: [{ name: "ВОР.docx", text: TEXT }],
        parameters: makeParameters(),
        priceZoneId: 282,
        priceZoneChoice: { basis: "MUNICIPALITY", matched: "Кабанский р-н", northZone: "TERRITORY" },
        now: new Date("2026-09-28T00:00:00.000Z"),
      },
      { base: makeBase(), fetcher: fetcherFor(rows) },
    );

    expect(result.document.priceZoneChoice).toEqual({ basis: "MUNICIPALITY", matched: "Кабанский р-н" });
    expect(result.document.priceZone).toBe(AMUR_ZONE.zone);
  });

  it("без основания документ его не несёт: старые вызовы не меняются", async () => {
    const result = await run(rows);
    expect(result.document.priceZoneChoice).toBeUndefined();
  });

  it("ЛСР сверяется с уровнем цен выбранной зоны, а не какой-то другой: другая зона — пробел, не отказ", async () => {
    const base = makeBase();
    const buryatia = {
      ...base,
      priceBook: { ...base.priceBook, priceZone: "Республика Бурятия (5 зона)" },
    };

    const result = await buildEstimateFromDocuments(
      {
        regNumber: "1",
        subject: "Объект",
        // ЛСР посчитана по 2 зоне, а выбрана 5 зона: считаем в выбранной, расхождение называем.
        documents: [
          {
            name: "Смета.docx",
            text: [
              "Наименование зоны субъекта Российской Федерации ,,Республика Бурятия (2 зона)",
              "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 1",
              "Составлен(а) в текущем уровне цен ,,III квартал 2026 года",
              "№ п/п",
              TEXT,
            ].join("\n"),
          },
        ],
        parameters: makeParameters(),
        priceZoneId: 236,
      },
      { base: buryatia, fetcher: fetcherFor(rows) },
    );

    expect(result.billItems).toBe(1);
    const gaps = result.document.gaps.filter((gap) => gap.kind === "PRICE_LEVEL_DIFFERS");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.message).toContain("«Республика Бурятия (2 зона)»");
    expect(gaps[0]?.message).toContain("«Республика Бурятия (5 зона)»");
  });
});
