import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { findNorms } from "@/domain/estimate/matchNorms";
import { resolveWage } from "@/domain/estimate/wageScale";
import {
  BUILD_COMMAND,
  DEFAULT_INDEX_DIR,
  EstimateBaseUnavailableError,
  buildEstimateSources,
  clearEstimateBaseCache,
  currentPriceCoverageNote,
  describeEstimateBase,
  listBuiltZones,
  loadEstimateBase,
  AUDIT_PRICES_CACHE_ZONES,
  AUTO_SERVICES_CACHE_ZONES,
  loadZoneAuditPrices,
  loadZoneAutoServices,
  loadZonePriceBook,
  readPriceZoneRecords,
  resolveIndexDir,
} from "@/repositories/estimateBaseRepository";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BASE_PRICES,
  CURRENT_PRICES,
  NORM_DRAGLINE_15,
} from "@/test/estimateFixtures";

/*
  Репозиторий читает базу, собранную скриптом из открытых данных ФГИС ЦС. Здесь
  проверяются две вещи, которые легко потерять молча.

  Первая — точность обратного хода. Индекс собирается в JSONL и читается назад:
  если при чтении потеряется знак, округлится ставка или подменится источник
  цены, смета посчитается и не покажет ошибки. Поэтому фикстуры домена
  записываются в файл и сравниваются с прочитанным побайтово.

  Вторая — отказ обязан быть внятным. Базы на сервере нет: 204 МБ индекса
  исключены и из `.gitignore`, и из `.vercelignore`. Значит «не нашёл файл»
  должно звучать как инструкция, а не как ENOENT, а пустая тарифная шкала — как
  ошибка, а не как нулевая оплата труда.
*/

const DECREE = "Приказ Минстроя России № 527/пр от 12.08.2026";
const BASE_EDITION = "01.01.2022";

/** Название зоны, разорванное переносом строки в исходном CSV. */
const ARKHANGELSK_ISLANDS =
  "Архангельская область районы островов Северного Ледовитого океана и его морей";

const AMUR_ZONE_RECORD = {
  subjectCode: "28",
  subjectName: "Амурская область",
  zoneName: AMUR_ZONE.zone,
  center: "г. Благовещенск",
  municipalities: "р-н. Благовещенский, р-н. Тамбовский",
};

const ARKHANGELSK_ZONE_RECORD = {
  subjectCode: "29",
  subjectName: "Архангельская область",
  zoneName: ARKHANGELSK_ISLANDS,
  center: "г. Архангельск",
  municipalities: "",
};

const ZONES = [AMUR_ZONE_RECORD, ARKHANGELSK_ZONE_RECORD];

/** Первая строка реестра ставок рабочих: разряд 1,0 → 548,86 ₽ за чел.-ч. */
const FIRST_ANCHOR = {
  rank: 1,
  salary: 548.86,
  source: "Реестр ставок оплаты труда рабочих",
};

let dir = "";

beforeEach(async () => {
  clearEstimateBaseCache();
  dir = await mkdtemp(join(tmpdir(), "estimate-base-"));
  await writeIndex();
});

afterEach(async () => {
  clearEstimateBaseCache();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** Счётчики паспорта: столько строк тестовый индекс и содержит. */
function defaultOutputs(): Record<string, { lines: number }> {
  return {
    "norms.jsonl": { lines: 1 },
    "prices-base.jsonl": { lines: BASE_PRICES.length },
    "prices-current.jsonl": { lines: CURRENT_PRICES.length },
    "wages.jsonl": { lines: AMUR_WAGE_ANCHORS.length },
    "zones.jsonl": { lines: ZONES.length },
  };
}

function buildInfoDocument(outputs: Record<string, unknown>): string {
  return JSON.stringify({
    builtAt: "2026-09-26T14:41:30.480Z",
    baseEdition: BASE_EDITION,
    region: AMUR_ZONE.region,
    zone: AMUR_ZONE.zone,
    period: AMUR_ZONE.period,
    decree: DECREE,
    outputs,
    notes: [
      "Книг 5: ГЭСН 30028, ГЭСНм 19208, ГЭСНр 3976, ГЭСНп 2605, ГЭСНмр 425.",
    ],
  });
}

/** Пишет индекс из доменных фикстур: то же самое, что делает скрипт сборки. */
async function writeIndex(
  patch: Partial<Record<string, string>> = {},
): Promise<void> {
  const files: Record<string, string> = {
    "build-info.json": buildInfoDocument(defaultOutputs()),
    "norms.jsonl": jsonl([NORM_DRAGLINE_15]),
    "prices-base.jsonl": jsonl(BASE_PRICES),
    "prices-current.jsonl": jsonl(CURRENT_PRICES),
    "wages.jsonl": jsonl(AMUR_WAGE_ANCHORS),
    "zones.jsonl": jsonl(ZONES),
    ...patch,
  };

  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(join(dir, name), content, "utf8"),
    ),
  );
}

/** Подменяет счётчики паспорта: undefined убирает запись о файле вовсе. */
async function patchBuildInfo(
  replace: Record<string, { lines: number } | undefined>,
): Promise<void> {
  const outputs = defaultOutputs();
  for (const [file, value] of Object.entries(replace)) {
    if (value === undefined) delete outputs[file];
    else outputs[file] = value;
  }
  await writeFile(
    join(dir, "build-info.json"),
    buildInfoDocument(outputs),
    "utf8",
  );
}

function jsonl(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/** Ожидание отказа с нужной причиной и нужными словами в сообщении. */
async function expectUnavailable(
  action: Promise<unknown>,
  reason: EstimateBaseUnavailableError["reason"],
  ...mentioned: string[]
): Promise<void> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(EstimateBaseUnavailableError);
  const failure = error as EstimateBaseUnavailableError;
  expect(failure.reason).toBe(reason);
  expect(failure.indexDir).toBe(resolve(dir));
  for (const text of mentioned) expect(failure.message).toContain(text);
}

