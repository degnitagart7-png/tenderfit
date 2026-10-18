import { describe, expect, it } from "vitest";

import {
  canonicalCode,
  compareBlind,
  customerPositionsOf,
  generatedUnpricedOf,
  nameSimilarity,
  ourLinesOf,
  tableOfCode,
  type BlindCustomerPosition,
  type BlindOurLine,
} from "@/domain/estimate/benchmarkBlind";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import type { BillOfWorkSection, EstimateDocument } from "@/domain/estimate/types";
import { LSR_08_TEXT } from "@/test/t1118Fixtures";

/*
  Сравнение «вслепую» проверяется на синтетических данных: модели и базы норм здесь нет, позиции и строки заданы прямо.
*/

function position(spec: Partial<BlindCustomerPosition> & Pick<BlindCustomerPosition, "label" | "code" | "name">): BlindCustomerPosition {
  return { lsr: "02-01", sub: false, unit: "м2", quantity: 1, total: 100, ...spec };
}

function line(spec: Partial<BlindOurLine> & Pick<BlindOurLine, "itemId" | "normBaseType" | "normCode" | "normName">): BlindOurLine {
  return {
    normUnit: "м2",
    quantity: 1,
    billQuantity: 1,
    billUnit: "м2",
    total: 100,
    sourceQuote: null,
    sourceDocument: null,
    priceSource: null,
    ...spec,
  };
}

describe("шифры", () => {
  it("книга входит в шифр, пробелы и фигурные скобки не мешают", () => {
    expect(canonicalCode("ГЭСНр 58-01-003-01")).toBe("ГЭСНр58-01-003-01");
    expect(canonicalCode("ГЭСНр58-01-003-01")).toBe("ГЭСНр58-01-003-01");
    expect(canonicalCode("{ГЭСНмр 01-01-001-13} применительно")).toBe("ГЭСНмр01-01-001-13");
    expect(canonicalCode("ГЭСН 58-01-003-01")).not.toBe(canonicalCode("ГЭСНр 58-01-003-01"));
    expect(canonicalCode("ФЕРм 08-01-001-02")).toBe("ФЕРм08-01-001-02");
  });

  it("ресурс ФСНБ — сам код; цена заказчика и прочерк — без шифра", () => {
    expect(canonicalCode("ФСБЦ-01.7.15.03-0042")).toBe("01.7.15.03-0042");
    expect(canonicalCode("91.05.01-017")).toBe("91.05.01-017");
    expect(canonicalCode("ТЦ_01.6.03.03-1082_510")).toBe("01.6.03.03-1082");
    expect(canonicalCode("КА")).toBeNull();
    expect(canonicalCode("—")).toBeNull();
  });

  it("таблица — книга и три первые части; у ресурса таблицы нет", () => {
    expect(tableOfCode("ГЭСНр58-01-003-01")).toBe("ГЭСНр58-01-003");
    expect(tableOfCode("ГЭСН58-01-003-02")).toBe("ГЭСН58-01-003");
    expect(tableOfCode("58-01-003-01")).toBe("58-01-003");
    expect(tableOfCode("01.7.15.03-0042")).toBeNull();
    expect(tableOfCode(null)).toBeNull();
  });
});

describe("похожесть названий", () => {
  it("общие основы слов дают высокий балл, числа и служебные слова не считаются", () => {
    expect(nameSimilarity("Окраска стен водоэмульсионной краской", "Окраска стен водоэмульсионными составами")).toBeGreaterThanOrEqual(0.5);
    expect(nameSimilarity("Окраска стен", "Монтаж светильников")).toBe(0);
    expect(nameSimilarity("", "Монтаж")).toBe(0);
  });
});

