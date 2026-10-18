import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { BillOfWorkItem, NormRecord, NormResource, ResourcePrice } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import { AMUR_WAGE_ANCHORS, AMUR_ZONE, NORM_MANUAL_GRADING, makePriceBook } from "@/test/estimateFixtures";

/**
 * Синтетические данные к материалу нормы «по проекту» — случай закупки 32616409061: изоляция кровли напыляемым пенополиуретаном (ГЭСН26-01-021-01).
 * Заказчик оценил основной материал позиции — «ФСБЦ-14.2.05.03-0020 Состав двухкомпонентный на основе полиуретановых смол» 300,3 кг, 533 702 ₽, — а норма
 * называет его общим ресурсом без марки. Состав нормы и наименования ресурсов сочинены под тест и в базе могут называться иначе; важна структура: у настоящего
 * материала группа кода, слова и единица нормы, у двойников — одно отличие (другая смола, единица, группа).
 */

const labour: NormResource = {
  code: "1-100-30",
  kind: "LABOUR",
  name: "Средний разряд работы 3,0",
  quantity: 12.3,
  unit: "чел.-ч",
  quantityNote: null,
  projectSpecific: false,
  technologyGroup: null,
};

/** Ресурс без марки с расходом числом: 1,65 кг на м2, то есть 165 кг на единицу нормы «100 м2». */
export const PPU_RESOURCE: NormResource = {
  code: "14.2.05.03",
  kind: "MATERIAL",
  name: "Состав двухкомпонентный на основе полиуретановых смол",
  quantity: 165,
  unit: "кг",
  quantityNote: null,
  projectSpecific: true,
  technologyGroup: "14.2.05.03",
};

/** Расход «по проекту» без числа: число не названо нормой — цену не из чего считать. */
export const BY_PROJECT_RESOURCE: NormResource = {
  code: "14.4.02.09",
  kind: "MATERIAL",
  name: "Краска для защиты пенополиуретана",
  quantity: 0,
  unit: "кг",
  quantityNote: "П",
  projectSpecific: true,
  technologyGroup: "14.4.02.09",
};

/** Служебный ресурс «МАТЕРИАЛЫ (см. приложение)»: расход «П», единицы нет. */
export const SERVICE_RESOURCE: NormResource = {
  code: "999-9901",
  kind: "MATERIAL",
  name: "МАТЕРИАЛЫ (см. приложение)",
  quantity: 0,
  unit: "руб.",
  quantityNote: "П",
  projectSpecific: true,
  technologyGroup: null,
};

export const PPU_NORM: NormRecord = {
  ...NORM_MANUAL_GRADING,
  code: "26-01-021-01",
  tableCode: "26-01-021",
  fullName: "Изоляция плоских и криволинейных поверхностей из пенополиуретана: напылением слоем толщиной 50 мм",
  endName: "напылением слоем толщиной 50 мм",
  unit: "100 м2",
  baseType: "ГЭСН",
  collectionCode: "26",
  collectionName: "Теплоизоляционные работы",
  resources: [labour, PPU_RESOURCE, BY_PROJECT_RESOURCE, SERVICE_RESOURCE],
};

/** Коды ресурсов справочника: настоящий материал и двойники. */
export const PPU = {
  truth: "14.2.05.03-0020",
  epoxy: "14.2.05.03-0021",
  perTonne: "14.2.05.03-0030",
  panel: "14.2.05.01-0007",
  bolts: "01.7.15.03-0042",
  paint: "14.4.02.09-0001",
} as const;

const price = (code: string, name: string, unit: string, value: number, current = true): ResourcePrice => ({
  code,
  name,
  unit,
  price: value,
  machinistSalary: null,
  machinistHours: null,
  source: current ? "CURRENT_ZONE" : "BASE_2022",
  period: current ? "3 квартал 2026 г." : null,
  zone: current ? "Амурская область (1 зона)" : null,
});

export const PPU_TRUTH_PRICE = 1777.2;

/** Справочник цен. Двойник «за тонну» в одной группе и единица переводится (кг ↔ т); панель — другая единица (м2), в кандидаты не входит. */
export function ppuResources(options: { readonly perTonne?: boolean } = {}): readonly ResourcePrice[] {
  return [
    price(PPU.truth, "Состав двухкомпонентный на основе полиуретановых смол для напыляемой теплоизоляции", "кг", PPU_TRUTH_PRICE),
    price(PPU.epoxy, "Состав двухкомпонентный на основе эпоксидных смол для защитных покрытий", "кг", 612.4),
    ...(options.perTonne === false ? [] : [price(PPU.perTonne, "Состав двухкомпонентный на основе полиуретановых смол для напыляемой теплоизоляции, цена за тонну", "т", 1_650_000, false)]),
    price(PPU.panel, "Панели из пенополиуретана для кровли на основе полиуретановых смол", "м2", 2480),
    price(PPU.bolts, "Болты стальные строительные с гайками", "кг", 96.5),
    price(PPU.paint, "Краска защитная для пенополиуретановых покрытий", "кг", 420),
  ];
}

export function ppuBook(resources: readonly ResourcePrice[] = ppuResources()) {
  return {
    current: new Map(resources.filter((resource) => resource.source === "CURRENT_ZONE").map((resource) => [resource.code, resource])),
    base: new Map(resources.filter((resource) => resource.source === "BASE_2022").map((resource) => [resource.code, resource])),
  };
}

export function ppuPriceBook(resources: readonly ResourcePrice[] = ppuResources()) {
  const book = ppuBook(resources);
  return makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE), { current: book.current, base: book.base });
}

export function ppuBase(resources: readonly ResourcePrice[] = ppuResources()): EstimateBase {
  const norms = [PPU_NORM];
  const book = ppuBook(resources);
  return {
    info: {
      indexDir: "data/fsnb/index",
      builtAt: "2026-10-11T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: AMUR_ZONE.region,
      priceZone: AMUR_ZONE.zone,
      period: AMUR_ZONE.period,
      decree: "Приказ Минстроя России от 30.12.2021 № 1046/пр",
      counts: { norms: norms.length, basePrices: book.base.size, currentPrices: book.current.size, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: ppuPriceBook(resources),
    searchIndex: createNormSearchIndex(norms),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

/** Позиция: 182 м2 напыления при норме на 100 м2 — 1,82 единицы нормы, 300,3 кг материала. */
export function roofItem(extra: Partial<BillOfWorkItem> = {}): BillOfWorkItem {
  return {
    id: "roof",
    workName: "Изоляция кровли напыляемым пенополиуретаном толщиной 50 мм",
    quantity: 182,
    quantityUnit: "м2",
    unitDivisor: 100,
    normCode: PPU_NORM.code,
    normBaseType: "ГЭСН",
    resourceCode: null,
    sourceQuote: null,
    sourceDocument: null,
    positionNumber: "3",
    ...extra,
  };
}
