import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatMoscowTime } from "@/lib/moscowTime";

/**
 * Общий затвор запросов к ЕИС (zakupki.gov.ru).
 *
 * Зачем. С 10.10.2026 ЕИС с нашего единственного российского адреса время от
 * времени отвечает HTTP 434 (её код блокировки) на всё подряд, и держится это
 * часами. Прежний код ловил только 403 и 429, а 434 ретраил через 0,6 / 1,2 /
 * 2,4 секунды: мы продолжали долбить сайт, который уже отказал, а каждый процесс
 * (плановый прогон, живой поиск, догрузка документов, воркер) узнавал о блокировке
 * заново и сам. Итог прогона при этом звучал «Готово: 353 сохранено, 0 ошибок».
 *
 * Что делает затвор.
 *  - Ответ 434, 403 или 429 — сигнал блокировки: ставится общий «карантин»
 *    `blockedUntil` = сейчас + пауза. Пауза начинается с 2 минут, удваивается на
 *    каждой подряд идущей блокировке и упирается в 30 минут.
 *  - Пока карантин идёт, любой запрос к ЕИС отказывает сразу, БЕЗ обращения к
 *    сети, исключением `EisBlockedError` с понятным русским текстом.
 *  - Карантин кончился — следующий запрос идёт как обычно (это «проба»). Он
 *    снова заблокирован — пауза удваивается; прошёл — серия и карантин сбрасываются.
 *    Ручного сброса не нужно: плановый прогон сам продолжит работу после паузы.
 *
 * Состояние общее для процессов одной машины: маленький JSON-файл
 * (`data/eis-gate.json` в корне проекта, путь переопределяет `EIS_GATE_FILE`).
 * Запись атомарная (временный файл + rename). Файла нет, он битый или не
 * читается — карантина нет: затвор не имеет права сам ломать запросы. Если писать
 * некуда (серверная функция Vercel с read-only диском), состояние живёт в памяти
 * процесса.
 *
 * Лимитов для пользователей затвор не вводит: скорость запросов (3 в секунду на
 * процесс) и количество поисков он не трогает, он только перестаёт спрашивать
 * сайт, который уже сказал «нельзя».
 *
 * Чужой блок-страницы с кодом 200 (капча) затвор не ловит: надёжного признака у
 * неё нет, а ложное срабатывание остановило бы работу с живым сайтом.
 */

/** HTTP-статусы, которыми ЕИС сообщает о блокировке адреса. */
export const EIS_BLOCK_STATUSES: ReadonlySet<number> = new Set([434, 403, 429]);

/** Первая пауза после блокировки. */
export const EIS_BACKOFF_BASE_MS = 2 * 60_000;
/** Потолок паузы: дольше полчаса не ждём, проба каждые 30 минут дёшева. */
export const EIS_BACKOFF_MAX_MS = 30 * 60_000;
/**
 * Серия «подряд идущих» блокировок забывается, если с конца последнего
 * карантина прошло столько: блокировка через сутки — новая история, а не
 * продолжение вчерашней, и начинать с 30 минут незачем.
 */
export const EIS_STREAK_FORGET_MS = 2 * 60 * 60_000;

/** Блокирует ли ответ с таким статусом наш адрес. */
export function isEisBlockStatus(status: number): boolean {
  return EIS_BLOCK_STATUSES.has(status);
}

/** Адрес принадлежит ЕИС (страницы и filestore). */
export function isEisUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "zakupki.gov.ru" || host.endsWith(".zakupki.gov.ru");
  } catch {
    return false;
  }
}

/** Пауза после n-й подряд блокировки: 2, 4, 8, 16, 30, 30… минут. */
export function eisBackoffMs(streak: number): number {
  const power = Math.max(0, Math.min(streak - 1, 16));
  return Math.min(EIS_BACKOFF_BASE_MS * 2 ** power, EIS_BACKOFF_MAX_MS);
}

export { formatMoscowTime };

/**
 * ЕИС ограничила доступ, а мы сознательно не спрашиваем её до `retryAt`.
 *
 * Не «сбой»: вызывающий код обязан отличать эту ошибку (остановить обращения к
 * ЕИС, оставить работу на следующий прогон) от обычной сетевой неудачи.
 */
export class EisBlockedError extends Error {
  readonly retryAt: number;
  readonly status: number | null;

  constructor(retryAt: number, status: number | null) {
    super(
      `ЕИС временно ограничила доступ к серверу${status === null ? "" : ` (HTTP ${String(status)})`}, ` +
        `повторим после ${formatMoscowTime(retryAt)} МСК`,
    );
    this.name = "EisBlockedError";
    this.retryAt = retryAt;
    this.status = status;
  }
}

/** Ошибка — блокировка ЕИС (проверка и по классу, и по имени: модули могут дублироваться бандлером). */
export function isEisBlockedError(err: unknown): err is EisBlockedError {
  return (
    err instanceof EisBlockedError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "EisBlockedError" &&
      typeof (err as { retryAt?: unknown }).retryAt === "number")
  );
}

interface GateState {
  /** Момент (мс), до которого ЕИС не спрашиваем; 0 — карантина нет. */
  blockedUntil: number;
  /** Сколько блокировок подряд без единого успешного ответа. */
  streak: number;
  /** Статус последней блокировки: для текста сообщения. */
  status: number | null;
}

const EMPTY: GateState = { blockedUntil: 0, streak: 0, status: null };

