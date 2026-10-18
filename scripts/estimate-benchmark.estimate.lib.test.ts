import { describe, expect, it } from "vitest";

import { EMPTY_GENERATED_STATS } from "../src/domain/estimate/generatedItems";
import { EMPTY_NORM_PICK_STATS } from "../src/domain/estimate/normPick";
import type { BillOfWorkItem } from "../src/domain/estimate/types";
import {
  e2eJobId,
  EMPTY_LINES_BY_SOURCE,
  formatEstimateOnlySummary,
  moneyAfter,
  nmckFromText,
  priceSourceOf,
  ratioToNmck,
  resolveNmck,
  summarizeLines,
  type EstimateLike,
  type EstimateOnlyReport,
} from "./estimate-benchmark.estimate.lib";

const item = (id: string, workName: string, extra: Partial<BillOfWorkItem> = {}): BillOfWorkItem => ({
  id,
  workName,
  quantity: 10,
  quantityUnit: "м2",
  unitDivisor: 1,
  normCode: null,
  normBaseType: null,
  resourceCode: null,
  sourceQuote: null,
  sourceDocument: "ТЗ.docx",
  ...extra,
});

function line(itemId: string, total: number, extra: Record<string, unknown> = {}) {
  return {
    itemId,
    normBaseType: "ГЭСН",
    normCode: `01-01-00${itemId}-01`,
    normName: `Норма ${itemId}`,
    normUnit: "100 м2",
    quantity: 0.1,
    billQuantity: 10,
    billUnit: "м2",
    directCost: total * 0.8,
    overheadCost: total * 0.12,
    profitCost: total * 0.08,
    sourceDocument: "ТЗ.docx",
    ...extra,
  };
}

/** Смета из семи строк: по одной на каждый источник цены. */
function estimate(): EstimateLike {
  const lines = [
    line("1", 1000),
    line("2", 5000),
    line("3", 300, { priceSource: "CUSTOMER_PRICE", priceNote: "по цене заказчика" }),
    line("4", 200, { priceSource: "FGIS_SERVICE", normBaseType: "ФГИС ЦС ПРР", normCode: "49-1" }),
    line("5", 900),
    line("6", 100, { priceSource: "OWN_PRICE" }),
    line("7", 7000),
  ];
  return {
    document: { sections: [{ title: "Раздел", lines }] as never, totals: { workCost: 14500 } as never },
    bill: {
      sections: [
        {
          title: "Ведомость",
          items: [
            item("1", "Демонтаж профлиста"),
            item("2", "Монтаж утеплителя"),
            item("3", "Оборудование по КП"),
            item("4", "Погрузка мусора", { generated: "DEBRIS", generatedNote: "мусор по нормам" }),
            item("5", "Труба стальная", { resourceCode: "07.2.07.12-0068" }),
            item("6", "Позиция по своей цене"),
            item("7", "Устройство лесов", { generated: "AI_IMPLIED", generatedNote: "добавлено ИИ: леса" }),
            item("8", "Размещение мусора", { generated: "DEBRIS", generatedUnpricedReason: "тариф полигона не известен" }),
          ],
        },
      ],
      rows: [
        { itemId: "1", basis: "NAME", reviewReason: null },
        { itemId: "2", basis: "AI", reviewReason: null },
        { itemId: "3", basis: "NONE", reviewReason: "цена заказчика" },
        { itemId: "5", basis: "NONE", reviewReason: null },
      ],
    },
  };
}

describe("priceSourceOf", () => {
  it("порядок: добавлено расчётом, услуга, цена заказчика, цена человека, ресурс, ИИ-норма, норма", () => {
    expect(priceSourceOf({}, { generated: "DEBRIS", resourceCode: null }, undefined)).toBe("generated");
    expect(priceSourceOf({ priceSource: "FGIS_SERVICE" }, { resourceCode: null }, undefined)).toBe("service");
    expect(priceSourceOf({ priceSource: "CUSTOMER_PRICE" }, { resourceCode: null }, undefined)).toBe("customerPrice");
    expect(priceSourceOf({ priceSource: "OWN_PRICE" }, { resourceCode: null }, undefined)).toBe("ownPrice");
    expect(priceSourceOf({}, { resourceCode: "91.05.01-017" }, { basis: "NONE" })).toBe("resource");
    expect(priceSourceOf({}, { resourceCode: null }, { basis: "AI" })).toBe("aiNorm");
    expect(priceSourceOf({}, { resourceCode: null }, { basis: "CODE" })).toBe("norm");
    expect(priceSourceOf({}, undefined, undefined)).toBe("norm");
  });
});

