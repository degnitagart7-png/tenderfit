import type { ConsolidatedAnalysis } from "@/domain/analysisConsolidation";
import type { MarginOutlook, MoneyOutlook } from "@/domain/moneyOutlook";
import type { ProfileMatch } from "@/domain/profileMatch";
import type { AnalysisFinding } from "@/types/database";
import { pluralRu } from "@/utils/format";

/**
 * Выжимка глубокого анализа для беглого чтения: короткие имена документов, срок
 * запроса разъяснений, запас по цене и скоркарта по направлениям.
 *
 * Зачем. Результат разбора на живой закупке — десятки выводов, 25 рисков одной
 * строкой через «;», шесть противоречий с именами файлов в полторы строки. Человек,
 * который пробегает глазами, должен за десять секунд понять: идти или нет, почему,
 * что сделать и до какого числа. Здесь только арифметика и подписи — без React и
 * без обращения к часам: «сейчас» передаётся параметром, поэтому тесты не зависят
 * от дня запуска.
 */

const DAY_MS = 86_400_000;

/** Запрос на разъяснения подаётся не позднее чем за три дня до окончания подачи (44-ФЗ). */
export const CLARIFY_DAYS_BEFORE = 3;

/* ----------------------------------- Даты ----------------------------------- */

/*
  Даты печатаются по Москве, как и все сроки закупок в интерфейсе (`formatDateTime`):
  срок подачи в ЕИС — московское время, и «20.10» у иркутянина не должно стать «19.10».
*/
const MSK_DATE = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function mskParts(date: Date): { day: string; month: string; year: string } {
  const parts = Object.fromEntries(MSK_DATE.formatToParts(date).map((part) => [part.type, part.value]));
  return { day: parts.day ?? "", month: parts.month ?? "", year: parts.year ?? "" };
}

/** «20.10» — для строк, где год очевиден. */
export function formatDayMonth(date: Date): string {
  const { day, month } = mskParts(date);
  return `${day}.${month}`;
}

/** «30.11.2026». */
export function formatDayMonthYear(date: Date): string {
  const { day, month, year } = mskParts(date);
  return `${day}.${month}.${year}`;
}

function parseIso(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso.trim() === "") return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Целых дней от `now` до даты, округление вверх; в прошлом — 0 или меньше. */
export function daysUntil(iso: string | null, now: Date): number | null {
  const date = parseIso(iso);
  if (date === null) return null;
  const days = Math.ceil((date.getTime() - now.getTime()) / DAY_MS);
  return days === 0 ? 0 : days; // без «-0»
}

export interface ClarifyDeadline {
  /** Последний день, когда запрос на разъяснения ещё можно подать. */
  date: Date;
  /** Сколько дней осталось, не меньше нуля. */
  daysLeft: number;
  passed: boolean;
}

/** Срок запроса разъяснений: окончание подачи минус три календарных дня. */
export function clarificationDeadline(submissionEnd: string | null, now: Date): ClarifyDeadline | null {
  const end = parseIso(submissionEnd);
  if (end === null) return null;
  const date = new Date(end.getTime() - CLARIFY_DAYS_BEFORE * DAY_MS);
  const left = Math.ceil((date.getTime() - now.getTime()) / DAY_MS);
  return { date, daysLeft: Math.max(0, left), passed: date.getTime() < now.getTime() };
}

/* ---------------------------------- Деньги ---------------------------------- */

/** Доля в процентах: «6,9 %» до десяти, дальше целые — как в блоке «Деньги». */
export function formatPct(share: number): string {
  return `${(share * 100).toFixed(share * 100 < 10 ? 1 : 0).replace(".", ",")} %`;
}

/**
 * Порог снижения цены: «−19,9 %». Округляется вниз и всегда с десятой долей: порог
 * «без убытка» округлением вверх до «−20 %» заставил бы поверить в запас, которого
 * на 0,1 п. п. нет.
 */
export function cutLabel(share: number): string {
  const tenths = Math.floor(share * 1000 + 1e-9) / 10;
  return `−${tenths.toFixed(1).replace(".", ",")} %`;
}

