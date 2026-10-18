import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertPayload,
  collectRegistryPages,
  parseApiPeriods,
  parseApiZones,
  periodsUrl,
  pickPeriod,
  selectSubjectZones,
  serviceFileUrls,
  wagesPageUrl,
  zoneFileUrls,
  zonesUrl,
  type ApiPeriod,
  type ApiZone,
  type PayloadKind,
} from "../../src/lib/fsnb/fgisZoneApi";

/**
 * Скачивание сырья ценовых зон ФГИС ЦС. Только скачивание: сборка — `build-zone.ts`.
 *
 * Данные открыты без авторизации, но только с российского IP: с машины
 * разработчика за границей будет таймаут, с сервера всё работает. Запросы идут
 * строго по одному, с таймаутом и двумя повторами — это публичный государственный
 * сервис, а не повод его нагружать.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/fetch-zone.ts --zone 236 [--zone 237 …] [--period 427|latest]
 *   npx tsx scripts/fsnb/fetch-zone.ts --subject "Республика Бурятия"
 *
 * Результат: data/fsnb/raw/zones/<id>/<periodId>/{fscsr.xlsx, wages.json,
 * split.xlsx, transport-auto.xlsx, load-auto.xlsx, meta.json}.
 *
 * Перевозка и погрузка (`transport-auto.xlsx`, `load-auto.xlsx`) — необязательные
 * файлы: их недоступность не отменяет зону, а попадает в `meta.json` как
 * предупреждение, и расчёт работает с ценой заказчика, как раньше.
 */

const ROOT = resolve(__dirname, "../..");
const TIMEOUT_MS = 180_000;
const RETRIES = 2;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "*/*",
};

/** Скачивание одного ответа: подменяется в тестах и обёртывается паузой в `build-all-zones`. */
export type Downloader = (url: string, kind: PayloadKind | "json", what: string) => Promise<Uint8Array>;

