import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import { FIT_VERSION, type CompanyFitResult } from "@/domain/companyFacts/fit";
import { emptyFacts, type CompanyFacts } from "@/domain/companyFacts/types";
import type { CompanyProfile, Tender } from "@/domain/entities";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import { demoTenders } from "@/mocks/tenders";
import { CompanyApiError, companyApiService } from "@/services/companyApiService";
import { deepAnalysisService } from "@/services/deepAnalysisService";

/*
  «Соответствие вашей компании» в панели глубокого анализа: автозапуск, когда есть факты, приглашение загрузить документы,
  кнопки «Проверить» и «Проверить заново», ошибка и передача результата в выгрузку Word.
*/

vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
  useEstimateAuditJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
}));
vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: { getStatus: vi.fn(), trigger: vi.fn(), getKonturCard: vi.fn(), buyKonturCard: vi.fn() },
}));
vi.mock("@/services/companyApiService", async () => {
  const actual = await vi.importActual<typeof import("@/services/companyApiService")>("@/services/companyApiService");
  return { ...actual, companyApiService: { extractFacts: vi.fn(), fit: vi.fn() } };
});
const exportMock = vi.hoisted(() => vi.fn(async (_input: unknown) => new Uint8Array([1, 2, 3])));
vi.mock("@/services/deepAnalysisExport", () => ({
  buildDeepAnalysisDocx: exportMock,
  deepAnalysisFileName: () => "report.docx",
}));

const NOW = new Date("2026-10-21T12:00:00Z");

const FACTS: CompanyFacts = {
  ...emptyFacts(NOW),
  contracts: [{ id: "c1", subject: "Капитальный ремонт кровли школы", workType: null, customerType: "municipal", customer: null, year: 2025, sumRub: 8_000_000, law: "44-FZ", region: null }],
};
const PROFILE_WITH_FACTS: CompanyProfile = { ...emptyCompanyProfile, inn: "5503123456", legalName: "ООО «СтройОмск»", companyFacts: FACTS };
const PROFILE_NO_FACTS: CompanyProfile = { ...emptyCompanyProfile, inn: "5503123456", legalName: "ООО «СтройОмск»" };

const FIT: CompanyFitResult = {
  version: FIT_VERSION,
  tenderId: "t-1",
  computedAt: NOW.toISOString(),
  overall: "partial",
  headline: "Подходит по 1, уточнить: 1 из 2 требований",
  summary: "Участвовать можно, уточните технику.",
  requirements: [
    { id: "r1", kind: "EXPERIENCE", title: "Опыт выполнения работ", required: "не менее 20% НМЦК", verdict: "ok", basis: "Выполнено за 3 года на 12 млн ₽.", source: "rule+model", contractIds: ["c1"], quote: null },
    { id: "r2", kind: "EQUIPMENT", title: "Наличие автовышки", required: "не менее 22 м", verdict: "check", basis: "Данных о технике нет.", source: "rule", contractIds: [], quote: null },
  ],
  experience: [{ contractId: "c1", subject: "Капитальный ремонт кровли школы", customer: "Администрация города", year: 2025, sumRub: 8_000_000, why: "Тот же вид работ" }],
  gaps: ["Наличие автовышки: Данных о технике нет."],
  risks: ["Короткий срок"],
  basisNote: "Учтено — контрактов из документов: 1.",
  llmUsed: true,
  hasCompanyData: true,
};

function mockStatus() {
  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue({
    jobs: [{ id: "job-1", status: "completed", documents_processed: 1 } as never],
    verdictHistory: [],
    documents: [
      {
        id: "doc-0",
        filename: "ТЗ.docx",
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
        raw_json: { title: "ТЗ.docx", chars: 100 },
      } as never,
    ],
    documentAnalyses: [
      {
        id: "an-1",
        model_used: "m",
        analysis: { kind: "consolidated", summary: "Итог", findings: [], conflicts: [], questions: [], facts: {} },
        tokens_used: 1,
        processing_time_ms: 1,
        created_at: "2026-10-14T11:00:00Z",
      } as never,
    ],
  });
}

const tender: Tender = { ...demoTenders[0]!, law: "FZ_44", documents: [] };

const renderPanel = (profile: CompanyProfile | undefined) =>
  render(<DeepAnalysisPanel tenderId="t-1" dataSource="EIS" subject="Ремонт кровли" tender={tender} profile={profile} />);

