import { describe, expect, it } from "vitest";

import { dedupeItemsAcrossDocuments, leadingRowNumber } from "@/domain/estimate/billDedupe";
import type { BillOfWorkItem } from "@/domain/estimate/types";

function item(workName: string, quantity: number, unit: string, quote: string, document: string, level: BillOfWorkItem["sourceLevel"] = "BILL"): BillOfWorkItem {
  return {
    id: `${document}-${workName}-${String(quantity)}`,
    workName,
    quantity,
    quantityUnit: unit,
    unitDivisor: 1,
    normCode: null,
    resourceCode: null,
    normBaseType: null,
    sourceQuote: quote,
    sourceDocument: document,
    sourceLevel: level,
  };
}

describe("leadingRowNumber", () => {
  it("номер в начале цитаты в обоих видах: табуляция и csv", () => {
    expect(leadingRowNumber("65\tУстройство поясов: в опалубке\tм3\t7,52")).toBe("65");
    expect(leadingRowNumber('65,Устройство поясов: в опалубке,м3,"7,52 …')).toBe("65");
    expect(leadingRowNumber("Устройство поясов")).toBeNull();
    expect(leadingRowNumber("3,5 м3")).toBe("3");
  });
});

describe("dedupeItemsAcrossDocuments", () => {
  const A = "ВОР-ДВ.XLS";
  const B = "ВОР-ДВ.DOC";

  it("строка таблицы и строка модели с одним наименованием, единицей и объёмом — один раз", () => {
    const result = dedupeItemsAcrossDocuments([
      { document: A, items: [item("Устройство поясов: в опалубке", 7.52, "м3", "65\tУстройство поясов: в опалубке\tм3\t7,52", A)] },
      { document: B, items: [item("Устройство поясов:  в опалубке.", 7.52, "м3", '65,Устройство поясов: в опалубке,м3,"7,52 …', B)] },
    ]);
    expect(result.groups[0]?.items).toHaveLength(1);
    expect(result.groups[1]?.items).toHaveLength(0);
    expect(result.duplicateDocuments).toEqual([{ name: B, duplicateOf: A }]);
  });

  it("объём в допуске ±0,5 % совпал, за допуском — нет", () => {
    const first = [item("Кладка стен", 100, "м3", "1 Кладка", A), item("Окраска", 100, "м2", "2 Окраска", A)];
    const second = [item("Кладка стен", 100.4, "м3", "1 Кладка", B), item("Окраска", 101, "м2", "2 Окраска", B), item("Штукатурка", 5, "м2", "3 Штукатурка", B)];
    const result = dedupeItemsAcrossDocuments([
      { document: A, items: first },
      { document: B, items: second },
    ]);
    expect(result.groups[1]?.items.map((i) => i.workName)).toEqual(["Окраска", "Штукатурка"]);
    expect(result.partial).toEqual([{ name: B, duplicateOf: A, dropped: 1 }]);
  });

  it("множитель единицы учтён: «100 м» × 0,1726 и «м» × 17,26 — один объём", () => {
    const result = dedupeItemsAcrossDocuments([
      { document: A, items: [item("Устройство поясков", 0.1726, "100 м", "1 Устройство поясков", A)] },
      { document: B, items: [item("Устройство поясков", 17.26, "м", "1 Устройство поясков", B)] },
    ]);
    expect(result.duplicateDocuments).toHaveLength(1);
  });

  it("повторы внутри одного документа не трогаются", () => {
    const row = (n: string, d: string) => item("Устройство поясков", 0.1726, "100 м", `${n} Устройство поясков`, d);
    const result = dedupeItemsAcrossDocuments([{ document: A, items: [row("7", A), row("9", A)] }]);
    expect(result.groups[0]?.items).toHaveLength(2);
    expect(result.duplicateDocuments).toEqual([]);
    expect(result.partial).toEqual([]);
  });

  it("два повтора в первом и два во втором документе: пары один к одному, документ снят целиком", () => {
    const row = (n: string, d: string) => item("Устройство поясков", 0.1726, "100 м", `${n} Устройство поясков`, d);
    const result = dedupeItemsAcrossDocuments([
      { document: A, items: [row("7", A), row("9", A)] },
      { document: B, items: [row("7", B), row("9", B)] },
    ]);
    expect(result.groups[0]?.items).toHaveLength(2);
    expect(result.groups[1]?.items).toHaveLength(0);
  });

  it("в первом документе одна такая строка, во втором две — вторая лишняя только одна", () => {
    const row = (n: string, d: string) => item("Устройство поясков", 0.1726, "100 м", `${n} Устройство поясков`, d);
    const other = item("Кладка", 10, "м3", "1 Кладка", B);
    const other2 = item("Бетон", 10, "м3", "2 Бетон", B);
    const other3 = item("Окраска", 10, "м2", "3 Окраска", B);
    const result = dedupeItemsAcrossDocuments([
      { document: A, items: [row("7", A)] },
      { document: B, items: [row("7", B), row("9", B), other, other2, other3] },
    ]);
    expect(result.groups[1]?.items).toHaveLength(4);
  });

  it("позиции разных уровней источника (ведомость и смета заказчика) повтором не считаются", () => {
    const result = dedupeItemsAcrossDocuments([
      { document: A, items: [item("Кладка стен", 10, "м3", "1 Кладка стен", A, "BILL")] },
      { document: B, items: [item("Кладка стен", 10, "м3", "1 Кладка стен", B, "CUSTOMER_ESTIMATE")] },
    ]);
    expect(result.groups[1]?.items).toHaveLength(1);
  });

  it("порог 60 %: ровно три из пяти — документ снят целиком, два из пяти — частично", () => {
    const base = ["Кладка", "Бетон", "Окраска", "Штукатурка", "Монтаж"].map((n, i) => item(n, 10 + i, "м3", `${String(i + 1)} ${n}`, A));
    const copy = (count: number) =>
      base.map((it, i) => (i < count ? { ...it, sourceDocument: B } : item(`Другое ${String(i)}`, 500 + i, "м3", `${String(i + 1)} Другое`, B)));
    const three = dedupeItemsAcrossDocuments([{ document: A, items: base }, { document: B, items: copy(3) }]);
    expect(three.duplicateDocuments).toHaveLength(1);
    expect(three.groups[1]?.items).toHaveLength(0);
    const two = dedupeItemsAcrossDocuments([{ document: A, items: base }, { document: B, items: copy(2) }]);
    expect(two.duplicateDocuments).toHaveLength(0);
    expect(two.groups[1]?.items).toHaveLength(3);
  });

  it("номер строки выбирает пару среди одинаковых кандидатов", () => {
    const a1 = item("Устройство поясков", 5, "м", "7 Устройство поясков", A);
    const a2 = item("Устройство поясков", 5, "м", "9 Устройство поясков", A);
    const b = item("Устройство поясков", 5, "м", "9 Устройство поясков", B);
    const extra = [item("Кладка", 1, "м3", "10 Кладка", B), item("Бетон", 1, "м3", "11 Бетон", B)];
    const result = dedupeItemsAcrossDocuments([
      { document: A, items: [a1, a2] },
      { document: B, items: [b, ...extra] },
    ]);
    // Одна повторная из трёх: документ остаётся, убрана одна позиция.
    expect(result.partial[0]?.dropped).toBe(1);
  });
});
