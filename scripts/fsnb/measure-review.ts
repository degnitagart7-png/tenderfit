/**
 * Замер сигнала «проверьте»: сколько неверных подборов он ловит сверх покрытия и сколько верных
 * подсвечивает зря. Нужна собранная база норм (`data/fsnb/index`).
 *
 *   npx tsx scripts/fsnb/measure-review.ts [--list]
 *
 * Три набора:
 *  1. разметка (`review-markup.ts`): наименования работ и суждение «верная ли первая норма»;
 *  2. «ЛСР-подобный»: 560 случайных норм ГЭСН, запрос — наименование нормы целиком (так позиции и
 *     пишутся в реальных ЛСР), верно, если первая норма — из той же таблицы;
 *  3. «короткие наименования»: те же нормы, запрос — наименование до двоеточия (так работу пишет
 *     человек в ведомости), верно при той же таблице.
 * Порог и списки слов подбирались по этим замерам; результат записан в отчёте к изменению.
 */
import { createNormSearchIndex, findNorms, foreignWords, hasForeignSignal, needsReview } from "../../src/domain/estimate/matchNorms";
import { tableCodeOf } from "../../src/domain/estimate/normalize";
import { loadNormSearchIndex } from "../../src/repositories/estimateBaseRepository";
import { MARKUP } from "./review-markup";

void createNormSearchIndex;

/** Детерминированный ГПСЧ: один и тот же набор при каждом запуске. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface Outcome {
  readonly correct: boolean;
  readonly byCoverage: boolean;
  readonly byForeign: boolean;
}

function report(title: string, outcomes: readonly Outcome[]): void {
  const good = outcomes.filter((item) => item.correct);
  const bad = outcomes.filter((item) => !item.correct);
  const caughtCoverage = bad.filter((item) => item.byCoverage).length;
  const caughtExtra = bad.filter((item) => !item.byCoverage && item.byForeign).length;
  const falseCoverage = good.filter((item) => item.byCoverage).length;
  const falseExtra = good.filter((item) => !item.byCoverage && item.byForeign).length;
  console.log(`\n${title}: всего ${String(outcomes.length)}, верных ${String(good.length)}, неверных ${String(bad.length)}`);
  console.log(`  неверных: покрытие ловит ${String(caughtCoverage)}, новый сигнал ловит ещё ${String(caughtExtra)}, остаётся ${String(bad.length - caughtCoverage - caughtExtra)}`);
  console.log(`  верных: покрытие подсвечивает ${String(falseCoverage)}, новый сигнал подсвечивает ещё ${String(falseExtra)} (${((falseExtra / Math.max(1, good.length)) * 100).toFixed(1)} %)`);
}

async function main(): Promise<void> {
  const list = process.argv.includes("--list");
  const index = await loadNormSearchIndex();

  const markup: Outcome[] = [];
  for (const row of MARKUP) {
    const top = findNorms(index, { workName: row.name, limit: 1 })[0];
    if (top === undefined) continue;
    const foreign = foreignWords(index, row.name, top.norm);
    const outcome = { correct: row.correct, byCoverage: needsReview(top), byForeign: hasForeignSignal(foreign) };
    markup.push(outcome);
    if (list) {
      console.log(
        `${row.correct ? "верно  " : "НЕВЕРНО"} cov=${outcome.byCoverage ? "RV" : "--"} foreign=${outcome.byForeign ? "RV" : "--"} ${row.name} -> ${top.norm.code} ${top.norm.fullName.slice(0, 60)} [${foreign.words.slice(0, 3).map((w) => w.word).join(", ")}]`,
      );
    }
  }
  report("Разметка", markup);

  const random = lcg(20261009);
  const gesn = index.norms.filter((norm) => norm.baseType === "ГЭСН");
  const sample = new Set<number>();
  while (sample.size < 560) sample.add(Math.floor(random() * gesn.length));
  const norms = [...sample].map((position) => gesn[position]).filter((norm) => norm !== undefined);

  const run = (queryOf: (name: string) => string | null): Outcome[] => {
    const outcomes: Outcome[] = [];
    for (const norm of norms) {
      const query = queryOf(norm.fullName);
      if (query === null || query.trim().length < 6) continue;
      const top = findNorms(index, { workName: query, limit: 1 })[0];
      if (top === undefined) continue;
      outcomes.push({
        correct: tableCodeOf(top.norm.code) === tableCodeOf(norm.code) && top.norm.baseType === norm.baseType,
        byCoverage: needsReview(top),
        byForeign: hasForeignSignal(foreignWords(index, query, top.norm)),
      });
    }
    return outcomes;
  };
  report("ЛСР-подобный набор (наименование нормы целиком)", run((name) => name));
  report("Короткие наименования (до двоеточия)", run((name) => (name.includes(":") ? name.split(":")[0] ?? null : null)));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