describe("summarizeLines", () => {
  const summary = summarizeLines(estimate(), 3);

  it("строки по источнику цены: сумма равна числу строк сметы, один источник на строку", () => {
    expect(summary.pricedLines).toBe(7);
    expect(summary.linesBySource).toEqual({ norm: 1, aiNorm: 1, resource: 1, customerPrice: 1, ownPrice: 1, service: 0, generated: 2 });
    expect(Object.values(summary.linesBySource).reduce((sum, count) => sum + count, 0)).toBe(7);
    expect(EMPTY_LINES_BY_SOURCE.norm).toBe(0);
  });

  it("главные строки по рублям: по убыванию, с долей в СМР, нормой, основанием и пояснением", () => {
    expect(summary.topLines.map((entry) => entry.total)).toEqual([7000, 5000, 1000]);
    expect(summary.topLines[0]).toMatchObject({
      name: "Устройство лесов",
      norm: "ГЭСН 01-01-007-01",
      quantity: 10,
      unit: "м2",
      sharePercent: 48.28,
      priceSource: "generated",
      note: "добавлено ИИ: леса",
    });
    expect(summary.topLines[1]).toMatchObject({ name: "Монтаж утеплителя", basis: "AI / aiNorm" });
  });

  it("добавленные расчётом строки: и посчитанные, и не попавшие в смету (с причиной)", () => {
    expect(summary.generatedRows).toHaveLength(3);
    expect(summary.generatedRows.find((row) => row.name === "Погрузка мусора")).toMatchObject({ kind: "DEBRIS", total: 200, norm: "ФГИС ЦС ПРР 49-1", unpricedReason: null });
    expect(summary.generatedRows.find((row) => row.name === "Устройство лесов")).toMatchObject({ kind: "AI_IMPLIED", total: 7000 });
    expect(summary.generatedRows.find((row) => row.name === "Размещение мусора")).toMatchObject({ total: null, unpricedReason: "тариф полигона не известен" });
  });

  it("по умолчанию — 15 главных строк", () => {
    expect(summarizeLines(estimate()).topLines).toHaveLength(7);
  });
});

describe("НМЦК", () => {
  it("число после подписи: разряды пробелами, запятая или точка; годы, проценты и 44-ФЗ пропускаются", () => {
    expect(moneyAfter(": 12 345 678,90 руб.")).toBe(12345678.9);
    expect(moneyAfter(" составляет 5 000 000 рублей")).toBe(5000000);
    expect(moneyAfter("\t1234567.5")).toBe(1234567.5);
    expect(moneyAfter(" (44-ФЗ, 2026 год, НДС 20 %) 987 654,32")).toBe(987654.32);
    expect(moneyAfter(" не указана")).toBeNull();
  });

  it("из извещения: «Начальная (максимальная) цена контракта: …»", () => {
    const text = "Извещение\nНачальная (максимальная) цена контракта: 24 683 905,00 Российский рубль\nСрок: 90 дней";
    const found = nmckFromText([{ name: "Извещение.docx", text }]);
    expect(found).toMatchObject({ value: 24683905, source: "document" });
    expect(found?.quote).toContain("Извещение.docx");
    expect(found?.quote).toContain("24 683 905,00");
  });

  it("из печатной формы: подпись и значение в таблице через табуляцию", () => {
    const text = "Начальная (максимальная) цена контракта\t3 456 789,12\tруб.";
    expect(nmckFromText([{ name: "Печатная форма.pdf", text }])?.value).toBe(3456789.12);
  });

  it("значение в следующем абзаце — другое поле, не берётся; подписи нет — null", () => {
    expect(nmckFromText([{ name: "Д.docx", text: "Начальная (максимальная) цена контракта не определена\n\nЛимит финансирования 9 999 999,00" }])).toBeNull();
    expect(nmckFromText([{ name: "ТЗ.docx", text: "Выполнить ремонт кровли." }])).toBeNull();
  });

  it("tenders.price важнее документов; нет цены в закупке — из текста", () => {
    const documents = [{ name: "Извещение.docx", text: "Начальная (максимальная) цена контракта: 1 000 000,00" }];
    expect(resolveNmck(5_000_000, documents)).toEqual({ value: 5_000_000, source: "tenders.price", quote: null });
    expect(resolveNmck(null, documents)).toMatchObject({ value: 1_000_000, source: "document" });
    expect(resolveNmck(0, documents)).toMatchObject({ source: "document" });
    expect(resolveNmck(null, [])).toBeNull();
  });

  it("отношение нашего итога с НДС к НМЦК", () => {
    expect(ratioToNmck(15_000_000, { value: 12_000_000, source: "tenders.price", quote: null })).toBe(1.25);
    expect(ratioToNmck(15_000_000, null)).toBeNull();
    expect(ratioToNmck(null, { value: 1, source: "tenders.price", quote: null })).toBeNull();
  });
});

