import { isServiceName, serviceRowCodeOf } from "@/domain/estimate/autoServices";
import { resourceCodeFromJustification, type BillRejectionReason } from "@/domain/estimate/billExtraction";
import { evaluateCustomerConditions, hasConfirmedConditions } from "@/domain/estimate/customerCoefficients";
import type { CustomerPosition } from "@/domain/estimate/customerLsr";
import type { LsrEntry } from "@/domain/estimate/customerLsrSet";
import { parseNormCodeHint } from "@/domain/estimate/normCodes";
import { classifyResourceCode } from "@/domain/estimate/resourceKinds";
import type { BillOfWorkItem, BillOfWorkSection, CustomerMaterialRow, CustomerPrice, NormResource, ResourceKind } from "@/domain/estimate/types";
import { parseUnit } from "@/domain/estimate/units";

/**
 * Ведомость объёмов из локальной сметы заказчика — кодом, без модели.
 *
 * Зачем. Смета формы 421/пр уже содержит всё, что модель добывает из текста догадкой: шифр
 * расценки, наименование, единицу, объём «с учётом коэффициентов» и цену заказчика.
 * `parseCustomerLsr` читает её построчно и сверяет с итогом сметы. Чтение моделью такой
 * сметы стоило токенов и теряло строки: на закупке 0302300048726001118 одна смета занимает
 * сто тысяч знаков, ответ обрывался по лимиту, и из ~150 позиций шести смет доходили 27.
 * Поэтому позиции переносятся в ведомость кодом: ничего не выдумано, ничего не потеряно.
 *
 * Что становится строкой ведомости.
 * - Позиция верхнего уровня — работа по расценке ГЭСН (шифр берётся из обоснования, а не ищется по наименованию).
 * - Подпозиция «3.1 ФСБЦ-…» — поставка материала: считается по справочнику цен зоны.
 * - Подпозиция «1.1 О ТЦ_…», КП, прайс — оборудование и материалы по цене заказчика: нашей нормы у них нет,
 *   но деньги не теряются — позиция входит по цене заказчика и помечена как допущение.
 * - Подпозиция «3.1 ГЭСН…» — самостоятельная расценка (монтаж насоса под демонтажем), строка как у позиции.
 * Цена заказчика для строки — «Всего по позиции» в текущем уровне цен.
 * Позиция по ТЦ, КП, прайсу без единицы в смете не пропускается: единица «шт» или «компл» принимается и называется в цитате.
 * Невидимый остаток позиции выделяется только при известной видимой части (`hiddenRemainderOf`): у позиции по расценке НР и СП есть всегда,
 * и не прочитанные строки начислений остатком не становятся. Остаток несёт «М» заказчика (`customerPrintedMaterials`): расчёт зачтёт в нём
 * материалы нормы, которые она уже оценила сверх этой «М». Материалы с ценой заказчика
 * лежат в позиции строками (`customerMaterialRows`) — на случай материала нормы «по проекту».
 * Перевозка и погрузка-разгрузка («03-1 Погрузка …», «02-15-1-01-0047 Перевозка грузов …») — услуги по сметным ценам: строка помечена
 * `serviceRow`, шифр — `serviceCode`, к расценке по наименованию она не подбирается.
 * Смета по ТСН-2001 Москвы (`CustomerLsr.base`): расценки не ГЭСН, норм ТСН у нас нет. Шифр в подсказку не читается (цифры ТСН-2001.13 похожи на
 * ГЭСН, но работа другая), позиция несёт `foreignBase`: норма ищется по наименованию, как у строки без шифра, подбор помечен «проверьте», а без
 * уверенного подбора позиция идёт по цене заказчика. Один пробел на документ («смета заказчика по ТСН-2001, наша — ФСНБ-2022») добавляет расчёт.
 * Smeta.RU: «Всего по позиции» уже включает подстроки «1.1 …» (поставка материала, 2 % вспомогательных материалов), печатаемые до итога, — это
 * дополнения позиции (`CustomerResource.extra`), и невидимый остаток считается от них так же, как у выгрузок Гранд-Сметы с подстроками внутри позиции.
 *
 * Единица и объём. Объём — графа 7 («всего с учётом коэффициентов»), единица приводится так же, как у
 * строк модели: «100 шт» × 0,08 → 8 шт; делитель под единицу нормы ставит расчёт, когда норма подобрана.
 * Коэффициенты, которые заказчик применил к норме («ОЗП=1,2», «в помещениях эксплуатируемого объекта», п. 58),
 * сверяются с приложением 10 к 421/пр (`customerCoefficients.ts`): подтверждённые расчёт применяет к той же
 * позиции (`customerConditions`), неподтверждённые остаются подсказкой в `customerCoefficients` и в цитате строки.
 */

