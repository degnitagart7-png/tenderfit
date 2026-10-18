import { formatMoscowTime } from "@/lib/moscowTime";

/**
 * Итоговая строка прогона сбора закупок — `sync_jobs.report.note`.
 *
 * Эту строку воркер берёт из вывода `scripts/sync-eis.ts` (она начинается со
 * слова «Готово») и кладёт в отчёт задания; интерфейс показывает её человеку как
 * итог кнопки «Найти новые закупки» и живого поиска. Раньше строка состояла из
 * одних счётчиков и после прогона, где ЕИС отвечала 434 на каждый запрос,
 * звучала «Готово: 353 сохранено, … 0 ошибок»: человек видел успех и не мог
 * узнать, что закупки из ЕИС не обновились.
 *
 * Правило: всё, что сделало прогон неполным, дописывается к строке отдельным
 * сегментом через « · ». Сегменты-предупреждения распознаёт `syncNoteWarnings`,
 * поэтому интерфейс красит такую строку как предупреждение, а не как успех.
 *
 * Модуль чистый и без Node-зависимостей: им пользуются и скрипт на сервере, и
 * клиентские компоненты.
 */

/** Начало сегмента про блокировку ЕИС: по нему интерфейс узнаёт предупреждение. */
export const EIS_BLOCKED_NOTE_PREFIX = "ЕИС временно ограничила доступ";
/** Начало сегмента про источники, не ответившие на все запросы. */
export const FAILED_SOURCES_NOTE_PREFIX = "не ответили: ";

const SEGMENT_SEPARATOR = " · ";

export interface SyncRunNoteInput {
  saved: number;
  documents: number;
  duplicates: number;
  errors: number;
  /** Длительность прогона в секундах, уже отформатированная («280.4»). */
  elapsedSec: string;
  /**
   * ЕИС ограничила доступ в этом прогоне (или карантин шёл с самого начала):
   * момент, после которого затвор разрешит новую попытку. null — блокировки не было.
   */
  eisBlockedRetryAt: number | null;
  /** Названия источников, которые не ответили ни на один запрос прогона (без ЕИС при блокировке). */
  failedSources: readonly string[];
}

/** Сегмент про блокировку ЕИС. */
export function eisBlockedNote(retryAt: number): string {
  return (
    `${EIS_BLOCKED_NOTE_PREFIX} — закупки с неё не обновились, ` +
    `повторим после ${formatMoscowTime(retryAt)} МСК`
  );
}

/**
 * Сегмент про блокировку ЕИС для задания на документацию: сколько закупок остались
 * без загрузки. `retryAt` null — карантин уже снят (сосед получил успешный ответ).
 */
export function eisBlockedDocumentsNote(count: number, retryAt: number | null): string {
  return (
    `${EIS_BLOCKED_NOTE_PREFIX} — документы ${count} закупок не загружены, остались в очереди` +
    (retryAt === null ? ", повторим при следующем прогоне" : `, повторим после ${formatMoscowTime(retryAt)} МСК`)
  );
}

/** Итоговая строка прогона. */
export function buildSyncRunNote(input: SyncRunNoteInput): string {
  const head =
    `Готово: ${input.saved} сохранено, ${input.documents} документов, ` +
    `${input.duplicates} уже было от другого источника, ${input.errors} ошибок, ${input.elapsedSec} с`;
  const segments = [head];
  if (input.eisBlockedRetryAt !== null) segments.push(eisBlockedNote(input.eisBlockedRetryAt));
  if (input.failedSources.length > 0) {
    segments.push(`${FAILED_SOURCES_NOTE_PREFIX}${input.failedSources.join(", ")}`);
  }
  return segments.join(SEGMENT_SEPARATOR);
}

/**
 * Предупреждения, дописанные к итоговой строке: пусто — прогон прошёл полностью.
 * Принимает любую строку отчёта (в том числе чужую или пустую).
 */
export function syncNoteWarnings(note: string | null | undefined): string[] {
  if (!note) return [];
  return note
    .split(SEGMENT_SEPARATOR)
    .slice(1)
    .map((segment) => segment.trim())
    .filter(
      (segment) =>
        segment.startsWith(EIS_BLOCKED_NOTE_PREFIX) || segment.startsWith(FAILED_SOURCES_NOTE_PREFIX),
    );
}
