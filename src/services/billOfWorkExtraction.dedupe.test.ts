import { describe, expect, it, vi } from "vitest";

import {
  extractBillOfWork,
  parseBillResponse,
  type BillRowsFetcher,
  type BillRowsRequest,
} from "@/services/billOfWorkExtraction";

const CONTEXT = { regNumber: "32616407955", subject: "Капитальный ремонт здания" };

/** Копия ВОР в виде xls: у таблицы уверенная шапка, её читает код — цитата со знаками табуляции. */
const VOR_XLS = [
  "Ведомость объемов работ",
  "№ п/п\tНаименование\tЕд. изм.\tКол-во",
  "Раздел 1. Фасад",
  "63\tУстройство поясков из кирпича\tм3\t1,5",
  "64\tКладка стен из кирпича\tм3\t12,4",
  "65\tУстройство поясов: в опалубке\tм3\t7,52",
  "66\tОкраска фасадов\tм2\t310",
  "Раздел 2. Кровля",
  "67\tУстройство поясков, 0,1726 100 м\t100 м\t0,1726",
  "68\tУстройство кровли\tм2\t120",
  "69\tУстройство поясков, 0,1726 100 м\t100 м\t0,1726",
].join("\n");

/** Та же ведомость в .doc, преобразованная в csv-подобный вид без шапки таблицы: код её не читает, читает модель. */
const VOR_DOC = [
  "Ведомость объемов работ",
  '63,Устройство поясков из кирпича,м3,"1,5"',
  '64,Кладка стен из кирпича,м3,"12,4"',
  '65,Устройство поясов: в опалубке,м3,"7,52 "',
  '66,Окраска фасадов,м2,"310"',
  '67,"Устройство поясков, 0,1726 100 м",100 м,"0,1726"',
  '68,Устройство кровли,м2,"120"',
  '69,"Устройство поясков, 0,1726 100 м",100 м,"0,1726"',
].join("\n");

function modelRows(lines: readonly { name: string; quantity: string; unit: string; quote: string }[]): string {
  return JSON.stringify({
    has_bill: true,
    rows: lines.map((line) => ({
      work_name: line.name,
      quantity: line.quantity,
      unit: line.unit,
      evidence_quote: line.quote,
    })),
  });
}

function fetcherFor(reply: string): BillRowsFetcher {
  return vi.fn(async (_request: BillRowsRequest) => ({ ...parseBillResponse(reply), tokens: 100 }));
}

const DOC_ANSWER = modelRows([
  { name: "Устройство поясков из кирпича", quantity: "1,5", unit: "м3", quote: '63,Устройство поясков из кирпича,м3,"1,5"' },
  { name: "Кладка стен из кирпича", quantity: "12,4", unit: "м3", quote: '64,Кладка стен из кирпича,м3,"12,4"' },
  { name: "Устройство поясов: в опалубке", quantity: "7,52", unit: "м3", quote: '65,Устройство поясов: в опалубке,м3,"7,52' },
  { name: "Окраска фасадов", quantity: "310", unit: "м2", quote: '66,Окраска фасадов,м2,"310"' },
  { name: "Устройство поясков, 0,1726 100 м", quantity: "0,1726", unit: "100 м", quote: '67,"Устройство поясков, 0,1726 100 м",100 м,"0,1726"' },
  { name: "Устройство кровли", quantity: "120", unit: "м2", quote: '68,Устройство кровли,м2,"120"' },
  // Вторую такую же строку («69») модельный путь уже схлопывает сам (`DUPLICATE` в billExtraction): здесь её нет.
]);

