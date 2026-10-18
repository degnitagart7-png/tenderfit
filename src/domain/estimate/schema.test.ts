import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { buildEstimate, type EstimatePriceBook } from "@/domain/estimate/calculate";
import {
  auditEstimateArithmetic,
  parseEstimateDocument,
  type EstimateDocumentDto,
  type EstimateLineDto,
  type EstimateResourceDto,
} from "@/domain/estimate/schema";
import type {
  BillOfWorkItem,
  EstimateDocument,
  EstimateGapKind,
  EstimateParameters,
  EstimateSource,
  ResourcePrice,
} from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
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
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/**
 * Схема сметного документа и сверка его арифметики.
 *
 * Тесты расчёта в `calculate.test.ts` проверяют, что числа получаются верными.
 * Этот файл проверяет обратное: что неверное число не сможет пройти незамеченным.
 * Разница не академическая. Партнёр может отнести напечатанный итог заказчику,
 * поэтому опасны не ошибки, а молчаливые ошибки — `NaN` в цене ресурса, который
 * обнуляет позицию без единой пометки, или ставка, продолженная за пределы
 * тарифной шкалы, о которой в отчёте никто не сказал.
 *
 * Сюжета два.
 *
 * Первый — схема отвергает то, что выглядит как число, но им не является, и то,
 * что выглядит как допустимое значение перечисления, но им не является. Вид
 * ресурса здесь не формальность: по нему сверка решает, входит ресурс в прямые
 * затраты или нет, и неизвестный вид молча выпал бы из суммы.
 *
 * Второй — сверка требует объяснения для каждого послабления. Нулевая ставка
 * труда, нулевая цена машины или материала и ставка вне известных разрядов
 * обязаны иметь пометку в gaps; без неё занижение итога не видно. Пометка при
 * этом привязана к паре «книга + код»: в выгрузке ФГИС ЦС 2 784 кода встречаются
 * больше чем в одной книге, и «01-01-001-01» — это экскаватор-драглайн в ГЭСН и
 * пусконаладка генератора в ГЭСНп. Пробел одной из двух работ не закрывает
 * вопрос по второй.
 */

const WAGE_SCALE = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);
const PRICE_BOOK = makePriceBook(WAGE_SCALE);
const PARAMETERS = makeParameters();

/** Книга цен без базы 2022 года: остаётся только текущее покрытие зоны. */
const EMPTY_BASE: ReadonlyMap<string, ResourcePrice> = new Map<string, ResourcePrice>();

/**
 * Шкала, обрезанная до разряда 3,4 — только ставки реестра рабочих. Разряд 4 в
 * ней продолжается по наклону крайнего участка и даёт 735,47 ₽.
 */
const NARROW_BOOK = makePriceBook(
  buildWageScale(
    AMUR_WAGE_ANCHORS.filter((anchor) => anchor.rank <= 3.4),
    AMUR_ZONE,
  ),
);

const RESOLVE = makeResolver([
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  NORM_DRAINAGE_100,
  NORM_SLOPE_REINFORCEMENT,
  NORM_PUSKONALADKA_GENERATOR,
  NORM_DREDGER_800,
]);

/**
 * Индексы пересчёта Минстроя. Значения произвольные: письма с индексами
 * опубликованы только в PDF, в выгрузке ФГИС ЦС их нет, и мы их не разбирали.
 */
const INDICES = {
  period: "III квартал 2026 г.",
  labour: 1.09,
  machinistLabour: 1.12,
  machines: 1.15,
  materials: 1.22,
  source: "Значения заданы для теста; письма Минстроя опубликованы только в PDF",
} as const;

const SOURCES: readonly EstimateSource[] = [
  {
    title: "ФСНБ-2022: нормы ГЭСН и Федеральная сметная база цен",
    url: "https://fgiscs.minstroyrf.ru/frsn/fsnb",
    edition: "редакция 12.08.2026, приказ Минстроя России № 527/пр",
  },
];

const DISCLAIMER = "Расчёт носит информационно-аналитический характер.";

function build(
  items: readonly BillOfWorkItem[],
  priceBook: EstimatePriceBook = PRICE_BOOK,
  parameters: EstimateParameters = PARAMETERS,
): EstimateDocumentDto {
  return parseEstimateDocument(
    buildEstimate({
      title: "Локальный сметный расчёт на земляные работы",
      sections: [makeBillSection("Земляные работы", items)],
      priceBook,
      parameters,
      resolveNorm: RESOLVE,
      sources: SOURCES,
      generatedAt: "2026-09-26T09:00:00.000Z",
      disclaimer: DISCLAIMER,
    }),
  );
}

/** Две позиции: ручной труд без пробелов и машина с ценами двух уровней. */
const DOCUMENT = build([BILL_GRADING, BILL_DRAGLINE]);

type SectionDto = EstimateDocumentDto["sections"][number];

