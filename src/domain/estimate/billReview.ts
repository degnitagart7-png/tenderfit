import { LOAD_PRICE_BOOK } from "@/domain/estimate/calculate";
import { GENERATED_LABEL } from "@/domain/estimate/generatedItems";
import type { BimSelection } from "@/domain/estimate/calculateBim";
import { findNorms, normKey, reviewVerdict, type NormMatch, type NormSearchIndex } from "@/domain/estimate/matchNorms";
import { normalizeText } from "@/domain/estimate/normalize";
import type { NorthZone } from "@/domain/estimate/overheadNormatives";
import type {
  AppliedNormative,
  BillOfWorkItem,
  BillOfWorkSection,
  EstimateLine,
  EstimateMethodBasis,
} from "@/domain/estimate/types";
import { baseUnitOf, deriveUnitDivisor } from "@/domain/estimate/units";
import { variantsOf } from "@/domain/estimate/volumeCrossCheck";

/**
 * «Ведомость и нормы»: что показывать о каждой позиции, кроме её стоимости.
 *
 * Расчёт сам выбирает норму под позицию. Человеку, который проверяет смету, нужны три ответа:
 * какая норма взята, насколько подбору можно верить и что выбрать вместо неё. Первый ответ
 * лежит в строке сметы, остальные считаются здесь — по тем же функциям подбора, что и сам расчёт
 * (`findNorms`, `needsReview`), чтобы подсветка «проверьте» совпадала с решением, которое принял
 * расчёт, а не жила своей жизнью.
 *
 * Модуль чистый; индекс норм ему передают.
 */

/** Как выбрана норма позиции. */
export type NormBasis =
  /** По шифру расценки из документа (подсказка строки или сметы заказчика). */
  | "CODE"
  /** Поиском по наименованию работы. */
  | "NAME"
  /** Человеком — через правку ведомости. */
  | "MANUAL"
  /** «ИИ-сметчиком»: модель выбрала норму среди кандидатов кода, код проверил шифр и единицу (`normPick.ts`). */
  | "AI"
  /** Нормы нет: цена по справочнику, цена заказчика, своя цена или услуга ФГИС ЦС. */
  | "NONE";

/** Кандидат на роль нормы: что показывается в списке «другие нормы». */
export interface NormCandidate {
  readonly code: string;
  readonly baseType: string;
  readonly name: string;
  /** Единица нормы, например «100 м3». */
  readonly unit: string;
  readonly coverage: number;
  readonly strictCoverage: number;
  /** Единица нормы сходится с единицей позиции: иначе позиция в расчёт не войдёт. */
  readonly unitOk: boolean;
}

/**
 * Материал нормы «по проекту»: расход «П» или ресурс без марки. Его количество и цена лежат в проекте, поэтому в расчёт он не
 * входит, пока человек их не назовёт (правка «материал»).
 */
export interface ProjectMaterialHint {
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  /** Количество на весь объём позиции, которое можно предложить; null — предложить нечего. */
  readonly suggestedQuantity: number | null;
  /** Откуда предложение: «по норме» (в норме расход есть) или «предложено» (1 на единицу позиции, когда единицы равны). */
  readonly suggestion: "NORM" | "ASSUMED" | null;
  /** Количество и цена уже названы человеком. */
  readonly supplied: boolean;
}

/** Сведения о подборе нормы одной позиции. */
export interface BillRowInfo {
  readonly itemId: string;
  readonly basis: NormBasis;
  /** Покрытие запроса, 0–1; только для подбора по наименованию. */
  readonly coverage: number | null;
  readonly strictCoverage: number | null;
  /** Подбор слабый, или нормы нет и деньги держатся на цене заказчика: подсветить «проверьте». */
  readonly review: boolean;
  /** Почему «проверьте»: «в норме есть «опалубки», в работе — нет». Нет поля — причина не названа. */
  readonly reviewReason?: string | null;
  /** Другие нормы под ту же работу, лучшие первыми. Выбранная среди них не повторяется. */
  readonly alternatives: readonly NormCandidate[];
  /** Материалы «по проекту» нормы позиции. Нет поля — таких нет. Подсвечиваются отдельно от «проверьте» подбора. */
  readonly projectMaterials?: readonly ProjectMaterialHint[];
}

