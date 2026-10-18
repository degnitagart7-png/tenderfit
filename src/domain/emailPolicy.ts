/**
 * Какие адреса почты принимает сервис.
 *
 * Регистрация с почтой Google (gmail.com) закрыта по требованию владельца.
 * Правило не должно обходиться регистром букв, точкой в конце домена или
 * поддоменом, поэтому домен сравнивается целиком и по границе точки, а не по
 * подстроке: «notgmail.com» и «gmail.com.evil.ru» проходят, «mail.gmail.com» —
 * нет. Домены компаний на Google Workspace определяются по почтовым серверам
 * (MX): письма ivan@firma.ru, которые принимает Google, — тоже почта Google.
 *
 * Модуль без сети: запрос MX делает вызывающий код, а здесь — только решения.
 */

const MAX_EMAIL_CHARS = 254;

const LOCAL_PART = /^[\p{L}\p{N}._%+'-]+$/u;
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

/** Домены, регистрация с которых закрыта. Поддомены закрыты вместе с ними. */
const BLOCKED_DOMAINS = ["gmail.com", "googlemail.com", "google.com"] as const;

/** Хосты почтовых серверов Google: у Workspace письма идут через них. */
const GOOGLE_MX_DOMAINS = ["google.com", "googlemail.com"] as const;

function stripDot(host: string): string {
  return host.replace(/\.$/, "").toLowerCase();
}

function isSameOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Приводит адрес к виду, в котором он хранится и сравнивается.
 *
 * Возвращает null, если это не адрес почты. Домен на кириллице допустим
 * (ivan@почта.рф): такие адреса в России не редкость.
 */
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value === "" || value.length > MAX_EMAIL_CHARS) return null;

  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return null;

  const local = value.slice(0, at);
  const domain = stripDot(value.slice(at + 1));
  if (!LOCAL_PART.test(local)) return null;

  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return null;
  if (!/^\p{L}{2,}$/u.test(labels[labels.length - 1] ?? "") && !(labels[labels.length - 1] ?? "").startsWith("xn--")) {
    return null;
  }

  return `${local}@${domain}`;
}

/** Домен нормализованного адреса. */
export function emailDomain(email: string): string {
  return stripDot(email.slice(email.lastIndexOf("@") + 1));
}

/** Домен закрыт для регистрации (gmail.com, googlemail.com и их поддомены). */
export function isBlockedEmailDomain(domain: string): boolean {
  const host = stripDot(domain);
  return BLOCKED_DOMAINS.some((blocked) => isSameOrSubdomain(host, blocked));
}

/** Письма домена принимает Google: адрес — почта Google, хотя домен свой. */
export function isGoogleHostedMx(mxHosts: readonly string[]): boolean {
  return mxHosts.some((raw) => {
    const host = stripDot(raw);
    return GOOGLE_MX_DOMAINS.some((d) => isSameOrSubdomain(host, d));
  });
}

/** Сообщение человеку, когда адрес закрыт. */
export const GOOGLE_MAIL_BLOCKED_MESSAGE =
  "Регистрация с почтой Google (gmail.com и почтой компаний на Google Workspace) недоступна. Укажите другой адрес, например Яндекс, Mail.ru или корпоративный.";
