"use client";

import { useEffect, useState } from "react";

import type { PriceZoneRecord } from "@/domain/estimate/priceZoneResolve";

/**
 * Ценовые зоны для экрана сметы: какие собраны и справочник зон целиком.
 *
 * Один запрос на монтирование к `/api/estimate/zones`. Любой сбой (сети нет,
 * приложение развёрнуто без индекса и вернуло пустой список) оставляет списки
 * пустыми: экран тогда просто не предлагает выбор зоны, а решение о зоне остаётся
 * за воркером, который скажет причину, если выбрать нечего.
 */

export interface BuiltZoneView {
  readonly priceZoneId: number;
  readonly zoneName: string;
  readonly subject: string;
  readonly period: string;
}

export interface PriceZonesState {
  readonly status: "loading" | "ready";
  readonly zones: readonly BuiltZoneView[];
  readonly allZones: readonly PriceZoneRecord[];
  /** Номера всех зон ФГИС ЦС: не собранную зону воркер соберёт перед расчётом. Нет — выбираются только собранные. */
  readonly directory?: readonly { readonly priceZoneId: number; readonly zoneName: string }[];
}

const EMPTY: PriceZonesState = { status: "loading", zones: [], allZones: [] };

export function usePriceZones(): PriceZonesState {
  const [state, setState] = useState<PriceZonesState>(EMPTY);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch("/api/estimate/zones");
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as {
          zones?: BuiltZoneView[];
          allZones?: { name: string; subjectCode: string; subjectName?: string; center: string; municipalities: string }[];
          directory?: { priceZoneId: number; zoneName: string }[];
        };
        if (!alive) return;
        setState({
          status: "ready",
          zones: payload.zones ?? [],
          allZones: (payload.allZones ?? []).map((zone) => ({
            subjectCode: zone.subjectCode,
            subjectName: zone.subjectName ?? "",
            zoneName: zone.name,
            center: zone.center,
            municipalities: zone.municipalities,
          })),
          directory: payload.directory ?? [],
        });
      } catch {
        if (alive) setState({ status: "ready", zones: [], allZones: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
