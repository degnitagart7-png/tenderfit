import { z } from "zod";

import type { RejectedBillRow } from "@/domain/estimate/billExtraction";
import { hasConfirmedConditions } from "@/domain/estimate/customerCoefficients";
import { stripAiNormMaterials } from "@/domain/estimate/normMaterial";
import { stripAiNormPick } from "@/domain/estimate/normPick";
import { normalizeText } from "@/domain/estimate/normalize";
import type {
  BillOfWorkItem,
  BillOfWorkSection,
  EstimateLine,
} from "@/domain/estimate/types";
import { baseUnitOf, parseUnit } from "@/domain/estimate/units";

/**
 * Правки ведомости объёмов: что человек исправил в «Ведомости и нормах».
 *
 * Расчёт сметы разбирает ведомость и подбирает нормы сам, и ошибается в двух местах: прочитал не
 * тот объём или подобрал не ту норму («Демонтаж наружных стен» → опалубка). Правка — это не новый
 * расчёт и не вызов модели: исходная ведомость остаётся как была, а поверх неё лежит короткий
 * список правок, который применяется чистой функцией. Тот же список сохраняется за закупкой и
 * пользователем и переживает повторное извлечение ведомости (`remapEdits`).
 *
 * Правка называет строку не только номером, но и «якорем» — наименованием, объёмом, номером
 * позиции и шифром строки на момент правки. По якорю её можно приложить к строке новой ведомости,
 * у которой номера уже другие.
 *
 * Модуль чистый: ни сети, ни базы норм, ни часов. Что в норме и сколько она стоит — решает расчёт.
 */

/** Раздел, в который попадают строки, добавленные вручную. */
export const ADDED_SECTION_TITLE = "Добавлено вручную";
/** Раздел, в который попадают строки, возвращённые из отклонённых. */
export const RESTORED_SECTION_TITLE = "Возвращено в расчёт";

/** Норма, выбранная человеком: книга и код — пара, которая однозначно находит запись в базе. */
export interface NormPick {
  readonly code: string;
  readonly baseType: string;
}

/** Чем строка была на момент правки: по этому её находят в новой ведомости. */
export interface RowAnchor {
  readonly itemId: string;
  readonly workName: string;
  readonly quantity: number;
  readonly unit: string;
  readonly positionNumber: string | null;
  readonly normCode: string | null;
  readonly section: string | null;
}

/** Строка, которую человек добавил или вернул из отклонённых: хранится в правке целиком. */
export interface AddedRow {
  readonly workName: string;
  readonly quantity: number;
  readonly unit: string;
  /** Норма, выбранная человеком; null — подберёт поиск по наименованию. */
  readonly norm: NormPick | null;
  /** Своя цена за единицу, ₽ без НДС; null — цена по норме. */
  readonly unitPrice: number | null;
  readonly sourceQuote: string | null;
  readonly sourceDocument: string | null;
}

/**
 * Одна правка.
 *
 * - `change` — объём и/или единица (только то, что отличается от исходной строки);
 * - `remove` — строка убрана из расчёта;
 * - `norm` — вместо подобранной взята эта норма;
 * - `price` — своя цена за единицу вместо цены по норме;
 * - `coefficients` — коэффициенты заказчика к строке: `apply: false` снимает их, `apply: true` включает; у строки
 *   без подтверждённых значений включает неподтверждённые, и они становятся допущением;
 * - `material` — количество и цена материала «по проекту» (норма с расходом «П» или материалом без марки): без них стоимость
 *   материала в расчёт не входит; по одной правке на материал (шифр ресурса);
 * - `add` — новая строка;
 * - `restore` — отклонённая строка возвращена в расчёт (`sourceKey` — какая именно).
 *
 * Изменения, сделанные над добавленной или возвращённой строкой, в отдельные правки не
 * выделяются, а вносятся в саму строку: у неё нет исходного состояния, к которому можно вернуться.
 */
