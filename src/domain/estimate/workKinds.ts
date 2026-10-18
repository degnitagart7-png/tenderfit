import { temporaryRow, winterRow } from "@/domain/estimate/normatives";

/**
 * Виды работ, по которым выбираются нормативы зимнего удорожания (приказ 325/пр) и временных зданий
 * (приказ 332/пр).
 *
 * Классификаторы двух приказов разные (в 325/пр — по видам объектов и конструкций, в 332/пр — по
 * видам объектов и капремонта), поэтому соответствие записано явно, строка к строке, и проверяется
 * тестом: каждая ссылка должна указывать на строку справочника. Выбор вида — решение пользователя:
 * по тексту закупки подсказывается, но не ставится.
 *
 * Соответствие по Методикам:
 * - снос — 325/пр п. 23(1) (приложение 1, п. 88 или 89); 332/пр п. 29: норматива в процентах нет;
 * - капремонт жилых, социально-культурных, коммунально-бытовых объектов и инфраструктуры —
 *   325/пр п. 21 (приложение 2); 332/пр п. 24 (приложение 2);
 * - реконструкция — 325/пр п. 23 (приложение 2, п. 1 или 2); 332/пр п. 25 (приложение 1 с коэффициентом 0,8);
 * - новое строительство — 325/пр п. 18 (приложение 1); 332/пр п. 23 (приложение 1).
 */

export type EstimatePhase = "CONSTRUCTION" | "RECONSTRUCTION" | "CAPITAL_REPAIR" | "DEMOLITION";

export const PHASE_LABELS: Readonly<Record<EstimatePhase, string>> = {
  CAPITAL_REPAIR: "Капитальный ремонт",
  RECONSTRUCTION: "Реконструкция",
  CONSTRUCTION: "Новое строительство",
  DEMOLITION: "Снос",
};

export interface WorkKind {
  readonly id: string;
  readonly phase: EstimatePhase;
  readonly label: string;
  /** Строка НДЗ зимнего удорожания (`winter.json`). */
  readonly winterRow: string;
  /** Множитель к НДЗ (325/пр п. 20: 0,8 для капремонта линейных и производственных объектов). */
  readonly winterMultiplier: number;
  /** Норматив временных зданий (`temporary.json`); null — норматива в процентах нет. */
  readonly temporary: { readonly row: string; readonly multiplier: number } | null;
  /** Почему норматива временных зданий нет. */
  readonly temporaryNote: string | null;
  /** Выражения (флаги iu) для подсказки по тексту закупки. */
  readonly hints: readonly string[];
}

const NO_TEMP_DEMOLITION =
  "Для сноса норматива временных зданий в процентах нет: затраты определяются только расчётом по проекту организации работ по сносу (332/пр, п. 29)";

function kind(
  id: string,
  phase: EstimatePhase,
  label: string,
  winter: string,
  temporary: { row: string; multiplier?: number } | null,
  hints: readonly string[] = [],
  temporaryNote: string | null = null,
): WorkKind {
  return {
    id,
    phase,
    label,
    winterRow: winter,
    winterMultiplier: 1,
    temporary: temporary === null ? null : { row: temporary.row, multiplier: temporary.multiplier ?? 1 },
    temporaryNote,
    hints,
  };
}

