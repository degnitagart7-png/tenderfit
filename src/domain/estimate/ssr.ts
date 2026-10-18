import { computeForecastInflation, type InflationResult, type SsrPeriodInput } from "@/domain/estimate/forecastInflation";
import { roundTo } from "@/domain/estimate/resourceKinds";
import { PURPOSE_LABELS, reserveRate, SSR } from "@/domain/estimate/ssrNormatives";
import type { ObjectPurpose, SsrGroupId, SsrScope } from "@/domain/estimate/ssrTypes";
import type { EstimateDocument } from "@/domain/estimate/types";

/**
 * Сводный сметный расчёт (ССР) по нашей локальной смете и «наша оценка НМЦК».
 *
 * Зачем. Итог нашего расчёта — локальная смета плюс временные здания, зимнее удорожание и НДС. НМЦК по
 * 44-ФЗ на строительство считается иначе: по сводному сметному расчёту (главы 1-12, резерв на
 * непредвиденные работы и затраты, НДС — 421/пр, глава IX) и в прогнозном уровне цен периода работ
 * (841/пр, п. 22-23). Поэтому сравнивать НМЦК нужно не с голой ЛСР, а с ценой контракта, построенной так же.
 *
 * Два слоя поверх неизменной сметы (итоги `computeTotals` не трогаются):
 * 1. ССР в текущем уровне цен: главы, итоги по главам 1-7, 1-8, 1-9, 1-12 (п. 143), резерв за итогом глав
 *    1-12 (п. 142, 179), НДС (п. 180-181). Считаются только главы, которые у нас есть: локальные сметы
 *    (глава 2 или заданные), временные здания (8), зимнее удорожание (9, строка 2.1 приложения 9).
 *    Главы 1 и 10-12 не оцениваются — исходных данных нет, и три из них (10-12) оплачивает заказчик.
 * 2. «Наша оценка НМЦК» — цена контракта подрядчика по 841/пр: главы подрядчика, резерв, индекс прогнозной
 *    инфляции (п. 22, подп. «б»), НДС. Главы заказчика (10-12) и строки заказчика главы 9 в неё не входят
 *    (п. 21: «работы и услуги, относящиеся к предмету закупки»).
 *
 * Порядок: резерв считается от итога глав (п. 179), инфляция умножает показатели глав вместе с резервом
 * (резерв — строка расчёта НМЦК, приложение 4 к 841/пр), НДС — на итог с резервом и инфляцией. Умножения
 * переставимы, поэтому порядок не влияет на итог. Проверка по закупке 0134300025826000377: 1 625 720 ₽ ×
 * 1,02 × 1,0045 × 1,22 = 2 032 150 ₽ против НМЦК 2 032 153,32 ₽ (остаток — округление 1 625 720).
 *
 * Модуль чистый: ни сети, ни хранилища, ни `Date.now()`.
 */

/** Графы 4-8 сводного сметного расчёта, ₽. */
export interface SsrColumns {
  /** Графа 4: строительные (ремонтно-строительные) работы. */
  readonly construction: number;
  /** Графа 5: монтажные работы. */
  readonly installation: number;
  /** Графа 6: оборудование. */
  readonly equipment: number;
  /** Графа 7: прочие затраты. */
  readonly other: number;
  /** Графа 8: всего. */
  readonly total: number;
}

export const ZERO_COLUMNS: SsrColumns = { construction: 0, installation: 0, equipment: 0, other: 0, total: 0 };

export type SsrLineSource = "LOCAL_ESTIMATE" | "TEMPORARY" | "WINTER";

export interface SsrLine {
  readonly id: string;
  readonly chapter: number;
  readonly title: string;
  readonly source: SsrLineSource;
  readonly amounts: SsrColumns;
  /** Пункт приказа, по которому строка попала в главу. */
  readonly ref: string;
  readonly note?: string;
}

export interface SsrChapter {
  readonly number: number;
  /** Наименование главы по 421/пр: с заглавной буквы. */
  readonly title: string;
  readonly shortTitle: string;
  readonly scope: SsrScope;
  readonly lines: readonly SsrLine[];
  readonly amounts: SsrColumns;
  /** Глава посчитана нами (есть строки); иначе — не оценивалась. */
  readonly computed: boolean;
  /** Что с главой: почему не посчитана или входит ли в цену контракта. */
  readonly note: string;
}

