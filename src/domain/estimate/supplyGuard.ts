import type { BillOfWorkItem } from "@/domain/estimate/types";

/**
 * Предохранитель позиции-поставки: наша сумма не может быть на порядки больше, чем у заказчика.
 *
 * Зачем. Цена справочника назначена за единицу с множителем («1000 м», «100 шт»), а объём ведомости — в основной единице; ошибка единицы
 * умножает поставку на тысячу, и сумма уходит в миллиарды (кабель ААБл 3х185: 3 229 702 197 ₽ вместо 1,77 млн ₽ заказчика). Перевод единиц
 * (`deriveSupplyDivisor`) эту ошибку закрывает, а предохранитель ловит то, чего перевод не знает: опечатку в объёме, чужой код ресурса.
 *
 * Работает только там, где сумма позиции заказчика известна (`customerPrice.total`): нет её — сравнивать не с чем. Порог — сто раз:
 * разница цен справочника и закупки в разы — обычное дело, в сотни раз — единицы или масштаб.
 */
export const SUPPLY_SANITY_FACTOR = 100;

/** Причина отказа считать поставку, если наша сумма больше суммы заказчика более чем в `SUPPLY_SANITY_FACTOR` раз; иначе null. */
export function supplySanityProblem(item: BillOfWorkItem, ourTotal: number): string | null {
  const customer = item.customerPrice?.total;
  if (customer == null || !(customer > 0) || !(ourTotal > customer * SUPPLY_SANITY_FACTOR)) return null;
  const money = (value: number): string => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(value));
  return `«${item.workName}»: наша сумма ${money(ourTotal)} ₽ больше суммы заказчика ${money(customer)} ₽ более чем в ${String(SUPPLY_SANITY_FACTOR)} раз — вероятно, единица или объём прочитаны неверно, позиция не посчитана`;
}
