import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { demoTenders } from "@/mocks/tenders";
import type { Tender } from "@/domain/entities";
import type { AnalysisFinding } from "@/types/database";

/*
  Верх панели читается за десять секунд: решение с итогом по документации, шаги с датами, светофор по
  направлениям (скоркарта), вердикт одной строкой с причиной под раскрытием. Вкладка «Выводы» — навигация
  по секциям, противоречия с короткими именами документов, риски по важности.
*/

vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
  useEstimateAuditJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
}));

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: { getStatus: vi.fn(), trigger: vi.fn(), getKonturCard: vi.fn(), buyKonturCard: vi.fn() },
}));

const DAY = 86_400_000;

function risk(title: string, severity: AnalysisFinding["severity"], patch: Partial<AnalysisFinding> = {}): AnalysisFinding {
  return {
    category: "risk",
    title,
    detail: `Суть: ${title}.`,
    evidence_quote: `Цитата про ${title}`,
    evidence_section: "Проект контракта",
    severity,
    ...patch,
  };
}

const FINDINGS: AnalysisFinding[] = [
  risk("Низкий риск Г", "low"),
  risk("Средний риск В", "medium"),
  risk("Высокий риск А", "high"),
  risk("Высокий риск Б", "high"),
];

const REASON = "Обнаружены риски: Пеня 0,5% в день; Гарантия 5 лет; Штраф за срыв; Пеня 0,5% в день";

function consolidated(extra: Record<string, unknown> = {}) {
  return {
    kind: "consolidated",
    summary: "Участвовать можно: допуск закрыт, но договор жёсткий — проверьте пеню и сроки.",
    findings: FINDINGS,
    conflicts: ["Срок работ", "НМЦК", "Гарантия", "Аванс"].map((topic, i) => ({
      topic,
      values: [
        { value: `Значение ${String(i)}А`, source: "print-form-0848300041226000311.html" },
        {
          value: `Значение ${String(i)}Б`,
          source: "Приложение № 1 к Описанию объекта закупки (Техническому заданию) ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА).xlsx",
        },
      ],
      resolution: i === 0 ? "Уточнить у заказчика: какой срок верный" : "Верным считать срок из контракта",
      needs_question: i === 0,
    })),
    questions: ["Какой срок работ верный?", "Включён ли НДС в цену?"],
    facts: {
      work_start: null,
      work_end: "2026-11-30",
      warranty_months: null,
      bid_security_percent: 1,
      contract_security_percent: 5,
      warranty_security_percent: null,
      advance_percent: 0,
      payment_days: 30,
    },
    ...extra,
  };
}

function mockStatus(analysis: unknown = consolidated()) {
  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue({
    jobs: [{ id: "job-1", status: "completed", documents_processed: 2 } as never],
    verdictHistory: [
      {
        id: "vh-1",
        old_verdict: "RECOMMENDED",
        new_verdict: "MANUAL_REVIEW",
        reason: REASON,
        triggered_by: "document_analysis",
        created_at: "2026-10-14T12:00:00Z",
      } as never,
    ],
    documents: ["Извещение.html", "Договор.docx"].map(
      (filename, i) =>
        ({
          id: `doc-${String(i)}`,
          filename,
          document_type: "attachment",
          source_type: "eis_api",
          file_url: "https://zakupki.gov.ru/f",
          parsed_status: "parsed",
          download_status: "downloaded",
          content_hash: "a".repeat(64),
          file_size: 1000,
          error_message: null,
          created_at: "2026-10-14T10:00:00Z",
          updated_at: "2026-10-14T10:00:00Z",
          raw_json: { title: filename, chars: 100 },
        }) as never,
    ),
    documentAnalyses: [
      {
        id: "an-1",
        model_used: "m",
        analysis,
        tokens_used: 1,
        processing_time_ms: 1,
        created_at: "2026-10-14T11:00:00Z",
      } as never,
    ],
  });
}

function tenderIn(days: number): Tender {
  const base = demoTenders[0]!;
  return {
    ...base,
    law: "FZ_44",
    documents: [],
    deadlines: { ...base.deadlines, submissionEnd: new Date(Date.now() + days * DAY).toISOString() },
  };
}

