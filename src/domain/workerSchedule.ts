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

/**
 * Как часто воркер просыпается, чтобы отметить пульс и посмотреть очередь.
 *
 * Десять секунд, а не минута: по кнопке «Глубокий анализ» партнёр сидит перед
 * карточкой и ждёт, и минута до первого движения читается как «не работает».
 * Тик — это три-четыре лёгких запроса к Supabase, их частота нагрузкой не
 * становится.
 */
export const DEFAULT_TICK_SECONDS = 10;

/**
 * Как часто повторять попытку по задачам разбора, которые ждут без движения.
 *
 * Новая задача забирается в первый же тик. Повтор нужен задачам, документацию
 * которых источник в этот раз не отдал: долбить ЕИС за ними каждые десять
 * секунд нельзя, а ждать планового прогона два часа — незачем.
 */
export const ANALYSIS_RETRY_MIN = 10;

/** Что воркер помнит о прошлом заходе в очередь разбора. */
export interface AnalysisQueueMemory {
  /** Задачи, которые ждали при прошлом заходе. */
  jobIds: readonly string[];
  /** Когда был заход, мс; null — ещё не было. */
  at: number | null;
}

/**
 * Заходить ли в очередь разбора в этот тик.
 *
 * Заходим, когда появилась задача, которой в прошлый раз не было (её только что
 * поставили кнопкой), либо когда с прошлого захода прошло `ANALYSIS_RETRY_MIN`.
 * Очередь заданий на загрузку важнее: её вызывающий проверяет раньше.
 */
export function shouldDrainAnalysisQueue(
  pendingJobIds: readonly string[],
  memory: AnalysisQueueMemory,
  nowMs: number,
): boolean {
  if (pendingJobIds.length === 0) return false;
  if (memory.at === null) return true;
  const seen = new Set(memory.jobIds);
  if (pendingJobIds.some((id) => !seen.has(id))) return true;
  return nowMs - memory.at >= ANALYSIS_RETRY_MIN * 60_000;
}

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
  /**
   * Дорожки работают одновременно (по умолчанию). `WORKER_PARALLEL=0` возвращает
   * прежний строго последовательный воркер — рычаг отката без выкладки кода.
   */
  parallel: boolean;
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
    parallel: !isDisabled(env["WORKER_PARALLEL"]),
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

/*
  Дорожки. Замеры на проде за семь суток (14.10.2026): документация — медиана
  1,4 мин, максимум 6,9; смета — максимум 11,1; полный обход — медиана 4,8 мин,
  максимум 21,9. Воркер делал одно дело за раз, и глубокий анализ ждал в очереди
  68 минут за обходом; при десяти пользователях десятый ждал бы больше получаса.
  Дорожки позволяют работе человека не стоять за плановым обходом и за делами
  другого вида. Внутри дорожки всё по-прежнему строго по очереди.
*/

/** Дорожка воркера: самостоятельная последовательная очередь работы. */
export type LaneId = "sync" | "live" | "documents" | "estimate";

/** Порядок дорожек в решении и в логе. */
export const LANE_IDS: readonly LaneId[] = ["sync", "live", "documents", "estimate"];

/** Сколько заданий ждёт на каждой дорожке; сумма — это прежний `pending`. */
export interface LanePending {
  documents: number;
  estimate: number;
  /** `full_sync` без запроса («Найти новые закупки»): идёт в дорожке обхода. */
  sync: number;
  /** `full_sync` с запросом (живой поиск). */
  live: number;
}

/** Что воркер видит перед решением о дорожках. */
export interface LaneState {
  heartbeat: WorkerHeartbeatRow | null;
  /** Какие дорожки сейчас заняты (их дело уже идёт в этом процессе). */
  busy: Readonly<Record<LaneId, boolean>>;
  pending: LanePending;
}

/**
 * Что запустить на свободной дорожке.
 *
 *  - `scheduled` — плановый обход по расписанию (дорожка sync);
 *  - `job` — взять следующее задание своего вида из очереди;
 *  - `drain` — довести задачи разбора, ждущие без задания на загрузку (дорожка
 *    документации, когда заданий на документацию нет).
 */
export type LaneStart =
  | { lane: "sync"; kind: "scheduled"; reason: string }
  | { lane: "sync"; kind: "job"; reason: string }
  | { lane: "live"; kind: "job"; reason: string }
  | { lane: "documents"; kind: "job"; reason: string }
  | { lane: "documents"; kind: "drain"; reason: string }
  | { lane: "estimate"; kind: "job"; reason: string };

/** Решение тика: либо одно действие прежнего расписания, либо старты дорожек. */
export type LanePlan =
  | { mode: "serial"; action: TickAction }
  | { mode: "parallel"; starts: LaneStart[] };

/**
 * Пора ли планового обхода — те же сроки, что в `planTick`, но без очереди.
 *
 * Очередь заданий плановый обход больше не удерживает: у неё своя дорожка. Сроки
 * (первый запуск, интервал, двойной интервал) не менялись, поэтому `planTick` с
 * пустой очередью и эта функция всегда согласны — это закреплено тестом.
 */