export interface EisGateOptions {
  /** Файл состояния; по умолчанию EIS_GATE_FILE или `data/eis-gate.json` в cwd. */
  file?: string;
  /** Часы; для тестов. */
  now?: () => number;
}

function defaultFile(): string {
  const fromEnv = process.env["EIS_GATE_FILE"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(process.cwd(), "data", "eis-gate.json");
}

function parseState(raw: string): GateState | null {
  try {
    const data = JSON.parse(raw) as Partial<GateState> | null;
    if (typeof data !== "object" || data === null) return null;
    const { blockedUntil, streak, status } = data;
    if (typeof blockedUntil !== "number" || !Number.isFinite(blockedUntil)) return null;
    if (typeof streak !== "number" || !Number.isFinite(streak) || streak < 0) return null;
    return {
      blockedUntil: Math.max(0, blockedUntil),
      streak: Math.floor(streak),
      status: typeof status === "number" ? status : null,
    };
  } catch {
    return null;
  }
}

export class EisGate {
  private readonly fileOption: string | undefined;
  private readonly now: () => number;
  /** Копия состояния в памяти: единственный источник там, где файл недоступен. */
  private memory: GateState = EMPTY;
  /** Запись в файл когда-либо удалась: значит, отсутствие файла — это сброс, а не «писать некуда». */
  private fileWorks = false;

  constructor(options: EisGateOptions = {}) {
    this.fileOption = options.file;
    this.now = options.now ?? Date.now;
  }

  private get file(): string {
    // Путь читается при каждом обращении: тесты и воркер меняют EIS_GATE_FILE уже после загрузки модуля.
    return this.fileOption ?? defaultFile();
  }

  /**
   * Текущее состояние. Файл мал, поэтому читается на каждый запрос: так
   * карантин, поставленный соседним процессом, виден сразу, а ручное удаление
   * файла работает как сброс.
   */
  private load(): GateState {
    try {
      const parsed = parseState(readFileSync(this.file, "utf-8"));
      if (parsed !== null) {
        this.memory = parsed;
        return parsed;
      }
    } catch {
      // Файла нет или он не читается — решает ветка ниже.
    }
    // Файл битый или пропал. Если мы им пользовались — это сброс (оператор удалил
    // файл или он испорчен): карантина нет. Если писать вообще некуда — верим памяти.
    if (this.fileWorks) {
      this.memory = EMPTY;
      return EMPTY;
    }
    return this.memory;
  }

  private save(state: GateState): void {
    this.memory = state;
    const file = this.file;
    const tmp = `${file}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(state), "utf-8");
      renameSync(tmp, file);
      this.fileWorks = true;
    } catch {
      // Писать некуда — остаёмся на памяти процесса; затвор запросы не ломает.
      try {
        unlinkSync(tmp);
      } catch {
        // временного файла могло не быть
      }
    }
  }

  /** До какого момента (мс) ЕИС не спрашиваем; null — карантина нет. */
  blockedUntil(): { retryAt: number; status: number | null } | null {
    const state = this.load();
    if (state.blockedUntil > this.now()) {
      return { retryAt: state.blockedUntil, status: state.status };
    }
    return null;
  }

  /** Бросает `EisBlockedError`, если идёт карантин. Сети не касается. */
  assertOpen(): void {
    const block = this.blockedUntil();
    if (block !== null) throw new EisBlockedError(block.retryAt, block.status);
  }

  /**
   * Записывает блокировку и возвращает ошибку, которую вызывающий код бросает.
   *
   * Ответ, пришедший, пока карантин уже идёт (запрос был в полёте, когда
   * соседний поток получил блокировку), серию не удлиняет: иначе десять
   * параллельных запросов разом довели бы паузу до потолка.
   */
  recordBlock(status: number): EisBlockedError {
    const now = this.now();
    const state = this.load();
    if (state.blockedUntil > now) {
      return new EisBlockedError(state.blockedUntil, state.status ?? status);
    }
    const stale = state.blockedUntil > 0 && now - state.blockedUntil > EIS_STREAK_FORGET_MS;
    const streak = (stale ? 0 : state.streak) + 1;
    const next: GateState = { blockedUntil: now + eisBackoffMs(streak), streak, status };
    this.save(next);
    return new EisBlockedError(next.blockedUntil, status);
  }

  /** Успешный ответ ЕИС: серия и карантин сбрасываются. Файл не трогается, пока сбрасывать нечего. */
  recordSuccess(): void {
    const state = this.load();
    if (state.blockedUntil === 0 && state.streak === 0) return;
    this.save(EMPTY);
  }
}

/** Затвор процесса по умолчанию: его используют все вызовы, которым не передали свой. */
export const eisGate = new EisGate();

/**
 * Обёртка запроса к ЕИС: карантин проверяется до сети, ответ — после.
 *
 * Адреса не ЕИС проходят без изменений: скрипты скачивания документов ходят и на
 * Контур, и на ТЭК-Торг, а их блокировки к ЕИС отношения не имеют.
 *
 * Статус блокировки превращается в `EisBlockedError` (тело ответа отбрасывается),
 * любой другой ответ ниже 500 говорит, что сайт нас обслуживает, и сбрасывает серию.
 */
export async function gatedEisFetch(
  url: string,
  doFetch: () => Promise<Response>,
  gate: EisGate = eisGate,
): Promise<Response> {
  if (!isEisUrl(url)) return doFetch();
  gate.assertOpen();
  const response = await doFetch();
  if (isEisBlockStatus(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw gate.recordBlock(response.status);
  }
  if (response.status < 500) gate.recordSuccess();
  return response;
}
