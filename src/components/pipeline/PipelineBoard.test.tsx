import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PipelineBoard } from "@/components/pipeline/PipelineBoard";
import { demoTenders } from "@/mocks/tenders";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { mockTenderAnalysisProvider } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { useTenderData } from "@/hooks/useTenderData";
import type { TenderRow } from "@/domain/filtering";

vi.mock("@/hooks/useTenderData", () => ({
  useTenderData: vi.fn(),
}));

/** jsdom не реализует DataTransfer: достаточно пары setData/getData. */
function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
  } as unknown as DataTransfer;
}

/** Колонка доски: обработчик drop висит на родителе шапки с названием. */
function boardColumn(label: string): HTMLElement {
  const heading = screen.getByText(label, { selector: "span" });
  const column = heading.parentElement?.parentElement;
  if (!column) throw new Error(`Не найдена колонка «${label}»`);
  return column;
}

/** Перетащить карточку закупки в колонку. */
function dragCardTo(subject: string, columnLabel: string): void {
  const card = screen.getByText(subject).parentElement;
  if (!card) throw new Error("Не найдена карточка закупки");
  const dataTransfer = makeDataTransfer();
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.drop(boardColumn(columnLabel), { dataTransfer });
}

describe("PipelineBoard — перенос по доске", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const tender = demoTenders[0]!;
    const profile = companyProfileRepository.get();
    const analysis = await mockTenderAnalysisProvider.analyze(tender, profile);
    const rows: TenderRow[] = [{ tender, analysis, pipelineStatus: "NEW" }];

    vi.mocked(useTenderData).mockReturnValue({
      profile,
      rows,
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    });
  });

  it("карточка остаётся в колонке, куда её перенесли", async () => {
    const tender = demoTenders[0]!;
    render(<PipelineBoard />);
    await screen.findByText(tender.subject);

    dragCardTo(tender.subject, "Интересные");

    expect(boardColumn("Интересные")).toHaveTextContent(tender.subject);
    expect(boardColumn("Новые")).not.toHaveTextContent(tender.subject);
  });

  it("перенос списком на карточке работает без мыши", async () => {
    const tender = demoTenders[0]!;
    render(<PipelineBoard />);
    await screen.findByText(tender.subject);

    const select = screen.getByLabelText(
      `Перенести закупку «${tender.subject}» в другую колонку`,
    );
    fireEvent.change(select, { target: { value: "PREPARING_APPLICATION" } });

    expect(boardColumn("Готовим заявку")).toHaveTextContent(tender.subject);
  });

  it("перенос в «Интересные» ничего не тратит и не переспрашивает", async () => {
    const tender = demoTenders[0]!;
    render(<PipelineBoard />);
    await screen.findByText(tender.subject);

    dragCardTo(tender.subject, "Интересные");

    expect(window.confirm).not.toHaveBeenCalled();
    expect(boardColumn("Интересные")).toHaveTextContent(tender.subject);
  });
});
