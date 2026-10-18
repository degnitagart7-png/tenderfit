import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { selectPricedZones, type ApiZone } from "../../src/lib/fsnb/fgisZoneApi";
import { createDownloader, fetchZoneDirectory, fetchZonePeriods, type Downloader } from "./fetch-zone";
import {
  defaultLockPath,
  directoryBytes,
  installSignalCleanup,
  pacedDownloader,
  readZonePassport,
  updateZoneLocked,
  zoneState,
  ZONE_STATE_TEXT,
  type UpdateZoneDeps,
  type ZoneState,
} from "./zone-update";

/**
 * Сборка и обновление всех ценовых зон ФГИС ЦС (около 157).
 *
 * Берёт справочник зон и последний опубликованный период каждой, собирает недостающие и
 * устаревшие зоны (период в `zone.json` не равен последнему, зона собрана прежним форматом или
 * без перевозки, хотя она должна была быть) — по одной, с паузой между запросами к ФГИС ЦС.
 * Сбой одной зоны не останавливает остальные: он попадает в журнал, итог печатается в конце, код
 * выхода 1, если сбои были. Каждая зона собирается во временный каталог и меняет `zones/<id>`
 * переименованием (`zone-update.ts`), под замком-файлом `data/fsnb/zones-build.lock`.
 *
 * Запуск (на сервере в России: ФГИС ЦС отвечает только российским адресам):
 *   npx tsx scripts/fsnb/build-all-zones.ts [--only 236,246] [--force] [--dry-run]
 *     [--pause 2000] [--max-minutes 420] [--keep-raw] [--lock-wait-minutes 30]
 *
 *   --only <ids>   только эти зоны (через запятую или несколько раз)
 *   --force        пересобрать, даже если зона актуальна
 *   --dry-run      показать, что будет собрано, ничего не скачивая и не записывая (запросы — только
 *                  справочник и периоды)
 *   --pause <мс>   пауза между запросами к ФГИС ЦС, по умолчанию 2000
 *   --max-minutes  не начинать новую зону после этого срока (ночное окно); остальные — в следующий раз
 *   --keep-raw     не удалять скачанное сырьё после сборки
 *   --lock-wait-minutes  сколько ждать замок, если им занята другая сборка (по умолчанию 30)
 *
 * Размер: зона занимает ~21 МБ, полный набор из 157 зон — около 3,3 ГБ (19 зон — 391 МБ).
 */

const ROOT = resolve(__dirname, "../..");
// Тот же каталог, что читает расчёт: `FSNB_INDEX_DIR`, иначе data/fsnb/index.
const DEFAULT_INDEX = process.env.FSNB_INDEX_DIR !== undefined && process.env.FSNB_INDEX_DIR.trim() !== "" ? resolve(process.env.FSNB_INDEX_DIR) : resolve(ROOT, "data/fsnb/index");
/** Сборка зоны не идёт дольше этого времени: замок старше считается брошенным. */
const LOCK_STALE_MS = 60 * 60_000;

export interface BuildAllOptions {
  readonly only: readonly number[] | null;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly pauseMs: number;
  readonly keepRaw: boolean;
  readonly maxMinutes: number | null;
  readonly lockWaitMinutes: number;
  readonly indexDir: string;
  readonly rawRoot?: string;
}

export interface ZoneOutcome {
  readonly priceZoneId: number;
  readonly zoneName: string;
  readonly detail: string;
}

export interface BuildAllReport {
  readonly built: readonly (ZoneOutcome & { readonly bytes: number })[];
  readonly skipped: readonly ZoneOutcome[];
  readonly failed: readonly ZoneOutcome[];
  /** Зоны, которые --dry-run собрал бы. */
  readonly planned: readonly (ZoneOutcome & { readonly state: ZoneState })[];
  /** Не начаты из-за --max-minutes. */
  readonly deferred: readonly ZoneOutcome[];
  readonly zonesOnDisk: number;
  readonly bytesOnDisk: number;
  readonly startedAt: string;
  readonly seconds: number;
}

export interface BuildAllDeps {
  readonly download: Downloader;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly isAlive?: (pid: number) => boolean;
  /** Подмены сборки и скачивания сырья зоны (тесты). */
  readonly updateDeps?: Pick<UpdateZoneDeps, "build" | "fetchRaw">;
  readonly lockPath?: string;
}

