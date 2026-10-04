import type {
  BillOfWorkItem,
  BillOfWorkSection,
  EstimateParameters,
  NormRecord,
  OverheadRate,
  ResourcePrice,
  WageAnchor,
} from "@/domain/estimate/types";
import type { EstimatePriceBook } from "@/domain/estimate/calculate";

/**
 * Общие данные тестов сметного расчёта.
 *
 * Здесь нет выдуманных значений. Каждая норма и каждая цена скопирована из
 * реальной выгрузки ФСНБ-2022 редакции 12.08.2026 (приказ Минстроя России
 * № 527/пр), которая лежит в `data/fsnb/raw/xml/`. Тесты, построенные на этих
 * числах, проверяют не «работает ли арифметика вообще», а совпадает ли расчёт с
 * тем, что записано в открытых данных.
 */

/** Реквизиты ценовой зоны, по которой сверялись ставки. */
export const AMUR_ZONE = {
  region: "Амурская область",
  zone: "Амурская область (1 зона)",
  period: "3 квартал 2026 г.",
} as const;

const REGISTRY_SOURCE =
  "Реестр ставок оплаты труда рабочих (RimWorkerSalaryRegistry), Амурская область (1 зона), 3 квартал 2026 г.";

const FSCSR_SOURCE =
  "ФСЦСР, «Оплата труда машинистов» ÷ «Трудозатраты машинистов», Амурская область (1 зона), 3 квартал 2026 г.";

/**
 * Опорные точки тарифной шкалы Амурской области, 1 зона, 3 квартал 2026.
 *
 * Два открытых источника одной зоны за один квартал. Реестр ставок рабочих
 * (`RimWorkerSalaryRegistry?periodId=427&priceZoneId=282`) возвращает 25 строк —
 * коды от «1-100-10» до «1-100-34», то есть разряды от 1,0 до 3,4, и этого не
 * хватает: уже первая норма ГЭСН требует разряд 3,8. Поле `total` в том же
 * ответе равно 186, но пагинация не заявлена и других разрядов для этой зоны и
 * периода ответ не содержит. Недостающие разряды достаются из колонки оплаты
 * труда машинистов в текущих ценах ФСЦСР.
 *
 * Пересечение источников сходится до копейки: разряд 2,0 даёт 598,26 ₽ и там,
 * и там; разряд 3,0 — 653,14 ₽. Повторы оставлены намеренно: `buildWageScale`
 * обязан схлопнуть их сам.
 */
export const AMUR_WAGE_ANCHORS: readonly WageAnchor[] = [
  { rank: 1.0, salary: 548.86, source: REGISTRY_SOURCE },
  { rank: 1.1, salary: 553.8, source: REGISTRY_SOURCE },
  { rank: 1.2, salary: 558.74, source: REGISTRY_SOURCE },
  { rank: 1.3, salary: 563.68, source: REGISTRY_SOURCE },
  { rank: 1.4, salary: 568.62, source: REGISTRY_SOURCE },
  { rank: 1.5, salary: 573.56, source: REGISTRY_SOURCE },
  { rank: 1.6, salary: 578.5, source: REGISTRY_SOURCE },
  { rank: 1.7, salary: 583.44, source: REGISTRY_SOURCE },
  { rank: 1.8, salary: 588.38, source: REGISTRY_SOURCE },
  { rank: 1.9, salary: 593.32, source: REGISTRY_SOURCE },
  { rank: 2.0, salary: 598.26, source: REGISTRY_SOURCE },
  { rank: 2.1, salary: 603.75, source: REGISTRY_SOURCE },
  { rank: 2.2, salary: 609.23, source: REGISTRY_SOURCE },
  { rank: 2.3, salary: 614.72, source: REGISTRY_SOURCE },
  { rank: 2.4, salary: 620.21, source: REGISTRY_SOURCE },
  { rank: 2.5, salary: 625.7, source: REGISTRY_SOURCE },
  { rank: 2.6, salary: 631.19, source: REGISTRY_SOURCE },
  { rank: 2.7, salary: 636.68, source: REGISTRY_SOURCE },
  { rank: 2.8, salary: 642.17, source: REGISTRY_SOURCE },
  { rank: 2.9, salary: 647.65, source: REGISTRY_SOURCE },
  { rank: 3.0, salary: 653.14, source: REGISTRY_SOURCE },
  { rank: 3.1, salary: 661.38, source: REGISTRY_SOURCE },
  { rank: 3.2, salary: 669.61, source: REGISTRY_SOURCE },
  { rank: 3.3, salary: 677.84, source: REGISTRY_SOURCE },
  { rank: 3.4, salary: 686.08, source: REGISTRY_SOURCE },
  { rank: 2.0, salary: 598.26, source: FSCSR_SOURCE },
  { rank: 3.0, salary: 653.14, source: FSCSR_SOURCE },
  { rank: 4.0, salary: 735.47, source: FSCSR_SOURCE },
  { rank: 5.0, salary: 845.24, source: FSCSR_SOURCE },
  { rank: 6.0, salary: 987.95, source: FSCSR_SOURCE },
  { rank: 6.5, salary: 1020.88, source: FSCSR_SOURCE },
  { rank: 7.0, salary: 1053.81, source: FSCSR_SOURCE },
  { rank: 8.0, salary: 1125.16, source: FSCSR_SOURCE },
  { rank: 8.7, salary: 1178.95, source: FSCSR_SOURCE },
  { rank: 9.0, salary: 1202.0, source: FSCSR_SOURCE },
];

/**
 * Только целые разряды — набор для проверки самой модели.
 *
 * Тарифные коэффициенты, которые получаются из этих девяти точек: 1,000; 1,090;
 * 1,190; 1,340; 1,540; 1,800; 1,920; 2,050; 2,190. Дробные разряды лежат строго
 * на прямой между целыми, поэтому интерполяция коэффициентов обязана
 * воспроизвести наблюдаемые значения из открытых данных точно: разряд 3,4 →
 * 686,08 ₽, разряд 6,5 → 1 020,88 ₽, разряд 8,7 → 1 178,95 ₽.
 */
export const AMUR_INTEGER_ANCHORS: readonly WageAnchor[] = [
  { rank: 1.0, salary: 548.86, source: REGISTRY_SOURCE },
  { rank: 2.0, salary: 598.26, source: REGISTRY_SOURCE },
  { rank: 3.0, salary: 653.14, source: REGISTRY_SOURCE },
  { rank: 4.0, salary: 735.47, source: FSCSR_SOURCE },
  { rank: 5.0, salary: 845.24, source: FSCSR_SOURCE },
  { rank: 6.0, salary: 987.95, source: FSCSR_SOURCE },
  { rank: 7.0, salary: 1053.81, source: FSCSR_SOURCE },
  { rank: 8.0, salary: 1125.16, source: FSCSR_SOURCE },
  { rank: 9.0, salary: 1202.0, source: FSCSR_SOURCE },
];