/** Строка сметы по коду нормы. Падает, если такой строки в документе нет. */
function lineOf(document: EstimateDocumentDto, normCode: string): EstimateLineDto {
  for (const section of document.sections) {
    const found = section.lines.find((line) => line.normCode === normCode);
    if (found !== undefined) return found;
  }
  throw new Error(`В документе нет строки с нормой ${normCode}`);
}

function resourceOf(line: EstimateLineDto, code: string): EstimateResourceDto {
  const found = line.resources.find((resource) => resource.code === code);
  if (found === undefined) throw new Error(`В расшифровке нет ресурса ${code}`);
  return found;
}

/** Копия документа с изменённой строкой сметы. */
function patchLine(
  document: EstimateDocumentDto,
  normCode: string,
  patch: (line: EstimateLineDto) => EstimateLineDto,
): EstimateDocumentDto {
  let touched = false;
  const sections = document.sections.map((section) => ({
    ...section,
    lines: section.lines.map((line) => {
      if (line.normCode !== normCode) return line;
      touched = true;
      return patch(line);
    }),
  }));
  if (!touched) throw new Error(`В документе нет строки с нормой ${normCode}`);
  return { ...document, sections };
}

/** Копия документа с изменённым ресурсом в расшифровке строки. */
function patchResource(
  document: EstimateDocumentDto,
  normCode: string,
  resourceCode: string,
  patch: (resource: EstimateResourceDto) => EstimateResourceDto,
): EstimateDocumentDto {
  return patchLine(document, normCode, (line) => {
    let touched = false;
    const resources = line.resources.map((resource) => {
      if (resource.code !== resourceCode) return resource;
      touched = true;
      return patch(resource);
    });
    if (!touched) throw new Error(`В строке ${normCode} нет ресурса ${resourceCode}`);
    return { ...line, resources };
  });
}

function patchSection(
  document: EstimateDocumentDto,
  patch: (section: SectionDto) => SectionDto,
): EstimateDocumentDto {
  return { ...document, sections: document.sections.map(patch) };
}

/**
 * Копия документа с подменой поля ресурса значением, которое доменные типы не
 * допускают.
 *
 * Схема стоит на границе, куда данные приходят извне типов — из строки базы или
 * из чужого JSON, — поэтому проверять её на заведомо недопустимых значениях
 * можно только в обход компилятора. Обход собран здесь, а не размазан
 * приведениями по тестам, и возвращает `unknown`: дальше значение всё равно
 * уходит в `parseEstimateDocument`, который принимает что угодно.
 */
function breakResource(
  document: EstimateDocumentDto,
  normCode: string,
  resourceCode: string,
  override: Record<string, unknown>,
): unknown {
  const sections = document.sections.map((section) => ({
    ...section,
    lines: section.lines.map((line) =>
      line.normCode === normCode
        ? {
            ...line,
            resources: line.resources.map((resource) =>
              resource.code === resourceCode ? { ...resource, ...override } : resource,
            ),
          }
        : line,
    ),
  }));
  return { ...document, sections };
}

/** Убрать из документа пометки одного вида — как если бы расчёт их не выставил. */
function dropGaps(document: EstimateDocumentDto, kind: EstimateGapKind): EstimateDocumentDto {
  return { ...document, gaps: document.gaps.filter((gap) => gap.kind !== kind) };
}

/** Переписать книгу у пометок одного вида. */
function rebaseGaps(
  document: EstimateDocumentDto,
  kind: EstimateGapKind,
  baseType: string | null,
): EstimateDocumentDto {
  return {
    ...document,
    gaps: document.gaps.map((gap) => (gap.kind === kind ? { ...gap, baseType } : gap)),
  };
}

function hasGap(document: EstimateDocumentDto, kind: EstimateGapKind): boolean {
  return document.gaps.some((gap) => gap.kind === kind);
}

/** Отказ схемы: возвращает нарушение, а не роняет тест непонятным образом. */
function violation(input: unknown): ZodError {
  try {
    parseEstimateDocument(input);
  } catch (error) {
    if (error instanceof ZodError) return error;
    throw error;
  }
  throw new Error("Схема приняла документ, который обязана была отвергнуть");
}

/** Пути полей, на которые схема указала при отказе. */
function rejectedPaths(input: unknown): string[] {
  return violation(input).issues.map((issue) => issue.path.join("."));
}

