"use client";

import { useMemo } from "react";

import { DEFAULT_SSR_OPTIONS, NO_ESTIMATE_OPTIONS, type EstimateOptions, type SsrOptions } from "@/domain/estimate/estimateOptions";
import { PURPOSE_LABELS } from "@/domain/estimate/ssrNormatives";
import { extractSsrTerm } from "@/domain/estimate/ssrTerm";
import type { ObjectPurpose } from "@/domain/estimate/ssrTypes";
import type { WorkCondition } from "@/domain/estimate/normativeTypes";
import { normalizeRegionText } from "@/domain/regions";
import { commissioningConditions, conditionsOfPhase, detectConditionHints } from "@/domain/estimate/workConditions";
import { extractWorkPeriod, detectWinterMention } from "@/domain/estimate/workPeriod";
import { resolveWinterZone } from "@/domain/estimate/winterSurcharge";
import {
  detectKindHint,
  detectPhaseHint,
  PHASE_LABELS,
  workKindsOfPhase,
  type EstimatePhase,
} from "@/domain/estimate/workKinds";

/**
 * Блок «Условия работ» перед «Рассчитать смету».
 *
 * Здесь пользователь указывает то, чего нет в нормах: вид работ (для зимнего удорожания и временных
 * зданий), условия производства работ (коэффициенты приложения 10 к 421/пр) и сроки. По умолчанию
 * всё выключено — смета считается без начислений сверх норм. Текст документации подсказывает
 * («В ТЗ сказано: «…» — отметить?»), но галочку сам не ставит: коэффициент прибавляет деньги, и
 * решение о нём принимает человек.
 */

export interface WorkConditionsTender {
  readonly region: string;
  readonly deliveryAddress: string;
  readonly customerName: string;
}

const PHASES: readonly EstimatePhase[] = ["CAPITAL_REPAIR", "RECONSTRUCTION", "CONSTRUCTION", "DEMOLITION"];

function coefficientText(condition: WorkCondition): string {
  const values = [condition.coefficients.gesn, condition.coefficients.gesnm, condition.coefficients.gesnr, condition.coefficients.gesnp].filter(
    (value): value is number => typeof value === "number",
  );
  return [...new Set(values)].map((value) => value.toFixed(2).replace(".", ",")).join(" / ");
}

/** Включает условие и выключает остальные из его группы (подпункты одного пункта взаимоисключающи). */
function toggleCondition(options: EstimateOptions, condition: WorkCondition, on: boolean, all: readonly WorkCondition[]): EstimateOptions {
  const without = options.conditionIds.filter((id) => {
    if (id === condition.id) return false;
    if (!on || condition.exclusiveGroup === null) return true;
    const other = all.find((item) => item.id === id);
    return other?.exclusiveGroup !== condition.exclusiveGroup;
  });
  return { ...options, conditionIds: on ? [...without, condition.id] : without };
}

