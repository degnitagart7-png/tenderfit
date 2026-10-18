import { describe, expect, it, vi } from "vitest";

import {
  extractBillOfWork,
  parseBillResponse,
  type BillRowsFetcher,
  type BillRowsRequest,
} from "@/services/billOfWorkExtraction";

const CONTEXT = { regNumber: "0134300025826000377", subject: "Капитальный ремонт фасада" };

const VOR = [
  "Ведомость объемов работ",
  "№ п/п\tНаименование\tЕд. изм.\tКол-во\tПримечание",
  "ул. Возрождения, д. 46",
  "1\tДемонтаж оконных откосов\tмп/шт\t68,7/46\t*В целях доступа к профлисту. b = 300 мм",
  "2\tДемонтаж профлиста\tм2\t199,1",
  "3\tРез профлиста\tмп\t59,3\tУШМ",
  "4\tМонтаж утеплителя\tм2\t56,5\th = 150 мм",
  "5\tМонтаж профлиста\tм2\t199,1",
  "Утилизация мусора",
  "1\tУтилизация строительного мусора\tм3/т\t11,3/1,13\t*Вывоз на полигон ТБО, 51км",
].join("\n");

/** Та же ведомость, но в csv-виде листа xlsx: другой файл, те же строки. */
const VOR_CSV = [
  "=== Лист1 ===",
  "Ведомость объемов работ,,,,",
  "№ п/п,Наименование,Ед. изм.,Кол-во,Примечание",
  "ул. Возрождения д. 46,,,,",
  "1,Демонтаж оконных откосов,мп/шт,\"68,7/46\",*В целях доступа к профлисту. b = 300 мм",
  "2,Демонтаж профлиста,м2,\"199,1\",",
  "3,Рез профлиста,мп,\"59,3\",УШМ",
  "4,Монтаж утеплителя,м2,\"56,5\",h = 150 мм",
  "5,Монтаж профлиста,м2,\"199,1\",",
  "Утилизация мусора,,,,",
  "1,Утилизация строительного мусора,м3/т,\"11,3/1,13\",*Вывоз на полигон ТБО, 51км",
].join("\n");

function stubFetcher(): BillRowsFetcher {
  return vi.fn(async (_request: BillRowsRequest) => ({
    ...parseBillResponse(JSON.stringify({ has_bill: false, rows: [] })),
    tokens: 100,
  }));
}

describe("extractBillOfWork: таблица, прочитанная кодом", () => {
  it("модель по документу с доверенной таблицей не зовётся, токены 0, уровень — ведомость", async () => {
    const fetcher = stubFetcher();
    const report = await extractBillOfWork([{ name: "Ведомость объемов работ.odt", text: VOR }], CONTEXT, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(report.tokensUsed).toBe(0);
    expect(report.rejected).toHaveLength(0);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]?.items).toHaveLength(6);
    expect(report.volumeSource?.level).toBe("BILL");
    expect(report.volumeSource?.documents).toEqual(["Ведомость объемов работ.odt"]);
    expect(report.volumeSource?.details?.join(" ")).toContain("прочитана таблицей, без модели");

    const waste = report.sections[0]?.items.find((item) => item.workName.startsWith("Утилизация"));
    expect(waste).toMatchObject({ quantityUnit: "т", quantity: 1.13, billSection: "Утилизация мусора" });
    expect(waste?.volumeVariants).toHaveLength(2);
  });

  it("строки, которые не удалось прочитать, попадают в отказы с причиной", async () => {
    const text = `${VOR}\n`.replace(
      "5\tМонтаж профлиста\tм2\t199,1",
      "5\tМонтаж профлиста\tм2\t199,1\n6\tМонтаж отливов\tмп\tпо проекту",
    );
    const report = await extractBillOfWork([{ name: "Ведомость объемов работ.odt", text }], CONTEXT, stubFetcher());

    expect(report.sections[0]?.items).toHaveLength(6);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.reason).toBe("BAD_QUANTITY");
    expect(report.rejected[0]?.documentName).toBe("Ведомость объемов работ.odt");
  });

  it("копия той же ведомости в другом файле (xlsx) не удваивает строки", async () => {
    const fetcher = stubFetcher();
    const report = await extractBillOfWork(
      [
        { name: "Ведомость объемов работ.odt", text: VOR },
        { name: "Ведомость объемов работ.xlsx", text: VOR_CSV },
      ],
      CONTEXT,
      fetcher,
    );

    expect(fetcher).not.toHaveBeenCalled();
    const items = report.sections.flatMap((section) => section.items);
    expect(items).toHaveLength(6);
    expect(report.duplicateDocuments).toEqual([
      { name: "Ведомость объемов работ.xlsx", duplicateOf: "Ведомость объемов работ.odt" },
    ]);
  });

  it("документ без таблицы по-прежнему читает модель", async () => {
    const text = "Техническое задание. Выполнить демонтаж профлиста, монтаж утеплителя и профлиста по фасаду здания.";
    const fetcher = stubFetcher();
    const report = await extractBillOfWork([{ name: "ТЗ.docx", text }], CONTEXT, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report.tokensUsed).toBe(100);
  });

  it("в наборе из ТЗ и ведомости модель зовётся только по ТЗ", async () => {
    const fetcher = stubFetcher();
    const report = await extractBillOfWork(
      [
        { name: "ТЗ.docx", text: "Техническое задание. Работы по ремонту фасада здания выполняются по ведомости." },
        { name: "Ведомость объемов работ.odt", text: VOR },
      ],
      CONTEXT,
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ documentName: "ТЗ.docx" });
    expect(report.volumeSource?.level).toBe("BILL");
  });
});
