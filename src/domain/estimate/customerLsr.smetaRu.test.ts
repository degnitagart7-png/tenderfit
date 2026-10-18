import { describe, expect, it } from "vitest";

import { parseCustomerEstimates } from "@/domain/estimate/customerEstimate";
import { parseCustomerLsr, type CustomerLsr, type CustomerPosition } from "@/domain/estimate/customerLsr";
import { buildLsrSet, lsrTotalExVat } from "@/domain/estimate/customerLsrSet";
import { declaredLevelsOf } from "@/domain/estimate/customerPriceLevel";
import { lsrDocument, type PositionSpec } from "@/domain/estimate/customerLsr.builders";
import { monthQuarterIn } from "@/domain/estimate/priceLevel";
import {
  BASE_INDEX_PDF_NAME,
  BASE_INDEX_PDF_TEXT,
  RIM_DEMOLITION_NAME,
  RIM_DEMOLITION_TEXT,
  RIM_DEMOLITION_TOTALS,
  RIM_SECTIONS_NAME,
  RIM_SECTIONS_TEXT,
  RIM_SUPPLY_NAME,
  RIM_SUPPLY_TEXT,
} from "@/test/smetaRuFixtures";

/*
  Выгрузка Smeta.RU формы 421/пр читается так же построчно, как Гранд-Смета, но итог позиции стоит иначе:
  «Всего по позиции | 12 930,64 | 447,40 | …» — первое число стоимость на единицу измерения, второе — стоимость позиции.
  Прежний разбор брал последнее число подряд (ЭМ позиции) — сумма позиций закупки 32616439079 выходила 3 464 ₽ вместо 1,34 млн ₽.
*/

const parse = (name: string, text: string): CustomerLsr => {
  const parsed = parseCustomerLsr([{ name, text }]);
  expect(parsed.notRecognized).toEqual([]);
  expect(parsed.estimates).toHaveLength(1);
  return parsed.estimates[0] as CustomerLsr;
};

const demolition = parse(RIM_DEMOLITION_NAME, RIM_DEMOLITION_TEXT);
const supply = parse(RIM_SUPPLY_NAME, RIM_SUPPLY_TEXT);
const sections = parse(RIM_SECTIONS_NAME, RIM_SECTIONS_TEXT);

const position = (estimate: CustomerLsr, label: string): CustomerPosition => {
  const found = estimate.positions.find((item) => item.label === label);
  if (found === undefined) throw new Error(`позиции ${label} нет`);
  return found;
};

