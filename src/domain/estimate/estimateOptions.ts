import { z } from "zod";

import type { SsrPeriodInput } from "@/domain/estimate/forecastInflation";
import type { ObjectPurpose } from "@/domain/estimate/ssrTypes";
import type { WinterWork, WorkPeriod } from "@/domain/estimate/winterSurcharge";
import type { EstimateMethod } from "@/domain/estimate/types";
import { workKindById, type EstimatePhase } from "@/domain/estimate/workKinds";

/**
 * Что пользователь указал перед «Рассчитать смету»: вид работ, условия производства работ, сроки.
 *
 * По умолчанию не указано ничего (`NO_ESTIMATE_OPTIONS`), и смета считается без начислений сверх норм:
 * ни коэффициентов условий, ни зимнего удорожания, ни временных зданий. Каждое начисление включается
 * явным выбором — подставлять за пользователя деньги, о которых он не просил, нельзя.
 */

/**
 * Условия сводного расчёта (ССР) и цены контракта: назначение объекта и сроки работ.
 *
 * Не влияют на смету и не входят в `hasEstimateOptions`: ССР — отдельный слой поверх сметы (`ssr.ts`), он
 * считается в браузере по готовому расчёту и на воркер не отправляется.
 */
export interface SsrOptions {
  /** Назначение объекта для размера резерва на непредвиденные (421/пр, п. 179); null — по виду работ. */
  readonly purpose: ObjectPurpose | null;
  /**
   * Как читать срок работ: «работы с … по …» (даты `workPeriod`), «с даты контракта по …» (`until`) или «в
   * течение N месяцев с даты контракта» (`months`). null — взять даты `workPeriod`, если оба заданы.
   */
  readonly periodMode: "DATES" | "UNTIL" | "MONTHS" | null;
  readonly until: string | null;
  readonly months: number | null;
}

export const DEFAULT_SSR_OPTIONS: SsrOptions = { purpose: null, periodMode: null, until: null, months: null };

/** Срок работ для индекса прогнозной инфляции по выбору пользователя; null — сроки не указаны. */
export function resolveSsrPeriod(options: EstimateOptions): SsrPeriodInput | null {
  const ssr = options.ssr ?? DEFAULT_SSR_OPTIONS;
  const dates = options.workPeriod;
  const bothDates = dates !== null && dates.start !== null && dates.end !== null;
  switch (ssr.periodMode) {
    case "UNTIL":
      return ssr.until === null ? null : { kind: "UNTIL", end: ssr.until };
    case "MONTHS":
      return ssr.months === null || !(ssr.months > 0) ? null : { kind: "MONTHS", months: ssr.months };
    case "DATES":
    case null:
      return bothDates ? { kind: "DATES", start: dates.start as string, end: dates.end as string } : null;
  }
}

export interface EstimateOptions {
  readonly phase: EstimatePhase | null;
  /** Вид работ из `workKinds.ts` (для зимнего удорожания и временных зданий). */
  readonly workKind: string | null;
  /** Условия производства работ (идентификаторы `work-conditions.json`). */
  readonly conditionIds: readonly string[];
  /** Ремонт или реконструкция по нормам нового строительства (421/пр, п. 58). */
  readonly newConstructionNorms: boolean;
  /** «Работы зимой»: да, нет, часть. null — не указано. */
  readonly winterWork: WinterWork | null;
  /** Сроки работ: из документации или введённые вручную. */
  readonly workPeriod: WorkPeriod | null;
  /** Часть территории субъекта (приложение 4 к 325/пр), когда по закупке её определить нельзя. */
  readonly winterPartId: string | null;
  /** Условия сводного расчёта; нет поля — по умолчанию. Сметой не используются. */
  readonly ssr?: SsrOptions;
  /**
   * Метод расчёта: ресурсно-индексный или базисно-индексный (ФЕР-2001 × индексы Минстроя). null или нет поля — как у заказчика:
   * метод определяется по документации (смета заказчика, задание, контракт), молчит документация — ресурсно-индексный.
   */
  readonly method?: EstimateMethod | null;
  /**
   * Применять ли коэффициенты, которые заказчик применил к позициям своей ЛСР и которые подтверждены приложением 10 к 421/пр
   * (`customerCoefficients.ts`). Нет поля или `true` — применять (по умолчанию, если такие коэффициенты есть); `false` —
   * снято переключателем в блоке «Условия работ».
   */
  readonly applyCustomerCoefficients?: boolean;
  /**
   * Добавлять ли строки про строительный мусор (погрузка, перевозка, размещение) по тоннажу из норм (`debrisItems.ts`, без ИИ). Нет поля или
   * `true` — добавлять (по умолчанию); `false` — снято переключателем в блоке «Условия работ». Для смет по ЛСР заказчика не применяется вовсе.
   */
  readonly generateDebris?: boolean;
  /**
   * Добавлять ли работы, которые ИИ предложил по технологии, а ведомость не называет (леса, защитные сетки, ограждения; `impliedWorks.ts`).
   * Нет поля или `true` — добавлять (по умолчанию); `false` — снято переключателем. Для смет по ЛСР заказчика не применяется вовсе.
   */
  readonly generateImplied?: boolean;
}

