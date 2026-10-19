import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EstimateUploadView } from "@/components/estimate/EstimateUploadView";
import { buildEstimate } from "@/domain/estimate/calculate";
import type { EstimateHistoryItem } from "@/domain/estimate/estimateHistory";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_DRAGLINE,
  BILL_GRADING,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  «Мои расчёты» на экране «Смета»: список под формой, от нового к старому; нажатие открывает результат на
  этой же странице, номер расчёта лежит в адресе (?job=), и по нему же страница открывается заново —
  так ведёт ссылка из письма «смета готова».
*/

// Адрес страницы: useSearchParams читает то, что тест положил в `search`; роутера в тесте нет.
let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

const DOCUMENT = buildEstimate({
  title: "Реконструкция запорных колодцев",
  sections: [makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE])],
  priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE)),
  parameters: makeParameters(),
  resolveNorm: makeResolver([NORM_MANUAL_GRADING, NORM_DRAGLINE_15]),
  sources: [],
  generatedAt: "2026-09-28T00:00:00.000Z",
  disclaimer: "Информационно-аналитическая справка",
});

const ZONES = {
  zones: [{ priceZoneId: 282, zoneName: "Амурская область (1 зона)", subject: "Амурская область", period: "3 квартал 2026 г." }],
  allZones: [{ name: "Амурская область (1 зона)", subjectCode: "28", subjectName: "Амурская область", center: "г. Благовещенск", municipalities: "" }],
  directory: [{ priceZoneId: 282, zoneName: "Амурская область (1 зона)" }],
};

function entry(n: number, patch: Partial<EstimateHistoryItem> = {}): EstimateHistoryItem {
  return {
    id: `job-${String(n)}`,
    status: "completed",
    createdAt: `2026-10-${String(10 + n)}T09:00:00.000000+00:00`,
    finishedAt: `2026-10-${String(10 + n)}T09:05:00.000000+00:00`,
    mode: "estimate",
    reason: "upload",
    tenderId: null,
    subject: `Объект ${String(n)}`,
    documentNames: [`файл-${String(n)}.docx`],
    totalRub: 1_000_000 * n,
    error: null,
    ...patch,
  };
}

interface Server {
  history: EstimateHistoryItem[][];
  jobs: Record<string, unknown>;
  posted: unknown[];
  historyCalls: string[];
  jobCalls: string[];
}

let server: Server;

function stubServer(): void {
  server = { history: [[]], jobs: {}, posted: [], historyCalls: [], jobCalls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("/api/estimate/zones")) return json(ZONES);
      if (url.startsWith("/api/estimate/history")) {
        server.historyCalls.push(url);
        // Две страницы: без курсора — первая, с курсором — вторая; курсор первой — время её последней строки.
        const before = new URL(url, "http://x").searchParams.get("before");
        const page = (before === null ? server.history[0] : server.history[1]) ?? [];
        const next = before === null && server.history[1] !== undefined ? (server.history[0]?.at(-1)?.createdAt ?? null) : null;
        return json({ items: page, nextCursor: next });
      }
      if (url.startsWith("/api/estimate?jobId=")) {
        const id = decodeURIComponent(url.split("jobId=")[1] ?? "");
        server.jobCalls.push(id);
        return json({ job: server.jobs[id] ?? null });
      }
      if (url === "/api/estimate" && init?.method === "POST") {
        server.posted.push(JSON.parse(String(init.body)));
        const created = entry(9, { id: "job-new", status: "pending", totalRub: null, subject: "Новый объект" });
        server.history = [[created, ...(server.history[0] ?? [])], ...server.history.slice(1)];
        return json({ job: { id: "job-new", status: "pending", error: null, mode: "estimate", estimate: null }, reused: false });
      }
      return json({ job: null });
    }),
  );
}

const completedJob = (n: number, patch: Record<string, unknown> = {}) => ({
  id: `job-${String(n)}`,
  status: "completed",
  error: null,
  mode: "estimate",
  reason: "upload",
  tenderId: null,
  subject: `Объект ${String(n)}`,
  documentNames: [`файл-${String(n)}.docx`],
  createdAt: `2026-10-${String(10 + n)}T09:00:00.000000+00:00`,
  estimate: { document: DOCUMENT, rejected: [], documentsWithoutBill: [], billItems: 2 },
  audit: null,
  ...patch,
});

