import { z } from "zod";

import { scrubPii, type ScrubOptions, type ScrubStats } from "@/domain/companyFacts/scrubPii";
import {
  FACTS_VERSION,
  emptyFacts,
  type CompanyFacts,
  type FactContract,
  type FactCustomerType,
  type FactEquipment,
  type FactLaw,
  type FactLicense,
  type FactPrice,
  type FactSro,
  type FactSroKind,
  type FactStaff,
  type FactWorkType,
} from "@/domain/companyFacts/types";
import { extractLlmJson } from "@/lib/llmJson";

/**
 * Разбор и проверка фактов о компании.
 *
 * Два входа, одна проверка:
 *  - ответ модели (`parseFactsResponse`): JSON в snake_case, как его просит промпт;
 *  - факты из анкеты (`sanitizeFacts`): camelCase, как они хранятся. Анкета приходит с устройства человека, то есть её
 *    содержимое сервер доверием не пользуется: перед отправкой в модель (сверка с закупкой) факты проходят ту же проверку.
 *
 * Проверка — защита «в глубину» от утечки личного. Скруббер чистит документы до модели, но модель могла выдать то, чего
 * в очищенном тексте не было (домыслить имя, склеить), а человек мог вписать в факты что угодно. Поэтому каждая строка
 * проходит скруббер ещё раз: строка с ПД в основном поле (предмет контракта, название вида работ) выбрасывает всю запись,
 * в необязательном (заказчик, регион, примечание) — только это поле. Заказчик-человек (ИП, гражданин) не хранится вовсе.
 *
 * Битая запись отбрасывается поштучно, а не весь ответ: одна плохая строка прайса не должна стоить остальных четырёхсот.
 */

/** Потолки по спискам: факты едут в анкете и в запросе к модели, неограниченными они быть не могут. */
export const FACTS_LIMITS = {
  workTypes: 60,
  contracts: 200,
  sro: 10,
  licenses: 30,
  equipment: 80,
  staff: 60,
  prices: 400,
  regions: 40,
  notes: 20,
} as const;

const MAX_TEXT = 300;
const MAX_SHORT = 120;

/* ------------------------------- Терпимые чтения значений ------------------------------- */

