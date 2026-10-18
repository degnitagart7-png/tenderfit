import { describe, expect, it } from "vitest";

import type { BillExtractionRow } from "@/domain/estimate/billExtraction";
import { computeAssurance, droppingGaps } from "@/domain/estimate/assurance";
import { estimateDocumentSchema } from "@/domain/estimate/schema";
import { createNormSearchIndex, findNorms, trustedByName } from "@/domain/estimate/matchNorms";
import type { NormRecord } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments } from "@/services/estimateService";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BASE_PRICES,
  makeParameters,
  makePriceBook,
  makeSearchNorm,
} from "@/test/estimateFixtures";
import { SMETA_001_OCR, SMETA_NAME, SMETA_ROWS } from "@/test/volumeSourceFixtures";

/**
 * Цена заказчика как запасной вариант и порог доверия к подбору по наименованию.
 * Данные — живая смета закупки 0134600012126000001.
 */

const DEMOLITION = makeSearchNorm({
  code: "46-06-009-03",
  fullName: "Разборка зданий методом обрушения: деревянных жилых домов и прочих отапливаемых зданий",
  endName: "деревянных жилых домов и прочих отапливаемых зданий",
  unit: "100 м3 строительного объема",
  collectionCode: "46",
  collectionName: "Работы при реконструкции зданий и сооружений",
  baseType: "ГЭСН",
});
const GRADING = makeSearchNorm({
  code: "01-02-027-02",
  fullName: "Планировка площадей: механизированным способом, группа грунтов 2",
  endName: "механизированным способом, группа грунтов 2",
  unit: "1000 м2",
  collectionCode: "01",
  collectionName: "Земляные работы",
  baseType: "ГЭСН",
});
/** Та самая норма-«фантом»: слово «погрузка» и единица «т» совпали случайно. */
const ISOLATORS = makeSearchNorm({
  code: "33-03-005-01",
  fullName: "Погрузка и выгрузка вручную: изоляторов стеклянных тарельчатых подвесных",
  endName: "изоляторов стеклянных тарельчатых подвесных",
  unit: "т",
  collectionCode: "33",
  collectionName: "Линии электропередачи",
  baseType: "ГЭСН",
});

/** Цена гравийной смеси 02.2.04.03-0013 из сметы заказчика (в базе 2022 года: 1 912,45). */
const GRAVEL_PRICE = {
  code: "02.2.04.03-0013",
  name: "Смесь песчано-гравийная обогащенная с содержанием гравия 35-50 %",
  unit: "м3",
  price: 1912.45,
  machinistSalary: null,
  machinistHours: null,
  source: "BASE_2022" as const,
  period: null,
  zone: null,
};

