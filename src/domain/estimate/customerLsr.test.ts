import { describe, expect, it } from "vitest";

import { bookOf, parseCustomerLsr, resourceCodeOf, type CustomerLsr } from "@/domain/estimate/customerLsr";
import {
  EXPERT_LAYOUT,
  GRAND_LAYOUT,
  lsrDocument,
  lsrHead,
  lsrRow,
  lsrTotals,
  type PositionSpec,
} from "@/domain/estimate/customerLsr.builders";
import { REAL_A_ROWS, REAL_A_WITH_TOTALS, REAL_B_ROWS, REAL_SUPPLY_CABLES, REAL_SUPPLY_MOSCOW } from "@/domain/estimate/customerLsr.fixtures";

function parseOne(text: string): CustomerLsr {
  const { estimates } = parseCustomerLsr([{ name: "смета.xlsx", text }]);
  expect(estimates).toHaveLength(1);
  return estimates[0] as CustomerLsr;
}

/** Позиция по образцу A: труд + машина, НР и СП в процентах от ФОТ. */
const DEMOLITION: PositionSpec = {
  n: 1,
  justification: "ГЭСНр56-01-009-01",
  name: "Демонтаж дверных коробок",
  unit: "100 шт",
  qty: 0.03,
  resources: [
    { code: "1-100-23", name: "Средний разряд работы 2,3", unit: "чел.-ч", perUnit: 179.3, qty: 5.379, price: 611.05 },
    { code: "91.21.10-002", name: "Молотки отбойные", unit: "маш.-ч", perUnit: 7.93, qty: 0.2379, base: 2.11, index: 1.63, price: 3.44 },
    { code: "999-9900", name: "Строительный мусор", unit: "т", perUnit: 10.5, qty: 0.315, unaccounted: true },
  ],
  overhead: { ref: "Пр/812-090.0-1", base: 90 },
  profit: { ref: "Пр/774-090.0", base: 47 },
};

describe("разбор реальной сметы A (Гранд-Смета, Методика 2020)", () => {
  const lsr = parseOne(REAL_A_WITH_TOTALS);

  it("шапка: название листа, дата и квартал уровня цен", () => {
    expect(lsr.estimateName).toBe("701-702 - ЛСР по Методике 2020");
    expect(lsr.priceDate).toBe("01.04.2026");
    expect(lsr.priceQuarter).toEqual({ quarter: 2, year: 2026 });
  });

  it("итоги: раздел, НДС 22 % названа в строке, ВСЕГО по смете", () => {
    expect(lsr.sectionsTotal).toBe(13979.89);
    expect(lsr.total).toBe(17055.47);
    expect(lsr.vatPercent).toBe(22);
    expect(lsr.vatInferred).toBe(false);
    expect(lsr.vatAmount).toBe(3075.58);
    expect(lsr.positionsTotal).toBeCloseTo(13979.89, 2);
  });

  it("четыре позиции целиком, цифры дословно по образцу", () => {
    expect(lsr.positions.map((position) => [position.number, position.code, position.total])).toEqual([
      [1, "ГЭСНр56-01-009-01", 7810.56],
      [2, "ГЭСНр56-01-010-01", 3952.16],
      [3, "ГЭСНр56-01-011-01", 936.57],
      [4, "ГЭСНр57-01-003-01", 1280.6],
    ]);
    const first = lsr.positions[0]!;
    expect(first.book).toBe("GESNR");
    expect(first.unit).toBe("100 шт");
    expect(first.quantity).toBe(0.03);
    expect(first.section).toBe("Демонтажные работы");
    expect(first.perUnit).toBe(260352);
    expect(first.truncated).toBe(false);
    expect(first.groupTotals).toEqual({ labour: 3286.84, machinistLabour: null, machines: 20.75, materials: null });
    expect(first.directTotal).toBe(3307.59);
    expect(first.wageFund).toBe(3286.84);
    expect(first.overhead).toEqual({ ref: "Пр/812-090.0-1", rawRef: "Пр/812-090.0-1", basePercent: 90, percent: 90, amount: 2958.16 });
    expect(first.profit).toEqual({ ref: "Пр/774-090.0", rawRef: "Пр/774-090.0", basePercent: 47, percent: 47, amount: 1544.81 });
    expect(lsr.positions[3]!.overhead?.ref).toBe("Пр/812-091.0-1");
  });

  it("ресурсы позиции 1: труд, две машины и «Н»-строка без цены", () => {
    const resources = lsr.positions[0]!.resources;
    expect(resources.map((resource) => resource.code)).toEqual(["1-100-23", "91.18.01-508", "91.21.10-002", "999-9900"]);
    const labour = resources[0]!;
    expect(labour).toMatchObject({ unit: "чел.-ч", qtyPerUnit: 179.3, qtyTotal: 5.379, currentUnitPrice: 611.05, currentTotal: 3286.84, unaccounted: false, extra: false });
    const machine = resources[1]!;
    expect(machine).toMatchObject({ unit: "маш.-ч", qtyTotal: 0.1191, baseUnitPrice: 115.43, index: 1.45, currentUnitPrice: 167.37, currentTotal: 19.93 });
    // «Н» — неучтённый ресурс: он назван, но цены и стоимости у него нет и в суммы он не идёт.
    const mess = resources[3]!;
    expect(mess).toMatchObject({ code: "999-9900", unaccounted: true, currentUnitPrice: null, currentTotal: null });
  });

  it("отрезок без строки «ВСЕГО по смете» сметой не считается: у него нет границы", () => {
    // Те же четыре позиции, но без итогов — именно так выглядит обрезанный текст документа.
    const bare = parseCustomerLsr([{ name: "обрезан.xlsx", text: REAL_A_ROWS }]);
    expect(bare.estimates).toHaveLength(0);
  });
});

