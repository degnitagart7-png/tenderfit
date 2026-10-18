import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildZone } from "../../../scripts/fsnb/build-zone";

/*
  Сборка зоны на урезанных фикстурах: три файла сырья в том же формате, что отдаёт
  ФГИС ЦС (ФСЦСР с двумя листами, реестр ставок, сплит-форма), плюс общий индекс с
  нормами и базисными ценами. Настоящая сплит-форма — 13,7 МБ, в репозиторий её не
  кладём: формат шапки и колонок повторён вручную. Совпадение настоящей зоны Амура
  с корневыми файлами проверено `scripts/fsnb/compare-zone.ts`.
*/

let dir = "";
let raw = "";
let index = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "build-zone-"));
  raw = join(dir, "raw");
  index = join(dir, "index");
  await mkdir(raw, { recursive: true });
  await mkdir(index, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ZONE = "Республика Бурятия (5 зона)";

function writeFscsr(): void {
  const materials: unknown[][] = [
    ["Сметные цены на материалы, изделия, конструкции и оборудование"],
    [`${ZONE}, г. Улан-Удэ`],
    ["(наименование субъекта)"],
    [],
    ["Отчетный период:", "3 квартал 2026"],
    [],
    ["Код материала", "Наименование", "Единица", "Сметная цена"],
    [1, 2, 3, 4],
    ["01.1.01.04-1018", "Листы хризотилцементные", "м2", 232.49],
    ["01.1.01.04-1068", "Листы хризотилцементные волнистые", "м2", 258.85],
  ];
  const machines: unknown[][] = [
    [`${ZONE}, г. Улан-Удэ`],
    ["(наименование субъекта)"],
    [],
    ["Отчетный период: 3 квартал 2026 года"],
    ["ВЫХОДНАЯ ТАБЛИЦА СМЕТНЫХ ЦЕН"],
    [],
    ["Код ресурса", "Наименование", "Ед. изм.", "Сметная цена", "Оплата труда машинистов", "Средний разряд", "Код разряда", "Трудозатраты"],
    ["1", 2, 3, 4, 5, 6, 7, 8],
    ["91.05.05-015", "Краны на автомобильном ходу, 16 т", "маш.-ч", 3000, 1000, 6, "4-100-060", 1],
    ["91.05.05-015", "Краны на автомобильном ходу, 16 т", "маш.-ч", 3000, 1000, 6, "4-100-060", 1],
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(materials), "Материалы и оборудование");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(machines), "Машины и механизмы");
  XLSX.writeFile(book, join(raw, "fscsr.xlsx"));
}

