import type { CustomerLsr } from "@/domain/estimate/customerLsr";
import { classifyResourceCode, rankFromWageCode } from "@/domain/estimate/resourceKinds";
import type { WageScale } from "@/domain/estimate/types";
import { resolveWage } from "@/domain/estimate/wageScale";

/**
 * Ценовая зона по ценам самой сметы заказчика.
 *
 * Зачем. Шапка ЛСР не всегда называет субъект и зону: на закупке 0134300025826000377 (Иркутск) её нет, а по адресу
 * «г. Иркутск» наш разбор выбрал «Иркутская область (1 зона)». Но заказчик печатает в ресурсных строках ставки оплаты труда —
 * «1-100-31 Средний разряд работы 3,1» по 921,66 ₽, машинист «4-100-040» по 1 024,91 ₽ — а ставки рабочих и машинистов в
 * реестре ФГИС ЦС у каждой зоны свои и опубликованы до копейки: у 1 зоны это 586,29 и 651,98, у 3 зоны — 921,66 и 1 024,91, у
 * 4–5 зон — 1 001,93 и 1 114,18, у 6 зоны — 1 093,86 и 1 216,41. Совпадение двух разных кодов до копейки с одной зоной и несовпадение
 * с остальными — отпечаток зоны: случайно такого не бывает, а цена зоны решает десятки процентов сметы.
 *
 * Правило, как во всём домене: не угадывать. Зона названа, только если
 * - совпали (±0,01 ₽) ставки не менее чем двух РАЗНЫХ кодов с её реестром;
 * - ни одна ставка, которую в реестре зоны можно назвать точно, с ней не разошлась (разошлась — смета в другом квартале или
 *   по другим ставкам, и верить совпадению нельзя);
 * - ни одна другая зона субъекта не подходит под те же условия, и ни у кого из остальных нет совпадения по коду, которого нет у
 *   победителя (иначе данные противоречат друг другу).
 * Две зоны с одинаковыми ставками (у Иркутской области 4 и 5 зоны) называются неоднозначностью, а не выбором.
 *
 * Цены машин и материалов в отпечаток не входят: ставки труда достаточно (они опубликованы в реестре для каждой зоны полностью),
 * а цены машин и материалов потребовали бы грузить ценовые книги всех зон субъекта ради проверки.
 *
 * Модуль чистый: шкалы зон ему отдаёт вызывающий код (`src/services/estimateZoneFingerprint.ts`).
 */

/** Допуск сравнения ставок, ₽: цены в сметах и реестре — с копейками. */
export const WAGE_MATCH_TOLERANCE = 0.01;
/** Не меньше стольких разных кодов должны совпасть. */
export const MIN_MATCHED_CODES = 2;

/** Ставка оплаты труда, которую заказчик напечатал в своей смете: код и цена за чел.-ч в текущем уровне. */
export interface CustomerWageRate {
  readonly code: string;
  readonly price: number;
  /** Сколько строк сметы заказчика несут эту цену. */
  readonly rows: number;
}

/**
 * Ставки труда рабочих («1-100-*», «2-100-*») и машинистов («4-100-*») из ресурсных строк смет заказчика. Цена заказчика по КП и
 * строки без цены пропускаются. У кода несколько цен (смета правилась по-разному) — берётся самая частая: при ничьей код не берётся.
 */
export function customerWageRates(estimates: readonly Pick<CustomerLsr, "positions" | "subPositions">[]): CustomerWageRate[] {
  const prices = new Map<string, Map<number, number>>();
  for (const estimate of estimates) {
    for (const position of [...estimate.positions, ...(estimate.subPositions ?? [])]) {
      for (const resource of position.resources) {
        if (resource.customerPrice || resource.unaccounted) continue;
        if (rankFromWageCode(resource.code) === null) continue;
        const kind = classifyResourceCode(resource.code);
        if (kind !== "LABOUR" && kind !== "MACHINIST_HOURS") continue;
        const price = resource.currentUnitPrice;
        if (price === null || !(price > 0)) continue;
        const key = Math.round(price * 100) / 100;
        const byPrice = prices.get(resource.code) ?? new Map<number, number>();
        byPrice.set(key, (byPrice.get(key) ?? 0) + 1);
        prices.set(resource.code, byPrice);
      }
    }
  }
  const rates: CustomerWageRate[] = [];
  for (const [code, byPrice] of prices) {
    const sorted = [...byPrice.entries()].sort((a, b) => b[1] - a[1]);
    const first = sorted[0];
    const second = sorted[1];
    if (first === undefined || (second !== undefined && second[1] === first[1])) continue;
    rates.push({ code, price: first[0], rows: first[1] });
  }
  return rates.sort((a, b) => a.code.localeCompare(b.code));
}

