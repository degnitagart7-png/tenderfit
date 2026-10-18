import { classifyBill, type BillRowClass } from "@/domain/estimate/billMaterial";
import { collectNormCandidates } from "@/domain/estimate/normCandidates";
import type { NormSearchIndex } from "@/domain/estimate/matchNorms";
import {
  applyNormPick,
  checkPick,
  EMPTY_NORM_PICK_STATS,
  lexicalCoverage,
  needsNormPick,
  NO_NORM_PICKER,
  NORM_PICK_BATCH_SIZE,
  withAiDemolition,
  type NormPickBatch,
  type NormPickContext,
  type NormPickItem,
  type NormPickKind,
  type NormPicker,
  type NormPickStats,
  type RawNormPick,
} from "@/domain/estimate/normPick";
import {
  applyResourcePick,
  checkResourcePick,
  collectResourceMatches,
  isResourcePick,
  markMaterialUnpriced,
  massConversionFor,
  massPerMetreKg,
  pickByName,
  resourceCandidateOf,
  resourceIndexOf,
  type ResourceMatch,
  type ResourcePriceSource,
  type ResourceSearchIndex,
} from "@/domain/estimate/resourceCandidates";
import type { BillOfWorkItem, BillOfWorkSection } from "@/domain/estimate/types";
import { parseUnit } from "@/domain/estimate/units";
import { variantsOf } from "@/domain/estimate/volumeCrossCheck";

/**
 * Этап «ИИ-сметчик» расчёта сметы: позиции без шифра получают норму, выбранную моделью среди кандидатов кода.
 *
 * Когда идёт. После извлечения ведомости и подсказок шифров, до расчёта: позиция с шифром из документа (или из сметы
 * заказчика) этот этап не проходит — шифр документа сильнее модели. Остальным (за вычетом поставок по справочнику, услуг
 * перевозки, оборудования по цене заказчика, цен человека) собираются кандидаты и пачками по десять уходят к модели через
 * `NormPicker`. Приоритет источников нормы: шифр из документа > выбор ИИ > подбор по наименованию.
 *
 * Что считается сбоем и чем он кончается. Пачка, на которую нет ответа (HTTP, не JSON, таймаут), и позиция, которую модель
 * пропустила, молча откатываются на подбор по наименованию — как было до этого этапа. Счётчики идут в результат расчёта:
 * `fallback` — позиции без ответа, `failedBatches` — упавшие пачки. Ответ модели, не прошедший проверку (шифр вне кандидатов,
 * единица не сходится), — `rejected`, позиция тоже остаётся на подборе по наименованию.
 */

/** Сколько пачек идёт к модели одновременно: шлюз и прод не должны получить сотню запросов разом. */
export const NORM_PICK_CONCURRENCY = 3;
/** Сколько причин отказов остаётся в счётчиках: хватает, чтобы понять картину, и не раздувает отчёт задания. */
const MAX_NOTES = 8;

export interface NormPickStageOptions {
  /** Поисковый индекс норм: кандидаты и проверка ответа. */
  readonly index: NormSearchIndex;
  /** Нет — модель не зовётся (воркер без прода, тесты): расчёт как раньше, а материалы — только запасным выбором по наименованию. */
  readonly picker: NormPicker | undefined;
  readonly context: NormPickContext;
  /** Единицу и делитель позиции с новой нормой назначает расчёт (`withUnitDivisor`): он живёт в estimateService. */
  readonly finalize: (item: BillOfWorkItem) => BillOfWorkItem;
  /**
   * Книга цен: из неё строится индекс ресурсов для материалов (`resourceCandidates.ts`). Нет — материалы не опознаются, этап идёт как
   * раньше: каждая строка — работа.
   */
  readonly resources?: ResourcePriceSource;
  readonly batchSize?: number;
  readonly concurrency?: number;
}

interface Pending {
  readonly section: number;
  readonly index: number;
  readonly item: BillOfWorkItem;
  readonly units: readonly string[];
  /** Что известно про строку: работа, материал (поставка) или неясно. */
  readonly kind: NormPickKind;
  /** Почему строка опознана как материал или неясная; null у работы. */
  readonly verdict: BillRowClass | null;
  /** Найденные ресурсы-кандидаты (те же, что ушли модели): по ним же идёт запасной выбор и проверка ответа. */
  readonly matches: readonly ResourceMatch[];
  /** Масса метра из документа, кг: пересчёт «м» → «кг» для ресурса с ценой за тонну. */
  readonly kgPerMetre: number | null;
  readonly request: NormPickItem;
}