export interface SsrGroupTotal {
  readonly id: SsrGroupId;
  readonly label: string;
  readonly amounts: SsrColumns;
}

export type PurposeBasis = "USER" | "WORK_KIND" | "DEFAULT";

export interface SsrPurpose {
  readonly value: ObjectPurpose;
  readonly label: string;
  readonly basis: PurposeBasis;
  /** Почему именно такое назначение. */
  readonly note: string;
}

export interface SsrReserve {
  readonly purpose: ObjectPurpose;
  /** Размер резерва, % (предельный по п. 179). */
  readonly percent: number;
  /** База: итог глав 1-12, ₽ (наши главы). */
  readonly base: number;
  readonly amounts: SsrColumns;
  readonly ref: string;
}

export type SsrContractRowId = "LOCAL" | "TEMPORARY" | "WINTER" | "RESERVE" | "INFLATION" | "VAT";

export interface SsrContractRow {
  readonly id: SsrContractRowId;
  readonly label: string;
  readonly amount: number;
  /** Как получена строка: проценты, индекс, пункт. */
  readonly note: string;
}

/** Наша оценка НМЦК: цена контракта подрядчика по 841/пр. */
export interface SsrNmcEstimate {
  readonly rows: readonly SsrContractRow[];
  /** Главы подрядчика с резервом, до инфляции и НДС. */
  readonly baseWithReserve: number;
  readonly inflation: InflationResult;
  readonly beforeVat: number;
  readonly vatPercent: number;
  readonly vat: number;
  readonly total: number;
}

export type SsrAssumptionCode = "PURPOSE_DEFAULT" | "PERIOD_UNKNOWN" | "INFLATION_NOT_COMPUTED" | "PRICE_DATE_ASSUMED" | "INFLATION_CONVENTION";

export interface SsrAssumption {
  readonly code: SsrAssumptionCode;
  readonly text: string;
  /** Допущение двигает цену: идёт в «Надёжность расчёта». */
  readonly affectsPrice: boolean;
}

export interface SsrResult {
  readonly status: "COMPUTED" | "EMPTY";
  readonly chapters: readonly SsrChapter[];
  readonly groups: readonly SsrGroupTotal[];
  readonly purpose: SsrPurpose;
  readonly reserve: SsrReserve;
  /** Итог глав 1-12 с резервом, ₽. */
  readonly afterReserve: SsrColumns;
  readonly vatPercent: number;
  /** ССР в текущем уровне цен: НДС за итогом. */
  readonly full: { readonly beforeVat: number; readonly vat: number; readonly total: number };
  readonly nmc: SsrNmcEstimate;
  readonly assumptions: readonly SsrAssumption[];
  /** Какие главы исключены из цены контракта и почему — для подписи. */
  readonly excluded: readonly string[];
}

export interface SsrInput {
  readonly document: EstimateDocument;
  /** Назначение, выбранное пользователем; null — по виду работ или по умолчанию. */
  readonly purpose: ObjectPurpose | null;
  /** Вид работ из `workKinds.ts`: от него зависит назначение по умолчанию. */
  readonly workKind: string | null;
  readonly period: SsrPeriodInput | null;
  /** ISO-дата определения НМЦК (дата извещения); null — неизвестна. */
  readonly priceDate: string | null;
  /** ISO-дата «сегодня». */
  readonly today: string;
  /** Глава (2-7) для каждого раздела нашей сметы по заголовку; нет — глава 2. */
  readonly sectionChapters?: Readonly<Record<string, number>>;
}

/* ------------------------------ Назначение объекта ------------------------------ */

/**
 * Виды работ, которые 421/пр (п. 179, подп. «б») относит к 3-процентному резерву: линейные объекты —
 * сети, дороги, набережные, воздушные линии электропередачи. Производственный объект среди видов работ
 * один: производственный объект, обслуживающий жилищно-коммунальное хозяйство.
 */
