import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CustomerAuditCard } from "@/components/estimate/CustomerAuditCard";
import { auditData, reportLowCoverage, reportMatching, reportWithFindings } from "@/test/auditReports";

afterEach(cleanup);

const flat = (text: string | null | undefined): string => (text ?? "").replace(/\s/g, " ");

describe("CustomerAuditCard", () => {
  it("шапка: итог заказчика, итог по нашим ценам, вывод и зона с периодом", () => {
    const report = reportWithFindings();
    render(<CustomerAuditCard audit={auditData([report])} />);

    const headline = flat(screen.getByTestId("audit-headline").textContent);
    expect(headline).toContain("Смета заказчика: 17 055 ₽");
    expect(headline).toContain("по нашим ценам (Республика Бурятия, 1 зона, 2 кв. 2026)");
    expect(headline).toContain(report.conclusion.replace(/\s/g, " "));
    expect(flat(screen.getByTestId("audit-zone").textContent)).toContain("Республика Бурятия (5 зона), 3 квартал 2026 г.");
    expect(screen.getByTestId("audit-zone").textContent).toContain("Проверка без ИИ");
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

  it("топ позиций: таблица с обоснованием, суммами у заказчика и у нас, разницей и флагами", () => {
    const report = reportWithFindings();
    render(<CustomerAuditCard audit={auditData([report])} />);

    const table = screen.getByRole("table");
    expect(within(table).getByText("ГЭСНр56-01-009-01")).toBeTruthy();
    const rows = within(table).getAllByRole("row");
    // Заголовок + позиции с разницей, не больше десяти.
    expect(rows.length).toBe(1 + Math.min(10, report.top.length));
    expect(flat(rows[1]!.textContent)).toContain("цены");
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
    expect(coverage).toMatch(/проверено \d+ % прямых затрат/);
    expect(coverage).toContain("вывод неполный");
    expect(screen.getByTestId("audit-headline").textContent).toContain("вывод неполный");
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

  it("несколько смет — каждая в своём раскрывающемся блоке, первая открыта", () => {
    const { container } = render(<CustomerAuditCard audit={auditData([reportWithFindings(), reportMatching()])} />);
    const blocks = container.querySelectorAll("section > details");
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect((blocks[0] as HTMLDetailsElement).open).toBe(true);
    expect((blocks[1] as HTMLDetailsElement).open).toBe(false);
  });
});
