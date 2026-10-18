import type { NormRecord, NormResource, ResourcePrice } from "@/domain/estimate/types";
import type { BillOfWorkItem } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import { AMUR_WAGE_ANCHORS, AMUR_ZONE, NORM_MANUAL_GRADING, makePriceBook } from "@/test/estimateFixtures";

/**
 * Синтетические данные к случаю кровли — закупка 0391300028226000005, слепой бенчмарк: позиция ГЭСН12-01-007-12 «Устройство кровель из листов волнистых битумных»
 * вышла 675 223 ₽ против 158 952 ₽ у заказчика, а ГЭСН12-01-033-02 «Монтаж кровли из профилированного листа» — 275 003 ₽ против 698 074 ₽: дорогое покрытие
 * (профилированный стальной лист) оказалось не на своей позиции. Наименования и коды сочинены под тест; важна структура: у каждой нормы ресурс «по проекту» с кодом
 * группы, в справочнике у групп свои записи (битумные листы, профилированные стальные листы), рядом чужая группа (асбестоцемент) и запись-выброс по цене.
 */

const labour: NormResource = {
  code: "1-100-30",
  kind: "LABOUR",
  name: "Средний разряд работы 3,0",
  quantity: 120,
  unit: "чел.-ч",
  quantityNote: null,
  projectSpecific: false,
  technologyGroup: null,
};

const openResource = (code: string, name: string, quantity: number): NormResource => ({
  code,
  kind: "MATERIAL",
  name,
  quantity,
  unit: "м2",
  quantityNote: null,
  projectSpecific: true,
  technologyGroup: code,
});

/** Листы волнистые битумные: 105 м2 на 100 м2 кровли. */
export const BITUMEN_RESOURCE: NormResource = openResource("12.1.02.06", "Листы волнистые битумные", 105);
/** Профилированный лист: 112 м2 на 100 м2 кровли. */
export const PROFILED_RESOURCE: NormResource = openResource("12.1.02.03", "Профилированный лист", 112);

const norm = (code: string, tableCode: string, fullName: string, resource: NormResource): NormRecord => ({
  ...NORM_MANUAL_GRADING,
  code,
  tableCode,
  fullName,
  endName: fullName,
  unit: "100 м2",
  baseType: "ГЭСН",
  collectionCode: "12",
  collectionName: "Кровли",
  resources: [labour, resource],
});

export const BITUMEN_NORM: NormRecord = norm("12-01-007-12", "12-01-007", "Устройство кровель из листов волнистых битумных", BITUMEN_RESOURCE);
export const PROFILED_NORM: NormRecord = norm("12-01-033-02", "12-01-033", "Монтаж кровли из профилированного листа", PROFILED_RESOURCE);

/** Коды справочника: свои группы и чужое. */
export const ROOF = {
  bitumenOndulin: "12.1.02.06-0001",
  bitumenPlain: "12.1.02.06-0002",
  bitumenPainted: "12.1.02.06-0003",
  bitumenPremium: "12.1.02.06-0099",
  steelLight: "12.1.02.03-0001",
  steelHeavy: "12.1.02.03-0002",
  asbestos: "12.1.01.01-0001",
  bolts: "01.7.15.03-0042",
} as const;

const price = (code: string, name: string, unit: string, value: number): ResourcePrice => ({
  code,
  name,
  unit,
  price: value,
  machinistSalary: null,
  machinistHours: null,
  source: "CURRENT_ZONE",
  period: "3 квартал 2026 г.",
  zone: "Амурская область (1 зона)",
});

export const ROOF_PRICES = {
  bitumenOndulin: 520,
  bitumenPlain: 460,
  bitumenPainted: 610,
  bitumenPremium: 9000,
  steelLight: 780,
  steelHeavy: 1100,
} as const;

/** Справочник цен кровли. `premium` — запись-выброс в группе битумных листов (в ~15 раз дороже соседей). */
export function roofResources(options: { readonly premium?: boolean } = {}): readonly ResourcePrice[] {
  return [
    price(ROOF.bitumenOndulin, "Лист волнистый битумный ондулин Смарт 1950х960 мм", "м2", ROOF_PRICES.bitumenOndulin),
    price(ROOF.bitumenPlain, "Листы волнистые битумные кровельные толщиной 3 мм", "м2", ROOF_PRICES.bitumenPlain),
    price(ROOF.bitumenPainted, "Лист волнистый битумный окрашенный", "м2", ROOF_PRICES.bitumenPainted),
    ...(options.premium === true ? [price(ROOF.bitumenPremium, "Лист волнистый битумный дизайнерский премиум", "м2", ROOF_PRICES.bitumenPremium)] : []),
    price(ROOF.steelLight, "Профилированный лист оцинкованный С8-1150-0,5", "м2", ROOF_PRICES.steelLight),
    price(ROOF.steelHeavy, "Профилированный лист оцинкованный НС35-1000-0,7 с полимерным покрытием", "м2", ROOF_PRICES.steelHeavy),
    price(ROOF.asbestos, "Листы асбестоцементные волнистые", "м2", 380),
    price(ROOF.bolts, "Болты стальные строительные с гайками", "кг", 96.5),
  ];
}

export function roofBook(resources: readonly ResourcePrice[] = roofResources()) {
  return {
    current: new Map(resources.map((resource) => [resource.code, resource])),
    base: new Map<string, ResourcePrice>(),
  };
}

export function roofPriceBook(resources: readonly ResourcePrice[] = roofResources()) {
  const book = roofBook(resources);
  return makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE), { current: book.current, base: book.base });
}

/** Позиции ведомости: 480 м2 битумных листов и 900 м2 профилированного. */
const item = (id: string, workName: string, quantity: number, normCode: string, positionNumber: string): BillOfWorkItem => ({
  id,
  workName,
  quantity,
  quantityUnit: "м2",
  unitDivisor: 100,
  normCode,
  normBaseType: "ГЭСН",
  resourceCode: null,
  sourceQuote: null,
  sourceDocument: null,
  positionNumber,
});

export const bitumenItem = (extra: Partial<BillOfWorkItem> = {}): BillOfWorkItem => ({
  ...item("bitumen", "Устройство кровель из листов волнистых битумных (ондулин)", 480, BITUMEN_NORM.code, "3"),
  ...extra,
});

export const profiledItem = (extra: Partial<BillOfWorkItem> = {}): BillOfWorkItem => ({
  ...item("profiled", "Монтаж кровли из профилированного листа", 900, PROFILED_NORM.code, "4"),
  ...extra,
});