describe("loadEstimateBase: обратный ход индекса", () => {
  it("возвращает цены базы ровно теми, что записаны в индекс", async () => {
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.priceBook.base.size).toBe(BASE_PRICES.length);
    for (const price of BASE_PRICES) {
      expect(base.priceBook.base.get(price.code)).toEqual(price);
    }
  });

  it("возвращает текущие цены ФСЦСР с периодом и зоной", async () => {
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.priceBook.current.size).toBe(CURRENT_PRICES.length);
    for (const price of CURRENT_PRICES) {
      expect(base.priceBook.current.get(price.code)).toEqual(price);
    }
  });

  it("нулевая цена машины сохраняется нулём, а не пропадает из базы", async () => {
    // Землесос 91.20.12-101 в «ФСБЦ_Маш.xml» действительно стоит 0 ₽. Потерять
    // его значит превратить пробел ZERO_PRICE в NO_PRICE: расчёт сказал бы
    // «такой машины в каталоге нет», хотя она там есть и цена у неё нулевая.
    const base = await loadEstimateBase({ indexDir: dir });
    const dredger = base.priceBook.base.get("91.20.12-101");
    expect(dredger?.price).toBe(0);
    expect(dredger?.source).toBe("BASE_2022");
  });

  it("тарифная шкала собирается из прочитанных опорных точек", async () => {
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.priceBook.wageScale.region).toBe(AMUR_ZONE.region);
    expect(base.priceBook.wageScale.zone).toBe(AMUR_ZONE.zone);
    expect(base.priceBook.wageScale.period).toBe(AMUR_ZONE.period);
    expect(base.priceBook.wageScale.baseSalary).toBe(548.86);
    expect(base.priceBook.wageScale.minRank).toBe(1);
    expect(base.priceBook.wageScale.maxRank).toBe(9);
  });

  it("ставка разряда 2,5 совпадает с реестром до копейки", async () => {
    // 625,70 ₽ — значение из ответа RimWorkerSalaryRegistry, а не результат
    // интерполяции: разряд 2,5 есть среди опорных точек. Если чтение округлит
    // ставку, расхождение появится именно здесь.
    const base = await loadEstimateBase({ indexDir: dir });
    const wage = resolveWage(base.priceBook.wageScale, "1-100-25");
    expect(wage?.salary).toBe(625.7);
    expect(wage?.origin).toBe("ANCHOR");
  });

  it("35 строк шкалы дают 33 точки: разряды 2,0 и 3,0 пришли из двух источников", async () => {
    // Реестр ставок рабочих покрывает разряды 1,0–3,4, колонка оплаты труда
    // машинистов в ФСЦСР — 2–9. Пересечение совпадает до копейки, и шкала
    // обязана схлопнуть его, а не выдать две ставки на разряд.
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.info.counts.wages).toBe(AMUR_WAGE_ANCHORS.length);
    expect(AMUR_WAGE_ANCHORS.length).toBe(35);
    expect(base.priceBook.wageScale.anchors).toHaveLength(33);
    expect(
      base.priceBook.wageScale.anchors.filter((anchor) => anchor.rank === 2),
    ).toHaveLength(1);
    expect(
      base.priceBook.wageScale.anchors.find((anchor) => anchor.rank === 2)
        ?.salary,
    ).toBe(598.26);
    expect(
      base.priceBook.wageScale.anchors.find((anchor) => anchor.rank === 3)
        ?.salary,
    ).toBe(653.14);
  });

  it("счётчики паспорта и прочитанного совпадают", async () => {
    // Два пути к одному числу: `describeEstimateBase` берёт его из паспорта,
    // `loadEstimateBase` — подсчётом строк. Разошлись бы — экран состояния базы
    // показывал бы не то, что реально загружается в расчёт.
    const described = await describeEstimateBase({ indexDir: dir });
    const base = await loadEstimateBase({ indexDir: dir });
    if (described.state !== "READY") throw new Error("ожидалось READY");
    expect(described.info.counts).toEqual(base.info.counts);
  });

  it("нормы доходят до поискового индекса и находятся по коду с книгой", async () => {
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.searchIndex.size).toBe(1);

    const found = findNorms(base.searchIndex, {
      workName: NORM_DRAGLINE_15.fullName,
      normCode: NORM_DRAGLINE_15.code,
      normBaseType: NORM_DRAGLINE_15.baseType,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.norm).toEqual(NORM_DRAGLINE_15);
  });

  it("индекс ищет и по наименованию работы из ведомости объёмов", async () => {
    // Подбор по коду работает и без инвертированного индекса. Здесь проверяется
    // именно он: формулировка из ВОР не совпадает с наименованием нормы дословно.
    const base = await loadEstimateBase({ indexDir: dir });
    const found = findNorms(base.searchIndex, {
      workName: "Разработка грунта экскаватором драглайн в отвал",
    });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.norm.code).toBe(NORM_DRAGLINE_15.code);
    expect(found[0]?.reasons.join(" ")).toContain("Земляные работы");
  });

  it("паспорт сборки повторяет издание, зону, период и приказ", async () => {
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.info).toMatchObject({
      indexDir: resolve(dir),
      builtAt: "2026-09-26T14:41:30.480Z",
      baseEdition: BASE_EDITION,
      region: AMUR_ZONE.region,
      priceZone: AMUR_ZONE.zone,
      period: AMUR_ZONE.period,
      decree: DECREE,
    });
    expect(base.info.counts).toEqual({
      norms: 1,
      basePrices: BASE_PRICES.length,
      currentPrices: CURRENT_PRICES.length,
      wages: AMUR_WAGE_ANCHORS.length,
      zones: ZONES.length,
    });
    expect(base.info.notes).toHaveLength(1);
  });

  it("ценовые зоны читаются вместе с названием, разорванным переносом строки", async () => {
    // В `price-zones.csv` название этой зоны заключено в кавычки и разбито
    // переводом строки. Наивный построчный разбор терял хвост, и зона
    // Архангельской области оказывалась обрезанной на слове «районы».
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.zones).toHaveLength(2);
    expect(base.zones[1]?.zoneName).toBe(ARKHANGELSK_ISLANDS);
  });
});