describe("extractBillOfWork: одна ведомость дважды, разными путями чтения (32616407955)", () => {
  it("предпосылка: каждая копия сама по себе читается целиком, но разными путями", async () => {
    const docFetcher = fetcherFor(DOC_ANSWER);
    const doc = await extractBillOfWork([{ name: "Ведомость объемов работ - ДВ.DOC", text: VOR_DOC }], CONTEXT, docFetcher, { retryDelayMs: 0 });
    expect(doc.rejected).toEqual([]);
    expect(doc.sections.flatMap((section) => section.items)).toHaveLength(6);
    expect(docFetcher).toHaveBeenCalledTimes(1);

    const xlsFetcher = fetcherFor(DOC_ANSWER);
    const xls = await extractBillOfWork([{ name: "Ведомость объемов работ - ДВ.XLS", text: VOR_XLS }], CONTEXT, xlsFetcher, { retryDelayMs: 0 });
    expect(xlsFetcher).not.toHaveBeenCalled();
    expect(xls.sections.flatMap((section) => section.items)).toHaveLength(7);
    expect(xls.sections[0]?.items[2]?.sourceQuote).toContain("\t7,52");
  });

  it("копия, прочитанная моделью, не удваивает строки таблицы; документ назван повтором", async () => {
    const fetcher = fetcherFor(DOC_ANSWER);
    const report = await extractBillOfWork(
      [
        { name: "Ведомость объемов работ - ДВ.XLS", text: VOR_XLS },
        { name: "Ведомость объемов работ - ДВ.DOC", text: VOR_DOC },
      ],
      CONTEXT,
      fetcher,
      { retryDelayMs: 0 },
    );

    // Документ прочитан и тем и другим путём: иначе тест ничего не проверяет.
    expect(fetcher).toHaveBeenCalledTimes(1);
    const items = report.sections.flatMap((section) => section.items);
    expect(items).toHaveLength(7);
    expect(items.map((item) => item.sourceDocument)).toEqual(Array(7).fill("Ведомость объемов работ - ДВ.XLS"));
    expect(report.duplicateDocuments).toEqual([
      { name: "Ведомость объемов работ - ДВ.DOC", duplicateOf: "Ведомость объемов работ - ДВ.XLS" },
    ]);
    expect(report.volumeSource?.details?.join(" ")).toContain("повторяет");
  });

  it("законные повторы внутри одного документа остаются: два «Устройство поясков … 0,1726 100 м» в разных разделах", async () => {
    const report = await extractBillOfWork(
      [{ name: "Ведомость объемов работ - ДВ.XLS", text: VOR_XLS }],
      CONTEXT,
      fetcherFor(DOC_ANSWER),
      { retryDelayMs: 0 },
    );
    const items = report.sections.flatMap((section) => section.items);
    expect(items.filter((item) => item.workName.startsWith("Устройство поясков, 0,1726"))).toHaveLength(2);
    expect(report.duplicateDocuments).toEqual([]);
  });

  it("копия с частичным совпадением: убираются только повторившиеся позиции, документ остаётся", async () => {
    const other = modelRows([
      { name: "Кладка стен из кирпича", quantity: "12,4", unit: "м3", quote: '64,Кладка стен из кирпича,м3,"12,4"' },
      { name: "Устройство поясов: в опалубке", quantity: "7,52", unit: "м3", quote: '65,Устройство поясов: в опалубке,м3,"7,52' },
      { name: "Устройство отмостки", quantity: "40", unit: "м2", quote: '70,Устройство отмостки,м2,"40"' },
      { name: "Демонтаж ограждения", quantity: "25", unit: "м", quote: '71,Демонтаж ограждения,м,"25"' },
      { name: "Установка водосточных труб", quantity: "30", unit: "м", quote: '72,Установка водосточных труб,м,"30"' },
    ]);
    const text = [
      "Ведомость объемов работ",
      '64,Кладка стен из кирпича,м3,"12,4"',
      '65,Устройство поясов: в опалубке,м3,"7,52 "',
      '70,Устройство отмостки,м2,"40"',
      '71,Демонтаж ограждения,м,"25"',
      '72,Установка водосточных труб,м,"30"',
    ].join("\n");
    const report = await extractBillOfWork(
      [
        { name: "Ведомость объемов работ - ДВ.XLS", text: VOR_XLS },
        { name: "Допведомость.DOC", text },
      ],
      CONTEXT,
      fetcherFor(other),
      { retryDelayMs: 0 },
    );
    const names = report.sections.flatMap((section) => section.items.filter((item) => item.sourceDocument === "Допведомость.DOC")).map((item) => item.workName);
    expect(names).toEqual(["Устройство отмостки", "Демонтаж ограждения", "Установка водосточных труб"]);
    expect(report.duplicateDocuments).toEqual([]);
    expect(report.volumeSource?.details?.join(" ")).toContain("2 поз. повторяют");
  });

  it("то же наименование, но другой объём — разные позиции", async () => {
    const text = ["Ведомость объемов работ", '64,Кладка стен из кирпича,м3,"30"'].join("\n");
    const reply = modelRows([{ name: "Кладка стен из кирпича", quantity: "30", unit: "м3", quote: '64,Кладка стен из кирпича,м3,"30"' }]);
    const report = await extractBillOfWork(
      [
        { name: "Ведомость объемов работ - ДВ.XLS", text: VOR_XLS },
        { name: "Допведомость.DOC", text },
      ],
      CONTEXT,
      fetcherFor(reply),
      { retryDelayMs: 0 },
    );
    expect(report.sections.flatMap((section) => section.items)).toHaveLength(8);
  });
});
