import type { CompanyProfile, SearchProfile } from "@/domain/entities";
import { freeSyncSources } from "@/domain/sources";
import type { TenderDataSource, TenderLaw } from "@/types/database";
import { pluralRu } from "@/utils/format";

/**
 * Живой поиск: запрос человека уходит прямо на площадки, а найденное остаётся
 * в базе.
 *
 * Зачем. Поиск по ленте ищет только то, что уже загружено, а грузят три
 * зашитых профиля сервера. Запрос «юридические услуги» находил две закупки не
 * потому, что поиск плох, а потому, что юристов никто не собирал. Живой поиск
 * закрывает это: запрос уходит в ЕИС, Сбербанк-АСТ, Росэлторг, Фабрикант и ЭТП ГПБ,
 * найденное сохраняется.
 *
 * Главное, что здесь нужно удержать, — судьба найденного. Плановый прогон
 * пересоздаёт строки опрошенного источника целиком: удаляет все и пишет заново
 * только то, что нашли профили сервера. Найденное живым поиском без защиты
 * пропало бы при ближайшем обходе — человек нашёл бы закупки и через два часа
 * потерял их без объяснения. Поэтому такие строки помечаются в `raw_data`, а
 * очистка их щадит.
 *
 * Модуль чистый: ни сети, ни базы. Сюда входят правила, а запись и опрос — в
 * `scripts/sync-eis.ts` и воркере.
 */

/** Значение `raw_data.origin` у строк, найденных живым поиском. */
export const LIVE_ORIGIN = "live";

/** Сколько закупок на слово берём у каждой площадки: больше планового профиля. */
export const LIVE_LIMIT_PER_KEYWORD = 25;

const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 120;

/**
 * Чистит запрос перед тем, как отдать его чужим поисковым строкам.
 *
 * Оставляет буквы, цифры, пробел и знаки, значимые в названиях и кодах
 * (дефис, точка, запятая): точка нужна коду ОКПД2. Всё остальное — кавычки,
 * угловые скобки, управляющие символы — превращается в пробел: площадки
 * разбирают эти знаки как синтаксис, и пользовательский ввод не должен
 * менять разбор запроса. Запрос без единой буквы или цифры отклоняется.
 */
export function normalizeLiveQuery(raw: string): string | null {
  const cleaned = raw
    .replace(/[^\p{L}\p{N}\s.,-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < MIN_QUERY_CHARS || cleaned.length > MAX_QUERY_CHARS) return null;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return cleaned;
}

/** Сколько близких слов ищется вместе с запросом: каждое — отдельный обход площадок. */
export const MAX_LIVE_SYNONYMS = 3;

/**
 * Сколько слов профиля, кроме первого, берёт поиск по профилю (кнопка «Найти новые
 * закупки»). Каждое — запрос к ЕИС и Сбербанк-АСТ; площадкам с карточками уходит
 * только первое, поэтому семь слов укладываются в минуту.
 */
export const MAX_PROFILE_KEYWORDS = 6;

/**
 * Близкие слова запроса, предложенные моделью: чистятся как запрос, без повторов
 * запроса и друг друга, не больше `max` (по умолчанию `MAX_LIVE_SYNONYMS`).
 */
export function normalizeLiveSynonyms(query: string, input: unknown, max: number = MAX_LIVE_SYNONYMS): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>([query.replace(/\s+/g, " ").trim().toLowerCase()]);
  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const cleaned = normalizeLiveQuery(item);
    if (cleaned === null) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= max) break;
  }
  return result;
}

const MAX_LIVE_REGIONS = 5;
const MAX_REGION_CHARS = 60;

/**
 * Регионы запроса из тела ручки или переменной окружения.
 *
 * Каждое название чистится так же, как запрос, и режется по длине; повторы и
 * мусор отбрасываются, больше пяти не берётся: каждый регион — отдельная
 * выдача у площадок. Не список — пустой список (поиск по всей России).
 */
export function normalizeLiveRegions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const cleaned = normalizeLiveQuery(item);
    if (cleaned === null || cleaned.length > MAX_REGION_CHARS) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= MAX_LIVE_REGIONS) break;
  }
  return result;
}

const MAX_LIVE_OKPD2 = 10;
const OKPD2_CODE_RE = /^\d{2}(?:\.\d{1,2}(?:\.\d{1,2}(?:\.\d{1,3})?)?)?$/;