describe("loadEstimateBase: происхождение чисел", () => {
  it("даёт четыре источника с настоящими адресами ФГИС ЦС", async () => {
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.sources.map((source) => source.url)).toEqual([
      "https://fgiscs.minstroyrf.ru/opendata",
      "https://fgiscs.minstroyrf.ru/prices",
      "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/RimWorkerSalaryRegistry",
      "https://fgiscs.minstroyrf.ru/api/OpenData/7707082071-fsnb",
    ]);
  });

  it("в издании источника названы приказ и уровень цен, а не просто «ФСНБ»", async () => {
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.sources[0]?.edition).toBe(
      `${DECREE}, уровень цен ${BASE_EDITION}`,
    );
    expect(base.sources[1]?.edition).toBe(AMUR_ZONE.period);
  });

  it("без приказа в паспорте издание не остаётся пустым", () => {
    const sources = buildEstimateSources({
      indexDir: dir,
      builtAt: "",
      splitForm: null,
      baseEdition: BASE_EDITION,
      region: AMUR_ZONE.region,
      priceZone: AMUR_ZONE.zone,
      period: AMUR_ZONE.period,
      decree: "",
      counts: { norms: 1, basePrices: 1, currentPrices: 1, wages: 1, zones: 1 },
      notes: [],
    });
    expect(sources[0]?.edition).toBe(`ФСНБ-2022, уровень цен ${BASE_EDITION}`);
  });

  it("покрытие текущими ценами объяснено одной фразой с зоной и периодом", async () => {
    const base = await loadEstimateBase({ indexDir: dir });
    const note = currentPriceCoverageNote(base.info);
    expect(note).toContain(AMUR_ZONE.zone);
    expect(note).toContain(AMUR_ZONE.period);
    expect(note).toContain(String(CURRENT_PRICES.length));
    expect(note).toContain(BASE_EDITION);
  });
});

describe("loadEstimateBase: кэш", () => {
  it("вторая загрузка того же каталога не читает индекс заново", async () => {
    const first = await loadEstimateBase({ indexDir: dir });
    const second = await loadEstimateBase({ indexDir: dir });
    expect(second).toBe(first);
  });

  it("одновременные вызовы делят одну загрузку", async () => {
    const [a, b] = await Promise.all([
      loadEstimateBase({ indexDir: dir }),
      loadEstimateBase({ indexDir: dir }),
    ]);
    expect(a).toBe(b);
  });

  it("после сброса кэша база читается заново", async () => {
    const first = await loadEstimateBase({ indexDir: dir });
    clearEstimateBaseCache();
    const second = await loadEstimateBase({ indexDir: dir });
    expect(second).not.toBe(first);
    expect(second.info.counts).toEqual(first.info.counts);
  });

  it("неудачная загрузка не кэшируется: собрал индекс — и она прошла", async () => {
    await writeFile(join(dir, "norms.jsonl"), "", "utf8");
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "EMPTY_FILE",
      "norms.jsonl",
    );

    await writeFile(
      join(dir, "norms.jsonl"),
      jsonl([NORM_DRAGLINE_15]),
      "utf8",
    );
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.searchIndex.size).toBe(1);
  });
});

describe("loadEstimateBase: отказ", () => {
  it("без паспорта сборки говорит, какой командой её собрать", async () => {
    await rm(join(dir, "build-info.json"));
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "MISSING_FILE",
      BUILD_COMMAND,
    );
  });

  it("паспорт без ценовой зоны не принимается: неизвестно, к каким ценам относится расчёт", async () => {
    await writeFile(
      join(dir, "build-info.json"),
      JSON.stringify({ zone: "", period: AMUR_ZONE.period, outputs: {} }),
      "utf8",
    );
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_BUILD_INFO",
      "ценовая зона",
    );
  });

  it("отсутствующий файл норм назван по имени", async () => {
    await rm(join(dir, "norms.jsonl"));
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "MISSING_FILE",
      "norms.jsonl",
    );
  });

  it("пустой файл цен — ошибка, а не база без цен", async () => {
    await writeFile(join(dir, "prices-base.jsonl"), "", "utf8");
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "EMPTY_FILE",
      "prices-base.jsonl",
    );
  });

  it("повтор кода в ценах отклоняется: две цены на код означали бы произвольный выбор", async () => {
    const first = BASE_PRICES[0];
    if (first === undefined) throw new Error("фикстура BASE_PRICES пуста");
    await writeFile(
      join(dir, "prices-base.jsonl"),
      jsonl([...BASE_PRICES, first]),
      "utf8",
    );
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_RECORD",
      first.code,
      "второй раз",
    );
  });

  it("строка не-JSON отклоняется с номером строки", async () => {
    await writeFile(
      join(dir, "wages.jsonl"),
      `${jsonl([FIRST_ANCHOR])}{"rank": 2,\n`,
      "utf8",
    );
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_RECORD",
      "wages.jsonl",
      "строка 2",
    );
  });

  it("отрицательная цена отклоняется", async () => {
    const first = BASE_PRICES[0];
    if (first === undefined) throw new Error("фикстура BASE_PRICES пуста");
    await writeFile(
      join(dir, "prices-base.jsonl"),
      jsonl([{ ...first, price: -1 }]),
      "utf8",
    );
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_RECORD",
      "не неотрицательное",
    );
  });

  it("неизвестный источник цены отклоняется", async () => {
    const first = BASE_PRICES[0];
    if (first === undefined) throw new Error("фикстура BASE_PRICES пуста");
    await writeFile(
      join(dir, "prices-base.jsonl"),
      jsonl([{ ...first, source: "ТЕРРИТОРИАЛЬНАЯ" }]),
      "utf8",
    );
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_RECORD",
      "ТЕРРИТОРИАЛЬНАЯ",
    );
  });

  it("норма без книги отклоняется: код однозначен только вместе с книгой", async () => {
    await writeFile(
      join(dir, "norms.jsonl"),
      jsonl([{ ...NORM_DRAGLINE_15, baseType: "" }]),
      "utf8",
    );
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_RECORD",
      "нет книги",
    );
  });

  it("ставка без разряда отклоняется", async () => {
    await writeFile(
      join(dir, "wages.jsonl"),
      jsonl([{ salary: 548.86, source: "x" }]),
      "utf8",
    );
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_RECORD",
      "разряд",
    );
  });

  it("нулевая ставка отклоняется: нулевая оплата труда не может выглядеть расчётом", async () => {
    await writeFile(
      join(dir, "wages.jsonl"),
      jsonl([{ rank: 1, salary: 0, source: "x" }]),
      "utf8",
    );
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_RECORD",
      "не положительное",
    );
  });

  it("зона без названия отклоняется", async () => {
    await writeFile(
      join(dir, "zones.jsonl"),
      jsonl([{ ...AMUR_ZONE_RECORD, zoneName: "" }]),
      "utf8",
    );
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_RECORD",
      "нет названия",
    );
  });

  it("нормы одного издания с ценами другого не принимаются за базу", async () => {
    // Сборщик умеет пересобирать часть файлов (`--only norms`). Тогда в каталоге
    // лежат свежие нормы и прошлогодние цены, смета считается и не показывает
    // ошибки — поэтому расхождение с паспортом считается отказом.
    await patchBuildInfo({ "norms.jsonl": { lines: 30_028 } });
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir }),
      "BAD_BUILD_INFO",
      "norms.jsonl",
      "в паспорте 30028",
      "прочитано 1",
      BUILD_COMMAND,
    );
  });

  it("паспорт без счётчика файла не мешает загрузке", async () => {
    // `linesOf` возвращает 0, когда записи о файле нет, и сверка такие поля
    // пропускает: иначе паспорт старого формата заблокировал бы базу целиком.
    await patchBuildInfo({ "norms.jsonl": undefined });
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.info.counts.norms).toBe(1);
  });
});

