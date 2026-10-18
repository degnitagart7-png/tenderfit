import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { periodsUrl, zonesUrl } from "../../src/lib/fsnb/fgisZoneApi";
import { acquireZoneBuildLock } from "../../src/lib/fsnb/zoneBuildLock";
import { parseBuildAllArgs, runBuildAll, type BuildAllOptions } from "./build-all-zones";
import type { BuildZoneOptions } from "./build-zone";
import type { Downloader, FetchedZone } from "./fetch-zone";
import { directoryBytes, pacedDownloader, readZonePassport, zoneState, type ZonePassport } from "./zone-update";

/*
  Сборка всех зон на подменённых скачивании и сборке: выбор устаревших зон, сбой одной зоны,
  атомарность замены каталога, --dry-run, --force, --only, срок, замок. Сеть и настоящая сборка не
  нужны: справочник и периоды отдаёт подставной `download`, сырьё и сборку заменяют `fetchRaw` и `build`.
*/

let dir = "";
let indexDir = "";
let rawRoot = "";
let lockPath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "build-all-zones-"));
  indexDir = join(dir, "index");
  rawRoot = join(dir, "raw");
  lockPath = join(dir, "zones-build.lock");
  mkdirSync(join(indexDir, "zones"), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DIRECTORY = [
  { value: 193, text: "Республика Бурятия" },
  { value: 232, text: "Республика Бурятия (1 зона)" },
  { value: 233, text: "Республика Бурятия (2 зона)" },
  { value: 234, text: "Республика Бурятия (3 зона)" },
  { value: 236, text: "Республика Бурятия (5 зона)" },
  { value: 246, text: "Иркутская область (1 зона)" },
  { value: 282, text: "Амурская область (1 зона)" },
];

const LATEST = 427;

/** Подставное скачивание: справочник, периоды (по умолчанию 427, у отдельных зон — свои или сбой). */
function fakeDownload(periodsByZone: Readonly<Record<number, number | "fail" | "none">> = {}): Downloader & { urls: string[] } {
  const urls: string[] = [];
  const download = async (url: string): Promise<Uint8Array> => {
    urls.push(url);
    if (url === zonesUrl()) return new TextEncoder().encode(JSON.stringify(DIRECTORY));
    for (const zone of DIRECTORY) {
      if (url === periodsUrl(zone.value)) {
        const latest = periodsByZone[zone.value] ?? LATEST;
        if (latest === "fail") throw new Error("Периоды: ФГИС ЦС ответил 500.");
        if (latest === "none") return new TextEncoder().encode("[]");
        return new TextEncoder().encode(JSON.stringify([{ id: latest, name: `квартал ${String(latest)}` }, { id: 400, name: "старый" }]));
      }
    }
    throw new Error(`неожиданный запрос ${url}`);
  };
  return Object.assign(download, { urls });
}

/** Пишет собранную зону на диск: паспорт и один файл с отметкой, чтобы видеть, какая сборка лежит. */
function writeZone(id: number, passport: Partial<Record<string, unknown>> = {}, marker = "old"): void {
  const zoneDir = join(indexDir, "zones", String(id));
  mkdirSync(zoneDir, { recursive: true });
  writeFileSync(join(zoneDir, "zone.json"), JSON.stringify({ priceZoneId: id, periodId: LATEST, buildVersion: 2, builtAt: "2026-10-01T00:00:00.000Z", ...passport }));
  writeFileSync(join(zoneDir, "marker.txt"), marker);
}

interface Calls {
  readonly fetched: number[];
  readonly built: number[];
  /** Что лежало в каталоге зоны в момент сборки — доказательство, что подмена идёт только в конце. */
  readonly targetDuringBuild: Map<number, { passport: ZonePassport | null; marker: string | null }>;
}

function fakes(options: { failBuild?: readonly number[]; failFetch?: readonly number[]; onBuild?: (zone: number) => void } = {}) {
  const calls: Calls = { fetched: [], built: [], targetDuringBuild: new Map() };
  const fetchRaw = async (id: number, zoneName: string, o: { periodChoice?: { id: number; name: string } }): Promise<FetchedZone> => {
    calls.fetched.push(id);
    if (options.failFetch?.includes(id) === true) throw new Error("ФГИС ЦС ответил 502.");
    const period = o.periodChoice as { id: number; name: string };
    const rawDir = join(rawRoot, String(id), String(period.id));
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "split.xlsx"), "сырьё");
    return { priceZoneId: id, zoneName, periodId: period.id, periodName: period.name, dir: rawDir, warnings: [] };
  };
  const build = async (o: BuildZoneOptions) => {
    calls.built.push(o.zone);
    const target = join(indexDir, "zones", String(o.zone));
    calls.targetDuringBuild.set(o.zone, {
      passport: readZonePassport(indexDir, o.zone),
      marker: existsSync(join(target, "marker.txt")) ? readFileSync(join(target, "marker.txt"), "utf8") : null,
    });
    options.onBuild?.(o.zone);
    mkdirSync(o.out as string, { recursive: true });
    writeFileSync(join(o.out as string, "marker.txt"), "new");
    writeFileSync(join(o.out as string, "prices-current.jsonl"), "x".repeat(1000));
    if (options.failBuild?.includes(o.zone) === true) throw new Error("сплит-форма не разобралась");
    writeFileSync(
      join(o.out as string, "zone.json"),
      JSON.stringify({ priceZoneId: o.zone, periodId: o.period, buildVersion: 2, builtAt: "2026-10-08T02:30:00.000Z", notes: ["примечание сборки"] }),
    );
    return { zoneDocument: { notes: ["примечание сборки"] }, outDir: o.out as string, peakRssBytes: 1 };
  };
  return { calls, fetchRaw, build };
}

