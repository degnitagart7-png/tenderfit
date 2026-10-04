/**
 * Демонстрационный скрипт реального доступа к ЕИС (zakupki.gov.ru).
 * Запуск: npm run scrape:eis -- "поставка компьютеров" 44
 *
 * Скрипт показывает, что лента закупок доступна обычным HTTP-запросом
 * без ЭЦП и авторизации, и сохраняет первые найденные закупки в JSON.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EisTenderSourceAdapter } from "../src/adapters/tender-source/eisTenderSourceAdapter";
import type { TenderLaw } from "../src/domain/enums";

async function main(): Promise<void> {
  const keyword = process.argv[2] ?? "поставка компьютеров";
  const count = Number.parseInt(process.argv[3] ?? "10", 10);
  const laws: TenderLaw[] = ["FZ_44", "FZ_223"];

  console.log(`Запрос к ЕИС: «${keyword}», лимит ${count}, законы ${laws.join(", ")}`);
  const adapter = new EisTenderSourceAdapter({ rateLimitPerSec: 3 });

  const started = Date.now();
  const tenders = await adapter.fetchTenders({
    laws,
    keywords: keyword.split(" "),
    limit: count,
  });
  const elapsed = Date.now() - started;

  console.log(`Получено закупок: ${tenders.length} за ${elapsed} мс`);
  for (const t of tenders.slice(0, count)) {
    console.log(
      `- [${t.law}] №${t.regNumber} | ${t.financial.price.toLocaleString("ru-RU")} ₽ | ${t.region} | ${t.subject.slice(0, 60)}`,
    );
  }

  const outPath = resolve(process.cwd(), "eis-sample.json");
  writeFileSync(outPath, JSON.stringify(tenders.slice(0, count), null, 2), "utf-8");
  console.log(`\nСохранено в ${outPath}`);
}

main().catch((err: unknown) => {
  console.error("Ошибка доступа к ЕИС:", err);
  process.exit(1);
});
