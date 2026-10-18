import { isPriceKnown } from "@/domain/entities";
import type { PipelineStatus, TenderVerdict } from "@/domain/enums";
import type { TenderRow } from "@/domain/filtering";
import { isRub } from "@/domain/priceVisibility";
import { URGENT_DEADLINE_DAYS } from "@/domain/scoring";

/**
 * Логика экрана «Сегодня»: что взято в работу, что показать первым и на
 * какую сумму. Модуль чистый — ни сети, ни хранилища, время передаётся.
 */

/**
 * Статусы воронки, означающие «закупка у меня в работе».
 *
 * «Новые» сюда не входят: лента приносит их сама, и считать работой то, чего
 * человек не выбирал, — значит показывать на первом экране цифру, к которой он
 * не имеет отношения. Завершённые («Выиграно», «Проиграно», «Пропущено») тоже
 * не в работе: по ним делать уже нечего.
 */
export const IN_WORK_STATUSES: readonly PipelineStatus[] = [
  "INTERESTING",
  "ANALYZING",
  "PREPARING_APPLICATION",
  "SUBMITTED",
] as const;

export function isInWork(status: PipelineStatus): boolean {
  return IN_WORK_STATUSES.includes(status);
}

/** Горизонт, на котором близость срока вообще влияет на порядок выдачи. */
const URGENCY_HORIZON_DAYS = 30;

/**
 * Насколько сильно близкий срок поднимает закупку: при сроке «завтра» оценка
 * растёт в полтора раза. Больше брать нельзя — иначе заведомо неподходящая
 * закупка с горящим сроком обгонит подходящую, и совет станет вредным.
 */
const URGENCY_WEIGHT = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Доля срочности 0..1: 1 — подача закрывается сейчас, 0 — позже горизонта. */
export function urgencyFactor(submissionEnd: string, now: Date): number {
  const daysLeft = (new Date(submissionEnd).getTime() - now.getTime()) / DAY_MS;
  if (Number.isNaN(daysLeft)) return 0;
  if (daysLeft <= 0) return 1;
  if (daysLeft >= URGENCY_HORIZON_DAYS) return 0;
  return 1 - daysLeft / URGENCY_HORIZON_DAYS;
}

/**
 * Приоритет строки в блоке «Лучшее из нового»: связка срока и соответствия.
 *
 * Соответствие остаётся основой, срок только усиливает его. Складывать их
 * поровну нельзя: получилось бы, что закупка с оценкой 20 и подачей завтра
 * стоит выше закупки с оценкой 70 и подачей через неделю — а это прямо
 * противоположно тому, ради чего человек открывает экран.
 */
export function todayRank(row: TenderRow, now: Date): number {
  const urgency = urgencyFactor(row.tender.deadlines.submissionEnd, now);
  return row.analysis.fitScore * (1 + URGENCY_WEIGHT * urgency);
}

/** Сумма НМЦК по закупкам, у которых цена опубликована в рублях. */
export interface BudgetSummary {
  /** Сумма рублёвых НМЦК. */
  total: number;
  /** Сколько закупок вошло в сумму. */
  counted: number;
  /** Сколько осталось за её пределами: без цены или в другой валюте. */
  skipped: number;
}

/**
 * Масштаб денег в подборке.
 *
 * Валютные закупки и закупки без НМЦ в сумму не входят и считаются отдельно:
 * пересчитывать доллары в рубли по выдуманному курсу — значит печатать на
 * первом экране число, которого нет ни в одном извещении. Пропущенные
 * показываются рядом, чтобы сумма не выглядела полной, когда это не так.
 */
export function summarizeBudget(rows: readonly TenderRow[]): BudgetSummary {
  let total = 0;
  let counted = 0;
  let skipped = 0;
  for (const row of rows) {
    const { price, currency } = row.tender.financial;
    if (isPriceKnown(price) && isRub(currency)) {
      total += price;
      counted += 1;
    } else {
      skipped += 1;
    }
  }
  return { total, counted, skipped };
}

/* ============================ Вердикты ============================ */

/** Порядок вердиктов в полосе и легенде: от «берём» к «не берём». */
export const VERDICT_ORDER: readonly TenderVerdict[] = [
  "RECOMMENDED",
  "MANUAL_REVIEW",
  "NOT_RECOMMENDED",
] as const;

