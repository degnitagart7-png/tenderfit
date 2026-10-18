import {
  hasAutoServices,
  isServiceItem,
  resolveServicePrice,
  type ServicePrice,
  type ZoneAutoServices,
} from "@/domain/estimate/autoServices";
import {
  classifyResourceCode,
  rankFromWageCode,
  roundTo,
  unitForResourceKind,
} from "@/domain/estimate/resourceKinds";
import { substituteNormMaterial } from "@/domain/estimate/normMaterial";
import { normalizeText } from "@/domain/estimate/normalize";
import { correctedRatePointers } from "@/domain/estimate/overheadNormatives";
import { describeRateMultipliers, resolveRateMultipliers } from "@/domain/estimate/rateMultipliers";
import { supplySanityProblem } from "@/domain/estimate/supplyGuard";
import { deriveSupplyDivisor } from "@/domain/estimate/units";
import { describeWorkConditions, NEUTRAL, resolveItemCoefficients } from "@/domain/estimate/workConditions";
import { describeWageScale, formatRank, formatSalary, resolveWage } from "@/domain/estimate/wageScale";
import type {
  AppliedNormative,
  BillOfWorkItem,
  BillOfWorkSection,
  CustomerMaterialRow,
  EstimateDocument,
  EstimateGap,
  EstimatePriceZoneChoice,
  EstimateLine,
  EstimateParameters,
  EstimateResourceLine,
  EstimateSection,
  EstimateSource,
  EstimateTotals,
  LineCoefficients,
  NormRecord,
  NormResource,
  OverheadRate,
  OverheadRateSource,
  ResourceLineSource,
  ResourcePrice,
  SplitAllPrice,
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
 *    служебному коду «2» — она уже сидит внутри цены маш.-ч, которой оценена
 *    машина в расчёте (`unitPrice`, `machineCost`). Проверено на норме
 *    01-01-001-01 книги ГЭСН: код «2» = 6,4 чел.-ч ровно равен сумме
 *    (маш.-ч × звено) по машинам. Если считать и то, и другое, зарплата
 *    машинистов удвоится.
 *
 *    Но в источниках цен «полная» стоимость маш.-ч устроена по-разному, и это
 *    главное место, где расчёт легко занизить. Цена машины в базе ФСБЦ-2022
 *    ВКЛЮЧАЕТ оплату труда машинистов (814,35 ₽ при ОТм 336,43 ₽ — «без зарплаты»
 *    477,92 ₽). А «Сметная цена, руб./маш.-ч» из опубликованных ФГИС ЦС текущих цен
 *    (ФСЦСР) и из сплит-формы — БЕЗ неё: оплата труда машинистов вынесена в отдельную
 *    колонку (у «Автомобили бортовые до 5 т» 91.14.02-001 цена 800,01, ОТм 912,83 —
 *    оплата больше цены, то есть внутри цены её быть не может). Поэтому `resolvePrice`
 *    для текущей цены зоны складывает «цена + ОТм» и отдаёт полную стоимость
 *    маш.-ч, а `machinistSalary` оставляет частью этой суммы — ровно как у базы 2022.
 *    Ниже по расчёту все машины одинаковы: `unitPrice` и `machineCost` с оплатой,
 *    `machinistSalaryCost` — её доля для ФОТ. В форме 421/пр ЭМ печатается без ОТм
 *    (`machineCost − machinistSalaryCost`), а ОТм — отдельными строками 4-100-*.
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
 *    инженер, главный технолог) — труд, а не неизвестный ресурс. Семь таких
 *    кодов дают 6 183 строки: 2 565 работ книги ГЭСНп, 53 — ГЭСНм, 35 —
 *    ГЭСНмр. Ставки для них есть в реестре ставок оплаты труда зоны
 *    (`RimWorkerSalaryRegistry`), но на страницах после первой: коды реестра
 *    «3-100-01», «3-200-03», «3-300-01», «3-400-01» совпадают с кодами норм
 *    буква в букву, как и наименования («Инженер III категории»). Поэтому ставка
 *    ищется по точному коду в `WageScale.specialists`, а не по разряду: у
 *    должности разряда нет, и приравнять её к разряду рабочих нельзя.
 *    Код, которого в реестре зоны нет (шкала собрана по первой странице
 *    реестра, либо реестр дал иной состав), по-прежнему получает NO_WAGE:
 *    часы остаются в трудозатратах, денег нет, пометка называет причину.
 *    Оплата специалистов входит в оплату труда строки и, значит, в ФОТ — базу
 *    накладных расходов и сметной прибыли, как и оплата рабочих; ставка строки
 *    (`labourRate`) — средняя по всем оплаченным часам, и рабочим, и ИТР. Это
 *    главное для пусконаладки: в ГЭСНп нет ни машин, ни материалов ни в одной из
 *    2 605 работ, и без ставок ИТР она оценивалась только по рабочим.
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
 * 6. Порядок поиска цены ресурса: текущая цена книги зоны → «все цены сплит-формы» →
 *    база 2022. Книга зоны отфильтрована по кодам из норм, и позиция-поставка, которой в
 *    нормах нет (ПГС отдельной строкой), раньше шла по базе 2022 без пересчёта, хотя
 *    в сплит-форме у неё есть цена — измеренная или полученная индексом к группе
 *    однородных ресурсов. Цена по индексу сплит-формы — текущий уровень (источник
 *    `SPLIT_INDEXED`), это не допущение уровня «база 2022». Цена машины из «всех цен» —
 *    без оплаты машинистов, а выделенной колонки ОТм в сплит-форме нет: её берут из базы
 *    2022 индексом труда машинистов, а нет базы или индекса — это пометка
 *    MACHINIST_PAY_UNKNOWN. Машине в норме с отдельными строками машинистов цена из
 *    «всех цен» не берётся вовсе: пересчёт по базе 2022 даёт цену с оплатой звена целиком.
 *
 * 7. Перевозка и погрузочно-разгрузочные работы автотранспортом считаются по сметным
 *    ценам услуг ФГИС ЦС зоны (`autoServices.ts`): шифр из обоснования или однозначный
 *    разбор наименования, объём в тоннах × цена за тонну. НР и СП на них не начисляются —
 *    как в смете заказчика по Методике 421/пр: это цена услуги, а не работа по расценке.
 *    Нет таблицы зоны, нет шифра или сопоставление неоднозначно — позиция считается как
 *    прежде (норма, цена заказчика или разрыв).
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
  /**
   * Все цены сплит-формы зоны по коду ресурса. Нет — зона собрана без файла, и цена,
   * которой нет в `current`, ищется сразу в базе 2022. Загружается лениво вызывающим
   * кодом на время расчёта (файл — десятки мегабайт), в долгоживущую книгу не кладётся.
   */
  readonly splitAll?: ReadonlyMap<string, SplitAllPrice> | null;
  /** Цены перевозки и погрузки зоны (ФГИС ЦС). Нет — такие позиции считаются как прежде. */
  readonly services?: ZoneAutoServices | null;
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
  /** Почему выбрана ценовая зона книги; кладётся в документ, чтобы это было видно на экране. */
  readonly priceZoneChoice?: EstimatePriceZoneChoice;
  /**
   * Нормативы зимнего удорожания и временных зданий (и их причины, если не начислены): считаются до
   * расчёта (`limitedCosts.ts`), здесь только кладутся в документ рядом с нормативами условий работ.
   */
  readonly appliedNormatives?: readonly AppliedNormative[];
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
    billSection: item.billSection,
  };
}

