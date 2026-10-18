import type { ProfileMatch } from "@/domain/profileMatch";
import type { AnalysisFinding } from "@/types/database";

/**
 * Один вывод по закупке — то, что читатель хочет знать раньше всех подробностей.
 *
 * Разбор отдаёт десятки фактов: требования, риски, файлы, цены. Человек, открыв
 * вкладку, ищет один ответ — «идти или нет и что мешает». Эта функция собирает
 * его из тех же данных, что показаны ниже, и ничего не придумывает: каждая
 * строка причины — название требования или риска из разбора.
 */
export type DecisionTone = "good" | "warn" | "bad" | "neutral";

export interface AnalysisDecision {
  tone: DecisionTone;
  /** Короткий вывод, одна строка. */
  headline: string;
  /** До трёх причин — самые весомые, без пересказа всего списка. */
  reasons: string[];
}

const MAX_REASONS = 3;

export function analysisDecision(input: {
  match: ProfileMatch | null;
  findings: readonly AnalysisFinding[];
  documentsSkipped: number;
}): AnalysisDecision {
  const { match, findings, documentsSkipped } = input;
  const highRisks = findings.filter(
    (f) => f.category === "risk" && f.severity === "high",
  );
  const checks = match && match.verdict !== "NO_PROFILE" ? match.checks : [];
  const missing = checks.filter((c) => c.status === "NOT_MET");
  const toCheck = checks.filter((c) => c.status === "CHECK");

  if (missing.length > 0) {
    return {
      tone: "bad",
      headline: "Участвовать пока нельзя: не хватает по профилю",
      reasons: missing.slice(0, MAX_REASONS).map((c) => c.finding.title),
    };
  }

  const concerns: string[] = [
    ...highRisks.map((f) => `Риск: ${f.title}`),
    ...toCheck.map((c) => `Проверить: ${c.finding.title}`),
  ];
  if (documentsSkipped > 0) {
    concerns.push(
      documentsSkipped === 1
        ? "Один файл не прочитан — вывод по нему не делался"
        : `Файлов не прочитано: ${documentsSkipped} — вывод по ним не делался`,
    );
  }
  if (concerns.length > 0) {
    return {
      tone: "warn",
      headline: "Можно рассматривать, но есть что проверить",
      reasons: concerns.slice(0, MAX_REASONS),
    };
  }

  if (match === null || match.verdict === "NO_PROFILE") {
    return {
      tone: "neutral",
      headline: "Заполните профиль компании — тогда будет вывод по допуску",
      reasons: ["Требования найдены, но сверять их пока не с чем"],
    };
  }

  return {
    tone: "good",
    headline: "Препятствий для участия не найдено",
    reasons:
      checks.length > 0
        ? [
            "Требования закрыты профилем компании",
            "Высоких рисков договора нет",
          ]
        : ["Высоких рисков договора нет"],
  };
}