/**
 * Снимок ведомости, который воркер кладёт в отчёт расчёта.
 *
 * Без него править нечего: в документе сметы нет ни наименований работ (там наименования
 * норм), ни объёмов в разобранном виде, ни кодов ресурсов и цен заказчика. Снимок — это
 * ведомость ровно в том виде, в каком она ушла в расчёт, плюс то, чем расчёт можно повторить
 * без модели: ценовая зона и нормативы, которые не зависят от строк.
 */
export interface EstimateBillSnapshot {
  readonly version: 1;
  /** Позиции ведомости после привязки шифров, цен заказчика и делителей единиц. */
  readonly sections: readonly BillOfWorkSection[];
  readonly rows: readonly BillRowInfo[];
  /** Чем повторить расчёт; нет — расчёт сделан без записи этих данных, пересчёт недоступен. */
  readonly calc?: {
    readonly priceZoneId: number;
    readonly northZone: NorthZone;
    /** Нормативы сверх норм до описания условий работ по строкам: зимнее, временные здания, Север. */
    readonly resolvedNormatives: readonly AppliedNormative[];
    /**
     * Расчёт базисно-индексным методом: индексы письма, которыми пересчитаны расценки, и откуда выбран метод. Есть — пересчёт после
     * правок идёт по ФЕР-2020 с теми же индексами, а не по ресурсным ценам зоны.
     */
    readonly bim?: {
      readonly selection: BimSelection;
      readonly basis: EstimateMethodBasis;
      readonly basisNote: string;
      readonly customerBase: "FER" | "TER";
      readonly region: string;
      readonly priceZone: string;
    };
  };
}

/** Сколько вариантов нормы показывается в списке «другие нормы». */
export const MAX_ALTERNATIVES = 5;
/** Сколько из них — из сборника ГЭСН 46, когда работа — демонтаж, разборка или снос. */
const DEMOLITION_ALTERNATIVES = 2;
/**
 * Сборник ГЭСН 46 «Работы при реконструкции зданий и сооружений»: там лежат разборка и демонтаж
 * конструкций зданий. Подбор по словам «демонтаж наружных стен» уходит в опалубку, а нужная норма
 * («Разборка: кирпичных стен») лежит здесь, поэтому в варианты она добавляется отдельным поиском.
 */
const DEMOLITION_COLLECTION = "46";
const DEMOLITION_BOOK = "ГЭСН";
const DEMOLITION_WORK = /демонтаж|разборк|снос/u;
/** Кандидат с покрытием ниже этого порога — шум: случайное слово, а не та же работа. */
const MIN_ALTERNATIVE_COVERAGE = 0.25;

function candidateOf(item: BillOfWorkItem, match: NormMatch): NormCandidate {
  const units = variantsOf(item).map((variant) => variant.unit);
  return {
    code: match.norm.code,
    baseType: match.norm.baseType,
    name: match.norm.fullName,
    unit: match.norm.unit,
    coverage: match.coverage,
    strictCoverage: match.strictCoverage,
    unitOk: units.some((unit) => deriveUnitDivisor(unit, match.norm.unit) !== null),
  };
}

/**
 * Нормы сборника ГЭСН 46 под демонтаж, разборку или снос. Сборник называет эти работы «разборка»,
 * а в ведомости чаще «демонтаж» и «снос»; поиск по слову «демонтаж» находит там нормы, у которых оно
 * стоит в тексте условий («устройство въездов … демонтаж перекрытия»), а не саму разборку. Поэтому
 * ищется работа со словом «разборка» вместо «демонтаж»/«снос»; исходная формулировка — только если
 * так нашлось меньше нужного. Лучшие первыми.
 */
function demolitionCandidates(index: NormSearchIndex, workName: string): NormMatch[] {
  const asDisassembly = workName.replace(/(?:демонтаж|снос)\p{L}*/giu, "разборка");
  const search = (query: string): NormMatch[] =>
    findNorms(index, {
      workName: query,
      collectionCode: DEMOLITION_COLLECTION,
      normBaseType: DEMOLITION_BOOK,
      limit: DEMOLITION_ALTERNATIVES + 2,
    });

  const found = search(asDisassembly);
  if (found.length >= DEMOLITION_ALTERNATIVES || asDisassembly === workName) return found;
  const keys = new Set(found.map((match) => match.norm.code));
  return [...found, ...search(workName).filter((match) => !keys.has(match.norm.code))];
}