export interface VerdictShare {
  verdict: TenderVerdict;
  count: number;
  /** Доля от всех строк, 0..1. При пустом списке — 0, а не NaN. */
  share: number;
}

/**
 * Доли вердиктов для полосы на экране.
 *
 * Нулевой вердикт остаётся в списке: легенда обязана назвать его, иначе
 * «0 неподходящих» и «неподходящих не посчитали» выглядят одинаково. Рисовать
 * сегмент для него или нет — решает экран по `count`.
 */
export function summarizeVerdicts(rows: readonly TenderRow[]): {
  total: number;
  shares: VerdictShare[];
} {
  const counts: Record<TenderVerdict, number> = {
    RECOMMENDED: 0,
    MANUAL_REVIEW: 0,
    NOT_RECOMMENDED: 0,
  };
  for (const row of rows) counts[row.analysis.verdict] += 1;
  const total = rows.length;
  return {
    total,
    shares: VERDICT_ORDER.map((verdict) => ({
      verdict,
      count: counts[verdict],
      share: total === 0 ? 0 : counts[verdict] / total,
    })),
  };
}

/* ======================= Причины отказа ======================= */

/**
 * Причина отказа одной строкой.
 *
 * Берём первый стоп-фактор: он же показывается в карточке закупки, поэтому
 * объяснение на двух экранах не расходится. Если стоп-фактора нет (отказ по
 * оценке соответствия), говорим об этом прямо, а не выдумываем причину.
 */
export function rejectionReason(row: TenderRow): string {
  return (
    row.analysis.hardBlockers[0]?.reason ??
    row.analysis.negativeFactors[0]?.text ??
    "Не проходит по условиям профиля"
  );
}

export interface RejectionReasonCount {
  reason: string;
  count: number;
  /** Доля от всех переданных отклонённых закупок, 0..1. */
  share: number;
}

/**
 * Главные причины отказа: что в условиях поиска исправлять первым.
 *
 * Одна самая частая причина скрывала картину: при 60/40 между двумя
 * блокерами экран говорил только о первом. Доля считается от всех
 * отклонённых, а не от показанных, поэтому столбики честно не дают 100%, а
 * хвост из редких причин вынесен в `otherCount`. При равенстве счётчиков
 * порядок — по первому появлению, чтобы список не прыгал между срезами.
 */
export function tallyRejectionReasons(
  rejected: readonly TenderRow[],
  limit: number,
): { total: number; reasons: RejectionReasonCount[]; otherCount: number } {
  const tally = new Map<string, number>();
  for (const row of rejected) {
    const reason = rejectionReason(row);
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  const total = rejected.length;
  const sorted = [...tally.entries()]
    // Array.prototype.sort стабилен, поэтому равные счётчики сохраняют порядок появления.
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count, share: total === 0 ? 0 : count / total }));
  const reasons = sorted.slice(0, Math.max(0, limit));
  const shown = reasons.reduce((sum, item) => sum + item.count, 0);
  return { total, reasons, otherCount: total - shown };
}

/* ===================== Сроки: по дням и «Горит» ===================== */

/**
 * Сколько календарных суток от сегодняшних до дня подачи; null — дата не
 * разобрана. Считается по локальной дате, как и формат дат на экране: срок
 * «сегодня в 23:00» должен лежать в столбике «сегодня», а не «через 8 часов».
 * Разность берётся по UTC-полуночам компонентов даты, поэтому сдвиг часового
 * пояса и переход на летнее время не добавляют лишних суток.
 */
export function calendarDayOffset(submissionEnd: string, now: Date): number | null {
  const end = new Date(submissionEnd);
  if (Number.isNaN(end.getTime())) return null;
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((endDay - nowDay) / DAY_MS);
}

/** Сколько всего дней показывает гистограмма подачи. */
export const DEADLINE_HISTOGRAM_DAYS = 14;

/** Тон столбика: сегодня, горящие дни и остальные. */
export type DeadlineDayTone = "today" | "urgent" | "later";

