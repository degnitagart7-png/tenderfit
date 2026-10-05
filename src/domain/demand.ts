import { z } from "zod";

import { normalizeLiveQuery, normalizeLiveRegions } from "@/domain/liveSearch";
import type { CollectorProfile } from "@/domain/syncProfiles";
import type { TenderLaw } from "@/types/database";

/**
 * Спрос посетителей на темы закупок.
 *
 * Сервер собирает закупки не по набору владельца, а по объединению тем всех
 * активных посетителей. Сто человек с запросом «юрист» дают один запрос к
 * площадкам, а тема, которую никто не открывал две недели, перестаёт
 * собираться. Лента при этом общая: закупки — публичные данные, и отбирает их
 * под себя уже каждый посетитель на своей странице.
 *
 * Модуль без сети и базы: разбор отчёта посетителя и сборка профилей сбора —
 * чистые функции.
 */

/** Сколько профилей посетитель может объявить: каждый — запросы к чужим площадкам. */
export const MAX_DEMAND_PROFILES = 5;
/** Сколько разных слов посетитель может держать в спросе. */
export const MAX_DEMAND_KEYWORDS = 15;
/** Через сколько дней без визита тема перестаёт собираться. */
export const DEMAND_TTL_DAYS = 14;

const MAX_KEYWORD_CHARS = 60;
const KEYWORDS_PER_COLLECTOR_PROFILE = 8;
const LIMIT_PER_KEYWORD = 10;

/** Канонический порядок законов: от него не зависит порядок, в котором их прислали. */
const LAW_ORDER: readonly TenderLaw[] = ["FZ_44", "FZ_223", "PP_RF_615", "COMMERCIAL"];

const reportSchema = z.object({
  visitorId: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
  profiles: z
    .array(
      z.object({
        keywords: z.array(z.string().max(300)).max(30),
        laws: z.array(z.enum(["FZ_44", "FZ_223", "PP_RF_615", "COMMERCIAL"])).min(1).max(4),
        /** Регионы профиля; нет — вся Россия. */
        regions: z.array(z.string().max(120)).max(10).default([]),
        enabled: z.boolean(),
      }),
    )
    .max(MAX_DEMAND_PROFILES),
});

export interface DemandEntry {
  keyword: string;
  laws: TenderLaw[];
  /** Регионы, в которых ждут тему; пусто — по всей России. */
  regions: string[];
}

export type ParsedDemandReport =
  | { ok: true; visitorId: string; entries: DemandEntry[] }
  | { ok: false; error: string };

function sortLaws(laws: Iterable<TenderLaw>): TenderLaw[] {
  const set = new Set(laws);
  return LAW_ORDER.filter((l) => set.has(l));
}

/**
 * Разбирает отчёт посетителя: какие темы он ждёт.
 *
 * Слово чистится тем же правилом, что запрос живого поиска: чужие поисковые
 * строки разбирают кавычки и скобки как синтаксис. Мусорные слова пропускаются,
 * а не роняют отчёт; лишнее сверх предела не принимается. Пустой результат —
 * не ошибка: так посетитель снимает свои темы.
 */
