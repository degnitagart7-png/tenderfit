import { describe, expect, it } from "vitest";
import { summarizeDeepAnalysis } from "@/domain/deepAnalysis";
import { buildDeepAnalysisReport, type ReportBlock } from "@/domain/deepAnalysisReport";
import { buildMoney } from "@/domain/reportMoney";
import { demoTenders } from "@/mocks/tenders";
import type { AnalysisFinding, DocumentAnalysisRow } from "@/types/database";

/*
  Word-отчёт: норма закона не риск (findingNoise.ts). Типовое по 44-ФЗ схлопнуто в одно
  предложение «проверили, отклонений нет», нарушение закона об оплате стоит риском с
  пояснением про ФАС, а числа обеспечений остаются в «Деньгах».
*/

const NOW = new Date("2026-10-14T12:00:00Z");

function finding(patch: Partial<AnalysisFinding>): AnalysisFinding {
  return {
    category: "risk",
    title: "Риск",
    detail: "Пояснение.",
    evidence_quote: "цитата",
    evidence_section: "Проект контракта",
    severity: "medium",
    ...patch,
  };
}

function row(findings: AnalysisFinding[]): DocumentAnalysisRow {
  return {
    id: "an-1",
    tender_id: "t",
    document_id: "doc-1",
    model_used: "m",
    analysis: { findings, summary: "s" },
    verdict_before: null,
    verdict_after: null,
    old_score: null,
    new_score: null,
    confidence_score: null,
    tokens_used: 1,
    processing_time_ms: 1,
    created_at: "2026-10-14T10:00:00Z",
  };
}

const tender = demoTenders.find((t) => t.law === "FZ_44")!;

function report(findings: AnalysisFinding[], law: "FZ_44" | "FZ_223") {
  const summary = summarizeDeepAnalysis({
    dataSource: "EIS",
    jobs: [
      {
        id: "j",
        tender_id: "t",
        job_type: "full_analysis",
        status: "completed",
        priority: 0,
        documents_total: 1,
        documents_processed: 1,
        error_message: null,
        started_at: null,
        finished_at: null,
        created_at: "2026-10-14T10:00:00Z",
        updated_at: "2026-10-14T10:00:00Z",
      },
    ],
    documents: [],
    documentAnalyses: [row(findings)],
    verdictHistory: [],
    law,
  });
  return buildDeepAnalysisReport({
    regNumber: tender.regNumber,
    subject: tender.subject,
    summary,
    generatedAt: NOW,
    tender: { ...tender, law },
  });
}

function textOf(blocks: ReportBlock[]): string {
  return blocks
    .map((b) => {
      if (b.kind === "paragraph") return b.text;
      if (b.kind === "table") return b.rows.map((r) => r.map((c) => `${c.text} ${c.detail ?? ""}`).join(" ")).join(" ");
      return "";
    })
    .join("\n");
}

const section = (r: ReturnType<typeof report>, title: string) => r.sections.find((s) => s.title === title);

const TYPICAL = [
  finding({ title: "Возможность одностороннего отказа заказчика", severity: "high" }),
  finding({ title: "Казначейское сопровождение аванса", severity: "high" }),
  finding({ title: "Пеня за просрочку исполнения обязательств" }),
  finding({ category: "blocker", severity: "high", title: "Отсутствие в реестре недобросовестных поставщиков" }),
  finding({ title: "НДС 22%", severity: "high" }),
];

describe("отчёт Word: типовое не риск", () => {
  it("44-ФЗ: рисков нет, одно предложение «проверены, отклонений нет»", () => {
    const risks = section(report(TYPICAL, "FZ_44"), "Риски договора")!;
    const text = textOf(risks.blocks);
    expect(text).toMatch(/отклонений от нормы в условиях договора не найдено/);
    expect(text).toMatch(/Типовые условия 44-ФЗ проверены, отклонений от закона нет: односторонний отказ заказчика \(ч\. 9 ст\. 95\), пени и штрафы по ПП № 1042, казначейское сопровождение аванса\./);
    expect(risks.blocks.some((b) => b.kind === "table")).toBe(false);
    expect(text).not.toMatch(/НДС|недобросовестн/);
  });

  it("223-ФЗ: те же условия остаются рисками, строки про 44-ФЗ нет", () => {
    const risks = section(report(TYPICAL, "FZ_223"), "Риски договора")!;
    const text = textOf(risks.blocks);
    expect(text).toMatch(/Казначейское сопровождение аванса/);
    expect(text).toMatch(/Возможность одностороннего отказа/);
    expect(text).not.toMatch(/Типовые условия 44-ФЗ/);
    expect(text).not.toMatch(/НДС|недобросовестн/);
  });

  it("оплата 30 рабочих дней по 44-ФЗ — риск высокой важности с пояснением про жалобу в ФАС", () => {
    const risks = section(
      report(
        [
          ...TYPICAL,
          finding({
            category: "neutral",
            title: "Срок оплаты",
            evidence_quote: "оплата в течение 30 рабочих дней с даты подписания акта",
          }),
        ],
        "FZ_44",
      ),
      "Риски договора",
    )!;
    const text = textOf(risks.blocks);
    expect(text).toMatch(/Срок оплаты/);
    expect(text).toMatch(/жалобу в ФАС/);
    expect(text).toMatch(/ч\. 13\.1 ст\. 34/);
  });

  it("числа обеспечения остаются в «Деньгах», хотя типовое обеспечение не показано находкой", () => {
    const r = report(
      [
        finding({
          category: "requirement",
          title: "Обеспечение исполнения контракта",
          required_value: "5 % НМЦК",
          evidence_quote: "обеспечение исполнения контракта 5 % от НМЦК",
        }),
      ],
      "FZ_44",
    );
    expect(textOf(section(r, "Деньги")!.blocks)).toMatch(/Обеспечение исполнения/);
    // В «Можем ли участвовать» и «Рисках» обеспечения в пределах закона как находки нет.
    expect(textOf(section(r, "Риски договора")!.blocks)).toMatch(/обеспечение в пределах закона/);
  });
});

describe("«Деньги»: казначейское сопровождение", () => {
  const withTreasury = (law: "FZ_44" | "FZ_223") =>
    buildMoney({
      tender: { ...tender, law, financial: { ...tender.financial, treasurySupport: true } },
      findings: [],
    }).rows.find((row) => row[0]?.text === "Казначейское сопровождение");

  it("по 44-ФЗ — факт без тревоги (типовое условие)", () => {
    const row = withTreasury("FZ_44")!;
    expect(row[2]?.tone).toBeUndefined();
    expect(row[2]?.text).toMatch(/Типовое условие 44-ФЗ/);
  });

  it("по 223-ФЗ — по-прежнему предупреждение", () => {
    expect(withTreasury("FZ_223")![2]?.tone).toBe("warn");
  });
});
