import { z } from "zod";

/**
 * Zod-схема сметного документа.
 *
 * По правилам проекта любой результат, который уходит в интерфейс, сначала
 * проходит валидацию схемой. Для сметы это важнее обычного: здесь числа,
 * которые партнёр может отнести заказчику, и молча прошедший `undefined`
 * в цене превращается в заниженный итог без единой пометки.
 */

const resourceKindSchema = z.enum([
  "LABOUR",
  "WORKER_HOURS_TOTAL",
  "MACHINIST_HOURS",
  "MACHINE",
  "MATERIAL",
  "UNKNOWN",
]);

/**
 * Происхождение цены в напечатанной строке.
 *
 * `UNPRICED` — отдельное значение, а не `BASE_2022` с нулём: подпись «база
 * 01.01.2022» рядом с 0 ₽ утверждает, что источник дал ноль. Источник не дал
 * ничего, и это разные утверждения.
 */
const resourceLineSourceSchema = z.enum([
  "CURRENT_ZONE",
  "BASE_2022",
  "BASE_2022_INDEXED",
  "WAGE_SCALE",
  "UNPRICED",
  "SPLIT_INDEXED",
  "FGIS_SERVICE",
  "OWN_PRICE",
  "BIM_INDEXED",
  "CUSTOMER_SUM",
]);

const wageOriginSchema = z.enum(["ANCHOR", "INTERPOLATED", "EXTRAPOLATED"]).nullable();

const finiteNumber = z.number().refine((value) => Number.isFinite(value), {
  message: "Ожидалось конечное число, а не NaN или бесконечность",
});

const overheadRateSourceSchema = z.enum(["NORM_REF", "DEFAULT", "NONE"]);

const estimateGapKindSchema = z.enum([
  "NO_NORM",
  "BAD_QUANTITY",
  "BAD_DIVISOR",
  "UNIT_MISMATCH",
  "LABOUR_TOTAL_MISMATCH",
  "PROJECT_SPECIFIC_RESOURCE",
  "QUANTITY_BY_PROJECT",
  "UNKNOWN_RESOURCE",
  "NO_WAGE",
  "WAGE_EXTRAPOLATED",
  "NO_PRICE",
  "ZERO_PRICE",
  "NO_CURRENT_PRICE",
  "NO_OVERHEAD_RATE",
  "MACHINIST_HOURS_MISMATCH",
  "MACHINE_PRICE_INCONSISTENT",
  "MACHINIST_PAY_UNKNOWN",
  "CUSTOMER_PRICE",
  "INDEXED_PRICE",
  "AI_MATERIAL_PICK",
  "NORMATIVE_NOT_APPLIED",
  "BIM_NO_INDEX",
  "BIM_TER_AS_FER",
  "BIM_FALLBACK_RIM",
  "PRICE_LEVEL_DIFFERS",
  "CUSTOMER_BASE_DIFFERS",
  "BILL_CHUNK_UNREAD",
  "NO_VOLUME_SOURCE",
]);

const estimateGapSchema = z.object({
  kind: estimateGapKindSchema,
  message: z.string().min(1),
  code: z.string().nullable(),
  baseType: z.string().nullable(),
  billSection: z.string().nullish(),
});

const estimateResourceLineSchema = z.object({
  code: z.string().min(1),
  name: z.string(),
  unit: z.string(),
  quantity: finiteNumber,
  unitPrice: finiteNumber,
  total: finiteNumber,
  source: resourceLineSourceSchema,
  kind: resourceKindSchema,
  wageOrigin: wageOriginSchema,
  // Базисно-индексный метод: цена расценки в уровне 2001 года и индекс пересчёта.
  baseUnitPrice: finiteNumber.optional(),
  index: finiteNumber.optional(),
  // Машина: оплата звена, входящая в цену и сумму строки (форма 421/пр печатает ЭМ без неё и добавляет ОТм).
  machinistPay: finiteNumber.optional(),
  machinistPayTotal: finiteNumber.optional(),
  note: z.string().optional(),
});