/**
 * Коды ОКПД2 поиска по профилю: «41», «43.21», «43.21.10.120». Не код — мимо,
 * повторы и хвостовые точки убираются, больше десяти не берётся: каждый код —
 * отдельная выдача ЕИС в каждом регионе.
 */
export function normalizeLiveOkpd2(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const code = item.trim().replace(/\s+/g, "").replace(/\.+$/, "");
    if (!OKPD2_CODE_RE.test(code) || result.includes(code)) continue;
    result.push(code);
    if (result.length >= MAX_LIVE_OKPD2) break;
  }
  return result;
}

/** Что уходит воркеру по кнопке «Найти новые закупки»: выжимка профиля человека. */
export interface ProfileSearchRequest {
  /** Главное слово: по нему ищут и площадки с карточками. */
  query: string;
  /** Остальные слова профиля (ЕИС и Сбербанк-АСТ). */
  keywords: string[];
  regions: string[];
  okpd2: string[];
}

/** Виды работ из описания деятельности: «ремонт помещений, строительство» → два слова. */
function activityWords(description: string): string[] {
  return description
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

/**
 * Выжимка профиля для поиска на площадках.
 *
 * Раньше кнопка «Найти новые закупки» запускала общий обход по профилям
 * владельца и спросу всех посетителей: Москва и Подмосковье чужих тем, двести
 * пятьдесят секунд, а коды ОКПД2 и регион человека в нём не участвовали вовсе
 * (замечание тестировщика 23.10.2026). Теперь ищется ровно то, что человек
 * описал: слова включённых профилей поиска, затем виды работ из профиля
 * компании; регионы профилей поиска и география компании; коды ОКПД2 оттуда же.
 *
 * null — профиль пуст (ни одного слова): тогда остаётся общий обход.
 */
export function buildProfileSearchRequest(
  searchProfiles: readonly SearchProfile[],
  company: CompanyProfile | null,
): ProfileSearchRequest | null {
  const enabled = searchProfiles.filter((p) => p.enabled);
  const words: string[] = [];
  const seen = new Set<string>();
  const addWord = (raw: string): void => {
    const cleaned = normalizeLiveQuery(raw);
    if (cleaned === null) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    words.push(cleaned);
  };
  for (const profile of enabled) for (const word of profile.keywords) addWord(word);
  if (company !== null) {
    const cap = company.capabilities;
    for (const word of [...cap.works, ...cap.keywords, ...cap.services, ...cap.products]) addWord(word);
    for (const word of activityWords(company.activityDescription ?? "")) addWord(word);
  }
  const [query, ...rest] = words;
  if (query === undefined) return null;

  const regions = normalizeLiveRegions([
    ...enabled.flatMap((p) => p.regions),
    ...(company?.restrictions.workRegions ?? []),
    ...(company?.preferences.priorityRegions ?? []),
  ]);
  const okpd2 = normalizeLiveOkpd2([
    ...enabled.flatMap((p) => p.okpd2Codes ?? []),
    ...(company?.capabilities.okpd2Codes ?? []),
  ]);
  return { query, keywords: rest.slice(0, MAX_PROFILE_KEYWORDS), regions, okpd2 };
}

/** Профиль прогона — та же форма, что в `scripts/sync-profiles.json`. */
export interface LiveProfile {
  name: string;
  enabled: boolean;
  sources: TenderDataSource[];
  laws: TenderLaw[];
  keywords: string[];
  minPrice: number | null;
  maxPrice: number | null;
  regions: string[];
  /** Коды ОКПД2: ЕИС ищет их классы в регионах поиска отдельной выдачей, без слов. */
  okpd2Codes: string[];
  limitPerKeyword: number;
}

/**
 * Профиль живого прогона: только запрос человека и только бесплатные источники.
 *
 * Платный Контур не входит: каждый его запрос стоит денег, а запрос здесь
 * приходит с открытой страницы. Цена и регион не ограничиваются — человек их
 * не просил.
 */
export function buildLiveProfile(
  query: string,
  regions: readonly string[] = [],
  synonyms: readonly string[] = [],
  okpd2: readonly string[] = [],
): LiveProfile {
  return {
    name: "Живой поиск",
    enabled: true,
    sources: freeSyncSources().map((source) => source.source),
    // Коммерческие — обязательно: по законам профиля сборщик решает, какие
    // площадки опрашивать, и без них Сбербанк-АСТ выпал бы из живого поиска.
    laws: ["FZ_44", "FZ_223", "COMMERCIAL"],
    keywords: [query, ...synonyms],
    minPrice: null,
    maxPrice: null,
    regions: [...regions],
    okpd2Codes: [...okpd2],
    limitPerKeyword: LIVE_LIMIT_PER_KEYWORD,
  };
}

// `type`, а не `interface`: объект-литерал совместим с `Record<string, unknown>`,
// в котором репозиторий принимает `raw_data`, а интерфейс — нет.
export type LiveRawData = {
  origin: typeof LIVE_ORIGIN;
  query: string;
  at: string;
};

/** Пометка строки: откуда она взялась, по какому запросу и когда. */
export function liveRawData(query: string, at: string): LiveRawData {
  return { origin: LIVE_ORIGIN, query, at };
}

/** Строка помечена как найденная живым поиском. `raw_data` — любое значение из базы. */
export function isLiveRawData(value: unknown): value is LiveRawData {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { origin?: unknown }).origin === LIVE_ORIGIN
  );
}