describe("разбор реальной сметы B (Гранд-Смета РИМ, пусконаладка)", () => {
  const lsr = parseOne(REAL_B_ROWS);

  it("позиция ПНР: рабочий и инженер, НР 74 %, СП 36 %, итог позиции", () => {
    expect(lsr.positions).toHaveLength(1);
    const position = lsr.positions[0]!;
    expect(position).toMatchObject({ number: 1, code: "ГЭСНп01-12-027-01", book: "GESNP", unit: "испытание", quantity: 24, section: "Пусконаладочные работы" });
    expect(position.resources.map((resource) => [resource.code, resource.qtyTotal, resource.currentUnitPrice, resource.currentTotal])).toEqual([
      ["2-100-04", 46.56, 651.98, 30356.19],
      ["3-200-03", 70.08, 856.33, 60011.61],
    ]);
    expect(position.directTotal).toBe(90367.8);
    expect(position.wageFund).toBe(90367.8);
    expect(position.overhead).toMatchObject({ ref: "Пр/812-083.0-1", basePercent: 74, amount: 66872.17 });
    expect(position.profit).toMatchObject({ ref: "Пр/774-083.0", basePercent: 36, amount: 32532.41 });
    expect(position.perUnit).toBe(7907.18);
    expect(position.total).toBe(189772.38);
  });

  it("строки справочных итогов («421/пр_2020_прил.8») не становятся ни позициями, ни ресурсами", () => {
    expect(lsr.positions[0]!.resources).toHaveLength(2);
    expect(lsr.total).toBe(189772.38);
    expect(lsr.sectionsTotal).toBe(189772.38);
    // НДС в смете не назван и по итогу не выводится (итог равен сумме разделов).
    expect(lsr.vatPercent).toBeNull();
    expect(lsr.priceQuarter).toEqual({ quarter: 3, year: 2026 });
  });
});