describe("e2eJobId", () => {
  it("метка прогона, не длиннее 64 знаков", () => {
    expect(e2eJobId("32616407955")).toBe("bench-e2e:32616407955");
    expect(e2eJobId("x".repeat(100))).toHaveLength(64);
  });
});

function report(spec: Partial<EstimateOnlyReport> & Pick<EstimateOnlyReport, "tenderId" | "status">): EstimateOnlyReport {
  return {
    regNumber: null,
    message: null,
    notes: [],
    zone: null,
    zoneNotes: [],
    method: null,
    period: null,
    volumeLevel: null,
    volumeNote: null,
    volumeDocuments: [],
    tokens: null,
    modelCalls: 0,
    billItems: null,
    rejected: null,
    documentsWithoutBill: [],
    duplicateDocuments: [],
    pricedLines: null,
    linesBySource: null,
    gapCounts: {},
    totals: null,
    nmck: null,
    ratioToNmck: null,
    topLines: [],
    generatedRows: [],
    normPick: null,
    aiMaterials: [],
    generated: null,
    durationMs: 0,
    ...spec,
  };
}

describe("formatEstimateOnlySummary", () => {
  const summary = summarizeLines(estimate(), 15);
  const ok = report({
    tenderId: "32616407955",
    regNumber: "32616407955",
    status: "OK",
    notes: ["регион закупки в карточке не указан; взят из документов — Московская область"],
    zone: { priceZoneId: 236, zoneName: "Московская область (1 зона)", basis: "REGION", matched: null },
    zoneNotes: ["зона по региону"],
    method: "RESOURCE_INDEX" as never,
    volumeLevel: "BILL",
    volumeNote: "объёмы из ведомости",
    volumeDocuments: ["ВОР.xls"],
    tokens: { bill: 1000, normPick: 500, implied: 200, total: 1700 },
    billItems: 8,
    pricedLines: summary.pricedLines,
    linesBySource: summary.linesBySource,
    gapCounts: { NO_NORM: 2, CUSTOMER_PRICE: 1 },
    totals: { workCost: 14500, beforeVat: 15000, vat: 3000, total: 18000 },
    nmck: { value: 20000, source: "document", quote: "Извещение.docx: Начальная (максимальная) цена контракта: 20 000,00" },
    ratioToNmck: 0.9,
    topLines: summary.topLines,
    generatedRows: summary.generatedRows,
    normPick: { ...EMPTY_NORM_PICK_STATS, normMaterialRequested: 4, normMaterialPicked: 2, normMaterialFallback: 1, normMaterialDeclined: 1, normMaterialRejected: 0 },
    generated: { ...EMPTY_GENERATED_STATS, implied: { ...EMPTY_GENERATED_STATS.implied, proposed: 3, accepted: 1, rejected: 2, notes: ["«Козырёк»: временные меры"] } },
  });
  const failed = report({ tenderId: "32616409061", status: "NO_ZONE", message: "цены зоны не собраны" });
  // Разряды Intl — неразрывные пробелы: для сравнения со строками теста заменяем их обычными.
  const text = formatEstimateOnlySummary([ok, failed], { generatedAt: "2026-10-11T00:00:00.000Z", topN: 15 }).replace(/[\u00a0\u202f]/gu, " ");

  it("сводка: статус, зона, источник объёмов, токены, строки по источнику цены, пробелы, итог, НМЦК и отношение", () => {
    expect(text).toContain("# Расчёт без сметы заказчика: наш итог и НМЦК");
    expect(text).toContain("32616407955");
    expect(text).toContain("Московская область (1 зона) (236)");
    expect(text).toContain("BILL (ВОР.xls)");
    expect(text).toContain("1 700");
    expect(text).toContain("norm 1, aiNorm 1, resource 1, customerPrice 1, ownPrice 1, generated 2");
    expect(text).toContain("NO_NORM 2, CUSTOMER_PRICE 1");
    expect(text).toContain("18 000,00");
    expect(text).toContain("20 000,00 (из документа)");
    expect(text).toContain("90,00 %");
    expect(text).toContain("NO_ZONE: цены зоны не собраны");
  });

  it("по закупке: главные строки, добавленные расчётом, пометки и причины отклонений", () => {
    expect(text).toContain("### Главные строки по рублям");
    expect(text).toContain("Устройство лесов");
    expect(text).toContain("### Добавлено расчётом сверх ведомости");
    expect(text).toContain("нет в смете: тариф полигона не известен");
    expect(text).toContain("взят из документов — Московская область");
    expect(text).toContain("НМЦК: Извещение.docx");
    expect(text).toContain("Работы по технологии: предложено 3, принято 1, отклонено 2");
    expect(text).toContain("Материал нормы «по проекту» (ресурс без марки с числовым расходом): отправлено модели 4, выбрала модель 2, выбран кодом без модели 1, отказ модели 1, отклонено проверкой 0.");
  });
});

