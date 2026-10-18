import { describe, expect, it } from "vitest";

import { compareTender } from "../src/domain/estimate/benchmark";
import { lsrDocument, type PositionSpec } from "../src/domain/estimate/customerLsr.builders";
import { parseCustomerLsr } from "../src/domain/estimate/customerLsr";
import { buildLsrSet } from "../src/domain/estimate/customerLsrSet";
import type { EstimateDocument, EstimateLine } from "../src/domain/estimate/types";
import { LSR_08_TEXT } from "../src/test/t1118Fixtures";
import {
  BLIND_OUT_DIR,
  buildZoneInput,
  candidateOrFilter,
  cell,
  DEFAULT_OUT_DIR,
  documentsOfRows,
  E2E_OUT_DIR,
  extractLsrHeader,
  formatPriceLevel,
  formatSummary,
  isComparable,
  looksLikeLsrText,
  parseArgs,
  placeOfTender,
  safeFileName,
  splitCells,
  statusOfRun,
  type TenderReport,
} from "./estimate-benchmark.lib";

describe("parseArgs", () => {
  it("значения по умолчанию", () => {
    expect(parseArgs([])).toEqual({ tenders: [], limit: null, out: DEFAULT_OUT_DIR, fromJson: null, zone: null, method: "auto", blind: false, dryRun: false, estimateOnly: false, help: false });
    expect(DEFAULT_OUT_DIR).toBe("/var/tmp/estimate-benchmark");
  });

  it("--tender повторяется и не дублируется; --limit и --out читаются", () => {
    const args = parseArgs(["--tender", "0302300048726001118", "--tender", "abc", "--tender", "abc", "--limit", "25", "--out", "/tmp/x"]);
    expect(args).toMatchObject({ tenders: ["0302300048726001118", "abc"], limit: 25, out: "/tmp/x" });
  });

  it("--from-json требует --zone, и одну закупку", () => {
    expect(() => parseArgs(["--from-json", "docs.json"])).toThrow("--from-json требует --zone");
    expect(parseArgs(["--from-json", "docs.json", "--zone", "236"])).toMatchObject({ fromJson: "docs.json", zone: 236 });
    expect(() => parseArgs(["--from-json", "d.json", "--zone", "1", "--tender", "a", "--tender", "b"])).toThrow("одной закупки");
    // Справка не требует остальных аргументов.
    expect(parseArgs(["--help", "--from-json", "d.json"]).help).toBe(true);
  });

  it("плохие значения — понятная ошибка", () => {
    expect(() => parseArgs(["--limit", "0"])).toThrow("--limit требует целое число");
    expect(() => parseArgs(["--limit", "abc"])).toThrow("--limit требует целое число");
    expect(() => parseArgs(["--limit"])).toThrow("--limit требует целое число");
    expect(() => parseArgs(["--zone", "-3"])).toThrow("--zone требует целое число");
    expect(() => parseArgs(["--out"])).toThrow("--out требует значение");
    expect(() => parseArgs(["--tender", "--limit", "2"])).toThrow("--tender требует значение");
    expect(() => parseArgs(["--method", "x"])).toThrow("auto или resource");
    expect(() => parseArgs(["--bogus"])).toThrow("Неизвестный аргумент: --bogus");
  });

  it("--method resource", () => {
    expect(parseArgs(["--method", "resource"]).method).toBe("resource");
  });

  it("--blind: явные закупки обязательны, свой каталог по умолчанию, --dry-run только с ним", () => {
    expect(() => parseArgs(["--blind"])).toThrow("--blind требует явные закупки");
    const args = parseArgs(["--blind", "--tender", "0302300048726001118", "--tender", "0302300048726001119"]);
    expect(args).toMatchObject({ blind: true, dryRun: false, tenders: ["0302300048726001118", "0302300048726001119"], out: BLIND_OUT_DIR });
    expect(BLIND_OUT_DIR).toBe("/var/tmp/estimate-benchmark-blind");
    expect(parseArgs(["--blind", "--tender", "a", "--out", "/tmp/b", "--dry-run"])).toMatchObject({ out: "/tmp/b", dryRun: true });
    expect(() => parseArgs(["--dry-run", "--tender", "a"])).toThrow("--dry-run работает только с --blind");
    expect(() => parseArgs(["--blind", "--tender", "a", "--from-json", "d.json", "--zone", "1"])).toThrow("с --from-json не сочетается");
    expect(() => parseArgs(["--blind", "--tender", "a", "--limit", "3"])).toThrow("--limit в режиме --blind не нужен");
    // Справка не требует остальных аргументов.
    expect(parseArgs(["--blind", "--help"]).help).toBe(true);
    // Без --blind каталог прежний.
    expect(parseArgs(["--tender", "a"]).out).toBe(DEFAULT_OUT_DIR);
  });
});

