import { parseAdminEmails } from "@/domain/access";
import type { EmailMessage } from "@/domain/emailTemplates";
import { describeError } from "@/lib/errors";
import { paymentRepository, type PaymentStore } from "@/repositories/paymentRepository";
import { subscriptionRepository, type SubscriptionStore } from "@/repositories/subscriptionRepository";
import { sendSmtpMail } from "@/services/smtpMailer";
import { tochkaApiFromEnv, type TochkaApi } from "@/services/tochka";

/**
 * Зависимости сервисов оплаты: база, банк, почта, часы. Сервисы принимают их параметром, поэтому
 * тесты подставляют хранилище в памяти, поддельный банк и записывающую почту, а приложение и
 * воркер — `defaultPaymentDeps()`.
 */

/** Что сервисам нужно от банка; тесты подставляют часть методов. */
export type TochkaPort = Pick<
  TochkaApi,
  | "config"
  | "createInvoice"
  | "getInvoicePdf"
  | "getInvoicePaymentStatus"
  | "sendInvoiceToEmail"
  | "createAct"
  | "sendClosingToEmail"
>;

export interface PaymentDeps {
  store: PaymentStore;
  users: SubscriptionStore;
  /** null — банк не настроен. */
  tochka: TochkaPort | null;
  sendMail: (to: string, message: EmailMessage) => Promise<void>;
  env: Record<string, string | undefined>;
  now: () => number;
  log: (message: string) => void;
}

export function defaultPaymentDeps(overrides: Partial<PaymentDeps> = {}): PaymentDeps {
  return {
    store: paymentRepository,
    users: subscriptionRepository,
    tochka: tochkaApiFromEnv(),
    sendMail: (to, message) => sendSmtpMail(to, message.subject, message.text, { html: message.html, logLabel: "Оплата" }),
    env: process.env,
    now: () => Date.now(),
    log: (message) => console.log(`[payments] ${message}`),
    ...overrides,
  };
}

export function adminEmails(deps: Pick<PaymentDeps, "env">): string[] {
  return [...parseAdminEmails(deps.env["ADMIN_EMAILS"])];
}

/** Письмо администраторам; сбой почты не бросается: оплата важнее уведомления о ней. */
export async function notifyAdmins(deps: Pick<PaymentDeps, "env" | "sendMail" | "log">, message: EmailMessage): Promise<void> {
  const admins = adminEmails(deps);
  if (admins.length === 0) {
    deps.log(`письмо «${message.subject}» некому отправить: ADMIN_EMAILS пуст`);
    return;
  }
  await Promise.all(
    admins.map((to) =>
      deps.sendMail(to, message).catch((error: unknown) => {
        deps.log(`письмо «${message.subject}» администратору не ушло: ${describeError(error)}`);
      }),
    ),
  );
}

/** Письмо клиенту; сбой почты не бросается. */
export async function notifyUser(
  deps: Pick<PaymentDeps, "sendMail" | "log">,
  to: string,
  message: EmailMessage,
): Promise<boolean> {
  try {
    await deps.sendMail(to, message);
    return true;
  } catch (error) {
    deps.log(`письмо «${message.subject}» клиенту не ушло: ${describeError(error)}`);
    return false;
  }
}
