import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertPayload, parseApiZones, selectPricedZones, zonesUrl } from "@/lib/fsnb/fgisZoneApi";
import { listBuiltZones, resolveIndexDir } from "@/repositories/estimateBaseRepository";

/**
 * Сборка ценовой зоны по требованию: расчёт для зоны, которой нет на диске.
 *
 * Раньше такой расчёт падал с «Цен по зоне ещё нет, соберите её командами…». Теперь воркер
 * собирает зону сам (скачать у ФГИС ЦС и собрать — `scripts/fsnb/build-all-zones.ts --only <id>`) и
 * считает дальше. Сборка идёт отдельным процессом, а не внутри воркера:
 *  - процессор и ~400 МБ памяти на минуты не должны стоять в одном процессе с расчётом и
 *    очередью заданий, на сервере в 4 ГБ они делят память с приложением;
 *  - таймаут настоящий: процесс можно остановить (SIGTERM, затем SIGKILL), а синхронный разбор
 *    xlsx внутри воркера остановить нельзя;
 *  - замок-файл (`data/fsnb/zones-build.lock`) берёт сам дочерний процесс, поэтому одна сборка
 *    за раз — и между воркером и ночным обновлением.
 *
 * Два воркера или два задания, ждущие одну и ту же зону, не запускают две сборки: внутри процесса
 * ожидания склеиваются, между процессами решает замок (второй найдёт зону уже собранной).
 */

/** Сколько ждать сборку зоны целиком: скачивание ~20 МБ с паузами, разбор, запись. */
export const ZONE_BUILD_TIMEOUT_MS = 20 * 60_000;

export interface ZoneBuildContext {
  readonly timeoutMs: number;
  /** Срабатывает по таймауту: исполнитель обязан остановить сборку. */
  readonly signal: AbortSignal;
  readonly log: (message: string) => void;
}

/** Запуск сборки зоны. Завершился без ошибки — зона собрана (проверяет вызывающий код). */
export type ZoneBuildRunner = (priceZoneId: number, context: ZoneBuildContext) => Promise<void>;

export interface EnsureZoneDeps {
  readonly indexDir?: string;
  readonly run?: ZoneBuildRunner;
  /** Есть ли зона на диске; по умолчанию — `listBuiltZones`. */
  readonly isBuilt?: (priceZoneId: number) => Promise<boolean>;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

/** Зона не собрана и собрать её не удалось: причина — словами, для журнала задания и экрана. */
export class ZoneBuildError extends Error {
  constructor(
    message: string,
    readonly priceZoneId: number,
  ) {
    super(message);
    this.name = "ZoneBuildError";
  }
}

const inflight = new Map<string, Promise<"BUILT">>();

/**
 * Зона собрана на диске: уже была или собрана сейчас. Не смогли — `ZoneBuildError`.
 * Параллельные вызовы одной зоны делят одну сборку.
 */
export async function ensureZoneBuilt(priceZoneId: number, deps: EnsureZoneDeps = {}): Promise<"ALREADY" | "BUILT"> {
  const indexDir = resolveIndexDir(deps.indexDir);
  const isBuilt =
    deps.isBuilt ??
    (async (id: number): Promise<boolean> => (await listBuiltZones({ indexDir })).some((zone) => zone.priceZoneId === id));
  if (await isBuilt(priceZoneId)) return "ALREADY";

  const key = `${indexDir}|${String(priceZoneId)}`;
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;

  const log = deps.log ?? ((): void => undefined);
  const timeoutMs = deps.timeoutMs ?? ZONE_BUILD_TIMEOUT_MS;
  const run = deps.run ?? childProcessZoneBuilder({ indexDir });

  const building = (async (): Promise<"BUILT"> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    log(`зона ${String(priceZoneId)} не собрана: собираю по требованию (до ${String(Math.round(timeoutMs / 60_000))} мин)`);
    try {
      await run(priceZoneId, { timeoutMs, signal: controller.signal, log });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ZoneBuildError(
        timedOut
          ? `Сборка цен зоны ${String(priceZoneId)} не уложилась в ${String(Math.round(timeoutMs / 60_000))} мин и остановлена. Повторите расчёт позже или соберите зону вручную: npx tsx scripts/fsnb/build-all-zones.ts --only ${String(priceZoneId)}.`
          : `Не удалось собрать цены зоны ${String(priceZoneId)}: ${reason}`,
        priceZoneId,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!(await isBuilt(priceZoneId))) {
      throw new ZoneBuildError(`Сборка цен зоны ${String(priceZoneId)} завершилась, но зоны на диске нет: проверьте журнал сборки.`, priceZoneId);
    }
    log(`зона ${String(priceZoneId)} собрана`);
    return "BUILT";
  })();
  inflight.set(key, building);
  try {
    return await building;
  } finally {
    inflight.delete(key);
  }
}

/** Что показывать из вывода дочернего процесса при ошибке: хвост журнала. */
function tail(lines: readonly string[], count: number): string {
  return lines.slice(-count).join(" | ");
}

export interface ChildRunnerOptions {
  readonly indexDir: string;
  /** Корень проекта (там `scripts/` и `node_modules/`); по умолчанию — рабочий каталог процесса. */
  readonly root?: string;
  /** Пауза между запросами к ФГИС ЦС, мс. */
  readonly pauseMs?: number;
}

/** Сборка зоны дочерним процессом: `tsx scripts/fsnb/build-all-zones.ts --only <id>`. */
export function childProcessZoneBuilder(options: ChildRunnerOptions): ZoneBuildRunner {
  const root = options.root ?? process.cwd();
  return (priceZoneId, context) =>
    new Promise<void>((done, fail) => {
      const args = [
        resolve(root, "scripts/fsnb/build-all-zones.ts"),
        "--only",
        String(priceZoneId),
        "--index",
        options.indexDir,
        "--pause",
        String(options.pauseMs ?? 1_500),
        // Замок занят другой сборкой — ждём её, пока не истёк общий таймаут.
        "--lock-wait-minutes",
        String(Math.max(1, Math.floor(context.timeoutMs / 60_000) - 2)),
      ];
      const child = spawn(resolve(root, "node_modules/.bin/tsx"), args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env });
      const output: string[] = [];
      const collect = (chunk: Buffer): void => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim() === "") continue;
          output.push(line.trim());
          context.log(`  сборка зоны ${String(priceZoneId)}: ${line.trim()}`);
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const stop = (): void => {
        child.kill("SIGTERM");
        // Не отозвался за 10 с — убиваем: замок снимет следующий, признав владельца мёртвым.
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      };
      if (context.signal.aborted) stop();
      else context.signal.addEventListener("abort", stop, { once: true });

      child.once("error", (error) => fail(error));
      child.once("close", (code, signal) => {
        context.signal.removeEventListener("abort", stop);
        if (code === 0) done();
        else fail(new Error(`сборка завершилась с кодом ${String(code ?? signal)}: ${tail(output, 4)}`));
      });
    });
}

