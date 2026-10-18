import { config } from "dotenv";
import { resolve } from "node:path";
import {
  formatLlmCostReport,
  parseReportDate,
  summarizeLlmUsage,
} from "../src/domain/llmCostReport";
import { llmUsageRepository } from "../src/repositories/llmUsageRepository";

config({ path: resolve(__dirname, "../.env.local") });

/**
 * Отчёт о расходе на языковую модель в рублях (таблица llm_usage_log).
 *
 *   npx tsx scripts/llm-cost-report.ts                         — за всё время
 *   npx tsx scripts/llm-cost-report.ts --since 2026-10-08      — с начала суток 8 октября (UTC)
 *   npx tsx scripts/llm-cost-report.ts --since 2026-10-08 --until 2026-11-08
 *
 * Печатает: расход по видам работ; на одну закупку по глубокому анализу
 * (количество, среднее, медиана, p90, максимум, средний объём текста, пять самых
 * дорогих закупок); то же по смете; итог за период и в среднем в день.
 * Границы — даты в UTC; --until входит в отчёт целиком.
 *
 * Ключи Supabase берутся из .env.local, как у остальных скриптов. Скрипт только
 * читает базу.
 */

function parseArgs(argv: readonly string[]): { since?: Date; until?: Date; help: boolean } {
  const out: { since?: Date; until?: Date; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--since": {
        const value = argv[i + 1];
        if (!value) throw new Error("--since требует дату YYYY-MM-DD");
        out.since = parseReportDate(value, false);
        i += 1;
        break;
      }
      case "--until": {
        const value = argv[i + 1];
        if (!value) throw new Error("--until требует дату YYYY-MM-DD");
        out.until = parseReportDate(value, true);
        i += 1;
        break;
      }
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "Отчёт о расходе на ИИ в рублях.",
        "",
        "  --since YYYY-MM-DD   с начала этих суток (UTC)",
        "  --until YYYY-MM-DD   по эти сутки включительно (UTC)",
      ].join("\n"),
    );
    return;
  }

  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`В .env.local нет ${missing.join(", ")}`);

  const rows = await llmUsageRepository.listBetween({
    ...(args.since ? { since: args.since.toISOString() } : {}),
    ...(args.until ? { until: args.until.toISOString() } : {}),
  });
  const summary = summarizeLlmUsage(rows, {
    since: args.since ?? null,
    until: args.until ?? (args.since ? new Date() : null),
  });
  console.log(formatLlmCostReport(summary));
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Критическая ошибка:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