const estimateLineSchema = z.object({
  itemId: z.string().min(1),
  normCode: z.string().min(1),
  normBaseType: z.string().min(1),
  normName: z.string().min(1),
  normUnit: z.string(),
  quantity: finiteNumber,
  billQuantity: finiteNumber,
  billUnit: z.string(),
  sourceQuote: z.string().nullable(),
  sourceDocument: z.string().nullable(),
  // Нет у смет, сохранённых до сравнения по разделам.
  billSection: z.string().nullish(),
  labourHours: finiteNumber,
  specialistHours: finiteNumber,
  labourRate: finiteNumber,
  labourCost: finiteNumber,
  machinistHours: finiteNumber,
  machinistSalaryCost: finiteNumber,
  machineHours: finiteNumber,
  machineCost: finiteNumber,
  materialCost: finiteNumber,
  directCost: finiteNumber,
  wageFund: finiteNumber,
  overheadCost: finiteNumber,
  profitCost: finiteNumber,
  overheadPercent: finiteNumber,
  profitPercent: finiteNumber,
  overheadRef: z.string().nullable(),
  profitRef: z.string().nullable(),
  overheadSource: overheadRateSourceSchema,
  profitSource: overheadRateSourceSchema,
  resources: z.array(estimateResourceLineSchema),
  gaps: z.array(estimateGapSchema),
  // Нет у строк, посчитанных по нашим нормам.
  priceSource: z.enum(["CUSTOMER_PRICE", "FGIS_SERVICE", "OWN_PRICE"]).optional(),
  priceNote: z.string().optional(),
  // Строка-исключение: суммы со знаком минус (отрицательный объём в смете заказчика).
  deduction: z.literal(true).optional(),
  // Коэффициенты условий работ (421/пр, приложение 10); нет у позиций без выбранных условий.
  coefficients: z
    .object({
      labour: finiteNumber,
      machines: finiteNumber,
      wage: finiteNumber,
      materials: finiteNumber.optional(),
      conditionIds: z.array(z.string()),
      adjustmentIds: z.array(z.string()),
      // Коэффициенты заказчика, применённые к строке «как у заказчика».
      customer: z
        .object({
          applied: z.array(z.string()),
          duplicates: z.array(z.string()),
          skipped: z.array(z.string()),
          manual: z.boolean(),
          label: z.string(),
        })
        .optional(),
    })
    .optional(),
  // Множители заказчика к нормативам НР и СП (812/пр п. 25, 774/пр п. 16); нет у строк без них.
  rateMultipliers: z
    .object({
      overhead: finiteNumber,
      profit: finiteNumber,
      baseOverheadPercent: finiteNumber,
      baseProfitPercent: finiteNumber,
      applied: z.array(z.string()),
      skipped: z.array(z.string()),
      manual: z.boolean(),
      label: z.string(),
    })
    .optional(),
  // Базисно-индексный метод: базисные суммы и индексы строки; нет у ресурсно-индексных строк.
  bim: z
    .object({
      rateCode: z.string().min(1),
      baseWage: finiteNumber,
      baseMachines: finiteNumber,
      baseMachinistWage: finiteNumber,
      baseMaterials: finiteNumber,
      indexLabour: finiteNumber,
      indexMachines: finiteNumber,
      indexMaterials: finiteNumber,
      materialsOutsidePrice: z.array(z.string()),
    })
    .optional(),
});

const estimateSectionSchema = z.object({
  title: z.string().min(1),
  lines: z.array(estimateLineSchema),
  directCost: finiteNumber,
  overheadCost: finiteNumber,
  profitCost: finiteNumber,
  workCost: finiteNumber,
});

