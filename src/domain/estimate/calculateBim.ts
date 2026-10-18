import { findElementIndex, describeLetter, detectBimObject, quarterLabel, type BimIndexBook, type BimQuarterKey } from "@/domain/estimate/bimIndices";
import { terAsFerNote } from "@/domain/estimate/bimMethod";
import { resolveSubject, zoneOfName } from "@/domain/estimate/bimSubjects";
import { customerPriceLine, dedupeGaps, computeTotals, negateLine, ownPriceLine } from "@/domain/estimate/calculate";
import { normativeRef, type FerLookup } from "@/domain/estimate/customerBimAudit";
import { roundTo } from "@/domain/estimate/resourceKinds";
import { supplySanityProblem } from "@/domain/estimate/supplyGuard";
import { deriveSupplyDivisor } from "@/domain/estimate/units";
import type {
  AppliedNormative,
  BillOfWorkItem,
  BillOfWorkSection,
  BimDocumentInfo,
  EstimateDocument,
  EstimateGap,
  EstimateLine,
  EstimateMethodBasis,
  EstimateParameters,
  EstimatePriceZoneChoice,
  EstimateResourceLine,
  EstimateSection,
  EstimateSource,
  OverheadRate,
  OverheadRateSource,
  WageScale,
} from "@/domain/estimate/types";
import type { FerRate } from "@/lib/fsnb/ferXml";

/**
 * Наш расчёт базисно-индексным методом (БИМ): расценка ФЕР-2020 в уровне цен 01.01.2000 × индекс Минстроя.
 *
 * Зачем. Заказчик, составивший смету на ФЕР/ТЕР-2001 с индексами, будет сравниваться с ресурсной сметой, посчитанной по другой
 * базе: расхождение тогда несёт не ошибку заказчика, а разницу методов. Здесь мы считаем тем же методом, что и он, —
 * документ получается той же формы (`EstimateDocument`), с пометкой метода, и поверх него так же строится сводный сметный расчёт.
 *
 * Как складывается строка (проверено на реальной смете, см. `customerBimAudit.ts`):
 *   ОЗП × индекс труда + ЭМ × индекс машин + М × индекс материалов; НР и СП — процент приказов 812/пр и 774/пр от фонда оплаты труда
 *   (ОЗП + ЗПМ) × индекс труда. ЗПМ входит в ЭМ, но для начислений индексируется индексом оплаты труда.
 *
 * Откуда индекс. Письмо Минстроя на последний квартал, который есть у нас, по субъекту (зоне) закупки и объекту строительства.
 * Объект определяется по наименованию закупки однозначно (`detectBimObject`); не вышло — берутся «Прочие объекты» и это сказано
 * пробелом `BIM_NO_INDEX` и допущением в надёжности расчёта: подставлять индексы наугад молча нельзя.
 *
 * ТЕР региона. Открытой базы ТЕР нет (её цены есть только в закрытой базе региона). Если заказчик считает по ТЕР, считаем по ФЕР
 * с индексами к ФЕР и пишем об этом прямо (`BIM_TER_AS_FER`): «ТЕР <региона> недоступны в открытых данных — посчитано по ФЕР с
 * индексами к ФЕР; возможна разница».
 *
 * Чего БИМ-расчёт не делает: коэффициенты условий работ (прил. 10 к 421/пр) к расценкам ФЕР не применяются, перевозка и
 * погрузка по таблицам ФГИС ЦС (они ресурсные) — тоже; такие позиции идут по цене заказчика, если она есть.
 *
 * Модуль чистый: сети и диска нет.
 */

/** Индексы письма для субъекта, объекта и квартала — то, чем строки пересчитываются в текущий уровень цен. */
export interface BimSelection {
  readonly quarter: BimQuarterKey;
  readonly subject: string;
  readonly zone: number | null;
  readonly object: string;
  /** Объект определён по наименованию однозначно; иначе взят «Прочие объекты». */
  readonly objectDetected: boolean;
  readonly labour: number;
  readonly machines: number;
  readonly materials: number;
  /** «письмо Минстроя России от 30.07.2026 № 46728-ИФ/09, стр. 1». */
  readonly letter: string;
  /** Что было неоднозначно при выборе: попадает в пробелы документа. */
  readonly notes: readonly string[];
}