describe("карта «ячейка → графа»", () => {
  const text = (layout: typeof GRAND_LAYOUT) => lsrDocument({ positions: [DEMOLITION], layout });

  it("сдвиг колонок («Строительный эксперт») даёт тот же разбор, что и Гранд-Смета", () => {
    const grand = parseOne(text(GRAND_LAYOUT));
    const expert = parseOne(text(EXPERT_LAYOUT));
    expect(expert.positions).toEqual(grand.positions);
    expect(expert.total).toBe(grand.total);
    expect(grand.positions[0]!.resources[0]).toMatchObject({ code: "1-100-23", qtyTotal: 5.379, currentUnitPrice: 611.05 });
  });

  it("сегмент без строки нумерации граф — в notRecognized с причиной", () => {
    const body = [
      "=== Смета без нумерации ===",
      "Составлен(а) в текущем уровне цен ,,01.04.2026",
      "№ п/п,Обоснование,Наименование,Ед. изм.,Количество,Цена,Стоимость",
      "1,ГЭСН01-01-001-01,Разработка грунта,100 м3,1,1000,1000",
      "ВСЕГО по смете,,,,,,1000",
    ].join("\n");
    const result = parseCustomerLsr([{ name: "без-нумерации.xlsx", text: body }]);
    expect(result.estimates).toHaveLength(0);
    expect(result.notRecognized).toHaveLength(1);
    expect(result.notRecognized[0]!.reason).toContain("нет строки нумерации");
    expect(result.notRecognized[0]!.documentName).toBe("без-нумерации.xlsx");
  });

  it("нумерация есть, но шапки формы 421/пр над ней нет (другая форма) — не форма 421/пр", () => {
    const numbering = lsrRow(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, String(i + 1)])));
    const body = [
      "=== Изыскания ===",
      lsrRow({ 1: "№ п/п", 2: "Обоснование", 3: "Наименование", 5: "Количество", 8: "Стоимость в базовых ценах" }),
      numbering,
      lsrRow({ 1: "1", 2: "СБЦ-1", 3: "Бурение", 4: "м", 5: "10", 12: "1000" }),
      lsrRow({ 3: "ВСЕГО по смете", 12: "1000" }),
    ].join("\n");
    const result = parseCustomerLsr([{ name: "изыскания.xlsx", text: body }]);
    expect(result.estimates).toHaveLength(0);
    expect(result.notRecognized[0]!.reason).toContain("не форма 421/пр");
  });

  it("форма 421/пр без единой позиции называется отдельно", () => {
    const body = [...lsrHead(), "Раздел 1. Пусто", ...lsrTotals({ sectionTotal: 100, total: 100 })].join("\n");
    const result = parseCustomerLsr([{ name: "пусто.xlsx", text: body }]);
    expect(result.estimates).toHaveLength(0);
    expect(result.notRecognized[0]!.reason).toContain("позиций");
  });
});