describe("resolveIndexDir", () => {
  it("явный параметр важнее переменной окружения", () => {
    vi.stubEnv("FSNB_INDEX_DIR", "/opt/from-env");
    expect(resolveIndexDir("/opt/explicit")).toBe(resolve("/opt/explicit"));
  });

  it("без параметра берётся переменная окружения", () => {
    vi.stubEnv("FSNB_INDEX_DIR", "/opt/from-env");
    expect(resolveIndexDir()).toBe(resolve("/opt/from-env"));
  });

  it("пустая переменная окружения не принимается за каталог", () => {
    vi.stubEnv("FSNB_INDEX_DIR", "   ");
    expect(resolveIndexDir()).toBe(resolve(DEFAULT_INDEX_DIR));
  });

  it("без параметра и переменной берётся каталог по умолчанию", () => {
    vi.stubEnv("FSNB_INDEX_DIR", "");
    expect(resolveIndexDir()).toBe(resolve(DEFAULT_INDEX_DIR));
    expect(DEFAULT_INDEX_DIR).toBe("data/fsnb/index");
  });
});

describe("describeEstimateBase", () => {
  it("читает только паспорт и не трогает 185 МБ норм", async () => {
    // Нормы удалены, а состояние всё ещё READY: экран состояния базы обязан
    // работать без загрузки индекса, иначе проверка стоит 2 с и 822 МБ.
    await rm(join(dir, "norms.jsonl"));
    const described = await describeEstimateBase({ indexDir: dir });
    expect(described.state).toBe("READY");
    if (described.state !== "READY") return;
    expect(described.info.priceZone).toBe(AMUR_ZONE.zone);
    expect(described.info.counts.norms).toBe(1);
    expect(described.info.counts.basePrices).toBe(BASE_PRICES.length);
  });

  it("без паспорта отдаёт причину и команду сборки, а не бросает", async () => {
    await rm(join(dir, "build-info.json"));
    const described = await describeEstimateBase({ indexDir: dir });
    expect(described.state).toBe("UNAVAILABLE");
    if (described.state !== "UNAVAILABLE") return;
    expect(described.command).toBe(BUILD_COMMAND);
    expect(described.indexDir).toBe(resolve(dir));
    expect(described.reason).toContain("build-info.json");
  });

  it("счётчики берутся из паспорта, а не пересчётом строк", async () => {
    const described = await describeEstimateBase({ indexDir: dir });
    if (described.state !== "READY") throw new Error("ожидалось READY");
    expect(described.info.counts.wages).toBe(AMUR_WAGE_ANCHORS.length);
    expect(described.info.counts.zones).toBe(ZONES.length);
  });
});

/*
  Раскладка по ценовым зонам: общее лежит в корне индекса, зональное — в
  zones/<priceZoneId>/. Без папки zones/ работает прежний режим — зональные файлы
  в корне считаются одной зоной.
*/

const BURYATIA_ZONE = "Республика Бурятия (5 зона)";

/** Зональные файлы: цены зоны отличаются от амурских, чтобы подмену заметил тест. */
async function writeZone(
  id: number,
  zoneName: string,
  subject: string,
  priceFactor: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const zoneDir = join(dir, "zones", String(id));
  await mkdir(zoneDir, { recursive: true });
  const prices = CURRENT_PRICES.map((price) => ({
    ...price,
    price: Math.round(price.price * priceFactor * 100) / 100,
    zone: zoneName,
  }));
  await writeFile(join(zoneDir, "prices-current.jsonl"), jsonl(prices), "utf8");
  await writeFile(
    join(zoneDir, "wages.jsonl"),
    jsonl(AMUR_WAGE_ANCHORS.map((anchor) => ({ ...anchor, salary: Math.round(anchor.salary * priceFactor * 100) / 100 }))),
    "utf8",
  );
  await writeFile(
    join(zoneDir, "split-form.json"),
    JSON.stringify({ zone: zoneName, period: "3 квартал 2026 года", indexLetter: "Письмо № 1", wageAct: "Приказ № 2", written: 3, indexed: 1 }),
    "utf8",
  );
  await writeFile(
    join(zoneDir, "zone.json"),
    JSON.stringify({
      priceZoneId: id,
      zoneName,
      subject,
      periodId: 427,
      period: "3 квартал 2026 г.",
      builtAt: "2026-10-07T00:00:00.000Z",
      indexLetter: "Письмо № 1",
      wageAct: "Приказ № 2",
      counts: { currentPrices: prices.length, splitPrices: 3, splitIndexed: 1, wages: AMUR_WAGE_ANCHORS.length },
      sources: [{ title: `Сплит-форма, ${zoneName}`, url: `https://example.test/split/${String(id)}` }],
      ...extra,
    }),
    "utf8",
  );
}

