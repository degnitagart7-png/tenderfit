import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  loadEstimateBase,
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
