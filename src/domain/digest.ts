import type { CompanyProfile, SearchProfile } from "@/domain/entities";
import { PIPELINE_STATUSES, type PipelineStatus } from "@/domain/enums";
import { sendTimeMinutes, type ResolvedDigestSettings } from "@/domain/digestSettings";
import { profileDescribesSubject } from "@/domain/emptyCompanyProfile";
import { defaultFilters, searchRows, selectedRegions, sortSearched, type SearchedRow, type TenderRow } from "@/domain/filtering";
import { nonContractReason, profileIsContractor, worksIntent } from "@/domain/procurementNature";
import { isSubmissionExpired } from "@/domain/scoring";
import {
  autoAppliedProfile,
  limitsFromProfile,
  profileNarrowing,
  searchWordsFromProfile,
} from "@/domain/searchProfileFilters";

/**
 * Сводка для письма и страницы «Отчёт»: новое по профилю, что закрывается в ближайшие
 * двое суток и что у человека в работе.
 *
 * Отбор «нового» — тот же, что у ленты закупок (`TendersView`): слова, регион и лимиты
 * первого включённого профиля поиска, без «не подряд» (квартиры, мониторинг цен) и без оценки
 * «Не подходит». Сама лента — компонент браузера и состоит из состояний React, поэтому её
 * правила повторены здесь поверх общих функций домена (`searchRows`, `sortSearched`,
 * `nonContractReason`…), а не скопированы: порядок, слова и лимиты берутся оттуда же.
 * Расхождение возможно только в том, что лента ещё учитывает ручные фильтры человека, а сводка — нет.
 *
 * Чистый модуль: время приходит параметром, база и сеть не нужны. Одну и ту же функцию зовут
 * воркер (письмо) и браузер (страница «Отчёт»), чтобы письмо и экран не расходились.
 */

/** Сколько новых закупок показывает сводка; остальные — числом (`totalFresh`). */
export const DIGEST_FRESH_LIMIT = 10;
export const DIGEST_CLOSING_LIMIT = 5;
export const DIGEST_IN_WORK_LIMIT = 5;
/** «Закрывается в ближайшее время»: окно в часах. */
export const DIGEST_CLOSING_HOURS = 48;

const HOUR_MS = 3_600_000;

/** Рабочие статусы воронки «Мои закупки»: человек занимается закупкой и подача ещё впереди. */
export const WORKING_STATUSES: readonly PipelineStatus[] = ["INTERESTING", "ANALYZING", "PREPARING_APPLICATION"];

/** Воронка: номер закупки → статус. Остальные поля записи сводке не нужны. */
export type DigestPipeline = Readonly<Record<string, { status: PipelineStatus }>>;

/** Воронка из сохранённых данных аккаунта: записи с неизвестным статусом отбрасываются. */
export function readPipeline(raw: unknown): DigestPipeline {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, { status: PipelineStatus }> = {};
  for (const [id, item] of Object.entries(raw as Record<string, unknown>)) {
    const status = typeof item === "object" && item !== null ? (item as { status?: unknown }).status : undefined;
    if (typeof status === "string" && (PIPELINE_STATUSES as readonly string[]).includes(status)) {
      result[id] = { status: status as PipelineStatus };
    }
  }
  return result;
}

/** Строка сводки: всё, что нужно письму и странице, без самой закупки. */
export interface DigestItem {
  id: string;
  regNumber: string;
  subject: string;
  customer: string;
  region: string;
  /** НМЦК, ₽; null — цена не опубликована. */
  price: number | null;
  currency: string;
  /** Конец приёма заявок, ISO; пусто — срок неизвестен. */
  submissionEnd: string;
  fitScore: number;
  /** Ссылка на закупку в приложении. */
  url: string;
}

export interface DigestResult {
  /** Новые по профилю с момента `since`: не больше `DIGEST_FRESH_LIMIT`. */
  fresh: DigestItem[];
  /** Сколько всего новых нашлось (может быть больше показанных). */
  totalFresh: number;
  /** Закрываются в ближайшие 48 часов: из воронки и из подходящих. */
  closing: DigestItem[];
  /** Воронка в рабочих статусах с ближайшими сроками. */
  inWork: DigestItem[];
  /** Нечего сообщить: письмо не отправляется. */
  isEmpty: boolean;
}

