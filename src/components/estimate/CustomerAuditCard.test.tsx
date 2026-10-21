import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CustomerAuditCard } from "@/components/estimate/CustomerAuditCard";
import { auditData, reportLowCoverage, reportMatching, reportWithFindings } from "@/test/auditReports";

afterEach(cleanup);

const flat = (text: string | null | undefined): string => (text ?? "").replace(/\s/g, " ");

describe("CustomerAuditCard", () => {
  it("герой: вывод, три цифры в одной строке (заказчик → пересчёт → разница), зона и период одной строкой; сводной строки-дубля нет", () => {
    const report = reportWithFindings();
    render(<CustomerAuditCard audit={auditData([report])} />);

    // Подпись и значение — соседние элементы без пробела между ними: сравниваем без пробелов.
    const figures = (screen.getByTestId("audit-figures").textContent ?? "").replace(/\s/g, "");
    expect(figures).toContain("Сметазаказчика17055₽");
    expect(figures).toContain("Нашпересчёт17897₽");
    expect(figures).toContain("Разница+842₽(+4,9%)");
    expect(screen.queryByTestId("audit-headline")).toBeNull();
    expect(screen.queryByText(/Смета заказчика: 17 055 ₽ · по нашим ценам/)).toBeNull();
    const zone = flat(screen.getByTestId("audit-zone").textContent);
    expect(zone).toContain("Республика Бурятия (5 зона), 3 квартал 2026 г.");
    // Методика — не в шапке, а в блоке «Как считали»: один раз.
    expect(zone).not.toContain("Проверка без ИИ");
    expect(screen.getByTestId("audit-method").textContent).toContain("без участия ИИ");
  });

  it("«откуда разница»: труд с НР и СП, нормативы, суммы со знаком; строки совпадают с отчётом", () => {
    const report = reportWithFindings();
    render(<CustomerAuditCard audit={auditData([report])} />);

    const lines = within(screen.getByTestId("audit-breakdown")).getAllByRole("listitem").map((item) => flat(item.textContent));
    expect(lines.some((line) => line.startsWith("Труд (с НР и СП на него): +"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Накладные не по приказу 812/пр: −"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Сметная прибыль не по приказу 774/пр: −"))).toBe(true);
    expect(screen.getByText(/Суммы групп — с НДС 22 %/)).toBeTruthy();
  });

  it("топ позиций: только существенные, с обоснованием, суммами, разницей и русскими подписями причин; легенда цвета", () => {
    const report = reportWithFindings();
    render(<CustomerAuditCard audit={auditData([report])} />);

    const table = screen.getByRole("table");
    expect(within(table).getByText("ГЭСНр56-01-009-01")).toBeTruthy();
    const rows = within(table).getAllByRole("row");
    const expected = report.top.filter((item) => Math.abs(item.diff) >= 1 && Math.abs(item.diff) / item.customerTotal >= 0.005).length;
    expect(rows.length).toBe(1 + expected);
    expect(flat(rows[1]!.textContent)).toContain("цены ресурсов");
    expect(table.textContent).not.toMatch(/RESOURCE_PRICE|OVERHEAD_RATE|PROFIT_RATE|COEFFICIENTS/);
    expect(screen.getByTestId("audit-legend").textContent).toContain("у заказчика дешевле");
    // Деньги не переносятся посреди суммы.
    expect(rows[1]!.querySelector("td.whitespace-nowrap")).not.toBeNull();
  });

  it("расхождений по позициям нет — одна фраза вместо таблицы нулей", () => {
    render(<CustomerAuditCard audit={auditData([reportMatching()])} />);
    expect(screen.getByTestId("audit-no-positions").textContent).toBe("Расхождений по позициям нет.");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("у заказчика дешевле — красная разница, дороже — зелёная", () => {
    const base = reportWithFindings();
    const cheaper = { ...base, top: [{ ...base.top[0]!, diff: 500, customerTotal: 1000 }] };
    const { unmount } = render(<CustomerAuditCard audit={auditData([cheaper])} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")[1]!.querySelector("td.text-brick-fg")).not.toBeNull();
    unmount();
    const dearer = { ...base, top: [{ ...base.top[0]!, diff: -500, customerTotal: 1000 }] };
    render(<CustomerAuditCard audit={auditData([dearer])} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")[1]!.querySelector("td.text-olive-fg")).not.toBeNull();
  });

  it("находки и непроверенное свёрнуты в раскрывающиеся блоки", () => {
    const report = reportLowCoverage();
    render(<CustomerAuditCard audit={auditData([report])} />);

    expect(screen.getByText(/Не проверено \(\d+\)/)).toBeTruthy();
    expect(screen.getAllByText(/нашей цены нет/, { selector: "li" })).toHaveLength(3);
  });

  it("покрытие ниже 70 % — оговорка рядом с выводом", () => {
    render(<CustomerAuditCard audit={auditData([reportLowCoverage()])} />);
    const coverage = screen.getByTestId("audit-coverage").textContent ?? "";
    expect(coverage).toMatch(/Проверено \d+ % прямых затрат · не переоценено 3 поз\./);
    expect(coverage).toContain("вывод неполный");
  });

  it("разницы нет — «расхождений не найдено» вместо пустого списка групп", () => {
    render(<CustomerAuditCard audit={auditData([reportMatching()])} />);
    expect(screen.getByText(/Расхождений по ценам, нормативам и арифметике не найдено/)).toBeTruthy();
    expect(screen.queryByTestId("audit-breakdown")).toBeNull();
    expect(screen.getByTestId("audit-coverage").textContent).not.toContain("вывод неполный");
  });

  it("пустой список отчётов: сказано словами, а не пустой экран", () => {
    render(<CustomerAuditCard audit={auditData([])} />);
    expect(screen.getByText("Ни одной сметы заказчика построчно проверить не удалось.")).toBeTruthy();
  });

  it("нераспознанные сметы названы с причиной", () => {
    render(
      <CustomerAuditCard
        audit={auditData([reportMatching()], {
          notRecognized: [{ documentName: "Изыскания.xlsx", estimateName: null, reason: "нет строки нумерации граф 1–12: это не форма 421/пр" }],
        })}
      />,
    );
    expect(screen.getByText("Не проверено построчно: смет 1")).toBeTruthy();
    expect(screen.getByText(/Смета «Изыскания.xlsx» — не форма 421\/пр, построчно не проверена/)).toBeTruthy();
  });

  it("несколько смет: итог сверху, каждая смета — в своём свёрнутом блоке, названия различаются", () => {
    render(<CustomerAuditCard audit={auditData([reportWithFindings(), reportMatching()])} />);
    expect(screen.getByTestId("audit-overall")).toBeInTheDocument();
    const blocks = screen.getAllByTestId("audit-estimate") as HTMLDetailsElement[];
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => !block.open)).toBe(true);
    // Одинаковые названия различаются именем файла: смету можно узнать.
    expect(blocks[0]!.textContent).not.toBe(blocks[1]!.textContent?.slice(0, 5));
  });
});