const estimateTotalsSchema = z.object({
  directCost: finiteNumber,
  wageFund: finiteNumber,
  overheadCost: finiteNumber,
  profitCost: finiteNumber,
  workCost: finiteNumber,
  winterSurcharge: finiteNumber,
  temporaryStructures: finiteNumber,
  beforeVat: finiteNumber,
  vat: finiteNumber,
  total: finiteNumber,
  customerPriced: finiteNumber.optional(),
  customerPricedCount: finiteNumber.optional(),
  ownPriced: finiteNumber.optional(),
  ownPricedCount: finiteNumber.optional(),
});

const estimateSourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  edition: z.string(),
});

const wageAnchorSchema = z.object({
  rank: finiteNumber,
  salary: finiteNumber,
  source: z.string(),
});

const wageScaleSchema = z.object({
  region: z.string(),
  zone: z.string(),
  period: z.string(),
  anchors: z.array(wageAnchorSchema),
  baseSalary: finiteNumber,
  minRank: finiteNumber,
  maxRank: finiteNumber,
  // Нет у шкал, собранных по первой странице реестра ставок.
  specialists: z
    .array(z.object({ code: z.string().min(1), name: z.string(), salary: finiteNumber, source: z.string() }))
    .optional(),
  machinists: z.array(wageAnchorSchema).optional(),
});

const estimateDocumentObject = z.object({
  title: z.string().min(1),
  region: z.string().min(1),
  priceZone: z.string().min(1),
  period: z.string().min(1),
  method: z.enum(["RESOURCE_INDEX", "BASE_INDEX"]),
  // Сведения базисно-индексного метода; нет у ресурсно-индексных смет.
  bim: z
    .object({
      basis: z.enum(["USER", "CUSTOMER", "DEFAULT"]),
      basisNote: z.string(),
      subject: z.string().nullable(),
      zone: finiteNumber.nullable(),
      quarter: z.string().min(1),
      object: z.string().min(1),
      objectDetected: z.boolean(),
      customerBase: z.enum(["FER", "TER"]),
      indexLabour: finiteNumber,
      indexMachines: finiteNumber,
      indexMaterials: finiteNumber,
      letter: z.string(),
    })
    .optional(),
  baseEdition: z.string().min(1),
  parameters: z.object({
    vatPercent: finiteNumber,
    indices: z
      .object({
        period: z.string().min(1),
        labour: finiteNumber,
        machinistLabour: finiteNumber,
        machines: finiteNumber,
        materials: finiteNumber,
        source: z.string().min(1),
      })
      .nullable(),
    overhead: z.object({
      overheadPercent: finiteNumber,
      profitPercent: finiteNumber,
      workType: z.string(),
      source: z.string().min(1),
    }),
    limited: z.object({
      winterSurchargePercent: finiteNumber,
      temporaryStructuresPercent: finiteNumber,
      source: z.string().min(1),
    }),
    // Выбранные условия производства работ; нет у смет без выбора.
    workConditions: z
      .object({
        phase: z.enum(["CONSTRUCTION", "RECONSTRUCTION", "CAPITAL_REPAIR", "DEMOLITION"]),
        conditionIds: z.array(z.string()),
        newConstructionNorms: z.boolean(),
      })
      .optional(),
  }),
  wageScale: wageScaleSchema,
  sections: z.array(estimateSectionSchema),
  totals: estimateTotalsSchema,
  gaps: z.array(estimateGapSchema),
  sources: z.array(estimateSourceSchema),
  generatedAt: z.string().min(1),
  disclaimer: z.string().min(1),
  // Нормативы сверх норм (условия работ, зимнее, временные, Север); нет у смет без них.
  appliedNormatives: z
    .array(
      z.object({
        code: z.string().min(1),
        title: z.string().min(1),
        text: z.string(),
        value: z.string(),
        source: z.string(),
        applied: z.boolean(),
        reason: z.string().optional(),
        missingData: z.boolean().optional(),
        assumption: z.string().optional(),
      }),
    )
    .optional(),
  // Нет у смет, посчитанных до выбора ценовой зоны.
  priceZoneChoice: z
    .object({
      basis: z.enum(["SINGLE_ZONE", "MUNICIPALITY", "CAPITAL", "USER", "CUSTOMER_ESTIMATE", "CUSTOMER_PRICES", "UNKNOWN_REGION"]),
      matched: z.string().nullable(),
    })
    .nullish(),
});

