import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EstimateUploadView } from "@/components/estimate/EstimateUploadView";

/*
  Экран «Смета» без закупки. Замечание 09.10.2026: вместо выбора региона экран
  печатал полэкрана текста «Регион закупки не определён… Собраны: …». Теперь —
  регион и зона списками, и зона, цены которой не собраны, не подставляется молча.
*/

const ZONES = {
  zones: [
    { priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)", subject: "Республика Бурятия", period: "3 квартал 2026 г." },
    { priceZoneId: 282, zoneName: "Амурская область (1 зона)", subject: "Амурская область", period: "3 квартал 2026 г." },
  ],
  allZones: [
    { name: "Республика Бурятия (1 зона)", subjectCode: "3", subjectName: "Республика Бурятия", center: "с. Орлик", municipalities: "" },
    { name: "Республика Бурятия (5 зона)", subjectCode: "3", subjectName: "Республика Бурятия", center: "г. Улан-Удэ", municipalities: "" },
    { name: "Амурская область (1 зона)", subjectCode: "28", subjectName: "Амурская область", center: "г. Благовещенск", municipalities: "" },
  ],
  directory: [
    { priceZoneId: 232, zoneName: "Республика Бурятия (1 зона)" },
    { priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)" },
    { priceZoneId: 282, zoneName: "Амурская область (1 зона)" },
  ],
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("/api/estimate/zones")
        ? new Response(JSON.stringify(ZONES), { status: 200 })
        : new Response(JSON.stringify({ job: null }), { status: 200 }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EstimateUploadView — регион расчёта", () => {
  it("вместо перечня собранных зон — выбор региона", async () => {
    render(<EstimateUploadView />);

    const region = (await screen.findByLabelText("Регион объекта")) as HTMLSelectElement;
    expect([...region.options].map((option) => option.text)).toEqual([
      "Выберите регион",
      "Амурская область",
      "Республика Бурятия",
    ]);
    expect(screen.queryByText(/Собраны:/)).toBeNull();
    expect(screen.queryByText(/Регион закупки не определён/)).toBeNull();
  });

  it("в субъекте с одной зоной она подставляется сама", async () => {
    render(<EstimateUploadView />);
    fireEvent.change(await screen.findByLabelText("Регион объекта"), { target: { value: "Амурская область" } });

    expect(screen.queryByLabelText("Ценовая зона")).toBeNull();
    expect(screen.getByTestId("estimate-region-line").textContent).toBe(
      "Цены ФГИС ЦС: Амурская область (1 зона), 3 квартал 2026 г.",
    );
  });

  it("зон несколько — выбрать надо самому, и не собранная зона тоже в списке", async () => {
    render(<EstimateUploadView />);
    fireEvent.change(await screen.findByLabelText("Регион объекта"), { target: { value: "Республика Бурятия" } });

    const zone = screen.getByLabelText("Ценовая зона") as HTMLSelectElement;
    expect(zone.value).toBe("");
    expect([...zone.options].map((option) => option.text)).toEqual([
      "Выберите зону",
      "1 зона — с. Орлик",
      "5 зона — г. Улан-Удэ",
    ]);

    fireEvent.change(zone, { target: { value: "232" } });
    await waitFor(() =>
      expect(screen.getByTestId("estimate-region-line").textContent).toContain("подготовим их перед расчётом"),
    );
  });

  it("метод и условия работ свёрнуты, пока их не открыли", async () => {
    render(<EstimateUploadView />);

    expect(screen.queryByTestId("work-conditions-block")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Настроить/ }));
    expect(screen.getByTestId("work-conditions-block")).toBeTruthy();
    expect(screen.getByTestId("estimate-method")).toBeTruthy();
  });
});

describe("EstimateUploadView — форматы файлов", () => {
  it("выбор файла предлагает всё, что читает браузерный разбор, и не предлагает архивы и картинки", async () => {
    render(<EstimateUploadView />);

    const input = (await screen.findByTestId("estimate-files")) as HTMLInputElement;
    const accepted = input.accept.split(",");
    for (const extension of [".pdf", ".docx", ".xlsx", ".xls", ".xlsm", ".ods", ".odt", ".rtf", ".csv", ".txt"]) {
      expect(accepted).toContain(extension);
    }
    // Эти форматы читает только серверный разбор: в браузере они вернули бы «Неподдерживаемый формат».
    for (const extension of [".zip", ".rar", ".7z", ".png", ".jpg", ".tif", ".gsfx"]) {
      expect(accepted).not.toContain(extension);
    }
  });

  it("подсказка называет форматы и честно говорит, что архивы и родные файлы смет не читаются", async () => {
    render(<EstimateUploadView />);

    expect(await screen.findByText(/OpenDocument \(odt, ods\), RTF/)).toBeTruthy();
    expect(screen.getByText(/Архивы \(zip, rar, 7z\) и сканы-картинки здесь не читаются/)).toBeTruthy();
    expect(screen.getByText(/\.gsfx, \.xml/)).toBeTruthy();
  });
});