export const WORK_KINDS: readonly WorkKind[] = [
  /* ---- снос ---- */
  kind("DEM_DISMANTLE", "DEMOLITION", "Снос здания путём разборки и (или) демонтажа", "A1-88", null, ["снос", "демонтаж\\s+объект", "разборк[аи]\\s+здани"], NO_TEMP_DEMOLITION),
  kind("DEM_DESTROY", "DEMOLITION", "Снос здания путём разрушения", "A1-89", null, ["разрушени[ея]\\s+(?:здани|объект)"], NO_TEMP_DEMOLITION),

  /* ---- капитальный ремонт: здание в целом ---- */
  kind("CR_RES_BRICK", "CAPITAL_REPAIR", "Жилое здание в целом, стены из кирпича", "A2-1.1", { row: "A2-1.1" }, ["капитальн[а-я]+\\s+ремонт[а-я]*\\s+(?:многоквартирн|жил)"]),
  kind("CR_RES_PANEL", "CAPITAL_REPAIR", "Жилое здание в целом, крупнопанельное или объёмно-блочное", "A2-1.2", { row: "A2-1.1" }),
  kind("CR_RES_WOOD", "CAPITAL_REPAIR", "Жилое здание в целом, деревянное или смешанного типа", "A2-1.3", { row: "A2-1.1" }),
  kind("CR_RES_MONO", "CAPITAL_REPAIR", "Жилое здание в целом, монолитное", "A2-1.4", { row: "A2-1.1" }),
  kind("CR_PUBLIC", "CAPITAL_REPAIR", "Общественное, социально-культурное здание в целом", "A2-2.1", { row: "A2-1.2" }, ["капитальн[а-я]+\\s+ремонт[а-я]*\\s+(?:школ|детск|больниц|поликлиник|здани[ея]\\s+(?:администрац|дом[а]?\\s+культур))"]),
  kind("CR_COMMUNAL", "CAPITAL_REPAIR", "Коммунально-бытовое здание или объект коммунальной инфраструктуры в целом", "A2-2.1", { row: "A2-1.3" }),
  kind("CR_PROD_HOUSING", "CAPITAL_REPAIR", "Производственный объект, обслуживающий жилищно-коммунальное хозяйство", "A2-2.2", { row: "A2-1.3" }),

  /* ---- капитальный ремонт: отдельные конструкции и сети ---- */
  kind("CR_ROOF_PIECE", "CAPITAL_REPAIR", "Кровля из штучных материалов", "A2-3.1", { row: "A2-2.2" }, ["ремонт[а-я]*\\s+кровл", "капитальн[а-я]+\\s+ремонт[а-я]*\\s+крыш"]),
  kind("CR_ROOF_ROLL", "CAPITAL_REPAIR", "Кровля из рулонных материалов", "A2-3.2", { row: "A2-2.2" }),
  kind("CR_FACADE", "CAPITAL_REPAIR", "Фасады", "A2-3.3", { row: "A2-2.1" }, ["ремонт[а-я]*\\s+фасад"]),
  kind("CR_PLUMBING", "CAPITAL_REPAIR", "Внутренние санитарно-технические устройства", "A2-3.4", { row: "A2-2.4" }),
  kind("CR_ELECTRIC", "CAPITAL_REPAIR", "Внутренние электромонтажные работы и слаботочные системы", "A2-3.5", { row: "A2-2.4" }),
  kind("CR_FINISH", "CAPITAL_REPAIR", "Отделка внутренних помещений", "A2-3.6", { row: "A2-2.3" }),
  kind("CR_NET_GAS", "CAPITAL_REPAIR", "Сети газоснабжения", "A2-4.1", { row: "A2-3.1" }),
  kind("CR_NET_WATER", "CAPITAL_REPAIR", "Сети водоснабжения и водоотведения", "A2-4.2", { row: "A2-3.1" }),
  kind("CR_NET_HEAT", "CAPITAL_REPAIR", "Сети теплоснабжения", "A2-4.3", { row: "A2-3.1" }),
  kind("CR_ROAD_ASPHALT", "CAPITAL_REPAIR", "Дороги с асфальтовым покрытием (благоустройство)", "A2-5.1", { row: "A2-4.1" }),
  kind("CR_ROAD_GRAVEL", "CAPITAL_REPAIR", "Дороги с щебёночным и гравийным покрытием (благоустройство)", "A2-5.2", { row: "A2-4.1" }),
  kind("CR_EMBANKMENT", "CAPITAL_REPAIR", "Набережные и подпорные стенки", "A2-5.3", { row: "A2-4.3" }),
  kind("CR_GREENING", "CAPITAL_REPAIR", "Озеленение", "A2-5.4", { row: "A2-4.2" }),

  /* ---- реконструкция: 332/пр п. 25 — приложение 1 с коэффициентом 0,8 ---- */
  kind("RC_RES_BRICK", "RECONSTRUCTION", "Жилое здание, стены из кирпича (городское поселение)", "A2-1.1", { row: "A1-48.1", multiplier: 0.8 }),
  kind("RC_RES_PANEL", "RECONSTRUCTION", "Жилое здание, крупнопанельное или объёмно-блочное (городское поселение)", "A2-1.2", { row: "A1-48.1", multiplier: 0.8 }),
  kind("RC_RES_WOOD", "RECONSTRUCTION", "Жилое здание, деревянное или смешанного типа (городское поселение)", "A2-1.3", { row: "A1-48.1", multiplier: 0.8 }),
  kind("RC_RES_MONO", "RECONSTRUCTION", "Жилое здание, монолитное (городское поселение)", "A2-1.4", { row: "A1-48.1", multiplier: 0.8 }),
  kind("RC_PUBLIC", "RECONSTRUCTION", "Общественное, социально-культурное здание (школа, детский сад, административное)", "A2-2.1", { row: "A1-50", multiplier: 0.8 }),

  /* ---- новое строительство ---- */
  kind("NC_RES_PANEL", "CONSTRUCTION", "Жилое здание крупнопанельное или объёмно-блочное (городское поселение)", "A1-81", { row: "A1-48.1" }),
  kind("NC_RES_BRICK", "CONSTRUCTION", "Жилое здание кирпичное или из блоков (городское поселение)", "A1-82", { row: "A1-48.1" }),
  kind("NC_RES_WOOD", "CONSTRUCTION", "Жилое здание деревянное (городское поселение)", "A1-83", { row: "A1-48.1" }),
  kind("NC_RES_MONO", "CONSTRUCTION", "Жилое здание монолитное (городское поселение)", "A1-84", { row: "A1-48.1" }),
  kind("NC_PUBLIC", "CONSTRUCTION", "Общественное, социально-культурное здание (школа, детский сад, административное)", "A1-85", { row: "A1-50" }),
  kind("NC_NET_WATER_GAS", "CONSTRUCTION", "Сети водоснабжения и газопроводы в мягких грунтах в черте города", "A1-76", { row: "A1-41" }),
  kind("NC_NET_SEWER", "CONSTRUCTION", "Сети канализации в мягких грунтах в черте города", "A1-77", { row: "A1-41" }),
  kind("NC_NET_HEAT", "CONSTRUCTION", "Сети теплоснабжения в черте города", "A1-79", { row: "A1-41" }),
  kind("NC_POWER_LINE", "CONSTRUCTION", "Воздушные линии электропередачи 0,4-35 кВ", "A1-50", { row: "A1-39.2" }),
];

