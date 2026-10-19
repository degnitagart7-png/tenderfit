import type { TochkaConfig } from "@/services/tochka/config";

/**
 * Транспорт к API Точка Банка: заголовок авторизации, таймаут, повторы, понятные ошибки.
 *
 * Повторы только там, где они безопасны: 429 повторяется всегда (запрос не обработан), 5xx и
 * сетевые обрывы — только для чтений и идемпотентных вызовов (`idempotent: true`). Создание
 * счёта после таймаута не повторяется: банк мог его создать, и второй вызов выставил бы
 * клиенту два счёта. Сообщения об ошибках — по-русски и без секретов: JWT живёт только в
 * заголовке и в текст ошибки или журнал не попадает.
 */

export interface TochkaTransportOptions {
  fetchImpl?: typeof fetch;
  /** Пауза между повторами; в тестах — 0. */
  retryDelayMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

export class TochkaApiError extends Error {
  readonly status: number;
  /** Идентификатор ошибки банка (`id` в теле) — его называют в поддержке. */
  readonly bankErrorId: string | null;
  /** Ошибка временная: повтор позже может сработать. */
  readonly transient: boolean;

  constructor(message: string, status: number, options: { bankErrorId?: string | null; transient?: boolean } = {}) {
    super(message);
    this.name = "TochkaApiError";
    this.status = status;
    this.bankErrorId = options.bankErrorId ?? null;
    this.transient = options.transient ?? false;
  }
}

export interface TochkaRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Путь после базового адреса: «/invoice/v1.0/bills». */
  path: string;
  body?: unknown;
  /** Повторять при 5xx и обрывах. */
  idempotent?: boolean;
  /** Ждём не JSON, а файл. */
  binary?: boolean;
}

interface BankErrorBody {
  code?: unknown;
  id?: unknown;
  message?: unknown;
  Errors?: unknown;
}

/** Одна строка из тела ошибки банка: «message — errorCode: message». Секретов в нём нет. */
export function describeBankError(body: unknown): { text: string; id: string | null } {
  if (typeof body !== "object" || body === null) return { text: "", id: null };
  const b = body as BankErrorBody;
  const parts: string[] = [];
  if (typeof b.message === "string" && b.message.trim() !== "") parts.push(b.message.trim());
  if (Array.isArray(b.Errors)) {
    for (const item of b.Errors.slice(0, 4)) {
      if (typeof item !== "object" || item === null) continue;
      const e = item as { errorCode?: unknown; message?: unknown };
      const line = [e.errorCode, e.message].filter((v): v is string => typeof v === "string" && v !== "").join(": ");
      if (line !== "") parts.push(line);
    }
  }
  return { text: parts.join("; ").slice(0, 400), id: typeof b.id === "string" ? b.id : null };
}

function messageForStatus(status: number, bank: string): string {
  const tail = bank === "" ? "" : ` (${bank})`;
  switch (status) {
    case 400:
      return `Банк не принял данные${tail}`;
    case 401:
      return `Банк не принял ключ доступа (JWT): ключ неверный или истёк срок${tail}`;
    case 403:
      return `У ключа нет нужных разрешений в банке (для счетов — ManageInvoiceData, для вебхуков — ManageWebhookData)${tail}`;
    case 404:
      return `Банк не нашёл объект${tail}`;
    case 429:
      return `Банк просит не частить с запросами${tail}`;
    default:
      return status >= 500 ? `Банк временно недоступен (код ${String(status)})${tail}` : `Банк ответил ошибкой ${String(status)}${tail}`;
  }
}

const sleep = (ms: number): Promise<void> => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

export interface TochkaTransport {
  json<T>(req: TochkaRequest): Promise<T>;
  file(req: Omit<TochkaRequest, "binary">): Promise<{ bytes: Buffer; contentType: string }>;
}

export function createTochkaTransport(config: TochkaConfig, options: TochkaTransportOptions = {}): TochkaTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 700;

  async function call(req: TochkaRequest): Promise<Response> {
    const url = `${config.baseUrl}${req.path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.jwt}`,
      Accept: req.binary ? "application/pdf, application/octet-stream, */*" : "application/json",
    };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";

    let lastError: TochkaApiError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await doFetch(url, {
          method: req.method,
          headers,
          ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
        if (response.ok) return response;

        let bodyJson: unknown = null;
        try {
          bodyJson = await response.json();
        } catch {
          bodyJson = null;
        }
        const bank = describeBankError(bodyJson);
        const retryable = response.status === 429 || (response.status >= 500 && req.idempotent === true);
        const error = new TochkaApiError(messageForStatus(response.status, bank.text), response.status, {
          bankErrorId: bank.id,
          transient: response.status === 429 || response.status >= 500,
        });
        if (!retryable || attempt === maxAttempts) throw error;
        lastError = error;
      } catch (err) {
        if (err instanceof TochkaApiError) {
          if (attempt === maxAttempts || !(err.status === 429 || (err.status >= 500 && req.idempotent === true))) throw err;
          lastError = err;
        } else {
          // Сеть оборвалась или вышло время. Текст исходной ошибки не пересылаем: в нём может быть адрес с токеном.
          const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
          const error = new TochkaApiError(
            timedOut ? "Банк не ответил вовремя" : "Не удалось связаться с банком",
            0,
            { transient: true },
          );
          if (req.idempotent !== true || attempt === maxAttempts) throw error;
          lastError = error;
        }
      }
      await sleep(retryDelayMs * attempt);
    }
    throw lastError ?? new TochkaApiError("Банк не ответил", 0, { transient: true });
  }

  return {
    async json<T>(req: TochkaRequest): Promise<T> {
      const response = await call(req);
      try {
        return (await response.json()) as T;
      } catch {
        throw new TochkaApiError("Банк прислал ответ, который не удалось прочитать", response.status);
      }
    },
    async file(req) {
      const response = await call({ ...req, binary: true, idempotent: true });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes, contentType: response.headers.get("content-type") ?? "application/pdf" };
    },
  };
}
