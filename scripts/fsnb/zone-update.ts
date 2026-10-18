import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { ApiPeriod } from "../../src/lib/fsnb/fgisZoneApi";
import { acquireZoneBuildLock, describeLockOwner, inspectZoneBuildLock, type LockHandle } from "../../src/lib/fsnb/zoneBuildLock";
import { buildZone, ZONE_BUILD_VERSION, type BuildZoneOptions, type BuildZoneResult } from "./build-zone";
import { fetchZoneRaw, type Downloader, type FetchedZone } from "./fetch-zone";

/**
 * Обновление одной ценовой зоны: скачать за последний период, собрать, подменить каталог.
 *
 * Общее для `build-all-zones.ts` (все зоны, ночью) и сборки по требованию (воркер собирает зону,
 * которой нет на диске, перед расчётом). Что важно:
 *
 * - Атомарность. Зона собирается не на месте, а во временном каталоге рядом
 *   (`zones/.build-<id>-<pid>`), и только готовая меняет каталог `zones/<id>` переименованием.
 *   Расчёт, читающий зону в этот момент, видит либо прежнюю сборку целиком, либо новую целиком,
 *   а не половину файлов: каталоги с точкой в имени и без паспорта репозиторий за зону не
 *   считает (`readBuiltZoneDirs` берёт только имена из цифр). Прежняя сборка переименовывается
 *   в `.old-…` и удаляется после замены; между двумя переименованиями каталога зоны нет ровно
 *   на время одного системного вызова — расчёт в это окно получит «зона не собрана», а не
 *   полусобранную.
 * - Один за раз. Сборка идёт под замком-файлом (`zoneBuildLock.ts`): ночное обновление и сборка
 *   по требованию не пересекаются.
 * - Сырьё (20 МБ на зону) после удачной сборки удаляется: 157 зон сырья заняли бы ещё 3 ГБ.
 *   Оставить — `keepRaw`.
 */

export type ZoneState =
  /** Зоны на диске нет. */
  | "MISSING"
  /** Период в паспорте не равен последнему опубликованному. */
  | "STALE_PERIOD"
  /** Период тот же, но зона собрана старым форматом (без цен перевозки и погрузки). */
  | "OLD_FORMAT"
  /** Перевозка должна была быть, но при прошлой сборке не скачалась: повторяем попытку. */
  | "TRANSPORT_RETRY"
  | "FRESH";

export interface ZonePassport {
  readonly priceZoneId: number;
  readonly periodId: number | null;
  readonly buildVersion: number;
  readonly transportAuto: boolean | null;
  readonly builtAt: string;
}

/** Паспорт зоны из каталога сборки; null — паспорта нет, он нечитаем или назван чужой зоной. */
export function readZonePassportAt(dir: string, priceZoneId: number): ZonePassport | null {
  try {
    const value = JSON.parse(readFileSync(resolve(dir, "zone.json"), "utf8")) as Record<string, unknown>;
    if (value.priceZoneId !== priceZoneId) return null;
    return {
      priceZoneId,
      periodId: typeof value.periodId === "number" ? value.periodId : null,
      buildVersion: typeof value.buildVersion === "number" ? value.buildVersion : 1,
      transportAuto: typeof value.transportAuto === "boolean" ? value.transportAuto : null,
      builtAt: typeof value.builtAt === "string" ? value.builtAt : "",
    };
  } catch {
    return null;
  }
}

/** Паспорт собранной зоны `zones/<id>`; null — зоны нет. */
export function readZonePassport(indexDir: string, priceZoneId: number): ZonePassport | null {
  return readZonePassportAt(resolve(indexDir, "zones", String(priceZoneId)), priceZoneId);
}

/** Что с зоной относительно последнего периода. `latestPeriodId` null — период неизвестен: сверять не с чем. */
export function zoneState(passport: ZonePassport | null, latestPeriodId: number | null): ZoneState {
  if (passport === null) return "MISSING";
  if (latestPeriodId !== null && passport.periodId !== latestPeriodId) return "STALE_PERIOD";
  if (passport.buildVersion < ZONE_BUILD_VERSION) return "OLD_FORMAT";
  if (passport.transportAuto === false) return "TRANSPORT_RETRY";
  return "FRESH";
}

export const ZONE_STATE_TEXT: Readonly<Record<ZoneState, string>> = {
  MISSING: "не собрана",
  STALE_PERIOD: "период устарел",
  OLD_FORMAT: "собрана прежним форматом (без перевозки и погрузки)",
  TRANSPORT_RETRY: "прошлая сборка без цен перевозки — повтор",
  FRESH: "актуальна",
};

/** Размер каталога на диске, байт (сумма файлов). Нет каталога — 0. */
export function directoryBytes(path: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = resolve(path, name);
    try {
      const info = statSync(full);
      total += info.isDirectory() ? directoryBytes(full) : info.size;
    } catch {
      // файл исчез во время обхода
    }
  }
  return total;
}

