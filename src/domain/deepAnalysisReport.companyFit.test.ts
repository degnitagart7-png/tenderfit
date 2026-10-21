import { describe, expect, it } from "vitest";

import { buildDeepAnalysisReport, type ReportBlock } from "@/domain/deepAnalysisReport";
import type { DeepAnalysisSummary } from "@/domain/deepAnalysis";
import { FIT_VERSION, type CompanyFitResult } from "@/domain/companyFacts/fit";
import { demoTenders } from "@/mocks/tenders";

/** Раздел «Соответствие вашей компании» в отчёте Word: свой у каждого пользователя, стоит сразу после допуска. */

const tender = demoTenders[0]!;
const NOW = new Date("2026-10-21T12:00:00Z");

const summary = {
  state: "completed",
  title: "Разбор завершён",
  detail: "Прочитано 1 файл из 1.",
  job: null,
  documents: [],
  documentsWithText: 1,
  documentsSkipped: 0,
  documentsTruncated: 0,
  chunksAnalyzed: 1,
  findings: [],
  findingGroups: [],
  modelUsed: "m",
  verdictChange: null,
} as unknown as DeepAnalysisSummary;

const FIT: CompanyFitResult = {
  version: FIT_VERSION,
  tenderId: tender.regNumber,
  computedAt: NOW.toISOString(),
  overall: "no_fit",
  headline: "Не подходит: Наличие автовышки",
  summary: "Участвовать можно, уточните технику.",
  requirements: [
    { id: "r1", kind: "EXPERIENCE", title: "Опыт выполнения работ", required: "не менее 20% НМЦК", verdict: "ok", basis: "Выполнено на 12 млн ₽.", source: "rule+model", contractIds: [], quote: "опыт не менее 20% НМЦК" },
    { id: "r2", kind: "EQUIPMENT", title: "Наличие автовышки", required: null, verdict: "fail", basis: "Техники нет.", source: "rule", contractIds: [], quote: null },
  ],
  experience: [{ contractId: "c1", subject: "Капитальный ремонт кровли школы", customer: "Администрация города", year: 2025, sumRub: 8_000_000, why: "Тот же вид работ" }],
  gaps: ["Наличие автовышки: Техники нет."],
  risks: ["Короткий срок"],
  basisNote: "Учтено — контрактов из документов: 1.",
  llmUsed: true,
  hasCompanyData: true,
};

const build = (companyFit: CompanyFitResult | null | undefined) =>
  buildDeepAnalysisReport({ regNumber: tender.regNumber, subject: tender.subject, summary, generatedAt: NOW, tender, ...(companyFit === undefined ? {} : { companyFit }) });

const sectionOf = (companyFit: CompanyFitResult | null | undefined) => build(companyFit).sections.find((section) => section.title === "Соответствие вашей компании");

describe("отчёт: соответствие вашей компании", () => {
  it("нет сверки или нет данных о компании — раздела нет", () => {
    expect(sectionOf(undefined)).toBeUndefined();
    expect(sectionOf(null)).toBeUndefined();
    expect(sectionOf({ ...FIT, hasCompanyData: false })).toBeUndefined();
  });

  it("раздел стоит сразу после «Можем ли участвовать»", () => {
    const titles = build(FIT).sections.map((section) => section.title);
    const index = titles.indexOf("Соответствие вашей компании");
    expect(index).toBeGreaterThan(0);
    expect(titles[index - 1]).toBe("Можем ли участвовать");
  });

  it("итог одной строкой и цветом, таблица — только «не подходит» и «нужно уточнить», по строке на пункт", () => {
    const section = sectionOf(FIT)!;
    const first = section.blocks[0];
    expect(first).toMatchObject({ kind: "paragraph", tone: "bad", bold: true });
    expect((first as { text: string }).text).toBe("Не подходит: Наличие автовышки");

    const table = section.blocks.find((block): block is Extract<ReportBlock, { kind: "table" }> => block.kind === "table")!;
    expect(table.columns.map((column) => column.title)).toEqual(["№", "Требование", "Вердикт", "Основание"]);
    expect(table.columns.reduce((sum, column) => sum + column.width, 0)).toBe(100);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.[1]).toMatchObject({ text: "Наличие автовышки", bold: true });
    expect(table.rows[0]?.[2]).toMatchObject({ text: "Не подходит", tone: "bad" });
    expect(table.rows[0]?.[3]).toMatchObject({ text: "Техники нет" });
  });

  it("«подходит» — одной компактной строкой, предложение сути одно", () => {
    const section = sectionOf(FIT)!;
    const paragraphs = section.blocks.filter((block): block is Extract<ReportBlock, { kind: "paragraph" }> => block.kind === "paragraph").map((block) => block.text);
    expect(paragraphs).toContain("Подходит (1): Опыт выполнения работ.");
    expect(paragraphs).toContain("Участвовать можно, уточните технику");
    expect(paragraphs.some((text) => text.startsWith("Опыт по теме закупки: Капитальный ремонт кровли школы (2025, 8"))).toBe(true);
  });

  it("не больше восьми пунктов в таблице и трёх рисков; повторы пунктов в рисках отброшены", () => {
    const many: CompanyFitResult = {
      ...FIT,
      overall: "partial",
      requirements: Array.from({ length: 12 }, (_, i) => ({ id: `r${String(i)}`, kind: "LICENSE" as const, title: `Лицензия вида ${String(i)}`, required: null, verdict: "check" as const, basis: "Нужно проверить.", source: "rule" as const, contractIds: [], quote: null })),
      gaps: ["Лицензия вида 3: Нужно проверить.", "Нужен второй экземпляр допуска"],
      risks: ["Риск 1", "Риск 2", "Риск 3", "Риск 4"],
    };
    const section = sectionOf(many)!;
    const table = section.blocks.find((block): block is Extract<ReportBlock, { kind: "table" }> => block.kind === "table")!;
    expect(table.rows).toHaveLength(8);
    const bullets = section.blocks.find((block): block is Extract<ReportBlock, { kind: "bullets" }> => block.kind === "bullets")!;
    expect(bullets.items).toEqual(["Риск 1", "Риск 2", "Риск 3"]);
  });

  it("подпись говорит, чем сделана сверка и что персональных данных в ИИ нет", () => {
    const last = sectionOf(FIT)!.blocks.at(-1) as { text: string };
    expect(last.text).toContain("Учтено — контрактов из документов: 1.");
    expect(last.text).toContain("персональные данные до ИИ не доходят");
    const noModel = sectionOf({ ...FIT, llmUsed: false })!.blocks.at(-1) as { text: string };
    expect(noModel.text).toContain("без ИИ");
  });
});
