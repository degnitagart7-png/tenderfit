import {
  classifyResourceCode,
  rankFromWageCode,
  roundTo,
  unitForResourceKind,
} from "@/domain/estimate/resourceKinds";
import { normalizeText } from "@/domain/estimate/normalize";
import { describeWageScale, formatRank, formatSalary, resolveWage } from "@/domain/estimate/wageScale";
import type {
  BillOfWorkItem,
  BillOfWorkSection,
  EstimateDocument,
  EstimateGap,
  EstimateLine,
  EstimateParameters,
  EstimateResourceLine,
  EstimateSection,
  EstimateSource,
  EstimateTotals,
  NormRecord,
  NormResource,
  OverheadRate,
  OverheadRateSource,
  ResourceLineSource,
  ResourcePrice,
  WageScale,
} from "@/domain/estimate/types";

/**
 * Расчёт сметы ресурсно-индексным методом по данным ФСНБ-2022.
 *
 * Цепочка, которую повторяет модуль: норма ГЭСН задаёт расход ресурсов на
 * единицу; расход умножается на объём; каждый ресурс оценивается текущей ценой
 * ФСЦСР по ценовой зоне, а при её отсутствии — ценой базы 01.01.2022,
 * пересчитанной индексом Минстроя по соответствующему элементу затрат.
 * Накладные расходы и сметная прибыль считаются от фонда оплаты труда
 * (рабочие плюс машинисты), лимитированные затраты — от стоимости
 * строительно-монтажных работ, НДС — сверху.
 *
 * Пять решений, которые приняты осознанно и которые легко испортить:
 *
 * 1. Оплата труда машинистов не прибавляется отдельно к затратам труда по
 *    служебному коду «2» — она уже сидит внутри цены маш.-ч. Проверено на
 *    норме 01-01-001-01 книги ГЭСН: код «2» = 6,4 чел.-ч ровно равен сумме
 *    (маш.-ч × звено) по машинам. Если считать и то, и другое, зарплата
 *    машинистов удвоится.
 *
 * 2. Итоговая строка труда рабочих (код «1») не оценивается деньгами. Она
 *    встречается в 6 731 работе пяти книг — ГЭСН 3 273, ГЭСНп 2 605, ГЭСНм 443,
 *    ГЭСНр 375, ГЭСНмр 35 — и во всех 6 731 без исключения равна сумме
 *    разрядных строк той же работы: «1-100-*» плюс «2-100-*» плюс «3-*».
 *    Деньги начисляются по разрядным строкам, а код «1» идёт в справочные часы
 *    и в сверку; расхождение больше 0,02 чел.-ч помечается отдельно.
 *
 * 3. Всё, что не удалось оценить, не замалчивается, а попадает в gaps строки и
 *    документа. Позиция с неизвестной ценой даёт ноль в стоимости и явную
 *    пометку — так итог занижен, но честен. Завышать догадкой нельзя.
 *    Исключение сделано только для тарифной шкалы: разряд вне известных
 *    значений продолжается по наклону крайнего участка, но обязательно с
 *    пометкой WAGE_EXTRAPOLATED, потому что обнуление оплаты труда занижает
 *    смету сильнее, чем видимое приближение.
 *
 * 4. Труд специалистов (коды «3-*»: техник, инженер I–III категории, ведущий
 *    инженер, главный технолог) считается трудом, но остаётся без денег. Семь
 *    таких кодов дают 6 183 строки: 2 565 работ книги ГЭСНп, 53 — ГЭСНм,
 *    35 — ГЭСНмр. Ставки для них в открытых данных нет: реестр ставок рабочих
 *    перечисляет разряды (по Амурской области, 1 зона, 3 квартал 2026 — 25 строк,
 *    разряды 1,0–3,4), а колонка зарплаты машинистов в ФСЦСР относится к звеньям
 *    машин, а не к инженерам. Каждый такой ресурс получает NO_WAGE,
 *    часы остаются в трудозатратах, ставка строки считается только по
 *    оплаченным часам. Ни продолжить шкалой рабочих, ни приравнять к разряду
 *    их нельзя: инженеры и техники не входят в тарифную сетку, поэтому любое
 *    сопоставление дало бы ставку, которой не существует ни в одном источнике.
 *    Последствие серьёзное, и его надо видеть: в ГЭСНп нет ни машин, ни
 *    материалов ни в одной из 2 605 работ, поэтому без ставок ИТР пусконаладка
 *    оценивается только по рабочим — то есть почти обнуляется, а не занижается
 *    частично.
 *
 * 5. Найденная цена не равна пригодной цене. В «ФСБЦ_Маш.xml» десять машин
 *    имеют `SalaryMach="0"` и `PriceCostWithoutSalary="0"`, то есть полную
 *    стоимость маш.-ч по базе 01.01.2022, равную 0 ₽. Девять из них — землесосы
 *    папильонажные рефулерные, и внутри `<Work>` книги «ГЭСН.xml» они
 *    встречаются 63 раза: норма ГЭСН 44-04-180-01 состоит из одного такого
 *    землесоса и больше ни из чего. Подставить ноль значило бы напечатать
 *    «база 01.01.2022» рядом с нулевой стоимостью позиции — молчаливое
 *    занижение, которое ловит только сверка документа. Поэтому ноль в любом
 *    источнике считается ценой, которой нет: расчёт идёт дальше по цепочке, а
 *    если заменить нечем, даёт ZERO_PRICE вместо NO_PRICE, потому что код в
 *    справочнике есть и пользователь должен видеть разницу.
 *
 * Модуль чистый: ни сети, ни хранилища, ни Date.now(). Время приходит в
 * `generatedAt`, цены — в `priceBook`.
 */

/** Совокупность цен и ставок, нужных для расчёта. */
export interface EstimatePriceBook {
  readonly region: string;
  readonly priceZone: string;
  readonly period: string;
  readonly baseEdition: string;
  /** Текущие сметные цены ФСЦСР по коду ресурса. */
  readonly current: ReadonlyMap<string, ResourcePrice>;
  /** Цены базы ФСБЦ в уровне 01.01.2022 по коду ресурса. */
  readonly base: ReadonlyMap<string, ResourcePrice>;
  /** Тарифная шкала оплаты труда зоны за период. */
  readonly wageScale: WageScale;
  /**
   * Нормативы НР и СП по указателям расценок — приказы 812/пр и 774/пр.
   *
   * Ключ — указатель как он записан в данных ФСНБ: «Пр/812-001.1» для
   * накладных расходов, «Пр/774-001.1» для сметной прибыли. Пустая карта
   * допустима: расчёт тогда опускается на резерв документа и помечает каждую
   * такую позицию, а не делает вид, что один процент подходит всем работам.
   */
  readonly overheadRates: ReadonlyMap<string, OverheadRate>;
}

