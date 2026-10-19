import { createTochkaTransport, type TochkaTransportOptions } from "@/services/tochka/client";
import { tochkaConfigProblem, type TochkaConfig } from "@/services/tochka/config";
import { createTochkaInvoices, type TochkaInvoices } from "@/services/tochka/invoices";
import { createTochkaWebhooks, type TochkaWebhooks } from "@/services/tochka/webhooks";

export * from "@/services/tochka/config";
export { TochkaApiError } from "@/services/tochka/client";
export type { TochkaInvoices, InvoicePaymentStatus, CreateInvoiceInput } from "@/services/tochka/invoices";
export type { TochkaWebhooks, WebhookInfo, WebhookEvent } from "@/services/tochka/webhooks";
export { WEBHOOK_EVENTS } from "@/services/tochka/webhooks";

export interface TochkaApi extends TochkaInvoices, TochkaWebhooks {
  config: TochkaConfig;
}

/** Клиент банка из конфигурации; повторные вызовы в одном процессе делят настройки, а не соединение. */
export function createTochkaApi(config: TochkaConfig, options: TochkaTransportOptions = {}): TochkaApi {
  const transport = createTochkaTransport(config, options);
  return { config, ...createTochkaInvoices(config, transport), ...createTochkaWebhooks(config, transport) };
}

/** Клиент по окружению сервера или null (банк не настроен). */
export function tochkaApiFromEnv(env: Record<string, string | undefined> = process.env): TochkaApi | null {
  const { config } = tochkaConfigProblem(env);
  return config === null ? null : createTochkaApi(config);
}
