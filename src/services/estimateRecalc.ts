import { applyBillEdits, describeBillEdits, type BillEdit, type BillEditMark } from "@/domain/estimate/billEdits";
import type { EstimateBillSnapshot } from "@/domain/estimate/billReview";
import type { BillOfWorkItem, EstimateDocument, EstimateLine } from "@/domain/estimate/types";
import { BIM_BUILD_COMMAND, FerBaseUnavailableError, loadFerBase, type FerBase } from "@/repositories/bimRepository";
import { loadEstimateBase, loadOverheadRateMap, type EstimateBase } from "@/repositories/estimateBaseRepository";
import {
  calculateBill,
  calculateBimBill,
  EstimateBaseMissingError,
  resolveZoneExtras,
  withUnitDivisor,
  type EstimateDeps,
} from "@/services/estimateService";

/**
 * Пересчёт сметы после правок ведомости.
 *
 * Без модели и без документов: на входе результат прежнего расчёта (в нём ведомость, как она
 * ушла в расчёт, и то, чем расчёт повторить) и список правок человека. Ведомость правится
 * чистой функцией, нормы и цены берутся из той же базы и тех же цен зоны — и собирается новый
 * документ. Расход на модель — ноль по построению: ни `extractBillOfWork`, ни запросов к
 * `/api/estimate/bill-rows` на этом пути нет.
 *
 * Где считается и почему. Не в воркере: воркер выполняет задания по одному, и пересчёт встал бы
 * в очередь за разбором документации, который идёт минутами, — а ответ нужен за секунды. Приложение
 * и воркер лежат на одной машине и читают один каталог `data/fsnb/index`; база норм и цены зоны
 * грузятся в память процесса один раз (`loadEstimateBase` кэширует) и дальше пересчёт — миллисекунды.
 *
 * Уровень цен тот же, что у исходного расчёта: если за это время зона пересобрана за новый квартал,
 * пересчёт отказывает, а не смешивает старые объёмы с новыми ценами.
 */

/** Результат расчёта, из которого можно пересчитывать. */
export interface RecalcSource {
  readonly document: EstimateDocument;
  readonly bill: EstimateBillSnapshot;
}

export interface RecalcResult {
  readonly document: EstimateDocument;
  /** Ведомость после правок и сведения о подборе норм по ней. */
  readonly bill: EstimateBillSnapshot;
  /** Позиций в ведомости после правок. */
  readonly billItems: number;
  /** Расход токенов модели: всегда 0, поле нужно, чтобы это было видно в ответе. */
  readonly tokensUsed: 0;
  readonly applied: {
    readonly count: number;
    /** Правки, строку которых в ведомости найти не удалось. */
    readonly unmatched: readonly BillEdit[];
    readonly marks: readonly BillEditMark[];
  };
}

/** Расчёт сделан без записи ведомости (до появления правок) или без данных зоны: править нечего. */
export class RecalcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecalcUnavailableError";
  }
}

/** Цены зоны обновились после исходного расчёта: пересчёт в другом уровне цен не делаем. */
export class RecalcStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecalcStaleError";
  }
}

