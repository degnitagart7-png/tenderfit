/**
 * Демонстрационный прогон: полноценная смета по ведомости объёмов работ.
 *
 * Скрипт собирает документ из локального индекса открытых данных ФГИС ЦС и
 * печатает его — на экран коротко, в `docs/samples` подробно, с расшифровкой
 * каждого ресурса. К продукту он не подключён: ни API-роут, ни экран его не
 * вызывают, и пока это так и задумано.
 *
 * Зачем он нужен отдельно от расчёта. Домен (`src/domain/estimate`) чист и не
 * читает ни индекса, ни цен: всё приходит через `EstimateRequest`. Значит,
 * проверить, что смета действительно получается из настоящих 56 242 норм и
 * настоящих цен, можно только прогоном сверху донизу — этот скрипт и есть такой
 * прогон. Он делает четыре вещи, которые в тестах не проверить: грузит собранный
 * индекс, подбирает нормы поиском по наименованию работы, считает документ и
 * прогоняет его через Zod-схему и независимую сверку арифметики.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/demo-estimate.ts
 *   npx tsx scripts/fsnb/demo-estimate.ts --probe
 *   npx tsx scripts/fsnb/demo-estimate.ts --find "Кладка стен из кирпича" --book ГЭСН
 *   npx tsx scripts/fsnb/demo-estimate.ts --indices 1,1,1 --winter 0 --temporary 0
 *
 * Режимы: без флагов — полный расчёт и отчёт; `--probe` — только подбор норм
 * под ведомость; `--find` — справочный поиск нормы по наименованию без расчёта.
 *
 * Норму назначает человек, а не поиск, и это не осторожность, а измерение. Прогон
 * по ведомости из 16 позиций показал: у семи позиций лучший балл был 10 и выше, и
 * все семь привели в верную таблицу; из девяти позиций с баллом ниже 10 шесть
 * получили первым кандидатом норму не из той таблицы — вместо котлована подводную
 * разработку грунта, вместо кирпичной кладки облицовку плитками, вместо кровли из
 * профлиста несъёмную опалубку, вместо окон из ПВХ окна из алюминиевых сплавов,
 * вместо прокладки кабеля соединительные муфты. Но и верная таблица не даёт верной
 * строки: строки внутри неё различаются толщиной слоя, диаметром трубы, числом
 * створок, объёмом котлована и видом покрытия, а в наименовании работы этого нет.
 * Поэтому поиск сужает до таблицы, строку выбирает человек — и отчёт показывает
 * оба шага. Полностью автоматически подобранными остались пять позиций из
 * шестнадцати, и то потому, что в их наименования внесены различающие детали.
 *
 * Чего в открытых данных нет и поэтому введено вручную (всё перечислено и в
 * печатном отчёте): нормативы накладных расходов и сметной прибыли (приказы
 * Минстроя № 812/пр и № 774/пр опубликованы только в PDF), индексы пересчёта к
 * текущему уровню цен (письма Минстроя, тоже PDF), нормативы ГСН 81-05-01 и
 * 81-05-02 на временные здания и зимнее удорожание. Норма при этом сама несёт
 * указатели `Пр/812-…` и `Пр/774-…` — скрипт их печатает, чтобы процент можно
 * было сверить с первоисточником, а не взять на веру.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  auditEstimateArithmetic,
  parseEstimateDocument,
} from "../../src/domain/estimate/schema";
import { computeAssurance } from "../../src/domain/estimate/assurance";
import type { EstimateAssurance } from "../../src/domain/estimate/assurance";
import {
  toBillOfWorkCsv,
  toLocalEstimateCsv,
} from "../../src/domain/estimate/export";
import { toLocalEstimateFormCsv } from "../../src/domain/estimate/exportForm";
import { buildEstimate } from "../../src/domain/estimate/calculate";
import type { NormResolver } from "../../src/domain/estimate/calculate";
import { findNorms } from "../../src/domain/estimate/matchNorms";
import type {
  NormMatch,
  NormSearchIndex,
} from "../../src/domain/estimate/matchNorms";
import type {
  BillOfWorkItem,
  BillOfWorkSection,
  EstimateDocument,
  EstimateGap,
  EstimateGapKind,
  EstimateParameters,
  EstimateResourceLine,
  IndexSet,
} from "../../src/domain/estimate/types";
import {
  BUILD_COMMAND,
  EstimateBaseUnavailableError,
  currentPriceCoverageNote,
  loadEstimateBase,
} from "../../src/repositories/estimateBaseRepository";
import type {
  EstimateBase,
  EstimateBaseInfo,
} from "../../src/repositories/estimateBaseRepository";
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
} from "../../src/utils/format";

/** Каталог, куда кладётся подробный отчёт. */
const SAMPLE_PATH = "docs/samples/estimate-601801-drsks.md";

/** Сколько кандидатов показывать рядом с выбранной нормой. */
const ALTERNATIVES = 2;

/**
 * Закупка настоящая, объёмы работ — нет.
 *
 * Лот взят из разбора, который уже обсуждался: строительство
 * административно-бытового корпуса и гаражей на базе Февральского СУ филиала
 * «Амурские электрические сети». Регион совпадает с единственной ценовой зоной,
 * по которой в индексе есть текущие цены ФСЦСР, поэтому расчёт получается
 * честным, а не собранным из базы 2022 года целиком.
 *
 * Документация закупки при этом не разобрана: OCR и распаковка rar/7z в проекте
 * не реализованы, взять из неё ведомость объёмов работ неоткуда. Ниже — пример
 * ведомости, составленный для демонстрации расчёта. Каждое число в ней условно,
 * и отчёт это говорит прямо, а не намекает.
 */
const LOT = {
  number: "601801-КС ПИР СМР-2026-ДРСК-АЭС",
  okpd2: "41.20.40",
  title:
    "Выполнение работ по строительству административно-бытового корпуса и гаражей " +
    "на базе Февральского СУ, филиала «Амурские электрические сети» для нужд АО «ДРСК»",
} as const;

const BILL_NOTE =
  "Ведомость составлена как пример для демонстрации расчёта: документация закупки " +
  "не разбиралась (OCR и распаковка архивов в проекте не реализованы), поэтому " +
  "объёмы работ условны и не имеют отношения к реальной стоимости этого лота.";

/**
 * Пометка, которая печатается в каждом отчёте рядом с итогом.
 *
 * Общая `DISCLAIMER` из `src/lib/labels.ts` не подходит: она про оценку
 * соответствия закупки профилю компании. Здесь другой предмет — числа, которые
 * можно отнести заказчику, поэтому оговорка обязана называть, что именно в них
 * не посчитано.
 */
const DISCLAIMER =
  "Расчёт носит информационно-аналитический характер и не является сметной документацией. " +
  "Стоимость определена ресурсно-индексным методом по открытым данным ФГИС ЦС. " +
  "Позиция, под которую норма в ФСНБ-2022 не найдена, в итог не входит. Ресурс, цены на " +
  "который в справочниках нет, входит нулём. Ресурс без текущей цены по ценовой зоне входит " +
  "в уровне 01.01.2022. Ресурс, указанный в норме без конкретной марки — группой по " +
  "классификатору, — в итог не входит вовсе: его стоимость выбирает проект. Все четыре " +
  "случая перечислены в разделе «Пробелы». Нормативы накладных расходов и сметной прибыли взяты " +
  "по видам работ из приказов Минстроя 812/пр и 774/пр, текущие цены и индексы к группам " +
  "однородных ресурсов — из сплит-формы ФГИС ЦС. Лимитированные затраты введены вручную. " +
  "Для экспертизы и договора смету составляет и подписывает аттестованный сметчик.";

/**
 * Норма, назначенная человеком, и причина, по которой подбор поиском не оставили.
 *
 * `note` обязателен. Переопределение без объяснения неотличимо от опечатки в коде
 * нормы, а отчёт печатает рядом и то, что предложил поиск, и то, что назначил
 * человек: читатель должен видеть, от чего отказались и почему.
 */
interface NormConfirmation {
  readonly baseType: string;
  readonly code: string;
  readonly note: string;
}

/** Позиция ведомости: наименование, объём, единица и делитель до единицы нормы. */
interface BillDraft {
  readonly id: string;
  readonly workName: string;
  readonly quantity: number;
  readonly quantityUnit: string;
  readonly unitDivisor: number;
  /** null — норму подбирает поиск; иначе она назначена кодом и книгой. */
  readonly confirmed: NormConfirmation | null;
}

function draft(
  id: string,
  workName: string,
  quantity: number,
  quantityUnit: string,
  unitDivisor: number,
  confirmed: NormConfirmation | null = null,
): BillDraft {
  return { id, workName, quantity, quantityUnit, unitDivisor, confirmed };
}

