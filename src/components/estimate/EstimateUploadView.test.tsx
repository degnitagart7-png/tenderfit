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
  it("выбор файла предлагает всё, что читает браузер, а также .doc и архивы (их читает сервер), но не картинки", async () => {
    render(<EstimateUploadView />);

    const input = (await screen.findByTestId("estimate-files")) as HTMLInputElement;
    const accepted = input.accept.split(",");
    for (const extension of [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".xlsm", ".ods", ".odt", ".rtf", ".csv", ".txt", ".zip", ".rar", ".7z"]) {
      expect(accepted).toContain(extension);
    }
    // Распознавание сканов на этом экране выключено: картинка вернулась бы «не читается».
    for (const extension of [".png", ".jpg", ".tif", ".gsfx"]) {
      expect(accepted).not.toContain(extension);
    }
  });

  it("подсказка называет форматы, говорит, что архивы читает сервер, и что сканы и родные файлы смет не читаются", async () => {
    render(<EstimateUploadView />);

    expect(await screen.findByText(/OpenDocument \(odt, ods\), RTF/)).toBeTruthy();
    expect(screen.getByText(/Архивы \(zip, rar, 7z\) и старые \.doc читает сервер, до 50 МБ/)).toBeTruthy();
    expect(screen.getByText(/Сканы внутри архива и сканы-картинки не распознаются/)).toBeTruthy();
    expect(screen.queryByText(/распакуйте архив/)).toBeNull();
    expect(screen.getByText(/\.gsfx, \.xml/)).toBeTruthy();
  });
});

describe("EstimateUploadView — серверный разбор архивов и .doc", () => {
  const SERVER_BODY = {
    status: "parsed",
    text: "=== ведомость.txt ===\nВедомость объёмов работ: земляные работы 120 м3",
    reason: null,
    archive: {
      parsed: 1,
      total: 3,
      skipped: [
        { name: "скан.png", reason: "Формат не читается. Распознавание на этом сервере недоступно." },
        { name: "Раздел/схема.dwg", reason: "формат не читается" },
      ],
    },
    truncated: false,
  };

  /** fetch, который отвечает и на загрузку зон, и на разбор файла; возвращает мок для проверок. */
  function stubServer(answer: () => Response) {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/documents/parse")) return answer();
      if (String(url).includes("/api/estimate/zones")) return new Response(JSON.stringify(ZONES), { status: 200 });
      return new Response(JSON.stringify({ job: null }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const parseCalls = (fetchMock: ReturnType<typeof stubServer>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/documents/parse"));

  async function pick(...files: File[]) {
    const input = (await screen.findByTestId("estimate-files")) as HTMLInputElement;
    fireEvent.change(input, { target: { files } });
  }

  it("архив уходит на сервер: в списке «прочитано 1 из 3 файлов», пропущенные — свёрнутым списком с причинами", async () => {
    const fetchMock = stubServer(() => new Response(JSON.stringify(SERVER_BODY), { status: 200 }));
    render(<EstimateUploadView />);

    await pick(new File(["zip"], "Документация.zip"));

    expect(await screen.findByText("Документация.zip")).toBeTruthy();
    expect(parseCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByTestId("archive-summary").textContent).toBe("Прочитано 1 из 3 файлов");

    const skipped = screen.getByTestId("archive-skipped") as HTMLDetailsElement;
    expect(skipped.open).toBe(false);
    expect(skipped.textContent).toContain("Не прочитано: 2");
    expect(skipped.textContent).toContain("скан.png");
    expect(skipped.textContent).toContain("Раздел/схема.dwg");
    expect(skipped.textContent).toContain("Распознавание на этом сервере недоступно");
    // Прочитанный архив — документ расчёта: кнопка расчёта (после выбора региона) доступна, ошибки нет.
    expect(screen.queryByText(/Не прочитано —/)).toBeNull();
  });

  it("архив, из которого ничего не прочитано, в документы не попадает: причина и список пропущенных в сообщении", async () => {
    stubServer(
      () =>
        new Response(
          JSON.stringify({
            status: "empty",
            text: "",
            reason: "В архиве 2 файла, ни один не удалось прочитать.",
            archive: { parsed: 0, total: 2, skipped: [{ name: "1.png", reason: "скан" }, { name: "2.png", reason: "скан" }] },
            truncated: false,
          }),
          { status: 200 },
        ),
    );
    render(<EstimateUploadView />);

    await pick(new File(["zip"], "Сканы.zip"));

    expect(await screen.findByText(/Не прочитано — Сканы\.zip: \[Ошибка парсинга: В архиве 2 файла, ни один не удалось прочитать\.\]/)).toBeTruthy();
    expect(screen.getByText(/Сканы\.zip: прочитано 0 из 2 файлов/)).toBeTruthy();
    expect(screen.getByTestId("archive-skipped").textContent).toContain("1.png");
    // Файла нет в списке документов: объяснение не стало текстом расчёта.
    expect(screen.queryByLabelText("Убрать Сканы.zip")).toBeNull();
  });

  it("сбой сервера (401/413/500) — файл не добавлен, причина показана", async () => {
    stubServer(() => new Response(JSON.stringify({ error: "Файл больше 50 МБ: разделите архив." }), { status: 413 }));
    render(<EstimateUploadView />);

    await pick(new File(["x"], "Проект.rar"));

    expect(await screen.findByText(/Проект\.rar: \[Ошибка парсинга: Файл больше 50 МБ/)).toBeTruthy();
    expect(screen.queryByLabelText("Убрать Проект.rar")).toBeNull();
  });

  it(".doc читается сервером и добавляется как обычный документ, без отчёта об архиве", async () => {
    const fetchMock = stubServer(
      () =>
        new Response(
          JSON.stringify({ status: "parsed", text: "Техническое задание на выполнение работ по замене запорной арматуры", reason: null, archive: null, truncated: false }),
          { status: 200 },
        ),
    );
    render(<EstimateUploadView />);

    await pick(new File(["doc"], "ТЗ.doc"));

    expect(await screen.findByLabelText("Убрать ТЗ.doc")).toBeTruthy();
    expect(parseCalls(fetchMock)).toHaveLength(1);
    expect(screen.queryByTestId("archive-summary")).toBeNull();
  });

  it("обычный файл читается в браузере и на сервер не уходит", async () => {
    const fetchMock = stubServer(() => new Response("{}", { status: 500 }));
    render(<EstimateUploadView />);

    // В jsdom у File нет text(): браузерный разбор читает именно его.
    const text = "Ведомость объёмов работ: земляные работы 120 м3";
    const txt = new File([text], "ведомость.txt");
    Object.defineProperty(txt, "text", { value: async () => text });
    await pick(txt);

    expect(await screen.findByLabelText("Убрать ведомость.txt")).toBeTruthy();
    expect(parseCalls(fetchMock)).toHaveLength(0);
  });
});