/**
 * Кандидаты на роль нормы: поиск по всей базе и, для демонтажа, разборки и сноса, отдельный поиск
 * по сборнику ГЭСН 46. Кандидаты сборника идут первыми (но не больше `DEMOLITION_ALTERNATIVES`),
 * остальные — по ранжированию подбора; повторов нет, выбранная норма исключена.
 */
function alternativesFor(
  index: NormSearchIndex,
  item: BillOfWorkItem,
  found: readonly NormMatch[],
  chosenKey: string | null,
): NormCandidate[] {
  const keyOf = (match: NormMatch): string => `${match.norm.baseType}|${match.norm.code}`;
  const usable = (match: NormMatch): boolean => keyOf(match) !== chosenKey && match.coverage >= MIN_ALTERNATIVE_COVERAGE;

  const fromCollection = DEMOLITION_WORK.test(normalizeText(item.workName))
    ? demolitionCandidates(index, item.workName).filter(usable).slice(0, DEMOLITION_ALTERNATIVES)
    : [];

  const seen = new Set<string>();
  const result: NormMatch[] = [];
  for (const match of [...fromCollection, ...found.filter(usable)]) {
    if (seen.has(keyOf(match))) continue;
    seen.add(keyOf(match));
    result.push(match);
    if (result.length >= MAX_ALTERNATIVES) break;
  }
  return result.map((match) => candidateOf(item, match));
}

/** Материалы нормы позиции, у которых нет ни количества, ни цены в самой норме. */
function projectMaterialsOf(
  index: NormSearchIndex,
  item: BillOfWorkItem,
  line: EstimateLine,
): readonly ProjectMaterialHint[] {
  // Позиции ЛСР заказчика несут его суммы (и невидимый остаток отдельной строкой): спрашивать у человека нечего.
  if (item.customerMaterials !== undefined || item.customerResources !== undefined || item.unaccountedOf !== undefined) return [];
  const norm = index.byKey.get(normKey(line.normBaseType, line.normCode));
  if (norm === undefined) return [];
  // Материал, названный человеком, и материал, подобранный ИИ для этой нормы (`aiNormMaterials`), ресурс закрывают: спрашивать нечего.
  const supplied = new Set([
    ...(item.projectMaterials ?? []).map((material) => material.code),
    ...(item.aiNormMaterials ?? [])
      .filter((material) => material.normCode === line.normCode && material.normBaseType === line.normBaseType)
      .map((material) => material.normResourceCode),
  ]);
  const normQuantity = item.quantity / (item.unitDivisor > 0 ? item.unitDivisor : 1);

  return norm.resources
    .filter((resource) => resource.kind === "MATERIAL" && (resource.projectSpecific || resource.quantityNote !== null))
    .map((resource): ProjectMaterialHint => {
      const name = resource.name === "" ? resource.code : resource.name;
      const done = supplied.has(resource.code);
      if (resource.quantity > 0) {
        return { code: resource.code, name, unit: resource.unit, suggestedQuantity: Math.round(resource.quantity * normQuantity * 1e6) / 1e6, suggestion: "NORM", supplied: done };
      }
      const same = baseUnitOf(resource.unit) !== null && baseUnitOf(resource.unit) === baseUnitOf(item.quantityUnit);
      return same
        ? { code: resource.code, name, unit: resource.unit, suggestedQuantity: item.quantity, suggestion: "ASSUMED", supplied: done }
        : { code: resource.code, name, unit: resource.unit, suggestedQuantity: null, suggestion: null, supplied: done };
    });
}

/**
 * Сведения о подборе для всех позиций ведомости.
 *
 * @param items позиции, ушедшие в расчёт (после правок, если они были)
 * @param lines строки сметы по идентификатору позиции; позиции без строки — «не вошло в расчёт»
 * @param manualNorm позиции, у которых норму выбрал человек
 */