export type BillEdit =
  | { readonly kind: "change"; readonly anchor: RowAnchor; readonly quantity?: number; readonly unit?: string }
  | { readonly kind: "remove"; readonly anchor: RowAnchor }
  | { readonly kind: "norm"; readonly anchor: RowAnchor; readonly norm: NormPick }
  | { readonly kind: "price"; readonly anchor: RowAnchor; readonly unitPrice: number }
  | { readonly kind: "coefficients"; readonly anchor: RowAnchor; readonly apply: boolean }
  | {
      readonly kind: "material";
      readonly anchor: RowAnchor;
      readonly code: string;
      readonly name: string;
      readonly unit: string;
      /** На весь объём позиции. */
      readonly quantity: number;
      /** За единицу, ₽ без НДС. */
      readonly unitPrice: number;
    }
  | { readonly kind: "add"; readonly id: string; readonly row: AddedRow }
  | { readonly kind: "restore"; readonly id: string; readonly sourceKey: string; readonly row: AddedRow };

export type BillEditKind = BillEdit["kind"];

/** Что хранится за закупкой и пользователем (`bill-edits:<tenderId>` в данных аккаунта). */
export interface BillEditsRecord {
  readonly version: 1;
  readonly tenderId: string;
  /** Задание расчёта, к ведомости которого относятся правки. */
  readonly baseJobId: string;
  /** Отпечаток ведомости: по нему видно, изменилась ли она при повторном расчёте. */
  readonly billSignature: string;
  readonly updatedAt: string;
  readonly edits: readonly BillEdit[];
}

/* ------------------------------ проверка формы ------------------------------ */

const text = (max: number) => z.string().max(max);
const finitePositive = z
  .number()
  .refine((value) => Number.isFinite(value) && value > 0, { message: "Ожидалось положительное число" });

const normPickSchema = z.object({ code: z.string().min(1).max(40), baseType: z.string().min(1).max(20) });

const anchorSchema = z.object({
  itemId: z.string().min(1).max(80),
  workName: text(1000),
  quantity: z.number().finite(),
  unit: text(40),
  positionNumber: text(40).nullable(),
  normCode: text(40).nullable(),
  section: text(300).nullable(),
});

const addedRowSchema = z.object({
  workName: z.string().min(1).max(1000),
  quantity: finitePositive,
  unit: z.string().min(1).max(40),
  norm: normPickSchema.nullable(),
  unitPrice: finitePositive.nullable(),
  sourceQuote: text(4000).nullable(),
  sourceDocument: text(300).nullable(),
});

export const billEditSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("change"),
    anchor: anchorSchema,
    quantity: finitePositive.optional(),
    unit: z.string().min(1).max(40).optional(),
  }),
  z.object({ kind: z.literal("remove"), anchor: anchorSchema }),
  z.object({ kind: z.literal("norm"), anchor: anchorSchema, norm: normPickSchema }),
  z.object({ kind: z.literal("price"), anchor: anchorSchema, unitPrice: finitePositive }),
  z.object({ kind: z.literal("coefficients"), anchor: anchorSchema, apply: z.boolean() }),
  z.object({
    kind: z.literal("material"),
    anchor: anchorSchema,
    code: z.string().min(1).max(60),
    name: z.string().min(1).max(400),
    unit: z.string().min(1).max(40),
    quantity: finitePositive,
    unitPrice: finitePositive,
  }),
  z.object({ kind: z.literal("add"), id: z.string().min(1).max(80), row: addedRowSchema }),
  z.object({
    kind: z.literal("restore"),
    id: z.string().min(1).max(80),
    sourceKey: z.string().min(1).max(1500),
    row: addedRowSchema,
  }),
]);

/** Сколько правок принимаем: ведомость на сотни строк с запасом, но не бесконечность. */
export const MAX_BILL_EDITS = 600;

export const billEditsSchema = z.array(billEditSchema).max(MAX_BILL_EDITS);

export const billEditsRecordSchema = z.object({
  version: z.literal(1),
  tenderId: z.string().min(1).max(200),
  baseJobId: z.string().min(1).max(80),
  billSignature: z.string().min(1).max(80),
  updatedAt: z.string().max(40),
  edits: billEditsSchema,
});

/** Идентификатор строки, к которой относится правка. */
export function editTargetId(edit: BillEdit): string {
  return edit.kind === "add" || edit.kind === "restore" ? edit.id : edit.anchor.itemId;
}

/* ------------------------------ якоря и отпечатки ------------------------------ */

/** Якорь строки: снимок того, по чему её найдут в другой ведомости. */
export function anchorOf(item: BillOfWorkItem): RowAnchor {
  return {
    itemId: item.id,
    workName: item.workName,
    quantity: item.quantity,
    unit: item.quantityUnit,
    positionNumber: item.positionNumber ?? null,
    normCode: item.normCode ?? item.normCodeHint?.code ?? null,
    section: item.billSection ?? null,
  };
}