describe("Smeta.RU: распознавание выгрузки", () => {
  it("программа и метод названы в шапке: ресурсно-индексный, база не чужая", () => {
    expect(demolition.program).toBe("SMETA_RU");
    expect(demolition.method).toBe("RESOURCE_INDEX");
    expect(demolition.base).toBeUndefined();
    expect(demolition.estimateName).toBe("Смета по ФСНБ 421+557прРИМ");
  });

  it("служебный лист «Source» (дамп базы программы) — не смета и не «не распознанная» смета", () => {
    const parsed = parseCustomerLsr([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }]);
    expect(parsed.estimates).toHaveLength(1);
    expect(parsed.notRecognized).toEqual([]);
    expect(parseCustomerEstimates([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }])).toHaveLength(1);
  });

  it("позиции читаются все: 8 из вырезки, ни одной оборванной", () => {
    expect(demolition.positions.map((item) => item.label)).toEqual(["1", "3", "6", "8", "9", "17", "15", "16"]);
    expect(demolition.positions.every((item) => !item.truncated)).toBe(true);
    expect(supply.positions).toHaveLength(6);
    expect(sections.positions).toHaveLength(11);
  });

  it("номер сметы: «№ ЛСР-Новая локальная смета» — заглушка программы, номера у сметы нет; наименование — из шапки", () => {
    expect(demolition.estimateNumber).toBeNull();
    expect(demolition.title).toContain("Текущий ремонт помещений 1-го этажа");
    // Поле наименования работ пусто: наименованием служит объект над подписью «(наименование объекта …)».
    expect(sections.estimateNumber).toBeNull();
    expect(sections.title).toBe("Ремонт цоколя, основания забора, покраска забора");
  });

  it("шапка: уровень цен «на сентябрь 2026 года» → III квартал 2026, «Сметная стоимость» в тыс. руб.", () => {
    expect(demolition.priceQuarter).toEqual({ quarter: 3, year: 2026 });
    expect(declaredLevelsOf([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }])).toMatchObject([{ quarter: 3, year: 2026 }]);
    expect(demolition.headerTotalThousands).toBeCloseTo(1336.21, 2);
    expect(sections.headerTotalThousands).toBeCloseTo(951.06, 2);
    expect(sections.headerTotalThousands).toBeCloseTo((sections.total as number) / 1000, 2);
  });

  it("квартал по названию месяца читается только рядом с подписью уровня цен: «март 2024» вне шапки уровнем не считается", () => {
    expect(monthQuarterIn("на сентябрь 2026 года")).toEqual({ quarter: 3, year: 2026 });
    expect(monthQuarterIn("на март 2024 года")).toEqual({ quarter: 1, year: 2024 });
    expect(monthQuarterIn("в мае 2025 г.")).toEqual({ quarter: 2, year: 2025 });
    expect(monthQuarterIn("маяк 2026")).toBeNull();
    expect(monthQuarterIn("12 сентября 1999 года")).toBeNull();
    expect(declaredLevelsOf([{ name: "договор.docx", text: "Работы выполняются в марте 2026 года." }])).toEqual([]);
  });

  it("шапка базисно-индексной сметы Smeta.RU (PDF): субъект читается, метод и база — не ресурсные", () => {
    const [level] = declaredLevelsOf([{ name: BASE_INDEX_PDF_NAME, text: BASE_INDEX_PDF_TEXT }]);
    expect(level?.subject).toBe("Московская область");
  });
});

describe("Smeta.RU: итог позиции — второе число «Всего по позиции»", () => {
  it("позиция 1 закупки 32616439079: 12 930,64 — на единицу, 447,40 — стоимость позиции (прямые 189,60 + НР 170,60 + СП 87,20)", () => {
    const first = position(demolition, "1");
    expect(first.perUnit).toBeCloseTo(12_930.64, 2);
    expect(first.total).toBeCloseTo(447.4, 2);
    expect(first.quantity).toBeCloseTo(0.0346, 6);
    expect((first.directTotal as number) + (first.overhead?.amount as number) + (first.profit?.amount as number)).toBeCloseTo(447.4, 2);
    // Стоимость на единицу × объём = стоимость позиции.
    expect((first.perUnit as number) * (first.quantity as number)).toBeCloseTo(first.total as number, 1);
  });

  it("у каждой позиции итог сходится с «прямые затраты + дополнения + НР + СП»; у позиций-цен (ТЦ, ФСБЦ) — с ценой строки", () => {
    for (const estimate of [demolition, supply, sections]) {
      for (const item of estimate.positions) {
        expect(item.total, `${estimate.estimateName ?? ""} поз. ${item.label ?? ""}`).not.toBeNull();
        if (item.directTotal === null) {
          expect(item.total).toBeCloseTo(item.ownTotal ?? (item.perUnit as number) * (item.quantity as number), 1);
          continue;
        }
        const extras = item.resources.filter((resource) => resource.extra).reduce((sum, resource) => sum + (resource.currentTotal ?? 0), 0);
        const visible = item.directTotal + extras + (item.overhead?.amount ?? 0) + (item.profit?.amount ?? 0);
        expect(Math.abs(visible - (item.total as number)), `поз. ${item.label ?? ""}`).toBeLessThan(1);
      }
    }
  });

  it("сумма «Всего по позиции» сходится с итогом сметы и с «Сметной стоимостью» шапки", () => {
    expect(demolition.positionsTotal).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
    expect(supply.positionsTotal).toBeCloseTo(503_149.79, 2);
    expect(sections.positionsTotal).toBeCloseTo(951_062.01, 2);
    for (const estimate of [supply, sections]) {
      expect(Math.abs(estimate.positionsTotal - (estimate.total as number))).toBeLessThan(0.05);
      expect(Math.abs(estimate.positionsTotal / 1000 - (estimate.headerTotalThousands as number))).toBeLessThan(0.01);
    }
  });
});

