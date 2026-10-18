import { describe, expect, it, vi } from "vitest";

import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { NormRecord } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import {
  dedupeDocuments,
  extractBillOfWork,
  type BillRowsFetcher,
} from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments } from "@/services/estimateService";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  makeParameters,
  makePriceBook,
  makeSearchNorm,
} from "@/test/estimateFixtures";
import {
  CONTRACT_NAME,
  DOCUMENTS_001,
  NMCK_NAME,
  NMCK_001_TEXT,
  NMCK_ROWS,
  PROJECT_001_TABLES,
  PROJECT_NAME,
  PROJECT_ROWS,
  SMETA_001_OCR,
  SMETA_NAME,
  SMETA_ROWS,
  TZ_001_TEXT,
  TZ_NAME,
  TZ_ROWS,
} from "@/test/volumeSourceFixtures";
import type { BillExtractionRow } from "@/domain/estimate/billExtraction";

/**
 * Приоритет источников объёмов на данных закупки 0134600012126000001 и на
 * сочетаниях «ведомость + смета», «только проект».
 */

const CONTEXT = { regNumber: "0134600012126000001", subject: "Снос дома" };

interface Doc {
  readonly name: string;
  readonly text: string;
  readonly rows: readonly BillExtractionRow[];
}

/** Модель отвечает строками, заготовленными под документ; число вызовов запоминается. */
function fetcherFor(docs: readonly Doc[]): BillRowsFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = vi.fn(async ({ documentName }: { documentName: string }) => {
    calls.push(documentName);
    const doc = docs.find((candidate) => candidate.name === documentName);
    return {
      rows: [...(doc?.rows ?? [])],
      hasBill: (doc?.rows.length ?? 0) > 0,
      tokens: 10,
      malformed: 0,
      truncated: false,
    };
  }) as unknown as BillRowsFetcher & { calls: string[] };
  fetcher.calls = calls;
  return fetcher;
}

async function extract(docs: readonly Doc[]) {
  const fetcher = fetcherFor(docs);
  const report = await extractBillOfWork(
    docs.map(({ name, text }) => ({ name, text })),
    CONTEXT,
    fetcher,
  );
  return { report, fetcher };
}

const keptNames = (report: Awaited<ReturnType<typeof extractBillOfWork>>) =>
  report.sections.flatMap((section) => section.items.map((item) => item.workName));

