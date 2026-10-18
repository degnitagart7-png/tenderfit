import { describe, expect, it } from "vitest";

import {
  compareWithCustomerEstimate,
  CLOSE_PERCENT,
  rowDroppedNote,
  rowNote,
} from "@/domain/estimate/customerComparison";
import type { CustomerEstimate, CustomerSection } from "@/domain/estimate/customerEstimate";
import type { EstimateDocument, EstimateGap } from "@/domain/estimate/types";

/*
  Числа выбраны так, чтобы проверяться в уме: стоимость строки — прямые затраты +
  накладные + сметная прибыль, без НДС.
*/

interface LineSpec {
  readonly section: string | null | undefined;
  readonly direct: number;
  readonly overhead?: number;
  readonly profit?: number;
}

function documentOf(specs: readonly LineSpec[], gaps: readonly EstimateGap[] = []): EstimateDocument {
  const lines = specs.map((spec, index) => ({
    itemId: `i${String(index)}`,
    directCost: spec.direct,
    overheadCost: spec.overhead ?? 0,
    profitCost: spec.profit ?? 0,
    ...(spec.section === undefined ? {} : { billSection: spec.section }),
  }));
  const workCost = lines.reduce((total, line) => total + line.directCost + line.overheadCost + line.profitCost, 0);
  return {
    sections: [{ title: "Документ", lines }],
    totals: { workCost },
    gaps,
  } as unknown as EstimateDocument;
}

function section(title: string, amount: number): CustomerSection {
  return { number: null, title, amount, quote: title };
}

function estimateOf(
  sections: readonly CustomerSection[],
  overrides: Partial<CustomerEstimate> = {},
): CustomerEstimate {
  const total = sections.reduce((sum, s) => sum + s.amount, 0);
  return {
    documentName: "Смета.xlsx",
    estimateName: null,
    sections,
    sectionsTotal: total,
    statedTotal: total,
    totalIncludesVat: false,
    checked: true,
    priceLevel: { zone: null, quarter: null, year: null },
    method: "RESOURCE_2022",
    ...overrides,
  };
}

describe("compareWithCustomerEstimate: статусы", () => {
  const doc = documentOf([{ section: "Монтаж", direct: 100 }]);

  it("смет заказчика нет", () => {
    const result = compareWithCustomerEstimate(doc, []);
    expect(result.status).toBe("NO_CUSTOMER_ESTIMATE");
    expect(result.rows).toEqual([]);
    expect(result.overall).toBeNull();
  });

  it("сметы есть, а разделов в них нет — только итоги", () => {
    const result = compareWithCustomerEstimate(doc, [estimateOf([], { statedTotal: 500 })]);
    expect(result.status).toBe("NO_SECTIONS");
    expect(result.rows).toEqual([]);
    expect(result.estimates[0]?.statedTotal).toBe(500);
  });

  it("все сметы в базисных ценах 2001 г. — по разделам не сравниваются, но перечислены", () => {
    const base = estimateOf([section("Монтаж", 100)], { method: "BASE_2001", estimateName: "ТЕР" });
    const result = compareWithCustomerEstimate(doc, [base]);

    expect(result.status).toBe("BASE_PRICES_ONLY");
    expect(result.rows).toEqual([]);
    expect(result.baseEstimates).toHaveLength(1);
    expect(result.baseEstimates[0]?.estimateName).toBe("ТЕР");
    expect(result.estimates).toEqual([]);
  });

  it("у ВСЕХ строк поля раздела нет вовсе (старая смета) — LEGACY, но итоги сравниваются", () => {
    const legacy = documentOf([{ section: undefined, direct: 700 }, { section: undefined, direct: 300 }]);
    const result = compareWithCustomerEstimate(legacy, [estimateOf([section("Монтаж", 800)])]);

    expect(result.status).toBe("LEGACY_ESTIMATE");
    expect(result.rows).toEqual([]);
    expect(result.overall).toEqual({
      customerAmount: 800,
      ourAmount: 1000,
      diff: 200,
      diffPercent: 25,
      verdict: "OURS_HIGHER",
    });
  });

  it("поле есть, но везде null или пусто — NO_OUR_SECTIONS, итоги тоже сравниваются", () => {
    for (const empty of [null, "", "  "]) {
      const noSections = documentOf([{ section: empty, direct: 700 }, { section: null, direct: 300 }]);
      const result = compareWithCustomerEstimate(noSections, [estimateOf([section("Монтаж", 800)])]);

      expect(result.status).toBe("NO_OUR_SECTIONS");
      expect(result.rows).toEqual([]);
      expect(result.overall).toMatchObject({ customerAmount: 800, ourAmount: 1000, diff: 200, verdict: "OURS_HIGHER" });
    }
  });

  it("смесь старых и новых строк: раз поле хоть где-то есть, это уже не LEGACY", () => {
    const mixed = documentOf([{ section: undefined, direct: 700 }, { section: null, direct: 300 }]);
    expect(compareWithCustomerEstimate(mixed, [estimateOf([section("Монтаж", 800)])]).status).toBe("NO_OUR_SECTIONS");
  });

  it("OK: есть и разделы заказчика, и наши", () => {
    expect(compareWithCustomerEstimate(doc, [estimateOf([section("Монтаж", 100)])]).status).toBe("OK");
  });

  it("смета в базисных ценах рядом с обычной не мешает: по разделам идёт только обычная", () => {
    const result = compareWithCustomerEstimate(doc, [
      estimateOf([section("Монтаж", 100)]),
      estimateOf([section("Монтаж", 9_999)], { method: "BASE_2001" }),
    ]);

    expect(result.status).toBe("OK");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.customerAmount).toBe(100);
    expect(result.baseEstimates).toHaveLength(1);
  });
});