describe("parseEstimateDocument: документ расчёта", () => {
  it("принимает собранный расчётом документ без потерь", () => {
    const raw = buildEstimate({
      title: "Локальный сметный расчёт на земляные работы",
      sections: [makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE])],
      priceBook: PRICE_BOOK,
      parameters: PARAMETERS,
      resolveNorm: RESOLVE,
      sources: SOURCES,
      generatedAt: "2026-09-26T09:00:00.000Z",
      disclaimer: DISCLAIMER,
    });
    const parsed = parseEstimateDocument(raw);

    // Глубокое равенство важнее, чем «не бросает»: схема Zod по умолчанию
    // отбрасывает неизвестные поля. Если бы расчёт добавил в документ поле,
    // которого в схеме нет, оно исчезло бы здесь молча.
    expect(parsed).toEqual(raw);
    expect(auditEstimateArithmetic(parsed)).toEqual([]);
  });

  it("раздел документа-основания сохраняется при разборе, а старые сметы без него читаются", () => {
    const raw = buildEstimate({
      title: "Раздел заказчика",
      sections: [
        makeBillSection("Земляные работы", [{ ...BILL_GRADING, billSection: "Ремонтные работы" }, BILL_DRAGLINE]),
      ],
      priceBook: PRICE_BOOK,
      parameters: PARAMETERS,
      resolveNorm: RESOLVE,
      sources: SOURCES,
      generatedAt: "2026-09-26T09:00:00.000Z",
      disclaimer: DISCLAIMER,
    });
    const parsed = parseEstimateDocument(JSON.parse(JSON.stringify(raw)));
    const lines = parsed.sections.flatMap((section) => section.lines);

    expect(lines.map((line) => line.billSection ?? null)).toEqual(["Ремонтные работы", null]);
  });

  it("основание выбора ценовой зоны проходит разбор; у старых смет его нет", () => {
    const raw = buildEstimate({
      title: "Зона",
      sections: [makeBillSection("Документ", [BILL_GRADING])],
      priceBook: PRICE_BOOK,
      parameters: PARAMETERS,
      resolveNorm: RESOLVE,
      sources: SOURCES,
      generatedAt: "2026-09-26T09:00:00.000Z",
      disclaimer: DISCLAIMER,
      priceZoneChoice: { basis: "MUNICIPALITY", matched: "Кабанский р-н" },
    });
    expect(parseEstimateDocument(JSON.parse(JSON.stringify(raw))).priceZoneChoice).toEqual({
      basis: "MUNICIPALITY",
      matched: "Кабанский р-н",
    });

    const { priceZoneChoice: _omitted, ...old } = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    void _omitted;
    expect(parseEstimateDocument(old).priceZoneChoice).toBeUndefined();
    expect(() => parseEstimateDocument({ ...old, priceZoneChoice: { basis: "ВЫДУМАНО", matched: null } })).toThrow();
    // Основание «по ценам сметы заказчика» — настоящее: документ с ним проходит разбор.
    expect(parseEstimateDocument({ ...old, priceZoneChoice: { basis: "CUSTOMER_PRICES", matched: "1-100-31, 4-100-040" } }).priceZoneChoice).toEqual({
      basis: "CUSTOMER_PRICES",
      matched: "1-100-31, 4-100-040",
    });
  });

  it("ставки специалистов и машинистов в шкале документа проходят разбор; у старых смет их нет", () => {
    const priceBook = makePriceBook(
      buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE, {
        specialists: [{ code: "3-200-03", name: "Инженер III категории", salary: 965.99, source: "Реестр" }],
        machinists: [{ rank: 4.3, salary: 768.4, source: "Реестр" }],
      }),
    );
    const raw = buildEstimate({
      title: "Шкала",
      sections: [makeBillSection("Документ", [BILL_GRADING])],
      priceBook,
      parameters: PARAMETERS,
      resolveNorm: RESOLVE,
      sources: SOURCES,
      generatedAt: "2026-09-26T09:00:00.000Z",
      disclaimer: DISCLAIMER,
    });
    const parsed = parseEstimateDocument(JSON.parse(JSON.stringify(raw)));

    expect(parsed.wageScale.specialists).toEqual([{ code: "3-200-03", name: "Инженер III категории", salary: 965.99, source: "Реестр" }]);
    expect(parsed.wageScale.machinists).toHaveLength(1);
    expect(parseEstimateDocument(JSON.parse(JSON.stringify(build([BILL_GRADING])))).wageScale.specialists).toBeUndefined();
  });

  it("раздел в пробеле позиции сохраняется при разборе", () => {
    const raw = buildEstimate({
      title: "Пробел с разделом",
      sections: [
        makeBillSection("Документ", [
          BILL_GRADING,
          { ...BILL_DRAGLINE, id: "x", normCode: "08-01-001-01", normBaseType: "ГЭСНм", billSection: "Ремонт" },
        ]),
      ],
      priceBook: PRICE_BOOK,
      parameters: PARAMETERS,
      resolveNorm: RESOLVE,
      sources: SOURCES,
      generatedAt: "2026-09-26T09:00:00.000Z",
      disclaimer: DISCLAIMER,
    });
    const parsed = parseEstimateDocument(JSON.parse(JSON.stringify(raw)));

    expect(parsed.gaps.find((gap) => gap.kind === "NO_NORM")?.billSection).toBe("Ремонт");
  });

  it("описывает документ расчёта целиком", () => {
    // Присваивание DTO доменному типу — проверка на уровне типов: поле, которое
    // схема потеряла или переименовала, не компилируется. В обратную сторону
    // присваивание не работает и не должно: доменные массивы объявлены
    // `readonly`, а схема принимает `unknown`, потому что её работа — проверять
    // то, что пришло извне типов.
    const dto: EstimateDocumentDto = parseEstimateDocument(
      buildEstimate({
        title: "Проверка соответствия типов",
        sections: [],
        priceBook: PRICE_BOOK,
        parameters: PARAMETERS,
        resolveNorm: RESOLVE,
        sources: SOURCES,
        generatedAt: "2026-09-26T09:00:00.000Z",
        disclaimer: DISCLAIMER,
      }),
    );
    const asDomain: EstimateDocument = dto;

    expect(asDomain.method).toBe("RESOURCE_INDEX");
    expect(asDomain.sections).toEqual([]);
    // Шкала лежит в самом документе, чтобы итог можно было проверить спустя
    // время, не восстанавливая, какие ставки тогда использовались.
    expect(asDomain.wageScale.anchors).toHaveLength(33);
    expect(asDomain.wageScale.baseSalary).toBe(548.86);
  });

  it("хранит индексы пересчёта, когда они заданы, и null, когда их нет", () => {
    expect(DOCUMENT.parameters.indices).toBeNull();

    const indexed = build([BILL_GRADING], PRICE_BOOK, makeParameters({ indices: INDICES }));

    expect(indexed.parameters.indices?.period).toBe("III квартал 2026 г.");
    expect(indexed.parameters.indices?.labour).toBe(1.09);
    expect(indexed.parameters.indices?.materials).toBe(1.22);
    expect(indexed.parameters.indices?.source).toContain("заданы для теста");
  });

  it("не подменяет отсутствующие индексы единицей", () => {
    // «Не задано» и «равно единице» — разные утверждения: во втором случае
    // отчёт сказал бы, что пересчёт выполнен. Поэтому поле обязательно.
    const broken = {
      ...DOCUMENT,
      parameters: { ...DOCUMENT.parameters, indices: undefined },
    };

    expect(rejectedPaths(broken)).toContain("parameters.indices");
  });
});