describe("compareBlind", () => {
  const customer: BlindCustomerPosition[] = [
    // A: тот же шифр, объём у нас на 20 % больше.
    position({ label: "1", code: "ГЭСН01-01-001-01", name: "Разработка грунта", unit: "100 м3", quantity: 2, total: 1000 }),
    // B: тот же номер, но другая книга (ГЭСНр против ГЭСН) — это другая норма.
    position({ label: "2", code: "ГЭСНр58-01-003-01", name: "Разборка покрытий полов", quantity: 10, total: 500 }),
    // C: та же таблица, другой вариант.
    position({ label: "3", code: "ГЭСН15-02-001-01", name: "Штукатурка стен цементным раствором", quantity: 5, total: 300 }),
    // D: нет шифра у нас, но есть похожая по названию строка.
    position({ label: "4", code: "ГЭСН15-06-001-01", name: "Окраска стен водоэмульсионной краской", quantity: 8, total: 800 }),
    // E: цена заказчика без шифра: сравнивать можно только по названию.
    position({ label: "5", code: "ТЦ_123_510", name: "Светильник светодиодный офисный", unit: "шт", quantity: 4, total: 200 }),
    // F, G: одна норма в двух позициях — объём сравнивается суммой по шифру.
    position({ label: "6", code: "ГЭСН09-03-002-01", name: "Монтаж кабеля", unit: "м", quantity: 40, total: 150 }),
    position({ label: "7", code: "ГЭСН09-03-002-01", name: "Монтаж кабеля", unit: "м", quantity: 60, total: 250 }),
  ];
  const ours: BlindOurLine[] = [
    line({ itemId: "a", normBaseType: "ГЭСН", normCode: "01-01-001-01", normName: "Разработка грунта", normUnit: "100 м3", quantity: 2.4, total: 1200, sourceQuote: "грунт 240 м3", sourceDocument: "ТЗ.docx" }),
    line({ itemId: "b", normBaseType: "ГЭСН", normCode: "58-01-003-01", normName: "Разборка покрытий полов из линолеума", quantity: 10, total: 480 }),
    line({ itemId: "c", normBaseType: "ГЭСН", normCode: "15-02-001-02", normName: "Штукатурка стен", quantity: 5, total: 330 }),
    line({ itemId: "d", normBaseType: "ГЭСН", normCode: "15-04-005-01", normName: "Окраска стен водоэмульсионными составами", quantity: 8, total: 700 }),
    line({ itemId: "f", normBaseType: "ГЭСН", normCode: "09-03-002-01", normName: "Прокладка кабеля", normUnit: "м", quantity: 100, total: 520 }),
    line({ itemId: "z", normBaseType: "ГЭСН", normCode: "09-09-009-09", normName: "Устройство кровли", quantity: 1, total: 600 }),
  ];

  const result = compareBlind({ customer, ours, ourWorkTotal: 3830, customerLsrTotal: 3500 });
  const byLabel = (label: string) => result.positions.find((item) => item.position.label === label);

  it("статусы: шифр, таблица, недостающие", () => {
    expect(byLabel("1")?.status).toBe("MATCHED");
    expect(byLabel("2")?.status).toBe("MISSING");
    expect(byLabel("3")?.status).toBe("SAME_TABLE");
    expect(byLabel("4")?.status).toBe("MISSING");
    expect(byLabel("5")?.status).toBe("MISSING");
    expect(byLabel("6")?.status).toBe("MATCHED");
    expect(byLabel("7")?.status).toBe("MATCHED");
    expect(byLabel("3")?.ourItemIds).toEqual(["c"]);
  });

  it("объём сравнивается в базовой единице и суммой по шифру", () => {
    expect(byLabel("1")?.quantityRatio).toBeCloseTo(1.2, 4);
    // 40 + 60 = 100 м у заказчика, 100 м у нас.
    expect(byLabel("6")?.quantityRatio).toBe(1);
    expect(byLabel("7")?.quantityRatio).toBe(1);
    expect(result.groups.filter((group) => group.scope === "CODE")).toHaveLength(2);
    expect(result.quantity).toMatchObject({ groups: 2, median: 1.1, withinTolerancePercent: 50 });
  });

  it("лишние строки: без пары по шифру и таблице; у похожей по названию есть подсказка", () => {
    expect(result.extras.map((extra) => extra.line.itemId).sort()).toEqual(["b", "d", "z"]);
    // «Разборка покрытий полов» — та же работа, но книга другая: недостающая позиция 2 и лишняя строка b похожи по названию.
    expect(byLabel("2")?.similar).toMatchObject({ ref: "b", side: "OURS" });
    expect(byLabel("4")?.similar).toMatchObject({ ref: "d" });
    expect(byLabel("5")?.similar).toBeNull();
    const extraD = result.extras.find((extra) => extra.line.itemId === "d");
    expect(extraD?.similar?.name).toContain("Окраска стен");
    expect(result.extras.find((extra) => extra.line.itemId === "z")?.similar).toBeNull();
  });

  it("покрытие по рублям: совпавшие, та же таблица, недостающие, лишние", () => {
    const c = result.coverage;
    expect(c).toMatchObject({ customerPositions: 7, matched: 3, sameTable: 1, missing: 3, missingSimilar: 2, extra: 3, extraSimilar: 2 });
    // Вес заказчика: 1000 + 500 + 300 + 800 + 200 + 150 + 250.
    expect(c.customerWeight).toBe(3200);
    expect(c.matchedRub).toBe(1400);
    expect(c.sameTableRub).toBe(300);
    expect(c.missingRub).toBe(1500);
    expect(c.missingSimilarRub).toBe(1300);
    expect(c.matchedPercent).toBe(43.75);
    expect(c.matchedOrTablePercent).toBe(53.13);
    expect(c.missingPercent).toBe(46.88);
    // b + d + z.
    expect(c.extraRub).toBe(1780);
    expect(c.byKind.OTHER).toMatchObject({ positions: 1, customerTotal: 200, missingRub: 200 });
    expect(c.byKind.WORK.positions).toBe(6);
  });

  it("итоги: наш итог против позиций и итога сметы", () => {
    expect(result.totals).toMatchObject({
      ourWorkTotal: 3830,
      ourLinesTotal: 3830,
      customerPositionsTotal: 3200,
      customerLsrTotal: 3500,
      deltaVsPositions: 630,
      deltaPercentVsPositions: 19.69,
      deltaVsLsr: 330,
      deltaPercentVsLsr: 9.43,
    });
  });

  it("главные разрывы по убыванию рублей, с исходной цитатой нашей строки", () => {
    const kinds = result.gaps.map((gap) => `${gap.kind}:${gap.rub}`);
    expect(kinds).toEqual(["MISSING:800", "EXTRA:700", "EXTRA:600", "MISSING:500", "EXTRA:480", "MISSING:200", "QUANTITY:200", "PRICE:120", "VARIANT:30"]);
    const quantity = result.gaps.find((gap) => gap.kind === "QUANTITY");
    expect(quantity?.ratio).toBeCloseTo(1.2, 4);
    expect(quantity?.customer).toMatchObject({ code: "ГЭСН01-01-001-01", quantity: 2, unit: "100 м3" });
    expect(quantity?.ours[0]).toMatchObject({ ref: "a", sourceQuote: "грунт 240 м3", sourceDocument: "ТЗ.docx" });
    // Отношение 1,1 при допуске 0,1 — в допуске: расхождения по объёму нет, остаётся разница цены.
    const price = result.gaps.find((gap) => gap.kind === "PRICE");
    expect(price).toMatchObject({ customerPositions: 2, ratio: 1 });
    const variant = result.gaps.find((gap) => gap.kind === "VARIANT");
    expect(variant).toMatchObject({ rub: 30, customerPositions: 1 });
  });

  it("topN ограничивает список", () => {
    const top = compareBlind({ customer, ours, ourWorkTotal: 3830, customerLsrTotal: null }, { topN: 3 });
    expect(top.gaps).toHaveLength(3);
    expect(top.gaps[0]?.rub).toBe(800);
    expect(top.totals.deltaVsLsr).toBeNull();
    expect(top.totals.deltaPercentVsLsr).toBeNull();
  });
});