describe("compareWithCustomerEstimate: сопоставление", () => {
  it("по равенству нормализованных названий: регистр, «Раздел N.», ё, пунктуация", () => {
    const ours = documentOf([
      { section: "Раздел 1. Ёлочные работы", direct: 1_000 },
      { section: "РЕМОНТНЫЕ  работы", direct: 2_000, overhead: 300, profit: 200 },
    ]);
    const result = compareWithCustomerEstimate(ours, [
      estimateOf([section("Елочные работы", 1_000), section("Ремонтные работы.", 2_500)]),
    ]);

    expect(result.rows.map((r) => [r.title, r.ourAmount, r.diff])).toEqual([
      ["Елочные работы", 1_000, 0],
      ["Ремонтные работы.", 2_500, 0],
    ]);
    expect(result.unmatchedOurs).toEqual({ count: 0, amount: 0 });
  });

  it("стоимость нашей строки — прямые + накладные + сметная прибыль", () => {
    const ours = documentOf([{ section: "Монтаж", direct: 1_000, overhead: 100, profit: 50 }]);
    const [row] = compareWithCustomerEstimate(ours, [estimateOf([section("Монтаж", 1_150)])]).rows;
    expect(row?.ourAmount).toBe(1_150);
  });

  it("по пересечению токенов (Жаккар ≥ 0,6) с единственным лучшим кандидатом", () => {
    // {демонтажные, работы, на, высоте} против тех же + «6 5м»: 4 / 6 ≈ 0,67.
    const ours = documentOf([{ section: "Демонтажные работы на высоте 6,5м", direct: 500 }]);
    const result = compareWithCustomerEstimate(ours, [estimateOf([section("Демонтажные работы на высоте", 500)])]);

    expect(result.rows[0]?.ourAmount).toBe(500);
    expect(result.rows[0]?.verdict).toBe("CLOSE");
  });

  it("сходство ниже порога — пары нет", () => {
    // {монтаж, оборудования, связи} и {монтаж, оборудования, питания, здания}: 2 / 5 = 0,4.
    const ours = documentOf([{ section: "Монтаж оборудования питания здания", direct: 500 }]);
    const result = compareWithCustomerEstimate(ours, [estimateOf([section("Монтаж оборудования связи", 500)])]);

    expect(result.rows[0]?.ourAmount).toBeNull();
    expect(result.rows[0]?.verdict).toBe("MISSING_IN_OURS");
    expect(result.unmatchedOurs).toEqual({ count: 1, amount: 500 });
  });

  it("неоднозначность: два равных кандидата — пары нет", () => {
    const ours = documentOf([
      { section: "Электромонтажные работы щитов освещения", direct: 300 },
      { section: "Электромонтажные работы щитов питания", direct: 400 },
    ]);
    const result = compareWithCustomerEstimate(ours, [estimateOf([section("Электромонтажные работы щитов", 700)])]);

    expect(result.rows[0]?.ourAmount).toBeNull();
    expect(result.unmatchedOurs).toEqual({ count: 2, amount: 700 });
  });

  it("два раздела заказчика претендуют на один наш: достаётся более похожему", () => {
    const ours = documentOf([{ section: "Ремонтные работы здания корпус 1", direct: 800 }]);
    const result = compareWithCustomerEstimate(ours, [
      estimateOf([section("Ремонтные работы здания", 100), section("Ремонтные работы здания корпус", 800)]),
    ]);

    expect(result.rows.map((r) => r.ourAmount)).toEqual([null, 800]);
  });

  it("по одному номеру раздела не сопоставляется", () => {
    const ours = documentOf([{ section: "Раздел 1. Кровля", direct: 500 }]);
    const result = compareWithCustomerEstimate(ours, [
      estimateOf([{ number: "1", title: "Фундаменты", amount: 500, quote: "" }]),
    ]);
    expect(result.rows[0]?.ourAmount).toBeNull();
  });

  it("одноимённые разделы двух смет складываются, как у нас", () => {
    const ours = documentOf([
      { section: "Монтажные работы", direct: 600 },
      { section: "Монтажные работы", direct: 400 },
    ]);
    const result = compareWithCustomerEstimate(ours, [
      estimateOf([section("Раздел 1. Монтажные работы", 600)], { estimateName: "лист 1" }),
      estimateOf([section("Раздел 1. Монтажные работы", 400)], { estimateName: "лист 2" }),
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ customerAmount: 1_000, ourAmount: 1_000, verdict: "CLOSE" });
    expect(result.estimates).toHaveLength(2);
  });
});

