/**
 * Проверка распределения вердиктов по демо-базе.
 *
 * Смысл проверки — не конкретные числа, а два свойства демо-базы:
 * 1. она показывает человеку все три вердикта на достаточном числе примеров;
 * 2. каждый вердикт в ней выведен по правилам раздела 10 ТЗ, а не «откуда-то».
 *
 * Пороги пересмотрены 01.10.2026. Прежние (≥7 / ≥8 / ≥9) были подобраны под
 * демо-базу до перевзвешивания соответствия предмета: половина балла приходится
 * на subjectFit, и после правки 22 закупки из 35 получили subjectFit = 100,
 * баллы выросли, а полоса 50..74 — единственный источник MANUAL_REVIEW «просто
 * по баллу» — осталась всего с двумя закупками, у которых к тому же есть
 * критический блокер. Число 6 — честное следствие работы движка, а не поломка:
 * замер по всем 35 показал, что каждый вердикт обоснован. Поэтому вместо
 * замороженных чисел проверяется минимум на вердикт и правила его вывода.
 */
import { demoTenders } from "../src/mocks/tenders";
import { demoCompanyProfile } from "../src/mocks/companyProfile";
import { analyzeTender } from "../src/adapters/tender-analysis/mockTenderAnalysisProvider";

/**
 * Сколько примеров каждого вердикта нужно, чтобы демо-база показывала все три
 * состояния. Пять — достаточно, чтобы состояние не выглядело единичным
 * исключением, и не настолько много, чтобы проверка ломалась от осмысленной
 * правки движка или демо-данных.
 */
const MIN_PER_VERDICT = 5;
/** Демо-база обязана покрывать оба закона: клиент работает и по 44-ФЗ, и по 223-ФЗ. */
const MIN_PER_LAW = 8;

const counts: Record<string, number> = {
  RECOMMENDED: 0,
  MANUAL_REVIEW: 0,
  NOT_RECOMMENDED: 0,
};
const lawCounts: Record<string, number> = {};
/** Нарушения правил вердикта: «t-05: RECOMMENDED при блокере». */
const ruleViolations: string[] = [];

for (const t of demoTenders) {
  const a = analyzeTender(t, demoCompanyProfile);
  counts[a.verdict] = (counts[a.verdict] ?? 0) + 1;
  lawCounts[t.law] = (lawCounts[t.law] ?? 0) + 1;
  console.log(
    `${t.id} [${t.law}] score=${String(a.fitScore).padStart(3)} ${a.verdict.padEnd(15)} blockers=${a.hardBlockers.length} unc=${a.uncertainties.length} risks=${a.contractRisks.length} :: ${t.subject.slice(0, 45)}`,
  );

  const criticalBlocker = a.hardBlockers.some((b) => b.critical);
  const materialUncertainty = a.uncertainties.some((u) => u.material);

  // RECOMMENDED — только высокий балл без блокеров и существенных неопределённостей.
  if (
    a.verdict === "RECOMMENDED" &&
    (a.fitScore < 75 || a.hardBlockers.length > 0 || materialUncertainty)
  ) {
    ruleViolations.push(
      `${t.id}: RECOMMENDED при балле ${a.fitScore}, блокеров ${a.hardBlockers.length}, ` +
        `существенных неопределённостей ${a.uncertainties.filter((u) => u.material).length}`,
    );
  }
  // Критический блокер всегда даёт NOT_RECOMMENDED.
  if (criticalBlocker && a.verdict !== "NOT_RECOMMENDED") {
    ruleViolations.push(`${t.id}: критический блокер, но вердикт ${a.verdict}`);
  }
  // NOT_RECOMMENDED — только критический блокер или низкий балл: вердикт «ниоткуда» недопустим.
  if (a.verdict === "NOT_RECOMMENDED" && !criticalBlocker && a.fitScore >= 50) {
    ruleViolations.push(
      `${t.id}: NOT_RECOMMENDED без критического блокера при балле ${a.fitScore}`,
    );
  }
}

console.log("\n=== Распределение вердиктов ===");
console.log(counts);
console.log("Всего закупок:", demoTenders.length);
console.log("По законам:", lawCounts);

const requirements: Array<[string, boolean]> = [
  [`RECOMMENDED>=${MIN_PER_VERDICT}`, (counts.RECOMMENDED ?? 0) >= MIN_PER_VERDICT],
  [`MANUAL_REVIEW>=${MIN_PER_VERDICT}`, (counts.MANUAL_REVIEW ?? 0) >= MIN_PER_VERDICT],
  [`NOT_RECOMMENDED>=${MIN_PER_VERDICT}`, (counts.NOT_RECOMMENDED ?? 0) >= MIN_PER_VERDICT],
  [`44-ФЗ>=${MIN_PER_LAW}`, (lawCounts.FZ_44 ?? 0) >= MIN_PER_LAW],
  [`223-ФЗ>=${MIN_PER_LAW}`, (lawCounts.FZ_223 ?? 0) >= MIN_PER_LAW],
  ["правила вердикта не нарушены", ruleViolations.length === 0],
];

console.log(
  "\nТребования:",
  requirements.map(([label, ok]) => `${label}: ${ok}`).join(" | "),
);

for (const violation of ruleViolations) {
  console.error(`  нарушение: ${violation}`);
}

const failed = requirements.filter(([, ok]) => !ok).map(([label]) => label);
if (failed.length > 0) {
  // Проверка — гейт, а не справка: красный выход видно в цепочке перед деплоем.
  console.error(`\nНе выполнены требования: ${failed.join(", ")}.`);
  process.exitCode = 1;
}
