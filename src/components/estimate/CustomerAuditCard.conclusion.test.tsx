import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveBytes = vi.fn();
vi.mock("@/lib/downloadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/downloadFile")>()),
  saveBytes: (...args: unknown[]) => saveBytes(...args),
}));

import { AuditBidEconomics } from "@/components/estimate/AuditBidEconomics";
import { CustomerAuditCard } from "@/components/estimate/CustomerAuditCard";
import { auditData, reportLowCoverage, reportMatching, reportWithFindings } from "@/test/auditReports";

/*
  Блок «Заключение» над деталями проверки: вывод простыми словами, главные причины, непереоценённое, оговорка, файл Word.
*/

beforeEach(() => saveBytes.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flat = (text: string | null | undefined): string => (text ?? "").replace(/\s/g, " ");

describe("CustomerAuditCard: заключение", () => {
  it("вверху блока — вывод, цифры, главные причины, непереоценённое и оговорка", () => {
    const report = { ...reportWithFindings(), customerTotal: 1_000_000, repricedTotal: 1_150_000, diff: 150_000, diffPercent: 15 };
    render(<CustomerAuditCard audit={auditData([report])} jobId="job-1" />);

    expect(screen.getByTestId("audit-verdict")).toBeTruthy();
    expect(flat(screen.getByTestId("audit-verdict-headline").textContent)).toBe("Смета заказчика занижена на 150 000 ₽ (15,0 %) — денег на работы может не хватить");
    const figures = (screen.getByTestId("audit-figures").textContent ?? "").replace(/\s/g, "");
    expect(figures).toContain("Сметазаказчика1000000₽");
    expect(figures).toContain("Разница+150000₽(+15,0%)");
    const reasons = within(screen.getByTestId("audit-reasons")).getAllByRole("listitem");
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.length).toBeLessThanOrEqual(5);
    // Всё переоценено — отдельной строки про непереоценённое нет, покрытие одной строкой.
    expect(screen.queryByTestId("audit-unrepriced")).toBeNull();
    expect(screen.getByTestId("audit-coverage").textContent).toContain("не переоценено 0 поз.");
    expect(screen.getByTestId("audit-method").textContent).toContain("без участия ИИ");
  });

  it("завышена и в пределах ±5 % — свои формулировки", () => {
    const over = { ...reportWithFindings(), customerTotal: 1_000_000, repricedTotal: 800_000, diff: -200_000, diffPercent: -20 };
    const { unmount } = render(<CustomerAuditCard audit={auditData([over])} jobId="j" />);
    expect(screen.getByTestId("audit-verdict-headline").textContent).toContain("завышена");
    unmount();
    render(<CustomerAuditCard audit={auditData([reportMatching()])} jobId="j" />);
    expect(screen.getByTestId("audit-verdict-headline").textContent).toContain("в пределах ±5 %");
  });

  it("непереоценённое: сколько позиций, на сколько рублей и почему; малое покрытие — предупреждение", () => {
    render(<CustomerAuditCard audit={auditData([reportLowCoverage()])} jobId="j" />);

    const unrepriced = flat(screen.getByTestId("audit-unrepriced").textContent);
    expect(unrepriced).toContain("Не удалось переоценить: 3 поз.");
    expect(unrepriced).toContain("Причины: нашей цены нет");
    expect(screen.getByTestId("audit-coverage").textContent).toContain("вывод неполный");
  });

  it("кнопка «Скачать заключение (Word)» есть, когда известен номер проверки; без номера её нет", () => {
    const { unmount } = render(<CustomerAuditCard audit={auditData([reportWithFindings()])} jobId="job-1" />);
    expect(screen.getByRole("button", { name: /Скачать заключение \(Word\)/ })).toBeInTheDocument();
    unmount();
    render(<CustomerAuditCard audit={auditData([reportWithFindings()])} />);
    expect(screen.queryByRole("button", { name: /Скачать заключение/ })).toBeNull();
  });

  it("нажатие запрашивает файл по номеру проверки и номеру сметы и сохраняет его как .docx", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomerAuditCard audit={auditData([reportWithFindings()])} jobId="job 1" />);

    fireEvent.click(screen.getByRole("button", { name: /Скачать заключение \(Word\)/ }));

    await waitFor(() => expect(saveBytes).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/estimate/conclusion?jobId=job%201&report=0");
    const [, fileName, mime] = saveBytes.mock.calls[0] as [ArrayBuffer, string, string];
    expect(fileName).toMatch(/^Заключение по смете .* от \d{4}-\d{2}-\d{2}\.docx$/);
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("у второй сметы в запросе report=1: строка «Требуют внимания» раскрывает смету, там своя кнопка", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([80, 75]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomerAuditCard audit={auditData([reportWithFindings(), reportLowCoverage()])} jobId="j" />);

    fireEvent.click(within(screen.getByTestId("audit-attention")).getAllByRole("button")[0]!);
    const buttons = await screen.findAllByRole("button", { name: /Скачать заключение \(Word\)/ });
    fireEvent.click(buttons[0]!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/estimate/conclusion?jobId=j&report=1"));
  });

  it("ошибка сервера — сообщение рядом с кнопкой, файл не сохраняется", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Проверка ещё не закончена" }), { status: 409 })),
    );
    render(<CustomerAuditCard audit={auditData([reportWithFindings()])} jobId="j" />);

    fireEvent.click(screen.getByRole("button", { name: /Скачать заключение \(Word\)/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Проверка ещё не закончена");
    expect(saveBytes).not.toHaveBeenCalled();
  });
});

describe("AuditBidEconomics", () => {
  const company = { taxSystem: "OSNO" as const, minMarginPercent: 10 };

  it("строит экономику по смете заказчика: заголовок, «Моя цена», Excel", () => {
    render(<AuditBidEconomics audit={auditData([reportWithFindings()])} company={company} />);

    expect(screen.getByTestId("tile-break-even").textContent).toContain("Безубыточно от");
    expect(screen.getByTestId("bid-base-note").textContent).toContain("смета заказчика, пересчитанная");
    expect(screen.getByTestId("my-price")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Скачать расчёт \(Excel\)/ })).toBeInTheDocument();
  });

  it("нет смет с итогом — блока нет", () => {
    const empty = { ...reportWithFindings(), customerTotal: 0 };
    const { container } = render(<AuditBidEconomics audit={auditData([empty])} company={company} />);
    expect(container.textContent).toBe("");
    cleanup();
    const none = render(<AuditBidEconomics audit={auditData([])} company={company} />);
    expect(none.container.textContent).toBe("");
  });

  it("на карточке закупки с одной сметой берётся НМЦК закупки и закон; закон 44-ФЗ делает антидемпинг безусловным", () => {
    render(<AuditBidEconomics audit={auditData([reportWithFindings()])} company={company} tender={{ nmc: 20_000, law: "FZ_44" }} />);
    expect(screen.getByTestId("audit-bid").textContent).toContain("НМЦК — цена закупки");

    fireEvent.click(screen.getByRole("button", { name: "−25 %" }));
    expect(screen.getByTestId("my-price-antidumping").textContent).toContain("44-ФЗ, ст. 37");
    expect(screen.getByTestId("my-price-antidumping").textContent).not.toContain("Если закупка");
  });

  it("несколько смет: по умолчанию — итог по всем; выбор одной сметы остаётся, у каждого выбора своё состояние", () => {
    render(<AuditBidEconomics audit={auditData([reportWithFindings(), reportMatching()])} company={company} />);

    const select = screen.getByLabelText("Смета заказчика для расчёта цены") as HTMLSelectElement;
    expect(select.options).toHaveLength(3);
    expect(select.value).toBe("all");
    expect(select.options[0]!.text).toBe("Все сметы вместе (2)");
    expect(screen.getByTestId("audit-bid").textContent).toContain("сумме итогов смет заказчика");
    fireEvent.click(screen.getByRole("button", { name: "−10 %" }));
    expect(screen.getByTestId("my-price-result")).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "1" } });
    // Другой выбор — введённая цена относилась к другому набору смет и не переносится.
    expect(screen.queryByTestId("my-price-result")).toBeNull();
    expect(screen.getByTestId("audit-bid").textContent).toContain("итогу сметы заказчика");
  });

  it("итог по всем сметам: НМЦК — сумма итогов, себестоимость — сумма пересчётов", () => {
    const reports = [reportWithFindings(), reportMatching()];
    render(<AuditBidEconomics audit={auditData(reports)} company={company} />);
    const total = Math.round(reports[0]!.customerTotal + reports[1]!.customerTotal);
    expect((screen.getByLabelText("НМЦК, ₽") as HTMLInputElement).placeholder).toBe(String(total));
  });

  it("поправка профиля затрат уходит наверх для сохранения", () => {
    const onChange = vi.fn();
    render(<AuditBidEconomics audit={auditData([reportWithFindings()])} company={company} onCostProfileChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/Скидка на материалы к сметным ценам/), { target: { value: "12" } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ materialDiscountPercent: 12 }));
  });
});