function options(patch: Partial<BuildAllOptions> = {}): BuildAllOptions {
  return { only: null, force: false, dryRun: false, pauseMs: 0, keepRaw: false, maxMinutes: null, lockWaitMinutes: 0, indexDir, rawRoot, ...patch };
}

async function run(patch: Partial<BuildAllOptions> = {}, f = fakes(), download = fakeDownload(), extra: Partial<Parameters<typeof runBuildAll>[1]> = {}) {
  const log: string[] = [];
  const report = await runBuildAll(options(patch), {
    download,
    log: (message) => log.push(message),
    lockPath,
    updateDeps: { build: f.build, fetchRaw: f.fetchRaw as never },
    isAlive: () => true,
    ...extra,
  });
  return { report, log: log.join("\n"), f };
}

const tempDirs = (): string[] => readdirSync(join(indexDir, "zones")).filter((name) => name.startsWith("."));

describe("runBuildAll: выбор зон", () => {
  it("недостающие и устаревшие собираются, актуальные пропускаются; запись субъекта (193) — не зона", async () => {
    writeZone(282); // актуальна
    writeZone(236, { periodId: 410 }); // период устарел
    writeZone(246, { buildVersion: 1 }); // тот же период, но прежний формат
    writeZone(234, { transportAuto: false }); // перевозка не скачалась — повтор
    // 232 и 233 не собраны вовсе

    const { report, f } = await run();

    expect(report.built.map((zone) => zone.priceZoneId)).toEqual([232, 233, 234, 236, 246]);
    expect(report.skipped.map((zone) => zone.priceZoneId)).toEqual([282]);
    expect(report.failed).toEqual([]);
    expect(f.calls.fetched).not.toContain(193);
    expect(f.calls.fetched).not.toContain(282);
    // Зона 236 теперь за новый период, остальные тоже на диске.
    expect(readZonePassport(indexDir, 236)).toMatchObject({ periodId: LATEST, buildVersion: 2 });
    expect(readFileSync(join(indexDir, "zones", "236", "marker.txt"), "utf8")).toBe("new");
  });

  it("зона, у которой период свежее нашего, пересобирается; та же — нет (период берётся по каждой зоне)", async () => {
    writeZone(282);
    writeZone(246);

    const { report } = await run({}, fakes(), fakeDownload({ 246: 428 }));

    expect(report.built.map((zone) => zone.priceZoneId)).toContain(246);
    expect(report.skipped.map((zone) => zone.priceZoneId)).toContain(282);
    expect(readZonePassport(indexDir, 246)?.periodId).toBe(428);
  });

  it("справочник записывается рядом с индексом: по нему сборка по требованию узнаёт номер зоны", async () => {
    await run();

    const file = JSON.parse(readFileSync(join(indexDir, "zones-directory.json"), "utf8")) as { zones: { value: number }[] };
    expect(file.zones.map((zone) => zone.value)).toEqual(DIRECTORY.map((zone) => zone.value));
  });

  it("--only: только названные зоны; номера, которых нет в справочнике, — ошибка в журнале, остальные собираются", async () => {
    const { report, f } = await run({ only: [236, 9999] });

    expect(f.calls.built).toEqual([236]);
    expect(report.failed).toEqual([{ priceZoneId: 9999, zoneName: "?", detail: "нет в справочнике ФГИС ЦС" }]);
  });

  it("--force: актуальная зона пересобирается", async () => {
    writeZone(282);

    const { report, f } = await run({ only: [282], force: true });

    expect(f.calls.built).toEqual([282]);
    expect(report.skipped).toEqual([]);
    expect(readFileSync(join(indexDir, "zones", "282", "marker.txt"), "utf8")).toBe("new");
  });
});

