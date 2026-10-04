import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TenderDetailView } from "@/components/tenders/TenderDetailView";
import { demoTenders } from "@/mocks/tenders";
import { tenderApiService } from "@/services/tenderApiService";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { mockTenderAnalysisProvider } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";

vi.mock("@/services/tenderApiService", () => ({
  tenderApiService: { getRowById: vi.fn() },
}));

/** Панель глубокого анализа ходит в API — в тестах карточки она не нужна. */
vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: {
    getStatus: vi.fn().mockResolvedValue({
      jobs: [],
      verdictHistory: [],
      documents: [],
      documentAnalyses: [],
    }),
    trigger: vi.fn(),
  },
}));

/** Разделы, которые есть у любой закупки (операционная оценка — условная). */
const ALWAYS_SECTIONS = [
  "overview",
  "compliance",
  "requirements",
  "evidence",
  "deep-analysis",
  "economics",
  "risks",
  "manual-review",
  "documents",
  "history",
];

/** Открыть карточку первой демонстрационной закупки и дождаться её отрисовки. */
async function openCard(): Promise<void> {
  render(<TenderDetailView tenderId={demoTenders[0]!.id} />);
  await screen.findByRole("heading", { name: "Обзор", level: 2 });
}

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();

  const tender = demoTenders[0]!;
  const profile = companyProfileRepository.get();
  const analysis = await mockTenderAnalysisProvider.analyze(tender, profile);
  vi.mocked(tenderApiService.getRowById).mockResolvedValue({
    tender,
    analysis,
    pipelineStatus: "NEW",
  });
});

describe("TenderDetailView — секции вместо табов", () => {
  it("рендерит все разделы на одной странице, каждый со своим якорем", async () => {
    await openCard();

    for (const id of ALWAYS_SECTIONS) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it("каждый раздел помечен data-section и компенсирует sticky-хедер через scroll-mt", async () => {
    await openCard();

    for (const id of ALWAYS_SECTIONS) {
      const el = document.getElementById(id);
      expect(el?.getAttribute("data-section")).toBe(id);
      expect(el?.className).toContain("scroll-mt-20");
    }
  });

  it("на карточке больше нет табов", async () => {
    await openCard();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("дублирует структуру разделов в якорной навигации", async () => {
    await openCard();

    // Десктопный сайдбар и мобильный бар дают по две кнопки на раздел.
    const buttons = screen.getAllByRole("button", { name: "Риски договора" });
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByRole("navigation", { name: "Разделы карточки закупки" }).length,
    ).toBe(2);
  });
});

/**
 * Стадия воронки и глубокий разбор развязаны: смена статуса — это только статус.
 * Разбор ставится в очередь кнопкой в панели «Глубокий анализ документации»,
 * поэтому здесь проверяется, что смена статуса в API не ходит вовсе.
 */
describe("TenderDetailView — смена стадии воронки разбор не запускает", () => {
  it("перевод в «Интересные» задачу не создаёт", async () => {
    await openCard();

    fireEvent.change(screen.getByLabelText("Статус воронки"), {
      target: { value: "INTERESTING" },
    });

    expect(deepAnalysisService.trigger).not.toHaveBeenCalled();
  });
});
