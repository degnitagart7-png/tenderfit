import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildEstimate, type EstimatePriceBook } from "@/domain/estimate/calculate";
import {
  buildLocalEstimateForm,
  lineElements,
  type FormRow,
} from "@/domain/estimate/exportForm";
import type { EstimateDocument, EstimateLine, NormRecord, ResourcePrice } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAGLINE_15,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Элементы затрат позиции в форме: ОТ(ЗТ), ЭМ, ОТм(ЗТм), М. Главное свойство — сумма элементов равна прямым затратам позиции,
  потому что сметчик сверяет именно её. Проверяется на настоящих расчётах (ресурсно-индексном и базисно-индексном, из
  сохранённых результатов заданий) и на искусственной позиции с машиной, у которой оплата машинистов известна.
*/

const FIXTURES = join(__dirname, "__fixtures__", "lsr");
const load = (name: string): EstimateDocument => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as EstimateDocument;

const num = (text: string | undefined): number => Number((text ?? "").replace(/\s/g, "").replace(",", "."));
const input = (document: EstimateDocument) => ({
  document,
  number: "02-02-08",
  constructionName: "Стройка",
  objectName: "Объект",
  basis: "Ведомость объёмов работ",
});

/** Позиции формы: строка расценки … «Всего по позиции». */
function positionBlocks(rows: readonly FormRow[]): FormRow[][] {
  const blocks: FormRow[][] = [];
  let current: FormRow[] | null = null;
  for (const row of rows) {
    if (row.kind === "position") current = [row];
    else if (current !== null) current.push(row);
    if (row.kind === "positionTotal" && current !== null) {
      blocks.push(current);
      current = null;
    }
  }
  return blocks;
}

function lines(document: EstimateDocument): EstimateLine[] {
  return document.sections.flatMap((section) => section.lines);
}

describe.each([
  ["ресурсно-индексный расчёт, Бурятия", "resource-index-buryatia"],
  ["базисно-индексный расчёт, Иркутская область", "base-index-irkutsk"],
])("настоящая смета: %s", (_title, name) => {
  const document = load(name);
  const rows = buildLocalEstimateForm(input(document));
  const blocks = positionBlocks(rows);
  const all = lines(document);

  it("каждая позиция расчёта есть в форме, по порядку", () => {
    expect(blocks).toHaveLength(all.length);
    blocks.forEach((block, index) => {
      expect(block[0]?.cells[2], String(index)).toBe(all[index]?.normName);
    });
  });

  it("ОТ + ЭМ + ОТм + М равна прямым затратам каждой позиции с ресурсами (допуск 0,01 ₽)", () => {
    for (const line of all) {
      if (line.resources.length === 0) continue;
      const e = lineElements(line);
      expect(Math.abs(e.labour + e.machines + e.machinist + e.materials - line.directCost), `${line.normBaseType} ${line.normCode}`).toBeLessThanOrEqual(0.01);
    }
  });

  it("напечатанные строки элементов дают те же прямые затраты, что «Итого прямые затраты»", () => {
    for (const block of blocks) {
      const direct = block.find((row) => row.kind === "subtotal" && row.cells[2] === "Итого прямые затраты");
      if (direct === undefined) continue; // материал одной строкой, цена заказчика, услуга — без раскладки на элементы
      const sum = block.filter((row) => row.kind === "element").reduce((total, row) => total + num(row.cells[11]), 0);
      expect(Math.abs(sum - num(direct.cells[11])), block[0]?.cells[2]).toBeLessThanOrEqual(0.011 * block.filter((row) => row.kind === "element").length);
    }
  });

  it("«Всего по позиции»: колонка 12 = стоимость, колонка 10 = стоимость ÷ объём (для позиций с начислениями и по цене)", () => {
    blocks.forEach((block, index) => {
      const line = all[index];
      const total = block.at(-1);
      if (line === undefined || total === undefined) throw new Error("нет позиции");
      expect(num(total.cells[11])).toBeCloseTo(line.directCost + line.overheadCost + line.profitCost, 2);
      // У материала одной строкой цена за единицу стоит в самой строке позиции, в «Всего по позиции» колонка 10 пуста.
      if (total.cells[9] !== "") {
        // Цена в ячейке округлена до копейки, поэтому сверка с точностью до копейки, а не до долей.
        expect(Math.abs(num(total.cells[9]) - (line.directCost + line.overheadCost + line.profitCost) / line.quantity)).toBeLessThanOrEqual(0.0051);
      }
    });
  });

  it("материал одной строкой: цена и сумма в строке позиции, без элементов и ресурсов", () => {
    // Две строки: расценка и «Всего по позиции». Позиции по цене заказчика тоже двухстрочные, но цены в строке расценки у них нет.
    const single = blocks.filter((block) => block.length === 2 && block[0]?.cells[11] !== "");
    expect(single.length).toBeGreaterThan(0);
    for (const block of single) {
      const [position, total] = block;
      expect(position?.kind).toBe("position");
      expect(num(position?.cells[11])).toBeCloseTo(num(total?.cells[11]), 2);
      expect(num(position?.cells[9]) * num(position?.cells[6])).toBeCloseTo(num(position?.cells[11]), 0);
    }
  });

  it("итоги по смете сходятся: элементы дают прямые затраты, группы дают «Всего», «ВСЕГО по смете» = итог на экране", () => {
    const value = (label: string, from = 0): number | undefined => {
      const found = rows.slice(from).find((row) => (row.cells[2] ?? "").trim() === label);
      return found === undefined ? undefined : num(found.cells[11]);
    };
    const start = rows.findIndex((row) => row.kind === "summaryHeading");
    const direct = value("Всего прямые затраты (справочно)", start) ?? 0;
    const elements = ["Оплата труда рабочих", "Эксплуатация машин", "Оплата труда машинистов (Отм)", "Материалы"].reduce(
      (total, label) => total + (value(label, start) ?? 0),
      0,
    );

    expect(direct).toBeCloseTo(document.totals.directCost, 2);
    expect(elements).toBeCloseTo(direct, 1);
    expect((value("Строительные работы", start) ?? 0) + (value("Монтажные работы", start) ?? 0)).toBeCloseTo(document.totals.workCost, 1);
    expect(value("Всего", start)).toBeCloseTo(document.totals.workCost, 2);
    expect(value("ВСЕГО по смете", start)).toBeCloseTo(document.totals.total, 2);
    expect(value("Всего ФОТ (справочно)", start)).toBeCloseTo(document.totals.wageFund, 2);
  });

  it("каждая строка формы укладывается в двенадцать колонок, объединения не выходят за них", () => {
    for (const row of rows) {
      expect(row.cells.length).toBeLessThanOrEqual(12);
      for (const span of row.spans ?? []) {
        expect(span.from).toBeLessThanOrEqual(span.to);
        expect(span.to).toBeLessThan(12);
      }
    }
  });
});