describe("compareBlind: единицы и пустые стороны", () => {
  it("«100 м2» у нас и «м2» у заказчика — одна величина", () => {
    const result = compareBlind({
      customer: [position({ label: "1", code: "ГЭСН11-01-011-01", name: "Устройство стяжки", unit: "м2", quantity: 120, total: 1000 })],
      ours: [line({ itemId: "a", normBaseType: "ГЭСН", normCode: "11-01-011-01", normName: "Устройство стяжки", normUnit: "100 м2", quantity: 1.2, total: 1000 })],
      ourWorkTotal: 1000,
      customerLsrTotal: 1000,
    });
    expect(result.positions[0]?.quantityRatio).toBe(1);
    expect(result.gaps).toEqual([]);
  });

  it("разные величины или нечитаемая единица — отношение не определено, позиция всё равно совпала", () => {
    const result = compareBlind({
      customer: [position({ label: "1", code: "ГЭСН11-01-011-01", name: "Устройство стяжки", unit: "м2", quantity: 120, total: 1000 })],
      ours: [line({ itemId: "a", normBaseType: "ГЭСН", normCode: "11-01-011-01", normName: "Устройство стяжки", normUnit: "т", quantity: 5, total: 1000 })],
      ourWorkTotal: 1000,
      customerLsrTotal: null,
    });
    expect(result.positions[0]).toMatchObject({ status: "MATCHED", quantityRatio: null });
    expect(result.quantity).toMatchObject({ groups: 0, median: null, withinTolerancePercent: null });
  });

  it("расчёт ничего не нашёл: всё недостающее, покрытие нулевое", () => {
    const result = compareBlind({ customer: [position({ label: "1", code: "ГЭСН01-01-001-01", name: "Разработка грунта", total: 400 })], ours: [], ourWorkTotal: 0, customerLsrTotal: 400 });
    expect(result.coverage).toMatchObject({ matched: 0, missing: 1, matchedPercent: 0, missingPercent: 100, extra: 0, extraRub: 0 });
    expect(result.totals).toMatchObject({ deltaVsPositions: -400, deltaPercentVsPositions: -100 });
    expect(result.gaps).toHaveLength(1);
  });

  it("у заказчика нет позиций: проценты не определены, всё наше — лишнее", () => {
    const result = compareBlind({ customer: [], ours: [line({ itemId: "a", normBaseType: "ГЭСН", normCode: "01-01-001-01", normName: "Разработка грунта" })], ourWorkTotal: 100, customerLsrTotal: null });
    expect(result.coverage).toMatchObject({ customerPositions: 0, matchedPercent: null, missingPercent: null, extra: 1, extraPercent: null });
    expect(result.totals.deltaPercentVsPositions).toBeNull();
  });

  it("позиция без итога весит ноль и не попадает в разрывы по рублям выше нуля", () => {
    const result = compareBlind({ customer: [position({ label: "1", code: "ГЭСН01-01-001-01", name: "Разработка грунта", total: null })], ours: [], ourWorkTotal: 0, customerLsrTotal: null });
    expect(result.coverage.customerWeight).toBe(0);
    expect(result.coverage.missingPercent).toBeNull();
    expect(result.gaps[0]?.rub).toBe(0);
  });
});

