/**
 * Воркер на сервере в России: плановый прогон и очередь заданий.
 *
 * Зачем он нужен. Прод живёт на Vercel, то есть за рубежом. Контур.Закупки
 * отвечают оттуда (поиск по нажатию кнопки работает), а ЕИС и её хранилище
 * файлов — нет: 24.09.2026 запрос из Амстердама оборвался без ответа, а из
 * Одинцова те же семь файлов пришли за 6,7 секунды. Поэтому тяжёлая часть
 * конвейера — скачивание документации и плановый обход источников — обязана
 * выполняться с российского адреса. Раньше этим занимался домашний ПК по
 * расписанию Windows Task Scheduler («TenderFit EIS Sync»); воркер заменяет его
 * и добавляет очередь, чтобы документация догружалась по нажатию кнопки, а не
 * раз в два часа.
 *
 * Как устроено разделение. Прод ставит задания в таблицу sync_jobs через
 * POST /api/sync-jobs и читает пульс из worker_heartbeat через
 * GET /api/sync-jobs. Воркер здесь — единственный, кто задания выполняет.
 * Supabase в Стокгольме доступен с обеих сторон, поэтому общего хранилища
 * достаточно; отдельного протокола между Vercel и сервером нет.
 *
 * Что делает один тик (по умолчанию раз в минуту):
 *   1. определяет адрес выхода в сеть и пишет пульс;
 *   2. возвращает в очередь задания, зависшие в processing после перезагрузки;
 *   3. просит у домена решение — плановый прогон, задание из очереди или ничего
 *      (src/domain/workerSchedule.ts, правила покрыты тестами);
 *   4. выполняет одно действие и записывает результат.
 *
 * Дорожки (с 14.10.2026). Раньше воркер делал одно дело за раз, и глубокий анализ
 * ждал в очереди 68 минут за плановым обходом. Теперь работа идёт по четырём
 * независимым дорожкам внутри одного процесса; каждая дорожка последовательна,
 * дорожки работают одновременно:
 *   обход      — плановый прогон и «Найти новые закупки» (full_sync без запроса):
 *                скрипт пересоздаёт строки источника, два обхода не должны пересекаться;
 *   поиск      — живой поиск (full_sync с запросом): только добавляет строки, ограничен
 *                по времени, идёт рядом с обходом;
 *   документы  — задания на документацию, а когда их нет — задачи разбора. Одна дорожка
 *                на оба дела: бюджет Контур.Закупок суточный, а две загрузки одной
 *                закупки качали бы вложения дважды;
 *   смета      — расчёт и аудит сметы (≈600 МБ памяти — вдвоём нельзя).
 * Решение, что запускать, — чистая функция `planLanes` в src/domain/workerSchedule.ts.
 * WORKER_PARALLEL=0 возвращает прежний строго последовательный цикл (одно действие на
 * тик, `tick` ниже) — рычаг отката без выкладки кода.
 *
 * Задание на документацию бывает бесплатным и платным. Платное (`payload.konturCards`)
 * ставится только явным нажатием кнопки в карточке одной закупки: оно покупает
 * карточку Контур.Закупок (1 запрос из 30 в сутки) и сразу доводит закупку до
 * AI-разбора. Правила, кому это разрешено, живут в src/domain/documentsJob.ts и
 * покрыты тестами — воркер их не переопределяет.
 *
 * Запуск:
 *   npx tsx scripts/worker.ts                — демон: тик раз в SYNC_TICK_SECONDS
 *   npx tsx scripts/worker.ts --once         — один тик по расписанию и выход
 *   npx tsx scripts/worker.ts --full-sync    — сразу плановый прогон, без очереди
 *   npx tsx scripts/worker.ts --job          — сразу одно задание из очереди
 *
 * Переменные окружения (.env.local загружается автоматически):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — подключение к базе (обязательны)
 *   SYNC_WORKER_ID          — имя воркера в пульсе, по умолчанию ru-vps
 *   SYNC_INTERVAL_HOURS     — период планового прогона, по умолчанию 2
 *   SYNC_TICK_SECONDS       — период опроса очереди, по умолчанию 60, не ниже 5
 *   SYNC_FULL_SYNC=0        — отключить плановый прогон, оставив только очередь
 *   SYNC_BASE_URL           — адрес прода с воркером AI-разбора
 *   SYNC_STALE_JOB_MINUTES  — через сколько минут задание в работе считается
 *                             потерянным, по умолчанию 45. Задания, которые воркер
 *                             выполняет сам, при этом не трогаются
 *   WORKER_PARALLEL=0       — отключить дорожки: один процесс делает одно дело за раз,
 *                             как до 14.10.2026. По умолчанию дорожки включены
 *   EIS_RATE_PER_SEC        — скорость запросов к ЕИС из дочернего прогона (по умолчанию 2).
 *                             Воркер задаёт её сам: 1,5 для обхода, а живому поиску
 *                             рядом с обходом — тоже 1,5 (все запросы идут с одного адреса)
 *   ALERT_EMAIL             — куда писать, когда баланс модели кончается (раз в 30 минут
 *                             воркер читает LLM_BASE_URL/credits); без неё письма выключены.
 *                             Нужны также LLM_BASE_URL, LLM_API_KEY и SMTP_*;
 *                             LLM_BALANCE_ALERT_RUB — порог «мало», по умолчанию 150 ₽
 *   ADMIN_EMAILS            — почты администраторов через запятую: им не пишем о пробном
 *                             периоде. Письма «закончится завтра» и «закончился» раз в час
 *                             уходят при настроенном SMTP_* (см. trialNoticeService)
 *
 * NODE_TLS_REJECT_UNAUTHORIZED=0 сюда не принадлежит: переменная осталась от
 * локального обхода корпоративного прокси и отключает проверку сертификатов.
 * Воркер предупреждает о ней при старте.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { runDocumentFetch } from "./fetch-tender-documents";
import { describeError } from "../src/lib/errors";
import { readEgressReply, type EgressInfo } from "../src/domain/workerEgress";
import { describeSyncJobReport } from "../src/domain/syncJobReport";
import { eisBlockedDocumentsNote } from "../src/domain/syncRunNote";
import { describeLinkImport, importTendersByLink } from "../src/services/tenderLinkImport";
import { documentsJobOptions } from "../src/domain/documentsJob";
import {
  LANE_IDS,
  planLanes,
  planTick,
  shouldDrainAnalysisQueue,
  workerEisRate,
  type LaneId,
  type LaneStart,
  type AnalysisQueueMemory,
  resolveWorkerConfig,
  type TickAction,
  type WorkerConfig,
} from "../src/domain/workerSchedule";
import { syncJobRepository, type PendingFilter } from "../src/repositories/syncJobRepository";
import { LaneRunner } from "../src/lib/laneRunner";
import { analysisJobRepository } from "../src/repositories/analysisJobRepository";
import type { SyncJobReport, SyncJobRow } from "../src/types/database";
import { tracksFor, type SyncTrigger } from "../src/domain/sourceCadence";
import { LIVE_RUN_CAP_MS, normalizeLiveQuery, normalizeLiveRegions, normalizeLiveSynonyms } from "../src/domain/liveSearch";
import { ESTIMATE_PARAMETERS } from "../src/services/estimateDefaults";
import { resolveZoneTender } from "../src/domain/estimate/documentRegion";
import { defaultBalanceAlertDeps, runLlmBalanceCheck } from "../src/services/llmBalanceAlert";
import { defaultTrialNoticeDeps, runTrialNotices } from "../src/services/trialNoticeService";
import { startNotificationWatch } from "../src/services/notificationWatch";

loadEnv({ path: resolve(__dirname, "../.env.local") });

/** Корень проекта: оттуда запускается плановый прогон. */
const PROJECT_ROOT = resolve(__dirname, "..");

