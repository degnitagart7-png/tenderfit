import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BidEconomicsCard } from "@/components/estimate/BidEconomicsCard";
import type { EstimateDocument } from "@/domain/estimate/types";
import type { VatStatus } from "@/domain/estimate/vatStatus";

afterEach(cleanup);

const document = {
  parameters: { vatPercent: 20 },
  sections: [{ lines: [{ materialCost: 1_500_000 }] }],
  totals: {
    directCost: 3_000_000,
    wageFund: 800_000,
    overheadCost: 600_000,
    profitCost: 400_000,
    workCost: 4_000_000,
    winterSurcharge: 0,
    temporaryStructures: 0,
    beforeVat: 4_000_000,
    vat: 800_000,
    total: 4_800_000,
  },
} as unknown as EstimateDocument;

const base = {
  document,
  nmc: 5_400_000,
  billItems: 10,
  droppedPositions: 0,
  assumedPercent: 0,
  unpricedResources: 0,
  taxSystem: "OSNO" as const,
  minMarginPercent: 10,
};

/** Деньги печатаются с узким неразрывным пробелом: сравниваем без пробелов. */
const digits = (text: string | null | undefined): string => (text ?? "").replace(/\s/g, "");

/** Значение плитки-ответа в рублях: компактный текст плитки («4,94 млн ₽») округляет, поэтому точное число лежит в data-value. */
function tile(id: "tile-break-even" | "tile-min-price" | "tile-reduction"): number {
  return Number(screen.getByTestId(id).getAttribute("data-value"));
}