export type BimSelectionResult = { readonly ok: true; readonly selection: BimSelection } | { readonly ok: false; readonly reason: string };

export const FALLBACK_OBJECT = "Прочие объекты";

export interface BimSelectionQuery {
  /** Название субъекта или ценовой зоны в любой форме: «Республика Бурятия (5 зона)». */
  readonly subject: string | null;
  readonly zone?: number | null;
  /** Текст, по которому определяется объект строительства: предмет закупки, наименование стройки. */
  readonly text: string;
  /** Квартал; нет — последний, на который есть письма. */
  readonly quarter?: BimQuarterKey;
}

/** Индексы к ФЕР-2001 по субъекту (зоне), объекту строительства и кварталу. */
export function selectBimIndices(book: BimIndexBook, query: BimSelectionQuery): BimSelectionResult {
  const quarter = query.quarter ?? book.quarters[0];
  if (quarter === undefined) return { ok: false, reason: "писем Минстроя с индексами в справочнике нет" };
  const subject = query.subject === null ? null : resolveSubject(query.subject);
  if (subject === null) return { ok: false, reason: `субъект РФ «${query.subject ?? ""}» в справочнике писем Минстроя не найден` };
  const zone = query.zone ?? (query.subject === null ? null : zoneOfName(query.subject));

  const detected = detectBimObject(query.text);
  const notes: string[] = [];
  const attempt = (object: string) => findElementIndex(book, { quarter, subject, zone, object, base: "FER" });

  let object = detected.object ?? FALLBACK_OBJECT;
  let objectDetected = detected.object !== null;
  let found = attempt(object);
  if (detected.object === null) {
    notes.push(
      detected.candidates.length > 1
        ? `объект строительства определить однозначно не удалось (${detected.reason ?? "подходит несколько"}) — индексы взяты по «${FALLBACK_OBJECT}»; кандидаты: ${detected.candidates.join("; ")}`
        : `объект строительства по наименованию закупки не определяется — индексы взяты по «${FALLBACK_OBJECT}»`,
    );
  }
  const complete = (): boolean => found.status === "FOUND" && found.record.labour !== null && found.record.machines !== null && found.record.materials !== null;
  if (!complete() && object !== FALLBACK_OBJECT) {
    notes.push(`для объекта «${object}» в письме нет полного набора индексов к ФЕР — индексы взяты по «${FALLBACK_OBJECT}»`);
    object = FALLBACK_OBJECT;
    objectDetected = false;
    found = attempt(object);
  }
  if (found.status !== "FOUND") {
    const why =
      found.status === "NO_QUARTER"
        ? `писем за ${quarterLabel(quarter)} нет`
        : found.status === "NO_SUBJECT"
          ? `в письмах ${quarterLabel(quarter)} нет строк для «${subject}»`
          : found.status === "ZONE_AMBIGUOUS"
            ? `у «${subject}» несколько ценовых зон (${found.zones.join(", ")}), а зона закупки не определена`
            : "для объекта в письме нет индексов к ФЕР";
    return { ok: false, reason: why };
  }
  const { record } = found;
  if (record.labour === null || record.machines === null || record.materials === null) {
    return { ok: false, reason: `для «${subject}», «${object}» в письме есть прочерки вместо индексов` };
  }
  const letter = found.letter === null ? `письмо ${record.letter}, стр. ${String(record.page)}` : `${describeLetter(found.letter.info)}, стр. ${String(record.page)}`;
  return {
    ok: true,
    selection: { quarter, subject, zone, object, objectDetected, labour: record.labour, machines: record.machines, materials: record.materials, letter, notes },
  };
}

/** Расценка ФЕР, подобранная под позицию, и чем она подобрана. */
export interface FerResolution {
  readonly rate: FerRate;
  readonly reasons: readonly string[];
}
export type FerResolver = (item: BillOfWorkItem) => FerResolution | null;

