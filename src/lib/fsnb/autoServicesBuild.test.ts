import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadPriceByCode,
  loadPriceLine,
  parseLoadAutoRows,
  parseLoadPriceRecord,
  parseTransportAutoRows,
  parseTransportSeriesRecord,
  servicesFromRecords,
  transportPriceByCode,
  transportSeriesLine,
} from "@/domain/estimate/autoServices";
import { streamSheetRows } from "@/lib/fsnb/xlsxStream";

/*
  Разбор выгрузок ФГИС ЦС «Сметные цены услуг на перевозку грузов автомобильным транспортом» и
  «…на погрузочно-разгрузочные работы» на вырезках из настоящих файлов зоны 246 (Иркутская
  область, 1 зона, 3 квартал 2026): шапка, нумерация граф и строки данных — как в файлах
  портала, лишь километров меньше. Файлы собираются библиотекой xlsx и читаются тем же
  потоковым чтением, каким их читает сборка зоны.
*/

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-services-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function write(rows: readonly unknown[][], name: string): string {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows as unknown[][]), "Выходная форма");
  const path = join(dir, name);
  XLSX.writeFile(book, path);
  return path;
}

const ZONE = "Иркутская область (1 зона), г. Иркутск";
const ROAD_TITLE = "усовершенствованное (асфальтобетонное, цементобетонное, железобетонное, обработанное органическим вяжущим) дорожное покрытие";
const VEHICLES =
  "Тип автотранспортного средства:  Автобетоносмесители, Автобитумовозы, Автомобили бортовые, Автомобили-балковозы, Автомобили-опоровозы, Автомобили-панелевозы, Автомобили-самосвалы, Автомобили-трубоплетевозы, Автоцистерны";
const CAPACITIES = "Грузоподъемность автотранспортного средства:  до 15 т, до 16 м3, до 20 т, до 22 т, до 25 т, до 30 т, до 6 м3, до 65 т, до 8 м3";

const NOTE =
  "1. Сметные цены услуг на перевозку грузов для строительства автомобильным транспортом, определенные с учетом заработной платы, утвержденной органом исполнительной власти субъекта Российской Федерации, применяются для определения затрат:";

function transportHead(road = ROAD_TITLE): unknown[][] {
  return [
    ["Сметные цены услуг на перевозку грузов для строительства автомобильным транспортом*"],
    [],
    [ZONE],
    ["(наименование субъекта Российской Федерации, номер ценовой зоны и наименование населенного пункта – центра ценовой зоны)"],
    [],
    [road],
    [" (тип дорог)"],
    [],
    [VEHICLES],
    [CAPACITIES],
    ["Период действия:  3 квартал 2026 года"],
    [],
    ["Расстояние перевозки грузов, километров", "Сметные цены услуг на перевозку грузов для строительства автомобильным транспортом, рублей/тонну"],
    ["", "Код перевозки\n1-го класса грузов", "1-й класс грузов", "код перевозки \n2-го класса грузов", "2-й класс грузов", "код перевозки \n3-го класса грузов", "3-й класс грузов", "код перевозки \n4-го класса грузов", "4-й класс грузов"],
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  ];
}

/** Строки данных настоящей выгрузки: самосвалы до 15 т и до 30 т, три типа дорог, километры 46–48; 05-06 — до 100 км. */
const TRANSPORT_ROWS: unknown[][] = [
  [46, "02-15-1-01-0046", 611.82, "02-15-2-01-0046", 719.79, "02-15-3-01-0046", 1019.7, "02-15-4-01-0046", 1359.6],
  [46, "02-15-1-02-0046", 879.83, "02-15-2-02-0046", 1035.09, "02-15-3-02-0046", 1466.38, "02-15-4-02-0046", 1955.18],
  [46, "02-15-1-03-0046", 1063.91, "02-15-2-03-0046", 1251.66, "02-15-3-03-0046", 1773.18, "02-15-4-03-0046", 2364.24],
  [47, "02-15-1-01-0047", 619.94, "02-15-2-01-0047", 729.34, "02-15-3-01-0047", 1033.23, "02-15-4-01-0047", 1377.64],
  [47, "02-15-1-02-0047", 896.07, "02-15-2-02-0047", 1054.2, "02-15-3-02-0047", 1493.45, "02-15-4-02-0047", 1991.27],
  [47, "02-15-1-03-0047", 1082.86, "02-15-2-03-0047", 1273.95, "02-15-3-03-0047", 1804.77, "02-15-4-03-0047", 2406.36],
  [47, "02-30-1-01-0047", 380.58, "02-30-2-01-0047", 447.74, "02-30-3-01-0047", 634.3, "02-30-4-01-0047", 845.73],
  [48, "02-15-1-01-0048", 630.77, "02-15-2-01-0048", 742.08, "02-15-3-01-0048", 1051.28, "02-15-4-01-0048", 1401.71],
  [48, "02-15-1-02-0048", 912.31, "02-15-2-02-0048", 1073.31, "02-15-3-02-0048", 1520.52, "02-15-4-02-0048", 2027.36],
  [48, "02-15-1-03-0048", 1104.52, "02-15-2-03-0048", 1299.44, "02-15-3-03-0048", 1840.87, "02-15-4-03-0048", 2454.49],
  [99, "05-06-1-01-0099", 1258.82, "-", "-", "-", "-", "-", "-"],
  [100, "05-06-1-01-0100", 1267, "-", "-", "-", "-", "-", "-"],
];