/** Скрипт плановой синхронизации — он же запускается из расписания Windows. */
const SYNC_SCRIPT = "scripts/sync-eis.ts";

/**
 * Как часто обновлять адрес выхода.
 *
 * Проверка идёт на сторонние сервисы, и каждый тик долбить их невежливо и
 * бессмысленно: адрес сервера меняется только при переезде или смене провайдера.
 * Полчаса достаточно, чтобы смена выхода стала видна в панели в тот же день.
 */
const EGRESS_REFRESH_MS = 30 * 60_000;
const EGRESS_TIMEOUT_MS = 8_000;

/**
 * Провайдеры определения адреса, по порядку.
 *
 * Нескольких нужно потому, что отказывает обычно один: сервис лежит, не
 * отвечает из российского сегмента или меняет формат. Порядок важен — первым
 * идёт тот, что отдаёт и страну.
 */
const EGRESS_PROVIDERS: ReadonlyArray<{ url: string; json: boolean }> = [
  { url: "https://ipinfo.io/json", json: true },
  { url: "https://ipapi.co/json/", json: true },
  { url: "https://api.ipify.org?format=json", json: true },
  { url: "https://ifconfig.me/ip", json: false },
];

/**
 * Как часто писать пульс, пока идёт долгая работа.
 *
 * Тик во время прогона не выполняется, а порог «воркер пропал» в панели —
 * 15 минут. Без отдельного таймера получасовой прогон выглядел бы как обрыв
 * связи, и партнёр пошёл бы перезапускать сервер, который исправно качает файлы.
 */
const WORK_HEARTBEAT_MS = 5 * 60_000;

/** Как часто печатать «делать нечего»: раз в минуту — это 1440 строк в сутки. */
const IDLE_LOG_INTERVAL_MS = 15 * 60_000;

/** Сколько строк вывода дочернего процесса помним для отчёта. */
const TAIL_LINES = 400;

/**
 * Как часто проверять баланс языковой модели.
 *
 * Дважды баланс routerai.ru кончался молча. Полчаса — компромисс: при расходе в
 * сотни рублей в сутки порог «мало» (LLM_BALANCE_ALERT_RUB) не проскочить за один
 * интервал, а запрос к /credits остаётся копеечным. Мгновенный сигнал на 402
 * идёт отдельно, из самих вызовов модели (src/services/llmBalanceTrigger.ts).
 */
const BALANCE_CHECK_INTERVAL_MS = 30 * 60_000;

/** Как часто искать тех, кому пора написать о пробном периоде. Письма — раз в сутки, час с запасом. */
const TRIAL_NOTICE_INTERVAL_MS = 60 * 60_000;

/** Файл-замок: второй воркер на той же очереди удвоил бы загрузку. */
const LOCK_PATH = resolve(PROJECT_ROOT, "logs", "worker.lock");

let stopRequested = false;
/**
 * Дочерние прогоны, идущие сейчас. Раньше была одна переменная: на двух дорожках
 * (обход и поиск) второй прогон затёр бы первый, и остановка не нашла бы его.
 */
const runningChildren = new Set<ChildProcess>();
let lastIdleLogAt = 0;
/** Дорожки включены (WORKER_PARALLEL≠0); от этого зависят скорость запросов к ЕИС и приставки в логе. */
let parallelMode = false;
/** Задания, которые выполняет этот процесс: очистка потерянных их не трогает (см. resetStaleJobs). */
const runningJobIds = new Set<string>();
/** Прошлый заход в очередь разбора: по нему решается, заходить ли снова. */
let analysisQueueMemory: AnalysisQueueMemory = { jobIds: [], at: null };
let egress: EgressInfo = { ip: null, country: null };
let egressCheckedAt = 0;

/**
 * Приставка дорожки для строк журнала.
 *
 * На четырёх дорожках журнал systemd — одна лента, и без приставки не понять, чья
 * строка. Приставка живёт в AsyncLocalStorage: она следует за делом через `await`,
 * не передаваясь параметром в каждую функцию.
 */
const laneTagStore = new AsyncLocalStorage<string>();

const LANE_TAGS: Record<LaneId, string> = {
  sync: "[обход]",
  live: "[поиск]",
  documents: "[документы]",
  estimate: "[смета]",
};

/** Исходный console.log: `log` ставит приставку сам, после времени, а не перед ним. */
const rawConsoleLog = console.log.bind(console);

function log(message: string): void {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const tag = laneTagStore.getStore();
  rawConsoleLog(`[${stamp}]${tag === undefined ? "" : ` ${tag}`} ${message}`);
}

/**
 * Приставка к тому, что печатают библиотеки внутри дорожки через console.*
 * (загрузка документации, расчёт сметы). Ставится только в параллельном режиме и
 * только на вызовы внутри дорожки: остальные строки идут как раньше.
 */
function installLaneConsolePrefix(): void {
  for (const method of ["info", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      const tag = laneTagStore.getStore();
      if (tag === undefined) original(...args);
      else if (typeof args[0] === "string") original(`${tag} ${args[0]}`, ...args.slice(1));
      else original(tag, ...args);
    };
  }
  console.log = (...args: unknown[]): void => {
    const tag = laneTagStore.getStore();
    if (tag === undefined) rawConsoleLog(...args);
    else if (typeof args[0] === "string") rawConsoleLog(`${tag} ${args[0]}`, ...args.slice(1));
    else rawConsoleLog(tag, ...args);
  };
}

function secondsSince(startedMs: number): string {
  return ((Date.now() - startedMs) / 1000).toFixed(1);
}

/**
 * Отметка кода на сервере: когда файл воркера последний раз менялся.
 *
 * Git-репозитория на сервере нет, а версия из package.json не обновляется,
 * поэтому пригодная для сравнения отметка одна — время раскладки файлов. По ней
 * в панели видно, тот ли код работает, что положили при деплое.
 */
function workerVersion(): string {
  try {
    return statSync(__filename)
      .mtime.toISOString()
      .slice(0, 16)
      .replace("T", " ");
  } catch {
    return "не определена";
  }
}

function requireSupabaseEnv(): void {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (name) => !(process.env[name] ?? "").trim(),
  );
  if (missing.length > 0) {
    console.error(
      `Не заданы переменные окружения: ${missing.join(", ")}. ` +
        "Без них воркер не видит ни очередь заданий, ни пульс. " +
        "Скопируйте .env.example в .env.local или пропишите значения в EnvironmentFile юнита.",
    );
    process.exit(1);
  }

  if (process.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0") {
    log(
      "ВНИМАНИЕ: NODE_TLS_REJECT_UNAUTHORIZED=0 отключает проверку сертификатов. " +
        "Переменная осталась от локального обхода корпоративного прокси и на сервере не нужна.",
    );
  }
}

/**
 * Замок от второго воркера.
 *
 * Возвращает дескриптор файла или null, если замок держит живой процесс.
 * Проверка «жив ли владелец» обязательна: после аварийной перезагрузки файл
 * остаётся, и без неё воркер не стартовал бы никогда, пока кто-то не удалит
 * замок руками.
 */
function acquireLock(): number | null {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      return fd;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      let owner = 0;
      try {
        owner = Number.parseInt(readFileSync(LOCK_PATH, "utf8").trim(), 10);
      } catch {
        owner = 0;
      }

      if (owner > 0 && isAlive(owner)) {
        console.error(
          `Воркер уже запущен (pid ${owner}, замок ${LOCK_PATH}). ` +
            "Два воркера на одной очереди качали бы одни и те же вложения дважды.",
        );
        return null;
      }

      // Владелец мёртв или не читается: убираем чужой замок и пробуем снова.
      log(
        `замок остался от процесса ${owner || "без номера"} — убираю и занимаю свой`,
      );
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Дескриптор мог быть закрыт раньше — на снятие замка это не влияет.
  }
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    log(`не удалось удалить замок ${LOCK_PATH}`);
  }
}