describe("адаптеры", () => {
  it("позиции заказчика из набора ЛСР: порядок документа, подпозиции, шифр и итог", () => {
    const set = buildLsrSet(parseCustomerLsr([{ name: "ЛСР 02-02-08.xlsx", text: LSR_08_TEXT }]).estimates);
    const positions = customerPositionsOf(set);
    expect(positions.length).toBeGreaterThan(10);
    expect(positions[0]).toMatchObject({ lsr: "02-02-08", label: "1" });
    expect(positions.some((item) => item.sub)).toBe(true);
    expect(positions.filter((item) => canonicalCode(item.code) !== null).length).toBeGreaterThan(5);
    expect(positions.every((item) => item.total !== null)).toBe(true);
    // Сравнение с самим собой даёт полное совпадение по шифрам, где шифр есть.
    const own = positions
      .filter((item) => canonicalCode(item.code) !== null)
      .map((item, index) => {
        const code = canonicalCode(item.code) as string;
        const norm = /^(ГЭСН(?:мр|м|р|п)?)(.+)$/u.exec(code);
        return line({
          itemId: `o${String(index)}`,
          normBaseType: norm?.[1] ?? "ФСБЦ",
          normCode: norm?.[2] ?? code,
          normName: item.name,
          normUnit: item.unit,
          quantity: item.quantity ?? 0,
          total: item.total ?? 0,
        });
      });
    const same = compareBlind({ customer: positions, ours: own, ourWorkTotal: 0, customerLsrTotal: null });
    expect(same.coverage.sameTable).toBe(0);
    expect(same.positions.filter((item) => item.code !== null).every((item) => item.status === "MATCHED")).toBe(true);
  });

  it("строки нашего документа: итог строки — прямые + НР + СП, пометка цены", () => {
    const document = {
      sections: [
        {
          title: "Раздел",
          lines: [
            {
              itemId: "d1c1-1",
              normBaseType: "ГЭСН",
              normCode: "01-01-001-01",
              normName: "Разработка грунта",
              normUnit: "1000 м3",
              quantity: 0.5,
              billQuantity: 500,
              billUnit: "м3",
              directCost: 100,
              overheadCost: 20.005,
              profitCost: 10,
              sourceQuote: "грунт 500 м3",
              sourceDocument: "ТЗ.docx",
            },
            {
              itemId: "d1c1-2",
              normBaseType: "ЦЕНА",
              normCode: "—",
              normName: "Светильник",
              normUnit: "шт",
              quantity: 4,
              billQuantity: 4,
              billUnit: "шт",
              directCost: 40,
              overheadCost: 0,
              profitCost: 0,
              sourceQuote: null,
              sourceDocument: null,
              priceSource: "CUSTOMER_PRICE",
            },
          ],
        },
      ],
    } as unknown as EstimateDocument;
    const lines = ourLinesOf(document);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ itemId: "d1c1-1", total: 130.01, priceSource: null, sourceQuote: "грунт 500 м3", sourceDocument: "ТЗ.docx", quantity: 0.5, billQuantity: 500 });
    expect(lines[1]).toMatchObject({ total: 40, priceSource: "CUSTOMER_PRICE" });
  });
});