describe("parseEstimateDocument: числа", () => {
  it("не пропускает NaN в цене ресурса", () => {
    // NaN в цене даёт NaN в стоимости позиции, а оттуда — в итог: напечатанная
    // смета с «не числом» вместо суммы хуже любой заниженной суммы. Zod
    // отвергает NaN ещё до уточнения, поэтому сообщение здесь стандартное;
    // важно, что значение не проходит вовсе.
    const broken = patchResource(DOCUMENT, "01-01-001-01", "91.01.01-035", (resource) => ({
      ...resource,
      unitPrice: Number.NaN,
    }));

    const paths = rejectedPaths(broken);
    expect(paths.some((path) => path.endsWith("unitPrice"))).toBe(true);
    expect(violation(broken).issues[0]?.message).toBe("Expected number, received nan");
  });

  it("не пропускает бесконечность и объясняет отказ по-русски", () => {
    // Бесконечность `z.number()` принимает: это число. Отсекает её только
    // уточнение, и без него в итог могло бы уйти «бесконечно ₽» — значение,
    // которое форматтер напечатал бы как есть.
    const broken = { ...DOCUMENT, totals: { ...DOCUMENT.totals, total: Number.POSITIVE_INFINITY } };
    const error = violation(broken);

    expect(error.issues[0]?.message).toBe(
      "Ожидалось конечное число, а не NaN или бесконечность",
    );
    expect(error.issues[0]?.path).toEqual(["totals", "total"]);
  });

  it("не пропускает NaN в объёме позиции", () => {
    const broken = patchLine(DOCUMENT, "01-01-111-01", (line) => ({
      ...line,
      billQuantity: Number.NaN,
    }));

    expect(rejectedPaths(broken).some((path) => path.endsWith("billQuantity"))).toBe(true);
  });

  it("отдаёт нарушения списком с путями, чтобы их можно было напечатать", () => {
    const broken = {
      ...DOCUMENT,
      totals: { ...DOCUMENT.totals, vat: Number.POSITIVE_INFINITY, total: Number.NaN },
    };
    const error = violation(broken);

    // CLI-отчёт печатает именно эту пару «путь: сообщение», поэтому форма
    // нарушения — часть договора со скриптом, а не внутренняя деталь Zod.
    expect(error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([
      "totals.vat: Ожидалось конечное число, а не NaN или бесконечность",
      "totals.total: Expected number, received nan",
    ]);
  });
});

describe("parseEstimateDocument: значения перечислений", () => {
  it("не пропускает неизвестный метод расчёта", () => {
    expect(rejectedPaths({ ...DOCUMENT, method: "OTHER_INDEX" })).toContain("method");
  });

  it("базисно-индексный метод принимается только со сведениями об индексах, ресурсно-индексный — без них", () => {
    // Документ БИМ без `bim` — по нему не проверить, чем пересчитаны цены; и наоборот: сведения БИМ у ресурсной сметы — путаница методов.
    expect(rejectedPaths({ ...DOCUMENT, method: "BASE_INDEX" })).toContain("bim");
    const bim = {
      basis: "CUSTOMER",
      basisNote: "смета заказчика на ФЕР",
      subject: "Белгородская область",
      zone: null,
      quarter: "III кв. 2026",
      object: "Прочие объекты",
      objectDetected: false,
      customerBase: "FER",
      indexLabour: 47.58,
      indexMachines: 15.15,
      indexMaterials: 9.58,
      letter: "письмо Минстроя",
    };
    expect(rejectedPaths({ ...DOCUMENT, bim })).toContain("bim");
    expect(() => parseEstimateDocument({ ...DOCUMENT, method: "BASE_INDEX", bim })).not.toThrow();
  });

  it("не пропускает выдуманный вид пробела", () => {
    const broken = {
      ...DOCUMENT,
      gaps: [{ kind: "MAYBE", message: "Что-то не так", code: null, baseType: null }],
    };

    expect(rejectedPaths(broken)).toContain("gaps.0.kind");
  });

  it("не пропускает выдуманный источник цены", () => {
    const broken = breakResource(DOCUMENT, "01-01-001-01", "91.01.01-035", {
      source: "GUESSED",
    });

    expect(rejectedPaths(broken).some((path) => path.endsWith("source"))).toBe(true);
  });

  it("не пропускает выдуманный вид ресурса", () => {
    // Вид решает, войдёт ресурс в прямые затраты или нет: сверка суммирует
    // MACHINE и MATERIAL и отдельно LABOUR. Неизвестный вид выпал бы из обеих
    // сумм, и итог перестал бы сходиться с расшифровкой без объяснения.
    const broken = breakResource(DOCUMENT, "01-01-001-01", "91.01.01-035", {
      kind: "EQUIPMENT",
    });

    expect(rejectedPaths(broken).some((path) => path.endsWith("kind"))).toBe(true);
  });

  it("принимает каждый источник цены, который выдаёт расчёт", () => {
    // Перечисление в схеме обязано покрывать все значения, которые кладёт в
    // строку расчёт: пропущенное означало бы отказ на честном документе.
    // Пять источников собраны из трёх позиций — по одной на случай.
    const withoutIndices = build([BILL_SLOPE, BILL_DRAGLINE, BILL_GENERATOR]);
    const withIndices = build([BILL_DRAGLINE], PRICE_BOOK, makeParameters({ indices: INDICES }));

    const sources = new Set(
      [...withoutIndices.sections, ...withIndices.sections].flatMap((section) =>
        section.lines.flatMap((line) => line.resources.map((resource) => resource.source)),
      ),
    );

    expect(sources).toEqual(
      new Set(["CURRENT_ZONE", "BASE_2022", "BASE_2022_INDEXED", "WAGE_SCALE", "UNPRICED"]),
    );
  });

  it("принимает отсутствие разряда у машины и разряд у труда", () => {
    // `wageOrigin` описывает, откуда взялась ставка человека. У машины его нет,
    // и null здесь — не «неизвестно», а «неприменимо».
    const dragline = lineOf(DOCUMENT, "01-01-001-01");

    expect(resourceOf(dragline, "91.01.01-035").wageOrigin).toBeNull();
    expect(resourceOf(dragline, "1-100-38").wageOrigin).toBe("INTERPOLATED");
    expect(resourceOf(lineOf(DOCUMENT, "01-01-111-01"), "1-100-30").wageOrigin).toBe("ANCHOR");
  });
});

describe("parseEstimateDocument: обязательный текст", () => {
  it("не пропускает пустые реквизиты документа", () => {
    expect(rejectedPaths({ ...DOCUMENT, title: "" })).toContain("title");
    expect(rejectedPaths({ ...DOCUMENT, region: "" })).toContain("region");
    expect(rejectedPaths({ ...DOCUMENT, priceZone: "" })).toContain("priceZone");
    expect(rejectedPaths({ ...DOCUMENT, period: "" })).toContain("period");
    expect(rejectedPaths({ ...DOCUMENT, baseEdition: "" })).toContain("baseEdition");
    expect(rejectedPaths({ ...DOCUMENT, generatedAt: "" })).toContain("generatedAt");
  });

  it("не пропускает пустое предупреждение", () => {
    // Пустая строка здесь прошла бы как «дисклеймер есть», и экран с итогами
    // остался бы без оговорки, что это не сметная документация.
    expect(rejectedPaths({ ...DOCUMENT, disclaimer: "" })).toContain("disclaimer");
  });

  it("не пропускает пустую пометку пробела", () => {
    // Правило проекта: отфильтрованное или непросчитанное объясняется одной
    // фразой. Пометка без текста — это как раз исчезновение без объяснения.
    const broken = {
      ...DOCUMENT,
      gaps: [{ kind: "NO_PRICE", message: "", code: "91.01.01-035", baseType: "ГЭСН" }],
    };

    expect(rejectedPaths(broken)).toContain("gaps.0.message");
  });

  it("не пропускает источник данных без адреса", () => {
    const broken = {
      ...DOCUMENT,
      sources: [{ title: "ФСНБ-2022", url: "", edition: "редакция 12.08.2026" }],
    };

    expect(rejectedPaths(broken)).toContain("sources.0.url");
  });

  it("не пропускает пустое указание на происхождение нормативов", () => {
    // НР, СП, лимитированные затраты и индексы в открытых данных отсутствуют и
    // введены вручную. Без строки `source` это выглядело бы как данные из базы.
    const broken = {
      ...DOCUMENT,
      parameters: { ...DOCUMENT.parameters, overhead: { ...DOCUMENT.parameters.overhead, source: "" } },
    };

    expect(rejectedPaths(broken)).toContain("parameters.overhead.source");
  });

  it("принимает null вместо кода и книги у пометки", () => {
    const document = parseEstimateDocument({
      ...DOCUMENT,
      gaps: [{ kind: "QUANTITY_BY_PROJECT", message: "Объём определяет проект", code: null, baseType: null }],
    });

    expect(document.gaps[0]?.code).toBeNull();
    expect(document.gaps[0]?.baseType).toBeNull();
  });
});

describe("auditEstimateArithmetic: подытоги раздела", () => {
  it("видит расхождение прямых затрат раздела с суммой строк", () => {
    const broken = patchSection(DOCUMENT, (section) => ({
      ...section,
      directCost: section.directCost + 100,
    }));
    const problems = auditEstimateArithmetic(broken);

    expect(problems[0]).toContain("Раздел «Земляные работы»");
    expect(problems[0]).toContain("218316.52");
    expect(problems[0]).toContain("218416.52");
  });

  it("видит расхождение стоимости работ раздела", () => {
    const broken = patchSection(DOCUMENT, (section) => ({
      ...section,
      workCost: section.workCost + 50,
    }));

    expect(auditEstimateArithmetic(broken)).toContain(
      "Раздел «Земляные работы»: стоимость работ 315508.33 не равна сумме прямых затрат, НР и СП 315458.33",
    );
  });

  it("видит расхождение итога документа с суммой разделов", () => {
    const broken = {
      ...DOCUMENT,
      totals: { ...DOCUMENT.totals, workCost: DOCUMENT.totals.workCost + 1000 },
    };
    const problems = auditEstimateArithmetic(broken);

    expect(problems).toContain(
      "Стоимость СМР по разделам 315458.33 не равна итогу документа 316458.33",
    );
  });

  it("прощает копейки округления и не прощает их при узком допуске", () => {
    // Итоги округляются до копеек на каждом уровне, поэтому расхождение в одну
    // копейку — не ошибка. Допуск 0,02 ₽ это покрывает, и он же остаётся
    // достаточно узким, чтобы потерять целую позицию было нельзя.
    const broken = patchSection(DOCUMENT, (section) => ({
      ...section,
      directCost: section.directCost + 0.01,
    }));

    expect(auditEstimateArithmetic(broken)).toEqual([]);
    expect(auditEstimateArithmetic(broken, 0.005)).toContain(
      "Раздел «Земляные работы»: сумма прямых затрат строк 218316.52 не равна итогу раздела 218316.53",
    );
  });
});

describe("auditEstimateArithmetic: лимитированные затраты и НДС", () => {
  const LIMITED = makeParameters({
    limited: {
      winterSurchargePercent: 6,
      temporaryStructuresPercent: 2.4,
      source: "Значения заданы для теста; ГСН 81-05-01 и 81-05-02 в выгрузке ФГИС ЦС отсутствуют",
    },
  });

  it("требует, чтобы итог без НДС равнялся СМР плюс зимнее удорожание плюс временные здания", () => {
    const document = build([BILL_GRADING, BILL_DRAGLINE], PRICE_BOOK, LIMITED);
    // Временные здания от СМР, зимнее удорожание — уже от суммы с ними.
    expect(document.totals.temporaryStructures).toBe(7571);
    expect(document.totals.winterSurcharge).toBe(19381.76);
    expect(document.totals.beforeVat).toBe(342411.09);

    const broken = {
      ...document,
      totals: { ...document.totals, beforeVat: document.totals.workCost },
    };

    expect(auditEstimateArithmetic(broken)).toContain(
      "Итог без НДС не равен сумме СМР и лимитированных затрат",
    );
  });

  it("ловит зимнее удорожание, начисленное от одной только стоимости СМР", () => {
    const document = build([BILL_GRADING, BILL_DRAGLINE], PRICE_BOOK, LIMITED);

    // Ровно та ошибка, которую чинит последовательное начисление: процент взят
    // от СМР без временных зданий. Итоги при этом сходятся между собой, и
    // поймать её можно только проверкой самой базы.
    const fromWorkCostOnly = 18927.5;
    const broken = {
      ...document,
      totals: {
        ...document.totals,
        winterSurcharge: fromWorkCostOnly,
        beforeVat: document.totals.workCost + document.totals.temporaryStructures + fromWorkCostOnly,
        vat: 68391.37,
        total: 410348.2,
      },
    };

    expect(auditEstimateArithmetic(broken).join(" ")).toContain(
      "не соответствует 6 % от суммы СМР и временных зданий",
    );
  });

  it("пересчитывает НДС по ставке из документа", () => {
    const broken = {
      ...DOCUMENT,
      totals: { ...DOCUMENT.totals, vat: DOCUMENT.totals.vat + 10 },
    };

    expect(auditEstimateArithmetic(broken)).toContain(
      "НДС 63101.67 не соответствует ставке 20 % от 315458.33",
    );
  });

  it("требует, чтобы итоговая стоимость была суммой стоимости без НДС и НДС", () => {
    const broken = {
      ...DOCUMENT,
      totals: { ...DOCUMENT.totals, total: DOCUMENT.totals.total + 1 },
    };

    expect(auditEstimateArithmetic(broken)).toContain(
      "Итоговая стоимость не равна сумме стоимости без НДС и НДС",
    );
  });
});

describe("auditEstimateArithmetic: позиция и расшифровка", () => {
  it("видит расхождение прямых затрат позиции с расшифровкой", () => {
    const broken = patchLine(DOCUMENT, "01-01-111-01", (line) => ({
      ...line,
      directCost: line.directCost + 500,
    }));

    expect(auditEstimateArithmetic(broken)).toContain(
      `Позиция ГЭСН 01-01-111-01: прямые затраты 45697.29 не сходятся с расшифровкой 45197.29`,
    );
  });

  it("видит отрицательные прямые затраты", () => {
    const broken = patchLine(DOCUMENT, "01-01-111-01", (line) => ({
      ...line,
      directCost: -45197.29,
    }));

    expect(auditEstimateArithmetic(broken)).toContain(
      "Позиция ГЭСН 01-01-111-01: отрицательные прямые затраты",
    );
  });

  it("видит расхождение оплаты труда с суммой строк труда", () => {
    const broken = patchLine(DOCUMENT, "01-01-111-01", (line) => ({
      ...line,
      labourCost: line.labourCost + 10,
    }));

    expect(auditEstimateArithmetic(broken)).toContain(
      "Позиция ГЭСН 01-01-111-01: оплата труда 45207.29 не равна сумме строк труда 45197.29",
    );
  });

  it("видит расхождение стоимости ресурса с произведением расхода на цену", () => {
    const broken = patchResource(DOCUMENT, "01-01-001-01", "91.01.01-035", (resource) => ({
      ...resource,
      total: resource.total + 1,
    }));
    const problems = auditEstimateArithmetic(broken);

    expect(problems.some((problem) => problem.includes("ресурс 91.01.01-035"))).toBe(true);
  });

  it("допускает на больших суммах расхождение, которое даёт округление до копеек", () => {
    const line = lineOf(DOCUMENT, "01-01-001-01");
    const machine = resourceOf(line, "91.01.05-128");
    const exact = machine.quantity * machine.unitPrice;
    const relative = Math.abs(exact) * 1e-6;
    // Без этого условия тест был бы пустым: на малой сумме относительный допуск
    // меньше абсолютных 0,02 ₽ и ничего не меняет.
    expect(relative).toBeGreaterThan(0.02);

    const within = patchResource(DOCUMENT, "01-01-001-01", "91.01.05-128", (resource) => ({
      ...resource,
      total: exact + relative / 2,
    }));
    const beyond = patchResource(DOCUMENT, "01-01-001-01", "91.01.05-128", (resource) => ({
      ...resource,
      total: exact + relative * 2,
    }));

    const mentions = (problems: string[]): boolean =>
      problems.some((problem) => problem.includes("ресурс 91.01.05-128"));
    expect(mentions(auditEstimateArithmetic(within))).toBe(false);
    expect(mentions(auditEstimateArithmetic(beyond))).toBe(true);
  });
});

describe("auditEstimateArithmetic: каждое послабление объяснено", () => {
  it("нулевая ставка труда специалистов обязана иметь пометку NO_WAGE", () => {
    const document = build([BILL_GENERATOR]);
    // Три ресурса кодов 3-* — труд специалистов ИТР: в открытых данных ставки
    // на него нет, расчёт кладёт ноль и говорит об этом.
    expect(document.gaps.filter((gap) => gap.kind === "NO_WAGE")).toHaveLength(3);
    expect(auditEstimateArithmetic(document)).toEqual([]);

    const problems = auditEstimateArithmetic(dropGaps(document, "NO_WAGE"));
    const named = problems.map((problem) => /ресурс ([\d-]+):/.exec(problem)?.[1] ?? "");

    expect(problems).toHaveLength(3);
    expect([...named].sort()).toEqual(["3-100-02", "3-200-01", "3-200-03"]);
    for (const problem of problems) {
      expect(problem).toContain("Позиция ГЭСНп 01-01-001-01");
      expect(problem).toContain("ставка оплаты труда равна нулю");
      expect(problem).toContain("пометки NO_WAGE в пробелах нет");
    }
  });

  it("требует пометку NO_WAGE даже при нулевом расходе часов", () => {
    // Ставки нет в данных независимо от того, сколько часов норма потребляет,
    // и расчёт выставляет пометку, не глядя на расход. Сверка обязана требовать её
    // в тех же случаях: расхождение между ними означало бы, что честный
    // документ не проходит собственную проверку.
    const document = build([BILL_GENERATOR]);
    const zeroed = patchResource(document, "01-01-001-01", "3-200-01", (resource) => ({
      ...resource,
      quantity: 0,
      total: 0,
    }));

    const problems = auditEstimateArithmetic(dropGaps(zeroed, "NO_WAGE"));

    expect(problems).toHaveLength(3);
    expect(problems.some((problem) => problem.includes("ресурс 3-200-01"))).toBe(true);
  });

  it("не требует пометки о нулевой цене, если ресурс в позицию не входит", () => {
    // У машины и материала проверка смотрит на расход: ресурс с нулевым расходом
    // ничего не занижает, и требовать пометку значило бы завалить отчёт
    // предупреждениями о неважном.
    const document = build([BILL_DREDGER]);
    const [resource] = lineOf(document, "44-04-180-01").resources;
    if (resource === undefined) throw new Error("У земснаряда нет ресурсов");
    const emptied = patchResource(document, "44-04-180-01", resource.code, (item) => ({
      ...item,
      quantity: 0,
      total: 0,
    }));

    const problems = auditEstimateArithmetic(dropGaps(emptied, "ZERO_PRICE"));

    expect(problems.some((problem) => problem.includes("цена равна нулю"))).toBe(false);
  });

  it("нулевая цена в базе обязана иметь пометку ZERO_PRICE", () => {
    const document = build([BILL_DREDGER]);
    expect(hasGap(document, "ZERO_PRICE")).toBe(true);
    expect(document.totals.total).toBe(0);
    expect(auditEstimateArithmetic(document)).toEqual([]);

    const problems = auditEstimateArithmetic(dropGaps(document, "ZERO_PRICE"));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("цена равна нулю");
    expect(problems[0]).toContain("NO_PRICE или ZERO_PRICE");
  });

  it("отсутствие цены в справочниках обязано иметь пометку NO_PRICE", () => {
    const document = build([BILL_DRAGLINE], makePriceBook(WAGE_SCALE, { base: EMPTY_BASE }));
    expect(hasGap(document, "NO_PRICE")).toBe(true);
    expect(auditEstimateArithmetic(document)).toEqual([]);

    expect(auditEstimateArithmetic(dropGaps(document, "NO_PRICE")).length).toBeGreaterThan(0);
  });

  it("ставка, продолженная за пределы шкалы, обязана иметь пометку WAGE_EXTRAPOLATED", () => {
    const document = build([BILL_DRAINAGE], NARROW_BOOK);
    expect(hasGap(document, "WAGE_EXTRAPOLATED")).toBe(true);
    expect(resourceOf(lineOf(document, "01-01-129-11"), "2-100-04").wageOrigin).toBe(
      "EXTRAPOLATED",
    );
    expect(auditEstimateArithmetic(document)).toEqual([]);

    const problems = auditEstimateArithmetic(dropGaps(document, "WAGE_EXTRAPOLATED"));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ресурс 2-100-04");
    expect(problems[0]).toContain("за пределы тарифной шкалы");
  });

  it("пометка одной книги не закрывает ту же позицию другой книги", () => {
    // Код «01-01-001-01» есть и в ГЭСН (экскаватор-драглайн), и в ГЭСНп
    // (пусконаладка генератора). Нулевые ставки — у генератора. Если пометку
    // привязать к коду без книги, она закроет обе позиции, и отсутствующая
    // ставка у драглайна осталась бы невидимой.
    const document = build([BILL_DRAGLINE, BILL_GENERATOR]);
    expect(auditEstimateArithmetic(document)).toEqual([]);

    const problems = auditEstimateArithmetic(rebaseGaps(document, "NO_WAGE", "ГЭСН"));

    expect(problems).toHaveLength(3);
    for (const problem of problems) {
      expect(problem).toContain("Позиция ГЭСНп 01-01-001-01");
      expect(problem).not.toContain("Позиция ГЭСН 01-01-001-01");
    }
  });

  it("метка позиции печатает книгу вместе с кодом", () => {
    const document = build([BILL_DREDGER]);
    const [problem] = auditEstimateArithmetic(dropGaps(document, "ZERO_PRICE"));

    // «Позиция 44-04-180-01» не говорит, о какой из книг идёт речь, а коды
    // повторяются: 2 784 из 53 228 встречаются больше одного раза.
    expect(problem).toContain("Позиция ГЭСН 44-04-180-01");
  });
});