describe("ресурсно-индексная смета: условия работ и множители", () => {
  const document = load("resource-index-buryatia");
  const rows = buildLocalEstimateForm(input(document));

  it("позиция с п. 58 получает строку условия с указателем и коэффициентами и множители НР/СП в колонке 6", () => {
    const condition = rows.find((row) => row.kind === "condition" && row.cells[1] === "421/пр_2020_п.58");

    expect(condition?.cells[2]).toContain("ОЗП=1,15");
    expect(condition?.cells[2]).toContain("ЭМ=1,25 к расх.");
    const overhead = rows.find((row) => row.kind === "accrual" && row.cells[5] === "0,90");
    expect(overhead?.cells[4]).toBe("121");
    expect(overhead?.cells[6]).toBe("108,9");
  });
});

describe("оплата труда машинистов отдельным элементом", () => {
  const CODE = "91.14.02-001";
  const WAGE_SCALE = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);
  const NORM: NormRecord = {
    ...NORM_DRAGLINE_15,
    code: "01-01-999-01",
    resources: [
      { code: CODE, kind: "MACHINE", name: "Автомобили бортовые, грузоподъемность до 5 т", quantity: 1, unit: "маш.-ч", quantityNote: null, projectSpecific: false, technologyGroup: null },
      { code: "2", kind: "MACHINIST_HOURS", name: "", quantity: 1, unit: "чел.-ч", quantityNote: null, projectSpecific: false, technologyGroup: null },
    ],
  };
  const price: ResourcePrice = {
    code: CODE,
    name: "Автомобили бортовые, грузоподъемность до 5 т",
    unit: "маш.-ч",
    price: 800.01,
    machinistSalary: 912.83,
    machinistHours: 1,
    source: "CURRENT_ZONE",
    period: "3 квартал 2026 г.",
    zone: AMUR_ZONE.zone,
  };
  const priceBook: EstimatePriceBook = makePriceBook(WAGE_SCALE, { current: new Map([[CODE, price]]), base: new Map() });
  const document = buildEstimate({
    title: "Тест",
    sections: [makeBillSection("Раздел", [makeBillItem({ id: "m", workName: "Работа автомобиля", quantity: 1000, quantityUnit: "м3", unitDivisor: 1000, normCode: "01-01-999-01" })])],
    priceBook,
    parameters: makeParameters(),
    resolveNorm: makeResolver([NORM]),
    sources: [],
    generatedAt: "2026-10-10T00:00:00.000Z",
    disclaimer: "тест",
  });
  const [block = []] = positionBlocks(buildLocalEstimateForm(input(document)));
  const line = document.sections[0]?.lines[0] as EstimateLine;

  it("ЭМ — без оплаты машинистов, ОТм — отдельный элемент с часами, и вместе они дают прямые затраты", () => {
    const elements = block.filter((row) => row.kind === "element");
    const labels = elements.map((row) => row.cells[2]);

    expect(labels).toEqual(["ЭМ", "ОТм(ЗТм)"]);
    expect(num(elements[0]?.cells[11])).toBe(800.01);
    expect(num(elements[1]?.cells[11])).toBe(912.83);
    expect(elements[1]?.cells[3]).toBe("чел.-ч");
    expect(num(elements[1]?.cells[6])).toBeCloseTo(line.machinistHours, 4);
    expect(num(elements[0]?.cells[11]) + num(elements[1]?.cells[11])).toBeCloseTo(line.directCost, 2);
    expect(lineElements(line)).toMatchObject({ labour: 0, machines: 800.01, machinist: 912.83, materials: 0 });
  });

  it("ОТм идёт после ЭМ и перед М, под ней — детализация звена", () => {
    const order = block.map((row) => (row.kind === "element" ? row.cells[2] : row.kind));

    expect(order.indexOf("ЭМ")).toBeLessThan(order.indexOf("ОТм(ЗТм)"));
    expect(block[block.findIndex((row) => row.cells[2] === "ОТм(ЗТм)") + 1]?.cells[1]).toBe("4-100");
  });
});