/** Как была назначена норма для позиции. */
export interface NormResolution {
  readonly norm: NormRecord;
  readonly reasons: readonly string[];
}

/**
 * Функция подбора нормы. Вызывающий код передаёт сюда реализацию из
 * matchNorms.findNorms или назначение вручную — домен от источника не зависит.
 */
export type NormResolver = (item: BillOfWorkItem) => NormResolution | null;

/** Всё, что нужно для сборки документа. */
export interface EstimateRequest {
  readonly title: string;
  readonly sections: readonly BillOfWorkSection[];
  readonly priceBook: EstimatePriceBook;
  readonly parameters: EstimateParameters;
  readonly resolveNorm: NormResolver;
  readonly sources: readonly EstimateSource[];
  readonly generatedAt: string;
  readonly disclaimer: string;
}

interface LineAccumulator {
  /** Труд рабочих по разрядным строкам — то, что реально оплачивается. */
  labourHours: number;
  /**
   * Часть этих часов, на которую нашлась ставка.
   *
   * Считать среднюю ставку по всем часам нельзя: в ГЭСНп 2 565 работ из 2 605
   * несут труд специалистов (`3-100-*`, `3-200-*`, `3-300-*`, `3-400-*`), а
   * ставок инженеров и техников в открытых данных нет. Деление начисленной
   * стоимости на все часы дало бы по норме 01-01-001-01 книги ГЭСНп ставку
   * 84,52 ₽/чел.-ч — правдоподобное число, которого не существует.
   */
  labourHoursPriced: number;
  /**
   * Часы специалистов (коды «3-*») — труд, который считается, но не оплачен.
   *
   * Держится отдельно от `labourHours`, потому что подпись «затраты труда
   * рабочих» на сумме, где лежат часы инженеров, называет не ту величину.
   * В сверку с итоговым кодом «1» входит вместе с разрядными строками: по
   * переписи пяти книг код «1» равен сумме «1-100-*», «2-100-*» и «3-*».
   */
  specialistHours: number;
  /** Труд рабочих из итоговой строки «1» — справочно, для сверки. */
  labourHoursTotal: number;
  labourCost: number;
  /** Часы машинистов по служебным кодам «2» и «4-100-*». */
  machinistHours: number;
  /**
   * Те же часы, но собранные по машинам: сумма «маш.-ч × состав звена».
   *
   * Второй, независимый путь к одной величине. Равенство двух путей — то, на
   * чём держится отказ начислять оплату машинистов дважды, и проверять его
   * нужно на каждой норме, а не однажды вручную.
   */
  machinistHoursFromMachines: number;
  /**
   * Встретилась машина, у которой состав звена неизвестен.
   *
   * Тогда второй путь неполон, и сверка отключается: расхождение, полученное
   * из заведомо неполной суммы, означало бы не ошибку данных, а пробел в них.
   */
  machinistCrewUnknown: boolean;
  machinistSalaryCost: number;
  machineHours: number;
  machineCost: number;
  materialCost: number;
}

function emptyAccumulator(): LineAccumulator {
  return {
    labourHours: 0,
    labourHoursPriced: 0,
    specialistHours: 0,
    labourHoursTotal: 0,
    labourCost: 0,
    machinistHours: 0,
    machinistHoursFromMachines: 0,
    machinistCrewUnknown: false,
    machinistSalaryCost: 0,
    machineHours: 0,
    machineCost: 0,
    materialCost: 0,
  };
}

/**
 * Средняя ставка оплаты труда строки, ₽ за чел.-ч.
 *
 * В норме может быть несколько разрядных строк — например, в 01-01-129-11 их
 * три: рабочий 2, 3 и 4 разряда. Одна ставка на строку всё равно нужна, и
 * берётся она делением начисленной стоимости на оплаченные часы, чтобы число
 * воспроизводилось из двух других напечатанных величин.
 */
function labourRateOf(accumulator: LineAccumulator): number {
  if (accumulator.labourHoursPriced <= 0) return 0;
  return roundTo(accumulator.labourCost / accumulator.labourHoursPriced, 2);
}

/**
 * Пометка «норма не найдена».
 *
 * Собирается в одном месте, потому что нужна в двух: и при расчёте одной
 * строки, и при обходе раздела. Две копии текста разошлись бы при первой же
 * правке формулировки, а сверка честности расчёта сопоставляет пометки по
 * сообщению.
 */
function noNormGap(item: BillOfWorkItem): EstimateGap {
  return {
    kind: "NO_NORM",
    message: `Под позицию «${item.workName}» норма в ФСНБ-2022 не найдена — стоимость не рассчитана`,
    code: item.normCode,
    baseType: item.normBaseType,
  };
}

