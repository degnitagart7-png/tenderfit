import { uniqueTokens } from "@/domain/estimate/normalize";
import { checkMaterialFamily } from "@/domain/estimate/normMaterialFamily";
import type { NormMaterialNeed } from "@/domain/estimate/normPick";
import {
  describeEntry,
  FALLBACK_LEAD,
  FALLBACK_MIN_COVERAGE,
  FALLBACK_MIN_STRICT_COVERAGE,
  findResources,
  isResourcePick,
  MAX_RESOURCE_CANDIDATES,
  RESOURCE_PICK_PREFIX,
  type ResourceEntry,
  type ResourceMatch,
  type ResourcePriceSource,
  type ResourceSearchIndex,
} from "@/domain/estimate/resourceCandidates";
import type { AiNormMaterial, BillOfWorkItem, NormRecord, NormResource } from "@/domain/estimate/types";
import { deriveSupplyDivisor } from "@/domain/estimate/units";

/**
 * Материал нормы «по проекту» для ведомости без сметы заказчика.
 *
 * Зачем. Многие нормы ГЭСН называют основной материал работы общим ресурсом без марки: у расценки 26-01-021-01 «Изоляция плоских и криволинейных
 * поверхностей из пенополиуретана» это «Состав двухкомпонентный на основе полиуретановых смол» с числовым расходом на единицу нормы. Цены на группу
 * в книге нет, и расчёт (`priceResource`) ставил пробел `PROJECT_SPECIFIC_RESOURCE`: основной материал работы выпадал из сметы (заказчик в той
 * же позиции оценил его в 533 702 ₽ — ФСБЦ-14.2.05.03-0020, 300,3 кг). Когда у заказчика есть ЛСР, его строки материалов закрывают эту дыру
 * (`customerMaterialRows`); здесь — случай ведомости без ЛСР.
 *
 * Как устроено. Для пары «позиция + ресурс нормы без марки» с числовым расходом код собирает кандидатов — ресурсы справочника цен, у которых код
 * лежит в группе ресурса нормы или название похоже на название ресурса, работы и нормы; единица кандидата обязана переводиться из единицы ресурса
 * нормы (`deriveSupplyDivisor`). Модель выбирает материал по описанию работы (вид, марка, толщина, плотность) или отвечает «нет»; без модели
 * материал берётся только когда он единственный с высоким покрытием слов названия ресурса нормы. Расход и цену считает расчёт: расход нормы ×
 * объём в единицах нормы, цена зоны — как у любого материала нормы.
 *
 * Группа обязательна. Ресурс нормы «по проекту» обычно несёт код группы («12.1.02.06», «14.2.05.03»). Если в справочнике цен у группы есть записи, кандидаты
 * берутся только из неё, и принять можно только материал из неё (код начинается с кода группы и дефиса или точки) — выбор за пределами группы отклоняется.
 * Шире группы кандидаты ищутся лишь когда у группы записей нет (или код ресурса не группа), и тогда выбор всегда «проверьте». Дальше две проверки ответа:
 * род материала по словам названия (`normMaterialFamily.ts`: битумный лист не заменяется стальным профилированным) и здравость цены (не дороже 5 медиан
 * цен группы и не дороже 5 собственных цен ресурса нормы, если она есть в книге) — не прошёл, значит пробел «проверьте», а не чужие деньги.
 *
 * Чего код не делает никогда. Не придумывает расход: ресурс с расходом «по проекту» без числа (`quantityNote`) остаётся пробелом
 * `QUANTITY_BY_PROJECT`, как и служебный «МАТЕРИАЛЫ (см. приложение)». Не считает материал второй раз: если в ведомости есть отдельная строка материала
 * этой работы (подномер «11.1» под «11», ресурс строки совпал с кандидатом), ресурс остаётся пробелом, а материал стоит поставкой. Не трогает позиции
 * сметы заказчика (там ресурсные строки заказчика) и материалы, названные человеком (`projectMaterials`).
 *
 * Модуль чистый.
 */

/** Группа ресурса нормы без марки: «14.2.05.03», «01.7.12.16» — коды ресурсов этой группы в справочнике цен начинаются с неё и дефиса. */
const GROUP_CODE = /^\d{1,2}(?:\.\d{1,3}){2,4}$/u;
/** Выбор дороже медианы цен группы (или собственной цены ресурса нормы) во столько раз отклоняется как неправдоподобный. */
export const NORM_MATERIAL_MAX_PRICE_RATIO = 5;

