/**
 * Профиль затрат компании: чем её настоящая себестоимость отличается от сметной.
 *
 * Зачем. Смета по ФСНБ-2022 считает затраты «как по нормам»: труд по тарифной шкале, машины и материалы
 * по текущим сметным ценам, накладные — по приказу 812/пр. У конкретного подрядчика всё иначе: у поставщика
 * есть скидка, свои рабочие получают меньше (или больше) шкалы, накладных реально уходит не сто процентов.
 * Без этих поправок «безубыточная цена» — цена среднего подрядчика, а не ваша. Профиль даёт поправки
 * по группам затрат сметы и применяется в `computeBidEconomics`.
 *
 * Границы. Поправки действуют только на группы, которые в смете есть: труд рабочих (ОТ), машины и механизмы
 * (ЭМ, вместе с оплатой машинистов), материалы (М), накладные расходы (НР). Позиции по ценам заказчика, услуги
 * и «свои цены» не делятся на группы — для них поправок нет (они остаются «прочими»). Сметная прибыль (СП) —
 * не затраты, а часть цены, поправкам не подлежит. Страховые взносы и налоги профиль не трогает: налоги
 * считаются по системе налогообложения компании.
 *
 * Значения по умолчанию нейтральны: смета считается ровно так же, как до появления профиля.
 *
 * Модуль чистый: ни сети, ни хранилища.
 */

export interface CompanyCostProfile {
  /** Какая доля нормативных накладных расходов (НР) реально тратится, %. 100 — вся. */
  readonly overheadRealizationPercent: number;
  /** Скидка на материалы к сметным ценам, %. Отрицательная — материалы дороже сметных. */
  readonly materialDiscountPercent: number;
  /** Своя стоимость труда рабочих к сметной (по тарифной шкале), %. 100 — как в смете. */
  readonly labourFactorPercent: number;
  /** Своя стоимость машин и механизмов к сметной, %. 100 — как в смете; своя техника обычно дешевле аренды. */
  readonly machinesFactorPercent: number;
  /** Доля прямых затрат (труд, машины, материалы), которую выполняет субподряд, %. 0 — всё своими силами. */
  readonly subcontractSharePercent: number;
  /** Во сколько обходится субподряд, % от прямых затрат этой доли по смете. Значим, только когда доля больше нуля. */
  readonly subcontractPricePercent: number;
}

export type CostProfileField = keyof CompanyCostProfile;

export interface CostProfileFieldSpec {
  readonly key: CostProfileField;
  readonly label: string;
  /** Одна строка простым языком: что это и как выбрать значение. */
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
}

export const COST_PROFILE_FIELDS: readonly CostProfileFieldSpec[] = [
  {
    key: "overheadRealizationPercent",
    label: "Накладные расходы: сколько тратится от сметных",
    hint: "Сметные накладные (офис, управление, охрана труда) — норматив; если у вас они реально ниже, укажите долю, например 70 %.",
    min: 0,
    max: 150,
    step: 5,
    default: 100,
  },
  {
    key: "materialDiscountPercent",
    label: "Скидка на материалы к сметным ценам",
    hint: "Насколько вы закупаете дешевле сметных цен Минстроя (скидки поставщиков); если дороже — впишите минус.",
    min: -20,
    max: 50,
    step: 1,
    default: 0,
  },
  {
    key: "labourFactorPercent",
    label: "Ваш труд к сметному",
    hint: "Сколько стоит труд ваших рабочих в процентах от тарифной шкалы сметы: 100 — как в смете, 80 — на пятую часть дешевле.",
    min: 30,
    max: 250,
    step: 5,
    default: 100,
  },
  {
    key: "machinesFactorPercent",
    label: "Ваши машины к сметным",
    hint: "Стоимость машин и механизмов от сметной: своя техника обычно дешевле аренды, тогда впишите меньше 100.",
    min: 30,
    max: 250,
    step: 5,
    default: 100,
  },
  {
    key: "subcontractSharePercent",
    label: "Доля работ субподрядчикам",
    hint: "Какую часть прямых затрат (труд, машины, материалы) вы отдаёте субподрядчикам; 0 — всё делаете сами.",
    min: 0,
    max: 100,
    step: 5,
    default: 0,
  },
  {
    key: "subcontractPricePercent",
    label: "Цена субподряда к сметным прямым затратам",
    hint: "Во сколько обходится субподряд от прямых затрат по смете: с накладными и прибылью субподрядчика обычно 120–140 %.",
    min: 50,
    max: 250,
    step: 5,
    default: 130,
  },
];

