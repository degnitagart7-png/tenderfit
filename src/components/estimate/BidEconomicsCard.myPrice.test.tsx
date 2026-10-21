import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveBytes = vi.fn();
vi.mock("@/lib/downloadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/downloadFile")>()),
  saveBytes: (...args: unknown[]) => saveBytes(...args),
}));

import { BidEconomicsCard } from "@/components/estimate/BidEconomicsCard";
import type { BidCostBase } from "@/domain/estimate/bidEconomics";
import { DEFAULT_COST_PROFILE } from "@/domain/estimate/companyCostProfile";
import type { EstimateDocument } from "@/domain/estimate/types";

/*
  «Экономика участия» и «Моя цена» на экране. Смета: прямые затраты 3 000 000 (труд 600 000, машины 400 000, материалы 1 500 000,
  прочие 500 000), накладные 600 000, итог 4 000 000, НДС 20 %; НМЦК 5 400 000 с НДС; ОСНО, маржа 10 %.
*/

beforeEach(() => saveBytes.mockClear());
afterEach(cleanup);

const document = {
  parameters: { vatPercent: 20 },
  sections: [{ lines: [{ labourCost: 600_000, machineCost: 400_000, materialCost: 1_500_000 }] }],
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

const digits = (text: string | null | undefined): string => (text ?? "").replace(/\s/g, "");

describe("плитки «Экономика участия»", () => {
  const tileText = (id: string): string => digits(screen.getByTestId(id).textContent);

  it("безубыточно от · с маржой от · снижать можно до", () => {
    render(<BidEconomicsCard {...base} />);

    expect(tileText("tile-break-even")).toBe("Безубыточноот4,32млн₽");
    expect(tileText("tile-min-price")).toBe("Смаржой10%—от4,94млн₽");
    expect(tileText("tile-reduction")).toBe("Снижатьможнодо8,6%отНМЦК");
  });

  it("без НМЦК плитка снижения просит НМЦК; есть поле НМЦК: введёшь — появится допустимое снижение", () => {
    render(<BidEconomicsCard {...base} nmc={null} />);
    expect(tileText("tile-reduction")).toContain("укажитеНМЦК");

    fireEvent.change(screen.getByLabelText("НМЦК, ₽"), { target: { value: "5 400 000" } });

    expect(tileText("tile-reduction")).toBe("Снижатьможнодо8,6%отНМЦК");
  });

  it("маржа в профиле не задана (0): расчёт берёт 10 % и говорит об этом в «На чём стоят эти числа»", () => {
    render(<BidEconomicsCard {...base} minMarginPercent={0} />);
    expect(screen.getByTestId("bid-base-note").textContent).toContain("принята по умолчанию");
    expect(tileText("tile-min-price")).toContain("маржой10%");
  });

  it("основа названа: наша смета или смета заказчика", () => {
    render(<BidEconomicsCard {...base} />);
    expect(screen.getByTestId("bid-base-note").textContent).toContain("наша смета по ведомости");
    cleanup();
    const costBase: BidCostBase = { labour: 600_000, machines: 400_000, materials: 1_500_000, other: 500_000, overhead: 600_000, profit: 400_000, limited: 0, beforeVat: 4_000_000, vatPercent: 20, origin: "AUDIT" };
    render(<BidEconomicsCard {...base} document={undefined} costBase={costBase} notes={["НМЦК — цена закупки."]} />);
    expect(screen.getByTestId("bid-base-note").textContent).toContain("смета заказчика, пересчитанная");
    expect(screen.getByText("НМЦК — цена закупки.").closest("details")).not.toBeNull();
  });

  it("суммы не переносятся: плитки и ячейки денег с whitespace-nowrap и tabular-nums", () => {
    render(<BidEconomicsCard {...base} />);
    expect(screen.getByTestId("tile-break-even").querySelector(".whitespace-nowrap.tabular-nums")).not.toBeNull();
    expect(screen.getByTestId("price-table").querySelector("td.whitespace-nowrap.tabular-nums")).not.toBeNull();
    // Таблица прокручивается внутри своего контейнера, а не растягивает страницу.
    expect(screen.getByTestId("price-table").querySelector(".overflow-x-auto")).not.toBeNull();
    expect(screen.getByTestId("tile-break-even").parentElement!.className).toContain("grid-cols-1");
  });
});

describe("«Моя цена»", () => {

  it("пока цены нет — подсказка, без цифр", () => {
    render(<BidEconomicsCard {...base} />);
    expect(screen.getByTestId("my-price-empty")).toBeTruthy();
    expect(screen.queryByTestId("my-price-result")).toBeNull();
  });

  it("быстрые кнопки −5, −10, −15, −20, −25 %", () => {
    render(<BidEconomicsCard {...base} />);
    const buttons = within(screen.getByRole("group", { name: "Быстрый выбор снижения" })).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["−5 %", "−10 %", "−15 %", "−20 %", "−25 %"]);
  });

  it("−5 %: одна яркая строка «При … (−5 %): прибыль … · маржа … — выгодно», детали мельче", () => {
    render(<BidEconomicsCard {...base} />);

    fireEvent.click(screen.getByRole("button", { name: "−5 %" }));

    const line = digits(screen.getByTestId("my-price-line").textContent);
    expect(line).toBe("При5130000₽(−5%):прибыль540000₽·маржа12,6%—выгодно");
    const details = digits(screen.getByTestId("my-price-details").textContent);
    expect(details).toContain("Выручка4275000₽");
    expect(details).toContain("себестоимость3600000₽");
    expect(details).toContain("налог135000₽");
    expect(digits(screen.getByTestId("my-price-profit").textContent)).toBe("540000₽");
    expect(screen.getByTestId("my-price-margin").textContent).toMatch(/^12,6\s%$/);
    expect(screen.getByTestId("my-price-verdict").textContent).toBe("выгодно");
    // Второе поле показывает пересчёт: цена в рублях.
    expect(digits((screen.getByLabelText("Моя цена, ₽") as HTMLInputElement).value)).toBe("5130000");
  });

  it("−10 %: прибыль есть, но маржа ниже цели — «ниже вашей цели»", () => {
    render(<BidEconomicsCard {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "−10 %" }));

    expect(screen.getByTestId("my-price-verdict").textContent).toBe("ниже вашей цели");
    expect(digits(screen.getByTestId("my-price-line").textContent)).toContain("При4860000₽(−10%)");
    expect(screen.getByTestId("my-price-details").textContent).toContain("цель по марже 10 %");
  });

  it("−25 %: убыток; для закона, который не известен, антидемпинг показан условно", () => {
    render(<BidEconomicsCard {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "−25 %" }));

    expect(screen.getByTestId("my-price-verdict").textContent).toBe("убыток");
    // Знак минус в Intl зависит от версии ICU («-» или «−»): сравнивается число.
    expect(digits(screen.getByTestId("my-price-profit").textContent).replace("−", "-")).toBe("-225000₽");
    expect(screen.getByTestId("my-price-antidumping").textContent).toContain("Если закупка по 44-ФЗ");
  });

  it("44-ФЗ: антидемпинг без «если», и ровно с 25 %; на −20 % его нет", () => {
    render(<BidEconomicsCard {...base} law="FZ_44" />);

    fireEvent.click(screen.getByRole("button", { name: "−20 %" }));
    expect(screen.queryByTestId("my-price-antidumping")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "−25 %" }));
    const note = screen.getByTestId("my-price-antidumping").textContent ?? "";
    expect(note).toContain("44-ФЗ, ст. 37");
    expect(note).not.toContain("Если закупка");
    expect(note).toContain("1,5 раза");
  });

  it("223-ФЗ: при −25 % антидемпинговой меры нет", () => {
    render(<BidEconomicsCard {...base} law="FZ_223" />);
    fireEvent.click(screen.getByRole("button", { name: "−25 %" }));
    expect(screen.queryByTestId("my-price-antidumping")).toBeNull();
  });

  it("ввод цены в рублях обновляет проценты, и числа меняются при каждом вводе", () => {
    render(<BidEconomicsCard {...base} />);
    const priceInput = screen.getByLabelText("Моя цена, ₽");

    fireEvent.change(priceInput, { target: { value: "4 860 000" } });
    expect((screen.getByLabelText("Снижение от НМЦК, %") as HTMLInputElement).value).toBe("10");
    const first = digits(screen.getByTestId("my-price-profit").textContent);

    fireEvent.change(priceInput, { target: { value: "5 130 000" } });
    expect((screen.getByLabelText("Снижение от НМЦК, %") as HTMLInputElement).value).toBe("5");
    expect(digits(screen.getByTestId("my-price-profit").textContent)).not.toBe(first);
  });

  it("ввод процента с запятой; мусор вместо числа — пустой результат, а не падение", () => {
    render(<BidEconomicsCard {...base} />);
    const percentInput = screen.getByLabelText("Снижение от НМЦК, %");

    fireEvent.change(percentInput, { target: { value: "7,5" } });
    expect(digits((screen.getByLabelText("Моя цена, ₽") as HTMLInputElement).value)).toBe("4995000");
    fireEvent.change(percentInput, { target: { value: "abc" } });
    expect(screen.getByTestId("my-price-empty")).toBeTruthy();
  });

  it("цена выше НМЦК — предупреждение", () => {
    render(<BidEconomicsCard {...base} />);
    fireEvent.change(screen.getByLabelText("Моя цена, ₽"), { target: { value: "6000000" } });
    expect(screen.getByTestId("my-price-above").textContent).toContain("не принимается");
  });

  it("НМЦК не объявлена: цена в рублях считается, поле процентов закрыто", () => {
    render(<BidEconomicsCard {...base} nmc={null} />);
    expect(screen.getByLabelText("Снижение от НМЦК, %")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Моя цена, ₽"), { target: { value: "4800000" } });
    expect(screen.getByTestId("my-price-result")).toBeTruthy();
  });
});