describe("обоснование, коэффициенты, дополнения", () => {
  it("коэффициенты в фигурных скобках: код — всё до «{», коэффициенты — содержимое", () => {
    const coefficients = "(К Кзтр=0.3; Кзтм=0.3; Ккм=0 для 01.7.15.03-0031; Квэм=0.3)(К Кзтр=1.2; Кзтм=1.2; Квэм=1.2)";
    const spec: PositionSpec = {
      ...DEMOLITION,
      justification: `ГЭСНм11-03-001-01{571/пр_2022_п.84_т.3_стр.4_стб.3421/пр_2020_прил.10_т.5_п.1.1_гр.4}`,
      name: `Приборы, устанавливаемые на металлоконструкциях: до 5 кг{${coefficients}}`,
    };
    const position = parseOne(lsrDocument({ positions: [spec] })).positions[0]!;
    expect(position.code).toBe("ГЭСНм11-03-001-01");
    expect(position.book).toBe("GESNM");
    expect(position.hasCoefficients).toBe(true);
    expect(position.coefficients).toContain("Кзтр=0.3");
    expect(position.coefficients).toContain("571/пр_2022");
    expect(position.name).toBe("Приборы, устанавливаемые на металлоконструкциях: до 5 кг");
  });

  it("обоснование, перенесённое по строкам внутри кавычек, склеивается с позицией", () => {
    const text = lsrDocument({
      positions: [{ ...DEMOLITION, justification: "ГЭСНм11-03-001-01{571/пр_2022_п.84\nстр.4_стб.3}" }],
    });
    expect(text).toContain("п.84\nстр.4");
    const position = parseOne(text).positions[0]!;
    expect(position.code).toBe("ГЭСНм11-03-001-01");
    expect(position.coefficients).toContain("п.84 стр.4");
    expect(position.total).toBeGreaterThan(0);
    expect(position.resources).toHaveLength(3);
  });

  it("строка-дополнение «1.1» входит в ресурсы с признаком extra, но не в «Итого прямые затраты»", () => {
    const spec: PositionSpec = {
      ...DEMOLITION,
      resources: [
        ...DEMOLITION.resources,
        { code: "01.7.15.03-0042", name: "Болты", unit: "кг", qty: 2, price: 100, extra: "1.1" },
      ],
    };
    const position = parseOne(lsrDocument({ positions: [spec] })).positions[0]!;
    const extra = position.resources.find((resource) => resource.code === "01.7.15.03-0042")!;
    expect(extra.extra).toBe(true);
    expect(extra.currentTotal).toBe(200);
    // Прямые затраты — без дополнения: 3 286,84 + 0,82.
    expect(position.directTotal).toBeCloseTo(3287.66, 2);
    expect(position.total).toBeCloseTo(3287.66 + 200 + 3286.84 * 1.37, 1);
  });

  it("позиция без «Всего по позиции» помечается оборванной", () => {
    const position = parseOne(lsrDocument({ positions: [{ ...DEMOLITION, noTotal: true }, { ...DEMOLITION, n: 2 }] })).positions[0]!;
    expect(position.truncated).toBe(true);
    expect(position.total).toBeNull();
  });

  it("цена заказчика: «ТЦ_…» и «Прайс-лист» помечаются, код ФСБЦ внутри ТЦ узнаётся", () => {
    expect(resourceCodeOf("ТЦ_01.6.03.03-1082_510")).toEqual({ code: "01.6.03.03-1082", customerPrice: true });
    expect(resourceCodeOf("Прайс-лист")).toMatchObject({ customerPrice: true });
    expect(resourceCodeOf("п.17 отчёта о проверке цен")).toMatchObject({ customerPrice: true });
    expect(resourceCodeOf("ФСБЦ-01.7.15.03-0042")).toEqual({ code: "01.7.15.03-0042", customerPrice: false });
    expect(resourceCodeOf("1-100-23")).toEqual({ code: "1-100-23", customerPrice: false });
  });

  it("книга по префиксу кода", () => {
    expect(bookOf("ГЭСН01-01-001-01")).toBe("GESN");
    expect(bookOf("ГЭСНмр01-01-001-01")).toBe("GESNMR");
    expect(bookOf("ФСБЦ-01.7.15.03-0042")).toBe("MATERIAL_SUPPLY");
    expect(bookOf("ТЦ_01.6.03.03-1082_510")).toBe("CUSTOMER_PRICE");
    expect(bookOf("ТЕР 46-04-001")).toBe("OTHER_BASE");
    expect(bookOf("что-то")).toBe("UNKNOWN");
  });
});

