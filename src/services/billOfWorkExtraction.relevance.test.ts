import { afterEach, describe, expect, it, vi } from "vitest";

import { extractBillOfWork, skippedNoVolumeNotes, type BillRowsFetcher, type BillRowsRequest } from "@/services/billOfWorkExtraction";

/**
 * Документы без объёмов не уходят в модель, а в отчёте названы. Модель здесь — заглушка: настоящих вызовов нет.
 */

const CONTEXT = { regNumber: "0134300025826000377", subject: "Капитальный ремонт кровли" };

const CONTRACT = [
  "ПРОЕКТ",
  "МУНИЦИПАЛЬНЫЙ КОНТРАКТ № ____",
  "1.1. Подрядчик обязуется выполнить работы по капитальному ремонту кровли в соответствии с Техническим заданием.",
  "1.2. Срок выполнения работ — 90 календарных дней с даты заключения Контракта.",
  "3.1. За каждый день просрочки начисляется пеня в размере 1/300 ключевой ставки.",
].join("\n");

const TZ = [
  "Техническое задание на капитальный ремонт кровли",
  "Перечень и объёмы работ",
  "Демонтаж кровельного покрытия из металлочерепицы | м2 | 640",
  "Устройство пароизоляции | м2 | 640",
  "Монтаж утеплителя из минеральной ваты | м3 | 96",
  "Устройство кровельного покрытия из профнастила | м2 | 640",
  "Установка снегозадержателей | м | 120",
  "Монтаж водосточной системы | м | 84",
].join("\n");

const REQUIREMENTS = "Требования к содержанию и составу заявки\nЗаявка должна содержать полное наименование участника и выписку из ЕГРЮЛ.";

