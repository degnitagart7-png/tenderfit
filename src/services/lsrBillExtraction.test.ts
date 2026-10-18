import { describe, expect, it, vi } from "vitest";

import type { BillExtractionRow } from "@/domain/estimate/billExtraction";
import {
  extractBillOfWork,
  MAX_BILL_ROWS_PER_CHUNK,
  MAX_SPLIT_DEPTH,
  type BillRowsFetcher,
  type BillRowsRequest,
} from "@/services/billOfWorkExtraction";
import {
  CONTRACT_ESTIMATE_TEXT,
  CONTRACT_NAME,
  CONTRACT_TEXT,
  DESCRIPTION_NAME,
  DESCRIPTION_TEXT,
  DOCUMENTS_1118,
  NMCK_NAME,
} from "@/test/t1118Fixtures";

const CONTEXT = { regNumber: "0302300048726001118", subject: "Устранение замечаний по МКП ГКШП. Ремонтные работы" };

/** Модель, которой по таким документам звать нельзя: любой вызов роняет тест. */
function forbiddenModel(): BillRowsFetcher & { calls: BillRowsRequest[] } {
  const calls: BillRowsRequest[] = [];
  const fetcher = vi.fn(async (request: BillRowsRequest) => {
    calls.push(request);
    return { rows: [], hasBill: false, tokens: 0, malformed: 0, truncated: false };
  }) as unknown as BillRowsFetcher & { calls: BillRowsRequest[] };
  fetcher.calls = calls;
  return fetcher;
}

const itemsOf = (report: Awaited<ReturnType<typeof extractBillOfWork>>) => report.sections.flatMap((section) => section.items);

