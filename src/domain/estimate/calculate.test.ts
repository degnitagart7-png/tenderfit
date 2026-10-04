import { describe, expect, it } from "vitest";

import {
  buildEstimate,
  computeEstimateLine,
  computeEstimateSection,
  computeResourceLine,
  computeTotals,
  type EstimatePriceBook,
} from "@/domain/estimate/calculate";
import { auditEstimateArithmetic, parseEstimateDocument } from "@/domain/estimate/schema";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type {
  BillOfWorkItem,
  EstimateGap,
  EstimateGapKind,
  EstimateParameters,
  EstimateResourceLine,
  EstimateSource,
  NormRecord,
  NormResource,
  ResourcePrice,
} from "@/domain/estimate/types";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_DRAINAGE,
  BILL_DRAGLINE,
  BILL_DREDGER,
  BILL_GENERATOR,
  BILL_GRADING,
  BILL_SLOPE,
  NORM_DRAINAGE_100,
  NORM_DRAGLINE_15,
  NORM_DREDGER_800,
  NORM_MANUAL_GRADING,
  NORM_PUSKONALADKA_GENERATOR,
  NORM_SLOPE_REINFORCEMENT,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeOverheadRates,
  makeResolver,
  makeSearchNorm,
  VARIED_OVERHEAD_RATES,
} from "@/test/estimateFixtures";

/**
 * Расчёт сметы по данным ФСНБ-2022.
 *
 * Все числа в этом файле получены двумя независимыми путями: сначала вручную из
 * расхода нормы, объёма позиции и цены, которая лежит в выгрузке, затем —
 * прогоном той же арифметики отдельным скриптом. Поэтому тест проверяет не
 * «сошёлся ли код сам с собой», а совпадает ли расчёт с открытыми данными.
 *
 * Главных сюжета три.
 *
 * Первый — оплата труда машинистов не начисляется дважды. Служебный код «2»
 * несёт часы, а деньги уже сидят в цене маш.-ч; для нормы 01-01-001-01 это
 * проверяется тождеством 1,92 × 1 + 1,92 × 3 = 7,68.
 *
 * Второй — ничто не исчезает молча. Ресурс без конкретной марки, расход «по
 * проекту», отсутствующая цена, ставка вне известных разрядов и труд
 * специалиста, на который в открытых данных нет ставки, обязаны дать пометку в
 * gaps. Итог при этом занижен, и это видно: завышать догадкой нельзя.
 *
 * Третий — один и тот же код нормы в четырёх книгах означает четыре разные
 * работы, поэтому каждая пометка несёт книгу, а одна и та же отсутствующая цена
 * в двух позициях даёт две пометки, а не одну.
 */

/** Книга цен без базы 2022 года: ни одной цены, кроме текущих по зоне. */
const EMPTY_BASE: ReadonlyMap<string, ResourcePrice> = new Map<string, ResourcePrice>();

const WAGE_SCALE = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);
const PRICE_BOOK = makePriceBook(WAGE_SCALE);
const PARAMETERS = makeParameters();

const NORMS: readonly NormRecord[] = [
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  NORM_DRAINAGE_100,
  NORM_SLOPE_REINFORCEMENT,
  NORM_PUSKONALADKA_GENERATOR,
  NORM_DREDGER_800,
];

const RESOLVE = makeResolver(NORMS);

/** Индексы Минстроя. Значения произвольные: письма с индексами в выгрузке нет. */
const INDICES = {
  period: "III квартал 2026 г.",
  labour: 1.09,
  machinistLabour: 1.12,
  machines: 1.15,
  materials: 1.22,
  source: "Значения заданы для теста; письма Минстроя опубликованы только в PDF",
} as const;

/**
 * Шкала, обрезанная до разряда 3,4 — только ставки реестра рабочих, без
 * разрядов, которые достаются из колонки оплаты труда машинистов. Нужна, чтобы
 * проверить продолжение шкалы за пределы известных значений.
 */
const NARROW_SCALE = buildWageScale(
  AMUR_WAGE_ANCHORS.filter((anchor) => anchor.rank <= 3.4),
  AMUR_ZONE,
);

const SOURCES: readonly EstimateSource[] = [
  {
    title: "ФСНБ-2022: нормы ГЭСН и Федеральная сметная база цен",
    url: "https://fgiscs.minstroyrf.ru/frsn/fsnb",
    edition: "редакция 12.08.2026, приказ Минстроя России № 527/пр",
  },
  {
    title: "Открытые данные ФГИС ЦС, набор 7707082071-fsnb",
    url: "https://fgiscs.minstroyrf.ru/api/OpenData/7707082071-fsnb",
    edition: "выгрузка data-20260812-structure-20240216.zip",
  },
  {
    title: "Текущие сметные цены строительных ресурсов (ФСЦСР)",
    url: "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/BuildingResources/Export",
    edition:
      "Амурская область (1 зона), 3 квартал 2026 г.; локальная копия data/fsnb/raw/fscsr/amur-z1-3kv2026.xlsx",
  },
];

// Позиции ведомости объявлены в общих фикстурах: те же работы нужны тестам
// схемы документа, и два набора чисел разошлись бы молча.
const DRAGLINE_ITEM = BILL_DRAGLINE;
const GRADING_ITEM = BILL_GRADING;
const SLOPE_ITEM = BILL_SLOPE;
const DRAINAGE_ITEM = BILL_DRAINAGE;
const DREDGER_ITEM = BILL_DREDGER;
const GENERATOR_ITEM = BILL_GENERATOR;

/**
 * Норма с кодом ресурса, которого в классификаторе нет.
 *
 * Запись синтетическая, и другой быть не может. Признак `kind` в ней проставлен
 * так, как его проставил бы парсер. Перепись всех пяти книг даёт
 * ровно четыре кода, которые не попадают ни в один известный вид, и все они —
 * ServiceResource «999-9899», «999-9900», «999-9901», «999-9902» (1 271 строка).
 * Парсер помечает их `projectSpecific`, поэтому в расчёте они дают
 * PROJECT_SPECIFIC_RESOURCE, а не UNKNOWN_RESOURCE. Значит ветка неопознанного
 * кода — сетка на случай смены формата выгрузки, и проверить её можно только
 * на записи, которой в базе нет.
 */
