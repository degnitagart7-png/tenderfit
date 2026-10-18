import type { TenderRow } from "@/domain/filtering";
import { isSubmissionExpired } from "@/domain/scoring";

/**
 * Свежесть закупки: партия платного поиска и слои для ленты.
 *
 * Партнёр запускает платный поиск и хочет сразу увидеть, что именно нашлось.
 * Отдельной таблицы прогонов в базе нет, но она и не нужна: сервис
 * синхронизации вычисляет одну метку `now` на прогон и пишет её в
 * `tenders.synced_at` каждой строки. Значит все строки одного прогона несут
 * одинаковую метку, а последний платный поиск — это максимум этой метки среди
 * строк с `data_source = 'KONTUR'`.
 *
 * Метку ставит только платный источник, поэтому партия бесплатного прогона
 * здесь не собирается вовсе: у строк бесплатных площадок `synced_at` пуст. Их
 * прогон кнопка ставит в очередь заданий, и его исход виден в журнале
 * `sync_jobs`, а не в слое свежести (см. `src/lib/labels.ts`, слой `LAST_RUN`).
 * Обобщение «последний прогон» на любой источник упирается ровно в это: метку
 * придётся писать всем строкам прогона.
 *
 * Всё считается на клиенте из уже загруженной ленты: ни миграции, ни нового
 * запроса к API не требуется.
 */

/** Окно «на этой неделе» в днях от сегодняшнего момента. */
export const FRESH_WINDOW_DAYS = 7;

/**
 * Допуск на расхождение часов между приложением и базой.
 *
 * Метка партии — это `now` воркера, а `created_at` ставит Postgres. При приёме
 * закупки в базу `created_at` способен оказаться на несколько секунд раньше
 * метки прогона, который её принёс. Без допуска такая закупка выглядела бы
 * «лежала в базе до прогона», то есть новый результат потерялся бы ровно там,
 * где его ищут.
 */
export const NEW_IN_BATCH_SLACK_MS = 60_000;

/**
 * Слой свежести строки ленты.
 *
 * `LAST_RUN` — строка партии последнего прогона Контур.Закупок. `WEEK` —
 * закупка впервые появилась в базе в последние `FRESH_WINDOW_DAYS` дней.
 * `EARLIER` — всё остальное, включая строки без меток времени (неизвестно —
 * значит не «свежая»). `EXPIRED` — срок подачи закрыт: участвовать нельзя,
 * поэтому такие строки уходят вниз независимо от того, насколько они свежие.
 */
export type FreshnessLayer = "LAST_RUN" | "WEEK" | "EARLIER" | "EXPIRED";

/** Партия последнего прогона: метка и строки, которые этот прогон записал. */
export interface LastKonturBatch {
  /** Общая метка `synced_at` всех строк прогона. */
  stamp: string;
  /** Строки прогона в том порядке, в каком их отдала лента. */
  rows: TenderRow[];
}

/** Порядок слоёв для сортировки: чем меньше, тем выше слой. */
const LAYER_RANK: Record<FreshnessLayer, number> = {
  LAST_RUN: 0,
  WEEK: 1,
  EARLIER: 2,
  EXPIRED: 3,
};

/** Слои сверху вниз — тот же порядок, в котором их рисует лента. */
const LAYER_ORDER: FreshnessLayer[] = ["LAST_RUN", "WEEK", "EARLIER", "EXPIRED"];

export function layerRank(layer: FreshnessLayer): number {
  return LAYER_RANK[layer];
}

/**
 * От чего считается свежесть: метка последней партии и момент «сейчас».
 *
 * Контекст передают наружу, а не вычисляют внутри каждой функции, чтобы
 * сортировка ленты и разделители групп в таблице не разъехались: оба обязаны
 * видеть одну и ту же партию и одно и то же «сейчас».
 */
export interface FreshnessContext {
  batchStamp: string | null;
  now: Date;
}

/**
 * Контекст свежести для ленты: партия последнего прогона и текущий момент.
 *
 * Считается от полной ленты, а не от отфильтрованной выдачи: если фильтр
 * убрал все строки Контур, партии в выдаче всё равно нет, и слои честно
 * распределятся по датам первого появления.
 */
export function freshnessContextOf(rows: TenderRow[]): FreshnessContext {
  return {
    batchStamp: selectLastKonturBatch(rows)?.stamp ?? null,
    now: new Date(),
  };
}

