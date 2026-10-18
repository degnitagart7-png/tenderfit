import { config } from "dotenv";
import { resolve } from "node:path";

import { classifyBalance, resolveAlertConfig } from "../src/domain/llmBalanceAlert";
import {
  alertStateFile,
  defaultBalanceAlertDeps,
  fetchLlmBalance,
  loadAlertMemory,
  sendTestBalanceEmail,
} from "../src/services/llmBalanceAlert";

/**
 * Ручная проверка оповещения о балансе языковой модели.
 *
 *   npx tsx scripts/llm-balance-check.ts                         — печатает баланс, состояние и память оповещения
 *   npx tsx scripts/llm-balance-check.ts --send-test             — ещё и шлёт тестовое письмо на ALERT_EMAIL
 *   npx tsx scripts/llm-balance-check.ts --env-file /etc/tenderfit/app.env
 *
 * Скрипт письмо о балансе по правилам не шлёт и файл состояния не меняет: он
 * читает баланс и, по флагу, проверяет доставку почты. Окружение — из .env.local
 * или из файла по --env-file (LLM_BASE_URL, LLM_API_KEY, ALERT_EMAIL, SMTP_*).
 * Ключи и пароли не печатаются.
 */

function parseArgs(argv: readonly string[]): { sendTest: boolean; envFile?: string } {
  const out: { sendTest: boolean; envFile?: string } = { sendTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--send-test") out.sendTest = true;
    else if (argv[i] === "--env-file") {
      const value = argv[i + 1];
      if (!value) throw new Error("--env-file требует путь к файлу");
      out.envFile = value;
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  config({ path: resolve(__dirname, "../.env.local") });
  if (args.envFile) config({ path: resolve(args.envFile), override: true });

  const deps = defaultBalanceAlertDeps();
  const alert = resolveAlertConfig(process.env);
  const balance = await fetchLlmBalance(deps);

  console.log(`Получатель (ALERT_EMAIL): ${alert.email ?? "не задан — оповещения выключены"}`);
  console.log(`Порог «мало»: ${String(alert.lowRub)} ₽`);
  if (balance === null) {
    console.log("Баланс: не получен (причина выше)");
  } else {
    console.log(`Баланс: ${balance.toFixed(2)} ₽`);
    console.log(`Состояние: ${classifyBalance(balance, alert.lowRub)}`);
  }
  const memory = loadAlertMemory(deps);
  console.log(
    `Память оповещения (${alertStateFile(process.env)}): состояние ${memory.state}, ` +
      `последнее письмо ${memory.lastSentAt === null ? "—" : new Date(memory.lastSentAt).toISOString()}`,
  );

  if (args.sendTest) {
    const to = await sendTestBalanceEmail(deps);
    console.log(`Тестовое письмо отправлено на ${to}`);
  }
}

main().catch((err: unknown) => {
  console.error("Ошибка:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