export function buildRowInfos(input: {
  readonly items: readonly BillOfWorkItem[];
  readonly lines: ReadonlyMap<string, EstimateLine>;
  readonly index: NormSearchIndex;
  readonly manualNorm?: ReadonlySet<string>;
}): BillRowInfo[] {
  const infoOf = (item: BillOfWorkItem): BillRowInfo => {
    const line = input.lines.get(item.id);
    const normBased = line !== undefined && line.priceSource === undefined;

    // Кандидаты ищутся по наименованию всегда: и когда норма взята по шифру, человеку может
    // понадобиться «а что ещё подходит по смыслу».
    const found = findNorms(input.index, { workName: item.workName, limit: MAX_ALTERNATIVES + 2 });
    const chosenKey = normBased ? `${line.normBaseType}|${line.normCode}` : null;
    const alternatives = alternativesFor(input.index, item, found, chosenKey);

    if (input.manualNorm?.has(item.id) === true && normBased) {
      return { itemId: item.id, basis: "MANUAL", coverage: null, strictCoverage: null, review: false, alternatives };
    }

    if (!normBased) {
      // Норма не участвует: цена заказчика требует проверки, остальное (своя цена, услуга ФГИС) — нет.
      const fallback = line?.priceSource === "CUSTOMER_PRICE";
      return { itemId: item.id, basis: "NONE", coverage: null, strictCoverage: null, review: fallback, alternatives };
    }

    // Материал (поставка): ресурс справочника цен подобран моделью или кодом по наименованию — подпись и «проверьте» из пометки позиции.
    if (item.materialRow !== undefined && item.materialRow.pick !== null) {
      return {
        itemId: item.id,
        basis: item.materialRow.pick === "AI" ? "AI" : "NAME",
        coverage: item.materialRow.coverage,
        strictCoverage: item.materialRow.coverage,
        review: item.materialRow.review,
        reviewReason: item.materialRow.note,
        alternatives: [],
      };
    }

    // Норма выбрана ИИ: шифр уже в позиции, но это не шифр из документа — подпись и «проверьте» берутся из выбора модели.
    if (item.aiNormPick !== undefined) {
      return {
        itemId: item.id,
        basis: "AI",
        coverage: null,
        strictCoverage: null,
        review: item.aiNormPick.review,
        reviewReason: item.aiNormPick.note,
        alternatives,
      };
    }

    if (item.resourceCode !== null || item.normCode !== null) {
      return { itemId: item.id, basis: "CODE", coverage: 1, strictCoverage: 1, review: false, alternatives };
    }

    // Подбор по наименованию: расчёт брал первого кандидата. «Проверьте» — если слов работы в норме мало
    // (покрытие) или в норме есть значимые слова, которых в работе нет («опалубки» у «Демонтаж стен»).
    const top = found[0];
    if (top === undefined) {
      return { itemId: item.id, basis: "NAME", coverage: 0, strictCoverage: 0, review: true, reviewReason: null, alternatives };
    }
    const verdict = reviewVerdict(input.index, item.workName, top);
    // Расценка заказчика из ТСН-2001: норма нашей базы — подбор по смыслу, а не та же расценка. Проверить обязательно, как бы ни совпали слова.
    if (item.foreignBase === "TSN_2001_MOSCOW") {
      return {
        itemId: item.id,
        basis: "NAME",
        coverage: top.coverage,
        strictCoverage: top.strictCoverage,
        review: true,
        reviewReason: `расценка заказчика — ТСН-2001 (Москва), норм ТСН у нас нет: норма ФСНБ-2022 подобрана по наименованию, а не по шифру${verdict.reason == null ? "" : `; ${verdict.reason}`}`,
        alternatives,
      };
    }
    return {
      itemId: item.id,
      basis: "NAME",
      coverage: top.coverage,
      strictCoverage: top.strictCoverage,
      review: verdict.review,
      reviewReason: verdict.reason,
      alternatives,
    };
  };

  return input.items.map((item): BillRowInfo => {
    const base = infoOf(item);
    // Работа, добавленная ИИ сверх ведомости, всегда на проверку: человек решает, нужна ли она (и убирает правкой «Удалить строку»).
    const info =
      item.generated === "AI_IMPLIED"
        ? {
            ...base,
            review: true,
            reviewReason: [item.generatedNote, base.reviewReason].filter((part): part is string => part !== undefined && part !== null && part !== "").join("; "),
          }
        : base;
    const line = input.lines.get(item.id);
    const projectMaterials = line !== undefined && line.priceSource === undefined ? projectMaterialsOf(input.index, item, line) : [];
    return projectMaterials.length > 0 ? { ...info, projectMaterials } : info;
  });
}

/* ------------------------------ как показывать ------------------------------ */

