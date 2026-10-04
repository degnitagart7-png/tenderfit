import type { WorkerStatus } from "@/types/database";

/**
 * Через сколько минут молчания воркер считается пропавшим.
 *
 * Воркер отмечает пульс на каждом тике (раз в минуту), поэтому 15 минут — это
 * пропущенные пятнадцать отметок подряд: перезагрузка сервера, обрыв сети или
 * выключенный юнит. Меньше — ложные тревоги на длинном прогоне, больше —
 * партнёр часами смотрит на «на связи», хотя документация не грузится.
 */
export const WORKER_STALE_AFTER_MIN = 15;

/**
 * Состояния воркера с российским IP.
 *
 * `foreign_exit` выделено отдельно от `stale`: сервер может исправно писать
 * пульс, но выходить в сеть не из России — тогда ЕИС не отвечает и документация
 * не загружается. Молчание и неверный выход лечатся по-разному, и подписи у них
 * разные.
 */
export type WorkerState = "unknown" | "online" | "stale" | "foreign_exit";

/**
 * Имя воркера по умолчанию.
 *
 * Одно имя на сервер: прод читает пульс по нему, а воркер пишет. Значение
 * переопределяется переменной SYNC_WORKER_ID — она нужна, если вторая машина
 * (например, домашний ПК на время переезда) работает рядом, и в панели важно
 * различать, кто именно отвечал.
 */
export const DEFAULT_WORKER_ID = "ru-vps";

/** Имя воркера из окружения или по умолчанию; пустое значение не принимается. */
export function resolveWorkerId(envValue?: string | null): string {
  const value = (envValue ?? "").trim();
  return value.length > 0 ? value.slice(0, 64) : DEFAULT_WORKER_ID;
}

export interface WorkerStatusView {
  state: WorkerState;
  /** Короткая подпись для панели. */
  label: string;
  /** Что это означает для партнёра: последствия, а не диагноз. */
  hint: string;
  /** Минут с последнего пульса; null — воркер ни разу не выходил на связь. */
  minutesSinceSeen: number | null;
  /** Заданий в очереди. */
  pending: number;
  /** Адрес выхода в сеть, если воркер его определил. */
  exitIp: string | null;
  /** Последняя ошибка воркера, если она была. */
  lastError: string | null;
}

function minutesBetween(fromIso: string, nowMs: number): number | null {
  const from = Date.parse(fromIso);
  // Нечитаемая отметка возвращается как null, а не как огромное число: подпись
  // «не выходил на связь 153722867280912930 ч назад» сказала бы партнёру меньше,
  // чем честное «отметка времени не читается».
  if (Number.isNaN(from)) return null;
  // Отрицательное значение означает расхождение часов между сервером и
  // базой: показывать «-3 мин назад» партнёру нельзя, поэтому ноль.
  return Math.max(0, Math.round((nowMs - from) / 60000));
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч назад`;
}

/**
 * Превращает пульс воркера и длину очереди в подпись для интерфейса.
 *
 * Время передаётся параметром, а не читается внутри: состояние «пропал»
 * зависит от момента наблюдения, и тест обязан проверять границу порога, а не
 * надеяться на текущую дату.
 *
 * В подписях машина названа «сервером в России», а не «воркером»: партнёр не
 * обязан знать, как называется процесс, а вот откуда качается документация —
 * обязан. В комментариях и именах полей остаётся «воркер».
 *
 * Формулировки нарочно не склоняются по числам («В очереди заданий: 3»,
 * «5 мин назад»): подпись собирается в домене и показывается как есть, а
 * ошибка в согласовании «2 закупкИ/закупок» была бы видна каждому партнёру.
 */
export function describeWorkerStatus(
  status: WorkerStatus,
  now: string | number,
  options: { staleAfterMin?: number } = {},
): WorkerStatusView {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const staleAfterMin = options.staleAfterMin ?? WORKER_STALE_AFTER_MIN;
  const heartbeat = status.heartbeat;
  const pending = status.pending;

  if (!heartbeat) {
    return {
      state: "unknown",
      label: "Сервер в России ещё не выходил на связь",
      hint:
        "Он не настроен или не запущен. Закупки в ленте есть, но документация к ним не загружается и глубокий разбор не выполняется.",
      minutesSinceSeen: null,
      pending,
      exitIp: null,
      lastError: null,
    };
  }

  const minutesSinceSeen = minutesBetween(heartbeat.last_seen_at, nowMs);
  const exitIp = heartbeat.exit_ip ?? null;
  const lastError = heartbeat.last_error ?? null;
  const queueNote = pending > 0 ? ` В очереди заданий: ${pending}.` : "";

  const exitCountry = (heartbeat.exit_country ?? "").trim().toUpperCase();
  if (exitCountry.length > 0 && exitCountry !== "RU") {
    return {
      state: "foreign_exit",
      label: `Сервер выходит в сеть не из России${exitIp ? ` (${exitIp})` : ""}`,
      hint:
        "ЕИС и её хранилище файлов не отвечают зарубежным адресам, поэтому документация не загрузится, пока выход не станет российским." +
        queueNote,
      minutesSinceSeen,
      pending,
      exitIp,
      lastError,
    };
  }

  if (minutesSinceSeen === null) {
    return {
      state: "stale",
      label: "Отметка времени сервера не читается",
      hint:
        "Сервер в России записал отметку, но разобрать момент записи не удалось: считаем, что связь потеряна, а задания ждут в очереди." +
        queueNote,
      minutesSinceSeen: null,
      pending,
      exitIp,
      lastError,
    };
  }

  if (minutesSinceSeen >= staleAfterMin) {
    return {
      state: "stale",
      label: `Сервер в России не выходил на связь ${formatMinutes(minutesSinceSeen)}`,
      hint:
        "Он молчит: задания ждут в очереди, документация появится после его возврата. Плановый прогон тоже не выполняется." +
        queueNote,
      minutesSinceSeen,
      pending,
      exitIp,
      lastError,
    };
  }

  const exit = exitIp ? `Выход из России (${exitIp}).` : "Выход из России.";
  const errorNote = lastError ? ` Последняя ошибка: ${lastError}` : "";
  return {
    state: "online",
    label: `Сервер в России на связи ${formatMinutes(minutesSinceSeen)}`,
    hint: `${exit} Документация и плановый прогон выполняются на этом сервере.${queueNote}${errorNote}`,
    minutesSinceSeen,
    pending,
    exitIp,
    lastError,
  };
}
