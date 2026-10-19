import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

import { appBaseUrl } from "../src/domain/digest";
import { describeError } from "../src/lib/errors";
import { createTochkaApi, tochkaConfigProblem } from "../src/services/tochka";
import {
  REGISTER_USAGE,
  RegisterArgsError,
  parseRegisterArgs,
  planRegistration,
  webhookUrl,
} from "./tochka-webhook-register.lib";

loadEnv({ path: resolve(__dirname, "../.env.local") });

/**
 * Регистрация вебхука Точки на оплату подписки (см. REGISTER_USAGE). Секретов в вывод не пишет:
 * только адрес вебхука и список событий.
 */

async function main(): Promise<void> {
  const command = parseRegisterArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(REGISTER_USAGE);
    return;
  }

  const { config, problem } = tochkaConfigProblem();
  if (config === null) throw new Error(`Точка не настроена: ${problem ?? "нет переменных"}`);
  if (config.clientId === "") throw new Error("Не задан TOCHKA_CLIENT_ID (client_id рядом с JWT-ключом в интернет-банке)");
  if (config.sandbox) console.log("Режим песочницы: адрес и токен тестовые.");
  const api = createTochkaApi(config);

  if (command.kind === "list") {
    const current = await api.getWebhooks();
    console.log(current === null ? "Вебхуков нет (банк отвечает «не существует»)." : `Адрес: ${current.url}\nСобытия: ${current.webhooksList.join(", ")}`);
    return;
  }

  if (command.kind === "test-send") {
    for (const event of command.events) {
      const ok = await api.sendTestWebhook(event);
      console.log(`${event}: ${ok ? "банк отправил тестовый вебхук" : "банк не подтвердил отправку"}`);
    }
    return;
  }

  const url = webhookUrl(appBaseUrl(), command.url);
  const current = await api.getWebhooks();
  const plan = planRegistration(current, url);
  console.log(`Адрес вебхука: ${url}`);
  console.log(`Сейчас: ${current === null ? "нет" : `${current.url} [${current.webhooksList.join(", ")}]`}`);
  console.log(`Действие: ${plan === "create" ? "создать" : plan === "edit" ? "изменить" : "ничего не менять"}`);
  if (command.dryRun || plan === "keep") return;

  const saved = plan === "create" ? await api.createWebhook(url) : await api.editWebhook(url);
  console.log(`Готово. Адрес: ${saved.url}\nСобытия: ${saved.webhooksList.join(", ")}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    if (err instanceof RegisterArgsError) {
      console.error(`${err.message}\n\n${REGISTER_USAGE}`);
      process.exit(2);
    }
    console.error("Ошибка:", describeError(err));
    process.exit(1);
  });
}
