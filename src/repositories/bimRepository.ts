import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { BUNDLED_BIM_INDICES, createBimIndexBook, type BimIndexBook } from "@/domain/estimate/bimIndices";
import type { BimIndicesData } from "@/domain/estimate/bimIndicesTypes";
import type { FerLookup } from "@/domain/estimate/customerBimAudit";
import { createNormSearchIndex, type NormSearchIndex } from "@/domain/estimate/matchNorms";
import type { NormRecord } from "@/domain/estimate/types";
import type { FerBook, FerRate, FerResourcePrice, FerTransportPrice, FerUnaccounted } from "@/lib/fsnb/ferXml";
import { resolveIndexDir } from "@/repositories/estimateBaseRepository";

/**
 * Данные метода БИМ на диске: ФЕР-2020 (`data/fsnb/index/fer2020/`, собирает `scripts/fsnb/build-fer2020.ts`) и квартальные
 * индексы Минстроя (встроенные письма III квартала 2026 года плюс файлы `bim-indices/*.json`, которые ночью кладёт
 * `scripts/fsnb/fetch-bim-indices.ts`).
 *
 * ФЕР-2020 грузятся один раз на процесс: 52 тысячи расценок читаются построчно и занимают около 150 МБ вместе с индексом
 * поиска (отдельным от поиска по ГЭСН: у расценок ФЕР свои коды и цены, а книга `ФЕР*` не смешивается с `ГЭСН*`).
 * Нет каталога — расчёт и аудит по БИМ недоступны, и ошибка говорит, чем его собрать.
 */

export const FER2020_DIR_NAME = "fer2020";
export const BIM_BUILD_COMMAND = "npx tsx scripts/fsnb/build-fer2020.ts";

export class FerBaseUnavailableError extends Error {
  constructor(message: string, readonly indexDir: string) {
    super(message);
    this.name = "FerBaseUnavailableError";
  }
}

export interface FerBase {
  readonly rates: ReadonlyMap<string, FerRate>;
  readonly materials: ReadonlyMap<string, FerResourcePrice>;
  readonly transport: ReadonlyMap<string, FerTransportPrice>;
  /** Поиск расценки по наименованию и шифру — тот же `findNorms`, что у ГЭСН, но по книгам ФЕР. */
  readonly searchIndex: NormSearchIndex;
  readonly info: { readonly builtAt: string; readonly source: string; readonly rates: number; readonly priceLevel: string };
}

export const ferKey = (book: string, code: string): string => `${book}|${code}`;

/** Расценка ФЕР как норма для поиска: цены остаются в `rates`, поиску нужны только имена. */
export function ferRateAsNorm(rate: FerRate): NormRecord {
  return {
    code: rate.code,
    tableCode: rate.table,
    fullName: rate.name,
    endName: rate.endName,
    unit: rate.unit,
    collectionCode: rate.collectionCode,
    collectionName: rate.collectionName,
    sectionName: "",
    subsectionName: "",
    baseType: rate.book,
    content: [],
    resources: [],
    overheadRef: rate.overheadRef,
    profitRef: rate.profitRef,
  };
}

interface RawRate {
  code?: unknown;
  book?: unknown;
  table?: unknown;
  name?: unknown;
  endName?: unknown;
  unit?: unknown;
  collectionCode?: unknown;
  collectionName?: unknown;
  cost?: unknown;
  wage?: unknown;
  machines?: unknown;
  machinistWage?: unknown;
  materials?: unknown;
  labourHours?: unknown;
  machinistHours?: unknown;
  overheadRef?: unknown;
  profitRef?: unknown;
  unaccounted?: unknown;
  correction?: unknown;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const BOOKS: ReadonlySet<string> = new Set(["ФЕР", "ФЕРм", "ФЕРр", "ФЕРп", "ФЕРмр"]);

/** Запись `rates.jsonl` → расценка; повреждённая строка — отказ, а не пропуск. */
export function parseFerRate(value: unknown, line: number): FerRate {
  const raw = value as RawRate;
  if (typeof raw !== "object" || raw === null || !BOOKS.has(text(raw.book)) || text(raw.code) === "") {
    throw new Error(`rates.jsonl, строка ${String(line)}: нет книги или шифра расценки`);
  }
  const correction = raw.correction as { from?: unknown; to?: unknown; coeff?: unknown } | undefined;
  return {
    code: text(raw.code),
    book: text(raw.book) as FerBook,
    table: text(raw.table),
    name: text(raw.name),
    endName: text(raw.endName),
    unit: text(raw.unit),
    collectionCode: text(raw.collectionCode),
    collectionName: text(raw.collectionName),
    cost: num(raw.cost),
    wage: num(raw.wage),
    machines: num(raw.machines),
    machinistWage: num(raw.machinistWage),
    materials: num(raw.materials),
    labourHours: numOrNull(raw.labourHours),
    machinistHours: numOrNull(raw.machinistHours),
    overheadRef: text(raw.overheadRef) === "" ? null : text(raw.overheadRef),
    profitRef: text(raw.profitRef) === "" ? null : text(raw.profitRef),
    unaccounted: Array.isArray(raw.unaccounted) ? (raw.unaccounted as FerUnaccounted[]) : [],
    correction:
      correction !== undefined && correction !== null && typeof correction.coeff === "number"
        ? { from: text(correction.from), to: text(correction.to), coeff: correction.coeff }
        : null,
  };
}

async function readLines<T>(path: string, parse: (value: unknown, line: number) => T): Promise<T[]> {
  const result: T[] = [];
  let number = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    number += 1;
    if (line.length === 0) continue;
    result.push(parse(JSON.parse(line) as unknown, number));
  }
  return result;
}

