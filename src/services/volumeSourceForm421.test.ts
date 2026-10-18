import { describe, expect, it, vi } from "vitest";

import type { BillExtractionRow } from "@/domain/estimate/billExtraction";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { BillOfWorkItem } from "@/domain/estimate/types";
import { findBillDiscrepancies, VOLUME_TOLERANCE_PERCENT } from "@/domain/estimate/volumeCrossCheck";
import { chooseVolumeSource, volumeRank } from "@/domain/estimate/volumeSource";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import { extractBillOfWork, type BillRowsFetcher, type BillRowsRequest } from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments } from "@/services/estimateService";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeParameters,
  makePriceBook,
} from "@/test/estimateFixtures";
import { DESCRIPTION_NAME, DESCRIPTION_TEXT } from "@/test/t1118Fixtures";
import { PROJECT_001_TABLES, PROJECT_NAME, PROJECT_ROWS, SMETA_001_OCR, SMETA_NAME, SMETA_ROWS } from "@/test/volumeSourceFixtures";

/**
 * Решение владельца 2026-10-10: ЛСР формы 421/пр, прочитанная кодом, выше ведомости объёмов. Объёмы и шифры — из
 * ЛСР, ведомость — сверка в обратную сторону (объём расходится; работа есть в ведомости, а в ЛСР её нет).
 *
 * ЛСР — «Описание объекта закупки» закупки 1118 (три сметы): в ней «Смена кранов: водоразборных и туалетных» 8 шт,
 * «Разборка трубопроводов…» 24 м, «Покрытие поверхности изоляции трубопроводов…» 75 м2 и много оборудования и материалов.
 */

const CONTEXT = { regNumber: "0302300048726001118", subject: "Ремонтные работы" };

const VOR_NAME = "Ведомость объемов работ.docx";
/** ВОР с доверенной шапкой: код читает таблицу сам (`billTable`), модель не нужна. */
const VOR_TEXT = [
  "Ведомость объемов работ",
  "№ п/п\tНаименование\tЕд. изм.\tКол-во",
  "1\tСмена кранов водоразборных и туалетных\tшт\t10",
  "2\tРазборка трубопроводов из водогазопроводных труб\tм\t24",
  "3\tПокрытие поверхности изоляции трубопроводов стеклопластиками\tм2\t75",
  "4\tОкраска металлических поверхностей эмалью\tм2\t40",
].join("\n");

function recordingModel(): BillRowsFetcher & { calls: BillRowsRequest[] } {
  const calls: BillRowsRequest[] = [];
  const fetcher = vi.fn(async (request: BillRowsRequest) => {
    calls.push(request);
    return { rows: [], hasBill: false, tokens: 7, malformed: 0, truncated: false };
  }) as unknown as BillRowsFetcher & { calls: BillRowsRequest[] };
  fetcher.calls = calls;
  return fetcher;
}

const itemsOf = (report: Awaited<ReturnType<typeof extractBillOfWork>>) => report.sections.flatMap((section) => section.items);

