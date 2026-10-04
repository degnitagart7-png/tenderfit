/** Утилиты форматирования: суммы в рублях, даты в российском формате, время МСК. */

/**
 * Знаки валют, которые реально встречаются в закупках на российских площадках.
 *
 * Рубль — по умолчанию: подавляющее большинство карточек в ЕИС объявлено в нём.
 * Неизвестный код показываем как есть («AED»): выдумывать знак хуже, чем
 * показать трёхбуквенное обозначение из карточки.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  RUB: "₽",
  USD: "$",
  EUR: "€",
  GBP: "£",
  CNY: "¥",
  JPY: "¥",
  BYN: "Br",
  KZT: "₸",
  UAH: "₴",
};

/** Знак валюты по коду; пустой или отсутствующий код считается рублём. */
export function currencySymbol(code: string | null | undefined): string {
  const normalized = (code ?? "").trim().toUpperCase();
  if (normalized.length === 0) return "₽";
  return CURRENCY_SYMBOLS[normalized] ?? normalized;
}

/**
 * Сумма в указанной валюте. Без аргумента `currency` — рубли, поэтому все
 * существующие вызовы продолжают печатать «₽».
 */
export function formatCurrency(
  value: number | null | undefined,
  currency?: string | null,
): string {
  if (value === null || value === undefined) return "—";
  return `${value.toLocaleString("ru-RU", {
    maximumFractionDigits: 2,
  })} ${currencySymbol(currency)}`;
}

/**
 * Рублёвая сумма коротко: «12,4 млн ₽», «860 тыс ₽», «1,2 млрд ₽».
 *
 * Нужна там, где число читают как масштаб, а не как точную сумму — в подписи
 * подборки на первом экране. Полные «12 437 812,50 ₽» в такой строке заставляют
 * пересчитывать разряды глазами вместо того, чтобы сразу понять порядок денег.
 */
export function formatCompactRub(value: number | null | undefined): string {
  if (value === null || value === undefined || value <= 0) return "—";
  const units: { limit: number; suffix: string }[] = [
    { limit: 1e9, suffix: "млрд" },
    { limit: 1e6, suffix: "млн" },
    { limit: 1e3, suffix: "тыс" },
  ];
  for (const { limit, suffix } of units) {
    if (value >= limit) {
      const scaled = value / limit;
      /*
        До сотни показываем десятую долю: разница между 12,4 и 12,9 млн ещё
        читается как разные деньги, а между 124 и 124,3 млн — уже нет.
        Ровное значение печатается без хвостового нуля: «1 млн ₽», не «1,0 млн ₽».
      */
      const digits =
        scaled >= 100 || Number.isInteger(Math.round(scaled * 10) / 10) ? 0 : 1;
      return `${scaled.toLocaleString("ru-RU", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })} ${suffix} ₽`;
    }
  }
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("ru-RU");
}

/**
 * Цена закупки для показа. Нуль и null — это «цена не опубликована»
 * (так площадка отдаёт запросы предложений и запросы цен), а не «0 ₽».
 *
 * Валюта обязательна по смыслу, но не по сигнатуре: коммерческие закупки
 * площадки объявляют и в долларах, и в юанях, и «1 000 ₽» вместо
 * «1 000 $» — это уже не косметика, а неверные данные на экране.
 */
export function formatTenderPrice(
  value: number | null | undefined,
  currency?: string | null,
): string {
  if (value === null || value === undefined || value <= 0) return "Не указана";
  return formatCurrency(value, currency);
}

/** Дата в формате дд.мм.гггг. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

/** Дата и время в формате дд.мм.гггг, чч:мм МСК. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy}, ${hh}:${min} МСК`;
}

/** Обратный отсчёт до окончания подачи: «осталось N дн.» / «менее суток». */
export function formatTimeLeft(
  submissionEnd: string,
  now: Date = new Date(),
): string {
  const end = new Date(submissionEnd).getTime();
  if (Number.isNaN(end)) return "—";
  const diffMs = end - now.getTime();
  if (diffMs <= 0) return "подача завершена";
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 24) return `осталось менее суток (${hours} ч)`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `осталось ${days} дн. ${rest} ч`;
}

export function pluralRu(
  count: number,
  forms: [string, string, string],
): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2]!;
  if (n1 > 1 && n1 < 5) return forms[1]!;
  if (n1 === 1) return forms[0]!;
  return forms[2]!;
}

/**
 * Перечисление по-русски: «ЕИС, ТЭК-Торг и Сбербанк-АСТ».
 *
 * Союз ставится только перед последним элементом, поэтому перечень из двух
 * пунктов читается без запятой. Пустой список даёт пустую строку, а не висячий
 * «и»: подпись источника собирается из каталога, и подпись без источников
 * обязана исчезнуть целиком, а не остаться обрубком.
 */
export function joinRuList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} и ${items[items.length - 1]!}`;
}

/**
 * Размер в байтах читаемо: текст извещения ЕИС — это сотни килобайт,
 * и «432708» в карточке ничего не говорит пользователю.
 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} КБ`;
  }
  return `${(kb / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}
