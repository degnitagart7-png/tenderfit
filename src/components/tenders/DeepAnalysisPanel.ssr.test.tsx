import { openEstimateTab } from "@/test/panelTabs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import { SSR_377_CSV, SSR_BAD } from "@/domain/estimate/customerSsr.fixtures";
import type { Tender } from "@/domain/entities";
import { demoTenders } from "@/mocks/tenders";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { ssrEstimate } from "@/test/ssrFixtures";

/*
  Панель строит сводный расчёт по готовой смете и документам закупки и отдаёт его карточке расчёта; аудит ССР заказчика
  показывается, только когда ССР найден в документах. Карточка расчёта здесь заглушка: она печатает, что получила.
*/
const DOCUMENT = ssrEstimate({ sections: [{ title: "Фасад", workCost: 1_623_390 }] });

vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({
    status: "done",
    jobId: "job-1",
    result: { document: DOCUMENT, rejected: [], documentsWithoutBill: [], billItems: 10 },
    error: null,
    reused: false,
    start: vi.fn(),
  }),
  useEstimateAuditJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
}));

vi.mock("@/components/estimate/EstimateResult", () => ({
  EstimateResult: ({ ssr }: { ssr?: { result: { nmc: { total: number }; reserve: { percent: number } }; comparison: { nmc: number } | null; audits: unknown[] } | null }) => (
    <pre data-testid="ssr">{JSON.stringify(ssr === null || ssr === undefined ? null : { total: ssr.result.nmc.total, reserve: ssr.result.reserve.percent, nmc: ssr.comparison?.nmc ?? null, audits: ssr.audits.length })}</pre>
  ),
}));

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: { getStatus: vi.fn(), trigger: vi.fn(), getKonturCard: vi.fn(), buyKonturCard: vi.fn() },
}));

function tenderWith(text: string, price = 2_032_153.32): Tender {
  return {
    ...demoTenders[0]!,
    law: "FZ_44",
    financial: { ...demoTenders[0]!.financial, price },
    deadlines: { ...demoTenders[0]!.deadlines, publicationDate: "2026-10-01T05:00:00.000Z" },
    documents: [
      { id: "d1", type: "NOTICE", title: "ССРСС", fileName: "НМЦК_Возрождения 46 - ССРСС.xlsx", url: "", text, pageCount: null, lastModified: null } as Tender["documents"][number],
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue({ jobs: [{ id: "job-1", status: "completed" } as never], verdictHistory: [], documents: [], documentAnalyses: [] });
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue({ show: false, allowed: false } as never);
});

describe("DeepAnalysisPanel: сводный расчёт", () => {
  it("смета есть — карточка получает наш ССР: резерв 2 %, НМЦК закупки, один аудит ССР заказчика", async () => {
    const tender = tenderWith(SSR_377_CSV);
    render(<DeepAnalysisPanel tenderId={tender.regNumber} dataSource="EIS" subject="Тест" tender={tender} />);
    await openEstimateTab();
    const shown = JSON.parse((await screen.findByTestId("ssr")).textContent ?? "null") as { total: number; reserve: number; nmc: number; audits: number };
    expect(shown.reserve).toBe(2);
    expect(shown.nmc).toBe(2_032_153.32);
    expect(shown.audits).toBe(1);
    // Сроков в «Условиях работ» не указано: инфляция не применена, итог — смета × 1,02 × 1,22.
    expect(shown.total).toBeCloseTo(1_623_390 * 1.02 * 1.22, 0);
  });

  it("ССР заказчика в документах есть — под аудитом ЛСР показан аудит ССР", async () => {
    const tender = tenderWith(SSR_BAD, 1_813_280.4);
    render(<DeepAnalysisPanel tenderId={tender.regNumber} dataSource="EIS" subject="Тест" tender={tender} />);
    await openEstimateTab();
    expect(await screen.findByTestId("ssr-audit")).toBeInTheDocument();
    expect(screen.getByTestId("ssr-audit-conclusion").textContent).toContain("Замечаний:");
  });

  it("ССР в документах нет — аудит ССР не показывается, а наш сводный расчёт остаётся", async () => {
    const tender = tenderWith("Цена контракта фиксированная.");
    render(<DeepAnalysisPanel tenderId={tender.regNumber} dataSource="EIS" subject="Тест" tender={tender} />);
    await openEstimateTab();
    const shown = JSON.parse((await screen.findByTestId("ssr")).textContent ?? "null") as { audits: number };
    expect(shown.audits).toBe(0);
    expect(screen.queryByTestId("ssr-audit")).toBeNull();
  });
});
