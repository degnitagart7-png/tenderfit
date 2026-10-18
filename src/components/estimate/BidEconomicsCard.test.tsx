import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function figure(label: string): string {
  const term = screen.getByText(label);
  return digits(term.nextElementSibling?.textContent);
}

describe("BidEconomicsCard", () => {
  it("показывает минимальную цену и допустимое снижение", () => {
    render(<BidEconomicsCard {...base} />);

    expect(figure("Минимальная цена")).toMatch(/^49371\d\d₽$/);
    expect(figure("Допустимое снижение")).toBe("8,6%");
    expect(screen.getByText("НМЦК выше расчёта")).toBeTruthy();
  });

  it("шкала цены: три зоны и подписи с суммами, а не россыпь цифр", () => {
    render(<BidEconomicsCard {...base} />);

    const scale = screen.getByTestId("price-scale");
    expect(scale.textContent).toContain("Убыток");
    expect(scale.textContent).toContain("Ниже вашей маржи");
    expect(scale.textContent).toContain("Выгодно");
    // Граница «выгодно» — та же минимальная цена, что в цифре выше.
    expect(digits(scale.textContent)).toContain(figure("Минимальная цена").replace("₽", ""));
  });

  it("без НМЦК шкалы нет: нечего откладывать от нуля", () => {
    render(<BidEconomicsCard {...base} nmc={null} />);

    expect(screen.queryByTestId("price-scale")).toBeNull();
  });

  it("НМЦК без НДС — границы пересчитываются сразу", () => {
    render(<BidEconomicsCard {...base} />);
    const before = figure("Минимальная цена");

    fireEvent.click(screen.getByLabelText("НМЦК с НДС"));

    expect(figure("Минимальная цена")).not.toBe(before);
    expect(figure("Минимальная цена")).toMatch(/^41142\d\d₽$/);
  });

  it("НМЦК ниже себестоимости — красная пометка", () => {
    render(<BidEconomicsCard {...base} nmc={3_600_000} />);

    expect(screen.getByText("НМЦК ниже себестоимости")).toBeTruthy();
    expect(screen.getByText(/убыточна ещё до снижения/)).toBeTruthy();
  });

  it("цена не объявлена — без таблицы, но с границами", () => {
    render(<BidEconomicsCard {...base} nmc={null} />);

    expect(screen.getByText("Цена не объявлена")).toBeTruthy();
    expect(screen.queryByText("Что останется компании при разной цене")).toBeNull();
    expect(figure("Безубыточная цена")).toMatch(/^43200\d\d₽$/);
  });

  it("показатель называется «Надёжность расчёта», а не «Доверие»", () => {
    render(<BidEconomicsCard {...base} />);

    expect(screen.getByText("Надёжность расчёта 100")).toBeTruthy();
    expect(screen.queryByText(/Доверие/)).toBeNull();
  });

  it("запас прочности при НМЦК — рядом с главными цифрами, с пояснением", () => {
    render(<BidEconomicsCard {...base} />);

    // (4 500 000 − 3 600 000) / 3 600 000 = 25 %
    expect(figure("Запас прочности при НМЦК")).toBe("+25,0%");
    expect(screen.getByText("на столько могут вырасти затраты до нулевой прибыли")).toBeTruthy();
  });

  it("в таблице цен есть колонка «Запас»: у цены 90 % — +12,5 %, у убыточной строки — 0", () => {
    render(<BidEconomicsCard {...base} />);

    expect(screen.getByText("Запас")).toBeTruthy();
    const row90 = screen.getByText(/^90 % · /).closest("tr")!;
    expect(digits(row90.textContent)).toContain("+12,5%");
    const row70 = screen.getByText(/^70 % · /).closest("tr")!;
    expect(digits(row70.textContent)).toContain("0,0%убыток");
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
    expect(figure("Минимальная цена")).toMatch(/^41142\d\d₽$/);
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
    const before = figure("Минимальная цена");

    fireEvent.click(checkbox());

    expect(checkbox().checked).toBe(false);
    expect(figure("Минимальная цена")).not.toBe(before);
    expect(screen.getByTestId("vat-basis").textContent).toMatch(/значение изменено вами/);
  });

  it("без vat — «с НДС» по умолчанию и без подписи основания", () => {
    render(<BidEconomicsCard {...base} />);

    expect(checkbox().checked).toBe(true);
    expect(screen.queryByTestId("vat-basis")).toBeNull();
  });
});