/** Сумма коротко: «495 тыс. ₽», «1,2 млн ₽», «3 млрд ₽». */
export function compactRub(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = [
    { limit: 1e9, suffix: "млрд" },
    { limit: 1e6, suffix: "млн" },
    { limit: 1e3, suffix: "тыс." },
  ];
  let index = units.findIndex((unit) => value >= unit.limit);
  if (index === -1) return `${String(Math.round(value))} ₽`;
  let scaled = value / units[index]!.limit;
  // 999,6 тыс. после округления — уже «1 млн», а не «1000 тыс.».
  if (Math.round(scaled) >= 1000 && index > 0) {
    index -= 1;
    scaled = value / units[index]!.limit;
  }
  const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${String(rounded).replace(".", ",")} ${units[index]!.suffix} ₽`;
}

export interface PriceCushion {
  /** До какого снижения цены остаётся сметная прибыль, доля от стоимости по смете. */
  profitShare: number;
  /** До какого снижения нет убытка по смете: прибыль и накладные, доля от стоимости по смете. */
  breakEvenShare: number;
}

/** Те же доли, что считает `computeMoneyOutlook` для сценариев снижения. */
export function priceCushion(margin: MarginOutlook | null): PriceCushion | null {
  if (margin === null || !(margin.base > 0)) return null;
  return {
    profitShare: margin.profit / margin.base,
    breakEvenShare: (margin.profit + margin.overhead) / margin.base,
  };
}

/* ------------------------------ Причина вердикта ----------------------------- */

/**
 * «Обнаружены риски: A; B; C» → заголовок и пункты. История вердикта хранит причину
 * одной строкой; в 25 пунктов через «;» она нечитаема, а списком — читается.
 */
export function splitVerdictReason(reason: string): { lead: string; items: string[] } {
  const text = reason.trim();
  const colon = text.indexOf(":");
  if (colon === -1) return { lead: text, items: [] };
  const lead = text.slice(0, colon).trim();
  const items = [
    ...new Set(
      text
        .slice(colon + 1)
        .split(";")
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    ),
  ];
  return { lead, items };
}

/* ------------------------------ Имена документов ----------------------------- */

const EXTENSION = /\.(?:docx|doc|pdf|xlsx|xls|html|zip|rtf|txt)$/i;
const MAX_NAME = 40;

/** Короткое понятное имя документа: «Извещение», «Смета (прил. к ТЗ)», «Проект контракта». */
export function shortDocName(filename: string): string {
  const name = filename.trim();
  if (name === "") return "документ";
  const lower = name.toLowerCase();
  // Границы слов — «не буквой»: в JS `\b` знает только латиницу.
  const isTz = /(?<![а-яёa-z])тз(?![а-яёa-z])/iu.test(name);

  if (/print-form/.test(lower) || lower.includes("извещени")) return "Извещение";
  if (lower.includes("обоснование нмцк") || lower.includes("обоснование начальной")) return "Обоснование НМЦК";
  if (lower.includes("смет") || lower.includes("лср") || lower.includes("локальн")) {
    return /описани[а-яё]*\s+объекта/.test(lower) || lower.includes("техническ") ? "Смета (прил. к ТЗ)" : "Смета";
  }
  if (
    lower.includes("проект контракта") ||
    lower.includes("проект договора") ||
    lower.includes("контракт") ||
    lower.includes("договор")
  ) {
    return lower.includes("приложени") ? "Приложение к контракту" : "Проект контракта";
  }
  if (lower.includes("описание объекта") || lower.includes("техническое задание") || isTz) {
    return "Описание объекта (ТЗ)";
  }
  if (lower.includes("требования к заявке") || lower.includes("требования к содержанию")) {
    return "Требования к заявке";
  }

  const bare = name.replace(EXTENSION, "").trim();
  if (bare === "") return "документ";
  return bare.length > MAX_NAME ? `${bare.slice(0, MAX_NAME - 1).trimEnd()}…` : bare;
}

/* --------------------------------- Скоркарта --------------------------------- */

export type ScorecardKey = "access" | "docs" | "time" | "money" | "cushion" | "contract";
export type ScorecardStatus = "good" | "warn" | "bad" | "neutral";

export interface ScorecardItem {
  key: ScorecardKey;
  title: string;
  status: ScorecardStatus;
  value: string;
  note: string;
  /** id секции на вкладке «Выводы», к которой ведёт плитка. */
  anchor: string;
}

export interface ScorecardInput {
  match: ProfileMatch | null;
  findings: readonly AnalysisFinding[];
  consolidation: ConsolidatedAnalysis | null;
  documentsTotal: number;
  documentsWithText: number;
  documentsSkipped: number;
  outlook: MoneyOutlook | null;
  price: number | null;
  submissionEnd: string | null;
  now: Date;
}

/** Доля замороженных денег от НМЦК, выше которой участие становится заметной нагрузкой на оборотку. */
const HEAVY_FROZEN_SHARE = 0.1;
/** Подача «горит», когда до неё осталось не больше стольких дней. */
const URGENT_DAYS = 3;

const noun = {
  conflict: ["противоречие", "противоречия", "противоречий"] as [string, string, string],
  risk: ["риск", "риска", "рисков"] as [string, string, string],
};

function accessItem(match: ProfileMatch | null): ScorecardItem {
  const anchor = "analysis-access";
  if (match === null || match.verdict === "NO_PROFILE") {
    return {
      key: "access",
      title: "Допуск",
      status: "neutral",
      value: "Профиль не заполнен",
      note: "Заполните — сверим требования",
      anchor,
    };
  }
  if (match.checks.length === 0) {
    return { key: "access", title: "Допуск", status: "neutral", value: "Требований не найдено", note: "Сверять нечего", anchor };
  }
  const notMet = match.checks.find((c) => c.status === "NOT_MET");
  const toCheck = match.checks.find((c) => c.status === "CHECK");
  return {
    key: "access",
    title: "Допуск",
    status: match.notMet > 0 ? "bad" : match.toCheck > 0 ? "warn" : "good",
    value: `${String(match.met)} из ${String(match.checks.length)} требований`,
    note: notMet?.finding.title ?? toCheck?.finding.title ?? "Всё закрыто профилем",
    anchor,
  };
}

function docsItem(input: ScorecardInput): ScorecardItem {
  const { consolidation, documentsTotal, documentsWithText, documentsSkipped } = input;
  const anchor = "analysis-conflicts";
  const read = `${String(documentsWithText)} из ${String(documentsTotal)} файлов`;
  if (consolidation === null) {
    return {
      key: "docs",
      title: "Документация",
      status: "neutral",
      value: `${read} прочитано`,
      note: documentsSkipped > 0 ? `пропущено ${String(documentsSkipped)}` : "сводки по документам нет",
      anchor,
    };
  }
  const conflicts = consolidation.conflicts.length;
  return {
    key: "docs",
    title: "Документация",
    status: conflicts > 0 || documentsSkipped > 0 ? "warn" : "good",
    value: conflicts > 0 ? `${String(conflicts)} ${pluralRu(conflicts, noun.conflict)}` : "Противоречий нет",
    note: `прочитано ${read}`,
    anchor,
  };
}

function timeItem(input: ScorecardInput): ScorecardItem {
  const { submissionEnd, consolidation, outlook, now } = input;
  const anchor = "analysis-questions";
  const end = parseIso(submissionEnd);
  const workEnd = parseIso(consolidation?.facts.work_end ?? null);
  const winter = (outlook?.winter ?? null) !== null;
  const noteParts: string[] = [];
  if (workEnd !== null) noteParts.push(`работы до ${formatDayMonthYear(workEnd)}`);
  if (winter) noteParts.push("зима");
  const note = noteParts.length > 0 ? noteParts.join(", ") : "срок работ не найден";

  if (end === null) {
    return { key: "time", title: "Сроки", status: "neutral", value: "Дата подачи не указана", note, anchor };
  }
  const passed = end.getTime() < now.getTime();
  const days = daysUntil(submissionEnd, now);
  if (passed) {
    return { key: "time", title: "Сроки", status: "bad", value: `Подача была ${formatDayMonth(end)}`, note, anchor };
  }
  const value = `Подача до ${formatDayMonth(end)}${days !== null ? ` · ${String(days)} дн.` : ""}`;
  const status: ScorecardStatus = winter || (days !== null && days <= URGENT_DAYS) ? "warn" : "good";
  return { key: "time", title: "Сроки", status, value, note, anchor };
}

function moneyItem(input: ScorecardInput): ScorecardItem {
  const { outlook, price } = input;
  const anchor = "analysis-money";
  const peak = outlook?.frozenPeak ?? null;
  if (outlook === null || peak === null) {
    return { key: "money", title: "Деньги", status: "neutral", value: "Нет данных об обеспечении", note: "", anchor };
  }
  const noteParts: string[] = [];
  if (outlook.advancePercent !== null) {
    noteParts.push(outlook.advancePercent > 0 ? `аванс ${String(outlook.advancePercent).replace(".", ",")} %` : "аванса нет");
  }
  if (outlook.paymentDays !== null) noteParts.push(`оплата ${String(outlook.paymentDays)} дн.`);
  const noAdvance = outlook.advancePercent === 0;
  const heavy = price !== null && price > 0 && peak / price > HEAVY_FROZEN_SHARE;
  return {
    key: "money",
    title: "Деньги",
    status: noAdvance || heavy ? "warn" : "good",
    value: `Заморозится до ${compactRub(peak)}`,
    note: noteParts.join(" · "),
    anchor,
  };
}

function cushionItem(outlook: MoneyOutlook | null): ScorecardItem {
  const anchor = "analysis-money";
  const cushion = priceCushion(outlook?.margin ?? null);
  if (cushion === null) {
    return {
      key: "cushion",
      title: "Запас по цене",
      status: "neutral",
      value: "Нет сметы заказчика",
      note: "запас при снижении не посчитать",
      anchor,
    };
  }
  const { profitShare, breakEvenShare } = cushion;
  return {
    key: "cushion",
    title: "Запас по цене",
    status: breakEvenShare < 0.1 ? "bad" : breakEvenShare < 0.2 ? "warn" : "good",
    value: `без убытка до ${cutLabel(breakEvenShare)}`,
    note: `прибыль сохраняется до ${cutLabel(profitShare)}`,
    anchor,
  };
}

function contractItem(findings: readonly AnalysisFinding[]): ScorecardItem {
  const risks = findings.filter((f) => f.category === "risk");
  const high = risks.filter((f) => f.severity === "high").length;
  return {
    key: "contract",
    title: "Договор",
    status: high >= 5 ? "bad" : high >= 1 ? "warn" : "good",
    value: `${String(risks.length)} ${pluralRu(risks.length, noun.risk)}`,
    note: high > 0 ? `высоких ${String(high)}` : "высоких нет",
    anchor: "analysis-risks",
  };
}

/** Шесть направлений: светофор по каждому, чтобы глаз сразу нашёл красное и жёлтое. */
export function analysisScorecard(input: ScorecardInput): ScorecardItem[] {
  return [
    accessItem(input.match),
    docsItem(input),
    timeItem(input),
    moneyItem(input),
    cushionItem(input.outlook),
    contractItem(input.findings),
  ];
}

/* ------------------------------- Что сделать ------------------------------- */

export interface NextStep {
  key: "ask" | "submit" | "requirement";
  label: string;
  /** brick — срок горит или уже прошёл. */
  tone: "neutral" | "brick";
  /** id секции, куда ведёт шаг; null — шаг без перехода. */
  anchor: string | null;
}

export interface NextStepsInput {
  questionsCount: number;
  clarifyBy: ClarifyDeadline | null;
  submissionEnd: string | null;
  scorecard: readonly ScorecardItem[];
  now: Date;
}

/** Срок запроса, когда он «горит»: остался день или меньше. */
const URGENT_CLARIFY_DAYS = 1;

/**
 * До трёх коротких шагов под решением: что сделать и до какого числа. Только то, что
 * следует из данных: вопросов нет — нет и шага «задать вопросы».
 */
export function nextSteps(input: NextStepsInput): NextStep[] {
  const { questionsCount, clarifyBy, submissionEnd, scorecard, now } = input;
  const steps: NextStep[] = [];

  if (questionsCount > 0 && !(clarifyBy?.passed ?? false)) {
    const count = `${String(questionsCount)} ${pluralRu(questionsCount, ["вопрос", "вопроса", "вопросов"])}`;
    steps.push({
      key: "ask",
      label: `Задать ${count} заказчику${clarifyBy === null ? "" : ` до ${formatDayMonth(clarifyBy.date)}`}`,
      tone: clarifyBy !== null && clarifyBy.daysLeft <= URGENT_CLARIFY_DAYS ? "brick" : "neutral",
      anchor: "analysis-questions",
    });
  }

  const end = parseIso(submissionEnd);
  if (end !== null) {
    if (end.getTime() < now.getTime()) {
      steps.push({ key: "submit", label: "Срок подачи заявок прошёл", tone: "brick", anchor: null });
    } else {
      const days = daysUntil(submissionEnd, now) ?? 0;
      steps.push({
        key: "submit",
        label: `Подать заявку до ${formatDayMonth(end)} · ${days > 0 ? `осталось ${String(days)} дн.` : "осталось меньше суток"}`,
        tone: "neutral",
        anchor: null,
      });
    }
  }

  const access = scorecard.find((item) => item.key === "access");
  if (access?.status === "bad") {
    steps.push({ key: "requirement", label: `Закрыть требование: ${access.note}`, tone: "neutral", anchor: access.anchor });
  }
  return steps;
}

/**
 * Риски договора по глубокому анализу — для числа на вкладке страницы «Риски договора».
 * Вкладка раньше считала только быструю оценку по извещению (обычно 1–2 риска), а анализ
 * документации рядом показывал два десятка: человек видел два разных числа про одно и то же.
 * Пока разбор не закончен — null: вкладка остаётся при быстрой оценке.
 */
export function deepRiskCounts(
  summary: { state: string; findings: readonly Pick<AnalysisFinding, "category" | "severity">[] } | null,
): { total: number; high: number } | null {
  if (summary === null || summary.state !== "completed") return null;
  const risks = summary.findings.filter((f) => f.category === "risk");
  return { total: risks.length, high: risks.filter((f) => f.severity === "high").length };
}