/**
 * Находит партию последнего прогона Контур.Закупок.
 *
 * Возвращает null, когда строк Контур нет или ни у одной из них нет метки
 * синхронизации. Молча считать партией «все строки Контур подряд» нельзя: блок
 * «Последний поиск» утверждает, что показал результат конкретного прогона, и
 * без метки это утверждение было бы выдумкой.
 *
 * Прогон ЕИС с более свежей меткой партию не перебивает: это другой источник, и
 * его строки не отвечают на вопрос «что нашёл последний поиск».
 */
export function selectLastKonturBatch(rows: TenderRow[]): LastKonturBatch | null {
  let stamp: string | null = null;
  for (const row of rows) {
    const { tender } = row;
    if (tender.dataSource !== "KONTUR") continue;
    const syncedAt = tender.syncedAt ?? null;
    if (syncedAt === null) continue;
    if (stamp === null || syncedAt > stamp) stamp = syncedAt;
  }
  if (stamp === null) return null;

  return {
    stamp,
    rows: rows.filter((row) => isInBatch(row, stamp)),
  };
}

/** Строка принадлежит партии последнего прогона. */
export function isInBatch(row: TenderRow, stamp: string | null): boolean {
  if (stamp === null) return false;
  return row.tender.dataSource === "KONTUR" && row.tender.syncedAt === stamp;
}

/**
 * Закупка впервые появилась в базе этим прогоном.
 *
 * `created_at` строки, записанной прогоном, совпадает с его меткой с точностью
 * до секунд; строка, которая лежала в базе раньше, остаётся с прежней датой
 * первого появления даже после перезаписи. Без `firstSeenAt` закупка новой не
 * называется — мы не знаем, когда она появилась.
 */
export function isNewInBatch(row: TenderRow, stamp: string): boolean {
  const created = new Date(row.tender.firstSeenAt ?? "").getTime();
  if (Number.isNaN(created)) return false;
  const batchStart = new Date(stamp).getTime() - NEW_IN_BATCH_SLACK_MS;
  if (Number.isNaN(batchStart)) return false;
  return created >= batchStart;
}

/**
 * Слой свежести строки.
 *
 * Истёкший срок проверяется первым: закупка, в которую нельзя подать заявку,
 * не становится ценнее от того, что её нашли минуту назад.
 */
export function freshnessLayer(
  row: TenderRow,
  context: FreshnessContext,
): FreshnessLayer {
  const { tender } = row;
  if (isSubmissionExpired(tender.deadlines.submissionEnd, context.now)) {
    return "EXPIRED";
  }
  if (isInBatch(row, context.batchStamp)) return "LAST_RUN";

  const firstSeen = new Date(tender.firstSeenAt ?? "").getTime();
  if (Number.isNaN(firstSeen)) return "EARLIER";

  const ageDays = (context.now.getTime() - firstSeen) / (1000 * 60 * 60 * 24);
  return ageDays <= FRESH_WINDOW_DAYS ? "WEEK" : "EARLIER";
}

/**
 * Группа слоя свежести: сами строки и то, что про них можно напечатать.
 *
 * Метку партии несёт только слой последнего прогона — у остальных слоёв общей
 * даты нет, и выдуманная дата в заголовке группы была бы ложью.
 */
export interface FreshnessGroup {
  layer: FreshnessLayer;
  stamp: string | null;
  rows: TenderRow[];
}

/**
 * Раскладывает строки по слоям свежести, не меняя порядок внутри слоя.
 *
 * Группировка отделена от сортировки намеренно: ленту сортирует
 * `sortRows`/`sortSearched`, а разделители между слоями рисует таблица, и ей
 * нужен тот же результат, но сгруппированный. Пустые слои не возвращаются —
 * заголовок «На этой неделе» над нулём строк выглядел бы поломкой.
 */
export function groupByFreshness(
  rows: TenderRow[],
  context: FreshnessContext,
): FreshnessGroup[] {
  const byLayer = new Map<FreshnessLayer, TenderRow[]>();
  for (const row of rows) {
    const layer = freshnessLayer(row, context);
    const bucket = byLayer.get(layer);
    if (bucket === undefined) byLayer.set(layer, [row]);
    else bucket.push(row);
  }

  const groups: FreshnessGroup[] = [];
  for (const layer of LAYER_ORDER) {
    const layerRows = byLayer.get(layer);
    if (layerRows === undefined) continue;
    groups.push({
      layer,
      stamp: layer === "LAST_RUN" ? context.batchStamp : null,
      rows: layerRows,
    });
  }
  return groups;
}