/**
 * Условие PostgREST для плановой очистки: что УДАЛЯТЬ.
 *
 * Строка удаляется, если пометки нет или она не «live». Условие «origin is
 * null» нужно отдельно: у строк без пометки, включая сырые ответы Контура,
 * `raw_data->>origin` равно NULL, а `NULL <> 'live'` в SQL даёт NULL, то есть
 * «не удалять». Без второго условия очистка Контура и всех источников без
 * пометки молча перестала бы работать, и лента копила бы закрытые закупки.
 */

/**
 * Значение `raw_data.origin` у закупок, добавленных человеком по ссылке или номеру
 * (`src/domain/tenderLink.ts`). Плановая очистка их щадит так же, как найденные
 * живым поиском: человек сам попросил эту закупку, и через два часа она не должна
 * пропасть из-за того, что ни один профиль её не собирает.
 */
export const LINK_ORIGIN = "link";

export type LinkRawData = { origin: typeof LINK_ORIGIN; at: string };

/** Пометка закупки, добавленной по ссылке. */
export function linkRawData(at: string): LinkRawData {
  return { origin: LINK_ORIGIN, at };
}

/** Удаляются строки без пометки и с чужой пометкой; «live» и «link» остаются (13.10.2026). */
export const KEEP_LIVE_ROWS_FILTER = `raw_data->>origin.is.null,raw_data->>origin.not.in.(${LIVE_ORIGIN},${LINK_ORIGIN})`;

/**
 * Какие строки источника удалить после планового прогона: те, чьего реестрового номера
 * в снимке нет. Строки, которые прогон увидел, обновляются на месте и сохраняют дату
 * первого появления и id (15.10.2026).
 */
export function staleRowIds(
  stored: readonly { id: string; reg_number: string }[],
  keep: ReadonlySet<string>,
): string[] {
  return stored.filter((row) => !keep.has(row.reg_number)).map((row) => row.id);
}

/**
 * Граница, после которой закрытая «живая» закупка удаляется.
 *
 * Сутки после срока подачи, а не сам срок: человек нашёл закупку живым
 * поиском и мог не успеть её открыть, а исчезновение в момент закрытия выглядело
 * бы как сбой.
 */
export function liveExpiryCutoff(nowMs: number): string {
  return new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
}

/** Задание живого поиска, как его видит решение о запуске. */
export interface LiveJobView {
  id: string;
  query: string;
  status: "pending" | "processing" | "completed" | "failed";
  /** Регионы поиска; нет — вся Россия. */
  regions?: string[];
  createdAt: string;
  finishedAt: string | null;
  /**
   * Прогон закончился неполно: итоговая строка говорит, что ЕИС ограничила доступ
   * или площадка не ответила. Такой результат не считается «свежим»: повтор запроса
   * ставит новое задание, а не отвечает «уже искали» про поиск без части площадок.
   */
  incomplete?: boolean;
}

export type LiveStartDecision =
  | { kind: "create" }
  | { kind: "reuse"; jobId: string }
  | { kind: "cached"; jobId: string }
  | { kind: "busy"; reason: string };

