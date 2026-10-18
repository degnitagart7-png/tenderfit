import { describe, expect, it } from "vitest";

import type { ZoneAutoServices } from "@/domain/estimate/autoServices";
import {
  buildDebrisItems,
  debrisDisposalTariff,
  debrisDistanceKm,
  debrisTonnage,
  existingDebrisRows,
  isDebrisResource,
  tonnageNote,
} from "@/domain/estimate/debrisItems";
import { GENERATED_DEBRIS_SECTION } from "@/domain/estimate/generatedItems";
import type { BillOfWorkItem, BillOfWorkSection, NormRecord, NormResource } from "@/domain/estimate/types";
import { makeBillItem } from "@/test/estimateFixtures";

/*
  Мусор по нормам: тоннаж, расстояние до полигона и тариф из документов, строки, которые уже есть в ведомости, и сами добавленные строки.
  Нормы синтетические: у каждой есть выходной ресурс «999-9900 Строительный мусор» (т на единицу нормы), как в выгрузке ФСНБ-2022.
*/

const DEBRIS: NormResource = { code: "999-9900", kind: "UNKNOWN", name: "Строительный мусор", quantity: 1, unit: "т", quantityNote: null, projectSpecific: true, technologyGroup: null };

function norm(baseType: string, code: string, unit: string, debris: number | null, extra: Partial<NormRecord> = {}): NormRecord {
  return {
    code,
    tableCode: code.split("-").slice(0, 3).join("-"),
    fullName: `Норма ${code}`,
    endName: `Норма ${code}`,
    unit,
    collectionCode: code.slice(0, 2),
    collectionName: "Сборник",
    sectionName: "",
    subsectionName: "",
    baseType,
    content: [],
    resources: debris === null ? [] : [{ ...DEBRIS, quantity: debris }],
    overheadRef: null,
    profitRef: null,
    ...extra,
  };
}

const PROFLIST = norm("ГЭСНр", "66-01-024-02", "100 м2", 0.867);
const PLASTER = norm("ГЭСН", "46-02-009-01", "100 м2", 4.6);
const PAINT = norm("ГЭСН", "15-04-005-01", "100 м2", null);

const bill = (id: string, name: string, quantity: number, unit = "м2", extra: Partial<BillOfWorkItem> = {}): BillOfWorkItem =>
  makeBillItem({ id, workName: name, quantity, quantityUnit: unit, unitDivisor: 1, normCode: null, normBaseType: null, ...extra });

const A = bill("a", "Демонтаж профлиста", 56.5);
const B = bill("b", "Отбивка штукатурки", 20);
const C = bill("c", "Окраска стен", 100);
const NORMS = new Map<string, NormRecord>([
  ["a", PROFLIST],
  ["b", PLASTER],
  ["c", PAINT],
]);
const normOf = (item: BillOfWorkItem): NormRecord | null => NORMS.get(item.id) ?? null;
const section = (...items: BillOfWorkItem[]): BillOfWorkSection => ({ title: "Фасад", items });

/** Таблицы услуг зоны: погрузка мусора 49-1 и перевозка самосвалами 02-15-1-01 на 1…100 км. */
const SERVICES: ZoneAutoServices = {
  transport: new Map([
    [
      "02-15-1-01",
      {
        prefix: "02-15-1-01",
        vehicle: "02",
        capacity: 15,
        capacityUnit: "т",
        cls: 1,
        road: "01",
        vehicleName: "Автомобили-самосвалы",
        roadName: null,
        prices: Array.from({ length: 100 }, (_, index) => 600 + index),
      },
    ],
  ]),
  load: new Map([["49-1", { code: "49-1", group: 49, groupName: "Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", operation: "LOAD" as const, price: 94.64 }]]),
};