/**
 * Тон дня по сдвигу от сегодня.
 *
 * Граница горящих — включительно `URGENT_DEADLINE_DAYS`: окно «Горит» меряется
 * часами (до 72 ч), и срок через 70 часов может лечь на четвёртые календарные
 * сутки. Столбик этого дня обязан быть горячим, иначе закупка из «Горит» на
 * диаграмме выглядела бы спокойной.
 */
export function deadlineDayTone(offset: number): DeadlineDayTone {
  if (offset <= 0) return "today";
  return offset <= URGENT_DEADLINE_DAYS ? "urgent" : "later";
}

export interface DeadlineDay {
  /** 0 — сегодня, 1 — завтра и так далее. */
  offset: number;
  /** Локальная полночь этого дня. */
  date: Date;
  /** Сколько открытых не отклонённых закупок закрывают подачу в этот день. */
  count: number;
  tone: DeadlineDayTone;
}

/**
 * Гистограмма сроков подачи на ближайшие `days` суток.
 *
 * Считает только то, что ещё можно подать: срок уже прошёл — закупка не в
 * счёт, как и в остальном экране, а отклонённые по профилю не нужны там, где
 * человек решает, что успеть. Закупки позже окна не теряются, а попадают в
 * `beyond`, чтобы подпись диаграммы не врала про «всего открытых».
 */
export function deadlineHistogram(
  rows: readonly TenderRow[],
  now: Date,
  days: number = DEADLINE_HISTOGRAM_DAYS,
): { days: DeadlineDay[]; inWindow: number; beyond: number } {
  const counts = new Array<number>(days).fill(0);
  let beyond = 0;
  for (const row of rows) {
    if (row.analysis.verdict === "NOT_RECOMMENDED") continue;
    const end = row.tender.deadlines.submissionEnd;
    if (new Date(end).getTime() <= now.getTime()) continue;
    const offset = calendarDayOffset(end, now);
    if (offset === null || offset < 0) continue;
    if (offset < days) counts[offset] = (counts[offset] ?? 0) + 1;
    else beyond += 1;
  }
  const result = counts.map((count, offset): DeadlineDay => ({
    offset,
    date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset),
    count,
    tone: deadlineDayTone(offset),
  }));
  return { days: result, inWindow: counts.reduce((a, b) => a + b, 0), beyond };
}

/** Подпись дня в «Горит»: ближайшие три — словами, дальше — счётом. */
export function urgentDayLabel(offset: number): string {
  if (offset <= 0) return "Сегодня";
  if (offset === 1) return "Завтра";
  if (offset === 2) return "Послезавтра";
  return `Через ${offset} дн.`;
}

export interface UrgentGroup {
  offset: number;
  label: string;
  rows: TenderRow[];
}

/**
 * Горящие закупки по дням подачи.
 *
 * Внутри группы и между группами порядок по сроку: в начале то, что закрывается
 * раньше. Строки без разобранной даты в группы не попадают — их не бывает среди
 * горящих (окно меряется той же датой), но молча класть их в «Сегодня» нельзя.
 */
export function groupUrgentByDay(rows: readonly TenderRow[], now: Date): UrgentGroup[] {
  const byOffset = new Map<number, TenderRow[]>();
  const time = (row: TenderRow) => new Date(row.tender.deadlines.submissionEnd).getTime();
  for (const row of [...rows].sort((a, b) => time(a) - time(b))) {
    const offset = calendarDayOffset(row.tender.deadlines.submissionEnd, now);
    if (offset === null) continue;
    const day = Math.max(0, offset);
    byOffset.set(day, [...(byOffset.get(day) ?? []), row]);
  }
  return [...byOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([offset, group]) => ({ offset, label: urgentDayLabel(offset), rows: group }));
}

/**
 * Сколько часов осталось до подачи, округляя вверх, но не меньше одного:
 * «0 ч» у закупки, которая ещё принимает заявки, читалось бы как «уже поздно».
 * null — срок не разобран или уже прошёл.
 */
export function hoursUntil(submissionEnd: string, now: Date): number | null {
  const end = new Date(submissionEnd).getTime();
  if (Number.isNaN(end)) return null;
  const diff = end - now.getTime();
  if (diff <= 0) return null;
  return Math.max(1, Math.ceil(diff / (60 * 60 * 1000)));
}