describe("ведомость из ЛСР заказчика — без модели", () => {
  it("документ с разборными ЛСР модели не отдаётся: ни одного вызова, ни токенов", async () => {
    const fetcher = forbiddenModel();
    const report = await extractBillOfWork([{ name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }], CONTEXT, fetcher);

    expect(fetcher.calls).toEqual([]);
    expect(report.tokensUsed).toBe(0);
    expect(report.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(report.volumeSource?.documents).toEqual([DESCRIPTION_NAME]);
  });

  it("раздел на каждую ЛСР, с её номером и названием; все позиции и подпозиции на месте", async () => {
    const report = await extractBillOfWork([{ name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }], CONTEXT, forbiddenModel());

    const titles = report.sections.map((section) => section.title);
    expect(titles).toHaveLength(3);
    expect(titles.some((title) => title.startsWith("ЛСР 02-02-08. "))).toBe(true);
    expect(titles.some((title) => title.startsWith("ЛСР 02-02-12. "))).toBe(true);
    expect(titles.some((title) => title.startsWith("ЛСР 02-02-05/13. "))).toBe(true);
    expect(report.sections.map((section) => section.items.length).sort((a, b) => a - b)).toEqual([6, 7, 31]);
    expect(report.rejected).toEqual([]);
  });

  it("оборудование и поставки — отдельные строки ведомости, шифр расценки взят из ЛСР", async () => {
    const report = await extractBillOfWork([{ name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }], CONTEXT, forbiddenModel());
    const items = itemsOf(report);

    expect(items.filter((item) => item.customerPriceOnly === true).map((item) => item.workName)).toEqual(
      expect.arrayContaining(["Насос центробежный RV80-200/2", "Гликоль 30%"]),
    );
    expect(items.filter((item) => item.resourceCode !== null).length).toBeGreaterThan(5);
    expect(items.filter((item) => item.normCodeHint != null).length).toBeGreaterThan(15);
  });
});

describe("смета контракта не перебивает ЛСР", () => {
  it("ЛСР и смета контракта вместе: объёмы из ЛСР, строки контракта — сверка, а не отказы", async () => {
    const fetcher = forbiddenModel();
    const report = await extractBillOfWork(DOCUMENTS_1118, CONTEXT, fetcher);

    expect(report.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(itemsOf(report).every((item) => item.sourceLevel === "CUSTOMER_ESTIMATE")).toBe(true);
    expect(itemsOf(report)).toHaveLength(44);
    // Смету контракта читает код, ЛСР — код: модель не нужна ни по одному документу.
    expect(fetcher.calls).toEqual([]);
    expect(report.rejected.filter((entry) => entry.reason === "LOWER_SOURCE")).toEqual([]);
  });

  it("сверка: все позиции сметы контракта покрыты ЛСР — об этом сказано в источнике", async () => {
    const report = await extractBillOfWork(DOCUMENTS_1118, CONTEXT, forbiddenModel());

    expect(report.contractCheck?.covered).toBe(15);
    expect(report.contractCheck?.total).toBe(15);
    expect(report.volumeSource?.details).toContain("Смета контракта: все 15 позиций покрыты позициями ЛСР");
  });

  it("документ отнесён к уровню: проект контракта со сметами — CONTRACT_ESTIMATE", async () => {
    const report = await extractBillOfWork(DOCUMENTS_1118, CONTEXT, forbiddenModel());
    const levels = Object.fromEntries(report.documentLevels.map((entry) => [entry.name, entry.level]));

    expect(levels[CONTRACT_NAME]).toBe("CONTRACT_ESTIMATE");
  });

  it("нет ни ВОР, ни ЛСР — смета контракта становится источником, и это допущение названо", async () => {
    const fetcher = forbiddenModel();
    const report = await extractBillOfWork([{ name: CONTRACT_NAME, text: CONTRACT_TEXT }], CONTEXT, fetcher);

    expect(report.volumeSource?.level).toBe("CONTRACT_ESTIMATE");
    expect(report.volumeSource?.note).toContain("укрупнены");
    expect(report.volumeSource?.note).toContain("допущении");
    expect(itemsOf(report)).toHaveLength(15);
    expect(fetcher.calls).toEqual([]);
  });
});

describe("дубль ЛСР из двух архивов берётся один раз", () => {
  it("«Описание объекта закупки» и «Обоснование НМЦК»: смет три, документ-источник — описание", async () => {
    const report = await extractBillOfWork(DOCUMENTS_1118, CONTEXT, forbiddenModel());

    expect(report.customerLsrs).toHaveLength(3);
    expect(report.customerLsrs.every((entry) => entry.documentName === DESCRIPTION_NAME)).toBe(true);
    expect(report.customerLsrs.every((entry) => entry.documents.length === 2)).toBe(true);
    expect(report.volumeSource?.documents).toEqual([DESCRIPTION_NAME]);
    expect(report.lsrNotes).toContain(
      `ЛСР 02-02-12 найдена в 2 документах («${NMCK_NAME}», «${DESCRIPTION_NAME}»), взята из «${DESCRIPTION_NAME}»`,
    );
    expect(report.volumeSource?.details).toEqual(expect.arrayContaining([...report.lsrNotes]));
  });

  it("позиции не задвоены: сумма цен заказчика равна итогам трёх смет без НДС", async () => {
    const report = await extractBillOfWork(DOCUMENTS_1118, CONTEXT, forbiddenModel());
    const sum = itemsOf(report).reduce((total, item) => total + (item.deduction === true ? -1 : 1) * (item.customerPrice?.total ?? 0), 0);

    expect(sum).toBeCloseTo(32_020.29 + 930_679.99 + 43_133.33, 1);
  });

  it("коэффициенты заказчика несёт сама позиция: подтверждённые приложением 10 — к применению, остальные — отклонённые", async () => {
    const report = await extractBillOfWork(DOCUMENTS_1118, CONTEXT, forbiddenModel());
    const items = itemsOf(report);

    expect(items.filter((item) => item.customerConditions?.confirmed != null)).toHaveLength(7);
    expect(items.filter((item) => (item.customerConditions?.rejected ?? []).length > 0).length).toBeGreaterThan(0);
  });
});

describe("ЛСР формы 421/пр выше ведомости; ведомость, производная от ЛСР, — тоже сверка", () => {
  const BILL_NAME = "Ведомость объёмов работ.xlsx";
  const BILL_TEXT = ["ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ", "1 Смена кранов водоразборных и туалетных | шт | 8", "2 Прокладка трубопроводов отопления | м | 24"].join("\n");
  const DERIVED_TEXT = [
    "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
    "1\tЛС 02-02-08 Поз.: 4-4.2\tСмена кранов водоразборных и туалетных\tшт\t8",
    "2\tЛС 02-02-08 Поз.: 5-5.2\tПрокладка трубопроводов отопления\tм\t24",
  ].join("\n");

  const billRows: BillExtractionRow[] = [
    { workName: "Смена кранов водоразборных и туалетных", quantity: "8", unit: "шт", evidenceQuote: "1 Смена кранов водоразборных и туалетных | шт | 8" },
  ];
  const derivedRows: BillExtractionRow[] = [
    {
      workName: "Смена кранов водоразборных и туалетных",
      quantity: "8",
      unit: "шт",
      evidenceQuote: "Смена кранов водоразборных и туалетных\tшт\t8",
    },
  ];
  const modelFor = (rows: readonly BillExtractionRow[]): BillRowsFetcher =>
    (async () => ({ rows: [...rows], hasBill: true, tokens: 10, malformed: 0, truncated: false })) as BillRowsFetcher;

  it("настоящий ВОР и ЛСР формы 421/пр: объёмы из ЛСР, ВОР только сверка — и модель ради неё не зовётся", async () => {
    const fetcher = forbiddenModel();
    const report = await extractBillOfWork(
      [{ name: BILL_NAME, text: BILL_TEXT }, { name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }],
      CONTEXT,
      fetcher,
    );

    expect(report.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(report.volumeSource?.documents).toEqual([DESCRIPTION_NAME]);
    // ВОР без доверенной таблицы моделью не читается: объёмов и суммы это не меняет, а токены стоят денег.
    expect(fetcher.calls).toEqual([]);
    expect(report.tokensUsed).toBe(0);
    expect(report.billReference).toEqual([]);
    expect(report.volumeSource?.note).toContain("ведомость объёмов работ «Ведомость объёмов работ.xlsx» в расчёт не берётся");
    expect(report.volumeSource?.details?.some((line) => line.includes("не сверялась"))).toBe(true);
  });

  it("ВОР, ссылающийся на позиции ЛС, — производный документ: объёмы из ЛСР, модель по нему не зовётся", async () => {
    const fetcher = forbiddenModel();
    const report = await extractBillOfWork(
      [{ name: BILL_NAME, text: DERIVED_TEXT }, { name: DESCRIPTION_NAME, text: DESCRIPTION_TEXT }],
      CONTEXT,
      fetcher,
    );

    expect(report.volumeSource?.level).toBe("CUSTOMER_ESTIMATE");
    expect(report.volumeSource?.documents).toEqual([DESCRIPTION_NAME]);
    expect(fetcher.calls).toEqual([]);
  });

  it("без ЛСР формы 421/пр настоящий ВОР, прочитанный моделью, по-прежнему главный", async () => {
    const report = await extractBillOfWork([{ name: BILL_NAME, text: BILL_TEXT }], CONTEXT, modelFor(billRows));

    expect(report.volumeSource?.level).toBe("BILL");
    expect(report.volumeSource?.documents).toEqual([BILL_NAME]);
    expect(report.billReference).toEqual([]);
  });
});

describe("обрезанный ответ модели делится пополам", () => {
  /** Строки «N Работа … | м3 | N», каждая — своя позиция; текст длиннее порога деления. */
  const LINES = Array.from({ length: 40 }, (_, index) => {
    const n = index + 1;
    return `${String(n)} Устройство конструктивного элемента номер ${String(n)} с подробным описанием состава работ и материалов | м3 | ${String(n)}`;
  });
  const TEXT = ["ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ", ...LINES].join("\n");

  const rowFor = (line: string): BillExtractionRow => {
    const number = /^(\d+) /.exec(line)?.[1] ?? "0";
    return {
      workName: `Устройство конструктивного элемента номер ${number}`,
      quantity: number,
      unit: "м3",
      evidenceQuote: line,
    };
  };

  /** Модель, которая на всём фрагменте обрывается, а на половине отвечает целиком. */
  function modelThatTruncatesBigChunks(limit: number): BillRowsFetcher & { sizes: number[] } {
    const sizes: number[] = [];
    const fetcher = vi.fn(async (request: BillRowsRequest) => {
      sizes.push(request.chunk.length);
      const lines = request.chunk.split("\n").filter((line) => /^\d+ Устройство/.test(line));
      if (request.chunk.length > limit) {
        return { rows: lines.slice(0, 3).map(rowFor), hasBill: true, tokens: 100, malformed: 0, truncated: true };
      }
      return { rows: lines.map(rowFor), hasBill: true, tokens: 50, malformed: 0, truncated: false };
    }) as unknown as BillRowsFetcher & { sizes: number[] };
    fetcher.sizes = sizes;
    return fetcher;
  }

  it("кусок делится и запрашивается повторно: все 40 строк на месте, потери нет", async () => {
    const fetcher = modelThatTruncatesBigChunks(TEXT.length - 1);
    const report = await extractBillOfWork([{ name: "Ведомость объёмов работ.docx", text: TEXT }], CONTEXT, fetcher);

    expect(itemsOf(report)).toHaveLength(40);
    expect(new Set(itemsOf(report).map((item) => item.quantity)).size).toBe(40);
    expect(fetcher.sizes).toHaveLength(3);
    expect(report.truncatedAnswers).toBe(1);
    expect(report.splitAnswers).toBe(1);
    expect(report.incompleteAnswers).toBe(0);
    // Токены оборванного ответа потрачены и посчитаны.
    expect(report.tokensUsed).toBe(100 + 50 + 50);
  });

  it("глубокая обрезка: делится, пока ответы не станут полными (глубина не больше трёх)", async () => {
    // Целиком и половины обрываются, четверти — нет: два уровня деления.
    const fetcher = modelThatTruncatesBigChunks(Math.floor(TEXT.length * 0.4));
    const report = await extractBillOfWork([{ name: "Ведомость объёмов работ.docx", text: TEXT }], CONTEXT, fetcher);

    expect(itemsOf(report)).toHaveLength(40);
    expect(report.incompleteAnswers).toBe(0);
    expect(report.splitAnswers).toBe(3);
    expect(fetcher.sizes).toHaveLength(7);
    expect(Math.max(...fetcher.sizes)).toBe(TEXT.length);
  });

  it("ответ, упёршийся в предел строк, тоже неполный: фрагмент делится, строки не пропадают тихо", async () => {
    const calls: number[] = [];
    // Послушная модель: больше MAX_BILL_ROWS_PER_CHUNK строк за вызов не отдаёт.
    const fetcher = vi.fn(async (request: BillRowsRequest) => {
      calls.push(request.chunk.length);
      const lines = request.chunk.split("\n").filter((line) => /^\d+ Устройство/.test(line));
      return { rows: lines.slice(0, MAX_BILL_ROWS_PER_CHUNK).map(rowFor), hasBill: true, tokens: 10, malformed: 0, truncated: false };
    }) as unknown as BillRowsFetcher;
    const report = await extractBillOfWork([{ name: "Ведомость объёмов работ.docx", text: TEXT }], CONTEXT, fetcher);

    expect(itemsOf(report)).toHaveLength(40);
    expect(report.splitAnswers).toBe(1);
    expect(report.truncatedAnswers).toBe(0);
  });

  it("всегда обрезающая модель не вызывает лавину: не больше 1+2+4+8 вызовов, остаток назван неполным", async () => {
    const fetcher = vi.fn(async () => ({ rows: [], hasBill: true, tokens: 1, malformed: 0, truncated: true })) as unknown as BillRowsFetcher;
    const longText = [TEXT, ...Array.from({ length: 80 }, (_, index) => LINES[index % LINES.length] as string)].join("\n");
    const report = await extractBillOfWork([{ name: "Ведомость объёмов работ.docx", text: longText }], CONTEXT, fetcher);

    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeLessThanOrEqual(2 ** (MAX_SPLIT_DEPTH + 1) - 1);
    expect(report.incompleteAnswers).toBe(2 ** MAX_SPLIT_DEPTH);
    expect(report.volumeSource).toBeNull();
  });
});

describe("сверка в смете контракта: текст без ЛСР не создаёт сверки", () => {
  it("только смета контракта — сверять не с чем", async () => {
    const report = await extractBillOfWork([{ name: CONTRACT_NAME, text: CONTRACT_ESTIMATE_TEXT }], CONTEXT, forbiddenModel());

    expect(report.contractCheck).toBeNull();
    expect(report.customerLsrs).toEqual([]);
  });
});