describe("parseArgs: --estimate-only", () => {
  it("явные закупки обязательны, свой каталог по умолчанию", () => {
    expect(E2E_OUT_DIR).toBe("/var/tmp/estimate-benchmark-e2e");
    expect(() => parseArgs(["--estimate-only"])).toThrow("--estimate-only требует явные закупки");
    const args = parseArgs(["--estimate-only", "--tender", "32616407955", "--tender", "32616409061"]);
    expect(args).toMatchObject({ estimateOnly: true, blind: false, tenders: ["32616407955", "32616409061"], out: E2E_OUT_DIR });
    expect(parseArgs(["--estimate-only", "--tender", "a", "--out", "/tmp/e"]).out).toBe("/tmp/e");
    expect(parseArgs(["--tender", "a"]).estimateOnly).toBe(false);
  });

  it("не сочетается с --blind, --from-json, --limit, --dry-run; справка работает без остального", () => {
    expect(() => parseArgs(["--estimate-only", "--blind", "--tender", "a"])).toThrow("не сочетаются");
    expect(() => parseArgs(["--estimate-only", "--tender", "a", "--from-json", "d.json", "--zone", "1"])).toThrow("с --from-json не сочетается");
    expect(() => parseArgs(["--estimate-only", "--tender", "a", "--limit", "3"])).toThrow("--limit в режиме --estimate-only не нужен");
    expect(() => parseArgs(["--estimate-only", "--tender", "a", "--dry-run"])).toThrow("--dry-run работает только с --blind");
    expect(parseArgs(["--estimate-only", "--help"]).help).toBe(true);
  });
});

describe("отбор закупок и входа расчёта", () => {
  it("условие поиска: регистр не важен, второй признак — один из трёх маркеров", () => {
    expect(candidateOrFilter()).toBe("parsed_text.ilike.*421/пр*,parsed_text.ilike.*ФСБЦ*,parsed_text.ilike.*ГЭСН*");
    expect(looksLikeLsrText("ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 1 ... ГЭСН01-01")).toBe(true);
    expect(looksLikeLsrText("Локальный сметный расчёт, приказ 421/пр")).toBe(true);
    expect(looksLikeLsrText("Локальный сметный расчёт без шифров")).toBe(false);
    expect(looksLikeLsrText("ГЭСН без слов о смете")).toBe(false);
  });

  it("документы — как у воркера: пустой текст отбрасывается, имя — raw_json.title или имя файла", () => {
    const docs = documentsOfRows([
      { filename: "a.zip", parsed_text: "текст", raw_json: { title: "Описание объекта закупки" } },
      { filename: "b.xlsx", parsed_text: "второй", raw_json: null },
      { filename: "c.pdf", parsed_text: "" },
      { filename: "d.pdf", parsed_text: null },
      { filename: "e.docx", parsed_text: "третий", raw_json: { other: 1 } },
    ]);
    expect(docs).toEqual([
      { name: "Описание объекта закупки", text: "текст" },
      { name: "b.xlsx", text: "второй" },
      { name: "e.docx", text: "третий" },
    ]);
  });

  it("место закупки и вход выбора зоны — как у воркера", () => {
    const tender = { region: "Республика Бурятия", delivery_address: "г. Улан-Удэ", customer_name: "МКУ" };
    expect(placeOfTender(null)).toBeUndefined();
    expect(placeOfTender(tender)).toEqual({ region: "Республика Бурятия", address: "г. Улан-Удэ", customerName: "МКУ" });
    const input = buildZoneInput({ userPriceZoneId: 236, tender, zones: [], built: [{ priceZoneId: 236, zoneName: "Бурятия (5 зона)", subject: "Республика Бурятия" }] });
    expect(input).toEqual({
      userPriceZoneId: 236,
      declared: null,
      tender: { region: "Республика Бурятия", address: "г. Улан-Удэ", customerName: "МКУ" },
      zones: [],
      built: [{ priceZoneId: 236, zoneName: "Бурятия (5 зона)", subject: "Республика Бурятия" }],
    });
    expect(buildZoneInput({ userPriceZoneId: null, tender: null, zones: [], built: [] }).tender).toBeNull();
    const declared = { subject: "Республика Бурятия", zoneName: "Республика Бурятия (5 зона)", zoneNumber: 5 };
    expect(buildZoneInput({ userPriceZoneId: null, tender, zones: [], built: [], declared }).declared).toEqual(declared);
  });

  it("имя файла результата безопасно", () => {
    expect(safeFileName("0302300048726001118")).toBe("0302300048726001118");
    expect(safeFileName("../../etc/passwd")).toBe("etc_passwd");
    expect(safeFileName("a b/c")).toBe("a_b_c");
    expect(safeFileName("///")).toBe("tender");
  });
});