/** Считает одну строку сметы. */
export function computeEstimateLine(
  item: BillOfWorkItem,
  resolution: NormResolution | null,
  priceBook: EstimatePriceBook,
  parameters: EstimateParameters,
): { line: EstimateLine; gaps: EstimateGap[] } | { line: null; gaps: EstimateGap[] } {
  const gaps: EstimateGap[] = [];

  if (resolution === null) {
    gaps.push(noNormGap(item));
    return { line: null, gaps };
  }

  const norm = resolution.norm;
  const normRef: NormRef = { code: norm.code, baseType: norm.baseType };

  if (!(item.quantity > 0)) {
    gaps.push({
      kind: "BAD_QUANTITY",
      message: `Объём позиции «${item.workName}» равен ${String(item.quantity)} — расчёт невозможен`,
      code: norm.code,
      baseType: norm.baseType,
    });
    return { line: null, gaps };
  }

  const divisor = item.unitDivisor > 0 ? item.unitDivisor : 1;
  if (item.unitDivisor <= 0) {
    gaps.push({
      kind: "BAD_DIVISOR",
      message: `Делитель единицы для «${item.workName}» задан как ${String(item.unitDivisor)}, принят за 1`,
      code: norm.code,
      baseType: norm.baseType,
    });
  }
  const quantityInNormUnits = item.quantity / divisor;

  const billUnit = normalizeText(item.quantityUnit);
  const normUnit = normalizeText(norm.unit);
  if (billUnit.length > 0 && billUnit !== normUnit && divisor === 1) {
    // Считать здесь нечего: объём выражен не в той величине, в которой норма
    // задаёт расход, а перевести одну в другую без делителя нельзя — из тонн
    // в кубометры не перейти без плотности, которой в ведомости нет.
    //
    // Раньше объём брался как есть, и это стоило дорого: на смете
    // 02-01-02-КМ1 строка «Перевозка … 34,392 т» под нормой с единицей
    // «1000 м3» дала 9 182 897,33 ₽ — 87 % прямых затрат. Число никто не
    // проверял, а выглядело оно как посчитанное.
    //
    // Поэтому позиция выбывает, как выбывает позиция без нормы: смета будет
    // занижена на её вес, и пробел об этом скажет. Занижение видно и
    // исправимо, завышение втрое — нет.
    gaps.push({
      kind: "UNIT_MISMATCH",
      message: `Единица ведомости «${item.quantityUnit}» не совпадает с единицей нормы «${norm.unit}», а делитель не задан — позиция в расчёт не вошла`,
      code: norm.code,
      baseType: norm.baseType,
    });
    return { line: null, gaps };
  }

  const accumulator = emptyAccumulator();
  const resources: EstimateResourceLine[] = [];

  for (const resource of norm.resources) {
    const outcome = priceResource(
      resource,
      quantityInNormUnits,
      priceBook,
      parameters,
      normRef,
      gaps,
      accumulator,
    );
    if (outcome !== null) resources.push(outcome);
  }

  // Сверка двух записей труда: итоговая строка «1» должна совпадать с суммой
  // разрядных строк. По переписи пяти книг расхождений нет ни в одной из 6 731
  // работы, где встречается код «1», поэтому любое расхождение здесь означает
  // проблему в данных или в разборе.
  // Код «1» равен сумме «1-100-*», «2-100-*» и «3-*», то есть включает часы
  // специалистов. Сравнивать его с одними разрядными строками нельзя: в книге
  // ГЭСНп это дало бы ложное расхождение на каждой второй норме.
  const countedHours = accumulator.labourHours + accumulator.specialistHours;
  if (
    accumulator.labourHoursTotal > 0 &&
    countedHours > 0 &&
    Math.abs(accumulator.labourHoursTotal - countedHours) > 0.02
  ) {
    gaps.push({
      kind: "LABOUR_TOTAL_MISMATCH",
      message: `В норме ${normLabel(normRef)} итоговые затраты труда ${formatHours(accumulator.labourHoursTotal)} чел.-ч не равны сумме разрядных строк ${formatHours(countedHours)} чел.-ч — в расчёт взята сумма разрядных строк`,
      code: norm.code,
      baseType: norm.baseType,
    });
  }

  /*
    Сверка второй пары записей: часы машинистов по служебному коду против
    суммы «маш.-ч × состав звена» по машинам нормы.

    На этом равенстве держится решение не начислять оплату машинистов отдельно:
    она уже сидит в цене маш.-ч. Пока равенство выполняется, двойного счёта нет;
    как только оно нарушится — либо в разборе, либо в данных ошибка, и молча
    брать цену маш.-ч станет нельзя. Проверять это на каждой норме дешевле, чем
    один раз вручную и потом надеяться.

    Отключается, когда хотя бы у одной машины неизвестен состав звена: неполная
    сумма дала бы расхождение, которого в данных нет.
  */
  if (
    !accumulator.machinistCrewUnknown &&
    accumulator.machinistHours > 0 &&
    accumulator.machinistHoursFromMachines > 0 &&
    Math.abs(accumulator.machinistHours - accumulator.machinistHoursFromMachines) > 0.02
  ) {
    gaps.push({
      kind: "MACHINIST_HOURS_MISMATCH",
      message: `В норме ${normLabel(normRef)} затраты труда машинистов ${formatHours(accumulator.machinistHours)} чел.-ч не равны сумме «маш.-ч × звено» по машинам ${formatHours(accumulator.machinistHoursFromMachines)} чел.-ч — оплата машинистов взята из цены маш.-ч, и это расхождение надо проверить`,
      code: norm.code,
      baseType: norm.baseType,
    });
  }

  const directCost = roundTo(
    accumulator.labourCost + accumulator.machineCost + accumulator.materialCost,
    2,
  );
  const wageFund = roundTo(accumulator.labourCost + accumulator.machinistSalaryCost, 2);

  const rates = resolveOverheadRates(norm, priceBook, parameters, gaps);
  const overheadCost = roundTo((wageFund * rates.overheadPercent) / 100, 2);
  const profitCost = roundTo((wageFund * rates.profitPercent) / 100, 2);

  const line: EstimateLine = {
    itemId: item.id,
    normCode: norm.code,
    normBaseType: norm.baseType,
    normName: norm.fullName,
    normUnit: norm.unit,
    quantity: roundTo(quantityInNormUnits, 6),
    billQuantity: item.quantity,
    billUnit: item.quantityUnit,
    sourceQuote: item.sourceQuote,
    sourceDocument: item.sourceDocument,
    labourHours: roundTo(
      accumulator.labourHours > 0 ? accumulator.labourHours : accumulator.labourHoursTotal,
      3,
    ),
    specialistHours: roundTo(accumulator.specialistHours, 3),
    labourRate: labourRateOf(accumulator),
    labourCost: roundTo(accumulator.labourCost, 2),
    machinistHours: roundTo(accumulator.machinistHours, 3),
    machinistSalaryCost: roundTo(accumulator.machinistSalaryCost, 2),
    machineHours: roundTo(accumulator.machineHours, 3),
    machineCost: roundTo(accumulator.machineCost, 2),
    materialCost: roundTo(accumulator.materialCost, 2),
    directCost,
    wageFund,
    overheadCost,
    profitCost,
    overheadPercent: rates.overheadPercent,
    profitPercent: rates.profitPercent,
    overheadRef: norm.overheadRef,
    profitRef: norm.profitRef,
    overheadSource: rates.overheadSource,
    profitSource: rates.profitSource,
    resources,
    gaps: gaps.filter(
      (gap) => gap.code === norm.code && gap.baseType === norm.baseType,
    ),
  };

  return { line, gaps };
}