/**
 * Определяет адрес выхода в сеть.
 *
 * Проверка необязательная и никогда не роняет тик: если все провайдеры
 * отказали, в пульсе остаётся прежнее значение, а не null — иначе панель
 * показала бы потерю выхода, которой не было. Время проверки обновляется и при
 * неудаче, чтобы не долбить сервисы каждую минуту.
 */
async function detectEgress(force = false): Promise<EgressInfo> {
  const now = Date.now();
  if (!force && egress.ip !== null && now - egressCheckedAt < EGRESS_REFRESH_MS)
    return egress;

  for (const provider of EGRESS_PROVIDERS) {
    try {
      const response = await fetch(provider.url, {
        signal: AbortSignal.timeout(EGRESS_TIMEOUT_MS),
        headers: { "user-agent": "TenderFit-worker/1.0" },
      });
      if (!response.ok) continue;

      const body: unknown = provider.json
        ? await response.json()
        : await response.text();
      const info = readEgressReply(body);
      if (info.ip === null) continue;

      egress = { ip: info.ip, country: info.country ?? egress.country };
      egressCheckedAt = now;
      return egress;
    } catch {
      // Следующий провайдер.
    }
  }

  egressCheckedAt = now;
  return egress;
}

/** Пишет пульс. Сбой записи не останавливает работу. */
async function beat(
  config: WorkerConfig,
  extra: {
    lastFullSyncAt?: string | null;
    lastJobId?: string | null;
    lastError?: string | null;
  } = {},
): Promise<void> {
  try {
    await syncJobRepository.beat(config.workerId, {
      lastSeenAt: new Date().toISOString(),
      host: hostname(),
      version: workerVersion(),
      exitIp: egress.ip,
      exitCountry: egress.country,
      ...extra,
    });
  } catch (err) {
    // Задание важнее отметки: если база недоступна, воркер продолжает работу,
    // а панель увидит молчание и покажет «не выходил на связь».
    log(`пульс не записан: ${describeError(err)}`);
  }
}

/**
 * Пульс во время долгой работы.
 *
 * Возвращает функцию, которая таймер останавливает: её обязательно вызывают
 * в `finally`, иначе незакрытый интервал не даст процессу завершиться после
 * --once, и воркер зависнет на пустом месте.
 */
let heartbeatUsers = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

/**
 * Один общий таймер на все дорожки: пока занята хотя бы одна, он пишет пульс; когда
 * освободилась последняя — останавливается. N таймеров писали бы одну и ту же строку.
 */
function startWorkHeartbeat(config: WorkerConfig): () => void {
  heartbeatUsers += 1;
  if (heartbeatTimer === null) {
    heartbeatTimer = setInterval(() => {
      void beat(config);
    }, WORK_HEARTBEAT_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    heartbeatUsers -= 1;
    if (heartbeatUsers <= 0 && heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      heartbeatUsers = 0;
    }
  };
}

interface ScriptRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Последние строки вывода — по ним видно итог, не листая журнал. */
  tail: string[];
  /** Итоговая строка «Готово: …» из планового прогона, если она была напечатана. */
  summaryLine: string | null;
  /** Прогон не уложился в отведённое время и был остановлен воркером. */
  timedOut: boolean;
}

/**
 * Запускает скрипт проекта тем же tsx, под которым работает сам воркер.
 *
 * Вывод проходит в журнал systemd без изменений и одновременно запоминается
 * хвостом: в отчёт задания нужна итоговая строка, а не мегабайты лога.
 */
function runScript(
  script: string,
  extraEnv: Record<string, string> = {},
  timeoutMs: number | null = null,
): Promise<ScriptRun> {
  return new Promise((resolveRun, rejectRun) => {
    let tsxCli: string;
    try {
      tsxCli = require.resolve("tsx/cli");
    } catch (err) {
      rejectRun(err);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [tsxCli, script], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      rejectRun(err);
      return;
    }

    runningChildren.add(child);
    // Приставка дорожки берётся сейчас, пока мы внутри дела: обработчики потока
    // сработают позже, когда контекст уже не гарантирован.
    const prefix = laneTagStore.getStore();
    // Предел времени задаётся только живому поиску: он ничего не удаляет, и
    // остановка безопасна. Плановый прогон так не останавливают: он пересоздаёт
    // строки источника, и убитый на середине оставил бы источник без данных.
    let timedOut = false;
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            log(`прогон идёт дольше ${Math.round(timeoutMs / 60_000)} мин — останавливаю`);
            child.kill("SIGTERM");
          }, timeoutMs);
    const tail: string[] = [];
    /*
      Вывод прогона идёт в журнал без изменений, а на дорожке — с приставкой каждой
      строки, иначе вывод обхода и поиска перемешался бы. Неполная строка ждёт
      продолжения (по одной на поток), чтобы приставка не оказалась посреди строки.
    */
    const makePipe = () => {
      let carry = "";
      const pipe = (chunk: Buffer): void => {
        if (prefix === undefined) {
          process.stdout.write(chunk);
        } else {
          const lines = (carry + chunk.toString("utf8")).split("\n");
          carry = lines.pop() ?? "";
          for (const line of lines) process.stdout.write(`${prefix} ${line}\n`);
        }
        for (const line of chunk.toString("utf8").split("\n")) {
          const trimmed = line.trimEnd();
          if (trimmed.length === 0) continue;
          tail.push(trimmed);
          if (tail.length > TAIL_LINES) tail.shift();
        }
      };
      const flush = (): void => {
        if (prefix !== undefined && carry.length > 0) process.stdout.write(`${prefix} ${carry}\n`);
        carry = "";
      };
      return { pipe, flush };
    };
    const outPipe = makePipe();
    const errPipe = makePipe();

    child.stdout?.on("data", outPipe.pipe);
    child.stderr?.on("data", errPipe.pipe);
    child.on("error", (spawnError) => {
      if (timer !== null) clearTimeout(timer);
      runningChildren.delete(child);
      rejectRun(spawnError);
    });
    child.on("close", (code, signal) => {
      if (timer !== null) clearTimeout(timer);
      runningChildren.delete(child);
      outPipe.flush();
      errPipe.flush();
      const summaryLine =
        [...tail].reverse().find((line) => line.startsWith("Готово")) ?? null;
      resolveRun({ code, signal, tail, summaryLine, timedOut });
    });
  });
}

interface FullSyncResult {
  ok: boolean;
  note: string | null;
  error: string | null;
  /** Прогон остановлен по времени: не сбой источников, а предел, который мы сами задали. */
  timedOut: boolean;
}

/**
 * Плановый прогон: обход источников и догрузка документации по очереди разбора.
 *
 * Отметка времени пишется ДО запуска, а не после. Иначе убийство процесса на
 * середине оставляло бы `last_full_sync_at` старым, и каждый перезапуск systemd
 * начинал бы новый прогон: ЕИС получила бы десятки обходов подряд, а суточный
 * бюджет Контур.Закупок (30 запросов на метод) кончился бы за утро.
 */