describe("compareWithCustomerEstimate: вердикт по порогам", () => {
  const verdictFor = (ourAmount: number) =>
    compareWithCustomerEstimate(documentOf([{ section: "Монтаж", direct: ourAmount }]), [
      estimateOf([section("Монтаж", 1_000)]),
    ]);

  it("порог ровно 10 %", () => {
    expect(CLOSE_PERCENT).toBe(10);
  });

  it("плюс 10 % ровно — ещё «близко»; чуть больше — «у нас выше»", () => {
    expect(verdictFor(1_100).rows[0]?.verdict).toBe("CLOSE");
    expect(verdictFor(1_100).rows[0]?.diffPercent).toBe(10);
    expect(verdictFor(1_100.01).rows[0]?.verdict).toBe("OURS_HIGHER");
  });

  it("минус 10 % ровно — ещё «близко»; чуть меньше — «у нас ниже»", () => {
    expect(verdictFor(900).rows[0]?.verdict).toBe("CLOSE");
    expect(verdictFor(899.99).rows[0]?.verdict).toBe("OURS_LOWER");
  });

  it("разница и процент считаются от суммы заказчика", () => {
    const [row] = verdictFor(1_250).rows;
    expect(row).toMatchObject({ customerAmount: 1_000, ourAmount: 1_250, diff: 250, diffPercent: 25 });
  });

  it("итоговая строка судится тем же правилом", () => {
    expect(verdictFor(1_100).verdict).toBe("CLOSE");
    expect(verdictFor(1_101).verdict).toBe("OURS_HIGHER");
    expect(verdictFor(899).verdict).toBe("OURS_LOWER");
  });

  it("у заказчика ноль: процента нет, наши деньги — «выше», нет денег — «близко»", () => {
    const zero = compareWithCustomerEstimate(documentOf([{ section: "Монтаж", direct: 5 }]), [
      estimateOf([section("Монтаж", 0)]),
    ]);
    expect(zero.rows[0]?.diffPercent).toBeNull();
    expect(zero.rows[0]?.verdict).toBe("OURS_HIGHER");

    const none = compareWithCustomerEstimate(documentOf([{ section: "Другое", direct: 5 }]), [
      estimateOf([section("Монтаж", 0)]),
    ]);
    expect(none.rows[0]?.verdict).toBe("CLOSE");
    expect(none.customerOnly).toEqual([]);
  });
});