describe("extractLsrHeader: шапка ЛСР заказчика", () => {
  it("читает субъект, зону, метод и программу из настоящей шапки Гранд-Сметы", () => {
    const header = extractLsrHeader(LSR_08_TEXT, "02-02-08  Ремонтные работы по в");
    expect(header.subject).toBe("Республика Бурятия");
    expect(header.zone).toBe("Республика Бурятия (5 зона)");
    expect(header.method).toBe("ресурсно-индексным");
    expect(header.program).toBe("ГРАНД-Смета, версия 2026.2");
    expect(header.edition?.startsWith("Приказ Минстроя России от 30.12.2021 № 1046/пр")).toBe(true);
    expect(header.edition?.length).toBeLessThanOrEqual(160);
  });

  it("ТСН Москвы: база названа в строках о нормативах, метод — базисно-индексный, номер перед субъектом снят", () => {
    const text = [
      "=== Смета ===",
      "Наименование субъекта Российской Федерации ,,,,,77. Город Москва,,",
      "Наименование зоны субъекта Российской Федерации ,,,,,Город Москва,,",
      "Наименование редакции сметных нормативов ,,,,,ТСН-2001 (редакция 2014, с изменениями 2026),,",
      "Составлен ,базисно-индексным,методом,,,",
    ].join("\n");
    expect(extractLsrHeader(text, "Смета")).toMatchObject({
      subject: "Город Москва",
      zone: "Город Москва",
      method: "базисно-индексным",
      base: "ТСН-2001",
      program: null,
    });
  });

  it("база ищется словом: «ТЕР» внутри «МИНИСТЕРСТВА» не база, «ГЭСНр» — база", () => {
    const text = "Реквизиты нормативного акта: ПРИКАЗ МИНИСТЕРСТВА СТРОИТЕЛЬСТВА № 1452\nНаименование редакции сметных нормативов ,,,ГЭСНр 2020, ТЕР-2001";
    expect(extractLsrHeader(text).base).toBe("ГЭСНр, ТЕР-2001");
  });

  it("значение в той же ячейке после двоеточия и таблица Word с табуляцией", () => {
    const text = "Наименование субъекта Российской Федерации: 03. Республика Бурятия\nНаименование зоны\tРеспублика Бурятия (5 зона)\n";
    expect(extractLsrHeader(text)).toMatchObject({ subject: "Республика Бурятия", zone: "Республика Бурятия (5 зона)" });
  });

  it("лист находится по метке: у соседнего листа другая шапка", () => {
    const text = ["=== Первая ===", "Наименование зоны субъекта Российской Федерации ,,A (1 зона)", "=== Вторая ===", "Наименование зоны субъекта Российской Федерации ,,B (2 зона)"].join("\n");
    expect(extractLsrHeader(text, "Вторая").zone).toBe("B (2 зона)");
    expect(extractLsrHeader(text, "Первая").zone).toBe("A (1 зона)");
    // Лист не найден — берётся начало документа.
    expect(extractLsrHeader(text, "Нет такого").zone).toBe("A (1 зона)");
  });

  it("строки выгрузки xlsx кончаются сотней пустых ячеек: шапка на глубине в десятки тысяч знаков всё равно находится", () => {
    const wide = (cells: string[]): string => [...cells, ...Array.from({ length: 150 }, () => "")].join(",");
    const filler = Array.from({ length: 60 }, () => wide(["Служебная строка"]));
    const text = ["=== Лист ===", ...filler, wide(["Наименование субъекта Российской Федерации ", "", "03. Республика Бурятия"]), wide(["Составлен ", "ресурсно-индексным", "методом"])].join("\n");
    expect(text.indexOf("Наименование субъекта")).toBeGreaterThan(9_000);
    expect(extractLsrHeader(text, "Лист")).toMatchObject({ subject: "Республика Бурятия", method: "ресурсно-индексным" });
  });

  it("нет шапки — всё null", () => {
    expect(extractLsrHeader("просто текст без подписей")).toEqual({ subject: null, zone: null, method: null, base: null, edition: null, program: null });
  });

  it("ячейки с запятой в кавычках не рвутся", () => {
    expect(splitCells('Наименование программного продукта,,,"ГРАНД-Смета, версия 2026.2",,')).toEqual(["Наименование программного продукта", "", "", "ГРАНД-Смета, версия 2026.2", "", ""]);
    expect(splitCells("а\tб\t\tв")).toEqual(["а", "б", "", "в"]);
  });
});

