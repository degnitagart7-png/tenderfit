import type { WorkerHeartbeatRow } from "@/types/database";
import { resolveWorkerId } from "./workerStatus";

/**
 * Расписание воркера на сервере в России: что делать на этом тике.
 *
 * Правила вынесены в домен, потому что цена ошибки здесь измеряется деньгами и
 * доступностью источника. Плановый прогон обращается к Контур.Закупкам
 * (боевой тариф — 30 запросов в сутки на метод) и к ЕИС, которая не любит
 * частых обращений; задание из очереди скачивает вложения объёмом до 50 МБ.
 * Логика «когда запускать» обязана быть чистой функцией с тестами, а не
 * условными выражениями внутри бесконечного цикла, где её никто не видит.
 */

/**
 * Через сколько часов повторяется плановый прогон.
 *
 * Значение совпадает с прежним расписанием Windows Task Scheduler (каждые два
 * часа): переезд на сервер в России не должен менять ни свежесть ленты, ни
 * расход платного источника.
 */
export const DEFAULT_SYNC_INTERVAL_HOURS = 2;

/**
 * Во сколько раз дольше интервала очередь заданий может удерживать сервер,
 * прежде чем плановый прогон станет важнее.
 *
 * Задания из очереди идут первыми: их ставит человек нажатием кнопки, и ждать
 * они не должны. Но без порога просрочки длинная очередь отодвигала бы ленту
 * бесконечно — партнёр видел бы свежие закупки вчерашнего дня. Два интервала
 * (четыре часа при значении по умолчанию) — предел терпения расписания.
 */
export const FULL_SYNC_OVERDUE_FACTOR = 2;

/** Как часто воркер просыпается, чтобы отметить пульс и посмотреть очередь. */
export const DEFAULT_TICK_SECONDS = 60;

/**
 * Нижний порог частоты тиков.
 *
 * Меньше пяти секунд — это уже не расписание, а нагрузка на Supabase и на
 * хранилище ЕИС: опечатка в переменной окружения не должна превращаться в
 * отказ обслуживания своими руками.
 */
export const MIN_TICK_SECONDS = 5;

/**
 * Через сколько минут задание в статусе `processing` считается потерянным
 * и возвращается в очередь.
 *
 * Загрузка документации ограничена изнутри бюджетом 25 минут
 * (FETCH_BUDGET_MS в scripts/fetch-tender-documents.ts), поэтому порог взят
 * с запасом: задание, которое ещё качает файлы, нельзя перехватывать. Перехват
 * означал бы повторную загрузку тех же вложений и двойную запись в базу.
 */
export const STALE_JOB_AFTER_MIN = 45;

/** Адрес прода, на котором живёт воркер AI-разбора. */
export const DEFAULT_SYNC_BASE_URL = "https://tenderfit-ai-sage.vercel.app";