describe("Smeta.RU: итоги сметы и НДС", () => {
  it("«ВСЕГО по смете» — без НДС; «НДС 22 %» стоит за ним (за справочным блоком), ставка и сумма читаются", () => {
    expect(demolition.total).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
    expect(demolition.vatPercent).toBe(22);
    expect(demolition.vatInferred).toBe(false);
    expect(demolition.vatAmount).toBeCloseTo(RIM_DEMOLITION_TOTALS.vat, 2);
    expect(sections.vatPercent).toBe(22);
    expect(sections.vatAmount).toBeCloseTo(209_233.64, 2);
  });

  it("итог без НДС для сравнения — сам «ВСЕГО по смете»: НДС из него не вычитается", () => {
    expect(lsrTotalExVat(demolition)).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
    expect(lsrTotalExVat(sections)).toBeCloseTo(951_062.01, 2);
    const [entry] = buildLsrSet([sections]).entries;
    expect(entry?.totalExVat).toBeCloseTo(951_062.01, 2);
    expect(entry?.totalWithVat).toBeCloseTo(951_062.01, 2);
  });

  it("у Гранд-Сметы с НДС за итогом («ВСЕГО по смете» без НДС, затем «НДС 22 %») итог без НДС тоже не уменьшается", () => {
    const spec: PositionSpec = {
      n: 1,
      justification: "ГЭСН09-03-002-01",
      name: "Монтаж",
      unit: "т",
      qty: 1,
      resources: [{ code: "1-100-30", unit: "чел.-ч", perUnit: 10, qty: 10, price: 100 }],
    };
    const lsr = parseCustomerLsr([{ name: "after.xlsx", text: lsrDocument({ positions: [spec], totals: { sectionTotal: 1000, total: 1000, vatAfterTotal: { percent: 22, amount: 220 } } }) }]).estimates[0] as CustomerLsr;
    expect(lsr.vatAmount).toBeCloseTo(220, 2);
    expect(lsrTotalExVat(lsr)).toBeCloseTo(1000, 2);
    // «ВСЕГО по смете» с НДС (НДС перед итогом): вычитается, как раньше.
    const included = parseCustomerLsr([{ name: "incl.xlsx", text: lsrDocument({ positions: [spec], totals: { sectionTotal: 1000, total: 1220, vat: { percent: 22, amount: 220 } } }) }]).estimates[0] as CustomerLsr;
    expect(lsrTotalExVat(included)).toBeCloseTo(1000, 2);
  });

  it("разделы: итог подраздела («Итого по разделу» после «Итого прямые затраты по подразделу») в сумму разделов не входит", () => {
    const [estimate] = parseCustomerEstimates([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }]);
    expect(estimate?.sections).toHaveLength(1);
    expect(estimate?.sections[0]?.title).toBe("Коридор 1-й этаж");
    expect(estimate?.sectionsTotal).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
    expect(estimate?.statedTotal).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
    expect(estimate?.checked).toBe(true);
    expect(estimate?.method).toBe("RESOURCE_2022");
    expect(estimate?.base).toBeUndefined();
  });

  it("два раздела сметы сверяются с итогом; позиции несут раздел", () => {
    const [estimate] = parseCustomerEstimates([{ name: RIM_SECTIONS_NAME, text: RIM_SECTIONS_TEXT }]);
    expect(estimate?.sections.map((section) => section.title)).toHaveLength(2);
    expect(estimate?.checked).toBe(true);
    expect(sections.positions.map((item) => item.section)).toContain(estimate?.sections[0]?.title);
  });

  it("смета без «Итого по разделу» (Смета_9): итог и НДС читаются, разделов нет", () => {
    expect(supply.total).toBeCloseTo(503_149.79, 2);
    expect(supply.vatAmount).toBeCloseTo(110_692.95, 2);
    expect(supply.sectionsTotal).toBe(0);
    expect(lsrTotalExVat(supply)).toBeCloseTo(503_149.79, 2);
  });
});