function transportFile(extra: unknown[][] = []): string {
  return write([...transportHead(), ...TRANSPORT_ROWS, ...extra, [], [NOTE]], "auto.xlsx");
}

describe("разбор выгрузки перевозки (transport-auto)", () => {
  it("02-15-1-01-0047 = 619,94 ₽/т: код, километр, класс, дороги, тип ТС и грузоподъёмность читаются из кода", () => {
    const parsed = parseTransportAutoRows(streamSheetRows(transportFile(), 13));
    const services = servicesFromRecords(parsed.series, []);

    const found = transportPriceByCode(services, "02-15-1-01-0047");
    expect(found).toMatchObject({ ok: true, price: { kind: "TRANSPORT", code: "02-15-1-01-0047", price: 619.94, km: 47 } });
    const series = services.transport.get("02-15-1-01");
    expect(series).toMatchObject({ vehicle: "02", capacity: 15, capacityUnit: "т", cls: 1, road: "01", vehicleName: "Автомобили-самосвалы" });
    expect(series?.roadName).toContain("усовершенствованное");
  });

  it("шапка: период и зона найдены, ячейки с «-» (нет класса) в цены не попадают", () => {
    const parsed = parseTransportAutoRows(streamSheetRows(transportFile(), 13));

    expect(parsed.period).toBe("3 квартал 2026 года");
    expect(parsed.zone).toBe(ZONE);
    // 02-15: 3 дороги × 4 класса, 3 километра; 02-30: 4 класса × 1 дорога; 05-06: один класс, 2 километра.
    expect(parsed.series.map((series) => series.prefix)).toContain("05-06-1-01");
    expect(parsed.series.some((series) => series.prefix === "05-06-2-01")).toBe(false);
    expect(parsed.prices).toBe(3 * 3 * 4 + 4 + 2);
    expect(parsed.skipped).toBe(0);
  });

  it("все четыре класса и три дороги читаются своими сериями: дороги 02 и 03 дороже 01", () => {
    const services = servicesFromRecords(parseTransportAutoRows(streamSheetRows(transportFile(), 13)).series, []);

    const price = (code: string): number | null => {
      const outcome = transportPriceByCode(services, code);
      return outcome.ok ? outcome.price.price : null;
    };
    expect(price("02-15-2-01-0047")).toBe(729.34);
    expect(price("02-15-4-01-0047")).toBe(1377.64);
    expect(price("02-15-1-02-0047")).toBe(896.07);
    expect(price("02-15-1-03-0047")).toBe(1082.86);
    expect(price("02-30-1-01-0047")).toBe(380.58);
  });

  it("единица грузоподъёмности берётся из шапки: до 6 м3 — кубометры, до 15 т — тонны", () => {
    const services = servicesFromRecords(parseTransportAutoRows(streamSheetRows(transportFile(), 13)).series, []);

    expect(services.transport.get("05-06-1-01")?.capacityUnit).toBe("м3");
    expect(services.transport.get("02-30-1-01")?.capacityUnit).toBe("т");
  });

  it("километров нет в таблице (46 — первая строка вырезки) — цены нет, причина названа; больше максимума — правила нет", () => {
    const services = servicesFromRecords(parseTransportAutoRows(streamSheetRows(transportFile(), 13)).series, []);

    const before = transportPriceByCode(services, "02-15-1-01-0010");
    expect(before.ok).toBe(false);
    expect(before.ok ? "" : before.reason).toContain("нет цены 02-15-1-01-0010");

    const beyond = transportPriceByCode(services, "02-15-1-01-0049");
    expect(beyond.ok).toBe(false);
    expect(beyond.ok ? "" : beyond.reason).toContain("больше таблицы перевозки зоны (48 км)");
    expect(beyond.ok ? "" : beyond.reason).toContain("правила для большего расстояния в таблице нет");

    // У 05-06 таблица кончается на 100 км — то же правило для коротких серий.
    expect(transportPriceByCode(services, "05-06-1-01-0100")).toMatchObject({ ok: true, price: { price: 1267 } });
    expect(transportPriceByCode(services, "05-06-1-01-0101").ok).toBe(false);
  });

  it("серия сериализуется компактно и читается обратно без потерь (JSONL)", () => {
    const parsed = parseTransportAutoRows(streamSheetRows(transportFile(), 13));
    const lines = parsed.series.map(transportSeriesLine);
    const back = lines.map((line) => parseTransportSeriesRecord(JSON.parse(line) as unknown));

    expect(back.every((series) => series !== null)).toBe(true);
    expect(back.map((series) => series?.prefix)).toEqual(parsed.series.map((series) => series.prefix));
    const restored = servicesFromRecords(back.filter((series) => series !== null), []);
    expect(transportPriceByCode(restored, "02-15-1-01-0047")).toMatchObject({ ok: true, price: { price: 619.94 } });
    // Одна строка — серия по километрам, а не 140 тысяч строк по одному коду.
    expect(lines.length).toBe(parsed.series.length);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ c: expect.stringMatching(/^\d\d-\d\d-[1-4]-\d\d$/), p: expect.any(Array) });
  });

  it("повтор, чужой километр в коде и нечитаемая цена пропускаются и считаются", () => {
    const parsed = parseTransportAutoRows(
      streamSheetRows(
        write(
          [
            ...transportHead(),
            [47, "02-15-1-01-0047", 619.94, "02-15-2-01-0047", "н/д", "-", "-", "-", "-"],
            [47, "02-15-1-01-0047", 700, "-", "-", "-", "-", "-", "-"],
            [47, "02-15-1-01-0099", 1, "-", "-", "-", "-", "-", "-"],
          ],
          "bad.xlsx",
        ),
        13,
      ),
    );

    expect(parsed.prices).toBe(1);
    expect(parsed.skipped).toBe(3);
    const price = transportPriceByCode(servicesFromRecords(parsed.series, []), "02-15-1-01-0047");
    expect(price).toMatchObject({ ok: true, price: { price: 619.94 } });
  });

  it("лист из нескольких блоков по типам дорог: соответствие кода дороги её заголовку выводится из блока", () => {
    const block = (title: string, vehicles: string, road: string, price: number): unknown[][] => [
      [title],
      [" (тип дорог)"],
      [],
      [`Тип автотранспортного средства:  ${vehicles}`],
      [CAPACITIES],
      [],
      [47, `02-15-1-${road}-0047`, price, "-", "-", "-", "-", "-", "-"],
    ];
    const parsed = parseTransportAutoRows(
      streamSheetRows(
        write(
          [
            ...block(ROAD_TITLE, "Автомобили-самосвалы", "01", 619.94),
            ...block("переходное (щебеночное, гравийное) дорожное покрытие", "Автомобили-самосвалы", "02", 896.07),
          ],
          "blocks.xlsx",
        ),
        13,
      ),
    );

    const byRoad = new Map(parsed.series.map((series) => [series.road, series] as const));
    expect(byRoad.get("01")?.roadName).toContain("усовершенствованное");
    expect(byRoad.get("02")?.roadName).toBe("переходное (щебеночное, гравийное) дорожное покрытие");
    // Тип ТС назван в блоке одним названием — связь с кодом 02 подтверждена и блоком.
    expect(byRoad.get("02")?.vehicleName).toBe("Автомобили-самосвалы");
  });

  it("лист без цен — пустой результат, а не исключение", () => {
    const parsed = parseTransportAutoRows(streamSheetRows(write([["Сметные цены"], ["Нет данных"]], "empty.xlsx"), 13));
    expect(parsed.series).toEqual([]);
    expect(parsed.prices).toBe(0);
  });
});

