"use client";

import { useMemo } from "react";

import { describePriceZoneBasis, resolvePriceZone } from "@/domain/estimate/priceZoneResolve";
import { isSameRegion } from "@/domain/regionCodes";
import type { PriceZonesState } from "@/hooks/usePriceZones";
import { chooseEstimateZone, EstimatePriceZoneError } from "@/services/estimateZone";

/**
 * Какими ценами считать смету: зона закупки и выбор другой зоны вручную.
 *
 * Предвыбор делает тот же `chooseEstimateZone`, что воркер, — на тех же данных
 * закупки, — поэтому строка «Цены: …» показывает ровно то, что получится, если
 * ничего не трогать. Зона, выбранная вручную, уходит в задание как есть. Зона
 * другого субъекта допустима (закупка может быть смежной), но предупреждение
 * обязательно: цены чужого региона отличаются на десятки процентов.
 *
 * Выбор не обязателен: зона закупки не собрана или не определилась — сообщение
 * то же, что вернёт воркер, а кнопка расчёта остаётся доступной.
 */

export interface PriceZoneTender {
  readonly region: string;
  readonly deliveryAddress: string;
  readonly customerName: string;
}

export function PriceZonePicker({
  tender,
  zones,
  picked,
  onPick,
}: {
  /** Закупка; нет — расчёт по присланным документам, зону выбирает человек. */
  tender?: PriceZoneTender;
  zones: PriceZonesState;
  /** Зона, выбранная вручную; null — по закупке. */
  picked: number | null;
  onPick: (priceZoneId: number | null) => void;
}) {
  const built = zones.zones;

  const choice = useMemo(() => {
    if (built.length === 0) return null;
    try {
      return {
        ok: chooseEstimateZone({
          tender: tender === undefined ? null : { region: tender.region, address: tender.deliveryAddress, customerName: tender.customerName },
          zones: zones.allZones,
          built,
        }),
        message: null,
      };
    } catch (error) {
      if (error instanceof EstimatePriceZoneError) return { ok: null, message: error.message };
      throw error;
    }
  }, [built, tender, zones.allZones]);

  const ordered = useMemo(() => {
    const sameSubject = (zone: { subject: string }): boolean =>
      tender !== undefined && tender.region.trim() !== "" && isSameRegion(tender.region, zone.subject);
    return {
      own: built.filter(sameSubject),
      other: built.filter((zone) => !sameSubject(zone)),
    };
  }, [built, tender]);

  // Зона по закупке: основание нужно строке, а оно — результат разбора, а не выбора.
  const autoBasis = useMemo(() => {
    if (choice?.ok == null || tender === undefined) return null;
    const ids = new Map(built.map((zone) => [zone.zoneName, zone.priceZoneId] as const));
    return resolvePriceZone(
      { region: tender.region, address: tender.deliveryAddress, customerName: tender.customerName },
      zones.allZones,
      built.map((zone) => zone.priceZoneId),
      ids,
    );
  }, [built, choice, tender, zones.allZones]);

  if (built.length === 0) return null;

  const pickedZone = picked === null ? null : (built.find((zone) => zone.priceZoneId === picked) ?? null);
  const foreign =
    pickedZone !== null &&
    tender !== undefined &&
    tender.region.trim() !== "" &&
    !isSameRegion(tender.region, pickedZone.subject);

  const auto = choice?.ok ?? null;
  const autoZone = auto === null ? null : (built.find((zone) => zone.priceZoneId === auto.priceZoneId) ?? null);

  let line: string;
  if (pickedZone !== null) {
    line = `Цены: ${pickedZone.zoneName}, ${pickedZone.period} — ${describePriceZoneBasis({ basis: "USER", matched: null })}`;
  } else if (auto !== null && autoZone !== null) {
    const basis = autoBasis ?? { basis: auto.basis, matched: auto.matched };
    line = `Цены: ${autoZone.zoneName}, ${autoZone.period} — ${describePriceZoneBasis(basis)}`;
  } else {
    line = choice?.message ?? "";
  }

  return (
    <div className="space-y-1 text-sm" data-testid="price-zone">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={pickedZone === null && auto === null ? "text-mustard-fg" : "text-muted-foreground"} data-testid="price-zone-line">
          {line}
        </span>
        <select
          aria-label="Другая ценовая зона"
          className="rounded-full border border-border bg-panel px-2 py-0.5 text-xs"
          value={picked === null ? "" : String(picked)}
          onChange={(event) => onPick(event.target.value === "" ? null : Number(event.target.value))}
        >
          <option value="">{picked === null ? "другая зона…" : "вернуть зону закупки"}</option>
          {ordered.own.length > 0 && (
            <optgroup label="Зоны региона закупки">
              {ordered.own.map((zone) => (
                <option key={zone.priceZoneId} value={zone.priceZoneId}>
                  {zone.zoneName}
                </option>
              ))}
            </optgroup>
          )}
          {ordered.other.length > 0 && (
            <optgroup label={ordered.own.length > 0 ? "Остальные зоны" : "Собранные зоны"}>
              {ordered.other.map((zone) => (
                <option key={zone.priceZoneId} value={zone.priceZoneId}>
                  {zone.zoneName}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {foreign && (
        <p className="text-xs text-mustard-fg" data-testid="price-zone-warning">
          Зона не из региона закупки: цены другого региона отличаются, проверьте выбор.
        </p>
      )}
    </div>
  );
}
