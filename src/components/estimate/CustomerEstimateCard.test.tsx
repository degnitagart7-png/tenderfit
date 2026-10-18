import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CustomerEstimateCard } from "@/components/estimate/CustomerEstimateCard";
import type { CustomerEstimate } from "@/domain/estimate/customerEstimate";
import type { EstimateDocument } from "@/domain/estimate/types";

afterEach(cleanup);

function documentOf(lines: readonly { section: string | null | undefined; direct: number }[]): EstimateDocument {
  const rows = lines.map((line, index) => ({
    itemId: `i${String(index)}`,
    directCost: line.direct,
    overheadCost: 0,
    profitCost: 0,
    ...(line.section === undefined ? {} : { billSection: line.section }),
  }));
  return {
    sections: [{ title: "Документ", lines: rows }],
    totals: { workCost: rows.reduce((total, row) => total + row.directCost, 0) },
    gaps: [],
  } as unknown as EstimateDocument;
}

function estimateOf(
  sections: readonly { title: string; amount: number }[],
  overrides: Partial<CustomerEstimate> = {},
): CustomerEstimate {
  const total = sections.reduce((sum, s) => sum + s.amount, 0);
  return {
    documentName: "ЛСР.xlsx",
    estimateName: "701-702",
    sections: sections.map((s) => ({ number: null, title: s.title, amount: s.amount, quote: s.title })),
    sectionsTotal: total,
    statedTotal: total,
    totalIncludesVat: false,
    checked: true,
    priceLevel: { zone: null, quarter: null, year: null },
    method: "RESOURCE_2022",
    ...overrides,
  };
}

/** Деньги печатаются с узким неразрывным пробелом: сравниваем без пробелов. */
const digits = (text: string | null | undefined): string => (text ?? "").replace(/\s/g, "");

const OURS = documentOf([
  { section: "Демонтаж", direct: 1_200_000 },
  { section: "Ремонт", direct: 600_000 },
  { section: "Особые работы", direct: 300_000 },
]);

const CUSTOMER = estimateOf([
  { title: "Демонтаж", amount: 1_000_000 },
  { title: "Ремонт", amount: 1_000_000 },
  { title: "Оборудование", amount: 500_000 },
]);