const byId = new Map(WORK_KINDS.map((item) => [item.id, item]));

export function workKindById(id: string | null | undefined): WorkKind | null {
  return id === null || id === undefined ? null : (byId.get(id) ?? null);
}

export function workKindsOfPhase(phase: EstimatePhase): readonly WorkKind[] {
  return WORK_KINDS.filter((item) => item.phase === phase);
}

/** Ссылки каталога на строки справочников; пустой список — всё на месте (для теста). */
export function brokenKindReferences(): string[] {
  const broken: string[] = [];
  for (const item of WORK_KINDS) {
    if (winterRow(item.winterRow) === null) broken.push(`${item.id}: нет строки зимнего ${item.winterRow}`);
    if (item.temporary !== null && temporaryRow(item.temporary.row) === null) {
      broken.push(`${item.id}: нет строки временных зданий ${item.temporary.row}`);
    }
  }
  return broken;
}

/* ------------------------- подсказки по тексту закупки ------------------------- */

export interface PhaseHint {
  readonly phase: EstimatePhase;
  /** Что сказано в тексте. */
  readonly quote: string;
}

const PHASE_PATTERNS: readonly { readonly phase: EstimatePhase; readonly pattern: RegExp }[] = [
  { phase: "DEMOLITION", pattern: /(?:снос|демонтаж)(?:\s*\((?:демонтаж|разборка)\))?\s+(?:объект|здани|дом|строени)[а-я]*/iu },
  { phase: "RECONSTRUCTION", pattern: /реконструкци[яию]\s+[а-я]+/iu },
  { phase: "CAPITAL_REPAIR", pattern: /капитальн[а-я]+\s+ремонт[а-я]*/iu },
  { phase: "CONSTRUCTION", pattern: /строительств[оа]\s+[а-я]+/iu },
];

/** Вид работ по названию закупки или тексту ТЗ: подсказка, которую человек подтверждает сам. */
export function detectPhaseHint(text: string): PhaseHint | null {
  for (const { phase, pattern } of PHASE_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return { phase, quote: match[0] };
  }
  return null;
}

/** Подходящий вид работ по тексту: первый, чей шаблон совпал в пределах уже выбранного вида. */
export function detectKindHint(phase: EstimatePhase, text: string): { kind: WorkKind; quote: string } | null {
  for (const candidate of workKindsOfPhase(phase)) {
    for (const hint of candidate.hints) {
      const match = new RegExp(hint, "iu").exec(text);
      if (match !== null) return { kind: candidate, quote: match[0] };
    }
  }
  return null;
}