describe("уровень цен и статус", () => {
  it("уровень цен из квартала и даты", () => {
    expect(formatPriceLevel({ priceQuarter: { quarter: 2, year: 2026 }, priceDate: "01.04.2026" })).toBe("II кв. 2026 (01.04.2026)");
    expect(formatPriceLevel({ priceQuarter: { quarter: 3, year: 2026 }, priceDate: null })).toBe("III кв. 2026");
    expect(formatPriceLevel({ priceQuarter: null, priceDate: "01.04.2026" })).toBe("01.04.2026");
    expect(formatPriceLevel({ priceQuarter: null, priceDate: null })).toBeNull();
  });

  it("MODEL_NEEDED: заглушку позвали или объёмы не из ЛСР; иначе OK", () => {
    expect(statusOfRun({ modelCalls: 0, volumeLevel: "CUSTOMER_ESTIMATE" })).toBe("OK");
    expect(statusOfRun({ modelCalls: 2, volumeLevel: "CUSTOMER_ESTIMATE" })).toBe("MODEL_NEEDED");
    expect(statusOfRun({ modelCalls: 0, volumeLevel: "SPEC" })).toBe("MODEL_NEEDED");
    expect(statusOfRun({ modelCalls: 0, volumeLevel: null })).toBe("MODEL_NEEDED");
  });

  it("ячейка таблицы: черты экранируются, пустое — тире", () => {
    expect(cell("а|б")).toBe("а\\|б");
    expect(cell("а\nб")).toBe("а б");
    expect(cell(null)).toBe("—");
    expect(cell("")).toBe("—");
    expect(cell(0)).toBe("0");
  });
});