/** Код группы ресурса нормы или null, если код — не группа. */
export function resourceGroupOf(resourceCode: string): string | null {
  return GROUP_CODE.test(resourceCode) ? resourceCode : null;
}

/** Ресурс справочника лежит в группе: код начинается с кода группы и дефиса («14.2.05.03-0020») либо точки (подгруппа более длинной группы). */
export function inResourceGroup(code: string, group: string): boolean {
  return code.startsWith(`${group}-`) || code.startsWith(`${group}.`);
}

/** Все записи справочника в группе ресурса нормы, любой единицы; пусто — у группы записей нет или код не группа. */
export function groupEntriesOf(index: ResourceSearchIndex, resourceCode: string): ResourceEntry[] {
  const group = resourceGroupOf(resourceCode);
  return group === null ? [] : index.entries.filter((entry) => inResourceGroup(entry.code, group));
}

/** Цена материала справочника за единицу ресурса нормы, ₽: «т» против «кг» и «100 м2» против «м2» приводятся к единице нормы. null — единица не переводится. */
export function unitPriceInNormUnit(entry: Pick<ResourceEntry, "price" | "unit">, normUnit: string): number | null {
  const divisor = deriveSupplyDivisor(normUnit, entry.unit);
  return divisor !== null && divisor > 0 && Number.isFinite(entry.price) && entry.price > 0 ? entry.price / divisor : null;
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Собственная цена ресурса нормы в книге цен, ₽ за единицу ресурса нормы: у ресурса «по проекту» с кодом группы её обычно нет, но у ресурса с кодом
 * материала («в базе есть, а в смете взят другой») она есть. Базовая цена 2022, а когда её нет, — текущая цена зоны. null — цены нет или единица не переводится.
 */
export function normResourceOwnPrice(book: ResourcePriceSource, resource: Pick<NormResource, "code" | "unit">): number | null {
  for (const price of [book.base.get(resource.code), book.current.get(resource.code)]) {
    if (price === undefined || !(Number.isFinite(price.price) && price.price > 0)) continue;
    const converted = unitPriceInNormUnit({ price: price.price, unit: price.unit.trim() === "" ? resource.unit : price.unit }, resource.unit);
    if (converted !== null) return converted;
  }
  return null;
}

/** Ресурс нормы, под который можно подобрать материал: без марки, с числовым расходом, с единицей. */
export function isOpenNormMaterial(resource: NormResource): boolean {
  return (
    resource.kind === "MATERIAL" &&
    resource.projectSpecific &&
    resource.quantityNote === null &&
    Number.isFinite(resource.quantity) &&
    resource.quantity > 0 &&
    resource.unit.trim() !== ""
  );
}

/** Ресурсы нормы позиции, которым нужен материал: материал, названный человеком, свой — его не трогаем. */
export function openNormMaterials(norm: NormRecord, item: Pick<BillOfWorkItem, "projectMaterials">): NormResource[] {
  const named = new Set((item.projectMaterials ?? []).map((material) => material.code));
  return norm.resources.filter((resource) => isOpenNormMaterial(resource) && !named.has(resource.code));
}

/** Норма так, как её видит модель. */
export function describeNormForPrompt(norm: Pick<NormRecord, "baseType" | "code" | "fullName" | "unit">): string {
  return `${norm.baseType} ${norm.code} «${norm.fullName}», единица нормы ${norm.unit}`;
}

/** Что норма говорит о ресурсе и сколько его на объём позиции — для запроса модели. */
export function normMaterialNeed(item: Pick<BillOfWorkItem, "quantity" | "unitDivisor">, norm: NormRecord, resource: NormResource): NormMaterialNeed {
  const divisor = item.unitDivisor > 0 ? item.unitDivisor : 1;
  const total = (resource.quantity * item.quantity) / divisor;
  return {
    code: resource.code,
    name: resource.name,
    unit: resource.unit,
    quantity: resource.quantity,
    norm: describeNormForPrompt(norm),
    total: Number.isFinite(total) && total > 0 ? Math.round(total * 1e6) / 1e6 : null,
  };
}

/** Единица ресурса справочника переводится из единицы ресурса нормы: «кг» ↔ «т», «м» ↔ «1000 м», «шт» ↔ «100 шт». */
export function normMaterialUnitFits(normUnit: string, catalogUnit: string): boolean {
  const divisor = deriveSupplyDivisor(normUnit, catalogUnit);
  return divisor !== null && divisor > 0;
}

/* ------------------------------ кандидаты ------------------------------ */

export interface NormMaterialSearchInput {
  readonly resourceCode: string;
  readonly resourceName: string;
  /** Единица ресурса нормы. */
  readonly unit: string;
  readonly workName: string;
  readonly remark?: string | null;
  /** Наименование нормы целиком: «Изоляция … из пенополиуретана» несёт материал, которого нет в названии ресурса. */
  readonly normName: string;
  readonly limit?: number;
}

export interface NormMaterialMatches {
  /** Кандидаты для модели: у группы с записями — только её записи, ближайшие к описанию работы первыми; иначе ближайшие по названию ресурса, работы и нормы. */
  readonly matches: readonly ResourceMatch[];
  /** Ближайшие только по названию ресурса нормы (в группе — только из неё): по ним идёт запасной выбор без модели. */
  readonly byResourceName: readonly ResourceMatch[];
  /**
   * `GROUP` — у группы ресурса нормы есть записи в справочнике, кандидаты только из неё; `WIDE` — группы нет или записей у неё нет, кандидаты шире, и любой
   * выбор подсвечивается «проверьте».
   */
  readonly scope: "GROUP" | "WIDE";
}

const joined = (...parts: readonly (string | null | undefined)[]): string => parts.filter((part): part is string => part != null && part.trim() !== "").join(" ");

/**
 * Ресурсы-кандидаты под материал нормы «по проекту». Единица кандидата обязана переводиться из единицы ресурса нормы.
 * Группа кода (если код ресурса нормы — группа вида «14.2.05.03» и в справочнике у неё есть записи): кандидаты только из неё, не больше `limit` (15 по умолчанию),
 * сначала ближайшие по «название ресурса + работа + примечание + норма», потом остальные записи группы; записи вне группы не предлагаются никогда. У группы есть записи,
 * но ни одна не подходит по единице, — кандидатов нет (пробел, а не чужой материал). Группы нет или записей у неё нет — по очереди ближайшие по «название ресурса +
 * работа + примечание», «название ресурса» и «название ресурса + норма» без дублей (`scope` = `WIDE`).
 */
export function collectNormMaterialMatches(index: ResourceSearchIndex, input: NormMaterialSearchInput): NormMaterialMatches {
  const limit = input.limit ?? MAX_RESOURCE_CANDIDATES;
  const fits = (entry: ResourceEntry): boolean => normMaterialUnitFits(input.unit, entry.unit);

  const groupAll = groupEntriesOf(index, input.resourceCode);
  if (groupAll.length > 0) {
    const inGroup = new Set(groupAll.filter(fits).map((entry) => entry.code));
    const everything = (name: string): ResourceMatch[] =>
      name.trim() === "" ? [] : findResources(index, { name, limit: Math.max(index.size, 1) }).filter((match) => inGroup.has(match.entry.code));
    const ranked = everything(joined(input.resourceName, input.workName, input.remark, input.normName));
    const seen = new Set(ranked.map((match) => match.entry.code));
    // Записи группы без общих слов с описанием работы тоже кандидаты: группа названа нормой, а выбрать материал внутри неё — дело модели.
    const rest = groupAll
      .filter((entry) => inGroup.has(entry.code) && !seen.has(entry.code))
      .map((entry): ResourceMatch => ({ entry, coverage: 0, strictCoverage: 0, precision: 0, score: 0, missingNumbers: [] }));
    return { matches: [...ranked, ...rest].slice(0, limit), byResourceName: everything(input.resourceName), scope: "GROUP" };
  }

  const search = (name: string, max: number): ResourceMatch[] => (name.trim() === "" ? [] : findResources(index, { name, limit: max }).filter((match) => fits(match.entry)));
  const withWork = search(joined(input.resourceName, input.workName, input.remark), 200);
  const byResourceName = search(input.resourceName, 200);
  const withNorm = search(joined(input.resourceName, input.normName), 200);

  const result: ResourceMatch[] = [];
  const taken = new Set<string>();
  const add = (match: ResourceMatch | undefined): void => {
    if (match === undefined || taken.has(match.entry.code) || result.length >= limit) return;
    taken.add(match.entry.code);
    result.push(match);
  };
  const lists = [withWork, byResourceName, withNorm];
  for (let position = 0; result.length < limit && lists.some((list) => position < list.length); position += 1) {
    for (const list of lists) add(list[position]);
  }
  return { matches: result, byResourceName, scope: "WIDE" };
}

/* ------------------------------ запасной выбор без ИИ ------------------------------ */

/**
 * Материал по названию ресурса нормы без модели: только когда он единственный с высоким покрытием слов названия (пороги `pickByName`), без чисел
 * названия, которых нет у материала, и явный лидер по близости. Название ресурса из одного слова («Материалы») решать ничего не может — не берётся.
 */
export function pickNormMaterialByName(resourceName: string, byResourceName: readonly ResourceMatch[]): ResourceMatch | null {
  const words = uniqueTokens(resourceName).filter((token) => !/^\d+(?:[.,]\d+)?$/u.test(token));
  if (words.length < 2) return null;
  const strong = byResourceName.filter(
    (match) => match.coverage >= FALLBACK_MIN_COVERAGE && match.strictCoverage >= FALLBACK_MIN_STRICT_COVERAGE && match.missingNumbers.length === 0,
  );
  if (strong.length !== 1) return null;
  const top = strong[0] as ResourceMatch;
  const second = byResourceName.find((match) => match.entry.code !== top.entry.code);
  if (second !== undefined && !(top.score >= second.score * FALLBACK_LEAD)) return null;
  return top;
}

/* ------------------------------ проверка ответа модели ------------------------------ */

/** Что проверка знает о ресурсе нормы и работе: без этого проверяются только список кандидатов, справочник и единица. */
export interface NormMaterialPickContext {
  /** Код ресурса нормы: группа «12.1.02.06» ограничивает выбор. */
  readonly resourceCode: string;
  readonly resourceName: string;
  readonly workName: string;
  readonly normName?: string;
  /** Собственная цена ресурса нормы в книге за единицу ресурса нормы (`normResourceOwnPrice`); нет — не сверяется. */
  readonly ownPrice?: number | null;
}

/** Кандидат с тем, что нужно проверке цены; ключ — обязателен, остальное есть у кандидатов запроса (`ResourcePickCandidate`). */
export interface NormMaterialCandidateRef {
  readonly key: string;
  readonly unit?: string;
  readonly price?: number;
}

export type NormMaterialVet = { readonly ok: true; readonly widened: boolean } | { readonly ok: false; readonly reason: string };

/**
 * Проверка материала справочника под ресурс нормы: группа, род по словам названия, здравость цены. Общая для ответа модели и запасного выбора без неё.
 * `widened` — группы у ресурса нормы нет или в справочнике у неё нет записей: материал мог быть любым из найденных по словам, и запись подсвечивается «проверьте».
 *
 * Цена. Цена материала приводится к единице ресурса нормы («т» к «кг»). Эталоны — медиана цен записей группы с переводимой единицей (когда группы нет —
 * медиана цен кандидатов запроса) и собственная цена ресурса нормы; материал дороже любого эталона в 5 раз (`NORM_MATERIAL_MAX_PRICE_RATIO`) отклоняется:
 * дорогое покрытие, поставленное на чужую позицию, ломает две позиции сразу.
 */
export function vetNormMaterial(
  entry: ResourceEntry,
  index: ResourceSearchIndex,
  normUnit: string,
  context: NormMaterialPickContext,
  candidates: readonly NormMaterialCandidateRef[] = [],
): NormMaterialVet {
  const group = resourceGroupOf(context.resourceCode);
  const groupAll = groupEntriesOf(index, context.resourceCode);
  const widened = groupAll.length === 0;
  if (group !== null && !widened && !inResourceGroup(entry.code, group)) {
    return { ok: false, reason: `ресурс ${entry.code} вне группы ${group} ресурса нормы: у группы в справочнике ${String(groupAll.length)} записей, выбор только из них` };
  }

  const family = checkMaterialFamily({ materialName: entry.name, resourceName: context.resourceName, workName: context.workName, ...(context.normName === undefined ? {} : { normName: context.normName }) });
  if (!family.ok) return { ok: false, reason: `${family.reason} (${entry.code})` };

  const price = unitPriceInNormUnit(entry, normUnit);
  if (price !== null) {
    const peers = widened
      ? candidates.flatMap((candidate) => (candidate.unit === undefined || candidate.price === undefined ? [] : [unitPriceInNormUnit({ price: candidate.price, unit: candidate.unit }, normUnit)])).filter((value): value is number => value !== null)
      : groupAll.flatMap((member) => {
          const value = unitPriceInNormUnit(member, normUnit);
          return value === null ? [] : [value];
        });
    const median = medianOf(peers);
    const money = (value: number): string => String(Math.round(value * 100) / 100);
    if (median !== null && price > median * NORM_MATERIAL_MAX_PRICE_RATIO) {
      return {
        ok: false,
        reason: `цена материала ${entry.code} ${money(price)} ₽ за ${normUnit} больше чем в ${String(NORM_MATERIAL_MAX_PRICE_RATIO)} раз выше медианы цен ${widened ? "кандидатов" : `группы ${group ?? ""}`} (${money(median)} ₽)`,
      };
    }
    const own = context.ownPrice ?? null;
    if (own !== null && own > 0 && price > own * NORM_MATERIAL_MAX_PRICE_RATIO) {
      return { ok: false, reason: `цена материала ${entry.code} ${money(price)} ₽ за ${normUnit} больше чем в ${String(NORM_MATERIAL_MAX_PRICE_RATIO)} раз выше собственной цены ресурса нормы (${money(own)} ₽)` };
    }
  }
  return { ok: true, widened };
}

export type NormMaterialPickCheck =
  | { readonly status: "REJECTED"; readonly reason: string }
  | { readonly status: "ACCEPTED"; readonly entry: ResourceEntry; readonly widened: boolean };

/**
 * Проверка ответа «РЕСУРС|шифр» для материала нормы: шифр среди отправленных кандидатов, ресурс есть в справочнике, единица переводится из единицы
 * ресурса нормы. Норма вместо ресурса не принимается никогда. С `context` проверяются ещё группа, род и цена (`vetNormMaterial`).
 */
export function checkNormMaterialPick(
  pick: string,
  candidates: readonly NormMaterialCandidateRef[],
  index: ResourceSearchIndex,
  normUnit: string,
  context?: NormMaterialPickContext,
): NormMaterialPickCheck {
  if (!isResourcePick(pick)) return { status: "REJECTED", reason: `для материала нормы выбрана не ресурс, а «${pick.slice(0, 40)}»` };
  if (!candidates.some((candidate) => candidate.key === pick)) return { status: "REJECTED", reason: `ресурс «${pick.slice(0, 40)}» вне списка кандидатов` };
  const code = pick.slice(RESOURCE_PICK_PREFIX.length + 1);
  const entry = index.byCode.get(code);
  if (entry === undefined) return { status: "REJECTED", reason: `ресурса «${code}» нет в справочнике цен` };
  if (!normMaterialUnitFits(normUnit, entry.unit)) {
    return { status: "REJECTED", reason: `единица ресурса «${entry.unit}» не переводится из единицы ресурса нормы «${normUnit}» (${code})` };
  }
  if (context === undefined) return { status: "ACCEPTED", entry, widened: false };
  const vet = vetNormMaterial(entry, index, normUnit, context, candidates);
  return vet.ok ? { status: "ACCEPTED", entry, widened: vet.widened } : { status: "REJECTED", reason: vet.reason };
}

/* ------------------------------ запись в позицию ------------------------------ */

const QUANTITY = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 });

