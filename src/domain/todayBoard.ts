import { isPriceKnown } from "@/domain/entities";
import type { PipelineStatus } from "@/domain/enums";
import type { TenderRow } from "@/domain/filtering";
import { isRub } from "@/domain/priceVisibility";

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