/** Заглушка модели: запоминает, что ей прислали, и отвечает пустой ведомостью. */
function recorder(rows: Record<string, unknown>[] = []): BillRowsFetcher & { requests: BillRowsRequest[] } {
  const requests: BillRowsRequest[] = [];
  const fetcher = vi.fn(async (request: BillRowsRequest) => {
    requests.push(request);
    return { rows: rows as never, hasBill: rows.length > 0, tokens: 7, malformed: 0, truncated: false };
  }) as unknown as BillRowsFetcher & { requests: BillRowsRequest[] };
  fetcher.requests = requests;
  return fetcher;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("extractBillOfWork: документы без объёмов не уходят в модель", () => {
  it("проект контракта и требования к заявке не читаются, ТЗ читается; пропущенные названы в отчёте", async () => {
    const fetcher = recorder();
    const report = await extractBillOfWork(
      [
        { name: "Проект контракта.docx", text: CONTRACT },
        { name: "Требования к содержанию и составу заявки.docx", text: REQUIREMENTS },
        { name: "Техническое задание.docx", text: TZ },
      ],
      CONTEXT,
      fetcher,
      { readAllDocuments: false },
    );

    expect(fetcher.requests.map((request) => request.documentName)).toEqual(["Техническое задание.docx"]);
    expect(report.skippedNoVolumes.map((item) => item.name)).toEqual(["Проект контракта.docx", "Требования к содержанию и составу заявки.docx"]);
    expect(report.skippedNoVolumes[0]).toMatchObject({ chars: CONTRACT.length });
    expect(report.skippedNoVolumes[0]?.reason).toContain("проект контракта");
    // Не «ведомости нет», а «не смотрели»: в documentsWithoutBill пропущенные не попадают.
    expect(report.documentsWithoutBill).toEqual(["Техническое задание.docx"]);
    // Уровень пропущенного документа в отчёте остаётся.
    expect(report.documentLevels.map((entry) => entry.name)).toContain("Проект контракта.docx");
  });

  it("строка про пропущенные документы попадает в заметки источника объёмов", async () => {
    const fetcher = recorder([
      {
        workName: "Устройство пароизоляции",
        quantity: "640",
        unit: "м2",
        evidenceQuote: "Устройство пароизоляции | м2 | 640",
        quantityQuote: "Устройство пароизоляции | м2 | 640",
      },
    ]);
    const report = await extractBillOfWork(
      [
        { name: "Проект контракта.docx", text: CONTRACT },
        { name: "Техническое задание.docx", text: TZ },
      ],
      CONTEXT,
      fetcher,
      { readAllDocuments: false },
    );

    expect(report.volumeSource?.details?.some((line) => line.includes("Модель не читала 1 док.") && line.includes("Проект контракта.docx"))).toBe(true);
  });

  it("ESTIMATE_READ_ALL_DOCUMENTS=1 возвращает чтение всех документов, пропусков нет", async () => {
    vi.stubEnv("ESTIMATE_READ_ALL_DOCUMENTS", "1");
    const fetcher = recorder();
    const report = await extractBillOfWork(
      [
        { name: "Проект контракта.docx", text: CONTRACT },
        { name: "Техническое задание.docx", text: TZ },
      ],
      CONTEXT,
      fetcher,
    );

    expect(fetcher.requests.map((request) => request.documentName)).toEqual(["Проект контракта.docx", "Техническое задание.docx"]);
    expect(report.skippedNoVolumes).toEqual([]);
  });

  it("опция readAllDocuments сильнее окружения", async () => {
    vi.stubEnv("ESTIMATE_READ_ALL_DOCUMENTS", "1");
    const fetcher = recorder();
    const report = await extractBillOfWork([{ name: "Проект контракта.docx", text: CONTRACT }], CONTEXT, fetcher, { readAllDocuments: false });
    expect(fetcher.requests).toHaveLength(0);
    expect(report.skippedNoVolumes).toHaveLength(1);
  });

  it("архив: в модель уходит только читаемая часть, цитата из неё подтверждается, пропущенный файл назван с архивом", async () => {
    const archive = `=== Проект контракта.docx ===\n${CONTRACT}\n=== ТЗ.pdf ===\n${TZ}\n`;
    const fetcher = recorder([
      {
        workName: "Устройство пароизоляции",
        quantity: "640",
        unit: "м2",
        evidenceQuote: "Устройство пароизоляции | м2 | 640",
        quantityQuote: "Устройство пароизоляции | м2 | 640",
      },
    ]);
    const report = await extractBillOfWork([{ name: "Документация.zip", text: archive }], CONTEXT, fetcher, { readAllDocuments: false });

    expect(fetcher.requests).toHaveLength(1);
    const sent = fetcher.requests[0]?.chunk ?? "";
    expect(sent).toContain("=== ТЗ.pdf ===");
    expect(sent).not.toContain("1/300 ключевой ставки");
    expect(report.skippedNoVolumes.map((item) => item.name)).toEqual(["Проект контракта.docx (в Документация.zip)"]);
    // Строка принята: цитата найдена в тексте, который реально ушёл в модель.
    expect(report.sections.flatMap((section) => section.items).map((item) => item.workName)).toEqual(["Устройство пароизоляции"]);
    expect(report.rejected).toEqual([]);
  });

  it("архив из одних безобъёмных файлов не вызывает модель вовсе и не попадает в «без ведомости»", async () => {
    const archive = `=== Проект контракта.docx ===\n${CONTRACT}\n=== Анкета участника.docx ===\nАнкета. Полное наименование: ______\n`;
    const fetcher = recorder();
    const report = await extractBillOfWork([{ name: "Документация.zip", text: archive }], CONTEXT, fetcher, { readAllDocuments: false });

    expect(fetcher).not.toHaveBeenCalled();
    expect(report.skippedNoVolumes).toHaveLength(2);
    expect(report.documentsWithoutBill).toEqual([]);
    expect(report.volumeSource).toBeNull();
  });

  it("безымянный документ с объёмами читается; незнакомое имя читается", async () => {
    const fetcher = recorder();
    await extractBillOfWork(
      [
        { name: "Приложение 1.docx", text: TZ },
        { name: "Пояснительная записка.docx", text: "Раздел 5. Ответственность" },
      ],
      CONTEXT,
      fetcher,
      { readAllDocuments: false },
    );
    expect(fetcher.requests.map((request) => request.documentName)).toEqual(["Приложение 1.docx", "Пояснительная записка.docx"]);
  });
});

describe("skippedNoVolumeNotes", () => {
  it("пусто, когда ничего не пропущено", () => {
    expect(skippedNoVolumeNotes([])).toEqual([]);
  });

  it("называет число, первые пять имён и причину первого; хвост сворачивает", () => {
    const skipped = Array.from({ length: 7 }, (_, index) => ({ name: `Файл ${String(index + 1)}.docx`, reason: `причина ${String(index + 1)}`, chars: 10 }));
    const [note] = skippedNoVolumeNotes(skipped);
    expect(note).toContain("Модель не читала 7 док.");
    expect(note).toContain("«Файл 5.docx»");
    expect(note).not.toContain("«Файл 6.docx»");
    expect(note).toContain("и ещё 2");
    expect(note).toContain("Причина первого: причина 1");
  });
});
