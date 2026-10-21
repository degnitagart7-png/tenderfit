import type { BidEconomics, PriceVerdict } from "@/domain/estimate/bidEconomics";

/**
 * Подписи «Экономики участия», общие для экрана и книги Excel: числа и слова на экране и в файле не должны расходиться.
 */

export const VERDICT_TEXT: Record<PriceVerdict, string> = {
  OK: "выгодно",
  BELOW_TARGET_MARGIN: "маржа ниже цели",
  LOSS: "убыток",
};

export const TAX_TEXT: Record<BidEconomics["taxKind"], string> = {
  OSNO: "ОСНО: НДС к вычету, налог на прибыль 20 %",
  USN_INCOME: "УСН «доходы» 6 %, НДС поставщиков не возвращается",
  USN_INCOME_EXPENSES: "УСН «доходы минус расходы» 15 % (не меньше 1 % с выручки)",
  PATENT_AS_USN_INCOME: "патент — посчитан как УСН «доходы» 6 %",
};

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** «4 937 143 ₽»; нет значения — «—». */
export function rubText(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${RUB.format(Math.round(value))} ₽`;
}

/** «8,6 %»; нет значения — «—». */
export function percentText(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(digits).replace(".", ",")} %`;
}

/** Откуда основа расчёта — одной фразой для шапки блока и файла. */
export function baseOriginText(origin: BidEconomics["baseOrigin"]): string {
  switch (origin) {
    case "ESTIMATE":
      return "наша смета по ведомости: нормы ФСНБ-2022, текущие цены Минстроя";
    case "AUDIT":
      return "смета заказчика, пересчитанная по ценам зоны и квартала";
    case "AUDIT_LUMP":
      return "смета заказчика, пересчитанная по ценам зоны (без разбивки по группам затрат)";
  }
}
