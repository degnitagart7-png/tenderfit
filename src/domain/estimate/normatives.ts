import temporaryJson from "./normativesData/temporary.json";
import winterJson from "./normativesData/winter.json";
import equipmentDemolitionJson from "./normativesData/equipment-demolition.json";
import overheadMultipliersJson from "./normativesData/overhead-multipliers.json";
import workConditionsJson from "./normativesData/work-conditions.json";
import type {
  EquipmentDemolitionData,
  OverheadMultipliersData,
  TemporaryData,
  TemporaryNormRow,
  WinterData,
  WinterNormRow,
  WinterZonePart,
  WorkCondition,
  WorkConditionsData,
} from "@/domain/estimate/normativeTypes";

/**
 * Справочники нормативов, перенесённые из приказов Минстроя России (см. `normativeTypes.ts`).
 * Файлы собирает `scripts/fsnb/build-normatives.ts` из текстов в `data/fsnb/normatives/sources/`,
 * вручную их не правят. Рабочая копия лежит в `normativesData/` (каталог `data/` на сервер не
 * выкладывается); эталон — `data/fsnb/normatives/*.json`, их равенство проверяет тест.
 * Районы Крайнего Севера — в `north.ts`.
 */

export const WINTER: WinterData = winterJson as unknown as WinterData;
export const TEMPORARY: TemporaryData = temporaryJson as unknown as TemporaryData;
export const WORK_CONDITIONS: WorkConditionsData = workConditionsJson as unknown as WorkConditionsData;
export const EQUIPMENT_DEMOLITION: EquipmentDemolitionData = equipmentDemolitionJson as unknown as EquipmentDemolitionData;
export const OVERHEAD_MULTIPLIERS: OverheadMultipliersData = overheadMultipliersJson as unknown as OverheadMultipliersData;

const winterRows = new Map<string, WinterNormRow>(WINTER.rows.map((row) => [row.id, row]));
const temporaryRows = new Map<string, TemporaryNormRow>(TEMPORARY.rows.map((row) => [row.id, row]));
const conditions = new Map<string, WorkCondition>(WORK_CONDITIONS.conditions.map((condition) => [condition.id, condition]));
const zoneParts = new Map<string, WinterZonePart>(WINTER.zoneParts.map((part) => [part.id, part]));

export function winterRow(id: string): WinterNormRow | null {
  return winterRows.get(id) ?? null;
}

export function temporaryRow(id: string): TemporaryNormRow | null {
  return temporaryRows.get(id) ?? null;
}

export function workCondition(id: string): WorkCondition | null {
  return conditions.get(id) ?? null;
}

export function winterZonePart(id: string): WinterZonePart | null {
  return zoneParts.get(id) ?? null;
}

/** Часть числа с запятой: «6,77». */
export function formatDecimal(value: number, digits = 4): string {
  return String(Number(value.toFixed(digits))).replace(".", ",");
}
