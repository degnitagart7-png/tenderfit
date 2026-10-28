import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

/** Открыть карточку первой демонстрационной закупки и дождаться её отрисовки. */
async function openCard(): Promise<void> {
  render(<TenderDetailView tenderId={demoTenders[0]!.id} />);
  await screen.findByRole("heading", { level: 1 });
}

const tabButton = (name: string | RegExp) => screen.getByRole("tab", { name });

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", `/tenders/${demoTenders[0]!.id}`);

  const tender = demoTenders[0]!;
  const profile = companyProfileRepository.get();
  const analysis = await mockTenderAnalysisProvider.analyze(tender, profile);
  vi.mocked(tenderApiService.getRowById).mockResolvedValue({
    tender,
    analysis,
    pipelineStatus: "NEW",
  });
});

describe("TenderDetailView — шапка", () => {
  it("название, НМЦК, срок подачи и оценка видны сразу", async () => {
    await openCard();
    const tender = demoTenders[0]!;

    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe(tender.subject);
    expect(h1.getAttribute("title")).toBe(tender.subject);
    expect(screen.getByText("НМЦК")).toBeTruthy();
    expect(screen.getByText("Подача до")).toBeTruthy();
    expect(screen.getByText("Оценка")).toBeTruthy();
    expect(screen.getByTestId("deadline-countdown")).toBeTruthy();
  });

  it("в шапке нет дисклеймера с рамкой и вопроса «Вердикт полезен?»", async () => {
    await openCard();

    expect(screen.queryByText(/не является вероятностью победы/)).toBeNull();
    // «Вердикт полезен?» живёт внизу вкладки «Главное», а не в шапке.
    const feedback = screen.getByText("Вердикт полезен?");
    expect(feedback.closest("#tender-panel-main")).not.toBeNull();
  });

  it("статус закупки меняется списком в шапке", async () => {
    await openCard();

    fireEvent.change(screen.getByLabelText("Статус закупки"), { target: { value: "INTERESTING" } });

    expect((screen.getByLabelText("Статус закупки") as HTMLSelectElement).value).toBe("INTERESTING");
  });

  it("кнопка «Глубокий анализ» открывает вкладку анализа", async () => {
    await openCard();

    // Кнопка в шапке первая; в карточке без находок есть ещё одна такая же.
    fireEvent.click(screen.getAllByRole("button", { name: /Глубокий анализ/ })[0]!);

    expect(tabButton("Анализ документов").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toBe("?tab=analysis");
  });
});

describe("TenderDetailView — вкладки", () => {
  it("четыре вкладки; открыта «Главное», адрес чистый", async () => {
    await openCard();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => (t.textContent ?? "").replace(/\d+$/, "").trim())).toEqual([
      "Главное",
      "Анализ документов",
      "Риски договора",
      "Документы",
    ]);
    expect(tabButton("Главное").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toBe("");
    // Бокового меню и аккордеонов прежней карточки больше нет.
    expect(screen.queryByRole("button", { name: "Развернуть все разделы" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Разделы карточки закупки" })).toBeNull();
  });

  it("переключение пишет ?tab= в адрес без перезагрузки, главная адрес очищает", async () => {
    await openCard();

    fireEvent.click(tabButton(/Риски договора/));
    expect(window.location.search).toBe("?tab=risks");
    expect(tabButton(/Риски договора/).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("tender-panel-risks")!.hasAttribute("hidden")).toBe(false);
    expect(document.getElementById("tender-panel-main")!.hasAttribute("hidden")).toBe(true);

    fireEvent.click(tabButton(/Документы/));
    expect(window.location.search).toBe("?tab=docs");

    fireEvent.click(tabButton("Главное"));
    expect(window.location.search).toBe("");
  });

  it("чужие параметры адреса сохраняются", async () => {
    window.history.replaceState(null, "", `/tenders/${demoTenders[0]!.id}?from=list`);
    await openCard();

    fireEvent.click(tabButton("Анализ документов"));

    expect(window.location.search).toBe("?from=list&tab=analysis");
  });

  it("?tab= в адресе открывает нужную вкладку", async () => {
    window.history.replaceState(null, "", `/tenders/${demoTenders[0]!.id}?tab=risks`);
    await openCard();

    expect(tabButton(/Риски договора/).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("tender-panel-risks")!.hasAttribute("hidden")).toBe(false);
  });

  it("стрелки переключают вкладки с клавиатуры", async () => {
    await openCard();

    fireEvent.keyDown(tabButton("Главное"), { key: "ArrowRight" });

    expect(tabButton("Анализ документов").getAttribute("aria-selected")).toBe("true");
  });

  it("панель глубокого анализа монтируется только после открытия вкладки", async () => {
    await openCard();
    // Статус разбора карточка читает сразу — ради числа на вкладке «Риски договора»,
    // но сама панель (опрос, смета, Контур) до открытия вкладки не монтируется.
    expect(document.getElementById("deep-analysis")).toBeNull();

    fireEvent.click(tabButton("Анализ документов"));

    expect(document.getElementById("deep-analysis")).not.toBeNull();
    expect(document.getElementById("requirements")).not.toBeNull();
  });
});

describe("TenderDetailView — старые якоря открывают вкладку", () => {
  async function openWithHash(hash: string): Promise<void> {
    window.history.replaceState(null, "", `/tenders/${demoTenders[0]!.id}${hash}`);
    await openCard();
  }

  it.each([
    ["#deep-analysis", "Анализ документов"],
    ["#requirements", "Анализ документов"],
    ["#risks", "Риски договора"],
    ["#documents", "Документы"],
    ["#history", "Документы"],
    ["#overview", "Главное"],
  ])("%s → вкладка «%s»", async (hash, label) => {
    await openWithHash(hash);

    expect(tabButton(new RegExp(label)).getAttribute("aria-selected")).toBe("true");
  });

  it("#economics раскрывает «Все условия и сроки» на «Главном»", async () => {
    await openWithHash("#economics");

    expect(tabButton("Главное").getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Все условия и сроки" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("#evidence раскрывает «Подробнее об оценке» со всеми доказательствами", async () => {
    await openWithHash("#evidence");

    expect(
      screen.getByRole("button", { name: "Подробнее об оценке" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(document.getElementById("evidence")).not.toBeNull();
  });

  it("?tab= важнее якоря, если они противоречат", async () => {
    window.history.replaceState(null, "", `/tenders/${demoTenders[0]!.id}?tab=docs#risks`);
    await openCard();

    expect(tabButton(/Документы/).getAttribute("aria-selected")).toBe("true");
  });
});

describe("TenderDetailView — тексты без внутренних терминов", () => {
  it("нет «Hard blockers», «Неопределённости» и «Пять показателей»", async () => {
    await openCard();
    fireEvent.click(screen.getByRole("button", { name: "Подробнее об оценке" }));

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Hard blockers/i);
    expect(text).not.toMatch(/Неопределённости/);
    expect(text).not.toMatch(/Пять показателей/);
  });

  it("стоп-факторы и неясности стоят в одной карточке «Почему может не подойти»", async () => {
    const tender = demoTenders[0]!;
    const analysis = await mockTenderAnalysisProvider.analyze(tender, companyProfileRepository.get());
    vi.mocked(tenderApiService.getRowById).mockResolvedValue({
      tender,
      analysis: {
        ...analysis,
        hardBlockers: [
          { id: "hb-1", reason: "Нет допуска СРО", detail: "Нужен допуск", critical: true, evidenceId: null },
        ],
        uncertainties: [
          { id: "un-1", question: "Какой срок гарантии?", detail: "В документации не указан", material: true, evidenceId: null },
        ],
      } as never,
      pipelineStatus: "NEW",
    });
    await openCard();

    const card = screen.getByRole("heading", { name: "Почему может не подойти" }).closest("section")!;
    expect(card.textContent).toContain("Что мешает участвовать");
    expect(card.textContent).toContain("Нет допуска СРО");
    expect(card.textContent).toContain("Что неясно");
    expect(card.textContent).toContain("Какой срок гарантии?");
  });

  /** Закупка, по извещению которой нечего сказать ни за, ни против. */
  async function mockEmptyFindings(): Promise<void> {
    // Демо-закупка — источник MOCK, у него глубокий анализ недоступен; берём ЕИС.
    const tender = { ...demoTenders[0]!, dataSource: "EIS" as const };
    const analysis = await mockTenderAnalysisProvider.analyze(tender, companyProfileRepository.get());
    vi.mocked(tenderApiService.getRowById).mockResolvedValue({
      tender,
      analysis: { ...analysis, positiveFactors: [], hardBlockers: [], uncertainties: [], negativeFactors: [] } as never,
      pipelineStatus: "NEW",
    });
  }

  it("до глубокого анализа две пустые карточки заменены одной «Можно ли участвовать» с кнопкой", async () => {
    await mockEmptyFindings();
    await openCard();

    expect(screen.queryByText("Выраженных плюсов не найдено.")).toBeNull();
    expect(screen.queryByText("Существенных ограничений не найдено.")).toBeNull();
    const card = screen.getByRole("heading", { name: "Можно ли участвовать" }).closest("section")!;
    expect(card.textContent).toContain("В карточке на площадке нет условий, по которым можно решить.");

    // Кнопка в карточке — тот же запуск, что и в шапке: открывает вкладку анализа.
    fireEvent.click(within(card).getByRole("button", { name: /Глубокий анализ/ }));
    expect(tabButton("Анализ документов").getAttribute("aria-selected")).toBe("true");
  });

  it("после глубокого анализа остаются две карточки, даже если обе пусты", async () => {
    // clearAllMocks реализацию не сбрасывает, а соседним тестам нужен «разбор не запускался».
    vi.mocked(deepAnalysisService.getStatus).mockResolvedValueOnce({
      jobs: [{ id: "j1", status: "completed", updated_at: "2026-10-01T00:00:00Z" }],
      verdictHistory: [],
      documents: [],
      documentAnalyses: [],
    } as never);
    await mockEmptyFindings();
    await openCard();

    expect(await screen.findByText("Выраженных плюсов не найдено.")).toBeTruthy();
    expect(screen.getByText("Существенных ограничений не найдено.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Можно ли участвовать" })).toBeNull();
  });

  it("«Деньги и сроки» на «Главном» называют обеспечение, аванс, оплату и срок исполнения", async () => {
    await openCard();

    const card = screen.getByRole("heading", { name: "Деньги и сроки" }).closest("section")!;
    for (const label of ["Обеспечение заявки", "Обеспечение контракта", "Аванс", "Срок оплаты", "Срок исполнения"]) {
      expect(card.textContent).toContain(label);
    }
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

    fireEvent.change(screen.getByLabelText("Статус закупки"), {
      target: { value: "INTERESTING" },
    });

    expect(deepAnalysisService.trigger).not.toHaveBeenCalled();
  });
});