/**
 * Пример ведомости объёмов работ: 16 позиций в 4 разделах.
 *
 * Наименования оставлены так, как их пишет проектировщик, а не так, как звучит
 * норма, — иначе подбор поиском не проверяется, а только изображается.
 *
 * Делитель единицы подобран под то, в чём норма измеряется в выгрузке ФГИС ЦС:
 * земляные работы идут в «1000 м3», отделка и кровля в «100 м2», плиты перекрытий
 * и радиаторы в «100 шт», асфальтобетонное покрытие в «1000 м2». Если делитель
 * расходится с единицей найденной нормы, расчёт сообщает UNIT_MISMATCH, а не
 * угадывает, — это и есть причина, по которой он задан здесь явно.
 *
 * Ручных назначений одиннадцать из шестнадцати, и это результат прогона, а не
 * перестраховка: измерения приведены в шапке файла. Коротко — поиск доводит до
 * верной таблицы, когда в наименовании работы есть различающие детали, и уверенно
 * предлагает не ту таблицу, когда их нет. Строку внутри верной таблицы он не
 * выбирает никогда: строки различаются параметром, которого в названии работы нет.
 */
const BILL: readonly (readonly BillDraft[])[] = [
  [
    draft(
      "1",
      "Разработка грунта в отвал экскаватором одноковшовым, группа грунтов 2",
      850,
      "м3",
      1000,
      {
        baseType: "ГЭСН",
        code: "01-01-007-02",
        note:
          "Котлован на 850 м3 — это строка «объёмом до 1000 м3», а не «до 500 м3». " +
          "Группа грунтов 2 и ковш 0,5 (0,5–0,63) м3 приняты по условию примера.",
      },
    ),
    draft(
      "2",
      "Устройство песчаной подготовки под фундаменты с уплотнением",
      120,
      "м3",
      1,
      {
        baseType: "ГЭСН",
        code: "08-01-002-01",
        note:
          "Нужна норма сборника 08 «Устройство основания под фундаменты: песчаного». " +
          "Поиск ставит выше подушки под опоры мостов из сборника 30 — тот же песок, " +
          "но другой объект и другой сборник.",
      },
    ),
    draft("3", "Устройство бетонной подготовки под фундаменты", 45, "м3", 100),
    draft(
      "4",
      "Гидроизоляция стен фундаментов оклеечная в два слоя",
      310,
      "м2",
      100,
      {
        baseType: "ГЭСН",
        code: "08-01-003-05",
        note:
          "Таблицу поиск нашёл, но первым поставил строку «горизонтальная» с тем же баллом. " +
          "Стены фундамента изолируют сбоку, поэтому строка «боковая оклеечная … в 2 слоя».",
      },
    ),
  ],
  [
    draft(
      "5",
      "Кладка стен из кирпича керамического на цементном растворе",
      380,
      "м3",
      1,
      {
        baseType: "ГЭСН",
        code: "08-02-001-01",
        note:
          "Поиск первым даёт гладкую облицовку плитками из сборника 15: в наименовании " +
          "кирпичной нормы слово стоит в форме «кирпичных», а основа «кирпича» из запроса " +
          "с ней не совпадает. Стены наружные, кладка простая, высота этажа до 4 м.",
      },
    ),
    draft(
      "6",
      "Укладка плит перекрытий железобетонных многопустотных",
      24,
      "шт",
      100,
      {
        baseType: "ГЭСН",
        code: "07-01-006-06",
        note:
          "Единица нормы — «100 шт», а не «100 м2», поэтому объём переведён в штуки: " +
          "24 многопустотные плиты на перекрытие. Четыре строки таблицы набрали равный балл; " +
          "плита площадью более 5 м2 при наибольшей массе монтажных элементов до 5 т.",
      },
    ),
    draft("7", "Монтаж стальных конструкций каркаса гаража", 12, "т", 1),
    draft(
      "8",
      "Устройство кровли из профилированного стального листа",
      640,
      "м2",
      100,
      {
        baseType: "ГЭСН",
        code: "12-01-033-01",
        note:
          "Поиск первым даёт монтаж несъёмной опалубки сталебетонных перекрытий: там тоже " +
          "профилированный настил, но это не кровля. Кровля простая, объект непроизводственный.",
      },
    ),
  ],
  [
    draft(
      "9",
      "Штукатурка стен улучшенная по камню и бетону цементно-известковым раствором",
      1150,
      "м2",
      100,
    ),
    draft(
      "10",
      "Окраска стен улучшенная водно-дисперсионными составами",
      1150,
      "м2",
      100,
    ),
    draft(
      "11",
      "Установка оконных блоков из поливинилхлоридных профилей",
      96,
      "м2",
      100,
      {
        baseType: "ГЭСН",
        code: "10-01-034-05",
        note:
          "Первыми идут оконные блоки из алюминиевых профилей сборника 09; нужная норма " +
          "сборника 10 набирает столько же, но встаёт после. Блоки поворотно-откидные, " +
          "площадь проёма до 2 м2, двухстворчатые. ПВХ-окна в ФСНБ-2022 лежат в сборнике 10 " +
          "«Деревянные конструкции» — так сложилось в классификаторе, а не ошибка подбора.",
      },
    ),
    draft(
      "12",
      "Прокладка трубопроводов отопления из полипропиленовых труб наружным диаметром 25 мм",
      180,
      "м",
      100,
    ),
    draft(
      "13",
      "Установка радиаторов отопления стальных панельных с креплением к стене",
      42,
      "шт",
      100,
      {
        baseType: "ГЭСН",
        code: "18-03-008-01",
        note:
          "Восемь строк таблицы набрали равный балл: они различаются числом рядов и длиной. " +
          "Приняты однорядные длиной до 1600 мм. Единица нормы — «100 шт», делитель 100.",
      },
    ),
    draft(
      "14",
      "Прокладка кабеля силового с медными жилами по лоткам",
      640,
      "м",
      100,
      {
        baseType: "ГЭСНм",
        code: "08-02-147-01",
        note:
          "Поиск первым даёт соединительные муфты, а нормы прокладки кабеля в лучшие восемь " +
          "не попадают вовсе. Кабель до 35 кВ, масса 1 м до 1 кг, крепление на поворотах " +
          "и в конце трассы. Книга здесь ГЭСНм — монтаж, а не ГЭСН.",
      },
    ),
  ],
  [
    draft(
      "15",
      "Устройство асфальтобетонного покрытия проезда в два слоя",
      900,
      "м2",
      1000,
      {
        baseType: "ГЭСН",
        code: "27-06-039-01",
        note:
          "Шесть строк из двух разных сборников набрали равный балл. Проезд — автомобильная " +
          "дорога, а не аэродром, поэтому сборник 27; строка считает сразу оба слоя. " +
          "Единица нормы «1000 м2», делитель 1000.",
      },
    ),
    draft("16", "Установка бортовых камней бетонных", 320, "м", 100, {
      baseType: "ГЭСН",
      code: "27-02-010-02",
      note:
        "Четыре строки набрали равный балл, первая из них — «при цементобетонных покрытиях». " +
        "Покрытие проезда асфальтобетонное, значит строка «при других видах покрытий».",
    }),
  ],
];

const SECTION_TITLES = [
  "Земляные работы и фундаменты",
  "Каркас, стены и кровля",
  "Отделка и инженерные сети",
  "Благоустройство",
] as const;

/** Русские названия видов пробелов — для группировки в отчёте. */
const GAP_TITLES: Readonly<Record<EstimateGapKind, string>> = {
  NO_NORM: "Норма не найдена",
  BAD_QUANTITY: "Объём непригоден для расчёта",
  BAD_DIVISOR: "Делитель единицы непригоден",
  UNIT_MISMATCH: "Единица ведомости не совпала с единицей нормы",
  LABOUR_TOTAL_MISMATCH: "Итог затрат труда разошёлся с разрядными строками",
  PROJECT_SPECIFIC_RESOURCE: "Ресурс без марки, цена выбирается проектом",
  QUANTITY_BY_PROJECT: "Расход указан как «по проекту»",
  UNKNOWN_RESOURCE: "Код ресурса не распознан",
  NO_WAGE: "Нет ставки оплаты труда",
  WAGE_EXTRAPOLATED: "Ставка продолжена за пределы тарифной шкалы",
  NO_PRICE: "Цены на ресурс в справочниках нет",
  ZERO_PRICE: "Цена в справочнике есть, но равна нулю",
  NO_CURRENT_PRICE: "Нет текущей цены по ценовой зоне",
  NO_OVERHEAD_RATE: "Норматив НР или СП начислен резервом документа",
  MACHINIST_HOURS_MISMATCH: "Часы машинистов разошлись с составом звена машин",
  MACHINE_PRICE_INCONSISTENT: "Оплата звена больше полной цены маш.-ч",
  MACHINIST_PAY_UNKNOWN: "Цена машины без оплаты машинистов, взять её нечем",
  CUSTOMER_PRICE: "Позиция посчитана по цене заказчика, не по нашей норме",
  INDEXED_PRICE: "Цена по индексу сплит-формы (текущий уровень, не измерена по зоне)",
  AI_MATERIAL_PICK: "Материал нормы «по проекту» подобран ИИ в справочнике цен, проверьте",
  NORMATIVE_NOT_APPLIED: "Норматив не начислен: неизвестны вид работ, сроки или территория",
  BIM_NO_INDEX: "Базисно-индексный метод: индексы применены с оговоркой",
  BIM_TER_AS_FER: "Базисно-индексный метод: ТЕР региона посчитаны по ФЕР",
  BIM_FALLBACK_RIM: "Смета заказчика на ФЕР/ТЕР посчитана ресурсно-индексным методом",
  PRICE_LEVEL_DIFFERS: "Смета заказчика составлена в другом уровне цен (зона или квартал)",
  CUSTOMER_BASE_DIFFERS: "Смета заказчика составлена по другой базе норм (ТСН-2001 Москвы), наша — ФСНБ-2022",
  BILL_CHUNK_UNREAD: "Фрагмент документа не прочитан моделью: часть ведомости могла не попасть в смету",
  NO_VOLUME_SOURCE: "В документах нет объёмов работ: ведомости, сметы заказчика и таблиц с количествами",
};