describe("зоны: прежний режим без папки zones/", () => {
  it("корневые файлы — одна зона, идентификатор по названию (Амур — 282)", async () => {
    const zones = await listBuiltZones({ indexDir: dir });

    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ priceZoneId: 282, zoneName: AMUR_ZONE.zone, subject: AMUR_ZONE.region, period: AMUR_ZONE.period });
  });

  it("loadEstimateBase() без аргументов и с зоной 282 дают одну и ту же базу цен", async () => {
    const byDefault = await loadEstimateBase({ indexDir: dir });
    const amur = await loadEstimateBase({ indexDir: dir, priceZoneId: 282 });

    expect(amur.priceBook.priceZone).toBe(AMUR_ZONE.zone);
    expect(amur.priceBook.current.size).toBe(byDefault.priceBook.current.size);
  });

  it("чужая зона не собрана: сообщение называет зону и то, что собрано", async () => {
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir, priceZoneId: 236 }),
      "MISSING_FILE",
      "Цен по ценовой зоне 236 ещё нет",
      "Амурская область (1 зона) (282)",
    );
  });
});

describe("зоны: раскладка zones/<id>", () => {
  beforeEach(async () => {
    await writeZone(236, BURYATIA_ZONE, "Республика Бурятия", 1.3);
    await writeZone(282, AMUR_ZONE.zone, AMUR_ZONE.region, 1);
  });

  it("listBuiltZones читает паспорта и сортирует по идентификатору", async () => {
    const zones = await listBuiltZones({ indexDir: dir });

    expect(zones.map((zone) => zone.priceZoneId)).toEqual([236, 282]);
    expect(zones[0]).toMatchObject({
      zoneName: BURYATIA_ZONE,
      subject: "Республика Бурятия",
      periodId: 427,
      period: "3 квартал 2026 г.",
      indexLetter: "Письмо № 1",
      wageAct: "Приказ № 2",
      sources: [{ title: `Сплит-форма, ${BURYATIA_ZONE}`, url: "https://example.test/split/236" }],
    });
    expect(zones[0]?.counts.splitIndexed).toBe(1);
  });

  it("папка без паспорта и паспорт чужой зоны не считаются собранной зоной", async () => {
    await mkdir(join(dir, "zones", "300"), { recursive: true });
    await writeZone(301, "Какая-то зона", "Субъект", 1, { priceZoneId: 999 });

    expect((await listBuiltZones({ indexDir: dir })).map((zone) => zone.priceZoneId)).toEqual([236, 282]);
  });

  it("цены, шкала и реквизиты — у выбранной зоны, а не соседней", async () => {
    const buryatia = await loadEstimateBase({ indexDir: dir, priceZoneId: 236 });
    const amur = await loadEstimateBase({ indexDir: dir, priceZoneId: 282 });
    const code = CURRENT_PRICES[0]!.code;

    expect(buryatia.priceBook.priceZone).toBe(BURYATIA_ZONE);
    expect(buryatia.priceBook.region).toBe("Республика Бурятия");
    expect(buryatia.priceBook.current.get(code)?.price).toBe(Math.round(CURRENT_PRICES[0]!.price * 1.3 * 100) / 100);
    expect(amur.priceBook.current.get(code)?.price).toBe(CURRENT_PRICES[0]!.price);
    expect(buryatia.info.splitForm).toMatchObject({ zone: BURYATIA_ZONE, indexLetter: "Письмо № 1" });
    // Ставка разряда 2,5: 625,70 ₽ у Амура, у «бурятской» зоны — в 1,3 раза выше.
    expect(resolveWage(amur.priceBook.wageScale, "1-100-25")?.salary).toBe(625.7);
    expect(resolveWage(buryatia.priceBook.wageScale, "1-100-25")?.salary).toBe(813.41);
  });

  it("общая часть одна на обе зоны: нормы и базисные цены не читаются дважды", async () => {
    const buryatia = await loadEstimateBase({ indexDir: dir, priceZoneId: 236 });
    const amur = await loadEstimateBase({ indexDir: dir, priceZoneId: 282 });

    expect(buryatia.searchIndex).toBe(amur.searchIndex);
    expect(buryatia.priceBook.base).toBe(amur.priceBook.base);
    expect(buryatia.zones).toBe(amur.zones);
  });

  it("без аргументов — зона 282, если она собрана", async () => {
    const base = await loadEstimateBase({ indexDir: dir });
    expect(base.priceBook.priceZone).toBe(AMUR_ZONE.zone);
    expect(base.priceBook.current.get(CURRENT_PRICES[0]!.code)?.price).toBe(CURRENT_PRICES[0]!.price);
  });

  it("без аргументов и без зоны 282 — корневые файлы прежнего режима", async () => {
    await rm(join(dir, "zones", "282"), { recursive: true });
    const base = await loadEstimateBase({ indexDir: dir });

    expect(base.priceBook.priceZone).toBe(AMUR_ZONE.zone);
    expect(base.priceBook.current.get(CURRENT_PRICES[0]!.code)?.price).toBe(CURRENT_PRICES[0]!.price);
  });

  it("не собранная зона отказывает, называя собранные", async () => {
    await expectUnavailable(
      loadEstimateBase({ indexDir: dir, priceZoneId: 237 }),
      "MISSING_FILE",
      "Цен по ценовой зоне 237 ещё нет",
      "Республика Бурятия (5 зона) (236)",
      "fetch-zone.ts --zone 237",
    );
  });

  it("loadZonePriceBook: книга зоны, кэш по (зона, зона Севера)", async () => {
    const first = await loadZonePriceBook(236, { indexDir: dir, northZone: "TERRITORY" });
    const again = await loadZonePriceBook(236, { indexDir: dir, northZone: "TERRITORY" });
    const north = await loadZonePriceBook(236, { indexDir: dir, northZone: "MPRKS" });

    expect(first.priceZone).toBe(BURYATIA_ZONE);
    expect(again).toBe(first);
    // Другая колонка нормативов — другая книга, но цены зоны те же объекты.
    expect(north).not.toBe(first);
    expect(north.current).toBe(first.current);
    expect(north.wageScale).toBe(first.wageScale);
  });

  it("loadZonePriceBook не читает нормы: без файла norms.jsonl книга цен зоны всё равно собирается", async () => {
    // Аудит сметы заказчика нормы не подбирает, а справочник норм весит 185 МБ.
    await rm(join(dir, "norms.jsonl"));

    const book = await loadZonePriceBook(236, { indexDir: dir, northZone: "TERRITORY" });
    expect(book.priceZone).toBe(BURYATIA_ZONE);
    expect(book.current.size).toBeGreaterThan(0);

    // Тот же индекс без норм для полной загрузки (расчёта сметы) — отказ: нормы там нужны.
    clearEstimateBaseCache();
    await expectUnavailable(loadEstimateBase({ indexDir: dir, priceZoneId: 236 }), "MISSING_FILE", "norms.jsonl");
  });

  it("источники зоны названы её паспортом, с адресами выгрузок", async () => {
    const base = await loadEstimateBase({ indexDir: dir, priceZoneId: 236 });

    expect(base.sources.map((source) => source.url)).toContain("https://example.test/split/236");
    expect(base.sources.some((source) => source.title.includes("ФСЦСР"))).toBe(false);
    expect(base.sources[base.sources.length - 1]?.title).toContain("Главгосэкспертиза");
  });

  it("сброс кэша перечитывает и зоны", async () => {
    const first = await loadZonePriceBook(236, { indexDir: dir });
    clearEstimateBaseCache();
    expect(await loadZonePriceBook(236, { indexDir: dir })).not.toBe(first);
  });

  it("зоны ФГИС ЦС читаются без загрузки норм", async () => {
    const records = await readPriceZoneRecords({ indexDir: dir });
    expect(records.map((record) => record.subjectCode)).toEqual(["28", "29"]);
  });

  it("пустой каталог зон и каталог без индекса — пустой список, не ошибка", async () => {
    expect(await listBuiltZones({ indexDir: join(dir, "нет-такого") })).toEqual([]);
    expect(await readPriceZoneRecords({ indexDir: join(dir, "нет-такого") })).toEqual([]);
    await rm(join(dir, "zones"), { recursive: true });
    await mkdir(join(dir, "zones"));
    expect(await listBuiltZones({ indexDir: dir })).toEqual([]);
  });
});

