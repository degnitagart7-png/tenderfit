import { resolveAlertConfig } from "@/domain/llmBalanceAlert";

/**
 * Мгновенный сигнал «кончились деньги»: шлюз ответил 402.
 *
 * Воркер проверяет баланс раз в полчаса, но владельцу нужно письмо сразу, как
 * только первый запрос получил отказ. Вызывается из мест, где читается ответ
 * шлюза; ничего не ждёт и не бросает. Дребезг гасится: не чаще одной проверки в
 * пять минут на процесс — при 402 падают десятки запросов подряд, и каждый
 * ходить за балансом не должен. Дубли между процессами гасит общий файл
 * состояния в llmBalanceAlert.
 */

export const TRIGGER_DEBOUNCE_MS = 5 * 60_000;

type Env = Record<string, string | undefined>;

export interface TriggerDeps {
  env: Env;
  now: () => number;
  /** Запуск проверки; по умолчанию — настоящая, с динамическим импортом. */
  run: () => Promise<unknown>;
  log: (message: string) => void;
}

let lastTriggerAt: number | null = null;

/** Для тестов: забыть время прошлого запуска. */
export function resetLlmBalanceTriggerForTests(): void {
  lastTriggerAt = null;
}

/** 402 или текст «Insufficient balance» / «Недостаточно средств» — деньги кончились. */
export function isInsufficientBalance(status: number, body?: string): boolean {
  if (status === 402) return true;
  return body !== undefined && /insufficient\s+balance|недостаточно\s+средств/i.test(body);
}

/**
 * Сообщает о ответе шлюза с ошибкой. Возвращает true, если проверка запущена.
 * Не запускает ничего, если ответ не про деньги, ALERT_EMAIL не задан или
 * проверка уже была меньше пяти минут назад.
 */
export function noteLlmGatewayResponse(status: number, body?: string, deps?: Partial<TriggerDeps>): boolean {
  try {
    if (!isInsufficientBalance(status, body)) return false;
    const env = deps?.env ?? process.env;
    if (resolveAlertConfig(env).email === null) return false;

    const now = (deps?.now ?? Date.now)();
    if (lastTriggerAt !== null && now - lastTriggerAt < TRIGGER_DEBOUNCE_MS) return false;
    lastTriggerAt = now;

    const log = deps?.log ?? ((message: string) => console.warn(`[llm-balance] ${message}`));
    const run =
      deps?.run ??
      (async () => {
        const { runLlmBalanceCheck } = await import("@/services/llmBalanceAlert");
        return runLlmBalanceCheck({ saw402: true });
      });
    void run().catch((err: unknown) => {
      log(`проверка по 402 упала: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  } catch {
    return false;
  }
}
