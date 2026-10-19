import { WEBHOOK_EVENTS, type WebhookEvent } from "../src/services/tochka/webhooks";

/**
 * Чистая часть scripts/tochka-webhook-register.ts: разбор аргументов, адрес вебхука, решение
 * «создать, изменить или ничего не делать». Отдельно от скрипта, чтобы проверяться без сети.
 */

export class RegisterArgsError extends Error {}

export type RegisterCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "test-send"; events: WebhookEvent[] }
  | { kind: "register"; dryRun: boolean; url: string | null };

export const REGISTER_USAGE = [
  "Регистрация вебхука Точка Банка на оплату подписки.",
  "",
  "  npx tsx scripts/tochka-webhook-register.ts              создать или обновить вебхук",
  "  npx tsx scripts/tochka-webhook-register.ts --dry-run    показать, что будет сделано, ничего не меняя",
  "  npx tsx scripts/tochka-webhook-register.ts --list       показать текущие настройки",
  "  npx tsx scripts/tochka-webhook-register.ts --test-send [событие]   тестовый вебхук от банка",
  "                                                          (события: " + WEBHOOK_EVENTS.join(", ") + "; без аргумента — все)",
  "  --url https://…                                         свой адрес вместо ${APP_BASE_URL}/api/payments/tochka/webhook",
  "",
  "Окружение: TOCHKA_JWT, TOCHKA_CLIENT_ID, TOCHKA_CUSTOMER_CODE (+ TOCHKA_ACCOUNT_ID), APP_BASE_URL.",
  "На сервере: set -a; . /etc/tenderfit/tochka.env; . /etc/tenderfit/app.env; set +a",
  "Банк при создании сам шлёт на адрес тестовые вебхуки и требует ответ 200: приложение с обработчиком должно быть уже выложено.",
].join("\n");

export function parseRegisterArgs(argv: readonly string[]): RegisterCommand {
  let dryRun = false;
  let list = false;
  let url: string | null = null;
  let testSend = false;
  const events: WebhookEvent[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--dry-run":
        dryRun = true;
        break;
      case "--list":
        list = true;
        break;
      case "--test-send":
        testSend = true;
        break;
      case "--url": {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) throw new RegisterArgsError("--url требует адрес");
        url = next;
        i += 1;
        break;
      }
      default: {
        if (testSend && (WEBHOOK_EVENTS as readonly string[]).includes(arg)) {
          events.push(arg as WebhookEvent);
          break;
        }
        throw new RegisterArgsError(`Неизвестный аргумент: ${arg}`);
      }
    }
  }
  if (list) return { kind: "list" };
  if (testSend) return { kind: "test-send", events: events.length > 0 ? events : [...WEBHOOK_EVENTS] };
  return { kind: "register", dryRun, url };
}

/** Адрес вебхука: банк принимает только HTTPS на порт 443. */
export function webhookUrl(base: string, override: string | null): string {
  const url = override ?? `${base.replace(/\/+$/, "")}/api/payments/tochka/webhook`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RegisterArgsError(`Некорректный адрес вебхука: ${url}`);
  }
  if (parsed.protocol !== "https:") throw new RegisterArgsError("Банк принимает вебхуки только по HTTPS");
  if (parsed.port !== "" && parsed.port !== "443") throw new RegisterArgsError("Банк принимает вебхуки только на порт 443");
  return parsed.toString();
}

export type RegisterPlan = "create" | "edit" | "keep";

/** Что сделать с банком: вебхука нет — создать, отличается адрес или набор событий — изменить. */
export function planRegistration(current: { url: string; webhooksList: readonly string[] } | null, url: string): RegisterPlan {
  if (current === null) return "create";
  const same =
    current.url === url &&
    WEBHOOK_EVENTS.length === current.webhooksList.length &&
    WEBHOOK_EVENTS.every((event) => current.webhooksList.includes(event));
  return same ? "keep" : "edit";
}
