import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import type { EstimateResultData } from "@/components/estimate/EstimateResult";
import { anchorOf } from "@/domain/estimate/billEdits";
import type { BillEditor } from "@/hooks/useBillEdits";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { recalculateEstimate } from "@/services/estimateRecalc";
import { buildEditResult, makeEditBase } from "@/test/billEditFixtures";
import { demoTenders } from "@/mocks/tenders";
import type { Tender } from "@/domain/entities";

/*
  Отчёт Word и цена участия идут по пересчитанному результату, а не по исходному, и отчёт говорит
  о правках. Сама таблица проверена в BillTable.test.tsx; здесь — связь панели с редактором.
*/

const shared = vi.hoisted(() => ({ result: null as unknown, exported: [] as unknown[], editor: null as unknown }));

vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({ status: "done", jobId: "job-1", result: shared.result, error: null, reused: false, start: vi.fn() }),
  useEstimateAuditJob: () => ({ status: "idle", jobId: null, result: null, error: null, reused: false, start: vi.fn() }),
}));

vi.mock("@/components/estimate/EstimateResult", () => ({
  EstimateResult: ({ data, editor }: { data: EstimateResultData; editor: BillEditor | null }) => {
    shared.editor = editor;
    return <p data-testid="shown-total">{String(data.document.totals.workCost)}</p>;
  },
}));

vi.mock("@/services/deepAnalysisExport", () => ({
  deepAnalysisFileName: () => "f.docx",
  buildDeepAnalysisDocx: async (input: unknown) => {
    shared.exported.push(input);
    return new Uint8Array([1]);
  },
}));

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: { getStatus: vi.fn(), trigger: vi.fn(), getKonturCard: vi.fn(), buyKonturCard: vi.fn() },
}));

const tender: Tender = { ...demoTenders[0]!, financial: { ...demoTenders[0]!.financial, price: 3_000_000 } };
let base = makeEditBase();
let built: Awaited<ReturnType<typeof buildEditResult>>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  window.localStorage.clear();
  shared.exported = [];
  base = makeEditBase();
  built = await buildEditResult(base);
  shared.result = {
    document: built.document,
    rejected: [],
    documentsWithoutBill: [],
    billItems: built.billItems,
    bill: built.bill,
  } satisfies EstimateResultData;

  // Скачивание файла в jsdom не нужно: проверяется то, что ушло в сборку отчёта.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/estimate/recalc")) {
        const body = JSON.parse(String(init?.body)) as { edits: never[] };
        return json(await recalculateEstimate({ document: built.document, bill: built.bill }, body.edits, { base }));
      }
      if (url.startsWith("/api/estimate/edits")) return init?.method === "PUT" ? json({ saved: true }) : json({ record: null });
      return json({ error: "нет" }, 500);
    }),
  );

  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue({
    jobs: [{ id: "job-1", status: "completed", documents_processed: 1 } as never],
    verdictHistory: [],
    documents: [
      {
        id: "doc-1",
        filename: "Извещение.html",
        document_type: "attachment",
        source_type: "eis_api",
        file_url: "https://zakupki.gov.ru/f.html",
        parsed_status: "parsed",
        download_status: "downloaded",
        content_hash: "a".repeat(64),
        file_size: 1000,
        error_message: null,
        created_at: "2026-09-21T20:57:43Z",
        updated_at: "2026-09-21T20:57:43Z",
        raw_json: { title: "Извещение", chars: 100 },
      } as never,
    ],
    documentAnalyses: [],
  });
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue({ show: false, allowed: false } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function exportWord(): Promise<Record<string, unknown>> {
  const before = shared.exported.length;
  fireEvent.click(await screen.findByRole("button", { name: "Скачать в Word" }));
  await waitFor(() => expect(shared.exported.length).toBe(before + 1));
  return shared.exported[before] as Record<string, unknown>;
}

describe("DeepAnalysisPanel: правки ведомости доходят до отчёта и цены участия", () => {
  it("без правок отчёт как прежде: строки о правках нет, цена участия по исходному расчёту", async () => {
    render(<DeepAnalysisPanel tenderId={tender.regNumber} dataSource="EIS" subject="Тест" tender={tender} />);
    const input = await exportWord();

    expect(input["billEdits"]).toBeNull();
    const economics = input["bidEconomics"] as { basis: { estimateBeforeVat: number } };
    expect(economics.basis.estimateBeforeVat).toBeCloseTo(built.document.totals.beforeVat, 2);
  });

  it("после пересчёта отчёт получает пересчитанный документ, цену участия по нему и описание правок", async () => {
    render(<DeepAnalysisPanel tenderId={tender.regNumber} dataSource="EIS" subject="Тест" tender={tender} />);
    await screen.findByTestId("shown-total");

    const editor = shared.editor as BillEditor;
    const walls = built.bill.sections.flatMap((section) => section.items).find((item) => item.workName === "Демонтаж наружных стен");
    expect(walls).toBeDefined();
    await waitFor(() => expect(editor.available).toBe(true));
    // Правка и пересчёт идут через редактор, как из таблицы.
    await act(async () => {
      (shared.editor as BillEditor).record({ kind: "price", anchor: anchorOf(walls!), unitPrice: 1000 });
    });

    // Правка есть, пересчёта нет: итог на экране и в отчёте прежние, о правках отчёт не говорит (числа были бы не по ним).
    expect(screen.getByTestId("shown-total")).toHaveTextContent(String(built.document.totals.workCost));
    expect((await exportWord())["billEdits"]).toBeNull();

    await act(async () => {
      await (shared.editor as BillEditor).recalc();
    });
    await waitFor(() => expect(screen.getByTestId("shown-total")).not.toHaveTextContent(String(built.document.totals.workCost)));

    const recalculated = await recalculateEstimate(
      { document: built.document, bill: built.bill },
      [{ kind: "price", anchor: anchorOf(walls!), unitPrice: 1000 }],
      { base },
    );
    const input = await exportWord();
    const economics = input["bidEconomics"] as { basis: { estimateBeforeVat: number } };
    const edits = input["billEdits"] as { count: number; marks: { title: string; notes: string[] }[] };

    expect(economics.basis.estimateBeforeVat).toBeCloseTo(recalculated.document.totals.beforeVat, 2);
    expect(economics.basis.estimateBeforeVat).not.toBeCloseTo(built.document.totals.beforeVat, 2);
    expect(edits.count).toBe(1);
    expect(edits.marks[0]?.title).toBe("Демонтаж наружных стен");
    expect(edits.marks[0]?.notes[0]).toMatch(/своя цена/u);
    expect((input["estimateSource"] as { priceZone: string }).priceZone).toBe(built.document.priceZone);
  });
});