export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Единицы позиции, которые удаётся прочитать: по ним отбираются кандидаты и проверяется ответ. */
function unitsOf(item: BillOfWorkItem): string[] {
  return variantsOf(item)
    .map((variant) => variant.unit)
    .filter((unit) => parseUnit(unit) !== null);
}

/** Выполняет задания с ограничением одновременных; порядок результатов — по порядку заданий. */
export async function runPool<T>(tasks: readonly (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const position = next;
      next += 1;
      const task = tasks[position];
      if (task === undefined) return;
      results[position] = await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), tasks.length) }, worker));
  return results;
}

/**
 * Применяет выбор ИИ к ведомости. Вход не меняется; позиции без выбора возвращаются теми же объектами.
 *
 * Материалы (`billMaterial.ts`): строка-поставка не получает норму работы никогда. Модель выбирает ей ресурс справочника цен из кандидатов;
 * без модели (нет подборщика или пачка не получена) ресурс берётся по наименованию только при высоком покрытии слов и явном лидере
 * (`pickByName`), иначе строка остаётся без цены с пометкой «нет цены — проверьте». Неясная строка уходит модели с обоими списками; без ответа
 * она считается работой, как раньше.
 */
export async function withNormPicks(
  sections: readonly BillOfWorkSection[],
  options: NormPickStageOptions,
): Promise<{ sections: BillOfWorkSection[]; stats: NormPickStats }> {
  const { picker } = options;
  // Заглушка «ничего не выбирает» (бенчмарк по ЛСР заказчика) не стоит и поиска кандидатов.
  if (picker === NO_NORM_PICKER) return { sections: [...sections], stats: EMPTY_NORM_PICK_STATS };
  // Без модели этап нужен только материалам, а их опознание требует книги цен.
  if (picker === undefined && options.resources === undefined) return { sections: [...sections], stats: EMPTY_NORM_PICK_STATS };

  const resourceIndex: ResourceSearchIndex | null = options.resources === undefined ? null : resourceIndexOf(options.resources);
  const classes = resourceIndex === null ? null : classifyBill(sections);

  const batchSize = Math.max(1, Math.min(options.batchSize ?? NORM_PICK_BATCH_SIZE, NORM_PICK_BATCH_SIZE));
  let skipped = 0;
  const pending: Pending[] = [];
  const replaced = new Map<string, BillOfWorkItem>();
  const notes: string[] = [];
  const note = (text: string): void => {
    if (notes.length < MAX_NOTES) notes.push(text);
  };
  const counters = {
    picked: 0,
    declined: 0,
    rejected: 0,
    fallback: 0,
    review: 0,
    demolitionCoefficients: 0,
    failedBatches: 0,
    tokens: 0,
    materialRows: 0,
    ambiguousRows: 0,
    materialPicked: 0,
    materialRejected: 0,
    materialFallback: 0,
    materialUnpriced: 0,
  };
  const keyOf = (section: number, index: number): string => `${String(section)}:${String(index)}`;

  /** Материал без модели: ресурс по наименованию при явном лидере, иначе строка без цены. */
  const resolveWithoutModel = (member: Pending, why: string): BillOfWorkItem => {
    const verdict = member.verdict as BillRowClass;
    const top = pickByName(member.matches);
    if (top === null) {
      counters.materialUnpriced += 1;
      note(`«${member.item.workName.slice(0, 60)}»: материал без цены — ${why}`);
      return markMaterialUnpriced(member.item, verdict.reason, why);
    }
    counters.materialFallback += 1;
    const applied = applyResourcePick(member.item, top.entry, {
      source: "NAME",
      kindReason: verdict.reason,
      reason: "",
      confidence: null,
      coverage: top.coverage,
      massConversion: massConversionFor(member.units, top.entry, member.kgPerMetre),
    });
    if (applied.materialRow?.review === true) counters.review += 1;
    return applied;
  };

  /** Строка-материал, которой модель не помогла: цены нет, нормы работы нет. */
  const unpriced = (member: Pending, why: string): BillOfWorkItem => {
    counters.materialUnpriced += 1;
    note(`«${member.item.workName.slice(0, 60)}»: материал без цены — ${why}`);
    return markMaterialUnpriced(member.item, (member.verdict as BillRowClass).reason, why);
  };

  sections.forEach((section, sectionIndex) => {
    section.items.forEach((item, itemIndex) => {
      if (!needsNormPick(item)) return;
      const units = unitsOf(item);
      const verdict = classes?.get(item.id) ?? null;
      let kind: NormPickKind = verdict === null || verdict.kind === "WORK" ? "work" : verdict.kind === "MATERIAL" ? "material" : "ambiguous";
      if (kind === "material") counters.materialRows += 1;
      if (kind === "ambiguous") counters.ambiguousRows += 1;

      const kgPerMetre = kind === "work" ? null : massPerMetreKg(`${item.workName} ${item.remark ?? ""}`);
      const matches =
        kind === "work" || resourceIndex === null || units.length === 0
          ? []
          : collectResourceMatches(resourceIndex, { workName: item.workName, units, kgPerMetre });

      // Неясная строка без ресурсов-кандидатов — работа, как раньше.
      if (kind === "ambiguous" && matches.length === 0) kind = "work";
      const stateOf = (): Pending => ({
        section: sectionIndex,
        index: itemIndex,
        item,
        units,
        kind,
        verdict: kind === "work" ? null : verdict,
        matches,
        kgPerMetre,
        request: { id: "", workName: item.workName, quantity: 0, unit: "", remark: null, section: null, candidates: [] },
      });

      if (picker === undefined) {
        // Без модели — только материалы и только запасным выбором; работы и неясные строки идут как раньше.
        if (kind !== "material") return;
        replaced.set(keyOf(sectionIndex, itemIndex), resolveWithoutModel({ ...stateOf(), kind }, units.length === 0 ? "единица строки не распознана" : "ресурс по наименованию не найден или неоднозначен"));
        return;
      }

      if (kind === "material" && matches.length === 0) {
        replaced.set(
          keyOf(sectionIndex, itemIndex),
          unpriced(stateOf(), units.length === 0 ? "единица строки не распознана" : "в справочнике цен нет ресурса с похожим названием и переводимой единицей"),
        );
        return;
      }

      const candidates =
        kind === "material" || units.length === 0
          ? []
          : collectNormCandidates(options.index, { workName: item.workName, units, section: item.billSection ?? null });
      if (candidates.length === 0 && matches.length === 0) {
        skipped += 1;
        return;
      }
      const primary = variantsOf(item)[0];
      const extra = variantsOf(item)
        .slice(1)
        .map((variant) => `${String(variant.quantity)} ${variant.unit}`);
      const base = stateOf();
      pending.push({
        ...base,
        request: {
          id: "",
          workName: item.workName,
          quantity: primary?.quantity ?? item.quantity,
          unit: primary?.unit ?? item.quantityUnit,
          ...(extra.length === 0 ? {} : { extraVolumes: extra }),
          remark: item.remark ?? null,
          section: item.billSection ?? null,
          ...(kind === "work" ? {} : { kind, resources: matches.map((match) => resourceCandidateOf(match.entry)) }),
          candidates,
        },
      });
    });
  });

  const finish = (stats: NormPickStats): { sections: BillOfWorkSection[]; stats: NormPickStats } => ({
    sections: sections.map((section, sectionIndex) => ({
      title: section.title,
      items: section.items.map((item, itemIndex) => replaced.get(keyOf(sectionIndex, itemIndex)) ?? item),
    })),
    stats,
  });
  const materialStats = (): Pick<NormPickStats, "materialRows" | "ambiguousRows" | "materialRequested" | "materialPicked" | "materialRejected" | "materialFallback" | "materialUnpriced"> => ({
    materialRows: counters.materialRows,
    ambiguousRows: counters.ambiguousRows,
    materialRequested: pending.filter((member) => member.kind !== "work").length,
    materialPicked: counters.materialPicked,
    materialRejected: counters.materialRejected,
    materialFallback: counters.materialFallback,
    materialUnpriced: counters.materialUnpriced,
  });

  if (pending.length === 0) {
    return finish({
      ...EMPTY_NORM_PICK_STATS,
      skipped,
      ...materialStats(),
      review: counters.review,
      notes,
    });
  }

  const batches: Pending[][] = [];
  for (let start = 0; start < pending.length; start += batchSize) batches.push(pending.slice(start, start + batchSize));

  /** Позиции, на которые ответа нет (пачка упала или модель пропустила): материал считается без модели, остальное — подбором по наименованию. */
  const withoutAnswer = (member: Pending): void => {
    counters.fallback += 1;
    if (member.kind === "material") replaced.set(keyOf(member.section, member.index), resolveWithoutModel(member, "ответа модели нет"));
  };

  const runBatch = async (members: readonly Pending[]): Promise<void> => {
    // Идентификаторы внутри пачки короткие («1»…«10»): модель отвечает ими, а не идентификатором ведомости.
    const items = members.map((member, position) => ({ ...member.request, id: String(position + 1) }));
    const batch: NormPickBatch = { context: options.context, items };

    let answer: Awaited<ReturnType<NormPicker>>;
    try {
      answer = await (picker as NormPicker)(batch);
    } catch (error) {
      counters.failedBatches += 1;
      note(`пачка из ${String(members.length)} позиций не получена: ${describeFailure(error)}`);
      for (const member of members) withoutAnswer(member);
      return;
    }
    counters.tokens += answer.tokens;

    const byId = new Map<string, RawNormPick>();
    for (const pick of answer.picks) if (!byId.has(pick.id)) byId.set(pick.id, pick);

    members.forEach((member, position) => {
      const raw = byId.get(String(position + 1));
      if (raw === undefined) {
        note(`модель пропустила позицию «${member.item.workName.slice(0, 60)}»`);
        withoutAnswer(member);
        return;
      }
      const key = keyOf(member.section, member.index);
      const label = member.item.workName.slice(0, 60);

      if (raw.pick === null) {
        counters.declined += 1;
        if (member.kind === "material") replaced.set(key, unpriced(member, `модель не нашла подходящего ресурса${raw.reason === "" ? "" : `: ${raw.reason}`}`));
        return;
      }

      if (isResourcePick(raw.pick)) {
        // Ресурс для работы — никогда: цена поставки не заменяет расценку.
        if (member.kind === "work" || resourceIndex === null) {
          counters.rejected += 1;
          note(`«${label}»: ресурс для работы не принимается (${raw.pick.slice(0, 40)})`);
          return;
        }
        const resource = checkResourcePick(raw.pick, member.request.resources ?? [], resourceIndex, member.units, member.kgPerMetre);
        if (resource.status === "REJECTED") {
          counters.rejected += 1;
          counters.materialRejected += 1;
          note(`«${label}»: ${resource.reason}`);
          if (member.kind === "material") replaced.set(key, unpriced(member, `ответ модели не принят: ${resource.reason}`));
          return;
        }
        const match = member.matches.find((candidate) => candidate.entry.code === resource.entry.code);
        const applied = applyResourcePick(member.item, resource.entry, {
          source: "AI",
          kindReason: (member.verdict as BillRowClass).reason,
          reason: raw.reason,
          confidence: raw.confidence,
          coverage: match?.coverage ?? null,
          massConversion: resource.massConversion,
        });
        replaced.set(key, applied);
        counters.picked += 1;
        counters.materialPicked += 1;
        if (applied.materialRow?.review === true) counters.review += 1;
        return;
      }

      // Норма для материала — никогда: монтаж этого изделия уже стоит отдельной строкой.
      if (member.kind === "material") {
        counters.rejected += 1;
        counters.materialRejected += 1;
        note(`«${label}»: для материала выбрана норма работы «${raw.pick.slice(0, 40)}» — не принимается`);
        replaced.set(key, unpriced(member, "модель выбрала норму работы, а для материала она не принимается"));
        return;
      }

      const check = checkPick(raw.pick, member.request.candidates, options.index, member.units);
      if (check.status === "NONE") {
        counters.declined += 1;
        return;
      }
      if (check.status === "REJECTED") {
        counters.rejected += 1;
        note(`«${label}»: ${check.reason}`);
        return;
      }
      const coverage = raw.confidence === null ? lexicalCoverage(options.index, member.item.workName, check.norm) : null;
      const applied = withAiDemolition(applyNormPick(member.item, check.norm, raw, coverage));
      replaced.set(key, options.finalize(applied));
      counters.picked += 1;
      if (applied.aiNormPick?.review === true) counters.review += 1;
      if (applied.aiNormPick?.special !== undefined) counters.demolitionCoefficients += 1;
    });
  };

  await runPool(
    batches.map((members) => () => runBatch(members)),
    options.concurrency ?? NORM_PICK_CONCURRENCY,
  );

  return finish({
    requested: pending.length,
    picked: counters.picked,
    declined: counters.declined,
    rejected: counters.rejected,
    fallback: counters.fallback,
    review: counters.review,
    demolitionCoefficients: counters.demolitionCoefficients,
    skipped,
    ...materialStats(),
    normMaterialRequested: 0,
    normMaterialPicked: 0,
    normMaterialDeclined: 0,
    normMaterialRejected: 0,
    normMaterialFallback: 0,
    batches: batches.length,
    failedBatches: counters.failedBatches,
    tokens: counters.tokens,
    notes,
  });
}
