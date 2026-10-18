import { openEstimateTab } from "@/test/panelTabs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { demoTenders } from "@/mocks/tenders";
import type { Tender } from "@/domain/entities";

/*
  Панель связывает закупку со сметой: закон и статус НДС из документации должны
  дойти до блока «Цена участия». Сам блок здесь подменён заглушкой, которая печатает
  то, что получила, — его собственная логика проверена в BidEconomicsCard.test.tsx.
*/
vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({
    status: "done",
    result: { document: {}, rejected: [], documentsWithoutBill: [], billItems: 10 },
    error: null,
    reused: false,
    start: vi.fn(),
  }),
  useEstimateAuditJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
}));

vi.mock("@/components/estimate/EstimateResult", () => ({
  EstimateResult: ({ bid, customerEstimates }: { bid: unknown; customerEstimates?: unknown }) => (
    <>
      <pre data-testid="bid">{JSON.stringify(bid)}</pre>
      <pre data-testid="customer">{JSON.stringify(customerEstimates ?? null)}</pre>
    </>
  ),
}));

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: {
    getStatus: vi.fn(),
    trigger: vi.fn(),
    getKonturCard: vi.fn(),
    buyKonturCard: vi.fn(),
  },
}));

function tenderWith(law: Tender["law"], text: string): Tender {
  return {
    ...demoTenders[0]!,
    law,
    financial: { ...demoTenders[0]!.financial, price: 5_400_000 },
    documents: [
      {
        id: "d1",
        type: "NOTICE",
        title: "Извещение о закупке",
        fileName: "Извещение.docx",
        url: "",
        text,
        pageCount: null,
        lastModified: null,
      } as Tender["documents"][number],
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue({
    jobs: [{ id: "job-1", status: "completed" } as never],
    verdictHistory: [],
    documents: [],
    documentAnalyses: [],
  });
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue({ show: false, allowed: false } as never);
});

async function renderedBid(tender: Tender) {
  render(<DeepAnalysisPanel tenderId={tender.regNumber} dataSource="EIS" subject="Тест" tender={tender} />);
  await openEstimateTab();
  const node = await screen.findByTestId("bid");
  return JSON.parse(node.textContent ?? "{}") as {
    law: string;
    nmc: number;
    vat: { includesVat: boolean; basis: string; quote: string | null; documentName: string | null };
  };
}

describe("DeepAnalysisPanel: закон и НДС идут в блок цены", () => {
  it("44-ФЗ и «без НДС» в документации: закон передан, НДС — факт из файла", async () => {
    const bid = await renderedBid(tenderWith("FZ_44", "Начальная цена контракта 4 500 000 руб. без НДС."));

    expect(bid.law).toBe("FZ_44");
    expect(bid.nmc).toBe(5_400_000);
    expect(bid.vat.includesVat).toBe(false);
    expect(bid.vat.basis).toBe("DOCUMENT");
    expect(bid.vat.documentName).toBe("Извещение.docx");
    expect(bid.vat.quote).toContain("без НДС");
  });

  it("44-ФЗ без слов про НДС: основание — закон", async () => {
    const bid = await renderedBid(tenderWith("FZ_44", "Цена контракта фиксированная."));
    expect(bid.vat).toMatchObject({ includesVat: true, basis: "LAW_44" });
  });

  it("223-ФЗ без слов про НДС: допущение", async () => {
    const bid = await renderedBid(tenderWith("FZ_223", "Цена договора фиксированная."));
    expect(bid.law).toBe("FZ_223");
    expect(bid.vat).toMatchObject({ includesVat: true, basis: "ASSUMPTION" });
  });
});

describe("DeepAnalysisPanel: смета заказчика из документации идёт в блок сравнения", () => {
  const ESTIMATE_TEXT = [
    "Раздел 1. Монтаж,,,,,,",
    'Итого по разделу 1 Монтаж,,,,,"1,000.00"',
    'Итого по смете,,,,,"1,000.00"',
  ].join("\n");

  async function customerOf(tender: Tender) {
    render(<DeepAnalysisPanel tenderId={tender.regNumber} dataSource="EIS" subject="Тест" tender={tender} />);
    await openEstimateTab();
    const node = await screen.findByTestId("customer");
    return JSON.parse(node.textContent ?? "null") as { documentName: string; sections: { title: string }[] }[] | null;
  }

  it("в документах есть смета — она разобрана и передана", async () => {
    const estimates = await customerOf(tenderWith("FZ_44", ESTIMATE_TEXT));

    expect(estimates).toHaveLength(1);
    expect(estimates![0]).toMatchObject({ documentName: "Извещение.docx" });
    expect(estimates![0]!.sections.map((section) => section.title)).toEqual(["Монтаж"]);
  });

  it("сметы в документах нет — пустой массив, а не отсутствие блока", async () => {
    expect(await customerOf(tenderWith("FZ_44", "Цена контракта фиксированная."))).toEqual([]);
  });
});