const LINEAR_KINDS = /^(?:CR_NET_|CR_ROAD_|CR_EMBANKMENT|NC_NET_|NC_POWER_LINE)/u;
const PRODUCTION_KINDS = /^CR_PROD_/u;

export function purposeOfWorkKind(kindId: string | null): ObjectPurpose | null {
  if (kindId === null) return null;
  if (LINEAR_KINDS.test(kindId) || PRODUCTION_KINDS.test(kindId)) return "PRODUCTION";
  return "NON_PRODUCTION";
}

export function resolvePurpose(selected: ObjectPurpose | null, workKind: string | null): SsrPurpose {
  if (selected !== null) {
    return {
      value: selected,
      label: PURPOSE_LABELS[selected],
      basis: "USER",
      note: "назначение объекта выбрано пользователем",
    };
  }
  const byKind = purposeOfWorkKind(workKind);
  if (byKind !== null) {
    return {
      value: byKind,
      label: PURPOSE_LABELS[byKind],
      basis: "WORK_KIND",
      note:
        byKind === "PRODUCTION"
          ? "по виду работ: линейный или производственный объект (п. 179, подп. «б» 421/пр)"
          : "по виду работ: здание непроизводственного назначения (п. 179, подп. «а» 421/пр)",
    };
  }
  return {
    value: "NON_PRODUCTION",
    label: PURPOSE_LABELS.NON_PRODUCTION,
    basis: "DEFAULT",
    note: "назначение объекта не указано: принято непроизводственное, меньший из размеров резерва (2 %); для производственного объекта и линейных объектов предел 3 %",
  };
}

/* ------------------------------ Расчёт ------------------------------ */

function columns(construction: number, other = 0): SsrColumns {
  const c = roundTo(construction, 2);
  const o = roundTo(other, 2);
  return { construction: c, installation: 0, equipment: 0, other: o, total: roundTo(c + o, 2) };
}

function addColumns(left: SsrColumns, right: SsrColumns): SsrColumns {
  return {
    construction: roundTo(left.construction + right.construction, 2),
    installation: roundTo(left.installation + right.installation, 2),
    equipment: roundTo(left.equipment + right.equipment, 2),
    other: roundTo(left.other + right.other, 2),
    total: roundTo(left.total + right.total, 2),
  };
}

function scaleColumns(value: SsrColumns, factor: number): SsrColumns {
  const construction = roundTo(value.construction * factor, 2);
  const installation = roundTo(value.installation * factor, 2);
  const equipment = roundTo(value.equipment * factor, 2);
  const other = roundTo(value.other * factor, 2);
  return { construction, installation, equipment, other, total: roundTo(construction + installation + equipment + other, 2) };
}

function sumColumns(items: readonly SsrColumns[]): SsrColumns {
  return items.reduce(addColumns, ZERO_COLUMNS);
}