export async function recalculateEstimate(
  source: RecalcSource,
  edits: readonly BillEdit[],
  deps: EstimateDeps & { readonly now?: Date } = {},
): Promise<RecalcResult> {
  const { document, bill } = source;
  const calc = bill.calc;
  if (calc === undefined) {
    throw new RecalcUnavailableError(
      "Эта смета посчитана до появления правок ведомости: нажмите «Рассчитать смету» ещё раз — тогда её можно будет править",
    );
  }

  // Смета по базисно-индексному методу пересчитывается по ФЕР-2020 с теми же индексами письма: ресурсные цены зоны ей не нужны.
  if (calc.bim !== undefined) return recalculateBim(source, edits, deps);

  let base: EstimateBase;
  if (deps.base !== undefined) {
    base = deps.base;
  } else {
    try {
      base = await loadEstimateBase({ priceZoneId: calc.priceZoneId, northZone: calc.northZone });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new EstimateBaseMissingError(reason, "data/fsnb/index", "npx tsx scripts/fsnb/build-index.ts");
    }
  }

  // Смета и пересчёт обязаны стоять на одних ценах: иначе «было → стало» покажет не правки, а смену квартала.
  if (base.priceBook.priceZone !== document.priceZone || base.priceBook.period !== document.period) {
    throw new RecalcStaleError(
      `Цены обновились: смета посчитана по «${document.priceZone}», ${document.period}, а на сервере сейчас «${base.priceBook.priceZone}», ${base.priceBook.period}. Рассчитайте смету заново`,
    );
  }

  const applied = applyBillEdits(bill.sections, edits);

  // Делитель единицы зависит от нормы и единицы позиции: у затронутых правкой строк он назначается заново.
  const sections = applied.sections.map((section) => ({
    title: section.title,
    items: section.items.map((item): BillOfWorkItem => {
      if (!applied.edited.has(item.id) || (item.ownUnitPrice ?? 0) > 0) return item;
      return withUnitDivisor({ ...item, unitDivisor: 1 }, base);
    }),
  }));

  const extras = await resolveZoneExtras(deps, calc.priceZoneId);
  const priceBook = { ...base.priceBook, splitAll: extras.splitAll, services: extras.services };

  const generatedAt = (deps.now ?? new Date()).toISOString();
  const calculated = calculateBill({
    title: document.title,
    sections,
    base,
    priceBook,
    parameters: document.parameters,
    appliedNormatives: calc.resolvedNormatives,
    sources: document.sources,
    generatedAt,
    ...(document.priceZoneChoice == null ? {} : { priceZoneChoice: document.priceZoneChoice }),
    manualNorm: applied.manualNorm,
  });

  const lineMap = (doc: EstimateDocument): ReadonlyMap<string, EstimateLine> =>
    new Map(doc.sections.flatMap((section) => section.lines).map((line) => [line.itemId, line] as const));

  return {
    document: calculated.document,
    bill: { ...bill, sections, rows: calculated.rows },
    billItems: sections.reduce((sum, section) => sum + section.items.length, 0),
    tokensUsed: 0,
    applied: {
      count: edits.length,
      unmatched: applied.unmatched,
      marks: describeBillEdits({
        baseSections: bill.sections,
        edits,
        baseLines: lineMap(document),
        lines: lineMap(calculated.document),
      }),
    },
  };
}

/**
 * Пересчёт сметы БИМ: ведомость правится так же, нормы подбираются в ФЕР-2020 (`ferResolver`), индексы берутся из записи
 * расчёта (`calc.bim.selection`), а не ищутся заново: за время правок письма могут смениться, и «было → стало» должно
 * показывать правки, а не смену индексов.
 */
async function recalculateBim(
  source: RecalcSource,
  edits: readonly BillEdit[],
  deps: EstimateDeps & { readonly now?: Date },
): Promise<RecalcResult> {
  const { document, bill } = source;
  const bim = bill.calc?.bim;
  if (bim === undefined) throw new RecalcUnavailableError("В записи расчёта нет сведений базисно-индексного метода");

  let fer: FerBase;
  try {
    fer = deps.fer ?? (await loadFerBase());
  } catch (error) {
    if (!(error instanceof FerBaseUnavailableError)) throw error;
    throw new EstimateBaseMissingError(error.message, error.indexDir, BIM_BUILD_COMMAND);
  }

  const applied = applyBillEdits(bill.sections, edits);
  const sections = applied.sections.map((section) => ({
    title: section.title,
    items: section.items.map((item): BillOfWorkItem => {
      if (!applied.edited.has(item.id) || (item.ownUnitPrice ?? 0) > 0) return item;
      return withUnitDivisor({ ...item, unitDivisor: 1 }, fer);
    }),
  }));

  const overheadRates = deps.overheadRates ?? (await loadOverheadRateMap({ northZone: bill.calc?.northZone }));
  const generatedAt = (deps.now ?? new Date()).toISOString();
  const calculated = calculateBimBill({
    title: document.title,
    sections,
    fer,
    selection: bim.selection,
    overheadRates,
    parameters: document.parameters,
    appliedNormatives: bill.calc?.resolvedNormatives ?? [],
    sources: document.sources,
    generatedAt,
    ...(document.priceZoneChoice == null ? {} : { priceZoneChoice: document.priceZoneChoice }),
    manualNorm: applied.manualNorm,
    region: bim.region,
    priceZone: bim.priceZone,
    method: { basis: bim.basis, note: bim.basisNote, customerBase: bim.customerBase },
  });

  const lineMap = (doc: EstimateDocument): ReadonlyMap<string, EstimateLine> =>
    new Map(doc.sections.flatMap((section) => section.lines).map((line) => [line.itemId, line] as const));

  return {
    document: calculated.document,
    bill: { ...bill, sections, rows: calculated.rows },
    billItems: sections.reduce((sum, section) => sum + section.items.length, 0),
    tokensUsed: 0,
    applied: {
      count: edits.length,
      unmatched: applied.unmatched,
      marks: describeBillEdits({ baseSections: bill.sections, edits, baseLines: lineMap(document), lines: lineMap(calculated.document) }),
    },
  };
}