async function performFullSync(
  config: WorkerConfig,
  reason: string,
  trigger: SyncTrigger,
  extraEnv: Record<string, string> = {},
  timeoutMs: number | null = null,
): Promise<FullSyncResult> {
  const startedAt = new Date().toISOString();
  await beat(config, { lastFullSyncAt: startedAt });

  const started = Date.now();
  log(`плановый прогон (${reason}): запускаю ${SYNC_SCRIPT}`);

  // Плановому запуску достаются только подошедшие треки, человеку — все: см.
  // `tracksFor`. Решение передаётся скрипту переменной окружения, а не
  // аргументом, потому что воркер запускает его без аргументов.
  const run = await runScript(SYNC_SCRIPT, { SYNC_TRACKS: tracksFor(trigger), ...extraEnv }, timeoutMs);
  const ok = run.code === 0;
  const error = ok
    ? null
    : `${SYNC_SCRIPT} завершился с кодом ${run.code ?? `сигнал ${run.signal ?? "?"}`}: ` +
      run.tail.slice(-3).join(" | ");

  await beat(config, { lastError: error });
  log(
    ok
      ? `плановый прогон готов за ${secondsSince(started)} с: ${run.summaryLine ?? "итоговая строка не напечатана"}`
      : `плановый прогон не удался за ${secondsSince(started)} с: ${error}`,
  );

  return { ok, note: run.summaryLine, error, timedOut: run.timedOut };
}

/**
 * Задание на документацию.
 *
 * Обе возможные траты заданы правилами домена `documentsJobOptions` и проверены
 * тестами: платная карточка Контур.Закупок (группа purchase, 30 запросов в
 * сутки) и AI-разбор (≈6 ₽ за закупку при суточном потолке 20). Зашивать их
 * здесь — значит держать правило про деньги в файле без тестов.
 *
 * Бесплатное задание (кнопка «Найти новые закупки», панель администратора) не
 * покупает карточку и не запускает разбор: номеров в нём десятки, а оплачивать
 * их без решения партнёра по каждой закупке нельзя. Разбор таких закупок
 * добирает плановый прогон — по тем, что переведены в «Интересное».
 *
 * Платное задание наоборот доводит закупку до конца: партнёр нажал кнопку в
 * карточке одной закупки и согласился заплатить за результат, поэтому ждать
 * разбора ещё два часа до планового прогона после покупки карточки было бы
 * обманом.
 */
async function runDocumentsJob(
  job: SyncJobRow,
  config: WorkerConfig,
): Promise<SyncJobReport> {
  const regNumbers = job.payload?.regNumbers ?? [];
  if (regNumbers.length === 0) {
    return { note: "в задании не оказалось ни одного номера закупки" };
  }

  const options = documentsJobOptions(job.payload);
  if (options.cardRefusal !== null) log(options.cardRefusal);

  // Закупка по ссылке: недостающую в базе сначала берём из ЕИС, иначе загрузка
  // документов пометила бы её «не найдено».
  let linkNote: string | null = null;
  if (job.payload?.importFromLink === true) {
    const imported = await importTendersByLink(regNumbers);
    linkNote = describeLinkImport(imported);
    if (linkNote !== null) log(`по ссылке: ${linkNote}`);
    const usable = [...imported.added, ...imported.existing];
    if (usable.length === 0) {
      return { note: linkNote ?? "закупку по ссылке добавить не удалось", notFound: imported.notFound.length };
    }
  }

  const summary = await runDocumentFetch({
    tenders: regNumbers,
    baseUrl: config.baseUrl,
    runWorker: options.runWorker,
    konturCards: options.konturCards,
  });

  const measures: SyncJobReport = {
    tenders: summary.requested,
    documents: summary.saved,
    already: summary.already,
    unavailable: summary.unavailable,
    notFound: summary.notFound,
    failed: summary.failed,
    analysisJobs: summary.analysis?.completed,
    stoppedEarly: summary.stoppedEarly,
  };

  // Блокировка ЕИС: закупки остались в очереди, а не «недоступны» — и сказать
  // об этом нужно в отчёте, иначе панель покажет обычные нули.
  const blockedWarning =
    summary.blocked > 0 ? eisBlockedDocumentsNote(summary.blocked, summary.eisRetryAt) : null;

  if (options.cardRefusal === null && blockedWarning === null) {
    return linkNote === null ? measures : { ...measures, note: `Готово: ${linkNote}` };
  }

  // Отказ обязан быть виден и в журнале заданий на проде, а не только в логе
  // сервера: `note` вытесняет числа в подписи отчёта, поэтому меры печатаются
  // следом. Иначе партнёр, нажимавший «купить карточку», увидел бы причину и не
  // увидел бы, что именно в итоге загрузилось.
  const base =
    options.cardRefusal === null
      ? describeSyncJobReport(measures)
      : `${options.cardRefusal} ${describeSyncJobReport(measures)}`;
  return {
    ...measures,
    note: blockedWarning === null ? base : `${base} · ${blockedWarning}`,
  };
}

async function runFullSyncJob(job: SyncJobRow, config: WorkerConfig): Promise<SyncJobReport> {
  /*
    Задание с запросом — живой поиск: ищем этот запрос на бесплатных площадках
    и только добавляем найденное. Запрос чистится заново: payload пришёл из
    базы, куда его мог записать кто угодно, и скрипту он уходит переменной
    окружения. Непригодный запрос — отказ задания, а не молчаливый полный
    прогон: иначе «найти юристов» превратилось бы в обход всех источников со
    всеми побочными эффектами.
  */
  const rawLive = job.payload?.liveQuery;
  const liveQuery = rawLive === undefined ? null : normalizeLiveQuery(rawLive);
  if (rawLive !== undefined && liveQuery === null) {
    throw new Error("В задании живого поиска непригодный запрос");
  }

  /*
    Скорость запросов к ЕИС. Обход и живой поиск теперь могут идти одновременно, а адрес у
    них один (см. workerEisRate): без ограничения ЕИС увидела бы удвоенную нагрузку.
  */
  const eisRate = workerEisRate(liveQuery === null ? "sync" : "live", {
    parallel: parallelMode,
    syncBusy: lanes.isBusy("sync"),
  });
  const eisRateEnv: Record<string, string> = eisRate === null ? {} : { EIS_RATE_PER_SEC: eisRate };

  const run = await performFullSync(
    config,
    liveQuery === null ? "задание из очереди" : `живой поиск «${liveQuery}»`,
    "queued",
    liveQuery === null
      ? {
          ...eisRateEnv,
          /*
            «Найти новые закупки» — человек ждёт у экрана. Коды ОКПД2 из карточек ЕИС
            (до 60 карточек, около минуты) — дозаполнение для поиска по
            классификатору, а не сам результат: в ручном прогоне их немного, остальное
            доберёт плановый прогон в своём бюджете (13.10.2026, прогон шёл 283 с).
          */
          SYNC_OKPD2_BUDGET: process.env["SYNC_OKPD2_PRESS_BUDGET"] ?? "15",
        }
      : {
          ...eisRateEnv,
          SYNC_LIVE_QUERY: liveQuery,
          // Регионы чистятся заново: payload пришёл из базы, а скрипту уходит переменной окружения.
          SYNC_LIVE_REGIONS: JSON.stringify(normalizeLiveRegions(job.payload?.liveRegions)),
          SYNC_LIVE_KEYWORDS: JSON.stringify(normalizeLiveSynonyms(liveQuery, job.payload?.liveKeywords)),
        },
    liveQuery === null ? null : LIVE_RUN_CAP_MS,
  );
  /*
    Живой поиск, не уложившийся в предел, заканчивается как выполненный с
    пометкой, а не как сбой: сбой вернул бы задание в очередь, и ещё два
    одинаковых прогона по семь минут заблокировали бы воркер на двадцать минут
    ради запроса, который и в первый раз не уложился.
  */
  if (run.timedOut) {
    return {
      note: `Поиск не уложился в ${String(LIVE_RUN_CAP_MS / 60_000)} минут и остановлен: повторите запрос позже или уточните его.`,
    };
  }
  if (!run.ok)
    throw new Error(run.error ?? `${SYNC_SCRIPT} завершился с ошибкой`);
  return { note: run.note ?? "плановый прогон выполнен" };
}

