import { OVERHEAD_MULTIPLIERS } from "@/domain/estimate/normatives";
import type { CustomerConditions, LineCoefficients, LineRateMultipliers } from "@/domain/estimate/types";

/**
 * Множители заказчика к нормативам НР и СП на одной строке расчёта.
 *
 * Заказчик, считая капитальный ремонт по ГЭСН с коэффициентами п. 58 Методики 421/пр, умножает норматив накладных
 * расходов на 0,9 (812/пр п. 25), а сметной прибыли — на 0,85 (774/пр п. 16). Без этого наши НР и СП по той же
 * позиции выше его на десятые доли (ЛСР 02-02-12 закупки 0302300048726001118: +5,9 % к итогу). Сверку множителя
 * с приказами делает `customerCoefficients.ts` при чтении сметы; здесь — применение к нашей строке.
 *
 * Правила.
 * - Множитель применяется к нашему нормативу, найденному по указателю нормы, а не к проценту заказчика: если
 *   нормативы разошлись (заказчик взял 89 %, у нас другой), норматив не подменяется молча — разницу показывает
 *   аудит (OVERHEAD_RATE), а множитель стоит на нашем проценте.
 * - Только вместе с п. 58: п. 25 и п. 16 написаны для ГЭСН, к которым п. 58 применяется. Если у нашей строки п. 58
 *   не применён (человек выбрал другой вид работ, отключил применение, книга не ГЭСН), множитель пропущен и назван.
 * - П. 26 (капремонт сетей, дорог, инженерных сооружений) множитель отменяет: проверяется по сборнику нормы.
 * - Отключается тем же переключателем и той же галочкой позиции, что и коэффициенты условий работ (`enabled`).
 * - Значения заказчика без подтверждения применяются, только если человек включил их в ведомости: допущение.
 */

const MULTIPLIERS = new Map(OVERHEAD_MULTIPLIERS.multipliers.map((item) => [item.id, item] as const));

const k = (value: number): string => String(Number(value.toFixed(4))).replace(".", ",");

export interface RateMultiplierTarget {
  readonly baseType: string;
  readonly collectionCode: string;
}

export interface ResolvedRateMultipliers {
  readonly overhead: number;
  readonly profit: number;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly manual: boolean;
  readonly label: string;
}

/**
 * Множители к НР и СП строки. null — у позиции нет ни подтверждённых множителей заказчика, ни включённых вручную.
 * `coefficients` — коэффициенты условий, уже определённые для строки: п. 58 берётся оттуда.
 */
export function resolveRateMultipliers(
  customer: CustomerConditions | undefined,
  coefficients: LineCoefficients | null,
  target: RateMultiplierTarget,
): ResolvedRateMultipliers | null {
  if (customer === undefined || !customer.enabled) return null;

  const manualOverhead = customer.forceUnconfirmed ? customer.rejected.reduce((product, claim) => product * (claim.overheadMultiplier ?? 1), 1) : 1;
  const manualProfit = customer.forceUnconfirmed ? customer.rejected.reduce((product, claim) => product * (claim.profitMultiplier ?? 1), 1) : 1;
  const manual = manualOverhead !== 1 || manualProfit !== 1;

  const confirmed = [customer.rates?.overhead ?? null, customer.rates?.profit ?? null];
  if (confirmed.every((item) => item === null) && !manual) return null;

  const p58 = coefficients?.adjustmentIds.includes("P58") === true;
  const applied: string[] = [];
  const skipped: string[] = [];
  let overhead = manualOverhead;
  let profit = manualProfit;
  const labels: string[] = [];

  for (const multiplier of confirmed) {
    if (multiplier === null) continue;
    const entry = MULTIPLIERS.get(multiplier.id);
    if (entry === undefined) {
      skipped.push(`${multiplier.id}: нет в справочнике множителей`);
      continue;
    }
    const exclusion = OVERHEAD_MULTIPLIERS.exclusions.find(
      (item) => item.checkable && item.multiplierIds.includes(entry.id) && item.collections.includes(target.collectionCode),
    );
    if (entry.requires === "P58" && !p58) {
      skipped.push(`${entry.id}: п. 58 к строке не применён (вид работ, книга нормы или применение отключено)`);
    } else if (exclusion !== undefined) {
      skipped.push(`${entry.id}: ${exclusion.point} — не применяется при капитальном ремонте сетей, дорог и инженерных сооружений (сборник ${target.collectionCode})`);
    } else {
      applied.push(entry.id);
      labels.push(`${entry.order} ${entry.point} (${k(entry.value)})`);
      if (entry.normative === "OVERHEAD") overhead *= entry.value;
      else profit *= entry.value;
    }
  }
  if (manual) labels.push(`значения заказчика вручную: НР ×${k(manualOverhead)}, СП ×${k(manualProfit)}`);

  if (applied.length === 0 && skipped.length === 0 && !manual) return null;
  return {
    overhead: Math.round(overhead * 1e6) / 1e6,
    profit: Math.round(profit * 1e6) / 1e6,
    applied,
    skipped,
    manual,
    label: `как у заказчика: ${labels.join("; ")}`,
  };
}

/** Строка с применённым множителем: проценты — с множителем, нормативы по указателям — как были. */
export function describeRateMultipliers(
  resolved: ResolvedRateMultipliers,
  base: { readonly overhead: number; readonly profit: number },
): LineRateMultipliers {
  return {
    overhead: resolved.overhead,
    profit: resolved.profit,
    baseOverheadPercent: base.overhead,
    baseProfitPercent: base.profit,
    applied: resolved.applied,
    skipped: resolved.skipped,
    manual: resolved.manual,
    label: resolved.label,
  };
}
