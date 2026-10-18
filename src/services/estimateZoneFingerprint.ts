import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import type { DocumentText } from "@/domain/estimate/customerEstimate";
import type { WageScale } from "@/domain/estimate/types";
import { customerWageRates, identifyZoneByWages } from "@/domain/estimate/zoneFingerprint";
import { fingerprintCandidateZones, type ZoneChoiceInput, type ZoneFingerprint } from "@/services/estimateZone";

/**
 * Зона по ставкам оплаты труда в сметах заказчика: связка «документы → ставки → шкалы зон субъекта → отпечаток».
 *
 * Чистая логика — в `zoneFingerprint.ts`; здесь только сборка входа. Шкалы читает вызывающий код (`loadZoneWageScale`
 * репозитория базы цен), поэтому модуль не знает о диске, а воркер и бенчмарк (`scripts/worker.ts`,
 * `scripts/estimate-benchmark.ts`) зовут одну и ту же функцию одной строкой. Не бросает: отпечаток необязателен, и любая причина,
 * почему его нет, возвращается словами в `message` — для журнала.
 */
export async function fingerprintZoneByCustomerPrices(
  documents: readonly DocumentText[],
  input: Pick<ZoneChoiceInput, "declared" | "tender" | "zones" | "built">,
  loadScale: (priceZoneId: number) => Promise<WageScale | null>,
): Promise<{ readonly fingerprint: ZoneFingerprint | null; readonly message: string | null }> {
  const candidates = fingerprintCandidateZones(input);
  if (candidates.length === 0) return { fingerprint: null, message: null };

  const rates = customerWageRates(parseCustomerLsr(documents).estimates);
  if (rates.length === 0) return { fingerprint: null, message: null };

  const scales = await Promise.all(
    candidates.map(async (zone) => {
      const scale = await loadScale(zone.priceZoneId).catch(() => null);
      return scale === null ? null : { zoneName: zone.zoneName, scale };
    }),
  );
  const result = identifyZoneByWages(
    rates,
    scales.filter((entry) => entry !== null),
  );
  if (result.kind === "MATCH") {
    return { fingerprint: { zoneName: result.zoneName, matchedCodes: result.matchedCodes }, message: null };
  }
  return { fingerprint: null, message: `зона по ценам сметы заказчика не определена: ${result.reason}` };
}
