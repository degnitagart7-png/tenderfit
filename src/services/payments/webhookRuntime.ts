import { createWebhookVerifier, type WebhookVerifier } from "@/services/tochka/webhookVerify";

/** Один проверяющий на процесс: ключ банка кэшируется в нём. Запасной ключ — TOCHKA_WEBHOOK_PUBLIC_KEY. */
let verifier: WebhookVerifier | null = null;

export function getWebhookVerifier(): WebhookVerifier {
  verifier ??= createWebhookVerifier({ pinnedKey: process.env["TOCHKA_WEBHOOK_PUBLIC_KEY"] ?? null });
  return verifier;
}