describe("runBuildAll: сбои не останавливают остальные", () => {
  it("сбой сборки одной зоны: она в ошибках, остальные собраны, каталога сбойной зоны нет, временных каталогов нет", async () => {
    const f = fakes({ failBuild: [233] });

    const { report, log } = await run({}, f);

    expect(report.failed).toEqual([expect.objectContaining({ priceZoneId: 233, detail: "сборка: сплит-форма не разобралась" })]);
    expect(report.built.map((zone) => zone.priceZoneId)).toEqual([232, 234, 236, 246, 282]);
    expect(existsSync(join(indexDir, "zones", "233"))).toBe(false);
    expect(tempDirs()).toEqual([]);
    expect(log).toContain("ошибка: зона 233");
    expect(log).toContain("собрано: 5, пропущено: 0, ошибки: 1");
  });

  it("сбой скачивания и сбой запроса периодов — тоже по одной зоне; журнал называет причины", async () => {
    const f = fakes({ failFetch: [232] });

    const { report } = await run({}, f, fakeDownload({ 233: "fail" }));

    expect(report.failed.map((zone) => [zone.priceZoneId, zone.detail])).toEqual([
      [232, "скачивание: ФГИС ЦС ответил 502."],
      [233, "Периоды: ФГИС ЦС ответил 500."],
    ]);
    expect(report.built.map((zone) => zone.priceZoneId)).toEqual([234, 236, 246, 282]);
  });

  it("ФГИС ЦС не публикует периоды зоны (Карелия, Сахалин) — пропуск, а не ошибка: служба не падает каждую ночь", async () => {
    const { report, log } = await run({}, fakes(), fakeDownload({ 233: "none" }));

    expect(report.failed).toEqual([]);
    expect(report.skipped.map((zone) => [zone.priceZoneId, zone.detail])).toEqual([[233, "в ФГИС ЦС нет опубликованных периодов цен"]]);
    expect(report.built.map((zone) => zone.priceZoneId)).toEqual([232, 234, 236, 246, 282]);
    expect(log).toMatch(/зона 233 .*пропущена — в ФГИС ЦС нет опубликованных периодов цен/);
  });

  it("справочник зон недоступен — это не сбой одной зоны, а отказ запуска", async () => {
    const download: Downloader = async () => {
      throw new Error("справочник: таймаут");
    };

    await expect(run({}, fakes(), download as never)).rejects.toThrow("справочник: таймаут");
  });
});