export interface BimEstimateRequest {
  readonly title: string;
  readonly sections: readonly BillOfWorkSection[];
  readonly resolveRate: FerResolver;
  readonly fer: FerLookup;
  readonly selection: BimSelection;
  /** Нормативы НР и СП по указателям «Пр/812-001.1», «Пр/774-001.1». */
  readonly overheadRates: ReadonlyMap<string, OverheadRate>;
  readonly parameters: EstimateParameters;
  readonly appliedNormatives?: readonly AppliedNormative[];
  readonly sources: readonly EstimateSource[];
  readonly generatedAt: string;
  readonly disclaimer: string;
  /** Подписи документа: субъект, ценовая зона закупки, редакция базы. */
  readonly region: string;
  readonly priceZone: string;
  readonly baseEdition: string;
  readonly priceZoneChoice?: EstimatePriceZoneChoice;
  /** Откуда выбран метод и какая база расценок у заказчика. */
  readonly method: { readonly basis: EstimateMethodBasis; readonly note: string; readonly customerBase: "FER" | "TER" };
}

const money = (value: number): string => value.toFixed(2).replace(".", ",");
const percentText = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ","));

/** Тот же формат, что у расценок ГЭСН: «Пр/812-001.1» из указателя базы «812/пр-001.1». */
function chargeOf(
  ref: string | null,
  what: string,
  rate: FerRate,
  overheadRates: ReadonlyMap<string, OverheadRate>,
  fallbackPercent: number,
  gaps: EstimateGap[],
): { percent: number; source: OverheadRateSource; ref: string | null } {
  const normalized = normativeRef(ref);
  const label = `${rate.book} ${rate.code}`;
  if (normalized === null) {
    gaps.push({
      kind: "NO_OVERHEAD_RATE",
      message: `Расценка ${label} не несёт указателя на норматив ${what} — начислен резерв документа ${percentText(fallbackPercent)} %`,
      code: rate.code,
      baseType: rate.book,
    });
    return { percent: fallbackPercent, source: "DEFAULT", ref: null };
  }
  const found = overheadRates.get(normalized);
  if (found === undefined || !Number.isFinite(found.percent) || found.percent < 0) {
    gaps.push({
      kind: "NO_OVERHEAD_RATE",
      message: `Норматив ${what} по указателю ${normalized} из расценки ${label} не найден в справочнике — начислен резерв документа ${percentText(fallbackPercent)} %`,
      code: rate.code,
      baseType: rate.book,
    });
    return { percent: fallbackPercent, source: "DEFAULT", ref: normalized };
  }
  return { percent: found.percent, source: "NORM_REF", ref: normalized };
}

function resourceLines(rate: FerRate, quantity: number, base: { wage: number; machines: number; materials: number }, selection: BimSelection): EstimateResourceLine[] {
  const make = (code: string, name: string, kind: EstimateResourceLine["kind"], baseUnit: number, index: number): EstimateResourceLine | null => {
    if (!(baseUnit > 0)) return null;
    const unitPrice = baseUnit * index;
    return {
      code,
      name,
      unit: rate.unit,
      quantity: roundTo(quantity, 6),
      unitPrice,
      total: roundTo(roundTo(quantity, 6) * unitPrice, 2),
      source: "BIM_INDEXED",
      kind,
      wageOrigin: null,
      baseUnitPrice: baseUnit,
      index,
    };
  };
  return [
    make("ОЗП", "Оплата труда рабочих (ОЗП), базисная цена × индекс к оплате труда", "LABOUR", base.wage / quantity, selection.labour),
    make("ЭМ", "Эксплуатация машин (ЭМ, в т. ч. оплата труда машинистов), базисная цена × индекс к эксплуатации машин", "MACHINE", base.machines / quantity, selection.machines),
    make("МАТ", "Материалы (М), базисная цена × индекс к материалам", "MATERIAL", base.materials / quantity, selection.materials),
  ].filter((line): line is EstimateResourceLine => line !== null);
}