const SPEC_BY_KEY: Readonly<Record<CostProfileField, CostProfileFieldSpec>> = Object.fromEntries(
  COST_PROFILE_FIELDS.map((spec) => [spec.key, spec]),
) as Record<CostProfileField, CostProfileFieldSpec>;

export const DEFAULT_COST_PROFILE: CompanyCostProfile = {
  overheadRealizationPercent: 100,
  materialDiscountPercent: 0,
  labourFactorPercent: 100,
  machinesFactorPercent: 100,
  subcontractSharePercent: 0,
  subcontractPricePercent: 130,
};

export function costFieldSpec(key: CostProfileField): CostProfileFieldSpec {
  return SPEC_BY_KEY[key];
}

/** Значение поля в допустимых границах; не число — значение по умолчанию. */
export function clampCostField(key: CostProfileField, value: unknown): number {
  const spec = SPEC_BY_KEY[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, Math.round(value * 100) / 100));
}

/**
 * Профиль из того, что лежит в хранилище: любая версия схемы, любые значения.
 * Недостающее и негодное заменяется нейтральным значением, выход за границы — ближайшей границей.
 */
export function normalizeCostProfile(raw: unknown): CompanyCostProfile {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    overheadRealizationPercent: clampCostField("overheadRealizationPercent", source["overheadRealizationPercent"]),
    materialDiscountPercent: clampCostField("materialDiscountPercent", source["materialDiscountPercent"]),
    labourFactorPercent: clampCostField("labourFactorPercent", source["labourFactorPercent"]),
    machinesFactorPercent: clampCostField("machinesFactorPercent", source["machinesFactorPercent"]),
    subcontractSharePercent: clampCostField("subcontractSharePercent", source["subcontractSharePercent"]),
    subcontractPricePercent: clampCostField("subcontractPricePercent", source["subcontractPricePercent"]),
  };
}

/** Ошибки полей: пустой объект — всё в границах. Для подсказки рядом с полем; расчёт использует `normalizeCostProfile`. */
export function validateCostProfile(profile: Readonly<Record<CostProfileField, number>>): Partial<Record<CostProfileField, string>> {
  const errors: Partial<Record<CostProfileField, string>> = {};
  for (const spec of COST_PROFILE_FIELDS) {
    const value = profile[spec.key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors[spec.key] = "Введите число";
    } else if (value < spec.min || value > spec.max) {
      errors[spec.key] = `От ${String(spec.min)} до ${String(spec.max)} %`;
    }
  }
  return errors;
}

/** Профиль совпадает с нейтральным: поправок нет, расчёт — как по смете. */
export function isDefaultCostProfile(profile: CompanyCostProfile): boolean {
  return COST_PROFILE_FIELDS.every((spec) => {
    // Цена субподряда без доли субподряда ни на что не влияет.
    if (spec.key === "subcontractPricePercent" && profile.subcontractSharePercent === 0) return true;
    return profile[spec.key] === spec.default;
  });
}

/**
 * Минимальная маржа по умолчанию, % от выручки без НДС. Профиль компании хранит «не задана» нулём (`restrictions.minMarginPercent`),
 * а «минимальная цена» при нулевой марже совпадает с безубыточной и ничего не говорит о выгоде. Пока человек свою маржу не указал,
 * расчёт берёт десять процентов и говорит об этом словами.
 */
export const DEFAULT_MIN_MARGIN_PERCENT = 10;

/** Маржа для расчёта: заданная в профиле или значение по умолчанию. */
export function effectiveMinMargin(profileValue: number): number {
  return Number.isFinite(profileValue) && profileValue > 0 ? profileValue : DEFAULT_MIN_MARGIN_PERCENT;
}