/**
 * Расчёт сметы по документации.
 *
 * Здесь, а не в приложении, потому что расчёт читает базу ФСНБ с диска: 56 242
 * нормы, около 600 МБ памяти. Серверная функция Vercel её не поднимет, и
 * каталог индекса в поставку не входит — поэтому считает та же машина, что
 * качает документацию.
 *
 * Два источника текста. Закупка из базы: берутся документы, которые уже
 * разобрал воркер. Присланные тексты: экран «Смета» читает файлы в браузере и
 * кладёт в задание только текст — закупки у такого расчёта нет.
 *
 * Документ кладётся в отчёт целиком, вместе с ресурсными строками: из него
 * собираются все три выгрузки, а пересчёт ради выгрузки дал бы другой документ,
 * потому что база цен и редакция нормативов к тому времени могут смениться.
 */
async function runEstimateJob(
  job: SyncJobRow,
  config: WorkerConfig,
): Promise<SyncJobReport> {
  const [
    { buildEstimateFromDocuments, workerBillFetcher, workerImpliedProposer, workerNormPicker },
    { documentRepository },
    { tenderRepository },
    { chooseEstimateZone, EstimatePriceZoneError },
    { listBuiltZones, loadZoneWageScale, readPriceZoneRecords },
    { runCustomerAudit },
    { ensureZoneBuilt, loadZoneDirectory },
    { normalizeEstimateOptions },
    { extractDeclaredPriceLevel },
    { fingerprintZoneByCustomerPrices },
  ] = await Promise.all([
    import("../src/services/estimateService"),
    import("../src/repositories/documentRepository"),
    import("../src/repositories/tenderRepository"),
    import("../src/services/estimateZone"),
    import("../src/repositories/estimateBaseRepository"),
    import("../src/services/customerAuditService"),
    import("../src/services/zoneOnDemand"),
    import("../src/domain/estimate/estimateOptions"),
    import("../src/domain/estimate/customerPriceLevel"),
    import("../src/services/estimateZoneFingerprint"),
  ]);

  const tenderId = job.payload?.tenderId ?? null;
  const supplied = job.payload?.documents ?? [];

  const documents =
    supplied.length > 0
      ? supplied
      : tenderId === null
        ? []
        : (await documentRepository.findByTenderId(tenderId))
            .filter((row) => (row.parsed_text ?? "").length > 0)
            .map((row) => ({
              name:
                (row.raw_json as { title?: string } | null)?.title ??
                row.filename,
              text: row.parsed_text ?? "",
            }));

  if (documents.length === 0) {
    throw new Error(
      tenderId === null
        ? "В задании нет ни одного документа с текстом"
        : `У закупки ${tenderId} нет разобранных документов: сначала нужен глубокий анализ`,
    );
  }

  /*
    Ценовая зона. Цены зависят от зоны, и считать в чужой нельзя: зона берётся у
    пользователя (basis USER) или определяется по региону, адресу и заказчику
    закупки. Нет собранной зоны или выбрать не по чему — задание падает до вызова
    модели, чтобы не тратить токены на расчёт, который всё равно не состоится.
    Адрес в базе чаще всего «Не указан» — это нормально, тогда работает столица.
  */
  const [built, zoneRecords] = await Promise.all([listBuiltZones(), readPriceZoneRecords()]);
  const tenderRow =
    tenderId === null
      ? null
      : ((await tenderRepository.findById(tenderId).catch(() => null)) ??
        (await tenderRepository.findByRegNumber(tenderId).catch(() => null)));
  /*
    Зона, в которой заказчик составил свои ЛСР (шапка формы 421/пр). Она важнее определения по закупке:
    смета заказчика считана в ней, и сравнивать цены имеет смысл только в ней. Ручной выбор важнее: при расхождении
    расчёт не падает, а несёт пометку об уровне цен (`PRICE_LEVEL_DIFFERS`).
  */
  const declared = extractDeclaredPriceLevel(documents);
  for (const disagreement of declared?.disagreements ?? []) log(`уровень цен в сметах заказчика: ${disagreement}`);
  /*
    Закупки 223-ФЗ приходят без региона и адреса поставки: тогда регион берётся из извещения и карточки закупки
    («Место поставки товара, выполнения работы…», «Регион», «Субъект РФ»), иначе без сметы заказчика зону не выбрать.
  */
  const zoneTender = resolveZoneTender(
    tenderRow === null
      ? null
      : { region: tenderRow.region, address: tenderRow.delivery_address, customerName: tenderRow.customer_name },
    documents,
  );
  if (zoneTender.note !== null) log(`зона цен: ${zoneTender.note}`);
  const zoneBase = {
    userPriceZoneId: job.payload?.priceZoneId ?? null,
    declared:
      declared === null
        ? null
        : { subject: declared.subject, zoneName: declared.zoneName, zoneNumber: declared.zoneNumber },
    tender: zoneTender.tender,
    zones: zoneRecords,
    built: built.map(({ priceZoneId, zoneName, subject }) => ({ priceZoneId, zoneName, subject })),
  };
  /*
    Зона по ценам сметы заказчика: ставки труда в его ресурсных строках совпали до копейки с реестром ровно одной зоны субъекта.
    Приоритет ниже ручного выбора и шапки сметы (поэтому при ручном выборе не считается), выше определения по закупке.
  */
  const byPrices =
    zoneBase.userPriceZoneId === null
      ? await fingerprintZoneByCustomerPrices(documents, zoneBase, loadZoneWageScale)
      : { fingerprint: null, message: null };
  if (byPrices.message !== null) log(byPrices.message);
  const zoneInput = { ...zoneBase, fingerprint: byPrices.fingerprint };
  /*
    Зона, которой нет на диске, не отказ, а сборка по требованию: справочник зон ФГИС ЦС
    даёт её номер, воркер скачивает и собирает цены (один процесс за раз, замок в data/, таймаут
    20 минут) и считает дальше. Справочник берётся, только когда без него зону выбрать не
    удалось: собранные зоны выбираются, как раньше, без лишнего запроса.
  */
  let zone: ReturnType<typeof chooseEstimateZone>;
  try {
    zone = chooseEstimateZone(zoneInput);
  } catch (error) {
    if (!(error instanceof EstimatePriceZoneError)) throw error;
    const directory = await loadZoneDirectory();
    if (directory === null) throw error;
    zone = chooseEstimateZone({ ...zoneInput, directory });
  }
  for (const note of zone.notes ?? []) log(`зона цен: ${note}`);
  if (zone.built === false) {
    await ensureZoneBuilt(zone.priceZoneId, { log });
  }

  /*
    Аудит сметы заказчика: тот же отбор документов и та же зона, но без модели.
    Локальная смета заказчика разбирается построчно кодом, ресурсы переоцениваются
    нашими ценами зоны — быстро и бесплатно (токенов 0). Норм при этом не нужно:
    ценовая книга грузится без 185 МБ справочника норм.
  */
  if (job.payload?.mode === "audit") {
    const audit = await runCustomerAudit(documents, zone);
    return {
      audit: {
        reports: [...audit.reports],
        zone: {
          priceZoneId: audit.zone.priceZoneId,
          zoneName: audit.zone.zoneName,
          basis: audit.zone.basis,
          matched: audit.zone.matched,
          northZone: audit.zone.northZone,
        },
        period: audit.period,
        notRecognized: [...audit.notRecognized],
      },
    };
  }

  /*
    Модель зовётся через прод: ключ живёт там, и на этом сервере его нет
    намеренно. Тот же адрес воркер использует для глубокого разбора.
  */
  const result = await buildEstimateFromDocuments(
    {
      regNumber: tenderId ?? "без номера",
      subject: job.payload?.subject ?? "Расчёт по документации",
      documents,
      jobId: job.id,
      parameters: ESTIMATE_PARAMETERS,
      priceZoneId: zone.priceZoneId,
      // Базисно-индексный метод берёт по названию зоны субъект и зону индексов Минстроя.
      priceZoneName: zone.zoneName,
      priceZoneChoice: {
        basis: zone.basis,
        matched: zone.matched,
        northZone: zone.northZone,
        northBasis: zone.northBasis,
        ...(zone.notes === undefined ? {} : { notes: zone.notes }),
      },
      /*
        Выбор пользователя (вид работ, условия производства работ, сроки) приводится к пригодному
        виду заново: payload пришёл из базы. Без выбора начислений сверх норм нет — как раньше.
      */
      options: normalizeEstimateOptions(job.payload?.estimateOptions),
      place:
        tenderRow === null
          ? undefined
          : {
              region: tenderRow.region,
              address: tenderRow.delivery_address,
              customerName: tenderRow.customer_name,
            },
    },
    // Выбор нормы моделью (позиции без шифра) идёт через тот же прод, что и извлечение ведомости; сбой пачки откатывает её на подбор по наименованию.
    // Работы по технологии, которых нет в ведомости (леса, сетки, ограждения), предлагает модель через тот же прод; норму им выбирает тот же «ИИ-сметчик».
    {
      fetcher: workerBillFetcher(config.baseUrl),
      normPicker: workerNormPicker(config.baseUrl),
      impliedProposer: workerImpliedProposer(config.baseUrl),
    },
  );

  return {
    estimate: {
      document: result.document,
      rejected: [...result.rejected],
      documentsWithoutBill: [...result.documentsWithoutBill],
      ...((result.skippedNoVolumes ?? []).length === 0 ? {} : { skippedNoVolumes: (result.skippedNoVolumes ?? []).map((item) => ({ ...item })) }),
      billItems: result.billItems,
      tokensUsed: result.tokensUsed,
      // Подбор норм ИИ: принято, отклонено проверкой, откат на подбор по наименованию, токены (отдельно от tokensUsed ведомости).
      normPick: { ...result.normPick, notes: [...result.normPick.notes] },
      // Строки сверх ведомости: мусор по нормам и работы по технологии от ИИ — сколько добавлено, на сколько рублей, что отклонила проверка.
      generated: {
        debris: { ...result.generated.debris },
        implied: { ...result.generated.implied, notes: [...result.generated.implied.notes] },
      },
      volumeSource:
        result.volumeSource === null
          ? null
          : {
              level: result.volumeSource.level,
              note: result.volumeSource.note,
              documents: [...result.volumeSource.documents],
              ...(result.volumeSource.details === undefined ? {} : { details: [...result.volumeSource.details] }),
            },
      volumeFindings: [...result.volumeFindings],
      normHints: [...result.normHints],
      duplicateDocuments: [...result.duplicateDocuments],
      ...(result.customerLsrs.length === 0 ? {} : { customerLsrs: [...result.customerLsrs] }),
      ...(result.contractCheck === null ? {} : { contractCheck: result.contractCheck }),
      // Ведомость для правки и пересчёта без модели: см. src/services/estimateRecalc.ts.
      bill: result.bill,
    },
  };
}

