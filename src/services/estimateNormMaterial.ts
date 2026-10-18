import { isServiceItem } from "@/domain/estimate/autoServices";
import { classifyBill, parentPositionNumber, type BillRowClass } from "@/domain/estimate/billMaterial";
import {
  applyNormMaterial,
  checkNormMaterialPick,
  collectNormMaterialMatches,
  normMaterialNeed,
  normResourceOwnPrice,
  openNormMaterials,
  pickNormMaterialByName,
  vetNormMaterial,
  type NormMaterialPickContext,
} from "@/domain/estimate/normMaterial";
import { normalizeText } from "@/domain/estimate/normalize";
import {
  NO_NORM_PICKER,
  NORM_PICK_BATCH_SIZE,
  type NormPickBatch,
  type NormPickContext,
  type NormPickItem,
  type NormPicker,
  type NormPickStats,
  type RawNormPick,
} from "@/domain/estimate/normPick";
import {
  resourceCandidateOf,
  resourceIndexOf,
  type ResourceMatch,
  type ResourcePriceSource,
} from "@/domain/estimate/resourceCandidates";
import type { BillOfWorkItem, BillOfWorkSection, NormRecord, NormResource } from "@/domain/estimate/types";
import { describeFailure, NORM_PICK_CONCURRENCY, runPool } from "@/services/estimateNormPick";

/**
 * Этап «материал нормы по проекту» расчёта сметы для ведомости без сметы заказчика (`normMaterial.ts`).
 *
 * Когда идёт. После подбора норм (`withNormPicks`): нормы позиций уже известны — из документа, выбором ИИ или по наименованию, — и до расчёта.
 * Для каждой позиции, чья норма несёт ресурс без марки с числовым расходом («Состав двухкомпонентный на основе полиуретановых смол» у изоляции
 * из напыляемого ППУ), код собирает кандидатов в справочнике цен, пачками по десять отправляет их модели видом «norm_material» и записывает
 * принятый материал в позицию (`aiNormMaterials`); расчёт подставит его вместо ресурса нормы. Приоритет источников материала: человек
 * (`projectMaterials`) > строка ведомости с материалом > подбор ИИ > пробел «ресурс без марки».
 *
 * Чего этап не делает. Не идёт для смет по ЛСР заказчика (`skip`, заглушка `NO_NORM_PICKER` бенчмарка): там материалы закрывают строки ресурсов заказчика,
 * этот путь не меняется; не трогает позиции с ценой заказчика, остатки ЛСР, услуги, свои цены, строки-материалы и позиции, добавленные расчётом.
 * Не придумывает расход: ресурс без числа («по проекту») остаётся пробелом. Не считает материал второй раз: у работы есть отдельная строка материала
 * в ведомости (подномер «11.1» под «11», ресурс строки совпал с кандидатом) — ресурс нормы остаётся пробелом, а материал стоит поставкой.
 *
 * Группа, род и цена. Ресурс нормы с кодом группы («12.1.02.06»), у которой в справочнике есть записи, получает кандидатов только из группы, и принимается только материал
 * из неё; шире группы ищется лишь когда записей у группы нет — тогда выбор всегда «проверьте». Материал другого рода по словам названия (битумный лист вместо
 * стального профилированного и наоборот) и материал дороже 5 медиан цен группы или 5 собственных цен ресурса нормы отклоняются (`vetNormMaterial`): пробел остаётся.
 * Те же проверки проходит выбор кодом без модели.
 *
 * Сбой — не сбой расчёта. Пачка без ответа, пропущенная позиция или отсутствие подборщика откатываются на выбор кодом без модели (единственный кандидат с
 * высоким покрытием слов названия ресурса нормы, «проверьте»), иначе остаётся пробел. Ответ «нет» оставляет пробел. Ответ вне кандидатов или с
 * непереводимой единицей отклоняется и тоже оставляет пробел.
 */

const MAX_NOTES = 8;

export interface NormMaterialStageOptions {
  /** Нет — модель не зовётся: материал выбирается только запасным путём по наименованию. */
  readonly picker: NormPicker | undefined;
  readonly context: NormPickContext;
  /** Книга цен: из неё строится индекс ресурсов-кандидатов. */
  readonly resources: ResourcePriceSource;
  /** Норма позиции, которую применит расчёт (по шифру, выбору ИИ или наименованию); null — нормы нет. */
  readonly normOf: (item: BillOfWorkItem) => NormRecord | null;
  /** Причина, по которой этап не идёт (смета заказчика): непустая строка отключает этап целиком. */
  readonly skip?: string | null;
  readonly batchSize?: number;
  readonly concurrency?: number;
}