beforeEach(() => {
  search = "";
  window.history.replaceState(null, "", "/estimate");
  localStorage.clear();
  stubServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EstimateUploadView — «Мои расчёты»", () => {
  it("расчёты показаны от нового к старому: объект, время, режим, статус, сумма, файлы", async () => {
    server.history = [[entry(3), entry(2, { mode: "audit", status: "failed", totalRub: null, error: "Ни одна смета не подошла", documentNames: null })]];
    render(<EstimateUploadView />);

    const items = await screen.findAllByTestId("estimate-history-item");
    expect(items.map((item) => item.getAttribute("data-job-id"))).toEqual(["job-3", "job-2"]);

    const first = within(items[0]!);
    expect(first.getByText("Объект 3")).toBeInTheDocument();
    expect(first.getByText("готово")).toBeInTheDocument();
    expect(first.getByTestId("estimate-history-total").textContent).toContain("3");
    expect(first.getByText(/файл-3\.docx/)).toBeInTheDocument();
    expect(first.getByText(/Смета/)).toBeInTheDocument();

    const second = within(items[1]!);
    expect(second.getByText("ошибка")).toBeInTheDocument();
    expect(second.getByText(/Проверка сметы заказчика/)).toBeInTheDocument();
    expect(second.getByText("Ни одна смета не подошла")).toBeInTheDocument();
    // Старый расчёт без имён файлов — честная общая подпись, а не пустота.
    expect(second.getByText("загруженные файлы")).toBeInTheDocument();
  });

  it("расчёт по закупке — со ссылкой на закупку", async () => {
    server.history = [[entry(1, { reason: "tender", tenderId: "0373100000126000001", documentNames: null })]];
    render(<EstimateUploadView />);

    const link = await screen.findByRole("link", { name: /Закупка 0373100000126000001/ });
    expect(link.getAttribute("href")).toBe("/tenders/0373100000126000001?tab=analysis");
  });

  it("расчётов нет — раздел не рисуется", async () => {
    render(<EstimateUploadView />);

    await waitFor(() => expect(server.historyCalls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("estimate-history")).toBeNull();
  });

  it("«Показать ещё» подгружает следующую страницу по курсору и добавляет её в конец", async () => {
    server.history = [[entry(5), entry(4)], [entry(3), entry(2)]];
    render(<EstimateUploadView />);

    await screen.findAllByTestId("estimate-history-item");
    fireEvent.click(screen.getByRole("button", { name: "Показать ещё" }));

    await waitFor(() => expect(screen.getAllByTestId("estimate-history-item")).toHaveLength(4));
    expect(screen.getAllByTestId("estimate-history-item").map((item) => item.getAttribute("data-job-id"))).toEqual(["job-5", "job-4", "job-3", "job-2"]);
    // Курсор — время последней показанной строки, закодированное для адреса.
    expect(server.historyCalls.at(-1)).toBe(`/api/estimate/history?before=${encodeURIComponent(entry(4).createdAt)}`);
    // Больше страниц нет — кнопка пропала.
    expect(screen.queryByRole("button", { name: "Показать ещё" })).toBeNull();
  });

  it("нажатие на расчёт открывает результат на этой же странице и пишет номер в адрес", async () => {
    server.history = [[entry(3)]];
    server.jobs["job-3"] = completedJob(3);
    render(<EstimateUploadView />);

    fireEvent.click(await screen.findByRole("button", { name: /Открыть расчёт: Объект 3/ }));

    expect(await screen.findByText("Стоимость СМР")).toBeInTheDocument();
    expect(server.jobCalls).toEqual(["job-3"]);
    expect(window.location.search).toBe("?job=job-3");
    expect(screen.getByTestId("estimate-opened-banner").textContent).toContain("Объект 3");
    expect(screen.getByRole("button", { name: /Открыть расчёт: Объект 3/ })).toHaveAttribute("aria-current", "true");
  });

  it("«Закрыть» убирает результат и номер из адреса", async () => {
    server.history = [[entry(3)]];
    server.jobs["job-3"] = completedJob(3);
    render(<EstimateUploadView />);
    fireEvent.click(await screen.findByRole("button", { name: /Открыть расчёт: Объект 3/ }));
    await screen.findByText("Стоимость СМР");

    fireEvent.click(within(screen.getByTestId("estimate-opened-banner")).getByRole("button", { name: "Закрыть" }));

    await waitFor(() => expect(screen.queryByText("Стоимость СМР")).toBeNull());
    expect(window.location.search).toBe("");
  });

  it("?job=<номер> в адресе открывает расчёт сразу, без нажатия — так работает ссылка из письма", async () => {
    search = "job=job-7";
    server.jobs["job-7"] = completedJob(7);
    render(<EstimateUploadView />);

    expect(await screen.findByText("Стоимость СМР")).toBeInTheDocument();
    expect(server.jobCalls).toEqual(["job-7"]);
    expect(screen.getByTestId("estimate-opened-banner").textContent).toContain("Объект 7");
    // Адрес уже содержит номер — повторно в историю браузера он не пишется.
    expect(window.location.search).toBe("");
  });

  it("?job= с чужим или несуществующим номером — «Расчёт не найден», результата нет", async () => {
    search = "job=чужой-номер";
    // Сервер отвечает {job: null} и на чужой, и на несуществующий: пользователю видно одно и то же.
    render(<EstimateUploadView />);

    const alert = await screen.findByTestId("estimate-open-error");
    expect(alert.textContent).toContain("Расчёт не найден");
    expect(screen.queryByText("Стоимость СМР")).toBeNull();
  });

  it("расчёт, который ещё считается, открывается с индикатором, а не пустой страницей", async () => {
    search = "job=job-8";
    server.jobs["job-8"] = completedJob(8, { status: "processing", estimate: null });
    render(<EstimateUploadView />);

    expect(await screen.findByText("Считаем смету")).toBeInTheDocument();
    expect(screen.queryByText("Стоимость СМР")).toBeNull();
  });

  it("новый расчёт появляется в списке сразу, сверху, и его номер ложится в адрес", async () => {
    server.history = [[entry(3)]];
    render(<EstimateUploadView />);
    await screen.findAllByTestId("estimate-history-item");
    await waitFor(() => expect(screen.getByRole("button", { name: /Рассчитать смету/ })).toBeDisabled());

    // Файл читается в браузере: в jsdom у File нет text().
    const text = "Ведомость объёмов работ: земляные работы 120 м3";
    const file = new File([text], "ведомость.txt");
    Object.defineProperty(file, "text", { value: async () => text });
    fireEvent.change(screen.getByTestId("estimate-files"), { target: { files: [file] } });
    await screen.findByLabelText("Убрать ведомость.txt");
    fireEvent.change(await screen.findByLabelText("Регион объекта"), { target: { value: "Амурская область" } });

    fireEvent.click(screen.getByRole("button", { name: /Рассчитать смету/ }));

    await waitFor(() => expect(screen.getAllByTestId("estimate-history-item")).toHaveLength(2));
    expect(screen.getAllByTestId("estimate-history-item")[0]).toHaveAttribute("data-job-id", "job-new");
    expect(screen.getAllByTestId("estimate-history-item")[0]!.textContent).toContain("в очереди");
    expect(window.location.search).toBe("?job=job-new");
    expect(server.posted).toHaveLength(1);
  });

  it("сбой загрузки списка показан, форма расчёта при этом работает", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        String(input).includes("/api/estimate/zones")
          ? new Response(JSON.stringify(ZONES), { status: 200 })
          : String(input).startsWith("/api/estimate/history")
            ? new Response(JSON.stringify({ error: "База недоступна" }), { status: 500 })
            : new Response(JSON.stringify({ job: null }), { status: 200 }),
      ),
    );
    render(<EstimateUploadView />);

    expect(await screen.findByRole("alert")).toHaveTextContent("База недоступна");
    expect(screen.getByLabelText("Наименование объекта")).toBeInTheDocument();
  });
});
