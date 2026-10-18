import { describe, expect, it } from "vitest";

import { bundledBimIndexBook } from "@/domain/estimate/bimIndices";
import { buildBimEstimate, selectBimIndices } from "@/domain/estimate/calculateBim";
import { buildLocalEstimateForm, buildLocalEstimateFormRows, toLocalEstimateFormCsv, unfilled } from "@/domain/estimate/exportForm";
import { ferLookupOf } from "@/repositories/bimRepository";
import { BRICK, EARTH, MOUNT, OVERHEAD_RATES, makeFerBase } from "@/test/bimFixtures";
import { makeBillItem, makeParameters } from "@/test/estimateFixtures";

/*
  Форма локального сметного расчёта для сметы БИМ: те же двенадцать колонок, но колонки 8–10 заполнены (цена ФЕР на 01.01.2000,
  индекс, цена в текущем уровне), в шапке — письмо Минстроя, а не «индексы не применялись».
*/

const found = selectBimIndices(bundledBimIndexBook(), { subject: "Белгородская область", text: "Капитальный ремонт кирпичного многоквартирного дома" });
if (!found.ok) throw new Error(found.reason);
const selection = found.selection;

const items = [
  makeBillItem({ id: "a", workName: "Разработка грунта", quantity: 2, quantityUnit: "1000 м3", unitDivisor: 1, normCode: EARTH.code, normBaseType: "ФЕР" }),
  makeBillItem({ id: "m", workName: "Монтаж", quantity: 5, quantityUnit: "т", unitDivisor: 1, normCode: MOUNT.code, normBaseType: "ФЕРм" }),
];

function document(customerBase: "FER" | "TER" = "FER") {
  return buildBimEstimate({
    title: "Капитальный ремонт",
    sections: [{ title: "Раздел", items }],
    resolveRate: (item) => ({ rate: item.normBaseType === "ФЕРм" ? MOUNT : item.normCode === BRICK.code ? BRICK : EARTH, reasons: [] }),
    fer: ferLookupOf(makeFerBase()),
    selection,
    overheadRates: OVERHEAD_RATES,
    parameters: makeParameters(),
    sources: [],
    generatedAt: "2026-10-09T00:00:00.000Z",
    disclaimer: "оговорка",
    region: "Белгородская область",
    priceZone: "Белгородская область",
    baseEdition: "ФСНБ-2020",
    method: { basis: "CUSTOMER", note: "смета на ФЕР", customerBase },
  });
}

const input = (customerBase: "FER" | "TER" = "FER") => ({ document: document(customerBase), number: "1", constructionName: "Дом", objectName: "Дом", basis: "ВОР" });

describe("форма сметы БИМ", () => {
  const rows = buildLocalEstimateFormRows(input());
  const row = (label: string) => rows.find((candidate) => candidate[2] === label || candidate[0] === label);

  it("шапка называет письмо Минстроя и метод цен, оплата труда — по расценкам ФЕР", () => {
    expect(row("Реквизиты письма Минстроя России об индексах изменения сметной стоимости строительства")?.[6]).toContain("46728-ИФ/09");
    expect(row("Обоснование принятых текущих цен на строительные ресурсы")?.[6]).toContain("Базисно-индексный метод");
    expect(row("Реквизиты нормативного правового акта об утверждении оплаты труда")?.[6]).toContain("Не применялся");
  });

  it("форма базисно-индексной сметы — Приложение № 2, Форма № 2, метод назван в шапке, квартал римской цифрой", () => {
    const typed = buildLocalEstimateForm(input());

    expect(typed.filter((candidate) => candidate.kind === "appendix").map((candidate) => candidate.cells[6]).slice(0, 2)).toEqual([
      "Приложение № 2",
      "Форма № 2",
    ]);
    expect(typed.find((candidate) => candidate.cells[0] === "Составлен")?.cells[3]).toBe("базисно-индексным методом");
    expect(typed.find((candidate) => candidate.cells[0] === "Составлен(а) в текущем уровне цен")?.cells[3]).toMatch(/^III квартал 2026 года$/);
  });

  it("ресурсные строки: колонки 8–10 — цена ФЕР на 01.01.2000, индекс, цена в текущем уровне; итог в колонке 12", () => {
    const wage = rows.find((candidate) => candidate[2] === "Оплата труда рабочих (ОЗП), базисная цена × индекс к оплате труда");
    expect(wage?.slice(7, 12)).toEqual(["1000,00", "47,58", "47580,00", "", "95160,00"]);
    expect(wage?.[1]).toBe("ОЗП");
  });

  it("ФЕРм — монтажные работы в шапке: стоимость 5 т монтажа попала в «монтажных работ»", () => {
    const assembly = rows.find((candidate) => candidate[1] === "монтажных работ");
    expect(Number.parseFloat((assembly?.[3] ?? "0").replace(",", "."))).toBeGreaterThan(0);
    expect(rows.some((candidate) => candidate[1] === "ФЕРм08-02-001-01")).toBe(true);
  });

  it("«не заполнено»: колонки 8–10 заполнены, поэтому прежней строки «не заполнены» нет; ТЕР региона — оговорка", () => {
    const notes = unfilled(document("TER"));
    expect(notes.some((note) => note.startsWith("Колонки 8 и 9 (базисный уровень цен и индекс) не заполнены"))).toBe(false);
    expect(notes[0]).toContain("Базисно-индексный метод: колонки 8–10 заполнены");
    expect(notes.some((note) => note.includes("ТЕР Белгородская область недоступны в открытых данных"))).toBe(true);
  });

  it("CSV собирается и несёт те же числа", () => {
    const csv = toLocalEstimateFormCsv(input());
    expect(csv).toContain("47,58");
    expect(csv).toContain("ФЕР01-01-001-01");
  });
});

describe("элементы затрат в смете БИМ", () => {
  it("ОТ + ЭМ + М равна прямым затратам позиции: оплата машинистов входит в ЭМ, строки ОТм нет", () => {
    const list = buildLocalEstimateForm(input());
    const direct = list.filter((row) => row.kind === "subtotal" && row.cells[2] === "Итого прямые затраты");

    expect(direct).toHaveLength(2);
    expect(list.some((row) => row.kind === "element" && row.cells[2] === "ОТм(ЗТм)")).toBe(false);
    let position = 0;
    let sum = 0;
    for (const row of list) {
      if (row.kind === "position") {
        sum = 0;
      } else if (row.kind === "element") {
        sum += Number((row.cells[11] ?? "0").replace(",", "."));
      } else if (row.kind === "subtotal" && row.cells[2] === "Итого прямые затраты") {
        expect(sum).toBeCloseTo(Number((row.cells[11] ?? "0").replace(",", ".")), 1);
        position += 1;
      }
    }
    expect(position).toBe(2);
  });
});