/** Каталог зон ФГИС ЦС рядом с индексом: по нему сборка по требованию узнаёт номер зоны, которой ещё нет на диске. */
export function writeZoneDirectoryFile(indexDir: string, zones: readonly ApiZone[], fetchedAt: string): void {
  mkdirSync(indexDir, { recursive: true });
  const path = resolve(indexDir, "zones-directory.json");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ fetchedAt, zones: zones.map((zone) => ({ value: zone.value, text: zone.text })) })}\n`, "utf8");
  renameSync(tmp, path);
}

function countZoneDirs(indexDir: string): number {
  try {
    return readdirSync(resolve(indexDir, "zones")).filter((name) => /^\d+$/.test(name)).length;
  } catch {
    return 0;
  }
}

const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} МБ`;

export async function runBuildAll(options: BuildAllOptions, deps: BuildAllDeps): Promise<BuildAllReport> {
  const { log } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = options.maxMinutes === null ? null : started + options.maxMinutes * 60_000;

  const built: (ZoneOutcome & { bytes: number })[] = [];
  const skipped: ZoneOutcome[] = [];
  const failed: ZoneOutcome[] = [];
  const planned: (ZoneOutcome & { state: ZoneState })[] = [];
  const deferred: ZoneOutcome[] = [];

  log("— справочник ценовых зон");
  const directory = await fetchZoneDirectory(deps.download);
  const priced = selectPricedZones(directory);
  log(`  в справочнике ${String(directory.length)} записей, зон с ценами ${String(priced.length)}`);
  if (!options.dryRun) writeZoneDirectoryFile(options.indexDir, directory, new Date(started).toISOString());

  const byId = new Map(priced.map((zone) => [zone.value, zone] as const));
  let queue: ApiZone[];
  if (options.only === null) {
    queue = priced;
  } else {
    queue = [];
    for (const id of options.only) {
      const zone = byId.get(id) ?? directory.find((item) => item.value === id);
      if (zone === undefined) failed.push({ priceZoneId: id, zoneName: "?", detail: "нет в справочнике ФГИС ЦС" });
      else queue.push(zone);
    }
  }

  const lockPath = deps.lockPath ?? defaultLockPath(ROOT);
  let index = 0;
  for (const zone of queue) {
    index += 1;
    const label = `[${String(index)}/${String(queue.length)}] зона ${String(zone.value)} «${zone.text}»`;
    const outcome = (detail: string): ZoneOutcome => ({ priceZoneId: zone.value, zoneName: zone.text, detail });

    if (deadline !== null && now() >= deadline) {
      deferred.push(outcome("не начата: вышел срок --max-minutes"));
      continue;
    }

    try {
      const periods = await fetchZonePeriods(deps.download, zone.value);
      const latest = periods[0];
      /*
        Пустой список периодов — не сбой сборки, а отсутствие данных в источнике: у Карелии (198),
        Сахалина (6 зона, 323), новых регионов и «Вся Россия» ФГИС ЦС цен не публикует. Раньше это
        шло в ошибки, служба каждую ночь падала с кодом 1, и настоящая поломка (11-я зона
        Красноярского края, 11.10.2026) терялась среди восьми привычных «ошибок».
      */
      if (latest === undefined) {
        log(`${label}: пропущена — в ФГИС ЦС нет опубликованных периодов цен`);
        skipped.push(outcome("в ФГИС ЦС нет опубликованных периодов цен"));
        continue;
      }
      const passport = readZonePassport(options.indexDir, zone.value);
      const state = zoneState(passport, latest.id);
      const why = options.force && state === "FRESH" ? "принудительно (--force)" : ZONE_STATE_TEXT[state];

      if (state === "FRESH" && !options.force) {
        log(`${label}: пропущена — актуальна (период ${String(latest.id)} «${latest.name}»)`);
        skipped.push(outcome(`актуальна, период ${String(latest.id)}`));
        continue;
      }
      if (options.dryRun) {
        log(`${label}: будет собрана — ${why}; последний период ${String(latest.id)} «${latest.name}»`);
        planned.push({ ...outcome(why), state });
        continue;
      }

      log(`${label}: сборка — ${why}; период ${String(latest.id)} «${latest.name}»`);
      const updateDeps: UpdateZoneDeps = {
        indexDir: options.indexDir,
        download: deps.download,
        log: (message) => log(`  ${message}`),
        keepRaw: options.keepRaw,
        ...(options.rawRoot === undefined ? {} : { rawRoot: options.rawRoot }),
        ...(deps.updateDeps ?? {}),
      };
      const stillNeeded = (): boolean =>
        options.force ? true : zoneState(readZonePassport(options.indexDir, zone.value), latest.id) !== "FRESH";
      const result = await updateZoneLocked({ id: zone.value, name: zone.text }, latest, updateDeps, {
        lockPath,
        waitMs: options.lockWaitMinutes * 60_000,
        staleMs: LOCK_STALE_MS,
        by: "build-all-zones",
        stillNeeded,
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.isAlive === undefined ? {} : { isAlive: deps.isAlive }),
      });
      if (result.status === "busy") {
        failed.push(outcome(`замок сборки занят: ${result.holder}`));
        log(`${label}: ОШИБКА — замок сборки занят: ${result.holder}`);
      } else if (result.status === "built-by-other") {
        skipped.push(outcome("пока ждали замок, зону собрал другой процесс"));
        log(`${label}: пропущена — зону собрал другой процесс`);
      } else {
        const { bytes, warnings, notes } = result.result;
        built.push({ ...outcome(`период ${String(latest.id)}, ${mb(bytes)}`), bytes });
        log(`${label}: собрана, ${mb(bytes)}`);
        for (const warning of warnings) log(`  ВНИМАНИЕ: ${warning}`);
        for (const note of notes) log(`  ПРИМЕЧАНИЕ: ${note}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(outcome(message));
      log(`${label}: ОШИБКА — ${message}`);
    }
  }

  const report: BuildAllReport = {
    built,
    skipped,
    failed,
    planned,
    deferred,
    zonesOnDisk: countZoneDirs(options.indexDir),
    bytesOnDisk: directoryBytes(resolve(options.indexDir, "zones")),
    startedAt: new Date(started).toISOString(),
    seconds: Math.round((now() - started) / 1000),
  };

  log("— итог");
  if (options.dryRun) {
    log(`  будет собрано: ${String(planned.length)}, актуальны: ${String(skipped.length)}, ошибки: ${String(failed.length)}`);
    log(`  ожидаемый прирост по диску: около ${mb(planned.length * 21 * 1_048_576)} (зона ≈ 21 МБ), сырьё удаляется после сборки`);
  } else {
    log(`  собрано: ${String(built.length)}, пропущено: ${String(skipped.length)}, ошибки: ${String(failed.length)}, отложено по времени: ${String(deferred.length)}`);
  }
  for (const item of failed) log(`  ошибка: зона ${String(item.priceZoneId)} «${item.zoneName}» — ${item.detail}`);
  for (const item of deferred) log(`  отложена: зона ${String(item.priceZoneId)} «${item.zoneName}»`);
  log(`  на диске: ${String(report.zonesOnDisk)} зон, ${mb(report.bytesOnDisk)} (${options.indexDir}/zones); работа заняла ${String(report.seconds)} с`);
  return report;
}

function parseIds(value: string): number[] {
  const ids = value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) throw new Error("--only ожидает номера зон через запятую.");
  return ids;
}

export function parseBuildAllArgs(argv: readonly string[]): BuildAllOptions {
  let only: number[] | null = null;
  let force = false;
  let dryRun = false;
  let pauseMs = 2_000;
  let keepRaw = false;
  let maxMinutes: number | null = null;
  let lockWaitMinutes = 30;
  let indexDir = DEFAULT_INDEX;
  let rawRoot: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--only" && value !== undefined) {
      only = [...(only ?? []), ...parseIds(value)];
      i += 1;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--keep-raw") {
      keepRaw = true;
    } else if (arg === "--pause" && value !== undefined) {
      pauseMs = Number.parseInt(value, 10);
      if (!Number.isInteger(pauseMs) || pauseMs < 0) throw new Error("--pause ожидает неотрицательное число миллисекунд.");
      i += 1;
    } else if (arg === "--max-minutes" && value !== undefined) {
      maxMinutes = Number.parseInt(value, 10);
      if (!Number.isInteger(maxMinutes) || maxMinutes <= 0) throw new Error("--max-minutes ожидает положительное число минут.");
      i += 1;
    } else if (arg === "--lock-wait-minutes" && value !== undefined) {
      lockWaitMinutes = Number.parseInt(value, 10);
      if (!Number.isInteger(lockWaitMinutes) || lockWaitMinutes < 0) throw new Error("--lock-wait-minutes ожидает неотрицательное число минут.");
      i += 1;
    } else if (arg === "--index" && value !== undefined) {
      indexDir = resolve(value);
      i += 1;
    } else if (arg === "--raw-root" && value !== undefined) {
      rawRoot = resolve(value);
      i += 1;
    } else if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(`Неизвестный флаг ${arg}.`);
    }
  }
  return { only, force, dryRun, pauseMs, keepRaw, maxMinutes, lockWaitMinutes, indexDir, ...(rawRoot === undefined ? {} : { rawRoot }) };
}

async function main(): Promise<void> {
  const options = parseBuildAllArgs(process.argv.slice(2));
  installSignalCleanup();
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  const download = pacedDownloader(createDownloader(log), options.pauseMs);
  const report = await runBuildAll(options, { download, log });
  if (report.failed.length > 0) process.exitCode = 1;
}

// Запуск из командной строки; при импорте (тесты) сборка не стартует.
if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
