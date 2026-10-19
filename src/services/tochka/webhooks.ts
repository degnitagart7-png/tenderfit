import type { TochkaConfig } from "@/services/tochka/config";
import { TochkaApiError, type TochkaTransport } from "@/services/tochka/client";

/**
 * Управление вебхуками Точки (разрешение ManageWebhookData). Пути — из ссылок на методы:
 *
 *   GET    /webhook/v1.0/{client_id}              Get Webhooks   (404 «не существует», пока ни одного нет)
 *   PUT    /webhook/v1.0/{client_id}              Create Webhook {webhooksList, url}
 *   POST   /webhook/v1.0/{client_id}              Edit Webhook   {webhooksList, url}
 *   DELETE /webhook/v1.0/{client_id}              Delete Webhook
 *   POST   /webhook/v1.0/{client_id}/test_send    Send Webhook   {webhookType}
 *
 * Банк при создании и изменении сам шлёт на адрес по тестовому вебхуку на каждое событие и
 * требует ответ 200 (только HTTPS, порт 443).
 */

export const WEBHOOK_EVENTS = ["incomingPayment", "incomingSbpPayment", "incomingSbpB2BPayment"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookInfo {
  webhooksList: string[];
  url: string;
}

interface WebhookResponse {
  Data?: { webhooksList?: unknown; url?: unknown };
}
interface BooleanResponse {
  Data?: { result?: unknown };
}

function toInfo(response: WebhookResponse): WebhookInfo {
  const list = response.Data?.webhooksList;
  return {
    webhooksList: Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [],
    url: typeof response.Data?.url === "string" ? response.Data.url : "",
  };
}

export interface TochkaWebhooks {
  /** null — вебхука ещё нет (банк отвечает 404). */
  getWebhooks(): Promise<WebhookInfo | null>;
  createWebhook(url: string, events?: readonly string[]): Promise<WebhookInfo>;
  editWebhook(url: string, events?: readonly string[]): Promise<WebhookInfo>;
  sendTestWebhook(type: WebhookEvent): Promise<boolean>;
}

export function createTochkaWebhooks(config: TochkaConfig, transport: TochkaTransport): TochkaWebhooks {
  const path = `/webhook/v1.0/${encodeURIComponent(config.clientId)}`;
  const need = (): void => {
    if (config.clientId === "") throw new TochkaApiError("Не задан TOCHKA_CLIENT_ID (client_id рядом с JWT-ключом в банке)", 0);
  };

  return {
    async getWebhooks() {
      need();
      try {
        return toInfo(await transport.json<WebhookResponse>({ method: "GET", path, idempotent: true }));
      } catch (error) {
        if (error instanceof TochkaApiError && error.status === 404) return null;
        throw error;
      }
    },
    async createWebhook(url, events = WEBHOOK_EVENTS) {
      need();
      return toInfo(await transport.json<WebhookResponse>({ method: "PUT", path, body: { webhooksList: [...events], url } }));
    },
    async editWebhook(url, events = WEBHOOK_EVENTS) {
      need();
      return toInfo(await transport.json<WebhookResponse>({ method: "POST", path, body: { webhooksList: [...events], url } }));
    },
    async sendTestWebhook(type) {
      need();
      const response = await transport.json<BooleanResponse>({
        method: "POST",
        path: `${path}/test_send`,
        body: { webhookType: type },
        idempotent: true,
      });
      return response.Data?.result === true;
    },
  };
}
