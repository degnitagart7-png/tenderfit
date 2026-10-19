/**
 * Список «Мои расчёты» на экране «Смета»: одна строка на задание `estimate` того, кто смотрит.
 *
 * Строка лёгкая намеренно. Задание весит много: в `payload.documents` лежат тексты присланных
 * файлов (до 2 млн знаков), в `report` — смета целиком с ресурсными строками (мегабайты). Список
 * же нужен, чтобы найти нужный расчёт глазами, поэтому в нём только то, что видно в строке: когда,
 * что, чем закончилось и сколько вышло. Сам результат открывается по номеру (`GET /api/estimate?jobId=`).
 */

export type EstimateHistoryStatus = "pending" | "processing" | "completed" | "failed";

export interface EstimateHistoryItem {
  readonly id: string;
  readonly status: EstimateHistoryStatus;
  /** Когда поставлено. Строка из базы как есть: она же служит курсором (`nextCursor`) и сохраняет микросекунды. */
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** `estimate` — смета по ведомости; `audit` — проверка сметы заказчика. */
  readonly mode: "estimate" | "audit";
  /** `upload` — по загруженным файлам; `tender` — по закупке из карточки. */
  readonly reason: "upload" | "tender";
  readonly tenderId: string | null;
  /** Наименование объекта, как его ввели. */
  readonly subject: string | null;
  /**
   * Имена загруженных файлов — только имена, содержимое в список не попадает. `null` у расчётов,
   * поставленных до 20.10.2026: имена хранились лишь внутри `payload.documents`, а достать их из базы
   * дешевле, чем весь payload, нельзя (PostgREST не умеет проекцию имён из массива).
   */
  readonly documentNames: readonly string[] | null;
  /** Итог с НДС, ₽; null — расчёт не закончен, это проверка сметы или суммы в отчёте нет. */
  readonly totalRub: number | null;
  /** Краткая причина сбоя; null, если сбоя не было. */
  readonly error: string | null;
}

export interface EstimateHistoryPage {
  readonly items: readonly EstimateHistoryItem[];
  /** Значение `before` для следующей страницы; null — это последняя. */
  readonly nextCursor: string | null;
}

/** Сколько расчётов в одной странице списка по умолчанию и не больше скольки. */
export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_MAX_PAGE_SIZE = 50;

/** Сколько знаков причины сбоя отдаётся в список: в строке нужна суть, а не стек. */
export const HISTORY_ERROR_CHARS = 200;

export const STATUS_LABELS: Record<EstimateHistoryStatus, string> = {
  pending: "в очереди",
  processing: "считается",
  completed: "готово",
  failed: "ошибка",
};

export const MODE_LABELS: Record<EstimateHistoryItem["mode"], string> = {
  estimate: "Смета",
  audit: "Проверка сметы заказчика",
};

/** Идёт ли расчёт: пока да, строка обновляется. */
export function isHistoryItemActive(item: Pick<EstimateHistoryItem, "status">): boolean {
  return item.status === "pending" || item.status === "processing";
}

/** Заголовок строки: объект; нет его — имена файлов; нет и их — номер закупки или общая подпись. */
export function historyTitle(item: EstimateHistoryItem): string {
  const subject = item.subject?.trim() ?? "";
  if (subject !== "") return subject;
  if (item.documentNames !== null && item.documentNames.length > 0) return item.documentNames.join(", ");
  if (item.tenderId !== null) return `Закупка ${item.tenderId}`;
  return item.mode === "audit" ? "Проверка сметы" : "Расчёт по документации";
}

/** «3 файла», «1 файл»: подпись под заголовком; у старых расчётов имён нет — об этом и говорим. */
export function historyFilesLine(item: EstimateHistoryItem): string | null {
  if (item.reason !== "upload") return null;
  const names = item.documentNames;
  if (names === null) return "загруженные файлы";
  if (names.length === 0) return null;
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} и ещё ${String(names.length - 3)}` : shown;
}

/** Слияние свежей первой страницы с уже загруженным списком: без повторов, от нового к старому. */
export function mergeHistory(fresh: readonly EstimateHistoryItem[], known: readonly EstimateHistoryItem[]): EstimateHistoryItem[] {
  const byId = new Map<string, EstimateHistoryItem>();
  for (const item of known) byId.set(item.id, item);
  // Свежие строки перекрывают прежние: у идущего расчёта изменился статус.
  for (const item of fresh) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
}