/**
 * Справочник, из которого взята цена позиции-поставки.
 *
 * Стоит там же, где у расценки стоит книга («ГЭСН», «ГЭСНм»), и по той же
 * причине: без имени справочника код не проверяем — сметчик не найдёт по нему
 * ту же строку.
 */
const RESOURCE_BASE_TYPE = "ФСБЦ";

/**
 * Считает позицию-поставку: материал или машину, купленные по прямой цене.
 *
 * Отдельно от `computeEstimateLine`, потому что считается здесь другое.
 * Расценка раскладывается на труд, машины и материалы по расходам нормы;
 * поставка — это одна цена на один объём, и раскладывать в ней нечего.
 *
 * Чего у поставки нет и почему. Труда и машин — их несёт работа, в которой
 * материал уложен; начислить их ещё раз на саму поставку значит посчитать
 * одну бригаду дважды. Накладных расходов и сметной прибыли — они считаются
 * от фонда оплаты труда, а он здесь ноль. Указателей 812/пр и 774/пр —
 * приказы задают норматив по виду работ, а поставка видом работ не является.
 *
 * Расхождение единиц тут не отменяет расчёт, в отличие от расценки. У
 * расценки единица задаёт расход — «на 1000 м3», — и ошибка в ней умножает
 * смету на тысячу. У поставки единица ведомости и единица справочника просто
 * разные записи одной величины («т» и «тонна»), а цена умножается на объём
 * один раз. Пометка остаётся, счёт продолжается.
 */
export function computeResourceLine(
  item: BillOfWorkItem,
  priceBook: EstimatePriceBook,
  parameters: EstimateParameters,
): { line: EstimateLine; gaps: EstimateGap[] } | { line: null; gaps: EstimateGap[] } {
  const gaps: EstimateGap[] = [];
  const code = item.resourceCode;

  if (code === null) {
    throw new Error(
      `Позиция «${item.workName}» не несёт кода ресурса — считать её как поставку нельзя`,
    );
  }

  const normRef: NormRef = { code, baseType: RESOURCE_BASE_TYPE };

  if (!(item.quantity > 0)) {
    gaps.push({
      kind: "BAD_QUANTITY",
      message: `Объём позиции «${item.workName}» равен ${String(item.quantity)} — расчёт невозможен`,
      code,
      baseType: RESOURCE_BASE_TYPE,
    });
    return { line: null, gaps };
  }

  const kind = classifyResourceCode(code);
  const priced = resolvePrice(code, kind, priceBook, parameters, normRef, gaps);

  /*
    Единица берётся из справочника, а не из вида ресурса. У материалов она
    своя у каждого кода — «т», «м3», «шт», — и `unitForResourceKind` честно
    отдаёт для них пустую строку: по виду её не угадать. Машинам и труду вид
    единицу задаёт, и там она остаётся запасным вариантом.
  */
  const catalogUnit = (
    priceBook.current.get(code)?.unit ??
    priceBook.base.get(code)?.unit ??
    ""
  ).trim();
  const resourceUnit = catalogUnit.length > 0 ? catalogUnit : unitForResourceKind(kind);
  const billUnit = normalizeText(item.quantityUnit);

  if (
    billUnit.length > 0 &&
    resourceUnit.length > 0 &&
    billUnit !== normalizeText(resourceUnit)
  ) {
    gaps.push({
      kind: "UNIT_MISMATCH",
      message: `Единица ведомости «${item.quantityUnit}» не совпадает с единицей справочника «${resourceUnit}» для ресурса ${code} — цена умножена на объём как есть`,
      code,
      baseType: RESOURCE_BASE_TYPE,
    });
  }

  const total = roundTo(priced.unitPrice * item.quantity, 2);
  const resource: EstimateResourceLine = {
    code,
    name: priced.name,
    unit: resourceUnit,
    quantity: roundTo(item.quantity, 6),
    unitPrice: priced.unitPrice,
    total,
    source: priced.source,
    kind,
    wageOrigin: null,
  };

  /*
    Машина, купленная как поставка, всё равно материальная затрата: в смете
    она стоит строкой «оборудование», а не «эксплуатация машин». Колонка
    «эксплуатация машин» отвечает за работу техники по расценке, и класть туда
    покупку значило бы подписать одну величину именем другой.
  */
  const line: EstimateLine = {
    itemId: item.id,
    normCode: code,
    normBaseType: RESOURCE_BASE_TYPE,
    normName: priced.name,
    normUnit: resourceUnit,
    quantity: roundTo(item.quantity, 6),
    billQuantity: item.quantity,
    billUnit: item.quantityUnit,
    sourceQuote: item.sourceQuote,
    sourceDocument: item.sourceDocument,
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
    resources: [resource],
    gaps,
  };

  return { line, gaps };
}

/** Нормативы, применённые к позиции, вместе с их происхождением. */
interface ResolvedOverheadRates {
  readonly overheadPercent: number;
  readonly profitPercent: number;
  readonly overheadSource: OverheadRateSource;
  readonly profitSource: OverheadRateSource;
}

/**
 * Берёт НР и СП по указателям самой расценки, а не один процент на смету.
 *
 * Норма несёт `<ReasonItem Nr="Пр/812-001.1" Sp="Пр/774-001.1"/>`, и это не
 * справочная пометка: приказы 812/пр и 774/пр задают норматив по виду работ,
 * поэтому земляные работы и отделочные не могут иметь одинаковые НР. Единый
 * процент на весь документ занижает одни разделы и завышает другие, а так как
 * НР и СП считаются от фонда оплаты труда и входят в стоимость СМР, ошибка
 * идёт дальше через лимитированные затраты и НДС до итога.
 *
 * Когда указателя нет или он не найден в справочнике, расчёт опускается на
 * резерв документа — по той же причине, по которой ставка вне шкалы
 * продолжается, а не обнуляется: НР и СП составляют заметную долю СМР, и ноль
 * исказил бы итог сильнее, чем приближение. Но опускается громко: каждая такая
 * позиция получает NO_OVERHEAD_RATE и печатает источник DEFAULT, так что
 * смета, собранная целиком на резерве, видна сразу.
 *
 * НР и СП разрешаются независимо: в выгрузке встречается норма, у которой
 * задан только один из двух указателей, и терять найденный из-за потерянного
 * второго нельзя.
 */