export interface LsrSkippedPosition {
  readonly label: string;
  readonly name: string;
  readonly reason: BillRejectionReason;
  readonly message: string;
}

export interface LsrBill {
  readonly section: BillOfWorkSection;
  /** Позиции сметы, которые в ведомость не попали, с причиной: молча ничего не теряется. */
  readonly skipped: readonly LsrSkippedPosition[];
}

const RUB = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatQuantity(value: number): string {
  return String(Math.round(value * 1e6) / 1e6).replace(".", ",");
}

/** Порядок позиций сметы: «3», «3.1», «3.2», «4»; позиции и подпозиции хранятся порознь. */
export function documentOrder(entry: LsrEntry): CustomerPosition[] {
  const all = [...entry.estimate.positions, ...(entry.estimate.subPositions ?? [])];
  const minor = (position: CustomerPosition): number => {
    const match = /^\d+\.(\d+)/.exec(position.label ?? "");
    return match === null ? 0 : Number.parseInt(match[1] as string, 10);
  };
  return all
    .map((position, index) => ({ position, index }))
    .sort(
      (left, right) =>
        left.position.number - right.position.number ||
        minor(left.position) - minor(right.position) ||
        left.index - right.index,
    )
    .map(({ position }) => position);
}

/** Первая строка обоснования: в ячейке бывает «ФСБЦ-…\nприменительно\nСплит-форма …». */
function firstLine(raw: string): string {
  return (raw.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
}

function customerPriceOf(
  position: CustomerPosition,
  quantity: number,
  unit: string,
  document: string,
): CustomerPrice | null {
  const signed = position.total ?? position.ownTotal;
  // У исключения сумма отрицательная; строка вычитает сама, цена хранится положительной.
  const total = signed === null ? null : Math.abs(signed);
  if (total === null || !(total > 0) || !(quantity > 0)) return null;
  return { total, unitPrice: total / quantity, unit, origin: "POSITION_TOTAL", document };
}

function coefficientsOf(position: CustomerPosition): string | null {
  const parts: string[] = [];
  if (position.coefficients !== null) parts.push(position.coefficients);
  for (const note of position.notes ?? []) parts.push(note.text);
  const unique = [...new Set(parts.map((part) => part.replace(/\s+/g, " ").trim()).filter((part) => part !== ""))];
  return unique.length === 0 ? null : unique.join("; ");
}

const money = (value: number): string => RUB.format(value);

/** Расход ресурса на единицу позиции — для состава позиции по строкам ЛСР. */
const KNOWN_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>(["LABOUR", "MACHINE", "MATERIAL", "MACHINIST_HOURS"]);

/**
 * Ресурсный состав позиции по строкам ЛСР заказчика (графа 5 — расход на единицу, до коэффициентов: коэффициенты расчёт
 * применяет сам). null — состав использовать нельзя: строк нет, у какой-то строки нет расхода на единицу, код не опознан или цена у
 * строки — коммерческое предложение (нашей цены на неё нет, и состав без неё был бы неполным).
 */
export function compositionOf(position: CustomerPosition): NormResource[] | null {
  const priced = position.resources.filter((resource) => !resource.unaccounted);
  if (priced.length === 0) return null;
  const result: NormResource[] = [];
  for (const resource of priced) {
    const kind = classifyResourceCode(resource.code);
    if (!KNOWN_KINDS.has(kind) || resource.customerPrice || resource.qtyPerUnit === null || !(resource.qtyPerUnit >= 0)) return null;
    result.push({
      code: resource.code,
      kind,
      name: resource.name,
      quantity: resource.qtyPerUnit,
      unit: resource.unit,
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    });
  }
  return result;
}

/**
 * Во сколько раз невидимый остаток может превышать прямые затраты позиции. Выше — это не материал «по проекту», а ошибка
 * разбора (начисления НР и СП прочитаны не целиком, «Всего по позиции» относится к другой структуре позиции): на закупке
 * по Камчатке остаток вышел в 11 раз больше прямых затрат и добавил 74 млн ₽ (+70 % к ЛСР). Настоящий остаток в образцах — до 0,4 прямых затрат
 * (поз. 6 ЛСР 02-02-08 закупки 0302300048726001118); десятикратный запас оставляет место дорогому материалу «по проекту»
 * (труба, кабель) и отсекает фантомы.
 */
export const HIDDEN_REMAINDER_MAX_RATIO = 10;
/** Нижняя граница допуска остатка, ₽: у позиции с копеечными прямыми затратами материал «по проекту» всё равно может стоить тысячи. */
export const HIDDEN_REMAINDER_MIN_ALLOWANCE = 5_000;

export type HiddenRemainderStatus =
  /** Остатка нет: видимые составляющие сходятся с «Всего по позиции» (или нечего сверять). */
  | { readonly kind: "NONE" }
  | { readonly kind: "FOUND"; readonly remainder: number; readonly visible: number }
  /** Сумма НР или СП в смете не прочитана и по ФОТ × процент не выводится: видимую часть назвать нельзя, остаток не считается. */
  | { readonly kind: "ACCRUALS_UNKNOWN"; readonly reason: string }
  /** Остаток вышел, но не похож на материал «по проекту»: отрицательный для положительной позиции или несоразмерный прямым затратам. */
  | { readonly kind: "IMPLAUSIBLE"; readonly remainder: number; readonly reason: string };

/**
 * Позиция — услуга перевозки или погрузки-разгрузки по сметной цене («03-1 Погрузка …», «02-15-1-01-0047 Перевозка грузов …»,
 * «ФССЦпг-…», «ФСБЦ-…_02-15»): не расценка, и накладных расходов с прибылью у неё нет. Позиция с шифром расценки (ГЭСН, ФЕР…) услугой не
 * считается, даже если называется «Погрузка …»: у расценки НР и СП есть всегда.
 */
export function isServicePosition(position: CustomerPosition): boolean {
  if (position.book === "GESN" || position.book === "GESNM" || position.book === "GESNR" || position.book === "GESNP" || position.book === "GESNMR" || position.book === "OTHER_BASE") {
    return false;
  }
  return serviceRowCodeOf(position.rawJustification).service || serviceRowCodeOf(position.code).service || isServiceName(position.name);
}

/**
 * Бывают ли у позиции начисления НР и СП по методике. У позиции по расценке (ГЭСН, ГЭСНм/р/п, ФЕР и т. п.) они есть всегда: если строк
 * в разборе нет, их не прочитали, а не «они равны нулю». Нулевыми начисления могут быть только у позиций, у которых их быть не должно:
 * поставка ресурса, ТЦ, КП, прайс, цена услуги перевозки и погрузки. Позиция неизвестного вида, не похожая на услугу, — не угадывается.
 */
function accrualsExpected(position: CustomerPosition): boolean {
  if (position.book === "MATERIAL_SUPPLY" || position.book === "CUSTOMER_PRICE") return false;
  if (position.book === "UNKNOWN") return !isServicePosition(position);
  return true;
}

/**
 * Сумма начисления (НР или СП) позиции или null, если её назвать нельзя. Строка с суммой — сумма. Строка с процентом без суммы: сумма —
 * ФОТ × процент, но только когда ФОТ позиции прочитан. Иначе null. Строки начисления нет вовсе: у позиции, где начислений быть не
 * должно (`accrualsExpected`), это 0; у позиции по расценке — null: строку не прочитали (закупка 0134600008526000372: ГЭСНп07-10-015-02 и
 * многие ГЭСН16, 18 — строки НР и СП есть в тексте, но разбор их не взял, и вся «НР + СП» (+247 тыс. ₽ на одной позиции) становилась «материалом»).
 */
function accrualAmount(rate: CustomerPosition["overhead"], wageFund: number | null, expected: boolean): number | null {
  if (rate === null) return expected ? null : 0;
  if (rate.amount !== null) return rate.amount;
  if (rate.percent !== null && wageFund !== null) return Math.round(((wageFund * rate.percent) / 100) * 100) / 100;
  return null;
}

/**
 * Невидимый остаток позиции: «Всего по позиции» минус видимые составляющие (прямые затраты, НР, СП). Больше рубля —
 * заказчик включил в итог то, чего в выгрузке нет: неучтённый в норме материал («по проекту») со своей ценой из
 * коммерческого предложения. Меньше рубля — округление, остатка нет.
 *
 * Остаток считается, только когда известна вся видимая часть. Если у НР или СП прочитан процент, а сумма нет (так бывает у
 * выгрузок с другой раскладкой граф), недостающая сумма раньше шла нулём, и вся «НР + СП» (у Камчатки: 154 % и 134 % ФОТ,
 * 74 млн ₽; у Забайкалья: 480 тыс. ₽) превращалась в «невидимый материал». Теперь сумма выводится как ФОТ × процент, если ФОТ
 * позиции прочитан, и остаток не считается, если не прочитан. То же, когда строки НР или СП нет вовсе, а позиция по расценке
 * (`accrualsExpected`): начисления у неё по методике есть, значит, строку не прочитали. Правдоподобие остатка проверяют
 * `HIDDEN_REMAINDER_MAX_RATIO` и знак.
 *
 * Остаток — материал заказчика сверх напечатанных строк «М». Если наша норма уже оценила материалы выше его «М», остаток частично или
 * целиком покрыт ими, и расчёт добавляет только разницу (`BillOfWorkItem.customerPrintedMaterials`, `computeEstimateSection`).
 */
export function hiddenRemainderOf(position: CustomerPosition): HiddenRemainderStatus {
  if (position.directTotal === null || position.total === null) return { kind: "NONE" };
  const expected = accrualsExpected(position);
  const overhead = accrualAmount(position.overhead, position.wageFund, expected);
  const profit = accrualAmount(position.profit, position.wageFund, expected);
  if (overhead === null || profit === null) {
    const names = [overhead === null ? "НР" : null, profit === null ? "СП" : null].filter((name) => name !== null).join(" и ");
    return {
      kind: "ACCRUALS_UNKNOWN",
      reason: `сумма ${names} в смете не прочитана (строки начисления нет или в ней нет суммы), а ФОТ позиции для расчёта «ФОТ × процент» неизвестен — видимая часть позиции не определена`,
    };
  }
  const visible = position.directTotal + overhead + profit;
  const remainder = Math.round((position.total - visible) * 100) / 100;
  if (!(Math.abs(remainder) > 1)) return { kind: "NONE" };
  const rounded = Math.round(visible * 100) / 100;
  // Остаток того же знака, что и позиция: у исключения (отрицательный объём) он отрицательный, и это правильно.
  if (remainder * position.total < 0) {
    return { kind: "IMPLAUSIBLE", remainder, reason: "остаток противоположен по знаку итогу позиции: видимые составляющие больше «Всего по позиции»" };
  }
  const allowance = Math.max(HIDDEN_REMAINDER_MAX_RATIO * Math.abs(position.directTotal), HIDDEN_REMAINDER_MIN_ALLOWANCE);
  if (Math.abs(remainder) > allowance) {
    return {
      kind: "IMPLAUSIBLE",
      remainder,
      reason: `остаток больше прямых затрат позиции более чем в ${String(HIDDEN_REMAINDER_MAX_RATIO)} раз — это ошибка разбора начислений, а не материал «по проекту»`,
    };
  }
  return { kind: "FOUND", remainder, visible: rounded };
}

/** Невидимый остаток позиции, если он определён и правдоподобен; иначе null (`hiddenRemainderOf` называет причину). */
export function hiddenRemainder(position: CustomerPosition): { remainder: number; visible: number } | null {
  const status = hiddenRemainderOf(position);
  return status.kind === "FOUND" ? { remainder: status.remainder, visible: status.visible } : null;
}

/** Единица позиции по цене заказчика без единицы в смете: комплект, если так назван, иначе штуки. */
function inferredUnit(name: string): string {
  return /комплект|компл(?![а-яё])|комплекс/iu.test(name) ? "компл" : "шт";
}

/**
 * Материалы и оборудование позиции из её ресурсных строк с ценой заказчика (`BillOfWorkItem.customerMaterialRows`): стоимость на единицу
 * объёма позиции в единице ведомости. Труд и машины не нужны: на них у нас ставки и цены. Нет объёма или ценных строк — undefined.
 */
export function materialRowsOf(position: CustomerPosition, billQuantity: number): readonly CustomerMaterialRow[] | undefined {
  if (!(billQuantity > 0)) return undefined;
  const rows: CustomerMaterialRow[] = [];
  for (const resource of position.resources) {
    if (resource.unaccounted) continue;
    const kind = classifyResourceCode(resource.code);
    if (kind !== "MATERIAL" && kind !== "UNKNOWN") continue;
    const total = resource.currentTotal ?? (resource.qtyTotal !== null && resource.currentUnitPrice !== null ? resource.qtyTotal * resource.currentUnitPrice : null);
    if (total === null || !(Math.abs(total) > 0)) continue;
    rows.push({
      code: resource.code,
      name: resource.name.replace(/\s+/g, " ").trim(),
      unit: resource.unit,
      customerPrice: resource.customerPrice,
      extra: resource.extra,
      costPerUnit: Math.abs(total) / billQuantity,
      quantity: resource.qtyTotal,
    });
  }
  return rows.length === 0 ? undefined : rows;
}

/**
 * Ведомость одной сметы заказчика. `ordinal` — номер сметы в наборе: из него и из метки позиции
 * собирается устойчивый идентификатор строки, не сталкивающийся с идентификаторами других смет.
 */
export function lsrBillSection(entry: LsrEntry, ordinal: number): LsrBill {
  const items: BillOfWorkItem[] = [];
  const skipped: LsrSkippedPosition[] = [];
  const used = new Set<string>();
  const label = entry.number === null ? `ЛСР № ${String(ordinal)}` : `ЛСР ${entry.number}`;
  // Смета по чужой базе норм (ТСН-2001 Москвы): шифр расценки не ГЭСН, и читать его как ГЭСН нельзя.
  const foreignBase = entry.estimate.base ?? null;

  for (const position of documentOrder(entry)) {
    const positionLabel = position.label ?? String(position.number);
    const name = position.name.replace(/\s+/g, " ").trim();
    const skip = (reason: BillRejectionReason, message: string): void => {
      skipped.push({ label: positionLabel, name, reason, message: `${label}, поз. ${positionLabel} «${name}»: ${message}` });
    };

    if (name === "") {
      skip("EMPTY_NAME", "в строке позиции нет наименования");
      continue;
    }
    const signed = position.quantity;
    if (signed === null || signed === 0 || !Number.isFinite(signed)) {
      skip("BAD_QUANTITY", "в строке позиции нет объёма");
      continue;
    }
    // Отрицательный объём — исключение: строка вычитает (`BillOfWorkItem.deduction`), модуль идёт в объём.
    const deduction = signed < 0;
    const quantity = Math.abs(signed);

    // Единица приводится к основной («100 шт» → «шт», множитель — в объём); не узнана — остаётся как напечатана.
    const parsedUnit = parseUnit(position.unit);
    const billQuantity = parsedUnit === null ? quantity : quantity * parsedUnit.multiplier;
    let billUnit = parsedUnit === null ? position.unit : parsedUnit.unit;
    // Позиция по ТЦ, КП, прайсу без единицы («Консервация трансформатора», 2, цена 3,77 млн ₽): цена заказчика — всё, что у неё есть,
    // и терять эти деньги нельзя. Единица принимается «шт» (или «компл» по наименованию) и называется в цитате строки.
    let unitNote = "";
    if (billUnit === "") {
      if (position.book !== "CUSTOMER_PRICE") {
        skip("UNKNOWN_UNIT", "в строке позиции нет единицы измерения");
        continue;
      }
      billUnit = inferredUnit(name);
      unitNote = ` (единица в смете не указана, принята «${billUnit}»)`;
    }

    const justification = position.rawJustification;
    // ТСН: «4.8-61-4» и ему подобные шифры ни ГЭСН, ни ФЕР; цифры ТСН-2001.13 («13-02-004-01») похожи на ГЭСН, но это другая работа. Подсказки нет — подбор по наименованию.
    const hint = foreignBase !== null || position.book === "CUSTOMER_PRICE" || position.book === "MATERIAL_SUPPLY" ? null : parseNormCodeHint(justification);
    const resourceCode = position.book === "MATERIAL_SUPPLY" ? resourceCodeFromJustification(justification) : null;
    /*
      Перевозка и погрузка-разгрузка — услуги по сметным ценам, а не расценки: «03-1 Погрузка в автотранспортное средство: …»,
      «02-15-1-01-0047 Перевозка грузов I класса …», «ФСБЦ-…_02-15». Шифр (если по нему есть таблицы зоны) идёт в позицию как `serviceCode`,
      сама строка помечена `serviceRow`: к расценке ГЭСН по наименованию такая строка не подбирается никогда (закупка 32616401076:
      погрузка железобетонных изделий нашла «ГЭСН 29-02-113-01» и стоила 184 790 ₽ вместо 30 714,92 ₽ заказчика).
    */
    const service = resourceCode === null && hint === null && isServicePosition(position);
    const serviceCode = service ? (serviceRowCodeOf(justification).code ?? serviceRowCodeOf(position.code).code) : null;
    // У ТЦ, КП, поставки и цены услуги перевозки и погрузки «Всего по позиции» — сама цена: остатка там нет.
    const restStatus: HiddenRemainderStatus =
      position.book === "CUSTOMER_PRICE" || position.book === "MATERIAL_SUPPLY" || isServicePosition(position) ? { kind: "NONE" } : hiddenRemainderOf(position);
    const rest = restStatus.kind === "FOUND" ? restStatus : null;
    const fullPrice = customerPriceOf(position, billQuantity, billUnit, entry.documentName);
    // Цена заказчика самой позиции — без невидимого остатка: он идёт отдельной строкой, и при возврате к цене заказчика его нельзя считать дважды.
    const customerPrice =
      fullPrice === null || rest === null || !(Math.abs(rest.visible) > 0)
        ? fullPrice
        : { ...fullPrice, total: Math.abs(rest.visible), unitPrice: Math.abs(rest.visible) / billQuantity };
    // ТЦ, КП, прайс-лист: цена заказчика — единственное, что у позиции есть.
    const priceOnly = position.book === "CUSTOMER_PRICE";
    const coefficients = coefficientsOf(position);
    const conditions = evaluateCustomerConditions(position);
    const confirmed = hasConfirmedConditions(conditions ?? undefined);

    const total = position.total ?? position.ownTotal;
    const code = firstLine(justification);
    const quote =
      `${label}, поз. ${positionLabel}${position.equipment === true ? " (оборудование)" : ""}: ` +
      `${code === "" ? "" : `${code} `}«${name}», ${formatQuantity(quantity)} ${position.unit}${unitNote}` +
      `${total === null ? "" : `; всего по позиции ${RUB.format(total)} ₽`}${deduction ? " (исключается: отрицательный объём)" : ""}` +
      `${restStatus.kind === "NONE" || restStatus.kind === "FOUND" ? "" : `. Невидимый остаток не выделен: ${restStatus.reason}`}` +
      `${coefficients === null ? "" : `. Условия и коэффициенты ЛСР: ${coefficients}${confirmed ? ` — применены, ${conditions?.label ?? ""}` : " — в расчёт не включены: приложением 10 к 421/пр не подтверждены"}`}`;

    let id = `l${String(ordinal)}-${positionLabel}`;
    for (let suffix = 2; used.has(id); suffix += 1) id = `l${String(ordinal)}-${positionLabel}-${String(suffix)}`;
    used.add(id);

    // Состав позиции: по строкам ЛСР, если они есть; иначе — только сумма материалов группы «М» (по ней видно, что состав заменён).
    const norm = position.book === "GESN" || position.book === "GESNM" || position.book === "GESNR" || position.book === "GESNP" || position.book === "GESNMR";
    const resources = norm ? compositionOf(position) : null;
    // Итоги групп известны, если смета их напечатала или они просуммированы из ресурсов; если нет ни того ни другого — «М = 0» утверждать нельзя.
    const groupsKnown = Object.values(position.groupTotals).some((value) => value !== null);
    /*
      Материалы группы «М» заказчика: напечатанный итог или просуммированный из ресурсных строк (`deriveGroupTotals`, `groupTotalsDerived`).
      Известны, когда группы известны вообще, либо когда ресурсных строк нет совсем (тогда «М = 0» — не догадка, а отсутствие таблицы). Если
      строки есть, а итоги групп вывести нельзя (у какой-то строки нет стоимости), «М» неизвестна, и называть её нулём нельзя: значение не
      передаётся, сверка материалов с нормой и зачёт остатка в материалах нормы пропускаются.
    */
    const printedMaterials = norm && position.directTotal !== null && (groupsKnown || position.resources.length === 0) ? Math.abs(position.groupTotals.materials ?? 0) : undefined;
    const materialRows = norm && resources === null ? materialRowsOf(position, billQuantity) : undefined;
    /*
      Состав по строкам заказчика (`customerResources`) заменяет состав нормы, и расчёт сверяет с «М» уже его, а не норму (материалы
      нормы там не участвуют). Сумма «М» при этом всё равно кладётся в позицию: она нужна и аудиту, и зачёту остатка. Сверка
      `customerMaterials` с материалами нормы без состава заказчика (`resources === null`) живёт в `computeEstimateLine`.
    */
    const composition =
      resources !== null
        ? { customerResources: resources, ...(printedMaterials === undefined ? {} : { customerMaterials: printedMaterials }) }
        : norm && position.directTotal !== null
          ? {
              ...(printedMaterials === undefined ? {} : { customerMaterials: printedMaterials }),
              ...(materialRows === undefined ? {} : { customerMaterialRows: materialRows }),
            }
          : materialRows === undefined
            ? {}
            : { customerMaterialRows: materialRows };
    let restItem: BillOfWorkItem | undefined;
    if (rest !== null) {
      const restId = `${id}-rest`;
      restItem = {
        id: restId,
        workName: `Неучтённые в выгрузке ресурсы позиции ${positionLabel} «${name}»`,
        quantity: 1,
        quantityUnit: "усл. ед.",
        unitDivisor: 1,
        normCode: null,
        normBaseType: null,
        resourceCode: null,
        sourceQuote:
          `${label}, поз. ${positionLabel}: «Всего по позиции» ${money(position.total as number)} ₽ при видимых составляющих ` +
          `(прямые затраты, НР, СП) ${money(rest.visible)} ₽; остаток ${money(rest.remainder)} ₽ — ресурсы, которых в выгрузке нет ` +
          "(материал нормы «по проекту»); принят по сумме заказчика",
        sourceDocument: entry.documentName,
        billSection: position.section,
        sourceLevel: "CUSTOMER_ESTIMATE",
        positionNumber: `${positionLabel}*`,
        normCodeHint: null,
        customerPriceOnly: true,
        unaccountedOf: id,
        ...(printedMaterials === undefined ? {} : { customerPrintedMaterials: printedMaterials }),
        customerPrice: {
          total: Math.abs(rest.remainder),
          unitPrice: Math.abs(rest.remainder),
          unit: "усл. ед.",
          origin: "POSITION_TOTAL",
          document: entry.documentName,
        },
        ...(rest.remainder < 0 ? { deduction: true } : {}),
      };
    }

    items.push({
      id,
      workName: name,
      quantity: billQuantity,
      quantityUnit: billUnit,
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      resourceCode,
      sourceQuote: quote,
      sourceDocument: entry.documentName,
      billSection: position.section,
      sourceLevel: "CUSTOMER_ESTIMATE",
      positionNumber: positionLabel,
      normCodeHint: hint,
      ...(service ? { serviceRow: true } : {}),
      ...(serviceCode === null ? {} : { serviceCode }),
      ...(customerPrice === null ? {} : { customerPrice }),
      ...(coefficients === null ? {} : { customerCoefficients: coefficients }),
      ...(conditions === null ? {} : { customerConditions: conditions }),
      ...(priceOnly ? { customerPriceOnly: true } : {}),
      ...(foreignBase === null || priceOnly ? {} : { foreignBase }),
      ...composition,
      ...(deduction ? { deduction: true } : {}),
    });
    if (restItem !== undefined) items.push(restItem);
  }

  return { section: { title: entry.sectionTitle, items }, skipped };
}
