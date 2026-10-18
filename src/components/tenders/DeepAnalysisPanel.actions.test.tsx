import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { demoTenders } from "@/mocks/tenders";
import type { Tender } from "@/domain/entities";

/*
  Сверка с профилем на сайте говорит то же, что колонка «Что делать» в отчёте Word:
  обе берут текст из `requirementAction`. Здесь — что строка есть и читается как
  действие, а не как служебная причина статуса.
*/

vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
  useEstimateAuditJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
}));

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: { getStatus: vi.fn(), trigger: vi.fn(), getKonturCard: vi.fn(), buyKonturCard: vi.fn() },
}));

const tender: Tender = {
  ...demoTenders[0]!,
  financial: { ...demoTenders[0]!.financial, price: 2_000_000 },
};

const experience = {
  category: "requirement",
  title: "Опыт выполнения работ",
  detail: "",
  evidence_quote: "цена выполненных работ не менее 20% от НМЦК",
  evidence_section: "Требования к участникам",
  severity: "medium",
  requirement_kind: "EXPERIENCE",
  required_value: "опыт исполнения договора, не менее 20% от НМЦК",
};

const smp = {
  category: "requirement",
  title: "Только СМП",
  detail: "",
  evidence_quote: "только субъекты малого предпринимательства",
  evidence_section: "Извещение",
  severity: "medium",
  requirement_kind: "SMP",
  required_value: null,
};

beforeEach(() => {
  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue({
    jobs: [{ id: "job-1", status: "completed", documents_processed: 1 } as never],
    verdictHistory: [],
    documents: [
      {
        id: "doc-1",
        filename: "Извещение.html",
        document_type: "attachment",
        source_type: "eis_api",
        file_url: "https://zakupki.gov.ru/f.html",
        parsed_status: "parsed",
        download_status: "downloaded",
        content_hash: "a".repeat(64),
        file_size: 1000,
        error_message: null,
        created_at: "2026-09-21T20:57:43Z",
        updated_at: "2026-09-21T20:57:43Z",
        raw_json: { title: "Извещение", chars: 100 },
      } as never,
    ],
    documentAnalyses: [
      {
        id: "an-1",
        model_used: "m",
        analysis: { summary: "ok", findings: [smp, experience] },
        tokens_used: 1,
        processing_time_ms: 1,
        created_at: "2026-09-21T21:00:00Z",
      } as never,
    ],
  });
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue({ show: false, allowed: false } as never);
});

afterEach(cleanup);

describe("DeepAnalysisPanel: «Что делать» в сверке с профилем", () => {
  it("у каждого требования — строка «Что делать» тем же текстом, что в отчёте Word", async () => {
    render(
      <DeepAnalysisPanel
        tenderId={tender.id}
        dataSource="EIS"
        subject="Тест"
        tender={tender}
        profile={demoCompanyProfile}
      />,
    );

    await screen.findByText("Сверка с профилем компании");
    const hints = screen.getAllByText(/Что делать:/);
    expect(hints).toHaveLength(2);
    const text = hints.map((node) => node.parentElement!.textContent!.replace(/\s/g, " "));
    // СМП: проверить реестр, иначе участвовать нельзя.
    expect(text.some((t) => t.includes("rmsp.nalog.ru") && t.includes("участвовать нельзя"))).toBe(true);
    // Опыт: процент из требования пересчитан в рубли от НМЦК закупки (20 % × 2 000 000).
    expect(text.some((t) => t.includes("400 000,00 ₽"))).toBe(true);
    // Служебной фразы нет.
    expect(document.body.textContent).not.toMatch(/Автоматически не сверяется/);
  });
});