/**
 * Метод и сведения о нём согласованы: документ базисно-индексного метода несёт `bim` (индексы, письмо, объект), ресурсно-индексный
 * его не имеет. Документ с подписью «БИМ» без сведений нельзя показать: по нему не проверить, чем пересчитаны цены.
 */
export const estimateDocumentSchema = estimateDocumentObject.superRefine((document, context) => {
  if (document.method === "BASE_INDEX" && document.bim === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bim"], message: "У сметы базисно-индексного метода нет сведений об индексах" });
  }
  if (document.method === "RESOURCE_INDEX" && document.bim !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bim"], message: "Сведения базисно-индексного метода у ресурсно-индексной сметы" });
  }
});

export type EstimateDocumentDto = z.infer<typeof estimateDocumentSchema>;

/** Строка сметы в том виде, в каком её описывает схема. */
export type EstimateLineDto = EstimateDocumentDto["sections"][number]["lines"][number];

/** Ресурсная строка в расшифровке позиции. */
export type EstimateResourceDto = EstimateLineDto["resources"][number];

/**
 * Проверяет документ и возвращает его же. Бросает ZodError с перечнем
 * нарушений, если расчёт собрался некорректно.
 */
export function parseEstimateDocument(document: unknown): EstimateDocumentDto {
  return estimateDocumentSchema.parse(document);
}

/**
 * Проверяет арифметику документа независимо от того, как он был собран.
 * Возвращает список расхождений: пустой массив означает, что итоги сходятся
 * с суммой строк.
 */