/** Сколько минут выполненный поиск считается свежим. */
export const LIVE_CACHE_MINUTES = 30;

/** Воркер заглядывает в очередь раз в минуту: столько задание может ждать подхвата. */
export const LIVE_PICKUP_MS = 60_000;

/**
 * Предел одного живого прогона. Дольше воркер его не держит: прогон прерывается,
 * и занятая им площадка освобождается. Этим пределом держится обещание человеку
 * «подождите не больше десяти минут» (подхват + прогон = 8 минут).
 */
export const LIVE_RUN_CAP_MS = 7 * 60_000;

/**
 * Через сколько минут воркер освободится от задания, поставленного в `createdMs`.
 *
 * Верхняя оценка: прогон идёт до своего предела, а обычно заканчивается раньше.
 * Задание давно перешло срок — null: воркер, видимо, занят чем-то ещё, и число,
 * которого мы не знаем, называть нельзя. Создание «в будущем» (часы расходятся)
 * не даёт срока больше полного.
 */
export function liveWaitMinutes(createdMs: number, nowMs: number): number | null {
  const elapsed = Math.max(0, nowMs - createdMs);
  const remaining = LIVE_PICKUP_MS + LIVE_RUN_CAP_MS - elapsed;
  if (remaining <= 0) return null;
  return Math.ceil(remaining / 60_000);
}

const flat = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Тот же поиск: тот же запрос и те же регионы (порядок не важен). */
function sameSearch(
  a: { query: string; regions?: readonly string[] },
  b: { query: string; regions?: readonly string[] },
): boolean {
  if (flat(a.query) !== flat(b.query)) return false;
  const regionsOf = (x: { regions?: readonly string[] }): string =>
    [...(x.regions ?? [])].map(flat).sort().join("|");
  return regionsOf(a) === regionsOf(b);
}

/**
 * Ставить ли задание живого поиска.
 *
 * Прогон идёт минуты и ходит по чужим площадкам, поэтому повторное нажатие не
 * должно плодить задания. Тот же запрос в работе — возвращаем его; выполненный
 * недавно — не повторяем, данные уже в базе; чужой запрос в работе — отказ с
 * объяснением, а не очередь из прогонов, каждый из которых занимает воркер на
 * несколько минут.
 */
function busyReason(active: LiveJobView, nowMs: number): string {
  const minutes = liveWaitMinutes(Date.parse(active.createdAt), nowMs);
  if (minutes === null) {
    return "Сервер ещё занят другим запросом, он идёт дольше обычного. Повторите через несколько минут.";
  }
  const word = pluralRu(minutes, ["минуту", "минуты", "минут"]);
  return `Сервер сейчас ищет другой запрос. Повторите примерно через ${String(minutes)} ${word}.`;
}

export function decideLiveStart(input: {
  query: string;
  regions?: readonly string[];
  active: LiveJobView | null;
  recent: LiveJobView | null;
  nowMs: number;
}): LiveStartDecision {
  if (input.active !== null) {
    return sameSearch(input.active, input)
      ? { kind: "reuse", jobId: input.active.id }
      : { kind: "busy", reason: busyReason(input.active, input.nowMs) };
  }

  const recent = input.recent;
  if (
    recent !== null &&
    recent.status === "completed" &&
    recent.incomplete !== true &&
    recent.finishedAt !== null &&
    sameSearch(recent, input)
  ) {
    const finished = Date.parse(recent.finishedAt);
    if (!Number.isNaN(finished) && input.nowMs - finished < LIVE_CACHE_MINUTES * 60_000) {
      return { kind: "cached", jobId: recent.id };
    }
  }

  return { kind: "create" };
}

/**
 * Закупка закрыта дольше, чем живёт «живая» строка: сохранять её незачем.
 *
 * Та же граница, по которой плановый прогон удаляет такие строки
 * (`liveExpiryCutoff`): сохранить, чтобы стереть при ближайшем обходе, значило
 * бы показывать закрытое как найденное. Неразобранная или пустая дата
 * просроченной не считается: срок неизвестен, а не прошёл.
 */
export function isLiveExpired(submissionEnd: string, nowMs: number): boolean {
  const end = Date.parse(submissionEnd);
  if (Number.isNaN(end)) return false;
  return end < Date.parse(liveExpiryCutoff(nowMs));
}
