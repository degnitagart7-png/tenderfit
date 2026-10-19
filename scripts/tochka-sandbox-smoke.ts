import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

import { describeError } from "../src/lib/errors";
import { INVOICE_TTL_MS } from "../src/domain/payments";
import { createTochkaApi, tochkaConfigProblem } from "../src/services/tochka";

loadEnv({ path: resolve(__dirname, "../.env.local") });

/**
 * Дымовая проверка счетов Точки: создать счёт → прочитать статус оплаты → скачать PDF → отправить
 * на почту.
 *
 *   TOCHKA_SANDBOX=1 npx tsx scripts/tochka-sandbox-smoke.ts [--email кому@почта.ру]
 *
 * Песочница отдаёт фиксированные ответы (по документации банка), поэтому проверяется формат
 * запросов и ответов, а не бизнес-логика. Без TOCHKA_SANDBOX=1 скрипт откажется работать: на
 * боевом ключе он выставил бы настоящий счёт; для осознанной проверки есть флаг --allow-prod
 * (счёт на тестовое ИНН будет создан в банке владельца — удалить его нужно в интернет-банке).
 */

const TEST_INN = "7707083893"; // Сбербанк: валидный ИНН организации из открытых данных.

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowProd = args.includes("--allow-prod");
  const emailIndex = args.indexOf("--email");
  const email = emailIndex >= 0 ? (args[emailIndex + 1] ?? "") : "test@example.com";

  const { config, problem } = tochkaConfigProblem();
  if (config === null) throw new Error(`Точка не настроена: ${problem ?? "нет переменных"}`);
  if (!config.sandbox && !allowProd) {
    throw new Error("Это боевой режим: задайте TOCHKA_SANDBOX=1 или, зная последствия, добавьте --allow-prod.");
  }
  console.log(`Режим: ${config.sandbox ? "песочница" : "БОЕВОЙ"}; адрес ${config.baseUrl}`);
  const api = createTochkaApi(config);

  const nowMs = Date.now();
  const created = await api.createInvoice({
    number: "ТФ-9999",
    buyer: { inn: TEST_INN, kpp: "770701001", name: "ООО Тестовая компания", email },
    planName: "Старт",
    months: 1,
    amountRub: 9000,
    nowMs,
    expiresAtMs: nowMs + INVOICE_TTL_MS,
  });
  console.log(`1. Счёт создан: documentId ${created.documentId}`);

  const status = await api.getInvoicePaymentStatus(created.documentId);
  console.log(`2. Статус оплаты: ${status}`);

  const pdf = await api.getInvoicePdf(created.documentId);
  console.log(`3. PDF: ${String(pdf.bytes.length)} байт, ${pdf.contentType}`);

  await api.sendInvoiceToEmail(created.documentId, email);
  console.log(`4. Отправка на ${email}: банк принял`);
}

main().catch((err: unknown) => {
  console.error("Ошибка:", describeError(err));
  process.exit(1);
});