export function WorkConditionsBlock({
  options,
  onChange,
  text,
  subject,
  tender,
  customerCoefficients,
}: {
  options: EstimateOptions;
  onChange: (next: EstimateOptions) => void;
  /** Тексты документации и название закупки — для подсказок. */
  text: string;
  subject: string;
  tender?: WorkConditionsTender;
  /**
   * Коэффициенты заказчика в его ЛСР: сколько позиций с ними и сколько подтверждено приложением 10. Есть и больше нуля — в блоке
   * стоит переключатель «Применять коэффициенты заказчика».
   */
  customerCoefficients?: { readonly positions: number; readonly confirmed: number; readonly rejected: number } | null;
}) {
  const phase = options.phase;
  const conditions = useMemo(() => (phase === null ? [] : conditionsOfPhase(phase)), [phase]);
  const frequent = conditions.filter((condition) => condition.frequent);
  const rest = conditions.filter((condition) => !condition.frequent);
  const commissioning = useMemo(() => commissioningConditions(), []);

  const hintText = `${subject}\n${text}`;
  const phaseHint = useMemo(() => detectPhaseHint(hintText), [hintText]);
  const conditionHints = useMemo(
    () => (phase === null ? [] : detectConditionHints(hintText, phase)),
    [hintText, phase],
  );
  const kindHint = useMemo(() => (phase === null ? null : detectKindHint(phase, hintText)), [hintText, phase]);
  const periodHint = useMemo(() => extractWorkPeriod(text), [text]);
  const termHint = useMemo(() => extractSsrTerm(text), [text]);
  const winterHint = useMemo(() => detectWinterMention(text), [text]);

  // Температурная зона по закупке: если часть субъекта определить нельзя — предлагаем выбрать.
  const zone = useMemo(() => {
    if (tender === undefined || options.workKind === null) return null;
    const words = normalizeRegionText(`${tender.deliveryAddress} ${tender.customerName} ${subject}`)
      .split(" ")
      .filter((word) => word !== "");
    return resolveWinterZone(tender.region, words, options.winterPartId);
  }, [tender, options.workKind, options.winterPartId, subject]);

  const kinds = phase === null ? [] : workKindsOfPhase(phase);
  const set = (patch: Partial<EstimateOptions>): void => onChange({ ...options, ...patch });
  // Сброс условий работ не отменяет выбор метода расчёта и переключатель коэффициентов заказчика: это отдельные настройки.
  const reset = (): void =>
    onChange({
      ...NO_ESTIMATE_OPTIONS,
      ...(options.method == null ? {} : { method: options.method }),
      ...(options.applyCustomerCoefficients === false ? { applyCustomerCoefficients: false } : {}),
      ...(options.generateDebris === false ? { generateDebris: false } : {}),
      ...(options.generateImplied === false ? { generateImplied: false } : {}),
    });
  /** «Добавлять» — значение по умолчанию и в настройках не хранится: хранится только снятое. */
  const setGenerate = (key: "generateDebris" | "generateImplied", on: boolean): void => {
    const { [key]: _previous, ...rest } = options;
    onChange(on ? rest : { ...rest, [key]: false });
  };
  const setApplyCustomer = (apply: boolean): void => {
    const { applyCustomerCoefficients: _previous, ...rest } = options;
    onChange(apply ? rest : { ...rest, applyCustomerCoefficients: false });
  };
  const ssr: SsrOptions = options.ssr ?? DEFAULT_SSR_OPTIONS;
  const setSsr = (patch: Partial<SsrOptions>): void => onChange({ ...options, ssr: { ...ssr, ...patch } });
  const ssrPeriodSet =
    ssr.periodMode === "UNTIL" ? ssr.until !== null : ssr.periodMode === "MONTHS" ? ssr.months !== null : options.workPeriod?.start != null && options.workPeriod.end != null;

  const renderCondition = (condition: WorkCondition) => {
    const checked = options.conditionIds.includes(condition.id);
    const hint = conditionHints.find((item) => item.conditionId === condition.id);
    return (
      <li key={condition.id} className="space-y-0.5" data-testid={`condition-${condition.id}`}>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]"
            checked={checked}
            onChange={(event) => onChange(toggleCondition(options, condition, event.target.checked, conditions))}
          />
          <span>
            {condition.label}{" "}
            <span className="text-xs text-muted-foreground" title={condition.text}>
              К {coefficientText(condition)} · {condition.source.replace("Приложение 10 к 421/пр, ", "")}
            </span>
          </span>
        </label>
        {hint !== undefined && !checked && (
          <p className="ml-6 text-xs text-mustard-fg" data-testid={`hint-${condition.id}`}>
            В ТЗ сказано: «{hint.quote}» — отметить?{" "}
            <button
              type="button"
              className="underline"
              onClick={() => onChange(toggleCondition(options, condition, true, conditions))}
            >
              Отметить
            </button>
          </p>
        )}
      </li>
    );
  };

  const active =
    options.phase !== null ||
    options.conditionIds.length > 0 ||
    options.winterWork !== null ||
    options.workPeriod !== null ||
    options.ssr !== undefined;

  return (
    <fieldset className="space-y-2 rounded-md border border-border/60 px-3 py-2 text-sm" data-testid="work-conditions-block">
      <legend className="px-1 text-sm font-medium">Условия работ</legend>
      <p className="text-xs text-muted-foreground">
        По умолчанию всё выключено. Что отмечено, добавляется к смете по приказам Минстроя 421/пр (приложение 10), 325/пр (зимнее
        удорожание), 332/пр (временные здания); основание — в результате расчёта.
      </p>

      {customerCoefficients != null && customerCoefficients.positions > 0 && (
        <label className="flex items-start gap-2" data-testid="apply-customer-coefficients">
          <input
            type="checkbox"
            className="mt-1"
            checked={options.applyCustomerCoefficients !== false}
            onChange={(event) => setApplyCustomer(event.target.checked)}
            aria-label="Применять коэффициенты заказчика"
          />
          <span>
            Применять коэффициенты заказчика
            <span className="block text-xs text-muted-foreground">
              В ЛСР заказчика коэффициенты и множители к НР и СП у {customerCoefficients.positions} позиций: подтверждены приложением 10 к 421/пр, п. 58, 812/пр п. 25 или 774/пр п. 16 у{" "}
              {customerCoefficients.confirmed} — они применяются к тем же позициям нашего расчёта
              {customerCoefficients.rejected > 0
                ? `; не подтверждены у ${String(customerCoefficients.rejected)} — не применяются, их можно включить в ведомости по строке`
                : ""}
              . Если вы выбрали то же условие ниже, второй раз оно не применяется.
            </span>
          </span>
        </label>
      )}

      <div className="space-y-1" data-testid="generated-items-options">
        <p className="text-xs font-medium">Строки сверх ведомости</p>
        <label className="flex items-start gap-2" data-testid="generate-debris">
          <input
            type="checkbox"
            className="mt-1"
            checked={options.generateDebris !== false}
            onChange={(event) => setGenerate("generateDebris", event.target.checked)}
            aria-label="Добавлять вывоз строительного мусора"
          />
          <span>
            Добавлять вывоз строительного мусора
            <span className="block text-xs text-muted-foreground">
              Погрузка, перевозка и размещение мусора по тоннажу из норм разборки (ресурс 999-9900). Расстояние до полигона берётся из документов; не указано —
              строка добавляется без цены, так же и размещение без тарифа полигона. В таблице строки помечены «добавлено расчётом (мусор)».
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2" data-testid="generate-implied">
          <input
            type="checkbox"
            className="mt-1"
            checked={options.generateImplied !== false}
            onChange={(event) => setGenerate("generateImplied", event.target.checked)}
            aria-label="Добавлять работы по технологии (леса, ограждения)"
          />
          <span>
            Добавлять работы по технологии (леса, ограждения)
            <span className="block text-xs text-muted-foreground">
              ИИ предлагает работы, которых нет в ведомости, но без которых технология невыполнима (леса при работах на фасаде, защитные сетки, ограждения):
              объём считается по формуле от объёмов ведомости, норму выбирает ИИ из найденных в базе. В таблице строки помечены «добавлено ИИ · проверьте»;
              лишнюю можно удалить. Для смет по ЛСР заказчика обе настройки не действуют.
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-2">
          Вид работ
          <select
            aria-label="Вид работ"
            className="rounded-full border border-border bg-panel px-2 py-0.5"
            value={phase ?? ""}
            onChange={(event) => {
              const next = event.target.value === "" ? null : (event.target.value as EstimatePhase);
              // Условия и объект другого вида работ не переносятся: таблицы приложения 10 у них разные.
              set({ phase: next, workKind: null, conditionIds: [], newConstructionNorms: false });
            }}
          >
            <option value="">не указан</option>
            {PHASES.map((item) => (
              <option key={item} value={item}>
                {PHASE_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        {phase === null && phaseHint !== null && (
          <span className="text-xs text-mustard-fg" data-testid="phase-hint">
            В названии закупки: «{phaseHint.quote}» — {PHASE_LABELS[phaseHint.phase].toLowerCase()}?{" "}
            <button type="button" className="underline" onClick={() => set({ phase: phaseHint.phase })}>
              Выбрать
            </button>
          </span>
        )}
        {active && (
          <button type="button" className="text-xs text-muted-foreground underline" onClick={reset}>
            Сбросить всё
          </button>
        )}
      </div>

      {phase !== null && (
        <div className="space-y-1">
          <label className="flex flex-wrap items-center gap-2">
            Объект
            <select
              aria-label="Объект или конструкции"
              className="max-w-full rounded-full border border-border bg-panel px-2 py-0.5"
              value={options.workKind ?? ""}
              onChange={(event) => set({ workKind: event.target.value === "" ? null : event.target.value, winterPartId: null })}
            >
              <option value="">не указан — зимнее удорожание и временные здания не начислятся</option>
              {kinds.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {kindHint !== null && options.workKind === null && (
            <p className="text-xs text-mustard-fg" data-testid="kind-hint">
              В ТЗ сказано: «{kindHint.quote}» — {kindHint.kind.label}?{" "}
              <button type="button" className="underline" onClick={() => set({ workKind: kindHint.kind.id })}>
                Выбрать
              </button>
            </p>
          )}
        </div>
      )}

      {phase === "DEMOLITION" && (
        <p className="text-xs text-muted-foreground">
          Для сноса в приложении 10 к 421/пр условий производства работ нет; погрузка и вывоз мусора учитываются отдельными строками
          (п. 62). Временные здания при сносе считаются только расчётом по проекту (332/пр, п. 29).
        </p>
      )}

      {phase !== null && phase !== "DEMOLITION" && (
        <>
          <ul className="space-y-1.5" data-testid="frequent-conditions">
            {frequent.map(renderCondition)}
          </ul>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Ещё</summary>
            <div className="mt-2 space-y-2">
              {(phase === "CAPITAL_REPAIR" || phase === "RECONSTRUCTION") && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]"
                    checked={options.newConstructionNorms}
                    onChange={(event) => set({ newConstructionNorms: event.target.checked })}
                  />
                  <span>
                    Работы по нормам нового строительства: К 1,15 к труду и 1,25 к машинам{" "}
                    <span className="text-xs text-muted-foreground">п. 58 Методики 421/пр; не к разборке и не к ГЭСН 81-02-46</span>
                  </span>
                </label>
              )}
              <ul className="space-y-1.5">{rest.map(renderCondition)}</ul>
              <p className="text-xs font-medium">Пусконаладочные работы (нормы ГЭСНп)</p>
              <ul className="space-y-1.5">
                {commissioning.map((condition) => {
                  const checked = options.conditionIds.includes(condition.id);
                  return (
                    <li key={condition.id}>
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]"
                          checked={checked}
                          onChange={(event) => onChange(toggleCondition(options, condition, event.target.checked, [...conditions, ...commissioning]))}
                        />
                        <span>
                          {condition.label}{" "}
                          <span className="text-xs text-muted-foreground">К {coefficientText(condition)} · {condition.source.replace("Приложение 10 к 421/пр, ", "")}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          </details>
        </>
      )}

      {phase !== null && options.workKind !== null && (
        <div className="space-y-1" data-testid="winter-block">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Работы зимой</span>
            {(
              [
                [null, "не указано"],
                ["YES", "да"],
                ["NO", "нет"],
                ["PART", "часть"],
              ] as const
            ).map(([value, label]) => (
              <label key={label} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="winter-work"
                  checked={options.winterWork === value}
                  onChange={() => set({ winterWork: value })}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <label className="flex items-center gap-1">
              Начало работ
              <input
                type="date"
                aria-label="Начало работ"
                className="rounded border border-border bg-panel px-1"
                value={options.workPeriod?.start ?? ""}
                onChange={(event) =>
                  set({ workPeriod: { start: event.target.value === "" ? null : event.target.value, end: options.workPeriod?.end ?? null } })
                }
              />
            </label>
            <label className="flex items-center gap-1">
              Окончание
              <input
                type="date"
                aria-label="Окончание работ"
                className="rounded border border-border bg-panel px-1"
                value={options.workPeriod?.end ?? ""}
                onChange={(event) =>
                  set({ workPeriod: { start: options.workPeriod?.start ?? null, end: event.target.value === "" ? null : event.target.value } })
                }
              />
            </label>
            <span className="text-muted-foreground">Даты главнее ответа «да / нет»: нет пересечения с зимним периодом — зимнее не начисляется.</span>
          </div>
          {periodHint !== null && periodHint.start !== null && periodHint.end !== null && options.workPeriod === null && (
            <p className="text-xs text-mustard-fg" data-testid="period-hint">
              В ТЗ сказано: «{periodHint.quote}» — применить сроки {periodHint.start} — {periodHint.end}?{" "}
              <button type="button" className="underline" onClick={() => set({ workPeriod: { start: periodHint.start, end: periodHint.end } })}>
                Применить
              </button>
            </p>
          )}
          {winterHint !== null && options.winterWork === null && options.workPeriod === null && (
            <p className="text-xs text-mustard-fg" data-testid="winter-hint">
              В ТЗ сказано: {winterHint.quote} — работы зимой?{" "}
              <button type="button" className="underline" onClick={() => set({ winterWork: "YES" })}>
                Отметить «да»
              </button>
            </p>
          )}
          {zone !== null && !zone.ok && zone.candidates.length > 0 && (
            <label className="flex flex-wrap items-center gap-2 text-xs" data-testid="winter-part">
              <span className="text-mustard-fg">Температурная зона по закупке не определилась: {zone.reason}.</span>
              <select
                aria-label="Часть территории субъекта"
                className="max-w-full rounded-full border border-border bg-panel px-2 py-0.5"
                value={options.winterPartId ?? ""}
                onChange={(event) => set({ winterPartId: event.target.value === "" ? null : event.target.value })}
              >
                <option value="">выбрать часть…</option>
                {zone.candidates.map((part) => (
                  <option key={part.id} value={part.id}>
                    {`п. ${part.item}: ${part.description === "" ? part.subject : part.description} (${part.zone} зона)`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {zone !== null && zone.ok && zone.assumption !== null && (
            <p className="text-xs text-muted-foreground" data-testid="winter-assumption">
              Допущение: {zone.assumption}.
            </p>
          )}
        </div>
      )}

      <div className="space-y-1 border-t border-border/60 pt-2" data-testid="ssr-conditions">
        <p className="font-medium">Сводный расчёт и цена контракта</p>
        <p className="text-xs text-muted-foreground">
          Назначение объекта задаёт размер резерва на непредвиденные (421/пр, п. 179), сроки работ — индекс прогнозной инфляции
          (841/пр, п. 22-23). Без сроков инфляция не применяется, и в надёжности расчёта это записано как допущение.
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-2">
            Назначение объекта
            <select
              aria-label="Назначение объекта"
              className="rounded-full border border-border bg-panel px-2 py-0.5"
              value={ssr.purpose ?? ""}
              onChange={(event) => setSsr({ purpose: event.target.value === "" ? null : (event.target.value as ObjectPurpose) })}
            >
              <option value="">по виду работ (по умолчанию — непроизводственное)</option>
              {(Object.keys(PURPOSE_LABELS) as ObjectPurpose[]).map((key) => (
                <option key={key} value={key}>
                  {PURPOSE_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <label className="flex items-center gap-2 text-sm">
            Сроки работ
            <select
              aria-label="Как заданы сроки работ"
              className="rounded-full border border-border bg-panel px-2 py-0.5"
              value={ssr.periodMode ?? ""}
              onChange={(event) => setSsr({ periodMode: event.target.value === "" ? null : (event.target.value as SsrOptions["periodMode"]) })}
            >
              <option value="">не указаны (или даты из блока выше)</option>
              <option value="DATES">работы с … по …</option>
              <option value="UNTIL">с даты контракта по …</option>
              <option value="MONTHS">в течение N месяцев с даты контракта</option>
            </select>
          </label>
          {ssr.periodMode === "DATES" && (
            <>
              <label className="flex items-center gap-1">
                Работы с
                <input
                  type="date"
                  aria-label="Работы с"
                  className="rounded border border-border bg-panel px-1"
                  value={options.workPeriod?.start ?? ""}
                  onChange={(event) =>
                    set({ workPeriod: { start: event.target.value === "" ? null : event.target.value, end: options.workPeriod?.end ?? null } })
                  }
                />
              </label>
              <label className="flex items-center gap-1">
                по
                <input
                  type="date"
                  aria-label="Работы по"
                  className="rounded border border-border bg-panel px-1"
                  value={options.workPeriod?.end ?? ""}
                  onChange={(event) =>
                    set({ workPeriod: { start: options.workPeriod?.start ?? null, end: event.target.value === "" ? null : event.target.value } })
                  }
                />
              </label>
            </>
          )}
          {ssr.periodMode === "UNTIL" && (
            <label className="flex items-center gap-1">
              Работы до
              <input
                type="date"
                aria-label="Работы до"
                className="rounded border border-border bg-panel px-1"
                value={ssr.until ?? ""}
                onChange={(event) => setSsr({ until: event.target.value === "" ? null : event.target.value })}
              />
            </label>
          )}
          {ssr.periodMode === "MONTHS" && (
            <label className="flex items-center gap-1">
              Месяцев
              <input
                type="number"
                min={1}
                max={120}
                aria-label="Срок работ, месяцев"
                className="w-16 rounded border border-border bg-panel px-1"
                value={ssr.months ?? ""}
                onChange={(event) => setSsr({ months: event.target.value === "" ? null : Number.parseInt(event.target.value, 10) })}
              />
            </label>
          )}
        </div>
        {!ssrPeriodSet && (
          <p className="text-xs text-muted-foreground" data-testid="ssr-no-period">
            Сроков нет: прогнозная инфляция не применяется (цена остаётся в текущем уровне цен).
          </p>
        )}
        {termHint !== null && !ssrPeriodSet && (
          <p className="text-xs text-mustard-fg" data-testid="term-hint">
            В ТЗ сказано: «{termHint.quote}» —{" "}
            {termHint.start !== null && termHint.end !== null
              ? `применить сроки ${termHint.start} — ${termHint.end}?`
              : termHint.end !== null
                ? `работы с даты контракта по ${termHint.end}?`
                : termHint.months !== null
                  ? `срок ${String(termHint.months)} мес. с даты контракта?`
                  : "применить срок?"}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                if (termHint.start !== null && termHint.end !== null) {
                  onChange({ ...options, workPeriod: { start: termHint.start, end: termHint.end }, ssr: { ...ssr, periodMode: "DATES" } });
                } else if (termHint.end !== null) {
                  setSsr({ periodMode: "UNTIL", until: termHint.end });
                } else if (termHint.months !== null) {
                  setSsr({ periodMode: "MONTHS", months: termHint.months });
                }
              }}
            >
              Применить
            </button>
          </p>
        )}
      </div>
    </fieldset>
  );
}