/** Базовый адрес приложения для ссылок в письмах: `APP_BASE_URL`, по умолчанию https://tender-fit.ru. */
export function appBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env["APP_BASE_URL"] ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(raw) ? raw : "https://tender-fit.ru";
}

/** Ссылка на закупку: карточка открывается по реестровому номеру. */
export function tenderUrl(regNumber: string, base: string = appBaseUrl()): string {
  return `${base}/tenders/${encodeURIComponent(regNumber)}`;
}

function endMs(row: TenderRow): number {
  return Date.parse(row.tender.deadlines.submissionEnd);
}

/** Закупку ещё можно подавать: срок не прошёл или неизвестен (неизвестный — не «закрыто»). */
function isOpen(row: TenderRow, now: number): boolean {
  return !isSubmissionExpired(row.tender.deadlines.submissionEnd, new Date(now));
}

/** Подача закрывается в ближайшие 48 часов: срок известен и ещё не прошёл. */
function closesSoon(row: TenderRow, now: number): boolean {
  const end = endMs(row);
  return Number.isFinite(end) && end > now && end - now <= DIGEST_CLOSING_HOURS * HOUR_MS;
}

function toItem(row: TenderRow, base: string): DigestItem {
  const { tender } = row;
  return {
    id: tender.id,
    regNumber: tender.regNumber,
    subject: tender.subject,
    customer: tender.customerName,
    region: tender.region,
    price: tender.financial.price > 0 ? tender.financial.price : null,
    currency: tender.financial.currency,
    submissionEnd: tender.deadlines.submissionEnd,
    fitScore: row.analysis.fitScore,
    url: tenderUrl(tender.regNumber, base),
  };
}

/** Отклонили только регионом вне географии компании, других блокеров нет (как в ленте). */
function onlyRegionBlocks(row: TenderRow): boolean {
  const blockers = row.analysis.hardBlockers;
  return blockers.length > 0 && blockers.every((b) => b.id.endsWith("-block-region"));
}

/**
 * Подходящее человеку из `rows` — выдача ленты по первому включённому профилю, в порядке ленты.
 * Профиля со словами нет — пусто: «новое по профилю» без профиля значило бы всю Россию.
 */
export function selectForProfile(input: {
  rows: readonly TenderRow[];
  searchProfiles: readonly SearchProfile[];
  companyProfile: CompanyProfile;
  now: number;
}): SearchedRow[] {
  const profile = autoAppliedProfile(input.searchProfiles);
  if (profile === null) return [];

  const filters = { ...defaultFilters, ...searchWordsFromProfile(profile) };
  const rows = [...input.rows];
  let hits = searchRows(rows, filters);

  // Заказчики и цена профиля: лента прячет то, что они исключают (`profileLimitIds`).
  if (profileNarrowing(profile).length > 0) {
    const within = new Set(
      searchRows(rows, { ...filters, ...limitsFromProfile(profile) }).map((hit) => hit.row.tender.id),
    );
    hits = hits.filter((hit) => within.has(hit.row.tender.id));
  }

  const queryWords = profile.keywords.filter((word) => word.trim() !== "");
  const contractor = profileIsContractor(input.companyProfile);
  const subjectKnown = profileDescribesSubject(input.companyProfile);
  const regionChosen = selectedRegions(filters).length > 0;
  hits = hits.filter(({ row }) => {
    // Не подряд: покупка квартир у застройщика, мониторинг цен.
    if (nonContractReason(row.tender, { words: queryWords, contractor }) !== null) return false;
    // «Не подходит» по профилю компании — только если профиль вообще о чём-то говорит;
    // отказ одним лишь регионом при выбранном регионе не прячет закупку (как в ленте).
    if (subjectKnown && row.analysis.verdict === "NOT_RECOMMENDED" && !(regionChosen && onlyRegionBlocks(row))) {
      return false;
    }
    return true;
  });

  return sortSearched(hits, "fitScore", "desc", undefined, {
    now: new Date(input.now),
    preferWorks: worksIntent(queryWords, contractor),
  });
}