/**
 * Строка — материал, ресурс которому не подобран: цены нет. Норму работы такой строке не ищут (`BillOfWorkItem.materialRow`), поэтому
 * пробел называет причину словами материала, а не «норма не найдена».
 */
function noMaterialPriceGap(item: BillOfWorkItem): EstimateGap {
  return {
    kind: "NO_PRICE",
    message: `Позиция «${item.workName}» — материал или оборудование, а не работа (${item.materialRow?.reason ?? "поставка"}): ресурс в справочнике цен не подобран — стоимость не рассчитана, проверьте. Норма работы для материала не подбирается`,
    code: null,
    baseType: null,
    billSection: item.billSection,
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
      billSection: item.billSection,
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
      billSection: item.billSection,
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
      billSection: item.billSection,
    });
    return { line: null, gaps };
  }

  const accumulator = emptyAccumulator();
  const resources: EstimateResourceLine[] = [];
  const gapsBefore = gaps.length;
  // Оплата машинистов в норме идёт отдельными строками: цену машины из «всех цен сплит-формы» тогда не берём.
  const operatorRows = norm.resources.some((resource) => resource.kind === "MACHINIST_HOURS");
  // Коэффициенты условий работ (421/пр, прил. 10): без выбора условий — единицы, расход нормы без изменений.
  const coefficients = resolveItemCoefficients(parameters.workConditions, item.customerConditions, {
    baseType: norm.baseType,
    collectionCode: norm.collectionCode,
    name: `${item.workName} ${norm.fullName}`,
  });
  const factors = coefficients ?? NEUTRAL;

  // Ресурсы нормы «по проекту», вместо которых подобран материал справочника цен (`aiNormMaterials`): чужими материалами заказчика не закрываются.
  const aiPickedCodes = new Set<string>();
  for (const resource of norm.resources) {
    /*
      Материал нормы «по проекту», подобранный «ИИ-сметчиком» (`normMaterial.ts`): ресурс без марки с числовым расходом заменяется материалом справочника
      цен, и дальше он оценивается как любой материал нормы — расход × объём, цена зоны. Пробела PROJECT_SPECIFIC_RESOURCE нет, вместо него — пометка
      AI_MATERIAL_PICK с обоснованием: материал выбран не документом, и его надо проверить. Расход «по проекту» без числа сюда не попадает никогда.
    */
    const substitute = substituteNormMaterial(item, norm, resource);
    const outcome = priceResource(
      substitute === null ? resource : substitute.resource,
      quantityInNormUnits,
      priceBook,
      parameters,
      normRef,
      gaps,
      accumulator,
      operatorRows,
      factors,
    );
    if (outcome === null) continue;
    if (substitute === null) {
      resources.push(outcome);
      continue;
    }
    aiPickedCodes.add(resource.code);
    resources.push({ ...outcome, note: substitute.material.note });
    gaps.push({
      kind: "AI_MATERIAL_PICK",
      message: `«${item.workName}»: ресурс ${resource.code} «${resource.name === "" ? "без наименования" : resource.name}» в норме ${normLabel(normRef)} указан без конкретной марки — взят материал ${substitute.material.code} «${substitute.material.name}», ${formatMoney(outcome.total)} ₽ (${substitute.material.note}); проверьте`,
      code: normRef.code,
      baseType: normRef.baseType,
      billSection: item.billSection,
    });
  }

  /*
    Материалы по сумме заказчика. В выгрузке ЛСР строк ресурсов нет, только итог группы «М», и пересчитать состав нашими
    ценами нечем. Но группа говорит, совпадает ли состав материалов с нормой: у позиции с нормой заказчика его «М» равна нашей
    до копейки (ГЭСН 26-01-011-01: 5 111,19 и 5 111,19), у позиции с заменённым составом — нет (26-01-052-01: у него 458,16,
    у нас по норме 26 957,71: он исключил алюминиевые листы и рубероид, а заменивший их материал стоит в невидимом остатке
    позиции). Расходятся больше чем на четверть и на 100 ₽ — материалы берутся по его сумме, а не по составу нормы.
  */
  let materialsReplaced = false;

  /*
    Материалы, которых заказчик в позиции не учёл. Строки ресурсов у позиции есть (`customerResources`), а группа «М» напечатана и равна
    нулю: заказчик материалы из позиции убрал сознательно — они вынесены отдельной позицией (закупка 0134300025826000377, поз. 1
    ГЭСН15-01-070-01 «Облицовка оконных проемов … откосной планкой»: планки — поз. 2; закупка 0391300028226000005, поз. 3 ГЭСН12-01-007-12).
    Правило «сверка по сумме» выше работает только без состава заказчика, поэтому материалы нормы, оценённые здесь, шли бы в смету второй раз.
    Материалы позиции — нуль, строки материалов нормы снимаются вместе с пометками об их ценах. Если у заказчика материалы в позиции есть
    (его «М» больше нуля) или «М» неизвестна — правило не действует, состав берётся как раньше. Материалы, названные человеком
    (`projectMaterials`), ниже добавляются как всегда: это его решение, а не норма.
  */
  if (item.customerResources !== undefined && item.customerMaterials !== undefined && Math.abs(item.customerMaterials) < 0.005 && accumulator.materialCost > 0) {
    const ours = accumulator.materialCost;
    const removed = resources.filter((resource) => resource.kind === "MATERIAL").map((resource) => resource.code);
    for (let index = resources.length - 1; index >= 0; index -= 1) {
      if ((resources[index] as EstimateResourceLine).kind === "MATERIAL") resources.splice(index, 1);
    }
    for (let index = gaps.length - 1; index >= gapsBefore; index -= 1) {
      const gap = gaps[index] as EstimateGap;
      if (
        gap.code === norm.code &&
        gap.baseType === norm.baseType &&
        ["NO_PRICE", "ZERO_PRICE", "NO_CURRENT_PRICE", "INDEXED_PRICE"].includes(gap.kind) &&
        removed.some((code) => gap.message.includes(code))
      ) {
        gaps.splice(index, 1);
      }
    }
    accumulator.materialCost = 0;
    materialsReplaced = true;
    gaps.push({
      kind: "CUSTOMER_PRICE",
      message: `«${item.workName}»: материалы у заказчика в позиции не учтены (вынесены отдельно) — «М» = 0 при строках ресурсов; материалы нормы на ${formatMoney(ours)} ₽ в расчёт не включены, чтобы не считать их дважды`,
      code: norm.code,
      baseType: norm.baseType,
      billSection: item.billSection,
    });
  }

  if (item.customerMaterials !== undefined && item.customerResources === undefined) {
    const ours = accumulator.materialCost;
    const theirs = item.customerMaterials;
    if (Math.abs(ours - theirs) > Math.max(100, 0.25 * Math.max(ours, theirs))) {
      materialsReplaced = true;
      const removed = resources.filter((resource) => resource.kind === "MATERIAL").map((resource) => resource.code);
      for (let index = resources.length - 1; index >= 0; index -= 1) {
        if ((resources[index] as EstimateResourceLine).kind === "MATERIAL") resources.splice(index, 1);
      }
      // Пометки об этих материалах (нет цены, цена базы) теряют смысл: в строке их больше нет.
      for (let index = gaps.length - 1; index >= gapsBefore; index -= 1) {
        const gap = gaps[index] as EstimateGap;
        if (
          gap.code === norm.code &&
          gap.baseType === norm.baseType &&
          ["NO_PRICE", "ZERO_PRICE", "NO_CURRENT_PRICE", "INDEXED_PRICE"].includes(gap.kind) &&
          removed.some((code) => gap.message.includes(code))
        ) {
          gaps.splice(index, 1);
        }
      }
      accumulator.materialCost = theirs;
      resources.push({
        code: "—",
        name: "Материалы по сумме заказчика (состав в его ЛСР иной, чем в норме)",
        unit: "усл. ед.",
        quantity: 1,
        unitPrice: theirs,
        total: theirs,
        source: "CUSTOMER_SUM",
        kind: "MATERIAL",
        wageOrigin: null,
      });
      gaps.push({
        kind: "CUSTOMER_PRICE",
        message: `«${item.workName}»: материалы по сумме заказчика ${formatMoney(theirs)} ₽, по норме у нас ${formatMoney(ours)} ₽ — в его ЛСР состав материалов иной, чем в норме (исключены или заменены), строк ресурсов в выгрузке нет`,
        code: norm.code,
        baseType: norm.baseType,
        billSection: item.billSection,
      });
    }
  }

  /*
    Материал нормы «по проекту» по цене заказчика. Ресурс без марки (профилированный лист, труба, кабель) или с расходом «П» цены в
    нашей базе не имеет, и его стоимость выпадала из строки — смета занижалась на весь этот материал (закупка 0391300028226000005,
    ГЭСН12-01-033-02 «Монтаж кровли из профилированного листа»: у заказчика 698 тыс. ₽, у нас 275 тыс. ₽). Заказчик свой материал оценил, и в
    выгрузке его ресурсные строки есть (`customerMaterialRows`): берётся строка с тем же кодом, а если такой нет — материалы заказчика,
    которых в норме нет вовсе (так программа называет подобранную по проекту марку). Строка идёт по его цене с источником
    CUSTOMER_SUM и пробелом CUSTOMER_PRICE: нашими ценами она не проверена. Сумма материалов по группе «М» (выше) приоритетнее: она уже
    заменила материалы позиции целиком. Материал, названный человеком, ниже снимает пробел сам — его здесь не трогаем.
  */
  if (item.customerMaterialRows !== undefined && item.customerResources === undefined && !materialsReplaced) {
    const named = new Set((item.projectMaterials ?? []).map((material) => material.code));
    const open = norm.resources.filter(
      (resource) => resource.kind === "MATERIAL" && (resource.projectSpecific || resource.quantityNote !== null) && !named.has(resource.code) && !aiPickedCodes.has(resource.code),
    );
    if (open.length > 0) {
      const normCodes = new Set(norm.resources.map((resource) => resource.code));
      const taken = new Set<CustomerMaterialRow>();
      const matches: { resource: NormResource | null; row: CustomerMaterialRow }[] = [];
      for (const resource of open) {
        const row = item.customerMaterialRows.find((candidate) => candidate.code === resource.code && !taken.has(candidate));
        if (row === undefined) continue;
        taken.add(row);
        matches.push({ resource, row });
      }
      const waiting = open.filter((resource) => !matches.some((match) => match.resource === resource));
      for (const row of item.customerMaterialRows) {
        if (taken.has(row) || normCodes.has(row.code)) continue;
        taken.add(row);
        matches.push({ resource: waiting.shift() ?? null, row });
      }
      for (const { resource, row } of matches) {
        const total = roundTo(row.costPerUnit * item.quantity, 2);
        if (!(total > 0)) continue;
        if (resource !== null) {
          for (let index = gaps.length - 1; index >= gapsBefore; index -= 1) {
            const gap = gaps[index] as EstimateGap;
            if (
              gap.code === norm.code &&
              gap.baseType === norm.baseType &&
              (gap.kind === "PROJECT_SPECIFIC_RESOURCE" || gap.kind === "QUANTITY_BY_PROJECT") &&
              (gap.message.includes(`Ресурс ${resource.code} `) || gap.message.includes(`ресурса ${resource.code} `))
            ) {
              gaps.splice(index, 1);
            }
          }
        }
        accumulator.materialCost += total;
        resources.push({
          code: row.code,
          name: `${row.name === "" ? row.code : row.name} (по цене заказчика)`,
          unit: "усл. ед.",
          quantity: 1,
          unitPrice: total,
          total,
          source: "CUSTOMER_SUM",
          kind: "MATERIAL",
          wageOrigin: null,
        });
        const forWhat =
          resource === null
            ? "материал заказчика, которого нет в норме (в норме есть ресурс по проекту)"
            : `ресурс ${resource.code} «${resource.name}» указан в норме ${normLabel(normRef)} без марки или по проекту`;
        gaps.push({
          kind: "CUSTOMER_PRICE",
          message: `«${item.workName}»: материал «${row.name === "" ? row.code : row.name}» (${row.code}) принят по цене заказчика ${formatMoney(total)} ₽ — ${forWhat}, нашей цены на него нет, не проверено`,
          code: norm.code,
          baseType: norm.baseType,
          billSection: item.billSection,
        });
      }
    }
  }

  // Материалы «по проекту», названные человеком (правка «материал»): строка со своей ценой, пробел по ресурсу снимается.
  for (const material of item.projectMaterials ?? []) {
    if (!(material.quantity > 0) || !(material.unitPrice > 0)) continue;
    const total = roundTo(material.quantity * material.unitPrice, 2);
    for (let index = gaps.length - 1; index >= gapsBefore; index -= 1) {
      const gap = gaps[index] as EstimateGap;
      if (
        gap.code === norm.code &&
        gap.baseType === norm.baseType &&
        (gap.kind === "PROJECT_SPECIFIC_RESOURCE" || gap.kind === "QUANTITY_BY_PROJECT") &&
        (gap.message.includes(`Ресурс ${material.code} `) || gap.message.includes(`ресурса ${material.code} `))
      ) {
        gaps.splice(index, 1);
      }
    }
    accumulator.materialCost += total;
    resources.push({
      code: material.code,
      name: material.name,
      unit: material.unit,
      quantity: material.quantity,
      unitPrice: material.unitPrice,
      total,
      source: "OWN_PRICE",
      kind: "MATERIAL",
      wageOrigin: null,
    });
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

  const baseRates = resolveOverheadRates(norm, priceBook, parameters, gaps);
  // Множители заказчика к НР и СП (812/пр п. 25, 774/пр п. 16) — к нашему нормативу по указателю нормы; резерв документа их не получает.
  const multipliers = resolveRateMultipliers(item.customerConditions, coefficients, {
    baseType: norm.baseType,
    collectionCode: norm.collectionCode,
  });
  const overheadFactor = multipliers !== null && baseRates.overheadSource === "NORM_REF" ? multipliers.overhead : 1;
  const profitFactor = multipliers !== null && baseRates.profitSource === "NORM_REF" ? multipliers.profit : 1;
  const rates = {
    ...baseRates,
    overheadPercent: roundTo(baseRates.overheadPercent * overheadFactor, 4),
    profitPercent: roundTo(baseRates.profitPercent * profitFactor, 4),
  };
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
    billSection: item.billSection,
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
    overheadRef: correctedRatePointers(norm).overheadRef,
    profitRef: correctedRatePointers(norm).profitRef,
    overheadSource: rates.overheadSource,
    profitSource: rates.profitSource,
    resources,
    gaps: gaps.filter(
      (gap) => gap.code === norm.code && gap.baseType === norm.baseType,
    ),
    ...(coefficients === null ? {} : { coefficients }),
    ...(multipliers === null
      ? {}
      : {
          rateMultipliers: describeRateMultipliers(
            { ...multipliers, overhead: overheadFactor, profit: profitFactor },
            { overhead: baseRates.overheadPercent, profit: baseRates.profitPercent },
          ),
        }),
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
      billSection: item.billSection,
    });
    return { line: null, gaps };
  }

  const kind = classifyResourceCode(code);
  const priced = resolvePrice(code, kind, priceBook, parameters, normRef, gaps, false, false);

  /*
    Единица берётся из справочника, а не из вида ресурса. У материалов она
    своя у каждого кода — «т», «м3», «шт», — и `unitForResourceKind` честно
    отдаёт для них пустую строку: по виду её не угадать. Машинам и труду вид
    единицу задаёт, и там она остаётся запасным вариантом.
  */
  const splitUnit = priceBook.splitAll?.get(code)?.unit;
  const catalogUnit = (
    priceBook.current.get(code)?.unit ??
    (splitUnit !== undefined && splitUnit.trim() !== "" ? splitUnit : undefined) ??
    priceBook.base.get(code)?.unit ??
    ""
  ).trim();
  const resourceUnit = catalogUnit.length > 0 ? catalogUnit : unitForResourceKind(kind);
  const billUnit = normalizeText(item.quantityUnit);

  /*
    Единица справочника с множителем — «1000 м», «100 шт», «10 м» — не расхождение, а масштаб:
    цена в справочнике назначена за тысячу метров, а объём ведомости — в метрах. Перемножение «как
    есть» умножало поставку на множитель: на закупке 0302300048726001118 провод РПШЭ, 102 м при
    единице справочника «1000 м», стоил 6,77 млн ₽ вместо 6,8 тыс. ₽. Объём переводится в единицу
    справочника (`deriveSupplyDivisor`: «м» → «1000 м» делит на 1000, «кг» → «т» делит на 1000); единицы разных величин («м3» и
    «м2», «т» и «м2», «м» и «т») по-прежнему не переводятся — это пометка, а не догадка.
  */
  const sameUnit = billUnit === normalizeText(resourceUnit);
  const divisor = sameUnit || billUnit.length === 0 || resourceUnit.length === 0 ? 1 : deriveSupplyDivisor(item.quantityUnit, resourceUnit);
  const pricedQuantity = divisor !== null && divisor > 0 ? item.quantity / divisor : item.quantity;

  if (
    billUnit.length > 0 &&
    resourceUnit.length > 0 &&
    divisor === null
  ) {
    gaps.push({
      kind: "UNIT_MISMATCH",
      message: `Единица ведомости «${item.quantityUnit}» не совпадает с единицей справочника «${resourceUnit}» для ресурса ${code} — цена умножена на объём как есть`,
      code,
      baseType: RESOURCE_BASE_TYPE,
      billSection: item.billSection,
    });
  }

  const total = roundTo(priced.unitPrice * pricedQuantity, 2);
  // Предохранитель (supplyGuard.ts): поставка дороже позиции заказчика в сотни раз — единица или объём прочитаны неверно.
  // Строки нет — позиция уходит к цене заказчика с этой причиной, а не в итог миллиардами.
  const insane = supplySanityProblem(item, total);
  if (insane !== null) {
    gaps.push({ kind: "UNIT_MISMATCH", message: insane, code, baseType: RESOURCE_BASE_TYPE, billSection: item.billSection });
    return { line: null, gaps };
  }
  const resource: EstimateResourceLine = {
    code,
    name: priced.name,
    unit: resourceUnit,
    quantity: roundTo(pricedQuantity, 6),
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
    quantity: roundTo(pricedQuantity, 6),
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
  const pointers = correctedRatePointers(norm);
  const overhead = lookupRate(
    pointers.overheadRef,
    "накладных расходов",
    priceBook,
    parameters.overhead.overheadPercent,
    norm,
    gaps,
  );
  const profit = lookupRate(
    pointers.profitRef,
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
  operatorRows: boolean,
  factors: LineCoefficients,
): EstimateResourceLine | null {
  // Коэффициенты условий работ меняют расход: труд рабочих — на `labour`, время машин и труд
  // машинистов — на `machines` (421/пр, п. 52). Оплата труда (`wage`) — ниже, на ставку.
  const factor =
    resource.kind === "LABOUR" || resource.kind === "WORKER_HOURS_TOTAL"
      ? factors.labour
      : resource.kind === "MACHINE" || resource.kind === "MACHINIST_HOURS"
        ? factors.machines
        : 1;
  // Материалы: коэффициент на разборку и демонтаж (571/пр п. 83, 84) обнуляет их стоимость в расчёте.
  const materialFactor = resource.kind === "MATERIAL" ? (factors.materials ?? 1) : 1;
  const totalQuantity = roundTo(resource.quantity * quantityInNormUnits * factor * materialFactor, 6);

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
      factors.wage,
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

  const priced = resolvePrice(resource.code, resource.kind, priceBook, parameters, normRef, gaps, operatorRows);
  const total = roundTo(totalQuantity * priced.unitPrice, 2);

  if (resource.kind === "MACHINE") {
    accumulator.machineHours += totalQuantity;
    // Повышенный размер оплаты труда (таблицы 2, 4, 6, 8) — к оплате машинистов внутри цены маш.-ч.
    const wagePremium =
      factors.wage !== 1 && priced.machinistSalary > 0
        ? roundTo(totalQuantity * priced.machinistSalary * (factors.wage - 1), 2)
        : 0;
    accumulator.machineCost += total + wagePremium;
    if (priced.machinistSalary > 0) {
      accumulator.machinistSalaryCost += roundTo(totalQuantity * priced.machinistSalary * factors.wage, 2);
    }
    // Второй путь к часам машинистов — для сверки со служебным кодом «2».
    // Машина без известного состава звена делает сумму неполной, и сверку
    // приходится выключать: иначе она поймала бы пробел в данных как ошибку.
    if (priced.machinistCrew !== null && Number.isFinite(priced.machinistCrew)) {
      accumulator.machinistHoursFromMachines += totalQuantity * priced.machinistCrew;
    } else {
      accumulator.machinistCrewUnknown = true;
    }
    const machineUnitPrice = wagePremium === 0 ? priced.unitPrice : roundTo(priced.unitPrice + priced.machinistSalary * (factors.wage - 1), 2);
    // Оплата звена внутри `unitPrice` и `total` — чтобы форма 421/пр напечатала ЭМ без неё, а ОТм отдельными строками.
    const pay =
      priced.machinistSalary > 0
        ? {
            machinistPay: roundTo(priced.machinistSalary * factors.wage, 4),
            machinistPayTotal: roundTo(totalQuantity * priced.machinistSalary * factors.wage, 2),
          }
        : {};
    return {
      code: resource.code,
      name: priced.name,
      unit: resource.unit.length > 0 ? resource.unit : "маш.-ч",
      quantity: totalQuantity,
      unitPrice: machineUnitPrice,
      total: roundTo(total + wagePremium, 2),
      source: priced.source,
      kind: resource.kind,
      wageOrigin: null,
      ...pay,
      ...baseLevelOf(resource.code, priced.source, machineUnitPrice, priceBook, pay.machinistPay ?? 0),
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
    ...baseLevelOf(resource.code, priced.source, priced.unitPrice, priceBook),
  };
}

/**
 * Цена ресурса в базисном уровне (01.01.2022) и индекс к текущему уровню — для колонок 8 и 9 формы 421/пр.
 *
 * База ФСБЦ хранит цену ресурса на 01.01.2022; текущая цена зоны получена из ФСЦСР или индексом к ней. Индекс здесь — отношение
 * текущей цены к базисной, а не индекс письма Минстроя: письма по элементам затрат расчёт не применял. Ресурс без цены в базе
 * (поставка из сплит-формы) базисной цены не имеет — колонки остаются пустыми; ресурс без текущей цены идёт в базисном уровне,
 * индекс 1.
 *
 * Машина с известной оплатой звена (`machinistPay` > 0, ₽ за маш.-ч в текущем уровне, с повышающим коэффициентом): колонки
 * относятся к тому же числу, что печатается в строке ЭМ формы 421/пр, — к цене БЕЗ оплаты машинистов. Цена базы ФСБЦ полная, и из
 * неё вычитается оплата звена базы 2022 (814,35 − 336,43 = 477,92 — «сметная цена» сплит-формы в уровне 01.01.2022); от `unitPrice`
 * вычитается `machinistPay`. Тогда отношение цен — рост цены машины без зарплаты, а не смесь полной цены с неполной. Без звена
 * (`machinistPay` = 0) цена ресурса остаётся как есть.
 */
function baseLevelOf(
  code: string,
  source: ResourceLineSource,
  unitPrice: number,
  priceBook: EstimatePriceBook,
  machinistPay = 0,
): { baseUnitPrice?: number; index?: number } {
  const current = roundTo(unitPrice - machinistPay, 2);
  if (source === "BASE_2022") return isPriced(current) ? { baseUnitPrice: current, index: 1 } : {};
  if (source !== "CURRENT_ZONE" && source !== "SPLIT_INDEXED" && source !== "BASE_2022_INDEXED") return {};
  const baseRecord = priceBook.base.get(code);
  if (baseRecord === undefined) return {};
  const base = roundTo(baseRecord.price - (machinistPay > 0 ? (baseRecord.machinistSalary ?? 0) : 0), 2);
  if (!isPriced(base) || !isPriced(current)) return {};
  return { baseUnitPrice: base, index: roundTo(current / base, 4) };
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
  wageFactor: number,
): EstimateResourceLine {
  const scale = priceBook.wageScale;
  const wage = resolveWage(scale, resource.code);

  // Разряд есть — рабочий, разряда нет — специалист. Других вариантов в
  // выгрузке не встречается: коды труда делятся на разрядные («1-100-*»,
  // «2-100-*») и должностные («3-*»), и вторые не входят в тарифную сетку —
  // их ставка ищется в реестре по коду (`resolveWage` делает это сам).
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

  // Повышенный размер оплаты труда (421/пр, таблицы 2, 4, 6, 8) — множитель ставки.
  const salary = wageFactor === 1 ? wage.salary : roundTo(wage.salary * wageFactor, 2);
  const cost = roundTo(totalQuantity * salary, 2);
  accumulator.labourHoursPriced += totalQuantity;
  accumulator.labourCost += cost;

  return {
    code: resource.code,
    name,
    unit: "чел.-ч",
    quantity: totalQuantity,
    unitPrice: salary,
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
    const have = scale.specialists === undefined || scale.specialists.length === 0;
    return (
      `${describeWageScale(scale)} не покрывает код ${code}: так в выгрузке записан труд ` +
      "специалистов — техников и инженеров, у которых нет разряда, " +
      (have
        ? "а ставки специалистов в шкале зоны не загружены (реестр ставок собран не целиком)"
        : "а записи с таким кодом в реестре ставок зоны нет")
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
  /**
   * Оплата труда звена машинистов, ₽ за маш.-ч. Входит в `unitPrice`: для машины это ПОЛНАЯ
   * стоимость маш.-ч с оплатой звена, как у цены базы ФСБЦ-2022. Цена ФГИС ЦС (текущая цена
   * зоны, сплит-форма) приходит без оплаты машинистов — `resolvePrice` прибавляет её здесь,
   * один раз, и дальше по расчёту разницы между источниками нет.
   */
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
  operatorRows: boolean,
  /**
   * Прибавлять ли к цене маш.-ч ФГИС ЦС оплату труда звена. Да — машина в норме (работа машины). Нет — позиция-поставка
   * (`computeResourceLine`): это покупка по цене справочника, а не работа с машинистами, и ОТм в ней не появляется.
   */
  addCrewPay = true,
): PricedResource {
  const current = priceBook.current.get(code);
  const base = priceBook.base.get(code);
  const currentIsZero = current !== undefined && !isPriced(current.price);

  if (current !== undefined && !currentIsZero) {
    /*
      Текущая цена машины из ФГИС ЦС — «Сметная цена, руб./маш.-ч» БЕЗ оплаты труда машинистов; оплата
      звена опубликована отдельной колонкой (`current.machinistSalary`). Полная стоимость маш.-ч — их
      сумма, как и цена маш.-ч базы ФСБЦ. Не прибавить значило бы выбросить ОТм из прямых затрат
      (на земляных работах и демонтаже это до пятой части), хотя НР и СП от неё начислены.
      Оплата null — в выгрузке её нет (сплит-форма, машины вне базы): берём из базы 2022, иначе пометка.
    */
    const crewPay =
      kind === "MACHINE" && addCrewPay
        ? current.machinistSalary ?? machinistPayFromBase(code, base, priceBook, parameters, normRef, gaps)
        : 0;
    return {
      unitPrice: kind === "MACHINE" && addCrewPay ? roundTo(current.price + crewPay, 2) : current.price,
      // Цена книги, полученная индексом к группе ресурсов, — «по индексу сплит-формы», не измеренная.
      source: current.source === "BASE_2022_INDEXED" ? "SPLIT_INDEXED" : "CURRENT_ZONE",
      name: current.name.length > 0 ? current.name : code,
      machinistSalary: crewPay,
      machinistCrew: current.machinistHours,
    };
  }

  /*
    Вторая ступень: «все цены сплит-формы». В книге зоны остались только ресурсы из норм,
    а поставка, которой в нормах нет (ПГС отдельной позицией), в ней отсутствует, хотя в
    сплит-форме у неё есть цена. Машину в норме со строками машинистов не берём: цена в
    «всех ценах» без оплаты звена, а ОТм в сплит-форме отдельной колонкой не публикуется; по
    базе 2022 цена такой машины пересчитывается целиком, вместе с оплатой звена.
    Машина вне нормы со строками машинистов (поставка отдельной позицией) — цена из «всех цен»
    тоже без ОТм: оплата звена берётся из базы 2022 индексом труда машинистов, нет базы или
    индекса — цена остаётся без неё, и это видно в пометке MACHINIST_PAY_UNKNOWN.
  */
  const split = kind === "MACHINE" && operatorRows ? undefined : priceBook.splitAll?.get(code);
  if (split !== undefined && isPriced(split.price)) {
    const splitName = (base?.name ?? "").length > 0 ? (base?.name as string) : code;
    const crewPay = kind === "MACHINE" && addCrewPay ? machinistPayFromBase(code, base, priceBook, parameters, normRef, gaps) : 0;
    const splitUnitPrice = roundTo(split.price + crewPay, 2);
    if (!split.indexed) {
      return {
        unitPrice: splitUnitPrice,
        source: "CURRENT_ZONE",
        name: splitName,
        machinistSalary: crewPay,
        machinistCrew: base?.machinistHours ?? null,
      };
    }
    gaps.push({
      kind: "INDEXED_PRICE",
      message: `Для ресурса ${code} в норме ${normLabel(normRef)} взята цена по индексу сплит-формы ФГИС ЦС зоны «${priceBook.priceZone}» за ${priceBook.period}: ${formatMoney(split.price)} ₽ — текущий уровень, получен индексом к группе однородных ресурсов, а не измерен по зоне`,
      code: normRef.code,
      baseType: normRef.baseType,
    });
    return {
      unitPrice: splitUnitPrice,
      source: "SPLIT_INDEXED",
      name: splitName,
      machinistSalary: crewPay,
      machinistCrew: base?.machinistHours ?? null,
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

/**
 * Оплата труда звена машинистов машины, цена которой пришла из ФГИС ЦС без неё и без отдельной
 * колонки ОТм (сплит-форма, «все цены»; машина вне выгрузки ФСЦСР зоны), ₽ за маш.-ч.
 *
 * Берётся из базы ФСБЦ-2022 и пересчитывается индексом труда машинистов — тем же, которым
 * `resolvePrice` пересчитывает оплату звена у машины, взятой по базе. Выводить её из цены
 * нельзя: оплата — доля непостоянная (у 91.14.02-001 она больше цены без оплаты).
 *
 * Звено в базе нулевое (`machinistSalary` = 0) — машина работает без машинистов, оплаты нет, и
 * пометка не нужна. Базы нет, оплата в ней не задана или нет индекса — оплату определить нечем:
 * возвращается 0 и добавляется MACHINIST_PAY_UNKNOWN, а не придуманное число; прямые затраты
 * и ФОТ по такой машине занижены на ОТм, и пользователь это видит.
 */
function machinistPayFromBase(
  code: string,
  base: ResourcePrice | undefined,
  priceBook: EstimatePriceBook,
  parameters: EstimateParameters,
  normRef: NormRef,
  gaps: EstimateGap[],
): number {
  const baseSalary = base?.machinistSalary ?? null;
  if (baseSalary === 0) return 0;
  const index = parameters.indices?.machinistLabour;
  if (baseSalary !== null && index !== undefined) return roundTo(baseSalary * index, 2);

  gaps.push({
    kind: "MACHINIST_PAY_UNKNOWN",
    message:
      `У машины ${code} в норме ${normLabel(normRef)} цена ФГИС ЦС зоны «${priceBook.priceZone}» за ${priceBook.period} — без оплаты труда машинистов, ` +
      (baseSalary === null
        ? `а оплаты звена этой машины нет и в базе ${priceBook.baseEdition}`
        : `а индекс труда машинистов для пересчёта оплаты звена из базы ${priceBook.baseEdition} (${formatMoney(baseSalary)} ₽ за маш.-ч) не задан`) +
      " — ОТм в стоимость маш.-ч и в ФОТ не включена, прямые затраты и начисления НР и СП занижены",
    code: normRef.code,
    baseType: normRef.baseType,
  });
  return 0;
}

/** Индекс по элементу затрат: для машин — свой, для материалов — свой. */
function indexFor(kind: NormResource["kind"], parameters: EstimateParameters): number | null {
  if (parameters.indices === null) return null;
  if (kind === "MACHINE") return parameters.indices.machines;
  return parameters.indices.materials;
}

/** Название «книги» строки, посчитанной по цене заказчика: стоит там, где у остальных ГЭСН. */
export const CUSTOMER_PRICE_BOOK = "Цена заказчика";

/**
 * Строка по цене заказчика: запасной вариант, когда нашей нормы или цены нет.
 *
 * Вся стоимость лежит в прямых затратах: сумма заказчика — «Всего по позиции» с
 * его накладными и прибылью внутри, разложить её нечем, а начислять НР и СП
 * поверх значило бы посчитать их дважды. Ресурсов у строки нет, и это видно:
 * пометка в самой строке, пробел `CUSTOMER_PRICE` в списке и доля в допущениях.
 */
export function customerPriceLine(
  item: BillOfWorkItem,
  reason: string,
): { line: EstimateLine; gap: EstimateGap } | null {
  const price = item.customerPrice;
  if (price == null || !(price.total > 0) || !(item.quantity > 0)) return null;

  const total = roundTo(price.total, 2);
  const code = item.normCodeHint?.code ?? item.resourceCode ?? "—";
  const gap: EstimateGap = {
    kind: "CUSTOMER_PRICE",
    message: `«${item.workName}»: по цене заказчика ${formatMoney(total)} ₽ — не проверено нашими ценами (${reason})`,
    code: code === "—" ? null : code,
    baseType: CUSTOMER_PRICE_BOOK,
    billSection: item.billSection,
  };
  const line: EstimateLine = {
    itemId: item.id,
    normCode: code,
    normBaseType: CUSTOMER_PRICE_BOOK,
    normName: item.workName,
    normUnit: item.quantityUnit,
    quantity: item.quantity,
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
    materialCost: 0,
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
    resources: [],
    gaps: [gap],
    priceSource: "CUSTOMER_PRICE",
  };
  return { line, gap };
}

/** Название «книги» строки, посчитанной по своей цене: стоит там, где у остальных ГЭСН. */
export const OWN_PRICE_BOOK = "Своя цена";

/**
 * Строка по цене за единицу, которую назвал человек: объём × цена.
 *
 * НР и СП не начисляются — как у цены заказчика: названная цена готовая, и начислять поверх
 * неё накладные значило бы посчитать их дважды; ФОТ у строки нет, база начислений нулевая.
 * От цены заказчика отличается тем, что это не допущение расчёта: пробела нет, в долю допущений
 * строка не входит — цену назвал человек и отвечает за неё сам. Видна она в самой строке
 * (`priceSource`) и в расшифровке (одна ресурсная строка «своя цена»), чтобы арифметика
 * «объём × цена = прямые затраты» проверялась так же, как у любой другой позиции.
 */
export function ownPriceLine(item: BillOfWorkItem): EstimateLine | null {
  const price = item.ownUnitPrice;
  if (price == null || !(price > 0) || !(item.quantity > 0)) return null;

  const unitPrice = roundTo(price, 2);
  const total = roundTo(unitPrice * item.quantity, 2);
  const resource: EstimateResourceLine = {
    code: "—",
    name: `Своя цена за ${item.quantityUnit}, без НДС`,
    unit: item.quantityUnit,
    quantity: roundTo(item.quantity, 6),
    unitPrice,
    total,
    source: "OWN_PRICE",
    kind: "MATERIAL",
    wageOrigin: null,
  };
  return {
    itemId: item.id,
    normCode: "—",
    normBaseType: OWN_PRICE_BOOK,
    normName: item.workName,
    normUnit: item.quantityUnit,
    quantity: roundTo(item.quantity, 6),
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
    resources: [resource],
    gaps: [],
    priceSource: "OWN_PRICE",
    priceNote: `Своя цена ${formatMoney(unitPrice)} ₽ за ${item.quantityUnit} без НДС — указана вручную`,
  };
}

/** «Книга» строки перевозки: стоит там, где у остальных ГЭСН. */
export const TRANSPORT_PRICE_BOOK = "ФГИС ЦС перевозка";
/** «Книга» строки погрузки и разгрузки. */
export const LOAD_PRICE_BOOK = "ФГИС ЦС ПРР";

/**
 * Строка по сметной цене услуги автотранспорта из таблиц ФГИС ЦС: объём (т) × цена за тонну.
 *
 * НР и СП не начисляются: цена услуги — это стоимость перевозки или погрузки целиком, как и в
 * смете заказчика по Методике 421/пр, у которой на такие строки нет ни ФОТ, ни нормативов.
 * Источник написан в самой строке (`priceNote`) и в расшифровке ресурса, пробела (`gaps`) нет:
 * это не допущение, а цена из открытых данных.
 */
export function serviceLine(item: BillOfWorkItem, price: ServicePrice, priceBook: EstimatePriceBook): EstimateLine {
  const isTransport = price.kind === "TRANSPORT";
  const total = roundTo(price.price * item.quantity, 2);
  const book = isTransport ? TRANSPORT_PRICE_BOOK : LOAD_PRICE_BOOK;
  const what = isTransport ? "перевозку" : "погрузочно-разгрузочные работы";
  const resource: EstimateResourceLine = {
    code: price.code,
    name: price.description,
    unit: "т",
    quantity: roundTo(item.quantity, 6),
    unitPrice: price.price,
    total,
    source: "FGIS_SERVICE",
    kind: "MATERIAL",
    wageOrigin: null,
  };
  return {
    itemId: item.id,
    normCode: price.code,
    normBaseType: book,
    normName: item.workName,
    normUnit: "т",
    quantity: roundTo(item.quantity, 6),
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
    resources: [resource],
    gaps: [],
    priceSource: "FGIS_SERVICE",
    priceNote: `ФГИС ЦС, сметные цены на ${what}, ${priceBook.priceZone}, ${priceBook.period}, код ${price.code}`,
  };
}

/** Причина, по которой нашей строки нет, — первая из пробелов позиции, одной фразой. */
function failureReason(gaps: readonly EstimateGap[]): string {
  const first = gaps.find((gap) => gap.kind !== "CUSTOMER_PRICE");
  if (first === undefined) return "нашей цены нет";
  return `нашей нормы нет: ${first.message.replace(/ — позиция в расчёт не вошла$| — стоимость не рассчитана$/, "")}`;
}

/**
 * Строка-исключение: все суммы, часы и объёмы со знаком минус, цены за единицу — как есть.
 * Арифметика строки сохраняется: сумма ресурсов равна прямым затратам, а накладные и прибыль
 * равны проценту от (отрицательного) фонда оплаты труда.
 */
export function negateLine(line: EstimateLine): EstimateLine {
  const flip = (value: number): number => (value === 0 ? 0 : -value);
  return {
    ...line,
    quantity: flip(line.quantity),
    billQuantity: flip(line.billQuantity),
    labourHours: flip(line.labourHours),
    specialistHours: flip(line.specialistHours),
    labourCost: flip(line.labourCost),
    machinistHours: flip(line.machinistHours),
    machinistSalaryCost: flip(line.machinistSalaryCost),
    machineHours: flip(line.machineHours),
    machineCost: flip(line.machineCost),
    materialCost: flip(line.materialCost),
    directCost: flip(line.directCost),
    wageFund: flip(line.wageFund),
    overheadCost: flip(line.overheadCost),
    profitCost: flip(line.profitCost),
    resources: line.resources.map((resource) => ({
      ...resource,
      quantity: flip(resource.quantity),
      total: flip(resource.total),
      ...(resource.machinistPayTotal === undefined ? {} : { machinistPayTotal: flip(resource.machinistPayTotal) }),
    })),
    deduction: true,
  };
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

  /*
    Одна позиция ведомости → строка (или пробел) сметы. Вынесено в функцию, чтобы после любого из путей
    расчёта — норма, поставка, услуга, цена заказчика — строку-исключение можно было развернуть в минус.
  */
  // Материалы нашей нормы по главным позициям (до знака исключения): по ним строка-остаток узнаёт, что материал уже оценён нормой.
  const normMaterials = new Map<string, number>();

  const processItem = (original: BillOfWorkItem): void => {
    let item = original;
    /*
      Строка-остаток ЛСР («материалы заказчика сверх его напечатанных строк») и материалы нашей нормы: если норма главной позиции уже
      оценила материалы выше «М» заказчика, этот избыток — тот же материал (труба, которую норма оценила, а заказчик вынес за строки), и
      остаток добавляется только сверх него. Без этого материал считался дважды (закупка 0891200000626010037, ГЭСН22-01-011-02: +479 679 ₽).
    */
    let residualNote: string | null = null;
    if (item.unaccountedOf !== undefined && item.customerPrintedMaterials !== undefined && item.customerPrice != null) {
      const ours = normMaterials.get(item.unaccountedOf);
      const remainder = item.customerPrice.total;
      if (ours !== undefined && remainder > 0) {
        const covered = Math.min(remainder, Math.max(0, ours - item.customerPrintedMaterials));
        if (covered > 0) {
          // Остаток в пределах рубля — округление, а не материал: строка не нужна.
          const added = remainder - covered > 1 ? roundTo(remainder - covered, 2) : 0;
          residualNote = `остаток заказчика ${formatMoney(remainder)} ₽, из них ${formatMoney(roundTo(covered, 2))} ₽ уже в материалах нормы (наши материалы ${formatMoney(ours)} ₽ при «М» заказчика ${formatMoney(item.customerPrintedMaterials)} ₽) — добавлено ${formatMoney(added)} ₽`;
          if (added === 0) {
            gaps.push({
              kind: "CUSTOMER_PRICE",
              message: `«${item.workName}»: ${residualNote}; строка не нужна`,
              code: null,
              baseType: CUSTOMER_PRICE_BOOK,
              billSection: item.billSection,
            });
            return;
          }
          item = { ...item, customerPrice: { ...item.customerPrice, total: added, unitPrice: added } };
        }
      }
    }

    /*
      Своя цена человека важнее всего остального: он назвал цену за единицу вместо цены по норме,
      и ни норму, ни цену справочника, ни цену заказчика для такой позиции искать не нужно.
    */
    const own = ownPriceLine(item);
    if (own !== null) {
      lines.push(own);
      return;
    }

    /*
      Строка, добавленная расчётом (`BillOfWorkItem.generated`), у которой цены нет по построению: мусор без расстояния до полигона или без тарифа
      полигона. Ни нормы, ни цены заказчика у неё быть не может, поиск по наименованию ей не нужен; пробел называет причину словами. Цену или норму
      назовёт человек (правка «своя цена» или «норма») — тогда этот путь не берётся.
    */
    if (item.generatedUnpricedReason !== undefined && item.normCode === null && item.normCodeHint == null && item.resourceCode === null) {
      gaps.push({
        kind: "NO_NORM",
        message: `Позиция «${item.workName}», добавленная расчётом: ${item.generatedUnpricedReason} — стоимость не рассчитана`,
        code: null,
        baseType: null,
        billSection: item.billSection,
      });
      return;
    }

    /*
      Поставка не идёт в подбор расценки. Документ уже сказал, что это ресурс,
      а не работа, и искать для неё норму незачем: поиск по наименованию
      «Металлоконструкции … сталь С255» найдёт монтаж металлоконструкций и
      принесёт оттуда чужие труд и машины. На смете 02-01-02-КМ1 так и вышло —
      1 000,72 чел.-ч вместо 601,21.
    */
    if (item.resourceCode !== null) {
      const outcome = computeResourceLine(item, priceBook, parameters);
      // Цены нет вовсе (строка без денег) — как и нет строки: у заказчика цена есть.
      const empty = outcome.line === null || outcome.line.directCost === 0;
      const fallback = empty ? customerPriceLine(item, failureReason(outcome.gaps)) : null;
      if (fallback !== null) {
        lines.push(fallback.line);
        gaps.push(fallback.gap);
        return;
      }
      gaps.push(...outcome.gaps);
      if (outcome.line !== null) lines.push(outcome.line);
      return;
    }

    /*
      Материал (поставка), которому ресурс не подобран: норму работы не ищем. «Задвижка клиновая …» с нормой монтажа ГЭСНм посчитала бы
      монтаж второй раз — он уже стоит отдельной строкой. Есть цена заказчика — позиция входит по ней с пометкой; нет — пробел «нет цены».
      Норму назвал человек или документ (`normCode`, `normCodeHint`) — тогда это уже не поставка, и позиция идёт обычным путём.
    */
    if (item.materialRow !== undefined && item.normCode === null && item.normCodeHint == null) {
      const priced = customerPriceLine(item, `позиция — материал (${item.materialRow.reason}): ресурс в справочнике цен не подобран, нормы для материала не ищутся`);
      if (priced !== null) {
        lines.push(priced.line);
        gaps.push(priced.gap);
      } else {
        gaps.push(noMaterialPriceGap(item));
      }
      return;
    }

    /*
      Позиция по ТЦ, КП или прайс-листу: оборудование и материалы по предложению поставщика. Нормы у неё
      нет, поэтому поиск по наименованию не запускается — он находит «похожую» работу и считает вместо
      оборудования её труд (`BillOfWorkItem.customerPriceOnly`). Цена заказчика есть — позиция входит по
      ней и помечена допущением; цены нет — «норма не найдена», а не чужая норма.
    */
    if (item.customerPriceOnly === true) {
      const priced = customerPriceLine(
        item,
        residualNote !== null
          ? `невидимый остаток позиции ЛСР: ${residualNote}`
          : "позиция по цене заказчика (ТЦ, КП, прайс-лист): оборудование или материал по предложению поставщика, нормы и ресурса в справочниках у неё нет",
      );
      if (priced !== null) {
        lines.push(residualNote === null ? priced.line : { ...priced.line, priceNote: residualNote });
        gaps.push(priced.gap);
      } else {
        gaps.push(noNormGap(item));
      }
      return;
    }

    /*
      Перевозка и погрузка автотранспортом — по сметным ценам услуг зоны, а не по расценке и не
      по цене заказчика. Шифр расценки ГЭСН в строке (явный выбор нормы) важнее: услуга ищется
      для строк без него. Нет таблицы зоны (старая сборка) — путь пропускается целиком.
    */
    let serviceMiss: string | null = null;
    const withoutNormCode = item.normCode === null && item.normCodeHint == null;
    const serviceLike = withoutNormCode && isServiceItem(item);
    if (withoutNormCode && hasAutoServices(priceBook.services)) {
      const looked = resolveServicePrice(priceBook.services, {
        serviceCode: item.serviceCode ?? null,
        workName: item.workName,
        quantityUnit: item.quantityUnit,
        quantity: item.quantity,
      });
      if (looked !== null && looked.ok) {
        lines.push(serviceLine(item, looked.price, priceBook));
        return;
      }
      // Шифр в документе есть, а цены нет: причина попадёт в пометку «по цене заказчика».
      if (looked !== null && item.serviceCode != null) {
        serviceMiss = `нашей цены услуги ${item.serviceCode} нет: ${looked.reason}`;
      } else if (looked !== null && serviceLike) {
        serviceMiss = `нашей цены услуги нет: ${looked.reason}`;
      }
    }

    /*
      Перевозка и погрузка-разгрузка — услуги по сметным ценам, а не работы: к расценке ГЭСН по наименованию они не подбираются никогда.
      Поиск по наименованию находил «Погрузку и выгрузку вручную: …» и считал её труд вместо цены услуги (закупка 32616401076, «03-1
      Погрузка в автотранспортное средство: изделия из сборного железобетона», 75,8 т: 184 790 ₽ против 30 714,92 ₽ заказчика). Цены
      ФГИС ЦС не нашлось — позиция входит по цене заказчика с пометкой; и её нет — «норма не найдена», а не чужая расценка.
    */
    if (serviceLike) {
      const priced = customerPriceLine(
        item,
        serviceMiss ?? "перевозка или погрузка по сметной цене: цены услуги в таблицах зоны нет, а к расценке ГЭСН по наименованию такая строка не подбирается",
      );
      if (priced !== null) {
        lines.push(priced.line);
        gaps.push(priced.gap);
      } else {
        gaps.push(noNormGap(item));
      }
      return;
    }

    const resolution = resolveNorm(item);
    const outcome =
      resolution === null
        ? { line: null, gaps: [noNormGap(item)] }
        : computeEstimateLine(item, resolution, priceBook, parameters);
    // Нашей нормы нет, единица не сошлась или цены нет — позиция входит по цене заказчика, а не выпадает.
    const fallback =
      outcome.line === null
        ? customerPriceLine(item, serviceMiss ?? failureReason(outcome.gaps))
        : null;
    if (fallback !== null) {
      lines.push(fallback.line);
      gaps.push(fallback.gap);
      return;
    }
    gaps.push(...outcome.gaps);
    if (outcome.line !== null) lines.push(outcome.line);
  };

  for (const item of section.items) {
    const start = lines.length;
    processItem(item);
    // Материалы нормы главной позиции — для строки-остатка, которая идёт следом (до смены знака у исключения).
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index] as EstimateLine;
      if (line.itemId === item.id && line.priceSource === undefined) normMaterials.set(item.id, line.materialCost);
    }
    // Исключение (отрицательный объём в смете заказчика): строка посчитана как обычно, знак — минус.
    if (item.deduction === true) {
      for (let index = start; index < lines.length; index += 1) {
        lines[index] = negateLine(lines[index] as EstimateLine);
      }
    }
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

  // Нормативы сверх норм: зимнее и временные (посчитаны заранее) и условия работ (по строкам сметы).
  const allLines = sections.flatMap((section) => section.lines);
  const appliedNormatives = [
    ...(request.appliedNormatives ?? []),
    ...describeWorkConditions(request.parameters.workConditions, allLines),
  ];
  for (const normative of appliedNormatives) {
    if (!normative.applied && normative.missingData === true) {
      gaps.push({
        kind: "NORMATIVE_NOT_APPLIED",
        message: `${normative.title}: ${normative.reason ?? "норматив не начислен"}`,
        code: null,
        baseType: null,
      });
    }
  }

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
    ...(request.priceZoneChoice === undefined ? {} : { priceZoneChoice: request.priceZoneChoice }),
    ...(appliedNormatives.length === 0 ? {} : { appliedNormatives }),
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

  const customerLines = lines.filter((line) => line.priceSource === "CUSTOMER_PRICE");
  const customerPriced = roundTo(
    sum(customerLines, (line) => line.directCost + line.overheadCost + line.profitCost),
    2,
  );

  const ownLines = lines.filter((line) => line.priceSource === "OWN_PRICE");
  const ownPriced = roundTo(
    sum(ownLines, (line) => line.directCost + line.overheadCost + line.profitCost),
    2,
  );

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
    ...(customerLines.length === 0
      ? {}
      : { customerPriced, customerPricedCount: customerLines.length }),
    ...(ownLines.length === 0 ? {} : { ownPriced, ownPricedCount: ownLines.length }),
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
export function dedupeGaps(gaps: readonly EstimateGap[]): EstimateGap[] {
  const seen = new Set<string>();
  const result: EstimateGap[] = [];
  for (const gap of gaps) {
    // Раздел входит в ключ: одинаковое сообщение в разных разделах — разные пробелы,
    // иначе число выпавших позиций раздела занижалось бы склейкой.
    const key = `${gap.kind}|${gap.baseType}|${gap.code}|${gap.billSection ?? ""}|${gap.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(gap);
  }
  return result;
}