interface Outcome {
  readonly line: EstimateLine | null;
  readonly gaps: EstimateGap[];
}

function rateLine(item: BillOfWorkItem, resolution: FerResolution, request: BimEstimateRequest): Outcome {
  const { rate } = resolution;
  const { selection, parameters } = request;
  const gaps: EstimateGap[] = [];
  const label = `${rate.book} ${rate.code}`;
  const here = { code: rate.code, baseType: rate.book as string, billSection: item.billSection };

  if (!(item.quantity > 0)) {
    gaps.push({ kind: "BAD_QUANTITY", message: `Объём позиции «${item.workName}» равен ${String(item.quantity)} — расчёт невозможен`, ...here });
    return { line: null, gaps };
  }
  const divisor = item.unitDivisor > 0 ? item.unitDivisor : 1;
  if (item.unitDivisor <= 0) {
    gaps.push({ kind: "BAD_DIVISOR", message: `Делитель единицы для «${item.workName}» задан как ${String(item.unitDivisor)}, принят за 1`, ...here });
  }
  const quantity = item.quantity / divisor;
  const billUnit = item.quantityUnit.trim().toLowerCase().replace(/\s+/gu, " ");
  const rateUnit = rate.unit.trim().toLowerCase().replace(/\s+/gu, " ");
  if (billUnit.length > 0 && billUnit !== rateUnit && divisor === 1) {
    gaps.push({
      kind: "UNIT_MISMATCH",
      message: `Единица ведомости «${item.quantityUnit}» не совпадает с единицей расценки «${rate.unit}», а делитель не задан — позиция в расчёт не вошла`,
      ...here,
    });
    return { line: null, gaps };
  }

  const base = { wage: rate.wage * quantity, machines: rate.machines * quantity, machinistWage: rate.machinistWage * quantity, materials: rate.materials * quantity };
  const resources = resourceLines(rate, quantity, base, selection);
  const byKind = (kind: EstimateResourceLine["kind"]): number => roundTo(resources.filter((resource) => resource.kind === kind).reduce((sum, resource) => sum + resource.total, 0), 2);
  const labourCost = byKind("LABOUR");
  const machineCost = byKind("MACHINE");
  const materialCost = byKind("MATERIAL");
  const machinistSalaryCost = roundTo(base.machinistWage * selection.labour, 2);
  const directCost = roundTo(labourCost + machineCost + materialCost, 2);
  const wageFund = roundTo(labourCost + machinistSalaryCost, 2);

  const overhead = chargeOf(rate.overheadRef, "накладных расходов", rate, request.overheadRates, parameters.overhead.overheadPercent, gaps);
  const profit = chargeOf(rate.profitRef, "сметной прибыли", rate, request.overheadRates, parameters.overhead.profitPercent, gaps);

  const outside = rate.unaccounted.map((item) => item.name);
  if (outside.length > 0) {
    gaps.push({
      kind: "QUANTITY_BY_PROJECT",
      message: `В расценке ${label} цена части материалов в расценку не входит (расход «по проекту»): ${outside.slice(0, 4).join("; ")}${outside.length > 4 ? " …" : ""} — их стоимость в строку не включена`,
      ...here,
    });
  }

  const line: EstimateLine = {
    itemId: item.id,
    normCode: rate.code,
    normBaseType: rate.book,
    normName: rate.name,
    normUnit: rate.unit,
    quantity: roundTo(quantity, 6),
    billQuantity: item.quantity,
    billUnit: item.quantityUnit,
    sourceQuote: item.sourceQuote,
    sourceDocument: item.sourceDocument,
    billSection: item.billSection,
    labourHours: roundTo((rate.labourHours ?? 0) * quantity, 3),
    specialistHours: 0,
    labourRate: rate.labourHours !== null && rate.labourHours > 0 ? roundTo(labourCost / (rate.labourHours * quantity), 2) : 0,
    labourCost,
    machinistHours: roundTo((rate.machinistHours ?? 0) * quantity, 3),
    machinistSalaryCost,
    machineHours: 0,
    machineCost,
    materialCost,
    directCost,
    wageFund,
    overheadCost: roundTo((wageFund * overhead.percent) / 100, 2),
    profitCost: roundTo((wageFund * profit.percent) / 100, 2),
    overheadPercent: overhead.percent,
    profitPercent: profit.percent,
    overheadRef: overhead.ref,
    profitRef: profit.ref,
    overheadSource: overhead.source,
    profitSource: profit.source,
    resources,
    gaps: gaps.filter((gap) => gap.code === rate.code && gap.baseType === rate.book),
    priceNote: `${label} (01.01.2000): ОЗП ${money(base.wage)} × ${money(selection.labour)}, ЭМ ${money(base.machines)} × ${money(selection.machines)}, М ${money(base.materials)} × ${money(selection.materials)}`,
    bim: {
      rateCode: `${rate.book}${rate.code}`,
      baseWage: roundTo(base.wage, 2),
      baseMachines: roundTo(base.machines, 2),
      baseMachinistWage: roundTo(base.machinistWage, 2),
      baseMaterials: roundTo(base.materials, 2),
      indexLabour: selection.labour,
      indexMachines: selection.machines,
      indexMaterials: selection.materials,
      materialsOutsidePrice: outside,
    },
  };
  return { line, gaps };
}

