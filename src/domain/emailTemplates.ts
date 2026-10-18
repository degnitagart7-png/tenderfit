import { OPERATOR } from "@/lib/legal";

/**
 * Письма сервиса: код подтверждения и напоминания о пробном периоде.
 *
 * Чистые функции без почтового сервера: тема, текстовая версия и HTML. У
 * каждого письма обе версии — часть почтовых клиентов показывает только текст,
 * а спам-фильтры не любят письма без него. HTML простой, таблицей и с
 * inline-стилями: почтовые клиенты не читают ни Tailwind, ни `<style>` в
 * `<head>` одинаково.
 *
 * Цвета те же, что у приложения (--ink, --accent-strong), но заданы числами:
 * переменные CSS в письме не работают.
 */

export type CodeEmailKind = "register" | "login" | "reset";

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export const INK = "#1C1917";
export const ACCENT = "#D14311";
export const MUTED = "#55514B";
export const FAINT = "#6C6862";
export const BORDER = "#E9E7E3";
export const PAGE = "#F6F6F4";
const MUSTARD_BG = "#FFFAE8";
const MUSTARD_LINE = "#FAE5A5";
const MUSTARD_FG = "#854D0E";

/** Адрес оплаты в приложении. */
export const BILLING_URL = `https://${OPERATOR.site}/billing`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Общая рамка письма: тёмная шапка с логотипом, белая карточка, подпись оператора. */
export function layout(options: { preheader: string; title: string; body: string; maxWidth?: number }): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(options.title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(options.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${String(options.maxWidth ?? 480)}px;font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
<tr><td style="padding:0 4px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:34px;height:34px;background:${ACCENT};border-radius:9px;text-align:center;vertical-align:middle;color:#ffffff;font-size:14px;font-weight:700;">ТФ</td>
<td style="padding-left:10px;font-size:17px;font-weight:600;color:${INK};letter-spacing:-0.01em;">ТендерФит</td>
</tr></table>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid ${BORDER};border-radius:16px;padding:28px 24px;color:${INK};">
${options.body}
</td></tr>
<tr><td style="padding:16px 8px 0;font-size:12px;line-height:1.5;color:${FAINT};text-align:center;">
${escapeHtml(OPERATOR.fullName)}, ИНН ${escapeHtml(OPERATOR.inn)}<br>
Вопросы: <a href="mailto:${OPERATOR.email}" style="color:${FAINT};">${escapeHtml(OPERATOR.email)}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 26px;border-radius:999px;">${escapeHtml(label)}</a>`;
}

const CODE_COPY: Record<CodeEmailKind, { subject: string; heading: string; lead: string; ignore: string }> = {
  register: {
    subject: "Код подтверждения регистрации в ТендерФит",
    heading: "Подтвердите почту",
    lead: "Ваш код подтверждения регистрации:",
    ignore: "Если вы не регистрировались в ТендерФит, просто проигнорируйте это письмо: аккаунт не будет создан.",
  },
  login: {
    subject: "Код входа в ТендерФит",
    heading: "Вход в ТендерФит",
    lead: "Ваш код входа:",
    ignore: "Если вы не запрашивали код, просто проигнорируйте это письмо: без кода в аккаунт не войти.",
  },
  reset: {
    subject: "Код для восстановления пароля в ТендерФит",
    heading: "Восстановление пароля",
    lead: "Ваш код для смены пароля:",
    ignore: "Если вы не просили сменить пароль, просто проигнорируйте это письмо: прежний пароль продолжит работать.",
  },
};

/** Письмо с шестизначным кодом: регистрация, вход по коду или восстановление пароля. */
export function buildCodeEmail(input: { kind: CodeEmailKind; code: string; ttlMinutes: number }): EmailMessage {
  const copy = CODE_COPY[input.kind];
  const ttl = `${String(input.ttlMinutes)} минут`;
  const text = [
    `${copy.lead} ${input.code}`,
    "",
    `Код действует ${ttl} и подходит один раз.`,
    "",
    copy.ignore,
    "",
    `ТендерФит · ${OPERATOR.site}`,
  ].join("\n");

  const body = `<h1 style="margin:0 0 6px;font-size:20px;font-weight:600;letter-spacing:-0.01em;color:${INK};">${escapeHtml(copy.heading)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${MUTED};">${escapeHtml(copy.lead)}</p>
<div style="margin:0 0 20px;padding:18px 12px;background:${PAGE};border:1px solid ${BORDER};border-radius:12px;text-align:center;font-family:'JetBrains Mono','SFMono-Regular',Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:0.28em;text-indent:0.28em;color:${INK};">${escapeHtml(input.code)}</div>
<p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:${MUTED};">Код действует <strong style="color:${INK};">${escapeHtml(ttl)}</strong> и подходит один раз.</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${FAINT};">${escapeHtml(copy.ignore)}</p>`;

  return {
    subject: copy.subject,
    text,
    html: layout({ preheader: `${copy.lead} ${input.code}`, title: copy.subject, body }),
  };
}

const MSK_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Moscow",
});