/** Обёртка скачивания с паузой: следующий запрос не раньше, чем через `pauseMs` после завершения предыдущего. */
export function pacedDownloader(inner: Downloader, pauseMs: number, sleep: (ms: number) => Promise<void> = defaultSleep): Downloader {
  let readyAt = 0;
  return async (url, kind, what) => {
    const wait = readyAt - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await inner(url, kind, what);
    } finally {
      readyAt = Date.now() + pauseMs;
    }
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export interface UpdateZoneDeps {
  readonly indexDir: string;
  /** Каталог сырья: по умолчанию `data/fsnb/raw/zones` корня проекта. */
  readonly rawRoot?: string;
  readonly download: Downloader;
  readonly log: (message: string) => void;
  readonly keepRaw?: boolean;
  /** Подмены для тестов: сборка и скачивание. */
  readonly build?: (options: BuildZoneOptions, log: (message: string) => void) => Promise<BuildZoneResult>;
  readonly fetchRaw?: typeof fetchZoneRaw;
}

export interface UpdateZoneResult {
  readonly priceZoneId: number;
  readonly periodId: number;
  readonly bytes: number;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

/** Скачивает, собирает во временный каталог и подменяет каталог зоны. Замок — на вызывающем коде. */
export async function updateZone(zone: { readonly id: number; readonly name: string }, latest: ApiPeriod, deps: UpdateZoneDeps): Promise<UpdateZoneResult> {
  const { indexDir, log } = deps;
  const zonesDir = resolve(indexDir, "zones");
  mkdirSync(zonesDir, { recursive: true });
  const target = resolve(zonesDir, String(zone.id));
  const tmp = resolve(zonesDir, `.build-${String(zone.id)}-${String(process.pid)}`);
  const old = resolve(zonesDir, `.old-${String(zone.id)}-${String(process.pid)}`);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });

  const fetchRaw = deps.fetchRaw ?? fetchZoneRaw;
  const build = deps.build ?? buildZone;

  let fetched: FetchedZone;
  try {
    fetched = await fetchRaw(zone.id, zone.name, { download: deps.download, log, periodChoice: latest, ...(deps.rawRoot === undefined ? {} : { rawRoot: deps.rawRoot }) });
  } catch (error) {
    throw new Error(`скачивание: ${error instanceof Error ? error.message : String(error)}`);
  }

  let result: BuildZoneResult;
  try {
    result = await build({ zone: zone.id, period: latest.id, raw: fetched.dir, out: tmp, index: indexDir, keepAll: false }, log);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`сборка: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Паспорт обязан называть ту зону и тот период, которые собирали: иначе подменять каталог нечем.
  const passport = readZonePassportAt(tmp, zone.id);
  if (passport === null || (passport.periodId !== null && passport.periodId !== latest.id)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`сборка: в собранном каталоге нет паспорта зоны ${String(zone.id)} за период ${String(latest.id)}`);
  }

  const hadOld = existsSync(target);
  try {
    if (hadOld) renameSync(target, old);
    renameSync(tmp, target);
  } catch (error) {
    // Вернуть прежнюю сборку, если успели её отодвинуть.
    if (hadOld && !existsSync(target) && existsSync(old)) renameSync(old, target);
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`замена каталога зоны: ${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(old, { recursive: true, force: true });
  if (deps.keepRaw !== true) rmSync(fetched.dir, { recursive: true, force: true });

  const notes = Array.isArray(result.zoneDocument.notes) ? (result.zoneDocument.notes as string[]) : [];
  return { priceZoneId: zone.id, periodId: latest.id, bytes: directoryBytes(target), warnings: fetched.warnings, notes };
}

/** Путь замка сборки зон по умолчанию: `data/fsnb/zones-build.lock` корня проекта. */
export function defaultLockPath(root: string): string {
  return resolve(root, "data/fsnb/zones-build.lock");
}

/** Что снять при внезапной остановке (SIGTERM): замок и временные каталоги этого процесса. */
const activeCleanups = new Set<() => void>();

/**
 * Снимает замки и временные каталоги при SIGTERM/SIGINT (таймаут сборки по требованию, остановка
 * службы) и завершает процесс. Без этого оборванная сборка оставила бы замок до признания его
 * брошенным и недособранный временный каталог.
 */
export function installSignalCleanup(): void {
  const stop = (signal: NodeJS.Signals): void => {
    for (const cleanup of [...activeCleanups]) {
      try {
        cleanup();
      } catch {
        // остановка важнее уборки
      }
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

function removeOwnTemporaryDirs(indexDir: string): void {
  const zonesDir = resolve(indexDir, "zones");
  let names: string[];
  try {
    names = readdirSync(zonesDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (new RegExp(`^\\.(?:build|old)-\\d+-${String(process.pid)}$`).test(name)) {
      rmSync(resolve(zonesDir, name), { recursive: true, force: true });
    }
  }
}

export type LockedUpdate =
  | { readonly status: "built"; readonly result: UpdateZoneResult }
  /** Пока ждали замок, зону собрал кто-то другой. */
  | { readonly status: "built-by-other" }
  | { readonly status: "busy"; readonly holder: string };

export interface LockedUpdateOptions {
  readonly lockPath: string;
  readonly waitMs: number;
  readonly staleMs: number;
  readonly by: string;
  /** Актуальна ли зона: проверяется после взятия замка, чтобы не собирать то, что уже собрано. */
  readonly stillNeeded: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly isAlive?: (pid: number) => boolean;
}

/** Берёт замок (ждёт, сколько разрешено), собирает зону и снимает замок. */
export async function updateZoneLocked(
  zone: { readonly id: number; readonly name: string },
  latest: ApiPeriod,
  deps: UpdateZoneDeps,
  options: LockedUpdateOptions,
): Promise<LockedUpdate> {
  const handle: LockHandle | null = await acquireZoneBuildLock({
    path: options.lockPath,
    waitMs: options.waitMs,
    staleMs: options.staleMs,
    zoneId: zone.id,
    by: options.by,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
  });
  if (handle === null) {
    const holder = inspectZoneBuildLock(options.lockPath);
    return { status: "busy", holder: holder === null ? "неизвестный процесс" : describeLockOwner(holder) };
  }
  const cleanup = (): void => {
    handle.release();
    removeOwnTemporaryDirs(deps.indexDir);
  };
  activeCleanups.add(cleanup);
  try {
    if (!options.stillNeeded()) return { status: "built-by-other" };
    return { status: "built", result: await updateZone(zone, latest, deps) };
  } finally {
    activeCleanups.delete(cleanup);
    handle.release();
  }
}