describe("материалы, подобранные ИИ, в сводке режима --estimate-only", () => {
  const material = {
    kind: "NORM_MATERIAL" as const,
    itemId: "bitumen",
    lineName: "Устройство кровель из листов волнистых битумных",
    norm: "ГЭСН 12-01-007-12",
    lineTotal: 675223,
    normResource: { code: "12.1.02.06", name: "Листы волнистые битумные" },
    picked: { code: "12.1.02.06-0001", name: "Лист волнистый битумный", unit: "м2" },
    quantity: 504,
    unitPrice: 520,
    total: 262080,
    pick: "AI" as const,
    review: false,
    reason: "битумный волнистый лист",
    confidence: "high" as const,
  };
  const text = formatEstimateOnlySummary([report({ tenderId: "0391300028226000005", status: "OK", aiMaterials: [material, { ...material, itemId: "profiled", lineName: "Монтаж кровли из профилированного листа", total: 1108800 }] })], {
    generatedAt: "2026-10-11T00:00:00.000Z",
    topN: 15,
  }).replace(/[\u00a0\u202f]/gu, " ");

  it("раздел по закупке: главные по рублям, дорогое покрытие первым", () => {
    expect(text).toContain("### Материалы, подобранные ИИ (2 из 2 по рублям");
    expect(text).toContain("ГЭСН 12-01-007-12");
    expect(text).toContain("12.1.02.06 Листы волнистые битумные");
    expect(text).toContain("1 108 800,00");
    expect(text.indexOf("Монтаж кровли из профилированного листа")).toBeLessThan(text.indexOf("Устройство кровель из листов волнистых битумных"));
  });

  it("закупка без подобранных материалов раздела не получает", () => {
    expect(formatEstimateOnlySummary([report({ tenderId: "1", status: "OK" })], { generatedAt: "2026-10-11T00:00:00.000Z", topN: 15 })).not.toContain("Материалы, подобранные ИИ");
  });
});