/* ------------------------------ Погрузка ------------------------------ */

const LOAD_HEAD: unknown[][] = [
  ["Сметные цены услуг на погрузочно-разгрузочные работы при перевозке грузов для строительства автомобильным транспортом*"],
  [],
  [ZONE],
  ["(наименование субъекта Российской Федерации, номер ценовой зоны и наименование населенного пункта – центра ценовой зоны)"],
  [],
  ["Период действия:  3 квартал 2026 года"],
  [],
  ["Наименование группы грузов", "Погрузка", "", "Разгрузка", ""],
  ["", "код", "сметная цена услуг, рублей/тонну", "код", "сметная цена услуг, рублей/тонну"],
  [1, 2, 3, 4, 5],
];

const LOAD_ROWS: unknown[][] = [
  ["Бетоны и растворы", "01-1", 1515.59, "01-2", 1297.27],
  ["Шлак", "39-1", 106.47, "39-2", 0],
  ["Щебень (выгрузка учитывает затраты на штабелирование)", "40-1", 94.64, "40-2", 234.05],
  ["Гравий (выгрузка учитывает перемещение транспортерами)", "42-1", 94.64, "42-2", 234.05],
  ["Мусор строительный с погрузкой вручную", "47-1", 1391.69, "47-2", 1153.44],
  ["Мусор строительный с погрузкой транспортерами", "48-1", 378.79, "48-2", 0],
  ["Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", "49-1", 94.64, "49-2", 0],
];

