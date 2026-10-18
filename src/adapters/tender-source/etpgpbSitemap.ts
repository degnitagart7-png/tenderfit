/**
 * Карта сайта ЭТП ГПБ: индекс → список кусков процедур → адреса карточек.
 *
 * Единственный разрешённый `robots.txt` способ узнать, какие процедуры есть: поиск
 * площадки и её JSON API требуют query-строки, а они запрещены (см. `etpgpbUrl.ts`).
 * Карта сайта устроена в три яруса (проверено 19.10.2026):
 *   `sitemap.xml` (`<sitemapindex>`, 18 карт, у каждой `<lastmod>`)
 *     → `sitemap/procedures.xml` — внимание: это `<urlset>`, а не индекс; в нём 60
 *       `<url>` с адресами кусков и датой изменения каждого
 *       → `sitemap/procedures/procedures<N>.xml` — по ~20 600 адресов карточек
 *         (4,7 МБ) с `<lastmod>` у каждой процедуры.
 * Куски с большим номером — новее: у 50–60 дата изменения за последние дни, у
 * старых — 2023–2025, но часть старых тоже изменена недавно (правка одной процедуры
 * меняет дату всего куска), поэтому кусков в окне просмотра бывает до двух-трёх десятков. Порядок записей внутри куска ничего не значит, поэтому
 * свежесть определяется только по `<lastmod>`.
 *
 * Модуль чистый: разбор текста и отбор, без сети и диска. Разбор — регулярными
 * выражениями, а не DOM: кусок весит мегабайты, а формат карты сайта фиксирован
 * стандартом sitemaps.org. Адреса, не прошедшие `etpgpbUrlKind`, молча отбрасываются:
 * лишняя запись в чужом ответе не должна превращаться в запрос.
 */
import {
  etpgpbChunkNumber,
  etpgpbUrlKind,
  parseEtpgpbCardUrl,
  type EtpgpbCardUrl,
} from "@/adapters/tender-source/etpgpbUrl";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Сколько дней назад смотреть по умолчанию: процедура свежее этого срока по `<lastmod>`. */
export const ETPGPB_DEFAULT_LOOKBACK_DAYS = 21;

/** Виды процедур, которые не берём: продажа имущества — поставщик там покупатель, а не продавец. */
export const ETPGPB_EXCLUDED_KINDS: readonly string[] = ["sale"];

/** Запись `<url>`/`<sitemap>` карты сайта. */
export interface SitemapLoc {
  readonly loc: string;
  readonly lastmod: string | null;
}

/** Кусок карты процедур. */
export interface EtpgpbChunkRef {
  readonly url: string;
  readonly number: number;
  /** Дата изменения куска в том виде, как её напечатала площадка: часть ключа кэша. */
  readonly lastmod: string | null;
  readonly lastmodMs: number | null;
}

/** Процедура из куска карты. */
export interface EtpgpbSitemapEntry extends Pick<EtpgpbCardUrl, "url" | "kind" | "id" | "slug"> {
  readonly lastmodMs: number;
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity);
}

