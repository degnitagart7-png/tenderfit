/**
 * Настройки писем: приведение сохранённого значения к виду, пригодному для работы.
 *
 * Настройки лежат в браузере (`tf.digestSettings`) и в аккаунте (`app_state.digestSettings`),
 * то есть приходят из сети и со старых версий приложения: там может не оказаться новых
 * полей (часовой пояс, письмо «готов расчёт») или лежать мусор. Воркер читает их на
 * сервере тем же способом, что страница — через эту функцию, чтобы «что считается
 * включённым» не разошлось между экраном и рассылкой.
 *
 * Чистый модуль: без часов, базы и браузера.
 */

/** Пояс по умолчанию: основная аудитория — Москва, и неверный пояс не должен ронять рассылку. */
export const DEFAULT_TIME_ZONE = "Europe/Moscow";
export const DEFAULT_SEND_TIME = "08:00";
export const DEFAULT_MIN_FIT_SCORE = 50;

export interface ResolvedDigestSettings {
  /** Утренняя сводка включена. */
  enabled: boolean;
  /** «ЧЧ:ММ» по часовому поясу клиента. */
  sendTime: string;
  /** IANA-имя пояса, проверенное: его принимает `Intl`. */
  timeZone: string;
  /** Письмо «готов анализ или смета» включено. */
  readyEnabled: boolean;
  /** Закупки с оценкой ниже в сводку не попадают, 0–100. */
  minFitScore: number;
}

/** Принимает ли `Intl` такой пояс. */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** «ЧЧ:ММ» в пределах суток; иначе null. Допускает «8:00». */
export function normalizeSendTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Минуты от полуночи для «ЧЧ:ММ» (значение уже проверено `normalizeSendTime`). */
export function sendTimeMinutes(sendTime: string): number {
  const [hours, minutes] = sendTime.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * Настройки с значениями по умолчанию и проверкой.
 *
 * - сводка и письмо о готовности включены, пока человек явно не выключил (`=== false`);
 * - время не «ЧЧ:ММ» — 08:00; пояс, которого не знает `Intl`, — Москва;
 * - порог оценки не число — 50, иначе зажимается в 0–100.
 */
export function resolveDigestSettings(raw: unknown): ResolvedDigestSettings {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const min = source["minFitScore"];
  return {
    enabled: source["enabled"] !== false,
    sendTime: normalizeSendTime(source["sendTime"]) ?? DEFAULT_SEND_TIME,
    timeZone: isValidTimeZone(source["timeZone"]) ? source["timeZone"] : DEFAULT_TIME_ZONE,
    readyEnabled: source["readyEnabled"] !== false,
    minFitScore:
      typeof min === "number" && Number.isFinite(min) ? Math.min(100, Math.max(0, Math.round(min))) : DEFAULT_MIN_FIT_SCORE,
  };
}

/* ------------------------------ Часовые пояса РФ ------------------------------ */

export interface TimeZoneOption {
  /** IANA-имя, которое сохраняется в настройках. */
  value: string;
  /** Подпись в списке: города и смещение от Москвы. */
  label: string;
  /** Короткое имя для строки «Сводка придёт … (Иркутск)». */
  city: string;
  /** Другие IANA-имена с тем же смещением: браузер человека может назвать пояс ими. */
  aliases: readonly string[];
}

/** Пояса России, на которые смотрит выбор в «Уведомлениях»: от Калининграда до Камчатки. */
export const TIME_ZONE_OPTIONS: readonly TimeZoneOption[] = [
  { value: "Europe/Kaliningrad", label: "Калининград (МСК−1)", city: "Калининград", aliases: [] },
  { value: "Europe/Moscow", label: "Москва (МСК)", city: "Москва", aliases: ["Europe/Simferopol", "Europe/Kirov", "Europe/Volgograd", "Europe/Minsk"] },
  { value: "Europe/Samara", label: "Самара (МСК+1)", city: "Самара", aliases: ["Europe/Astrakhan", "Europe/Saratov", "Europe/Ulyanovsk"] },
  { value: "Asia/Yekaterinburg", label: "Екатеринбург (МСК+2)", city: "Екатеринбург", aliases: [] },
  { value: "Asia/Omsk", label: "Омск (МСК+3)", city: "Омск", aliases: [] },
  {
    value: "Asia/Krasnoyarsk",
    label: "Новосибирск, Красноярск (МСК+4)",
    city: "Новосибирск/Красноярск",
    aliases: ["Asia/Novosibirsk", "Asia/Barnaul", "Asia/Tomsk", "Asia/Novokuznetsk"],
  },
  { value: "Asia/Irkutsk", label: "Иркутск (МСК+5)", city: "Иркутск", aliases: [] },
  { value: "Asia/Yakutsk", label: "Якутск (МСК+6)", city: "Якутск", aliases: ["Asia/Chita"] },
  { value: "Asia/Vladivostok", label: "Владивосток (МСК+7)", city: "Владивосток", aliases: ["Asia/Ust-Nera"] },
  { value: "Asia/Magadan", label: "Магадан (МСК+8)", city: "Магадан", aliases: ["Asia/Sakhalin", "Asia/Srednekolymsk"] },
  { value: "Asia/Kamchatka", label: "Камчатка (МСК+9)", city: "Камчатка", aliases: ["Asia/Anadyr"] },
];

/** Пункт списка для пояса: по самому имени или по его псевдониму; null — пояса нет среди российских. */
export function timeZoneOption(zone: string): TimeZoneOption | null {
  return TIME_ZONE_OPTIONS.find((o) => o.value === zone || o.aliases.includes(zone)) ?? null;
}

/** Название для людей: «Иркутск»; незнакомый пояс — его IANA-имя без региона («Asia/Dubai» → «Dubai»). */
export function timeZoneCity(zone: string): string {
  const option = timeZoneOption(zone);
  if (option !== null) return option.city;
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}