/**
 * Подпись задания в логе.
 *
 * Платная карточка называется явно: по одной строке журнала должно быть видно,
 * что тик потратил запрос группы purchase, а не качал бесплатные файлы ЕИС.
 */
function describeJob(job: SyncJobRow): string {
  if (job.kind === "full_sync") return "плановый прогон";
  if (job.kind === "estimate") {
    const where =
      job.payload?.tenderId ??
      `присланные документы (${job.payload?.documents?.length ?? 0})`;
    return `${job.payload?.mode === "audit" ? "аудит сметы заказчика" : "расчёт сметы"}: ${where}`;
  }
  const count = job.payload?.regNumbers?.length ?? 0;
  const paid =
    job.payload?.konturCards === true
      ? " с платной карточкой Контур.Закупок"
      : "";
  const reason = job.payload?.reason ? `, причина ${job.payload.reason}` : "";
  return `документация по ${count} закупкам${paid}${reason}`;
}

/**
 * Задание вида, которого эта сборка не знает.
 *
 * Бросает, а не выполняет что-нибудь похожее: сервер мог остаться на старом
 * коде после деплоя без перезапуска, и тогда единственный честный ответ —
 * «я такого не умею», а не догадка о том, что имел в виду прод.
 */
function unknownJobKind(job: SyncJobRow): never {
  throw new Error(
    `Вид задания «${job.kind}» этой сборке воркера неизвестен: обновите код на сервере`,
  );
}

/**
 * Берёт одно задание из очереди и выполняет его.
 *
 * `filter` — дорожка берёт задания только своего вида; без него (флаг --job,
 * последовательный режим) — самое старое задание любого вида, как раньше.
 */
async function processOneJob(config: WorkerConfig, filter?: PendingFilter): Promise<void> {
  let job: SyncJobRow | null;
  try {
    job = await syncJobRepository.claimNextPending(
      config.workerId,
      new Date().toISOString(),
      filter,
    );
  } catch (err) {
    log(`очередь не читается: ${describeError(err)}`);
    return;
  }
  if (!job) return;

  // Сразу, без await после захвата: очистка потерянных не должна увидеть своё
  // задание «зависшим» (см. releaseStaleJobs).
  runningJobIds.add(job.id);
  const started = Date.now();
  log(`задание ${job.id}: ${describeJob(job)} (попытка ${job.attempts})`);
  const stopHeartbeat = startWorkHeartbeat(config);

  try {
    /*
      Вид задания разбирается явно, до последнего значения.

      Раньше здесь стояла развилка «документация или всё остальное», и это
      оказалось опасно: задание нового вида — расчёт сметы — молча уходило в
      полный прогон источников и тратило платные запросы Контур.Закупок. Одно
      нажатие кнопки стоило суточного бюджета поиска и не давало результата.
      Неизвестный вид обязан падать: задание вернётся в очередь и дождётся
      воркера, который его понимает, а деньги останутся целы.
    */
    const report =
      job.kind === "documents"
        ? await runDocumentsJob(job, config)
        : job.kind === "estimate"
          ? await runEstimateJob(job, config)
          : job.kind === "full_sync"
            ? await runFullSyncJob(job, config)
            : unknownJobKind(job);

    await syncJobRepository.complete(job.id, report);
    await beat(config, { lastJobId: job.id, lastError: null });
    log(
      `задание ${job.id} выполнено за ${secondsSince(started)} с: ${describeSyncJobReport(report)}`,
    );
  } catch (err) {
    const message = describeError(err);
    try {
      const status = await syncJobRepository.fail(
        job.id,
        message,
        job.attempts,
      );
      await beat(config, { lastJobId: job.id, lastError: message });
      log(
        status === "pending"
          ? `задание ${job.id} не выполнено и вернулось в очередь: ${message}`
          : `задание ${job.id} закрыто с ошибкой после ${job.attempts} попыток: ${message}`,
      );
    } catch (dbErr) {
      // База недоступна: задание осталось в processing и вернётся в очередь
      // очисткой потерянных на следующем старте. Молчать об этом нельзя.
      log(
        `задание ${job.id} не выполнено (${message}), ` +
          `и записать сбой не удалось: ${describeError(dbErr)}`,
      );
    }
  } finally {
    runningJobIds.delete(job.id);
    stopHeartbeat();
  }
}

/**
 * Возвращает в очередь задания, оставленные убитым процессом.
 *
 * На каждом тике, а не только перед выбором задания: `planTick` решает по числу
 * pending, поэтому строка, зависшая в `processing` после перезагрузки или
 * `systemctl kill`, не видна ни домену, ни панели. Без этой очистки она лежала
 * бы так вечно — документация по кнопке не скачалась бы, и единственным следом
 * осталась плитка «в работе».
 *
 * Собственные задания не трогаются. В последовательном режиме тик на время работы
 * не выполнялся, и перехватить своё задание воркер не мог. На дорожках тик идёт
 * каждые десять секунд поверх работающих дел, и задание дольше порога (45 минут
 * по умолчанию, настраивается) вернулось бы в очередь и выполнилось бы дважды, —
 * поэтому в очистку передаётся список заданий, которые выполняет этот процесс.
 */
