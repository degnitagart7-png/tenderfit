import { createWriteStream, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";

import { getSupabaseServerClient } from "../src/lib/supabase";
import { BACKUP_TABLES, KEEP_DAYS, expiredBackups, readAllRows, type FetchPage } from "./backup-db.lib";

/**
 * Ежедневная резервная копия базы: каждая таблица — сжатый NDJSON в папке с датой.
 *
 *   npx tsx scripts/backup-db.ts [--dir /var/backups/tenderfit]
 *
 * Запускается таймером tenderfit-backup.timer на сервере (deploy/systemd). Хранит KEEP_DAYS
 * последних копий. Ключи Supabase — из окружения (worker.env). Пишет manifest.json с числом
 * строк по таблицам: по нему видно, что копия полная, и с ним сверяется восстановление.
 */

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function writeTable(dir: string, name: string, collect: (write: (rows: unknown[]) => void) => Promise<number>): Promise<number> {
  const gzip = createGzip();
  const out = createWriteStream(join(dir, `${name}.ndjson.gz`));
  gzip.pipe(out);
  const done = new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    gzip.on("error", reject);
  });
  const count = await collect((rows) => {
    for (const row of rows) gzip.write(`${JSON.stringify(row)}\n`);
  });
  gzip.end();
  await done;
  return count;
}

async function main(): Promise<void> {
  const root = argValue("--dir", "/var/backups/tenderfit");
  const today = new Date().toISOString().slice(0, 10);
  const dir = join(root, today);
  mkdirSync(dir, { recursive: true });

  const supabase = getSupabaseServerClient();
  const fetchPage: FetchPage = async (table, offset, limit) => {
    let query = supabase.from(table.name).select("*");
    for (const column of table.orderBy) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(offset, offset + limit - 1);
    return { rows: (data ?? []) as unknown[], error: error ? `${error.message}${error.code ? ` (${error.code})` : ""}` : null };
  };

  const started = Date.now();
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    counts[table.name] = await writeTable(dir, table.name, (write) => readAllRows(table, fetchPage, write));
    console.log(`  ${table.name}: ${String(counts[table.name])}`);
  }
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), counts }, null, 2),
  );

  for (const old of expiredBackups(readdirSync(root), today, KEEP_DAYS)) {
    rmSync(join(root, old), { recursive: true, force: true });
    console.log(`  удалена старая копия ${old}`);
  }
  console.log(`Копия готова: ${dir} за ${String(Math.round((Date.now() - started) / 1000))} с`);
}

void main().catch((err: unknown) => {
  console.error("Резервная копия не сделана:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
