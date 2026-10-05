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
 * Одно действие на тик, а не всё сразу: плановый прогон идёт десятки минут, и
 * параллельная загрузка документации качала бы те же вложения дважды.
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
 *                             потерянным, по умолчанию 45
 *
 * NODE_TLS_REJECT_UNAUTHORIZED=0 сюда не принадлежит: переменная осталась от
 * локального обхода корпоративного прокси и отключает проверку сертификатов.
 * Воркер предупреждает о ней при старте.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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
import { documentsJobOptions } from "../src/domain/documentsJob";
import {
  planTick,
  resolveWorkerConfig,
  type TickAction,
  type WorkerConfig,
} from "../src/domain/workerSchedule";
import { syncJobRepository } from "../src/repositories/syncJobRepository";
import type { SyncJobReport, SyncJobRow } from "../src/types/database";
import { tracksFor, type SyncTrigger } from "../src/domain/sourceCadence";
import { LIVE_RUN_CAP_MS, normalizeLiveQuery, normalizeLiveRegions, normalizeLiveSynonyms } from "../src/domain/liveSearch";

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

/** Файл-замок: второй воркер на той же очереди удвоил бы загрузку. */
const LOCK_PATH = resolve(PROJECT_ROOT, "logs", "worker.lock");

let stopRequested = false;
let currentChild: ChildProcess | null = null;
let lastIdleLogAt = 0;
let egress: EgressInfo = { ip: null, country: null };
let egressCheckedAt = 0;

function log(message: string): void {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${stamp}] ${message}`);
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
function startWorkHeartbeat(config: WorkerConfig): () => void {
  const timer = setInterval(() => {
    void beat(config);
  }, WORK_HEARTBEAT_MS);
  return () => clearInterval(timer);
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

    currentChild = child;
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
    const pipe = (chunk: Buffer): void => {
      process.stdout.write(chunk);
      for (const line of chunk.toString("utf8").split("\n")) {
        const trimmed = line.trimEnd();
        if (trimmed.length === 0) continue;
        tail.push(trimmed);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };

    child.stdout?.on("data", pipe);
    child.stderr?.on("data", pipe);
    child.on("error", (err) => {
      if (timer !== null) clearTimeout(timer);
      currentChild = null;
      rejectRun(err);
    });
    child.on("close", (code, signal) => {
      if (timer !== null) clearTimeout(timer);
      currentChild = null;
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

  if (options.cardRefusal === null) return measures;

  // Отказ обязан быть виден и в журнале заданий на проде, а не только в логе
  // сервера: `note` вытесняет числа в подписи отчёта, поэтому меры печатаются
  // следом. Иначе партнёр, нажимавший «купить карточку», увидел бы причину и не
  // увидел бы, что именно в итоге загрузилось.
  return {
    ...measures,
    note: `${options.cardRefusal} ${describeSyncJobReport(measures)}`,
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

  const run = await performFullSync(
    config,
    liveQuery === null ? "задание из очереди" : `живой поиск «${liveQuery}»`,
    "queued",
    liveQuery === null
      ? {}
      : {
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
    { buildEstimateFromDocuments, workerBillFetcher },
    { documentRepository },
  ] = await Promise.all([
    import("../src/services/estimateService"),
    import("../src/repositories/documentRepository"),
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
    Модель зовётся через прод: ключ живёт там, и на этом сервере его нет
    намеренно. Тот же адрес воркер использует для глубокого разбора.
  */
  const result = await buildEstimateFromDocuments(
    {
      regNumber: tenderId ?? "без номера",
      subject: job.payload?.subject ?? "Расчёт по документации",
      documents,
      parameters: ESTIMATE_PARAMETERS,
    },
    { fetcher: workerBillFetcher(config.baseUrl) },
  );

  return {
    estimate: {
      document: result.document,
      rejected: [...result.rejected],
      documentsWithoutBill: [...result.documentsWithoutBill],
      billItems: result.billItems,
      tokensUsed: result.tokensUsed,
    },
  };
}

/**
 * Параметры расчёта по умолчанию.
 *
 * Резервные нормативы НР и СП нужны только там, где у расценки нет указателя:
 * основной путь — нормативы по виду работ из приказов 812/пр и 774/пр.
 * Лимитированные затраты нулевые: зимнее удорожание и временные здания зависят
 * от объекта и сроков, и подставить их за пользователя значит дописать в смету
 * деньги, которых он не просил.
 */
const ESTIMATE_PARAMETERS = {
  vatPercent: 20,
  overhead: {
    overheadPercent: 100,
    profitPercent: 65,
    workType: "резерв документа",
    source: "Резервный норматив: указателя у расценки не нашлось",
  },
  limited: {
    winterSurchargePercent: 0,
    temporaryStructuresPercent: 0,
    source: "Лимитированные затраты не начислялись",
  },
  indices: null,
} as const;

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
    return `расчёт сметы: ${where}`;
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

/** Берёт одно задание из очереди и выполняет его. */
async function processOneJob(config: WorkerConfig): Promise<void> {
  let job: SyncJobRow | null;
  try {
    job = await syncJobRepository.claimNextPending(
      config.workerId,
      new Date().toISOString(),
    );
  } catch (err) {
    log(`очередь не читается: ${describeError(err)}`);
    return;
  }
  if (!job) return;

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
 * Перехватить собственное задание воркер не может: тик последовательный, на
 * время дочернего процесса тиков нет, а отдельный таймер пишет только пульс.
 */
async function releaseStaleJobs(config: WorkerConfig): Promise<void> {
  try {
    const stale = await syncJobRepository.resetStaleJobs(
      config.staleJobAfterMin,
    );
    if (stale > 0) log(`возвращено в очередь потерянных заданий: ${stale}`);
  } catch (err) {
    log(`очистка потерянных заданий не удалась: ${describeError(err)}`);
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

function requestStop(signal: string): void {
  if (stopRequested) {
    log(`${signal}: завершаюсь немедленно`);
    process.exit(130);
  }
  stopRequested = true;
  log(`${signal}: доделываю текущее действие и выхожу`);
  // Дочерний прогон убивается вместе с воркером: оставленный сиротой, он
  // продолжил бы писать в базу, пока новый воркер уже занят тем же.
  if (currentChild && currentChild.exitCode === null)
    currentChild.kill("SIGTERM");
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

  const lock = acquireLock();
  if (lock === null) process.exit(1);

  log(
    `воркер ${config.workerId} запущен: плановый прогон ` +
      `${config.fullSyncEnabled ? `раз в ${config.intervalHours} ч` : "отключён"}, ` +
      `опрос очереди раз в ${Math.round(config.tickMs / 1000)} с, ` +
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

    while (!stopRequested) {
      try {
        await tick(config);
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