describe("BidEconomicsCard", () => {
  it("три плитки-ответа: безубыточно от, с маржой от, снижать можно до — крупно и компактно", () => {
    render(<BidEconomicsCard {...base} />);

    expect(tile("tile-min-price")).toBeGreaterThanOrEqual(4_937_142);
    expect(tile("tile-min-price")).toBeLessThanOrEqual(4_937_144);
    expect(tile("tile-break-even")).toBe(4_320_000);
    expect(digits(screen.getByTestId("tile-break-even").textContent)).toBe("Безубыточноот4,32млн₽");
    expect(digits(screen.getByTestId("tile-min-price").textContent)).toBe("Смаржой10%—от4,94млн₽");
    expect(digits(screen.getByTestId("tile-reduction").textContent)).toBe("Снижатьможнодо8,6%отНМЦК");
    expect(screen.getByText("НМЦК выше расчёта")).toBeTruthy();
  });

  it("нельзя снижать — плитка красная и говорит «нельзя»", () => {
    render(<BidEconomicsCard {...base} nmc={4_500_000} />);
    const reduction = screen.getByTestId("tile-reduction");
    expect(digits(reduction.textContent)).toBe("Снижатьможнодонельзя");
    expect(reduction.querySelector(".text-brick-fg")).not.toBeNull();
  });

  it("шкала цены: три зоны с короткими подписями, суммы не повторяются; плиток-дублей пяти цифр нет", () => {
    render(<BidEconomicsCard {...base} />);

    const scale = screen.getByTestId("price-scale");
    expect(scale.textContent).toContain("Убыток");
    expect(scale.textContent).toContain("Ниже вашей маржи");
    expect(scale.textContent).toContain("Выгодно");
    // Суммы видны один раз — в плитках; шкала их не печатает (они только в aria-label).
    expect(scale.textContent).not.toMatch(/\d/);
    expect(scale.querySelector("[role=img]")!.getAttribute("aria-label")).toContain("убыток до");
    expect(screen.queryByText("Допустимое снижение")).toBeNull();
  });

  it("без НМЦК шкалы нет: нечего откладывать от нуля", () => {
    render(<BidEconomicsCard {...base} nmc={null} />);

    expect(screen.queryByTestId("price-scale")).toBeNull();
  });

  it("НМЦК без НДС — границы пересчитываются сразу", () => {
    render(<BidEconomicsCard {...base} />);
    const before = tile("tile-min-price");

    fireEvent.click(screen.getByLabelText("НМЦК с НДС"));

    expect(tile("tile-min-price")).not.toBe(before);
    expect(tile("tile-min-price")).toBeCloseTo(4_114_286, -1);
  });

  it("НМЦК ниже себестоимости — красная пометка", () => {
    render(<BidEconomicsCard {...base} nmc={3_600_000} />);

    expect(screen.getByText("НМЦК ниже себестоимости")).toBeTruthy();
    expect(screen.getByText(/убыточна ещё до снижения/)).toBeTruthy();
  });

  it("цена не объявлена — без таблицы, но с границами; плитка снижения просит НМЦК", () => {
    render(<BidEconomicsCard {...base} nmc={null} />);

    expect(screen.getByText("Цена не объявлена")).toBeTruthy();
    expect(screen.queryByText("Что останется компании при разной цене")).toBeNull();
    expect(tile("tile-break-even")).toBe(4_320_000);
    expect(digits(screen.getByTestId("tile-reduction").textContent)).toBe("СнижатьможнодоукажитеНМЦК");
  });

  it("показатель называется «Надёжность расчёта», а не «Доверие»", () => {
    render(<BidEconomicsCard {...base} />);

    expect(screen.getByText("Надёжность расчёта 100")).toBeTruthy();
    expect(screen.queryByText(/Доверие/)).toBeNull();
  });

  it("запас прочности при НМЦК — одной небольшой строкой под плитками", () => {
    render(<BidEconomicsCard {...base} />);

    // (4 500 000 − 3 600 000) / 3 600 000 = 25 %
    const line = screen.getByTestId("bid-safety").textContent ?? "";
    expect(digits(line)).toContain("ЗапаспрочностиприНМЦК+25,0%");
    expect(line).toContain("на столько могут вырасти затраты до нулевой прибыли");
  });

  it("таблица цен: цена, прибыль, маржа, итог; выручка, затраты, налог и запас — по кнопке «Подробнее»", () => {
    render(<BidEconomicsCard {...base} />);
    const table = screen.getByTestId("price-table");
    const headers = () => within(table).getAllByRole("columnheader").map((th) => th.textContent);

    expect(headers()).toEqual(["Цена", "Прибыль", "Маржа", "Итог"]);
    expect(within(table).getByText(/^70 % · /).closest("tr")!.textContent).toContain("убыток");
    expect(within(table).getByText(/^95 % · /).closest("tr")!.textContent).toContain("выгодно");
    expect(within(table).getByText(/^90 % · /).closest("tr")!.textContent).toContain("ниже маржи");

    fireEvent.click(screen.getByRole("button", { name: /Подробнее: выручка, затраты, налог/ }));

    expect(headers()).toEqual(["Цена", "Выручка", "Затраты", "Налог", "Прибыль", "Маржа", "Запас", "Итог"]);
    // У цены 90 % запас +12,5 %, у убыточной строки — 0.
    expect(digits(within(table).getByText(/^90 % · /).closest("tr")!.textContent)).toContain("+12,5%");
    expect(digits(within(table).getByText(/^70 % · /).closest("tr")!.textContent)).toContain("0,0%");
  });

  it("строка ближе всего к «Моей цене» подсвечена", () => {
    render(<BidEconomicsCard {...base} />);
    expect(screen.getByTestId("price-table").querySelector("[data-closest]")).toBeNull();

    fireEvent.change(screen.getByLabelText("Снижение от НМЦК, %"), { target: { value: "11" } });

    const row = screen.getByTestId("price-table").querySelector("[data-closest]")!;
    expect(row.textContent).toMatch(/^90 % · /);
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("не больше одной пометки на виду; остальные и основа — в «На чём стоят эти числа»", () => {
    render(<BidEconomicsCard {...base} nmc={3_600_000} />);
    expect(screen.getAllByTestId("bid-warning")).toHaveLength(1);
    expect(screen.getByTestId("bid-warning").textContent).toMatch(/убыточна ещё до снижения/);
    const hidden = screen.getByTestId("bid-flags");
    expect(hidden.closest("details")).not.toBeNull();
    expect(hidden.textContent).toContain("НМЦК принята с НДС");
    expect(screen.getByTestId("bid-base-note").closest("details")).not.toBeNull();
  });

  it("44-ФЗ: строки со снижением от 25 % помечены «антидемпинг» с пояснением", () => {
    render(<BidEconomicsCard {...base} law="FZ_44" />);

    const marks = screen.getAllByText("антидемпинг");
    expect(marks).toHaveLength(2);
    expect(marks[0]!.getAttribute("title")).toMatch(/ст\. 37/);
    expect(marks[0]!.closest("tr")!.textContent).toMatch(/^75 %/);
    // Допустимое снижение здесь меньше 25 % — отдельной пометки нет, только значки строк.
    expect(screen.queryByText(/По 44-ФЗ \(ст\. 37\)/)).toBeNull();
  });

  it("44-ФЗ и допустимое снижение от 25 % — пометка про обеспечение показана", () => {
    render(<BidEconomicsCard {...base} nmc={7_200_000} law="FZ_44" />);
    expect(screen.getByText(/По 44-ФЗ \(ст\. 37\)/)).toBeTruthy();
  });

  it("не 44-ФЗ — без пометок антидемпинга", () => {
    render(<BidEconomicsCard {...base} law="FZ_223" />);
    expect(screen.queryByText("антидемпинг")).toBeNull();
  });
});

describe("BidEconomicsCard: НДС из документации", () => {
  const vat = (overrides: Partial<VatStatus>): VatStatus => ({
    includesVat: true,
    basis: "ASSUMPTION",
    quote: null,
    documentName: null,
    conflict: false,
    ...overrides,
  });
  const checkbox = () => screen.getByLabelText("НМЦК с НДС") as HTMLInputElement;

  it("документация говорит «без НДС» — переключатель стоит «без», основание с цитатой и файлом", () => {
    render(
      <BidEconomicsCard
        {...base}
        vat={vat({ includesVat: false, basis: "DOCUMENT", quote: "цена контракта без НДС", documentName: "Извещение.docx" })}
      />,
    );

    expect(checkbox().checked).toBe(false);
    expect(screen.getByTestId("vat-basis").textContent).toBe("из документации: «цена контракта без НДС» (Извещение.docx)");
    expect(tile("tile-min-price")).toBeCloseTo(4_114_286, -1);
  });

  it("44-ФЗ: основание — закон, с оговоркой", () => {
    render(<BidEconomicsCard {...base} vat={vat({ basis: "LAW_44" })} />);

    expect(checkbox().checked).toBe(true);
    expect(screen.getByTestId("vat-basis").textContent).toBe(
      "по 44-ФЗ цена контракта включает налоги — допущение, в документации прямо не указано",
    );
  });

  it("допущение: предупреждение и отдельная пометка выше по странице", () => {
    render(<BidEconomicsCard {...base} vat={vat({ basis: "ASSUMPTION" })} />);

    expect(screen.getByTestId("vat-basis").textContent).toBe("⚠ НДС в документации не определён, принято «с НДС» — проверьте");
    expect(screen.getByText(/НДС в документации не определён: НМЦК принята с НДС 20 %/)).toBeTruthy();
  });

  it("конфликт: просьба проверить вручную", () => {
    render(<BidEconomicsCard {...base} vat={vat({ basis: "LAW_44", conflict: true })} />);

    expect(screen.getByTestId("vat-basis").textContent).toBe("в документации встречаются оба варианта — проверьте вручную");
  });

  it("человек всё ещё может переключить: границы пересчитываются, подпись говорит об изменении", () => {
    render(<BidEconomicsCard {...base} vat={vat({ basis: "DOCUMENT", quote: "цена с учетом НДС", documentName: "Извещение.docx" })} />);
    const before = tile("tile-min-price");

    fireEvent.click(checkbox());

    expect(checkbox().checked).toBe(false);
    expect(tile("tile-min-price")).not.toBe(before);
    expect(screen.getByTestId("vat-basis").textContent).toMatch(/значение изменено вами/);
  });

  it("без vat — «с НДС» по умолчанию и без подписи основания", () => {
    render(<BidEconomicsCard {...base} />);

    expect(checkbox().checked).toBe(true);
    expect(screen.queryByTestId("vat-basis")).toBeNull();
  });
});
