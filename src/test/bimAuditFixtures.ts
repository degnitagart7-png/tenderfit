import { bundledBimIndexBook } from "@/domain/estimate/bimIndices";
import type { BimAuditContext, FerLookup } from "@/domain/estimate/customerBimAudit";
import type { BimAmounts, BimCharge, BimPosition, CustomerBim } from "@/domain/estimate/customerBim";
import type { OverheadRate } from "@/domain/estimate/types";
import type { FerRate } from "@/lib/fsnb/ferXml";

/*
  Синтетическая смета БИМ одной позиции для аудита, цифры которой считаются в уме:
  расценка ФЕР 01-01-001-01 (100 м3), объём 2; ОЗП 1000, ЭМ 500 (в т. ч. ЗПМ 100), М 300 за единицу.
  В базисных ценах: ОЗП 2000, ЭМ 1000, ЗПМ 200, М 600; ФОТ = ОЗП + ЗПМ = 2200; НР 100 % = 2200, СП 50 % = 1100.
  Письмо Минстроя на III кв. 2026 для Белгородской области, «Многоквартирные жилые дома: Кирпичные», ФЕР: ОТ 47,58, ЭМ 15,15, М 9,58.
*/

export const amounts = (a: Partial<BimAmounts>): BimAmounts => ({ total: null, wage: null, machines: null, machinistWage: null, materials: null, ...a });
export const charge = (ref: string, percent: number, amount: number): BimCharge => ({ ref, percent, basePercent: percent, base: null, amount });

export const FER_RATE: FerRate = {
  code: "01-01-001-01",
  book: "ФЕР",
  table: "01-01-001",
  name: "Разработка грунта",
  endName: "",
  unit: "100 м3",
  collectionCode: "01",
  collectionName: "Земляные работы",
  cost: 1800,
  wage: 1000,
  machines: 500,
  machinistWage: 100,
  materials: 300,
  labourHours: null,
  machinistHours: null,
  overheadRef: "812/пр-001.1",
  profitRef: "774/пр-001.1",
  unaccounted: [],
  correction: null,
};

export const FER: FerLookup = {
  rate: (book, code) => (book === "ФЕР" && code === FER_RATE.code ? FER_RATE : null),
  material: () => null,
  transport: () => null,
};

export const OVERHEAD = new Map<string, OverheadRate>([
  ["Пр/812-001.1", { ref: "Пр/812-001.1", percent: 100, workType: "Земляные работы", source: "812/пр" }],
  ["Пр/774-001.1", { ref: "Пр/774-001.1", percent: 50, workType: "Земляные работы", source: "774/пр" }],
]);

export const CONTEXT: BimAuditContext = { fer: FER, indices: bundledBimIndexBook(), overheadRates: OVERHEAD, subject: null };

export interface IndexOptions {
  readonly labour: number;
  readonly machines: number;
  readonly materials: number;
}

/** Позиция потока текста: индексы применены, итоги посчитаны так же, как их печатает Гранд-Смета. */
export function position(options: { readonly index: IndexOptions; readonly code?: string; readonly baseWage?: number; readonly unitWage?: number }): BimPosition {
  const code = options.code ?? "ФЕР01-01-001-01";
  const family = code.startsWith("ТЕР") ? ("TER" as const) : ("FER" as const);
  const baseWage = options.baseWage ?? 2000;
  const { labour, machines, materials } = options.index;
  const current = (baseWage + 2200 + 1100) * labour + 1000 * machines + 600 * materials;
  return {
    number: "1",
    code,
    rawCode: code,
    family,
    book: family === "FER" ? "ФЕР" : null,
    rateCode: "01-01-001-01",
    name: "Разработка грунта",
    unit: "100 м3",
    quantity: 2,
    unitPrice: amounts({ total: 1800, wage: options.unitWage ?? 1000, machines: 500, machinistWage: 100, materials: 300 }),
    baseTotal: amounts({ wage: baseWage, machines: 1000, machinistWage: 200, materials: 600 }),
    coefficients: { wage: 1, machines: 1, machinistWage: 1, materials: 1, notes: [], hasUnparsed: false },
    positionCoefficient: 1,
    overhead: charge("Пр/812-001.1", 100, 2200),
    profit: charge("Пр/774-001.1", 50, 1100),
    indices: { labour, machines, machinistLabour: labour, materials },
    currentTotal: amounts({ wage: baseWage * labour, machines: 1000 * machines, materials: 600 * materials }),
    positionBaseTotal: baseWage + 1000 + 600 + 3300,
    positionCurrentTotal: current,
    priceFormula: null,
    section: null,
    gaps: [],
  };
}

export function estimate(overrides: Partial<CustomerBim> & { readonly positions: readonly BimPosition[] }): CustomerBim {
  const total = overrides.positions.reduce((sum, item) => sum + (item.positionCurrentTotal ?? 0), 0);
  return {
    documentName: "smeta.pdf",
    estimateName: "Локальная смета 01-01-01",
    format: "STREAM",
    number: "01-01-01",
    priceLevel: "CURRENT",
    quarter: { quarter: 3, year: 2026 },
    quarterSource: "ESTIMATE",
    subjectText: "Белгородская область",
    zone: null,
    constructionName: "Строительство кирпичного многоквартирного дома по ул. Садовой",
    workName: "Земляные работы",
    declaredBaseIndex: true,
    overheadNorms: "812_774",
    indexStatements: [],
    directBase: null,
    directWithTotalCoefficients: null,
    overheadTotal: null,
    profitTotal: null,
    total,
    totalBase: null,
    smrTotal: total,
    smrTotalBase: null,
    equipmentTotal: null,
    vatPercent: null,
    positionsTotal: total,
    ...overrides,
  };
}

export const BELGOROD: IndexOptions = { labour: 47.58, machines: 15.15, materials: 9.58 };

