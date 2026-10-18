import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { demoTenders } from "@/mocks/tenders";
import type { Tender } from "@/domain/entities";
import type { AnalysisFinding } from "@/types/database";

/*
  Панель разбора: норма закона не находка (findingNoise.ts). По 44-ФЗ типовое схлопнуто в одну
  приглушённую строку, нарушение закона об оплате остаётся риском с пояснением про ФАС.
*/

vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
  useEstimateAuditJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
}));

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: { getStatus: vi.fn(), trigger: vi.fn(), getKonturCard: vi.fn(), buyKonturCard: vi.fn() },
}));

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

const FINDINGS: AnalysisFinding[] = [
  finding({ severity: "high", title: "Казначейское сопровождение аванса" }),
  finding({ severity: "high", title: "Возможность одностороннего отказа заказчика" }),
  finding({ category: "blocker", severity: "high", title: "Отсутствие статуса иностранного агента" }),
  finding({ title: "НДС 22%", severity: "high" }),
  finding({ category: "neutral", title: "Контактное лицо" }),
  finding({ title: "Работы в зимний период", detail: "Сметой зимнее удорожание не учтено." }),
];

function tenderWith(law: "FZ_44" | "FZ_223"): Tender {
  return { ...demoTenders[0]!, law, documents: [] };
}

beforeEach(() => {
  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue({
    jobs: [{ id: "job-1", status: "completed", documents_processed: 1 } as never],
    verdictHistory: [],
    documents: [
      {
        id: "doc-1",
        filename: "Контракт.docx",
        document_type: "attachment",
        source_type: "eis_api",
        file_url: "https://zakupki.gov.ru/f.docx",
        parsed_status: "parsed",
        download_status: "downloaded",
        content_hash: "a".repeat(64),
        file_size: 1000,
        error_message: null,
        created_at: "2026-09-21T20:57:43Z",
        updated_at: "2026-09-21T20:57:43Z",
        raw_json: { title: "Контракт", chars: 100 },
      } as never,
    ],
    documentAnalyses: [
      {
        id: "an-1",
        model_used: "m",
        analysis: { summary: "ok", findings: FINDINGS },
        tokens_used: 1,
        processing_time_ms: 1,
        created_at: "2026-09-21T21:00:00Z",
      } as never,
    ],
  });
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue({ show: false, allowed: false } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ job: null, zones: [], allZones: [] }) }) as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeepAnalysisPanel: типовое не находка", () => {
  it("44-ФЗ: типовое убрано из рисков и собрано в одну строку, существенное осталось", async () => {
    render(<DeepAnalysisPanel tenderId="t-1" dataSource="EIS" subject="Ремонт" tender={tenderWith("FZ_44")} />);

    expect(await screen.findByText("Работы в зимний период")).toBeInTheDocument();
    expect(screen.queryByText("НДС 22%")).not.toBeInTheDocument();
    expect(screen.queryByText("Отсутствие статуса иностранного агента")).not.toBeInTheDocument();
    expect(screen.queryByText("Контактное лицо")).not.toBeInTheDocument();
    expect(screen.queryByText("Казначейское сопровождение аванса")).not.toBeInTheDocument();
    expect(screen.getByTestId("standard-conditions")).toHaveTextContent(
      "Типовые условия 44-ФЗ без отклонений: односторонний отказ заказчика (ч. 9 ст. 95), казначейское сопровождение аванса.",
    );
  });

  it("223-ФЗ: казначейство и отказ остаются рисками, строки про 44-ФЗ нет", async () => {
    render(<DeepAnalysisPanel tenderId="t-1" dataSource="EIS" subject="Ремонт" tender={tenderWith("FZ_223")} />);

    expect(await screen.findByText("Казначейское сопровождение аванса")).toBeInTheDocument();
    expect(screen.getByText("Возможность одностороннего отказа заказчика")).toBeInTheDocument();
    expect(screen.queryByText("НДС 22%")).not.toBeInTheDocument();
    expect(screen.queryByTestId("standard-conditions")).not.toBeInTheDocument();
  });
});
