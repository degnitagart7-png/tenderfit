/**
 * Настройки Точка Банка из окружения сервера.
 *
 * Боевой режим: TOCHKA_JWT, TOCHKA_CLIENT_ID, TOCHKA_CUSTOMER_CODE, TOCHKA_ACCOUNT_ID
 * (в systemd — EnvironmentFile /etc/tenderfit/tochka.env). Песочница (TOCHKA_SANDBOX=1):
 * адрес, токен, код клиента и счёт — публичные тестовые значения из документации банка;
 * боевой JWT в песочницу не уходит никогда, даже если он задан.
 *
 * Секрет (JWT) живёт только в этой конфигурации и заголовке запроса: ни в журнал, ни в
 * текст ошибки, ни в ответ клиенту он не попадает (см. client.ts).
 */

export const TOCHKA_PROD_BASE = "https://enter.tochka.com/uapi";
export const TOCHKA_SANDBOX_BASE = "https://enter.tochka.com/sandbox/v2";
export const TOCHKA_SANDBOX_JWT = "sandbox.jwt.token";
export const TOCHKA_SANDBOX_CUSTOMER_CODE = "1234567ab";
export const TOCHKA_SANDBOX_ACCOUNT_ID = "12345810901234567890/044525104";
export const TOCHKA_PUBLIC_KEY_URL = "https://enter.tochka.com/doc/openapi/static/keys/public";

/** Ставка НДС в позиции счёта для ИП на УСН. Значение из перечня банка; меняется переменной без выкладки. */
export const DEFAULT_NDS_KIND = "without_nds";

export interface TochkaConfig {
  baseUrl: string;
  jwt: string;
  clientId: string;
  customerCode: string;
  /** Формат «<номер счёта>/<БИК>». */
  accountId: string;
  sandbox: boolean;
  /** Значение `ndsKind` для позиций счёта и акта. */
  ndsKind: string;
  /** Создавать ли акт после оплаты. */
  closingDocs: boolean;
  /** Pinned-ключ банка для проверки вебхуков (JWK-JSON или PEM) — запасной, если адрес ключа недоступен. */
  webhookPublicKey: string | null;
}

export class TochkaConfigError extends Error {}

type Env = Record<string, string | undefined>;

const trimmed = (env: Env, name: string): string => (env[name] ?? "").trim();

export function isSandbox(env: Env = process.env): boolean {
  return trimmed(env, "TOCHKA_SANDBOX") === "1";
}

/** Номер счёта без БИК: в вебхуке получатель приходит номером, без «/БИК». */
export function accountNumberOf(accountId: string): string {
  return accountId.split("/")[0]?.trim() ?? "";
}

/**
 * Конфигурация или null, если банк не настроен (приложение без Точки работает: счёт
 * выставить нельзя, остальное — как раньше). Неполная конфигурация — тоже null, а причина
 * доступна через `tochkaConfigProblem`.
 */
export function tochkaConfig(env: Env = process.env): TochkaConfig | null {
  return tochkaConfigProblem(env).config;
}

export function tochkaConfigProblem(env: Env = process.env): { config: TochkaConfig | null; problem: string | null } {
  const sandbox = isSandbox(env);
  const common = {
    sandbox,
    ndsKind: trimmed(env, "TOCHKA_NDS_KIND") || DEFAULT_NDS_KIND,
    closingDocs: trimmed(env, "TOCHKA_CLOSING_DOCS") !== "0",
    webhookPublicKey: trimmed(env, "TOCHKA_WEBHOOK_PUBLIC_KEY") || null,
  };

  if (sandbox) {
    return {
      config: {
        ...common,
        baseUrl: (trimmed(env, "TOCHKA_API_BASE") || TOCHKA_SANDBOX_BASE).replace(/\/+$/, ""),
        jwt: TOCHKA_SANDBOX_JWT,
        clientId: trimmed(env, "TOCHKA_CLIENT_ID") || "sandbox-client-id",
        customerCode: TOCHKA_SANDBOX_CUSTOMER_CODE,
        accountId: TOCHKA_SANDBOX_ACCOUNT_ID,
      },
      problem: null,
    };
  }

  const missing = ["TOCHKA_JWT", "TOCHKA_CUSTOMER_CODE", "TOCHKA_ACCOUNT_ID"].filter((name) => trimmed(env, name) === "");
  if (missing.length > 0) {
    return { config: null, problem: `Не заданы ${missing.join(", ")}` };
  }
  const accountId = trimmed(env, "TOCHKA_ACCOUNT_ID");
  if (!/^\d{20}\/\d{9}$/.test(accountId)) {
    return { config: null, problem: "TOCHKA_ACCOUNT_ID должен иметь вид «<20 цифр счёта>/<БИК, 9 цифр>»" };
  }
  return {
    config: {
      ...common,
      baseUrl: (trimmed(env, "TOCHKA_API_BASE") || TOCHKA_PROD_BASE).replace(/\/+$/, ""),
      jwt: trimmed(env, "TOCHKA_JWT"),
      clientId: trimmed(env, "TOCHKA_CLIENT_ID"),
      customerCode: trimmed(env, "TOCHKA_CUSTOMER_CODE"),
      accountId,
    },
    problem: null,
  };
}