/** Русские подписи источников цены в расшифровке ресурса. */
const PRICE_SOURCE_TITLES: Readonly<
  Record<EstimateResourceLine["source"], string>
> = {
  CURRENT_ZONE: "текущая цена ФСЦСР по зоне",
  BASE_2022: "база ФСБЦ 01.01.2022 без пересчёта",
  BASE_2022_INDEXED: "база 01.01.2022 × индекс",
  WAGE_SCALE: "тарифная шкала зоны",
  UNPRICED: "цены нет",
  SPLIT_INDEXED: "по индексу сплит-формы",
  FGIS_SERVICE: "сметная цена услуги ФГИС ЦС (перевозка, погрузка)",
  OWN_PRICE: "своя цена, указана вручную",
  BIM_INDEXED: "цена ФЕР-2020 (01.01.2000) × индекс Минстроя",
  CUSTOMER_SUM: "сумма материалов по ЛСР заказчика (состав иной, чем в норме)",
};

/** Параметры расчёта, собранные из аргументов командной строки. */
interface DemoParameters {
  readonly vatPercent: number;
  readonly overheadPercent: number;
  readonly profitPercent: number;
  readonly winterSurchargePercent: number;
  readonly temporaryStructuresPercent: number;
  readonly indices: IndexSet | null;
  readonly probeOnly: boolean;
  readonly indexDir: string | undefined;
  readonly outPath: string;
  /** Запросы справочного режима `--find`: поиск нормы без расчёта. */
  readonly findQueries: readonly string[];
  /** Книга для `--find`. Пустая строка — искать во всех пяти. */
  readonly findBaseType: string;
}

const MANUAL_INDEX_NOTE =
  "Ручной ввод. Индексы пересчёта к текущему уровню цен публикуются письмами " +
  "Минстроя России в PDF и в открытых данных ФГИС ЦС отсутствуют.";

const MANUAL_OVERHEAD_NOTE =
  "Ручной ввод. Нормативы накладных расходов (приказ Минстроя № 812/пр) и сметной " +
  "прибыли (№ 774/пр) опубликованы только в PDF; указатель на пункт методики каждая " +
  "норма несёт сама, он напечатан рядом с позицией.";

const MANUAL_LIMITED_NOTE =
  "Ручной ввод. Нормативы ГСН 81-05-01 (временные здания и сооружения) и ГСН 81-05-02 " +
  "(зимнее удорожание) в открытых данных ФГИС ЦС отсутствуют.";

function parseNumberArg(
  args: readonly string[],
  name: string,
  fallback: number,
): number {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const raw = args[at + 1];
  if (raw === undefined) throw new Error(`У аргумента ${name} нет значения.`);
  const value = Number.parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(value))
    throw new Error(`Значение ${name} «${raw}» не число.`);
  return value;
}

function parseArgs(args: readonly string[]): DemoParameters {
  const indicesAt = args.indexOf("--indices");
  let indices: IndexSet | null = null;
  if (indicesAt >= 0) {
    const raw = args[indicesAt + 1];
    if (raw === undefined)
      throw new Error("У аргумента --indices нет значения.");
    const parts = raw
      .split(",")
      .map((part) => Number.parseFloat(part.trim().replace(",", ".")));
    const [labour, machinistLabour, machines, materials] = parts;
    if (
      labour === undefined ||
      machinistLabour === undefined ||
      machines === undefined ||
      materials === undefined
    ) {
      // Индексов четыре, а не три: оплата труда машинистов пересчитывается
      // своим значением — Минстрой публикует её отдельной колонкой внутри
      // индекса к эксплуатации машин.
      throw new Error(
        `--indices ждёт четыре числа через запятую: труд, оплата труда машинистов, машины, материалы. Получено «${raw}».`,
      );
    }
    for (const value of [labour, machinistLabour, machines, materials]) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(
          `--indices: значение ${String(value)} не положительное число.`,
        );
      }
    }
    indices = {
      period: "",
      labour,
      machinistLabour,
      machines,
      materials,
      source: MANUAL_INDEX_NOTE,
    };
  }

  const outAt = args.indexOf("--out");
  const outRaw = outAt >= 0 ? args[outAt + 1] : undefined;
  if (outAt >= 0 && outRaw === undefined)
    throw new Error("У аргумента --out нет значения.");

  const dirAt = args.indexOf("--index-dir");
  const dirRaw = dirAt >= 0 ? args[dirAt + 1] : undefined;
  if (dirAt >= 0 && dirRaw === undefined)
    throw new Error("У аргумента --index-dir нет значения.");

  // --find можно повторять: каждый следующий запрос берёт своё значение.
  const findQueries: string[] = [];
  for (
    let at = args.indexOf("--find");
    at >= 0;
    at = args.indexOf("--find", at + 1)
  ) {
    const query = args[at + 1];
    if (query === undefined)
      throw new Error("У аргумента --find нет значения.");
    findQueries.push(query);
  }
  const bookAt = args.indexOf("--book");
  const bookRaw = bookAt >= 0 ? args[bookAt + 1] : undefined;
  if (bookAt >= 0 && bookRaw === undefined)
    throw new Error("У аргумента --book нет значения.");

  return {
    // С 01.01.2026 общая ставка НДС — 22 % (ст. 164 НК РФ, ФЗ от 28.11.2025 № 425-ФЗ).
    vatPercent: parseNumberArg(args, "--vat", 22),
    overheadPercent: parseNumberArg(args, "--overhead", 100),
    profitPercent: parseNumberArg(args, "--profit", 65),
    winterSurchargePercent: parseNumberArg(args, "--winter", 0),
    temporaryStructuresPercent: parseNumberArg(args, "--temporary", 0),
    indices,
    probeOnly: args.includes("--probe"),
    indexDir: dirRaw,
    outPath: outRaw ?? SAMPLE_PATH,
    findQueries,
    findBaseType: bookRaw ?? "",
  };
}

/** Собирает разделы ведомости из черновиков. */
function billSections(): readonly BillOfWorkSection[] {
  return BILL.map((items, index) => ({
    title: SECTION_TITLES[index] ?? `Раздел ${index + 1}`,
    items: items.map(
      (item): BillOfWorkItem => ({
        id: item.id,
        workName: item.workName,
        quantity: item.quantity,
        quantityUnit: item.quantityUnit,
        unitDivisor: item.unitDivisor,
        normCode: item.confirmed?.code ?? null,
        normBaseType: item.confirmed?.baseType ?? null,
        resourceCode: null,
        sourceQuote: null,
        sourceDocument: null,
      }),
    ),
  }));
}

/**
 * Что предложил поиск и что в итоге ушло в расчёт.
 *
 * Две половины намеренно разведены: `suggested` — работа поиска, `chosen` —
 * решение. Пока они совпадают, позиция посчитана автоматически; как только
 * расходятся, отчёт обязан напечатать оба и назвать причину.
 */
interface NormPick {
  /** Кандидаты поиска по наименованию работы, лучший первым. */
  readonly suggested: readonly NormMatch[];
  /** Норма, по которой посчитана позиция. null — позиция в итог не вошла. */
  readonly chosen: NormMatch | null;
  /** Норму назначил человек кодом и книгой, а не выбрал поиск. */
  readonly confirmed: boolean;
  /** Почему поиск не оставили. Есть только у назначенных вручную позиций. */
  readonly note: string | null;
}

/**
 * Подбор норм поиском по наименованию работы.
 *
 * Кандидаты сохраняются, а не выбрасываются: отчёт обязан показать, из чего
 * выбирали. Позиция, где лучшая норма набрала вдвое больше второй, и позиция,
 * где они почти равны, — разные случаи, и сметчику нужно видеть оба.
 */