describe("тоннаж мусора по нормам", () => {
  it("Σ расход 999-9900 × объём в единицах нормы; норма без мусора не даёт ничего; тонны округлены до 0,001", () => {
    const tonnage = debrisTonnage([section(A, B, C)], normOf);
    // 0,867 × 0,565 = 0,489855; 4,6 × 0,2 = 0,92; Σ = 1,409855 → 1,41.
    expect(tonnage.tons).toBe(1.41);
    expect(tonnage.parts).toEqual([
      { baseType: "ГЭСНр", code: "66-01-024-02", normQuantity: 0.565, tons: 0.49 },
      { baseType: "ГЭСН", code: "46-02-009-01", normQuantity: 0.2, tons: 0.92 },
    ]);
    expect(tonnageNote(tonnage)).toBe("мусор по нормам: 0,49 т (ГЭСНр 66-01-024-02 × 0,565) + 0,92 т (ГЭСН 46-02-009-01 × 0,2) = 1,41 т");
  });

  it("одна норма у нескольких позиций — одно слагаемое с суммой объёмов; единица, не переводимая в единицу нормы, мусора не даёт", () => {
    const again = bill("a2", "Демонтаж профлиста, корпус 2", 43.5);
    const wrongUnit = bill("a3", "Демонтаж профлиста, т", 5, "т");
    const tonnage = debrisTonnage([section(A, again, wrongUnit)], (item) => (item.id.startsWith("a") ? PROFLIST : null));
    expect(tonnage.parts).toHaveLength(1);
    expect(tonnage.parts[0]).toMatchObject({ code: "66-01-024-02", normQuantity: 1 });
    expect(tonnage.tons).toBe(0.867);
    expect(tonnageNote(tonnage)).toBe("мусор по нормам: 0,867 т (ГЭСНр 66-01-024-02 × 1)");
  });

  it("не считаются: строки, добавленные расчётом, поставки, услуги, цены человека, исключения", () => {
    const skipped = [
      bill("g", "Погрузка строительного мусора", 5, "т", { generated: "DEBRIS" }),
      bill("m", "Труба стальная", 10, "м", { resourceCode: "23.3.06.04-0026" }),
      bill("s", "Перевозка грузов", 10, "т", { serviceRow: true }),
      bill("p", "Демонтаж с ценой", 10, "м2", { ownUnitPrice: 100 }),
      bill("d", "Исключение", 10, "м2", { deduction: true }),
    ];
    expect(debrisTonnage([section(...skipped)], () => PROFLIST).tons).toBe(0);
  });

  it("ресурс-мусор: код 999-9900 или название «мусор строительный», только в тоннах и с расходом", () => {
    expect(isDebrisResource(DEBRIS)).toBe(true);
    expect(isDebrisResource({ ...DEBRIS, code: "999-9901", name: "Мусор строительный" })).toBe(true);
    expect(isDebrisResource({ ...DEBRIS, code: "999-9901", name: "Материалы (см. приложение)" })).toBe(false);
    expect(isDebrisResource({ ...DEBRIS, unit: "кг" })).toBe(false);
    expect(isDebrisResource({ ...DEBRIS, quantity: 0 })).toBe(false);
  });
});

describe("расстояние до полигона из документов", () => {
  it("«на расстояние 47 км», «51км», дробное — вверх до целого", () => {
    expect(debrisDistanceKm(["Вывоз мусора осуществляется на полигон, расположенный на расстоянии 47 км от объекта."])?.km).toBe(47);
    expect(debrisDistanceKm(["Утилизация отходов: полигон ТКО (51км)"])?.km).toBe(51);
    expect(debrisDistanceKm(["Расстояние до полигона 12,5 км."])?.km).toBe(13);
    expect(debrisDistanceKm(["Вывоз мусора на расстояние 47 км"])?.quote).toContain("47 км");
  });

  it("из нескольких берётся ближайшее к слову про полигон", () => {
    expect(debrisDistanceKm(["Вывоз мусора на полигон 25 км, поставка материалов с завода за 300 км"])?.km).toBe(25);
  });

  it("расстояния нет — null, а не придуманное: километры без слов про вывоз, слова без километров, км/ч, нуль и больше таблицы", () => {
    expect(debrisDistanceKm(["Объект находится на расстоянии 30 км от областного центра."])).toBeNull();
    expect(debrisDistanceKm(["Вывоз мусора на полигон за счёт подрядчика."])).toBeNull();
    expect(debrisDistanceKm(["Вывоз мусора, скорость движения не более 40 км/ч"])).toBeNull();
    expect(debrisDistanceKm(["Вывоз мусора на полигон 0 км"])).toBeNull();
    expect(debrisDistanceKm(["Вывоз мусора на полигон 2000 км"])).toBeNull();
    expect(debrisDistanceKm([])).toBeNull();
  });

  it("ищет по всем документам", () => {
    expect(debrisDistanceKm(["ТЗ без расстояния", "Проект контракта: утилизация на полигоне, 18 км"])?.km).toBe(18);
  });
});