beforeEach(() => {
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue({ show: false, allowed: false } as never);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ job: null, zones: [], allZones: [] }) }) as Response));
  mockStatus();
  vi.mocked(companyApiService.fit).mockResolvedValue({ result: FIT, cached: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DeepAnalysisPanel: соответствие вашей компании", () => {
  it("есть факты — сверка запускается сама, один раз, и показывает итог и требования светофором", async () => {
    renderPanel(PROFILE_WITH_FACTS);

    const overall = await screen.findByTestId("company-fit-overall");
    expect(overall).toHaveAttribute("data-overall", "partial");
    // Итог одной строкой, без повтора «Подходит с оговорками — Подходит, …».
    expect(overall.textContent).toBe("Подходит с оговорками · 1 пункт уточнить");
    expect(companyApiService.fit).toHaveBeenCalledTimes(1);
    expect(companyApiService.fit).toHaveBeenCalledWith("t-1", false);

    // Наверху только то, что требует внимания; «подходит» свёрнуто в одну строку.
    const attention = screen.getByTestId("company-fit-requirements");
    const rows = within(attention).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-verdict", "check");
    expect(rows[0]).toHaveTextContent("Наличие автовышки — Данных о технике нет");
    const ok = screen.getByTestId("company-fit-ok");
    expect(ok).toHaveTextContent("Подходит · 1");
    expect(ok).not.toHaveAttribute("open");
    expect(within(ok).getByTestId("company-fit-ok-items")).toHaveTextContent("Опыт выполнения работ");
    // Подробности пункта — внутри раскрытия.
    expect(rows[0]).toHaveTextContent("Требуется: не менее 22 м");
    expect(screen.getByTestId("company-fit-summary")).toHaveTextContent("Участвовать можно, уточните технику");
    expect(screen.getByTestId("company-fit-experience")).toHaveTextContent("Капитальный ремонт кровли школы");
    // Пересказ пункта «нужно уточнить» в «чего не хватает» не повторяется: остаётся один риск.
    expect(within(screen.getByTestId("company-fit-risks")).getAllByRole("listitem")).toHaveLength(1);
  });

  it("нет фактов — автозапуска нет, есть приглашение загрузить документы со ссылкой в настройки", async () => {
    renderPanel(PROFILE_NO_FACTS);
    const hint = await screen.findByTestId("company-fit-hint");
    expect(hint).toHaveTextContent("Загрузите документы компании — анализ учтёт ваш опыт");
    expect(within(hint).getByRole("link", { name: "Загрузить документы" })).toHaveAttribute("href", "/settings/profile");
    expect(companyApiService.fit).not.toHaveBeenCalled();
  });

  it("нет фактов, но человек нажал «Проверить соответствие» — запрос уходит (анкета могла быть заполнена)", async () => {
    renderPanel(undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить соответствие" }));
    await waitFor(() => expect(companyApiService.fit).toHaveBeenCalledWith("t-1", false));
    expect(await screen.findByTestId("company-fit-overall")).toBeInTheDocument();
  });

  it("сервер ответил «данных о компании нет» — приглашение, а не вердикт", async () => {
    vi.mocked(companyApiService.fit).mockResolvedValue({
      result: { ...FIT, hasCompanyData: false, overall: "unknown", requirements: [], experience: [], gaps: [], risks: [], headline: "Загрузите документы компании — анализ учтёт ваш опыт" },
      cached: false,
    });
    renderPanel(undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить соответствие" }));
    expect(await screen.findByTestId("company-fit-hint")).toBeInTheDocument();
    expect(screen.queryByTestId("company-fit-overall")).toBeNull();
  });

  it("«Проверить заново» пересчитывает в обход кэша", async () => {
    renderPanel(PROFILE_WITH_FACTS);
    await screen.findByTestId("company-fit-overall");
    fireEvent.click(screen.getByRole("button", { name: "Проверить заново" }));
    await waitFor(() => expect(companyApiService.fit).toHaveBeenCalledWith("t-1", true));
  });

  it("сбой сверки показан в блоке и не ломает остальной анализ", async () => {
    vi.mocked(companyApiService.fit).mockRejectedValue(new CompanyApiError("Достигнут суточный предел сверок", 429));
    renderPanel(PROFILE_WITH_FACTS);
    const section = await screen.findByTestId("company-fit");
    expect(await within(section).findByRole("alert")).toHaveTextContent("суточный предел");
    expect(screen.getByTestId("decision")).toBeInTheDocument();
  });

  it("неполный результат (модель не ответила) подписан", async () => {
    vi.mocked(companyApiService.fit).mockResolvedValue({ result: { ...FIT, llmUsed: false }, cached: false, degraded: true });
    renderPanel(PROFILE_WITH_FACTS);
    expect(await screen.findByText(/ИИ сейчас не ответил/u)).toBeInTheDocument();
  });

  it("результат попадает в выгрузку Word", async () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    // jsdom не умеет переходить по ссылке скачивания: нажатие подменено.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderPanel(PROFILE_WITH_FACTS);
    await screen.findByTestId("company-fit-overall");
    fireEvent.click(screen.getByRole("button", { name: "Скачать в Word" }));
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    const input = exportMock.mock.calls[0]?.[0] as { companyFit: CompanyFitResult };
    expect(input.companyFit.overall).toBe("partial");
    expect(input.companyFit.requirements).toHaveLength(2);
  });
});
