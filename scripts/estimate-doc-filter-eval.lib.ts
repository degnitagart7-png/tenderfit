import type { PartDecision } from "../src/domain/estimate/documentRelevance";
import type { VolumeSourceLevel } from "../src/domain/estimate/types";

/**
 * Чистые помощники `scripts/estimate-doc-filter-eval.ts`: разбор аргументов, строки по документам и текст отчёта. Без базы и
 * сети: всё, что можно проверить без них, проверяется тестом; скрипт только читает базу и печатает.
 */

export interface EvalArgs {
  /** Закупки: реестровый номер или uuid (`--tender` можно повторять). */
  readonly tenders: readonly string[];
  /** Как в бенчмарке `--blind`: сметы заказчика вырезаны из входа, фильтр видит то, что увидел бы расчёт без ЛСР. */
  readonly blind: boolean;
  /** Куда записать полный отчёт JSON; null — только печать. */
  readonly json: string | null;
  readonly help: boolean;
}

export const HELP_TEXT = `Офлайн-оценка фильтра документов сметы (без вызова модели).

  npx tsx scripts/estimate-doc-filter-eval.ts --tender <номер> [--tender <номер> ...] [--blind] [--json <файл>]

По каждой закупке: документы, как их читает расчёт (tender_documents.parsed_text), решение фильтра (читать / пропуск / частично /
код), причина, знаки, фрагменты модели до и после. Модель не вызывается: расчёт ведомости идёт с заглушкой, которая только считает
фрагменты. --blind вырезает сметы заказчика из входа, как слепой прогон бенчмарка.`;

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const tenders: string[] = [];
  let blind = false;
  let json: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--tender": {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--") || next.trim() === "") throw new Error("--tender требует номер закупки");
        const id = next.trim();
        if (!tenders.includes(id)) tenders.push(id);
        i += 1;
        break;
      }
      case "--blind":
        blind = true;
        break;
      case "--json": {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) throw new Error("--json требует путь к файлу");
        json = next;
        i += 1;
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }
  if (!help && tenders.length === 0) throw new Error("Нужен хотя бы один --tender <номер>");
  return { tenders, blind, json, help };
}

/** Один вызов заглушки модели: какому документу и сколько знаков ушло бы в платный вызов. */
export interface ModelCall {
  readonly document: string;
  readonly chars: number;
}

export type RowDecision = "читать" | "пропуск" | "частично" | "код" | "дубль";

export interface DocumentRow {
  readonly name: string;
  readonly level: VolumeSourceLevel | null;
  readonly decision: RowDecision;
  readonly reason: string;
  /** Размер текста документа. */
  readonly chars: number;
  /** Фрагментов модели без фильтра и с фильтром (один фрагмент — один платный вызов). */
  readonly chunksBefore: number;
  readonly chunksAfter: number;
  /** Знаков, ушедших бы в модель без фильтра и с фильтром. */
  readonly charsBefore: number;
  readonly charsAfter: number;
  /** Решения по файлам архива (только у архива из нескольких файлов). */
  readonly parts: readonly PartDecision[];
}

const sum = (calls: readonly ModelCall[], name: string, field: "chars" | "count"): number =>
  calls.filter((call) => call.document === name).reduce((total, call) => total + (field === "chars" ? call.chars : 1), 0);