describe("тариф размещения из документов", () => {
  it("«тариф … полигона … 1 250 руб./т», «850,50 руб. за тонну»", () => {
    expect(debrisDisposalTariff(["Тариф на размещение отходов на полигоне — 1 250 руб./т (с НДС)."])?.price).toBe(1250);
    expect(debrisDisposalTariff(["Стоимость утилизации строительного мусора 850,50 руб. за тонну"])?.price).toBe(850.5);
  });

  it("без слова о цене или без «за тонну» — тарифа нет", () => {
    expect(debrisDisposalTariff(["Полигон принимает отходы 1250 руб./т"])).toBeNull();
    expect(debrisDisposalTariff(["Тариф полигона — по договору с эксплуатирующей организацией"])).toBeNull();
    expect(debrisDisposalTariff([])).toBeNull();
  });
});

describe("строки мусора, уже названные в ведомости", () => {
  const names = (...list: string[]): BillOfWorkSection[] => [section(...list.map((name, index) => bill(`r${String(index)}`, name, 1, "т")))];

  it("«Вывоз мусора» закрывает все три стороны; остальное — каждое своё", () => {
    expect(existingDebrisRows(names("Вывоз строительного мусора"))).toMatchObject({ load: true, transport: true, disposal: true });
    expect(existingDebrisRows(names("Погрузка строительного мусора"))).toMatchObject({ load: true, transport: false, disposal: false });
    expect(existingDebrisRows(names("Перевозка отходов на полигон"))).toMatchObject({ load: false, transport: true, disposal: false });
    expect(existingDebrisRows(names("Утилизация строительных отходов"))).toMatchObject({ load: false, transport: false, disposal: true });
    expect(existingDebrisRows(names("Размещение отходов"))).toMatchObject({ disposal: true });
  });

  it("без слова «мусор» или «отход» не считается; строки, добавленные расчётом, тоже", () => {
    expect(existingDebrisRows(names("Погрузка гравия", "Перевозка грузов", "Демонтаж профлиста"))).toMatchObject({ load: false, transport: false, disposal: false, names: [] });
    const generated = [section(bill("g", "Погрузка строительного мусора", 1, "т", { generated: "DEBRIS" }))];
    expect(existingDebrisRows(generated).load).toBe(false);
  });
});