const NORM_WITH_FOREIGN_CODE: NormRecord = {
  ...makeSearchNorm({
    code: "99-99-999-01",
    fullName: "Работа с кодом ресурса неизвестного формата",
    endName: "проверка предохранителя",
    unit: "шт",
    collectionCode: "99",
    collectionName: "Служебный сборник",
    baseType: "ГЭСН",
  }),
  resources: [
    {
      code: "0.0.0.0",
      kind: "UNKNOWN",
      name: "Код, которого нет в классификаторе",
      quantity: 1,
      unit: "шт",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
  ],
};

/** Считает строку сметы и падает, если расчёт отказался её строить. */
function lineFor(
  item: BillOfWorkItem,
  priceBook: EstimatePriceBook = PRICE_BOOK,
  parameters: EstimateParameters = PARAMETERS,
) {
  const outcome = computeEstimateLine(item, RESOLVE(item), priceBook, parameters);
  const line = outcome.line;
  if (line === null) {
    throw new Error(`Расчёт не дал строки для позиции ${item.id}`);
  }
  return line;
}

/** Пробелы позиции: то, что расчёт обязан показать, а не проглотить. */
function gapsFor(
  item: BillOfWorkItem,
  priceBook: EstimatePriceBook = PRICE_BOOK,
  parameters: EstimateParameters = PARAMETERS,
): EstimateGap[] {
  return computeEstimateLine(item, RESOLVE(item), priceBook, parameters).gaps;
}

function countKind(gaps: readonly EstimateGap[], kind: EstimateGapKind): number {
  return gaps.filter((gap) => gap.kind === kind).length;
}

function resourcesOfKind(
  resources: readonly EstimateResourceLine[],
  kind: NormResource["kind"],
): EstimateResourceLine[] {
  return resources.filter((resource) => resource.kind === kind);
}

function resourceByCode(
  resources: readonly EstimateResourceLine[],
  code: string,
): EstimateResourceLine {
  const found = resources.find((resource) => resource.code === code);
  if (found === undefined) throw new Error(`В расшифровке нет ресурса ${code}`);
  return found;
}

describe("computeEstimateLine: норма только с трудом рабочих", () => {
  // 800 м2 при норме на 1000 м2 дают 0,8; 86,5 чел.-ч × 0,8 = 69,2.
  // Разряд 3,0 есть в реестре ставок, поэтому 653,14 ₽ без приближения:
  // 69,2 × 653,14 = 45 197,29 ₽.
  it("начисляет оплату труда по ставке разряда из открытых данных", () => {
    const line = lineFor(GRADING_ITEM);

    expect(line.quantity).toBe(0.8);
    expect(line.labourHours).toBe(69.2);
    expect(line.labourRate).toBe(653.14);
    expect(line.labourCost).toBe(45197.29);
    expect(line.machineCost).toBe(0);
    expect(line.materialCost).toBe(0);
    expect(line.directCost).toBe(45197.29);
    expect(line.wageFund).toBe(45197.29);
    // НР 105 % и СП 65 % от фонда оплаты труда.
    expect(line.overheadCost).toBe(47457.15);
    expect(line.profitCost).toBe(29378.24);
  });

  it("не даёт ни одной пометки: всё взято из открытых данных без допущений", () => {
    expect(gapsFor(GRADING_ITEM)).toEqual([]);
  });

  it("помечает происхождение ставки как точное значение", () => {
    const resource = resourceByCode(lineFor(GRADING_ITEM).resources, "1-100-30");

    expect(resource.wageOrigin).toBe("ANCHOR");
    expect(resource.source).toBe("WAGE_SCALE");
    expect(resource.unit).toBe("чел.-ч");
  });

  it("переносит в строку сметы цитату и документ-основание", () => {
    const line = lineFor(GRADING_ITEM);

    expect(line.sourceQuote).toBe(GRADING_ITEM.sourceQuote);
    expect(line.sourceDocument).toBe(GRADING_ITEM.sourceDocument);
    expect(line.billQuantity).toBe(800);
    expect(line.billUnit).toBe("м2");
    expect(line.normUnit).toBe("1000 м2");
  });

  it("печатает книгу нормы рядом с кодом: одного кода для сверки мало", () => {
    const line = lineFor(GRADING_ITEM);

    expect(line.normBaseType).toBe("ГЭСН");
    expect(line.normCode).toBe("01-01-111-01");
    expect(line.normName).toBe(NORM_MANUAL_GRADING.fullName);
  });
});

describe("computeEstimateLine: машины без текущей цены зоны", () => {
  // 1200 м3 при норме на 1000 м3 дают 1,2. Труд: 1,54 × 1,2 = 1,848 чел.-ч,
  // разряд 3,8 между опорными 3,4 и 4,0 → коэффициент 1,31 → 719,01 ₽.
  // Машины: 1,6 × 1,2 = 1,92 маш.-ч каждая; 1,92 × 1 339,47 = 2 571,78 и
  // 1,92 × 88 134,75 = 169 218,72.
  it("берёт базу 2022 года и помечает каждый такой переход", () => {
    const line = lineFor(DRAGLINE_ITEM);
    const gaps = gapsFor(DRAGLINE_ITEM);

    expect(line.labourHours).toBe(1.848);
    expect(line.labourRate).toBe(719.01);
    expect(line.labourCost).toBe(1328.73);
    expect(line.machineHours).toBe(3.84);
    expect(line.machineCost).toBe(171790.5);
    expect(line.directCost).toBe(173119.23);
    expect(countKind(gaps, "NO_CURRENT_PRICE")).toBe(2);
    expect(resourcesOfKind(line.resources, "MACHINE")).toHaveLength(2);
    for (const machine of resourcesOfKind(line.resources, "MACHINE")) {
      expect(machine.source).toBe("BASE_2022");
    }
  });

  it("разряд между опорными точками помечает интерполяцией", () => {
    const resource = resourceByCode(lineFor(DRAGLINE_ITEM).resources, "1-100-38");

    expect(resource.wageOrigin).toBe("INTERPOLATED");
    expect(resource.unitPrice).toBe(719.01);
  });

  // Код «2» = 6,4 чел.-ч на единицу нормы, и 1,92 × 1 + 1,92 × 3 = 7,68 —
  // то же самое, посчитанное от состава звена. Деньги при этом берутся один
  // раз, из цены маш.-ч: 1,92 × 451,93 = 867,71 и 1,92 × 5 077,35 = 9 748,51.
  it("не начисляет оплату труда машинистов второй раз", () => {
    const line = lineFor(DRAGLINE_ITEM);

    expect(line.machinistHours).toBe(7.68);
    expect(line.machinistSalaryCost).toBe(10616.22);
    expect(line.resources.some((resource) => resource.code === "2")).toBe(false);
    // Фонд оплаты труда — рабочие плюс машинисты, и только они.
    expect(line.wageFund).toBe(11944.95);
    expect(line.wageFund).toBe(
      Math.round((line.labourCost + line.machinistSalaryCost) * 100) / 100,
    );
  });

  it("не оценивает служебный код «2» деньгами: он даёт только часы", () => {
    const line = lineFor(DRAGLINE_ITEM);

    expect(line.resources).toHaveLength(3);
    expect(resourcesOfKind(line.resources, "MACHINIST_HOURS")).toHaveLength(0);
  });
});

describe("computeEstimateLine: сверка часов машинистов", () => {
  it("на норме из выгрузки два пути к часам машинистов сходятся", () => {
    // 1,92 × 1 + 1,92 × 3 = 7,68 по машинам — ровно код «2».
    const outcome = computeEstimateLine(DRAGLINE_ITEM, RESOLVE(DRAGLINE_ITEM), PRICE_BOOK, PARAMETERS);

    expect(outcome.line?.machinistHours).toBe(7.68);
    expect(countKind(outcome.gaps, "MACHINIST_HOURS_MISMATCH")).toBe(0);
  });

  it("расхождение служебного кода с составом звена помечается", () => {
    // На этом равенстве держится отказ начислять оплату машинистов отдельно:
    // если оно нарушено, брать её молча из цены маш.-ч больше нельзя.
    const broken = {
      ...NORM_DRAGLINE_15,
      resources: NORM_DRAGLINE_15.resources.map((resource) =>
        resource.code === "2" ? { ...resource, quantity: 99 } : resource,
      ),
    };
    const outcome = computeEstimateLine(
      DRAGLINE_ITEM,
      { norm: broken, reasons: ["Проверка сверки"] },
      PRICE_BOOK,
      PARAMETERS,
    );

    expect(countKind(outcome.gaps, "MACHINIST_HOURS_MISMATCH")).toBe(1);
    expect(outcome.gaps.find((gap) => gap.kind === "MACHINIST_HOURS_MISMATCH")?.message).toContain(
      "маш.-ч × звено",
    );
  });

  it("неизвестный состав звена выключает сверку, а не выдаёт ложное расхождение", () => {
    const withoutCrew = makePriceBook(WAGE_SCALE, {
      base: new Map(
        [...PRICE_BOOK.base].map(([code, price]) => [code, { ...price, machinistHours: null }]),
      ),
      current: new Map(
        [...PRICE_BOOK.current].map(([code, price]) => [code, { ...price, machinistHours: null }]),
      ),
    });
    const outcome = computeEstimateLine(
      DRAGLINE_ITEM,
      RESOLVE(DRAGLINE_ITEM),
      withoutCrew,
      PARAMETERS,
    );

    expect(countKind(outcome.gaps, "MACHINIST_HOURS_MISMATCH")).toBe(0);
  });
});

describe("computeEstimateLine: индексы пересчёта к текущему уровню цен", () => {
  const parameters = makeParameters({ indices: INDICES });

  it("пересчитывает базу индексом по элементу затрат и снимает пометку о понижении точности", () => {
    const line = lineFor(DRAGLINE_ITEM, PRICE_BOOK, parameters);
    const gaps = gapsFor(DRAGLINE_ITEM, PRICE_BOOK, parameters);

    // Цена маш.-ч разбирается на части и каждая идёт своим индексом:
    // бульдозер 887,54 × 1,15 + 451,93 × 1,12 = 1 526,83;
    // драглайн 83 057,40 × 1,15 + 5 077,35 × 1,12 = 101 202,64.
    expect(resourceByCode(line.resources, "91.01.01-035").unitPrice).toBe(1526.83);
    expect(resourceByCode(line.resources, "91.01.05-128").unitPrice).toBe(101202.64);
    for (const machine of resourcesOfKind(line.resources, "MACHINE")) {
      expect(machine.source).toBe("BASE_2022_INDEXED");
    }
    expect(gaps).toEqual([]);
    expect(line.machineCost).toBe(197240.58);
    expect(line.directCost).toBe(198569.31);
  });

  /*
    Зарплата машинистов идёт своим индексом — ОТм (1,12), а не индексом труда
    рабочих (1,09) и не индексом машин (1,15). Минстрой публикует её отдельной
    колонкой внутри индекса к эксплуатации машин, и та же величина попадает в
    фонд оплаты труда, а через него в НР и СП: 451,93 × 1,12 = 506,16 и
    5 077,35 × 1,12 = 5 686,63.
  */
  it("пересчитывает зарплату машинистов индексом ОТм, а не индексом рабочих", () => {
    const line = lineFor(DRAGLINE_ITEM, PRICE_BOOK, parameters);

    expect(line.machinistSalaryCost).toBe(11890.16);
    expect(line.wageFund).toBe(13218.89);
    expect(line.overheadCost).toBe(13879.83);
    expect(line.profitCost).toBe(8592.28);
  });

  it("та же зарплата сидит в стоимости машин и в ФОТ, а не два разных числа", () => {
    const line = lineFor(DRAGLINE_ITEM, PRICE_BOOK, parameters);
    const machines = resourcesOfKind(line.resources, "MACHINE");

    // Пересчитанная ОТм внутри цены маш.-ч: (цена − «без зарплаты» × Иэм).
    const salaryInsideMachines = machines.reduce((acc, machine) => {
      const withoutSalary = machine.code === "91.01.01-035" ? 887.54 : 83057.4;
      return acc + machine.quantity * (machine.unitPrice - withoutSalary * 1.15);
    }, 0);

    expect(salaryInsideMachines).toBeCloseTo(line.machinistSalaryCost, 1);
  });

  it("не трогает индексом оплату труда рабочих: шкала уже в текущем уровне", () => {
    const withIndices = lineFor(GRADING_ITEM, PRICE_BOOK, parameters);

    expect(withIndices.labourRate).toBe(653.14);
    expect(withIndices.labourCost).toBe(45197.29);
  });
});

describe("computeEstimateLine: ресурсы, которые оценить нельзя", () => {
  // 2 500 м2 при норме на 1000 м2 дают 2,5. Труд: 123,36 × 2,5 = 308,4 чел.-ч
  // по разряду 2,9 → 647,65 ₽ → 199 735,26 ₽. Машины: 57,65 маш.-ч на
  // 59 728,11 ₽, из них оплата машинистов 18 859,64 ₽. Материалы: 327 085,25 ₽.
  it("считает позицию, в которой часть ресурсов не поддаётся оценке", () => {
    const line = lineFor(SLOPE_ITEM);

    expect(line.labourHours).toBe(308.4);
    expect(line.labourCost).toBe(199735.26);
    expect(line.machinistHours).toBe(49.1);
    expect(line.machinistSalaryCost).toBe(18859.64);
    expect(line.machineHours).toBe(57.65);
    expect(line.machineCost).toBe(59728.11);
    expect(line.materialCost).toBe(327085.25);
    expect(line.directCost).toBe(586548.62);
    expect(line.wageFund).toBe(218594.9);
    expect(line.overheadCost).toBe(229524.65);
    expect(line.profitCost).toBe(142086.69);
  });

  // Расход «П» означает «по проекту». Цена на анкеры в базе есть — 62 413,13 ₽
  // за тонну, — но расхода нет, поэтому оценить позицию нельзя. Именно так:
  // пометка про количество, а не про цену.
  it("расход «по проекту» даёт пометку и не попадает в стоимость, даже когда цена известна", () => {
    const gaps = gapsFor(SLOPE_ITEM);
    const byProject = gaps.filter((gap) => gap.kind === "QUANTITY_BY_PROJECT");

    expect(byProject).toHaveLength(1);
    expect(byProject[0]?.message).toContain("01.7.15.01-0040");
    expect(byProject[0]?.message).toContain("по проекту");
    expect(lineFor(SLOPE_ITEM).resources.some((resource) => resource.code === "01.7.15.01-0040")).toBe(
      false,
    );
  });

  it("ресурс без конкретной марки даёт пометку с технологической группой", () => {
    const gaps = gapsFor(SLOPE_ITEM);
    const project = gaps.filter((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE");

    expect(project).toHaveLength(1);
    expect(project[0]?.message).toContain("01.7.12.16");
    expect(project[0]?.message).toContain("54.08.005");
  });

  it("перечисляет все переходы на базу 2022 года: четыре машины и три материала", () => {
    const gaps = gapsFor(SLOPE_ITEM);

    expect(countKind(gaps, "NO_CURRENT_PRICE")).toBe(7);
    expect(countKind(gaps, "NO_PRICE")).toBe(0);
    expect(gaps).toHaveLength(9);
    for (const gap of gaps) {
      expect(gap.code).toBe("01-01-050-01");
      expect(gap.baseType).toBe("ГЭСН");
    }
  });

  it("смешивает текущую цену зоны с базой 2022 года в одной позиции", () => {
    const resources = lineFor(SLOPE_ITEM).resources;

    expect(resourceByCode(resources, "91.05.05-015").source).toBe("CURRENT_ZONE");
    expect(resourceByCode(resources, "91.14.02-001").source).toBe("CURRENT_ZONE");
    expect(resourceByCode(resources, "91.01.01-035").source).toBe("BASE_2022");
    expect(resources).toHaveLength(10);
  });
});

describe("computeEstimateLine: две записи труда рабочих", () => {
  // 500 м при норме на 1000 м дают 0,5. Три разрядные строки: 11,74 × 0,5 =
  // 5,87 по разряду 2 (598,26 ₽), 129,57 × 0,5 = 64,785 по разряду 3
  // (653,14 ₽), 61,8 × 0,5 = 30,9 по разряду 4 (735,47 ₽).
  it("начисляет деньги по каждой разрядной строке, а итоговый код «1» даёт только часы", () => {
    const line = lineFor(DRAINAGE_ITEM);

    expect(line.labourHours).toBe(101.555);
    expect(line.labourCost).toBe(68551.48);
    expect(resourceByCode(line.resources, "2-100-02").total).toBe(3511.79);
    expect(resourceByCode(line.resources, "2-100-03").total).toBe(42313.67);
    expect(resourceByCode(line.resources, "2-100-04").total).toBe(22726.02);
    expect(line.resources.some((resource) => resource.code === "1")).toBe(false);
  });

  // Итоговая строка «1» = 203,11 чел.-ч, и 203,11 × 0,5 = 101,555 — ровно
  // сумма разрядных строк. Тождество проверено по всем пяти книгам: из 6 731
  // работы, где встречается код «1», оно выполняется в 6 731.
  it("не поднимает тревогу, когда итог кода «1» сходится с суммой разрядных строк", () => {
    expect(countKind(gapsFor(DRAINAGE_ITEM), "LABOUR_TOTAL_MISMATCH")).toBe(0);
  });

  it("показывает расхождение, если итог кода «1» не сходится с разрядными строками", () => {
    const tampered: NormRecord = {
      ...NORM_DRAINAGE_100,
      resources: NORM_DRAINAGE_100.resources.map((resource) =>
        resource.code === "1" ? { ...resource, quantity: 250 } : resource,
      ),
    };
    const outcome = computeEstimateLine(
      DRAINAGE_ITEM,
      { norm: tampered, reasons: ["Проверка сверки"] },
      PRICE_BOOK,
      PARAMETERS,
    );
    const mismatch = outcome.gaps.filter((gap) => gap.kind === "LABOUR_TOTAL_MISMATCH");

    expect(mismatch).toHaveLength(1);
    // 250 чел.-ч из нормы, умноженные на 0,5 объёма позиции.
    expect(mismatch[0]?.message).toContain("125,00");
    expect(mismatch[0]?.message).toContain("101,56");
    // В расчёт идёт сумма разрядных строк, а не служебный итог.
    expect(outcome.line?.labourHours).toBe(101.555);
    expect(outcome.line?.labourCost).toBe(68551.48);
  });

  it("считает машины и материалы по той же позиции", () => {
    const line = lineFor(DRAINAGE_ITEM);

    expect(line.machineHours).toBe(3.57);
    expect(line.machineCost).toBe(1219.42);
    expect(line.machinistSalaryCost).toBe(445.94);
    expect(line.materialCost).toBe(492898.3);
    expect(line.directCost).toBe(562669.2);
    expect(line.wageFund).toBe(68997.42);
    expect(line.overheadCost).toBe(72447.29);
    expect(line.profitCost).toBe(44848.32);
  });

  it("даёт по две пометки на ресурсы без марки: один с расходом «П», другой с числом", () => {
    const gaps = gapsFor(DRAINAGE_ITEM);

    // «П» у AbstractResource не видно: признак «без конкретной марки» сильнее,
    // и это правильно — цена всё равно определяется проектом.
    expect(countKind(gaps, "PROJECT_SPECIFIC_RESOURCE")).toBe(2);
    expect(countKind(gaps, "QUANTITY_BY_PROJECT")).toBe(0);
    expect(countKind(gaps, "NO_CURRENT_PRICE")).toBe(4);
  });

  it("ставка строки — средняя по начисленным часам, а не последняя из строк", () => {
    const line = lineFor(DRAINAGE_ITEM);

    // 68 551,48 ₽ / 101,555 чел.-ч = 675,02 ₽. Число воспроизводится из
    // напечатанных в смете стоимости и часов, поэтому проверяемо.
    expect(line.labourRate).toBe(675.02);
  });
});

describe("computeEstimateLine: труд специалистов, на который нет ставки", () => {
  // ГЭСНп 01-01-001-01: рабочий 5 разряда 4,59 чел.-ч по ставке 845,24 ₽ даёт
  // 3 879,65 ₽, а техник II категории, инженер I и инженер III категории
  // (9,18 + 22,95 + 9,18 чел.-ч) не оплачены: ставок ИТР в открытых данных нет.
  it("даёт пометку NO_WAGE на каждую должность специалиста вместо молчаливого нуля", () => {
    const gaps = gapsFor(GENERATOR_ITEM);
    const noWage = gaps.filter((gap) => gap.kind === "NO_WAGE");

    expect(noWage).toHaveLength(3);
    expect(noWage.map((gap) => gap.message).join(" ")).toContain("3-100-02");
    expect(noWage.map((gap) => gap.message).join(" ")).toContain("3-200-01");
    expect(noWage.map((gap) => gap.message).join(" ")).toContain("3-200-03");
    for (const gap of noWage) {
      expect(gap.code).toBe("01-01-001-01");
      expect(gap.baseType).toBe("ГЭСНп");
      // Причина названа верно: шкала загружена, она просто не про должности.
      expect(gap.message).toContain("не покрывает код");
      expect(gap.message).toContain("специалист");
      expect(gap.message).not.toContain("не загружена");
      expect(gap.message).toContain("ГЭСНп 01-01-001-01");
    }
  });

  it("не относит специалистов к неопознанным кодам: это труд, а не неизвестный ресурс", () => {
    expect(countKind(gapsFor(GENERATOR_ITEM), "UNKNOWN_RESOURCE")).toBe(0);
  });

  it("сохраняет часы специалистов в трудозатратах и не начисляет на них деньги", () => {
    const line = lineFor(GENERATOR_ITEM);

    // Код «1» равен 45,9 и складывается из разрядной строки рабочих 4,59 и
    // часов специалистов 9,18 + 22,95 + 9,18 = 41,31. В строке сметы они
    // разведены: подпись «затраты труда рабочих» на сумме с часами инженеров
    // называла бы не ту величину.
    expect(line.labourHours).toBe(4.59);
    expect(line.specialistHours).toBe(41.31);
    expect(line.labourHours + line.specialistHours).toBeCloseTo(45.9, 3);
    expect(line.labourCost).toBe(3879.65);
    expect(line.directCost).toBe(3879.65);
    expect(line.resources).toHaveLength(4);
    expect(resourceByCode(line.resources, "3-200-01").unitPrice).toBe(0);
    expect(resourceByCode(line.resources, "3-200-01").total).toBe(0);
    // Ноль не подписан тарифной шкалой: шкала эту ставку не давала.
    expect(resourceByCode(line.resources, "3-200-01").source).toBe("UNPRICED");
    expect(resourceByCode(line.resources, "2-100-05").source).toBe("WAGE_SCALE");
    expect(resourceByCode(line.resources, "2-100-05").wageOrigin).toBe("ANCHOR");
  });

  it("показывает ставку только по оплаченным часам, чтобы ноль не выглядел средней ставкой", () => {
    const line = lineFor(GENERATOR_ITEM);

    // 3 879,65 ₽ / 4,59 чел.-ч = 845,24 ₽ — ставка 5 разряда, а не
    // 84,52 ₽, которые получились бы делением стоимости на все 45,9 часа.
    expect(line.labourRate).toBe(845.24);
  });

  it("в книге ГЭСНп нет ни машин, ни материалов: без ставок ИТР смета равна оплате рабочих", () => {
    const line = lineFor(GENERATOR_ITEM);

    expect(line.machineHours).toBe(0);
    expect(line.machineCost).toBe(0);
    expect(line.materialCost).toBe(0);
    expect(line.machinistHours).toBe(0);
    expect(line.wageFund).toBe(3879.65);
    expect(line.overheadCost).toBe(4073.63);
    expect(line.profitCost).toBe(2521.77);
  });
});

describe("computeEstimateLine: ставка вне известных разрядов", () => {
  const priceBook = makePriceBook(NARROW_SCALE);

  // Шкала обрезана до 3,4. Разряд 4 продолжается по наклону крайнего участка:
  // коэффициенты 1,235 (3,3) и 1,250 (3,4) дают наклон 0,15 на разряд,
  // 1,250 + 0,15 × 0,6 = 1,340 → 1,340 × 548,86 = 735,47 ₽.
  it("продолжает шкалу и помечает результат как приближение", () => {
    const gaps = gapsFor(DRAINAGE_ITEM, priceBook);
    const extrapolated = gaps.filter((gap) => gap.kind === "WAGE_EXTRAPOLATED");

    expect(extrapolated).toHaveLength(1);
    expect(extrapolated[0]?.message).toContain("4,0");
    expect(extrapolated[0]?.message).toContain("735,47");
    expect(extrapolated[0]?.message).toContain("приближение");
    expect(resourceByCode(lineFor(DRAINAGE_ITEM, priceBook).resources, "2-100-04").wageOrigin).toBe(
      "EXTRAPOLATED",
    );
  });

  // Продолжение шкалы по ставкам рабочих попадает ровно в то значение, которое
  // независимый источник даёт для разряда 4: 735,47 ₽ из колонки оплаты труда
  // машинистов ФСЦСР. Совпадение не случайное — обе величины описывают одну
  // тарифную сетку, и это лучшая проверка модели, которую дают открытые данные.
  it("продолжение шкалы по рабочим разрядам совпадает со ставкой машинистов из второго источника", () => {
    const narrow = lineFor(DRAINAGE_ITEM, priceBook);
    const full = lineFor(DRAINAGE_ITEM, PRICE_BOOK);

    expect(resourceByCode(narrow.resources, "2-100-04").unitPrice).toBe(735.47);
    expect(narrow.labourCost).toBe(full.labourCost);
    expect(narrow.directCost).toBe(full.directCost);
  });
});

describe("computeEstimateLine: отказ считать", () => {
  it("нулевой объём: строки нет, пометка есть", () => {
    const item = makeBillItem({ quantity: 0, normCode: "01-01-111-01", quantityUnit: "1000 м2" });
    const outcome = computeEstimateLine(item, RESOLVE(item), PRICE_BOOK, PARAMETERS);

    expect(outcome.line).toBeNull();
    expect(outcome.gaps).toHaveLength(1);
    expect(outcome.gaps[0]?.kind).toBe("BAD_QUANTITY");
    expect(outcome.gaps[0]?.baseType).toBe("ГЭСН");
  });

  it("отрицательный объём: строки нет, пометка есть", () => {
    const item = makeBillItem({ quantity: -12, normCode: "01-01-111-01", quantityUnit: "1000 м2" });
    const outcome = computeEstimateLine(item, RESOLVE(item), PRICE_BOOK, PARAMETERS);

    expect(outcome.line).toBeNull();
    expect(outcome.gaps[0]?.kind).toBe("BAD_QUANTITY");
    expect(outcome.gaps[0]?.message).toContain("-12");
  });

  it("нулевой делитель единицы: объём взят как есть, и это видно", () => {
    const item = makeBillItem({
      quantity: 3,
      quantityUnit: "1000 м2",
      unitDivisor: 0,
      normCode: "01-01-111-01",
    });
    const outcome = computeEstimateLine(item, RESOLVE(item), PRICE_BOOK, PARAMETERS);

    expect(outcome.gaps.map((gap) => gap.kind)).toEqual(["BAD_DIVISOR"]);
    expect(outcome.line?.quantity).toBe(3);
    // 86,5 × 3 = 259,5 чел.-ч × 653,14 ₽ = 169 489,83 ₽.
    expect(outcome.line?.labourCost).toBe(169489.83);
  });

  /**
   * Живой прогон на смете 02-01-02-КМ1 (Февральск, Амурская область) показал,
   * во что обходится «взять объём как есть»: строка «Перевозка … 34,392 т»
   * получила норму 36-01-011-01 с единицей «1000 м3» и дала 9 182 897,33 ₽ из
   * 10 522 623,30 ₽ прямых затрат — 87 % сметы на одной непроверенной строке.
   *
   * Пересчёта здесь нет и быть не может: из тонн в кубометры без плотности не
   * перейти, а плотности в ведомости нет. Поэтому позиция выбывает из расчёта,
   * как выбывает позиция без нормы: смета окажется занижена ровно на её вес,
   * и об этом скажет пробел, — но не завышена втрое числом, которого никто не
   * проверял.
   */
  it("единица ведомости не совпадает с единицей нормы, а делитель не задан: строки нет", () => {
    const item = makeBillItem({
      quantity: 800,
      quantityUnit: "м2",
      unitDivisor: 1,
      normCode: "01-01-111-01",
    });
    const outcome = computeEstimateLine(item, RESOLVE(item), PRICE_BOOK, PARAMETERS);

    expect(outcome.line).toBeNull();
    expect(outcome.gaps.map((gap) => gap.kind)).toEqual(["UNIT_MISMATCH"]);
    expect(outcome.gaps[0]?.message).toContain("м2");
    expect(outcome.gaps[0]?.message).toContain("1000 м2");
  });

  it("делитель задан — расхождения единиц нет: 800 м2 при норме на 1000 м2", () => {
    expect(countKind(gapsFor(GRADING_ITEM), "UNIT_MISMATCH")).toBe(0);
  });

  it("норма не подобрана: строки нет, пометка хранит код и книгу из ведомости", () => {
    const item = makeBillItem({ normCode: "08-01-001-01", normBaseType: "ГЭСНм" });
    const outcome = computeEstimateLine(item, null, PRICE_BOOK, PARAMETERS);

    expect(outcome.line).toBeNull();
    expect(outcome.gaps).toHaveLength(1);
    expect(outcome.gaps[0]?.kind).toBe("NO_NORM");
    expect(outcome.gaps[0]?.code).toBe("08-01-001-01");
    expect(outcome.gaps[0]?.baseType).toBe("ГЭСНм");
    expect(outcome.gaps[0]?.message).toContain(item.workName);
  });

  it("цена не найдена нигде: ноль в стоимости и явная пометка", () => {
    const withoutBase = makePriceBook(WAGE_SCALE, { base: EMPTY_BASE });
    const line = lineFor(GRADING_ITEM, withoutBase);
    const gaps = gapsFor(GRADING_ITEM, withoutBase);

    expect(gaps).toEqual([]);
    expect(line.labourCost).toBe(45197.29);

    const dragline = lineFor(DRAGLINE_ITEM, withoutBase);
    const draglineGaps = gapsFor(DRAGLINE_ITEM, withoutBase);
    expect(countKind(draglineGaps, "NO_PRICE")).toBe(2);
    expect(dragline.machineCost).toBe(0);
    expect(dragline.directCost).toBe(1328.73);
    expect(resourceByCode(dragline.resources, "91.01.05-128").unitPrice).toBe(0);
    expect(resourceByCode(dragline.resources, "91.01.05-128").source).toBe("UNPRICED");
  });

  it("код ресурса неизвестного формата: предохранитель на случай смены выгрузки", () => {
    const outcome = computeEstimateLine(
      makeBillItem({ normCode: "99-99-999-01" }),
      { norm: NORM_WITH_FOREIGN_CODE, reasons: ["Проверка предохранителя"] },
      PRICE_BOOK,
      PARAMETERS,
    );

    // Служебная норма собрана без указателей Nr и Sp, поэтому к неопознанному
    // ресурсу добавляются две пометки о нормативах — по одной на НР и СП.
    expect(outcome.gaps.map((gap) => gap.kind)).toEqual([
      "UNKNOWN_RESOURCE",
      "NO_OVERHEAD_RATE",
      "NO_OVERHEAD_RATE",
    ]);
    expect(outcome.gaps[0]?.message).toContain("0.0.0.0");
    expect(outcome.line?.resources).toHaveLength(0);
    expect(outcome.line?.directCost).toBe(0);
  });

  it("пустая тарифная шкала: оплата труда не начислена, и это помечено", () => {
    const empty = makePriceBook(buildWageScale([], AMUR_ZONE));
    const gaps = gapsFor(GRADING_ITEM, empty);
    const line = lineFor(GRADING_ITEM, empty);

    expect(countKind(gaps, "NO_WAGE")).toBe(1);
    expect(gaps[0]?.message).toContain("Тарифная шкала не загружена");
    expect(line.labourHours).toBe(69.2);
    expect(line.labourCost).toBe(0);
    expect(line.labourRate).toBe(0);
    expect(line.directCost).toBe(0);
    expect(resourceByCode(line.resources, "1-100-30").source).toBe("UNPRICED");
  });
});

describe("computeEstimateLine: цена в базе равна нулю", () => {
  // В «ФСБЦ_Маш.xml» у землесоса 91.20.12-101 стоит SalaryMach="0" и
  // PriceCostWithoutSalary="0", поэтому полная стоимость маш.-ч по базе
  // 01.01.2022 равна 0 ₽. Всего таких машин в книге десять, девять из них —
  // землесосы, и внутри <Work> книги «ГЭСН.xml» они встречаются 63 раза.
  // Ноль здесь означает «цена не задана», а не «машина бесплатна».
  it("даёт пометку ZERO_PRICE вместо вида «оценено по базе»", () => {
    const line = lineFor(DREDGER_ITEM);
    const gaps = gapsFor(DREDGER_ITEM);

    expect(gaps.map((gap) => gap.kind)).toEqual(["ZERO_PRICE"]);
    expect(countKind(gaps, "NO_PRICE")).toBe(0);
    expect(countKind(gaps, "NO_CURRENT_PRICE")).toBe(0);

    const dredger = resourceByCode(line.resources, "91.20.12-101");
    expect(dredger.source).toBe("UNPRICED");
    expect(dredger.unitPrice).toBe(0);
    expect(dredger.total).toBe(0);
    // Наименование ресурса известно из справочника, терять его незачем.
    expect(dredger.name).toContain("Землесосы папильонажные");
  });

  it("сохраняет расход машины: ноль в цене не означает ноль в объёме работ", () => {
    const line = lineFor(DREDGER_ITEM);

    // 12 000 м3 при норме на 1000 м3 — 12; 1,38 маш.-ч × 12 = 16,56.
    expect(line.quantity).toBe(12);
    expect(line.machineHours).toBe(16.56);
    expect(resourceByCode(line.resources, "91.20.12-101").quantity).toBe(16.56);
    expect(line.machineCost).toBe(0);
    expect(line.directCost).toBe(0);
  });

  it("показывает нулевую позицию целиком: в норме нет ни рабочих, ни материалов", () => {
    const line = lineFor(DREDGER_ITEM);

    expect(line.labourHours).toBe(0);
    expect(line.labourCost).toBe(0);
    expect(line.labourRate).toBe(0);
    expect(line.machinistHours).toBe(0);
    expect(line.machinistSalaryCost).toBe(0);
    expect(line.materialCost).toBe(0);
    expect(line.wageFund).toBe(0);
    expect(line.overheadCost).toBe(0);
    expect(line.profitCost).toBe(0);
    expect(line.resources).toHaveLength(1);
  });

  it("называет в пометке книгу, код нормы и ресурс", () => {
    const [gap] = gapsFor(DREDGER_ITEM);

    expect(gap?.code).toBe("44-04-180-01");
    expect(gap?.baseType).toBe("ГЭСН");
    expect(gap?.message).toContain("ГЭСН 44-04-180-01");
    expect(gap?.message).toContain("91.20.12-101");
    expect(gap?.message).toContain("нулю");
    expect(gap?.message).toContain("01.01.2022");
  });

  it("индекс пересчёта не превращает нулевую базу в цену", () => {
    const line = lineFor(DREDGER_ITEM, PRICE_BOOK, makeParameters({ indices: INDICES }));
    const gaps = gapsFor(DREDGER_ITEM, PRICE_BOOK, makeParameters({ indices: INDICES }));

    // 0 × 1,15 = 0: без проверки на ноль позиция выглядела бы как
    // «пересчитано по индексу» рядом с нулевой стоимостью.
    expect(gaps.map((gap) => gap.kind)).toEqual(["ZERO_PRICE"]);
    expect(resourceByCode(line.resources, "91.20.12-101").source).toBe("UNPRICED");
    expect(line.machineCost).toBe(0);
  });

  it("ноль в текущих ценах зоны не мешает взять базу: цена там положительная", () => {
    // Вход искусственный: в выгрузке ФСЦСР по Амурской области (1 зона) за
    // 3 квартал 2026 нулевых цен нет — 228 машин и 1 062 материала, ни одного
    // нуля в колонке цены. Ветка написана на случай смены данных, поэтому
    // проверяется на подставной записи.
    const zeroCurrent = makePriceBook(WAGE_SCALE, {
      current: new Map<string, ResourcePrice>([
        [
          "91.01.05-128",
          {
            code: "91.01.05-128",
            name: "Экскаваторы одноковшовые электрические шагающие, ковш 15 м3",
            unit: "маш.-ч",
            price: 0,
            machinistSalary: 0,
            machinistHours: 3,
            source: "CURRENT_ZONE",
            period: AMUR_ZONE.period,
            zone: AMUR_ZONE.zone,
          },
        ],
      ]),
    });

    const line = lineFor(DRAGLINE_ITEM, zeroCurrent);
    const gaps = gapsFor(DRAGLINE_ITEM, zeroCurrent);

    expect(countKind(gaps, "ZERO_PRICE")).toBe(0);
    expect(resourceByCode(line.resources, "91.01.05-128").unitPrice).toBe(88134.75);
    expect(resourceByCode(line.resources, "91.01.05-128").source).toBe("BASE_2022");
    // Пометка обязана сказать правду: цена в зоне есть, но она нулевая.
    expect(countKind(gaps, "NO_CURRENT_PRICE")).toBe(2);
    const zeroGap = gaps.find((gap) => gap.message.includes("равна нулю"));
    expect(zeroGap?.message).toContain("91.01.05-128");
  });

  it("ноль в зоне и отсутствие базы дают ZERO_PRICE, а не NO_PRICE", () => {
    const zeroCurrentNoBase = makePriceBook(WAGE_SCALE, {
      base: EMPTY_BASE,
      current: new Map<string, ResourcePrice>([
        [
          "91.20.12-101",
          {
            code: "91.20.12-101",
            name: "Землесосы папильонажные рефулерные самоходные с фрезерным разрыхлителем",
            unit: "маш.-ч",
            price: 0,
            machinistSalary: 0,
            machinistHours: 0,
            source: "CURRENT_ZONE",
            period: AMUR_ZONE.period,
            zone: AMUR_ZONE.zone,
          },
        ],
      ]),
    });

    const gaps = gapsFor(DREDGER_ITEM, zeroCurrentNoBase);

    expect(gaps.map((gap) => gap.kind)).toEqual(["ZERO_PRICE"]);
    expect(gaps[0]?.message).toContain("текущих ценах зоны");
    expect(gaps[0]?.message).not.toContain("не найдена");
  });

  it("нулевая позиция проходит сверку документа: ноль объяснён, а не спрятан", () => {
    const document = buildEstimate({
      title: "Дноуглубительные работы",
      sections: [makeBillSection("Гидромеханизация", [DREDGER_ITEM])],
      priceBook: PRICE_BOOK,
      parameters: PARAMETERS,
      resolveNorm: RESOLVE,
      sources: SOURCES,
      generatedAt: "2026-09-26T09:00:00.000Z",
      disclaimer: "Расчёт носит информационно-аналитический характер.",
    });

    expect(document.totals.total).toBe(0);
    expect(auditEstimateArithmetic(parseEstimateDocument(document))).toEqual([]);
  });
});

describe("computeEstimateLine: нормативы НР и СП по указателям расценки", () => {
  /* Книга цен с разными нормативами: земляные 95/50, пусконаладка 66/40. */
  const VARIED = makePriceBook(WAGE_SCALE, {
    overheadRates: makeOverheadRates(VARIED_OVERHEAD_RATES),
  });

  it("берёт норматив по указателю нормы, а не процент из параметров документа", () => {
    const outcome = computeEstimateLine(GRADING_ITEM, RESOLVE(GRADING_ITEM), VARIED, PARAMETERS);
    const line = outcome.line;

    // Резерв документа — 105 и 65, указатель земляных работ — 95 и 50.
    expect(PARAMETERS.overhead.overheadPercent).toBe(105);
    expect(line?.overheadPercent).toBe(95);
    expect(line?.profitPercent).toBe(50);
    expect(line?.overheadSource).toBe("NORM_REF");
    expect(line?.profitSource).toBe("NORM_REF");
    expect(line?.overheadRef).toBe("Пр/812-001.1");
    expect(line?.profitRef).toBe("Пр/774-001.1");
  });

  it("начисляет НР и СП от фонда оплаты труда по нормативу расценки", () => {
    const line = computeEstimateLine(GRADING_ITEM, RESOLVE(GRADING_ITEM), VARIED, PARAMETERS).line;

    const wageFund = line?.wageFund ?? 0;
    const toKopecks = (value: number): number => Math.round(value * 100) / 100;

    expect(wageFund).toBeGreaterThan(0);
    expect(line?.overheadCost).toBe(toKopecks((wageFund * 95) / 100));
    expect(line?.profitCost).toBe(toKopecks((wageFund * 50) / 100));
  });

  it("две разные книги получают разные нормативы: в этом весь смысл привязки", () => {
    const earth = computeEstimateLine(GRADING_ITEM, RESOLVE(GRADING_ITEM), VARIED, PARAMETERS).line;
    const commissioning = computeEstimateLine(
      BILL_GENERATOR,
      RESOLVE(BILL_GENERATOR),
      VARIED,
      PARAMETERS,
    ).line;

    expect(earth?.overheadPercent).toBe(95);
    expect(commissioning?.overheadPercent).toBe(66);
    expect(earth?.overheadPercent).not.toBe(commissioning?.overheadPercent);
  });

  it("указателя нет — резерв документа, но громко: по пометке на НР и на СП", () => {
    const norm = makeSearchNorm({
      code: "77-77-777-01",
      fullName: "Норма без указателей на нормативы",
      endName: "проверка резерва",
      unit: "м3",
      collectionCode: "77",
      collectionName: "Служебный сборник",
      baseType: "ГЭСН",
    });
    const outcome = computeEstimateLine(
      makeBillItem({ normCode: "77-77-777-01" }),
      { norm, reasons: ["Проверка резерва"] },
      VARIED,
      PARAMETERS,
    );

    expect(countKind(outcome.gaps, "NO_OVERHEAD_RATE")).toBe(2);
    expect(outcome.line?.overheadPercent).toBe(105);
    expect(outcome.line?.profitPercent).toBe(65);
    expect(outcome.line?.overheadSource).toBe("DEFAULT");
    expect(outcome.line?.profitSource).toBe("DEFAULT");
  });

  it("указатель есть, но справочник пуст — тоже резерв и тоже с пометкой", () => {
    const empty = makePriceBook(WAGE_SCALE, { overheadRates: new Map() });
    const outcome = computeEstimateLine(GRADING_ITEM, RESOLVE(GRADING_ITEM), empty, PARAMETERS);

    expect(countKind(outcome.gaps, "NO_OVERHEAD_RATE")).toBe(2);
    expect(outcome.gaps.find((gap) => gap.kind === "NO_OVERHEAD_RATE")?.message).toContain(
      "Пр/812-001.1",
    );
    expect(outcome.line?.overheadSource).toBe("DEFAULT");
    expect(outcome.line?.overheadPercent).toBe(105);
  });

  it("непригодный норматив не подставляется молча: отрицательный процент даёт резерв", () => {
    const broken = makePriceBook(WAGE_SCALE, {
      overheadRates: makeOverheadRates([
        {
          ref: "Пр/812-001.1",
          percent: -5,
          workType: "Испорченная строка справочника",
          source: "тест",
        },
      ]),
    });
    const outcome = computeEstimateLine(GRADING_ITEM, RESOLVE(GRADING_ITEM), broken, PARAMETERS);

    expect(outcome.line?.overheadPercent).toBe(105);
    expect(outcome.line?.overheadSource).toBe("DEFAULT");
    expect(countKind(outcome.gaps, "NO_OVERHEAD_RATE")).toBe(2);
  });

  it("НР и СП разрешаются независимо: потеря одного не теряет второй", () => {
    const halfKnown = makePriceBook(WAGE_SCALE, {
      overheadRates: makeOverheadRates([
        {
          ref: "Пр/812-001.1",
          percent: 95,
          workType: "Земляные работы",
          source: "тест",
        },
      ]),
    });
    const line = computeEstimateLine(GRADING_ITEM, RESOLVE(GRADING_ITEM), halfKnown, PARAMETERS)
      .line;

    expect(line?.overheadPercent).toBe(95);
    expect(line?.overheadSource).toBe("NORM_REF");
    expect(line?.profitPercent).toBe(65);
    expect(line?.profitSource).toBe("DEFAULT");
  });
});

describe("computeEstimateSection", () => {
  const section = makeBillSection("Земляные работы", [GRADING_ITEM, DRAGLINE_ITEM]);

  it("считает подытоги раздела по строкам", () => {
    const computed = computeEstimateSection(section, PRICE_BOOK, PARAMETERS, RESOLVE);

    expect(computed.section.title).toBe("Земляные работы");
    expect(computed.section.lines).toHaveLength(2);
    expect(computed.section.directCost).toBe(218316.52);
    expect(computed.section.overheadCost).toBe(59999.35);
    expect(computed.section.profitCost).toBe(37142.46);
    expect(computed.section.workCost).toBe(315458.33);
  });

  it("позиция без нормы не даёт строки, но даёт пометку раздела", () => {
    const withMissing = makeBillSection("Раздел с пробелом", [
      GRADING_ITEM,
      makeBillItem({ id: "item-missing", normCode: "08-01-001-01", normBaseType: "ГЭСНм" }),
    ]);
    const computed = computeEstimateSection(withMissing, PRICE_BOOK, PARAMETERS, RESOLVE);

    expect(computed.section.lines).toHaveLength(1);
    expect(countKind(computed.gaps, "NO_NORM")).toBe(1);
    expect(computed.section.directCost).toBe(45197.29);
  });

  it("раздел без позиций даёт нули, а не отсутствие итогов", () => {
    const computed = computeEstimateSection(
      makeBillSection("Пустой раздел", []),
      PRICE_BOOK,
      PARAMETERS,
      RESOLVE,
    );

    expect(computed.section.lines).toEqual([]);
    expect(computed.section.workCost).toBe(0);
  });
});

describe("buildEstimate: документ", () => {
  const parameters = makeParameters({
    limited: {
      winterSurchargePercent: 6,
      temporaryStructuresPercent: 2.4,
      source: "Значения заданы для теста; ГСН 81-05-01 и 81-05-02 в выгрузке ФГИС ЦС отсутствуют",
    },
  });

  function buildDocument() {
    return buildEstimate({
      title: "Локальный сметный расчёт на земляные работы",
      sections: [makeBillSection("Земляные работы", [GRADING_ITEM, DRAGLINE_ITEM])],
      priceBook: PRICE_BOOK,
      parameters,
      resolveNorm: RESOLVE,
      sources: SOURCES,
      generatedAt: "2026-09-26T09:00:00.000Z",
      disclaimer:
        "Расчёт носит информационно-аналитический характер и не заменяет смету, составленную аттестованным сметчиком.",
    });
  }

  it("начисляет лимитированные затраты последовательно, а НДС сверху", () => {
    const totals = buildDocument().totals;

    expect(totals.directCost).toBe(218316.52);
    expect(totals.wageFund).toBe(57142.24);
    expect(totals.workCost).toBe(315458.33);
    // Начисление последовательное: временные здания 315 458,33 × 2,4 % = 7 571,
    // зимнее удорожание уже от суммы с ними — (315 458,33 + 7 571) × 6 %.
    expect(totals.temporaryStructures).toBe(7571);
    expect(totals.winterSurcharge).toBe(19381.76);
    expect(totals.beforeVat).toBe(342411.09);
    expect(totals.vat).toBe(68482.22);
    expect(totals.total).toBe(410893.31);
  });

  it("хранит в документе реквизиты зоны, шкалу и источники, чтобы результат можно было проверить позже", () => {
    const document = buildDocument();

    expect(document.method).toBe("RESOURCE_INDEX");
    expect(document.region).toBe("Амурская область");
    expect(document.priceZone).toBe("Амурская область (1 зона)");
    expect(document.period).toBe("3 квартал 2026 г.");
    expect(document.wageScale.anchors).toHaveLength(33);
    expect(document.wageScale.baseSalary).toBe(548.86);
    expect(document.wageScale.maxRank).toBe(9);
    expect(document.sources).toHaveLength(3);
    expect(document.generatedAt).toBe("2026-09-26T09:00:00.000Z");
  });

  it("проходит собственную сверку арифметики и честности пометок", () => {
    expect(auditEstimateArithmetic(parseEstimateDocument(buildDocument()))).toEqual([]);
  });

  it("без лимитированных затрат итог без НДС равен стоимости СМР", () => {
    const totals = computeTotals(buildDocument().sections, PARAMETERS);

    expect(totals.winterSurcharge).toBe(0);
    expect(totals.temporaryStructures).toBe(0);
    expect(totals.beforeVat).toBe(315458.33);
    expect(totals.vat).toBe(63091.67);
    expect(totals.total).toBe(378550);
  });
});

describe("buildEstimate: пометки и книги", () => {
  function documentWith(items: readonly BillOfWorkItem[], priceBook: EstimatePriceBook = PRICE_BOOK) {
    return buildEstimate({
      title: "Проверка пометок",
      sections: [makeBillSection("Раздел", items)],
      priceBook,
      parameters: PARAMETERS,
      resolveNorm: RESOLVE,
      sources: SOURCES,
      generatedAt: "2026-09-26T09:00:00.000Z",
      disclaimer: "Расчёт носит информационно-аналитический характер.",
    });
  }

  // Одна и та же машина 91.01.01-035 входит в две разные нормы. Тексты пометок
  // совпадают, но позиции разные, и сметчику нужно видеть обе: иначе он решит,
  // что вопрос закрыт, и не станет искать цену для второй работы.
  it("одна и та же отсутствующая цена в двух позициях даёт две пометки", () => {
    const document = documentWith([DRAGLINE_ITEM, SLOPE_ITEM], makePriceBook(WAGE_SCALE, { base: EMPTY_BASE }));
    const noPrice = document.gaps.filter((gap) => gap.kind === "NO_PRICE");
    const bulldozer = noPrice.filter((gap) => gap.message.includes("91.01.01-035"));

    expect(bulldozer).toHaveLength(2);
    expect(bulldozer.map((gap) => gap.code).sort()).toEqual(["01-01-001-01", "01-01-050-01"]);
  });

  it("пробежавшая дедупликация не ломает сверку честности второй позиции", () => {
    const document = documentWith([DRAGLINE_ITEM, SLOPE_ITEM], makePriceBook(WAGE_SCALE, { base: EMPTY_BASE }));

    expect(auditEstimateArithmetic(parseEstimateDocument(document))).toEqual([]);
  });

  it("одинаковые пометки одной позиции не повторяются", () => {
    const document = documentWith([SLOPE_ITEM, SLOPE_ITEM]);
    const noCurrent = document.gaps.filter((gap) => gap.kind === "NO_CURRENT_PRICE");

    expect(noCurrent).toHaveLength(7);
    expect(document.gaps).toHaveLength(9);
  });

  // Код «01-01-001-01» есть и в ГЭСН, и в ГЭСНп, и это четыре разные работы.
  // Пометка, привязанная к одной книге, не закрывает вопрос по другой.
  it("пометка одной книги не закрывает ту же позицию другой книги", () => {
    const document = documentWith([DRAGLINE_ITEM, GENERATOR_ITEM]);
    const sameCode = document.gaps.filter((gap) => gap.code === "01-01-001-01");

    expect(new Set(sameCode.map((gap) => gap.baseType))).toEqual(new Set(["ГЭСН", "ГЭСНп"]));
    const [earthworks, puskonaladka] = document.sections[0]?.lines ?? [];
    expect(earthworks?.normBaseType).toBe("ГЭСН");
    expect(puskonaladka?.normBaseType).toBe("ГЭСНп");
    for (const gap of earthworks?.gaps ?? []) {
      expect(gap.baseType).toBe("ГЭСН");
      expect(gap.kind).not.toBe("NO_WAGE");
    }
    expect(countKind(puskonaladka?.gaps ?? [], "NO_WAGE")).toBe(3);
    expect(auditEstimateArithmetic(parseEstimateDocument(document))).toEqual([]);
  });

  it("пробелы позиции хранятся в самой позиции, а не только в конце документа", () => {
    const document = documentWith([SLOPE_ITEM]);
    const line = document.sections[0]?.lines[0];

    expect(line?.gaps).toHaveLength(9);
    expect(document.gaps).toHaveLength(9);
  });

  it("документ без рассчитанных позиций проходит схему, но сверка это показывает", () => {
    const document = documentWith([
      makeBillItem({ id: "item-none", normCode: "08-01-001-01", normBaseType: "ГЭСНм" }),
    ]);

    expect(document.sections[0]?.lines).toEqual([]);
    expect(document.totals.total).toBe(0);
    expect(countKind(document.gaps, "NO_NORM")).toBe(1);
    expect(auditEstimateArithmetic(parseEstimateDocument(document))).toEqual([
      "В смете нет ни одной рассчитанной позиции",
    ]);
  });
});

/**
 * Позиция-ресурс: материал или машина, поставляемые по прямой цене.
 *
 * Ведомость заказчика перечисляет работы и поставки вперемешку, и различает их
 * колонка обоснования: «ГЭСН09-03-002-01» — расценка, «ФСБЦ-07.2.07.12-0068» —
 * ресурс. Позиция-ресурс считается ценой за единицу на объём и в подбор
 * расценки не идёт.
 *
 * Труда, машин, накладных расходов и сметной прибыли у такой позиции нет.
 * Это не упрощение: труд на укладку материала несёт работа, в которой он
 * уложен, а начислить его ещё раз на саму поставку — значит посчитать одну и
 * ту же бригаду дважды. Живой прогон на смете 02-01-02-КМ1 показал цену
 * ошибки: пять поставок, принятых за работы, дали 1 000,72 чел.-ч вместо
 * 601,21 у сметчика.
 */
describe("computeResourceLine: позиция-поставка", () => {
  const GEOTEXTILE = makeBillItem({
    workName: "Геополотно нетканое полипропиленовое, 150 г/м2",
    quantity: 100,
    quantityUnit: "м2",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    resourceCode: "01.7.12.05-0131",
  });

  it("стоимость — цена за единицу на объём", () => {
    const outcome = computeResourceLine(GEOTEXTILE, PRICE_BOOK, PARAMETERS);

    // 37,97 ₽ × 100 м2 = 3 797 ₽.
    expect(outcome.line?.materialCost).toBe(3797);
    expect(outcome.line?.directCost).toBe(3797);
  });

  it("труда и машин у поставки нет", () => {
    const outcome = computeResourceLine(GEOTEXTILE, PRICE_BOOK, PARAMETERS);

    expect(outcome.line?.labourHours).toBe(0);
    expect(outcome.line?.labourCost).toBe(0);
    expect(outcome.line?.machinistHours).toBe(0);
    expect(outcome.line?.machineCost).toBe(0);
  });

  it("накладные расходы и сметная прибыль на поставку не начисляются", () => {
    const outcome = computeResourceLine(GEOTEXTILE, PRICE_BOOK, PARAMETERS);

    expect(outcome.line?.wageFund).toBe(0);
    expect(outcome.line?.overheadCost).toBe(0);
    expect(outcome.line?.profitCost).toBe(0);
  });

  it("в строке печатается код ресурса и справочник, а не расценка", () => {
    const outcome = computeResourceLine(GEOTEXTILE, PRICE_BOOK, PARAMETERS);

    expect(outcome.line?.normCode).toBe("01.7.12.05-0131");
    expect(outcome.line?.normBaseType).toBe("ФСБЦ");
    expect(outcome.line?.resources).toHaveLength(1);
    expect(outcome.line?.resources[0]?.kind).toBe("MATERIAL");
  });

  it("объём не положителен — строки нет", () => {
    const outcome = computeResourceLine(
      makeBillItem({ ...GEOTEXTILE, quantity: 0 }),
      PRICE_BOOK,
      PARAMETERS,
    );

    expect(outcome.line).toBeNull();
    expect(outcome.gaps[0]?.kind).toBe("BAD_QUANTITY");
  });

  it("единицы ведомости и справочника расходятся — это видно, но считать можно", () => {
    const outcome = computeResourceLine(
      makeBillItem({ ...GEOTEXTILE, quantityUnit: "м3" }),
      PRICE_BOOK,
      PARAMETERS,
    );

    expect(countKind(outcome.gaps, "UNIT_MISMATCH")).toBe(1);
    expect(outcome.line?.materialCost).toBe(3797);
  });
});

describe("раздел с поставками", () => {
  it("позиция-ресурс не уходит в подбор расценки", () => {
    const seen: string[] = [];
    const section = makeBillSection("Поставки", [
      makeBillItem({
        id: "supply-1",
        workName: "Геополотно нетканое полипропиленовое, 150 г/м2",
        quantity: 100,
        quantityUnit: "м2",
        unitDivisor: 1,
        normCode: null,
        normBaseType: null,
        resourceCode: "01.7.12.05-0131",
      }),
    ]);

    const outcome = computeEstimateSection(
      section,
      PRICE_BOOK,
      PARAMETERS,
      (item) => {
        seen.push(item.id);
        return RESOLVE(item);
      },
    );

    expect(seen).toEqual([]);
    expect(outcome.section.lines).toHaveLength(1);
    expect(outcome.section.directCost).toBe(3797);
  });
});

/**
 * Единица поставки берётся из справочника, а не выводится из вида ресурса.
 *
 * У материалов единица своя у каждого кода — «т», «м3», «м2», «шт», — и
 * `unitForResourceKind` для них честно возвращает пустую строку: по виду
 * ресурса её не угадать. Подставлять эту пустоту в строку сметы значит
 * напечатать «12,5 » без единицы и поднять ложное расхождение единиц на
 * каждой поставке.
 */
describe("единица позиции-поставки", () => {
  const STEEL = makeBillItem({
    workName: "Геополотно нетканое полипропиленовое, 150 г/м2",
    quantity: 100,
    quantityUnit: "м2",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    resourceCode: "01.7.12.05-0131",
  });

  it("единица печатается из справочника", () => {
    const outcome = computeResourceLine(STEEL, PRICE_BOOK, PARAMETERS);

    expect(outcome.line?.normUnit).toBe("м2");
    expect(outcome.line?.resources[0]?.unit).toBe("м2");
  });

  it("совпадающая единица не поднимает расхождения", () => {
    const outcome = computeResourceLine(STEEL, PRICE_BOOK, PARAMETERS);

    expect(countKind(outcome.gaps, "UNIT_MISMATCH")).toBe(0);
  });

  it("расхождение с единицей справочника по-прежнему видно", () => {
    const outcome = computeResourceLine(
      makeBillItem({ ...STEEL, quantityUnit: "м3" }),
      PRICE_BOOK,
      PARAMETERS,
    );

    expect(countKind(outcome.gaps, "UNIT_MISMATCH")).toBe(1);
    // Не gaps[0]: первым идёт NO_CURRENT_PRICE от оценки ресурса.
    const mismatch = outcome.gaps.find((gap) => gap.kind === "UNIT_MISMATCH");
    expect(mismatch?.message).toContain("м2");
    expect(mismatch?.message).toContain("м3");
  });
});
