import type { BimAuditDetails, BimBaseCheckRow, BimIndexTriple } from "@/domain/estimate/bimAuditTypes";
import {
  describeLetter,
  detectBimObject,
  findElementIndex,
  quarterLabel,
  type BimIndexBook,
  type BimQuarterKey,
} from "@/domain/estimate/bimIndices";
import type { BimBase, BimElement } from "@/domain/estimate/bimIndicesTypes";
import { resolveSubject, zoneOfName } from "@/domain/estimate/bimSubjects";
import {
  describeConclusion,
  emptyImpacts,
  emptySummary,
  quartersWord,
  rub,
  sameUnit,
  tolerance,
  type AuditFinding,
  type AuditFindingType,
  type AuditPosition,
  type AuditReport,
  type ImpactGroup,
  type UncheckedItem,
} from "@/domain/estimate/customerAudit";
import type { BimPosition, CustomerBim } from "@/domain/estimate/customerBim";
import type { OverheadRate } from "@/domain/estimate/types";
import type { FerRate, FerResourcePrice, FerTransportPrice } from "@/lib/fsnb/ferXml";

/**
 * Аудит локальной сметы заказчика, составленной базисно-индексным методом (БИМ).
 *
 * Принцип тот же, что у аудита ресурсной сметы (`customerAudit.ts`): объёмы заказчика не трогаем, переоцениваем его же
 * количества по открытым данным. Разница итога складывается из шагов, суммы которых сходятся с ней до копейки:
 *
 *  0. арифметика — итог позиции из его же цифр (цена расценки × коэффициент × объём, × индекс, ФОТ × %) против напечатанного;
 *  A. базисные цены — цена расценки ФЕР заказчика против ФЕР-2020 (с теми же поправочными коэффициентами);
 *  B. индексы — индексы заказчика против письма Минстроя по субъекту, объекту строительства и кварталу;
 *  C. нормативы НР и СП — проценты заказчика против приказов 812/пр и 774/пр.
 *
 * Как БИМ складывается в деньги (проверено на реальной смете: Тюменская область, III кв. 2025, расценка ФЕРм08-01-001-11):
 * ОЗП × индекс ОТ + ЭМ × индекс ЭМ + М × индекс М + НР и СП, где НР и СП считаются от фонда оплаты труда
 * (ОЗП + ЗПМ) × индекс ОТ — оплата машинистов, входящая в ЭМ, для начислений индексируется индексом оплаты труда
 * (так сказано в сноске 2 писем Минстроя).
 *
 * Чего аудит не делает, а говорит прямо:
 *  - ТЕР региона: открытой базы нет — базисные цены не проверяются, остаётся справка;
 *  - корпоративные расценки (КОЕР, КССЦ) — не с чем сравнить;
 *  - объект строительства определяется по наименованию стройки только однозначно (`detectBimObject`); не вышло — индексы
 *    не сверяются, а письмо называется справкой для субъекта;
 *  - квартал: индексы сверяются с письмом того же квартала; письма за этот квартал у нас нет — справка без вывода;
 *  - НР и СП при составлении по МДС 81-33.2004/81-25.2001 не проверяются: их нормативов в открытых данных нет.
 *
 * Модуль чистый: деньги внутри не округляются.
 */

/** Цена ресурса ФЕР-2020 и перевозки по коду — то, что нужно аудиту от базы. */
export interface FerLookup {
  rate(book: string, code: string): FerRate | null;
  material(code: string): FerResourcePrice | null;
  transport(code: string): FerTransportPrice | null;
}

export interface BimAuditContext {
  readonly fer: FerLookup;
  readonly indices: BimIndexBook;
  /** Нормативы НР и СП по указателям «Пр/812-001.1», «Пр/774-001.1» для зоны Севера расчёта. */
  readonly overheadRates: ReadonlyMap<string, OverheadRate>;
  /** Субъект закупки по ценовой зоне: используется, когда смета субъект не называет. */
  readonly subject: string | null;
  readonly zone?: number | null;
  readonly vatPercent?: number;
}

/** Расхождение индекса, с которого оно считается отличием: индекс в смете печатается до сотых. */
const INDEX_TOLERANCE = 0.0051;
/**
 * Допуск суммы позиции в таблице, ₽: суммы печатаются целыми рублями и подгоняются друг под друга (ЭМ = Всего − ОЗП), поэтому
 * расхождение до рубля на элемент — округление, а не ошибка (ФЕР24-02-120-04: 27,00 × 1,28695 = 34,75, в смете 34).
 */
const GRID_ROUNDING = 1.01;
/** Сколько строк сверки хранится в отчёте. */
const MAX_ROWS = 400;

/** Указатель из базы («812/пр-054.0») → указатель справочника («Пр/812-054.0»). */
export function normativeRef(ref: string | null): string | null {
  if (ref === null) return null;
  const match = /^(812|774)\/пр-(\d{3}\.\d)/u.exec(ref.trim());
  if (match !== null) return `Пр/${match[1] as string}-${match[2] as string}`;
  const direct = /^Пр\/(812|774)-(\d{3}\.\d)(?:-\d+)?/u.exec(ref.trim());
  return direct === null ? null : `Пр/${direct[1] as string}-${direct[2] as string}`;
}

const sum = (...values: Array<number | null | undefined>): number => values.reduce<number>((total, value) => total + (value ?? 0), 0);

function approxEqual(a: number, b: number, slack = 0): boolean {
  return Math.abs(a - b) <= Math.max(0.015, Math.abs(b) * 0.001) + slack;
}

const FAMILY_BASE: Readonly<Record<string, BimBase>> = { FER: "FER", TER: "TER" };

interface PositionOutcome {
  readonly position: AuditPosition;
  readonly findings: AuditFinding[];
  readonly impacts: Record<ImpactGroup, { amount: number; rows: number }>;
  readonly checkedDirect: number;
  readonly totalDirect: number;
  readonly unchecked: UncheckedItem[];
  readonly row: BimBaseCheckRow | null;
  /** По источникам: базисные цены, индексы, нормативы, арифметика. */
  readonly sources: { basePrices: number; indices: number; norms: number; arithmetic: number };
  /** Вклад индексов по элементам (с НР и СП на труд): для итоговой находки «индекс занижен на N ₽». */
  readonly indexImpact: Record<BimElement, number>;
  /** Позиция входит в итог сметы. */
  readonly included: boolean;
  /** Указатель НР заказчика и указатель той же расценки в ФЕР-2020, когда они разные. */
  readonly refDifferences: ReadonlyArray<{ own: string; base: string; position: string }>;
}