export function buildRows(input: {
  readonly documents: readonly { readonly name: string; readonly text: string }[];
  readonly levels: readonly { readonly name: string; readonly level: VolumeSourceLevel }[];
  readonly duplicates: readonly string[];
  readonly callsBefore: readonly ModelCall[];
  readonly callsAfter: readonly ModelCall[];
  readonly decide: (name: string, text: string) => { readonly reason: string; readonly parts: readonly PartDecision[] };
}): DocumentRow[] {
  return input.documents.map((document) => {
    const chunksBefore = sum(input.callsBefore, document.name, "count");
    const chunksAfter = sum(input.callsAfter, document.name, "count");
    const charsBefore = sum(input.callsBefore, document.name, "chars");
    const charsAfter = sum(input.callsAfter, document.name, "chars");
    const decision = input.decide(document.name, document.text);
    const level = input.levels.find((entry) => entry.name === document.name)?.level ?? null;
    const base = { name: document.name, level, chars: document.text.length, chunksBefore, chunksAfter, charsBefore, charsAfter, parts: decision.parts.length > 1 ? decision.parts : [] };

    if (level === null && input.duplicates.includes(document.name)) return { ...base, decision: "дубль" as const, reason: "тот же файл уже в наборе: считается один раз" };
    // Модель и без фильтра не звали: смету или таблицу прочитал код (или документ дубль) — фильтру здесь нечего менять.
    if (chunksBefore === 0) return { ...base, decision: "код" as const, reason: "модель не зовётся и без фильтра: документ прочитан кодом (смета, ведомость-таблица) или заменён сверкой" };
    if (chunksAfter === 0) return { ...base, decision: "пропуск" as const, reason: decision.reason };
    if (chunksAfter < chunksBefore || charsAfter < charsBefore) return { ...base, decision: "частично" as const, reason: decision.reason };
    return { ...base, decision: "читать" as const, reason: decision.reason };
  });
}

export interface TenderTotals {
  readonly documents: number;
  readonly skipped: number;
  readonly chunksBefore: number;
  readonly chunksAfter: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
}

export function totalsOf(rows: readonly DocumentRow[]): TenderTotals {
  return {
    documents: rows.length,
    skipped: rows.filter((row) => row.decision === "пропуск" || row.decision === "частично").length,
    chunksBefore: rows.reduce((total, row) => total + row.chunksBefore, 0),
    chunksAfter: rows.reduce((total, row) => total + row.chunksAfter, 0),
    charsBefore: rows.reduce((total, row) => total + row.charsBefore, 0),
    charsAfter: rows.reduce((total, row) => total + row.charsAfter, 0),
  };
}

const number = (value: number): string => value.toLocaleString("ru-RU").replace(/ /g, " ");

/** Доля сэкономленных знаков, целым процентом: расход модели пропорционален входу, поэтому это грубая оценка экономии. */
export function savedPercent(totals: Pick<TenderTotals, "charsBefore" | "charsAfter">): number {
  return totals.charsBefore === 0 ? 0 : Math.round(((totals.charsBefore - totals.charsAfter) / totals.charsBefore) * 100);
}

export function formatTotals(totals: TenderTotals): string {
  return (
    `документов ${String(totals.documents)}, с пропуском ${String(totals.skipped)}; фрагментов модели ${String(totals.chunksBefore)} → ${String(totals.chunksAfter)} ` +
    `(−${String(totals.chunksBefore - totals.chunksAfter)}); знаков ${number(totals.charsBefore)} → ${number(totals.charsAfter)} (−${String(savedPercent(totals))} %)`
  );
}

export function formatTender(tender: string, rows: readonly DocumentRow[]): string {
  const lines = [`=== Закупка ${tender} ===`];
  for (const row of rows) {
    const saved = row.chunksBefore - row.chunksAfter;
    lines.push(
      `[${row.decision.padEnd(8)}] ${row.name} · ${row.level ?? "—"} · ${number(row.chars)} зн` +
        (row.chunksBefore > 0 ? ` · фрагментов ${String(row.chunksBefore)} → ${String(row.chunksAfter)}${saved > 0 ? ` (−${String(saved)})` : ""}` : "") +
        `\n            ${row.reason}`,
    );
    for (const part of row.parts) {
      lines.push(`            └ [${part.read ? "читать " : "пропуск"}] ${part.name} · ${part.level} · ${number(part.chars)} зн · строк с количеством ${String(part.quantityLines)} · ${part.reason}`);
    }
  }
  lines.push(`Итого: ${formatTotals(totalsOf(rows))}`);
  return lines.join("\n");
}