describe("formatSummary", () => {
  const position: PositionSpec = {
    n: 1,
    justification: "ГЭСН01-01-001-01",
    name: "Работа | с чертой",
    unit: "м2",
    qty: 10,
    resources: [
      { code: "1-100-23", unit: "чел.-ч", perUnit: 2, qty: 20, price: 500 },
      { code: "91.05.05-015", unit: "маш.-ч", perUnit: 0.2, qty: 2, price: 1000 },
    ],
    overhead: { ref: "Пр/812-001.1", base: 100 },
    profit: { ref: "Пр/774-001.1", base: 60 },
  };
  const set = buildLsrSet(parseCustomerLsr([{ name: "ЛСР.xlsx", text: lsrDocument({ positions: [position], name: "02-02-01 Тест" }) }]).estimates);
  const ours = {
    itemId: "l1-1",
    normCode: "01-01-001-01",
    normBaseType: "ГЭСН",
    normName: "Норма",
    normUnit: "м2",
    quantity: 10,
    billQuantity: 10,
    billUnit: "м2",
    sourceQuote: null,
    sourceDocument: null,
    labourHours: 20,
    specialistHours: 0,
    labourRate: 500,
    labourCost: 10_000,
    machinistHours: 0,
    machinistSalaryCost: 0,
    machineHours: 2,
    machineCost: 2_000,
    materialCost: 0,
    directCost: 12_000,
    wageFund: 10_000,
    overheadCost: 9_000,
    profitCost: 6_000,
    overheadPercent: 90,
    profitPercent: 60,
    overheadRef: "Пр/812-001.1",
    profitRef: "Пр/774-001.1",
    overheadSource: "NORM_REF",
    profitSource: "NORM_REF",
    resources: [],
    gaps: [],
  } as EstimateLine;
  const document = {
    sections: [{ title: "Раздел", lines: [ours] }],
    totals: { workCost: 27_000, beforeVat: 27_000, vat: 5_940, total: 32_940 },
    gaps: [],
  } as unknown as EstimateDocument;
  const comparison = compareTender({ lsrSet: set, document });

  const report = (overrides: Partial<TenderReport>): TenderReport => ({
    tenderId: "T1",
    regNumber: "0302300048726001118",
    status: "MODEL_NEEDED",
    message: "заглушка модели вызвана 3 раз",
    zone: { priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)", basis: "USER", matched: null },
    method: "RESOURCE_INDEX",
    period: "3 кв. 2026",
    documents: 5,
    modelCalls: 3,
    modelDocuments: ["Проект контракта"],
    volumeLevel: "CUSTOMER_ESTIMATE",
    declared: [
      {
        index: 1,
        number: "02-02-01",
        title: "Тест",
        documentName: "ЛСР.xlsx",
        header: { subject: "Республика Бурятия", zone: "Республика Бурятия (5 зона)", method: "ресурсно-индексным", base: null, edition: null, program: "ГРАНД-Смета" },
        priceLevel: "II кв. 2026 (01.04.2026)",
        declaredZone: 5,
        declaredQuarter: "2 кв. 2026",
      },
    ],
    priceLevelNotes: [],
    zoneNotes: [],
    gapCounts: {},
    comparison,
    durationMs: 1,
    ...overrides,
  });

  it("MODEL_NEEDED с объёмами из ЛСР входит в сводку; закупка без сравнения — в список причин", () => {
    const reports = [report({}), report({ tenderId: "T2", status: "NO_ZONE", message: "Цен по зоне «X» ещё нет", comparison: null, volumeLevel: null, declared: [], zone: null, method: null })];
    expect(isComparable(reports[0] as TenderReport)).toBe(true);
    expect(isComparable(reports[1] as TenderReport)).toBe(false);

    const { text, aggregate } = formatSummary(reports, { generatedAt: "2026-10-10T00:00:00Z", source: "тест", topN: 5 });
    expect(aggregate.tenders).toBe(1);
    expect(text).toContain("# Бенчмарк точности сметы");
    // Таблица закупок: статус, зона, заглавные данные заказчика, итоги и Δ%.
    expect(text).toContain("MODEL_NEEDED: заглушка модели вызвана 3 раз");
    expect(text).toContain("Республика Бурятия / Республика Бурятия (5 зона)");
    expect(text).toContain("II кв. 2026 (01.04.2026)");
    expect(text).toContain("ресурсно-индексным");
    // Рубли по составляющим: НР у нас 90 % вместо 100 % — минус 1 000 ₽ в НР.
    expect(text).toContain("Накладные расходы (НР) | -1");
    // Расходящиеся проценты, корзины, топ с обеими сторонами и экранированной чертой.
    expect(text).toContain("ГЭСН01-01-001-01 | НР | 100,00 | 90,00 | 1");
    expect(text).toContain("только у заказчика");
    expect(text).toContain("Работа \\| с чертой");
    expect(text).toContain("| заказчик |");
    expect(text).toContain("| мы |");
    expect(text).toContain("NO_ZONE | Цен по зоне «X» ещё нет");
  });

  it("пометка об уровне цен выделяет закупку в отдельную группу сводки", () => {
    const { text } = formatSummary([report({ priceLevelNotes: ["Смета заказчика составлена в зоне 5, расчёт в зоне 2"] }), report({ tenderId: "T3" })], {
      generatedAt: "2026-10-10T00:00:00Z",
      source: "тест",
      topN: 5,
    });
    expect(text).toContain("расходится: Смета заказчика составлена в зоне 5, расчёт в зоне 2");
    expect(text).toContain("`PRICE_LEVEL_DIFFERS`");
    expect(text).toContain("уровень цен сметы заказчика совпадает с нашим или в смете не назван | 1 |");
  });

  it("перекрёстная таблица ЭМ × ОТм присутствует", () => {
    const { text } = formatSummary([report({})], { generatedAt: "2026-10-10T00:00:00Z", source: "тест", topN: 5 });
    expect(text).toContain("Арифметика сметы заказчика");
    expect(text).toContain("= наш machineCost (с ОТм)");
  });

  it("пустой список закупок не ломает отчёт", () => {
    const { text, aggregate } = formatSummary([], { generatedAt: "2026-10-10T00:00:00Z", source: "тест", topN: 5 });
    expect(aggregate.tenders).toBe(0);
    expect(text).toContain("_нет данных_");
  });
});