/** Поставка материала отдельной строкой: цена ФССЦ-2020 (уровень 2000) × индекс к материалам; НР и СП не начисляются. */
function materialLine(item: BillOfWorkItem, request: BimEstimateRequest): Outcome {
  const code = item.resourceCode as string;
  const resource = request.fer.material(code);
  const gaps: EstimateGap[] = [];
  const here = { code, baseType: "ФССЦ" as string, billSection: item.billSection };
  if (resource === null) {
    gaps.push({ kind: "NO_PRICE", message: `Цены материала ${code} в ФССЦ-2020 нет — позиция в расчёт не вошла`, ...here });
    return { line: null, gaps };
  }
  if (!(item.quantity > 0)) {
    gaps.push({ kind: "BAD_QUANTITY", message: `Объём позиции «${item.workName}» равен ${String(item.quantity)} — расчёт невозможен`, ...here });
    return { line: null, gaps };
  }
  /*
    Цена ФССЦ назначена за единицу справочника, часто с множителем («1000 м», «100 шт»), а объём ведомости — в основной единице:
    кабель «1000 м» × 1,229 приходил как 1229 «м», и поставка стоила в тысячу раз дороже (3,2 млрд ₽ вместо 1,77 млн). Объём
    переводится в единицу цены (`deriveSupplyDivisor`: «м» → «1000 м» делит на 1000, «кг» → «т» делит на 1000). Единицы разных
    величин не переводятся: умножать цену на такой объём молча нельзя — позиция не считается, пробел UNIT_MISMATCH.
  */
  const billUnit = item.quantityUnit.trim().toLowerCase().replace(/\s+/gu, " ");
  const priceUnit = resource.unit.trim().toLowerCase().replace(/\s+/gu, " ");
  const divisor = billUnit === "" || priceUnit === "" || billUnit === priceUnit ? 1 : deriveSupplyDivisor(item.quantityUnit, resource.unit);
  if (divisor === null || !(divisor > 0)) {
    gaps.push({
      kind: "UNIT_MISMATCH",
      message: `Единица ведомости «${item.quantityUnit}» не переводится в единицу цены ФССЦ «${resource.unit}» для ресурса ${code} — позиция «${item.workName}» в расчёт не вошла`,
      ...here,
    });
    return { line: null, gaps };
  }
  const index = request.selection.materials;
  const quantity = roundTo(item.quantity / divisor, 6);
  const unitPrice = resource.cost * index;
  const total = roundTo(quantity * unitPrice, 2);
  const problem = supplySanityProblem(item, total);
  if (problem !== null) {
    gaps.push({ kind: "UNIT_MISMATCH", message: problem, ...here });
    return { line: null, gaps };
  }
  const resources: EstimateResourceLine[] = [
    {
      code,
      name: resource.name === "" ? item.workName : resource.name,
      unit: resource.unit,
      quantity,
      unitPrice,
      total,
      source: "BIM_INDEXED",
      kind: "MATERIAL",
      wageOrigin: null,
      baseUnitPrice: resource.cost,
      index,
    },
  ];
  const line: EstimateLine = {
    itemId: item.id,
    normCode: code,
    normBaseType: "ФССЦ",
    normName: item.workName,
    normUnit: resource.unit,
    quantity,
    billQuantity: item.quantity,
    billUnit: item.quantityUnit,
    sourceQuote: item.sourceQuote,
    sourceDocument: item.sourceDocument,
    billSection: item.billSection,
    labourHours: 0,
    specialistHours: 0,
    labourRate: 0,
    labourCost: 0,
    machinistHours: 0,
    machinistSalaryCost: 0,
    machineHours: 0,
    machineCost: 0,
    materialCost: total,
    directCost: total,
    wageFund: 0,
    overheadCost: 0,
    profitCost: 0,
    overheadPercent: 0,
    profitPercent: 0,
    overheadRef: null,
    profitRef: null,
    overheadSource: "NONE",
    profitSource: "NONE",
    resources,
    gaps: [],
    priceNote: `ФССЦ-2020 ${code} (01.01.2000): ${money(resource.cost)} × индекс к материалам ${money(index)}`,
    bim: {
      rateCode: `ФССЦ-${code}`,
      baseWage: 0,
      baseMachines: 0,
      baseMachinistWage: 0,
      baseMaterials: roundTo(resource.cost * quantity, 2),
      indexLabour: request.selection.labour,
      indexMachines: request.selection.machines,
      indexMaterials: index,
      materialsOutsidePrice: [],
    },
  };
  return { line, gaps };
}