/** FNV-1a: короткий устойчивый отпечаток строки; для сравнения, а не для защиты. */
function hash(input: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(36);
}

const quantityKey = (quantity: number): string => String(Math.round(quantity * 1e6) / 1e6);

/**
 * Отпечаток ведомости: наименования, объёмы и единицы всех строк, независимо от порядка и
 * идентификаторов. Одинаковая ведомость при повторном извлечении даёт тот же отпечаток, и
 * правки остаются на месте без вопросов; изменилась хоть одна строка — отпечаток другой.
 */
export function billSignature(sections: readonly BillOfWorkSection[]): string {
  const rows = sections
    .flatMap((section) => section.items)
    // Строки, добавленные расчётом или ИИ, документу не принадлежат: другое предложение модели не должно «менять ведомость» и сбрасывать правки.
    .filter((item) => item.generated === undefined)
    .map((item) => `${normalizeText(item.workName)}|${quantityKey(item.quantity)}|${item.quantityUnit.trim().toLowerCase()}`)
    .sort();
  return `${String(rows.length)}-${hash(rows.join("\n"))}`;
}

/* ------------------------------ ведение списка правок ------------------------------ */

/** Следующий свободный номер для добавленной строки: `add-1`, `add-2`, … */
export function nextAddedId(edits: readonly BillEdit[]): string {
  let max = 0;
  for (const edit of edits) {
    if (edit.kind !== "add") continue;
    const match = /^add-(\d+)$/u.exec(edit.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return `add-${String(max + 1)}`;
}

function isOwnRow(edit: BillEdit, id: string): edit is Extract<BillEdit, { kind: "add" | "restore" }> {
  return (edit.kind === "add" || edit.kind === "restore") && edit.id === id;
}

function foldIntoRow(row: AddedRow, edit: Extract<BillEdit, { kind: "change" | "norm" | "price" }>): AddedRow {
  if (edit.kind === "change") {
    return { ...row, quantity: edit.quantity ?? row.quantity, unit: edit.unit ?? row.unit };
  }
  if (edit.kind === "norm") return { ...row, norm: edit.norm };
  return { ...row, unitPrice: edit.unitPrice };
}

/**
 * Вносит правку в список. Правка того же вида над той же строкой заменяет прежнюю: человек
 * называет желаемое состояние, а не дописывает к нему поправки. Список от этого остаётся
 * коротким, а счётчик «N правок» честным — одна строка и один вид правки дают одну правку.
 */
export function recordEdit(edits: readonly BillEdit[], edit: BillEdit): BillEdit[] {
  if (edit.kind === "add" || edit.kind === "restore") {
    return [...edits.filter((item) => !(item.kind === edit.kind && item.id === edit.id)), edit];
  }

  const id = edit.anchor.itemId;

  if (edit.kind === "remove") {
    const own = edits.some((item) => isOwnRow(item, id));
    // Строка была добавлена или возвращена самим человеком: удаляя её, он отменяет и её появление.
    return own
      ? edits.filter((item) => editTargetId(item) !== id)
      : [...edits.filter((item) => editTargetId(item) !== id), edit];
  }

  const ownIndex = edits.findIndex((item) => isOwnRow(item, id));
  if (ownIndex >= 0) {
    const own = edits[ownIndex];
    // У добавленной вручную строки коэффициентов заказчика нет: правка не нужна.
    if (edit.kind === "coefficients" || edit.kind === "material") return [...edits];
    if (own !== undefined && (own.kind === "add" || own.kind === "restore")) {
      const next = [...edits];
      next[ownIndex] = { ...own, row: foldIntoRow(own.row, edit) };
      return next;
    }
  }

  const rest = edits.filter(
    (item) =>
      !(
        item.kind === edit.kind &&
        item.anchor.itemId === id &&
        // Материалов у строки может быть несколько: заменяется правка того же шифра ресурса.
        (edit.kind !== "material" || (item.kind === "material" && item.code === edit.code))
      ),
  );
  if (edit.kind === "change" && edit.quantity === undefined && edit.unit === undefined) return rest;
  return [...rest, edit];
}

/** Убирает правку заданного вида у строки: «вернуть норму по подбору», «убрать свою цену», «вернуть удалённую». */
export function clearEdit(
  edits: readonly BillEdit[],
  itemId: string,
  kind: "change" | "norm" | "price" | "remove" | "coefficients" | "material",
  /** Для `material`: шифр ресурса; нет — убираются все правки материалов строки. */
  resourceCode?: string,
): BillEdit[] {
  const ownIndex = edits.findIndex((item) => isOwnRow(item, itemId));
  if (ownIndex >= 0 && kind !== "remove") {
    const own = edits[ownIndex];
    if (own !== undefined && (own.kind === "add" || own.kind === "restore")) {
      const next = [...edits];
      if (kind === "norm") next[ownIndex] = { ...own, row: { ...own.row, norm: null } };
      else if (kind === "price") next[ownIndex] = { ...own, row: { ...own.row, unitPrice: null } };
      return next;
    }
  }
  return edits.filter(
    (item) =>
      !(
        item.kind === kind &&
        editTargetId(item) === itemId &&
        (item.kind !== "material" || resourceCode === undefined || item.code === resourceCode)
      ),
  );
}

/** Правки строки, которые лежат в списке отдельно (у добавленных строк их нет — всё в самой строке). */
export function editsOfRow(edits: readonly BillEdit[], itemId: string): readonly BillEdit[] {
  return edits.filter((edit) => editTargetId(edit) === itemId);
}

/** Проверка добавляемой строки: пустой строки, нуля и «ни нормы, ни цены» в расчёт не пускаем. */
export function validateAddedRow(row: AddedRow): string | null {
  if (row.workName.trim().length === 0) return "Укажите наименование работы";
  if (!Number.isFinite(row.quantity) || row.quantity <= 0) return "Объём должен быть больше нуля";
  if (parseUnit(row.unit) === null) return "Выберите единицу из списка";
  if (row.norm === null && (row.unitPrice === null || !(row.unitPrice > 0))) {
    return "Выберите норму или укажите свою цену";
  }
  return null;
}

/* ------------------------------ отклонённые строки ------------------------------ */

/** Ключ отклонённой строки: по нему «вернуть в расчёт» находит её и в новой ведомости. */
export function rejectedKey(row: RejectedBillRow["row"]): string {
  return `${normalizeText(row.workName)}|${String(row.quantity).replace(/\s+/gu, "")}|${row.unit.trim().toLowerCase()}`;
}

/** Идентификатор возвращённой строки в ведомости. */
export function restoredId(row: RejectedBillRow["row"]): string {
  return `rej-${hash(rejectedKey(row))}`;
}

/**
 * Объём и единица отклонённой строки, если их можно прочитать.
 *
 * Объём — число с запятой или точкой, больше нуля; единица — из списка поддерживаемых. «100 м3»
 * при объёме 5 даёт 500 м3: множитель единицы входит в объём. Не читается — null: человек
 * исправляет значение сам, и только потом строка возвращается в расчёт.
 */
export function parseRejectedVolume(row: RejectedBillRow["row"]): { quantity: number | null; unit: string | null } {
  const raw = typeof row.quantity === "number" ? String(row.quantity) : row.quantity;
  const cleaned = raw.replace(/[\s ]/gu, "").replace(",", ".");
  const parsed = /^\d+(?:\.\d+)?$/u.test(cleaned) ? Number(cleaned) : Number.NaN;
  const unit = parseUnit(row.unit);
  const multiplier = unit?.multiplier ?? 1;
  return {
    quantity: Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * multiplier * 1e6) / 1e6 : null,
    unit: unit?.unit ?? null,
  };
}

/**
 * Правка «вернуть в расчёт» для отклонённой строки. null — объём или единица не прочитаны и
 * не заданы вручную: возвращать нечего.
 */
export function restoreEdit(
  rejected: RejectedBillRow,
  volume: { quantity: number | null; unit: string | null },
  documentName?: string | null,
): BillEdit | null {
  const parsed = parseRejectedVolume(rejected.row);
  const quantity = volume.quantity ?? parsed.quantity;
  const unit = volume.unit ?? parsed.unit;
  if (quantity === null || unit === null || !(quantity > 0) || parseUnit(unit) === null) return null;
  return {
    kind: "restore",
    id: restoredId(rejected.row),
    sourceKey: rejectedKey(rejected.row),
    row: {
      workName: rejected.row.workName.replace(/\s+/gu, " ").trim(),
      quantity,
      unit,
      norm: null,
      unitPrice: null,
      sourceQuote: rejected.row.evidenceQuote,
      sourceDocument: documentName ?? rejected.documentName ?? null,
    },
  };
}

/** Отклонённые строки без тех, что человек уже вернул в расчёт. */
export function remainingRejected(
  rejected: readonly RejectedBillRow[],
  edits: readonly BillEdit[],
): RejectedBillRow[] {
  const restored = new Set(edits.flatMap((edit) => (edit.kind === "restore" ? [edit.sourceKey] : [])));
  return rejected.filter((item) => !restored.has(rejectedKey(item.row)));
}

/* ------------------------------ применение правок ------------------------------ */

export interface AppliedBillEdits {
  /** Ведомость после правок. Делитель единицы у изменённых строк сброшен: его назначит расчёт по норме. */
  readonly sections: readonly BillOfWorkSection[];
  /** Строки, у которых норму выбрал человек (и от автоподбора ждать нечего). */
  readonly manualNorm: ReadonlySet<string>;
  /** Строки, затронутые правкой, включая добавленные и возвращённые. */
  readonly edited: ReadonlySet<string>;
  /** Строки, убранные человеком: показываются в «Не вошло в расчёт» с кнопкой «Вернуть». */
  readonly removed: readonly BillOfWorkItem[];
  /** Правки, строку которых найти не удалось (в этой ведомости её нет). */
  readonly unmatched: readonly BillEdit[];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function changed(item: BillOfWorkItem, quantity: number, unit: string): BillOfWorkItem {
  let customerPrice = item.customerPrice;
  if (customerPrice != null) {
    // Цена заказчика — цена за единицу из его сметы: пересчитывается на новый объём, пока единица той же величины.
    const sameUnit = baseUnitOf(customerPrice.unit) !== null && baseUnitOf(customerPrice.unit) === baseUnitOf(unit);
    customerPrice = sameUnit ? { ...customerPrice, total: round2(customerPrice.unitPrice * quantity) } : null;
  }
  return {
    ...item,
    // Объём задан человеком: парные величины документа («м3/т») больше не выбираются по единице нормы.
    volumeVariants: undefined,
    quantity,
    quantityUnit: unit,
    unitDivisor: 1,
    customerPrice,
  };
}

function itemFromRow(id: string, row: AddedRow, section: string): BillOfWorkItem {
  return {
    id,
    workName: row.workName,
    quantity: row.quantity,
    quantityUnit: row.unit,
    unitDivisor: 1,
    normCode: row.norm?.code ?? null,
    normBaseType: row.norm?.baseType ?? null,
    resourceCode: null,
    sourceQuote: row.sourceQuote,
    sourceDocument: row.sourceDocument,
    billSection: section,
    ...(row.unitPrice === null ? {} : { ownUnitPrice: row.unitPrice }),
  };
}

/**
 * Применяет правки к ведомости. Исходная ведомость не меняется: возвращается новая.
 *
 * Правки идут по порядку. Правка строки, которой нет, не падает, а попадает в `unmatched`:
 * в ведомости, пересчитанной заново, строка могла исчезнуть, и остальные правки это не отменяет.
 */
export function applyBillEdits(
  sections: readonly BillOfWorkSection[],
  edits: readonly BillEdit[],
): AppliedBillEdits {
  const working: { title: string; items: BillOfWorkItem[] }[] = sections.map((section) => ({
    title: section.title,
    items: [...section.items],
  }));
  const manualNorm = new Set<string>();
  const edited = new Set<string>();
  const removed: BillOfWorkItem[] = [];
  const unmatched: BillEdit[] = [];

  const originals = new Map<string, BillOfWorkItem>();
  for (const section of sections) for (const item of section.items) originals.set(item.id, item);

  const locate = (id: string): { section: number; index: number } | null => {
    for (const [sectionIndex, section] of working.entries()) {
      const index = section.items.findIndex((item) => item.id === id);
      if (index >= 0) return { section: sectionIndex, index };
    }
    return null;
  };
  const replace = (id: string, build: (item: BillOfWorkItem) => BillOfWorkItem): boolean => {
    const at = locate(id);
    if (at === null) return false;
    const section = working[at.section];
    const item = section?.items[at.index];
    if (section === undefined || item === undefined) return false;
    section.items[at.index] = build(item);
    return true;
  };
  const sectionNamed = (title: string): { title: string; items: BillOfWorkItem[] } => {
    const found = working.find((section) => section.title === title);
    if (found !== undefined) return found;
    const created = { title, items: [] as BillOfWorkItem[] };
    working.push(created);
    return created;
  };

  for (const edit of edits) {
    switch (edit.kind) {
      case "change": {
        const ok = replace(edit.anchor.itemId, (item) =>
          changed(item, edit.quantity ?? item.quantity, edit.unit ?? item.quantityUnit),
        );
        if (ok) edited.add(edit.anchor.itemId);
        else unmatched.push(edit);
        break;
      }
      case "norm": {
        const pick = edit.norm;
        const ok = replace(edit.anchor.itemId, (item) => ({
          // Норму выбрал человек: пометка «подобрано ИИ» и коэффициенты на демонтаж, выбранные для нормы модели, снимаются.
          ...stripAiNormMaterials(stripAiNormPick(item)),
          normCode: pick.code,
          normBaseType: pick.baseType,
          // Выбрана расценка: позиция — работа, а не поставка материала по справочнику цен.
          resourceCode: null,
        }));
        if (ok) {
          edited.add(edit.anchor.itemId);
          manualNorm.add(edit.anchor.itemId);
        } else unmatched.push(edit);
        break;
      }
      case "price": {
        const ok = replace(edit.anchor.itemId, (item) => ({ ...item, ownUnitPrice: edit.unitPrice }));
        if (ok) edited.add(edit.anchor.itemId);
        else unmatched.push(edit);
        break;
      }
      case "coefficients": {
        // Коэффициенты заказчика есть не у каждой строки: правка строки без них — в «не найдены».
        const has = locate(edit.anchor.itemId);
        const target = has === null ? undefined : working[has.section]?.items[has.index];
        if (target?.customerConditions === undefined) {
          unmatched.push(edit);
          break;
        }
        const conditions = target.customerConditions;
        replace(edit.anchor.itemId, (item) => ({
          ...item,
          // Включение у позиции без подтверждённых коэффициентов применяет значения заказчика вручную (допущение); у позиции с подтверждёнными — только их.
          customerConditions: { ...conditions, enabled: edit.apply, forceUnconfirmed: edit.apply && !hasConfirmedConditions(conditions) },
        }));
        edited.add(edit.anchor.itemId);
        break;
      }
      case "material": {
        const ok = replace(edit.anchor.itemId, (item) => ({
          ...item,
          projectMaterials: [
            ...(item.projectMaterials ?? []).filter((material) => material.code !== edit.code),
            { code: edit.code, name: edit.name, unit: edit.unit, quantity: edit.quantity, unitPrice: edit.unitPrice },
          ],
        }));
        if (ok) edited.add(edit.anchor.itemId);
        else unmatched.push(edit);
        break;
      }
      case "remove": {
        const at = locate(edit.anchor.itemId);
        const section = at === null ? undefined : working[at.section];
        const item = at === null ? undefined : section?.items[at.index];
        if (at === null || section === undefined || item === undefined) {
          unmatched.push(edit);
          break;
        }
        section.items.splice(at.index, 1);
        removed.push(originals.get(item.id) ?? item);
        break;
      }
      case "add":
      case "restore": {
        if (locate(edit.id) !== null) break;
        const title = edit.kind === "add" ? ADDED_SECTION_TITLE : RESTORED_SECTION_TITLE;
        sectionNamed(title).items.push(itemFromRow(edit.id, edit.row, title));
        edited.add(edit.id);
        if (edit.row.norm !== null) manualNorm.add(edit.id);
        break;
      }
    }
  }

  return {
    sections: working.filter((section) => section.items.length > 0 || sections.some((origin) => origin.title === section.title)),
    manualNorm,
    edited,
    removed,
    unmatched,
  };
}

/* ------------------------------ сопоставление с новой ведомостью ------------------------------ */

export interface RemappedEdits {
  /** Правки, нашедшие свою строку в новой ведомости, — с якорями новой ведомости. */
  readonly edits: readonly BillEdit[];
  /** Правки, строку которых найти не удалось: показываются человеку, молча не теряются. */
  readonly unmatched: readonly BillEdit[];
  /** Возвращённые строки, которые новая ведомость уже содержит сама: повторять их не нужно. */
  readonly alreadyPresent: readonly BillEdit[];
}

function sameQuantity(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-6 * Math.max(1, Math.abs(left), Math.abs(right));
}

/**
 * Находит в новой ведомости строку, к которой относилась правка.
 *
 * 1. Наименование и объём совпали (вторым признаком служит единица, если названа в обеих).
 * 2. Иначе — номер позиции в документе и шифр строки: наименование модель могла записать
 *    иначе, а номер и шифр остаются теми же.
 *
 * Строка, уже занятая другой правкой, второй раз не выбирается: две одинаковые строки
 * ведомости («Погрузка мусора» — 10 т) получают каждая свою правку.
 */
function findRow(
  anchor: RowAnchor,
  sections: readonly BillOfWorkSection[],
  taken: ReadonlySet<string>,
): BillOfWorkItem | null {
  const items = sections.flatMap((section) => section.items).filter((item) => !taken.has(item.id));
  const name = normalizeText(anchor.workName);

  const byName = items.find(
    (item) =>
      normalizeText(item.workName) === name &&
      sameQuantity(item.quantity, anchor.quantity) &&
      (anchor.unit === "" || item.quantityUnit.trim().toLowerCase() === anchor.unit.trim().toLowerCase()),
  );
  if (byName !== undefined) return byName;

  if (anchor.positionNumber !== null && anchor.normCode !== null) {
    const byPosition = items.find(
      (item) =>
        (item.positionNumber ?? null) === anchor.positionNumber &&
        (item.normCode ?? item.normCodeHint?.code ?? null) === anchor.normCode,
    );
    if (byPosition !== undefined) return byPosition;
  }
  return null;
}

/**
 * Приводит правки, сделанные к прежней ведомости, к новой.
 *
 * Правки добавленных и возвращённых строк самодостаточны и переносятся как есть. Правки
 * существующих строк переносятся, только если строка найдена (`findRow`); их якоря
 * заменяются якорями новой ведомости, чтобы следующее сопоставление шло от неё.
 */
export function remapEdits(
  edits: readonly BillEdit[],
  sections: readonly BillOfWorkSection[],
): RemappedEdits {
  const mapped: BillEdit[] = [];
  const unmatched: BillEdit[] = [];
  const alreadyPresent: BillEdit[] = [];
  const resolved = new Map<string, BillOfWorkItem | null>();
  const taken = new Set<string>();

  const allItems = sections.flatMap((section) => section.items);

  for (const edit of edits) {
    if (edit.kind === "add") {
      mapped.push(edit);
      continue;
    }
    if (edit.kind === "restore") {
      const name = normalizeText(edit.row.workName);
      const present = allItems.some(
        (item) => normalizeText(item.workName) === name && sameQuantity(item.quantity, edit.row.quantity),
      );
      if (present) alreadyPresent.push(edit);
      else mapped.push(edit);
      continue;
    }

    const oldId = edit.anchor.itemId;
    let target = resolved.get(oldId);
    if (target === undefined) {
      // Правка строки, добавленной или возвращённой самим человеком, сюда не доходит: она внутри add/restore.
      target = findRow(edit.anchor, sections, taken);
      resolved.set(oldId, target);
      if (target !== null) taken.add(target.id);
    }
    if (target === null) {
      unmatched.push(edit);
      continue;
    }
    mapped.push({ ...edit, anchor: anchorOf(target) });
  }

  return { edits: mapped, unmatched, alreadyPresent };
}

/* ------------------------------ описание правок словами ------------------------------ */

/** Что изменено в одной позиции: для пометки в таблице и строки отчёта. */
export interface BillEditMark {
  readonly itemId: string;
  /** Наименование работы. */
  readonly title: string;
  readonly kinds: readonly BillEditKind[];
  /** Короткие фразы: «объём 120 → 150 м2», «своя цена 1 200 ₽ за м2». */
  readonly notes: readonly string[];
}

const NUMBER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const num = (value: number): string => NUMBER.format(value);

function normLabelOf(pick: NormPick, line: EstimateLine | undefined): string {
  const name = line !== undefined && line.normCode === pick.code && line.normBaseType === pick.baseType ? line.normName : null;
  return name === null ? `${pick.baseType} ${pick.code}` : `${pick.baseType} ${pick.code} «${name}»`;
}

export interface DescribeEditsInput {
  /** Исходная ведомость расчёта (до правок). */
  readonly baseSections: readonly BillOfWorkSection[];
  readonly edits: readonly BillEdit[];
  /** Строки исходного расчёта по идентификатору позиции: чтобы назвать норму, которая была. */
  readonly baseLines?: ReadonlyMap<string, EstimateLine>;
  /** Строки расчёта после правок: чтобы назвать норму, которая стала. */
  readonly lines?: ReadonlyMap<string, EstimateLine>;
}

/** Правки словами, по одной записи на позицию. Порядок — как в списке правок. */
export function describeBillEdits(input: DescribeEditsInput): BillEditMark[] {
  const baseItems = new Map<string, BillOfWorkItem>();
  for (const section of input.baseSections) for (const item of section.items) baseItems.set(item.id, item);

  const marks = new Map<string, { title: string; kinds: BillEditKind[]; notes: string[] }>();
  const mark = (id: string, title: string) => {
    let entry = marks.get(id);
    if (entry === undefined) {
      entry = { title, kinds: [], notes: [] };
      marks.set(id, entry);
    }
    return entry;
  };

  for (const edit of input.edits) {
    if (edit.kind === "add" || edit.kind === "restore") {
      const entry = mark(edit.id, edit.row.workName);
      entry.kinds.push(edit.kind);
      entry.notes.push(edit.kind === "add" ? "добавлена вручную" : "возвращена в расчёт");
      entry.notes.push(`${num(edit.row.quantity)} ${edit.row.unit}`);
      if (edit.row.unitPrice !== null) entry.notes.push(`своя цена ${num(edit.row.unitPrice)} ₽ за ${edit.row.unit}`);
      else if (edit.row.norm !== null) entry.notes.push(`норма ${normLabelOf(edit.row.norm, input.lines?.get(edit.id))}`);
      continue;
    }

    const id = edit.anchor.itemId;
    const base = baseItems.get(id);
    const entry = mark(id, base?.workName ?? edit.anchor.workName);
    entry.kinds.push(edit.kind);

    if (edit.kind === "change") {
      const oldUnit = edit.anchor.unit;
      const newUnit = edit.unit ?? oldUnit;
      const newQuantity = edit.quantity ?? edit.anchor.quantity;
      if (edit.quantity !== undefined && edit.unit === undefined) {
        entry.notes.push(`объём ${num(edit.anchor.quantity)} → ${num(newQuantity)} ${oldUnit}`);
      } else {
        entry.notes.push(`объём ${num(edit.anchor.quantity)} ${oldUnit} → ${num(newQuantity)} ${newUnit}`);
      }
    } else if (edit.kind === "remove") {
      entry.notes.push("удалена из расчёта");
    } else if (edit.kind === "coefficients") {
      entry.notes.push(
        edit.apply
          ? "коэффициенты заказчика включены вручную, в том числе не подтверждённые приложением 10"
          : "коэффициенты заказчика сняты",
      );
    } else if (edit.kind === "material") {
      entry.notes.push(`материал по проекту «${edit.name}»: ${num(edit.quantity)} ${edit.unit} по ${num(edit.unitPrice)} ₽ без НДС`);
    } else if (edit.kind === "norm") {
      const was = input.baseLines?.get(id);
      const wasText =
        was === undefined || was.priceSource === "CUSTOMER_PRICE" || was.priceSource === "OWN_PRICE"
          ? "подобранной автоматически"
          : `${was.normBaseType} ${was.normCode}`;
      entry.notes.push(`норма ${normLabelOf(edit.norm, input.lines?.get(id))} вместо ${wasText}`);
    } else {
      const unit = edit.anchor.unit;
      entry.notes.push(`своя цена ${num(edit.unitPrice)} ₽ за ${unit} без НДС`);
    }
  }

  return [...marks].map(([itemId, entry]) => ({ itemId, title: entry.title, kinds: entry.kinds, notes: entry.notes }));
}

/** Склонение для счётчика: «1 правка», «2 правки», «5 правок». */
export function editsWord(count: number): string {
  const last = count % 10;
  const tens = count % 100;
  if (tens >= 11 && tens <= 14) return "правок";
  if (last === 1) return "правка";
  if (last >= 2 && last <= 4) return "правки";
  return "правок";
}
