import { isServiceItem } from "@/domain/estimate/autoServices";
import {
  EMPTY_GENERATED_IMPLIED,
  GENERATED_IMPLIED_SECTION,
  type GeneratedImpliedStats,
} from "@/domain/estimate/generatedItems";
import {
  checkAddition,
  duplicateOf,
  extractObjectFacts,
  impliedNote,
  isTemporaryMeasureNorm,
  MAX_IMPLIED_ITEMS,
  sameNormTable,
  type ImpliedCategory,
  type ImpliedCatalogItem,
  type ImpliedItem,
  type ImpliedProposer,
  type ObjectFacts,
} from "@/domain/estimate/impliedWorks";
import type { NormSearchIndex } from "@/domain/estimate/matchNorms";
import { tableCodeOf } from "@/domain/estimate/normalize";
import type { NormPicker, NormPickContext } from "@/domain/estimate/normPick";
import type { BillOfWorkItem, BillOfWorkSection, NormRecord } from "@/domain/estimate/types";
import { deriveUnitDivisor, parseUnit } from "@/domain/estimate/units";
import { withNormPicks } from "@/services/estimateNormPick";

/**
 * Этап «работы по технологии» расчёта сметы (`impliedWorks.ts`): ИИ предлагает дополнения к ведомости, код проверяет и принимает.
 *
 * Когда идёт. После выбора норм ИИ (`withNormPicks`): модель видит позиции ведомости вместе с нормами, которые им выбраны, и объём, на который
 * ссылаются формулы. Один вызов модели на расчёт (`ImpliedProposer`), затем один подбор норм «ИИ-сметчиком» для принятых дополнений (тот же `NormPicker`,
 * что у ведомости: кандидатов собирает код, шифр вне списка отбрасывается, единица нормы обязана переводиться). Дополнение без выбранной нормы не
 * добавляется: цену по наименованию ему не назначают, и «лишняя строка без денег» человеку ни к чему.
 *
 * Чего этап не делает: не меняет строки ведомости; не вызывается для смет по ЛСР заказчика, без подборщика норм и по выключенной опции (решает
 * вызывающий код — `buildResourceFromDocuments`). Сбой модели — не сбой расчёта: счётчик `failed`, ведомость как была.
 */

export interface ImpliedStageOptions {
  readonly index: NormSearchIndex;
  readonly proposer: ImpliedProposer;
  /** Подбор норм для принятых дополнений: тот же, что у позиций ведомости. */
  readonly picker: NormPicker;
  readonly context: NormPickContext;
  /** Тексты документов закупки: из них кодом извлекаются сведения об объекте. */
  readonly texts: readonly string[];
  /** Норма позиции в расчёте: показывается модели («машины: нет» — подъём материалов уже мог быть в норме). */
  readonly normOf: (item: BillOfWorkItem) => NormRecord | null;
  /** Единицу и делитель позиции с новой нормой назначает расчёт (`withUnitDivisor`). */
  readonly finalize: (item: BillOfWorkItem) => BillOfWorkItem;
}

export interface ImpliedStageResult {
  /** Раздел с добавленными строками; null — ничего не добавлено. */
  readonly section: BillOfWorkSection | null;
  readonly stats: GeneratedImpliedStats;
}

/** Сколько причин отказов остаётся в счётчиках. */
const MAX_NOTES = 8;

/** Позиции, на которые может сослаться формула и которые видит модель: работы по расценке с читаемой единицей. */
function eligible(item: BillOfWorkItem): boolean {
  return (
    item.generated === undefined &&
    item.deduction !== true &&
    item.materialRow === undefined &&
    item.resourceCode === null &&
    item.customerPriceOnly !== true &&
    !isServiceItem(item) &&
    item.quantity > 0
  );
}

/** Объём позиции в базовой единице: множитель единицы («100 м2») входит в число. */
function baseVolume(item: BillOfWorkItem): { quantity: number; unit: string } | null {
  const unit = parseUnit(item.quantityUnit);
  return unit === null ? null : { quantity: Math.round(item.quantity * unit.multiplier * 1e6) / 1e6, unit: unit.unit };
}

/** «Объект по ТЗ: высота 12 м, 5 этажей» — подсказка выбору строки нормы (лес «до 16 м» или «до 25 м»); null — фактов нет. */
function factsRemark(facts: ObjectFacts): string | null {
  const parts = [
    ...(facts.heightM === null ? [] : [`высота ${String(facts.heightM).replace(".", ",")} м`]),
    ...(facts.floors === null ? [] : [`этажность ${String(facts.floors)}`]),
  ];
  return parts.length === 0 ? null : `Объект по ТЗ: ${parts.join(", ")}`;
}