describe("тарифная шкала: специалисты и машинисты из полного реестра", () => {
  const SPECIALIST = {
    kind: "SPECIALIST",
    code: "3-200-03",
    name: "Инженер III категории",
    salary: 965.99,
    source: "Реестр ставок оплаты труда, должности специалистов",
  };
  const MACHINIST = { kind: "MACHINIST", code: "4-100-043", rank: 4.3, salary: 768.4, source: "Реестр, машинисты" };

  it("записи с kind читаются в свои списки, разряды рабочих — без изменений", async () => {
    await writeIndex({ "wages.jsonl": jsonl([...AMUR_WAGE_ANCHORS, MACHINIST, SPECIALIST]) });
    await patchBuildInfo({ "wages.jsonl": { lines: AMUR_WAGE_ANCHORS.length + 2 } });

    const { priceBook } = await loadEstimateBase({ indexDir: dir });
    const scale = priceBook.wageScale;

    expect(scale.anchors).toHaveLength(33);
    expect(scale.specialists).toEqual([
      { code: "3-200-03", name: "Инженер III категории", salary: 965.99, source: "Реестр ставок оплаты труда, должности специалистов" },
    ]);
    expect(scale.machinists?.map((anchor) => [anchor.rank, anchor.salary])).toEqual([[4.3, 768.4]]);
    expect(resolveWage(scale, "3-200-03")?.salary).toBe(965.99);
    expect(resolveWage(scale, "3-100-01")).toBeNull();
  });

  it("зона из zones/<id> с полным реестром: специалисты лежат в шкале зоны", async () => {
    await writeZone(236, BURYATIA_ZONE, "Республика Бурятия", 1);
    await writeFile(join(dir, "zones", "236", "wages.jsonl"), jsonl([...AMUR_WAGE_ANCHORS, SPECIALIST]), "utf8");

    const zone = await loadEstimateBase({ indexDir: dir, priceZoneId: 236 });
    const root = await loadEstimateBase({ indexDir: dir });

    expect(resolveWage(zone.priceBook.wageScale, "3-200-03")?.salary).toBe(965.99);
    expect(root.priceBook.wageScale.specialists).toBeUndefined();
  });

  it("специалист без кода, без ставки или неизвестный вид — отказ с номером строки", async () => {
    for (const [record, words] of [
      [{ kind: "SPECIALIST", name: "Инженер", salary: 1 }, "нет кода"],
      [{ kind: "SPECIALIST", code: "3-200-03", salary: 0 }, "не положительное число"],
      [{ kind: "ПРОЧЕЕ", rank: 1, salary: 1 }, "неизвестный вид ставки"],
    ] as const) {
      clearEstimateBaseCache();
      await writeIndex({ "wages.jsonl": jsonl([...AMUR_WAGE_ANCHORS, record]) });
      await patchBuildInfo({ "wages.jsonl": { lines: AMUR_WAGE_ANCHORS.length + 1 } });
      await expectUnavailable(loadEstimateBase({ indexDir: dir }), "BAD_RECORD", "wages.jsonl", words);
    }
  });
});

describe("настоящая собранная база", () => {
  // Полный прогон по настоящему индексу стоит 2 с и 822 МБ, поэтому здесь
  // проверяется только паспорт: он доказывает, что каталог по умолчанию
  // находится и что сборка записала зону, период и счётчики. Сам индекс целиком
  // читает `scripts/fsnb/demo-estimate.ts`. Тест честно помечается пропущенным,
  // если индекс не собран: молчаливое «прошло» здесь было бы ложным.
  const built = existsSync(resolve(DEFAULT_INDEX_DIR, "build-info.json"));

  it.skipIf(!built)(
    "паспорт в data/fsnb/index читается и называет амурскую зону",
    async () => {
      const described = await describeEstimateBase();
      expect(described.state).toBe("READY");
      if (described.state !== "READY") return;
      expect(described.info.priceZone).toBe("Амурская область (1 зона)");
      expect(described.info.period).toBe("3 квартал 2026 г.");
      expect(described.info.region).toBe("Амурская область");
      expect(described.info.baseEdition).toBe("01.01.2022");
      expect(described.info.decree).toBe(
        "Приказ Минстроя России № 527/пр от 12.08.2026",
      );
      expect(described.info.counts).toEqual({
        norms: 56_242,
        basePrices: 47_576,
        currentPrices: 1_290,
        wages: 35,
        zones: 154,
      });
    },
  );
});