describe("CustomerEstimateCard", () => {
  it("таблица по разделам: суммы, разница и пометки", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[CUSTOMER]} />);

    expect(screen.getByText("Сравнение со сметой заказчика")).toBeTruthy();
    const demolition = screen.getByText("Демонтаж").closest("tr")!;
    expect(digits(demolition.textContent)).toBe("Демонтаж1000000₽1200000₽+200000₽+20,0%заказчикзаложилменьшетекущихцен—риск");
    const repair = screen.getByText("Ремонт").closest("tr")!;
    expect(digits(repair.textContent)).toContain("−400000₽−40,0%");
    expect(repair.textContent).toContain("у заказчика запас");
    const missing = screen.getByText("Оборудование").closest("tr")!;
    expect(digits(missing.textContent)).toBe("Оборудование500000₽———унаснетпозицийэтогораздела");
  });

  it("строка итога по сопоставленным разделам", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[CUSTOMER]} />);

    const total = screen.getByText("Итого по сопоставленным разделам").closest("tr")!;
    // 2 000 000 у заказчика против 1 800 000 у нас: −10 %, ещё «близко».
    expect(digits(total.textContent)).toContain("2000000₽1800000₽−200000₽−10,0%близко");
  });

  it("свёрнутые списки: разделы заказчика без наших позиций и наши позиции вне разделов", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[CUSTOMER]} />);

    expect(screen.getByText("Разделы заказчика без наших позиций")).toBeTruthy();
    expect(screen.getByText(/Оборудование: 500\s000\s₽/)).toBeTruthy();
    expect(digits(screen.getByText(/Наши позиции вне разделов заказчика/).textContent)).toBe(
      "Нашипозициивнеразделовзаказчика:1на300000₽",
    );
  });

  it("источник: файл, лист, итог и сверка сошлась", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[CUSTOMER]} />);

    expect(screen.getByText(/ЛСР\.xlsx · 701-702: итог/)).toBeTruthy();
    expect(screen.getByTestId("verification").textContent).toBe("✓ сумма разделов сходится с итогом сметы");
  });

  it("итог с НДС: проверка сошлась, и это сказано", () => {
    render(
      <CustomerEstimateCard
        document={OURS}
        estimates={[estimateOf([{ title: "Демонтаж", amount: 1_000_000 }], { totalIncludesVat: true, statedTotal: 1_220_000 })]}
      />,
    );
    expect(screen.getByTestId("verification").textContent).toBe(
      "✓ сумма разделов сходится с итогом сметы (итог указан с НДС)",
    );
    expect(screen.getByText(/\(с НДС\)/)).toBeTruthy();
  });

  it("итог не сошёлся — предупреждение о колонке", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[{ ...CUSTOMER, checked: false }]} />);

    expect(screen.getByTestId("verification").textContent).toBe(
      "⚠ итог сметы не сошёлся с разделами — суммы могли быть прочитаны не из той колонки, проверьте",
    );
  });

  it("итога в тексте нет (обрезанный документ) — не «не сошёлся», а «не найден»", () => {
    render(
      <CustomerEstimateCard
        document={OURS}
        estimates={[{ ...CUSTOMER, checked: false, statedTotal: null, totalIncludesVat: null }]}
      />,
    );

    expect(screen.getByTestId("verification").textContent).toBe(
      "⚠ итог сметы в тексте не найден (документ мог быть обрезан) — суммы разделов не сверены",
    );
    expect(screen.queryByText(/не сошёлся/)).toBeNull();
  });

  it("у разных смет разные причины — обе строки", () => {
    render(
      <CustomerEstimateCard
        document={OURS}
        estimates={[
          { ...CUSTOMER, documentName: "А.xlsx", checked: false },
          { ...CUSTOMER, documentName: "Б.xlsx", checked: false, statedTotal: null, totalIncludesVat: null },
        ]}
      />,
    );

    expect(screen.getByText(/итог сметы не сошёлся с разделами/)).toBeTruthy();
    expect(screen.getByText(/итог сметы в тексте не найден \(документ мог быть обрезан\)/)).toBeTruthy();
  });

  it("уровень цен заказчика показан, если он известен", () => {
    render(
      <CustomerEstimateCard
        document={OURS}
        estimates={[{ ...CUSTOMER, priceLevel: { zone: 2, quarter: 3, year: 2026 } }]}
      />,
    );
    expect(screen.getByText(/уровень цен заказчика: 2 зона, 3 кв\. 2026/)).toBeTruthy();
  });

  it("расчёт без разделов документа: просьба пересчитать и сравнение только итогов", () => {
    const legacy = documentOf([{ section: undefined, direct: 1_500_000 }]);
    render(<CustomerEstimateCard document={legacy} estimates={[CUSTOMER]} />);

    expect(screen.getByText(/посчитана до появления сравнения по разделам — пересчитайте/)).toBeTruthy();
    expect(screen.queryByText("Итого по сопоставленным разделам")).toBeNull();
    // Σ разделов заказчика 2 500 000 против 1 500 000 у нас.
    expect(digits(screen.getByTestId("overall").textContent)).toContain("2500000₽·нашрасчёт1500000₽·разница−1000000₽(−40,0%)");
  });

  it("смета в базисных ценах 2001 г. — по разделам не сравнивается", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[{ ...CUSTOMER, method: "BASE_2001" }]} />);

    expect(
      screen.getByText(
        "Смета заказчика составлена в базисных ценах 2001 г. или по территориальной базе (ТЕР/ФЕР/ТСН) — по разделам с текущими ценами ФСНБ-2022 не сравнить.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("расчёт, где поле раздела есть, но пусто: «разделов нет — сравниваем только итоги»", () => {
    const noSections = documentOf([{ section: null, direct: 1_500_000 }]);
    render(<CustomerEstimateCard document={noSections} estimates={[CUSTOMER]} />);

    expect(
      screen.getByText("В документах, по которым считались объёмы, разделов нет — сравниваем только итоги."),
    ).toBeTruthy();
    expect(screen.queryByText(/пересчитайте/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(digits(screen.getByTestId("overall").textContent)).toContain("2500000₽·нашрасчёт1500000₽");
  });

  it("список смет: первые 5 участвующих и «и ещё N»; базисные — свёрнутой строкой", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      estimateOf([{ title: "Демонтаж", amount: 1_000 }], { documentName: `Смета ${String(index + 1)}.xlsx`, estimateName: null }),
    );
    const base = Array.from({ length: 3 }, (_, index) =>
      estimateOf([{ title: "Демонтаж", amount: 1_000 }], {
        documentName: `Базисная ${String(index + 1)}.xlsx`,
        estimateName: null,
        method: "BASE_2001",
      }),
    );
    render(<CustomerEstimateCard document={OURS} estimates={[...many, ...base]} />);

    expect(screen.getByText(/Смета 5\.xlsx: итог/)).toBeTruthy();
    expect(screen.queryByText(/Смета 6\.xlsx: итог/)).toBeNull();
    expect(screen.getByText("и ещё 3")).toBeTruthy();
    expect(screen.getByText("Не сравниваются (базисные цены): 3")).toBeTruthy();
    // Базисные видны только внутри свёрнутой строки.
    expect(screen.getByText("Не сравниваются (базисные цены): 3").closest("details")).not.toBeNull();
  });

  it("выпавшие позиции раздела: у пары — второй строкой, у раздела без пары — другой вывод", () => {
    const withGaps = {
      ...OURS,
      gaps: [
        { kind: "NO_NORM", message: "а", code: null, baseType: null, billSection: "Демонтаж" },
        { kind: "NO_NORM", message: "б", code: null, baseType: null, billSection: "Оборудование" },
        { kind: "NO_NORM", message: "в", code: null, baseType: null, billSection: "Оборудование" },
      ],
    } as unknown as EstimateDocument;
    render(<CustomerEstimateCard document={withGaps} estimates={[CUSTOMER]} />);

    expect(screen.getByText("1 поз. не посчитано — разница может быть из-за этого")).toBeTruthy();
    expect(screen.getByText("у нас нет посчитанных позиций, но 2 выпали из расчёта")).toBeTruthy();
  });

  it("в смете заказчика только итоги — разделов нет", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[estimateOf([], { statedTotal: 500_000, checked: false })]} />);

    expect(screen.getByText(/найдены только итоги, разделов нет/)).toBeTruthy();
    expect(screen.queryByTestId("verification")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("пустой массив — короткая строка, а не пустой блок", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[]} />);

    expect(screen.getByText("Смета заказчика в документации не найдена — сравнивать не с чем.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("CustomerEstimateCard: сверка объёмов", () => {
  const FINDING = {
    workName: "Разборка зданий",
    billQuantity: 600,
    billUnit: "м3",
    customerQuantity: 581.63,
    customerUnit: "м3",
    diffPercent: 3.2,
    customerDocument: "ЛСР.pdf",
    message: "В ведомости 600 м3, в смете заказчика 581,63 м3 — «Разборка зданий», расхождение 3,2 %",
  };

  it("находки показываются под таблицей разделов и помечены как не влияющие на сумму", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[CUSTOMER]} volumeFindings={[FINDING]} />);

    const block = screen.getByTestId("volume-findings");
    expect(block).toHaveTextContent("Объёмы ведомости расходятся со сметой заказчика: 1");
    expect(block).toHaveTextContent("В ведомости 600 м3, в смете заказчика 581,63 м3");
    expect(block).toHaveTextContent("На сумму расчёта не влияет");
  });

  it("находки видны и когда смету заказчика построчно прочитать не удалось", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[]} volumeFindings={[FINDING]} />);

    expect(screen.getByText(/Смета заказчика в документации не найдена/)).toBeInTheDocument();
    expect(screen.getByTestId("volume-findings")).toBeInTheDocument();
  });

  it("без находок блока нет", () => {
    render(<CustomerEstimateCard document={OURS} estimates={[CUSTOMER]} />);

    expect(screen.queryByTestId("volume-findings")).toBeNull();
  });

  it("работа ведомости, которой нет в смете заказчика, — отдельный блок; блок расхождений не появляется", () => {
    const only = {
      ...FINDING,
      kind: "BILL_ONLY" as const,
      customerQuantity: 0,
      customerUnit: "",
      customerDocument: null,
      message: "Работа есть в ведомости, но нет в смете заказчика: «Окраска», 40 м2 — проверьте",
    };
    render(<CustomerEstimateCard document={OURS} estimates={[CUSTOMER]} volumeFindings={[only]} />);

    const block = screen.getByTestId("volume-findings-bill-only");
    expect(block).toHaveTextContent("Работы ведомости, которых нет в смете заказчика: 1");
    expect(block).toHaveTextContent("Работа есть в ведомости, но нет в смете заказчика: «Окраска»");
    expect(screen.queryByTestId("volume-findings")).toBeNull();
  });
});