describe("CustomerAuditCard: итог по нескольким сметам", () => {
  const reports = [
    { ...reportWithFindings(), estimateNumber: "02-01-01", title: "Ремонт кровли" },
    { ...reportMatching(), estimateNumber: "02-01-02", title: "Электроснабжение" },
    { ...reportLowCoverage(), estimateNumber: "02-01-03", title: "Отопление" },
  ];
  const digits = (text: string | null | undefined): string => (text ?? "").replace(/\s/g, "");

  it("одна смета — итога нет: он нужен, только когда смет несколько", () => {
    render(<CustomerAuditCard audit={auditData([reportWithFindings()])} jobId="j" />);
    expect(screen.queryByTestId("audit-overall")).toBeNull();
  });

  it("герой «Итого по всем сметам (3)»: сумма заказчика → пересчёт → разница, покрытие одной строкой", () => {
    render(<CustomerAuditCard audit={auditData(reports)} jobId="j" />);

    expect(screen.getByTestId("audit-overall-headline").textContent).toContain("Итого по всем сметам (3)");
    const figures = digits(screen.getByTestId("audit-overall-figures").textContent);
    expect(figures).toContain("Сметызаказчика(3)");
    expect(figures).toContain("Нашпересчёт");
    expect(figures).toContain("Разница");
    expect(screen.getByTestId("audit-overall-coverage").textContent).toMatch(/^Проверено \d+ % прямых затрат/);
  });

  it("список внимания — только сметы с разницей больше 5 % или покрытием ниже 70 %, в одну строку: название · разница · покрытие", () => {
    render(<CustomerAuditCard audit={auditData(reports)} jobId="j" />);

    const items = within(screen.getByTestId("audit-attention")).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("ЛСР 02-01-03 · Отопление");
    expect(items[0]!.textContent).toMatch(/проверено \d+ %/);
    expect(screen.getByText("Требуют внимания: 1 из 3")).toBeInTheDocument();
  });

  it("все в норме — одна фраза вместо списка", () => {
    render(<CustomerAuditCard audit={auditData([reportMatching(), reportMatching()])} jobId="j" />);
    expect(screen.getByTestId("audit-attention-none").textContent).toContain("в пределах ±5 %");
    expect(screen.queryByTestId("audit-attention")).toBeNull();
  });

  it("строка списка раскрывает смету и прокручивает к ней; остальные остаются свёрнутыми", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.useFakeTimers();
    try {
      render(<CustomerAuditCard audit={auditData(reports)} jobId="j" />);
      const blocks = screen.getAllByTestId("audit-estimate") as HTMLDetailsElement[];
      expect(blocks.map((block) => block.open)).toEqual([false, false, false]);

      fireEvent.click(within(screen.getByTestId("audit-attention")).getAllByRole("button")[0]!);
      act(() => {
        vi.runAllTimers();
      });

      expect((screen.getAllByTestId("audit-estimate") as HTMLDetailsElement[]).map((block) => block.open)).toEqual([false, false, true]);
      expect(scrollIntoView).toHaveBeenCalled();
      expect(within(blocks[2]!).getByTestId("audit-verdict")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("названия смет — номер и работы; строка про базу норм — в подзаголовке, не в названии", () => {
    render(<CustomerAuditCard audit={auditData(reports)} jobId="j" />);
    const first = screen.getAllByTestId("audit-estimate")[0]!;
    expect(first.querySelector("summary span")!.textContent).toBe("ЛСР 02-01-01 · Ремонт кровли");
    expect(first.querySelector("summary")!.textContent).toContain("ЛСР по Методике 2020");
    expect(first.querySelector("summary span.font-medium")!.textContent).not.toContain("Методик");
  });

  it("«Скачать заключение по всем сметам» запрашивает report=all", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([80, 75]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomerAuditCard audit={auditData(reports)} jobId="j" />);

    fireEvent.click(screen.getByRole("button", { name: "Скачать заключение по всем сметам" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/estimate/conclusion?jobId=j&report=all"));
    const [, fileName] = saveBytes.mock.calls[0] as [ArrayBuffer, string];
    expect(fileName).toMatch(/^Заключение по всем сметам от \d{4}-\d{2}-\d{2}\.docx$/);
  });
});