function str(value: unknown, max = MAX_TEXT): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\s ]/gu, "").replace(",", ".").replace(/[^\d.]/gu, "");
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function count(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

function year(value: unknown, now: Date): number | null {
  const n = count(value);
  return n !== null && n >= 1990 && n <= now.getUTCFullYear() + 1 ? n : null;
}

function isoDate(value: unknown): string | null {
  const text = str(value, 30);
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(text);
  if (match !== null) return `${match[1] ?? ""}-${match[2] ?? ""}-${match[3] ?? ""}`;
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(text);
  return ru === null ? null : `${ru[3] ?? ""}-${ru[2] ?? ""}-${ru[1] ?? ""}`;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = str(value, 40).toLowerCase();
  return allowed.find((item) => item.toLowerCase() === text) ?? fallback;
}

const LAWS = ["44-FZ", "223-FZ", "commercial", "unknown"] as const satisfies readonly FactLaw[];
const CUSTOMER_TYPES = ["government", "municipal", "state_company", "commercial", "unknown"] as const satisfies readonly FactCustomerType[];
const SRO_KINDS = ["CONSTRUCTION", "DESIGN", "SURVEY", "OTHER"] as const satisfies readonly FactSroKind[];

/** Закон из слов, как он встречается в документах: «44-ФЗ», «223 ФЗ», «коммерческий». */
function law(value: unknown): FactLaw {
  const text = str(value, 40).toLowerCase();
  if (/44/u.test(text)) return "44-FZ";
  if (/223/u.test(text)) return "223-FZ";
  if (/коммерч|commercial|частн/u.test(text)) return "commercial";
  return pick(value, LAWS, "unknown");
}

function customerType(value: unknown): FactCustomerType {
  const text = str(value, 40).toLowerCase();
  if (/муницип/u.test(text)) return "municipal";
  if (/госкомпан|state_company|гос\.?\s*компан/u.test(text)) return "state_company";
  if (/госуд|government|орган/u.test(text)) return "government";
  if (/коммерч|commercial|частн/u.test(text)) return "commercial";
  return pick(value, CUSTOMER_TYPES, "unknown");
}

function sroKind(value: unknown): FactSroKind {
  const text = str(value, 60).toLowerCase();
  if (/проект|design/u.test(text)) return "DESIGN";
  if (/изыскан|survey/u.test(text)) return "SURVEY";
  if (/строит|construction|реконструк|капитальн/u.test(text)) return "CONSTRUCTION";
  return pick(value, SRO_KINDS, "OTHER");
}

/* ------------------------------- Проверка на личное ------------------------------- */

export interface SanitizeContext {
  scrub: ScrubOptions;
  now: Date;
  /** Сколько записей отброшено из-за ПД и из-за формы. */
  droppedForPii: number;
  droppedInvalid: number;
}

const PERSON_CUSTOMER_RE = /^(?:ип\s|индивидуальн|гражданин|физическ|самозанят)/iu;

/** Строка очищена; null — в ней нашлось личное (поле или запись надо выбросить). */
function clean(text: string, context: SanitizeContext): string | null {
  if (text === "") return "";
  const result = scrubPii(text, context.scrub);
  return result.total > 0 ? null : text;
}

function cleanOptional(text: string, context: SanitizeContext): string | null {
  const value = clean(text, context);
  return value === null || value === "" ? null : value;
}

function dropPii(context: SanitizeContext): null {
  context.droppedForPii += 1;
  return null;
}

function dropInvalid(context: SanitizeContext): null {
  context.droppedInvalid += 1;
  return null;
}

type Raw = Record<string, unknown>;

function field(raw: Raw, camel: string, snake: string): unknown {
  return raw[camel] ?? raw[snake];
}

function asRecords(value: unknown): Raw[] {
  return Array.isArray(value) ? value.filter((item): item is Raw => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/* ------------------------------- Записи ------------------------------- */

function workType(raw: Raw, context: SanitizeContext): FactWorkType | null {
  const name = str(raw["name"], MAX_SHORT);
  if (name === "") return dropInvalid(context);
  const cleanName = clean(name, context);
  if (cleanName === null) return dropPii(context);
  const years = (Array.isArray(raw["years"]) ? raw["years"] : [])
    .map((value) => year(value, context.now))
    .filter((value): value is number => value !== null);
  return {
    name: cleanName,
    contractsCount: count(field(raw, "contractsCount", "contracts_count")),
    totalSumRub: num(field(raw, "totalSumRub", "total_sum_rub")),
    years: [...new Set(years)].sort((a, b) => a - b).slice(0, 20),
    largestContractRub: num(field(raw, "largestContractRub", "largest_contract_rub")),
  };
}

function contract(raw: Raw, context: SanitizeContext): Omit<FactContract, "id"> | null {
  const subject = str(raw["subject"]);
  if (subject === "") return dropInvalid(context);
  const cleanSubject = clean(subject, context);
  if (cleanSubject === null) return dropPii(context);
  const rawCustomer = str(raw["customer"], MAX_SHORT);
  return {
    subject: cleanSubject,
    workType: cleanOptional(str(field(raw, "workType", "work_type"), MAX_SHORT), context),
    customerType: customerType(field(raw, "customerType", "customer_type")),
    customer: PERSON_CUSTOMER_RE.test(rawCustomer) ? null : cleanOptional(rawCustomer, context),
    year: year(raw["year"], context.now),
    sumRub: num(field(raw, "sumRub", "sum_rub")),
    law: law(raw["law"]),
    region: cleanOptional(str(raw["region"], MAX_SHORT), context),
  };
}

function sro(raw: Raw, context: SanitizeContext): Omit<FactSro, "id"> | null {
  const level = count(raw["level"]);
  return {
    kind: sroKind(raw["kind"]),
    level: level !== null && level >= 1 && level <= 5 ? level : null,
    maxContractRub: num(field(raw, "maxContractRub", "max_contract_rub")),
    number: cleanOptional(str(raw["number"], 60), context),
    validUntil: isoDate(field(raw, "validUntil", "valid_until")),
  };
}

function license(raw: Raw, context: SanitizeContext): Omit<FactLicense, "id"> | null {
  const kind = str(raw["kind"]);
  if (kind === "") return dropInvalid(context);
  const cleanKind = clean(kind, context);
  if (cleanKind === null) return dropPii(context);
  return {
    kind: cleanKind,
    issuer: cleanOptional(str(raw["issuer"], MAX_SHORT), context),
    number: cleanOptional(str(raw["number"], 60), context),
    validUntil: isoDate(field(raw, "validUntil", "valid_until")),
  };
}

function equipment(raw: Raw, context: SanitizeContext): FactEquipment | null {
  const name = str(raw["name"], MAX_SHORT);
  if (name === "") return dropInvalid(context);
  const cleanName = clean(name, context);
  if (cleanName === null) return dropPii(context);
  return { name: cleanName, count: count(raw["count"]) };
}

function staff(raw: Raw, context: SanitizeContext): FactStaff | null {
  const role = str(raw["role"], MAX_SHORT);
  const people = count(raw["count"]);
  if (role === "" || people === null || people <= 0) return dropInvalid(context);
  const cleanRole = clean(role, context);
  if (cleanRole === null) return dropPii(context);
  return { role: cleanRole, count: people, qualification: cleanOptional(str(raw["qualification"], MAX_SHORT), context) };
}

function price(raw: Raw, context: SanitizeContext): Omit<FactPrice, "id"> | null {
  const name = str(raw["name"]);
  const value = num(field(raw, "priceRub", "price_rub"));
  if (name === "" || value === null || value <= 0) return dropInvalid(context);
  const cleanName = clean(name, context);
  if (cleanName === null) return dropPii(context);
  const vatText = str(raw["vat"], 20).toLowerCase();
  return {
    name: cleanName,
    unit: str(raw["unit"], 30),
    priceRub: value,
    code: cleanOptional(str(raw["code"], 40), context),
    kind: pick(raw["kind"], ["work", "material", "other"] as const, "other"),
    vat: /^(?:with|с\s?ндс|включ)/u.test(vatText) ? "with" : /^(?:without|без)/u.test(vatText) ? "without" : "unknown",
  };
}

function strings(values: string[], limit: number, max: number, context: SanitizeContext): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = str(value, max);
    if (text === "") continue;
    const cleaned = clean(text, context);
    if (cleaned === null) {
      dropPii(context);
      continue;
    }
    if (!out.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function take<T>(items: Raw[], limit: number, read: (raw: Raw) => T | null): T[] {
  const out: T[] = [];
  for (const raw of items) {
    const item = read(raw);
    if (item !== null) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** Штат целиком из документов: число людей от 1 до 100 тысяч; всё остальное — «не названо». */
function staffTotal(raw: Raw): number | null {
  const value = count(field(raw, "staffTotal", "staff_total"));
  return value !== null && value >= 1 && value <= 100_000 ? value : null;
}

/** Ключ повтора: одинаковые контракты из двух документов (выписка и акт) — один. */
function contractKey(item: Omit<FactContract, "id">): string {
  return `${item.subject.toLowerCase().replace(/[^а-яёa-z0-9]+/gu, " ").trim()}|${String(item.year ?? "")}|${String(Math.round(item.sumRub ?? 0))}`;
}

/** Определения вида работ, которые не меняют его суть: «капитальный ремонт кровли» и «ремонт кровли» — одно и то же направление. */
const WORK_QUALIFIER_RE = /(?<![а-яё])(капитальн[а-яё]*|текущ[а-яё]*|комплексн[а-яё]*|частичн[а-яё]*|аварийн[а-яё]*)(?![а-яё])/giu;

function splitWorkName(name: string): { base: string; qualifiers: string[] } {
  const qualifiers: string[] = [];
  const base = name
    .replace(WORK_QUALIFIER_RE, (match) => {
      qualifiers.push(match.toLowerCase());
      return " ";
    })
    .replace(/\s+/gu, " ")
    .trim();
  return { base: base === "" ? name : base, qualifiers };
}

/**
 * Виды работ с одинаковым названием из разных документов: берётся большее, а не сумма — тот же контракт мог быть в двух файлах.
 * Близкие названия, отличающиеся только определением («ремонт кровли» и «капитальный ремонт кровли»), сливаются в одну строку
 * «ремонт кровли (в т.ч. капитальный)»: список видов работ читают глазами, и два почти одинаковых пункта — шум.
 */
function mergeWorkTypes(items: FactWorkType[]): FactWorkType[] {
  const byBase = new Map<string, { item: FactWorkType; base: string; qualifiers: Set<string>; plain: boolean; names: Set<string> }>();
  for (const item of items) {
    const { base, qualifiers } = splitWorkName(item.name);
    const key = base.toLowerCase();
    const current = byBase.get(key);
    if (current === undefined) {
      byBase.set(key, { item: { ...item, years: [...item.years] }, base, qualifiers: new Set(qualifiers), plain: qualifiers.length === 0, names: new Set([item.name.toLowerCase()]) });
      continue;
    }
    const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
    current.item.contractsCount = maxOf(current.item.contractsCount, item.contractsCount);
    current.item.totalSumRub = maxOf(current.item.totalSumRub, item.totalSumRub);
    current.item.largestContractRub = maxOf(current.item.largestContractRub, item.largestContractRub);
    current.item.years = [...new Set([...current.item.years, ...item.years])].sort((a, b) => a - b);
    for (const qualifier of qualifiers) current.qualifiers.add(qualifier);
    if (qualifiers.length === 0) current.plain = true;
    current.names.add(item.name.toLowerCase());
  }
  return [...byBase.values()].map((entry) => {
    // Название меняется только когда слились РАЗНЫЕ названия; одинаковые остаются как были.
    if (entry.names.size < 2) return entry.item;
    const qualifiers = [...entry.qualifiers];
    return { ...entry.item, name: `${entry.base}${qualifiers.length > 0 ? ` (в т.ч. ${qualifiers.join(", ")})` : ""}` };
  });
}

/** Части фактов без служебных полей: так их отдаёт разбор одного ответа модели. */
export type FactsBody = Pick<
  CompanyFacts,
  "workTypes" | "contracts" | "sro" | "licenses" | "equipment" | "staff" | "prices" | "regions" | "notes"
> & { staffTotal: number | null };

export interface SanitizeResult {
  body: FactsBody;
  droppedForPii: number;
  droppedInvalid: number;
}

/** Общая проверка: сырой объект (ответ модели или факты из анкеты) → очищенные части. */
export function sanitizeBody(raw: Raw, options: { scrub?: ScrubOptions; now?: Date } = {}): SanitizeResult {
  const context: SanitizeContext = {
    scrub: options.scrub ?? {},
    now: options.now ?? new Date(),
    droppedForPii: 0,
    droppedInvalid: 0,
  };

  const workTypes = mergeWorkTypes(take(asRecords(field(raw, "workTypes", "work_types")), FACTS_LIMITS.workTypes * 2, (r) => workType(r, context))).slice(
    0,
    FACTS_LIMITS.workTypes,
  );

  const seenContracts = new Set<string>();
  const contracts: FactContract[] = [];
  for (const record of asRecords(raw["contracts"])) {
    const item = contract(record, context);
    if (item === null) continue;
    const key = contractKey(item);
    if (seenContracts.has(key)) continue;
    seenContracts.add(key);
    contracts.push({ id: `c${String(contracts.length + 1)}`, ...item });
    if (contracts.length >= FACTS_LIMITS.contracts) break;
  }

  const sroList = take(asRecords(raw["sro"]), FACTS_LIMITS.sro, (r) => sro(r, context)).map((item, index) => ({ id: `s${String(index + 1)}`, ...item }));
  const licenses = take(asRecords(raw["licenses"]), FACTS_LIMITS.licenses, (r) => license(r, context)).map((item, index) => ({
    id: `l${String(index + 1)}`,
    ...item,
  }));
  const equipmentList = take(asRecords(raw["equipment"]), FACTS_LIMITS.equipment, (r) => equipment(r, context));
  const staffList = take(asRecords(raw["staff"]), FACTS_LIMITS.staff, (r) => staff(r, context));

  const seenPrices = new Set<string>();
  const prices: FactPrice[] = [];
  for (const record of asRecords(raw["prices"])) {
    const item = price(record, context);
    if (item === null) continue;
    const key = `${item.name.toLowerCase()}|${item.unit.toLowerCase()}|${String(item.priceRub)}`;
    if (seenPrices.has(key)) continue;
    seenPrices.add(key);
    prices.push({ id: `p${String(prices.length + 1)}`, ...item });
    if (prices.length >= FACTS_LIMITS.prices) break;
  }

  return {
    body: {
      workTypes,
      contracts,
      sro: sroList,
      licenses,
      equipment: equipmentList,
      staff: staffList,
      staffTotal: staffTotal(raw),
      prices,
      regions: strings(asStrings(raw["regions"]), FACTS_LIMITS.regions, MAX_SHORT, context),
      notes: strings(asStrings(raw["notes"]), FACTS_LIMITS.notes, MAX_TEXT, context),
    },
    droppedForPii: context.droppedForPii,
    droppedInvalid: context.droppedInvalid,
  };
}

/** Ответ модели → части фактов. Не JSON и не объект — ошибка: пустой «успех» молча стёр бы прежние факты. */
export function parseFactsResponse(content: string, options: { scrub?: ScrubOptions; now?: Date } = {}): SanitizeResult {
  const parsed: unknown = JSON.parse(extractLlmJson(content));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Ответ модели — не объект JSON");
  return sanitizeBody(parsed as Raw, options);
}

const metaSchema = z.object({
  extractedAt: z.string().optional(),
  sourceDocuments: z.array(z.string()).optional(),
  scrubStats: z.record(z.number()).optional(),
});

/**
 * Факты из анкеты (хранимый вид) → проверенные факты. null — анкета фактов не содержит.
 * Метаданные (время, источники, счётчики скрытого) читаются терпимо; содержимое проходит полную проверку.
 */
export function sanitizeFacts(value: unknown, options: { scrub?: ScrubOptions; now?: Date } = {}): { facts: CompanyFacts; droppedForPii: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Raw;
  const now = options.now ?? new Date();
  const meta = metaSchema.safeParse(raw);
  const result = sanitizeBody(raw, { ...options, now });
  const base = emptyFacts(now);
  const stats: ScrubStats = { ...base.scrubStats };
  for (const [key, count] of Object.entries(meta.success ? (meta.data.scrubStats ?? {}) : {})) {
    if (key in stats) stats[key as keyof ScrubStats] = Math.max(0, Math.round(count));
  }
  return {
    facts: {
      ...base,
      version: FACTS_VERSION,
      extractedAt: meta.success && meta.data.extractedAt !== undefined ? meta.data.extractedAt : now.toISOString(),
      sourceDocuments: meta.success ? (meta.data.sourceDocuments ?? []).slice(0, 50).map((name) => str(name, 200)) : [],
      scrubStats: stats,
      ...result.body,
    },
    droppedForPii: result.droppedForPii,
  };
}

/** Складывает ответы по нескольким частям запроса в один набор: повторы убираются, номера записей даются заново. */
export function mergeFactsBodies(bodies: readonly FactsBody[]): FactsBody {
  const raw: Raw = {
    work_types: bodies.flatMap((body) => body.workTypes),
    contracts: bodies.flatMap((body) => body.contracts),
    sro: bodies.flatMap((body) => body.sro),
    licenses: bodies.flatMap((body) => body.licenses),
    equipment: bodies.flatMap((body) => body.equipment),
    staff: bodies.flatMap((body) => body.staff),
    // Штат целиком: из разных частей запроса берётся большее названное число.
    staff_total: bodies.reduce<number | null>((best, body) => (body.staffTotal === null ? best : best === null ? body.staffTotal : Math.max(best, body.staffTotal)), null),
    prices: bodies.flatMap((body) => body.prices),
    regions: bodies.flatMap((body) => body.regions),
    notes: bodies.flatMap((body) => body.notes),
  };
  // Повторная проверка нужна для повторов и потолков, ПД к этому моменту уже вычищены.
  const merged = sanitizeBody(raw);
  // СРО и лицензии из разных документов с тем же содержимым — один: сверка по виду и уровню.
  const sroSeen = new Set<string>();
  const licenseSeen = new Set<string>();
  return {
    ...merged.body,
    sro: merged.body.sro.filter((item) => {
      const key = `${item.kind}|${String(item.level)}|${String(item.maxContractRub)}|${item.number ?? ""}`;
      if (sroSeen.has(key)) return false;
      sroSeen.add(key);
      return true;
    }),
    licenses: merged.body.licenses.filter((item) => {
      const key = `${item.kind.toLowerCase()}|${item.number ?? ""}`;
      if (licenseSeen.has(key)) return false;
      licenseSeen.add(key);
      return true;
    }),
  };
}
