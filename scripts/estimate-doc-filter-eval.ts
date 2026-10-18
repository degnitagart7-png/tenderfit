import { config } from "dotenv";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { selectDocumentForModel } from "../src/domain/estimate/documentRelevance";
import { stripCustomerEstimates } from "../src/domain/estimate/estimateRemoval";
import { describeError } from "../src/lib/errors";
import { documentRepository } from "../src/repositories/documentRepository";
import { tenderRepository } from "../src/repositories/tenderRepository";
import { extractBillOfWork, type BillRowsFetcher } from "../src/services/billOfWorkExtraction";
import { documentsOfRows } from "./estimate-benchmark.lib";
import {
  HELP_TEXT,
  buildRows,
  formatTender,
  formatTotals,
  parseEvalArgs,
  totalsOf,
  type DocumentRow,
  type ModelCall,
  type TenderTotals,
} from "./estimate-doc-filter-eval.lib";

config({ path: resolve(__dirname, "../.env.local") });

/**
 * Офлайн-оценка фильтра документов сметы (`src/domain/estimate/documentRelevance.ts`). МОДЕЛЬ НЕ ВЫЗЫВАЕТСЯ.
 *
 *   npx tsx scripts/estimate-doc-filter-eval.ts --tender 0302100011026000027 --tender 32616407955 [--blind] [--json out.json]
 *
 * Что делает. Для каждой закупки читает документы так же, как расчёт сметы (`documentsOfRows` бенчмарка и воркера: строки
 * `tender_documents` с непустым `parsed_text`, имя — `raw_json.title`, иначе имя файла) и прогоняет через настоящий
 * `extractBillOfWork` дважды: без фильтра (`readAllDocuments: true`, как до изменения) и с фильтром. Вместо модели стоит заглушка:
 * она возвращает пустой ответ и запоминает, сколько знаков ушло бы в платный вызов. Поэтому счёт «фрагментов до/после» точный, а не
 * прикидка: учтены и сметы, и таблицы, которые читает код, и дубли.
 *
 * Печатает по каждому документу: имя, уровень, решение (читать / пропуск / частично / код / дубль), причину, знаки, фрагменты
 * модели до и после; для архивов — решение по каждому файлу. Итог по закупке и по всем закупкам. Расход модели пропорционален
 * входу, поэтому доля сэкономленных знаков — оценка доли сэкономленных денег.
 *
 * Что не делает. Не вызывает языковую модель (ни напрямую, ни через прод), не пишет в базу, не печатает значения окружения.
 * Читает только Supabase (ключи из .env.local). `--blind` вырезает сметы заказчика, как слепой прогон бенчмарка
 * (`estimate-benchmark.ts --blind`): так фильтр видит вход расчёта без ЛСР.
 */

/** Заглушка модели: пустой ответ, но с учётом того, что и сколько ей прислали. */
function recordingFetcher(): { fetcher: BillRowsFetcher; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const fetcher: BillRowsFetcher = async (request) => {
    calls.push({ document: request.documentName, chars: request.chunk.length });
    return { rows: [], hasBill: false, tokens: 0, malformed: 0, truncated: false };
  };
  return { fetcher, calls };
}

interface TenderResult {
  readonly tender: string;
  readonly rows: readonly DocumentRow[];
  readonly totals: TenderTotals;
}

async function loadDocuments(tenderArg: string, blind: boolean): Promise<{ key: string; documents: { name: string; text: string }[] }> {
  const tender = (await tenderRepository.findById(tenderArg).catch(() => null)) ?? (await tenderRepository.findByRegNumber(tenderArg).catch(() => null));
  // Документы лежат под реестровым номером: так читает воркер и бенчмарк.
  const key = tender?.reg_number ?? tenderArg;
  const documents = documentsOfRows(await documentRepository.findByTenderId(key));
  if (!blind) return { key, documents };
  const stripped = stripCustomerEstimates(documents);
  return { key, documents: stripped.documents.map((document) => ({ name: document.name, text: document.text })) };
}

async function evaluate(tenderArg: string, blind: boolean): Promise<TenderResult> {
  const { key, documents } = await loadDocuments(tenderArg, blind);
  if (documents.length === 0) throw new Error("нет документов с текстом");

  const context = { regNumber: key, subject: "Расчёт по документации" };
  const before = recordingFetcher();
  const after = recordingFetcher();
  // Одинаковый вход, различается только фильтр. Повторов нет: заглушка не падает.
  await extractBillOfWork(documents, context, before.fetcher, { retryDelayMs: 0, readAllDocuments: true });
  const report = await extractBillOfWork(documents, context, after.fetcher, { retryDelayMs: 0, readAllDocuments: false });

  const rows = buildRows({
    documents,
    levels: report.documentLevels,
    duplicates: report.duplicateDocuments.map((entry) => entry.name),
    callsBefore: before.calls,
    callsAfter: after.calls,
    decide: (name, text) => selectDocumentForModel(name, text),
  });
  return { tender: key, rows, totals: totalsOf(rows) };
}

async function main(): Promise<void> {
  const args = parseEvalArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  const results: TenderResult[] = [];
  for (const tender of args.tenders) {
    try {
      const result = await evaluate(tender, args.blind);
      results.push(result);
      console.log(formatTender(result.tender, result.rows));
      console.log("");
    } catch (error) {
      console.log(`=== Закупка ${tender} ===\nпропущена: ${describeError(error)}\n`);
    }
  }

  if (results.length > 1) {
    const all = totalsOf(results.flatMap((result) => result.rows));
    console.log(`=== Всего по ${String(results.length)} закупкам ===\n${formatTotals(all)}`);
  }
  if (args.json !== null) {
    writeFileSync(args.json, JSON.stringify(results, null, 2));
    console.log(`Полный отчёт: ${args.json}`);
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