describe("Smeta.RU: состав позиции", () => {
  it("группы ОТ(ЗТ), ЭМ, ОТм(ЗТм), М и прямые затраты: ЭМ без труда машинистов, ФОТ — труд рабочих и машинистов", () => {
    const door = position(demolition, "3");
    expect(door.groupTotals).toEqual({ labour: 4813.38, machines: 320.33, machinistLabour: 331.07, materials: 0 });
    expect(door.directTotal).toBeCloseTo(5464.78, 2);
    expect(door.wageFund).toBeCloseTo(5144.45, 2);
    expect(door.groupTotalsDerived).toBeUndefined();
    expect(door.book).toBe("GESN");
    expect(door.code).toBe("ГЭСН09-04-012-01");
    expect(door.unit).toBe("м2");
    expect(door.quantity).toBeCloseTo(3.759, 6);
    expect(door.section).toBe("Коридор 1-й этаж");
    // Труд рабочих, машины, машинисты и материалы читаются строками ресурсов.
    expect(door.resources.find((resource) => resource.code === "1-100-42")).toMatchObject({ qtyPerUnit: 2.4, qtyTotal: 6.31512, currentUnitPrice: 762.2, currentTotal: 4813.38 });
    expect(door.resources.find((resource) => resource.code === "4-100-040")?.currentTotal).toBeCloseTo(331.07, 2);
  });

  it("подпозиция «1.1 999-9900 Строительный мусор» — дополнение позиции без стоимости; в прямые затраты не входит", () => {
    const first = position(demolition, "1");
    const trash = first.resources.find((resource) => resource.code === "999-9900");
    expect(trash).toMatchObject({ extra: true, unit: "т", qtyTotal: 0.004152, currentTotal: 0, customerPrice: false, unaccounted: false });
    expect(first.resources.filter((resource) => resource.extra)).toHaveLength(1);
    // В «Итого прямые затраты» мусора нет: 189,56 труд + 0,04 машины.
    expect(first.directTotal).toBeCloseTo(189.6, 2);
    expect(first.groupTotals).toEqual({ labour: 189.56, machines: 0.04, machinistLabour: 0, materials: null });
  });

  it("подпозиция «8.1 2 % вспомогательных материалов» входит в «Всего по позиции», а в «Итого прямые затраты» — нет", () => {
    const detector = position(demolition, "8");
    const extra = detector.resources.find((resource) => resource.extra);
    expect(extra).toMatchObject({ rawCode: "421/пр_2020_п.75_пп.а", unit: "%", qtyTotal: 2, currentTotal: 29.84, customerPrice: true });
    expect(detector.directTotal).toBeCloseTo(1492.06, 2);
    expect(detector.total).toBeCloseTo(1492.06 + 29.84 + 1342.85 + 686.35, 2);
  });

  it("подпозиции поставки (ФСБЦ 4.1) и «999-0005 Масса оборудования» (3.2) — дополнения позиции, не отдельные позиции", () => {
    const boxes = position(supply, "4");
    const cable = boxes.resources.find((resource) => resource.code === "20.2.05.04-0055");
    expect(cable).toMatchObject({ extra: true, customerPrice: false, unit: "100 м", currentTotal: 9727.98 });
    expect(boxes.total).toBeCloseTo(boxes.directTotal! + 9727.98 + 476.85 + boxes.overhead!.amount! + boxes.profit!.amount!, 2);
    expect(position(supply, "3").resources.find((resource) => resource.code === "999-0005")).toMatchObject({ extra: true, currentTotal: 0 });
    expect(supply.subPositions).toBeUndefined();
  });

  it("ТЦ-подпозиция (4.1 «Краска акриловая», цена заказчика) — дополнение, с ценой и пометкой цены заказчика", () => {
    const paint = position(sections, "4").resources.find((resource) => resource.extra && resource.rawCode.startsWith("ТЦ_"));
    expect(paint).toMatchObject({ customerPrice: true, unit: "кг", currentTotal: 245_640.61 });
    expect(position(sections, "4").total).toBeCloseTo(283_305.34, 2);
  });

  it("ресурс без цены («01.7.04.07 Скобяные изделия, КОМПЛ») — неучтённый, как «Н» у Гранд-Сметы", () => {
    const door = position(demolition, "3");
    const unpriced = door.resources.filter((resource) => resource.unaccounted);
    expect(unpriced.map((resource) => resource.code)).toEqual(["01.7.04.07", "07.1.01.03"]);
    expect(unpriced.every((resource) => resource.currentTotal === null)).toBe(true);
  });

  it("позиции-цены: ТЦ → цена заказчика, код ФСБЦ → поставка материала; итог — цена строки", () => {
    const tc = position(demolition, "15");
    expect(tc).toMatchObject({ book: "CUSTOMER_PRICE", unit: "шт.", quantity: 1, total: 23_133.94, ownUnitPrice: 23_133.94 });
    const material = position(demolition, "16");
    expect(material).toMatchObject({ book: "MATERIAL_SUPPLY", code: "01.7.04.01-1012", total: 1944.82, ownBasePrice: 1705.98, ownIndex: 1.14 });
  });
});