export function auditEstimateArithmetic(
  document: EstimateDocumentDto,
  tolerance = 0.02,
): string[] {
  const problems: string[] = [];
  const lineCount = document.sections.reduce((acc, section) => acc + section.lines.length, 0);

  if (lineCount === 0) {
    problems.push("В смете нет ни одной рассчитанной позиции");
  }

  for (const section of document.sections) {
    const direct = section.lines.reduce((acc, line) => acc + line.directCost, 0);
    if (Math.abs(direct - section.directCost) > tolerance) {
      problems.push(
        `Раздел «${section.title}»: сумма прямых затрат строк ${direct.toFixed(2)} не равна итогу раздела ${section.directCost.toFixed(2)}`,
      );
    }

    const work = section.directCost + section.overheadCost + section.profitCost;
    if (Math.abs(work - section.workCost) > tolerance) {
      problems.push(
        `Раздел «${section.title}»: стоимость работ ${section.workCost.toFixed(2)} не равна сумме прямых затрат, НР и СП ${work.toFixed(2)}`,
      );
    }
  }

  const sectionsWork = document.sections.reduce((acc, section) => acc + section.workCost, 0);
  if (Math.abs(sectionsWork - document.totals.workCost) > tolerance) {
    problems.push(
      `Стоимость СМР по разделам ${sectionsWork.toFixed(2)} не равна итогу документа ${document.totals.workCost.toFixed(2)}`,
    );
  }

  const expectedBeforeVat =
    document.totals.workCost +
    document.totals.winterSurcharge +
    document.totals.temporaryStructures;
  if (Math.abs(expectedBeforeVat - document.totals.beforeVat) > tolerance) {
    problems.push("Итог без НДС не равен сумме СМР и лимитированных затрат");
  }

  // Лимитированные затраты начисляются последовательно: временные здания от
  // стоимости СМР, зимнее удорожание — от суммы СМР и временных зданий.
  // Проверяется именно порядок: обе величины по отдельности выглядят
  // правдоподобно и при неверной базе.
  const limited = document.parameters.limited;
  const expectedTemporary =
    (document.totals.workCost * limited.temporaryStructuresPercent) / 100;
  if (Math.abs(expectedTemporary - document.totals.temporaryStructures) > tolerance) {
    problems.push(
      `Временные здания ${document.totals.temporaryStructures.toFixed(2)} не соответствуют ${limited.temporaryStructuresPercent} % от стоимости СМР ${document.totals.workCost.toFixed(2)}`,
    );
  }

  const winterBase = document.totals.workCost + document.totals.temporaryStructures;
  const expectedWinter = (winterBase * limited.winterSurchargePercent) / 100;
  if (Math.abs(expectedWinter - document.totals.winterSurcharge) > tolerance) {
    problems.push(
      `Зимнее удорожание ${document.totals.winterSurcharge.toFixed(2)} не соответствует ${limited.winterSurchargePercent} % от суммы СМР и временных зданий ${winterBase.toFixed(2)}`,
    );
  }

  const expectedVat = (document.totals.beforeVat * document.parameters.vatPercent) / 100;
  if (Math.abs(expectedVat - document.totals.vat) > tolerance) {
    problems.push(
      `НДС ${document.totals.vat.toFixed(2)} не соответствует ставке ${document.parameters.vatPercent} % от ${document.totals.beforeVat.toFixed(2)}`,
    );
  }

  const expectedTotal = document.totals.beforeVat + document.totals.vat;
  if (Math.abs(expectedTotal - document.totals.total) > tolerance) {
    problems.push("Итоговая стоимость не равна сумме стоимости без НДС и НДС");
  }

  const gapKeys = new Set(
    document.gaps.map((gap) => `${gap.kind}|${gap.baseType ?? ""}|${gap.code ?? ""}`),
  );

  for (const section of document.sections) {
    for (const line of section.lines) {
      const position = positionLabel(line);
      const resourceSum = line.resources.reduce((acc, resource) => {
        if (resource.kind === "MACHINE") return acc + resource.total;
        if (resource.kind === "MATERIAL") return acc + resource.total;
        return acc;
      }, 0);
      const expectedDirect = resourceSum + line.labourCost;
      if (Math.abs(expectedDirect - line.directCost) > tolerance) {
        problems.push(
          `Позиция ${position}: прямые затраты ${line.directCost.toFixed(2)} не сходятся с расшифровкой ${expectedDirect.toFixed(2)}`,
        );
      }
      // Строка-исключение (`deduction`) вычитает: её суммы со знаком минус по определению.
      if (line.directCost < 0 && line.deduction !== true) {
        problems.push(`Позиция ${position}: отрицательные прямые затраты`);
      }

      const expectedLabour = line.resources.reduce(
        (acc, resource) => (resource.kind === "LABOUR" ? acc + resource.total : acc),
        0,
      );
      if (Math.abs(expectedLabour - line.labourCost) > tolerance) {
        problems.push(
          `Позиция ${position}: оплата труда ${line.labourCost.toFixed(2)} не равна сумме строк труда ${expectedLabour.toFixed(2)}`,
        );
      }

      // Норматив у каждой расценки свой, поэтому начисление проверяется по
      // проценту самой строки, а не по параметрам документа: подстановка
      // чужого норматива иначе прошла бы сверку незамеченной.
      const expectedOverhead = (line.wageFund * line.overheadPercent) / 100;
      if (Math.abs(expectedOverhead - line.overheadCost) > tolerance) {
        problems.push(
          `Позиция ${position}: накладные расходы ${line.overheadCost.toFixed(2)} не соответствуют нормативу ${line.overheadPercent} % от ФОТ ${line.wageFund.toFixed(2)}`,
        );
      }

      const expectedProfit = (line.wageFund * line.profitPercent) / 100;
      if (Math.abs(expectedProfit - line.profitCost) > tolerance) {
        problems.push(
          `Позиция ${position}: сметная прибыль ${line.profitCost.toFixed(2)} не соответствует нормативу ${line.profitPercent} % от ФОТ ${line.wageFund.toFixed(2)}`,
        );
      }

      // Резерв документа вместо норматива расценки — допущение, а допущение
      // обязано быть объяснено пометкой. Иначе смета, целиком собранная на
      // резерве, выглядит как смета, посчитанная по видам работ.
      if (
        (line.overheadSource === "DEFAULT" || line.profitSource === "DEFAULT") &&
        !gapKeys.has(`NO_OVERHEAD_RATE|${line.normBaseType}|${line.normCode}`)
      ) {
        problems.push(
          `Позиция ${position}: норматив начислен резервом документа, но пометки NO_OVERHEAD_RATE нет`,
        );
      }

      for (const resource of line.resources) {
        const expectedTotal = resource.quantity * resource.unitPrice;
        const slack = Math.max(tolerance, Math.abs(expectedTotal) * 1e-6);
        if (Math.abs(expectedTotal - resource.total) > slack) {
          problems.push(
            `Позиция ${position}, ресурс ${resource.code}: ${resource.quantity} × ${resource.unitPrice} не даёт ${resource.total}`,
          );
        }
        checkResourceIsExplained(line, resource, gapKeys, problems);
      }
    }
  }

  return problems;
}