beforeEach(() => {
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue({ show: false, allowed: false } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ job: null, zones: [], allZones: [] }) }) as Response),
  );
  mockStatus();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderPanel = (tender: Tender = tenderIn(10)) =>
  render(<DeepAnalysisPanel tenderId="t-1" dataSource="EIS" subject="Ремонт" tender={tender} />);

describe("DeepAnalysisPanel: верх за десять секунд", () => {
  it("итог по документации стоит под решением и заменяет причины", async () => {
    renderPanel();

    const decision = await screen.findByTestId("decision");
    expect(within(decision).getByTestId("decision-overview")).toHaveTextContent(/Участвовать можно: допуск закрыт/);
    // Причины «Риск: …» ушли: итог говорит то же связно.
    expect(decision.textContent).not.toContain("Риск: ");
    // На вкладке итог не повторяется оранжевым абзацем.
    expect(screen.queryByText("Итог по всей документации")).toBeNull();
  });

  it("шаги: вопросы заказчику с датой и подача заявки с остатком дней", async () => {
    renderPanel(tenderIn(10));

    const steps = await screen.findByTestId("next-steps");
    expect(steps).toHaveTextContent(/Задать 2 вопроса заказчику до \d{2}\.\d{2}/);
    expect(steps).toHaveTextContent(/Подать заявку до \d{2}\.\d{2} · осталось 10 дн\./);
  });

  it("срок запроса прошёл — шага «задать вопросы» нет, скоркарта о сроках остаётся", async () => {
    renderPanel(tenderIn(2));

    const steps = await screen.findByTestId("next-steps");
    expect(steps.textContent).not.toContain("Задать");
    expect(steps).toHaveTextContent(/Подать заявку до/);
  });

  it("скоркарта: шесть плиток со статусами вместо трёх чисел", async () => {
    renderPanel();

    const board = await screen.findByTestId("scorecard");
    expect(screen.queryByTestId("key-numbers")).toBeNull();
    expect(within(board).getAllByRole("button")).toHaveLength(6);

    const docs = within(board).getByTestId("scorecard-docs");
    expect(docs).toHaveTextContent("4 противоречия");
    expect(docs).toHaveTextContent("прочитано 2 из 2 файлов");
    expect(docs).toHaveAttribute("data-status", "warn");

    const contract = within(board).getByTestId("scorecard-contract");
    expect(contract).toHaveTextContent("4 риска");
    expect(contract).toHaveTextContent("высоких 2");
    expect(contract).toHaveAttribute("data-status", "warn");

    // Аванса нет — деньги жёлтые; сметы заказчика в тесте нет — запас нейтральный.
    expect(within(board).getByTestId("scorecard-money")).toHaveAttribute("data-status", "warn");
    expect(within(board).getByTestId("scorecard-money")).toHaveTextContent(/Заморозится до/);
    expect(within(board).getByTestId("scorecard-money")).toHaveTextContent("аванса нет");
    expect(within(board).getByTestId("scorecard-cushion")).toHaveAttribute("data-status", "neutral");
    expect(within(board).getByTestId("scorecard-time")).toHaveTextContent(/Подача до \d{2}\.\d{2} · 10 дн\./);
  });

  it("клик по плитке открывает «Выводы» и прокручивает к секции", async () => {
    const scrolledTo: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledTo.push(this);
    };
    renderPanel();

    // Откроем другую вкладку: плитка обязана вернуть на «Выводы».
    fireEvent.click(await screen.findByRole("tab", { name: /Документы/ }));
    expect(screen.getByRole("tab", { name: /Документы/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(await screen.findByTestId("scorecard")).getByTestId("scorecard-docs"));

    expect(screen.getByRole("tab", { name: /Выводы/ })).toHaveAttribute("aria-selected", "true");
    expect(scrolledTo).toEqual([document.getElementById("analysis-conflicts")]);
  });

  it("вердикт пересмотрен одной строкой, причина — списком без повторов под раскрытием", async () => {
    renderPanel();

    const note = await screen.findByTestId("verdict-change");
    expect(note).toHaveTextContent(/Вердикт пересмотрен: Подходит → Проверить · 14\.10\.2026/);
    // Больше нет «Вердикт пересмотрен по итогам разбора документации» и стены текста через «;».
    expect(note.textContent).not.toContain(";");
    const why = within(note).getByText(/Почему: Обнаружены риски \(3\)/);
    expect(why.tagName).toBe("SUMMARY");
    expect(within(note).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Пеня 0,5% в день",
      "Гарантия 5 лет",
      "Штраф за срыв",
    ]);
  });
});