describe("CustomerEstimateCard: сравнение по каждой ЛСР", () => {
  const LSRS = [
    { key: "02-02-08", number: "02-02-08", title: "Вентиляция", sectionTitle: "ЛСР 02-02-08. Вентиляция", documentName: "Описание объекта закупки", documents: ["Обоснование НМЦК", "Описание объекта закупки"], totalWithVat: 1_135_429.59, totalExVat: 930_679.99, sharedNumber: false, positions: 13, subPositions: 14 },
    { key: "02-02-12", number: "02-02-12", title: "Желоб", sectionTitle: "ЛСР 02-02-12. Желоб", documentName: "Описание объекта закупки", documents: ["Описание объекта закупки"], totalWithVat: 52_622.66, totalExVat: 43_133.33, sharedNumber: false, positions: 2, subPositions: 4 },
  ];
  const DOC = {
    sections: [{ title: "ЛСР 02-02-08. Вентиляция", workCost: 898_163.19, lines: new Array(27).fill({ directCost: 0 }) }],
    totals: { workCost: 898_163.19 },
    gaps: [],
  } as unknown as EstimateDocument;

  it("таблица: у заказчика, у нас, разница, %, пометка; раздела без пары называет", () => {
    render(<CustomerEstimateCard document={DOC} estimates={[]} lsrs={LSRS} />);

    // Смет заказчика с разделами нет, но сравнение по ЛСР показывается.
    const table = screen.getByTestId("lsr-comparison");
    expect(table).toHaveTextContent("ЛСР 02-02-08. Вентиляция");
    expect(table).toHaveTextContent("930 680");
    expect(table).toHaveTextContent("898 163");
    expect(table).toHaveTextContent("−3,5 %");
    expect(table).toHaveTextContent("найдена в 2 документах, взята из «Описание объекта закупки»");
    expect(table).toHaveTextContent("в нашей смете раздела этой ЛСР нет");
  });

  it("без ЛСР таблицы нет", () => {
    render(<CustomerEstimateCard document={DOC} estimates={[CUSTOMER]} />);

    expect(screen.queryByTestId("lsr-comparison")).toBeNull();
  });
});