/** Источник цены позиции. */
export type LinePriceSource = "NORM" | "INDEXED" | "FGIS" | "CUSTOMER" | "OWN" | "BIM";

export function linePriceSource(line: EstimateLine): LinePriceSource {
  if (line.priceSource === "OWN_PRICE") return "OWN";
  if (line.priceSource === "CUSTOMER_PRICE") return "CUSTOMER";
  if (line.priceSource === "FGIS_SERVICE") return "FGIS";
  // Базисно-индексный метод: цена расценки ФЕР-2020 на 01.01.2000, умноженная на индекс письма Минстроя.
  if (line.bim !== undefined) return "BIM";
  // Часть ресурсов оценена индексом сплит-формы: текущий уровень цен, но не измеренный по зоне.
  if (line.resources.some((resource) => resource.source === "SPLIT_INDEXED")) return "INDEXED";
  return "NORM";
}

/** Подпись источника цены простыми словами. */
export function priceSourceLabel(line: EstimateLine): string {
  const source = linePriceSource(line);
  if (source === "FGIS") return line.normBaseType === LOAD_PRICE_BOOK ? "ФГИС погрузка" : "ФГИС перевозка";
  return { NORM: "наша норма", INDEXED: "по индексу", FGIS: "ФГИС перевозка", CUSTOMER: "цена заказчика", OWN: "своя цена", BIM: "ФЕР × индекс" }[source];
}

export type BadgeTone = "olive" | "mustard" | "brick" | "neutral" | "accent";

/** Подпись строки, добавленной расчётом или ИИ сверх ведомости («добавлено ИИ», «добавлено расчётом (мусор)»); null — строка из документа или от человека. */
export function generatedBadge(item: Pick<BillOfWorkItem, "generated" | "generatedNote" | "generatedUnpricedReason">): { readonly text: string; readonly tone: BadgeTone; readonly note: string | null } | null {
  if (item.generated === undefined) return null;
  return {
    text: GENERATED_LABEL[item.generated],
    tone: item.generated === "AI_IMPLIED" ? "mustard" : "accent",
    note: item.generatedNote ?? null,
  };
}

/** Уверенность подбора: подпись и цвет. `review` — подсветка «проверьте». */
export interface MatchBadge {
  readonly text: string;
  readonly tone: BadgeTone;
  readonly review: boolean;
  /** Пояснение под подписью: почему «проверьте». */
  readonly note?: string;
}

export function matchBadge(info: BillRowInfo | undefined, line: EstimateLine | undefined): MatchBadge {
  if (line?.priceSource === "OWN_PRICE") return { text: "цена указана вами", tone: "accent", review: false };
  if (line?.priceSource === "FGIS_SERVICE") return { text: "цена услуги ФГИС ЦС", tone: "neutral", review: false };
  if (line?.priceSource === "CUSTOMER_PRICE") {
    return { text: "нормы нет — цена заказчика · проверьте", tone: "mustard", review: true };
  }
  if (info === undefined) return { text: "не определено", tone: "neutral", review: false };
  if (info.basis === "MANUAL") return { text: "выбрано вами", tone: "accent", review: false };
  if (info.basis === "CODE") return { text: "по шифру из документа", tone: "olive", review: false };
  if (info.basis === "AI") {
    // Обоснование модели показывается всегда, а не только при «проверьте»: человеку надо понять, почему выбрана норма с другими словами.
    return {
      text: info.review ? "подобрано ИИ · проверьте" : "подобрано ИИ",
      tone: info.review ? "mustard" : "accent",
      review: info.review,
      ...(info.reviewReason == null ? {} : { note: info.reviewReason }),
    };
  }
  if (info.basis === "NAME") {
    const percent = Math.round((info.coverage ?? 0) * 100);
    return info.review
      ? {
          text: `по наименованию, ${String(percent)} % · проверьте`,
          tone: "mustard",
          review: true,
          ...(info.reviewReason == null ? {} : { note: info.reviewReason }),
        }
      : { text: `по наименованию, ${String(percent)} %`, tone: "olive", review: false };
  }
  return { text: "не определено", tone: "neutral", review: info.review };
}

/** Сколько позиций таблицы просят проверки. */
export function countToReview(
  lines: readonly EstimateLine[],
  rows: ReadonlyMap<string, BillRowInfo>,
): number {
  return lines.filter((line) => matchBadge(rows.get(line.itemId), line).review).length;
}