describe("строки, добавленные расчётом и ИИ: отдельный список со сверкой", () => {
  const customer = [
    position({ label: "1", code: "ГЭСН08-07-001-02", name: "Установка и разборка наружных инвентарных лесов высотой до 16 м: трубчатых для прочих отделочных работ", unit: "100 м2", quantity: 6.1, total: 798_700 }),
    position({ label: "2", code: "ГЭСН26-01-041-01", name: "Изоляция стен", unit: "100 м2", quantity: 0.565, total: 120_000 }),
    position({ label: "3", code: "ГЭСН09-05-001-01", name: "Установка нащельников", unit: "м", quantity: 40, total: 30_000 }),
  ];
  const ours: BlindOurLine[] = [
    line({ itemId: "w1", normBaseType: "ГЭСН", normCode: "26-01-041-01", normName: "Изоляция стен", normUnit: "100 м2", quantity: 0.565, total: 110_000 }),
    // Леса от ИИ: тот же шифр, что у заказчика, объём 199,1 м2 против 610 м2.
    line({ itemId: "gen-ai-1", normBaseType: "ГЭСН", normCode: "08-07-001-02", normName: "Установка и разборка наружных инвентарных лесов", normUnit: "100 м2", quantity: 1.991, total: 260_000, generated: "AI_IMPLIED", sourceQuote: "добавлено ИИ: …; объём = max(#1, #2) = 199,1 м2" }),
    // Другой вариант той же таблицы нащельников.
    line({ itemId: "gen-ai-2", normBaseType: "ГЭСН", normCode: "09-05-001-02", normName: "Установка нащельников из оцинкованной стали", normUnit: "м", quantity: 30, total: 20_000, generated: "AI_IMPLIED" }),
    // Мусор: услуга ФГИС ЦС, у заказчика такой строки в этой смете нет.
    line({ itemId: "gen-debris-load", normBaseType: "ФГИС ЦС ПРР", normCode: "49-1", normName: "Погрузка строительного мусора", normUnit: "т", quantity: 1.7, total: 160, generated: "DEBRIS", priceSource: "FGIS_SERVICE" }),
  ];
  const unpriced = [{ itemId: "gen-debris-disposal", kind: "DEBRIS" as const, name: "Размещение (утилизация) строительного мусора", unit: "т", quantity: 1.7, reason: "тариф полигона не известен — укажите свою цену" }];

  const comparison = compareBlind({ customer, ours, ourWorkTotal: 390_160, customerLsrTotal: 950_000, generatedUnpriced: unpriced });
  const generated = comparison.generated;

  it("считает строки, рубли и виды отдельно; без них — наш итог и отклонение от заказчика", () => {
    expect(generated.count).toBe(3);
    expect(generated.total).toBe(280_160);
    expect(generated.byKind.AI_IMPLIED).toEqual({ count: 2, total: 280_000 });
    expect(generated.byKind.DEBRIS).toEqual({ count: 1, total: 160 });
    expect(generated.ourWorkTotalWithoutGenerated).toBe(110_000);
    // Позиции заказчика — 948 700 ₽: без добавленных строк мы на 88,41 % ниже.
    expect(generated.deltaPercentWithoutGenerated).toBe(-88.41);
    expect(comparison.totals.deltaPercentVsPositions).toBe(-58.87);
  });

  it("леса совпали с позицией заказчика по шифру ГЭСН08-07-001-02, нащельники — та же таблица, мусор — у заказчика нет", () => {
    const [scaffold, flashing, debris] = generated.lines;
    expect(scaffold).toMatchObject({ itemId: "gen-ai-1", kind: "AI_IMPLIED", status: "MATCHED", code: "ГЭСН 08-07-001-02", total: 260_000 });
    expect(scaffold?.customer).toMatchObject({ code: "ГЭСН08-07-001-02", total: 798_700 });
    expect(scaffold?.quantityRatio).toBeCloseTo(1.991 / 6.1, 3);
    expect(scaffold?.note).toContain("добавлено ИИ");
    expect(flashing).toMatchObject({ status: "SAME_TABLE" });
    expect(flashing?.customer).toMatchObject({ code: "ГЭСН09-05-001-01" });
    expect(debris).toMatchObject({ kind: "DEBRIS", status: "NOT_IN_CUSTOMER", customer: null });
    expect([generated.matched, generated.sameTable, generated.notInCustomer]).toEqual([1, 1, 1]);
    expect(generated.matchedRub).toBe(280_000);
    expect(generated.customerMatchedRub).toBe(828_700);
  });

  it("добавленные строки без цены перечислены с причиной", () => {
    expect(generated.unpriced).toEqual(unpriced);
  });

  it("добавленные строки идут и в общее сравнение: леса закрывают позицию заказчика, а не числятся недостающей", () => {
    const scaffold = comparison.positions.find((result) => result.position.label === "1");
    expect(scaffold).toMatchObject({ status: "MATCHED", ourItemIds: ["gen-ai-1"] });
    expect(comparison.coverage.matched).toBe(2);
  });

  it("без добавленных строк список пуст, а итог без них равен итогу", () => {
    const plain = compareBlind({ customer, ours: ours.slice(0, 1), ourWorkTotal: 110_000, customerLsrTotal: null });
    expect(plain.generated).toMatchObject({ count: 0, total: 0, matched: 0, unpriced: [], ourWorkTotalWithoutGenerated: 110_000 });
  });

  it("ourLinesOf помечает строки по позициям ведомости; generatedUnpricedOf находит добавленные позиции без строки сметы", () => {
    const document = {
      sections: [
        {
          lines: [
            { itemId: "a", normBaseType: "ГЭСН", normCode: "08-07-001-02", normName: "Леса", normUnit: "100 м2", quantity: 1, billQuantity: 100, billUnit: "м2", directCost: 10, overheadCost: 1, profitCost: 1, sourceQuote: null, sourceDocument: null },
            { itemId: "b", normBaseType: "ГЭСН", normCode: "26-01-041-01", normName: "Изоляция", normUnit: "100 м2", quantity: 1, billQuantity: 100, billUnit: "м2", directCost: 5, overheadCost: 0, profitCost: 0, sourceQuote: null, sourceDocument: null },
          ],
        },
      ],
    } as unknown as EstimateDocument;
    const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, workName: id, quantity: 1, quantityUnit: "т", unitDivisor: 1, normCode: null, normBaseType: null, resourceCode: null, sourceQuote: null, sourceDocument: null, ...extra });
    const sections = [
      { title: "t", items: [item("a", { generated: "AI_IMPLIED" }), item("b"), item("c", { generated: "DEBRIS", generatedUnpricedReason: "расстояние до полигона не указано" }), item("d", { generated: "DEBRIS" })] },
    ] as unknown as BillOfWorkSection[];

    const lines = ourLinesOf(document, sections.flatMap((section) => section.items));
    expect(lines.map((candidate) => candidate.generated ?? null)).toEqual(["AI_IMPLIED", null]);
    expect(ourLinesOf(document).every((candidate) => candidate.generated === undefined)).toBe(true);

    expect(generatedUnpricedOf(sections, document)).toEqual([
      { itemId: "c", kind: "DEBRIS", name: "c", unit: "т", quantity: 1, reason: "расстояние до полигона не указано" },
      { itemId: "d", kind: "DEBRIS", name: "d", unit: "т", quantity: 1, reason: null },
    ]);
  });
});