describe("Smeta.RU: НР и СП", () => {
  it("указатели «Пр/812-092.0-1» и «Пр/774-092.0», нормативы, проценты и суммы", () => {
    const first = position(demolition, "1");
    expect(first.overhead).toMatchObject({ ref: "Пр/812-092.0-1", basePercent: 90, percent: 90, amount: 170.6 });
    expect(first.profit).toMatchObject({ ref: "Пр/774-092.0", basePercent: 46, percent: 46, amount: 87.2 });
    // НР и СП берутся от ФОТ: 189,56 × 90 % и × 46 %.
    expect(first.wageFund).toBeCloseTo(189.56, 2);
    expect((first.wageFund as number) * 0.9).toBeCloseTo(first.overhead!.amount!, 1);
  });

  it("множители к нормативам (графа 6): «Пр/812-009.0-1; п.25» — 0,9 к НР, «Пр/774-009.0; п.16» — 0,85 к СП", () => {
    const doors = position(demolition, "17");
    expect(doors.overhead).toMatchObject({ ref: "Пр/812-009.0-1", basePercent: 93, coefficient: 0.9, percent: 83.7, amount: 2750.75 });
    expect(doors.profit).toMatchObject({ ref: "Пр/774-009.0", basePercent: 62, coefficient: 0.85, percent: 52.7, amount: 1731.95 });
    expect(doors.overhead?.rawRef).toContain("п.25");
    expect(doors.profit?.rawRef).toContain("п.16");
  });
});

describe("Smeta.RU: поправки к норме", () => {
  it("строка поправок без ссылки на приказ — пояснение позиции, не ресурс и не наименование", () => {
    const door = position(demolition, "3");
    expect(door.notes).toEqual([{ ref: "", text: "ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7" }]);
    expect(door.name).toBe("Установка металлических дверных блоков в готовые проемы \\ Демонтаж");
    expect(door.resources.some((resource) => resource.code.includes("*"))).toBe(false);
  });

  it("«Поправки к:» в наименовании уходят в коэффициенты позиции, наименование остаётся чистым", () => {
    const doors = position(demolition, "17");
    expect(doors.name).toBe("Установка противопожарных дверей: однопольных остекленных");
    expect(doors.coefficients).toBe("ЭМ *1,25; ЗТ *1,15; ЗТм *1,25; НР *0,9; СП *0,85");
    expect(doors.hasCoefficients).toBe(true);
  });

  it("«Объем: 0,0346=(0,519/0,15)/100» не принимается ни за поправку, ни за ресурс", () => {
    const first = position(demolition, "1");
    expect(first.notes).toBeUndefined();
    expect(first.resources.map((resource) => resource.code)).toEqual(["1-100-20", "91.06.03-060", "999-9900"]);
  });
});