export function planScheduledSync(
  heartbeat: WorkerHeartbeatRow | null,
  now: string | number,
  config: Pick<WorkerConfig, "intervalHours" | "fullSyncEnabled">,
): string | null {
  if (!config.fullSyncEnabled) return null;
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const since = minutesSinceFullSync(heartbeat, nowMs);
  const dueMin = config.intervalHours * 60;
  if (since === null) return "плановый прогон на этом сервере ещё не выполнялся";
  if (since >= dueMin * FULL_SYNC_OVERDUE_FACTOR) {
    return `плановый прогон просрочен: ${since} мин с прошлого при интервале ${dueMin} мин`;
  }
  if (since >= dueMin) {
    return `подошёл срок планового прогона: ${since} мин с прошлого при интервале ${dueMin} мин`;
  }
  return null;
}

/**
 * Что запустить на этом тике: по одному действию на каждую свободную дорожку.
 *
 *  1. sync — один обход за раз (скрипт пересоздаёт строки источника, два обхода
 *     подряд стёрли бы друг другу данные). Если в очереди ждёт «Найти новые
 *     закупки», запускается оно, а не плановый: работа та же, а человек ждёт;
 *     иначе — плановый обход по расписанию;
 *  2. live — живой поиск, только добавляет строки и ограничен по времени, поэтому
 *     идёт параллельно обходу;
 *  3. documents — задания на документацию; пока их нет, дорожка доводит задачи
 *     разбора. Одна дорожка на оба дела: бюджет платного источника суточный, а
 *     две загрузки одной закупки скачали бы вложения дважды;
 *  4. estimate — расчёт сметы занимает около 600 МБ памяти, вдвоём нельзя.
 *
 * Занятая дорожка не получает ничего: её очередь продолжится на следующем тике
 * после окончания дела. Внутри вида порядок FIFO обеспечивает выборка из базы.
 *
 * `parallel: false` (WORKER_PARALLEL=0) — результат прежнего `planTick`, без учёта
 * дорожек. Сам воркер при выключенном параллелизме вызывает прежний `tick`, а не
 * эту функцию; ветка нужна, чтобы решение «как раньше» было закреплено тестом.
 */
export function planLanes(
  state: LaneState,
  now: string | number,
  config: Pick<WorkerConfig, "intervalHours" | "fullSyncEnabled" | "parallel">,
): LanePlan {
  if (!config.parallel) {
    const total = state.pending.documents + state.pending.estimate + state.pending.sync + state.pending.live;
    return { mode: "serial", action: planTick({ heartbeat: state.heartbeat, pending: total }, now, config) };
  }

  const starts: LaneStart[] = [];
  const { busy, pending } = state;

  if (!busy.sync) {
    if (pending.sync > 0) {
      starts.push({
        lane: "sync",
        kind: "job",
        reason: `«Найти новые закупки» в очереди: ${pending.sync}`,
      });
    } else {
      const reason = planScheduledSync(state.heartbeat, now, config);
      if (reason !== null) starts.push({ lane: "sync", kind: "scheduled", reason });
    }
  }

  if (!busy.live && pending.live > 0) {
    starts.push({ lane: "live", kind: "job", reason: `живой поиск в очереди: ${pending.live}` });
  }

  if (!busy.documents) {
    starts.push(
      pending.documents > 0
        ? { lane: "documents", kind: "job", reason: `заданий на документацию: ${pending.documents}` }
        : { lane: "documents", kind: "drain", reason: "заданий на документацию нет — смотрю задачи разбора" },
    );
  }

  if (!busy.estimate && pending.estimate > 0) {
    starts.push({ lane: "estimate", kind: "job", reason: `расчётов сметы в очереди: ${pending.estimate}` });
  }

  return { mode: "parallel", starts };
}

/**
 * Скорость запросов к ЕИС (`EIS_RATE_PER_SEC`) для дочернего прогона, запускаемого воркером.
 *
 * Все запросы к ЕИС идут с одного адреса, а лимит скрипта считается на процесс. Пока
 * обход и живой поиск не шли одновременно, хватало лимита по умолчанию (2 в секунду,
 * src/services/tenderSourceRegistry.ts). Теперь они могут идти вдвоём, и суммарно
 * ЕИС увидела бы вдвое больше обращений, чем когда-либо, — отсюда блокировка 434.
 *  - обход (плановый и «Найти новые закупки») — фон, его никто не ждёт: всегда 1,5;
 *  - живой поиск — его ждёт человек: один на сервере идёт с умолчанием, а рядом с
 *    обходом — тоже 1,5: вместе 3 в секунду против 2 у одного прогона раньше (3 в
 *    секунду — предел из ACCESS_EIS.md). Если обход стартует посреди живого поиска,
 *    поиск (≤ 7 мин) дорабатывает со своей скоростью, и суммарно выходит до 3,5.
 * `null` — переменную не задавать. Без параллелизма (`WORKER_PARALLEL=0`) всегда
 * `null`: поведение в точности прежнее.
 */
export const PARALLEL_EIS_RATE = "1.5";

export function workerEisRate(
  role: "sync" | "live",
  options: { parallel: boolean; syncBusy: boolean },
): string | null {
  if (!options.parallel) return null;
  if (role === "sync") return PARALLEL_EIS_RATE;
  return options.syncBusy ? PARALLEL_EIS_RATE : null;
}