/** «Подготовка территории …» с заглавной буквы. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function chapterNote(scope: SsrScope, computed: boolean, number: number): string {
  if (computed) {
    return number === 9
      ? "Входит в цену контракта: зимнее удорожание — строка 2.1 приложения 9 (затраты подрядчика)"
      : "Входит в цену контракта подрядчика";
  }
  if (scope === "CUSTOMER") return "Затраты заказчика: не оцениваются и в цену контракта подряда не входят";
  if (scope === "PARTIAL") return "Не оценивалась: нет исходных данных; цена контракта включает только строки подрядчика";
  return "Не оценивалась: по этой главе нет локальных смет";
}

export function buildSsr(input: SsrInput): SsrResult {
  const { document } = input;
  const totals = document.totals;
  const vatPercent = document.parameters.vatPercent;
  const chapterOfSection = (title: string): number => {
    const chosen = input.sectionChapters?.[title];
    return chosen !== undefined && chosen >= 2 && chosen <= 7 ? chosen : 2;
  };

  const lines: SsrLine[] = [];
  document.sections.forEach((section, index) => {
    if (section.lines.length === 0 && section.workCost <= 0) return;
    const chapter = chapterOfSection(section.title);
    lines.push({
      id: `LS-${String(index + 1)}`,
      chapter,
      title: `Локальная смета: ${section.title}`,
      source: "LOCAL_ESTIMATE",
      amounts: columns(section.workCost),
      ref: chapter === 2 ? "421/пр, п. 146-147" : `421/пр, п. 146, 148-152`,
      note: `${String(section.lines.length)} поз.; прямые затраты, накладные расходы, сметная прибыль`,
    });
  });
  if (totals.temporaryStructures > 0) {
    const percent = document.parameters.limited.temporaryStructuresPercent;
    lines.push({
      id: "TEMP",
      chapter: 8,
      title: "Временные здания и сооружения",
      source: "TEMPORARY",
      amounts: columns(totals.temporaryStructures),
      ref: "421/пр, п. 153-157; 332/пр",
      note: `${String(percent).replace(".", ",")} % от итога СМР глав 1-7 (графы 4, 5 и 8, п. 157, подп. «а»)`,
    });
  }
  if (totals.winterSurcharge > 0) {
    const percent = document.parameters.limited.winterSurchargePercent;
    lines.push({
      id: "WINTER",
      chapter: 9,
      title: "Дополнительные затраты при производстве работ в зимнее время",
      source: "WINTER",
      amounts: columns(totals.winterSurcharge),
      ref: "421/пр, приложение 9, строка 2.1; 325/пр",
      note: `${String(percent).replace(".", ",")} % от СМР с временными зданиями (графы 4, 5 и 8)`,
    });
  }

  const chapters: SsrChapter[] = SSR.chapters.map((norm) => {
    const own = lines.filter((line) => line.chapter === norm.number);
    const computed = own.length > 0;
    return {
      number: norm.number,
      title: capitalize(norm.title),
      shortTitle: norm.shortTitle,
      scope: norm.scope,
      lines: own,
      amounts: sumColumns(own.map((line) => line.amounts)),
      computed,
      note: chapterNote(norm.scope, computed, norm.number),
    };
  });

  const groups: SsrGroupTotal[] = SSR.groupTotals.map((group) => ({
    id: group.id,
    label: group.label,
    amounts: sumColumns(chapters.filter((chapter) => chapter.number >= group.from && chapter.number <= group.to).map((chapter) => chapter.amounts)),
  }));
  const all = (groups.find((group) => group.id === "1-12") as SsrGroupTotal).amounts;

  const purpose = resolvePurpose(input.purpose, input.workKind);
  const rate = reserveRate(purpose.value);
  const reserveAmounts = scaleColumns(all, rate.percent / 100);
  const reserve: SsrReserve = {
    purpose: purpose.value,
    percent: rate.percent,
    base: all.total,
    amounts: reserveAmounts,
    ref: rate.citation.ref,
  };
  const afterReserve = addColumns(all, reserveAmounts);
  const vatFull = roundTo((afterReserve.total * vatPercent) / 100, 2);

  // Цена контракта: те же главы подрядчика, в прогнозном уровне цен.
  const inflation = computeForecastInflation({ period: input.period, priceDate: input.priceDate, today: input.today });
  const inflationAmount = roundTo(afterReserve.total * (inflation.index - 1), 2);
  const beforeVat = roundTo(afterReserve.total + inflationAmount, 2);
  const vat = roundTo((beforeVat * vatPercent) / 100, 2);
  const localAmount = sumColumns(chapters.filter((chapter) => chapter.number >= 2 && chapter.number <= 7).map((chapter) => chapter.amounts)).total;
  const rows: SsrContractRow[] = [
    {
      id: "LOCAL",
      label: "Локальные сметы",
      amount: localAmount,
      note: "главы 2-7: работы подрядчика по ведомости объёмов, текущие цены Минстроя",
    },
    {
      id: "TEMPORARY",
      label: "Временные здания и сооружения",
      amount: chapters[7]?.amounts.total ?? 0,
      note: totals.temporaryStructures > 0 ? "глава 8, 332/пр" : "не начислены (не выбран вид работ или норматива нет)",
    },
    {
      id: "WINTER",
      label: "Зимнее удорожание",
      amount: chapters[8]?.amounts.total ?? 0,
      note: totals.winterSurcharge > 0 ? "глава 9, строка 2.1 приложения 9, 325/пр" : "не начислено (не выбран вид работ, нет зимних месяцев или сроки неизвестны)",
    },
    {
      id: "RESERVE",
      label: "Непредвиденные затраты",
      amount: reserveAmounts.total,
      note: `${String(rate.percent)} % от итога глав (${rate.citation.ref}); ${purpose.label.toLowerCase()}`,
    },
    {
      id: "INFLATION",
      label: "Прогнозная инфляция",
      amount: inflationAmount,
      note: inflation.applied ? `индекс ${inflation.index.toFixed(4).replace(".", ",")} (841/пр, п. 22-23)` : (inflation.reason ?? "не применена"),
    },
    {
      id: "VAT",
      label: "НДС",
      amount: vat,
      note: `${String(vatPercent)} % на итог с резервом и инфляцией (421/пр, п. 181)`,
    },
  ];
  const nmc: SsrNmcEstimate = {
    rows,
    baseWithReserve: afterReserve.total,
    inflation,
    beforeVat,
    vatPercent,
    vat,
    total: roundTo(beforeVat + vat, 2),
  };

  const assumptions: SsrAssumption[] = [];
  if (purpose.basis === "DEFAULT") {
    assumptions.push({ code: "PURPOSE_DEFAULT", text: `Резерв на непредвиденные: ${purpose.note}.`, affectsPrice: true });
  }
  if (!inflation.applied) {
    assumptions.push({
      code: input.period === null ? "PERIOD_UNKNOWN" : "INFLATION_NOT_COMPUTED",
      text: `Прогнозная инфляция не применена: ${inflation.reason ?? "индекс не рассчитан"}. НМЦК заказчика в прогнозном уровне цен выше нашей оценки на индекс (обычно 0,5-10 %).`,
      affectsPrice: true,
    });
  } else {
    if (inflation.baseAssumed) {
      assumptions.push({
        code: "PRICE_DATE_ASSUMED",
        text: "Дата определения НМЦК неизвестна: индекс отсчитан от месяца начала работ.",
        affectsPrice: false,
      });
    }
    assumptions.push({
      code: "INFLATION_CONVENTION",
      text: `Индекс прогнозной инфляции ${inflation.index.toFixed(4).replace(".", ",")}: ${inflation.assumptions.join("; ")}.`,
      affectsPrice: false,
    });
  }

  const excluded = chapters
    .filter((chapter) => chapter.scope === "CUSTOMER" || (chapter.scope === "PARTIAL" && !chapter.computed))
    .map((chapter) => `глава ${String(chapter.number)} «${chapter.shortTitle}»`);

  return {
    status: totals.workCost > 0 ? "COMPUTED" : "EMPTY",
    chapters,
    groups,
    purpose,
    reserve,
    afterReserve,
    vatPercent,
    full: { beforeVat: afterReserve.total, vat: vatFull, total: roundTo(afterReserve.total + vatFull, 2) },
    nmc,
    assumptions,
    excluded,
  };
}

/* ------------------------------ Сравнение с НМЦК закупки ------------------------------ */

export interface SsrNmcComparison {
  /** НМЦК закупки, ₽, как объявлена. */
  readonly nmc: number;
  readonly nmcIncludesVat: boolean;
  /** Наша оценка в тех же терминах, что НМЦК (с НДС или без). */
  readonly ours: number;
  /** Наша минус НМЦК закупки, ₽. */
  readonly diff: number;
  /** Разница от НМЦК закупки, %. */
  readonly diffPercent: number;
  /** Та же оценка, но без НДС — для сравнения с расчётом по смете. */
  readonly oursBeforeVat: number;
}

export function compareSsrWithNmc(result: SsrResult, nmc: number | null, nmcIncludesVat: boolean): SsrNmcComparison | null {
  if (nmc === null || !(nmc > 0) || result.status === "EMPTY") return null;
  const ours = nmcIncludesVat ? result.nmc.total : result.nmc.beforeVat;
  const diff = roundTo(ours - nmc, 2);
  return {
    nmc,
    nmcIncludesVat,
    ours,
    diff,
    diffPercent: roundTo((diff / nmc) * 100, 2),
    oursBeforeVat: result.nmc.beforeVat,
  };
}