/** Счётчики этапа; в отчёт расчёта они входят полями `normMaterial*` у `NormPickStats` (`mergeNormMaterialStats`). */
export interface NormMaterialStats {
  /** Пар «позиция + ресурс нормы», отправленных модели с кандидатами. */
  readonly requested: number;
  /** Материал принят по ответу модели. */
  readonly picked: number;
  /** Модель ответила «подходящего нет» — пробел остаётся. */
  readonly declined: number;
  /** Ответ не прошёл проверку (вне списка, единица не переводится, норма вместо ресурса). */
  readonly rejected: number;
  /** Материал выбран кодом по наименованию без модели (нет подборщика, пачка не получена, модель пропустила пару). */
  readonly fallback: number;
  readonly batches: number;
  readonly failedBatches: number;
  readonly tokens: number;
  readonly notes: readonly string[];
}

export const EMPTY_NORM_MATERIAL_STATS: NormMaterialStats = {
  requested: 0,
  picked: 0,
  declined: 0,
  rejected: 0,
  fallback: 0,
  batches: 0,
  failedBatches: 0,
  tokens: 0,
  notes: [],
};

/** Счётчики этапа — в общие счётчики подбора: поля `normMaterial*`, пачки, сбои, токены и причины складываются. */
export function mergeNormMaterialStats(stats: NormPickStats, material: NormMaterialStats): NormPickStats {
  return {
    ...stats,
    normMaterialRequested: stats.normMaterialRequested + material.requested,
    normMaterialPicked: stats.normMaterialPicked + material.picked,
    normMaterialDeclined: stats.normMaterialDeclined + material.declined,
    normMaterialRejected: stats.normMaterialRejected + material.rejected,
    normMaterialFallback: stats.normMaterialFallback + material.fallback,
    batches: stats.batches + material.batches,
    failedBatches: stats.failedBatches + material.failedBatches,
    tokens: stats.tokens + material.tokens,
    notes: [...stats.notes, ...material.notes].slice(0, MAX_NOTES),
  };
}

const CUSTOMER_LEVELS: ReadonlySet<string> = new Set(["CUSTOMER_ESTIMATE", "CONTRACT_ESTIMATE"]);

/**
 * Позиция, которой можно подбирать материал нормы: работа по норме с шифром, без цены, материалов и ЛСР заказчика. Строка сметы заказчика, остаток ЛСР и позиция
 * с составом заказчика закрыты его ресурсными строками (`customerMaterialRows`) — этот путь не трогаем.
 */
export function eligibleForNormMaterial(item: BillOfWorkItem): boolean {
  return (
    item.quantity > 0 &&
    item.resourceCode === null &&
    item.materialRow === undefined &&
    item.customerPriceOnly !== true &&
    item.ownUnitPrice == null &&
    item.unaccountedOf === undefined &&
    item.deduction !== true &&
    item.generated === undefined &&
    item.customerMaterialRows === undefined &&
    item.customerResources === undefined &&
    item.customerMaterials === undefined &&
    (item.sourceLevel === undefined || !CUSTOMER_LEVELS.has(item.sourceLevel)) &&
    !isServiceItem(item)
  );
}

/**
 * Под работой есть отдельная строка-материал: подномер «11.1» под «11», опознанная как материал, с ресурсом справочника или без него. Материал работы
 * тогда стоит поставкой, и ресурс нормы «по проекту» нельзя оценивать ещё раз.
 */
function hasMaterialChild(section: BillOfWorkSection, position: number, item: BillOfWorkItem, classes: ReadonlyMap<string, BillRowClass>): boolean {
  const number = item.positionNumber;
  if (number === undefined || number === null || number === "") return false;
  for (let next = position + 1; next < section.items.length; next += 1) {
    const candidate = section.items[next] as BillOfWorkItem;
    // Нумерация началась заново (следующая таблица): дальше — подстроки уже другой работы.
    if (candidate.positionNumber === number) break;
    if (parentPositionNumber(candidate.positionNumber) !== number) continue;
    if (classes.get(candidate.id)?.kind === "MATERIAL" || candidate.materialRow !== undefined || candidate.resourceCode !== null) return true;
  }
  return false;
}