export interface NormMaterialApplyOptions {
  readonly source: "AI" | "NAME";
  /** Обоснование модели; у запасного выбора пусто. */
  readonly reason: string;
  /** Уверенность модели; null — не назвала или выбор без модели. */
  readonly confidence: "high" | "low" | null;
  /** Покрытие слов названия ресурса нормы названием материала; у выбора ИИ не обязательно. */
  readonly coverage: number | null;
  /** У группы ресурса нормы нет записей в справочнике: кандидаты шире группы, выбор всегда «проверьте». */
  readonly widened?: boolean;
}

/**
 * Запись подобранного материала в позицию (`aiNormMaterials`): расчёт сам поставит его вместо ресурса нормы «по проекту». «Проверьте» — когда модель
 * сомневалась или не назвала уверенность либо материал выбран кодом без модели: неверный материал даёт неверные деньги, и ведомость подсвечивает это.
 */
export function applyNormMaterial(
  item: BillOfWorkItem,
  norm: NormRecord,
  resource: NormResource,
  entry: ResourceEntry,
  options: NormMaterialApplyOptions,
): BillOfWorkItem {
  const review = options.source === "NAME" || options.confidence !== "high" || options.widened === true;
  const reason = options.reason.trim() === "" ? "причина не названа" : options.reason.replace(/[.\s]+$/u, "");
  const label = resource.name === "" ? resource.code : `«${resource.name}»`;
  const note = [
    options.source === "AI"
      ? `материал подобран ИИ: ${reason}`
      : `материал подобран по наименованию без ИИ (слов названия ресурса нормы в названии материала ${String(Math.round((options.coverage ?? 0) * 100))} %)`,
    describeEntry(entry),
    `вместо ресурса нормы ${label} (${resource.code}) «по проекту»: расход по норме ${QUANTITY.format(resource.quantity)} ${resource.unit} на ${norm.unit}`,
    ...(options.source === "AI" && options.confidence === "low" ? ["модель не уверена в выборе"] : []),
    ...(options.source === "AI" && options.confidence === null ? ["модель не назвала уверенность"] : []),
    ...(options.source === "NAME" ? ["проверьте: материал выбран кодом, без модели"] : []),
    ...(options.widened === true ? ["проверьте: у группы ресурса нормы нет записей в справочнике цен, материал искался шире группы"] : []),
  ].join("; ");
  const material: AiNormMaterial = {
    normCode: norm.code,
    normBaseType: norm.baseType,
    normResourceCode: resource.code,
    code: entry.code,
    name: entry.name,
    unit: entry.unit,
    pick: options.source,
    review,
    note,
    normResourceName: resource.name,
    reason: options.source === "AI" ? reason : "",
    confidence: options.confidence,
  };
  const others = (item.aiNormMaterials ?? []).filter(
    (existing) => !(existing.normCode === norm.code && existing.normBaseType === norm.baseType && existing.normResourceCode === resource.code),
  );
  return { ...item, aiNormMaterials: [...others, material] };
}