describe("runBuildAll: атомарность — зона меняется целиком и только в конце", () => {
  it("пока идёт сборка, в каталоге зоны лежит прежняя сборка целиком; после — новая целиком", async () => {
    writeZone(236, { periodId: 410 }, "old");

    const { f } = await run({ only: [236] });

    expect(f.calls.targetDuringBuild.get(236)).toEqual({ passport: expect.objectContaining({ periodId: 410 }), marker: "old" });
    expect(readZonePassport(indexDir, 236)).toMatchObject({ periodId: LATEST });
    expect(readFileSync(join(indexDir, "zones", "236", "marker.txt"), "utf8")).toBe("new");
    expect(tempDirs()).toEqual([]);
  });

  it("сборка упала — прежняя зона цела и читается, временный каталог убран", async () => {
    writeZone(236, { periodId: 410 }, "old");

    const { report } = await run({ only: [236] }, fakes({ failBuild: [236] }));

    expect(report.failed).toHaveLength(1);
    expect(readZonePassport(indexDir, 236)).toMatchObject({ periodId: 410 });
    expect(readFileSync(join(indexDir, "zones", "236", "marker.txt"), "utf8")).toBe("old");
    expect(tempDirs()).toEqual([]);
  });

  it("собранный каталог без паспорта нужной зоны и периода не подменяет прежнюю зону", async () => {
    writeZone(236, { periodId: 410 }, "old");
    const f = fakes();
    const brokenBuild = async (o: BuildZoneOptions) => {
      mkdirSync(o.out as string, { recursive: true });
      writeFileSync(join(o.out as string, "zone.json"), JSON.stringify({ priceZoneId: 999, periodId: o.period }));
      return { zoneDocument: {}, outDir: o.out as string, peakRssBytes: 1 };
    };

    const log: string[] = [];
    const report = await runBuildAll(options({ only: [236] }), {
      download: fakeDownload(),
      log: (message) => log.push(message),
      lockPath,
      updateDeps: { build: brokenBuild as never, fetchRaw: f.fetchRaw as never },
    });

    expect(report.failed[0]?.detail).toContain("нет паспорта зоны 236");
    expect(readFileSync(join(indexDir, "zones", "236", "marker.txt"), "utf8")).toBe("old");
    expect(tempDirs()).toEqual([]);
  });

  it("сырьё после удачной сборки удаляется, с --keep-raw — остаётся; после сбоя остаётся для разбора", async () => {
    const { f } = await run({ only: [232] });
    expect(f.calls.fetched).toEqual([232]);
    expect(existsSync(join(rawRoot, "232", String(LATEST)))).toBe(false);

    await run({ only: [233], keepRaw: true });
    expect(existsSync(join(rawRoot, "233", String(LATEST)))).toBe(true);

    await run({ only: [234] }, fakes({ failBuild: [234] }));
    expect(existsSync(join(rawRoot, "234", String(LATEST)))).toBe(true);
  });
});

describe("runBuildAll: --dry-run", () => {
  it("называет, что будет собрано и почему; не скачивает сырьё, не собирает и ничего не пишет", async () => {
    writeZone(282);
    writeZone(236, { periodId: 410 }, "old");
    const download = fakeDownload();

    const { report, f, log } = await run({ dryRun: true }, fakes(), download);

    expect(f.calls.fetched).toEqual([]);
    expect(f.calls.built).toEqual([]);
    expect(report.planned.map((zone) => [zone.priceZoneId, zone.state])).toEqual([
      [232, "MISSING"],
      [233, "MISSING"],
      [234, "MISSING"],
      [236, "STALE_PERIOD"],
      [246, "MISSING"],
    ]);
    expect(report.skipped.map((zone) => zone.priceZoneId)).toEqual([282]);
    expect(report.built).toEqual([]);
    expect(log).toContain("зона 236 «Республика Бурятия (5 зона)»: будет собрана — период устарел");
    expect(log).toContain("будет собрано: 5");
    expect(log).toContain("ожидаемый прирост по диску");
    // Только справочник и периоды — никаких файлов зоны.
    expect(download.urls.every((url) => url === zonesUrl() || url.includes("/Periods?"))).toBe(true);
    expect(existsSync(join(indexDir, "zones-directory.json"))).toBe(false);
    expect(readFileSync(join(indexDir, "zones", "236", "marker.txt"), "utf8")).toBe("old");
    expect(existsSync(join(indexDir, "zones", "232"))).toBe(false);
  });
});

