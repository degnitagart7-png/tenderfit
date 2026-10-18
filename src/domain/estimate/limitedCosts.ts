import { UNKNOWN_REGION } from "@/domain/entities";
import { describeNorthBasis, type NorthBasis } from "@/domain/estimate/north";
import { hasLimitedOptions, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { computeTemporaryStructures } from "@/domain/estimate/temporaryStructures";
import { computeWinterSurcharge } from "@/domain/estimate/winterSurcharge";
import { workKindById } from "@/domain/estimate/workKinds";
import type { NorthZone } from "@/domain/estimate/overheadNormatives";
import type {
  AppliedNormative,
  EstimateSource,
  LimitedCosts,
  WorkConditionsApplication,
} from "@/domain/estimate/types";
import { normalizeRegionText, regionFromAddress } from "@/domain/regions";

/**
 * Зимнее удорожание, временные здания, коэффициенты условий работ и северность территории — сведены
 * в параметры расчёта и список применённых нормативов.
 *
 * Правило по умолчанию: ничего не указано — ничего не начислено, смета равна прежней. Что начислено,
 * по какой строке какого приказа и почему не начислено остальное — в `appliedNormatives`.
 */

export interface LimitedContext {
  /** Регион закупки, как записан в базе. */
  readonly region: string | null;
  readonly address?: string | null;
  readonly customerName?: string | null;
  /** Название закупки: слова из него тоже ищутся среди муниципалитетов. */
  readonly subject?: string | null;
  /** Северность территории, как её определил выбор ценовой зоны. */
  readonly north?: { readonly zone: NorthZone; readonly basis: NorthBasis; readonly matched?: string | null } | null;
}

export interface ResolvedLimited {
  readonly limited: LimitedCosts;
  readonly workConditions: WorkConditionsApplication | undefined;
  readonly appliedNormatives: readonly AppliedNormative[];
  readonly sources: readonly EstimateSource[];
}

export const NO_LIMITED_SOURCE = "Лимитированные затраты не начислялись";

const SOURCES: Readonly<Record<string, EstimateSource>> = {
  WINTER: {
    title: "Методика определения дополнительных затрат при производстве работ в зимнее время (приказ Минстроя России от 25.05.2021 N 325/пр)",
    url: "https://tu78.rosim.gov.ru/app/uploads/2026/04/730e05_prikaz-25.05.2021-n-325.pdf",
    edition: "ред. приказа от 21.03.2025 N 170/пр",
  },
  TEMPORARY: {
    title: "Методика определения затрат на строительство временных зданий и сооружений (приказ Минстроя России от 19.06.2020 N 332/пр)",
    url: "https://agentstvotek.ru/upload/files/Приказ 19.06.2020 N 332_пр (ред. от 13.08...).pdf",
    edition: "ред. приказа от 13.08.2024 N 534/пр (официальная публикация: publication.pravo.gov.ru/Document/View/0001202010300022)",
  },
  CONDITIONS: {
    title: "Методика определения сметной стоимости строительства (приказ Минстроя России от 04.08.2020 N 421/пр), приложение N 10, п. 52-62",
    url: "https://www.gosexpert53.ru/upload/medialibrary/bbd/udao5vo64xt7i0nkgwx62ea94y4ywc6y.pdf",
    edition: "ред. приказа от 30.01.2024 N 55/пр (текст на minstroyrf.gov.ru/docs/74851/)",
  },
  NORTH: {
    title: "Перечень районов Крайнего Севера и местностей, приравненных к районам Крайнего Севера (постановление Правительства РФ от 16.11.2021 N 1946)",
    url: "http://government.ru/docs/all/137437/",
    edition: "действует с 01.01.2022; выписка сверена по зеркалу zakonrf.info",
  },
};

function wordsOf(context: LimitedContext): string[] {
  return normalizeRegionText(
    [context.address, context.customerName, context.subject].filter((part) => (part ?? "") !== "").join(" . "),
  )
    .split(" ")
    .filter((word) => word !== "");
}

/** Субъект закупки: регион из базы либо найденный в адресе. */
function subjectOf(context: LimitedContext): string | null {
  const region = context.region ?? "";
  if (region !== "" && region !== UNKNOWN_REGION) return region;
  const fromAddress = regionFromAddress(context.address ?? "");
  return fromAddress === UNKNOWN_REGION ? null : fromAddress;
}

/** Записи о северности территории: РКС и МПРКС, районные коэффициенты и надбавки к труду. */
function northNormatives(north: NonNullable<LimitedContext["north"]>): AppliedNormative[] {
  const result: AppliedNormative[] = [];
  const basis = describeNorthBasis({ zone: north.zone, basis: north.basis, matched: north.matched ?? null });
  const source =
    "Постановление Правительства РФ от 16.11.2021 N 1946 (перечень); Приказ Минстроя России от 21.12.2020 N 812/пр, п. 4, 6, 8 и приложение";
  if (north.zone !== "TERRITORY") {
    const label = north.zone === "RKS" ? "районы Крайнего Севера (РКС)" : "местности, приравненные к районам Крайнего Севера (МПРКС)";
    result.push({
      code: "NORTH",
      title: "Районы Крайнего Севера",
      text: `Территория закупки относится к: ${label}. Нормативы накладных расходов взяты по колонке ${north.zone === "RKS" ? "РКС" : "МПРКС"} приложения к 812/пр; сметная прибыль по приказу 774/пр — одно значение на все территории`,
      value: north.zone === "RKS" ? "колонка РКС" : "колонка МПРКС",
      source,
      applied: true,
      ...(north.basis === "ZONE" ? { assumption: `муниципалитет не определён: ${basis}` } : {}),
    });
    result.push({
      code: "NORTH_WAGE",
      title: "Районный коэффициент и северная надбавка к оплате труда",
      text: "Не начисляются повторно: в сметную цену затрат труда по ценовой зоне ФГИС ЦС они уже входят (приказ Минстроя от 01.07.2022 N 534/пр, п. 8 и приложение 3, п. 2 «в»); текущие цены и ставки зоны берутся как есть",
      value: "уже в ставках",
      source: "Приказ Минстроя России от 01.07.2022 N 534/пр, п. 8, приложение 3",
      applied: false,
      reason: "учтены в текущих ставках оплаты труда и ценах Минстроя по ценовой зоне",
    });
  } else if (north.basis === "UNDETERMINED") {
    result.push({
      code: "NORTH",
      title: "Районы Крайнего Севера",
      text: "Субъект закупки частично входит в перечень районов Крайнего Севера и местностей, приравненных к ним; муниципалитет по закупке не определён",
      value: "обычная территория",
      source,
      applied: false,
      reason: `северность не определена (${basis}): накладные расходы начислены по колонке обычной территории; для РКС и МПРКС они выше`,
      missingData: true,
    });
  }
  return result;
}

/**
 * Параметры расчёта по выбору пользователя.
 *
 * `base` — параметры без начислений (НДС, резервные НР и СП). Без указанных опций они возвращаются как
 * были: тот же `limited` (нули, прежняя подпись), нет условий работ, нет записей о нормативах.
 */
export function resolveLimited(
  options: EstimateOptions,
  context: LimitedContext,
): ResolvedLimited {
  const applied: AppliedNormative[] = [];
  const sources: EstimateSource[] = [];
  const addSource = (key: keyof typeof SOURCES): void => {
    const source = SOURCES[key] as EstimateSource;
    if (!sources.some((item) => item.url === source.url)) sources.push(source);
  };

  if (context.north !== null && context.north !== undefined) {
    const entries = northNormatives(context.north);
    if (entries.length > 0) {
      applied.push(...entries);
      addSource("NORTH");
    }
  }

  if (!hasLimitedOptions(options)) {
    return {
      limited: { winterSurchargePercent: 0, temporaryStructuresPercent: 0, source: NO_LIMITED_SOURCE },
      workConditions: undefined,
      appliedNormatives: applied,
      sources,
    };
  }

  const kind = workKindById(options.workKind);
  const subject = subjectOf(context);
  const words = wordsOf(context);

  const winter = computeWinterSurcharge({
    kind,
    subject,
    words,
    partId: options.winterPartId,
    winterWork: options.winterWork,
    period: options.workPeriod,
  });
  const temporary = computeTemporaryStructures(kind);
  applied.unshift(winter.applied, temporary.applied);
  addSource("WINTER");
  addSource("TEMPORARY");

  let workConditions: WorkConditionsApplication | undefined;
  if (options.phase !== null && (options.conditionIds.length > 0 || options.newConstructionNorms)) {
    workConditions = {
      phase: options.phase,
      conditionIds: options.conditionIds,
      newConstructionNorms: options.newConstructionNorms,
    };
    addSource("CONDITIONS");
  }

  const parts: string[] = [];
  if (winter.applied.applied) parts.push(`зимнее удорожание ${winter.applied.value}`);
  if (temporary.applied.applied) parts.push(`временные здания ${temporary.applied.value}`);
  const source =
    parts.length === 0
      ? "Зимнее удорожание и временные здания не начислялись: см. причины в нормативах расчёта"
      : `По выбору пользователя: ${parts.join(", ")} (ГСН-методики 325/пр и 332/пр, строки — в нормативах расчёта)`;

  return {
    limited: {
      winterSurchargePercent: winter.percent,
      temporaryStructuresPercent: temporary.percent,
      source,
    },
    workConditions,
    appliedNormatives: applied,
    sources,
  };
}