/** Момент из `<lastmod>`: ISO-дата или дата со временем и смещением; нечитаемое — null. */
export function parseLastmod(raw: string | null | undefined): number | null {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

const BLOCK = /<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/g;
const LOC = /<loc>\s*([^<]*?)\s*<\/loc>/;
const LASTMOD = /<lastmod>\s*([^<]*?)\s*<\/lastmod>/;

/**
 * Записи карты сайта — и из `<urlset>`, и из `<sitemapindex>`: площадка отдаёт
 * список кусков процедур как `<urlset>`, хотя по смыслу это индекс.
 */
export function parseSitemapLocs(xml: string): SitemapLoc[] {
  const out: SitemapLoc[] = [];
  for (const block of xml.matchAll(BLOCK)) {
    const body = block[2] ?? "";
    const loc = LOC.exec(body)?.[1];
    if (loc === undefined || loc === "") continue;
    const lastmod = LASTMOD.exec(body)?.[1];
    out.push({ loc: decodeXml(loc), lastmod: lastmod === undefined || lastmod === "" ? null : lastmod });
  }
  return out;
}

/** Адрес `sitemap/procedures.xml` из индекса `sitemap.xml`; null, если площадка его убрала. */
export function findProceduresSitemapUrl(indexXml: string): string | null {
  for (const { loc } of parseSitemapLocs(indexXml)) {
    if (etpgpbUrlKind(loc) === "sitemap-procedures") return loc;
  }
  return null;
}

/** Куски карты процедур из `sitemap/procedures.xml`. Чужие адреса отброшены. */
export function parseProcedureChunks(xml: string): EtpgpbChunkRef[] {
  const out: EtpgpbChunkRef[] = [];
  for (const { loc, lastmod } of parseSitemapLocs(xml)) {
    const number = etpgpbChunkNumber(loc);
    if (number === null) continue;
    out.push({ url: loc, number, lastmod, lastmodMs: parseLastmod(lastmod) });
  }
  return out;
}

export interface ChunkParseOptions {
  /** Моложе какого момента должна быть запись, мс; не задан — любая. */
  readonly minLastmodMs?: number;
  /** Виды, которые пропускаются. По умолчанию — `ETPGPB_EXCLUDED_KINDS`. */
  readonly excludeKinds?: readonly string[];
  /** Дата куска: подставляется записи без своего `<lastmod>`. */
  readonly fallbackLastmodMs?: number | null;
}

/**
 * Процедуры из куска карты.
 *
 * Запись без читаемой даты берёт дату куска; если нет и её — отбрасывается: без даты
 * не отличить свежую процедуру от архивной, а читать карточки вслепую нельзя.
 * Отбор по возрасту и виду идёт прямо при разборе — кусок на 20 тысяч записей не
 * должен превращаться в 20 тысяч объектов ради десятка процентов нужных.
 */
export function parseChunkEntries(xml: string, options: ChunkParseOptions = {}): EtpgpbSitemapEntry[] {
  const excluded = new Set(options.excludeKinds ?? ETPGPB_EXCLUDED_KINDS);
  const byUrl = new Map<string, EtpgpbSitemapEntry>();
  for (const { loc, lastmod } of parseSitemapLocs(xml)) {
    const card = parseEtpgpbCardUrl(loc);
    if (card === null || excluded.has(card.kind)) continue;
    const lastmodMs = parseLastmod(lastmod) ?? options.fallbackLastmodMs ?? null;
    if (lastmodMs === null) continue;
    if (options.minLastmodMs !== undefined && lastmodMs < options.minLastmodMs) continue;
    const known = byUrl.get(card.url);
    if (known === undefined || known.lastmodMs < lastmodMs) {
      byUrl.set(card.url, { url: card.url, kind: card.kind, id: card.id, slug: card.slug, lastmodMs });
    }
  }
  return [...byUrl.values()];
}

export interface ChunkSelection {
  readonly nowMs: number;
  readonly lookbackMs: number;
  /**
   * Потолок числа кусков за скачивание: каждый — до 5 МБ. По дате изменения в окно в 21 день
   * попало 25 кусков из 60 (19.10.2026): старый кусок тоже получает новую дату, когда правят
   * одну из его процедур. Потолок — страховка от сотни кусков, а не рабочий отбор.
   */
  readonly maxChunks: number;
}

/**
 * Куски, которые стоит читать: изменённые не раньше границы окна, самые свежие первыми.
 *
 * Кусок без читаемой даты пропускается: старых кусков 49 из 60, и качать их все
 * («вдруг там новое») — 230 МБ ради архива. Пропуск виден в статистике адаптера.
 */
export function selectChunks(chunks: readonly EtpgpbChunkRef[], selection: ChunkSelection): EtpgpbChunkRef[] {
  const cutoff = selection.nowMs - selection.lookbackMs;
  return chunks
    .filter((chunk) => chunk.lastmodMs !== null && chunk.lastmodMs >= cutoff)
    .sort((a, b) => (b.lastmodMs ?? 0) - (a.lastmodMs ?? 0) || b.number - a.number)
    .slice(0, Math.max(0, selection.maxChunks));
}

export interface EntrySelection {
  readonly nowMs: number;
  readonly lookbackMs: number;
  readonly excludeKinds?: readonly string[];
}

/**
 * Процедуры окна просмотра: изменены не раньше границы, не из исключённых видов,
 * самые свежие первыми (при равенстве даты — больший номер первым, чтобы порядок не
 * зависел от порядка записей в чужом файле).
 */
export function selectEntries(
  entries: readonly EtpgpbSitemapEntry[],
  selection: EntrySelection,
): EtpgpbSitemapEntry[] {
  const cutoff = selection.nowMs - selection.lookbackMs;
  const excluded = new Set(selection.excludeKinds ?? ETPGPB_EXCLUDED_KINDS);
  return entries
    .filter((entry) => entry.lastmodMs >= cutoff && !excluded.has(entry.kind))
    .sort((a, b) => b.lastmodMs - a.lastmodMs || Number(b.id) - Number(a.id));
}
