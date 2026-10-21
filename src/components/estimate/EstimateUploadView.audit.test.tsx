import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EstimateUploadView } from "@/components/estimate/EstimateUploadView";
import { auditData, reportWithFindings } from "@/test/auditReports";

/*
  Экран «Смета»: две вкладки — «Рассчитать смету» и «Проверить смету заказчика». Проверка — отдельное действие со своими
  подсказками, заключением в Word и «Экономикой участия» по смете заказчика; открытая из «Мои расчёты» проверка
  открывается на своей вкладке.
*/

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

const ZONES = {
  zones: [{ priceZoneId: 282, zoneName: "Амурская область (1 зона)", subject: "Амурская область", period: "3 квартал 2026 г." }],
  allZones: [{ name: "Амурская область (1 зона)", subjectCode: "28", subjectName: "Амурская область", center: "г. Благовещенск", municipalities: "" }],
  directory: [{ priceZoneId: 282, zoneName: "Амурская область (1 зона)" }],
};

let jobs: Record<string, unknown> = {};
const posted: unknown[] = [];

beforeEach(() => {
  search = "";
  jobs = {};
  posted.length = 0;
  window.history.replaceState(null, "", "/estimate");
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("/api/estimate/zones")) return json(ZONES);
      if (url.startsWith("/api/estimate/history")) return json({ items: [], nextCursor: null });
      if (url.startsWith("/api/estimate?jobId=")) return json({ job: jobs[decodeURIComponent(url.split("jobId=")[1] ?? "")] ?? null });
      if (url === "/api/estimate" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return json({ job: { id: "job-audit", status: "pending", error: null, mode: "audit", audit: null }, reused: false });
      }
      return json({ job: null });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function auditJob(patch: Record<string, unknown> = {}) {
  const audit = auditData([reportWithFindings()]);
  return {
    id: "job-audit-1",
    status: "completed",
    error: null,
    mode: "audit",
    reason: "upload",
    tenderId: null,
    subject: "Ремонт школы",
    documentNames: ["Смета.xlsx"],
    createdAt: "2026-10-20T09:00:00.000000+00:00",
    estimate: null,
    audit: { reports: audit.reports, zone: audit.zone, period: audit.period, notRecognized: audit.notRecognized },
    ...patch,
  };
}

async function addTextFile(name: string, text: string): Promise<void> {
  const file = new File([text], name);
  Object.defineProperty(file, "text", { value: async () => text });
  fireEvent.change(await screen.findByTestId("estimate-files"), { target: { files: [file] } });
  await screen.findByLabelText(`Убрать ${name}`);
}

describe("EstimateUploadView: вкладки и точки входа", () => {
  it("две вкладки рядом: «Рассчитать смету» выбрана, «Проверить смету заказчика» доступна", async () => {
    render(<EstimateUploadView />);

    const tabs = within(await screen.findByRole("tablist", { name: "Что сделать со сметой" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Рассчитать смету", "Проверить смету заказчика"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: /Рассчитать смету/ })).toBeInTheDocument();
  });

  it("вкладка проверки: своё действие и своё описание, шага «Метод и условия работ» нет", async () => {
    render(<EstimateUploadView />);
    expect(await screen.findByText("Метод и условия работ")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Проверить смету заказчика" }));

    expect(screen.getByRole("tab", { name: "Проверить смету заказчика" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /Проверить смету заказчика/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Рассчитать смету/ })).toBeNull();
    expect(screen.queryByText("Метод и условия работ")).toBeNull();
    expect(screen.getByText(/Проверка локальной сметы \(ЛСР\) заказчика/)).toBeInTheDocument();
    expect(screen.getByText(/Excel, PDF или архив документации с площадки/)).toBeInTheDocument();
  });

  it("загруженный файл остаётся при смене вкладки: один раз загрузили — можно и посчитать, и проверить", async () => {
    render(<EstimateUploadView />);
    await addTextFile("смета.txt", "текст");

    fireEvent.click(screen.getByRole("tab", { name: "Проверить смету заказчика" }));
    expect(screen.getByLabelText("Убрать смета.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Рассчитать смету" }));
    expect(screen.getByLabelText("Убрать смета.txt")).toBeInTheDocument();
  });

  it("в файле нет сметы: на вкладке проверки — что делать (выгрузить из Гранд-Сметы или Smeta.RU в Excel, про сканы)", async () => {
    render(<EstimateUploadView />);
    await addTextFile("письмо.txt", "Добрый день, направляем вам письмо без таблиц.");

    expect(screen.queryByTestId("audit-no-estimate")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Проверить смету заказчика" }));

    const advice = screen.getByTestId("audit-no-estimate");
    expect(advice.textContent).toContain("смета не распознана");
    expect(advice.textContent).toContain("Гранд-Смета");
    expect(advice.textContent).toContain("Smeta.RU");
    expect(advice.textContent).toContain("скан");
  });

  it("проверка ставится заданием режима audit с выбранной зоной", async () => {
    render(<EstimateUploadView />);
    await addTextFile("смета.txt", "текст");
    fireEvent.change(await screen.findByLabelText("Регион объекта"), { target: { value: "Амурская область" } });
    fireEvent.click(screen.getByRole("tab", { name: "Проверить смету заказчика" }));

    fireEvent.click(screen.getByRole("button", { name: /Проверить смету заказчика/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ mode: "audit", priceZoneId: 282, documents: [{ name: "смета.txt" }] });
  });
});

describe("EstimateUploadView: результат проверки", () => {
  it("открытая проверка: вкладка проверки, заключение, кнопка Word, «Экономика участия» с Excel", async () => {
    search = "job=job-audit-1";
    jobs["job-audit-1"] = auditJob();
    render(<EstimateUploadView />);

    expect(await screen.findByTestId("audit-verdict")).toBeInTheDocument();
    // Открытая проверка — первое на странице: форма свёрнута в полосу с кнопкой «Новая проверка».
    expect(screen.getByTestId("estimate-form-collapsed")).toBeInTheDocument();
    expect(screen.queryByTestId("estimate-files")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: /Скачать заключение \(Word\)/ })).toBeInTheDocument();

    const bid = screen.getByTestId("audit-bid-card");
    expect(within(bid).getByText("Экономика участия по смете заказчика")).toBeInTheDocument();
    expect(within(bid).getByTestId("tile-break-even").textContent).toContain("Безубыточно от");
    expect(within(bid).getByTestId("my-price")).toBeInTheDocument();
    expect(within(bid).getByRole("button", { name: /Скачать расчёт \(Excel\)/ })).toBeInTheDocument();
  });

  it("«Новая проверка» разворачивает форму над результатом, вкладка проверки выбрана", async () => {
    search = "job=job-audit-1";
    jobs["job-audit-1"] = auditJob();
    render(<EstimateUploadView />);
    await screen.findByTestId("audit-verdict");

    fireEvent.click(screen.getByRole("button", { name: "Новая проверка" }));

    expect(screen.queryByTestId("estimate-form-collapsed")).toBeNull();
    expect(screen.getByTestId("estimate-files")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Проверить смету заказчика" })).toHaveAttribute("aria-selected", "true");
  });

  it("свёрнутая форма не прячет ход работы: идущая проверка показывает индикатор в полосе", async () => {
    search = "job=job-audit-3";
    jobs["job-audit-3"] = auditJob({ id: "job-audit-3", status: "processing", audit: null });
    render(<EstimateUploadView />);

    expect(await screen.findByText("Проверяем смету")).toBeInTheDocument();
    expect(screen.getByTestId("estimate-form-collapsed")).toBeInTheDocument();
  });

  it("в «Моей цене» кнопка −10 % пересчитывает деньги; НМЦК — итог сметы заказчика, её можно поправить", async () => {
    search = "job=job-audit-1";
    jobs["job-audit-1"] = auditJob();
    render(<EstimateUploadView />);
    const bid = await screen.findByTestId("audit-bid-card");

    fireEvent.click(within(bid).getByRole("button", { name: "−10 %" }));

    expect(within(bid).getByTestId("my-price-result")).toBeInTheDocument();
    expect(within(bid).getByTestId("my-price-verdict").textContent).toBeTruthy();
    expect(within(bid).getByLabelText("НМЦК, ₽")).toBeInTheDocument();
    expect(bid.textContent).toContain("НМЦК принята равной итогу сметы заказчика");
  });

  it("проверка без смет: что не распознано и что делать", async () => {
    search = "job=job-audit-2";
    jobs["job-audit-2"] = auditJob({
      id: "job-audit-2",
      audit: { reports: [], zone: auditData([]).zone, period: "3 квартал 2026 г.", notRecognized: [{ documentName: "Скан.pdf", estimateName: null, reason: "нет строки нумерации граф 1–12: это не форма 421/пр" }] },
    });
    render(<EstimateUploadView />);

    expect(await screen.findByTestId("audit-empty")).toBeInTheDocument();
    expect(screen.getByTestId("audit-not-recognized").textContent).toContain("Скан.pdf");
    expect(screen.getByTestId("audit-advice").textContent).toContain("Гранд-Смета");
    expect(screen.queryByTestId("audit-bid-card")).toBeNull();
    expect(screen.queryByRole("button", { name: /Скачать заключение/ })).toBeNull();
  });

  it("сбой соединения при открытии расчёта: дружелюбная фраза, а не «fetch failed … ECONNREFUSED»", async () => {
    search = "job=job-x";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (String(input).startsWith("/api/estimate?jobId=")) throw new TypeError("fetch failed — connect ECONNREFUSED 127.0.0.1:18088");
        return new Response(JSON.stringify(String(input).includes("zones") ? ZONES : { items: [], nextCursor: null }), { status: 200 });
      }),
    );
    render(<EstimateUploadView />);

    const alert = await screen.findByTestId("estimate-open-error");
    expect(alert.textContent).toContain("Не удалось загрузить расчёт — повторите через минуту");
    expect(document.body.textContent).not.toMatch(/ECONNREFUSED|fetch failed|TypeError/);
  });

  it("подсказка под зоной загрузки — две короткие строки, про сканы и .gsfx — под «Подробнее»", async () => {
    render(<EstimateUploadView />);
    const more = (await screen.findByTestId("upload-more")) as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain("Сканы внутри архива");
    expect(more.textContent).toContain(".gsfx");
  });
});