interface IndexSet {
  readonly labour: number;
  readonly machines: number;
  readonly materials: number;
}

function label(position: BimPosition): string {
  return `поз. ${position.number} ${position.code}`;
}

/** Цена за единицу по элементам ФЕР с коэффициентами позиции: так её печатает таблица (Гранд-Смета). */
function expectedUnitPrice(rate: FerRate, k: { wage: number; machines: number; machinistWage: number; materials: number }): { wage: number; machines: number; machinistWage: number; materials: number; total: number } {
  const wage = rate.wage * k.wage;
  const machinistWage = rate.machinistWage * k.machinistWage;
  const machines = (rate.machines - rate.machinistWage) * k.machines + machinistWage;
  const materials = rate.materials * k.materials;
  return { wage, machines, machinistWage, materials, total: wage + machines + materials };
}

/** Преобладающее значение из списка (самое частое; при равенстве — первое встреченное). */
function modal(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0] as number;
  for (const [value, count] of counts) if (count > (counts.get(best) ?? 0)) best = value;
  return best;
}

const ELEMENTS: ReadonlyArray<{ element: BimElement; key: keyof IndexSet; word: string; field: "labour" | "machines" | "materials"; group: ImpactGroup }> = [
  { element: "LABOUR", key: "labour", word: "ОЗП", field: "labour", group: "LABOUR" },
  { element: "MACHINES", key: "machines", word: "ЭМ", field: "machines", group: "MACHINES" },
  { element: "MATERIALS", key: "materials", word: "материалам", field: "materials", group: "MATERIALS" },
];

const fmt = (value: number): string => value.toFixed(2).replace(".", ",");

interface EstimateFacts {
  readonly subject: string | null;
  readonly subjectSource: "ESTIMATE" | "ZONE" | null;
  readonly zone: number | null;
  readonly object: string | null;
  readonly objectReason: string | null;
  readonly objectCandidates: readonly string[];
  readonly quarter: BimQuarterKey | null;
  readonly letterIndices: ReadonlyMap<BimBase, { indices: IndexSet; letterNumber: string; letterDate: string; object: string; text: string } | null>;
  readonly lookupNotes: string[];
}

function lookupLetterIndices(
  estimate: CustomerBim,
  ctx: BimAuditContext,
  facts: Omit<EstimateFacts, "letterIndices" | "lookupNotes">,
): { map: EstimateFacts["letterIndices"]; notes: string[] } {
  const map = new Map<BimBase, { indices: IndexSet; letterNumber: string; letterDate: string; object: string; text: string } | null>();
  const notes: string[] = [];
  const bases = new Set<BimBase>(estimate.positions.map((position) => FAMILY_BASE[position.family]).filter((base): base is BimBase => base !== undefined));
  if (bases.size === 0) bases.add("FER");
  const where = `${facts.subject ?? "субъект не определён"}${facts.zone === null ? "" : `, ${String(facts.zone)} зона`}`;

  for (const base of bases) {
    if (facts.quarter === null) {
      notes.push("квартал цен в смете не назван — индексы не с чем сверять по кварталу");
      map.set(base, null);
      continue;
    }
    if (facts.subject === null) {
      notes.push("субъект РФ в смете не назван и по зоне закупки не определён");
      map.set(base, null);
      continue;
    }
    if (facts.object === null) {
      notes.push(`объект строительства не определён (${facts.objectReason ?? "по наименованию стройки"})`);
      map.set(base, null);
      continue;
    }
    const lookup = findElementIndex(ctx.indices, { quarter: facts.quarter, subject: facts.subject, zone: facts.zone, object: facts.object, base });
    if (lookup.status === "FOUND") {
      const record = lookup.record;
      const labour = record.labour;
      const machines = record.machines;
      const materials = record.materials;
      map.set(base, {
        indices: { labour: labour ?? Number.NaN, machines: machines ?? Number.NaN, materials: materials ?? Number.NaN },
        letterNumber: lookup.letter?.info.number ?? record.letter,
        letterDate: lookup.letter?.info.date ?? "",
        object: facts.object,
        text: lookup.letter === null ? `письмо ${record.letter}, стр. ${String(record.page)}` : `${describeLetter(lookup.letter.info)}, стр. ${String(record.page)}`,
      });
      continue;
    }
    map.set(base, null);
    if (lookup.status === "NO_QUARTER") {
      const have = lookup.available.map(quarterLabel).join(", ");
      notes.push(`писем Минстроя за ${quarterLabel(facts.quarter)} в справочнике нет (есть: ${have === "" ? "ни одного" : have})`);
    } else if (lookup.status === "NO_SUBJECT") notes.push(`в письмах ${quarterLabel(facts.quarter)} нет строк для субъекта «${facts.subject}» (${where})`);
    else if (lookup.status === "NO_OBJECT") notes.push(`в письме для «${facts.subject}» нет объекта «${facts.object}»`);
    else if (lookup.status === "ZONE_AMBIGUOUS") {
      notes.push(`у субъекта «${facts.subject}» несколько ценовых зон (${lookup.zones.join(", ")}), а зона в смете не названа`);
    } else if (lookup.status === "NO_BASE") {
      notes.push(`для «${facts.subject}», ${facts.object} в письме нет индексов к ${base === "TER" ? "ТЕР-2001" : "ФЕР-2001"} (стоит прочерк)`);
    } else notes.push(`для «${facts.subject}», ${facts.object} в письме одни прочерки`);
  }
  return { map, notes };
}

function factsOf(estimate: CustomerBim, ctx: BimAuditContext): EstimateFacts {
  const fromEstimate = estimate.subjectText === null ? null : resolveSubject(estimate.subjectText);
  const fromZone = ctx.subject === null ? null : resolveSubject(ctx.subject);
  const subject = fromEstimate ?? fromZone;
  const text = [estimate.constructionName, estimate.workName, estimate.estimateName].filter((part): part is string => part !== null).join(". ");
  const detected = detectBimObject(text);
  const quarter: BimQuarterKey | null = estimate.quarter === null ? null : { year: estimate.quarter.year, quarter: estimate.quarter.quarter };
  const zone = estimate.zone ?? (fromEstimate === null ? (ctx.zone ?? (ctx.subject === null ? null : zoneOfName(ctx.subject))) : null);
  const base = { subject, subjectSource: fromEstimate !== null ? ("ESTIMATE" as const) : fromZone !== null ? ("ZONE" as const) : null, zone, object: detected.object, objectReason: detected.reason, objectCandidates: detected.candidates, quarter };
  const { map, notes } = lookupLetterIndices(estimate, ctx, base);
  return { ...base, letterIndices: map, lookupNotes: notes };
}