/** Пустой справочник ФЕР: для тестов, где нужна только часть данных. */
export function createFerBase(rates: readonly FerRate[], materials: readonly FerResourcePrice[] = [], transport: readonly FerTransportPrice[] = []): FerBase {
  return {
    rates: new Map(rates.map((rate) => [ferKey(rate.book, rate.code), rate] as const)),
    materials: new Map(materials.map((item) => [item.code, item] as const)),
    transport: new Map(transport.map((item) => [item.code, item] as const)),
    searchIndex: createNormSearchIndex(rates.map(ferRateAsNorm)),
    info: { builtAt: "", source: "", rates: rates.length, priceLevel: "01.01.2000" },
  };
}

const cache = new Map<string, Promise<FerBase>>();

/** Загрузка ФЕР-2020 с диска; кэшируется на процесс по каталогу индекса. */
export function loadFerBase(options: { readonly indexDir?: string } = {}): Promise<FerBase> {
  const indexDir = resolveIndexDir(options.indexDir);
  const cached = cache.get(indexDir);
  if (cached !== undefined) return cached;
  const loading = readFerBase(indexDir);
  cache.set(indexDir, loading);
  loading.catch(() => cache.delete(indexDir));
  return loading;
}

async function readFerBase(indexDir: string): Promise<FerBase> {
  const dir = resolve(indexDir, FER2020_DIR_NAME);
  if (!existsSync(resolve(dir, "rates.jsonl"))) {
    throw new FerBaseUnavailableError(
      `ФЕР-2020 не собраны: нет ${resolve(dir, "rates.jsonl")}. Соберите на сервере командой ${BIM_BUILD_COMMAND} (скачает архив ФГИС ЦС, ~3 с).`,
      indexDir,
    );
  }
  const rates = await readLines(resolve(dir, "rates.jsonl"), parseFerRate);
  const optional = async <T>(file: string, parse: (value: unknown) => T): Promise<T[]> =>
    existsSync(resolve(dir, file)) ? readLines(resolve(dir, file), (value) => parse(value)) : [];
  const materials = await optional("materials.jsonl", (value) => value as FerResourcePrice);
  const transport = await optional("transport.jsonl", (value) => value as FerTransportPrice);
  const base = createFerBase(rates, materials, transport);
  let info = base.info;
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, "build-info.json"), "utf8")) as { builtAt?: unknown; source?: unknown; priceLevel?: unknown };
    info = { builtAt: text(parsed.builtAt), source: text(parsed.source), rates: rates.length, priceLevel: text(parsed.priceLevel) || "01.01.2000" };
  } catch {
    // Паспорта нет — справочник рабочий, реквизиты неизвестны.
  }
  return { ...base, info };
}

/** Что нужно аудиту от базы: расценка, материал, перевозка по коду. */
export function ferLookupOf(base: FerBase): FerLookup {
  return {
    rate: (book, code) => base.rates.get(ferKey(book, code)) ?? null,
    material: (code) => base.materials.get(code) ?? null,
    transport: (code) => base.transport.get(code) ?? null,
  };
}

/** Квартальные справочники индексов: встроенные и серверные; серверный файл квартала заменяет встроенный. */
export function loadBimIndexBook(options: { readonly indexDir?: string } = {}): BimIndexBook {
  const indexDir = resolveIndexDir(options.indexDir);
  const dir = resolve(indexDir, "bim-indices");
  const datasets: BimIndicesData[] = [...BUNDLED_BIM_INDICES];
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((name) => /^bim-indices-\d{4}q[1-4]\.json$/.test(name)).sort()) {
      try {
        const parsed = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as BimIndicesData;
        if (parsed.version === 1 && Array.isArray(parsed.elements) && parsed.quarter !== undefined) datasets.push(parsed);
      } catch {
        // Повреждённый файл квартала не должен ломать аудит: остаются встроенные письма.
      }
    }
  }
  return createBimIndexBook(datasets);
}

export function clearFerBaseCache(): void {
  cache.clear();
}