function defaultLog(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Настоящее скачивание: таймаут, повторы, проверка, что пришёл файл, а не страница ошибки. */
export function createDownloader(log: (message: string) => void = defaultLog): Downloader {
  return async (url, kind, what) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) throw new Error(`${what}: ФГИС ЦС ответил ${String(response.status)}.`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assertPayload(kind, bytes, response.headers.get("content-type"), what);
        return bytes;
      } catch (error) {
        lastError = error;
        if (attempt < RETRIES) {
          log(`  повтор ${String(attempt + 1)} из ${String(RETRIES)}: ${error instanceof Error ? error.message : String(error)}`);
          await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)));
        }
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${what}: не удалось скачать за ${String(RETRIES + 1)} попытки. ${reason} Если вы не в России, запускайте на сервере.`);
  };
}

/** Справочник ценовых зон ФГИС ЦС. */
export async function fetchZoneDirectory(download: Downloader): Promise<ApiZone[]> {
  return parseApiZones(JSON.parse(Buffer.from(await download(zonesUrl(), "json", "Справочник ценовых зон")).toString("utf8")) as unknown);
}

/** Периоды зоны, свежий первым. */
export async function fetchZonePeriods(download: Downloader, priceZoneId: number): Promise<ApiPeriod[]> {
  return parseApiPeriods(
    JSON.parse(Buffer.from(await download(periodsUrl(priceZoneId), "json", `Периоды зоны ${String(priceZoneId)}`)).toString("utf8")) as unknown,
  );
}

export interface FetchedZone {
  readonly priceZoneId: number;
  readonly zoneName: string;
  readonly periodId: number;
  readonly periodName: string;
  /** Каталог сырья: `<rawRoot>/<id>/<periodId>`. */
  readonly dir: string;
  /** Необязательные файлы, которые скачать не удалось. */
  readonly warnings: readonly string[];
}

export interface FetchZoneOptions {
  readonly download: Downloader;
  readonly log?: (message: string) => void;
  /** Каталог сырья зон; по умолчанию `data/fsnb/raw/zones`. */
  readonly rawRoot?: string;
  /** Период, уже выбранный вызывающим кодом (например, последний); иначе берётся из запроса `period`. */
  readonly periodChoice?: ApiPeriod;
  readonly period?: number | "latest";
}

/** Скачивает сырьё одной зоны за один период. */
export async function fetchZoneRaw(id: number, zoneName: string, options: FetchZoneOptions): Promise<FetchedZone> {
  const log = options.log ?? defaultLog;
  const { download } = options;
  const period = options.periodChoice ?? pickPeriod(await fetchZonePeriods(download, id), options.period ?? "latest");
  const urls = zoneFileUrls(id, period.id);
  const services = serviceFileUrls(id, period.id);
  const dir = resolve(options.rawRoot ?? resolve(ROOT, "data/fsnb/raw/zones"), String(id), String(period.id));
  mkdirSync(dir, { recursive: true });

  const files: Record<string, { bytes: number }> = {};
  const warnings: string[] = [];
  const targets = [
    ["fscsr", "fscsr.xlsx", "xlsx", "ФСЦСР", true],
    ["wages", "wages.json", "json", "Реестр ставок оплаты труда", true],
    ["split", "split.xlsx", "xlsx", "Сплит-форма", true],
    ["transport", "transport-auto.xlsx", "xlsx", "Цены перевозки автотранспортом", false],
    ["load", "load-auto.xlsx", "xlsx", "Цены погрузочно-разгрузочных работ", false],
  ] as const;
  for (const [key, file, kind, label, required] of targets) {
    let bytes: Uint8Array;
    try {
      if (key === "wages") {
        // Реестр листается постранично (page=1,2,…, по 25 записей): одна страница — это
        // только разряды 1,0–3,4, а без остальных нет ни рабочих выше 3,4, ни специалистов.
        const registry = await collectRegistryPages(async (page) =>
          JSON.parse(
            Buffer.from(await download(wagesPageUrl(id, period.id, page), "json", `${label}, зона ${String(id)}, стр. ${String(page)}`)).toString("utf8"),
          ) as unknown,
        );
        log(`  реестр ставок: ${String(registry.items.length)} из ${String(registry.total)} записей, страниц ${String(registry.pages)}`);
        bytes = new TextEncoder().encode(JSON.stringify({ total: registry.total, items: registry.items }));
      } else {
        const url = key === "transport" ? services.transport : key === "load" ? services.load : urls[key];
        bytes = await download(url, kind, `${label}, зона ${String(id)}`);
      }
    } catch (error) {
      if (required) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${file}: ${reason}`);
      log(`  ВНИМАНИЕ: ${file} не скачан, зона соберётся без него: ${reason}`);
      continue;
    }
    writeFileSync(resolve(dir, file), bytes);
    files[file] = { bytes: bytes.length };
    log(`  ${file}: ${String(bytes.length)} байт`);
  }
  writeFileSync(
    resolve(dir, "meta.json"),
    `${JSON.stringify(
      {
        priceZoneId: id,
        zoneName,
        periodId: period.id,
        periodName: period.name,
        urls: { ...urls, transport: services.transport, load: services.load },
        files,
        ...(warnings.length === 0 ? {} : { warnings }),
        fetchedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  log(`  период ${String(period.id)} «${period.name}» → ${dir}`);
  return { priceZoneId: id, zoneName, periodId: period.id, periodName: period.name, dir, warnings };
}

interface Options {
  readonly zones: readonly number[];
  readonly subject: string | null;
  readonly period: number | "latest";
}

function parseArgs(argv: readonly string[]): Options {
  const zones: number[] = [];
  let subject: string | null = null;
  let period: number | "latest" = "latest";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--zone" && value !== undefined) {
      zones.push(Number.parseInt(value, 10));
      i += 1;
    } else if (arg === "--subject" && value !== undefined) {
      subject = value;
      i += 1;
    } else if (arg === "--period" && value !== undefined) {
      period = value === "latest" ? "latest" : Number.parseInt(value, 10);
      i += 1;
    }
  }
  if (zones.some((zone) => !Number.isInteger(zone) || zone <= 0)) throw new Error("--zone ожидает числовой идентификатор зоны.");
  if (period !== "latest" && !Number.isInteger(period)) throw new Error("--period ожидает число или latest.");
  if (zones.length === 0 && subject === null) {
    throw new Error('Укажите --zone <id> (можно несколько) или --subject "Республика Бурятия".');
  }
  return { zones, subject, period };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const download = createDownloader();

  defaultLog("— справочник зон");
  const allZones = await fetchZoneDirectory(download);
  const names = new Map(allZones.map((zone) => [zone.value, zone.text] as const));

  const wanted = new Map<number, string>();
  if (options.subject !== null) {
    const found = selectSubjectZones(allZones, options.subject);
    if (found.length === 0) throw new Error(`В справочнике ФГИС ЦС нет зон субъекта «${options.subject}».`);
    for (const zone of found) wanted.set(zone.value, zone.text);
  }
  for (const id of options.zones) {
    const name = names.get(id);
    if (name === undefined) throw new Error(`Зоны ${String(id)} нет в справочнике ФГИС ЦС.`);
    wanted.set(id, name);
  }

  for (const [id, zoneName] of wanted) {
    defaultLog(`— зона ${String(id)} «${zoneName}»`);
    await fetchZoneRaw(id, zoneName, { download, period: options.period });
  }
}

// Запуск из командной строки; при импорте (тесты, build-all-zones) скачивание не стартует.
if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
