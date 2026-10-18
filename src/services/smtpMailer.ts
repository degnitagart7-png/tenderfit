import nodemailer from "nodemailer";

/**
 * Отправка почты через SMTP (mail.ru) — общая для кода входа и для служебных
 * оповещений владельцу.
 *
 * Параметры берутся из окружения сервера: SMTP_HOST, SMTP_PORT (по умолчанию
 * 465, SSL), SMTP_USER, SMTP_PASSWORD и необязательный SMTP_FROM (по умолчанию —
 * SMTP_USER: mail.ru не даёт подписаться чужим адресом). Один модуль на обоих
 * потребителей нужен, чтобы воркер и приложение не расходились в настройках, а
 * сообщение об отсутствующих переменных было одним и тем же.
 */

/** Транспорт SMTP или null, если почтовый сервер не настроен. */
export function smtpTransport() {
  const host = process.env["SMTP_HOST"];
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASSWORD"];
  if (!host || !user || !pass) return null;
  const port = Number(process.env["SMTP_PORT"] ?? "465");
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

/** Настроен ли почтовый сервер. */
export function smtpConfigured(): boolean {
  return smtpTransport() !== null;
}

/**
 * Отправляет письмо. Бросает ошибку, если SMTP не настроен или сервер отказал:
 * решение, молчать об этом или нет, принимает вызывающий. `logLabel` — как
 * назвать источник в журнале («Вход по почте», «Баланс ИИ»).
 */
export async function sendSmtpMail(
  to: string,
  subject: string,
  text: string,
  options: { html?: string; logLabel?: string } = {},
): Promise<void> {
  const label = options.logLabel ?? "Почта";
  const transport = smtpTransport();
  if (transport === null) {
    console.error(`${label}: не заданы SMTP_HOST, SMTP_USER, SMTP_PASSWORD — письмо не отправлено.`);
    throw new Error("SMTP не настроен");
  }
  const from = process.env["SMTP_FROM"] ?? process.env["SMTP_USER"];
  try {
    await transport.sendMail({
      from,
      to,
      subject,
      text,
      ...(options.html === undefined ? {} : { html: options.html }),
    });
  } catch (error) {
    console.error(`${label}: письмо не отправлено:`, error instanceof Error ? error.message : error);
    throw error;
  }
}