function noRateGap(item: BillOfWorkItem): EstimateGap {
  return {
    kind: "NO_NORM",
    message: `Для позиции «${item.workName}» расценка ФЕР-2020 не найдена — позиция в расчёт не вошла`,
    code: item.normCode,
    baseType: item.normBaseType,
    billSection: item.billSection,
  };
}

function failureReason(gaps: readonly EstimateGap[]): string {
  const first = gaps.find((gap) => gap.kind !== "CUSTOMER_PRICE");
  if (first === undefined) return "нашей цены нет";
  return `нашей расценки нет: ${first.message.replace(/ — позиция в расчёт не вошла$| — стоимость не рассчитана$/u, "")}`;
}

function computeSection(section: BillOfWorkSection, request: BimEstimateRequest): { section: EstimateSection; gaps: EstimateGap[] } {
  const lines: EstimateLine[] = [];
  const gaps: EstimateGap[] = [];
  const processItem = (item: BillOfWorkItem): void => {
    const own = ownPriceLine(item);
    if (own !== null) {
      lines.push(own);
      return;
    }
    // Позиция по ТЦ, КП, прайсу: нормы нет, поиск по наименованию не запускается (см. `customerPriceOnly`).
    if (item.customerPriceOnly === true) {
      const priced = customerPriceLine(item, "позиция по цене заказчика (ТЦ, КП, прайс-лист): нормы и ресурса в справочниках у неё нет");
      if (priced !== null) {
        lines.push(priced.line);
        gaps.push(priced.gap);
      } else {
        gaps.push(noRateGap(item));
      }
      return;
    }
    let outcome: Outcome;
    if (item.resourceCode !== null) {
      outcome = materialLine(item, request);
    } else {
      const resolution = request.resolveRate(item);
      outcome = resolution === null ? { line: null, gaps: [noRateGap(item)] } : rateLine(item, resolution, request);
    }
    if (outcome.line === null) {
      const fallback = customerPriceLine(item, failureReason(outcome.gaps));
      if (fallback !== null) {
        lines.push(fallback.line);
        gaps.push(fallback.gap);
        return;
      }
    }
    gaps.push(...outcome.gaps);
    if (outcome.line !== null) lines.push(outcome.line);
  };
  for (const item of section.items) {
    const start = lines.length;
    processItem(item);
    // Исключение (отрицательный объём в смете заказчика): строка посчитана как обычно, знак — минус.
    if (item.deduction === true) {
      for (let index = start; index < lines.length; index += 1) lines[index] = negateLine(lines[index] as EstimateLine);
    }
  }
  const directCost = roundTo(lines.reduce((sum, line) => sum + line.directCost, 0), 2);
  const overheadCost = roundTo(lines.reduce((sum, line) => sum + line.overheadCost, 0), 2);
  const profitCost = roundTo(lines.reduce((sum, line) => sum + line.profitCost, 0), 2);
  return { section: { title: section.title, lines, directCost, overheadCost, profitCost, workCost: roundTo(directCost + overheadCost + profitCost, 2) }, gaps };
}