function resolveOverheadRates(
  norm: NormRecord,
  priceBook: EstimatePriceBook,
  parameters: EstimateParameters,
  gaps: EstimateGap[],
): ResolvedOverheadRates {
  const overhead = lookupRate(
    norm.overheadRef,
    "накладных расходов",
    priceBook,
    parameters.overhead.overheadPercent,
    norm,
    gaps,
  );
  const profit = lookupRate(
    norm.profitRef,
    "сметной прибыли",
    priceBook,
    parameters.overhead.profitPercent,
    norm,
    gaps,
  );

  return {
    overheadPercent: overhead.percent,
    profitPercent: profit.percent,
    overheadSource: overhead.source,
    profitSource: profit.source,
  };
}

/** Один норматив по указателю: найден — берём его, нет — резерв с пометкой. */
function lookupRate(
  ref: string | null,
  what: string,
  priceBook: EstimatePriceBook,
  fallbackPercent: number,
  norm: NormRecord,
  gaps: EstimateGap[],
): { percent: number; source: OverheadRateSource } {
  const normRef: NormRef = { code: norm.code, baseType: norm.baseType };

  if (ref === null || ref.length === 0) {
    gaps.push({
      kind: "NO_OVERHEAD_RATE",
      message: `Норма ${normLabel(normRef)} не несёт указателя на норматив ${what} — начислен резерв документа ${formatPercent(fallbackPercent)} %`,
      code: norm.code,
      baseType: norm.baseType,
    });
    return { percent: fallbackPercent, source: "DEFAULT" };
  }

  const rate = priceBook.overheadRates.get(ref);
  if (rate === undefined) {
    gaps.push({
      kind: "NO_OVERHEAD_RATE",
      message: `Норматив ${what} по указателю ${ref} из нормы ${normLabel(normRef)} не найден в справочнике — начислен резерв документа ${formatPercent(fallbackPercent)} %`,
      code: norm.code,
      baseType: norm.baseType,
    });
    return { percent: fallbackPercent, source: "DEFAULT" };
  }

  if (!Number.isFinite(rate.percent) || rate.percent < 0) {
    gaps.push({
      kind: "NO_OVERHEAD_RATE",
      message: `Норматив ${what} по указателю ${ref} задан как ${String(rate.percent)} — значение непригодно, начислен резерв документа ${formatPercent(fallbackPercent)} %`,
      code: norm.code,
      baseType: norm.baseType,
    });
    return { percent: fallbackPercent, source: "DEFAULT" };
  }

  return { percent: rate.percent, source: "NORM_REF" };
}

/** Проценты через запятую: «95», «66,5». */
function formatPercent(value: number): string {
  return String(value).replace(".", ",");
}

/**
 * Норма, к которой относится пометка о пробеле.
 *
 * Одним кодом обойтись нельзя: 2 784 кода в выгрузке ФГИС ЦС встречаются больше
 * чем в одной книге, и «01-01-001-01» означает экскаватор-драглайн в ГЭСН и
 * токарный станок в ГЭСНм. Пометка без книги привязалась бы к обеим позициям
 * сразу, и сверка честности расчёта перестала бы что-либо проверять.
 */
interface NormRef {
  readonly code: string;
  readonly baseType: string;
}

/**
 * Норма в тексте пометки — всегда вместе с книгой.
 *
 * 2 784 кода выгрузки встречаются больше чем в одной книге, и «01-01-001-01»
 * означает экскаватор-драглайн в ГЭСН и синхронный генератор в ГЭСНп. Пометка
 * без книги не говорит, о какой из двух работ идёт речь.
 */
function normLabel(normRef: NormRef): string {
  return `${normRef.baseType} ${normRef.code}`;
}

/**
 * Оценивает один ресурс нормы и возвращает строку расшифровки.
 *
 * Возвращает null для ресурсов, которые несут часы, а не деньги: итоговые
 * затраты труда рабочих (код «1») и затраты труда машинистов (коды «2» и
 * «4-100-*»). Их стоимость уже учтена — первых в разрядных строках, вторых
 * в цене маш.-ч.
 */
function priceResource(
  resource: NormResource,
  quantityInNormUnits: number,
  priceBook: EstimatePriceBook,
  parameters: EstimateParameters,
  normRef: NormRef,
  gaps: EstimateGap[],
  accumulator: LineAccumulator,
): EstimateResourceLine | null {
  const totalQuantity = roundTo(resource.quantity * quantityInNormUnits, 6);

  // Ресурс без конкретной марки и ресурс с расходом «по проекту» оценить
  // нельзя: цена и количество лежат в проектной документации, а не в норме.
  // Оба случая обязаны быть видны, иначе смета выглядит полной, но занижена.
  if (resource.projectSpecific) {
    const group =
      resource.technologyGroup !== null
        ? `, технологическая группа ${resource.technologyGroup}`
        : "";
    gaps.push({
      kind: "PROJECT_SPECIFIC_RESOURCE",
      message: `Ресурс ${resource.code} «${resource.name}» в норме ${normLabel(normRef)} указан без конкретной марки${group} — стоимость определяется проектом и в расчёт не попала`,
      code: normRef.code,
      baseType: normRef.baseType,
    });
    return null;
  }

  if (resource.quantityNote !== null) {
    gaps.push({
      kind: "QUANTITY_BY_PROJECT",
      message: `Расход ресурса ${resource.code} «${resource.name}» в норме ${normLabel(normRef)} указан как «${resource.quantityNote}» (по проекту) — стоимость не учтена`,
      code: normRef.code,
      baseType: normRef.baseType,
    });
    return null;
  }

  if (resource.kind === "LABOUR") {
    return priceLabour(
      resource,
      totalQuantity,
      priceBook,
      normRef,
      gaps,
      accumulator,
    );
  }

  if (resource.kind === "WORKER_HOURS_TOTAL") {
    accumulator.labourHoursTotal += totalQuantity;
    return null;
  }

  if (resource.kind === "MACHINIST_HOURS") {
    accumulator.machinistHours += totalQuantity;
    return null;
  }

  if (resource.kind === "UNKNOWN") {
    gaps.push({
      kind: "UNKNOWN_RESOURCE",
      message: `Код ресурса ${resource.code} в норме ${normLabel(normRef)} не распознан и не оценён`,
      code: normRef.code,
      baseType: normRef.baseType,
    });
    return null;
  }

  const priced = resolvePrice(resource.code, resource.kind, priceBook, parameters, normRef, gaps);
  const total = roundTo(totalQuantity * priced.unitPrice, 2);

  if (resource.kind === "MACHINE") {
    accumulator.machineHours += totalQuantity;
    accumulator.machineCost += total;
    if (priced.machinistSalary > 0) {
      accumulator.machinistSalaryCost += roundTo(totalQuantity * priced.machinistSalary, 2);
    }
    // Второй путь к часам машинистов — для сверки со служебным кодом «2».
    // Машина без известного состава звена делает сумму неполной, и сверку
    // приходится выключать: иначе она поймала бы пробел в данных как ошибку.
    if (priced.machinistCrew !== null && Number.isFinite(priced.machinistCrew)) {
      accumulator.machinistHoursFromMachines += totalQuantity * priced.machinistCrew;
    } else {
      accumulator.machinistCrewUnknown = true;
    }
    return {
      code: resource.code,
      name: priced.name,
      unit: resource.unit.length > 0 ? resource.unit : "маш.-ч",
      quantity: totalQuantity,
      unitPrice: priced.unitPrice,
      total,
      source: priced.source,
      kind: resource.kind,
      wageOrigin: null,
    };
  }

  accumulator.materialCost += total;
  return {
    code: resource.code,
    name: priced.name,
    unit: resource.unit,
    quantity: totalQuantity,
    unitPrice: priced.unitPrice,
    total,
    source: priced.source,
    kind: resource.kind,
    wageOrigin: null,
  };
}