/* ------------------------------ Позиция ------------------------------ */

function auditPosition(estimate: CustomerBim, position: BimPosition, facts: EstimateFacts, ctx: BimAuditContext, suppliesExcluded: boolean): PositionOutcome {
  const findings: AuditFinding[] = [];
  const impacts = emptyImpacts();
  const unchecked: UncheckedItem[] = [];
  const sources = { basePrices: 0, indices: 0, norms: 0, arithmetic: 0 };
  const indexImpact: Record<BimElement, number> = { LABOUR: 0, MACHINES: 0, MATERIALS: 0 };
  const add = (finding: Omit<AuditFinding, "positionNumber" | "impact"> & { impact?: number | null }): void => {
    findings.push({ ...finding, positionNumber: Number.parseFloat(position.number), impact: finding.impact ?? null });
  };

  const supply = position.family === "MATERIAL" || position.family === "TRANSPORT" || position.family === "CUSTOMER_PRICE";
  const included = !(supply && suppliesExcluded);
  const quantity = (position.quantity ?? 0) * (position.positionCoefficient ?? 1);
  const current = estimate.priceLevel === "CURRENT" && position.indices !== null;

  // Заказчик: что напечатано.
  const w = position.baseTotal.wage ?? 0;
  const mw = position.baseTotal.machinistWage ?? 0;
  const e = position.baseTotal.machines ?? 0;
  const m = supply ? (position.baseTotal.total ?? 0) : (position.baseTotal.materials ?? 0);
  const ohBase = position.overhead?.amount ?? 0;
  const prBase = position.profit?.amount ?? 0;
  const customerIndex: IndexSet = {
    // Индекс оплаты труда стоит и у ОТ, и у «в т. ч. ОТм»: у расценки без работ рабочих, но с машинистами, остаётся индекс ОТм.
    labour: current ? (position.indices?.labour ?? position.indices?.machinistLabour ?? 1) : 1,
    machines: current ? (position.indices?.machines ?? 1) : 1,
    materials: current ? (position.indices?.materials ?? 1) : 1,
  };
  // Итог позиции в уровне цен сметы: стоимость в текущих ценах напечатана только у потока; у таблицы — базисная.
  const printedTotal = current ? position.positionCurrentTotal : position.positionBaseTotal;

  // Составляющие «из цифр заказчика» — для арифметики позиции.
  const piecesTotal = w * customerIndex.labour + e * customerIndex.machines + m * customerIndex.materials + (ohBase + prBase) * customerIndex.labour;
  const label0 = label(position);

  /* ---- арифметика (шаг 0) ---- */
  let arithmeticEffect = 0;
  const flagArithmetic = (text: string, discrepancy: number): void => {
    add({ type: "ARITHMETIC", severity: "WARNING", message: `${label0}: ${text}`, discrepancy });
    impacts.ARITHMETIC.rows += 1;
  };
  const uPrice = position.unitPrice;
  if (position.quantity !== null && !supply) {
    // Таблица: стоимость = объём × цена за единицу (цена уже с коэффициентами); поток: × напечатанный коэффициент группы.
    const factor = estimate.format === "STREAM" ? position.coefficients : { wage: 1, machines: 1, machinistWage: 1, materials: 1 };
    const checks: ReadonlyArray<[string, number | null, number | null, number]> = [
      ["ОЗП", uPrice.wage, position.baseTotal.wage, factor.wage],
      ["ЭМ", uPrice.machines, position.baseTotal.machines, factor.machines],
      ["ОТм", uPrice.machinistWage, position.baseTotal.machinistWage, factor.machinistWage],
    ];
    for (const [name, unit, total, k] of checks) {
      if (unit === null || total === null || unit === 0) continue;
      const expected = unit * quantity * k;
      // Таблица печатает суммы позиции целыми рублями: допуск — рубль на строку.
      const slack = estimate.format === "GRID" ? GRID_ROUNDING : 0.02;
      if (Math.abs(expected - total) > Math.max(slack, Math.abs(expected) * 0.001)) {
        flagArithmetic(`${name}: ${fmt(unit)} × ${String(quantity)} × ${String(k)} = ${fmt(expected)} ₽, а в смете ${fmt(total)} ₽`, Math.abs(expected - total));
      }
    }
  }
  if (supply && position.quantity !== null && position.unitPrice.total !== null && position.baseTotal.total !== null) {
    const expected = position.unitPrice.total * quantity;
    const slack = estimate.format === "GRID" ? GRID_ROUNDING : 0.02;
    if (Math.abs(expected - position.baseTotal.total) > Math.max(slack, Math.abs(expected) * 0.001)) {
      flagArithmetic(`${fmt(position.unitPrice.total)} × ${String(quantity)} = ${fmt(expected)} ₽, а в смете ${fmt(position.baseTotal.total)} ₽`, Math.abs(expected - position.baseTotal.total));
    }
  }
  // Индексы: итого в базисных × индекс = итого в текущих.
  if (current && position.currentTotal !== null) {
    const pairs: ReadonlyArray<[string, number | null, number | null, number | null]> = [
      ["ОЗП", position.baseTotal.wage, position.indices?.labour ?? null, position.currentTotal.wage],
      ["ЭМ", position.baseTotal.machines, position.indices?.machines ?? null, position.currentTotal.machines],
      ["М", position.baseTotal.materials, position.indices?.materials ?? null, position.currentTotal.materials],
    ];
    for (const [name, base, index, currentValue] of pairs) {
      if (base === null || index === null || currentValue === null || base === 0) continue;
      const expected = base * index;
      if (Math.abs(expected - currentValue) > Math.max(0.05, Math.abs(expected) * 0.0005)) {
        flagArithmetic(`${name}: ${fmt(base)} × индекс ${fmt(index)} = ${fmt(expected)} ₽, а в смете ${fmt(currentValue)} ₽`, Math.abs(expected - currentValue));
      }
    }
  }
  // НР и СП: сумма = процент × ФОТ; у потока ФОТ — оплата рабочих и машинистов в базисных ценах.
  const fotBase = w + mw;
  for (const [name, charge] of [["НР", position.overhead], ["СП", position.profit]] as const) {
    if (charge === null || charge.percent === null || charge.amount === null) continue;
    const base = estimate.format === "STREAM" ? fotBase : charge.base;
    if (base === null || base === 0) continue;
    const expected = (base * charge.percent) / 100;
    if (Math.abs(expected - charge.amount) > Math.max(estimate.format === "GRID" ? GRID_ROUNDING : 0.02, Math.abs(expected) * 0.001)) {
      flagArithmetic(`${name}: ФОТ ${fmt(base)} × ${String(charge.percent)} % = ${fmt(expected)} ₽, а в смете ${fmt(charge.amount)} ₽`, Math.abs(expected - charge.amount));
    }
  }
  if (printedTotal !== null && Math.abs(piecesTotal - printedTotal) > tolerance(printedTotal, 5) + (estimate.format === "GRID" ? 1 : 0)) {
    flagArithmetic(`сумма составляющих ${fmt(piecesTotal)} ₽ не равна «Всего по позиции» ${fmt(printedTotal)} ₽`, Math.abs(piecesTotal - printedTotal));
  }
  if (printedTotal !== null) arithmeticEffect = piecesTotal - printedTotal;

  /* ---- наши цифры: базисные цены ФЕР-2020 ---- */
  let row: BimBaseCheckRow | null = null;
  let rate: FerRate | null = null;
  let checkedDirect = 0;
  const directBase = sum(position.baseTotal.wage, position.baseTotal.machines, position.baseTotal.materials, supply ? position.baseTotal.total : 0);
  const refDifferences: Array<{ own: string; base: string; position: string }> = [];
  let w2 = w;
  let mw2 = mw;
  let e2 = e;
  let m2 = m;

  if (position.family === "FER" && position.book !== null && position.rateCode !== null) {
    rate = ctx.fer.rate(position.book, position.rateCode);
    if (rate === null) {
      row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: null, status: "NOT_FOUND" };
      unchecked.push({ kind: "RATE_NOT_FOUND", code: position.code, name: position.name, positions: 1, amount: directBase });
    } else if (position.unit !== "" && !sameUnit(position.unit, rate.unit)) {
      row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: null, status: "UNIT_MISMATCH" };
      unchecked.push({ kind: "UNIT_MISMATCH", code: position.code, name: position.name, positions: 1, amount: directBase });
      add({ type: "UNIT_MISMATCH", severity: "INFO", message: `${label0}: единица у заказчика «${position.unit}», в ФЕР-2020 «${rate.unit}» — цена не сверялась`, subject: position.code });
      rate = null;
    } else if (estimate.format === "GRID" && position.coefficients.hasUnparsed) {
      row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: null, status: "COEFFICIENTS_UNPARSED" };
      unchecked.push({ kind: "COEFFICIENTS_UNPARSED", code: position.code, name: position.name, positions: 1, amount: directBase });
      rate = null;
    }

    if (rate !== null) {
      // Цены таблицы уже с коэффициентами позиции; поток печатает цену расценки без них, коэффициент стоит отдельной графой.
      const k = estimate.format === "GRID" ? position.coefficients : { wage: 1, machines: 1, machinistWage: 1, materials: 1 };
      const expected = expectedUnitPrice(rate, k);
      // Позиция с формулой пересчёта цены: заказчик вынес часть материалов отдельными строками, материалы не сверяются.
      const skipMaterials = position.priceFormula !== null;
      const compare: Array<[string, number | null, number]> = [
        ["ОЗП", uPrice.wage, expected.wage],
        ["ЭМ", uPrice.machines, expected.machines],
        ["ОТм", uPrice.machinistWage, expected.machinistWage],
      ];
      if (!skipMaterials) compare.push(["материалы", uPrice.materials, expected.materials]);
      const diffs: string[] = [];
      for (const [name, customerValue, ours] of compare) {
        // Нет напечатанной цены элемента (в ФЕР ноль или таблица её не показывает): пропускаем, а не считаем нулём.
        if (customerValue === null) continue;
        if (!approxEqual(customerValue, ours, 0.006)) diffs.push(`${name} ${fmt(customerValue)} ₽, в ФЕР-2020 ${fmt(ours)} ₽`);
      }
      const matched = diffs.length === 0;
      const customerPrice = position.unitPrice.total ?? sum(uPrice.wage, uPrice.machines, uPrice.materials);
      row = {
        number: position.number,
        code: position.code,
        customerPrice: Number.isFinite(customerPrice) ? customerPrice : null,
        ferPrice: skipMaterials ? expected.wage + expected.machines : expected.total,
        status: matched ? "MATCH" : "MISMATCH",
      };
      checkedDirect = directBase;
      if (!matched) {
        add({
          type: "FER_PRICE",
          severity: "WARNING",
          message: `${label0}: расценка ${position.code} — у заказчика ${diffs.join("; ")}${position.priceFormula === null ? "" : " (материалы не сверялись: цена пересчитана заказчиком формулой)"}`,
          subject: position.code,
          customerValue: customerPrice,
          ourValue: expected.total,
        });
        // Наши базисные суммы по позиции: цена ФЕР × поправочные коэффициенты (как напечатаны) × объём.
        const factor = estimate.format === "STREAM" ? position.coefficients : { wage: 1, machines: 1, machinistWage: 1, materials: 1 };
        w2 = expected.wage * quantity * factor.wage;
        mw2 = expected.machinistWage * quantity * factor.machinistWage;
        e2 = expected.machines * quantity * factor.machines;
        m2 = skipMaterials ? m : expected.materials * quantity * factor.materials;
      }
    }
  } else if (position.family === "MATERIAL" && position.rateCode !== null) {
    const resource = ctx.fer.material(position.rateCode);
    if (resource === null) {
      row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: null, status: "NOT_FOUND" };
      unchecked.push({ kind: "RATE_NOT_FOUND", code: position.code, name: position.name, positions: 1, amount: directBase });
    } else if (position.unit !== "" && !sameUnit(position.unit, resource.unit)) {
      row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: null, status: "UNIT_MISMATCH" };
      unchecked.push({ kind: "UNIT_MISMATCH", code: position.code, name: position.name, positions: 1, amount: directBase });
    } else if (position.unitPrice.total !== null) {
      const matched = approxEqual(position.unitPrice.total, resource.cost, 0.006);
      row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: resource.cost, status: matched ? "MATCH" : "MISMATCH" };
      checkedDirect = directBase;
      if (!matched) {
        add({
          type: "FER_PRICE",
          severity: included ? "WARNING" : "INFO",
          message: `${label0}: материал ${position.rateCode} — у заказчика ${fmt(position.unitPrice.total)} ₽, в ФССЦ-2020 ${fmt(resource.cost)} ₽${included ? "" : " (позиция не входит в итог сметы)"}`,
          subject: position.code,
          customerValue: position.unitPrice.total,
          ourValue: resource.cost,
        });
        m2 = resource.cost * quantity;
      }
    }
  } else if (position.family === "TRANSPORT" && position.rateCode !== null) {
    const service = ctx.fer.transport(position.rateCode);
    if (service === null) {
      row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: null, status: "NOT_FOUND" };
      unchecked.push({ kind: "RATE_NOT_FOUND", code: position.code, name: position.name, positions: 1, amount: directBase });
    } else if (position.unitPrice.total !== null) {
      const matched = approxEqual(position.unitPrice.total, service.cost, 0.006);
      row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: service.cost, status: matched ? "MATCH" : "MISMATCH" };
      checkedDirect = directBase;
      if (!matched) {
        add({
          type: "FER_PRICE",
          severity: "WARNING",
          message: `${label0}: перевозка ${position.rateCode} — у заказчика ${fmt(position.unitPrice.total)} ₽ за единицу, в ФССЦпг-2020 ${fmt(service.cost)} ₽`,
          subject: position.code,
          customerValue: position.unitPrice.total,
          ourValue: service.cost,
        });
        m2 = service.cost * quantity;
      }
    }
  } else if (position.family === "TER") {
    row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: null, status: "TER_NO_BASE" };
    unchecked.push({ kind: "TER_NO_BASE", code: position.code, name: position.name, positions: 1, amount: directBase });
  } else {
    row = { number: position.number, code: position.code, customerPrice: position.unitPrice.total, ferPrice: null, status: "OTHER_BASE" };
    unchecked.push({ kind: "OTHER_BASE", code: position.code, name: position.name, positions: 1, amount: directBase });
  }

  /* ---- индексы письма (шаг B) ---- */
  const letter = facts.letterIndices.get(FAMILY_BASE[position.family] ?? "FER") ?? null;
  let ourIndex: IndexSet = customerIndex;
  if (current && letter !== null) {
    const pick = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);
    ourIndex = {
      labour: pick(letter.indices.labour, customerIndex.labour),
      machines: pick(letter.indices.machines, customerIndex.machines),
      materials: pick(letter.indices.materials, customerIndex.materials),
    };
  }

  /* ---- нормативы НР и СП (шаг C) ---- */
  let ourOhPercent = position.overhead?.percent ?? null;
  let ourPrPercent = position.profit?.percent ?? null;
  const refOverhead = normativeRef(position.overhead?.ref ?? null) ?? (rate === null ? null : normativeRef(rate.overheadRef));
  const refProfit = normativeRef(position.profit?.ref ?? null) ?? (rate === null ? null : normativeRef(rate.profitRef));
  const normsChecked = estimate.overheadNorms !== "MDS";
  if (normsChecked) {
    for (const [name, charge, ref, type] of [
      ["НР", position.overhead, refOverhead, "OVERHEAD_RATE"],
      ["СП", position.profit, refProfit, "PROFIT_RATE"],
    ] as const) {
      if (charge === null || charge.percent === null) continue;
      if (ref === null) continue;
      const normative = ctx.overheadRates.get(ref);
      if (normative === undefined) continue;
      if (Math.abs(normative.percent - charge.percent) <= 0.5) continue;
      // Заказчик мог взять другой пункт приказа для своего вида объекта: это «проверьте», а не ошибка, если он назвал свой указатель.
      const ownRef = charge.ref !== null;
      const warning = estimate.overheadNorms === "812_774" || ownRef;
      add({
        type,
        severity: warning ? "WARNING" : "INFO",
        message:
          `${label0}: ${name} ${ref} — у заказчика ${String(charge.percent)} %, по приказу ${String(normative.percent)} %` +
          (estimate.overheadNorms === null && !ownRef ? "; в смете не названы нормативы НР и СП (возможно, МДС 81-33.2004) — по указателю расценки ФЕР-2020 они по приказам 812/пр и 774/пр" : ""),
        subject: ref,
        customerValue: charge.percent,
        ourValue: normative.percent,
      });
      if (warning) {
        if (name === "НР") ourOhPercent = normative.percent;
        else ourPrPercent = normative.percent;
      }
    }
    // Указатель заказчика отличается от указателя расценки в базе — справка (вид объекта может быть другим); сводится в одну находку.
    if (rate !== null) {
      const own = normativeRef(position.overhead?.ref ?? null);
      const baseRef = normativeRef(rate.overheadRef);
      if (own !== null && baseRef !== null && own !== baseRef) refDifferences.push({ own, base: baseRef, position: position.number });
    }
  }

  /* ---- пересчёт: шаги A, B, C ---- */
  const ohC = ohBase;
  const prC = prBase;
  const fotC = w + mw;
  const fotO = w2 + mw2;
  const chargeRate = fotC > 0 ? (ohC + prC) / fotC : ((position.overhead?.percent ?? 0) + (position.profit?.percent ?? 0)) / 100;
  const ohA = fotC > 0 ? ohC * (fotO / fotC) : fotO * ((position.overhead?.percent ?? 0) / 100);
  const prA = fotC > 0 ? prC * (fotO / fotC) : fotO * ((position.profit?.percent ?? 0) / 100);
  const ohOur = position.overhead?.percent && ourOhPercent !== null ? ohA * (ourOhPercent / position.overhead.percent) : ohA;
  const prOur = position.profit?.percent && ourPrPercent !== null ? prA * (ourPrPercent / position.profit.percent) : prA;

  const labourA = (w2 - w) * customerIndex.labour + chargeRate * (fotO - fotC) * customerIndex.labour;
  const machinesA = (e2 - e) * customerIndex.machines;
  const materialsA = (m2 - m) * customerIndex.materials;
  const labourB = (ourIndex.labour - customerIndex.labour) * (w2 + ohA + prA);
  const machinesB = (ourIndex.machines - customerIndex.machines) * e2;
  const materialsB = (ourIndex.materials - customerIndex.materials) * m2;
  const overheadC = (ohOur - ohA) * ourIndex.labour;
  const profitC = (prOur - prA) * ourIndex.labour;

  impacts.LABOUR.amount = labourA + labourB;
  impacts.MACHINES.amount = machinesA + machinesB;
  impacts.MATERIALS.amount = materialsA + materialsB;
  impacts.OVERHEAD.amount = overheadC;
  impacts.PROFIT.amount = profitC;
  impacts.ARITHMETIC.amount = arithmeticEffect;
  sources.basePrices = labourA + machinesA + materialsA;
  sources.indices = labourB + machinesB + materialsB;
  sources.norms = overheadC + profitC;
  sources.arithmetic = arithmeticEffect;
  indexImpact.LABOUR = labourB;
  indexImpact.MACHINES = machinesB;
  indexImpact.MATERIALS = materialsB;
  for (const group of ["LABOUR", "MACHINES", "MATERIALS"] as const) if (Math.abs(impacts[group].amount) >= 0.005) impacts[group].rows += 1;
  if (Math.abs(overheadC) >= 0.005) impacts.OVERHEAD.rows += 1;
  if (Math.abs(profitC) >= 0.005) impacts.PROFIT.rows += 1;

  const ours = piecesTotal + labourA + machinesA + materialsA + labourB + machinesB + materialsB + overheadC + profitC;
  const customerBase = printedTotal ?? piecesTotal;
  const diff = included ? ours - customerBase : 0;
  if (!included) {
    for (const group of Object.keys(impacts) as ImpactGroup[]) impacts[group] = { amount: 0, rows: 0 };
    sources.basePrices = 0;
    sources.indices = 0;
    sources.norms = 0;
    sources.arithmetic = 0;
  }
  const flags = [...new Set(findings.filter((finding) => finding.severity === "WARNING").map((finding) => finding.type))];
  return {
    position: {
      number: Number.parseFloat(position.number),
      code: position.code,
      name: position.name,
      section: position.section,
      customerTotal: customerBase,
      ourTotal: included ? ours : customerBase,
      diff,
      flags,
      checkedShare: directBase > 0 ? Math.min(1, checkedDirect / directBase) : 0,
    },
    findings,
    impacts,
    checkedDirect: included ? checkedDirect : 0,
    totalDirect: included ? directBase : 0,
    unchecked,
    row,
    sources,
    indexImpact,
    included,
    refDifferences,
  };
}