function makeResolver(searchIndex: NormSearchIndex): {
  resolveNorm: NormResolver;
  picks: ReadonlyMap<string, NormPick>;
} {
  const picks = new Map<string, NormPick>();

  const resolveNorm: NormResolver = (item) => {
    // Поиск по наименованию прогоняется всегда, даже когда норму уже назначил
    // человек: отчёту нужно показать, от чего отказались. Без этого ручное
    // назначение выглядит произволом, а не решением по результатам подбора.
    const suggested = findNorms(searchIndex, {
      workName: item.workName,
      limit: ALTERNATIVES + 1,
    });

    if (item.normCode === null) {
      const best = suggested[0] ?? null;
      picks.set(item.id, {
        suggested,
        chosen: best,
        confirmed: false,
        note: null,
      });
      return best === null ? null : { norm: best.norm, reasons: best.reasons };
    }

    const found = findNorms(searchIndex, {
      workName: item.workName,
      normCode: item.normCode,
      normBaseType: item.normBaseType,
      limit: 1,
    });
    const chosen = found[0] ?? null;
    // Код назначен в самом скрипте, значит его отсутствие в базе — опечатка, а
    // не «норма не найдена». Проглотить её — значит молча убрать позицию из сметы.
    if (chosen === null) {
      throw new Error(
        `Назначенная норма ${normLabel(item.normBaseType ?? "?", item.normCode)} не найдена в индексе. ` +
          `Позиция ${item.id} «${item.workName}».`,
      );
    }

    picks.set(item.id, {
      suggested,
      chosen,
      confirmed: true,
      note:
        BILL.flat().find((entry) => entry.id === item.id)?.confirmed?.note ??
        null,
    });
    return { norm: chosen.norm, reasons: chosen.reasons };
  };

  return { resolveNorm, picks };
}

function estimateParameters(
  period: string,
  options: DemoParameters,
): EstimateParameters {
  return {
    vatPercent: options.vatPercent,
    indices: options.indices === null ? null : { ...options.indices, period },
    overhead: {
      overheadPercent: options.overheadPercent,
      profitPercent: options.profitPercent,
      workType: "Строительство зданий и сооружений (общестроительные работы)",
      source: MANUAL_OVERHEAD_NOTE,
    },
    limited: {
      winterSurchargePercent: options.winterSurchargePercent,
      temporaryStructuresPercent: options.temporaryStructuresPercent,
      source: MANUAL_LIMITED_NOTE,
    },
  };
}

/** Число по-русски, до четырёх знаков: «850», «0,65», «0,0005». */
function num(value: number): string {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 4 });
}

