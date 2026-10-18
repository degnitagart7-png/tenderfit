import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Сверка собранной зоны с корневыми файлами индекса (прежний режим).
 *
 * Условие приёмки сборщика зон: зона Амура (282), собранная `build-zone.ts` из
 * сырья, даёт те же цены, что корневые файлы, собранные `build-index.ts` и
 * `build-split-form.ts`. Скрипт сравнивает файлы построчно и печатает первую
 * разницу; реквизиты сплит-формы — без времени сборки и пути источника.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/compare-zone.ts --zone data/fsnb/index/zones/282 [--root data/fsnb/index]
 */

const FILES = ["prices-current.jsonl", "prices-split.jsonl", "wages.jsonl"] as const;

/**
 * Что в зоне законно отличается от корня.
 *
 * - `wages.jsonl`: зона собрана по полному реестру ставок, корень — по его первой
 *   странице, поэтому у зоны больше точек (рабочие выше 3,4, машинисты, специалисты).
 *   Скрипт печатает, какие точки добавлены, изменены и пропали, а совпадение общих
 *   точек считает обязательным.
 * - `prices-split.jsonl`: оплата труда машинистов у машин сплит-формы в зоне
 *   считается по росту зарплаты (`machinistWageFactor`), в корне — по росту цены
 *   маш.-ч. Отличаться может только поле `machinistSalary`; любое другое
 *   различие — ошибка.
 */

interface Wage {
  readonly kind?: string;
  readonly rank?: number;
  readonly code?: string;
  readonly salary: number;
}

const wageKey = (wage: Wage): string => `${wage.kind ?? "WORKER"}:${wage.code ?? String(wage.rank)}`;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] !== undefined ? (process.argv[at + 1] as string) : fallback;
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

function parse(path: string): Record<string, unknown>[] {
  return lines(path).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function compareWages(zonePath: string, rootPath: string): boolean {
  const zone = parse(zonePath) as unknown as Wage[];
  const root = parse(rootPath) as unknown as Wage[];
  const rootByKey = new Map(root.map((wage) => [wageKey(wage), wage] as const));
  const zoneByKey = new Map(zone.map((wage) => [wageKey(wage), wage] as const));

  const added = zone.filter((wage) => !rootByKey.has(wageKey(wage)));
  const missing = root.filter((wage) => !zoneByKey.has(wageKey(wage)));
  const changed = zone.filter((wage) => {
    const other = rootByKey.get(wageKey(wage));
    return other !== undefined && Math.abs(other.salary - wage.salary) > 0.005;
  });
  const byKind = (items: readonly Wage[]): string => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.kind ?? "WORKER", (counts.get(item.kind ?? "WORKER") ?? 0) + 1);
    return [...counts].map(([kind, count]) => `${kind} ${String(count)}`).join(", ") || "—";
  };

  process.stdout.write(
    `wages.jsonl: зона ${String(zone.length)} точек, корень ${String(root.length)}; добавлено ${String(added.length)} (${byKind(added)}), ` +
      `изменено ${String(changed.length)}, пропало ${String(missing.length)}\n`,
  );
  for (const wage of changed.slice(0, 10)) {
    process.stdout.write(`  изменено ${wageKey(wage)}: корень ${String(rootByKey.get(wageKey(wage))?.salary)} → зона ${String(wage.salary)}\n`);
  }
  for (const wage of missing.slice(0, 10)) process.stdout.write(`  пропало ${wageKey(wage)}: ${String(wage.salary)}\n`);
  // Законно: добавлены новые точки. Незаконно: пропали или изменились общие.
  return changed.length === 0 && missing.length === 0;
}

function compareSplit(zonePath: string, rootPath: string): boolean {
  const zone = parse(zonePath);
  const root = parse(rootPath);
  const rootByCode = new Map(root.map((price) => [String(price.code), price] as const));
  let onlyWage = 0;
  let other = 0;
  let absent = 0;
  let worst = 0;
  for (const price of zone) {
    const reference = rootByCode.get(String(price.code));
    if (reference === undefined) {
      absent += 1;
      continue;
    }
    const keys = new Set([...Object.keys(price), ...Object.keys(reference)]);
    const differing = [...keys].filter((key) => JSON.stringify(price[key]) !== JSON.stringify(reference[key]));
    if (differing.length === 0) continue;
    if (differing.every((key) => key === "machinistSalary")) {
      onlyWage += 1;
      const a = Number(price.machinistSalary);
      const b = Number(reference.machinistSalary);
      if (b > 0) worst = Math.max(worst, Math.abs(a / b - 1));
    } else other += 1;
  }
  const missing = root.filter((price) => !zone.some((item) => item.code === price.code)).length;
  process.stdout.write(
    `prices-split.jsonl: зона ${String(zone.length)}, корень ${String(root.length)}; отличается только оплата труда машинистов у ${String(onlyWage)} ` +
      `(макс. отклонение ${(worst * 100).toFixed(1)} %), иначе — ${String(other)}, нет в корне ${String(absent)}, нет в зоне ${String(missing)}\n`,
  );
  return other === 0 && absent === 0 && missing === 0;
}

function main(): void {
  const zoneDir = resolve(arg("--zone", ""));
  const rootDir = resolve(arg("--root", "data/fsnb/index"));
  let ok = true;

  for (const file of FILES) {
    const left = resolve(zoneDir, file);
    const right = resolve(rootDir, file);
    if (!existsSync(left) || !existsSync(right)) {
      process.stdout.write(`${file}: нет файла (${existsSync(left) ? "корень" : "зона"})\n`);
      ok = false;
      continue;
    }
    if (file === "wages.jsonl") {
      if (!compareWages(left, right)) ok = false;
      continue;
    }
    if (file === "prices-split.jsonl") {
      if (!compareSplit(left, right)) ok = false;
      continue;
    }
    const a = lines(left);
    const b = lines(right);
    let diff = -1;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        diff = i;
        break;
      }
    }
    if (diff < 0) process.stdout.write(`${file}: совпадает, строк ${String(a.length)}\n`);
    else {
      ok = false;
      process.stdout.write(`${file}: различие в строке ${String(diff + 1)} (зона ${String(a.length)}, корень ${String(b.length)})\n  зона:   ${a[diff] ?? "—"}\n  корень: ${b[diff] ?? "—"}\n`);
    }
  }

  const strip = (path: string): string => {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete value.builtAt;
    delete value.source;
    return JSON.stringify(value, Object.keys(value).sort());
  };
  const metaLeft = resolve(zoneDir, "split-form.json");
  const metaRight = resolve(rootDir, "split-form.json");
  if (existsSync(metaLeft) && existsSync(metaRight)) {
    const same = strip(metaLeft) === strip(metaRight);
    if (!same) ok = false;
    process.stdout.write(`split-form.json: ${same ? "совпадает" : "различается"}\n`);
  }
  process.stdout.write(ok ? "ИТОГ: зона согласуется с корнем (допустимые различия перечислены выше)\n" : "ИТОГ: есть недопустимые различия\n");
  process.exitCode = ok ? 0 : 1;
}

main();