describe("профиль затрат в блоке", () => {
  const field = (label: RegExp): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;

  it("свёрнут и подписан «как в смете»; поправка пересчитывает границы и сообщает о сохранении", () => {
    const onChange = vi.fn();
    render(<BidEconomicsCard {...base} onCostProfileChange={onChange} />);
    const before = digits(screen.getByTestId("bid-headline").textContent);
    expect(screen.getByTestId("cost-profile").textContent).toContain("как в смете");

    fireEvent.change(field(/Скидка на материалы к сметным ценам/), { target: { value: "20" } });

    expect(digits(screen.getByTestId("bid-headline").textContent)).not.toBe(before);
    expect(screen.getByTestId("cost-profile").textContent).toContain("поправки применены");
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_COST_PROFILE, materialDiscountPercent: 20 });
    expect(screen.getByTestId("bid-base-note").textContent).toContain("ниже сметной");
  });

  it("профиль из компании применяется сразу: безубыточная цена ниже сметной", () => {
    render(<BidEconomicsCard {...base} costProfile={{ ...DEFAULT_COST_PROFILE, materialDiscountPercent: 20 }} />);
    // материалы 1 200 000 вместо 1 500 000: затраты 3 300 000 → цена без НДС 3 300 000 → с НДС 3 960 000
    expect(screen.getByTestId("tile-break-even").getAttribute("data-value")).toBe("3960000");
  });

  it("значение вне границ подсвечено, в расчёте — граница; пустое поле не ломает ввод", () => {
    const onChange = vi.fn();
    render(<BidEconomicsCard {...base} onCostProfileChange={onChange} />);

    fireEvent.change(field(/Ваш труд к сметному/), { target: { value: "500" } });
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("От 30 до 250"))).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_COST_PROFILE, labourFactorPercent: 250 });

    onChange.mockClear();
    fireEvent.change(field(/Ваш труд к сметному/), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent === "Введите число")).toBe(true);
  });

  it("«Вернуть как в смете» возвращает нейтральный профиль", () => {
    const onChange = vi.fn();
    render(<BidEconomicsCard {...base} costProfile={{ ...DEFAULT_COST_PROFILE, labourFactorPercent: 70 }} onCostProfileChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Вернуть как в смете" }));

    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_COST_PROFILE);
    expect(screen.getByTestId("cost-profile").textContent).toContain("как в смете");
  });

  it("у каждого поля есть пояснение простым языком", () => {
    render(<BidEconomicsCard {...base} />);
    const editor = screen.getByTestId("cost-profile-editor");
    expect(within(editor).getAllByRole("spinbutton")).toHaveLength(6);
    expect(editor.textContent).toContain("скидки поставщиков");
    expect(editor.textContent).toContain("своя техника обычно дешевле аренды");
  });
});

describe("скачивание Excel", () => {
  it("кнопка есть; нажатие собирает книгу и отдаёт файл с именем объекта и типом xlsx", async () => {
    render(<BidEconomicsCard {...base} subject="Ремонт школы" />);
    fireEvent.click(screen.getByRole("button", { name: "−10 %" }));

    fireEvent.click(screen.getByRole("button", { name: /Скачать расчёт \(Excel\)/ }));

    await waitFor(() => expect(saveBytes).toHaveBeenCalledTimes(1));
    const [bytes, fileName, mime] = saveBytes.mock.calls[0] as [Uint8Array, string, string];
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(fileName).toMatch(/^Расчёт цены участия Ремонт школы от \d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});