/* ------------------------------ Смета ------------------------------ */

/** Квартал по дате письма: «2026-07-23» → III квартал 2026. */
function quarterOfDate(date: string): BimQuarterKey | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (match === null) return null;
  return { year: Number.parseInt(match[1] as string, 10), quarter: Math.floor((Number.parseInt(match[2] as string, 10) - 1) / 3) + 1 };
}

const quartersBetween = (from: BimQuarterKey, to: BimQuarterKey): number => (to.year - from.year) * 4 + (to.quarter - from.quarter);

export function auditCustomerBim(estimate: CustomerBim, ctx: BimAuditContext): AuditReport {
  const facts = factsOf(estimate, ctx);
  const findings: AuditFinding[] = [];

  // Строки поставки (ФССЦ) в итог таблицы не входят, если итог прямых затрат сходится только без них: тогда их цены — справка.
  let suppliesExcluded = false;
  if (estimate.format === "GRID" && estimate.directBase?.total != null) {
    const printed = estimate.directBase.total;
    const rateSum = sum(...estimate.positions.filter((p) => p.family !== "MATERIAL" && p.family !== "TRANSPORT" && p.family !== "CUSTOMER_PRICE").map((p) => p.baseTotal.total));
    const allSum = sum(...estimate.positions.map((p) => p.baseTotal.total));
    const slack = estimate.positions.length * 0.51 + 1;
    suppliesExcluded = Math.abs(rateSum - printed) <= slack && Math.abs(allSum - printed) > slack;
  }

  const outcomes = estimate.positions.map((position) => auditPosition(estimate, position, facts, ctx, suppliesExcluded));
  const positions = outcomes.map((outcome) => outcome.position);
  for (const outcome of outcomes) findings.push(...outcome.findings);

  const printedTotal = estimate.total;
  const totalMissing = printedTotal === null;
  const customerTotal = printedTotal ?? estimate.positionsTotal;

  const priceDiff = outcomes.reduce((total, outcome) => total + outcome.position.diff, 0);
  const repricedTotal = customerTotal + priceDiff;

  const summary = emptySummary();
  for (const outcome of outcomes) {
    for (const group of Object.keys(summary) as ImpactGroup[]) {
      summary[group].amount += outcome.impacts[group].amount;
      summary[group].count += outcome.impacts[group].rows;
    }
  }
  for (const finding of findings) {
    if (finding.type === "ARITHMETIC" && finding.discrepancy !== undefined) summary.ARITHMETIC.discrepancy += finding.discrepancy;
  }
  const diff = priceDiff;

  // Указатели НР, отличные от указателя расценки в ФЕР-2020: одна справка на пару указателей, а не по строке на позицию.
  const refGroups = new Map<string, { own: string; base: string; positions: string[] }>();
  for (const outcome of outcomes) {
    for (const item of outcome.refDifferences) {
      const key = `${item.own}|${item.base}`;
      const group = refGroups.get(key) ?? { own: item.own, base: item.base, positions: [] };
      group.positions.push(item.position);
      refGroups.set(key, group);
    }
  }
  for (const group of refGroups.values()) {
    findings.push({
      type: "RATE_NOT_CHECKED",
      severity: "INFO",
      positionNumber: null,
      message:
        `НР по указателю ${group.own}, а у ${String(group.positions.length)} ${group.positions.length === 1 ? "расценки" : "расценок"} в ФЕР-2020 указатель ${group.base} (поз. ${group.positions.slice(0, 12).join(", ")}${group.positions.length > 12 ? " …" : ""}): ` +
        "допустимо, если вид объекта другой, — проверьте",
      impact: null,
      subject: group.own,
    });
  }

  /* ---- индексы: итоговые находки ---- */
  const current = estimate.priceLevel === "CURRENT";
  const customerValues = (pick: (position: BimPosition) => number | null | undefined): number | null =>
    // Индексы элементов — по расценкам: у перевозки и поставки свой индекс статьи, он не «индекс сметы».
    modal(
      outcomes
        .flatMap((outcome, at) => {
          const position = estimate.positions[at] as BimPosition;
          return outcome.included && (position.family === "FER" || position.family === "TER") ? [pick(position)] : [];
        })
        .filter((value): value is number => typeof value === "number" && value > 0),
    );
  const customerIndices: BimIndexTriple | null = current
    ? {
        labour: customerValues((p) => p.indices?.labour ?? p.indices?.machinistLabour),
        machines: customerValues((p) => p.indices?.machines),
        materials: customerValues((p) => p.indices?.materials),
      }
    : null;
  const ferLetter = facts.letterIndices.get("FER") ?? facts.letterIndices.get("TER") ?? null;
  const deviations: BimAuditDetails["indexDeviations"][number][] = [];
  let indexStatus: BimAuditDetails["indexStatus"] = current ? "NOT_CHECKED" : "NOT_APPLIED";
  let indexNote = "";

  if (!current) {
    indexNote = "в смете индексов нет: она составлена в базисных ценах 2001 года, пересчёт в текущие цены выполняется отдельно (сводный сметный расчёт)";
    if (estimate.indexStatements.length > 0) {
      const named = estimate.indexStatements.filter((statement) => statement.kind !== "QUARTER").slice(0, 6).map((statement) => statement.text);
      if (named.length > 0) indexNote += `; в тексте названо: ${named.join("; ")}`;
    }
  } else if (ferLetter === null) {
    indexNote = facts.lookupNotes.length === 0 ? "индексы письма найти не удалось" : facts.lookupNotes.join("; ");
    const objects = facts.object === null && facts.objectCandidates.length > 0 ? ` Кандидаты: ${facts.objectCandidates.join("; ")}.` : "";
    findings.push({
      type: "INDEX_NOT_CHECKED",
      severity: "INFO",
      positionNumber: null,
      message:
        `Индексы заказчика (${[customerIndices?.labour != null ? `ОЗП ${fmt(customerIndices.labour)}` : null, customerIndices?.machines != null ? `ЭМ ${fmt(customerIndices.machines)}` : null, customerIndices?.materials != null ? `материалы ${fmt(customerIndices.materials)}` : null].filter(Boolean).join(", ")}) не сверены с письмом Минстроя: ${indexNote}.${objects}`,
      impact: null,
    });
  } else {
    indexStatus = "CHECKED";
    const letterRef = ferLetter.text;
    const where = `${facts.subject ?? ""}${facts.zone === null ? "" : `, ${String(facts.zone)} зона`}, ${ferLetter.object}`;
    const letterIndex = (field: "labour" | "machines" | "materials"): number | null => {
      const value = ferLetter.indices[field];
      return Number.isFinite(value) ? value : null;
    };
    for (const item of ELEMENTS) {
      const customer = customerIndices?.[item.field] ?? null;
      const letter = letterIndex(item.field);
      if (customer === null || letter === null) continue;
      if (Math.abs(customer - letter) <= INDEX_TOLERANCE) continue;
      const impact = outcomes.reduce((total, outcome) => total + outcome.indexImpact[item.element], 0);
      deviations.push({ element: item.element, customer, letter, impact });
      const direction = impact >= 0 ? "занижено" : "завышено";
      findings.push({
        type: "INDEX_VALUE",
        severity: "WARNING",
        positionNumber: null,
        message:
          `Заказчик применил индекс к ${item.word} ${fmt(customer)}, по письму ${letterRef} для ${where} — ${fmt(letter)}: ${direction} на ${rub(impact)}` +
          (item.element === "LABOUR" ? " (вместе с накладными расходами и сметной прибылью на оплату труда)" : ""),
        impact,
        subject: item.element,
        customerValue: customer,
        ourValue: letter,
      });
    }
    if (deviations.length === 0) {
      indexNote = `индексы заказчика совпали с письмом ${letterRef} для ${where}`;
      findings.push({ type: "INDEX_NOT_CHECKED", severity: "INFO", positionNumber: null, message: `Индексы заказчика сверены с письмом: ${indexNote}`, impact: null });
    } else {
      indexNote = `индексы сверены с письмом ${letterRef} для ${where}: расхождений ${String(deviations.length)}`;
    }
  }

  // Квартал: цены сметы против квартала писем, на которые она ссылается.
  const declared = estimate.quarter;
  if (current && declared !== null) {
    const cited = estimate.indexStatements.filter((statement) => statement.kind === "LETTER" && statement.letterDate !== undefined);
    const dated = cited
      .map((statement) => ({ statement, quarter: quarterOfDate(statement.letterDate as string) }))
      .filter((item): item is { statement: (typeof cited)[number]; quarter: BimQuarterKey } => item.quarter !== null);
    // Находка только когда ВСЕ названные письма — прошлых кварталов: смета, ссылающаяся и на письма своего квартала, индексы
    // квартала знает (письма прошлых кварталов в ней — по другим затратам: проектные работы, оборудование).
    const allStale = dated.length > 0 && dated.every((item) => quartersBetween(item.quarter, declared) > 0);
    if (allStale && estimate.quarterSource === "ESTIMATE") {
      const latest = [...dated].sort((a, b) => b.quarter.year - a.quarter.year || b.quarter.quarter - a.quarter.quarter)[0] as (typeof dated)[number];
      const back = quartersBetween(latest.quarter, declared);
      findings.push({
        type: "INDEX_QUARTER",
        severity: "WARNING",
        positionNumber: null,
        message:
          `Смета составлена в ценах ${quarterLabel(declared)}, а индексы взяты из письма ${latest.statement.letterNumber ?? ""} от ${latest.statement.letterDate ?? ""} (${quarterLabel(latest.quarter)}): ` +
          `индексы ${String(back)} ${back === 1 ? "квартал" : "квартала"} назад`,
        impact: null,
      });
    }
  }
  // Актуальность: смета в ценах квартала старше последнего, на который есть письма.
  const latest = ctx.indices.quarters[0];
  if (declared !== null && latest !== undefined && quartersBetween(declared, latest) > 0) {
    findings.push({
      type: "OUTDATED_PRICE_LEVEL",
      severity: "WARNING",
      positionNumber: null,
      message: `Смета составлена в ценах ${quarterLabel(declared)}, наши индексы — ${quarterLabel(latest)}: устарела на ${quartersWord(quartersBetween(declared, latest))}`,
      impact: null,
    });
  }

  /* ---- сверка базисных цен и справки ---- */
  const rows = outcomes.map((outcome) => outcome.row).filter((row): row is BimBaseCheckRow => row !== null);
  const count = (status: BimBaseCheckRow["status"]): number => rows.filter((row) => row.status === status).length;
  const compared = count("MATCH") + count("MISMATCH");
  const baseChecks = {
    compared,
    matched: count("MATCH"),
    mismatched: count("MISMATCH"),
    terNotChecked: count("TER_NO_BASE"),
    otherNotChecked: count("OTHER_BASE"),
    notFound: count("NOT_FOUND"),
  };
  if (compared > 0) {
    const examples = rows.filter((row) => row.status === "MATCH").slice(0, 3).map((row) => `расценка ${row.code}: у заказчика ${fmt(row.customerPrice ?? 0)} ₽, в ФЕР-2020 ${fmt(row.ferPrice ?? 0)} ₽ — совпало`);
    findings.push({
      type: "FER_PRICE",
      severity: "INFO",
      positionNumber: null,
      message:
        `Базисные цены сверены с ФЕР-2020 (уровень 01.01.2000) у ${String(compared)} позиций: совпали у ${String(baseChecks.matched)}, расходятся у ${String(baseChecks.mismatched)}.` +
        (examples.length === 0 ? "" : ` Например, ${examples.join("; ")}.`),
      impact: null,
    });
  }
  if (baseChecks.terNotChecked > 0) {
    const region = facts.subject ?? "региона";
    findings.push({
      type: "BASE_NOT_CHECKED",
      severity: "INFO",
      positionNumber: null,
      message: `ТЕР ${region} — базисные цены не проверены, нет открытой базы (позиций ${String(baseChecks.terNotChecked)}). Индексы к ТЕР в письмах Минстроя есть, цены ТЕР-2001 — только в закрытой базе региона.`,
      impact: null,
    });
  }
  if (baseChecks.otherNotChecked > 0) {
    findings.push({
      type: "BASE_NOT_CHECKED",
      severity: "INFO",
      positionNumber: null,
      message: `Корпоративные и прочие расценки (КОЕР, КССЦ, цены по запросу) — не с чем сравнить: позиций ${String(baseChecks.otherNotChecked)}.`,
      impact: null,
    });
  }
  if (baseChecks.notFound > 0) {
    findings.push({ type: "BASE_NOT_CHECKED", severity: "INFO", positionNumber: null, message: `Шифра нет в ФЕР-2020 (опечатка в шифре или расценка из другой редакции базы): позиций ${String(baseChecks.notFound)}.`, impact: null });
  }
  if (suppliesExcluded) {
    findings.push({
      type: "BASE_NOT_CHECKED",
      severity: "INFO",
      positionNumber: null,
      message: "Строки поставки (ФССЦ) в итог прямых затрат сметы не входят — материалы и оборудование показаны справочно; их цены сверены, но на итог не влияют.",
      impact: null,
    });
  }

  const overheadChecked = estimate.overheadNorms !== "MDS";
  const overheadNote =
    estimate.overheadNorms === "MDS"
      ? "НР и СП начислены по МДС 81-33.2004 и 81-25.2001: их нормативов в открытых данных ФГИС ЦС нет, проценты не проверялись"
      : estimate.overheadNorms === "812_774"
        ? "НР и СП — по приказам 812/пр и 774/пр: проценты сверены с нашими нормативами"
        : "в смете не названы нормативы НР и СП: проценты сверены с приказами 812/пр и 774/пр по указателям расценок ФЕР-2020";
  if (!overheadChecked) {
    findings.push({ type: "RATE_NOT_CHECKED", severity: "INFO", positionNumber: null, message: overheadNote, impact: null });
  }

  const merged = new Map<string, UncheckedItem>();
  for (const item of outcomes.flatMap((outcome) => outcome.unchecked)) {
    const key = `${item.kind}|${item.code}`;
    const existing = merged.get(key);
    merged.set(key, existing === undefined ? item : { ...existing, positions: existing.positions + item.positions, amount: existing.amount + item.amount });
  }

  const checkedDirect = outcomes.reduce((total, outcome) => total + outcome.checkedDirect, 0);
  const totalDirect = outcomes.reduce((total, outcome) => total + outcome.totalDirect, 0);
  const coverage = totalDirect > 0 ? Math.min(1, checkedDirect / totalDirect) : 0;
  const diffPercent = customerTotal === 0 ? null : (diff * 100) / customerTotal;
  const conclusion = describeConclusion(diff, diffPercent, coverage);
  const top = [...positions].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10).filter((position) => Math.abs(position.diff) > 0);

  const sourcesTotal = outcomes.reduce(
    (total, outcome) => ({
      basePrices: total.basePrices + outcome.sources.basePrices,
      indices: total.indices + outcome.sources.indices,
      norms: total.norms + outcome.sources.norms,
      arithmetic: total.arithmetic + outcome.sources.arithmetic,
    }),
    { basePrices: 0, indices: 0, norms: 0, arithmetic: 0 },
  );

  const primaryBase: BimBase = estimate.positions.filter((position) => position.family === "TER").length > estimate.positions.filter((position) => position.family === "FER").length ? "TER" : "FER";
  const bim: BimAuditDetails = {
    subject: facts.subject,
    zone: facts.zone,
    subjectSource: facts.subjectSource,
    object: facts.object,
    objectReason: facts.objectReason,
    objectCandidates: facts.objectCandidates,
    customerQuarter: estimate.quarter,
    quarterSource: estimate.quarterSource,
    base: primaryBase,
    indexStatus,
    indexNote,
    customerIndices,
    letterIndices:
      ferLetter === null
        ? null
        : {
            labour: Number.isFinite(ferLetter.indices.labour) ? ferLetter.indices.labour : null,
            machines: Number.isFinite(ferLetter.indices.machines) ? ferLetter.indices.machines : null,
            materials: Number.isFinite(ferLetter.indices.materials) ? ferLetter.indices.materials : null,
            letterNumber: ferLetter.letterNumber,
            letterDate: ferLetter.letterDate,
            object: ferLetter.object,
          },
    baseChecks,
    rows: rows.slice(0, MAX_ROWS),
    overheadNorms: estimate.overheadNorms,
    overheadChecked,
    overheadNote,
    impactBySource: sourcesTotal,
    indexDeviations: deviations,
  };

  const zoneLabel = `${facts.subject ?? "субъект не определён"}${facts.zone === null ? "" : `, ${String(facts.zone)} зона`}`;
  return {
    documentName: estimate.documentName,
    estimateName: estimate.estimateName,
    customerTotal,
    totalMissing,
    repricedTotal,
    diff,
    diffPercent,
    vat: { included: false, customerPercent: estimate.vatPercent, inferred: false, ourPercent: ctx.vatPercent ?? 22 },
    impacts: summary,
    coverage,
    checkedDirect,
    totalDirect,
    positions,
    top,
    findings,
    unchecked: [...merged.values()].sort((a, b) => b.amount - a.amount),
    verdict: conclusion.verdict,
    conclusion: conclusion.text,
    zone: zoneLabel,
    period: estimate.quarter === null ? "базисные цены 01.01.2000" : quarterLabel(estimate.quarter),
    priceQuarter: estimate.quarter,
    method: "BASE_INDEX",
    bim,
  };
}

export type { AuditFindingType };