export function parseDemandReport(input: unknown): ParsedDemandReport {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `Отчёт не принят: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim() };
  }

  /** Слово → законы и регионы; `nationwide` — хотя бы в одном профиле регионов нет. */
  const byKeyword = new Map<string, { laws: Set<TenderLaw>; regions: string[]; nationwide: boolean }>();
  for (const profile of parsed.data.profiles) {
    if (!profile.enabled) continue;
    const regions = normalizeLiveRegions(profile.regions);
    for (const raw of profile.keywords) {
      const cleaned = normalizeLiveQuery(raw);
      if (cleaned === null || cleaned.length > MAX_KEYWORD_CHARS) continue;
      const keyword = cleaned.toLowerCase();
      const entry = byKeyword.get(keyword);
      if (entry === undefined) {
        if (byKeyword.size >= MAX_DEMAND_KEYWORDS) continue;
        byKeyword.set(keyword, { laws: new Set(profile.laws), regions: [...regions], nationwide: regions.length === 0 });
      } else {
        for (const law of profile.laws) entry.laws.add(law);
        if (regions.length === 0) entry.nationwide = true;
        entry.regions = normalizeLiveRegions([...entry.regions, ...regions]);
      }
    }
  }

  const entries = [...byKeyword].map(([keyword, e]) => ({
    keyword,
    laws: sortLaws(e.laws),
    regions: e.nationwide ? [] : e.regions,
  }));
  return { ok: true, visitorId: parsed.data.visitorId, entries };
}

export interface DemandRow {
  visitor_id: string;
  keyword: string;
  laws: TenderLaw[];
  /** Нет поля (старая строка) или пусто — по всей России. */
  regions?: string[] | null;
  last_seen_at: string;
}

export interface BuildDemandOptions {
  nowMs: number;
  /** Сколько слов собирать за прогон: потолок нагрузки на чужие площадки. */
  maxKeywords: number;
  /**
   * Что уже собирают профили владельца: слово → регионы (пустой список — вся
   * Россия). Тема посетителя занята, только если владелец собирает её во всех
   * его регионах; иначе собираются недостающие регионы.
   */
  exclude: ReadonlyMap<string, readonly string[]>;
}

/**
 * Профили сбора из спроса.
 *
 * Тема, которую ждут несколько посетителей, собирается один раз. Не хватает
 * места — первыми идут темы с большим числом посетителей, затем более свежие.
 * Цены и коды ОКПД2 не берутся: ими лента отбирает уже у человека, а чужая
 * граница цены сузила бы сбор для остальных. Законы объединяются по всем, кто
 * тему ждёт, а темы с разным набором законов идут отдельными профилями, чтобы
 * чужой закон не расширял запрос.
 */
export function buildDemandProfiles(rows: readonly DemandRow[], opts: BuildDemandOptions): CollectorProfile[] {
  const cutoff = opts.nowMs - DEMAND_TTL_DAYS * 86_400_000;

  const topics = new Map<
    string,
    { visitors: Set<string>; laws: Set<TenderLaw>; seenMs: number; regions: string[]; nationwide: boolean }
  >();
  for (const r of rows) {
    const seenMs = Date.parse(r.last_seen_at);
    if (Number.isNaN(seenMs) || seenMs < cutoff) continue;
    // Регионы, которые владелец этим словом уже собирает, у темы снимаются.
    const owned = opts.exclude.get(r.keyword);
    let rowRegions = r.regions ?? [];
    if (owned !== undefined) {
      if (owned.length === 0) continue;
      if (rowRegions.length > 0) {
        const ownedSet = new Set(owned.map((x) => x.trim().toLowerCase()));
        rowRegions = rowRegions.filter((x) => !ownedSet.has(x.trim().toLowerCase()));
        if (rowRegions.length === 0) continue;
      }
    }
    const topic = topics.get(r.keyword) ?? {
      visitors: new Set<string>(),
      laws: new Set<TenderLaw>(),
      seenMs: 0,
      regions: [],
      nationwide: false,
    };
    topic.visitors.add(r.visitor_id);
    if (rowRegions.length === 0) topic.nationwide = true;
    topic.regions = normalizeLiveRegions([...topic.regions, ...rowRegions]);
    for (const law of r.laws) topic.laws.add(law);
    topic.seenMs = Math.max(topic.seenMs, seenMs);
    topics.set(r.keyword, topic);
  }

  const ranked = [...topics]
    .sort(
      ([ka, a], [kb, b]) =>
        b.visitors.size - a.visitors.size || b.seenMs - a.seenMs || (ka < kb ? -1 : ka > kb ? 1 : 0),
    )
    .slice(0, opts.maxKeywords);

  const groups = new Map<string, { laws: TenderLaw[]; regions: string[]; keywords: string[] }>();
  for (const [keyword, topic] of ranked) {
    const laws = sortLaws(topic.laws);
    const regions = topic.nationwide ? [] : [...topic.regions].sort((a, b) => a.localeCompare(b, "ru"));
    const signature = `${laws.join("+")}|${regions.join("+")}`;
    const group = groups.get(signature) ?? { laws, regions, keywords: [] };
    group.keywords.push(keyword);
    groups.set(signature, group);
  }

  const profiles: CollectorProfile[] = [];
  for (const [signature, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (let i = 0; i < group.keywords.length; i += KEYWORDS_PER_COLLECTOR_PROFILE) {
      profiles.push({
        name: `Спрос (${signature}) №${String(profiles.length + 1)}`,
        regions: group.regions,
        enabled: true,
        laws: group.laws,
        keywords: group.keywords.slice(i, i + KEYWORDS_PER_COLLECTOR_PROFILE),
        minPrice: null,
        maxPrice: null,
        okpd2Codes: [],
        limitPerKeyword: LIMIT_PER_KEYWORD,
      });
    }
  }
  return profiles;
}