/**
 * Оценивает труд по тарифной шкале зоны: и разряды рабочих, и коды
 * специалистов «3-*», которые остаются без денег.
 *
 * Ставка вне известных разрядов продолжается по наклону крайнего участка и
 * обязательно помечается: обнулить оплату труда значило бы занизить смету
 * молча, а правило проекта — чтобы ничто не исчезало без объяснения.
 *
 * Строка без ставки печатается с источником `UNPRICED`, а не `WAGE_SCALE`:
 * подпись «тарифная шкала» рядом с 0 ₽ утверждала бы, что шкала дала ноль.
 */
function priceLabour(
  resource: NormResource,
  totalQuantity: number,
  priceBook: EstimatePriceBook,
  normRef: NormRef,
  gaps: EstimateGap[],
  accumulator: LineAccumulator,
): EstimateResourceLine {
  const scale = priceBook.wageScale;
  const wage = resolveWage(scale, resource.code);

  // Разряд есть — рабочий, разряда нет — специалист. Других вариантов в
  // выгрузке не встречается: коды труда делятся на разрядные («1-100-*»,
  // «2-100-*») и должностные («3-*»), и вторые не входят в тарифную сетку.
  if (rankFromWageCode(resource.code) === null) {
    accumulator.specialistHours += totalQuantity;
  } else {
    accumulator.labourHours += totalQuantity;
  }

  const name =
    resource.name.length > 0
      ? resource.name
      : `Затраты труда рабочих, код ${resource.code}`;

  if (wage === null) {
    gaps.push({
      kind: "NO_WAGE",
      message: `${noWageReason(scale, resource.code)} — ${formatHours(totalQuantity)} чел.-ч по норме ${normLabel(normRef)} остались без оплаты`,
      code: normRef.code,
      baseType: normRef.baseType,
    });
    return {
      code: resource.code,
      name,
      unit: "чел.-ч",
      quantity: totalQuantity,
      unitPrice: 0,
      total: 0,
      source: "UNPRICED",
      kind: resource.kind,
      wageOrigin: null,
    };
  }

  if (wage.origin === "EXTRAPOLATED") {
    gaps.push({
      kind: "WAGE_EXTRAPOLATED",
      message: `Ставка для разряда ${formatRank(wage.rank)} (код ${resource.code}) продолжена за пределы шкалы зоны «${scale.zone}», известной до разряда ${formatRank(scale.maxRank)}: ${formatSalary(wage.salary)} ₽/чел.-ч — приближение`,
      code: normRef.code,
      baseType: normRef.baseType,
    });
  }

  const cost = roundTo(totalQuantity * wage.salary, 2);
  accumulator.labourHoursPriced += totalQuantity;
  accumulator.labourCost += cost;

  return {
    code: resource.code,
    name,
    unit: "чел.-ч",
    quantity: totalQuantity,
    unitPrice: wage.salary,
    total: cost,
    source: "WAGE_SCALE",
    kind: resource.kind,
    wageOrigin: wage.origin,
  };
}

/**
 * Почему ставка не найдена — три разные причины, и путать их нельзя.
 *
 * Шкала может быть не загружена вовсе; может быть загружена, но код описывает
 * не разряд, а должность специалиста (коды «3-*», 6 183 строки в пяти книгах);
 * может быть загружена и описывать разряд, но без стоимости первого разряда,
 * от которой считаются все остальные. Первая и вторая выглядят в смете
 * одинаково — ноль в оплате труда, — но исправляются по-разному.
 */
function noWageReason(scale: WageScale, code: string): string {
  if (scale.anchors.length === 0) return describeWageScale(scale);

  if (rankFromWageCode(code) === null) {
    return (
      `${describeWageScale(scale)} не покрывает код ${code}: так в выгрузке записан труд ` +
      "специалистов — техников и инженеров, у которых нет разряда, а их ставок в открытых данных нет"
    );
  }

  return (
    `${describeWageScale(scale)} не даёт начислить оплату по коду ${code}: ` +
    "стоимость часа 1-го разряда не задана, а все ставки шкалы считаются от неё"
  );
}

interface PricedResource {
  readonly unitPrice: number;
  readonly source: ResourceLineSource;
  readonly name: string;
  /** Оплата труда звена машинистов, ₽ за маш.-ч. Входит в `unitPrice`. */
  readonly machinistSalary: number;
  /** Состав звена, чел. на маш.-ч. null — в источнике не указан. */
  readonly machinistCrew: number | null;
}