describe("compareWithCustomerEstimate: итоги, непарные и покрытие", () => {
  const ours = documentOf([
    { section: "Демонтаж", direct: 1_200 },
    { section: "Ремонт", direct: 600 },
    { section: "Наши особые работы", direct: 300 },
    { section: null, direct: 100 },
  ]);
  const customer = estimateOf([
    section("Демонтаж", 1_000),
    section("Ремонт", 1_000),
    section("Оборудование", 1_000),
  ]);
  const result = compareWithCustomerEstimate(ours, [customer]);

  it("строки по разделам заказчика, с вердиктами", () => {
    expect(result.rows.map((r) => [r.title, r.verdict])).toEqual([
      ["Демонтаж", "OURS_HIGHER"],
      ["Ремонт", "OURS_LOWER"],
      ["Оборудование", "MISSING_IN_OURS"],
    ]);
  });

  it("итог по сопоставленным: 2 000 у заказчика против 1 800 у нас — минус 10 %, «близко»", () => {
    expect(result.matchedCustomer).toBe(2_000);
    expect(result.matchedOurs).toBe(1_800);
    expect(result.diff).toBe(-200);
    expect(result.diffPercent).toBe(-10);
    expect(result.verdict).toBe("CLOSE");
  });

  it("наши непарные группы, включая «вне разделов»", () => {
    expect(result.unmatchedOurs).toEqual({ count: 2, amount: 400 });
  });

  it("разделы заказчика без наших позиций и покрытие", () => {
    expect(result.customerOnly.map((r) => r.title)).toEqual(["Оборудование"]);
    expect(result.coverage).toBeCloseTo(2 / 3, 10);
  });

  it("общий итог: все разделы заказчика против нашего итога СМР", () => {
    expect(result.overall).toMatchObject({ customerAmount: 3_000, ourAmount: 2_200, diff: -800 });
    expect(result.overall?.verdict).toBe("OURS_LOWER");
  });

  it("ни один раздел не сопоставился — вердикта итога нет", () => {
    const none = compareWithCustomerEstimate(documentOf([{ section: "Прочее", direct: 5 }]), [
      estimateOf([section("Другое", 100)]),
    ]);
    expect(none.verdict).toBeNull();
    expect(none.coverage).toBe(0);
    expect(none.matchedCustomer).toBe(0);
  });

  it("без пробелов в документе выпавших позиций у разделов нет", () => {
    expect(result.rows.every((r) => r.droppedPositions === 0)).toBe(true);
  });

  it("общее число выпавших из расчёта позиций берётся из пробелов документа", () => {
    const gap = { kind: "NO_NORM", message: "m", code: null, baseType: null } as const;
    const doc = documentOf([{ section: "Демонтаж", direct: 10 }], [gap, { ...gap, kind: "UNIT_MISMATCH" }]);
    expect(compareWithCustomerEstimate(doc, [estimateOf([section("Демонтаж", 10)])]).droppedPositions).toBe(2);
  });
});

describe("compareWithCustomerEstimate: сверка смет", () => {
  const ours = documentOf([{ section: "Монтаж", direct: 100 }]);

  it("checked — все участвующие сметы с разделами сверены с итогом", () => {
    const good = estimateOf([section("Монтаж", 100)]);
    const bad = estimateOf([section("Прочее", 100)], { checked: false });

    expect(compareWithCustomerEstimate(ours, [good]).checked).toBe(true);
    expect(compareWithCustomerEstimate(ours, [good, bad]).checked).toBe(false);
  });

  it("несверенная смета без разделов и смета в базисных ценах на сверку не влияют", () => {
    const good = estimateOf([section("Монтаж", 100)]);
    const noSections = estimateOf([], { checked: false });
    const base = estimateOf([section("Монтаж", 1)], { checked: false, method: "BASE_2001" });

    expect(compareWithCustomerEstimate(ours, [good, noSections, base]).checked).toBe(true);
  });

  it("список смет для подписи несёт итог, НДС, уровень цен и метод", () => {
    const withLevel = estimateOf([section("Монтаж", 100)], {
      statedTotal: 122,
      totalIncludesVat: true,
      priceLevel: { zone: 2, quarter: 3, year: 2026 },
      estimateName: "лист",
    });
    const [info] = compareWithCustomerEstimate(ours, [withLevel]).estimates;

    expect(info).toMatchObject({
      documentName: "Смета.xlsx",
      estimateName: "лист",
      statedTotal: 122,
      totalIncludesVat: true,
      checked: true,
      method: "RESOURCE_2022",
      priceLevel: { zone: 2, quarter: 3, year: 2026 },
      sectionsCount: 1,
    });
  });
});

