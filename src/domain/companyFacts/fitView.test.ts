import { describe, expect, it } from "vitest";

import { FIT_VERSION, type CompanyFitResult, type FitRequirement } from "@/domain/companyFacts/fit";
import { clip, essenceOf, groupedRequirements, oneSentence, repeatsRequirement, riskLines, summaryShort, verdictLine } from "@/domain/companyFacts/fitView";

const row = (id: string, verdict: FitRequirement["verdict"], title: string, patch: Partial<FitRequirement> = {}): FitRequirement => ({
  id,
  kind: "LICENSE",
  title,
  required: null,
  verdict,
  basis: "Основание.",
  source: "rule",
  contractIds: [],
  quote: null,
  ...patch,
});

const fit = (patch: Partial<CompanyFitResult>): CompanyFitResult => ({
  version: FIT_VERSION,
  tenderId: "T",
  computedAt: "2026-10-21T00:00:00.000Z",
  overall: "partial",
  headline: "Подходит, 2 пункта нужно уточнить",
  summary: "",
  requirements: [],
  experience: [],
  gaps: [],
  risks: [],
  basisNote: "",
  llmUsed: true,
  hasCompanyData: true,
  ...patch,
});

describe("итоговая строка", () => {
  it("подходит с оговорками: без повтора, со счётом пунктов", () => {
    const result = fit({ requirements: [row("1", "check", "А"), row("2", "check", "Б"), row("3", "ok", "В")] });
    expect(verdictLine(result)).toEqual({ tone: "warn", text: "Подходит с оговорками · 2 пункта уточнить" });
    expect(verdictLine(fit({ requirements: [row("1", "check", "А")] })).text).toBe("Подходит с оговорками · 1 пункт уточнить");
    expect(verdictLine(fit({ requirements: Array.from({ length: 5 }, (_, i) => row(String(i), "check", "А")) })).text).toBe("Подходит с оговорками · 5 пунктов уточнить");
  });

  it("не подходит: поимённо, не больше двух и счёт остальных", () => {
    const requirements = [row("1", "fail", "Допуск СРО: строительство."), row("2", "fail", "Опыт"), row("3", "fail", "Лицензия"), row("4", "check", "Техника")];
    expect(verdictLine(fit({ overall: "no_fit", requirements }))).toEqual({ tone: "bad", text: "Не подходит: Допуск СРО: строительство; Опыт и ещё 1" });
  });

  it("подходит и «нечего сверять»", () => {
    expect(verdictLine(fit({ overall: "fit" }))).toEqual({ tone: "good", text: "Подходит" });
    expect(verdictLine(fit({ overall: "unknown" })).tone).toBe("neutral");
  });

  it("регион в счёт «уточнить» не идёт", () => {
    const result = fit({ requirements: [row("1", "check", "А"), row("region", "check", "Регион", { kind: "REGION" })] });
    expect(verdictLine(result).text).toBe("Подходит с оговорками · 1 пункт уточнить");
  });
});

describe("краткость", () => {
  it("первое предложение и обрезка по слову", () => {
    expect(oneSentence("Первое. Второе предложение.", 100)).toBe("Первое");
    const long = "Очень длинное предложение ".repeat(20);
    const cut = oneSentence(long, 160);
    expect(cut.length).toBeLessThanOrEqual(160);
    expect(cut.endsWith("…")).toBe(true);
    expect(clip("коротко", 50)).toBe("коротко");
  });

  it("суть основания — одно предложение до 90 знаков", () => {
    const essence = essenceOf("Штат 32 чел. (в анкете 12, в документах 32) при требуемых 20. Остальное неважно, " + "слово ".repeat(40));
    expect(essence.length).toBeLessThanOrEqual(90);
    expect(essence).not.toContain("Остальное");
  });

  it("краткая суть и полный текст под «Подробнее»", () => {
    const text = "Участвовать можно, но уточните технику. " + "Подробное объяснение модели. ".repeat(10);
    const { short, full } = summaryShort(fit({ summary: text }));
    expect(short).toBe("Участвовать можно, но уточните технику");
    expect(full).toBe(text.trim());
    expect(summaryShort(fit({ summary: "Подходит, 2 пункта нужно уточнить" })).short).toBe("");
    expect(summaryShort(fit({ summary: "Коротко." })).full).toBeNull();
  });
});

describe("порядок и риски", () => {
  it("группы: не подходит, уточнить, подходит", () => {
    const groups = groupedRequirements(fit({ requirements: [row("1", "ok", "А"), row("2", "fail", "Б"), row("3", "check", "В")] }));
    expect(groups.fails.map((r) => r.id)).toEqual(["2"]);
    expect(groups.checks.map((r) => r.id)).toEqual(["3"]);
    expect(groups.oks.map((r) => r.id)).toEqual(["1"]);
  });

  it("строка, пересказывающая пункт «нужно уточнить», — повтор; про «подходит» — нет", () => {
    const requirements = [row("1", "check", "Наличие автовышки у участника"), row("2", "ok", "Опыт выполнения работ")];
    expect(repeatsRequirement("Наличие автовышки: данных о технике нет", requirements)).toBe(true);
    expect(repeatsRequirement("Автовышка у участника не подтверждена", requirements)).toBe(true);
    expect(repeatsRequirement("Короткий срок выполнения", requirements)).toBe(false);
    expect(repeatsRequirement("Опыт выполнения работ подтверждён", requirements)).toBe(false);
  });

  it("риски: не больше трёх, без повторов пунктов, чего не хватало — в общий список", () => {
    const result = fit({
      requirements: [row("1", "check", "Наличие автовышки у участника")],
      risks: ["Риск А.", "Риск Б", "Риск А"],
      gaps: ["Наличие автовышки: данных нет", "Нужна свежая выписка СРО", "Ещё один пробел"],
    });
    expect(riskLines(result)).toEqual(["Риск А", "Риск Б", "Нужна свежая выписка СРО"]);
  });
});
