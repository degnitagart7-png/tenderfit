import { openEstimateTab } from "@/test/panelTabs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { demoTenders } from "@/mocks/tenders";
import type { Tender } from "@/domain/entities";

/*
  Ценовая зона у кнопки «Рассчитать смету»: строка «Цены: …» с основанием, select
  другой зоны и предупреждение о зоне не из региона закупки. Предвыбор делает та же
  функция, что и воркер, поэтому строка показывает то, что получится, если ничего
  не трогать.
*/

const start = vi.fn();

vi.mock("@/hooks/useEstimateJob", () => ({
  useEstimateJob: () => ({ status: "idle", result: null, error: null, reused: false, start }),
  useEstimateAuditJob: () => ({ status: "idle", result: null, error: null, reused: false, start: vi.fn() }),
}));

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: { getStatus: vi.fn(), trigger: vi.fn(), getKonturCard: vi.fn(), buyKonturCard: vi.fn() },
}));

const burZone = (n: number, center: string, municipalities: string) => ({
  name: `Республика Бурятия (${String(n)} зона)`,
  subjectCode: "3",
  subjectName: "Республика Бурятия",
  center,
  municipalities,
});

const ZONES_RESPONSE = {
  zones: [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      priceZoneId: 231 + n,
      zoneName: `Республика Бурятия (${String(n)} зона)`,
      subject: "Республика Бурятия",
      period: "3 квартал 2026 г.",
    })),
    { priceZoneId: 282, zoneName: "Амурская область (1 зона)", subject: "Амурская область", period: "3 квартал 2026 г." },
  ],
  allZones: [
    burZone(5, "г. Улан-Удэ", "р-н. Кабанский, г. Улан-Удэ"),
    burZone(8, "пгт. Новый Уоян", "р-н. Муйский, г. Северобайкальск"),
    burZone(1, "с. Орлик", "р-н. Окинский"),
    { name: "Республика Калмыкия", subjectCode: "8", subjectName: "Республика Калмыкия", center: "г. Элиста", municipalities: "" },
    { name: "Амурская область (1 зона)", subjectCode: "28", subjectName: "Амурская область", center: "г. Благовещенск", municipalities: "р-н. Архаринский" },
  ],
};

function tenderIn(region: string, address: string): Tender {
  return { ...demoTenders[0]!, region, deliveryAddress: address, customerName: "Администрация" };
}

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
        return { ok: true, status: 200, json: async () => ZONES_RESPONSE } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ job: null }) } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(tender: Tender) {
  render(<DeepAnalysisPanel tenderId={tender.id} dataSource="EIS" subject="Тест" tender={tender} />);
  await openEstimateTab();
  return screen.findByTestId("price-zone-line");
}

describe("DeepAnalysisPanel: ценовая зона расчёта", () => {
  it("предвыбор по муниципалитету: «Кабанского района» → 5 зона, основание названо", async () => {
    const line = await open(tenderIn("Республика Бурятия", "Кабанского района, с. Кабанск"));

    expect(line.textContent).toBe("Цены: Республика Бурятия (5 зона), 3 квартал 2026 г. — по муниципалитету: Кабанский р-н");
  });

  it("адрес не указан — по столице субъекта", async () => {
    const line = await open(tenderIn("Республика Бурятия", "Не указан"));

    expect(line.textContent).toBe("Цены: Республика Бурятия (5 зона), 3 квартал 2026 г. — по столице субъекта");
  });

  it("если ничего не трогать, на сервер зона не уходит: её определит воркер тем же правилом", async () => {
    await open(tenderIn("Республика Бурятия", "Не указан"));
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать смету" }));

    expect(start).toHaveBeenCalledWith({ tenderId: demoTenders[0]!.id, subject: "Тест" });
  });

  it("select: сначала зоны региона закупки, потом остальные", async () => {
    await open(tenderIn("Республика Бурятия", "Не указан"));
    const select = screen.getByLabelText("Другая ценовая зона");
    const groups = [...select.querySelectorAll("optgroup")];

    expect(groups.map((group) => group.label)).toEqual(["Зоны региона закупки", "Остальные зоны"]);
    expect([...groups[0]!.querySelectorAll("option")]).toHaveLength(8);
    expect([...groups[1]!.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Амурская область (1 зона)"]);
  });

  it("зона другого субъекта: «выбрана вручную» и предупреждение; на сервер уходит её идентификатор", async () => {
    await open(tenderIn("Республика Бурятия", "Не указан"));
    expect(screen.queryByTestId("price-zone-warning")).toBeNull();

    fireEvent.change(screen.getByLabelText("Другая ценовая зона"), { target: { value: "282" } });

    await waitFor(() => expect(screen.getByTestId("price-zone-warning")).toBeTruthy());
    expect(screen.getByTestId("price-zone-warning").textContent).toContain("Зона не из региона закупки");
    expect(screen.getByTestId("price-zone-line").textContent).toBe("Цены: Амурская область (1 зона), 3 квартал 2026 г. — выбрана вручную");

    fireEvent.click(screen.getByRole("button", { name: "Рассчитать смету" }));
    expect(start).toHaveBeenCalledWith({ tenderId: demoTenders[0]!.id, subject: "Тест", priceZoneId: 282 });
  });

  it("другая зона того же субъекта — без предупреждения", async () => {
    await open(tenderIn("Республика Бурятия", "Не указан"));
    fireEvent.change(screen.getByLabelText("Другая ценовая зона"), { target: { value: "239" } });

    await waitFor(() => expect(screen.getByTestId("price-zone-line").textContent).toContain("Республика Бурятия (8 зона)"));
    expect(screen.queryByTestId("price-zone-warning")).toBeNull();
  });

  it("можно вернуться к зоне закупки", async () => {
    await open(tenderIn("Республика Бурятия", "Кабанский район"));
    const select = screen.getByLabelText("Другая ценовая зона") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "282" } });
    await waitFor(() => expect(select.value).toBe("282"));

    fireEvent.change(select, { target: { value: "" } });

    await waitFor(() => expect(screen.getByTestId("price-zone-line").textContent).toContain("по муниципалитету: Кабанский р-н"));
  });

  it("зона закупки не собрана — сообщение воркера, а кнопка остаётся доступной", async () => {
    const line = await open(tenderIn("Республика Калмыкия", "Не указан"));

    expect(line.textContent).toBe(
      "Цен по зоне «Республика Калмыкия» ещё нет. Собраны: Республика Бурятия (1–8 зона), Амурская область (1 зона). Можно выбрать зону вручную.",
    );
    expect((screen.getByRole("button", { name: "Рассчитать смету" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("регион закупки неизвестен — сообщение и выбор вручную", async () => {
    const line = await open(tenderIn("Не указан", "Не указан"));

    expect(line.textContent).toContain("Регион закупки не определён");
    expect(screen.getByLabelText("Другая ценовая зона")).toBeTruthy();
  });

  it("зон не собрано или справочник не отдался — блока нет, расчёт как раньше", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ zones: [], allZones: [] }) }) as Response));
    render(<DeepAnalysisPanel tenderId="t" dataSource="EIS" subject="Тест" tender={tenderIn("Республика Бурятия", "x")} />);
    await openEstimateTab();

    await screen.findByRole("button", { name: "Рассчитать смету" });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("price-zone")).toBeNull();
  });
});