export interface BuildDigestInput {
  rows: readonly TenderRow[];
  searchProfiles: readonly SearchProfile[];
  companyProfile: CompanyProfile;
  pipeline: DigestPipeline;
  /** Новое — появившееся в базе (`firstSeenAt`) не раньше этого момента, мс. */
  since: number;
  now: number;
  /** Закупки с оценкой ниже в «новые» и «закрываются» не попадают. */
  minFitScore: number;
  /** Базовый адрес ссылок; по умолчанию `appBaseUrl()`. */
  baseUrl?: string;
}

export function buildDigest(input: BuildDigestInput): DigestResult {
  const { now } = input;
  const base = input.baseUrl ?? appBaseUrl();

  const suitable = selectForProfile(input).filter(
    (hit) => hit.row.analysis.fitScore >= input.minFitScore && isOpen(hit.row, now),
  );

  const freshHits = suitable.filter((hit) => {
    const seen = hit.row.tender.firstSeenAt == null ? Number.NaN : Date.parse(hit.row.tender.firstSeenAt);
    return Number.isFinite(seen) && seen >= input.since;
  });
  const fresh = freshHits.slice(0, DIGEST_FRESH_LIMIT).map((hit) => toItem(hit.row, base));

  /* Воронка: рабочие статусы, подача ещё впереди. Статус берётся из воронки человека, а не из строки. */
  const statusOf = (row: TenderRow): PipelineStatus => input.pipeline[row.tender.id]?.status ?? row.pipelineStatus;
  const inFunnel = input.rows.filter((row) => WORKING_STATUSES.includes(statusOf(row)) && isOpen(row, now));
  const bySoonestEnd = (a: TenderRow, b: TenderRow): number => {
    const ea = endMs(a);
    const eb = endMs(b);
    // Срок неизвестен — в конец: «ближайшие сроки» про известные.
    return (Number.isFinite(ea) ? ea : Number.POSITIVE_INFINITY) - (Number.isFinite(eb) ? eb : Number.POSITIVE_INFINITY) || 0;
  };

  /*
    Одна закупка — одна строка письма: показанное в «Новых» не повторяется в «Закрываются»,
    а показанное выше не повторяется в «В работе». Срок подачи виден в каждой строке.
  */
  const shown = new Set(fresh.map((item) => item.id));
  const closingRows = new Map<string, TenderRow>();
  for (const row of inFunnel.filter((r) => closesSoon(r, now))) closingRows.set(row.tender.id, row);
  for (const hit of suitable) if (closesSoon(hit.row, now)) closingRows.set(hit.row.tender.id, hit.row);
  const closing = [...closingRows.values()]
    .filter((row) => !shown.has(row.tender.id))
    .sort(bySoonestEnd)
    .slice(0, DIGEST_CLOSING_LIMIT)
    .map((row) => toItem(row, base));
  for (const item of closing) shown.add(item.id);

  const inWork = inFunnel
    .filter((row) => !shown.has(row.tender.id))
    .sort(bySoonestEnd)
    .slice(0, DIGEST_IN_WORK_LIMIT)
    .map((row) => toItem(row, base));

  return {
    fresh,
    totalFresh: freshHits.length,
    closing,
    inWork,
    isEmpty: fresh.length === 0 && closing.length === 0 && inWork.length === 0,
  };
}

/* ------------------------------- Когда слать ------------------------------- */

/** Дата и минуты суток момента `ms` по часовому поясу клиента. */
function localClock(ms: number, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  // «24» вместо «00» отдаёт часть ICU для полуночи при hour12: false; hourCycle h23 этого не делает, но не рискуем.
  const hour = parts["hour"] === "24" ? 0 : Number(parts["hour"]);
  return { date: `${String(parts["year"])}-${String(parts["month"])}-${String(parts["day"])}`, minutes: hour * 60 + Number(parts["minute"]) };
}