/** Зона-кандидат: название и её шкала ставок. */
export interface ZoneWageCandidate {
  readonly zoneName: string;
  readonly scale: WageScale;
}

export type ZoneFingerprintResult =
  | {
      readonly kind: "MATCH";
      readonly zoneName: string;
      /** Коды, ставки которых совпали с реестром зоны. */
      readonly matchedCodes: readonly string[];
    }
  | { readonly kind: "NONE"; readonly reason: string }
  | { readonly kind: "AMBIGUOUS"; readonly reason: string; readonly zoneNames: readonly string[] };

type Verdict = "MATCH" | "MISMATCH" | "UNKNOWN";

/**
 * Что реестр зоны говорит о ставке кода. Точная запись (опорная точка шкалы или официальная ставка машиниста) даёт и совпадение, и
 * расхождение; ставка, достроенная интерполяцией, — только совпадение: её копейки не измерены, и расхождение с ней ничего не доказывает.
 */
function verdictOf(scale: WageScale, rate: CustomerWageRate): Verdict {
  const rank = rankFromWageCode(rate.code);
  if (rank === null) return "UNKNOWN";
  if (classifyResourceCode(rate.code) === "MACHINIST_HOURS") {
    const official = scale.machinists?.find((anchor) => Math.abs(anchor.rank - rank) <= 1e-6);
    if (official === undefined) return "UNKNOWN";
    return Math.abs(official.salary - rate.price) <= WAGE_MATCH_TOLERANCE + 1e-9 ? "MATCH" : "MISMATCH";
  }
  const wage = resolveWage(scale, rate.code);
  if (wage === null || wage.origin === "EXTRAPOLATED") return "UNKNOWN";
  const equal = Math.abs(wage.salary - rate.price) <= WAGE_MATCH_TOLERANCE + 1e-9;
  if (equal) return "MATCH";
  return wage.origin === "ANCHOR" ? "MISMATCH" : "UNKNOWN";
}

/** Зона, чьи ставки труда совпали со ставками смет заказчика, или причина, почему назвать зону нельзя. */
export function identifyZoneByWages(rates: readonly CustomerWageRate[], candidates: readonly ZoneWageCandidate[]): ZoneFingerprintResult {
  if (rates.length < MIN_MATCHED_CODES) {
    return { kind: "NONE", reason: `в смете заказчика меньше ${String(MIN_MATCHED_CODES)} разных кодов ставок труда с ценой` };
  }
  if (candidates.length === 0) return { kind: "NONE", reason: "нет зон-кандидатов со шкалой ставок" };

  const outcomes = candidates.map((candidate) => {
    const matched: string[] = [];
    const mismatched: string[] = [];
    for (const rate of rates) {
      const verdict = verdictOf(candidate.scale, rate);
      if (verdict === "MATCH") matched.push(rate.code);
      else if (verdict === "MISMATCH") mismatched.push(rate.code);
    }
    return { zoneName: candidate.zoneName, matched, mismatched };
  });

  const qualifying = outcomes.filter((outcome) => outcome.matched.length >= MIN_MATCHED_CODES && outcome.mismatched.length === 0);
  if (qualifying.length === 0) {
    const best = [...outcomes].sort((a, b) => b.matched.length - a.matched.length)[0];
    return {
      kind: "NONE",
      reason:
        best === undefined || best.matched.length === 0
          ? "ставки смет заказчика не совпали ни с одной зоной субъекта (другой квартал или другие ставки)"
          : `лучшая зона «${best.zoneName}»: совпали ${String(best.matched.length)} из ${String(rates.length)} кодов, расхождение по ${String(best.mismatched.length)} — не отпечаток`,
    };
  }
  if (qualifying.length > 1) {
    return {
      kind: "AMBIGUOUS",
      reason: "несколько зон имеют те же ставки труда",
      zoneNames: qualifying.map((outcome) => outcome.zoneName),
    };
  }

  const winner = qualifying[0] as (typeof outcomes)[number];
  const own = new Set(winner.matched);
  for (const other of outcomes) {
    if (other === winner) continue;
    if (other.matched.some((code) => !own.has(code))) {
      return {
        kind: "AMBIGUOUS",
        reason: `ставка по коду, которого у «${winner.zoneName}» нет в реестре, совпала с зоной «${other.zoneName}» — данные противоречат друг другу`,
        zoneNames: [winner.zoneName, other.zoneName],
      };
    }
  }
  return { kind: "MATCH", zoneName: winner.zoneName, matchedCodes: [...winner.matched].sort() };
}
