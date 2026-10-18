import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

/**
 * Замок-файл сборки ценовых зон: одна сборка зоны за раз на машину.
 *
 * Сборка зоны — это 20 МБ скачанного, до 400 МБ памяти и минуты процессора. Две сборки
 * одновременно (ночное обновление и сборка по требованию из воркера) на сервере в 4 ГБ, где
 * живут приложение и воркер, — это риск нехватки памяти, а две сборки одной зоны ещё и пишут
 * в одно место. Поэтому перед сборкой берётся замок: файл, созданный с флагом «только если
 * не существует» (`wx`) — операция атомарная на любой файловой системе, кроме сетевых.
 *
 * Чей замок и жив ли он. В файле — владелец (pid, машина, зона, время начала). Замок считается
 * брошенным, если процесс-владелец на этой машине не существует или замок старше `staleMs`
 * (сборка столько не идёт, значит владелец завис или погиб вместе с машиной). Брошенный замок
 * снимает тот, кто его нашёл. Гонка двух снимающих возможна, но окно — микросекунды, а цена —
 * две одновременные сборки, которые и без того пишут во временные каталоги разными путями и
 * меняют каталог зоны переименованием.
 */

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  /** Зона, которую собирает владелец. */
  readonly zoneId: number | null;
  /** Кто собирает: «build-all-zones», «worker». */
  readonly by: string;
}

export interface LockOptions {
  readonly path: string;
  /** Сколько ждать, пока замок освободится, мс. 0 — не ждать. */
  readonly waitMs: number;
  /** Старше этого возраста замок считается брошенным, мс. */
  readonly staleMs: number;
  /** Период опроса, мс. */
  readonly pollMs?: number;
  readonly zoneId: number | null;
  readonly by: string;
  /** Подмены для тестов: время, проверка жизни процесса, ожидание, имя машины, pid. */
  readonly now?: () => number;
  readonly isAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly host?: string;
  readonly pid?: number;
}

export interface LockHandle {
  readonly owner: LockOwner;
  /** Снимает замок, если он всё ещё наш. Повторный вызов безопасен. */
  release(): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — процесс есть, но чужой: он жив.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(path: string): LockOwner | "unreadable" | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof value.pid !== "number" || typeof value.startedAt !== "string") return "unreadable";
    return {
      pid: value.pid,
      host: typeof value.host === "string" ? value.host : "",
      startedAt: value.startedAt,
      zoneId: typeof value.zoneId === "number" ? value.zoneId : null,
      by: typeof value.by === "string" ? value.by : "",
    };
  } catch {
    return "unreadable";
  }
}

/** Текст «кто держит замок» для сообщений. */
export function describeLockOwner(owner: LockOwner): string {
  const zone = owner.zoneId === null ? "" : `, зона ${String(owner.zoneId)}`;
  return `${owner.by === "" ? "процесс" : owner.by} (pid ${String(owner.pid)}${zone}, с ${owner.startedAt})`;
}

/** Читает владельца замка, не трогая его. null — замка нет. */
export function inspectZoneBuildLock(path: string): LockOwner | null {
  const owner = readOwner(path);
  return owner === "unreadable" ? null : owner;
}

/**
 * Берёт замок. `null` — за `waitMs` замок не освободился (его держит живой владелец).
 * Ошибки файловой системы, кроме «файл уже есть», пробрасываются: сборка без замка опаснее отказа.
 */
export async function acquireZoneBuildLock(options: LockOptions): Promise<LockHandle | null> {
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processAlive;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const host = options.host ?? hostname();
  const pid = options.pid ?? process.pid;
  const pollMs = options.pollMs ?? 2_000;
  const deadline = now() + options.waitMs;

  mkdirSync(dirname(options.path), { recursive: true });

  for (;;) {
    const owner: LockOwner = { pid, host, startedAt: new Date(now()).toISOString(), zoneId: options.zoneId, by: options.by };
    try {
      const fd = openSync(options.path, "wx");
      try {
        writeSync(fd, `${JSON.stringify(owner)}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        owner,
        release() {
          if (released) return;
          released = true;
          // Снимаем только свой замок: если его успели признать брошенным и взять заново, чужой не трогаем.
          const current = readOwner(options.path);
          if (current !== null && current !== "unreadable" && current.pid === pid && current.startedAt === owner.startedAt) {
            try {
              unlinkSync(options.path);
            } catch {
              // уже снят
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const holder = readOwner(options.path);
    if (holder === null) continue; // исчез между попытками — пробуем снова сразу
    let ageMs: number;
    if (holder === "unreadable") {
      // Файл есть, но не читается: его, возможно, пишут прямо сейчас. Брошенным он становится через 10 с.
      try {
        ageMs = now() - statSync(options.path).mtimeMs;
      } catch {
        continue;
      }
    } else {
      ageMs = now() - Date.parse(holder.startedAt);
    }
    const dead = holder !== "unreadable" && holder.host === host && !isAlive(holder.pid);
    const abandoned = dead || ageMs > (holder === "unreadable" ? 10_000 : options.staleMs);
    if (abandoned) {
      try {
        unlinkSync(options.path);
      } catch {
        // снял кто-то другой
      }
      continue;
    }
    if (now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

/** Выполняет `work` под замком; не удалось взять замок — `onBusy` решает, что делать (по умолчанию ошибка). */
export async function withZoneBuildLock<T>(
  options: LockOptions,
  work: (handle: LockHandle) => Promise<T>,
  onBusy?: (holder: LockOwner | null) => T | Promise<T>,
): Promise<T> {
  const handle = await acquireZoneBuildLock(options);
  if (handle === null) {
    const holder = inspectZoneBuildLock(options.path);
    if (onBusy !== undefined) return onBusy(holder);
    throw new Error(
      `Сборка зон занята: замок ${options.path} держит ${holder === null ? "неизвестный процесс" : describeLockOwner(holder)}; ждали ${String(Math.round(options.waitMs / 1000))} с`,
    );
  }
  try {
    return await work(handle);
  } finally {
    handle.release();
  }
}
