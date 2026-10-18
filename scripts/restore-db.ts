import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import { getSupabaseServerClient } from "../src/lib/supabase";
import { BACKUP_TABLES } from "./backup-db.lib";

/**
 * Восстановление из копии scripts/backup-db.ts.
 *
 *   npx tsx scripts/restore-db.ts --dir /var/backups/tenderfit/2026-10-18            — проверка копии (ничего не пишет)
 *   npx tsx scripts/restore-db.ts --dir … --apply [--tables tenders,user_data]       — записать в базу из окружения
 *
 * База-приёмник должна иметь схему: сначала миграции supabase/migrations, потом этот скрипт.
 * Запись — upsert по ключу таблицы, пачками: повторный запуск ничего не дублирует. Без --apply
 * скрипт только читает файлы и сверяет число строк с manifest.json — так проверяется, что копия
 * целая, не трогая базу.
 */

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

async function* readRows(file: string): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() !== "") yield JSON.parse(line) as Record<string, unknown>;
  }
}

async function main(): Promise<void> {
  const dir = argValue("--dir");
  if (dir === null) throw new Error("Укажите --dir с папкой копии");
  const apply = process.argv.includes("--apply");
  const only = argValue("--tables")?.split(",").map((t) => t.trim()).filter(Boolean) ?? null;
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { counts: Record<string, number> };
  const supabase = apply ? getSupabaseServerClient() : null;

  let problems = 0;
  for (const table of BACKUP_TABLES) {
    if (only !== null && !only.includes(table.name)) continue;
    const file = join(dir, `${table.name}.ndjson.gz`);
    if (!existsSync(file)) {
      console.log(`  ${table.name}: файла нет`);
      problems += 1;
      continue;
    }
    let count = 0;
    let batch: Record<string, unknown>[] = [];
    const flush = async (): Promise<void> => {
      if (supabase === null || batch.length === 0) return;
      const { error } = await supabase.from(table.name).upsert(batch, { onConflict: table.orderBy.join(",") });
      if (error) throw new Error(`${table.name}: ${error.message}`);
      batch = [];
    };
    for await (const row of readRows(file)) {
      count += 1;
      batch.push(row);
      if (batch.length >= table.pageSize) await flush();
    }
    await flush();
    const expected = manifest.counts[table.name];
    const ok = expected === count;
    if (!ok) problems += 1;
    console.log(`  ${table.name}: ${String(count)} строк${ok ? "" : ` — в описи ${String(expected)}`}${apply ? ", записано" : ""}`);
  }
  console.log(problems === 0 ? (apply ? "Восстановлено." : "Копия целая.") : `Расхождений: ${String(problems)}`);
  if (problems > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error("Восстановление не выполнено:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
