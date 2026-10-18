"use client";

import { useMemo } from "react";

import { detectCustomerMethod, METHOD_LABEL } from "@/domain/estimate/bimMethod";
import type { EstimateOptions } from "@/domain/estimate/estimateOptions";
import type { EstimateMethod } from "@/domain/estimate/types";

/**
 * Метод расчёта сметы: ресурсно-индексный (ФСНБ-2022) или базисно-индексный (расценки ФЕР-2001 × индексы Минстроя).
 *
 * По умолчанию — «как у заказчика»: воркер сам определяет метод по смете заказчика, заданию и контракту. Здесь рядом с выбором
 * показано, что по тексту документации видно уже сейчас (смету заказчика читает воркер, поэтому подсказка может быть неполной).
 * Выбор метода вручную важнее документации.
 */

const OPTIONS: ReadonlyArray<{ readonly value: EstimateMethod | ""; readonly label: string }> = [
  { value: "", label: "Как у заказчика (по документации)" },
  { value: "RESOURCE_INDEX", label: "Ресурсно-индексный (ФСНБ-2022)" },
  { value: "BASE_INDEX", label: "Базисно-индексный (ФЕР-2001 × индексы)" },
];

export function EstimateMethodSelect({
  options,
  onChange,
  text,
}: {
  readonly options: EstimateOptions;
  readonly onChange: (next: EstimateOptions) => void;
  /** Тексты документации закупки: по ним подсказка «в документации назван …». */
  readonly text: string;
}) {
  const hint = useMemo(() => detectCustomerMethod([{ name: "документация", text }]), [text]);
  const selected = options.method ?? "";

  return (
    <div className="space-y-1 rounded-md border border-border/60 px-3 py-2 text-sm" data-testid="estimate-method">
      <label className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Метод расчёта</span>
        <select
          aria-label="Метод расчёта"
          className="rounded-full border border-border bg-panel px-2 py-0.5"
          value={selected}
          onChange={(event) => {
            const value = event.target.value;
            onChange({ ...options, method: value === "BASE_INDEX" || value === "RESOURCE_INDEX" ? value : null });
          }}
        >
          {OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted-foreground" data-testid="estimate-method-hint">
        {selected !== ""
          ? `Метод выбран вручную: ${METHOD_LABEL[selected]}.`
          : hint.method === null
            ? "Документация о методе заказчика не говорит — будет ресурсно-индексный. Если его смета на ФЕР/ТЕР с индексами, мы заметим это по смете."
            : `По документации: ${METHOD_LABEL[hint.method]} — ${hint.note}.`}
        {selected === "BASE_INDEX" || (selected === "" && hint.method === "BASE_INDEX")
          ? " Расценки ФЕР-2020 пересчитываются индексами письма Минстроя по субъекту и объекту строительства; ТЕР региона в открытых данных нет — считается по ФЕР."
          : ""}
      </p>
    </div>
  );
}
