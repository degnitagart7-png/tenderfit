import type { SyncJobKind, SyncJobPayload, SyncJobRow } from "@/types/database";

/**
 * Потолок номеров в одном задании.
 *
 * Одно нажатие кнопки приносит не больше 150 записей (3 ключевых слова ×
 * 1 страница × 50), поэтому 200 — запас, а не ограничение рабочего случая.
 * Потолок нужен не ради базы, а ради воркера: задание на тысячу номеров
 * выполнялось бы часами и блокировало очередь, а партнёр видел бы «в работе»
 * без движения.
 */
export const MAX_REG_NUMBERS_PER_JOB = 200;

const SYNC_JOB_KINDS: readonly SyncJobKind[] = ["documents", "full_sync"];

export interface SyncJobRequest {
  kind: SyncJobKind;
  regNumbers: string[];
  /** Откуда задание: 'press' — кнопка на дашборде, 'manual' — панель администратора. */
  reason: string;
  requestedBy: string | null;
  /**
   * Читать ли платную карточку Контур.Закупок, если ЕИС документацию не отдала.
   *
   * Допустимо только в задании на документацию: плановый прогон идёт по десяткам
   * закупок, и флаг в нём молча истратил бы суточный бюджет группы `purchase`.
   */
  konturCards: boolean;
}

export type SyncJobParseResult =
  | { ok: true; request: SyncJobRequest }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Разбирает тело запроса на постановку задания.
 *
 * Чистая функция: роут остаётся тонким, а правила проверки живут в домене и
 * проверяются тестами без сети. Сообщение об ошибке пишется по-русски и
 * называет причину — интерфейс показывает его как есть.
 */
export function parseSyncJobRequest(body: unknown): SyncJobParseResult {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "Ожидался JSON-объект с параметрами задания" };

  const kindValue = record["kind"] ?? "documents";
  if (typeof kindValue !== "string" || !SYNC_JOB_KINDS.includes(kindValue as SyncJobKind)) {
    return {
      ok: false,
      error: `Неизвестный вид задания: ${String(kindValue)}. Допустимы ${SYNC_JOB_KINDS.join(", ")}`,
    };
  }
  const kind = kindValue as SyncJobKind;

  /*
    Платная карточка Контур.Закупок — только явное задание на документацию.
    Плановый прогон обходит десятки закупок, и флаг в нём означал бы десятки
    платных запросов группы `purchase` без решения партнёра: суточный бюджет
    (30 запросов) кончился бы за один прогон, и никто бы этого не заметил до
    следующего нажатия кнопки поиска.
  */
  const rawKonturCards = record["konturCards"];
  if (rawKonturCards !== undefined && typeof rawKonturCards !== "boolean") {
    return {
      ok: false,
      error: `konturCards ожидается логическим значением, а получено ${typeof rawKonturCards}`,
    };
  }
  const konturCards = rawKonturCards === true;
  if (konturCards && kind !== "documents") {
    return {
      ok: false,
      error: "Платные карточки Контур.Закупок доступны только в задании на документацию",
    };
  }

  const reason = typeof record["reason"] === "string" && record["reason"].trim().length > 0
    ? record["reason"].trim()
    : "manual";

  const requestedBy =
    typeof record["requestedBy"] === "string" && record["requestedBy"].trim().length > 0
      ? record["requestedBy"].trim().slice(0, 200)
      : null;

  const rawNumbers = record["regNumbers"];
  const numbers: string[] = [];
  if (rawNumbers !== undefined && rawNumbers !== null) {
    if (!Array.isArray(rawNumbers)) {
      return { ok: false, error: "Номера закупок ожидаются списком" };
    }
    const seen = new Set<string>();
    for (const item of rawNumbers) {
      if (typeof item !== "string") {
        return { ok: false, error: "Номер закупки — строка, а не число или объект" };
      }
      const value = item.trim();
      if (value.length === 0) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      numbers.push(value);
    }
  }

  if (kind === "documents") {
    if (numbers.length === 0) {
      return { ok: false, error: "Не указано ни одного номера закупки" };
    }
    if (numbers.length > MAX_REG_NUMBERS_PER_JOB) {
      return {
        ok: false,
        error: `Слишком много номеров в одном задании: ${numbers.length} при пределе ${MAX_REG_NUMBERS_PER_JOB}`,
      };
    }
  }

  return {
    ok: true,
    request: { kind, regNumbers: numbers, reason, requestedBy, konturCards },
  };
}

/** Номера задания в виде, пригодном для сравнения: порядок не важен. */
export function regNumbersKey(regNumbers: readonly string[]): string {
  return [...regNumbers].map((value) => value.trim()).sort().join("|");
}

/**
 * Ищет в активных заданиях то, которое уже покрывает этот запрос.
 *
 * Повторное нажатие кнопки в том же часу даёт тот же набор номеров: без этой
 * проверки в очереди росла бы стопка одинаковых заданий, а воркер качал бы одни
 * и те же файлы несколько раз. Совпадение требуется полное — частичное
 * пересечение означает другой набор закупки и ставится отдельным заданием.
 *
 * Плановый прогон (`full_sync`) сравнивается только по виду: два прогона подряд
 * не дают ничего нового, зато каждый занимает сервер на десятки минут и тратит
 * суточный бюджет Контур.Закупок.
 */
export function findReusableJob(
  activeJobs: readonly SyncJobRow[],
  request: SyncJobRequest,
): SyncJobRow | null {
  const wanted = regNumbersKey(request.regNumbers);

  for (const job of activeJobs) {
    if (job.kind !== request.kind) continue;
    if (job.status !== "pending" && job.status !== "processing") continue;
    if (request.kind === "full_sync") return job;
    const payload: SyncJobPayload = job.payload ?? {};
    /*
      Платное и бесплатное задание на те же номера — разная работа, поэтому они
      не заменяют друг друга. Совместить бесплатное с платным значило бы вовсе
      не купить карточку (воркер выполнил бы прежнее задание без флага), а
      наоборот — потратить платный запрос на закупку, документацию которой
      партнёр заказывал бесплатно.
    */
    if ((payload.konturCards ?? false) !== request.konturCards) continue;
    if (regNumbersKey(payload.regNumbers ?? []) === wanted) return job;
  }
  return null;
}