async function releaseStaleJobs(config: WorkerConfig): Promise<void> {
  try {
    const stale = await syncJobRepository.resetStaleJobs(
      config.staleJobAfterMin,
      Date.now(),
      [...runningJobIds],
    );
    if (stale > 0) log(`возвращено в очередь потерянных заданий: ${stale}`);
  } catch (err) {
    log(`очистка потерянных заданий не удалась: ${describeError(err)}`);
  }
}

/** Конфигурация для обработчика ошибок дорожек, которому её негде взять параметром. */
let laneErrorConfig: WorkerConfig | null = null;

/**
 * Занятость дорожек. Любая ошибка дела попадает сюда и в журнал, а не в цикл:
 * сбой одной дорожки не должен ни остановить остальные, ни оставить её «занятой».
 */
const lanes = new LaneRunner<LaneId>((lane, error) => {
  const message = describeError(error);
  rawConsoleLog(
    `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${LANE_TAGS[lane]} дорожка завершилась ошибкой: ${message}`,
  );
  if (laneErrorConfig !== null) void beat(laneErrorConfig, { lastError: message });
});

/** Задание, которое берёт дорожка: вид и (для full_sync) живой он или нет. */
function laneFilter(start: LaneStart): PendingFilter | null {
  if (start.kind !== "job") return null;
  switch (start.lane) {
    case "sync":
      return { kind: "full_sync", live: false };
    case "live":
      return { kind: "full_sync", live: true };
    case "documents":
      return { kind: "documents" };
    case "estimate":
      return { kind: "estimate" };
  }
}

/** Дело одной дорожки. Бросать может что угодно — `lanes` поймает и освободит дорожку. */
async function runLaneStart(config: WorkerConfig, start: LaneStart): Promise<void> {
  if (stopRequested) return;

  if (start.lane === "sync" && start.kind === "scheduled") {
    // Плановый обход — фон, его никто не ждёт: идёт помедленнее, чтобы рядом с
    // живым поиском не удваивать нагрузку на ЕИС (см. workerEisRate).
    const rate = workerEisRate("sync", { parallel: true, syncBusy: false });
    const stopHeartbeat = startWorkHeartbeat(config);
    try {
      await performFullSync(config, start.reason, "scheduled", rate === null ? {} : { EIS_RATE_PER_SEC: rate });
    } finally {
      stopHeartbeat();
    }
    return;
  }
  // Пульс на время дела ведут сами `processOneJob` и `drainPendingAnalysis`.
  if (start.lane === "documents" && start.kind === "drain") {
    await drainPendingAnalysis(config);
    return;
  }
  const filter = laneFilter(start);
  if (filter !== null) await processOneJob(config, filter);
}

/**
 * Один проход в параллельном режиме: пульс, решение домена, запуск свободных дорожек.
 *
 * Дела не ждутся: тик только раздаёт работу и возвращается, поэтому через десять секунд
 * он снова смотрит очередь, пока обход и расчёт сметы ещё идут. Заданию человека,
 * поставленному в это время, не мешают ни обход, ни дела другого вида.
 */
async function laneTick(config: WorkerConfig): Promise<void> {
  await detectEgress();
  await releaseStaleJobs(config);

  const [heartbeat, pending] = await Promise.all([
    syncJobRepository.readHeartbeat(config.workerId),
    syncJobRepository.countPendingByLane(),
  ]);
  await beat(config);

  const busy = Object.fromEntries(LANE_IDS.map((lane) => [lane, lanes.isBusy(lane)])) as Record<LaneId, boolean>;
  const plan = planLanes({ heartbeat, busy, pending }, Date.now(), config);
  if (plan.mode !== "parallel") return;

  const allIdle = !Object.values(busy).some(Boolean);
  let worked = false;
  for (const start of plan.starts) {
    if (stopRequested) break;
    // Просмотр задач разбора каждые десять секунд — не событие для журнала:
    // о заходе скажет сама `drainPendingAnalysis`, когда он случится.
    const quiet = start.kind === "drain";
    const started = lanes.start(start.lane, () =>
      laneTagStore.run(LANE_TAGS[start.lane], async () => {
        if (!quiet) log(`→ ${start.reason}`);
        await runLaneStart(config, start);
      }),
    );
    if (started && !quiet) worked = true;
  }

  if (!worked && allIdle && Date.now() - lastIdleLogAt >= IDLE_LOG_INTERVAL_MS) {
    log(`— ${planTick({ heartbeat, pending: 0 }, Date.now(), config).reason}`);
    lastIdleLogAt = Date.now();
  }
}

/** Один проход: пульс, решение домена, одно действие. */
async function tick(config: WorkerConfig): Promise<void> {
  await detectEgress();
  await releaseStaleJobs(config);

  const heartbeat = await syncJobRepository.readHeartbeat(config.workerId);
  const pending = await syncJobRepository.countPending();
  await beat(config);

  const action: TickAction = planTick(
    { heartbeat, pending },
    Date.now(),
    config,
  );
  if (action.kind === "idle") {
    // Очередь заданий пуста — смотрим задачи разбора, которые ждут без
    // задания на загрузку (поставлены до кнопки или не дождались документов).
    if (await drainPendingAnalysis(config)) return;
    if (Date.now() - lastIdleLogAt >= IDLE_LOG_INTERVAL_MS) {
      log(`— ${action.reason}`);
      lastIdleLogAt = Date.now();
    }
    return;
  }

  log(`→ ${action.reason}`);
  const stopHeartbeat = startWorkHeartbeat(config);
  try {
    if (action.kind === "full_sync") {
      await performFullSync(config, action.reason, "scheduled");
      return;
    }
    await processOneJob(config);
  } finally {
    stopHeartbeat();
  }
}

/**
 * Довести ожидающие задачи разбора: скачать документацию и отдать модели.
 *
 * `runDocumentFetch` без номеров сам берёт закупки из очереди разбора, качает
 * и распаковывает их документацию и вызывает разбор на проде. Возвращает true,
 * если заход был, — тогда тик на этом заканчивается.
 */
async function drainPendingAnalysis(config: WorkerConfig): Promise<boolean> {
  let pending: string[];
  try {
    pending = (await analysisJobRepository.findPending(20)).map((job) => job.id);
  } catch (err) {
    log(`очередь разбора не прочитана: ${describeError(err)}`);
    return false;
  }
  const now = Date.now();
  if (!shouldDrainAnalysisQueue(pending, analysisQueueMemory, now)) return false;
  analysisQueueMemory = { jobIds: pending, at: now };

  log(`→ задач разбора ждут: ${pending.length} — загружаю документацию и запускаю разбор`);
  const stopHeartbeat = startWorkHeartbeat(config);
  try {
    await runDocumentFetch({ baseUrl: config.baseUrl, runWorker: true });
  } finally {
    stopHeartbeat();
  }
  return true;
}

/**
 * Проверка баланса модели при старте и затем по таймеру.
 *
 * Выполняется в стороне от цикла тиков и не ждётся: сеть и почта могут висеть
 * десятки секунд, а очередь заданий ждать не должна. `runLlmBalanceCheck` сама
 * не бросает; `.catch` стоит на случай, если это изменится. Возвращает остановку
 * таймера.
 */