/**
 * «12 октября, 15:30 (МСК)»: серверный пояс в письме не значит ничего.
 * Строка собирается из частей, а не берётся готовой: связка между датой и
 * временем («в» или запятая) зависит от версии ICU в Node.
 */
export function formatMoscow(ms: number): string {
  const parts = Object.fromEntries(MSK_FORMAT.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts["day"] ?? ""} ${parts["month"] ?? ""}, ${parts["hour"] ?? ""}:${parts["minute"] ?? ""} (МСК)`;
}

/** За сутки до конца пробного периода. */
export function buildTrialEndingEmail(input: { endsAtMs: number }): EmailMessage {
  const until = formatMoscow(input.endsAtMs);
  const subject = "Пробный период закончится завтра";
  const text = [
    "Здравствуйте!",
    "",
    `Бесплатный период в ТендерФит закончится завтра, ${until}.`,
    "Ваши данные сохранятся. Чтобы продолжить пользоваться поиском, анализом документации и сметами, выберите тариф и запросите счёт:",
    "",
    BILLING_URL,
    "",
    `Вопросы — ответом на это письмо или на ${OPERATOR.email}.`,
    "",
    `ТендерФит · ${OPERATOR.site}`,
  ].join("\n");

  const body = `<h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em;color:${INK};">Пробный период закончится завтра</h1>
<div style="margin:0 0 18px;padding:12px 14px;background:${MUSTARD_BG};border:1px solid ${MUSTARD_LINE};border-radius:12px;font-size:14px;line-height:1.5;color:${MUSTARD_FG};">Доступ открыт до <strong>${escapeHtml(until)}</strong></div>
<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:${MUTED};">Ваши данные сохранятся. Чтобы продолжить пользоваться поиском закупок, анализом документации и сметами, выберите тариф и запросите счёт.</p>
<p style="margin:0 0 20px;">${button(BILLING_URL, "Выбрать тариф")}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${FAINT};">Вопросы — ответом на это письмо.</p>`;

  return { subject, text, html: layout({ preheader: `Доступ открыт до ${until}`, title: subject, body }) };
}

/** Пробный период закончился. */
export function buildTrialEndedEmail(): EmailMessage {
  const subject = "Пробный период закончился";
  const text = [
    "Здравствуйте!",
    "",
    "Бесплатный период в ТендерФит закончился. Ваши данные, профили и настройки сохранены: вы можете войти, посмотреть тарифы и запросить счёт.",
    "После оплаты доступ откроется снова:",
    "",
    BILLING_URL,
    "",
    `Вопросы — ответом на это письмо или на ${OPERATOR.email}.`,
    "",
    `ТендерФит · ${OPERATOR.site}`,
  ].join("\n");

  const body = `<h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em;color:${INK};">Пробный период закончился</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:${MUTED};">Ваши данные, профили и настройки сохранены. Выберите тариф и запросите счёт: после оплаты доступ откроется снова.</p>
<p style="margin:0 0 20px;">${button(BILLING_URL, "Выбрать тариф")}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${FAINT};">Вопросы — ответом на это письмо.</p>`;

  return { subject, text, html: layout({ preheader: "Данные сохранены. Выберите тариф, чтобы продолжить.", title: subject, body }) };
}