const LOAD_NOTE = "1. Сметные цены услуг на погрузочно-разгрузочные работы при перевозке грузов для строительства автомобильным транспортом, определенные с учетом заработной платы";

function loadFile(): string {
  return write([...LOAD_HEAD, ...LOAD_ROWS, [], [LOAD_NOTE, LOAD_NOTE, LOAD_NOTE, LOAD_NOTE, LOAD_NOTE]], "load.xlsx");
}

describe("разбор выгрузки погрузки (load-auto)", () => {
  it("49-1 = 94,64 (мусор строительный, экскаваторы) и 42-1 = 94,64 (гравий); код и группа читаются", () => {
    const parsed = parseLoadAutoRows(streamSheetRows(loadFile(), 6));
    const services = servicesFromRecords([], parsed.prices);

    expect(loadPriceByCode(services, "49-1")).toMatchObject({
      ok: true,
      price: { kind: "LOAD", code: "49-1", price: 94.64, description: expect.stringContaining("Мусор строительный с погрузкой экскаваторами") },
    });
    expect(loadPriceByCode(services, "42-1")).toMatchObject({ ok: true, price: { price: 94.64 } });
    expect(services.load.get("49-1")).toMatchObject({ group: 49, operation: "LOAD" });
    expect(services.load.get("42-2")).toMatchObject({ group: 42, operation: "UNLOAD", price: 234.05 });
  });

  it("шапка: период и зона; примечание под таблицей и строка нумерации в цены не попадают", () => {
    const parsed = parseLoadAutoRows(streamSheetRows(loadFile(), 6));

    expect(parsed.period).toBe("3 квартал 2026 года");
    expect(parsed.zone).toBe(ZONE);
    expect(parsed.prices.map((price) => price.code)).toEqual(["01-1", "01-2", "39-1", "40-1", "40-2", "42-1", "42-2", "47-1", "47-2", "48-1", "49-1"]);
  });

  it("нулевая цена («отдельно не оплачивается») не сохраняется: ноль не отличить от отсутствия цены", () => {
    const parsed = parseLoadAutoRows(streamSheetRows(loadFile(), 6));
    const services = servicesFromRecords([], parsed.prices);

    expect(parsed.skipped).toBe(3);
    const unload = loadPriceByCode(services, "49-2");
    expect(unload.ok).toBe(false);
    expect(unload.ok ? "" : unload.reason).toContain("нет цены 49-2");
  });

  it("группы 1–9 в таблице с нулём («01-1»), в смете — и так, и без нуля: «1-1» находит ту же цену", () => {
    const services = servicesFromRecords([], parseLoadAutoRows(streamSheetRows(loadFile(), 6)).prices);

    expect(loadPriceByCode(services, "1-1")).toMatchObject({ ok: true, price: { code: "01-1", price: 1515.59 } });
    expect(loadPriceByCode(services, "01-1")).toMatchObject({ ok: true, price: { price: 1515.59 } });
  });

  it("запись JSONL читается обратно; запись с нулевой ценой или чужим кодом отклоняется", () => {
    const parsed = parseLoadAutoRows(streamSheetRows(loadFile(), 6));
    const line = loadPriceLine(parsed.prices.find((price) => price.code === "49-1")!);

    expect(JSON.parse(line)).toEqual({ c: "49-1", g: 49, n: "Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", k: "load", p: 94.64 });
    expect(parseLoadPriceRecord(JSON.parse(line) as unknown)).toMatchObject({ code: "49-1", operation: "LOAD", price: 94.64 });
    expect(parseLoadPriceRecord({ c: "49-1", g: 49, n: "x", k: "load", p: 0 })).toBeNull();
    expect(parseLoadPriceRecord({ c: "кот", g: 1, n: "x", k: "load", p: 1 })).toBeNull();
  });
});
