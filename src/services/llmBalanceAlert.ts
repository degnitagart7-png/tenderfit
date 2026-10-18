import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildAlertEmail,
  classifyBalance,
  decideAlert,
  parseAlertMemory,
  parseCreditsResponse,
  resolveAlertConfig,
  summarizeSpend,
  type AlertAction,
  type AlertMemory,
  type BalanceState,
  type SpendRow,
  type SpendSummary,
} from "@/domain/llmBalanceAlert";
import { describeError } from "@/lib/errors";
import { endpointHost, resolveLlmEndpoint } from "@/services/llmGateway";

/**
 * Проверка баланса языковой модели и письмо владельцу (правила — в
 * src/domain/llmBalanceAlert.ts).
 *
 * Баланс читается из `GET {LLM_BASE_URL}/credits` (routerai.ru отдаёт рубли).
 * Состояние «что уже сообщили» лежит в файле `data/llm-balance-alert.json`
 * (путь переопределяет LLM_BALANCE_ALERT_FILE): его делят воркер и приложение,
 * которые работают на одном сервере под одним пользователем, поэтому два процесса
 * не пришлют два одинаковых письма. Гонку двух проверок в одну секунду не
 * лечим: худший исход — лишнее письмо.
 *
 * Ничего здесь не бросает наружу: воркер крутит эту проверку в своём цикле, и
 * сбой сети, почты или базы не должен его ронять.
 */

/** Сколько ждём ответ шлюза про баланс. */
export const BALANCE_FETCH_TIMEOUT_MS = 10_000;

type Env = Record<string, string | undefined>;

export interface BalanceAlertDeps {
  env: Env;
  now: () => number;
  fetchFn: typeof fetch;
  /** Содержимое файла или null, если файла нет. */
  readFile: (path: string) => string | null;
  /** Атомарная запись: временный файл и rename. */
  writeFileAtomic: (path: string, content: string) => void;
  sendMail: (to: string, subject: string, text: string) => Promise<void>;
  /** Строки журнала расхода начиная с ISO-даты; бросает, если журнал недоступен. */
  loadSpendRows: (sinceIso: string) => Promise<SpendRow[]>;
  log: (message: string) => void;
}

/** Атомарная запись: читатель никогда не увидит половину файла. */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function defaultBalanceAlertDeps(): BalanceAlertDeps {
  return {
    env: process.env,
    now: () => Date.now(),
    fetchFn: (input, init) => fetch(input, init),
    readFile: readFileOrNull,
    writeFileAtomic,
    sendMail: async (to, subject, text) => {
      // Динамический импорт: nodemailer нужен только тому, кто и правда шлёт письмо.
      const { sendSmtpMail } = await import("@/services/smtpMailer");
      await sendSmtpMail(to, subject, text, { logLabel: "Баланс ИИ" });
    },
    loadSpendRows: async (sinceIso) => {
      const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
      return llmUsageRepository.listBetween({ since: sinceIso });
    },
    log: (message) => console.log(`[llm-balance] ${message}`),
  };
}

/** Путь файла состояния: LLM_BALANCE_ALERT_FILE или `data/llm-balance-alert.json` в cwd. */
export function alertStateFile(env: Env = process.env): string {
  const fromEnv = env["LLM_BALANCE_ALERT_FILE"]?.trim();
  return fromEnv ? fromEnv : join(process.cwd(), "data", "llm-balance-alert.json");
}

export function loadAlertMemory(deps: BalanceAlertDeps = defaultBalanceAlertDeps()): AlertMemory {
  return parseAlertMemory(deps.readFile(alertStateFile(deps.env)));
}

function saveAlertMemory(deps: BalanceAlertDeps, memory: AlertMemory): void {
  try {
    deps.writeFileAtomic(alertStateFile(deps.env), JSON.stringify(memory));
  } catch (err) {
    deps.log(`состояние оповещения не записано: ${describeError(err)}`);
  }
}

/**
 * Баланс шлюза в рублях или null при любом сбое (нет ключа, сеть, таймаут,
 * не-200, чужой формат). Причина уходит в журнал одной строкой.
 */
