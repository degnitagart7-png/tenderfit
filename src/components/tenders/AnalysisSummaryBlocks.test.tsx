import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { ConsolidationBlock, MoneyBlock } from "@/components/tenders/AnalysisSummaryBlocks";
import type { ConsolidatedAnalysis } from "@/domain/analysisConsolidation";
import type { MoneyOutlook } from "@/domain/moneyOutlook";

/*
  Блок «Деньги»: суть сверху большими числами, запас по цене — шкалой и одной фразой, таблица шагов и
  обеспечения по видам — под раскрытием. Блок противоречий и вопросов: срок запроса разъяснений рядом со счётчиком.
*/

afterEach(cleanup);

const OUTLOOK: MoneyOutlook = {
  securities: [
    { kind: "bid", label: "Обеспечение заявки", percent: 1, amount: 60_000, period: "с подачи заявки до подписания контракта" },
    { kind: "contract", label: "Обеспечение исполнения контракта", percent: 5, amount: 300_000, period: "до приёмки работ" },
  ],
  frozenPeak: 495_000,
  advancePercent: 0,
  paymentDays: 30,
  margin: {
    profit: 103_261.12,
    overhead: 200_221.78,
    base: 1_525_000,
    scenarios: [
      { reduction: 0.05, price: 5_700_000, profitLeft: 0.017, overheadLeft: 0.149, note: "остаётся сметной прибыли около 1,7 %" },
      { reduction: 0.25, price: 4_500_000, profitLeft: -0.18, overheadLeft: -0.05, note: "ниже прямых затрат по смете заказчика — работа в убыток" },
    ],
  },
  winter: { months: ["ноябрь", "декабрь"], included: null },
};

describe("MoneyBlock", () => {
  it("большие числа: заморозится, аванс, оплата", () => {
    render(<MoneyBlock outlook={OUTLOOK} price={6_000_000} />);

    const block = screen.getByTestId("money-block");
    expect(within(block).getByText("495 тыс. ₽")).toBeTruthy();
    expect(within(block).getByText("заморозится до этой суммы")).toBeTruthy();
    expect(within(block).getByText("нет")).toBeTruthy();
    expect(within(block).getByText("30 дн.")).toBeTruthy();
  });

  it("запас по цене: шкала и одна фраза про безопасное снижение", () => {
    render(<MoneyBlock outlook={OUTLOOK} price={6_000_000} />);

    expect(screen.getByRole("img", { name: /Без убытка до −19,9 %, прибыль сохраняется до −6,7 %/ })).toBeTruthy();
    expect(
      screen.getByText(
        "Снижение до −6,7 % — в пределах сметной прибыли, до −19,9 % — за счёт накладных, глубже — убыток по смете заказчика.",
      ),
    ).toBeTruthy();
  });

  it("таблица сценариев и обеспечения спрятаны под раскрытие", () => {
    render(<MoneyBlock outlook={OUTLOOK} price={6_000_000} />);

    const steps = screen.getByText("Подробно по шагам снижения").closest("details")!;
    expect(steps).not.toHaveAttribute("open");
    expect(within(steps).getByText("−25 %")).toBeTruthy();

    const securities = screen.getByText("Обеспечения по видам").closest("details")!;
    expect(securities).not.toHaveAttribute("open");
    expect(within(securities).getByText("Обеспечение заявки")).toBeTruthy();
    expect(within(securities).getByText(/Одновременно может быть заморожено до/)).toBeTruthy();
  });

  it("зима — выноска с жёлтой чертой, текст прежний", () => {
    render(<MoneyBlock outlook={OUTLOOK} price={6_000_000} />);

    const winter = screen.getByText(/Работы приходятся на зиму \(ноябрь, декабрь\)/);
    expect(winter.className).toContain("border-mustard");
    expect(winter).toHaveTextContent(/Зимнее удорожание в смете заказчика не начислено/);
  });

  it("без цены закупки шкалы нет: запас считается от неё", () => {
    render(<MoneyBlock outlook={OUTLOOK} price={null} />);

    expect(screen.queryByTestId("cushion-bar")).toBeNull();
    expect(screen.queryByText(/Запас по цене/)).toBeNull();
  });

  it("запас шире шкалы 30 % — красного участка нет, метки не вылезают", () => {
    const wide: MoneyOutlook = { ...OUTLOOK, margin: { ...OUTLOOK.margin!, profit: 400_000, overhead: 200_000 } };
    render(<MoneyBlock outlook={wide} price={6_000_000} />);

    const bar = screen.getByTestId("cushion-bar");
    const segments = bar.querySelectorAll<HTMLElement>('[role="img"] > div');
    // Прибыль 26,2 % от базы занимает 87,4 % шкалы до 30 %.
    expect(Number.parseFloat(segments[0]!.style.width)).toBeCloseTo(87.43, 1);
    const total = [...segments].reduce((sum, el) => sum + Number.parseFloat(el.style.width), 0);
    expect(total).toBeCloseTo(100, 5);
  });
});

function consolidation(patch: Partial<ConsolidatedAnalysis> = {}): ConsolidatedAnalysis {
  return {
    kind: "consolidated",
    summary: "Итог.",
    findings: [],
    conflicts: [],
    questions: ["Вопрос 1", "Вопрос 2"],
    facts: {
      work_start: null,
      work_end: null,
      warranty_months: null,
      bid_security_percent: null,
      contract_security_percent: null,
      warranty_security_percent: null,
      advance_percent: null,
      payment_days: null,
    },
    ...patch,
  };
}

describe("ConsolidationBlock", () => {
  const clarify = (daysLeft: number, passed = false) => ({ date: new Date("2026-10-17T07:00:00Z"), daysLeft, passed });

  it("итог по документации показывается по умолчанию и скрывается showSummary=false", () => {
    const { rerender } = render(<ConsolidationBlock consolidation={consolidation()} />);
    expect(screen.getByText("Итог по всей документации")).toBeTruthy();

    rerender(<ConsolidationBlock consolidation={consolidation()} showSummary={false} />);
    expect(screen.queryByText("Итог по всей документации")).toBeNull();
    expect(screen.getByText("Вопросы заказчику")).toBeTruthy();
  });

  it("только итог и скрыт — блока нет вовсе", () => {
    const { container } = render(
      <ConsolidationBlock consolidation={consolidation({ questions: [] })} showSummary={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("срок запроса: обычный, горящий (≤ 1 дня) и прошедший", () => {
    const { rerender } = render(<ConsolidationBlock consolidation={consolidation()} clarifyBy={clarify(2)} />);
    expect(screen.getByText("отправить до 17.10").className).not.toContain("text-brick-fg");

    rerender(<ConsolidationBlock consolidation={consolidation()} clarifyBy={clarify(1)} />);
    expect(screen.getByText("отправить до 17.10").className).toContain("text-brick-fg");

    rerender(<ConsolidationBlock consolidation={consolidation()} clarifyBy={clarify(0, true)} />);
    expect(screen.getByText("срок запроса прошёл").className).toContain("text-brick-fg");
  });

  it("без срока подписи нет", () => {
    render(<ConsolidationBlock consolidation={consolidation()} clarifyBy={null} />);
    expect(screen.queryByText(/отправить до/)).toBeNull();
  });
});
