import type { Tender } from "@/domain/entities";

/**
 * Повторное использование карточек процедур Росэлторга и Фабриканта.
 *
 * Зачем. Эти две площадки отдают в выдаче только лот, а полный набор лотов, цену,
 * срок и регион добирают отдельным запросом карточки на каждую процедуру (у
 * Фабриканта — по странице на пять лотов). Один и тот же набор процедур повторяется
 * и между профилями прогона, и между прогонами раз в два часа: прогон 11.10.2026
 * потратил 72 и 119 секунд на карточки, которые в большинстве уже читались утром.
 *
 * Что именно запоминается. Не строка таблицы `tenders`, а результат маппинга
 * карточки в `Tender` ДО отбора по профилю. Строка таблицы для этого не годится по
 * двум причинам: (1) её `updated_at` обновляется при каждой перезаписи, а плановая
 * очистка пересоздаёт строки источника каждый прогон — по `updated_at` процедура
 * «всегда свежая» и карточку не перечитали бы никогда; (2) в таблице нет
 * процедур, отброшенных отбором профиля (регион и цена у Фабриканта известны
 * только из карточки, и отбрасывается большинство), а платить за них запросом
 * приходится в каждом прогоне. Запись кэша несёт собственную отметку времени
 * чтения карточки и при повторном использовании её не продлевает: срок жизни
 * считается от настоящего запроса.
 */

/**
 * Сколько живёт прочитанная карточка. Дольше суток не верим: срок приёма заявок и
 * цену заказчик может изменить, а строка выдачи Фабриканта этих изменений не
 * показывает вовсе. Сутки — граница, до которой устаревший срок в ленте допустим;
 * просроченный по кэшу срок перечитывается всегда (см. адаптеры).
 */
export const CARD_REUSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Версия формата записи кэша. Правка маппинга карточки в `Tender` меняет форму
 * записи; несовпавшая версия значит «кэша нет», и карточки читаются заново.
 */
export const CARD_CACHE_SCHEMA = 1;

/** Прочитанная карточка процедуры в виде, пригодном для повторного использования. */
export interface CachedCard {
  /** Момент настоящего запроса карточки, мс. При повторном использовании не меняется. */
  readonly fetchedAt: number;
  /** Все ли лоты процедуры получены: у неполного набора цена не публикуется, его перечитывают. */
  readonly complete: boolean;
  /** Закупка ДО отбора по профилю: отбор идёт заново, фильтры у профилей разные. */
  readonly tender: Tender;
  /**
   * Самый поздний срок приёма заявок среди лотов, мс; null — хотя бы один срок не
   * напечатан или не читается. Нужен Фабриканту: срок виден только в карточке, а
   * процедура жива, пока жив хотя бы один лот.
   */
  readonly lastLotEndMs: number | null;
}

/** Хранилище прочитанных карточек одной площадки; ключ — номер процедуры на площадке. */
export interface ProcedureCardCache {
  get(procedureNumber: string): CachedCard | undefined;
  set(procedureNumber: string, card: CachedCard): void;
}

/** Хранилище в памяти: для тестов и для прогонов без доступа к диску. */
export function createMemoryCardCache(): ProcedureCardCache & {
  readonly entries: Map<string, CachedCard>;
} {
  const entries = new Map<string, CachedCard>();
  return {
    entries,
    get: (number) => entries.get(number),
    set: (number, card) => {
      entries.set(number, card);
    },
  };
}

/** Карточка ещё свежа: прочитана не раньше, чем `maxAgeMs` назад. `maxAgeMs` ≤ 0 — повторное использование выключено. */
export function isCardFresh(
  card: Pick<CachedCard, "fetchedAt">,
  nowMs: number,
  maxAgeMs: number = CARD_REUSE_MAX_AGE_MS,
): boolean {
  if (maxAgeMs <= 0) return false;
  const age = nowMs - card.fetchedAt;
  return age >= 0 && age < maxAgeMs;
}

/**
 * Окно свежести из переменной окружения `SYNC_CARD_REUSE_HOURS`.
 * Не задана или не число — сутки; 0 — повторное использование выключено (аварийный
 * выключатель, если площадка начнёт менять карточки чаще, чем мы их читаем).
 */
export function cardReuseMaxAgeMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return CARD_REUSE_MAX_AGE_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return CARD_REUSE_MAX_AGE_MS;
  return Math.round(hours * 60 * 60 * 1000);
}

/** Текст для сравнения предметов: регистр, «ё» и пробелы роли не играют. */
export function normalizeLotText(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * Один и тот же момент, записанный двумя строками. Пустая или нечитаемая дата
 * равной ничему не считается: «не знаю» не доказывает, что срок не менялся.
 */
export function sameInstant(left: string, right: string): boolean {
  if (left.trim() === "" || right.trim() === "") return false;
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  return !Number.isNaN(a) && !Number.isNaN(b) && a === b;
}
