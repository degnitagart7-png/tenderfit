import { OPERATOR } from "@/lib/legal";

/**
 * Пакеты подписки — единственный источник цен и состава.
 *
 * Страница оплаты и коммерческое предложение должны называть одни и те же
 * числа, поэтому они читают их отсюда, а не копируют. Цена `null` означает
 * «по запросу»: у пакета нет фиксированной стоимости, и придумывать её нельзя.
 */
export interface Plan {
  id: "start" | "calc" | "premium";
  name: string;
  /** Одна строка о том, для чего пакет. */
  tagline: string;
  /** Рублей в месяц; null — по запросу. */
  priceRub: number | null;
  /** Вводная цена первого месяца, ₽; нет поля — первый месяц стоит как обычный. */
  firstMonthRub?: number;
  features: readonly string[];
}

export const PLANS: readonly Plan[] = [
  {
    id: "start",
    name: "Старт",
    tagline: "Находим подходящие закупки и объясняем, подходят ли они вам",
    priceRub: 9_000,
    features: [
      "Поиск закупок под вашу компанию",
      "Глубокий анализ документации",
      "Сверка требований с профилем компании",
      "Отчёт с выводами и рисками в Word",
    ],
  },
  {
    id: "calc",
    name: "Расчёт",
    tagline: "Всё из «Старта» и работа со сметой: считаем и проверяем",
    priceRub: 39_000,
    firstMonthRub: 9_000,
    features: [
      "Всё из пакета «Старт»",
      "Расчёт сметы по закупке",
      "Проверка сметы",
    ],
  },
  {
    id: "premium",
    name: "Премиум",
    tagline: "Полное сопровождение, включая защиту ваших интересов в УФАС",
    priceRub: null,
    features: [
      "Всё из пакета «Расчёт»",
      "Юридическое сопровождение",
      "Обжалование в УФАС — до 10 жалоб",
    ],
  },
];

export function planById(id: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

function formatRub(amount: number): string {
  return `${amount.toLocaleString("ru-RU").replace(/\s/g, " ")} ₽`;
}

/** «9 000 ₽» или «по запросу». Пробел — неразрывный, чтобы число не рвалось на строки. */
export function formatPlanPrice(plan: Plan): string {
  if (plan.priceRub === null) return "по запросу";
  return formatRub(plan.priceRub);
}

/** Вводная цена первого месяца («9 000 ₽») или null, если её у пакета нет. */
export function formatFirstMonthPrice(plan: Plan): string | null {
  if (plan.firstMonthRub === undefined || plan.priceRub === null) return null;
  return formatRub(plan.firstMonthRub);
}

/**
 * Письмо-заявка на счёт.
 *
 * Онлайн-приём платежей не подключён, поэтому оплата идёт по счёту: человек
 * нажимает кнопку, открывается письмо с готовой темой и составом, остаётся
 * дописать реквизиты своей компании.
 */
export function invoiceRequestHref(plan: Plan, accountEmail: string | null): string {
  const priced = plan.priceRub !== null;
  const subject = priced
    ? `Счёт на оплату — пакет «${plan.name}»`
    : `Условия пакета «${plan.name}»`;
  const firstMonth = formatFirstMonthPrice(plan);
  const request = !priced
    ? `Хочу обсудить условия пакета «${plan.name}».`
    : firstMonth
      ? `Прошу выставить счёт на оплату: пакет «${plan.name}», первый месяц — ${firstMonth} (далее ${formatPlanPrice(plan)} в месяц).`
      : `Прошу выставить счёт на оплату: пакет «${plan.name}», ${formatPlanPrice(plan)} в месяц.`;
  const body = [
    "Здравствуйте!",
    "",
    request,
    "",
    "Компания:",
    "ИНН:",
    "Контактное лицо и телефон:",
    accountEmail ? `Почта в сервисе: ${accountEmail}` : "",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  return `mailto:${OPERATOR.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