export async function withImpliedWorks(sections: readonly BillOfWorkSection[], options: ImpliedStageOptions): Promise<ImpliedStageResult> {
  const enabled: GeneratedImpliedStats = { ...EMPTY_GENERATED_IMPLIED, enabled: true };
  const notes: string[] = [];
  const note = (text: string): void => {
    if (notes.length < MAX_NOTES) notes.push(text);
  };

  const allItems = sections.flatMap((section) => section.items);
  const catalog = new Map<string, ImpliedCatalogItem>();
  const listed: ImpliedItem[] = [];
  for (const item of allItems) {
    if (!eligible(item) || listed.length >= MAX_IMPLIED_ITEMS) continue;
    const volume = baseVolume(item);
    if (volume === null) continue;
    const id = String(listed.length + 1);
    const norm = options.normOf(item);
    catalog.set(id, { id, name: item.workName, quantity: volume.quantity, unit: volume.unit });
    listed.push({
      id,
      name: item.workName,
      quantity: volume.quantity,
      unit: volume.unit,
      norm: norm === null ? null : { book: norm.baseType, code: norm.code, name: norm.fullName },
      machines: norm === null ? null : norm.resources.some((resource) => resource.kind === "MACHINE"),
    });
  }
  if (listed.length === 0) return { section: null, stats: { ...enabled, skipped: "в ведомости нет работ с читаемым объёмом" } };

  const facts = extractObjectFacts(options.texts);
  let response: Awaited<ReturnType<ImpliedProposer>>;
  try {
    response = await options.proposer({ context: options.context, facts, items: listed });
  } catch (error) {
    note(`предложение работ по технологии не получено: ${error instanceof Error ? error.message : String(error)}`);
    return { section: null, stats: { ...enabled, failed: 1, notes } };
  }

  const existingNames = allItems.map((item) => item.workName);
  const accepted: BillOfWorkItem[] = [];
  let rejected = response.malformed;
  if (response.malformed > 0) note(`${String(response.malformed)} элементов ответа модели не подошли под схему или категорию`);
  const remark = factsRemark(facts);
  const takenNames: string[] = [];
  const categoryOf = new Map<string, ImpliedCategory>();

  for (const raw of response.additions) {
    const check = checkAddition(raw, catalog, existingNames);
    if (check.status === "REJECTED") {
      rejected += 1;
      note(check.reason);
      continue;
    }
    // Два одинаковых предложения в одном ответе — одна строка.
    const twin = duplicateOf("OTHER_TECH", check.draft.workName, takenNames);
    if (twin !== null) {
      rejected += 1;
      note(`«${check.draft.workName.slice(0, 60)}»: повторяет «${twin.slice(0, 60)}» из того же ответа`);
      continue;
    }
    takenNames.push(check.draft.workName);
    categoryOf.set(`gen-ai-${String(accepted.length + 1)}`, check.draft.category);
    const generatedNote = impliedNote(check.draft);
    accepted.push({
      id: `gen-ai-${String(accepted.length + 1)}`,
      workName: check.draft.workName,
      quantity: check.draft.quantity,
      quantityUnit: check.draft.unit,
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      resourceCode: null,
      sourceQuote: generatedNote,
      sourceDocument: null,
      billSection: null,
      ...(remark === null ? {} : { remark }),
      generated: "AI_IMPLIED",
      generatedNote,
    });
  }

  const base: GeneratedImpliedStats = { ...enabled, proposed: response.additions.length + response.malformed, tokens: response.tokens, notes };
  if (accepted.length === 0) return { section: null, stats: { ...base, rejected } };

  // Норму принятым дополнениям выбирает тот же «ИИ-сметчик»: кандидатов собирает код, шифр вне списка и непереводимая единица отбрасываются.
  const picked = await withNormPicks([{ title: GENERATED_IMPLIED_SECTION, items: accepted }], {
    index: options.index,
    picker: options.picker,
    context: options.context,
    finalize: options.finalize,
  });
  for (const pickNote of picked.stats.notes) note(pickNote);

  const items: BillOfWorkItem[] = [];
  for (const item of picked.sections[0]?.items ?? []) {
    const label = item.workName.slice(0, 60);
    if (item.normCode === null || item.normBaseType === null) {
      rejected += 1;
      note(`«${label}»: норма не выбрана — строка не добавлена`);
      continue;
    }
    // Коэффициенты на демонтаж к добавленной работе не применяются: лес и ограждение не разбирают «по норме на устройство».
    if (item.aiNormPick?.demolition === true) {
      rejected += 1;
      note(`«${label}»: ИИ-сметчик выбрал норму на демонтаж — не принято`);
      continue;
    }
    const norm = options.normOf(item);
    if (norm === null || deriveUnitDivisor(item.quantityUnit, norm.unit) === null) {
      rejected += 1;
      note(`«${label}»: единица нормы не переводится из единицы строки — не принято`);
      continue;
    }
    /*
      Норма — постоянная конструкция вне категорий («Устройство козырьков над входами» вместо временной меры): белый список — временные меры и технология, а не здание
      (`isTemporaryMeasureNorm`). Строку отбрасываем, как бы ни назвала работу модель.
    */
    const category = categoryOf.get(item.id) ?? "OTHER_TECH";
    if (!isTemporaryMeasureNorm(category, norm.fullName)) {
      rejected += 1;
      note(`«${label}»: выбрана норма «${norm.fullName.slice(0, 80)}» — постоянная конструкция, а не временная мера по технологии; не принято`);
      continue;
    }
    /*
      Дубль по норме (а): строка ведомости уже посчитана по той же таблице норм (книга + три группы шифра), что и дополнение. Это надёжнее слов в наименовании:
      работа та же, как бы её ни назвал заказчик.
    */
    const same = allItems.find((existing) => {
      const existingNorm = options.normOf(existing);
      return existingNorm !== null && sameNormTable({ book: existingNorm.baseType, code: existingNorm.code }, { book: norm.baseType, code: norm.code });
    });
    if (same !== undefined) {
      rejected += 1;
      note(`«${label}»: в ведомости уже есть «${same.workName.slice(0, 60)}» по той же таблице норм ${norm.baseType} ${tableCodeOf(norm.code)}`);
      continue;
    }
    items.push({ ...item, billSection: GENERATED_IMPLIED_SECTION });
  }

  return {
    section: items.length === 0 ? null : { title: GENERATED_IMPLIED_SECTION, items },
    stats: { ...base, accepted: items.length, rejected, tokens: base.tokens + picked.stats.tokens, notes },
  };
}