export const NO_ESTIMATE_OPTIONS: EstimateOptions = {
  phase: null,
  workKind: null,
  conditionIds: [],
  newConstructionNorms: false,
  winterWork: null,
  workPeriod: null,
  winterPartId: null,
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const estimateOptionsSchema = z.object({
  phase: z.enum(["CONSTRUCTION", "RECONSTRUCTION", "CAPITAL_REPAIR", "DEMOLITION"]).nullable().optional(),
  workKind: z.string().min(1).max(60).nullable().optional(),
  conditionIds: z.array(z.string().regex(/^T\d-\d+(?:\.\d+)*$/u)).max(40).optional(),
  newConstructionNorms: z.boolean().optional(),
  winterWork: z.enum(["YES", "NO", "PART"]).nullable().optional(),
  workPeriod: z.object({ start: isoDate.nullable(), end: isoDate.nullable() }).nullable().optional(),
  winterPartId: z.string().regex(/^A4-[\d.()]+$/u).nullable().optional(),
  method: z.enum(["RESOURCE_INDEX", "BASE_INDEX"]).nullable().optional(),
  applyCustomerCoefficients: z.boolean().optional(),
  generateDebris: z.boolean().optional(),
  generateImplied: z.boolean().optional(),
});

/**
 * Приводит присланное (тело запроса, payload задания из базы) к виду, пригодному для расчёта.
 * Непригодное отбрасывается по полю, а не отказом: задание, поставленное старой версией интерфейса,
 * должно считаться как раньше.
 */
export function normalizeEstimateOptions(raw: unknown): EstimateOptions {
  if (raw === null || raw === undefined || typeof raw !== "object") return NO_ESTIMATE_OPTIONS;
  const parsed = estimateOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    // Разбираем по полям, чтобы одно битое не обнуляло остальные.
    const partial: Record<string, unknown> = {};
    for (const key of Object.keys(estimateOptionsSchema.shape) as (keyof typeof estimateOptionsSchema.shape)[]) {
      const one = estimateOptionsSchema.shape[key].safeParse((raw as Record<string, unknown>)[key]);
      if (one.success && one.data !== undefined) partial[key] = one.data;
    }
    return buildOptions(partial);
  }
  return buildOptions(parsed.data);
}

function buildOptions(data: Record<string, unknown>): EstimateOptions {
  const kindId = typeof data["workKind"] === "string" ? data["workKind"] : null;
  const kind = workKindById(kindId);
  const phase = (data["phase"] as EstimatePhase | null | undefined) ?? kind?.phase ?? null;
  const period = data["workPeriod"] as { start: string | null; end: string | null } | null | undefined;
  return {
    phase,
    // Вид работ другого вида работ, чем выбранный, не принимается: список в интерфейсе зависит от вида.
    workKind: kind !== null && (phase === null || kind.phase === phase) ? kind.id : null,
    conditionIds: Array.isArray(data["conditionIds"]) ? [...new Set(data["conditionIds"] as string[])] : [],
    newConstructionNorms: data["newConstructionNorms"] === true,
    winterWork: (data["winterWork"] as WinterWork | null | undefined) ?? null,
    workPeriod: period === undefined || period === null ? null : { start: period.start, end: period.end },
    winterPartId: typeof data["winterPartId"] === "string" ? data["winterPartId"] : null,
    ...(data["method"] === "RESOURCE_INDEX" || data["method"] === "BASE_INDEX" ? { method: data["method"] as EstimateMethod } : {}),
    // Только снятое: «применять» — значение по умолчанию, и хранить его незачем.
    ...(data["applyCustomerCoefficients"] === false ? { applyCustomerCoefficients: false } : {}),
    // Так же и добавление мусора и работ по технологии: хранится только снятое, включено по умолчанию.
    ...(data["generateDebris"] === false ? { generateDebris: false } : {}),
    ...(data["generateImplied"] === false ? { generateImplied: false } : {}),
  };
}

/** Указано ли что-нибудь сверх значений по умолчанию, включая метод расчёта (его надо передать воркеру). */
export function hasEstimateOptions(options: EstimateOptions): boolean {
  return (
    hasLimitedOptions(options) ||
    (options.method ?? null) !== null ||
    options.applyCustomerCoefficients === false ||
    options.generateDebris === false ||
    options.generateImplied === false
  );
}

/**
 * Указано ли что-нибудь для начислений сверх норм (вид работ, условия, сроки). Метод расчёта сюда не входит: выбор метода
 * не должен включать расчёт зимнего удорожания и пометки «вид работ не указан».
 */
export function hasLimitedOptions(options: EstimateOptions): boolean {
  return (
    options.phase !== null ||
    options.workKind !== null ||
    options.conditionIds.length > 0 ||
    options.newConstructionNorms ||
    options.winterWork !== null ||
    options.workPeriod !== null ||
    options.winterPartId !== null
  );
}