/** Процент с одним знаком: «12,5 %». */
function percent(value: number): string {
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} %`;
}

/** Метка нормы: книга и код вместе, потому что код сам по себе неоднозначен. */
function normLabel(baseType: string, code: string): string {
  return `${baseType} ${code}`;
}

/**
 * Сколько ресурсов и на какую сумму посчитано по каждому источнику цены.
 *
 * Это главная честная цифра отчёта: открытые данные дают текущие цены ФСЦСР по
 * одной ценовой зоне и покрывают 228 машин из 1 729 и 1 062 материала из 45 847.
 * Всё остальное считается в уровне 01.01.2022, и читатель обязан видеть, какую
 * долю сметы это составляет.
 */
function priceCoverage(document: EstimateDocument): {
  readonly rows: readonly (readonly [string, number, number])[];
  readonly resources: number;
  readonly current: number;
  readonly baseLevel: number;
} {
  const counts = new Map<
    EstimateResourceLine["source"],
    { count: number; total: number }
  >();
  let resources = 0;
  let current = 0;
  let baseLevel = 0;

  for (const section of document.sections) {
    for (const line of section.lines) {
      for (const resource of line.resources) {
        if (resource.kind !== "MACHINE" && resource.kind !== "MATERIAL")
          continue;
        resources += 1;
        // Цена по индексу сплит-формы — текущий уровень, не база 2022.
        if (resource.source === "CURRENT_ZONE" || resource.source === "SPLIT_INDEXED") current += 1;
        if (
          resource.source === "BASE_2022" ||
          resource.source === "BASE_2022_INDEXED"
        )
          baseLevel += 1;
        const entry = counts.get(resource.source) ?? { count: 0, total: 0 };
        entry.count += 1;
        entry.total += resource.total;
        counts.set(resource.source, entry);
      }
    }
  }

  const rows: (readonly [string, number, number])[] = [...counts.entries()]
    .map(
      ([source, entry]) =>
        [PRICE_SOURCE_TITLES[source], entry.count, entry.total] as const,
    )
    .sort((a, b) => b[2] - a[2]);

  return { rows, resources, current, baseLevel };
}

/**
 * Сколько ресурсов не попало в итог из-за того, что в норме они названы группой.
 *
 * Это главное ограничение цифры итога, а не рядовой пробел. В ФСНБ-2022 основные
 * материалы лежат группами без конкретной марки — «Кирпич керамический или
 * силикатный», «Смеси бетонные тяжелого бетона», «Блоки оконные пластиковые»,
 * «Радиаторы стальные панельные», «Смеси асфальтобетонные». Цены у группы нет:
 * стоимость выбирает проект, поэтому в расчёт такой ресурс не входит вовсе.
 * Без предупреждения рядом с итогом число читалось бы как стоимость стройки,
 * а это стоимость работ без основных материалов.
 */
function unpricedMaterialShare(document: EstimateDocument): {
  readonly resources: number;
  readonly items: number;
} {
  const gaps = document.gaps.filter(
    (gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE",
  );
  const items = new Set<string>();
  for (const gap of gaps) {
    if (gap.code === null) continue;
    items.add(`${gap.baseType ?? ""} ${gap.code}`);
  }
  return { resources: gaps.length, items: items.size };
}

/** Русская форма числительного: 1 ресурс, 2 ресурса, 5 ресурсов. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Предупреждение, которое печатается сразу под итогом — до всех пояснений.
 *
 * Собирается из самого документа, а не пишется заранее: прогон с индексами и
 * прогон без них отличаются тем, в каком уровне посчитаны машины и материалы,
 * и общая фраза в одном из двух случаев соврала бы.
 */
function totalCaveat(document: EstimateDocument): string {
  const share = unpricedMaterialShare(document);
  const indices = document.parameters.indices;

  /*
    Про уровень цен говорим только то, что случилось на этом прогоне. Ресурсов
    без текущей цены может не остаться вовсе — со сплит-формой так и выходит, — и
    тогда фраза о пересчёте лишняя: она заставляла бы искать в смете то, чего в
    ней нет.
  */
  const withoutCurrent = document.gaps.filter(
    (gap) => gap.kind === "NO_CURRENT_PRICE",
  ).length;

  const priceLevel =
    withoutCurrent === 0
      ? "Все ресурсы, у которых есть цена, посчитаны в текущем уровне цен по ценовой зоне."
      : indices === null
        ? `Ресурсов без текущей цены по зоне: ${withoutCurrent} — посчитаны в уровне ` +
          "01.01.2022 без пересчёта, индекс не задан."
        : `Ресурсов без текущей цены по зоне: ${withoutCurrent} — пересчитаны индексом из ` +
          `ручного ввода: труд ${num(indices.labour)}, машины ${num(indices.machines)}, ` +
          `материалы ${num(indices.materials)}.`;

  return (
    "Итог не включает стоимость основных материалов: в расчёт не вошли " +
    `${formatNumber(share.resources)} ${plural(share.resources, "ресурс", "ресурса", "ресурсов")} ` +
    `из ${formatNumber(share.items)} ${plural(share.items, "позиции", "позиций", "позиций")} ведомости — ` +
    "в норме они названы группой без марки (кирпич, бетонные и асфальтобетонные смеси, " +
    "оконные блоки, радиаторы, трубы, профилированный настил), цены на группу в справочниках " +
    "нет, и её выбирает проект. " +
    priceLevel
  );
}

/** Строка отчёта: «метка … значение», выровненная по ширине. */
function row(label: string, value: string, width = 26): string {
  return `  ${label.padEnd(width, ".")} ${value}`;
}

function sectionRule(char = "─"): string {
  return char.repeat(78);
}

function renderPassport(base: EstimateBase, options: DemoParameters): string[] {
  const { info } = base;
  return [
    sectionRule("═"),
    "  Смета по открытым данным ФГИС ЦС — демонстрационный прогон",
    sectionRule("═"),
    "",
    "База",
    row("Регион", info.region),
    row("Ценовая зона", info.priceZone),
    row("Период текущих цен", info.period),
    row("Уровень базы", info.baseEdition),
    row("Издание", info.decree),
    row("Норм", `${formatNumber(info.counts.norms)} в пяти книгах`),
    row("Цен базы ФСБЦ", formatNumber(info.counts.basePrices)),
    row("Текущих цен ФСЦСР", formatNumber(info.counts.currentPrices)),
    row(
      "Тарифных точек",
      `${formatNumber(info.counts.wages)} строк, ${formatNumber(base.priceBook.wageScale.anchors.length)} в шкале`,
    ),
    row("Ценовых зон", formatNumber(info.counts.zones)),
    row("Загрузка базы", `${formatNumber(Math.round(base.loadMs))} мс`),
    row("Каталог индекса", resolve(options.indexDir ?? "data/fsnb/index")),
    "",
    "Закупка",
    row("Лот", LOT.number),
    row("ОКПД2", LOT.okpd2),
    row("Наименование", LOT.title),
    "",
    "  " + BILL_NOTE,
    "",
    "  " + DISCLAIMER,
    "",
  ];
}

/** Печатает по каждой позиции: что предложил поиск, что назначено и почему. */
function renderPicks(picks: ReadonlyMap<string, NormPick>): string[] {
  const out: string[] = ["Подбор норм", ""];
  const drafts = BILL.flat();
  const confirmed = drafts.filter((item) => item.confirmed !== null).length;
  const tied = drafts.filter((item) => {
    if (item.confirmed !== null) return false;
    const suggested = picks.get(item.id)?.suggested ?? [];
    const [first, second] = suggested;
    return (
      first !== undefined &&
      second !== undefined &&
      first.score === second.score
    );
  }).length;

  out.push(
    `  Позиций ${drafts.length}: назначено человеком ${confirmed}, подобрано поиском ${drafts.length - confirmed}, ` +
      `из них с равным баллом у первого и второго кандидата ${tied}.`,
  );
  out.push("");

  for (const draftItem of drafts) {
    const pick = picks.get(draftItem.id);
    out.push(`  ${draftItem.id}. ${draftItem.workName}`);
    out.push(
      `     ${num(draftItem.quantity)} ${draftItem.quantityUnit}, делитель ${num(draftItem.unitDivisor)}`,
    );

    const best = pick?.suggested[0];
    if (best === undefined) {
      out.push("     поиск: кандидатов нет");
    } else {
      out.push(
        `     поиск: ${normLabel(best.norm.baseType, best.norm.code)} (балл ${num(best.score)}) — ${best.norm.fullName}`,
      );
      for (const alternative of (pick?.suggested ?? []).slice(1)) {
        out.push(
          `            ещё: ${normLabel(alternative.norm.baseType, alternative.norm.code)} (балл ${num(alternative.score)}) — ${alternative.norm.fullName}`,
        );
      }
    }

    const chosen = pick?.chosen;
    if (chosen === undefined || chosen === null) {
      out.push("     → норма не найдена, позиция в итог не войдёт");
      out.push("");
      continue;
    }

    const same =
      best !== undefined &&
      best.norm.baseType === chosen.norm.baseType &&
      best.norm.code === chosen.norm.code;
    out.push(
      `     → ${pick?.confirmed === true ? "назначено вручную" : "в расчёт"}: ` +
        `${normLabel(chosen.norm.baseType, chosen.norm.code)} [${chosen.norm.unit}]${same ? "" : " — не то, что предложил поиск"}`,
    );
    out.push(`       ${chosen.norm.fullName}`);
    out.push(
      `       Сборник ${chosen.norm.collectionCode} «${chosen.norm.collectionName}»`,
    );
    for (const reason of chosen.reasons) out.push(`       · ${reason}`);
    if (pick?.note !== undefined && pick.note !== null)
      out.push(`       · Почему не поиск: ${pick.note}`);
    if (chosen.norm.overheadRef !== null || chosen.norm.profitRef !== null) {
      out.push(
        `       Нормативы: НР ${chosen.norm.overheadRef ?? "—"}, СП ${chosen.norm.profitRef ?? "—"}`,
      );
    }
    out.push("");
  }

  return out;
}

/**
 * Справочный режим `--find`: поиск нормы по наименованию без расчёта.
 *
 * Нужен не для красоты. Подбор по одному лишь названию работы не заменяет
 * сметчика: на низких баллах он уверенно предлагает не ту норму — подводную
 * разработку грунта вместо котлована, соединительную муфту вместо прокладки
 * кабеля. Поэтому режим печатает кандидатов вместе с баллом и единицей
 * измерения, по которой подбирается делитель объёма, а назначает норму человек.
 */
function renderFind(
  searchIndex: NormSearchIndex,
  queries: readonly string[],
  baseType: string,
): string[] {
  const out: string[] = ["Поиск норм", ""];

  for (const query of queries) {
    out.push(`  Запрос: ${query}`);
    if (baseType.length > 0) out.push(`  Книга: ${baseType}`);
    const matches = findNorms(searchIndex, {
      workName: query,
      normBaseType: baseType.length === 0 ? null : baseType,
      limit: 8,
    });
    if (matches.length === 0) {
      out.push("    кандидатов нет");
      out.push("");
      continue;
    }
    for (const match of matches) {
      out.push(
        `    ${num(match.score).padStart(7, " ")}  ${normLabel(match.norm.baseType, match.norm.code)}  [${match.norm.unit}]`,
      );
      out.push(`             ${match.norm.fullName}`);
      out.push(
        `             сборник ${match.norm.collectionCode} «${match.norm.collectionName}»`,
      );
    }
    out.push("");
  }

  return out;
}

function renderDocument(
  document: EstimateDocument,
  info: EstimateBaseInfo,
  options: DemoParameters,
): string[] {
  const out: string[] = ["Смета", ""];
  const parameters = document.parameters;

  out.push("  Параметры");
  out.push(row("    Метод", "ресурсно-индексный"));
  out.push(row("    НДС", percent(parameters.vatPercent)));
  out.push(
    row("    Накладные расходы", percent(parameters.overhead.overheadPercent)),
  );
  out.push(
    row("    Сметная прибыль", percent(parameters.overhead.profitPercent)),
  );
  out.push(
    row(
      "    Зимнее удорожание",
      percent(parameters.limited.winterSurchargePercent),
    ),
  );
  out.push(
    row(
      "    Временные здания",
      percent(parameters.limited.temporaryStructuresPercent),
    ),
  );
  out.push(
    row(
      "    Индексы",
      parameters.indices === null
        ? "не заданы: позиции без текущей цены идут по базе 01.01.2022"
        : `труд ${num(parameters.indices.labour)}, машины ${num(parameters.indices.machines)}, материалы ${num(parameters.indices.materials)}`,
    ),
  );
  out.push("");

  for (const section of document.sections) {
    out.push(`  ${section.title}`);
    if (section.lines.length === 0) {
      out.push("    ни одна позиция не рассчитана");
      out.push("");
      continue;
    }
    for (const line of section.lines) {
      out.push(
        `    ${line.itemId.padStart(2, " ")}. ${normLabel(line.normBaseType, line.normCode)} · ${num(line.billQuantity)} ${line.billUnit} → ${num(line.quantity)} ${line.normUnit}`,
      );
      out.push(`       ${line.normName}`);
      out.push(
        `       труд ${num(line.labourHours)} чел.-ч × ${formatCurrency(line.labourRate)} = ${formatCurrency(line.labourCost)}` +
          (line.labourHours === 0 && line.machinistHours > 0
            ? " — рабочих в норме нет, весь труд у машиниста"
            : ""),
      );
      out.push(
        `       машинисты ${num(line.machinistHours)} чел.-ч = ${formatCurrency(line.machinistSalaryCost)} · ` +
          `машины ${num(line.machineHours)} маш.-ч = ${formatCurrency(line.machineCost)} · материалы ${formatCurrency(line.materialCost)}`,
      );
      out.push(
        `       прямые ${formatCurrency(line.directCost)} · ФОТ ${formatCurrency(line.wageFund)} · НР ${formatCurrency(line.overheadCost)} · СП ${formatCurrency(line.profitCost)}`,
      );
      if (line.gaps.length > 0) {
        out.push(
          `       пометки: ${line.gaps.map((gap) => gap.kind).join(", ")}`,
        );
      }
    }
    out.push(
      `    Итого по разделу: прямые ${formatCurrency(section.directCost)}, НР ${formatCurrency(section.overheadCost)}, СП ${formatCurrency(section.profitCost)}, работы ${formatCurrency(section.workCost)}`,
    );
    out.push("");
  }

  const totals = document.totals;
  out.push("  Итоги по документу");
  out.push(row("    Прямые затраты", formatCurrency(totals.directCost)));
  out.push(row("    Фонд оплаты труда", formatCurrency(totals.wageFund)));
  out.push(row("    Накладные расходы", formatCurrency(totals.overheadCost)));
  out.push(row("    Сметная прибыль", formatCurrency(totals.profitCost)));
  out.push(row("    Стоимость СМР", formatCurrency(totals.workCost)));
  out.push(
    row("    Зимнее удорожание", formatCurrency(totals.winterSurcharge)),
  );
  out.push(
    row("    Временные здания", formatCurrency(totals.temporaryStructures)),
  );
  out.push(row("    Без НДС", formatCurrency(totals.beforeVat)));
  out.push(row("    НДС", formatCurrency(totals.vat)));
  out.push(row("    Итого с НДС", formatCurrency(totals.total)));
  out.push("");
  out.push("  " + totalCaveat(document));
  out.push("");

  out.push(...renderAssurance(document));

  const coverage = priceCoverage(document);
  out.push("  Откуда цены на машины и материалы");
  for (const [title, count, total] of coverage.rows) {
    out.push(
      row(
        `    ${title}`,
        `${formatNumber(count)} шт. на ${formatCurrency(total)}`,
        46,
      ),
    );
  }
  out.push(
    row(
      "    Покрытие текущими ценами",
      coverage.resources === 0
        ? "—"
        : `${formatNumber(coverage.current)} из ${formatNumber(coverage.resources)} (${percent((coverage.current / coverage.resources) * 100)}), в уровне ${document.baseEdition} — ${formatNumber(coverage.baseLevel)}`,
      46,
    ),
  );
  out.push("");
  if (options.indices === null) {
    out.push("  " + currentPriceCoverageNote(info));
    out.push("");
  }

  return out;
}

/** Короткое название допущения для таблиц отчёта. */
function assumptionTitle(
  kind: EstimateAssurance["assumptions"][number]["kind"],
): string {
  switch (kind) {
    case "OVERHEAD_DEFAULT":
      return "НР и СП резервом документа";
    case "BASE_PRICE":
      return "Цена базового уровня 2022 года";
    case "EXTRAPOLATED_WAGE":
      return "Ставка продолжена за шкалу";
    case "CUSTOMER_PRICE":
      return "Цена заказчика вместо нашей нормы";
    case "NORMATIVE_ASSUMED":
      return "Зимнее удорожание с допущением о территории";
    case "BIM_INDEX_ASSUMED":
      return "Базисно-индексный метод: индексы по прочим объектам или ТЕР по ФЕР";
    case "CONTRACT_ESTIMATE_VOLUMES":
      return "Объёмы из сметы контракта: позиции укрупнены";
    case "CUSTOMER_COEFFICIENT_MANUAL":
      return "Коэффициенты заказчика включены вручную без подтверждения";
  }
}

/**
 * Сверка «сверху вниз»: один процент вместо чтения списка пометок.
 *
 * Стоит сразу под итогами, а не в конце рядом с пробелами: вопрос «можно ли
 * верить этой цифре» задаётся в тот момент, когда цифру увидели.
 */
function renderAssurance(document: EstimateDocument): string[] {
  const assurance = computeAssurance(document);
  const out: string[] = [];

  out.push("  Сколько стоимости держится на допущении");
  out.push(
    row(
      "    Доля допущений в СМР",
      assurance.workCost === 0 ? "—" : percent(assurance.assumedPercent),
      46,
    ),
  );
  for (const assumption of assurance.assumptions) {
    out.push(
      row(
        `    ${assumptionTitle(assumption.kind)}`,
        `${formatCurrency(assumption.cost)} (${percent(assumption.percent)})`,
        46,
      ),
    );
  }
  if (assurance.assumptions.length === 0 && assurance.workCost > 0) {
    out.push(
      "    Ни одно начисление не опирается на резерв, базу 2022 года или продолженную ставку.",
    );
  }
  if (assurance.unpricedResources > 0) {
    out.push(
      row(
        "    Ресурсов с расходом без денег",
        `${formatNumber(assurance.unpricedResources)} шт. — итог на их стоимость занижен`,
        46,
      ),
    );
  }
  if (assurance.droppedPositions > 0) {
    out.push(
      row(
        "    Позиций вне расчёта",
        `${formatNumber(assurance.droppedPositions)} — их стоимости в итоге нет вовсе`,
        46,
      ),
    );
  }
  out.push("");

  return out;
}

function renderGaps(document: EstimateDocument): string[] {
  const out: string[] = ["Пробелы", ""];
  if (document.gaps.length === 0) {
    out.push(
      "  нет: по каждой позиции нашлись и норма, и цены на все её ресурсы",
    );
    out.push("");
    return out;
  }

  const byKind = new Map<EstimateGapKind, EstimateGap[]>();
  for (const gap of document.gaps) {
    const list = byKind.get(gap.kind) ?? [];
    list.push(gap);
    byKind.set(gap.kind, list);
  }

  out.push(`  всего ${formatNumber(document.gaps.length)}`);
  out.push("");
  const ordered = [...byKind.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );
  for (const [kind, gaps] of ordered) {
    out.push(`  ${kind} — ${GAP_TITLES[kind]}: ${formatNumber(gaps.length)}`);
    for (const gap of gaps) {
      const where =
        gap.code === null
          ? ""
          : ` [${gap.baseType === null ? "" : `${gap.baseType} `}${gap.code}]`;
      out.push(`    · ${gap.message}${where}`);
    }
    out.push("");
  }

  return out;
}

/** Подробный отчёт в Markdown — тот же документ, но с расшифровкой ресурсов. */
function renderMarkdown(
  document: EstimateDocument,
  base: EstimateBase,
  picks: ReadonlyMap<string, NormPick>,
  problems: readonly string[],
  options: DemoParameters,
): string {
  const out: string[] = [];
  const parameters = document.parameters;

  out.push(`# ${document.title}`);
  out.push("");
  out.push(
    `Демонстрационный прогон \`scripts/fsnb/demo-estimate.ts\` от ${formatDateTime(document.generatedAt)}. ` +
      "К продукту не подключён: ни API-роут, ни экран его не вызывают.",
  );
  out.push("");
  out.push(`> ${DISCLAIMER}`);
  out.push("");

  out.push("## Закупка");
  out.push("");
  out.push(`- Лот: ${LOT.number}`);
  out.push(`- ОКПД2: ${LOT.okpd2}`);
  out.push(`- Наименование: ${LOT.title}`);
  out.push("");
  out.push(`**${BILL_NOTE}**`);
  out.push("");

  out.push("## Откуда числа");
  out.push("");
  out.push("| Параметр | Значение |");
  out.push("| --- | --- |");
  out.push(`| Регион | ${document.region} |`);
  out.push(`| Ценовая зона | ${document.priceZone} |`);
  out.push(`| Период текущих цен | ${document.period} |`);
  out.push(`| Уровень базы | ${document.baseEdition} |`);
  out.push(`| Издание базы | ${base.info.decree} |`);
  out.push(`| Норм в индексе | ${formatNumber(base.info.counts.norms)} |`);
  out.push(`| Цен базы ФСБЦ | ${formatNumber(base.info.counts.basePrices)} |`);
  out.push(
    `| Текущих цен ФСЦСР | ${formatNumber(base.info.counts.currentPrices)} |`,
  );
  out.push(
    `| Тарифная шкала | разряды ${num(document.wageScale.minRank)}–${num(document.wageScale.maxRank)}, ` +
      `${formatNumber(document.wageScale.anchors.length)} опорных точек, ставка 1-го разряда ${formatCurrency(document.wageScale.baseSalary)} |`,
  );
  out.push("");
  out.push("Источники:");
  out.push("");
  for (const source of document.sources) {
    out.push(`- [${source.title}](${source.url}) — ${source.edition}`);
  }
  out.push("");

  out.push("## Параметры, введённые вручную");
  out.push("");
  out.push(
    "В открытых данных ФГИС ЦС их нет, поэтому каждое значение — ручной ввод, а не факт из базы.",
  );
  out.push("");
  out.push("| Параметр | Значение | Почему вручную |");
  out.push("| --- | --- | --- |");
  out.push(
    `| Накладные расходы | ${percent(parameters.overhead.overheadPercent)} | ${MANUAL_OVERHEAD_NOTE} |`,
  );
  out.push(
    `| Сметная прибыль | ${percent(parameters.overhead.profitPercent)} | ${MANUAL_OVERHEAD_NOTE} |`,
  );
  out.push(
    `| Индексы пересчёта | ${
      parameters.indices === null
        ? "не заданы"
        : `труд ${num(parameters.indices.labour)}, машины ${num(parameters.indices.machines)}, материалы ${num(parameters.indices.materials)}`
    } | ${MANUAL_INDEX_NOTE} |`,
  );
  out.push(
    `| Зимнее удорожание | ${percent(parameters.limited.winterSurchargePercent)} | ${MANUAL_LIMITED_NOTE} |`,
  );
  out.push(
    `| Временные здания и сооружения | ${percent(parameters.limited.temporaryStructuresPercent)} | ${MANUAL_LIMITED_NOTE} |`,
  );
  out.push(
    `| НДС | ${percent(parameters.vatPercent)} | Ставка Налогового кодекса РФ |`,
  );
  out.push("");

  out.push("## Ведомость объёмов работ и подбор норм");
  out.push("");
  const drafts = BILL.flat();
  const confirmedCount = drafts.filter(
    (item) => item.confirmed !== null,
  ).length;
  out.push(
    `Позиций ${formatNumber(drafts.length)}. Подбор поиском оставлен в ${formatNumber(drafts.length - confirmedCount)}, ` +
      `в ${formatNumber(confirmedCount)} норму назначил человек кодом и книгой — причины приведены ниже.`,
  );
  out.push("");
  out.push(
    "| № | Наименование работы | Объём | Ед. | Делитель | Норма в расчёте | Поиск предложил | Балл |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const draftItem of drafts) {
    const pick = picks.get(draftItem.id);
    const chosen = pick?.chosen ?? null;
    const best = pick?.suggested[0];
    out.push(
      `| ${draftItem.id} | ${draftItem.workName} | ${num(draftItem.quantity)} | ${draftItem.quantityUnit} | ` +
        `${num(draftItem.unitDivisor)} | ` +
        (chosen === null
          ? "не найдена"
          : `${normLabel(chosen.norm.baseType, chosen.norm.code)} [${chosen.norm.unit}]`) +
        ` | ${best === undefined ? "кандидатов нет" : normLabel(best.norm.baseType, best.norm.code)} | ` +
        `${best === undefined ? "—" : num(best.score)} |`,
    );
  }
  out.push("");
  out.push("### Как назначена каждая позиция");
  out.push("");
  for (const draftItem of drafts) {
    const pick = picks.get(draftItem.id);
    const chosen = pick?.chosen ?? null;
    const best = pick?.suggested[0];
    const same =
      best !== undefined &&
      chosen !== null &&
      best.norm.baseType === chosen.norm.baseType &&
      best.norm.code === chosen.norm.code;

    if (chosen === null) {
      out.push(
        `**${draftItem.id}. ${draftItem.workName}** — норма не найдена, позиция в итог не вошла.`,
      );
      out.push("");
      continue;
    }

    out.push(
      `**${draftItem.id}. ${draftItem.workName}** → ${normLabel(chosen.norm.baseType, chosen.norm.code)} ` +
        `[${chosen.norm.unit}] — ${chosen.norm.fullName}`,
    );
    out.push("");
    out.push(
      pick?.confirmed === true
        ? `- Норма назначена человеком, поиск её первым не предложил.`
        : same
          ? `- Норма выбрана поиском автоматически: его первый кандидат и пошёл в расчёт.`
          : `- Норма выбрана поиском автоматически, хотя его первый кандидат был другим.`,
    );
    if (best !== undefined) {
      out.push(
        `- Поиск предложил ${normLabel(best.norm.baseType, best.norm.code)} (балл ${num(best.score)}) — ${best.norm.fullName}.`,
      );
    }
    const alternatives = (pick?.suggested ?? []).slice(1);
    if (alternatives.length > 0) {
      out.push(
        `- Другие кандидаты: ${alternatives
          .map(
            (match) =>
              `${normLabel(match.norm.baseType, match.norm.code)} (${num(match.score)})`,
          )
          .join("; ")}.`,
      );
    }
    if (pick?.note !== undefined && pick.note !== null) {
      out.push(`- Почему не поиск: ${pick.note}`);
    }
    for (const reason of chosen.reasons) out.push(`- ${reason}.`);
    if (chosen.norm.overheadRef !== null || chosen.norm.profitRef !== null) {
      out.push(
        `- Указатели нормативов в самой норме: НР ${chosen.norm.overheadRef ?? "—"}, СП ${chosen.norm.profitRef ?? "—"}. ` +
          "Проценты в расчёте ручные, по ним их можно сверить с первоисточником.",
      );
    }
    out.push("");
  }

  out.push("## Расчёт");
  out.push("");
  for (const section of document.sections) {
    out.push(`### ${section.title}`);
    out.push("");
    if (section.lines.length === 0) {
      out.push("Ни одна позиция раздела не рассчитана.");
      out.push("");
      continue;
    }
    for (const line of section.lines) {
      out.push(
        `**${line.itemId}. ${normLabel(line.normBaseType, line.normCode)}** — ${line.normName}  `,
      );
      out.push(
        `Объём: ${num(line.billQuantity)} ${line.billUnit} = ${num(line.quantity)} ${line.normUnit}`,
      );
      out.push("");
      out.push(
        "| Код | Ресурс | Ед. | Расход | Цена за ед. | Стоимость | Источник цены |",
      );
      out.push("| --- | --- | --- | --- | --- | --- | --- |");
      for (const resource of line.resources) {
        const name =
          resource.name.length === 0 ? "(служебный код)" : resource.name;
        const origin =
          resource.wageOrigin === null
            ? ""
            : `, ${resource.wageOrigin.toLowerCase()}`;
        out.push(
          `| ${resource.code} | ${name} | ${resource.unit} | ${num(resource.quantity)} | ` +
            `${num(resource.unitPrice)} | ${num(resource.total)} | ${PRICE_SOURCE_TITLES[resource.source]}${origin} |`,
        );
      }
      out.push("");
      out.push(
        `Труд: ${num(line.labourHours)} чел.-ч по ${formatCurrency(line.labourRate)} = ${formatCurrency(line.labourCost)}. ` +
          `Машинисты: ${num(line.machinistHours)} чел.-ч = ${formatCurrency(line.machinistSalaryCost)}. ` +
          `Машины: ${num(line.machineHours)} маш.-ч = ${formatCurrency(line.machineCost)}. ` +
          `Материалы: ${formatCurrency(line.materialCost)}.`,
      );
      out.push("");
      out.push(
        `Прямые затраты ${formatCurrency(line.directCost)}, фонд оплаты труда ${formatCurrency(line.wageFund)}, ` +
          `накладные расходы ${formatCurrency(line.overheadCost)}, сметная прибыль ${formatCurrency(line.profitCost)}.`,
      );
      if (line.gaps.length > 0) {
        out.push("");
        out.push("Пометки по позиции:");
        out.push("");
        for (const gap of line.gaps)
          out.push(`- \`${gap.kind}\` — ${gap.message}`);
      }
      out.push("");
    }
    out.push(
      `**Итого по разделу:** прямые ${formatCurrency(section.directCost)}, НР ${formatCurrency(section.overheadCost)}, ` +
        `СП ${formatCurrency(section.profitCost)}, стоимость работ ${formatCurrency(section.workCost)}.`,
    );
    out.push("");
  }

  out.push("## Итоги");
  out.push("");
  out.push("| Показатель | Сумма |");
  out.push("| --- | --- |");
  out.push(
    `| Прямые затраты | ${formatCurrency(document.totals.directCost)} |`,
  );
  out.push(
    `| Фонд оплаты труда | ${formatCurrency(document.totals.wageFund)} |`,
  );
  out.push(
    `| Накладные расходы | ${formatCurrency(document.totals.overheadCost)} |`,
  );
  out.push(
    `| Сметная прибыль | ${formatCurrency(document.totals.profitCost)} |`,
  );
  out.push(`| Стоимость СМР | ${formatCurrency(document.totals.workCost)} |`);
  out.push(
    `| Зимнее удорожание | ${formatCurrency(document.totals.winterSurcharge)} |`,
  );
  out.push(
    `| Временные здания и сооружения | ${formatCurrency(document.totals.temporaryStructures)} |`,
  );
  out.push(`| Без НДС | ${formatCurrency(document.totals.beforeVat)} |`);
  out.push(
    `| НДС ${percent(document.parameters.vatPercent)} | ${formatCurrency(document.totals.vat)} |`,
  );
  out.push(
    `| **Итого с НДС** | **${formatCurrency(document.totals.total)}** |`,
  );
  out.push("");
  out.push(`**${totalCaveat(document)}**`);
  out.push("");

  const assurance = computeAssurance(document);
  out.push("## Сколько стоимости держится на допущении");
  out.push("");
  out.push(
    assurance.workCost === 0
      ? "Стоимости СМР нет: считать долю не от чего."
      : `На допущениях держится **${percent(assurance.assumedPercent)}** стоимости СМР — ` +
          `${formatCurrency(assurance.assumedCost)} из ${formatCurrency(assurance.workCost)}.`,
  );
  out.push("");
  if (assurance.assumptions.length === 0) {
    out.push(
      "Ни одно начисление не опирается на резервный норматив, цену базового уровня 2022 года или продолженную ставку оплаты труда.",
    );
    out.push("");
  } else {
    out.push("| Допущение | Стоимость | Доля в СМР |");
    out.push("| --- | --- | --- |");
    for (const assumption of assurance.assumptions) {
      out.push(
        `| ${assumptionTitle(assumption.kind)} | ${formatCurrency(assumption.cost)} | ${percent(assumption.percent)} |`,
      );
    }
    out.push("");
    for (const assumption of assurance.assumptions) {
      out.push(`- ${assumptionTitle(assumption.kind)}: ${assumption.message}.`);
    }
    out.push("");
  }
  if (assurance.unpricedResources > 0 || assurance.droppedPositions > 0) {
    out.push(
      "В процент не входит и войти не может, потому что стоимости у этого нет: " +
        `ресурсов с расходом и без денег — ${formatNumber(assurance.unpricedResources)}, ` +
        `позиций, выпавших из расчёта, — ${formatNumber(assurance.droppedPositions)}. ` +
        "Итог занижен на их величину, а не приблизителен.",
    );
    out.push("");
  }

  const coverage = priceCoverage(document);
  out.push("## Покрытие ценами");
  out.push("");
  out.push("| Источник цены | Ресурсов | Сумма |");
  out.push("| --- | --- | --- |");
  for (const [title, count, total] of coverage.rows) {
    out.push(
      `| ${title} | ${formatNumber(count)} | ${formatCurrency(total)} |`,
    );
  }
  out.push("");
  out.push(
    coverage.resources === 0
      ? "Машин и материалов в рассчитанных позициях нет."
      : `Текущая цена ФСЦСР по зоне нашлась у ${formatNumber(coverage.current)} из ${formatNumber(coverage.resources)} ` +
          `ресурсов (${percent((coverage.current / coverage.resources) * 100)}); ${formatNumber(coverage.baseLevel)} ` +
          `посчитаны в уровне ${document.baseEdition}.`,
  );
  out.push("");
  out.push(`Пояснение базы: ${currentPriceCoverageNote(base.info)}`);
  out.push("");

  out.push("## Пробелы");
  out.push("");
  if (document.gaps.length === 0) {
    out.push(
      "Нет: по каждой позиции нашлись и норма, и цены на все её ресурсы.",
    );
  } else {
    out.push(`Всего ${formatNumber(document.gaps.length)}.`);
    out.push("");
    const byKind = new Map<EstimateGapKind, EstimateGap[]>();
    for (const gap of document.gaps) {
      const list = byKind.get(gap.kind) ?? [];
      list.push(gap);
      byKind.set(gap.kind, list);
    }
    for (const [kind, gaps] of [...byKind.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      out.push(
        `### \`${kind}\` — ${GAP_TITLES[kind]}: ${formatNumber(gaps.length)}`,
      );
      out.push("");
      for (const gap of gaps) {
        const where =
          gap.code === null
            ? ""
            : ` (${gap.baseType === null ? "" : `${gap.baseType} `}${gap.code})`;
        out.push(`- ${gap.message}${where}`);
      }
      out.push("");
    }
  }
  out.push("");

  out.push("## Проверки");
  out.push("");
  out.push(`- Документ прошёл \`parseEstimateDocument\` (Zod-схема сметы).`);
  out.push(
    problems.length === 0
      ? "- `auditEstimateArithmetic`: расхождений нет — итоги сходятся с суммой строк, каждая нулевая цена и каждая приблизительная ставка объяснены пометкой."
      : `- \`auditEstimateArithmetic\` нашёл ${formatNumber(problems.length)} расхождени${problems.length === 1 ? "е" : "й"}:`,
  );
  for (const problem of problems) out.push(`  - ${problem}`);
  const confirmed = drafts.filter((item) => item.confirmed !== null).length;
  const automatic = drafts.length - confirmed;
  // Измерение не праздное: равный балл у первого и второго кандидата означает,
  // что поиск довёл до таблицы, а строку выбрал порядок сортировки, а не смысл.
  const tied = drafts.filter((item) => {
    if (item.confirmed !== null) return false;
    const suggested = picks.get(item.id)?.suggested ?? [];
    const [first, second] = suggested;
    return (
      first !== undefined &&
      second !== undefined &&
      first.score === second.score
    );
  }).length;
  out.push(
    `- Подбор норм: ${formatNumber(automatic)} из ${formatNumber(drafts.length)} позиций подобраны поиском, ` +
      `в ${formatNumber(tied)} из них первый кандидат делил балл со вторым — строку там выбрал порядок сортировки, а не смысл. ` +
      `${formatNumber(confirmed)} позиций назначены человеком кодом и книгой, причина напечатана по каждой.`,
  );
  out.push(
    `- Каталог индекса: \`${resolve(options.indexDir ?? "data/fsnb/index")}\``,
  );
  out.push(`- Собран: ${base.info.builtAt}`);
  out.push(`- Пересобрать индекс: \`${BUILD_COMMAND}\``);
  out.push("");

  return out.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let base: EstimateBase;
  try {
    base = await loadEstimateBase({ indexDir: options.indexDir });
  } catch (error) {
    if (error instanceof EstimateBaseUnavailableError) {
      console.error(`База сметных данных недоступна: ${error.message}`);
      console.error(`Каталог: ${error.indexDir}`);
      console.error(`Собрать индекс: ${BUILD_COMMAND}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (options.findQueries.length > 0) {
    console.log(
      renderFind(
        base.searchIndex,
        options.findQueries,
        options.findBaseType,
      ).join("\n"),
    );
    return;
  }

  const lines = renderPassport(base, options);
  const { resolveNorm, picks } = makeResolver(base.searchIndex);

  // Резолвер вызывается внутри расчёта, поэтому подбор нужно прогнать и в
  // режиме --probe: без этого нечего печатать. Расчёт при этом не запускается.
  const sections = billSections();
  if (options.probeOnly) {
    for (const section of sections) {
      for (const item of section.items) resolveNorm(item);
    }
    lines.push(...renderPicks(picks));
    console.log(lines.join("\n"));
    return;
  }

  const document = buildEstimate({
    title: `Локальная смета: ${LOT.title}`,
    sections,
    priceBook: base.priceBook,
    parameters: estimateParameters(base.info.period, options),
    resolveNorm,
    sources: base.sources,
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  });

  let problems: readonly string[] = [];
  try {
    const dto = parseEstimateDocument(document);
    problems = auditEstimateArithmetic(dto);
  } catch (error) {
    const message =
      error !== null && typeof error === "object" && "issues" in error
        ? (
            error as {
              issues: readonly {
                path: readonly (string | number)[];
                message: string;
              }[];
            }
          ).issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "(корень)"}: ${issue.message}`,
            )
            .join("; ")
        : String(error);
    console.error("Документ не прошёл проверку схемы сметы:");
    console.error(message);
    process.exitCode = 1;
    return;
  }

  lines.push(...renderPicks(picks));
  lines.push(...renderDocument(document, base.info, options));
  lines.push(...renderGaps(document));
  lines.push("Проверка арифметики", "");
  lines.push(
    problems.length === 0
      ? "  расхождений нет"
      : problems.map((problem) => `  · ${problem}`).join("\n"),
  );
  lines.push("");
  console.log(lines.join("\n"));

  const markdown = renderMarkdown(document, base, picks, problems, options);
  const outPath = resolve(options.outPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, "utf8");
  console.log(`Подробный отчёт записан: ${outPath}`);

  /*
    Рядом с отчётом кладём три выгрузки, и это разные документы, а не три вида
    одного. Ведомость объёмов работ — то, что сметчик подхватывает импортом из
    Excel. Рабочая таблица сметы — то, что читается глазами и проверяется без
    сметной программы вообще. Локальный сметный расчёт по Приложению 3 к
    Методике 421/пр — то, что можно показать заказчику: двенадцать колонок в
    заданном порядке, ресурсные строки под каждой расценкой и шапка с
    реквизитами. Раскладка колонок ведомости до первого живого импорта в
    ГРАНД-Смету остаётся неподтверждённой, и об этом сказано здесь, а не внутри
    файла: лишняя строка сбила бы разбор заголовка.
  */
  const billPath = outPath.replace(/\.md$/, "-vor.csv");
  const estimatePath = outPath.replace(/\.md$/, "-smeta.csv");
  const formPath = outPath.replace(/\.md$/, "-lsr.csv");
  writeFileSync(billPath, toBillOfWorkCsv(document), "utf8");
  writeFileSync(estimatePath, toLocalEstimateCsv(document), "utf8");
  writeFileSync(
    formPath,
    toLocalEstimateFormCsv({
      document,
      number: "01-01-01",
      constructionName: document.title,
      objectName: document.title,
      basis: "Ведомость объёмов работ, собранная по документации закупки",
      indexLetter: base.info.splitForm?.indexLetter,
      wageAct: base.info.splitForm?.wageAct,
    }),
    "utf8",
  );
  console.log(`Ведомость объёмов работ: ${billPath}`);
  console.log(`Рабочая таблица сметы: ${estimatePath}`);
  console.log(`Локальный сметный расчёт по форме 421/пр: ${formPath}`);
  console.log(
    "  Раскладка колонок ведомости под импорт в ГРАНД-Смету не подтверждена живым импортом.",
  );

  if (problems.length > 0) process.exitCode = 1;
}

// Скрипт собирается в CJS, поэтому верхнеуровневый `await` недоступен:
// промах ловим здесь, иначе он уйдёт в unhandled rejection.
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