describe("добавленные строки мусора", () => {
  const texts = ["Вывоз мусора на полигон на расстояние 51 км."];

  it("три строки: погрузка (49-1), перевозка на N км (02-15-1-01-00NN), размещение без тарифа — без цены, с причиной", () => {
    const result = buildDebrisItems({ sections: [section(A, B, C)], normOf, texts, services: SERVICES });
    expect(result.section?.title).toBe(GENERATED_DEBRIS_SECTION);
    const [load, transport, disposal] = result.section?.items ?? [];

    expect(load).toMatchObject({ id: "gen-debris-load", workName: "Погрузка строительного мусора", quantity: 1.41, quantityUnit: "т", serviceCode: "49-1", serviceRow: true, generated: "DEBRIS" });
    expect(load?.generatedUnpricedReason).toBeUndefined();
    expect(load?.sourceQuote).toContain("мусор по нормам: 0,49 т (ГЭСНр 66-01-024-02 × 0,565)");

    expect(transport).toMatchObject({ workName: "Перевозка строительного мусора на 51 км", quantity: 1.41, serviceCode: "02-15-1-01-0051", serviceRow: true, generated: "DEBRIS" });
    expect(transport?.generatedUnpricedReason).toBeUndefined();
    expect(transport?.sourceQuote).toContain("51 км");

    expect(disposal).toMatchObject({ workName: "Размещение (утилизация) строительного мусора", quantity: 1.41, generated: "DEBRIS", generatedUnpricedReason: "тариф полигона не известен — укажите свою цену" });
    expect(disposal?.ownUnitPrice).toBeUndefined();

    expect(result.stats).toMatchObject({ enabled: true, rows: 3, tons: 1.41, distanceKm: 51, unpriced: 1, skipped: null });
  });

  it("расстояния нет — перевозка без цены с причиной «расстояние до полигона не указано», километраж не придуман", () => {
    const result = buildDebrisItems({ sections: [section(A)], normOf, texts: ["Вывоз мусора за счёт подрядчика"], services: SERVICES });
    const transport = result.section?.items.find((item) => item.id === "gen-debris-transport");
    expect(transport).toMatchObject({ workName: "Перевозка строительного мусора", generatedUnpricedReason: "расстояние до полигона не указано" });
    expect(transport?.serviceCode).toBeUndefined();
    expect(result.stats).toMatchObject({ distanceKm: null, unpriced: 2 });
  });

  it("тариф назван в документе — размещение идёт по нему, как своя цена, с цитатой", () => {
    const result = buildDebrisItems({ sections: [section(A)], normOf, texts: [...texts, "Тариф на размещение отходов на полигоне — 1 250 руб./т."], services: SERVICES });
    const disposal = result.section?.items.find((item) => item.id === "gen-debris-disposal");
    expect(disposal).toMatchObject({ ownUnitPrice: 1250 });
    expect(disposal?.generatedUnpricedReason).toBeUndefined();
    expect(disposal?.sourceQuote).toContain("1 250");
    expect(result.stats.unpriced).toBe(0);
  });

  it("таблиц услуг зоны нет — погрузка и перевозка без цены с причиной", () => {
    const result = buildDebrisItems({ sections: [section(A)], normOf, texts, services: null });
    const reasons = (result.section?.items ?? []).map((item) => item.generatedUnpricedReason);
    expect(reasons[0]).toContain("таблиц сметных цен ФГИС ЦС");
    expect(reasons[1]).toContain("таблиц сметных цен ФГИС ЦС");
    expect(result.stats.unpriced).toBe(3);
  });

  it("расстояние больше таблицы зоны (100 км в тесте) — перевозка без цены с причиной таблицы, шифр остаётся", () => {
    const result = buildDebrisItems({ sections: [section(A)], normOf, texts: ["Вывоз мусора на полигон на расстояние 120 км"], services: SERVICES });
    const transport = result.section?.items.find((item) => item.id === "gen-debris-transport");
    expect(transport?.serviceCode).toBe("02-15-1-01-0120");
    expect(transport?.generatedUnpricedReason).toContain("больше таблицы перевозки зоны");
  });

  it("в ведомости уже есть «Вывоз мусора» — ничего не добавляется, причина названа", () => {
    const existing = bill("w", "Вывоз строительного мусора", 10, "т");
    const result = buildDebrisItems({ sections: [section(A, existing)], normOf, texts, services: SERVICES });
    expect(result.section).toBeNull();
    expect(result.stats).toMatchObject({ enabled: true, rows: 0, tons: 0.49 });
    expect(result.stats.skipped).toContain("«Вывоз строительного мусора»");
  });

  it("в ведомости есть только погрузка — добавляются перевозка и размещение", () => {
    const existing = bill("w", "Погрузка мусора вручную", 10, "т");
    const result = buildDebrisItems({ sections: [section(A, existing)], normOf, texts, services: SERVICES });
    expect((result.section?.items ?? []).map((item) => item.id)).toEqual(["gen-debris-transport", "gen-debris-disposal"]);
  });

  it("нормы не дают мусора — раздела нет, причина названа", () => {
    const result = buildDebrisItems({ sections: [section(C)], normOf, texts, services: SERVICES });
    expect(result.section).toBeNull();
    expect(result.stats.skipped).toContain("999-9900");
    expect(result.stats.rows).toBe(0);
  });
});