describe("compareWithCustomerEstimate: выпавшие позиции по разделам", () => {
  const gap = (billSection: string | null | undefined, message: string, kind: EstimateGap["kind"] = "NO_NORM"): EstimateGap => ({
    kind,
    message,
    code: null,
    baseType: null,
    billSection,
  });

  it("считаются по тому же нормализованному разделу, что у сопоставленной группы", () => {
    const doc = documentOf(
      [
        { section: "Раздел 1. Демонтаж", direct: 1_000 },
        { section: "Ремонт", direct: 1_000 },
      ],
      [
        gap("Демонтаж", "позиция А"),
        gap("ДЕМОНТАЖ.", "позиция Б", "UNIT_MISMATCH"),
        gap("Ремонт", "позиция В", "BAD_QUANTITY"),
        gap("Ремонт", "предупреждение о цене", "NO_PRICE"),
        gap(null, "позиция без раздела"),
        gap(undefined, "старый пробел"),
      ],
    );
    const result = compareWithCustomerEstimate(doc, [estimateOf([section("Демонтаж", 1_000), section("Ремонт", 1_000)])]);

    expect(result.rows.map((row) => [row.title, row.droppedPositions])).toEqual([
      ["Демонтаж", 2],
      ["Ремонт", 1],
    ]);
    // Общее число — по всем пробелам, которые роняют позицию, и «без раздела» в нём тоже.
    expect(result.droppedPositions).toBe(5);
  });

  it("у раздела без наших позиций считается по названию раздела заказчика", () => {
    const doc = documentOf(
      [{ section: "Демонтаж", direct: 1_000 }],
      [gap("Оборудование", "а"), gap("Оборудование", "б"), gap("Оборудование", "в")],
    );
    const result = compareWithCustomerEstimate(doc, [estimateOf([section("Демонтаж", 1_000), section("Раздел 3. Оборудование", 500)])]);
    const missing = result.rows.find((row) => row.title.includes("Оборудование"))!;

    expect(missing.verdict).toBe("MISSING_IN_OURS");
    expect(missing.ourAmount).toBeNull();
    expect(missing.droppedPositions).toBe(3);
  });

  it("у раздела без пары и без выпавших позиций — 0", () => {
    const doc = documentOf([{ section: "Демонтаж", direct: 1_000 }], [gap("Другое", "а")]);
    const result = compareWithCustomerEstimate(doc, [estimateOf([section("Демонтаж", 1_000), section("Оборудование", 500)])]);

    expect(result.rows.find((row) => row.title === "Оборудование")?.droppedPositions).toBe(0);
  });

  it("пометка строки: «нет посчитанных позиций, но 3 выпали» — не то же, что «позиций нет»", () => {
    const doc = documentOf([{ section: "Демонтаж", direct: 1_000 }], [gap("Оборудование", "а"), gap("Оборудование", "б"), gap("Оборудование", "в")]);
    const result = compareWithCustomerEstimate(doc, [estimateOf([section("Демонтаж", 1_000), section("Оборудование", 500)])]);
    const missing = result.rows.find((row) => row.title === "Оборудование")!;
    const demolition = result.rows.find((row) => row.title === "Демонтаж")!;

    expect(rowNote(missing)).toBe("у нас нет посчитанных позиций, но 3 выпали из расчёта");
    expect(rowDroppedNote(missing)).toBeNull();
    expect(rowNote(demolition)).toBe("близко");
    expect(rowDroppedNote(demolition)).toBeNull();
    expect(rowNote({ ...missing, droppedPositions: 0 })).toBe("у нас нет позиций этого раздела");
    expect(rowDroppedNote({ ...demolition, droppedPositions: 2 })).toBe("2 поз. не посчитано — разница может быть из-за этого");
  });
});
