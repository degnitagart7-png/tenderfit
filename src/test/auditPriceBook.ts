import type { EstimatePriceBook } from "@/domain/estimate/calculate";
import type { OverheadRate, ResourcePrice, SpecialistWage, WageAnchor } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";

/*
  Наша книга цен для тестов совпадает с ценами образцов A и B там, где проверяется
  «чистый» случай: тогда любое расхождение в отчёте появилось от того, что тест
  изменил сам. Значения — из реальных смет (разряд 2,3 → 611,05 и т. д.).
*/

export const SOURCE = "тест";
export const ANCHORS: WageAnchor[] = [
  { rank: 2.0, salary: 594.68, source: SOURCE },
  { rank: 2.2, salary: 605.59, source: SOURCE },
  { rank: 2.3, salary: 611.05, source: SOURCE },
  { rank: 4.0, salary: 651.98, source: SOURCE },
];
const SPECIALISTS: SpecialistWage[] = [{ code: "3-200-03", name: "Инженер III категории", salary: 856.33, source: SOURCE }];

export function machine(code: string, price: number, machinistSalary: number | null = null, unit = "маш.-ч"): ResourcePrice {
  return { code, name: code, unit, price, machinistSalary, machinistHours: null, source: "CURRENT_ZONE", period: "3 квартал 2026 г.", zone: "Республика Бурятия (1 зона)" };
}

function rate(ref: string, percent: number): OverheadRate {
  return { ref, percent, workType: "Тест", source: "Приказ" };
}

export interface BookPatch {
  anchors?: WageAnchor[];
  current?: ResourcePrice[];
  /** Федеральные цены ФСБЦ-2022 (базис). */
  base?: ResourcePrice[];
  rates?: Record<string, number>;
  machinists?: WageAnchor[];
  period?: string;
  zone?: string;
}

export function makeBook(patch: BookPatch = {}): EstimatePriceBook {
  const wageScale = buildWageScale(
    patch.anchors ?? ANCHORS,
    { region: "Республика Бурятия", zone: "Республика Бурятия (1 зона)", period: patch.period ?? "2 квартал 2026 г." },
    { specialists: SPECIALISTS, machinists: patch.machinists },
  );
  const current = patch.current ?? [
    machine("91.18.01-508", 167.37),
    machine("91.21.10-002", 3.44),
    machine("01.7.15.03-0042", 100, null, "кг"),
  ];
  const rates: Record<string, number> = patch.rates ?? {
    "Пр/812-090.0": 90,
    "Пр/774-090.0": 47,
    "Пр/812-091.0": 89,
    "Пр/774-091.0": 49,
    "Пр/812-083.0": 74,
    "Пр/774-083.0": 36,
  };
  return {
    region: "Республика Бурятия",
    priceZone: patch.zone ?? "Республика Бурятия (1 зона)",
    period: patch.period ?? "2 квартал 2026 г.",
    baseEdition: "тест",
    current: new Map(current.map((price) => [price.code, price])),
    base: new Map((patch.base ?? []).map((price) => [price.code, price])),
    wageScale,
    overheadRates: new Map(Object.entries(rates).map(([ref, percent]) => [ref, rate(ref, percent)])),
  };
}