/** Заглушка тарифной шкалы: БИМ оплату труда по шкале не считает — ОЗП берётся из расценки в базисных ценах. */
function noWageScale(request: BimEstimateRequest): WageScale {
  return { region: request.region, zone: request.priceZone, period: quarterLabel(request.selection.quarter), anchors: [], baseSalary: 0, minRank: 0, maxRank: 0 };
}

export function buildBimEstimate(request: BimEstimateRequest): EstimateDocument {
  const { selection } = request;
  const sections: EstimateSection[] = [];
  const gaps: EstimateGap[] = [];
  for (const billSection of request.sections) {
    const computed = computeSection(billSection, request);
    sections.push(computed.section);
    gaps.push(...computed.gaps);
  }
  const totals = computeTotals(sections, request.parameters);

  for (const note of selection.notes) gaps.push({ kind: "BIM_NO_INDEX", message: note, code: null, baseType: null });
  if (request.method.customerBase === "TER") {
    gaps.push({ kind: "BIM_TER_AS_FER", message: terAsFerNote(selection.subject), code: null, baseType: null });
  }

  const appliedNormatives: AppliedNormative[] = [...(request.appliedNormatives ?? [])];
  if (request.parameters.workConditions !== undefined && request.parameters.workConditions.conditionIds.length > 0) {
    appliedNormatives.push({
      code: "WORK_CONDITION",
      title: "Условия производства работ",
      text: "Коэффициенты приложения 10 к 421/пр установлены для ресурсно-индексного метода.",
      value: "не применены",
      source: "421/пр, приложение 10",
      applied: false,
      reason: "при расчёте базисно-индексным методом коэффициенты условий работ к расценкам ФЕР не применяются — учтите их вручную или выберите ресурсно-индексный метод",
      missingData: true,
    });
  }
  for (const normative of appliedNormatives) {
    if (!normative.applied && normative.missingData === true) {
      gaps.push({ kind: "NORMATIVE_NOT_APPLIED", message: `${normative.title}: ${normative.reason ?? "норматив не начислен"}`, code: null, baseType: null });
    }
  }

  const bim: BimDocumentInfo = {
    basis: request.method.basis,
    basisNote: request.method.note,
    subject: selection.subject,
    zone: selection.zone,
    quarter: quarterLabel(selection.quarter),
    object: selection.object,
    objectDetected: selection.objectDetected,
    customerBase: request.method.customerBase,
    indexLabour: selection.labour,
    indexMachines: selection.machines,
    indexMaterials: selection.materials,
    letter: selection.letter,
  };

  return {
    title: request.title,
    region: request.region,
    priceZone: request.priceZone,
    period: `${quarterLabel(selection.quarter)} (индексы Минстроя)`,
    method: "BASE_INDEX",
    bim,
    baseEdition: request.baseEdition,
    parameters: request.parameters,
    wageScale: noWageScale(request),
    sections,
    totals,
    gaps: dedupeGaps(gaps),
    sources: request.sources,
    generatedAt: request.generatedAt,
    disclaimer: request.disclaimer,
    ...(request.priceZoneChoice === undefined ? {} : { priceZoneChoice: request.priceZoneChoice }),
    ...(appliedNormatives.length === 0 ? {} : { appliedNormatives }),
  };
}