export async function fetchLlmBalance(deps: BalanceAlertDeps = defaultBalanceAlertDeps()): Promise<number | null> {
  try {
    const endpoint = resolveLlmEndpoint(deps.env);
    const response = await deps.fetchFn(`${endpoint.baseUrl}/credits`, {
      method: "GET",
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const balance = parseCreditsResponse(response.status, body);
    if (balance === null) {
      deps.log(`баланс не получен: ${endpointHost(endpoint.baseUrl)} ответил ${String(response.status)} без числа credits`);
    }
    return balance;
  } catch (err) {
    deps.log(`баланс не получен: ${describeError(err)}`);
    return null;
  }
}

/** Расход за неделю по журналу llm_usage_log; null, если журнал недоступен. */
async function loadSpend(deps: BalanceAlertDeps, nowMs: number): Promise<SpendSummary | null> {
  try {
    const since = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    return summarizeSpend(await deps.loadSpendRows(since), nowMs);
  } catch (err) {
    deps.log(`расход из журнала не прочитан: ${describeError(err)}`);
    return null;
  }
}

export interface BalanceCheckResult {
  /** Баланс, ₽; null — не удалось получить. */
  balanceRub: number | null;
  /** Состояние; null — оценить не удалось или оповещения выключены. */
  state: BalanceState | null;
  action: AlertAction;
  /** Письмо ушло. */
  sent: boolean;
}

const SKIPPED: BalanceCheckResult = { balanceRub: null, state: null, action: "none", sent: false };

let warnedNoRecipient = false;
let inFlight: Promise<BalanceCheckResult> | null = null;

/** Для тестов: забыть «уже предупредили» и незавершённую проверку. */
export function resetLlmBalanceAlertForTests(): void {
  warnedNoRecipient = false;
  inFlight = null;
}

/**
 * Одна проверка: баланс → состояние → решение → письмо → память.
 *
 * `saw402` — шлюз только что ответил 402. Если сам баланс получить не удалось,
 * этого достаточно, чтобы считать его исчерпанным; если получилось, верим
 * числу (402 при положительном балансе — не «кончились деньги», а что-то
 * другое, и письмо про деньги было бы ложным).
 *
 * Параллельные вызовы в одном процессе делят одну проверку.
 */
export function runLlmBalanceCheck(
  options: { saw402?: boolean } = {},
  deps: BalanceAlertDeps = defaultBalanceAlertDeps(),
): Promise<BalanceCheckResult> {
  if (inFlight !== null) return inFlight;
  const current = doCheck(options, deps).finally(() => {
    if (inFlight === current) inFlight = null;
  });
  inFlight = current;
  return current;
}

async function doCheck(options: { saw402?: boolean }, deps: BalanceAlertDeps): Promise<BalanceCheckResult> {
  try {
    const config = resolveAlertConfig(deps.env);
    if (config.email === null) {
      if (!warnedNoRecipient) {
        warnedNoRecipient = true;
        deps.log("ALERT_EMAIL не задан — оповещения о балансе ИИ выключены");
      }
      return SKIPPED;
    }

    const balance = await fetchLlmBalance(deps);
    let state: BalanceState;
    if (balance !== null) {
      state = classifyBalance(balance, config.lowRub);
      if (options.saw402 === true && state !== "empty") {
        deps.log(`шлюз ответил 402, но баланс ${String(balance)} ₽ — письмо про деньги не шлём`);
      }
    } else if (options.saw402 === true) {
      state = "empty";
    } else {
      return SKIPPED;
    }

    const nowMs = deps.now();
    const memory = loadAlertMemory(deps);
    const decision = decideAlert(memory, state, nowMs);

    if (decision.action === "none") {
      if (decision.next.state !== memory.state) saveAlertMemory(deps, decision.next);
      return { balanceRub: balance, state, action: "none", sent: false };
    }

    const spend = await loadSpend(deps, nowMs);
    const email = buildAlertEmail(decision.action, state, { balanceRub: balance, lowRub: config.lowRub, spend });
    try {
      await deps.sendMail(config.email, email.subject, email.text);
    } catch (err) {
      // Память не трогаем: следующая проверка попробует снова.
      deps.log(`письмо «${email.subject}» не отправлено: ${describeError(err)}`);
      return { balanceRub: balance, state, action: decision.action, sent: false };
    }
    saveAlertMemory(deps, decision.next);
    deps.log(`письмо отправлено (${decision.action}): ${email.subject}`);
    return { balanceRub: balance, state, action: decision.action, sent: true };
  } catch (err) {
    deps.log(`проверка баланса упала: ${describeError(err)}`);
    return SKIPPED;
  }
}

/** Тестовое письмо для проверки доставки (scripts/llm-balance-check.ts --send-test). Бросает при сбое. */
export async function sendTestBalanceEmail(deps: BalanceAlertDeps = defaultBalanceAlertDeps()): Promise<string> {
  const config = resolveAlertConfig(deps.env);
  if (config.email === null) throw new Error("ALERT_EMAIL не задан");
  const balance = await fetchLlmBalance(deps);
  const lines = [
    "Это тестовое письмо: оповещения о балансе ИИ доставляются.",
    balance === null ? "Баланс сейчас получить не удалось." : `Баланс сейчас: ${balance.toFixed(2).replace(".", ",")} ₽.`,
    "Настоящие письма приходят, когда баланс ниже порога, закончился или пополнен.",
  ];
  await deps.sendMail(config.email, "ТендерФит: тест оповещения о балансе ИИ", lines.join("\n"));
  return config.email;
}
