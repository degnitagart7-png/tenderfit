import { openEstimateTab } from "@/test/panelTabs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { demoTenders } from "@/mocks/tenders";
import type { Tender } from "@/domain/entities";

/*
  Блок «Условия работ» у кнопки «Рассчитать смету»: по умолчанию в задание ничего не уходит (смета
  как прежде), выбор пользователя уходит одним полем `options`.
*/

const start = vi.fn();

vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({ status: "idle", result: null, error: null, reused: false, start }),
  useEstimateAuditJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
}));

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: { getStatus: vi.fn(), trigger: vi.fn(), getKonturCard: vi.fn(), buyKonturCard: vi.fn() },
}));

const tender: Tender = {
  ...demoTenders[0]!,
  subject: "Капитальный ремонт многоквартирного дома",
  region: "Иркутская область",
  deliveryAddress: "Иркутский район, д. Сосновый бор",
  customerName: "Администрация",
  documents: [
    {
      id: "d1",
      type: "TECHNICAL_SPEC",
      title: "ТЗ",
      fileName: "tz.docx",
      url: "",
      text: "Работы выполняются в жилых помещениях без расселения.",
      pageCount: 1,
      lastModified: null,
    } as never,
  ],
};

beforeEach(() => {
  start.mockReset();
  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue({
    jobs: [{ id: "job-1", status: "completed", documents_processed: 1 } as never],
    verdictHistory: [],
    documents: [
      {
        id: "doc-1",
        filename: "Смета.xlsx",
        document_type: "attachment",
        source_type: "eis_api",
        file_url: "https://zakupki.gov.ru/f.xlsx",
        parsed_status: "parsed",
        download_status: "downloaded",
        content_hash: "a".repeat(64),
        file_size: 1000,
        error_message: null,
        created_at: "2026-09-21T20:57:43Z",
        updated_at: "2026-09-21T20:57:43Z",
        raw_json: { title: "Смета", chars: 100 },
      } as never,
    ],
    documentAnalyses: [
      {
        id: "an-1",
        model_used: "m",
        analysis: { summary: "ok", findings: [] },
        tokens_used: 1,
        processing_time_ms: 1,
        created_at: "2026-09-21T21:00:00Z",
      } as never,
    ],
  });
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue({ show: false, allowed: false } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/estimate/zones")) {
        return { ok: true, status: 200, json: async () => ({ zones: [], allZones: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ job: null }) } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeepAnalysisPanel: условия работ", () => {
  it("блок виден, по умолчанию всё выключено, в задание ничего не уходит", async () => {
    render(<DeepAnalysisPanel tenderId={tender.id} dataSource="EIS" subject="Капитальный ремонт" tender={tender} />);
    await openEstimateTab();
    expect(await screen.findByTestId("work-conditions-block")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать смету" }));
    expect(start).toHaveBeenCalledWith({ tenderId: tender.id, subject: "Капитальный ремонт" });
  });

  it("отмеченное условие и вид работ уходят в задание полем options", async () => {
    render(<DeepAnalysisPanel tenderId={tender.id} dataSource="EIS" subject="Капитальный ремонт" tender={tender} />);
    await openEstimateTab();
    await screen.findByTestId("work-conditions-block");
    fireEvent.change(screen.getByLabelText("Вид работ"), { target: { value: "CAPITAL_REPAIR" } });
    // Подсказка из ТЗ есть, но галочка не стоит, пока человек не нажал.
    expect(screen.getByTestId("hint-T5-8")).toHaveTextContent("без расселения");
    expect(screen.getByLabelText(/без расселения/u)).not.toBeChecked();
    fireEvent.click(screen.getByLabelText(/без расселения/u));
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать смету" }));

    expect(start).toHaveBeenCalledTimes(1);
    const body = start.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(body.options).toMatchObject({ phase: "CAPITAL_REPAIR", conditionIds: ["T5-8"], workKind: null, newConstructionNorms: false });
  });
});