describe("ЛСР формы 421/пр и ВОР вместе: приоритет", () => {
  it("ВОР, прочитанный таблицей, и ЛСР: источник — смета заказчика, ВОР — billReference; модели нет", async () => {
    const fetcher = recordingModel();
    const report = await extractBillOfWork(
      [{ name: VOR_NAME, text: VOR_TEXT }, { name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }],
      CONTEXT,
      fetcher,
    );

    expect(report.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(report.volumeSource?.documents).toEqual([DESCRIPTION_NAME]);
    expect(report.volumeSource?.note).toBe(
      "Объёмы и шифры — из сметы заказчика (форма 421/пр); ведомость объёмов работ использована для сверки",
    );
    expect(itemsOf(report).every((item) => item.sourceLevel === "CUSTOMER_ESTIMATE")).toBe(true);
    expect(itemsOf(report)).toHaveLength(44);
    expect(report.billReference.map((item) => item.workName)).toHaveLength(4);
    expect(report.billReference.every((item) => item.sourceLevel === "BILL")).toBe(true);
    // Строки ВОР — сверка, а не отказ.
    expect(report.rejected.some((entry) => entry.reason === "LOWER_SOURCE")).toBe(false);
    expect(fetcher.calls).toEqual([]);
    expect(report.tokensUsed).toBe(0);
  });

  it("порядок документов не важен", async () => {
    const report = await extractBillOfWork(
      [{ name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }, { name: VOR_NAME, text: VOR_TEXT }],
      CONTEXT,
      recordingModel(),
    );
    expect(report.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(report.billReference).toHaveLength(4);
  });

  it("только ВОР, без ЛСР: уровень BILL, как раньше", async () => {
    const report = await extractBillOfWork([{ name: VOR_NAME, text: VOR_TEXT }], CONTEXT, recordingModel());

    expect(report.volumeSource?.level).toBe("BILL");
    expect(report.volumeSource?.documents).toEqual([VOR_NAME]);
    expect(report.billReference).toEqual([]);
    expect(itemsOf(report)).toHaveLength(4);
  });

  it("смета, прочитанная моделью (не форма 421/пр), и ВОР: ВОР выше, как раньше", async () => {
    const calls: string[] = [];
    const fetcher = (async ({ documentName }: { documentName: string }) => {
      calls.push(documentName);
      const rows = documentName === SMETA_NAME ? SMETA_ROWS : documentName === PROJECT_NAME ? PROJECT_ROWS : [];
      return { rows: [...rows], hasBill: rows.length > 0, tokens: 10, malformed: 0, truncated: false };
    }) as unknown as BillRowsFetcher;
    const report = await extractBillOfWork(
      [
        { name: VOR_NAME, text: VOR_TEXT },
        { name: SMETA_NAME, text: SMETA_001_OCR },
        { name: PROJECT_NAME, text: PROJECT_001_TABLES },
      ],
      CONTEXT,
      fetcher,
    );

    expect(report.volumeSource?.level).toBe("BILL");
    expect(report.volumeSource?.documents).toEqual([VOR_NAME]);
    expect(report.customerReference.length).toBeGreaterThan(0);
    expect(report.billReference).toEqual([]);
  });

  it("ВОР, который код не прочитал, при ЛСР моделью не читается: ни вызова, ни токенов", async () => {
    const fetcher = recordingModel();
    const prose = "Ведомость объемов работ\nСмену кранов водоразборных и туалетных (8 шт) выполнить в срок.";
    const report = await extractBillOfWork(
      [{ name: VOR_NAME, text: prose }, { name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }],
      CONTEXT,
      fetcher,
    );

    expect(fetcher.calls).toEqual([]);
    expect(report.tokensUsed).toBe(0);
    expect(report.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(report.volumeSource?.note).toContain("не сверялась");
  });

  it("ВОР без ЛСР, не прочитанный кодом, читает модель — без ЛСР он единственный источник", async () => {
    const fetcher = recordingModel();
    const prose = "Ведомость объемов работ\nСмену кранов водоразборных и туалетных (8 шт) выполнить в срок.";
    await extractBillOfWork([{ name: VOR_NAME, text: prose }], CONTEXT, fetcher);
    expect(fetcher.calls).toHaveLength(1);
  });
});

describe("volumeRank и chooseVolumeSource", () => {
  it("смета формы 421 выше ведомости, смета, прочитанная моделью, ниже", () => {
    expect(volumeRank("CUSTOMER_ESTIMATE", true)).toBeGreaterThan(volumeRank("BILL"));
    expect(volumeRank("CUSTOMER_ESTIMATE", false)).toBeLessThan(volumeRank("BILL"));
    expect(volumeRank("BILL", true)).toBe(volumeRank("BILL"));
  });

  it("форма 421/пр без ведомости: прежнее пояснение «Ведомости объёмов в документации нет»", () => {
    const source = chooseVolumeSource({
      accepted: [{ level: "CUSTOMER_ESTIMATE", document: "ЛСР.xlsx", form421: true }],
      documentLevels: [{ name: "ЛСР.xlsx", level: "CUSTOMER_ESTIMATE" }],
    });
    expect(source?.note).toContain("Ведомости объёмов в документации нет");
  });
});

/** Позиция расчёта, как её строит ЛСР: смета заказчика. */
function lsrRow(workName: string, quantity: number, unit: string, extra: Partial<BillOfWorkItem> = {}): BillOfWorkItem {
  return {
    id: `l-${workName}`,
    workName,
    quantity,
    quantityUnit: unit,
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    resourceCode: null,
    sourceQuote: workName,
    sourceDocument: "ЛСР.xlsx",
    sourceLevel: "CUSTOMER_ESTIMATE",
    ...extra,
  };
}

function billRow(workName: string, quantity: number, unit: string): BillOfWorkItem {
  return { ...lsrRow(workName, quantity, unit), id: `b-${workName}`, sourceDocument: "ВОР.docx", sourceLevel: "BILL" };
}

describe("findBillDiscrepancies: обратная сверка — основа ЛСР, ведомость проверяется", () => {
  const lsr = [
    lsrRow("Разборка кирпичных стен", 120, "м3"),
    lsrRow("Устройство стяжки цементной", 300, "м2"),
    lsrRow("Устройство лесов трубчатых", 450, "м2"),
    lsrRow("Кирпич керамический полнотелый", 5000, "шт", { customerPriceOnly: true }),
    lsrRow("Перевозка строительного мусора автосамосвалами", 80, "т"),
  ];

  it("объём расходится больше порога: «В смете заказчика X, в ведомости Y — проверьте»", () => {
    const findings = findBillDiscrepancies(lsr, [billRow("Разборка кирпичных стен", 150, "м3")]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("VOLUME_DIFF");
    expect(findings[0]?.message).toBe(
      "В смете заказчика 120 м3, в ведомости 150 м3 — проверьте: «Разборка кирпичных стен», расхождение 25 %",
    );
    expect(findings[0]).toMatchObject({ billQuantity: 150, customerQuantity: 120, diffPercent: 25, customerDocument: "ЛСР.xlsx" });
  });

  it("расхождение в пределах порога находкой не считается", () => {
    const close = 120 * (1 + (VOLUME_TOLERANCE_PERCENT - 0.5) / 100);
    expect(findBillDiscrepancies(lsr, [billRow("Разборка кирпичных стен", close, "м3")])).toEqual([]);
  });

  it("работа есть в ведомости, но нет в ЛСР — находка «Работа есть в ведомости, но нет в смете заказчика»", () => {
    const findings = findBillDiscrepancies(lsr, [billRow("Огрунтовка металлоконструкций полимерным составом", 60, "м2")]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("BILL_ONLY");
    expect(findings[0]?.message).toBe(
      "Работа есть в ведомости, но нет в смете заказчика: «Огрунтовка металлоконструкций полимерным составом», 60 м2 — проверьте",
    );
    expect(findings[0]?.customerDocument).toBeNull();
  });

  it("позиции ЛСР без пары в ведомости — леса, материалы, перевозка — находками не становятся", () => {
    const findings = findBillDiscrepancies(lsr, [
      billRow("Разборка кирпичных стен", 120, "м3"),
      billRow("Устройство стяжки цементной", 300, "м2"),
    ]);
    expect(findings).toEqual([]);
  });

  it("название заказчика иное, но слова общие — «нет в смете» не говорим", () => {
    const findings = findBillDiscrepancies(lsr, [billRow("Устройство цементной стяжки по плитам", 300, "м2")]);
    expect(findings.filter((finding) => finding.kind === "BILL_ONLY")).toEqual([]);
  });

  it("пустая ведомость или пустая ЛСР — пусто", () => {
    expect(findBillDiscrepancies(lsr, [])).toEqual([]);
    expect(findBillDiscrepancies([], [billRow("Разборка кирпичных стен", 1, "м3")])).toEqual([]);
  });

  it("одна и та же строка ведомости, продублированная в двух файлах, даёт одну находку", () => {
    const row = billRow("Огрунтовка металлоконструкций полимерным составом", 60, "м2");
    expect(findBillDiscrepancies(lsr, [row, { ...row, id: "b2" }])).toHaveLength(1);
  });
});

/* ------------------------------ Расчёт целиком ------------------------------ */

const NORMS = [NORM_MANUAL_GRADING, NORM_DRAGLINE_15];
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

describe("расчёт при ЛСР формы 421/пр и ВОР: результат", () => {
  const run = (documents: readonly { name: string; text: string }[], fetcher: BillRowsFetcher) =>
    buildEstimateFromDocuments(
      {
        regNumber: CONTEXT.regNumber,
        subject: CONTEXT.subject,
        documents,
        parameters: makeParameters({ vatPercent: 22 }),
        now: new Date("2026-10-09T00:00:00.000Z"),
      },
      { base: makeBase(), fetcher },
    );

  it("объёмы из ЛСР, источник — смета заказчика; находки сверки с ВОР — в volumeFindings", async () => {
    const fetcher = recordingModel();
    const result = await run([{ name: VOR_NAME, text: VOR_TEXT }, { name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }], fetcher);

    expect(result.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(result.volumeSource?.note).toContain("ведомость объёмов работ использована для сверки");
    expect(fetcher.calls).toEqual([]);

    const diff = result.volumeFindings.find((finding) => finding.kind === "VOLUME_DIFF");
    expect(diff?.message).toBe(
      "В смете заказчика 8 шт, в ведомости 10 шт — проверьте: «Смена кранов водоразборных и туалетных», расхождение 25 %",
    );
    const only = result.volumeFindings.filter((finding) => finding.kind === "BILL_ONLY");
    expect(only.map((finding) => finding.workName)).toEqual(["Окраска металлических поверхностей эмалью"]);
    // Позиции ЛСР без пары в ВОР (оборудование, материалы) находками не стали.
    expect(result.volumeFindings).toHaveLength(2);
  });

  it("без ВОР находок нет", async () => {
    const result = await run([{ name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }], recordingModel());
    expect(result.volumeFindings).toEqual([]);
  });
});
