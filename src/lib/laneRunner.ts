/**
 * Учёт дорожек воркера: кто занят, и ни одно падение не оставляет дорожку «занятой».
 *
 * Зачем отдельный класс. Параллельный воркер запускает дело и не ждёт его: если
 * забыть снять пометку «занято» после сбоя, дорожка замирает навсегда, а пока
 * ждёт `await`, остальной цикл не должен падать от чужой ошибки. Эти два
 * инварианта проще проверить тестом на маленьком классе, чем в скрипте с базой и
 * дочерними процессами.
 */
export class LaneRunner<L extends string> {
  private readonly running = new Map<L, Promise<void>>();

  constructor(
    /** Сюда попадает каждая ошибка дела; цикл воркера её не видит. */
    private readonly onError: (lane: L, error: unknown) => void,
  ) {}

  isBusy(lane: L): boolean {
    return this.running.has(lane);
  }

  /** Сколько дорожек занято. */
  get size(): number {
    return this.running.size;
  }

  /** Занятые дорожки — для строки лога. */
  busyLanes(): L[] {
    return [...this.running.keys()];
  }

  /**
   * Запускает дело на свободной дорожке и сразу возвращается.
   *
   * Занятая дорожка дела не получает: вернёт false, `work` не вызывается.
   * Пометка «занято» ставится синхронно, а `work` стартует в следующем микротакте
   * (`Promise.resolve().then`): так даже синхронное исключение из `work` не успеет
   * снять пометку раньше, чем она поставлена, и дорожка не застрянет занятой.
   * Синхронное исключение и отказ промиса обрабатываются одинаково: ошибка уходит
   * в `onError`, дорожка освобождается.
   */
  start(lane: L, work: () => Promise<void>): boolean {
    if (this.running.has(lane)) return false;

    const done = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        try {
          this.onError(lane, error);
        } catch {
          // Журнал не должен мешать освобождению дорожки.
        }
      })
      .finally(() => {
        this.running.delete(lane);
      });
    this.running.set(lane, done);
    return true;
  }

  /** Ждёт, пока освободятся все дорожки; true, если уложились в `timeoutMs`. */
  async whenIdle(timeoutMs: number | null = null): Promise<boolean> {
    const everything = async (): Promise<boolean> => {
      while (this.running.size > 0) {
        await Promise.allSettled([...this.running.values()]);
      }
      return true;
    };
    if (timeoutMs === null) return everything();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    });
    try {
      return await Promise.race([everything(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