describe("runBuildAll: срок и замок", () => {
  it("--max-minutes: после срока новые зоны не начинаются и называются отложенными", async () => {
    let now = Date.parse("2026-10-08T02:30:00Z");
    const f = fakes({ onBuild: () => void (now += 3 * 60_000) });

    const { report } = await run({ maxMinutes: 5 }, f, fakeDownload(), { now: () => now });

    // Каждая сборка «длится» 3 минуты: после второй срок вышел.
    expect(report.built.map((zone) => zone.priceZoneId)).toEqual([232, 233]);
    expect(report.deferred.map((zone) => zone.priceZoneId)).toEqual([234, 236, 246, 282]);
  });

  it("замок занят живым процессом и ждать нельзя — зона в ошибках с названием владельца, запуск идёт дальше", async () => {
    const holder = await acquireZoneBuildLock({ path: lockPath, waitMs: 0, staleMs: 3_600_000, zoneId: 1, by: "воркер", pid: 4242, host: "x", isAlive: () => true });

    const { report, f } = await run({ only: [232, 233] }, fakes(), fakeDownload(), { isAlive: () => true });

    expect(f.calls.built).toEqual([]);
    expect(report.failed.map((zone) => zone.detail)).toEqual([expect.stringContaining("замок сборки занят: воркер (pid 4242"), expect.stringContaining("pid 4242")]);
    holder?.release();
  });

  it("пока ждали замок, зону собрал другой процесс — она пропущена, второй раз не собирается", async () => {
    const holder = await acquireZoneBuildLock({ path: lockPath, waitMs: 0, staleMs: 3_600_000, zoneId: 232, by: "воркер", host: "x", pid: 4242, isAlive: () => true });
    const f = fakes();

    const { report } = await run({ only: [232], lockWaitMinutes: 1 }, f, fakeDownload(), {
      sleep: async () => {
        writeZone(232, {}, "other");
        holder?.release();
      },
    });

    expect(f.calls.built).toEqual([]);
    expect(report.skipped.map((zone) => zone.detail)).toEqual(["пока ждали замок, зону собрал другой процесс"]);
    expect(report.built).toEqual([]);
  });

  it("замок снят после каждой зоны и после сбоя: между зонами его может взять сборка по требованию", async () => {
    await run({ only: [232] }, fakes({ failBuild: [232] }));
    expect(existsSync(lockPath)).toBe(false);
    await run({ only: [233] });
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("итог по размеру и вспомогательные функции", () => {
  it("итог: сколько зон и сколько байт на диске; размер собранной зоны — в журнале", async () => {
    const { report, log } = await run({ only: [232, 233] });

    expect(report.zonesOnDisk).toBe(2);
    expect(report.bytesOnDisk).toBe(directoryBytes(join(indexDir, "zones")));
    expect(report.bytesOnDisk).toBeGreaterThan(2000);
    expect(report.built[0]?.bytes).toBeGreaterThan(1000);
    expect(log).toContain("на диске: 2 зон");
  });

  it("состояния зоны: нет паспорта, период, формат, перевозка, актуальна", () => {
    const passport = (patch: Partial<ZonePassport> = {}): ZonePassport => ({ priceZoneId: 1, periodId: 427, buildVersion: 2, transportAuto: null, builtAt: "", ...patch });

    expect(zoneState(null, 427)).toBe("MISSING");
    expect(zoneState(passport({ periodId: 410 }), 427)).toBe("STALE_PERIOD");
    expect(zoneState(passport({ buildVersion: 1 }), 427)).toBe("OLD_FORMAT");
    expect(zoneState(passport({ transportAuto: false }), 427)).toBe("TRANSPORT_RETRY");
    expect(zoneState(passport(), 427)).toBe("FRESH");
    // Последний период неизвестен — по периоду не сравниваем.
    expect(zoneState(passport({ periodId: 410 }), null)).toBe("FRESH");
  });

  it("паспорт чужой зоны или нечитаемый файл — зоны нет", () => {
    writeZone(5, { priceZoneId: 6 });
    mkdirSync(join(indexDir, "zones", "7"), { recursive: true });
    writeFileSync(join(indexDir, "zones", "7", "zone.json"), "{ оборвано");

    expect(readZonePassport(indexDir, 5)).toBeNull();
    expect(readZonePassport(indexDir, 7)).toBeNull();
    expect(readZonePassport(indexDir, 8)).toBeNull();
  });

  it("пауза между запросами: второй запрос ждёт, первый — нет", async () => {
    const waits: number[] = [];
    const inner: Downloader = async () => new Uint8Array();
    const paced = pacedDownloader(inner, 2_000, async (ms) => void waits.push(ms));

    await paced("a", "json", "x");
    await paced("b", "json", "x");

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(1_500);
    expect(waits[0]).toBeLessThanOrEqual(2_000);
  });

  it("аргументы командной строки: флаги, несколько --only, значения по умолчанию, ошибки", () => {
    expect(parseBuildAllArgs([])).toMatchObject({ only: null, force: false, dryRun: false, pauseMs: 2000, keepRaw: false, maxMinutes: null, lockWaitMinutes: 30 });
    expect(parseBuildAllArgs(["--only", "246,282", "--only", "236", "--force", "--dry-run", "--pause", "500", "--max-minutes", "420", "--keep-raw"])).toMatchObject({
      only: [246, 282, 236],
      force: true,
      dryRun: true,
      pauseMs: 500,
      maxMinutes: 420,
      keepRaw: true,
    });
    expect(() => parseBuildAllArgs(["--only", "abc"])).toThrow("--only ожидает номера зон");
    expect(() => parseBuildAllArgs(["--pause", "-1"])).toThrow("--pause");
    expect(() => parseBuildAllArgs(["--вперёд"])).toThrow("Неизвестный флаг");
  });
});