/** Календарная дата момента по часовому поясу: «2026-10-16». */
export function localDateIn(ms: number, timeZone: string): string {
  return localClock(ms, timeZone).date;
}

/**
 * Пора ли слать утреннюю сводку: сводка включена, по поясу клиента время уже не раньше `sendTime`,
 * и сегодня (по тому же поясу) её ещё не отправляли. `lastSentAt` — `app_users.digest_sent_at`.
 */
export function digestDue(settings: ResolvedDigestSettings, lastSentAt: number | null, now: number): boolean {
  if (!settings.enabled) return false;
  const current = localClock(now, settings.timeZone);
  const start = sendTimeMinutes(settings.sendTime);
  // Окно отправки — шесть часов от выбранного времени: воркер, простоявший до ночи,
  // не должен будить человека утренней сводкой в два часа ночи. Пропущенный день просто пропускается.
  if (current.minutes < start || current.minutes >= start + DIGEST_SEND_WINDOW_MIN) return false;
  return lastSentAt === null || localDateIn(lastSentAt, settings.timeZone) !== current.date;
}

/** Сколько минут после выбранного времени сводку ещё можно отправить. */
export const DIGEST_SEND_WINDOW_MIN = 6 * 60;

/**
 * Когда придёт ближайшая сводка: «сегодня» (время ещё не наступило и сегодня не слали) или «завтра».
 * Для строки на странице «Отчёт». Сводка выключена — null.
 */
export function nextDigestDay(settings: ResolvedDigestSettings, lastSentAt: number | null, now: number): "today" | "tomorrow" | null {
  if (!settings.enabled) return null;
  const current = localClock(now, settings.timeZone);
  const sentToday = lastSentAt !== null && localDateIn(lastSentAt, settings.timeZone) === current.date;
  if (!sentToday && current.minutes < sendTimeMinutes(settings.sendTime)) return "today";
  return "tomorrow";
}

/**
 * «16.10 14:00» — срок подачи по часовому поясу клиента. Срок неизвестен или не разбирается — «—».
 * Пояс называется явно: серверный пояс в письме ничего не значит, а в браузере человека он может быть
 * не тем, что выбран для писем.
 */
export function formatDeadline(iso: string | null | undefined, timeZone: string): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return "—";
  /*
    ЕИС отдаёт срок подачи без времени, и он хранится как полночь по UTC. Переведённая в пояс
    клиента, полночь превращалась в «08:00» у каждой закупки — время, которого в извещении нет.
    Такой срок — только дата, и именно та, что в извещении (без сдвига поясом).
  */
  const date = new Date(ms);
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
    return `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("ru-RU", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  const hour = parts["hour"] === "24" ? "00" : parts["hour"];
  return `${String(parts["day"])}.${String(parts["month"])} ${String(hour)}:${String(parts["minute"])}`;
}

/**
 * Профили поиска из данных аккаунта (JSON из базы): записи без списка слов отбрасываются, недостающие
 * поля — пустые, как их достраивает `searchProfileRepository` в браузере. Нужна воркеру: он читает профили
 * сам, не через браузерное хранилище.
 */
export function normalizeSearchProfiles(raw: unknown): SearchProfile[] {
  if (!Array.isArray(raw)) return [];
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const price = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const profiles: SearchProfile[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    if (!Array.isArray(p["keywords"])) continue;
    profiles.push({
      id: typeof p["id"] === "string" ? p["id"] : "",
      name: typeof p["name"] === "string" ? p["name"] : "",
      laws: strings(p["laws"]) as SearchProfile["laws"],
      keywords: strings(p["keywords"]),
      stopWords: strings(p["stopWords"]),
      okpd2Codes: strings(p["okpd2Codes"]),
      regions: strings(p["regions"]),
      customerInns: strings(p["customerInns"]),
      minPrice: price(p["minPrice"]),
      maxPrice: price(p["maxPrice"]),
      onlyOpenForSubmission: p["onlyOpenForSubmission"] === true,
      enabled: p["enabled"] === true,
    });
  }
  return profiles;
}