/**
 * Цена, которую можно подставить в расчёт.
 *
 * Ноль — не цена, а незаполненная строка справочника. В «ФСБЦ_Маш.xml» десять
 * машин имеют `SalaryMach="0"` и `PriceCostWithoutSalary="0"`, то есть полную
 * стоимость маш.-ч по базе 01.01.2022, равную 0 ₽; девять из них — землесосы
 * папильонажные рефулерные, и внутри `<Work>` книги «ГЭСН.xml» они встречаются
 * 63 раза. Подставить такой ноль значило бы напечатать «база 01.01.2022» рядом
 * с нулевой стоимостью — молчаливое занижение, которое к тому же ловит
 * собственная сверка документа. В выгрузке ФСЦСР по Амурской области (1 зона)
 * за 3 квартал 2026 нулевых цен нет: 228 машин и 1 062 материала, ни одного
 * нуля в колонке цены. Текущие цены всё равно проверяются — правило «ноль не
 * считается ценой» от источника не зависит.
 */
function isPriced(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

/** Называет те источники, где цена нашлась, но оказалась нулевой. */
function zeroPriceMessage(
  code: string,
  priceBook: EstimatePriceBook,
  normRef: NormRef,
  current: ResourcePrice | undefined,
  base: ResourcePrice | undefined,
): string {
  const places: string[] = [];
  if (current !== undefined) places.push(`в текущих ценах зоны «${priceBook.priceZone}»`);
  if (base !== undefined) places.push(`в базе ${priceBook.baseEdition}`);
  return (
    `Цена ресурса ${code} ${places.join(" и ")} равна нулю — ` +
    `в норме ${normLabel(normRef)} он остался без стоимости`
  );
}

/**
 * Выбирает цену ресурса: сначала текущая по зоне, затем база 2022 с индексом,
 * затем база 2022 как есть — с явной пометкой о понижении точности.
 *
 * Нулевая цена в любом источнике считается отсутствующей. Если заменить её
 * нечем, расчёт даёт ZERO_PRICE, а не вид «цена найдена»: ноль в базе означает
 * «цена не задана», а не «ресурс бесплатен».
 */
function resolvePrice(
  code: string,
  kind: NormResource["kind"],
  priceBook: EstimatePriceBook,
  parameters: EstimateParameters,
  normRef: NormRef,
  gaps: EstimateGap[],
): PricedResource {
  const current = priceBook.current.get(code);
  const base = priceBook.base.get(code);
  const currentIsZero = current !== undefined && !isPriced(current.price);

  if (current !== undefined && !currentIsZero) {
    return {
      unitPrice: current.price,
      source: "CURRENT_ZONE",
      name: current.name.length > 0 ? current.name : code,
      machinistSalary: current.machinistSalary ?? 0,
      machinistCrew: current.machinistHours,
    };
  }

  if (base === undefined || !isPriced(base.price)) {
    if (current === undefined && base === undefined) {
      gaps.push({
        kind: "NO_PRICE",
        message: `Цена ресурса ${code} не найдена ни в текущих ценах зоны «${priceBook.priceZone}», ни в базе ${priceBook.baseEdition} — в норме ${normLabel(normRef)} он остался без стоимости`,
        code: normRef.code,
        baseType: normRef.baseType,
      });
      return {
        unitPrice: 0,
        source: "UNPRICED",
        name: code,
        machinistSalary: 0,
        machinistCrew: null,
      };
    }

    gaps.push({
      kind: "ZERO_PRICE",
      message: zeroPriceMessage(code, priceBook, normRef, current, base),
      code: normRef.code,
      baseType: normRef.baseType,
    });
    const foundName = (base?.name ?? current?.name ?? "").trim();
    return {
      unitPrice: 0,
      source: "UNPRICED",
      name: foundName.length > 0 ? foundName : code,
      machinistSalary: 0,
      machinistCrew: base?.machinistHours ?? current?.machinistHours ?? null,
    };
  }

  const index = indexFor(kind, parameters);
  if (index === null) {
    gaps.push({
      kind: "NO_CURRENT_PRICE",
      message: currentIsZero
        ? `Текущая цена зоны «${priceBook.priceZone}» для ресурса ${code} равна нулю, индекс пересчёта не задан — в норме ${normLabel(normRef)} взята база ${priceBook.baseEdition} без пересчёта`
        : `Для ресурса ${code} в норме ${normLabel(normRef)} нет текущей цены зоны, индекс пересчёта не задан — взята база ${priceBook.baseEdition} без пересчёта`,
      code: normRef.code,
      baseType: normRef.baseType,
    });
    return {
      unitPrice: base.price,
      source: "BASE_2022",
      name: base.name.length > 0 ? base.name : code,
      machinistSalary: base.machinistSalary ?? 0,
      machinistCrew: base.machinistHours,
    };
  }

  /*
    Цена маш.-ч в базе полная: «без зарплаты» плюс оплата труда звена. Две её
    части пересчитываются разными индексами, потому что Минстрой публикует их
    раздельно — внутри индекса к эксплуатации машин оплата труда машинистов
    выделена как «в том числе ОТм».

    Считать всю цену индексом машин, а ту же зарплату в фонде оплаты труда —
    индексом труда значило бы получить два разных числа для одной величины:
    внутри стоимости машин сидела бы одна зарплата, а в базе накладных расходов
    и сметной прибыли стояла бы другая. Поэтому зарплата вынимается, обе части
    пересчитываются своими индексами и складываются обратно.

    Для материалов вынимать нечего: `machinistSalary` у них null.
  */
  const machinistIndex = parameters.indices?.machinistLabour ?? 1;
  const baseSalary = base.machinistSalary ?? 0;
  const indexedSalary = roundTo(baseSalary * machinistIndex, 2);
  const withoutSalary = base.price - baseSalary;

  // Зарплата звена не может превышать полную цену маш.-ч: в выгрузке цена и
  // собирается как «без зарплаты» плюс зарплата. Если источник это нарушил,
  // разбирать цену на части нельзя — пересчитываем целиком индексом машин и
  // говорим об этом, а не печатаем отрицательную составляющую.
  if (withoutSalary < 0) {
    gaps.push({
      kind: "MACHINE_PRICE_INCONSISTENT",
      message: `У ресурса ${code} оплата труда звена ${formatMoney(baseSalary)} ₽ больше полной цены маш.-ч ${formatMoney(base.price)} ₽ в базе ${priceBook.baseEdition} — цена пересчитана целиком индексом машин, без выделения ОТм`,
      code: normRef.code,
      baseType: normRef.baseType,
    });
    return {
      unitPrice: roundTo(base.price * index, 2),
      source: "BASE_2022_INDEXED",
      name: base.name.length > 0 ? base.name : code,
      machinistSalary: indexedSalary,
      machinistCrew: base.machinistHours,
    };
  }

  return {
    unitPrice: roundTo(withoutSalary * index + indexedSalary, 2),
    source: "BASE_2022_INDEXED",
    name: base.name.length > 0 ? base.name : code,
    machinistSalary: indexedSalary,
    machinistCrew: base.machinistHours,
  };
}

/** Индекс по элементу затрат: для машин — свой, для материалов — свой. */
function indexFor(kind: NormResource["kind"], parameters: EstimateParameters): number | null {
  if (parameters.indices === null) return null;
  if (kind === "MACHINE") return parameters.indices.machines;
  return parameters.indices.materials;
}

/** Считает раздел: строки плюс подытоги. */
export function computeEstimateSection(
  section: BillOfWorkSection,
  priceBook: EstimatePriceBook,
  parameters: EstimateParameters,
  resolveNorm: NormResolver,
): { section: EstimateSection; gaps: EstimateGap[] } {
  const lines: EstimateLine[] = [];
  const gaps: EstimateGap[] = [];

  for (const item of section.items) {
    /*
      Поставка не идёт в подбор расценки. Документ уже сказал, что это ресурс,
      а не работа, и искать для неё норму незачем: поиск по наименованию
      «Металлоконструкции … сталь С255» найдёт монтаж металлоконструкций и
      принесёт оттуда чужие труд и машины. На смете 02-01-02-КМ1 так и вышло —
      1 000,72 чел.-ч вместо 601,21.
    */
    if (item.resourceCode !== null) {
      const outcome = computeResourceLine(item, priceBook, parameters);
      gaps.push(...outcome.gaps);
      if (outcome.line !== null) lines.push(outcome.line);
      continue;
    }

    const resolution = resolveNorm(item);
    if (resolution === null) {
      gaps.push(noNormGap(item));
      continue;
    }
    const outcome = computeEstimateLine(item, resolution, priceBook, parameters);
    gaps.push(...outcome.gaps);
    if (outcome.line !== null) lines.push(outcome.line);
  }

  const directCost = roundTo(sum(lines, (line) => line.directCost), 2);
  const overheadCost = roundTo(sum(lines, (line) => line.overheadCost), 2);
  const profitCost = roundTo(sum(lines, (line) => line.profitCost), 2);

  return {
    section: {
      title: section.title,
      lines,
      directCost,
      overheadCost,
      profitCost,
      workCost: roundTo(directCost + overheadCost + profitCost, 2),
    },
    gaps,
  };
}

/** Собирает весь документ: разделы, итоги, пробелы, источники. */
export function buildEstimate(request: EstimateRequest): EstimateDocument {
  const sections: EstimateSection[] = [];
  const gaps: EstimateGap[] = [];

  for (const billSection of request.sections) {
    const computed = computeEstimateSection(
      billSection,
      request.priceBook,
      request.parameters,
      request.resolveNorm,
    );
    sections.push(computed.section);
    gaps.push(...computed.gaps);
  }

  const totals = computeTotals(sections, request.parameters);

  return {
    title: request.title,
    region: request.priceBook.region,
    priceZone: request.priceBook.priceZone,
    period: request.priceBook.period,
    method: "RESOURCE_INDEX",
    baseEdition: request.priceBook.baseEdition,
    parameters: request.parameters,
    wageScale: request.priceBook.wageScale,
    sections,
    totals,
    gaps: dedupeGaps(gaps),
    sources: request.sources,
    generatedAt: request.generatedAt,
    disclaimer: request.disclaimer,
  };
}

/** Итоги по документу, включая лимитированные затраты и НДС. */
export function computeTotals(
  sections: readonly EstimateSection[],
  parameters: EstimateParameters,
): EstimateTotals {
  const lines = sections.flatMap((section) => section.lines);

  const directCost = roundTo(sum(lines, (line) => line.directCost), 2);
  const wageFund = roundTo(sum(lines, (line) => line.wageFund), 2);
  const overheadCost = roundTo(sum(lines, (line) => line.overheadCost), 2);
  const profitCost = roundTo(sum(lines, (line) => line.profitCost), 2);
  const workCost = roundTo(directCost + overheadCost + profitCost, 2);

  /*
    Лимитированные затраты начисляются последовательно, а не оба от стоимости
    СМР.

    Порядок задан сводным сметным расчётом: временные здания и сооружения —
    глава 8, от итога строительно-монтажных работ; зимнее удорожание — глава 9,
    от итога, в который глава 8 уже вошла. Начислить оба процента от одной базы
    значит занизить зимнее удорожание ровно на «временные здания × зимний
    процент»: на большой смете это заметная сумма, и она уходит в итог тихо.
  */
  const temporaryStructures = roundTo(
    (workCost * parameters.limited.temporaryStructuresPercent) / 100,
    2,
  );
  const winterSurcharge = roundTo(
    ((workCost + temporaryStructures) * parameters.limited.winterSurchargePercent) / 100,
    2,
  );
  const beforeVat = roundTo(workCost + temporaryStructures + winterSurcharge, 2);
  const vat = roundTo((beforeVat * parameters.vatPercent) / 100, 2);

  return {
    directCost,
    wageFund,
    overheadCost,
    profitCost,
    workCost,
    winterSurcharge,
    temporaryStructures,
    beforeVat,
    vat,
    total: roundTo(beforeVat + vat, 2),
  };
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

/** Человеко-часы через запятую: «203,11». */
function formatHours(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

/** Рубли через запятую: «1 692,45». */
function formatMoney(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

/**
 * Убирает повторяющиеся пробелы документа: одна и та же цена может отсутствовать
 * в десятках норм.
 *
 * Книга и код нормы входят в ключ обязательно. Сообщение о ненайденной цене
 * называет только код ресурса, поэтому у двух разных норм оно совпадает
 * посимвольно; склейка по тексту оставила бы вторую норму без пометки, и сверка
 * честности расчёта сочла бы её ноль необъяснённым.
 */
function dedupeGaps(gaps: readonly EstimateGap[]): EstimateGap[] {
  const seen = new Set<string>();
  const result: EstimateGap[] = [];
  for (const gap of gaps) {
    const key = `${gap.kind}|${gap.baseType}|${gap.code}|${gap.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(gap);
  }
  return result;
}