describe("loadZoneAuditPrices: все цены сплит-формы для аудита", () => {
  const record = (code: string, price: number, unit = "кг", indexed = false) => JSON.stringify({ c: code, p: price, u: unit, i: indexed });

  async function writeAll(zone: number, lines: readonly string[]): Promise<void> {
    await mkdir(join(dir, "zones", String(zone)), { recursive: true });
    await writeFile(join(dir, "zones", String(zone), "prices-split-all.jsonl"), `${lines.join("\n")}\n`, "utf8");
  }

  it("читает {c, p, u, i} в карту: цена, единица, признак «по индексу»", async () => {
    await writeAll(236, [record("21.1.07.05-0116", 5580023.18, "1000 м", true), record("04.3.02.13-0022", 33.71)]);

    const prices = await loadZoneAuditPrices(236, { indexDir: dir });

    expect(prices?.size).toBe(2);
    expect(prices?.get("21.1.07.05-0116")).toEqual({ price: 5580023.18, unit: "1000 м", indexed: true });
    expect(prices?.get("04.3.02.13-0022")).toEqual({ price: 33.71, unit: "кг", indexed: false });
  });

  it("файла нет (зона собрана раньше) — null, без ошибки; не кэшируется: пересобранная зона подхватывается", async () => {
    await mkdir(join(dir, "zones", "246"), { recursive: true });
    expect(await loadZoneAuditPrices(246, { indexDir: dir })).toBeNull();

    await writeAll(246, [record("01.7.15.03-0042", 195.92)]);
    expect((await loadZoneAuditPrices(246, { indexDir: dir }))?.get("01.7.15.03-0042")?.price).toBe(195.92);
  });

  it("ленивость: книга цен зоны и полная загрузка файл «все цены» не трогают", async () => {
    // Вместо файла — каталог с тем же именем: любая попытка прочитать его оборвалась бы ошибкой.
    await mkdir(join(dir, "zones", "236", "prices-split-all.jsonl"), { recursive: true });
    await writeFile(join(dir, "zones", "236", "zone.json"), JSON.stringify({ priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)", period: "3 квартал 2026 г.", subject: "Республика Бурятия" }));
    await writeFile(join(dir, "zones", "236", "prices-current.jsonl"), jsonl(CURRENT_PRICES));
    await writeFile(join(dir, "zones", "236", "wages.jsonl"), jsonl(AMUR_WAGE_ANCHORS));

    const book = await loadZonePriceBook(236, { indexDir: dir });
    expect(book.current.size).toBeGreaterThan(0);
  });

  it("кэш на несколько зон с вытеснением давно не запрашивавшейся (LRU)", async () => {
    expect(AUDIT_PRICES_CACHE_ZONES).toBe(3);
    for (const zone of [1, 2, 3, 4]) await writeAll(zone, [record("01.7.15.03-0042", zone * 10)]);

    const first = await loadZoneAuditPrices(1, { indexDir: dir });
    await loadZoneAuditPrices(2, { indexDir: dir });
    await loadZoneAuditPrices(3, { indexDir: dir });
    // Зона 1 запрошена снова — самой старой становится зона 2.
    expect(await loadZoneAuditPrices(1, { indexDir: dir })).toBe(first);
    await loadZoneAuditPrices(4, { indexDir: dir });

    // Файлы подменены: что прочитано заново, а что осталось в кэше — видно по цене.
    for (const zone of [1, 2, 3, 4]) await writeAll(zone, [record("01.7.15.03-0042", zone * 10 + 1)]);
    expect((await loadZoneAuditPrices(1, { indexDir: dir }))?.get("01.7.15.03-0042")?.price).toBe(10);
    expect((await loadZoneAuditPrices(3, { indexDir: dir }))?.get("01.7.15.03-0042")?.price).toBe(30);
    expect((await loadZoneAuditPrices(4, { indexDir: dir }))?.get("01.7.15.03-0042")?.price).toBe(40);
    expect((await loadZoneAuditPrices(2, { indexDir: dir }))?.get("01.7.15.03-0042")?.price).toBe(21);
  });

  it("одновременные запросы одной зоны делят одно чтение; сброс кэша читает заново", async () => {
    await writeAll(5, [record("01.7.15.03-0042", 1)]);
    const [a, b] = await Promise.all([loadZoneAuditPrices(5, { indexDir: dir }), loadZoneAuditPrices(5, { indexDir: dir })]);
    expect(a).toBe(b);

    clearEstimateBaseCache();
    expect(await loadZoneAuditPrices(5, { indexDir: dir })).not.toBe(a);
  });

  it("битые строки и строки без цены пропускаются: файл нужен только для сверки", async () => {
    await writeAll(7, ["не json", JSON.stringify({ c: "x" }), JSON.stringify({ c: "y", p: -1, u: "т", i: false }), record("01.7.15.03-0042", 195.92)]);
    const prices = await loadZoneAuditPrices(7, { indexDir: dir });
    expect([...(prices?.keys() ?? [])]).toEqual(["01.7.15.03-0042"]);
  });
});


describe("loadZoneAutoServices: цены перевозки и погрузки зоны", () => {
  const transportLine = (prefix: string, price: number, road = "01") =>
    JSON.stringify({ c: prefix, vt: "02", cap: 15, cu: "т", cls: 1, road, p: Array.from({ length: 50 }, (_, index) => (index + 1 === 47 ? price : null)) });
  const loadLine = (code: string, group: number, price: number, kind = "load") =>
    JSON.stringify({ c: code, g: group, n: `Группа ${String(group)}`, k: kind, p: price });

  async function writeServices(zone: number, transport: readonly string[], load: readonly string[]): Promise<void> {
    await mkdir(join(dir, "zones", String(zone)), { recursive: true });
    if (transport.length > 0) await writeFile(join(dir, "zones", String(zone), "transport-auto.jsonl"), `${transport.join("\n")}\n`, "utf8");
    if (load.length > 0) await writeFile(join(dir, "zones", String(zone), "load-auto.jsonl"), `${load.join("\n")}\n`, "utf8");
  }

  it("читает серии по километрам и цены погрузки в карты: 02-15-1-01 → 47 км = 619,94, 49-1 = 94,64", async () => {
    await writeServices(246, [transportLine("02-15-1-01", 619.94)], [loadLine("49-1", 49, 94.64), loadLine("49-2", 49, 10, "unload")]);

    const services = await loadZoneAutoServices(246, { indexDir: dir });

    expect(services?.transport.get("02-15-1-01")?.prices[46]).toBe(619.94);
    expect(services?.load.get("49-1")).toMatchObject({ price: 94.64, operation: "LOAD", group: 49 });
    expect(services?.load.get("49-2")?.operation).toBe("UNLOAD");
  });

  it("файлов нет (зона собрана раньше) — null, без ошибки; не кэшируется: пересобранная зона подхватывается", async () => {
    await mkdir(join(dir, "zones", "246"), { recursive: true });
    expect(await loadZoneAutoServices(246, { indexDir: dir })).toBeNull();

    await writeServices(246, [], [loadLine("42-1", 42, 94.64)]);
    expect((await loadZoneAutoServices(246, { indexDir: dir }))?.load.get("42-1")?.price).toBe(94.64);
  });

  it("битые строки и записи без цены пропускаются; файл без единой пригодной записи — null", async () => {
    await writeServices(7, ["не json", JSON.stringify({ c: "02-15-1-01" }), transportLine("02-15-1-02", 700, "02")], ["{", loadLine("49-1", 49, 0)]);

    const services = await loadZoneAutoServices(7, { indexDir: dir });

    expect([...(services?.transport.keys() ?? [])]).toEqual(["02-15-1-02"]);
    expect(services?.load.size).toBe(0);

    await writeServices(8, ["мусор"], ["мусор"]);
    expect(await loadZoneAutoServices(8, { indexDir: dir })).toBeNull();
  });

  it("кэш на несколько зон с вытеснением давно не запрашивавшейся; одновременные запросы делят одно чтение", async () => {
    expect(AUTO_SERVICES_CACHE_ZONES).toBe(3);
    for (const zone of [1, 2, 3, 4]) await writeServices(zone, [], [loadLine("49-1", 49, zone * 10)]);

    const first = await loadZoneAutoServices(1, { indexDir: dir });
    await loadZoneAutoServices(2, { indexDir: dir });
    await loadZoneAutoServices(3, { indexDir: dir });
    expect(await loadZoneAutoServices(1, { indexDir: dir })).toBe(first);
    await loadZoneAutoServices(4, { indexDir: dir });

    for (const zone of [1, 2, 3, 4]) await writeServices(zone, [], [loadLine("49-1", 49, zone * 10 + 1)]);
    expect((await loadZoneAutoServices(1, { indexDir: dir }))?.load.get("49-1")?.price).toBe(10);
    expect((await loadZoneAutoServices(2, { indexDir: dir }))?.load.get("49-1")?.price).toBe(21);

    const [a, b] = await Promise.all([loadZoneAutoServices(9, { indexDir: dir }), loadZoneAutoServices(9, { indexDir: dir })]);
    expect(a).toBe(b);
  });

  it("зона пересобрана (новый builtAt в паспорте) — читается новая сборка, а не кэш воркера", async () => {
    await writeZone(246, "Иркутская область (1 зона)", "Иркутская область", 1);
    await writeServices(246, [], [loadLine("49-1", 49, 94.64)]);
    expect((await loadZoneAutoServices(246, { indexDir: dir }))?.load.get("49-1")?.price).toBe(94.64);

    // Ночное обновление: файлы и паспорт заменены другим процессом.
    await writeServices(246, [], [loadLine("49-1", 49, 99.99)]);
    expect((await loadZoneAutoServices(246, { indexDir: dir }))?.load.get("49-1")?.price).toBe(94.64);
    await writeZone(246, "Иркутская область (1 зона)", "Иркутская область", 1, { builtAt: "2026-10-09T02:30:00.000Z" });
    await writeServices(246, [], [loadLine("49-1", 49, 99.99)]);

    expect((await loadZoneAutoServices(246, { indexDir: dir }))?.load.get("49-1")?.price).toBe(99.99);
  });

  it("книга цен и база зоны тоже перечитываются после пересборки: кэш ключуется отметкой сборки", async () => {
    const code = (CURRENT_PRICES[0] as { code: string }).code;
    await writeZone(236, BURYATIA_ZONE, "Республика Бурятия", 1.3);
    const before = await loadEstimateBase({ indexDir: dir, priceZoneId: 236 });
    expect(await loadEstimateBase({ indexDir: dir, priceZoneId: 236 })).toBe(before);
    const price = before.priceBook.current.get(code)?.price;

    await writeZone(236, BURYATIA_ZONE, "Республика Бурятия", 2, { builtAt: "2026-10-09T02:30:00.000Z" });
    const after = await loadEstimateBase({ indexDir: dir, priceZoneId: 236 });

    expect(after).not.toBe(before);
    expect(after.priceBook.current.get(code)?.price).not.toBe(price);
    expect((await loadZonePriceBook(236, { indexDir: dir })).current.get(code)?.price).toBe(after.priceBook.current.get(code)?.price);
  });

  it("паспорт базы называет идентификатор зоны — по нему расчёт дочитывает файлы той же зоны", async () => {
    await writeZone(236, BURYATIA_ZONE, "Республика Бурятия", 1.3);

    expect((await loadEstimateBase({ indexDir: dir, priceZoneId: 236 })).info.priceZoneId).toBe(236);
    // Прежний режим без zones/ идентификатор зоны в паспорте не называет.
    clearEstimateBaseCache();
    await rm(join(dir, "zones"), { recursive: true, force: true });
    expect((await loadEstimateBase({ indexDir: dir })).info.priceZoneId).toBeUndefined();
  });
});