function makeBase(norms: readonly NormRecord[], withGravelPrice = true): EstimateBase {
  return {
    info: {
      indexDir: "data/fsnb/index",
      builtAt: "2026-10-08T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: "Иркутская область",
      priceZone: "Иркутская область (1 зона)",
      period: AMUR_ZONE.period,
      decree: "Приказ Минстроя России от 30.12.2021 № 1046/пр",
      counts: { norms: norms.length, basePrices: 0, currentPrices: 0, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE), {
      region: "Иркутская область",
      priceZone: "Иркутская область (1 зона)",
      ...(withGravelPrice
        ? { base: new Map([...BASE_PRICES, GRAVEL_PRICE].map((price) => [price.code, price])) }
        : {}),
    }),
    searchIndex: createNormSearchIndex(norms),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

interface Doc {
  readonly name: string;
  readonly text: string;
  readonly rows: readonly BillExtractionRow[];
}

function fetcherFor(docs: readonly Doc[]): BillRowsFetcher {
  return async ({ documentName }) => ({
    rows: [...(docs.find((doc) => doc.name === documentName)?.rows ?? [])],
    hasBill: true,
    tokens: 0,
    malformed: 0,
    truncated: false,
  });
}

async function estimate(docs: readonly Doc[], norms: readonly NormRecord[], withGravelPrice = true) {
  return buildEstimateFromDocuments(
    {
      regNumber: "0134600012126000001",
      subject: "Снос дома",
      documents: docs.map(({ name, text }) => ({ name, text })),
      parameters: makeParameters(),
      now: new Date("2026-10-08T00:00:00.000Z"),
    },
    { base: makeBase(norms, withGravelPrice), fetcher: fetcherFor(docs) },
  );
}

const SMETA: Doc = { name: SMETA_NAME, text: SMETA_001_OCR, rows: SMETA_ROWS };
const lines = (result: Awaited<ReturnType<typeof estimate>>) => result.document.sections.flatMap((section) => section.lines);
const lineByName = (result: Awaited<ReturnType<typeof estimate>>, part: string) =>
  lines(result).find((line) => line.normName.includes(part));
const total = (line: { directCost: number; overheadCost: number; profitCost: number } | undefined) =>
  line === undefined ? undefined : Math.round((line.directCost + line.overheadCost + line.profitCost) * 100) / 100;

describe("порог доверия к подбору по наименованию", () => {
  const index = createNormSearchIndex([DEMOLITION, GRADING, ISOLATORS]);

  it("«Погрузка гравия» находит изоляторы, но с покрытием ниже порога", () => {
    const match = findNorms(index, {
      workName: "Погрузка в автотранспортное средство: гравий (выгрузка учитывает перомещение транспортерами)",
      limit: 1,
    })[0];

    expect(match?.norm.code).toBe("33-03-005-01");
    // «Автотранспортное», «гравий», «перемещение» в нормах неизвестны, и это не «покрытие»: строгое число это ловит.
    expect(match?.strictCoverage).toBeLessThan(0.4);
    expect(trustedByName(match!)).toBe(false);
  });

  it("верный подбор порог проходит", () => {
    const match = findNorms(index, { workName: "Планировка площадей механизированным способом", limit: 1 })[0];

    expect(match?.norm.code).toBe("01-02-027-02");
    expect(trustedByName(match!)).toBe(true);
  });

  it("норма, найденная по коду, всегда доверена", () => {
    const match = findNorms(index, { workName: "что угодно", normCode: "33-03-005-01", normBaseType: "ГЭСН", limit: 1 })[0];

    expect(match?.coverage).toBe(1);
    expect(trustedByName(match!)).toBe(true);
  });

  it("слово, которого нет ни в одной норме («подсыпка»), снижает строгое покрытие", () => {
    const match = findNorms(createNormSearchIndex([ISOLATORS, GRADING]), { workName: "Подсыпка вручную гравием", limit: 1 })[0];

    expect(match).toBeDefined();
    expect(match!.strictCoverage).toBeLessThan(match!.coverage);
  });
});

describe("«погрузка гравия» не получает 33-03-005-01", () => {
  const norms = [DEMOLITION, GRADING, ISOLATORS];

  it("в смете заказчика позиция входит по цене заказчика 5 254,41 ₽, а не по изоляторам", async () => {
    const result = await estimate([SMETA], norms);

    expect(lines(result).some((line) => line.normCode === "33-03-005-01")).toBe(false);
    const loading = lineByName(result, "Погрузка в автотранспортное средство: гравий");
    expect(loading?.priceSource).toBe("CUSTOMER_PRICE");
    expect(total(loading)).toBe(5254.41);
  });

  it("у позиции ведомости без строки сметы заказчика цены нет — это NO_NORM, а не изоляторы", async () => {
    const bill: Doc = {
      name: "Ведомость объемов работ.xlsx",
      text: "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ\n1 Погрузка в автотранспортное средство: гравий | т | 55,52",
      rows: [
        {
          workName: "Погрузка в автотранспортное средство: гравий",
          quantity: "55,52",
          unit: "т",
          evidenceQuote: "1 Погрузка в автотранспортное средство: гравий | т | 55,52",
        },
      ],
    };
    const result = await estimate([bill], norms);

    expect(lines(result)).toHaveLength(0);
    expect(result.document.gaps.map((gap) => gap.kind)).toEqual(["NO_NORM"]);
    expect(droppingGaps(result.document)).toHaveLength(1);
  });
});

describe("уровень CUSTOMER_ESTIMATE: цена заказчика вместо выпавшей позиции", () => {
  const norms = [DEMOLITION, GRADING, ISOLATORS];

  it("погрузка, перевозка и размещение входят по суммам сметы", async () => {
    const result = await estimate([SMETA], norms);

    expect(total(lineByName(result, "Перевозка Грузов"))).toBe(16378.96);
    expect(total(lineByName(result, "мусор строительный с погрузкой"))).toBe(47882.16);
    expect(total(lineByName(result, "по дорогам с усовершенствованным"))).toBe(313652.44);
    expect(total(lineByName(result, "Размещение"))).toBe(420775.12);
  });

  it("сумма размещения — по строке «505,94 × 831,67», а не по искажённому «Всего по позиции 220 775,12»", async () => {
    const result = await estimate([SMETA], norms);

    expect(total(lineByName(result, "Размещение"))).toBe(420775.12);
    expect(SMETA_001_OCR).toContain("220 775,12");
  });

  it("строка помечена, пробел CUSTOMER_PRICE называет причину, и позиция больше не «выпала»", async () => {
    const result = await estimate([SMETA], norms);
    const placement = lineByName(result, "Размещение");

    expect(placement).toMatchObject({ priceSource: "CUSTOMER_PRICE", normBaseType: "Цена заказчика", resources: [] });
    const gap = result.document.gaps.find((entry) => entry.kind === "CUSTOMER_PRICE" && entry.message.includes("Размещение"));
    expect(gap?.message).toContain("по цене заказчика 420775,12 ₽ — не проверено нашими ценами");
    expect(gap?.message).toContain("нашей нормы нет");
    expect(droppingGaps(result.document)).toEqual([]);
    expect(computeAssurance(result.document).droppedPositions).toBe(0);
  });

  it("в итогах отдельная строка: сумма и число позиций по ценам заказчика", async () => {
    const result = await estimate([SMETA], norms);

    expect(result.document.totals.customerPricedCount).toBe(5);
    expect(result.document.totals.customerPriced).toBe(803943.09);
    expect(result.document.totals.workCost).toBeGreaterThan(result.document.totals.customerPriced ?? 0);
  });

  it("доля по ценам заказчика — допущение: она в ASSUMPTIONS и поднимает процент допущений", async () => {
    const result = await estimate([SMETA], norms);
    const assurance = computeAssurance(result.document);
    const assumption = assurance.assumptions.find((entry) => entry.kind === "CUSTOMER_PRICE");

    expect(assumption?.cost).toBe(803943.09);
    expect(assumption?.percent).toBeGreaterThan(50);
    expect(assurance.assumedPercent).toBeGreaterThanOrEqual(assumption?.percent ?? 0);
    expect(assurance.explainedCost).toBeLessThan(assurance.workCost);
  });

  it("поставка без цены в наших справочниках тоже входит по цене заказчика — 34,7 × 1 740,33", async () => {
    const result = await estimate([SMETA], norms, false);
    const gravel = lines(result).find((line) => line.normCode === "02.2.04.03-0013");

    expect(gravel?.priceSource).toBe("CUSTOMER_PRICE");
    expect(total(gravel)).toBe(60389.45);
  });

  it("документ с позицией по цене заказчика проходит схему и не теряет пометок", async () => {
    const result = await estimate([SMETA], norms);
    const parsed = estimateDocumentSchema.parse(JSON.parse(JSON.stringify(result.document)));

    expect(parsed.totals.customerPricedCount).toBe(5);
    expect(parsed.sections.flatMap((section) => section.lines).filter((line) => line.priceSource === "CUSTOMER_PRICE")).toHaveLength(5);
    expect(parsed.gaps.some((gap) => gap.kind === "CUSTOMER_PRICE")).toBe(true);
  });

  it("позиции, у которых есть наша норма, цену заказчика не берут", async () => {
    const result = await estimate([SMETA], norms);

    expect(lineByName(result, "Разборка зданий")?.priceSource).toBeUndefined();
    expect(lineByName(result, "Планировка")?.priceSource).toBeUndefined();
  });

  it("справочная строка «Строительный мусор 505,94 т» (999-9900) в расчёт не входит и нормы не получает", async () => {
    const result = await estimate([SMETA], norms);

    expect(result.rejected.some((entry) => entry.reason === "NOT_WORK" && entry.row.workName === "Строительный мусор")).toBe(true);
    expect(lines(result).some((line) => line.normName === "Строительный мусор")).toBe(false);
    expect(result.document.gaps.some((gap) => gap.message.includes("Строительный мусор"))).toBe(false);
  });

  it("смета в базисных ценах цены заказчика не даёт: суммы несопоставимы", async () => {
    const base2001: Doc = {
      ...SMETA,
      text: SMETA_001_OCR.replace("Составлен(а) в текущем уровне цен", "Составлен(а) в базисном уровне цен"),
    };
    const result = await estimate([base2001], norms);

    expect(lines(result).some((line) => line.priceSource === "CUSTOMER_PRICE")).toBe(false);
    expect(result.document.totals.customerPricedCount).toBeUndefined();
    expect(droppingGaps(result.document).length).toBeGreaterThan(0);
  });
});

describe("уровень BILL: цена заказчика только для строки, сопоставленной со строкой сметы", () => {
  const norms = [DEMOLITION, GRADING, ISOLATORS];
  const BILL: Doc = {
    name: "Ведомость объемов работ.xlsx",
    text: [
      "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
      "1 Размещение (захоронение) мусора | т | 500",
      "2 Устройство ограждения площадки | м | 80",
    ].join("\n"),
    rows: [
      {
        workName: "Размещение (захоронение) мусора",
        quantity: "500",
        unit: "т",
        evidenceQuote: "1 Размещение (захоронение) мусора | т | 500",
      },
      {
        workName: "Устройство ограждения площадки",
        quantity: "80",
        unit: "м",
        evidenceQuote: "2 Устройство ограждения площадки | м | 80",
      },
    ],
  };

  it("сопоставленная строка — цена заказчика за единицу × объём ведомости: 500 × 831,67", async () => {
    const result = await estimate([BILL, SMETA], norms);
    const placement = lineByName(result, "Размещение");

    expect(placement?.priceSource).toBe("CUSTOMER_PRICE");
    expect(total(placement)).toBe(415835);
    expect(placement?.billQuantity).toBe(500);
  });

  it("несопоставленная строка без нормы выпадает, как раньше", async () => {
    const result = await estimate([BILL, SMETA], norms);

    expect(lineByName(result, "ограждения")).toBeUndefined();
    expect(droppingGaps(result.document).some((gap) => gap.message.includes("ограждения"))).toBe(true);
  });
});