describe("НДС", () => {
  const positions = [DEMOLITION];

  it("НДС, названный в итогах, читается вместе с суммой", () => {
    const lsr = parseOne(lsrDocument({ positions, totals: { vat: { percent: 20, amount: 100 }, total: 600 } }));
    expect(lsr.vatPercent).toBe(20);
    expect(lsr.vatInferred).toBe(false);
    expect(lsr.vatAmount).toBe(100);
  });

  it("НДС не назван, но итог равен сумме разделов × 1,22 — ставка выводится и помечается выведенной", () => {
    const lsr = parseOne(lsrDocument({ positions: [DEMOLITION], totals: { sectionTotal: 1000, total: 1220 } }));
    expect(lsr.vatPercent).toBe(22);
    expect(lsr.vatInferred).toBe(true);
    expect(lsr.vatAmount).toBeNull();
  });

  it("НДС после «ВСЕГО по смете» читается из хвоста", () => {
    const lsr = parseOne(lsrDocument({ positions, totals: { sectionTotal: 1000, total: 1000, vatAfterTotal: { percent: 22, amount: 220 } } }));
    expect(lsr.vatPercent).toBe(22);
    expect(lsr.vatAmount).toBe(220);
    expect(lsr.vatInferred).toBe(false);
  });
});

describe("позиции-поставки: материал, оборудование или цена по КП в строке самой позиции", () => {
  it("кабели КЛ-6/КЛ-10 (Гранд-Смета): ФСБЦ-код, объём, базис, индекс, цена и стоимость из строки позиции", () => {
    const lsr = parseOne(REAL_SUPPLY_CABLES);
    expect(lsr.positions.map((position) => [position.number, position.code, position.total])).toEqual([
      [11, "ФСБЦ-21.1.07.02-0097", 215488.29],
      [14, "ФСБЦ-21.1.07.02-0099", 459027.21],
      [16, "ФСБЦ-21.1.07.05-0116", 843281],
      [21, "", 747240.98],
    ]);

    const cable = lsr.positions[2]!;
    expect(cable).toMatchObject({
      book: "MATERIAL_SUPPLY",
      unit: "1000 м",
      quantity: 0.156,
      ownBasePrice: 4359393.11,
      ownIndex: 1.24,
      ownUnitPrice: 5405647.46,
      ownTotal: 843281,
      ownPriceCoefficient: null,
      directTotal: null,
      overhead: null,
      profit: null,
    });
    expect(cable.resources).toEqual([]);

    // Позиция 11 — без базиса и индекса: только цена и стоимость.
    expect(lsr.positions[0]).toMatchObject({ ownBasePrice: null, ownIndex: null, ownUnitPrice: 813163.36, ownTotal: 215488.29 });
  });

  it("кабель по КП без обоснования: наименование вместо кода, коэффициент к цене 1,02 из графы 11", () => {
    const kp = parseOne(REAL_SUPPLY_CABLES).positions[3]!;
    expect(kp).toMatchObject({
      code: "",
      book: "UNKNOWN",
      name: "Кабель ПвПу-10-1х300/70",
      unit: "м",
      quantity: 245,
      ownUnitPrice: 2990.16,
      ownPriceCoefficient: 1.02,
      ownTotal: 747240.98,
    });
    expect(kp.resources).toEqual([]);
  });

  it("Москва («Строительный эксперт»): голый код 04.3.02.13-0022 — материал; ТЦ_06.2.01.02_… — цена заказчика", () => {
    const lsr = parseOne(REAL_SUPPLY_MOSCOW);
    expect(lsr.priceQuarter).toEqual({ quarter: 2, year: 2026 });
    const [mix, tile] = lsr.positions;
    expect(mix).toMatchObject({
      number: 335,
      code: "04.3.02.13-0022",
      book: "MATERIAL_SUPPLY",
      unit: "кг",
      quantity: 4224,
      ownBasePrice: 22.47,
      ownIndex: 1.5,
      ownUnitPrice: 33.71,
      ownTotal: 142391.04,
    });
    expect(tile).toMatchObject({ number: 423, book: "CUSTOMER_PRICE", unit: "м2", quantity: 765.64, ownUnitPrice: 2316.67, ownTotal: 1773735.22 });
    expect(tile!.code).toBe("ТЦ_06.2.01.02_77_7743136928_10.08.2026_02_54.1");
  });
});
