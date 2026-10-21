import { textStems, type CompanyFitResult, type FitRequirement } from "@/domain/companyFacts/fit";
import { pluralRu } from "@/utils/format";

/**
 * Как сверка с компанией выглядит для глаз: одна строка итога, одно предложение сути, строки «не подходит» и «нужно уточнить»
 * по одной на пункт, «подходит» — свёрнуто, риски — не больше трёх. Одни и те же функции кормят экран и отчёт Word, чтобы
 * они не разошлись.
 *
 * Принцип: главное — сверху и коротко, подробности — по требованию. Ничего не повторяется: «чего не хватает» и риски,
 * которые пересказывают строки «нужно уточнить», здесь отбрасываются.
 */

export type FitTone = "good" | "warn" | "bad" | "neutral";

export interface FitVerdictLine {
  tone: FitTone;
  /** «Подходит с оговорками · 2 пункта уточнить», «Не подходит: Допуск СРО», «Подходит». */
  text: string;
}

/** Обрезка по границе слова с многоточием. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.lastIndexOf(" ", max - 1);
  return `${clean.slice(0, cut > max * 0.5 ? cut : max - 1).trimEnd().replace(/[,;:.\-—]+$/u, "")}…`;
}

/** Первое предложение, не длиннее `max` знаков. */
export function oneSentence(text: string, max: number): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  const first = /^.*?[.!?](?=\s|$)/u.exec(clean)?.[0] ?? clean;
  return clip(first.replace(/[.\s]+$/u, ""), max);
}

/** Суть вывода по пункту: первое предложение основания, коротко. */
export function essenceOf(basis: string, max = 90): string {
  return oneSentence(basis, max);
}

/** Название пункта в итоговой строке: коротко и без точки. */
export function shortTitle(title: string, max = 60): string {
  return clip(title.replace(/[.\s]+$/u, ""), max);
}

export function groupedRequirements(result: CompanyFitResult): { fails: FitRequirement[]; checks: FitRequirement[]; oks: FitRequirement[] } {
  return {
    fails: result.requirements.filter((item) => item.verdict === "fail"),
    checks: result.requirements.filter((item) => item.verdict === "check"),
    oks: result.requirements.filter((item) => item.verdict === "ok"),
  };
}

/** Итог одной строкой. Регион в счёт «уточнить» не идёт: это справка, а не препятствие (как и в общем итоге). */
export function verdictLine(result: CompanyFitResult): FitVerdictLine {
  const { fails, checks } = groupedRequirements(result);
  const checkCount = checks.filter((item) => item.kind !== "REGION").length;
  switch (result.overall) {
    case "no_fit": {
      const named = fails.slice(0, 2).map((item) => shortTitle(item.title)).join("; ");
      const more = fails.length > 2 ? ` и ещё ${String(fails.length - 2)}` : "";
      return { tone: "bad", text: `Не подходит: ${named}${more}` };
    }
    case "partial":
      return { tone: "warn", text: `Подходит с оговорками · ${String(checkCount)} ${pluralRu(checkCount, ["пункт", "пункта", "пунктов"])} уточнить` };
    case "fit":
      return { tone: "good", text: "Подходит" };
    default:
      return { tone: "neutral", text: "Сверять не с чем" };
  }
}

/** Суть итога: одно предложение до ~160 знаков; полный текст — «Подробнее». Совпадает с итоговой строкой — не повторяется. */
export function summaryShort(result: CompanyFitResult, max = 160): { short: string; full: string | null } {
  const full = result.summary.trim();
  if (full === "" || full === result.headline) return { short: "", full: null };
  const short = oneSentence(full, max);
  return { short, full: full.length > short.length + 1 ? full : null };
}

/** Строка уже сказана пунктом: основная часть слов названия пункта есть в тексте. */
export function repeatsRequirement(text: string, requirements: readonly FitRequirement[]): boolean {
  const own = textStems(text);
  const lower = text.toLowerCase();
  return requirements.some((item) => {
    if (item.verdict === "ok") return false;
    if (lower.startsWith(item.title.toLowerCase().slice(0, 30))) return true;
    const titleStems = textStems(item.title);
    if (titleStems.size === 0) return false;
    let shared = 0;
    for (const stem of titleStems) if (own.has(stem)) shared += 1;
    return shared / titleStems.size >= 0.6 && shared >= 2;
  });
}

export const MAX_RISKS = 3;

/**
 * Риски одним списком: то, что модель назвала рисками, и то, чего ей не хватало, — за вычетом строк, повторяющих пункты
 * «нужно уточнить». Не больше трёх, по одной строке.
 */
export function riskLines(result: CompanyFitResult): string[] {
  const out: string[] = [];
  for (const text of [...result.risks, ...result.gaps]) {
    const line = oneSentence(text, 110);
    if (line === "" || repeatsRequirement(text, result.requirements)) continue;
    if (out.some((existing) => existing.toLowerCase() === line.toLowerCase())) continue;
    out.push(line);
    if (out.length >= MAX_RISKS) break;
  }
  return out;
}
