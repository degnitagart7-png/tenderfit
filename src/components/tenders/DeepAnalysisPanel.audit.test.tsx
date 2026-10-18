import { openEstimateTab } from "@/test/panelTabs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import type { Tender } from "@/domain/entities";
import type { AuditJobData } from "@/hooks/useEstimateJob";
import { demoTenders } from "@/mocks/tenders";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { auditData, reportWithFindings } from "@/test/auditReports";

/*
  Кнопка «Проверить смету заказчика»: появляется, только когда в документации нашлась
  смета с разделами; ставит задание аудита с той же зоной, что и расчёт; результат
  показывает карточка аудита. Сами хуки подменены — их проверяет useEstimateJob.test.ts.
*/

const auditStart = vi.fn();
const estimateStart = vi.fn();
let auditState: { status: string; result: AuditJobData | null; error: string | null } = { status: "idle", result: null, error: null };

vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({ status: "idle", result: null, error: null, reused: false, start: estimateStart }),
  useEstimateAuditJob: () => ({ ...auditState, reused: false, start: auditStart }),
}));

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: { getStatus: vi.fn(), trigger: vi.fn(), getKonturCard: vi.fn(), buyKonturCard: vi.fn() },
}));

const ESTIMATE_TEXT = [
  "Раздел 1. Монтаж,,,,,,",
  'Итого по разделу 1 Монтаж,,,,,"1,000.00"',
  'Итого по смете,,,,,"1,000.00"',
].join("\n");

function tenderWith(text: string): Tender {
  return {
    ...demoTenders[0]!,
    documents: [
      { id: "d1", type: "NOTICE", title: "Смета", fileName: "ЛСР.xlsx", url: "", text, pageCount: null, lastModified: null } as Tender["documents"][number],
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditState = { status: "idle", result: null, error: null };
  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue({
    jobs: [{ id: "job-1", status: "completed" } as never],
    verdictHistory: [],
    documents: [],
    documentAnalyses: [],
  });
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue({ show: false, allowed: false } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ zones: [], allZones: [], job: null }) }) as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(tender: Tender) {
  render(<DeepAnalysisPanel tenderId={tender.id} dataSource="EIS" subject="Тест" tender={tender} />);
  await openEstimateTab();
  // Панель грузит статус асинхронно: ждём ответа и даём состоянию примениться.
  await waitFor(() => expect(deepAnalysisService.getStatus).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
}

describe("DeepAnalysisPanel: аудит сметы заказчика", () => {
  it("смета с разделами найдена — кнопка есть и ставит задание аудита", async () => {
    const tender = tenderWith(ESTIMATE_TEXT);
    await open(tender);

    fireEvent.click(screen.getByRole("button", { name: "Проверить смету заказчика" }));

    expect(auditStart).toHaveBeenCalledWith({ tenderId: tender.id, subject: "Тест" });
    // Расчёт сметы при этом не запускается: это отдельные задания.
    expect(estimateStart).not.toHaveBeenCalled();
  });

  it("сметы в документах нет — кнопки нет", async () => {
    await open(tenderWith("Цена контракта фиксированная."));
    expect(screen.queryByRole("button", { name: "Проверить смету заказчика" })).toBeNull();
  });

  it("идёт проверка — кнопка заблокирована, показан прогресс", async () => {
    auditState = { status: "running", result: null, error: null };
    await open(tenderWith(ESTIMATE_TEXT));

    const button = screen.getByRole("button", { name: "Проверяем смету…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("audit-progress")).toBeTruthy();
  });

  it("результат показывает карточка аудита, ошибка — строка ошибки", async () => {
    auditState = { status: "done", result: auditData([reportWithFindings()]), error: null };
    await open(tenderWith(ESTIMATE_TEXT));
    expect(screen.getByRole("region", { name: "Аудит сметы заказчика" })).toBeTruthy();
    cleanup();

    auditState = { status: "failed", result: null, error: "Ни одна смета не подошла под форму 421/пр" };
    await open(tenderWith(ESTIMATE_TEXT));
    expect(screen.getByTestId("audit-error").textContent).toContain("форму 421/пр");
  });
});