interface Pending {
  readonly section: number;
  readonly index: number;
  /** Идентификатор пары: позиция + код ресурса нормы. */
  readonly key: string;
  readonly item: BillOfWorkItem;
  readonly norm: NormRecord;
  readonly resource: NormResource;
  readonly matches: readonly ResourceMatch[];
  readonly byResourceName: readonly ResourceMatch[];
  /** Что знает проверка ответа: ресурс нормы, работа, собственная цена ресурса. */
  readonly vetting: NormMaterialPickContext;
  readonly request: NormPickItem;
}

/**
 * Подбирает материалы нормы «по проекту». Вход не меняется; позиции без подобранного материала возвращаются теми же объектами.
 */
export async function withNormMaterials(
  sections: readonly BillOfWorkSection[],
  options: NormMaterialStageOptions,
): Promise<{ sections: BillOfWorkSection[]; stats: NormMaterialStats }> {
  const unchanged = { sections: [...sections], stats: EMPTY_NORM_MATERIAL_STATS };
  // Смета заказчика и заглушка бенчмарка по ЛСР: материалы закрывают строки заказчика, этот путь не меняется.
  if (options.picker === NO_NORM_PICKER || (options.skip !== undefined && options.skip !== null && options.skip !== "")) return unchanged;

  const resourceIndex = resourceIndexOf(options.resources);
  if (resourceIndex.size === 0) return unchanged;
  const classes = classifyBill(sections);
  const notes: string[] = [];
  const note = (text: string): void => {
    if (notes.length < MAX_NOTES) notes.push(text);
  };
  const counters = { picked: 0, declined: 0, rejected: 0, fallback: 0, failedBatches: 0, tokens: 0 };
  const replaced = new Map<string, BillOfWorkItem>();
  const keyOf = (section: number, index: number): string => `${String(section)}:${String(index)}`;
  const pending: Pending[] = [];

  sections.forEach((section, sectionIndex) => {
    section.items.forEach((item, itemIndex) => {
      if (!eligibleForNormMaterial(item)) return;
      const norm = options.normOf(item);
      if (norm === null) return;
      // Единицу позиции расчёт к норме не приведёт — позиции в смете не будет, и материал ей ни к чему.
      const divisor = item.unitDivisor > 0 ? item.unitDivisor : 1;
      if (divisor === 1 && item.quantityUnit.trim() !== "" && normalizeText(item.quantityUnit) !== normalizeText(norm.unit)) return;
      const open = openNormMaterials(norm, item);
      if (open.length === 0) return;

      // Материал работы стоит отдельной строкой ведомости — второй раз его оценивать нельзя.
      if (hasMaterialChild(section, itemIndex, item, classes)) {
        note(`«${item.workName.slice(0, 60)}»: материал работы указан отдельной строкой ведомости — ресурс нормы без марки не подбирается`);
        return;
      }

      for (const resource of open) {
        const { matches, byResourceName } = collectNormMaterialMatches(resourceIndex, {
          resourceCode: resource.code,
          resourceName: resource.name,
          unit: resource.unit,
          workName: item.workName,
          remark: item.remark ?? null,
          normName: norm.fullName,
        });
        if (matches.length === 0) continue;
        // Ресурс другой строки этого раздела совпал с кандидатом: материал, скорее всего, уже в ведомости поставкой.
        const candidateCodes = new Set(matches.map((match) => match.entry.code));
        const overlaps = section.items.some((other) => other !== item && other.resourceCode !== null && candidateCodes.has(other.resourceCode));
        if (overlaps) {
          note(`«${item.workName.slice(0, 60)}»: среди кандидатов на ресурс ${resource.code} есть материал другой строки ведомости — не подбирается, чтобы не считать дважды`);
          continue;
        }
        pending.push({
          section: sectionIndex,
          index: itemIndex,
          key: `${item.id}|${resource.code}`,
          item,
          norm,
          resource,
          matches,
          byResourceName,
          vetting: {
            resourceCode: resource.code,
            resourceName: resource.name,
            workName: item.workName,
            normName: norm.fullName,
            ownPrice: normResourceOwnPrice(options.resources, resource),
          },
          request: {
            id: "",
            workName: item.workName,
            quantity: item.quantity,
            unit: item.quantityUnit,
            remark: item.remark ?? null,
            section: item.billSection ?? null,
            kind: "norm_material",
            candidates: [],
            resources: matches.map((match) => resourceCandidateOf(match.entry)),
            normResource: normMaterialNeed(item, norm, resource),
          },
        });
      }
    });
  });

  const finish = (stats: NormMaterialStats): { sections: BillOfWorkSection[]; stats: NormMaterialStats } => ({
    sections: sections.map((section, sectionIndex) => ({
      title: section.title,
      items: section.items.map((item, itemIndex) => replaced.get(keyOf(sectionIndex, itemIndex)) ?? item),
    })),
    stats,
  });

  /** Запись материала в позицию с учётом уже записанных для неё других ресурсов. */
  const apply = (
    member: Pending,
    entry: Parameters<typeof applyNormMaterial>[3],
    source: "AI" | "NAME",
    raw: Pick<RawNormPick, "confidence" | "reason"> | null,
    coverage: number | null,
    widened: boolean,
  ): void => {
    const key = keyOf(member.section, member.index);
    const current = replaced.get(key) ?? member.item;
    replaced.set(
      key,
      applyNormMaterial(current, member.norm, member.resource, entry, {
        source,
        reason: raw?.reason ?? "",
        confidence: raw?.confidence ?? null,
        coverage,
        widened,
      }),
    );
  };

  /** Выбор кодом без модели: единственный кандидат с высоким покрытием слов названия ресурса нормы; иначе пробел остаётся. */
  const fallback = (member: Pending): void => {
    const top = pickNormMaterialByName(member.resource.name, member.byResourceName);
    if (top === null) return;
    const vet = vetNormMaterial(top.entry, resourceIndex, member.resource.unit, member.vetting, member.request.resources ?? []);
    if (!vet.ok) {
      note(`«${member.item.workName.slice(0, 50)} / ${member.resource.code}»: выбор по наименованию отклонён: ${vet.reason}`);
      return;
    }
    counters.fallback += 1;
    apply(member, top.entry, "NAME", null, top.coverage, vet.widened);
  };

  if (pending.length === 0) return finish({ ...EMPTY_NORM_MATERIAL_STATS, notes });

  const picker = options.picker;
  if (picker === undefined) {
    pending.forEach(fallback);
    return finish({ ...EMPTY_NORM_MATERIAL_STATS, fallback: counters.fallback, notes });
  }

  const batchSize = Math.max(1, Math.min(options.batchSize ?? NORM_PICK_BATCH_SIZE, NORM_PICK_BATCH_SIZE));
  const batches: Pending[][] = [];
  for (let start = 0; start < pending.length; start += batchSize) batches.push(pending.slice(start, start + batchSize));

  const runBatch = async (members: readonly Pending[]): Promise<void> => {
    const items = members.map((member, position) => ({ ...member.request, id: String(position + 1) }));
    const batch: NormPickBatch = { context: options.context, items };

    let answer: Awaited<ReturnType<NormPicker>>;
    try {
      answer = await picker(batch);
    } catch (error) {
      counters.failedBatches += 1;
      note(`пачка материалов нормы из ${String(members.length)} позиций не получена: ${describeFailure(error)}`);
      members.forEach(fallback);
      return;
    }
    counters.tokens += answer.tokens;

    const byId = new Map<string, RawNormPick>();
    for (const pick of answer.picks) if (!byId.has(pick.id)) byId.set(pick.id, pick);

    members.forEach((member, position) => {
      const label = `${member.item.workName.slice(0, 50)} / ${member.resource.code}`;
      const raw = byId.get(String(position + 1));
      if (raw === undefined) {
        note(`модель пропустила материал нормы «${label}»`);
        fallback(member);
        return;
      }
      if (raw.pick === null) {
        counters.declined += 1;
        return;
      }
      const check = checkNormMaterialPick(raw.pick, member.request.resources ?? [], resourceIndex, member.resource.unit, member.vetting);
      if (check.status === "REJECTED") {
        counters.rejected += 1;
        note(`«${label}»: ${check.reason}`);
        return;
      }
      counters.picked += 1;
      apply(member, check.entry, "AI", raw, null, check.widened);
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
    batches: batches.length,
    failedBatches: counters.failedBatches,
    tokens: counters.tokens,
    notes,
  });
}