export interface WorkerConfig {
  workerId: string;
  intervalHours: number;
  tickMs: number;
  fullSyncEnabled: boolean;
  baseUrl: string;
  staleJobAfterMin: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat((raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Секунды между тиками: не число — значение по умолчанию, меньше порога — порог.
 *
 * Ноль поднимается до порога, а не до значения по умолчанию: оба означают
 * «слишком часто», и лечатся одинаково. Разные исходы для 0 и 1 нельзя было бы
 * объяснить в строке лога.
 */
function clampedTickSeconds(raw: string | undefined): number {
  const value = Number.parseFloat((raw ?? "").trim());
  if (!Number.isFinite(value)) return DEFAULT_TICK_SECONDS;
  return Math.max(MIN_TICK_SECONDS, value);
}

function isDisabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

/**
 * Собирает настройки воркера из переменных окружения.
 *
 * Невозможные значения исправляются молча к безопасным, а не роняют процесс:
 * воркер работает без присмотра на арендованном сервере, и падение из-за
 * опечатки в `SYNC_TICK_SECONDS=0` оставило бы партнёра без документации до
 * ручного вмешательства. Исправление видно в стартовой строке лога.
 */
export function resolveWorkerConfig(
  env: Record<string, string | undefined> = {},
): WorkerConfig {
  const tickSeconds = clampedTickSeconds(env["SYNC_TICK_SECONDS"]);

  return {
    workerId: resolveWorkerId(env["SYNC_WORKER_ID"]),
    intervalHours: positiveNumber(env["SYNC_INTERVAL_HOURS"], DEFAULT_SYNC_INTERVAL_HOURS),
    tickMs: tickSeconds * 1000,
    fullSyncEnabled: !isDisabled(env["SYNC_FULL_SYNC"]),
    baseUrl: (env["SYNC_BASE_URL"] ?? "").trim() || DEFAULT_SYNC_BASE_URL,
    staleJobAfterMin: positiveNumber(env["SYNC_STALE_JOB_MINUTES"], STALE_JOB_AFTER_MIN),
  };
}

/** Что воркер видит перед решением: пульс и длину очереди. */
export interface TickState {
  heartbeat: WorkerHeartbeatRow | null;
  pending: number;
}

/**
 * Решение на один тик.
 *
 * Одно действие, а не «всё сразу»: плановый прогон занимает десятки минут, и
 * запускать его параллельно с загрузкой документации — значит качать одни и те
 * же вложения дважды и держать два обращения к ЕИС вместо одного.
 */
export type TickAction =
  | { kind: "idle"; reason: string }
  | { kind: "job"; reason: string }
  | { kind: "full_sync"; reason: string };

/**
 * Минут с последнего планового прогона; null — прогона на этом сервере не было
 * или отметка не читается.
 *
 * Нечитаемая отметка трактуется как «прогона не было», а не как «только что
 * был»: лучше лишний прогон, чем лента, которая молча перестала обновляться.
 */
export function minutesSinceFullSync(
  heartbeat: WorkerHeartbeatRow | null,
  nowMs: number,
): number | null {
  const raw = heartbeat?.last_full_sync_at;
  if (!raw) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((nowMs - at) / 60000));
}

/**
 * Что делать на этом тике.
 *
 * Порядок приоритетов:
 *   1. плановый прогон просрочен вдвое — он важнее очереди, иначе лента встаёт;
 *   2. есть задание в очереди — его поставил человек, ждать оно не должно;
 *   3. подошёл срок планового прогона;
 *   4. ничего не делать.
 *
 * `reason` пишется по-русски и попадает в лог как есть: по нему через неделю
 * должно быть понятно, почему сервер запустил прогон или почему молчал.
 */
export function planTick(
  state: TickState,
  now: string | number,
  config: Pick<WorkerConfig, "intervalHours" | "fullSyncEnabled">,
): TickAction {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const pending = Math.max(0, state.pending);
  const since = minutesSinceFullSync(state.heartbeat, nowMs);
  const dueMin = config.intervalHours * 60;
  const overdueMin = dueMin * FULL_SYNC_OVERDUE_FACTOR;

  if (config.fullSyncEnabled) {
    if (since === null) {
      return {
        kind: "full_sync",
        reason: "плановый прогон на этом сервере ещё не выполнялся",
      };
    }
    if (since >= overdueMin) {
      return {
        kind: "full_sync",
        reason:
          `плановый прогон просрочен: ${since} мин с прошлого при пороге ${overdueMin} мин — ` +
          `очередь заданий (${pending}) больше не удерживает расписание`,
      };
    }
  }

  if (pending > 0) {
    return { kind: "job", reason: `в очереди заданий: ${pending}` };
  }

  if (config.fullSyncEnabled && since !== null && since >= dueMin) {
    return {
      kind: "full_sync",
      reason: `подошёл срок планового прогона: ${since} мин с прошлого при интервале ${dueMin} мин`,
    };
  }

  if (!config.fullSyncEnabled) {
    return {
      kind: "idle",
      reason: "очередь пуста, плановый прогон отключён (SYNC_FULL_SYNC=0)",
    };
  }

  return {
    kind: "idle",
    reason: `очередь пуста, до планового прогона ${Math.max(0, dueMin - (since ?? 0))} мин`,
  };
}
