import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(__dirname, "../.env.local") });

/**
 * Заполнение `tenders.doc_terms` по документации, скачанной до появления
 * разбора условий (src/domain/documentTerms.ts).
 *
 * Новые документы условия пишут сами при сохранении; этот прогон нужен один
 * раз — после миграции 20261005000015 — и повторно, если поменялись шаблоны.
 * Повторный запуск безопасен: слияние не затирает уже найденное.
 *
 *   npm run backfill:doc-terms -- --dry-run   # показать, что найдено, без записи
 *   npm run backfill:doc-terms
 */

const PAGE = 20;

async function main(): Promise<void> {
  // Импорты после загрузки .env.local: клиент Supabase читает ключи при создании.
  const { getSupabaseServerClient } = await import("../src/lib/supabase");
  const { tenderRepository } = await import("../src/repositories/tenderRepository");
  const { extractDocumentTerms, DOCUMENT_TERM_KINDS } = await import(
    "../src/domain/documentTerms"
  );

  const dryRun = process.argv.includes("--dry-run");
  const supabase = getSupabaseServerClient();
  const counts: Record<string, number> = { documents: 0, written: 0 };
  for (const kind of DOCUMENT_TERM_KINDS) counts[kind] = 0;

  // Пагинация по id, а не offset: текст извещения — сотни килобайт, и страница
  // в двадцать документов — предел, при котором ответ не упирается в таймаут.
  let after = "";
  for (;;) {
    const { data, error } = await supabase
      .from("tender_documents")
      .select("id, tender_id, filename, parsed_text")
      .eq("parsed_status", "parsed")
      .gt("id", after)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (error) throw error;
    const rows = (data ?? []) as {
      id: string;
      tender_id: string;
      filename: string;
      parsed_text: string | null;
    }[];
    if (rows.length === 0) break;

    for (const row of rows) {
      after = row.id;
      const text = row.parsed_text ?? "";
      if (text === "") continue;
      counts.documents! += 1;
      const found = extractDocumentTerms(text);
      for (const kind of DOCUMENT_TERM_KINDS) if (found[kind]) counts[kind]! += 1;

      if (dryRun) {
        for (const kind of DOCUMENT_TERM_KINDS) {
          const term = found[kind];
          if (term) console.log(`${row.tender_id}\t${kind}\t${term.quote}`);
        }
      } else if (await tenderRepository.recordDocumentTerms(row.tender_id, text)) {
        counts.written! += 1;
      }
    }
  }

  console.log(
    `Документов: ${counts.documents}. Найдено — обеспечение заявки: ${counts.bidSecurity}, ` +
      `контракта: ${counts.contractSecurity}, аванс: ${counts.advance}.` +
      (dryRun ? " Режим --dry-run: ничего не записано." : ` Обновлено закупок: ${counts.written}.`),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