describe("DeepAnalysisPanel: вкладка «Выводы»", () => {
  it("навигация по существующим секциям со счётчиками", async () => {
    renderPanel();

    const nav = await screen.findByTestId("section-nav");
    const labels = within(nav).getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Противоречия4", "Вопросы2", "Деньги", "Допуск", "Риски4"]);
  });

  it("противоречия: короткие имена документов, метки решения, первые три и «Показать ещё»", async () => {
    renderPanel();

    const block = await screen.findByTestId("consolidation-block");
    expect(within(block).queryByText("print-form-0848300041226000311.html")).toBeNull();
    const chips = within(block).getAllByText("Извещение");
    expect(chips[0]).toHaveAttribute("title", "print-form-0848300041226000311.html");
    expect(within(block).getAllByText("Смета (прил. к ТЗ)")[0]).toBeTruthy();

    // Префикс «Уточнить у заказчика:» убран — вместо него метка.
    expect(within(block).getByText("Уточнить:")).toBeTruthy();
    expect(within(block).getByText("какой срок верный")).toBeTruthy();
    expect(within(block).queryByText(/Уточнить у заказчика/)).toBeNull();
    expect(within(block).getAllByText("Верно:")).toHaveLength(2);

    // Видно три из четырёх.
    expect(within(block).queryByText("Аванс")).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "Показать ещё 1" }));
    expect(within(block).getByText("Аванс")).toBeTruthy();
    expect(within(block).queryByRole("button", { name: /Показать ещё/ })).toBeNull();
  });

  it("вопросы: рядом со счётчиком — «отправить до»", async () => {
    renderPanel(tenderIn(10));

    const block = await screen.findByTestId("consolidation-block");
    expect(within(block).getByText(/отправить до \d{2}\.\d{2}/)).toBeTruthy();
    expect(within(block).getByText(/не позднее чем за три дня/)).toBeTruthy();
  });

  it("вопросы: срок запроса прошёл — так и сказано", async () => {
    renderPanel(tenderIn(2));

    const block = await screen.findByTestId("consolidation-block");
    expect(within(block).getByText("срок запроса прошёл")).toBeTruthy();
  });

  it("риски: высокие сверху и целиком, средние и низкие — под одной раскрывашкой, цитата — по клику", async () => {
    renderPanel();

    const risks = (await screen.findByText("Высокий риск А")).closest("#analysis-risks") as HTMLElement;
    expect(risks).not.toBeNull();
    const titles = within(risks).getAllByText(/^(Высокий|Средний|Низкий) риск/).map((el) => el.textContent);
    expect(titles).toEqual([
      "Высокий риск А",
      "Высокий риск Б",
      "Средний риск В",
      "Низкий риск Г",
    ]);

    const rest = within(risks).getByTestId("findings-rest");
    expect(rest.tagName).toBe("DETAILS");
    expect(rest).toHaveTextContent("Средние и низкие: 2");
    expect(within(rest).getByText("Средний риск В")).toBeTruthy();
    // Высокий риск вне раскрывашки.
    expect(rest.contains(within(risks).getByText("Высокий риск А"))).toBe(false);

    const quote = within(risks).getAllByText(/Цитата про Высокий риск А/)[0]!;
    expect(quote.closest("details")).not.toBeNull();
    expect(within(risks).getAllByText("Цитата и источник").length).toBe(4);
  });

  it("без высоких рисков средние показаны открыто, а раскрывашкой уходят низкие", async () => {
    mockStatus(consolidated({ findings: [risk("Средний риск А", "medium"), risk("Низкий риск Б", "low")] }));
    renderPanel();

    const medium = await screen.findByText("Средний риск А");
    const rest = screen.getByTestId("findings-rest");
    expect(rest).toHaveTextContent("Низкие: 1");
    expect(rest.contains(medium)).toBe(false);
    expect(rest.contains(screen.getByText("Низкий риск Б"))).toBe(true);
  });
});
