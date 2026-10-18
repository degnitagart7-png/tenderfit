import type { BillOfWorkItem, BillOfWorkSection } from "../src/domain/estimate/types";
import { fmtRub, table } from "./estimate-benchmark.lib";

/**
 * Материалы, подобранные ИИ, для отчётов режимов `--blind` и `--estimate-only` скрипта `scripts/estimate-benchmark.ts`.
 *
 * Зачем. В JSON бенчмарка были только итоги строк, и на закупке 0391300028226000005 (кровля) было не видно, какой материал встал под какую норму: битумные листы
 * 675 223 ₽ против 158 952 ₽ у заказчика и профилированный лист 275 003 ₽ против 698 074 ₽ — дорогое покрытие, похоже, попало не на свою позицию. Здесь по каждой нашей строке
 * собирается то, что выбрал ИИ: материал нормы «по проекту» (`BillOfWorkItem.aiNormMaterials`, ресурс нормы → ресурс справочника) и материал строки ведомости
 * (`BillOfWorkItem.materialRow` с `pick`, ресурс справочника вместо нормы работы), с расходом, ценой, суммой, обоснованием и уверенностью модели.
 *
 * Модуль чистый: ни диска, ни сети, ни базы.
 */

export type AiMaterialKind = "NORM_MATERIAL" | "MATERIAL_ROW";

export interface AiMaterialRow {
  /** `NORM_MATERIAL` — материал нормы «по проекту»; `MATERIAL_ROW` — строка ведомости опознана как поставка и получила ресурс справочника. */
  readonly kind: AiMaterialKind;
  readonly itemId: string;
  /** Наименование позиции ведомости, к которой относится материал. */
  readonly lineName: string;
  /** «ГЭСН 12-01-007-12»; у строки-материала — «РЕСУРС <код>». */
  readonly norm: string;
  /** Итог нашей строки без НДС (прямые затраты, НР, СП), ₽. */
  readonly lineTotal: number;
  /** Ресурс нормы без марки, который заменён; у строки-материала null. */
  readonly normResource: { readonly code: string; readonly name: string } | null;
  readonly picked: { readonly code: string; readonly name: string; readonly unit: string };
  /** Расход на всю позицию в единицах справочника, как в строке сметы. */
  readonly quantity: number;
  /** Цена за единицу справочника, ₽. */
  readonly unitPrice: number;
  /** Стоимость материала, ₽. */
  readonly total: number;
  /** `AI` — выбрала модель; `NAME` — код по наименованию без модели. */
  readonly pick: "AI" | "NAME";
  /** Выбор подсвечен «проверьте». */
  readonly review: boolean;
  /** Обоснование модели; у выбора кодом пусто. */
  readonly reason: string;
  /** Уверенность модели; null — не называла, выбор без модели или смета посчитана до появления поля. */
  readonly confidence: "high" | "low" | null;
}

interface ResourceLike {
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly total: number;
}

interface LineLike {
  readonly itemId: string;
  readonly normBaseType: string;
  readonly normCode: string;
  readonly directCost: number;
  readonly overheadCost: number;
  readonly profitCost: number;
  readonly resources: readonly ResourceLike[];
}