/**
 * Метка позиции для сообщений сверки.
 *
 * Книга печатается вместе с кодом намеренно: в выгрузке ФГИС ЦС 2 784 кода
 * встречаются больше чем в одной книге, и сообщение «позиция 01-01-001-01»
 * не говорит, о какой из четырёх разных работ идёт речь.
 */
function positionLabel(line: EstimateLineDto): string {
  return `${line.normBaseType} ${line.normCode}`;
}

/**
 * Проверяет, что любое послабление в данных видно пользователю.
 *
 * Требование правил проекта: неопределённое не исчезает молча, а объясняется
 * одной фразой. Нулевая цена или приблизительная ставка без соответствующей
 * пометки в gaps — это именно молчаливое занижение сметы, поэтому такая
 * комбинация считается ошибкой расчёта.
 */
function checkResourceIsExplained(
  line: EstimateLineDto,
  resource: EstimateResourceDto,
  gapKeys: ReadonlySet<string>,
  problems: string[],
): void {
  const has = (kind: string): boolean =>
    gapKeys.has(`${kind}|${line.normBaseType}|${line.normCode}`);
  const position = positionLabel(line);

  if (resource.wageOrigin === "EXTRAPOLATED" && !has("WAGE_EXTRAPOLATED")) {
    problems.push(
      `Позиция ${position}, ресурс ${resource.code}: ставка продолжена за пределы тарифной шкалы, но пометки WAGE_EXTRAPOLATED в пробелах нет`,
    );
  }

  if (resource.kind === "LABOUR" && resource.unitPrice === 0 && !has("NO_WAGE")) {
    problems.push(
      `Позиция ${position}, ресурс ${resource.code}: ставка оплаты труда равна нулю, но пометки NO_WAGE в пробелах нет`,
    );
  }

  const pricedKind = resource.kind === "MACHINE" || resource.kind === "MATERIAL";
  // NO_PRICE — кода нет в справочниках, ZERO_PRICE — код есть, но цена в нём
  // нулевая. Оба объясняют нулевую стоимость, и оба обязательны: без них
  // позиция с нулём выглядит посчитанной.
  if (
    pricedKind &&
    resource.quantity > 0 &&
    resource.unitPrice === 0 &&
    !has("NO_PRICE") &&
    !has("ZERO_PRICE")
  ) {
    problems.push(
      `Позиция ${position}, ресурс ${resource.code}: цена равна нулю, но пометки NO_PRICE или ZERO_PRICE в пробелах нет`,
    );
  }
}