/* ------------------------------ подстановка в расчёте ------------------------------ */

/**
 * Подобранный материал для ресурса нормы или null: запись относится к этой норме и этому ресурсу, ресурс по-прежнему «по проекту» с числовым
 * расходом, человек своего материала на него не назвал, единица материала переводится из единицы ресурса. Возвращает материал и ресурс нормы,
 * переписанный под него: код, название и единица справочника, расход пересчитан в единицу справочника — дальше он оценивается как любой материал нормы.
 */
export function substituteNormMaterial(
  item: Pick<BillOfWorkItem, "aiNormMaterials" | "projectMaterials">,
  norm: Pick<NormRecord, "code" | "baseType">,
  resource: NormResource,
): { readonly material: AiNormMaterial; readonly resource: NormResource } | null {
  const materials = item.aiNormMaterials;
  if (materials === undefined || materials.length === 0 || !isOpenNormMaterial(resource)) return null;
  if ((item.projectMaterials ?? []).some((named) => named.code === resource.code)) return null;
  const material = materials.find((candidate) => candidate.normCode === norm.code && candidate.normBaseType === norm.baseType && candidate.normResourceCode === resource.code);
  if (material === undefined) return null;
  const divisor = deriveSupplyDivisor(resource.unit, material.unit);
  if (divisor === null || !(divisor > 0)) return null;
  return {
    material,
    resource: {
      ...resource,
      code: material.code,
      name: material.name,
      unit: material.unit,
      quantity: resource.quantity / divisor,
      projectSpecific: false,
      technologyGroup: null,
    },
  };
}

/** Снимает подобранные материалы нормы: норму выбрал человек, и материалы относились к норме, которой в позиции больше нет. */
export function stripAiNormMaterials(item: BillOfWorkItem): BillOfWorkItem {
  if (item.aiNormMaterials === undefined) return item;
  const { aiNormMaterials: _removed, ...rest } = item;
  return rest;
}