export interface AiMaterialsEstimate {
  readonly document: { readonly sections: readonly { readonly lines: readonly LineLike[] }[] };
  readonly bill: { readonly sections: readonly Pick<BillOfWorkSection, "items">[] };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

const reasonOf = (reason: string | undefined, note: string): string => {
  if (reason !== undefined) return reason;
  // Смета без структурного поля: обоснование вынимается из подписи «материал подобран ИИ: …; ресурс …».
  const match = /материал подобран ИИ:\s*([^;]+)/u.exec(note);
  return match === null ? "" : (match[1] as string).trim();
};

/** Материалы, подобранные ИИ или кодом, по строкам сметы: материал нормы «по проекту» и материал строки ведомости. Строки без цены в смету не попали и не берутся. */
export function aiMaterialsOf(estimate: AiMaterialsEstimate): AiMaterialRow[] {
  const items = new Map<string, BillOfWorkItem>();
  for (const section of estimate.bill.sections) for (const item of section.items) items.set(item.id, item);

  const rows: AiMaterialRow[] = [];
  for (const section of estimate.document.sections) {
    for (const line of section.lines) {
      const item = items.get(line.itemId);
      if (item === undefined) continue;
      const lineTotal = round2(line.directCost + line.overheadCost + line.profitCost);

      for (const material of item.aiNormMaterials ?? []) {
        if (material.normCode !== line.normCode || material.normBaseType !== line.normBaseType) continue;
        const resource = line.resources.find((candidate) => candidate.code === material.code);
        if (resource === undefined) continue;
        rows.push({
          kind: "NORM_MATERIAL",
          itemId: item.id,
          lineName: item.workName,
          norm: `${line.normBaseType} ${line.normCode}`.trim(),
          lineTotal,
          normResource: { code: material.normResourceCode, name: material.normResourceName ?? "" },
          picked: { code: material.code, name: resource.name === "" ? material.name : resource.name, unit: resource.unit === "" ? material.unit : resource.unit },
          quantity: resource.quantity,
          unitPrice: resource.unitPrice,
          total: resource.total,
          pick: material.pick,
          review: material.review,
          reason: reasonOf(material.reason, material.note),
          confidence: material.confidence ?? null,
        });
      }

      const row = item.materialRow;
      if (row !== undefined && row.pick !== null && item.resourceCode !== null) {
        const resource = line.resources.find((candidate) => candidate.code === item.resourceCode) ?? line.resources[0];
        if (resource === undefined) continue;
        rows.push({
          kind: "MATERIAL_ROW",
          itemId: item.id,
          lineName: item.workName,
          norm: `${line.normBaseType} ${line.normCode}`.trim(),
          lineTotal,
          normResource: null,
          picked: { code: resource.code, name: resource.name, unit: resource.unit },
          quantity: resource.quantity,
          unitPrice: resource.unitPrice,
          total: resource.total,
          pick: row.pick,
          review: row.review,
          reason: reasonOf(row.pickReason, row.note),
          confidence: row.confidence ?? null,
        });
      }
    }
  }
  return rows;
}

/** Главные материалы по рублям: сначала дорогие, при равенстве — по наименованию позиции. */
export function topAiMaterials(rows: readonly AiMaterialRow[], topN: number): AiMaterialRow[] {
  return [...rows].sort((a, b) => b.total - a.total || a.lineName.localeCompare(b.lineName, "ru")).slice(0, Math.max(0, topN));
}

const KIND_LABELS: Readonly<Record<AiMaterialKind, string>> = { NORM_MATERIAL: "материал нормы «по проекту»", MATERIAL_ROW: "материал строки ведомости" };

const CONFIDENCE_LABELS = { high: "высокая", low: "низкая" } as const;

/**
 * Раздел `summary.md` «материалы, подобранные ИИ» по закупке: главные `topN` по рублям. Пустой список — пустой массив (раздел не печатается).
 * Колонки: позиция, норма, ресурс нормы, подобранный материал, расход, цена, ₽, кто выбрал, уверенность, обоснование.
 */
export function formatAiMaterialsSection(rows: readonly AiMaterialRow[], topN: number, heading = "###"): string[] {
  if (rows.length === 0) return [];
  const top = topAiMaterials(rows, topN);
  const sum = rows.reduce((total, row) => total + row.total, 0);
  return [
    `${heading} Материалы, подобранные ИИ (${String(top.length)} из ${String(rows.length)} по рублям, всего ${fmtRub(sum)} ₽)`,
    "",
    ...table(
      ["Позиция", "Норма", "Вид", "Ресурс нормы (код, название)", "Материал (код, название, ед.)", "Расход", "Цена, ₽", "₽", "Выбор", "Уверенность", "Обоснование"],
      top.map((row) => [
        row.lineName,
        row.norm,
        KIND_LABELS[row.kind],
        row.normResource === null ? null : `${row.normResource.code}${row.normResource.name === "" ? "" : ` ${row.normResource.name}`}`,
        `${row.picked.code} ${row.picked.name}, ${row.picked.unit}`,
        fmtRub(row.quantity),
        fmtRub(row.unitPrice),
        fmtRub(row.total),
        `${row.pick === "AI" ? "ИИ" : "код по наименованию"}${row.review ? ", проверьте" : ""}`,
        row.confidence === null ? null : CONFIDENCE_LABELS[row.confidence],
        row.reason,
      ]),
    ),
  ];
}