describe("закупка 001: ведомости нет, есть смета заказчика", () => {
  it("выбран уровень CUSTOMER_ESTIMATE, источник — смета", async () => {
    const { report } = await extract(DOCUMENTS_001);

    expect(report.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(report.volumeSource?.documents).toEqual([SMETA_NAME]);
    expect(report.volumeSource?.note).toBe(
      "Ведомости объёмов в документации нет — объёмы взяты из сметы заказчика «7. смета снос Мелихова 4.pdf»",
    );
  });

  it("строки проекта в расчёте не участвуют: они в отказах с причиной LOWER_SOURCE", async () => {
    const { report } = await extract(DOCUMENTS_001);

    expect(report.sections.map((section) => section.title)).toEqual([SMETA_NAME]);
    const lower = report.rejected.filter((entry) => entry.reason === "LOWER_SOURCE");
    expect(lower.map((entry) => entry.row.workName)).toEqual(
      expect.arrayContaining(["Демонтаж наружных стен", "Демонтаж кровли (шифер)", "Подсыпка грунтом"]),
    );
    expect(lower).toHaveLength(9);
    expect(lower[0]?.message).toContain("взяты из сметы заказчика");
  });

  it("машины и СИЗ не участвуют ни при каком уровне: 15 строк таблиц 4 и 6 — NOT_WORK", async () => {
    const { report } = await extract(DOCUMENTS_001);
    const notWork = report.rejected.filter(
      (entry) => entry.reason === "NOT_WORK" && !/мусор/i.test(entry.row.workName),
    );

    expect(notWork).toHaveLength(15);
    expect(notWork.map((entry) => entry.row.workName)).toEqual(
      expect.arrayContaining(["Бульдозер Komatsu D65", "Прожектор освещения", "Лопата совковая", "Респираторы", "Защитные очки"]),
    );
    expect(keptNames(report).some((name) => /Бульдозер|Каска|Респиратор|Лопата|Прожектор/.test(name))).toBe(false);
  });

  it("единицы «100 m3», «мз», «1т груза» распознаны — строки сметы в расчёте", async () => {
    const { report } = await extract(DOCUMENTS_001);
    const items = report.sections.flatMap((section) => section.items);

    expect(items).toHaveLength(8);
    expect(items.find((item) => item.workName.startsWith("Разборка зданий"))?.quantity).toBeCloseTo(581.63, 6);
    expect(items.filter((item) => item.quantityUnit === "т")).toHaveLength(5);
    expect(report.rejected.some((entry) => entry.reason === "UNKNOWN_UNIT")).toBe(false);
  });

  it("дубль позиции 4 схлопнут: в расчёте один гравий 34,7 м3", async () => {
    const { report } = await extract(DOCUMENTS_001);
    const gravel = report.sections.flatMap((section) => section.items).filter((item) => item.resourceCode !== null);

    expect(gravel).toHaveLength(1);
    expect(gravel[0]?.quantity).toBe(34.7);
    expect(report.rejected.filter((entry) => entry.reason === "DUPLICATE_POSITION")).toHaveLength(1);
  });

  it("«Условная единица 1» отклонена с причиной в двух документах; проект контракта с ней модель не читала", async () => {
    const { report, fetcher } = await extract(DOCUMENTS_001);
    const whole = report.rejected.filter((entry) => entry.reason === "WHOLE_WORK");

    // Проект контракта («Предмет контракта … Условная единица 1») — без объёмов: раньше модель читала его ради одной
    // отклонённой строки, теперь он назван в `skippedNoVolumes`.
    expect(fetcher.calls).not.toContain(CONTRACT_NAME);
    expect(report.skippedNoVolumes.map((entry) => entry.name)).toEqual([CONTRACT_NAME]);
    expect(whole).toHaveLength(2);
    expect(whole[0]?.message).toContain("объём задан всей работой (1 усл. ед.) — нужна разбивка по позициям");
  });

  it("каждая из 32 отклонённых строк живого прогона получила судьбу — ни одна не пропала молча", async () => {
    const { report } = await extract(DOCUMENTS_001);
    // Документы, которые модель не читала (проект контракта без объёмов), строк не дали.
    const skipped = new Set(report.skippedNoVolumes.map((entry) => entry.name));
    const total = DOCUMENTS_001.filter((doc) => !skipped.has(doc.name)).reduce((sum, doc) => sum + doc.rows.length, 0);
    const kept = report.sections.reduce((sum, section) => sum + section.items.length, 0);

    // Все строки ответа модели: либо в расчёте, либо в отказах с причиной.
    expect(kept + report.rejected.length).toBe(total);
  });

  it("уровни документов определены кодом", async () => {
    const { report } = await extract(DOCUMENTS_001);
    const levels = Object.fromEntries(report.documentLevels.map((entry) => [entry.name, entry.level]));

    expect(levels).toEqual({
      [NMCK_NAME]: "SPEC",
      [TZ_NAME]: "SPEC",
      [CONTRACT_NAME]: "SPEC",
      [PROJECT_NAME]: "SPEC",
      [SMETA_NAME]: "CUSTOMER_ESTIMATE",
    });
  });
});

describe("ведомость + смета заказчика", () => {
  const BILL_NAME = "Ведомость объемов работ.xlsx";
  const BILL_TEXT = [
    "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
    "1 Разборка зданий деревянных жилых домов | м3 | 600",
    "2 Планировка площадей механизированным способом | м2 | 347,7",
    "Таблица 4 - Ведомость потребности машин, механизмов и приспособлений",
    "1 | Бульдозер Komatsu D65 | шт | 1",
  ].join("\n");
  const BILL_ROWS: BillExtractionRow[] = [
    {
      workName: "Разборка зданий деревянных жилых домов",
      quantity: "600",
      unit: "м3",
      evidenceQuote: "1 Разборка зданий деревянных жилых домов | м3 | 600",
    },
    {
      workName: "Планировка площадей механизированным способом",
      quantity: "347,7",
      unit: "м2",
      evidenceQuote: "2 Планировка площадей механизированным способом | м2 | 347,7",
    },
    {
      workName: "Бульдозер Komatsu D65",
      quantity: "1",
      unit: "шт",
      evidenceQuote: "1 | Бульдозер Komatsu D65 | шт | 1",
    },
  ];
  const DOCS: Doc[] = [
    { name: BILL_NAME, text: BILL_TEXT, rows: BILL_ROWS },
    { name: SMETA_NAME, text: SMETA_001_OCR, rows: SMETA_ROWS },
    { name: PROJECT_NAME, text: PROJECT_001_TABLES, rows: PROJECT_ROWS },
  ];

  it("объёмы только из ведомости; смета не даёт строк расчёта, но остаётся справкой", async () => {
    const { report } = await extract(DOCS);

    expect(report.volumeSource?.level).toBe("BILL");
    expect(report.volumeSource?.documents).toEqual([BILL_NAME]);
    expect(report.volumeSource?.note).toBe("Объёмы взяты из ведомости объёмов работ «Ведомость объемов работ.xlsx»");
    expect(report.sections.map((section) => section.title)).toEqual([BILL_NAME]);
    expect(keptNames(report)).toEqual([
      "Разборка зданий деревянных жилых домов",
      "Планировка площадей механизированным способом",
    ]);
    expect(report.customerReference).toHaveLength(8);
    // Справка не считается отказом: в отчёте нет её строк, кроме дубля OCR.
    expect(report.rejected.some((entry) => entry.row.workName.startsWith("Разборка зданий методом"))).toBe(false);
  });

  it("проект при ведомости — LOWER_SOURCE, таблица машин даже в ведомости — NOT_WORK", async () => {
    const { report } = await extract(DOCS);

    expect(report.rejected.filter((entry) => entry.reason === "LOWER_SOURCE")).toHaveLength(9);
    const bulldozer = report.rejected.filter(
      (entry) => entry.reason === "NOT_WORK" && entry.row.workName === "Бульдозер Komatsu D65",
    );
    expect(bulldozer).toHaveLength(2);
  });
});

describe("только проект или ТЗ", () => {
  it("уровень SPEC; строки сметы нет, таблицы работ берутся, машины и СИЗ — нет", async () => {
    const { report } = await extract([
      { name: PROJECT_NAME, text: PROJECT_001_TABLES, rows: PROJECT_ROWS },
      { name: TZ_NAME, text: TZ_001_TEXT, rows: TZ_ROWS },
      { name: NMCK_NAME, text: NMCK_001_TEXT, rows: NMCK_ROWS },
    ]);

    expect(report.volumeSource?.level).toBe("SPEC");
    expect(report.volumeSource?.documents).toEqual([PROJECT_NAME]);
    expect(report.volumeSource?.note).toContain("Ведомости объёмов в документации нет");
    expect(report.volumeSource?.note).toContain("сметы заказчика нет");
    expect(keptNames(report)).toEqual(
      expect.arrayContaining(["Демонтаж наружных стен", "Демонтаж кровли (шифер)", "Подсыпка грунтом"]),
    );
    expect(keptNames(report)).toHaveLength(9);
    expect(report.rejected.filter((entry) => entry.reason === "NOT_WORK")).toHaveLength(15);
    expect(report.rejected.filter((entry) => entry.reason === "WHOLE_WORK")).toHaveLength(2);
  });

  it("нет ни одной подтверждённой строки — источника нет", async () => {
    const { report } = await extract([{ name: TZ_NAME, text: TZ_001_TEXT, rows: TZ_ROWS }]);

    expect(report.volumeSource).toBeNull();
    expect(report.sections).toEqual([]);
  });
});

describe("один и тот же документ дважды", () => {
  it("файл отдельно и внутри архива считается один раз, модель по нему зовётся один раз", async () => {
    const archive = `=== ${SMETA_NAME} ===\n${SMETA_001_OCR}\n=== Другой файл.txt ===\nПрочий текст архива`;
    const docs: Doc[] = [
      { name: SMETA_NAME, text: SMETA_001_OCR, rows: SMETA_ROWS },
      { name: "Документация.zip", text: archive, rows: [] },
    ];
    const { report, fetcher } = await extract(docs);

    expect(report.duplicateDocuments).toEqual([
      { name: `${SMETA_NAME} (в Документация.zip)`, duplicateOf: SMETA_NAME },
    ]);
    expect(fetcher.calls.filter((name) => name === SMETA_NAME)).toHaveLength(1);
    expect(report.sections.flatMap((section) => section.items)).toHaveLength(8);
  });

  it("сначала архив, потом отдельный файл — отдельный файл пропущен", () => {
    const archive = `=== ${SMETA_NAME} ===\n${SMETA_001_OCR}`;
    const { documents, duplicates } = dedupeDocuments([
      { name: "Документация.zip", text: archive },
      { name: SMETA_NAME, text: SMETA_001_OCR },
    ]);

    expect(documents.map((doc) => doc.name)).toEqual(["Документация.zip"]);
    expect(duplicates).toHaveLength(1);
  });

  it("два документа с одним именем и текстом — один", () => {
    const { documents } = dedupeDocuments([
      { name: "ЛСР.pdf", text: "Смета  номер 1" },
      { name: "лср.PDF", text: "смета номер 1" },
    ]);

    expect(documents).toHaveLength(1);
  });

  it("разные имена при одинаковом тексте — разные документы", () => {
    const { documents } = dedupeDocuments([
      { name: "Первый.docx", text: "Типовое приложение" },
      { name: "Второй.docx", text: "Типовое приложение" },
    ]);

    expect(documents).toHaveLength(2);
  });

  it("несколько смет одного уровня — берутся все", async () => {
    const lsr = (name: string, work: string, quantity: string): Doc => {
      const text = `ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА)\n1 ГЭСН01-02-027-02 ${work} 1000 м2 ${quantity}`;
      return {
        name,
        text,
        rows: [
          {
            workName: work,
            quantity,
            unit: "1000 м2",
            evidenceQuote: `1 ГЭСН01-02-027-02 ${work} 1000 м2 ${quantity}`,
            justification: "ГЭСН01-02-027-02",
          },
        ],
      };
    };
    const { report } = await extract([
      lsr("ЛСР раздел 1.pdf", "Планировка площадей площадки А", "1,5"),
      lsr("ЛСР раздел 2.pdf", "Планировка площадей площадки Б", "2,5"),
    ]);

    expect(report.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(report.volumeSource?.documents).toEqual(["ЛСР раздел 1.pdf", "ЛСР раздел 2.pdf"]);
    expect(keptNames(report)).toHaveLength(2);
  });
});

/* -------------------------- расчёт на подменённой базе -------------------------- */

const DEMOLITION = makeSearchNorm({
  code: "46-06-009-03",
  fullName: "Разборка зданий методом обрушения: деревянных жилых домов и прочих отапливаемых зданий",
  endName: "деревянных жилых домов и прочих отапливаемых зданий",
  unit: "100 м3 строительного объема",
  collectionCode: "46",
  collectionName: "Работы при реконструкции зданий и сооружений",
  baseType: "ГЭСН",
});
const DEMOLITION_BRICK = makeSearchNorm({
  code: "46-06-009-01",
  fullName: "Разборка зданий методом обрушения: кирпичных отапливаемых зданий",
  endName: "кирпичных отапливаемых зданий",
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
const WALLS_TONS = makeSearchNorm({
  code: "09-99-001-01",
  fullName: "Демонтаж наружных стен",
  endName: "наружных стен",
  unit: "т",
  collectionCode: "09",
  collectionName: "Строительные металлические конструкции",
  baseType: "ГЭСН",
});
const WALLS_CUBES = makeSearchNorm({
  code: "09-99-002-01",
  fullName: "Демонтаж наружных стен",
  endName: "наружных стен",
  unit: "100 м3",
  collectionCode: "09",
  collectionName: "Строительные металлические конструкции",
  baseType: "ГЭСН",
});

function makeBase(norms: readonly NormRecord[]): EstimateBase {
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
    }),
    searchIndex: createNormSearchIndex(norms),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

async function estimate(docs: readonly Doc[], norms: readonly NormRecord[]) {
  return buildEstimateFromDocuments(
    {
      regNumber: CONTEXT.regNumber,
      subject: CONTEXT.subject,
      documents: docs.map(({ name, text }) => ({ name, text })),
      parameters: makeParameters(),
      now: new Date("2026-10-08T00:00:00.000Z"),
    },
    { base: makeBase(norms), fetcher: fetcherFor(docs) },
  );
}

const lineOf = (result: Awaited<ReturnType<typeof estimate>>, part: string) =>
  result.document.sections.flatMap((section) => section.lines).find((line) => line.normName.includes(part));

describe("шифр расценки из сметы: на подменённой базе, где 46-06-009-03 есть, а 46-06-909-03 нет", () => {
  const norms = [DEMOLITION, DEMOLITION_BRICK, GRADING];

  it("«F9CH46-06-909-03» восстановлен в 46-06-009-03, норма взята по шифру, делитель 100", async () => {
    const result = await estimate([{ name: SMETA_NAME, text: SMETA_001_OCR, rows: SMETA_ROWS }], norms);

    const line = lineOf(result, "Разборка зданий");
    expect(line?.normCode).toBe("46-06-009-03");
    expect(line?.billQuantity).toBeCloseTo(581.63, 6);
    expect(line?.quantity).toBeCloseTo(5.8163, 6);
    expect(result.normHints.find((note) => note.code === "46-06-009-03")).toMatchObject({
      rawCode: "F9CH46-06-909-03",
      restored: true,
      source: "ITEM",
    });
    expect(norms.some((norm) => norm.code === "46-06-909-03")).toBe(false);
  });

  it("«F3CH01-02-027-02» найден как есть: ГЭСН 01-02-027-02, 0,3477 × 1000 м2", async () => {
    const result = await estimate([{ name: SMETA_NAME, text: SMETA_001_OCR, rows: SMETA_ROWS }], norms);

    const line = lineOf(result, "Планировка");
    expect(line?.normCode).toBe("01-02-027-02");
    expect(line?.quantity).toBeCloseTo(0.3477, 6);
    expect(result.normHints.find((note) => note.code === "01-02-027-02")?.restored).toBe(false);
  });

  it("цифры не исправляются, если у варианта другая единица: норма подбирается поиском", async () => {
    const wrongUnit = makeSearchNorm({ ...DEMOLITION, unit: "т" } as Parameters<typeof makeSearchNorm>[0]);
    const result = await estimate(
      [{ name: SMETA_NAME, text: SMETA_001_OCR, rows: SMETA_ROWS }],
      [wrongUnit, GRADING],
    );

    expect(result.normHints.some((note) => note.restored)).toBe(false);
  });

  it("источник объёмов попадает в результат расчёта", async () => {
    const result = await estimate([{ name: SMETA_NAME, text: SMETA_001_OCR, rows: SMETA_ROWS }], norms);

    expect(result.volumeSource).toEqual({
      level: "CUSTOMER_ESTIMATE",
      documents: [SMETA_NAME],
      note: "Ведомости объёмов в документации нет — объёмы взяты из сметы заказчика «7. смета снос Мелихова 4.pdf»",
    });
    expect(result.volumeFindings).toEqual([]);
  });
});

describe("ведомость + смета: шифры подсказаны сметой, расхождение объёма — находка", () => {
  const BILL_NAME = "Ведомость объемов работ.xlsx";
  const BILL_TEXT = [
    "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
    "1 Разборка зданий деревянных жилых домов | м3 | 600",
    "2 Планировка площадей механизированным способом | м2 | 347,7",
  ].join("\n");
  const BILL: Doc = {
    name: BILL_NAME,
    text: BILL_TEXT,
    rows: [
      {
        workName: "Разборка зданий деревянных жилых домов",
        quantity: "600",
        unit: "м3",
        evidenceQuote: "1 Разборка зданий деревянных жилых домов | м3 | 600",
      },
      {
        workName: "Планировка площадей механизированным способом",
        quantity: "347,7",
        unit: "м2",
        evidenceQuote: "2 Планировка площадей механизированным способом | м2 | 347,7",
      },
    ],
  };
  const SMETA: Doc = { name: SMETA_NAME, text: SMETA_001_OCR, rows: SMETA_ROWS };
  // В базе есть и «кирпичная» разборка: поиск по наименованию ведомости мог бы взять её.
  const norms = [DEMOLITION_BRICK, DEMOLITION, GRADING];

  it("расчёт идёт по объёмам ведомости, не сметы", async () => {
    const result = await estimate([BILL, SMETA], norms);

    expect(result.volumeSource?.level).toBe("BILL");
    expect(lineOf(result, "Разборка зданий")?.billQuantity).toBe(600);
    expect(lineOf(result, "Планировка")?.billQuantity).toBeCloseTo(347.7, 6);
    expect(result.billItems).toBe(2);
  });

  it("норма берётся по шифру из строки сметы заказчика", async () => {
    const result = await estimate([BILL, SMETA], norms);

    expect(lineOf(result, "Разборка зданий")?.normCode).toBe("46-06-009-03");
    const hint = result.normHints.find((note) => note.code === "46-06-009-03");
    expect(hint).toMatchObject({ source: "CUSTOMER_ESTIMATE", restored: true });
  });

  it("расхождение больше 2 % — находка «В ведомости X, в смете заказчика Y»; на сумму не влияет", async () => {
    const result = await estimate([BILL, SMETA], norms);

    expect(result.volumeFindings).toHaveLength(1);
    expect(result.volumeFindings[0]?.message).toBe(
      "В ведомости 600 м3, в смете заказчика 581,63 м3 — «Разборка зданий деревянных жилых домов», расхождение 3,2 %",
    );
    expect(result.volumeFindings[0]).toMatchObject({ billQuantity: 600, customerQuantity: 581.63, billUnit: "м3" });

    const withoutEstimate = await estimate([BILL], norms);
    expect(withoutEstimate.volumeFindings).toEqual([]);
    expect(lineOf(withoutEstimate, "Разборка зданий")?.billQuantity).toBe(600);
  });

  it("расхождение до 2 % находкой не считается", async () => {
    const close: Doc = {
      ...BILL,
      text: BILL_TEXT.replace("| 600", "| 585"),
      rows: [
        { ...(BILL.rows[0] as BillExtractionRow), quantity: "585", evidenceQuote: "1 Разборка зданий деревянных жилых домов | м3 | 585" },
        BILL.rows[1] as BillExtractionRow,
      ],
    };
    const result = await estimate([close, SMETA], norms);

    expect(result.volumeFindings).toEqual([]);
  });
});

describe("парный объём «103,65/82,92 м3/т» и единица найденной нормы", () => {
  const PAIR_DOC = (rows: readonly BillExtractionRow[]): Doc => ({
    name: PROJECT_NAME,
    text: PROJECT_001_TABLES,
    rows,
  });
  const WALLS_ROW = PROJECT_ROWS[0] as BillExtractionRow;

  it("норма в тоннах берёт тонны: 82,92 т", async () => {
    const result = await estimate([PAIR_DOC([WALLS_ROW])], [WALLS_TONS]);
    const line = lineOf(result, "Демонтаж наружных стен");

    expect(line?.normUnit).toBe("т");
    expect(line?.billUnit).toBe("т");
    expect(line?.billQuantity).toBe(82.92);
    expect(line?.quantity).toBe(82.92);
  });

  it("норма в 100 м3 берёт кубометры: 103,65 м3, делитель 100", async () => {
    const result = await estimate([PAIR_DOC([WALLS_ROW])], [WALLS_CUBES]);
    const line = lineOf(result, "Демонтаж наружных стен");

    expect(line?.normUnit).toBe("100 м3");
    expect(line?.billUnit).toBe("м3");
    expect(line?.billQuantity).toBe(103.65);
    expect(line?.quantity).toBeCloseTo(1.0365, 6);
  });

  it("норма не подобрана — берётся первая величина, расчёт назовёт пробел", async () => {
    const result = await estimate([PAIR_DOC([WALLS_ROW])], [GRADING]);

    expect(result.document.sections.flatMap((section) => section.lines)).toHaveLength(0);
    expect(result.document.gaps.some((gap) => gap.kind === "NO_NORM" || gap.kind === "UNIT_MISMATCH")).toBe(true);
  });
});