/* ------------------------------ Справочник зон ФГИС ЦС ------------------------------ */

export interface ZoneDirectoryEntry {
  readonly priceZoneId: number;
  readonly zoneName: string;
}

/** Справочник зон, который записал `build-all-zones.ts` (`zones-directory.json`); null — файла нет. */
export async function readZoneDirectoryFile(indexDir?: string): Promise<ZoneDirectoryEntry[] | null> {
  try {
    const value = JSON.parse(await readFile(resolve(resolveIndexDir(indexDir), "zones-directory.json"), "utf8")) as { zones?: unknown };
    const zones = selectPricedZones(parseApiZones(value.zones));
    return zones.map((zone) => ({ priceZoneId: zone.value, zoneName: zone.text }));
  } catch {
    return null;
  }
}

/** Справочник зон ФГИС ЦС напрямую: нужен, пока `build-all-zones.ts` ещё ни разу не запускался. */
export async function fetchZoneDirectoryLive(fetchImpl: typeof fetch = fetch): Promise<ZoneDirectoryEntry[]> {
  const response = await fetchImpl(zonesUrl(), {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "*/*" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Справочник зон: ФГИС ЦС ответил ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertPayload("json", bytes, response.headers.get("content-type"), "Справочник ценовых зон");
  return selectPricedZones(parseApiZones(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown)).map((zone) => ({
    priceZoneId: zone.value,
    zoneName: zone.text,
  }));
}

/**
 * Справочник для выбора зоны: из файла, иначе напрямую из ФГИС ЦС. Не получилось — null, и выбор
 * зоны работает как раньше (без сборки по требованию): пустой справочник не повод ронять расчёт
 * для уже собранных зон.
 */
export async function loadZoneDirectory(
  deps: { readonly indexDir?: string; readonly fetchLive?: () => Promise<ZoneDirectoryEntry[]> } = {},
): Promise<ZoneDirectoryEntry[] | null> {
  const fromFile = await readZoneDirectoryFile(deps.indexDir);
  if (fromFile !== null && fromFile.length > 0) return fromFile;
  try {
    return await (deps.fetchLive ?? (() => fetchZoneDirectoryLive()))();
  } catch {
    return null;
  }
}