/**
 * Норма 01-01-001-01. Труд рабочих записан средним разрядом «1-100-38».
 *
 * Полное наименование собрано ровно так, как это делает парсер: начало из
 * `<NameGroup BeginName="...">` плюс окончание из `<Work EndName="...">`. Начало
 * у таблицы одно на 24 строки и заканчивается двоеточием, поэтому «15 м3»
 * оказывается его продолжением, а не отдельным заголовком.
 *
 * По ней проверяется тождество затрат труда машинистов: бульдозер 1,6 маш.-ч со
 * звеном 1,00 плюс драглайн 1,6 маш.-ч со звеном 3,00 дают ровно 6,4 чел.-ч —
 * значение служебного кода «2».
 */
export const NORM_DRAGLINE_15: NormRecord = {
  code: "01-01-001-01",
  tableCode: "01-01-001",
  fullName:
    'Разработка грунта в отвал экскаваторами "драглайн" одноковшовыми электрическими ' +
    "шагающими при работе на гидроэнергетическом строительстве с ковшом вместимостью: " +
    "15 м3, группа грунтов 1",
  endName: "15 м3, группа грунтов 1",
  unit: "1000 м3",
  collectionCode: "01",
  collectionName: "Земляные работы",
  sectionName:
    "МЕХАНИЗИРОВАННАЯ РАЗРАБОТКА ГРУНТОВ (ЭКСКАВАТОРАМИ, СКРЕПЕРАМИ, БУЛЬДОЗЕРАМИ, " +
    "ГРЕЙДЕРАМИ, МЕТОДОМ ГИДРОМЕХАНИЗАЦИИ И ПР.)",
  subsectionName: "РАЗРАБОТКА ГРУНТА ЭКСКАВАТОРАМИ В ОТВАЛ",
  baseType: "ГЭСН",
  content: [
    "Разработка грунта навымет.",
    "Устройство и содержание водоотводных канав или ограждающих валиков.",
    "Вспомогательные работы, связанные с перемещением экскаватора из забоя в забой.",
  ],
  resources: [
    {
      code: "1-100-38",
      kind: "LABOUR",
      name: "Средний разряд работы 3,8",
      quantity: 1.54,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "2",
      kind: "MACHINIST_HOURS",
      name: "",
      quantity: 6.4,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.01.01-035",
      kind: "MACHINE",
      name: "Бульдозеры, мощность 79 кВт (108 л.с.)",
      quantity: 1.6,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.01.05-128",
      kind: "MACHINE",
      name:
        'Экскаваторы одноковшовые электрические шагающие с рабочим оборудованием "драглайн", емкость ковша 15 м3',
      quantity: 1.6,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
  ],
  overheadRef: "Пр/812-001.1",
  profitRef: "Пр/774-001.1",
};

/**
 * Норма 01-01-111-01, «Планировка вручную: дна и откосов выемок каналов,
 * группа грунтов 1». Единственный ресурс — труд рабочих: ни машин, ни
 * материалов. Самая простая норма для проверки начисления оплаты труда.
 */
export const NORM_MANUAL_GRADING: NormRecord = {
  code: "01-01-111-01",
  tableCode: "01-01-111",
  fullName: "Планировка вручную: дна и откосов выемок каналов, группа грунтов 1",
  endName: "дна и откосов выемок каналов, группа грунтов 1",
  unit: "1000 м2",
  collectionCode: "01",
  collectionName: "Земляные работы",
  sectionName:
    "МЕХАНИЗИРОВАННАЯ РАЗРАБОТКА ГРУНТОВ (ЭКСКАВАТОРАМИ, СКРЕПЕРАМИ, БУЛЬДОЗЕРАМИ, " +
    "ГРЕЙДЕРАМИ, МЕТОДОМ ГИДРОМЕХАНИЗАЦИИ И ПР.)",
  subsectionName:
    "РАЗРАБОТКА ГРУНТА И УСТРОЙСТВО ДРЕНАЖЕЙ В ВОДОХОЗЯЙСТВЕННОМ СТРОИТЕЛЬСТВЕ",
  baseType: "ГЭСН",
  content: [
    "Срезка и планировка поверхности с проверкой по шаблону.",
    "Перекидка грунта по откосу на дно выемки.",
  ],
  resources: [
    {
      code: "1-100-30",
      kind: "LABOUR",
      name: "Средний разряд работы 3,0",
      quantity: 86.5,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
  ],
  overheadRef: "Пр/812-001.1",
  profitRef: "Пр/774-001.1",
};

/**
 * Норма 01-01-129-11, закрытый дренаж вручную из полиэтиленовых труб диаметром
 * 100 мм. Самая насыщенная из трёх:
 *
 * — труд рабочих записан разрядными строками «2-100-*», а не средним разрядом,
 *   и рядом стоит итоговый код «1» = 203,11 = 11,74 + 129,57 + 61,80;
 * — четыре машины, по которым код «2» = 1,74 = 1,30 + 0,26 + 0 + 0,18;
 * — три материала с ценой в ФСБЦ;
 * — два AbstractResource без конкретной марки: у первого расход «П» (по
 *   проекту), у второго — число, но цены на код группы не существует.
 *
 * Именно эти два AbstractResource обязаны попасть в пробелы, а не в ноль.
 *
 * Таблица 01-01-129 содержит две группы наименований: строки 01–10 — дренаж из
 * керамических труб, строки 11–12 — из полиэтиленовых. Начало наименования
 * берётся из `<NameGroup BeginName>`, а не из заголовка таблицы, иначе одиннадцатая
 * строка оказалась бы керамической.
 */
export const NORM_DRAINAGE_100: NormRecord = {
  code: "01-01-129-11",
  tableCode: "01-01-129",
  fullName: "Устройство закрытого дренажа вручную из полиэтиленовых труб диаметром: 100 мм",
  endName: "100 мм",
  unit: "1000 м",
  collectionCode: "01",
  collectionName: "Земляные работы",
  sectionName:
    "МЕХАНИЗИРОВАННАЯ РАЗРАБОТКА ГРУНТОВ (ЭКСКАВАТОРАМИ, СКРЕПЕРАМИ, БУЛЬДОЗЕРАМИ, " +
    "ГРЕЙДЕРАМИ, МЕТОДОМ ГИДРОМЕХАНИЗАЦИИ И ПР.)",
  subsectionName:
    "РАЗРАБОТКА ГРУНТА И УСТРОЙСТВО ДРЕНАЖЕЙ В ВОДОХОЗЯЙСТВЕННОМ СТРОИТЕЛЬСТВЕ",
  baseType: "ГЭСН",
  content: [
    "Укладка выравнивающего слоя песка с трамбованием.",
    "Укладка геотекстильного полотна.",
    "Укладка щебня.",
    "Укладка дренажных труб.",
    "Засыпка щебнем.",
    "Оборачивание слоя щебня геотекстильным полотном с нахлестом.",
    "Укладка слоя песка.",
  ],
  resources: [
    {
      code: "1",
      kind: "WORKER_HOURS_TOTAL",
      name: "",
      quantity: 203.11,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "2-100-02",
      kind: "LABOUR",
      name: "Рабочий 2 разряда",
      quantity: 11.74,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "2-100-03",
      kind: "LABOUR",
      name: "Рабочий 3 разряда",
      quantity: 129.57,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "2-100-04",
      kind: "LABOUR",
      name: "Рабочий 4 разряда",
      quantity: 61.8,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "2",
      kind: "MACHINIST_HOURS",
      name: "",
      quantity: 1.74,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.01.01-034",
      kind: "MACHINE",
      name: "Бульдозеры, мощность 59 кВт (80 л.с.)",
      quantity: 1.3,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.05.05-015",
      kind: "MACHINE",
      name: "Краны на автомобильном ходу, грузоподъемность 16 т",
      quantity: 0.26,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.08.09-024",
      kind: "MACHINE",
      name: "Трамбовки пневматические при работе от стационарного компрессора",
      quantity: 5.4,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.14.02-001",
      kind: "MACHINE",
      name: "Автомобили бортовые, грузоподъемность до 5 т",
      quantity: 0.18,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "01.7.12.05-0131",
      kind: "MATERIAL",
      name:
        "Геополотно нетканое полипропиленовое, иглопробивное, прочность при растяжении 5,6/3,6 кН/м, поверхностная плотность 150 г/м2",
      quantity: 2140,
      unit: "м2",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "01.8.01.08-0004",
      kind: "MATERIAL",
      name: "Щебень из пеностекла, насыпная плотность 170-180 кг/м3, фракция 5-20 мм",
      quantity: 160,
      unit: "м3",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "02.3.01.02-1118",
      kind: "MATERIAL",
      name: "Песок природный для строительных работ II класс, средний",
      quantity: 220,
      unit: "м3",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "24.3.03.05",
      kind: "MATERIAL",
      name: "Муфта полиэтиленовая для труб дренажных",
      quantity: 0,
      unit: "шт",
      quantityNote: "П",
      projectSpecific: true,
      technologyGroup: "34.04.013",
    },
    {
      code: "24.3.03.06",
      kind: "MATERIAL",
      name: "Труба дренажная полиэтиленовая, гофрированная",
      quantity: 1025,
      unit: "м",
      quantityNote: null,
      projectSpecific: true,
      technologyGroup: "33.07.203",
    },
  ],
  overheadRef: "Пр/812-001.1",
  profitRef: "Пр/774-001.1",
};

/**
 * Норма 01-01-050-01, укрепление откосов геотехнической сеткой. Самая полная из
 * четырёх: в ней встречаются все четыре способа, которыми ФСНБ-2022 оставляет
 * стоимость неопределённой.
 *
 * — `<Resource Code="01.7.15.01-0040" ... Quantity="П" />`: расход «по проекту».
 *   Цена на анкер в ФСБЦ есть — 62 413,13 ₽/т, — но расхода нет, поэтому
 *   стоимость неопределима. Всего таких строк в выгрузке 2 005: 1 819 в
 *   «ГЭСН.xml», 184 в «ГЭСНр.xml», 2 в «ГЭСНм.xml».
 * — `<AbstractResource Code="01.7.12.16" ... Quantity="1428.3"
 *   TechnologyGroups="54.08.005" />`: расход есть, а марки нет — цена
 *   выбирается проектом.
 * — `<NameGroup BeginName="">`: начало наименования пустое, поэтому полное имя
 *   строки совпадает с EndName. Так устроена не одна эта таблица, и разбор
 *   обязан это пережить.
 * — три машины из шести есть в текущих ценах зоны, три приходится брать из базы
 *   01.01.2022: расчёт смешивает источники и помечает каждый переход.
 *
 * Тождество затрат труда машинистов сходится и здесь: служебный код «2» = 19,64
 * = 0,3 + 16,83 + 0,05 + 0 + 2,4 + 0,06 — сумма (маш.-ч × звено) по шести
 * машинам. Трамбовки электрические идут со звеном 0,00: это машина без
 * машиниста.
 */
export const NORM_SLOPE_REINFORCEMENT: NormRecord = {
  code: "01-01-050-01",
  tableCode: "01-01-050",
  fullName: "Укрепление откосов с использованием сетки геотехнической пластиковой противоэрозийной",
  endName: "Укрепление откосов с использованием сетки геотехнической пластиковой противоэрозийной",
  unit: "1000 м2",
  collectionCode: "01",
  collectionName: "Земляные работы",
  sectionName:
    "МЕХАНИЗИРОВАННАЯ РАЗРАБОТКА ГРУНТОВ (ЭКСКАВАТОРАМИ, СКРЕПЕРАМИ, БУЛЬДОЗЕРАМИ, " +
    "ГРЕЙДЕРАМИ, МЕТОДОМ ГИДРОМЕХАНИЗАЦИИ И ПР.)",
  subsectionName: "РАЗРАБОТКА ВЫЕМОК И ОТСЫПКА НАСЫПЕЙ ДЛЯ ЖЕЛЕЗНЫХ И АВТОМОБИЛЬНЫХ ДОРОГ",
  baseType: "ГЭСН",
  content: [
    "Разравнивание и планировка поверхности укрепляемого откоса экскаватором.",
    "Устройство траншей вдоль верхней и нижней бровки откоса экскаватором.",
    "Выравнивание (окончательная разработка) траншеи вручную.",
    "Отсыпка и распределение растительного грунта по поверхности откоса экскаватором.",
    "Окончательная планировка и разравнивание растительного грунта по откосу вручную.",
    "Укладка противоэрозийного материала вдоль уклона по поверхности откоса с устройством нахлеста смежных полотен.",
    "Закрепление полотен матов в местах нахлеста анкерами.",
    "Обратная засыпка грунтом концов полотен матов в верхней и нижней траншее.",
    "Трамбование засыпанного в траншее грунта.",
    "Распределение по поверхности матов семян трав.",
    "Повторная отсыпка и распределение растительного грунта по поверхности откоса экскаватором.",
    "Последующее заполнение ячеек противоэрозийного материала растительным грунтом.",
    "Уплотнение поверхности откоса ручными трамбовками.",
    "Полив растительного грунта водой.",
  ],
  resources: [
    {
      code: "1-100-29",
      kind: "LABOUR",
      name: "Средний разряд работы 2,9",
      quantity: 123.36,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "2",
      kind: "MACHINIST_HOURS",
      name: "",
      quantity: 19.64,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.01.01-035",
      kind: "MACHINE",
      name: "Бульдозеры, мощность 79 кВт (108 л.с.)",
      quantity: 0.3,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.01.05-106",
      kind: "MACHINE",
      name:
        "Экскаваторы одноковшовые дизельные на пневмоколесном ходу, объем ковша 0,25 м3",
      quantity: 16.83,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.05.05-015",
      kind: "MACHINE",
      name: "Краны на автомобильном ходу, грузоподъемность 16 т",
      quantity: 0.05,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.08.09-025",
      kind: "MACHINE",
      name: "Трамбовки электрические",
      quantity: 3.42,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.13.01-038",
      kind: "MACHINE",
      name: "Машины поливомоечные, вместимость цистерны 6 м3",
      quantity: 2.4,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "91.14.02-001",
      kind: "MACHINE",
      name: "Автомобили бортовые, грузоподъемность до 5 т",
      quantity: 0.06,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "01.7.03.01-0001",
      kind: "MATERIAL",
      name: "Вода",
      quantity: 10,
      unit: "м3",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      // Расход «П» — по проекту. Цена в ФСБЦ есть, количества нет.
      code: "01.7.15.01-0040",
      kind: "MATERIAL",
      name: "Анкеры забивные из арматурной стали A-I, диаметр 12 мм, длина 900 мм",
      quantity: 0,
      unit: "т",
      quantityNote: "П",
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "16.2.01.02-0001",
      kind: "MATERIAL",
      name: "Земля растительная",
      quantity: 120,
      unit: "м3",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "16.2.02.07-0161",
      kind: "MATERIAL",
      name: "Семена газонных трав (смесь Городская)",
      quantity: 20,
      unit: "кг",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      // AbstractResource: код группы, а не конкретной марки.
      code: "01.7.12.16",
      kind: "MATERIAL",
      name: "Сетка геотехническая пластиковая противоэрозионная",
      quantity: 1428.3,
      unit: "м2",
      quantityNote: null,
      projectSpecific: true,
      technologyGroup: "54.08.005",
    },
  ],
  overheadRef: "Пр/812-001.1",
  profitRef: "Пр/774-001.1",
};

/**
 * Норма 01-01-001-01 книги ГЭСНп — пусконаладка синхронного генератора.
 *
 * Зачем она в наборе, хотя считать по ней нечего. Это единственная запись,
 * которая показывает две настоящие границы автоматизации, а не придуманные:
 *
 * — Тот же код «01-01-001-01» в ГЭСН означает экскаватор-драглайн
 *   (`NORM_DRAGLINE_15`), в ГЭСНм — токарный станок, в ГЭСНмр — замок двери
 *   шахты лифта. Подбор без книги возвращает одну из четырёх работ молча.
 *
 * — Труд здесь записан не разрядами рабочих, а должностями специалистов:
 *   «3-100-02» — техник II категории, «3-200-01» — инженер I категории,
 *   «3-200-03» — инженер III категории. Перепись всей выгрузки даёт семь таких
 *   кодов и 6 183 строки: 3-100-01/02 (техник I и II категории), 3-200-01/02/03
 *   (инженер I, II и III категории), 3-300-01 (ведущий инженер), 3-400-01
 *   (главный технолог). Они встречаются в 2 565 работах ГЭСНп из 2 605, в 53
 *   работах ГЭСНм и в 35 работах ГЭСНмр.
 *
 * Ставки для должностей взять неоткуда. Реестр ставок рабочих
 * (`RimWorkerSalaryRegistry`) содержит только разряды 1,0–3,4, а колонка
 * «Оплата труда машинистов» в ФСЦСР описывает звенья машин, а не инженеров.
 * Поэтому расчёт обязан выдать по каждой такой строке пробел NO_WAGE и ноль в
 * стоимости: итог занижен, но это видно. Молча отнести код к неопознанным
 * нельзя — тогда целая книга норм исчезает из сметы без объяснения.
 *
 * В ГЭСНп вообще нет ни машин, ни материалов: 0 из 2 605 работ. Стоимость
 * пусконаладки целиком состоит из оплаты труда, и значит отсутствие ставок ИТР
 * обнуляет такую смету полностью, а не частично.
 *
 * Итоговая строка «1» = 45,9 чел.-ч равна сумме всех четырёх разрядных строк:
 * 4,59 + 9,18 + 22,95 + 9,18. Тождество проверено по всем пяти книгам: из
 * 6 731 работы, где встречается код «1», оно выполняется в 6 731 — расхождений
 * нет ни одного.
 *
 * Уровень «Отдел» («СИНХРОННЫЕ ГЕНЕРАТОРЫ И ВОЗБУДИТЕЛИ») в `NormRecord` не
 * попадает: парсер берёт раздел и подраздел, а в ГЭСНп подраздела нет, поэтому
 * `subsectionName` пуст.
 */
export const NORM_PUSKONALADKA_GENERATOR: NormRecord = {
  code: "01-01-001-01",
  tableCode: "01-01-001",
  fullName: "Генератор синхронный (компенсатор) напряжением: до 1 кВ, мощностью до 100 кВт",
  endName: "до 1 кВ, мощностью до 100 кВт",
  unit: "шт",
  collectionCode: "01",
  collectionName: "Электротехнические устройства",
  sectionName: "ГЕНЕРАТОРЫ",
  subsectionName: "",
  baseType: "ГЭСНп",
  content: [],
  resources: [
    {
      code: "1",
      kind: "WORKER_HOURS_TOTAL",
      name: "",
      quantity: 45.9,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "2-100-05",
      kind: "LABOUR",
      name: "Рабочий 5 разряда",
      quantity: 4.59,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "3-100-02",
      kind: "LABOUR",
      name: "Техник II категории",
      quantity: 9.18,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "3-200-01",
      kind: "LABOUR",
      name: "Инженер I категории",
      quantity: 22.95,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
    {
      code: "3-200-03",
      kind: "LABOUR",
      name: "Инженер III категории",
      quantity: 9.18,
      unit: "чел.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
  ],
  overheadRef: "Пр/812-083.0",
  profitRef: "Пр/774-083.0",
};

/**
 * Норма дноуглубления — та, у которой цена ресурса в базе равна нулю.
 *
 * ГЭСН 44-04-180-01, единственный ресурс — землесос 91.20.12-101 с расходом
 * 1,38 маш.-ч. В «ФСБЦ_Маш.xml» у этой машины `SalaryMach="0"` и
 * `PriceCostWithoutSalary="0"`, то есть полная стоимость маш.-ч по базе
 * 01.01.2022 равна 0 ₽. Всего таких машин в книге десять, девять из них —
 * землесосы папильонажные рефулерные, и внутри `<Work>` книги «ГЭСН.xml» они
 * встречаются 63 раза. Значит это не опечатка одной строки, а свойство
 * справочника: цена не задана, и расчёт обязан показать это, а не напечатать
 * 0 ₽ со ссылкой на базу.
 *
 * Рабочих в норме нет вовсе — ни итоговой строки «1», ни разрядных. Поэтому
 * позиция целиком оценивается стоимостью машины, и при нулевой цене её
 * прямые затраты, фонд оплаты труда, накладные расходы и прибыль равны нулю.
 *
 * Запись получена прогоном `parseNormsXml` по настоящей выгрузке
 * «ГЭСН.xml» (30 028 работ) и сверена с XML, а не переписана от руки.
 */
export const NORM_DREDGER_800: NormRecord = {
  code: "44-04-180-01",
  tableCode: "44-04-180",
  fullName:
    "Разработка грунта самоходными свайно-папильонажными земснарядами с фрезерным разрыхлителем, мощностью привода фрезы 800 кВт в грунтах группы: 1",
  endName: "1",
  unit: "1000 м3",
  collectionCode: "44",
  collectionName: "Подводно-строительные (водолазные) работы",
  sectionName:
    "ДНОУГЛУБИТЕЛЬНЫЕ РАБОТЫ С ПРИМЕНЕНИЕМ СВАЙНО-ПАПИЛЬОНАЖНЫХ ЗЕМСНАРЯДОВ С ФРЕЗЕРНЫМ РАЗРЫХЛИТЕЛЕМ",
  subsectionName: "",
  baseType: "ГЭСН",
  content: ["Разработка грунта.", "Завозка, перекладка и сбор якорей."],
  resources: [
    {
      code: "91.20.12-101",
      kind: "MACHINE",
      name: "Землесосы папильонажные рефулерные самоходные с фрезерным разрыхлителем, мощность привода фрезы 800 кВт",
      quantity: 1.38,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
  ],
  overheadRef: "Пр/812-038.0",
  profitRef: "Пр/774-038.0",
};

/**
 * Цены базы ФСБЦ на уровне 01.01.2022 — ровно те, что лежат в выгрузке.
 *
 * Полная стоимость маш.-ч машины собрана как `PriceCostWithoutSalary +
 * SalaryMach × LabourMach`, а `machinistSalary` — это уже произведение, то есть
 * оплата всего звена за один машино-час. Две машины подтверждают разницу:
 * бульдозер 79 кВт со звеном 1,00 даёт 451,93 ₽, шагающий драглайн со звеном
 * 3,00 — 5 077,35 ₽.
 *
 * Последняя строка намеренно нулевая: в книге «ФСБЦ_Маш.xml» десять машин
 * имеют полную цену 0 ₽, и землесос 91.20.12-101 — одна из них.
 */
export const BASE_PRICES: readonly ResourcePrice[] = [
  {
    code: "91.01.01-035",
    name: "Бульдозеры, мощность 79 кВт (108 л.с.)",
    unit: "маш.-ч",
    price: 1339.47,
    machinistSalary: 451.93,
    machinistHours: 1,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "91.01.05-128",
    name: 'Экскаваторы одноковшовые электрические шагающие "драглайн", емкость ковша 15 м3',
    unit: "маш.-ч",
    price: 88134.75,
    machinistSalary: 5077.35,
    machinistHours: 3,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "91.01.01-034",
    name: "Бульдозеры, мощность 59 кВт (80 л.с.)",
    unit: "маш.-ч",
    price: 1214.81,
    machinistSalary: 386.65,
    machinistHours: 1,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "91.05.05-015",
    name: "Краны на автомобильном ходу, грузоподъемность 16 т",
    unit: "маш.-ч",
    price: 1619.63,
    machinistSalary: 451.93,
    machinistHours: 1,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "91.08.09-024",
    name: "Трамбовки пневматические при работе от стационарного компрессора",
    unit: "маш.-ч",
    price: 13.78,
    machinistSalary: 0,
    machinistHours: 0,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "91.14.02-001",
    name: "Автомобили бортовые, грузоподъемность до 5 т",
    unit: "маш.-ч",
    price: 814.35,
    machinistSalary: 336.43,
    machinistHours: 1,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "91.01.05-106",
    name: "Экскаваторы одноковшовые дизельные на пневмоколесном ходу, объем ковша 0,25 м3",
    unit: "маш.-ч",
    price: 1187.02,
    machinistSalary: 386.65,
    machinistHours: 1,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    // Price SalaryMach="0" LabourMach="0": машина без машиниста. В норме
    // 01-01-050-01 она даёт 3,42 маш.-ч и ноль человеко-часов.
    code: "91.08.09-025",
    name: "Трамбовки электрические",
    unit: "маш.-ч",
    price: 12.06,
    machinistSalary: 0,
    machinistHours: 0,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "91.13.01-038",
    name: "Машины поливомоечные, вместимость цистерны 6 м3",
    unit: "маш.-ч",
    price: 1379.57,
    machinistSalary: 336.43,
    machinistHours: 1,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "01.7.12.05-0131",
    name: "Геополотно нетканое полипропиленовое, 150 г/м2",
    unit: "м2",
    price: 37.97,
    machinistSalary: null,
    machinistHours: null,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "01.8.01.08-0004",
    name: "Щебень из пеностекла, фракция 5-20 мм",
    unit: "м3",
    price: 4876.23,
    machinistSalary: null,
    machinistHours: null,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "02.3.01.02-1118",
    name: "Песок природный для строительных работ II класс, средний",
    unit: "м3",
    price: 565.2,
    machinistSalary: null,
    machinistHours: null,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "01.7.03.01-0001",
    name: "Вода",
    unit: "м3",
    price: 35.71,
    machinistSalary: null,
    machinistHours: null,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    // Цена есть, а расхода в норме 01-01-050-01 нет: Quantity="П". Строка
    // оставлена в справочнике намеренно — она доказывает, что пометка
    // QUANTITY_BY_PROJECT ставится из-за неизвестного количества, а не из-за
    // неизвестной цены.
    code: "01.7.15.01-0040",
    name: "Анкеры забивные из арматурной стали A-I, диаметр 12 мм, длина 900 мм",
    unit: "т",
    price: 62413.13,
    machinistSalary: null,
    machinistHours: null,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "16.2.01.02-0001",
    name: "Земля растительная",
    unit: "м3",
    price: 1062.45,
    machinistSalary: null,
    machinistHours: null,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    code: "16.2.02.07-0161",
    name: "Семена газонных трав (смесь Городская)",
    unit: "кг",
    price: 149.15,
    machinistSalary: null,
    machinistHours: null,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
  {
    // Полная цена 0 ₽ — не округление, а буквальное значение выгрузки:
    // `SalaryMach="0"` и `PriceCostWithoutSalary="0"`. Такую строку расчёт
    // обязан показать как пробел, потому что ноль здесь означает «цена не
    // задана», а не «машина бесплатна».
    code: "91.20.12-101",
    name: "Землесосы папильонажные рефулерные самоходные с фрезерным разрыхлителем, мощность привода фрезы 800 кВт",
    unit: "маш.-ч",
    price: 0,
    machinistSalary: 0,
    machinistHours: 0,
    source: "BASE_2022",
    period: null,
    zone: null,
  },
];

/**
 * Текущие цены ФСЦСР по зоне, взятые из реальной выгрузки
 * `data/fsnb/raw/fscsr/amur-z1-3kv2026.xlsx`, лист «Машины и механизмы».
 *
 * Покрытие заведомо частичное, и это главная особенность данных: в выгрузке
 * 228 машин против 1 729 в «ФСБЦ_Маш.xml» и 1 062 материала против 45 847 в
 * «ФСБЦ_Мат&Оборуд.xml». Машин в 456 строках ровно вдвое больше кодов —
 * каждый код встречается дважды, и пары отличаются только колонкой
 * электроэнергии, поэтому дедупликация по коду ничего не теряет. Из четырёх
 * машин нормы 01-01-129-11 в текущих ценах есть три, бульдозера 59 кВт нет, а
 * из трёх материалов — ни одного. Значит расчёт обязан уметь смешивать текущую
 * цену зоны с базой 2022 года по индексу и помечать каждый такой переход.
 *
 * Колонка «Оплата труда машинистов» здесь уже дана за один маш.-ч: кран 16 т —
 * 987,95 ₽ при разряде 6, бортовой автомобиль — 735,47 ₽ при разряде 4. Ровно
 * эти значения легли в опорные точки тарифной шкалы.
 */
export const CURRENT_PRICES: readonly ResourcePrice[] = [
  {
    code: "91.05.05-015",
    name: "Краны на автомобильном ходу, грузоподъемность 16 т",
    unit: "маш.-ч",
    price: 2216.55,
    machinistSalary: 987.95,
    machinistHours: 1,
    source: "CURRENT_ZONE",
    period: "3 квартал 2026 г.",
    zone: "Амурская область (1 зона)",
  },
  {
    code: "91.08.09-024",
    name: "Трамбовки пневматические при работе от стационарного компрессора",
    unit: "маш.-ч",
    price: 25.34,
    machinistSalary: 0,
    machinistHours: 0,
    source: "CURRENT_ZONE",
    period: "3 квартал 2026 г.",
    zone: "Амурская область (1 зона)",
  },
  {
    code: "91.14.02-001",
    name: "Автомобили бортовые, грузоподъемность до 5 т",
    unit: "маш.-ч",
    price: 813.59,
    machinistSalary: 735.47,
    machinistHours: 1,
    source: "CURRENT_ZONE",
    period: "3 квартал 2026 г.",
    zone: "Амурская область (1 зона)",
  },
];

/**
 * Параметры расчёта по умолчанию.
 *
 * Здесь намеренно нет ссылок на нормативные акты. Нормативы накладных расходов
 * и сметной прибыли (приказы Минстроя России № 812/пр и № 774/пр, на которые
 * указывают `overheadRef` и `profitRef` норм) и письма с индексами пересчёта
 * опубликованы только в PDF и в выгрузку ФГИС ЦС не входят. Мы их не
 * разбирали, поэтому значения в тестах — произвольные входные данные, а не
 * данные из базы. Строка `source` говорит об этом прямо.
 *
 * Норма 01-01-001-01 несёт указатели «Пр/812-001.1» и «Пр/774-001.1»: по ним
 * сметчик найдёт нужный норматив сам, даже пока расчёт его не подставляет.
 */
export function makeParameters(patch: Partial<EstimateParameters> = {}): EstimateParameters {
  return {
    vatPercent: 20,
    indices: null,
    overhead: {
      overheadPercent: 105,
      profitPercent: 65,
      workType: "Земляные работы",
      source: "Значения заданы для теста; нормативные таблицы 812/пр и 774/пр в выгрузке ФГИС ЦС отсутствуют",
    },
    limited: {
      winterSurchargePercent: 0,
      temporaryStructuresPercent: 0,
      source: "Значения заданы для теста; ГСН 81-05-01 и 81-05-02 в выгрузке ФГИС ЦС отсутствуют",
    },
    ...patch,
  };
}

/** Позиция ведомости объёмов работ. */
export function makeBillItem(patch: Partial<BillOfWorkItem> = {}): BillOfWorkItem {
  return {
    id: "item-1",
    workName: "Разработка грунта экскаватором драглайн 15 м3, группа грунтов 1",
    quantity: 1200,
    quantityUnit: "м3",
    unitDivisor: 1000,
    normCode: "01-01-001-01",
    normBaseType: "ГЭСН",
    resourceCode: null,
    sourceQuote: "п. 3.2 ведомости объёмов работ: разработка грунта — 1 200 м3",
    sourceDocument: "Проектная документация, раздел 3",
    ...patch,
  };
}

/** Раздел ведомости объёмов работ. */
export function makeBillSection(
  title: string,
  items: readonly BillOfWorkItem[],
): BillOfWorkSection {
  return { title, items };
}

/**
 * Позиции ведомости объёмов работ, на которых сходятся тесты расчёта и тесты
 * схемы документа.
 *
 * Набор подобран не случайно: каждая позиция тянет за собой своё послабление в
 * данных, и вместе они закрывают все четыре случая, о которых обязан говорить
 * отчёт. Планировка вручную — позиция без единого пробела, эталон чистой
 * арифметики. Драглайн — труд машиниста и цены, которых нет в текущем уровне.
 * Дренаж — разряд 4, которого нет в реестре рабочих. Земснаряд — цена, которая
 * в базе равна нулю. Генератор из ГЭСНп — труд специалистов ИТР, ставки на
 * который в открытых данных нет, и заодно тот же код «01-01-001-01», что у
 * драглайна, но другая книга и другая работа.
 */

/** Эталонная позиция без пробелов: ручной труд, ставка известна, цены есть. */
export const BILL_GRADING: BillOfWorkItem = makeBillItem({
  id: "item-grading",
  workName: "Планировка вручную дна и откосов выемок каналов, группа грунтов 1",
  quantity: 800,
  quantityUnit: "м2",
  unitDivisor: 1000,
  normCode: "01-01-111-01",
  sourceQuote: "п. 2.1 ведомости объёмов работ: планировка откосов каналов — 800 м2",
  sourceDocument: "Проектная документация, раздел 2",
});

/** Разработка грунта драглайном: та же норма, что и в `makeBillItem`. */
export const BILL_DRAGLINE: BillOfWorkItem = makeBillItem();

/** Укрепление откосов сеткой: позиция с большим числом материалов без цены. */
export const BILL_SLOPE: BillOfWorkItem = makeBillItem({
  id: "item-slope",
  workName: "Укрепление откосов геотехнической сеткой",
  quantity: 2500,
  quantityUnit: "м2",
  unitDivisor: 1000,
  normCode: "01-01-050-01",
  sourceQuote: "п. 4.7 ведомости объёмов работ: укрепление откосов — 2 500 м2",
  sourceDocument: "Проектная документация, раздел 4",
});

/** Закрытый дренаж: разряд 4, которого нет в реестре рабочих ставок. */
export const BILL_DRAINAGE: BillOfWorkItem = makeBillItem({
  id: "item-drainage",
  workName: "Устройство закрытого дренажа из полиэтиленовых труб диаметром 100 мм",
  quantity: 500,
  quantityUnit: "м",
  unitDivisor: 1000,
  normCode: "01-01-129-11",
  sourceQuote: "п. 5.3 ведомости объёмов работ: закрытый дренаж — 500 м",
  sourceDocument: "Проектная документация, раздел 5",
});

/**
 * Дноуглубление земснарядом. 12 000 м3 при норме на 1000 м3 дают 12, а расход
 * 1,38 маш.-ч — 16,56 маш.-ч. Единственный ресурс нормы стоит в базе 0 ₽,
 * поэтому вся позиция оценивается нулём, и это обязано быть видно.
 */
export const BILL_DREDGER: BillOfWorkItem = makeBillItem({
  id: "item-dredger",
  workName: "Разработка грунта земснарядом с фрезерным разрыхлителем 800 кВт, группа грунтов 1",
  quantity: 12000,
  quantityUnit: "м3",
  unitDivisor: 1000,
  normCode: "44-04-180-01",
  sourceQuote: "п. 6.2 ведомости объёмов работ: дноуглубление — 12 000 м3",
  sourceDocument: "Проектная документация, раздел 6",
});

/**
 * Та же позиция, но норма взята из книги ГЭСНп: код «01-01-001-01» здесь
 * означает пусконаладку генератора, а не экскаватор-драглайн.
 */
export const BILL_GENERATOR: BillOfWorkItem = makeBillItem({
  id: "item-generator",
  workName: "Пусконаладка синхронного генератора до 1 кВ мощностью до 100 кВт",
  quantity: 1,
  quantityUnit: "шт",
  unitDivisor: 1,
  normCode: "01-01-001-01",
  normBaseType: "ГЭСНп",
  sourceQuote: "п. 1.1 ведомости объёмов работ: генератор синхронный — 1 шт",
  sourceDocument: "Проектная документация, раздел 1",
});

/** Все указатели, которые несут нормы этих фикстур. */
const FIXTURE_OVERHEAD_REFS = [
  "Пр/812-001.1",
  "Пр/812-038.0",
  "Пр/812-083.0",
  "Пр/812-104.1",
] as const;
const FIXTURE_PROFIT_REFS = [
  "Пр/774-001.1",
  "Пр/774-038.0",
  "Пр/774-083.0",
  "Пр/774-104.1",
] as const;

/**
 * Нормативы НР и СП по умолчанию — намеренно равны резерву документа
 * (105 % и 65 %).
 *
 * Так основной набор тестов проверяет арифметику и пометки, не завися от того,
 * какой норматив у какого вида работ: сами суммы остаются теми же, что и до
 * привязки, зато путь «взято по указателю расценки» проходится по-настоящему.
 * Для проверки самой привязки есть `VARIED_OVERHEAD_RATES`, где нормативы
 * разные, — именно там видно, что процент берётся из расценки, а не из
 * параметров документа.
 */
export const OVERHEAD_RATES: readonly OverheadRate[] = [
  ...FIXTURE_OVERHEAD_REFS.map((ref) => ({
    ref,
    percent: 105,
    workType: "Строительные работы",
    source: `Приказ Минстроя России № 812/пр, ${ref}`,
  })),
  ...FIXTURE_PROFIT_REFS.map((ref) => ({
    ref,
    percent: 65,
    workType: "Строительные работы",
    source: `Приказ Минстроя России № 774/пр, ${ref}`,
  })),
];

/**
 * Нормативы, различающиеся по виду работ.
 *
 * Земляные работы и пусконаладка не могут нести один норматив — ради этого
 * привязка и существует. Значения условные: открытые таблицы приказов 812/пр
 * и 774/пр в проект ещё не перенесены, поэтому здесь важны не сами числа, а то,
 * что они разные и что расчёт берёт их из расценки.
 */
export const VARIED_OVERHEAD_RATES: readonly OverheadRate[] = [
  {
    ref: "Пр/812-001.1",
    percent: 95,
    workType: "Земляные работы, выполняемые механизированным способом",
    source: "Приказ Минстроя России № 812/пр, таблица 1",
  },
  {
    ref: "Пр/774-001.1",
    percent: 50,
    workType: "Земляные работы, выполняемые механизированным способом",
    source: "Приказ Минстроя России № 774/пр, таблица 1",
  },
  {
    ref: "Пр/812-083.0",
    percent: 66,
    workType: "Пусконаладочные работы",
    source: "Приказ Минстроя России № 812/пр, таблица 83",
  },
  {
    ref: "Пр/774-083.0",
    percent: 40,
    workType: "Пусконаладочные работы",
    source: "Приказ Минстроя России № 774/пр, таблица 83",
  },
];

/** Карта нормативов по указателю — то, что ждёт книга цен. */
export function makeOverheadRates(
  rates: readonly OverheadRate[] = OVERHEAD_RATES,
): ReadonlyMap<string, OverheadRate> {
  return new Map(rates.map((rate) => [rate.ref, rate]));
}

/** Книга цен: база 2022, частичное текущее покрытие зоны, тарифная шкала. */
export function makePriceBook(
  wageScale: EstimatePriceBook["wageScale"],
  patch: Partial<EstimatePriceBook> = {},
): EstimatePriceBook {
  return {
    region: AMUR_ZONE.region,
    priceZone: AMUR_ZONE.zone,
    period: AMUR_ZONE.period,
    baseEdition: "ФСБЦ, уровень 01.01.2022, приказ Минстроя России № 527/пр от 12.08.2026",
    current: new Map(CURRENT_PRICES.map((price) => [price.code, price])),
    base: new Map(BASE_PRICES.map((price) => [price.code, price])),
    wageScale,
    overheadRates: makeOverheadRates(),
    ...patch,
  };
}

/**
 * Нормы по паре «книга + код» — простейший детерминированный подборщик для
 * тестов расчёта.
 *
 * Книга обязательна. Если позиция ведомости несёт только код и этот код
 * встречается в нескольких книгах, подборщик бросает исключение: тест, который
 * молча взял бы первую попавшуюся норму, проверял бы расчёт не той работы.
 */
export function makeResolver(
  norms: readonly NormRecord[],
): (item: BillOfWorkItem) => { norm: NormRecord; reasons: readonly string[] } | null {
  const byKey = new Map(norms.map((norm) => [`${norm.baseType}|${norm.code}`, norm]));
  const byCode = new Map<string, NormRecord[]>();
  for (const norm of norms) {
    const bucket = byCode.get(norm.code);
    if (bucket === undefined) byCode.set(norm.code, [norm]);
    else bucket.push(norm);
  }

  return (item) => {
    if (item.normCode === null) return null;

    if (item.normBaseType !== null) {
      const norm = byKey.get(`${item.normBaseType}|${item.normCode}`);
      if (norm === undefined) return null;
      return {
        norm,
        reasons: [`Код нормы ${norm.code} задан явно, книга ${norm.baseType}`],
      };
    }

    const candidates = byCode.get(item.normCode) ?? [];
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      const books = candidates.map((norm) => norm.baseType).join(", ");
      throw new Error(
        `Код ${item.normCode} есть в книгах ${books}: укажите normBaseType в позиции ведомости`,
      );
    }
    const only = candidates[0];
    if (only === undefined) return null;
    return {
      norm: only,
      reasons: [`Код нормы ${only.code} задан явно, книга ${only.baseType}`],
    };
  };
}

/**
 * Запись нормы только для подбора: наименования, код и реквизиты настоящие,
 * а состав работ и ресурсов пустые. Подбор читает исключительно наименование
 * и реквизиты сборника, поэтому платить за заполнение ресурсов в этих записях
 * нечем. В расчёт сметы такие нормы передавать нельзя — для него есть
 * `NORM_DRAGLINE_15`, `NORM_MANUAL_GRADING` и `NORM_DRAINAGE_100`.
 */
export function makeSearchNorm(
  fields: Pick<
    NormRecord,
    | "code"
    | "fullName"
    | "endName"
    | "unit"
    | "collectionCode"
    | "collectionName"
    | "baseType"
  > &
    Partial<Pick<NormRecord, "tableCode" | "sectionName" | "subsectionName">>,
): NormRecord {
  const parts = fields.code.split("-");
  return {
    tableCode: parts.length > 3 ? parts.slice(0, 3).join("-") : fields.code,
    sectionName: "",
    subsectionName: "",
    content: [],
    resources: [],
    overheadRef: null,
    profitRef: null,
    ...fields,
  };
}

/**
 * Начало наименования таблицы 01-01-001 книги ГЭСН. Оно одно на 24 строки и
 * заканчивается двоеточием: строки различаются только окончанием.
 */
const DRAGLINE_BEGIN =
  'Разработка грунта в отвал экскаваторами "драглайн" одноковшовыми электрическими ' +
  "шагающими при работе на гидроэнергетическом строительстве с ковшом вместимостью:";

const EARTHWORKS = {
  collectionCode: "01",
  collectionName: "Земляные работы",
  baseType: "ГЭСН",
} as const;

/**
 * Корпус норм для проверки подбора.
 *
 * Первые четыре записи — главный сюжет. Код «01-01-001-01» в выгрузке ФГИС ЦС
 * не уникален: он встречается в четырёх книгах и означает четыре разные работы.
 * Перепись всех пяти книг даёт 56 242 элемента Work, 53 228 различных кодов и
 * 2 784 кода, которые встречаются больше одного раза. Подбор, который хранит
 * нормы в словаре по коду, молча вернёт одну из четырёх — например, токарный
 * станок вместо экскаватора-драглайна. Поэтому эти четыре записи обязаны
 * возвращаться вместе, каждая со своим указанием на книгу.
 *
 * Пары «разработка грунта» и «разборка скального грунта» нужны, чтобы проверить
 * различающий бонус: без него обе нормы набирают одинаково по слову «грунт».
 */
export const SEARCH_NORMS: readonly NormRecord[] = [
  makeSearchNorm({
    ...EARTHWORKS,
    code: "01-01-001-01",
    fullName: `${DRAGLINE_BEGIN} 15 м3, группа грунтов 1`,
    endName: "15 м3, группа грунтов 1",
    unit: "1000 м3",
  }),
  makeSearchNorm({
    ...EARTHWORKS,
    code: "01-01-001-02",
    fullName: `${DRAGLINE_BEGIN} 15 м3, группа грунтов 2`,
    endName: "15 м3, группа грунтов 2",
    unit: "1000 м3",
  }),
  makeSearchNorm({
    ...EARTHWORKS,
    code: "01-01-001-07",
    fullName: `${DRAGLINE_BEGIN} 10 м3, группа грунтов 1`,
    endName: "10 м3, группа грунтов 1",
    unit: "1000 м3",
  }),
  makeSearchNorm({
    ...EARTHWORKS,
    code: "01-01-111-01",
    fullName: "Планировка вручную: дна и откосов выемок каналов, группа грунтов 1",
    endName: "дна и откосов выемок каналов, группа грунтов 1",
    unit: "1000 м2",
  }),
  makeSearchNorm({
    ...EARTHWORKS,
    code: "01-01-129-11",
    fullName: "Устройство закрытого дренажа вручную из полиэтиленовых труб диаметром: 100 мм",
    endName: "100 мм",
    unit: "1000 м",
  }),
  makeSearchNorm({
    ...EARTHWORKS,
    code: "01-02-072-01",
    fullName: "Разборка скального грунта бетоноломом (гидроклиньями)",
    endName: "Разборка скального грунта бетоноломом (гидроклиньями)",
    unit: "м3",
    sectionName:
      "ДРУГИЕ ВИДЫ ЗЕМЛЯНЫХ РАБОТ, ПОДГОТОВИТЕЛЬНЫЕ, СОПУТСТВУЮЩИЕ И УКРЕПИТЕЛЬНЫЕ РАБОТЫ",
    subsectionName: "РАЗРАБОТКА ВЕЧНОМЕРЗЛЫХ И СКАЛЬНЫХ ГРУНТОВ",
  }),
  makeSearchNorm({
    ...EARTHWORKS,
    code: "01-02-097-01",
    fullName: "Разборка навалов на уступах склонов, ширина уступа до 1 м",
    endName: "Разборка навалов на уступах склонов, ширина уступа до 1 м",
    unit: "м3",
    sectionName:
      "ДРУГИЕ ВИДЫ ЗЕМЛЯНЫХ РАБОТ, ПОДГОТОВИТЕЛЬНЫЕ, СОПУТСТВУЮЩИЕ И УКРЕПИТЕЛЬНЫЕ РАБОТЫ",
    subsectionName: "РАЗРАБОТКА ВЕЧНОМЕРЗЛЫХ И СКАЛЬНЫХ ГРУНТОВ",
  }),
  makeSearchNorm({
    code: "06-01-001-13",
    fullName: "Устройство фундаментов-столбов: бетонных",
    endName: "бетонных",
    unit: "100 м3",
    collectionCode: "06",
    collectionName: "Бетонные и железобетонные конструкции монолитные",
    baseType: "ГЭСН",
    sectionName: "ФУНДАМЕНТЫ",
  }),
  makeSearchNorm({
    code: "08-01-001-01",
    fullName:
      "Устройство из бутового камня фундаментов с применением мастики горячей: ленточных",
    endName: "ленточных",
    unit: "м3",
    collectionCode: "08",
    collectionName: "Конструкции из кирпича и блоков",
    baseType: "ГЭСН",
    sectionName:
      "КОНСТРУКЦИИ ИЗ БУТОВОГО КАМНЯ, ГИДРОИЗОЛЯЦИЯ И ОСНОВАНИЯ ПОД ФУНДАМЕНТЫ",
  }),
  makeSearchNorm({
    code: "01-01-001-01",
    fullName:
      "Станок в собранном виде: токарный, сверлильно-расточный, шлифовальный, " +
      "зубообрабатывающий, фрезерный, строгальный и долбежный, протяжный, " +
      "электрофизический и электрохимический, балансировочный и отрезной, масса: " +
      "от 1,1 до 2 т",
    endName: "от 1,1 до 2 т",
    unit: "шт",
    collectionCode: "01",
    collectionName: "Металлообрабатывающее оборудование",
    baseType: "ГЭСНм",
    sectionName: "СТАНКИ В СОБРАННОМ ВИДЕ",
  }),
  makeSearchNorm({
    code: "01-01-001-01",
    fullName: "Генератор синхронный (компенсатор) напряжением: до 1 кВ, мощностью до 100 кВт",
    endName: "до 1 кВ, мощностью до 100 кВт",
    unit: "шт",
    collectionCode: "01",
    collectionName: "Электротехнические устройства",
    baseType: "ГЭСНп",
    sectionName: "ГЕНЕРАТОРЫ",
  }),
  makeSearchNorm({
    code: "01-01-001-01",
    fullName: "Замена замка распашной двери шахты лифта: автоматического",
    endName: "автоматического",
    unit: "шт",
    collectionCode: "01",
    collectionName: "Капитальный ремонт и модернизация оборудования лифтов",
    baseType: "ГЭСНмр",
  }),
];
