import { config } from "dotenv";
import { resolve } from "node:path";
import { documentSkipMark } from "../src/domain/deepAnalysis";
import { documentRepository } from "../src/repositories/documentRepository";
import {
  parseArchiveVolumes,
  parseAttachment,
} from "../src/services/attachmentParser";
import {
  parseReparseArgs,
  reparseUnreadable,
  type ReparseDoc,
  type ReparseStore,
} from "../src/services/documentReparse";
import type { DocumentMeta } from "../src/types/database";
import { createAttachmentDisk } from "../src/services/diskAttachments";
import { fetchFile, supabaseStore } from "./fetch-tender-documents";

config({ path: resolve(__dirname, "../.env.local") });

/**
 * Повторный разбор документов, которые раньше не прочитались.
 *
 * В tender_documents лежат строки с причиной «Формат rar не разбирается»,
 * «Текстового слоя нет», «Invalid PDF structure», «Не влез в бюджет …»,
 * «Файл больше предела … и не читается» и подобными. Часть записана до
 * того, как проект научился читать rar и 7z, OpenDocument, rtf, тома `.zip.001`
 * и распознавать сканы. Скрипт находит такие строки, скачивает файл по
 * сохранённой ссылке, разбирает новым кодом и пишет результат теми же методами
 * репозитория, что и обычная загрузка (fetch-tender-documents.ts).
 *
 * Запускать только на сервере в России: ЕИС не отвечает зарубежным адресам.
 * Для сканов нужны tesseract-ocr, tesseract-ocr-rus и poppler-utils; без них
 * сканы и картинки пропускаются, остальное перечитывается.
 *
 *   npx tsx scripts/reparse-unreadable.ts --dry-run          — список и счёт, без скачивания и записи
 *   npx tsx scripts/reparse-unreadable.ts --limit 5          — не больше пяти закупок
 *   npx tsx scripts/reparse-unreadable.ts --tender 0134300025826000377
 *   npx tsx scripts/reparse-unreadable.ts --only archive_partial --dry-run
 *                                                            — архивы, прочитанные частично (parsed < total)
 *   npx tsx scripts/reparse-unreadable.ts                    — всё найденное
 *
 * Ограничение «--limit N» считается в закупках, а не в файлах: тома одной
 * закупки читаются комплектом и делят бюджет знаков.
 */

function printUsage(): void {
  console.log(
    [
      "Повторный разбор нечитаемых документов закупок.",
      "",
      "  --dry-run          только перечислить и посчитать; ничего не скачивать и не писать",
      "  --limit <N>        обработать не больше N закупок",
      "  --tender <номер>   одна закупка по реестровому номеру",
      "  --only <группа>    одна группа: format, scan, module, pdf_structure, budget, limit,",
      "                     archive_partial (архивы, прочитанные частично прежним разбором)",
    ].join("\n"),
  );
}

function requireSupabaseEnv(): void {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    throw new Error(`В .env.local нет ${missing.join(", ")}`);
  }
}

function toReparseDoc(row: DocumentMeta & { tender_id: string }): ReparseDoc {
  return {
    tenderId: row.tender_id,
    filename: row.filename,
    title: row.raw_json?.title ?? null,
    documentType: row.document_type,
    sourceType: row.source_type,
    fileUrl: row.file_url,
    parsedStatus: row.parsed_status,
    reason: row.error_message ?? documentSkipMark(row)?.reason ?? null,
    skipCode: documentSkipMark(row)?.code ?? null,
    chars: row.raw_json?.chars ?? null,
    fileSize: row.file_size,
    archive: row.raw_json?.archive
      ? {
          parsed: row.raw_json.archive.parsed,
          total: row.raw_json.archive.total,
          // Список пропусков пишет только нынешний разбор: по нему строки
          // прежнего разбора отличаются от честно непрочитанных архивов.
          listed: Array.isArray(row.raw_json.archive.skipped),
        }
      : null,
  };
}

/** Порт базы поверх тех же репозиториев, что у обычной загрузки. */
const store: ReparseStore = {
  async listUnreadable(options) {
    const rows = await documentRepository.listUnreadable(options);
    return rows.map(toReparseDoc);
  },
  async listPartialArchives(options) {
    const rows = await documentRepository.listParsedArchives(options);
    return rows.map(toReparseDoc);
  },
  async listTender(tenderId) {
    const rows = await documentRepository.listMetaByTenderId(tenderId);
    return rows.map((row) => toReparseDoc({ ...row, tender_id: tenderId }));
  },
  save: (regNumber, document) => supabaseStore.save(regNumber, document),
};

async function main(): Promise<void> {
  const options = parseReparseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  requireSupabaseEnv();
  const started = Date.now();
  console.log(
    `Повторный разбор нечитаемых документов${options.dryRun ? " (dry-run)" : ""}`,
  );

  const report = await reparseUnreadable(
    {
      store,
      fetchFile,
      parse: (bytes, filename, contentType, budgetChars) =>
        parseAttachment(bytes, filename, contentType, budgetChars),
      parseVolumes: (volumes, budgetChars) =>
        parseArchiveVolumes(volumes, budgetChars),
      disk: createAttachmentDisk(),
      ocrAvailable: async () => {
        // Импорт здесь, а не вверху: модуль тянет child_process и нужен только серверу.
        const { getOcrEngine } = await import("../src/services/ocr");
        return await getOcrEngine().available("pdf");
      },
      log: (line) => console.log(line),
    },
    options,
  );

  console.log();
  console.log(
    `Итог: кандидатов ${report.candidates} в ${report.tenders} закупках ` +
      `(форматы ${report.byCategory.format}, сканы ${report.byCategory.scan}, ` +
      `модули ${report.byCategory.module}, pdf ${report.byCategory.pdf_structure}, ` +
      `бюджет ${report.byCategory.budget}, предел объёма ${report.byCategory.limit}, ` +
      `архивы прочитаны частично ${report.byCategory.archive_partial}).`,
  );
  if (!options.dryRun) {
    console.log(
      `Обработано ${report.processed}: прочитано ${report.recovered}, ` +
        `осталось нечитаемым ${report.stillUnreadable}, не влезло в бюджет ${report.overBudget}, ` +
        `сканов без распознавания пропущено ${report.skippedNoOcr}, комплектов пропущено ${report.skippedSets}, ` +
        `отказов по объёму без 7z/unrar пропущено ${report.skippedNoCli}, ` +
        `архивов дочитано ${report.improved}, не лучше прежнего ${report.notImproved}, ` +
        `сбоев сохранения ${report.saveFailures}. ` +
        `${((Date.now() - started) / 1000).toFixed(1)} с.`,
    );
  }
  if (report.aborted) {
    console.error(`Прогон остановлен: ${report.aborted}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(
      "Критическая ошибка:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