function writeSplit(zoneInHeader = ZONE): void {
  const row = (code: string, current: unknown, indexValue: unknown, base: unknown): unknown[] => [
    code, `Ресурс ${code}`, "т", 100, base, 12, "Группа", current, indexValue,
  ];
  const rows: unknown[][] = [
    ["Сплит-форма индексов и сметных цен для ценовой зоны Республика Бурятия (5 зона) на 3 квартал 2026 года"],
    ["Реквизиты письма Минстроя России об индексах", "", "", "", "", "", "Письмо Минстроя России № 52419-ИФ/09"],
    ["Реквизиты нормативного правового акта об оплате труда", "", "", "", "", "", "ПРИКАЗ № 78-ОД"],
    ["Наименование субъекта Российской Федерации", "", "", "", "", "", "Республика Бурятия"],
    ["Наименование зоны субъекта Российской Федерации", "", "", "", "", "", zoneInHeader],
    [],
    ["1. Примечание, которое не данные"],
    ["Код ресурса, услуги", "Наименование", "Ед.", "Отпускная", "Сметная 2022", "Группа", "Название группы", "Текущая", "Индекс"],
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    // Машина: текущая цена 3000 при базе 2000 → множитель 1,5.
    row("91.05.05-015", 3000, "-", 2000),
    // Нет текущей цены, есть индекс 1,2 к базе 100 → 120, источник «по индексу».
    row("01.1.01.02-0011", "-", 1.2, 100),
    // Нормам не нужен: отфильтруется, но в сводке сплит-формы остаётся.
    row("99.9.99.99-0001", 5, "-", 4),
    // Ни цены, ни индекса — цены нет.
    row("02.2.02.02-0002", "-", "-", 7),
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Лист1");
  XLSX.writeFile(book, join(raw, "split.xlsx"));
}

async function writeRest(zoneName: string | null = ZONE): Promise<void> {
  await writeFile(
    join(raw, "wages.json"),
    JSON.stringify({
      total: 186,
      items: [
        { code: "1-100-10", salaryRateRank: "1.0", salary: "416.29", authorityName: "МИНИСТЕРСТВО РЕСПУБЛИКИ БУРЯТИЯ" },
        { code: "1-100-20", salaryRateRank: "2.0", salary: "598.26", authorityName: "МИНИСТЕРСТВО РЕСПУБЛИКИ БУРЯТИЯ" },
        { code: "4-100-043", salaryRateName: "Средний разряд машинистов 4,3", salaryRateRank: "4.3", salary: "768.40", authorityName: "МИНИСТЕРСТВО РЕСПУБЛИКИ БУРЯТИЯ" },
        { code: "3-200-03", salaryRateName: "Инженер III категории", salaryRateRank: "3.0", salary: "732.67", authorityName: "МИНИСТЕРСТВО РЕСПУБЛИКИ БУРЯТИЯ" },
      ],
    }),
  );
  await writeFile(
    join(raw, "meta.json"),
    JSON.stringify({
      zoneName,
      periodId: 427,
      urls: { fscsr: "https://example.test/fscsr", wages: "https://example.test/wages", split: "https://example.test/split" },
    }),
  );
  await writeFile(
    join(index, "norms.jsonl"),
    `${[
      { code: "01-01-001-01", baseType: "ГЭСН", fullName: "Норма", resources: [{ code: "91.05.05-015" }, { code: "01.1.01.02-0011" }, { code: "02.2.02.02-0002" }] },
    ]
      .map((norm) => JSON.stringify(norm))
      .join("\n")}\n`,
  );
  await writeFile(
    join(index, "prices-base.jsonl"),
    `${JSON.stringify({ code: "91.05.05-015", name: "Кран", unit: "маш.-ч", price: 2000, machinistSalary: 1000, machinistHours: 1, source: "BASE_2022", period: null, zone: null })}\n`,
  );
}

async function build(out = join(dir, "out")) {
  const result = await buildZone({ zone: 236, period: null, raw, out, index, keepAll: false }, () => undefined);
  const lines = async (name: string) =>
    (await readFile(join(out, name), "utf8")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { result, out, lines };
}

describe("buildZone на урезанных фикстурах", () => {
  beforeEach(async () => {
    writeFscsr();
    writeSplit();
    await writeRest();
  });

  it("текущие цены ФСЦСР: дубль машины схлопнут, зона и период из шапки листа", async () => {
    const { lines } = await build();
    const current = await lines("prices-current.jsonl");

    expect(current.map((price) => price.code)).toEqual(["91.05.05-015", "01.1.01.04-1018", "01.1.01.04-1068"]);
    expect(current[0]).toMatchObject({
      price: 3000,
      machinistSalary: 1000,
      machinistHours: 1,
      source: "CURRENT_ZONE",
      period: "3 квартал 2026 г.",
      zone: ZONE,
    });
    expect(current[1]).toMatchObject({ price: 232.49, machinistSalary: null, unit: "м2" });
  });

  it("ставки: реестр рабочих и якорь машинистов (3000 → 1000 за разряд 6)", async () => {
    const { lines } = await build();

    expect(await lines("wages.jsonl")).toEqual([
      { rank: 1, salary: 416.29, source: "Реестр ставок оплаты труда рабочих: МИНИСТЕРСТВО РЕСПУБЛИКИ БУРЯТИЯ" },
      { rank: 2, salary: 598.26, source: "Реестр ставок оплаты труда рабочих: МИНИСТЕРСТВО РЕСПУБЛИКИ БУРЯТИЯ" },
      { rank: 6, salary: 1000, source: `ФСЦСР, оплата труда машинистов: ${ZONE}, 3 квартал 2026 г.` },
      {
        kind: "MACHINIST",
        rank: 4.3,
        salary: 768.4,
        source: "Реестр ставок оплаты труда, средний разряд машинистов: МИНИСТЕРСТВО РЕСПУБЛИКИ БУРЯТИЯ",
      },
      {
        kind: "SPECIALIST",
        code: "3-200-03",
        name: "Инженер III категории",
        salary: 732.67,
        source: "Реестр ставок оплаты труда, должности специалистов: МИНИСТЕРСТВО РЕСПУБЛИКИ БУРЯТИЯ",
      },
    ]);
  });

  it("сплит-форма режется по кодам норм; индекс даёт цену, источник и множитель оплаты труда машинистов", async () => {
    const { lines } = await build();
    const split = await lines("prices-split.jsonl");

    expect(split.map((price) => [price.code, price.price, price.source])).toEqual([
      ["91.05.05-015", 3000, "CURRENT_ZONE"],
      ["01.1.01.02-0011", 120, "BASE_2022_INDEXED"],
    ]);
    // ОТм из базы 2022 (1000) двигается тем же множителем, что и цена (3000 / 2000).
    expect(split[0]).toMatchObject({ machinistSalary: 1500, machinistHours: 1, zone: ZONE, period: "3 квартал 2026 года" });
  });

  it("реквизиты сплит-формы и сводка покрытия считаются по всем строкам, а не по отфильтрованным", async () => {
    const { out } = await build();
    const meta = JSON.parse(await readFile(join(out, "split-form.json"), "utf8")) as Record<string, unknown>;

    expect(meta).toMatchObject({
      subject: "Республика Бурятия",
      zone: ZONE,
      period: "3 квартал 2026 года",
      indexLetter: "Письмо Минстроя России № 52419-ИФ/09",
      wageAct: "ПРИКАЗ № 78-ОД",
      coverage: { total: 4, withCurrentPrice: 2, withIndex: 1, withNothing: 1 },
      written: 2,
      indexed: 1,
      skippedUnusedByNorms: 1,
    });
  });

  it("паспорт зоны: идентификатор, период, счётчики и источники с адресами выгрузок", async () => {
    const { result, out } = await build();
    const zone = JSON.parse(await readFile(join(out, "zone.json"), "utf8")) as Record<string, unknown>;

    expect(zone).toMatchObject({
      priceZoneId: 236,
      zoneName: ZONE,
      subject: "Республика Бурятия",
      periodId: 427,
      period: "3 квартал 2026 г.",
      indexLetter: "Письмо Минстроя России № 52419-ИФ/09",
      wageAct: "ПРИКАЗ № 78-ОД",
      counts: {
        currentPrices: 3,
        splitPrices: 2,
        splitIndexed: 1,
        wages: 5,
        workerRanks: 3,
        machinistRanks: 1,
        specialists: 1,
        splitRows: 4,
      },
    });
    // Машин в ФСЦСР мало для оценки роста зарплаты — это записано, а не молчит.
    expect((zone as { notes: string[] }).notes.join(" ")).toContain("Рост оплаты труда машинистов по ФСЦСР определить не удалось");
    expect((zone.sources as { url: string }[]).map((source) => source.url)).toEqual([
      "https://example.test/fscsr",
      "https://example.test/wages",
      "https://example.test/split",
    ]);
    expect(result.peakRssBytes).toBeGreaterThan(0);
  });

  it("зоны источников не сошлись — это попадает в паспорт, а не молчит", async () => {
    writeSplit("Республика Бурятия (1 зона)");
    const { out } = await build();
    const zone = JSON.parse(await readFile(join(out, "zone.json"), "utf8")) as { notes: string[] };

    expect(zone.notes.some((note) => note.includes("сплит-форма") && note.includes("не совпала"))).toBe(true);
    expect(zone.notes.some((note) => note.includes("ФСЦСР относится к зоне"))).toBe(true);
  });

  it("prices-split-all.jsonl: все строки с ценой без фильтра по нормам, компактно {c, p, u, i}", async () => {
    const { lines, out } = await build();

    // В основной файл код вне норм не попал, а в «все цены» — попал: аудиту нужны позиции-поставки.
    expect((await lines("prices-split.jsonl")).map((price) => price.code)).not.toContain("99.9.99.99-0001");
    expect(await lines("prices-split-all.jsonl")).toEqual([
      { c: "91.05.05-015", p: 3000, u: "т", i: false },
      { c: "01.1.01.02-0011", p: 120, u: "т", i: true },
      { c: "99.9.99.99-0001", p: 5, u: "т", i: false },
    ]);
    // Строки без цены и без индекса (02.2.02.02-0002) не пишутся; временного файла после сборки нет.
    expect(await readdir(out)).not.toContain("prices-split-all.jsonl.tmp");
  });

  it("паспорт зоны называет число и размер файла «все цены»", async () => {
    const { out } = await build();
    const zone = JSON.parse(await readFile(join(out, "zone.json"), "utf8")) as { counts: Record<string, number> };
    const size = Buffer.byteLength(await readFile(join(out, "prices-split-all.jsonl"), "utf8"));

    expect(zone.counts.splitAllPrices).toBe(3);
    expect(zone.counts.splitAllBytes).toBe(size);
  });

  it("--all: сплит-форма остаётся целиком, включая коды, которых нет в нормах", async () => {
    const out = join(dir, "all");
    await buildZone({ zone: 236, period: null, raw, out, index, keepAll: true }, () => undefined);
    const split = (await readFile(join(out, "prices-split.jsonl"), "utf8")).split("\n").filter((line) => line !== "");

    expect(split).toHaveLength(3);
  });
});

describe("buildZone: отказы", () => {
  it("нет сырья или общего индекса — внятная ошибка", async () => {
    await expect(buildZone({ zone: 236, period: null, raw, out: join(dir, "o"), index, keepAll: false }, () => undefined)).rejects.toThrow(/Не найден/);

    writeFscsr();
    writeSplit();
    await writeRest();
    await rm(join(index, "norms.jsonl"));
    await expect(buildZone({ zone: 236, period: null, raw, out: join(dir, "o"), index, keepAll: false }, () => undefined)).rejects.toThrow(/общий индекс/);
  });

  it("сплит-форма без единой нужной цены — ошибка, а не пустая зона", async () => {
    writeFscsr();
    writeSplit();
    await writeRest();
    await writeFile(join(index, "norms.jsonl"), `${JSON.stringify({ code: "1", baseType: "ГЭСН", fullName: "Н", resources: [{ code: "00.0.00.00-0000" }] })}\n`);

    await expect(buildZone({ zone: 236, period: null, raw, out: join(dir, "o"), index, keepAll: false }, () => undefined)).rejects.toThrow(/не получилось ни одной цены/);
  });

  it("с raw-каталогом не нужен data/fsnb/raw: период берётся из meta.json", async () => {
    writeFscsr();
    writeSplit();
    await writeRest();
    const { result } = await build();
    expect((result.zoneDocument as { periodId: number }).periodId).toBe(427);
  });
});

describe("buildZone: оплата труда машинистов у машин сплит-формы", () => {
  /** 25 машин с измеренной ФСЦСР оплатой труда: ровно ×2 к базе 2022 года. */
  async function manyMachines(): Promise<void> {
    const machines: unknown[][] = [
      [`${ZONE}, г. Улан-Удэ`],
      ["(наименование субъекта)"],
      [],
      ["Отчетный период: 3 квартал 2026 года"],
      ["ВЫХОДНАЯ ТАБЛИЦА СМЕТНЫХ ЦЕН"],
      [],
      ["Код ресурса", "Наименование", "Ед. изм.", "Сметная цена", "Оплата труда машинистов", "Средний разряд", "Код разряда", "Трудозатраты"],
      ["1", 2, 3, 4, 5, 6, 7, 8],
    ];
    const base: unknown[] = [];
    for (let i = 0; i < 25; i += 1) {
      const code = `91.01.01-${String(i).padStart(3, "0")}`;
      machines.push([code, `Машина ${code}`, "маш.-ч", 3000, 2 * (100 + i), 6, "4-100-060", 1]);
      base.push({ code, name: code, unit: "маш.-ч", price: 1000, machinistSalary: 100 + i, machinistHours: 1, source: "BASE_2022", period: null, zone: null });
    }
    // Машина, которой нет в ФСЦСР: цена выросла в 1,5 раза, зарплата — в 2.
    base.push({ code: "91.99.99-001", name: "Машина вне ФСЦСР", unit: "маш.-ч", price: 2000, machinistSalary: 400, machinistHours: 1, source: "BASE_2022", period: null, zone: null });
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["x"], [ZONE + ", г. Улан-Удэ"], [], [], ["Отчетный период:", "3 квартал 2026"], [], ["Код материала"], [1, 2, 3, 4], ["01.1.01.04-1018", "Листы", "м2", 232.49]]), "Материалы и оборудование");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(machines), "Машины и механизмы");
    XLSX.writeFile(book, join(raw, "fscsr.xlsx"));
    await writeFile(join(index, "prices-base.jsonl"), `${base.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await writeFile(
      join(index, "norms.jsonl"),
      `${JSON.stringify({ code: "1", baseType: "ГЭСН", fullName: "Н", resources: [{ code: "91.99.99-001" }, { code: "01.1.01.02-0011" }] })}\n`,
    );

    const row = (code: string, current: unknown, base2022: unknown): unknown[] => [code, code, "маш.-ч", 100, base2022, 12, "Группа", current, "-"];
    const split: unknown[][] = [
      ["Сплит-форма для ценовой зоны Республика Бурятия (5 зона) на 3 квартал 2026 года"],
      ["Реквизиты письма", "", "", "", "", "", "Письмо"],
      ["Реквизиты акта", "", "", "", "", "", "Приказ"],
      ["Наименование субъекта", "", "", "", "", "", "Республика Бурятия"],
      ["Наименование зоны", "", "", "", "", "", ZONE],
      [],
      ["Код ресурса, услуги", "Наименование", "Ед.", "Отпускная", "Сметная 2022", "Группа", "Название группы", "Текущая", "Индекс"],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      row("91.99.99-001", 3000, 2000),
    ];
    const splitBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(splitBook, XLSX.utils.aoa_to_sheet(split), "Лист1");
    XLSX.writeFile(splitBook, join(raw, "split.xlsx"));
  }

  it("зарплата растёт в k раз (×2 по ФСЦСР), а не как цена машины (×1,5)", async () => {
    await writeRest();
    await manyMachines();
    const { lines, out } = await build();
    const split = await lines("prices-split.jsonl");
    const zone = JSON.parse(await readFile(join(out, "zone.json"), "utf8")) as { counts: Record<string, number>; notes: string[] };

    // 400 (база 2022) × 2 = 800; прежний вывод дал бы 400 × 3000 / 2000 = 600.
    expect(split.find((price) => price.code === "91.99.99-001")?.machinistSalary).toBe(800);
    expect(zone.counts.machinistWageFactor).toBe(2);
    expect(zone.notes.join(" ")).not.toContain("определить не удалось");
  });
});

describe("buildZone: цены перевозки и погрузки (transport-auto, load-auto)", () => {
  function writeTransport(zoneLabel = `${ZONE}, г. Улан-Удэ`, period = "3 квартал 2026 года"): void {
    const rows: unknown[][] = [
      ["Сметные цены услуг на перевозку грузов для строительства автомобильным транспортом*"],
      [],
      [zoneLabel],
      ["(наименование субъекта Российской Федерации, номер ценовой зоны и наименование населенного пункта – центра ценовой зоны)"],
      [],
      ["усовершенствованное (асфальтобетонное) дорожное покрытие"],
      [" (тип дорог)"],
      [],
      ["Тип автотранспортного средства:  Автомобили-самосвалы, Автоцистерны"],
      ["Грузоподъемность автотранспортного средства:  до 15 т, до 16 м3"],
      [`Период действия:  ${period}`],
      [],
      ["Расстояние перевозки грузов, километров", "Сметные цены услуг"],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      [46, "02-15-1-01-0046", 611.82, "02-15-2-01-0046", 719.79, "-", "-", "-", "-"],
      [47, "02-15-1-01-0047", 619.94, "02-15-2-01-0047", 729.34, "-", "-", "-", "-"],
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Выходная форма");
    XLSX.writeFile(book, join(raw, "transport-auto.xlsx"));
  }

  function writeLoad(zoneLabel = `${ZONE}, г. Улан-Удэ`): void {
    const rows: unknown[][] = [
      ["Сметные цены услуг на погрузочно-разгрузочные работы при перевозке грузов для строительства автомобильным транспортом*"],
      [],
      [zoneLabel],
      [],
      ["Период действия:  3 квартал 2026 года"],
      ["Наименование группы грузов", "Погрузка", "", "Разгрузка", ""],
      [1, 2, 3, 4, 5],
      ["Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", "49-1", 94.64, "49-2", 0],
      ["Гравий (выгрузка учитывает перемещение транспортерами)", "42-1", 94.64, "42-2", 234.05],
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Выходная форма");
    XLSX.writeFile(book, join(raw, "load-auto.xlsx"));
  }

  async function withServiceUrls(): Promise<void> {
    await writeFile(
      join(raw, "meta.json"),
      JSON.stringify({
        zoneName: ZONE,
        periodId: 427,
        urls: {
          fscsr: "https://example.test/fscsr",
          wages: "https://example.test/wages",
          split: "https://example.test/split",
          transport: "https://example.test/transport",
          load: "https://example.test/load",
        },
      }),
    );
  }

  const jsonl = async (path: string) =>
    (await readFile(path, "utf8")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeEach(async () => {
    writeFscsr();
    writeSplit();
    await writeRest();
  });

  it("обе таблицы пишутся потоково: серии цен по километрам и цены погрузки без нулевой разгрузки", async () => {
    await withServiceUrls();
    writeTransport();
    writeLoad();
    const { out } = await build();

    const transport = await jsonl(join(out, "transport-auto.jsonl"));
    expect(transport.map((series) => series.c)).toEqual(["02-15-1-01", "02-15-2-01"]);
    expect(transport[0]).toMatchObject({ vt: "02", cap: 15, cu: "т", cls: 1, road: "01", vn: "Автомобили-самосвалы" });
    const prices = (transport[0] as { p: (number | null)[] }).p;
    expect(prices).toHaveLength(47);
    expect(prices[46]).toBe(619.94);
    expect(prices[0]).toBeNull();

    expect(await jsonl(join(out, "load-auto.jsonl"))).toEqual([
      { c: "49-1", g: 49, n: "Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", k: "load", p: 94.64 },
      { c: "42-1", g: 42, n: "Гравий (выгрузка учитывает перемещение транспортерами)", k: "load", p: 94.64 },
      { c: "42-2", g: 42, n: "Гравий (выгрузка учитывает перемещение транспортерами)", k: "unload", p: 234.05 },
    ]);
    // Временных файлов после сборки нет.
    expect((await readdir(out)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("паспорт: размеры и числа в counts, источники с адресами, версия формата 2; перевозка записана — флага повтора нет", async () => {
    await withServiceUrls();
    writeTransport();
    writeLoad();
    const { out } = await build();
    const zone = JSON.parse(await readFile(join(out, "zone.json"), "utf8")) as Record<string, unknown> & { counts: Record<string, number>; sources: { title: string; url: string }[] };

    expect(zone.buildVersion).toBe(2);
    expect(zone).not.toHaveProperty("transportAuto");
    expect(zone.counts).toMatchObject({ transportAutoSeries: 2, transportAutoPrices: 4, loadAutoPrices: 3 });
    expect(zone.counts.transportAutoBytes).toBeGreaterThan(0);
    expect(zone.counts.loadAutoBytes).toBeGreaterThan(0);
    expect(zone.sources.map((source) => source.url)).toEqual([
      "https://example.test/fscsr",
      "https://example.test/wages",
      "https://example.test/split",
      "https://example.test/transport",
      "https://example.test/load",
    ]);
    expect(zone.sources[3]?.title).toContain("перевозку грузов");
  });

  it("старая сборка (нет сырья перевозки и погрузки): файлов нет, паспорт как раньше, флага повтора нет", async () => {
    const { out } = await build();
    const zone = JSON.parse(await readFile(join(out, "zone.json"), "utf8")) as Record<string, unknown> & { counts: Record<string, number> };

    expect(await readdir(out)).not.toContain("transport-auto.jsonl");
    expect(await readdir(out)).not.toContain("load-auto.jsonl");
    expect(zone).not.toHaveProperty("transportAuto");
    expect(zone.counts).not.toHaveProperty("transportAutoSeries");
  });

  it("перевозка должна была быть (адрес в meta.json), но не скачалась: файла нет, паспорт просит повторить", async () => {
    await withServiceUrls();
    const { out } = await build();
    const zone = JSON.parse(await readFile(join(out, "zone.json"), "utf8")) as Record<string, unknown>;

    expect(await readdir(out)).not.toContain("transport-auto.jsonl");
    expect(zone.transportAuto).toBe(false);
  });

  it("таблица чужой зоны не записывается: цены чужой зоны в расчёт попасть не должны", async () => {
    await withServiceUrls();
    writeTransport("Амурская область (1 зона), г. Благовещенск");
    writeLoad();
    const { out } = await build();
    const zone = JSON.parse(await readFile(join(out, "zone.json"), "utf8")) as { notes: string[]; transportAuto?: boolean };

    expect(await readdir(out)).not.toContain("transport-auto.jsonl");
    expect(await readdir(out)).toContain("load-auto.jsonl");
    expect(zone.notes.join(" ")).toContain("Цены перевозки: таблица относится к зоне «Амурская область (1 зона), г. Благовещенск»");
    // Повтор скачивания тут не поможет — флага повтора нет.
    expect(zone.transportAuto).toBeUndefined();
  });

  it("название зоны сравнивается без различий в регистре и пробелах", async () => {
    await withServiceUrls();
    writeTransport("республика  бурятия (5 ЗОНА), г. Улан-Удэ");
    const { out } = await build();

    expect(await readdir(out)).toContain("transport-auto.jsonl");
  });

  it("таблица другого квартала не записывается", async () => {
    await withServiceUrls();
    writeTransport(undefined, "2 квартал 2026 года");
    const { out } = await build();
    const zone = JSON.parse(await readFile(join(out, "zone.json"), "utf8")) as { notes: string[] };

    expect(await readdir(out)).not.toContain("transport-auto.jsonl");
    expect(zone.notes.join(" ")).toContain("таблица за «2 квартал 2026 года»");
  });

  it("файлы прежней сборки в том же каталоге не остаются под новым паспортом", async () => {
    await withServiceUrls();
    writeTransport();
    writeLoad();
    const first = await build();
    expect(await readdir(first.out)).toContain("transport-auto.jsonl");

    await rm(join(raw, "transport-auto.xlsx"));
    await rm(join(raw, "load-auto.xlsx"));
    await build(first.out);

    expect(await readdir(first.out)).not.toContain("transport-auto.jsonl");
    expect(await readdir(first.out)).not.toContain("load-auto.jsonl");
  });
});
