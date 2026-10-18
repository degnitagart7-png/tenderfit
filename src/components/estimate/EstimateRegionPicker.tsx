"use client";

import { useEffect, useMemo, useState } from "react";

import { Select } from "@/components/ui/primitives";
import type { PriceZonesState } from "@/hooks/usePriceZones";

/**
 * Регион расчёта для сметы без закупки: субъект, затем ценовая зона.
 *
 * У карточки закупки зона определяется по её региону и адресу (`PriceZonePicker`).
 * Здесь закупки нет, и спрашивать надо просто: «где объект». Раньше вместо вопроса
 * экран печатал объяснение воркера со списком всех собранных зон — полэкрана
 * текста, из которого выбирать всё равно приходилось в выпадающем списке.
 *
 * Зоны субъекта показываются все, а не только собранные: иначе в субъекте с одной
 * собранной зоной она подставилась бы молча, хотя объект может стоять в соседней, с
 * другими ценами. Не собранную зону воркер соберёт перед расчётом; если её номера
 * нет в справочнике, выбрать её нельзя — так и написано.
 *
 * Последний выбор помнится в браузере: сметы обычно считают по одному региону.
 */

const LAST_ZONE_KEY = "tf.estimate.lastZone";

function readLastZone(): number | null {
  try {
    const raw = localStorage.getItem(LAST_ZONE_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLastZone(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(LAST_ZONE_KEY);
    else localStorage.setItem(LAST_ZONE_KEY, String(id));
  } catch {
    // Без памяти браузера выбор просто не запомнится.
  }
}

/** «Республика Бурятия (8 зона)» → «8 зона»; без скобок — название целиком. */
function shortZoneName(zoneName: string, subject: string): string {
  const inBrackets = /\(([^()]*зона[^()]*)\)\s*$/i.exec(zoneName);
  if (inBrackets !== null) return inBrackets[1]!;
  const rest = zoneName.startsWith(subject) ? zoneName.slice(subject.length).trim() : zoneName;
  return rest === "" ? zoneName : rest;
}

interface ZoneOption {
  readonly zoneName: string;
  readonly subject: string;
  readonly center: string;
  /** Номер зоны для задания; null — номера нет, выбрать нельзя. */
  readonly priceZoneId: number | null;
  /** Цены собраны; нет — соберутся перед расчётом. */
  readonly built: boolean;
  readonly period: string | null;
}

export function EstimateRegionPicker({
  zones,
  picked,
  onPick,
}: {
  zones: PriceZonesState;
  picked: number | null;
  onPick: (priceZoneId: number | null) => void;
}) {
  const options = useMemo((): ZoneOption[] => {
    const built = new Map(zones.zones.map((zone) => [zone.zoneName, zone] as const));
    const ids = new Map((zones.directory ?? []).map((zone) => [zone.zoneName, zone.priceZoneId] as const));
    const fromDirectory = zones.allZones.map((record): ZoneOption => {
      const ready = built.get(record.zoneName);
      return {
        zoneName: record.zoneName,
        subject: record.subjectName !== "" ? record.subjectName : (ready?.subject ?? record.zoneName),
        center: record.center,
        priceZoneId: ready?.priceZoneId ?? ids.get(record.zoneName) ?? null,
        built: ready !== undefined,
        period: ready?.period ?? null,
      };
    });
    // Собранная зона, которой нет в справочнике (или справочник не пришёл), всё равно выбирается.
    const listed = new Set(fromDirectory.map((option) => option.zoneName));
    const extra = zones.zones
      .filter((zone) => !listed.has(zone.zoneName))
      .map((zone): ZoneOption => ({
        zoneName: zone.zoneName,
        subject: zone.subject,
        center: "",
        priceZoneId: zone.priceZoneId,
        built: true,
        period: zone.period,
      }));
    return [...fromDirectory, ...extra];
  }, [zones]);

  const subjects = useMemo(() => {
    const map = new Map<string, ZoneOption[]>();
    for (const option of options) map.set(option.subject, [...(map.get(option.subject) ?? []), option]);
    return [...map.entries()]
      .filter(([, list]) => list.some((option) => option.priceZoneId !== null))
      .map(([subject, list]) => ({ subject, zones: list }))
      .sort((a, b) => a.subject.localeCompare(b.subject, "ru"));
  }, [options]);

  const pickedOption = options.find((option) => option.priceZoneId !== null && option.priceZoneId === picked) ?? null;
  const [subject, setSubject] = useState<string>("");

  // Последний выбор — когда список зон пришёл, а человек ещё ничего не выбрал.
  useEffect(() => {
    if (options.length === 0 || picked !== null) return;
    const last = readLastZone();
    const option = last === null ? undefined : options.find((item) => item.priceZoneId === last);
    if (option !== undefined) {
      setSubject(option.subject);
      onPick(last);
    }
    // onPick — сеттер состояния родителя; повторять подстановку при его смене незачем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  useEffect(() => {
    if (pickedOption !== null && pickedOption.subject !== subject) setSubject(pickedOption.subject);
  }, [pickedOption, subject]);

  if (zones.status === "loading") {
    return <p className="muted text-sm">Загружаем список регионов…</p>;
  }
  if (subjects.length === 0) {
    return (
      <p className="muted text-sm">
        Регион определит сервер расчёта: список ценовых зон сейчас недоступен.
      </p>
    );
  }

  const subjectZones = subjects.find((item) => item.subject === subject)?.zones ?? [];

  const pick = (id: number | null): void => {
    writeLastZone(id);
    onPick(id);
  };

  const chooseSubject = (next: string): void => {
    setSubject(next);
    const list = subjects.find((item) => item.subject === next)?.zones ?? [];
    // Одна зона в субъекте — выбирать нечего, подставляем сразу.
    pick(list.length === 1 ? list[0]!.priceZoneId : null);
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="estimate-region">
      <label className="block">
        <span className="label">Регион объекта</span>
        <Select aria-label="Регион объекта" value={subject} onChange={(event) => chooseSubject(event.target.value)}>
          <option value="">Выберите регион</option>
          {subjects.map((item) => (
            <option key={item.subject} value={item.subject}>
              {item.subject}
            </option>
          ))}
        </Select>
      </label>

      {subjectZones.length > 1 && (
        <label className="block">
          <span className="label">Ценовая зона</span>
          <Select
            aria-label="Ценовая зона"
            value={picked === null ? "" : String(picked)}
            onChange={(event) => pick(event.target.value === "" ? null : Number(event.target.value))}
          >
            <option value="">Выберите зону</option>
            {subjectZones.map((zone) => (
              <option
                key={zone.zoneName}
                value={zone.priceZoneId ?? ""}
                disabled={zone.priceZoneId === null}
              >
                {shortZoneName(zone.zoneName, zone.subject)}
                {zone.center !== "" ? ` — ${zone.center}` : ""}
                {zone.priceZoneId === null ? " (цены не собраны)" : ""}
              </option>
            ))}
          </Select>
        </label>
      )}

      {pickedOption !== null && (
        <p className="muted text-[13px] sm:col-span-2" data-testid="estimate-region-line">
          {pickedOption.built
            ? `Цены ФГИС ЦС: ${pickedOption.zoneName}${pickedOption.period === null ? "" : `, ${pickedOption.period}`}`.replace(/\.?$/, ".")
            : `Цен зоны «${pickedOption.zoneName}» ещё нет — подготовим их перед расчётом, это до 20 минут.`}
        </p>
      )}
    </div>
  );
}