function startBalanceWatch(): () => void {
  const deps = { ...defaultBalanceAlertDeps(), log: (message: string) => log(`баланс ИИ: ${message}`) };
  const check = (): void => {
    runLlmBalanceCheck({}, deps).catch((err: unknown) => {
      log(`баланс ИИ: проверка упала: ${describeError(err)}`);
    });
  };
  check();
  const timer = setInterval(check, BALANCE_CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Письма о пробном периоде («закончится завтра», «закончился») раз в час.
 *
 * Как и проверка баланса, не ждётся и не роняет цикл: `runTrialNotices` сама не
 * бросает, `.catch` — на случай, если это изменится. Почта не настроена — проверка
 * пропускается. Возвращает остановку таймера.
 */
function startTrialNoticeWatch(): () => void {
  const deps = { ...defaultTrialNoticeDeps(), log: (message: string) => log(`пробный период: ${message}`) };
  const check = (): void => {
    runTrialNotices(deps).catch((err: unknown) => {
      log(`пробный период: проверка упала: ${describeError(err)}`);
    });
  };
  check();
  const timer = setInterval(check, TRIAL_NOTICE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    const started = Date.now();
    const timer = setInterval(
      () => {
        if (stopRequested || Date.now() - started >= ms) {
          clearInterval(timer);
          done();
        }
      },
      Math.min(1000, ms),
    );
  });
}

/**
 * Сколько ждём, пока идущий прогон закончится сам, прежде чем остановить его.
 * Меньше `TimeoutStopSec` юнита (deploy/tenderfit-worker.service): после этого
 * срока systemd убивает всё без разговоров.
 */
const STOP_GRACE_MS = Number(process.env["WORKER_STOP_GRACE_MS"] ?? "") || 9.5 * 60_000;

function requestStop(signal: string): void {
  if (stopRequested) {
    log(`${signal}: завершаюсь немедленно`);
    for (const child of runningChildren) if (child.exitCode === null) child.kill("SIGTERM");
    process.exit(130);
  }
  stopRequested = true;
  const alive = [...runningChildren].filter((child) => child.exitCode === null);
  if (alive.length === 0) {
    log(`${signal}: доделываю текущее действие и выхожу`);
    return;
  }
  /*
    Прогон не убиваем сразу. 12.10.2026 перезапуск воркера во время «Найти
    новые закупки» оборвал прогон сигналом (код 143): задание вернулось в
    очередь и началось с нуля, человек прождал лишние восемь минут. Теперь
    воркер перестаёт брать новое и ждёт, пока прогоны закончатся сами, — но не
    дольше STOP_GRACE_MS: затем все оставшиеся останавливаются, а не остаются
    сиротами, которые писали бы в базу, пока новый воркер занят тем же. На дорожках
    прогонов может быть два (обход и поиск), и срок общий, а не на каждый.

    Чтобы дочерние процессы не получили SIGTERM от systemd раньше нас, юнит
    использует KillMode=mixed: сигнал уходит только воркеру.
  */
  log(
    `${signal}: жду, пока текущие прогоны (${alive.length}) закончатся ` +
      `(до ${Math.round(STOP_GRACE_MS / 60_000)} мин), и выхожу`,
  );
  const timer = setTimeout(() => {
    const left = [...runningChildren].filter((child) => child.exitCode === null);
    if (left.length === 0) return;
    log(`прогоны не закончились за ${Math.round(STOP_GRACE_MS / 60_000)} мин — останавливаю (${left.length})`);
    for (const child of left) child.kill("SIGTERM");
  }, STOP_GRACE_MS);
  // Таймер не должен держать процесс: закончились прогоны — воркер выходит сразу.
  timer.unref();
}

interface CliOptions {
  once: boolean;
  forceFullSync: boolean;
  forceJob: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const flags = new Set(argv.map((arg) => arg.toLowerCase()));
  return {
    once: flags.has("--once"),
    forceFullSync: flags.has("--full-sync"),
    forceJob: flags.has("--job"),
  };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const config = resolveWorkerConfig(process.env);
  requireSupabaseEnv();
  laneErrorConfig = config;
  // Дорожки нужны только демону: флаги --once, --job, --full-sync выполняют одно
  // действие последовательно, как раньше.
  parallelMode = config.parallel && !cli.once && !cli.forceFullSync && !cli.forceJob;

  const lock = acquireLock();
  if (lock === null) process.exit(1);

  log(
    `воркер ${config.workerId} запущен: плановый прогон ` +
      `${config.fullSyncEnabled ? `раз в ${config.intervalHours} ч` : "отключён"}, ` +
      `опрос очереди раз в ${Math.round(config.tickMs / 1000)} с, ` +
      `${parallelMode ? "дорожки: обход, поиск, документы, смета" : "последовательно (WORKER_PARALLEL=0 или одноразовый флаг)"}, ` +
      `прод ${config.baseUrl}, версия кода ${workerVersion()}`,
  );

  await detectEgress(true);
  log(
    egress.ip
      ? `выход в сеть: ${egress.ip}${egress.country ? ` (${egress.country})` : " (страна не определена)"}`
      : "выход в сеть определить не удалось: ни один сервис не ответил",
  );
  if (egress.country && egress.country !== "RU") {
    log(
      `ВНИМАНИЕ: выход из ${egress.country}, а не из России. ЕИС и её хранилище файлов ` +
        "не отвечают зарубежным адресам: документация не загрузится, плановый прогон прервётся.",
    );
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => requestStop(signal));
  }

  try {
    if (cli.forceFullSync) {
      const stopHeartbeat = startWorkHeartbeat(config);
      try {
        const run = await performFullSync(config, "явный флаг --full-sync", "manual");
        if (!run.ok) process.exitCode = 1;
      } finally {
        stopHeartbeat();
      }
      return;
    }
    if (cli.forceJob) {
      await processOneJob(config);
      return;
    }
    if (cli.once) {
      await tick(config);
      return;
    }

    const stopBalanceWatch = startBalanceWatch();
    const stopTrialNoticeWatch = startTrialNoticeWatch();
    const stopNotificationWatch = startNotificationWatch(log);
    if (parallelMode) installLaneConsolePrefix();
    while (!stopRequested) {
      try {
        // Параллельный режим раздаёт работу дорожкам и возвращается; прежний
        // последовательный выполняет одно действие и ждёт его (WORKER_PARALLEL=0).
        if (parallelMode) await laneTick(config);
        else await tick(config);
      } catch (err) {
        // Тик обязан пережить сбой базы или сети: воркер работает без присмотра,
        // и падение из-за одной недоступной записи оставило бы партнёра без
        // документации до ручного вмешательства.
        const message = describeError(err);
        log(`тик завершился ошибкой: ${message}`);
        await beat(config, { lastError: message });
      }
      await sleep(config.tickMs);
    }
    stopBalanceWatch();
    stopTrialNoticeWatch();
    stopNotificationWatch();
    // Дорожки доделывают начатое: после сигнала новых дел не берут, а идущие
    // заканчиваются сами (прогоны — в пределах STOP_GRACE_MS, затем их останавливает
    // requestStop). Выходим, когда свободны все.
    if (lanes.size > 0) log(`жду дорожки: ${lanes.busyLanes().map((lane) => LANE_TAGS[lane]).join(" ")}`);
    await lanes.whenIdle();
    log("воркер остановлен");
  } finally {
    releaseLock(lock);
  }
}

main().catch((err: unknown) => {
  console.error("Критическая ошибка:", describeError(err));
  process.exitCode = 1;
  // Небольшая отсрочка перед принудительным выходом. Немедленный process.exit
  // обрывает незакрытые сокеты на середине, и Node на Windows в этом месте
  // падает с внутренним assertion и кодом 127 вместо единицы: по коду возврата
  // systemd решает, перезапускать ли юнит, и 127 читался бы как «команда не
  // найдена».
  setTimeout(() => process.exit(1), 250);
});
