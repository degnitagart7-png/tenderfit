import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(__dirname, "../.env.local") });

/**
 * Извлечение ведомости объёмов работ из документов закупки.
 *
 * Зачем скрипт. Разбор ведомости — единственное место расчёта, где данные даёт
 * языковая модель, и проверять его надо на настоящей документации, а не на
 * придуманных строках. Скрипт берёт документы закупки такими, какими их уже
 * прочитал воркер, прогоняет через модель и печатает две вещи: что попало в
 * ведомость и что отвергнуто с указанием причины. Второе важнее: по нему видно,
 * где модель выдумывает, а где документация просто не содержит объёмов.
 *
 * Запуск:
 *   npx tsx scripts/extract-bill.ts 32616404800
 *   npx tsx scripts/extract-bill.ts 32616404800 --limit 2
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const regNumber = args.find((value) => !value.startsWith("--"));
  if (regNumber === undefined) {
    throw new Error(
      "Укажите номер закупки: npx tsx scripts/extract-bill.ts <регномер> [--limit N]",
    );
  }

  const limitAt = args.indexOf("--limit");
  const limit =
    limitAt < 0
      ? Number.POSITIVE_INFINITY
      : Number.parseInt(args[limitAt + 1] ?? "", 10);

  const [{ documentRepository }, { tenderRepository }, extraction] =
    await Promise.all([
      import("../src/repositories/documentRepository"),
      import("../src/repositories/tenderRepository"),
      import("../src/services/billOfWorkExtraction"),
    ]);

  /*
    Документы лежат под тем же ключом, каким закупку зовёт интерфейс: в
    tender_documents.tender_id стоит реестровый номер. Карточка закупки из
    таблицы tenders нужна только ради предмета — без неё разбор тоже идёт,
    просто модель получает меньше контекста.
  */
  const tender = await tenderRepository.findByRegNumber(regNumber);
  const subject = tender?.subject ?? "предмет закупки не найден в базе";

  const rows = await documentRepository.findByTenderId(regNumber);
  const withText = rows
    .filter((row) => (row.parsed_text ?? "").length > 0)
    .slice(0, Number.isFinite(limit) ? limit : undefined);

  console.log(`Закупка ${regNumber}: ${subject}`);
  console.log(
    `Документов в базе ${rows.length}, с текстом ${withText.length}${Number.isFinite(limit) ? ` (взято ${withText.length})` : ""}\n`,
  );

  if (withText.length === 0) {
    console.log("Текста ни в одном документе нет — извлекать не из чего.");
    return;
  }

  const report = await extraction.extractBillOfWork(
    withText.map((row) => ({
      name: (row.raw_json as { title?: string } | null)?.title ?? row.filename,
      text: row.parsed_text ?? "",
    })),
    { regNumber, subject },
  );

  for (const section of report.sections) {
    console.log(`\n=== ${section.title} — позиций ${section.items.length}`);
    for (const item of section.items) {
      console.log(
        `  ${item.workName} — ${String(item.quantity)} ${item.quantityUnit}`,
      );
    }
  }

  if (report.documentsWithoutBill.length > 0) {
    console.log(`\nБез ведомости: ${report.documentsWithoutBill.join(", ")}`);
  }

  if (report.rejected.length > 0) {
    console.log(`\n=== Отвергнуто ${report.rejected.length}`);
    const byReason = new Map<string, number>();
    for (const item of report.rejected) {
      byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
    }
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${String(count)}`);
    }
    for (const item of report.rejected.slice(0, 10)) {
      console.log(`  · ${item.message}`);
    }
  }

  const relaxed = report.relaxedAccepted;
  console.log(
    `\nПринято по послаблению: единица из строки ${String(relaxed.unitRecovered)}, объём по строке ${String(relaxed.rowAnchored)}, пересчёт единиц ${String(relaxed.unitFactor)}, арифметика строки ${String(relaxed.arithmetic)}, множитель единицы из строки ${String(relaxed.unitMultiplierRecovered)}`,
  );

  const total = report.sections.reduce(
    (sum, section) => sum + section.items.length,
    0,
  );
  console.log(
    `\nИтого позиций ${total}, отвергнуто ${report.rejected.length}, токенов ${report.tokensUsed}, ${String(Math.round(report.processingTimeMs / 1000))} с`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
