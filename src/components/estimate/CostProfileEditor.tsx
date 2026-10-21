"use client";

import { useState } from "react";

import {
  COST_PROFILE_FIELDS,
  DEFAULT_COST_PROFILE,
  clampCostField,
  costFieldSpec,
  isDefaultCostProfile,
  type CompanyCostProfile,
  type CostProfileField,
} from "@/domain/estimate/companyCostProfile";

/**
 * Профиль затрат компании: шесть чисел, которыми фактическая себестоимость отличается от сметной.
 *
 * Один и тот же редактор стоит в «Настройки → Профиль» и прямо в блоке «Экономика участия»: человек, увидевший чужую
 * безубыточную цену, поправляет скидку на материалы там же и сразу видит новые границы. У каждого поля — одна строка
 * о том, что это и как выбрать значение. Ввод свободный (можно стереть и набрать заново); значение, вышедшее из
 * границ, подсвечивается, а в расчёт идёт ближайшая допустимая граница — расчёт никогда не считает по абсурду.
 *
 * Состояние поля-текста хранится здесь: иначе «−» или пустая строка при наборе превращались бы в число и сбивали ввод.
 */

export function CostProfileEditor({
  value,
  onChange,
  idPrefix = "cost",
}: {
  value: CompanyCostProfile;
  onChange: (next: CompanyCostProfile) => void;
  /** Префикс id полей: редактор бывает дважды на странице (карточка и форма профиля). */
  idPrefix?: string;
}) {
  // Текст поля, пока человек его правит; нет записи — показывается значение профиля.
  const [drafts, setDrafts] = useState<Partial<Record<CostProfileField, string>>>({});

  const commit = (key: CostProfileField, text: string): void => {
    setDrafts((current) => ({ ...current, [key]: text }));
    const parsed = Number(text.replace(",", "."));
    if (text.trim() === "" || !Number.isFinite(parsed)) return;
    onChange({ ...value, [key]: clampCostField(key, parsed) });
  };

  const reset = (): void => {
    setDrafts({});
    onChange(DEFAULT_COST_PROFILE);
  };

  return (
    <div className="space-y-3" data-testid="cost-profile-editor">
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {COST_PROFILE_FIELDS.map((spec) => {
          const text = drafts[spec.key] ?? String(value[spec.key]);
          const parsed = Number(text.replace(",", "."));
          const outOfRange = text.trim() !== "" && Number.isFinite(parsed) && (parsed < spec.min || parsed > spec.max);
          const invalid = text.trim() === "" || !Number.isFinite(parsed);
          const id = `${idPrefix}-${spec.key}`;
          // Цена субподряда без доли субподряда ни на что не влияет: поле тусклое, но доступно.
          const inactive = spec.key === "subcontractPricePercent" && value.subcontractSharePercent === 0;
          return (
            <div key={spec.key} className={inactive ? "opacity-60" : undefined}>
              <label htmlFor={id} className="text-[13.5px] font-medium text-foreground">
                {spec.label}, %
              </label>
              <input
                id={id}
                type="number"
                inputMode="decimal"
                step={spec.step}
                min={spec.min}
                max={spec.max}
                value={text}
                onChange={(event) => commit(spec.key, event.target.value)}
                onBlur={() => setDrafts((current) => {
                  const next = { ...current };
                  delete next[spec.key];
                  return next;
                })}
                aria-invalid={outOfRange || invalid || undefined}
                aria-describedby={`${id}-hint`}
                className="input mt-1 w-full max-w-[10rem] tabular-nums"
              />
              <p id={`${id}-hint`} className="mt-1 text-[12.5px] leading-snug text-muted-foreground">
                {spec.hint}
              </p>
              {(outOfRange || invalid) && (
                <p className="mt-0.5 text-xs text-brick-fg" role="alert">
                  {invalid
                    ? "Введите число"
                    : `От ${String(costFieldSpec(spec.key).min)} до ${String(costFieldSpec(spec.key).max)} % — в расчёте будет ближайшая граница`}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={reset}
        disabled={isDefaultCostProfile(value)}
        className="text-[13.5px] text-accent-fg underline-offset-2 hover:underline disabled:cursor-default disabled:text-faint disabled:no-underline"
      >
        Вернуть как в смете
      </button>
    </div>
  );
}
