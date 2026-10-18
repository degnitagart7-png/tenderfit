import { describe, it, expect } from "vitest";
import { describeSyncJobReport } from "./syncJobReport";

describe("describeSyncJobReport", () => {
  it("обычный итог загрузки документации", () => {
    expect(
      describeSyncJobReport({
        tenders: 12,
        documents: 8,
        already: 3,
        unavailable: 1,
      }),
    ).toBe("закупок 12, загружено 8, уже было 3, недоступно 1");
  });

  it("нулевые значения остаются видимыми", () => {
    // «загружено 0» — утверждение, а не отсутствие данных: прогон состоялся
    // и не получил ни одного файла. Скрывать ноль значит показать успех там,
    // где его не было.
    expect(describeSyncJobReport({ tenders: 4, documents: 0, already: 0, unavailable: 4 })).toBe(
      "закупок 4, загружено 0, уже было 0, недоступно 4",
    );
  });

  it("отсутствующее поле показывается нулём, а не пропадает", () => {
    expect(describeSyncJobReport({ tenders: 3 })).toBe(
      "закупок 3, загружено 0, уже было 0, недоступно 0",
    );
  });

  it("редкие исходы добавляются к строке", () => {
    expect(
      describeSyncJobReport({ tenders: 5, documents: 2, notFound: 1, failed: 2 }),
    ).toContain("не найдено 1");
    expect(describeSyncJobReport({ tenders: 5, failed: 1 })).toContain("сбоев 1");
    expect(describeSyncJobReport({ tenders: 5, analysisJobs: 3 })).toContain(
      "задач разбора закрыто 3",
    );
  });

  it("прерванный по времени прогон говорит об этом прямо", () => {
    expect(describeSyncJobReport({ tenders: 60, documents: 12, stoppedEarly: true })).toContain(
      "прервано по времени",
    );
    expect(describeSyncJobReport({ tenders: 60, documents: 12 })).not.toContain(
      "прервано по времени",
    );
  });

  it("плановый прогон описывается своей строкой", () => {
    expect(describeSyncJobReport({ note: "Готово: 64 сохранено, 12 документов" })).toBe(
      "Готово: 64 сохранено, 12 документов",
    );
  });

  it("пустой отчёт не выдаётся за нули", () => {
    expect(describeSyncJobReport(null)).toBe("отчёт не заполнен");
    expect(describeSyncJobReport({})).toBe("отчёт не заполнен");
  });

  it("stoppedEarly: false — измеренное значение, а не пустота", () => {
    expect(describeSyncJobReport({ stoppedEarly: false })).toBe(
      "закупок 0, загружено 0, уже было 0, недоступно 0",
    );
  });

  /**
   * Смета — тоже выполненное задание, и журнал обязан говорить о ней то же,
   * что о прогоне источников.
   *
   * Живой прогон 75d560fc закончился готовой книгой на 13 позиций, а журнал
   * подписал его «отчёт не заполнен»: подпись знала только поля прогона
   * источников и про `report.estimate` не слышала. Отчёт, который называет
   * успех незаполненным, хуже отсутствующего — он заставляет искать поломку
   * там, где её нет.
   */
  it("смета: позиции и токены вместо «отчёт не заполнен»", () => {
    expect(
      describeSyncJobReport({
        estimate: {
          document: {},
          rejected: [],
          documentsWithoutBill: [],
          billItems: 13,
          tokensUsed: 12369,
        },
      }),
    ).toBe("смета: позиций 13, токенов 12369");
  });

  it("смета: отклонённые строки и документы без ведомости видны", () => {
    expect(
      describeSyncJobReport({
        estimate: {
          document: {},
          rejected: [{}, {}, {}],
          documentsWithoutBill: ["Договор.docx"],
          billItems: 13,
          tokensUsed: 12369,
        },
      }),
    ).toBe("смета: позиций 13, токенов 12369, отклонено строк 3, без ведомости 1");
  });

  it("смета: источник объёмов виден в журнале", () => {
    expect(
      describeSyncJobReport({
        estimate: {
          document: {},
          rejected: [],
          documentsWithoutBill: [],
          billItems: 9,
          tokensUsed: 100,
          volumeSource: { level: "CUSTOMER_ESTIMATE", documents: ["Смета.pdf"], note: "" },
        },
      }),
    ).toBe("смета: позиций 9, токенов 100, объёмы: смета заказчика");
  });

  it("смета без позиций: это отчёт, а не пустота", () => {
    expect(
      describeSyncJobReport({
        estimate: {
          document: null,
          rejected: [],
          documentsWithoutBill: ["Договор.docx"],
          billItems: 0,
          tokensUsed: 840,
        },
      }),
    ).toBe("смета: позиций 0, токенов 840, без ведомости 1");
  });
  it("аудит сметы заказчика: смет и «токенов 0», без позиций сметы", () => {
    expect(describeSyncJobReport({ audit: { reports: [{}, {}], notRecognized: [] } as never })).toBe("аудит сметы заказчика: смет 2, токенов 0");
  });

  it("аудит: сметы не по форме 421/пр видны в строке", () => {
    expect(describeSyncJobReport({ audit: { reports: [{}], notRecognized: [{}, {}, {}] } as never })).toBe(
      "аудит сметы заказчика: смет 1, токенов 0, не по форме 421/пр 3",
    );
  });
});
