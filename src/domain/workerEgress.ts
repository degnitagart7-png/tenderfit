/**
 * Разбор ответа сервиса определения внешнего адреса.
 *
 * Воркер пишет в пульс свой адрес выхода и страну: это единственное честное
 * доказательство для партнёра, что документация качается из России. ЕИС и её
 * хранилище файлов не отвечают зарубежным адресам, поэтому смена выхода —
 * не деталь реализации, а причина, по которой закупки перестанут получать
 * вложения.
 *
 * Сервисов несколько и форматы у них разные, а полагаться на один нельзя:
 * любой из них может ответить ошибкой или не отвечать из российского сегмента.
 * Разбор вынесен в чистую функцию, чтобы смену провайдера было видно в тесте,
 * а не в логе воркера ночью.
 */

export interface EgressInfo {
  ip: string | null;
  /** Двухбуквенный код страны в верхнем регистре; null — сервис его не отдал. */
  country: string | null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const COUNTRY = /^[A-Za-z]{2}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Походит ли строка на адрес: IPv4 или что-то с двоеточиями (IPv6). */
function looksLikeIp(value: string): boolean {
  return IPV4.test(value) || value.includes(":");
}

function readIp(record: Record<string, unknown>): string | null {
  // Разные сервисы называют поле по-своему: ipinfo и ipapi — `ip`,
  // ip-api.com — `query`, некоторые прокси отдают `origin` списком адресов.
  for (const key of ["ip", "query", "origin", "clientIp"] as const) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const candidate = value.split(",")[0]?.trim() ?? "";
    if (looksLikeIp(candidate)) return candidate;
  }
  return null;
}

function readCountry(record: Record<string, unknown>): string | null {
  for (const key of ["country", "country_code", "countryCode", "countryCodeIso2"] as const) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const candidate = value.trim();
    if (COUNTRY.test(candidate)) return candidate.toUpperCase();
  }
  return null;
}

/**
 * Достаёт адрес и страну из ответа любого из поддерживаемых сервисов.
 *
 * Принимает и строку (сервисы вроде ifconfig.me отдают голый адрес текстом),
 * и разобранный JSON. Нераспознанный ответ даёт `{ ip: null, country: null }`,
 * а не исключение: определение адреса — проверка, а не обязанность, и её сбой
 * не должен останавливать загрузку документации.
 */
export function readEgressReply(body: unknown): EgressInfo {
  if (typeof body === "string") {
    const candidate = body.trim();
    return { ip: looksLikeIp(candidate) ? candidate : null, country: null };
  }

  const record = asRecord(body);
  if (!record) return { ip: null, country: null };

  return { ip: readIp(record), country: readCountry(record) };
}
