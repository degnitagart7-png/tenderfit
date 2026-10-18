import { describe, expect, it } from "vitest";

import {
  ADDED_SECTION_TITLE,
  RESTORED_SECTION_TITLE,
  anchorOf,
  applyBillEdits,
  billEditsRecordSchema,
  billSignature,
  clearEdit,
  describeBillEdits,
  editsWord,
  nextAddedId,
  parseRejectedVolume,
  recordEdit,
  remainingRejected,
  remapEdits,
  restoreEdit,
  validateAddedRow,
  type AddedRow,
  type BillEdit,
} from "@/domain/estimate/billEdits";
import type { RejectedBillRow } from "@/domain/estimate/billExtraction";
import type { BillOfWorkItem, BillOfWorkSection } from "@/domain/estimate/types";
import { makeBillItem, makeBillSection } from "@/test/estimateFixtures";

/*
  Правка ведомости — чистая функция над списком позиций. Здесь проверяется только она: что
  меняется в позиции, что остаётся нетронутым и как правки находят свои строки в новой ведомости.
  Расчёт денег по исправленной ведомости проверен в estimateRecalc.test.ts.
*/

const WALLS = makeBillItem({
  id: "a-1",
  workName: "Демонтаж наружных стен",
  quantity: 120,
  quantityUnit: "м2",
  unitDivisor: 100,
  normCode: null,
  normBaseType: null,
  positionNumber: "1",
});
const GRADING = makeBillItem({
  id: "a-2",
  workName: "Планировка вручную дна и откосов выемок каналов",
  quantity: 800,
  quantityUnit: "м2",
  unitDivisor: 1000,
  normCode: "01-01-111-01",
  normBaseType: "ГЭСН",
  positionNumber: "2",
  volumeVariants: [
    { quantity: 800, unit: "м2" },
    { quantity: 40, unit: "т" },
  ],
});
const SUPPLY = makeBillItem({
  id: "a-3",
  workName: "Щебень фракции 20-40",
  quantity: 30,
  quantityUnit: "м3",
  unitDivisor: 1,
  normCode: null,
  normBaseType: null,
  resourceCode: "08.3.07.01-0076",
  customerPrice: { total: 60_000, unitPrice: 2000, unit: "м3", origin: "LINE", document: "Смета.pdf" },
});

const BILL: BillOfWorkSection[] = [makeBillSection("ВОР.docx", [WALLS, GRADING, SUPPLY])];

const itemsOf = (sections: readonly BillOfWorkSection[]): BillOfWorkItem[] => sections.flatMap((section) => section.items);
const byId = (sections: readonly BillOfWorkSection[], id: string): BillOfWorkItem | undefined =>
  itemsOf(sections).find((item) => item.id === id);

const NEW_ROW: AddedRow = {
  workName: "Устройство ограждения",
  quantity: 15,
  unit: "м",
  norm: null,
  unitPrice: 1200,
  sourceQuote: null,
  sourceDocument: null,
};

describe("applyBillEdits: применение правок к ведомости", () => {
  it("без правок возвращает ту же ведомость", () => {
    const applied = applyBillEdits(BILL, []);
    expect(applied.sections).toEqual(BILL);
    expect(applied.edited.size).toBe(0);
    expect(applied.unmatched).toEqual([]);
  });

  it("изменить: объём и единица заменяются, делитель и пары величин сбрасываются", () => {
    const edit: BillEdit = { kind: "change", anchor: anchorOf(GRADING), quantity: 900, unit: "м3" };
    const applied = applyBillEdits(BILL, [edit]);
    const item = byId(applied.sections, "a-2");

    expect(item?.quantity).toBe(900);
    expect(item?.quantityUnit).toBe("м3");
    // Делитель назначит расчёт по норме, а парные величины документа больше не выбираются.
    expect(item?.unitDivisor).toBe(1);
    expect(item?.volumeVariants).toBeUndefined();
    expect(applied.edited.has("a-2")).toBe(true);
    // Остальные позиции и исходная ведомость не тронуты.
    expect(byId(applied.sections, "a-1")).toEqual(WALLS);
    expect(GRADING.quantity).toBe(800);
  });

  it("изменить объём: цена заказчика пересчитывается на новый объём той же единицы", () => {
    const edit: BillEdit = { kind: "change", anchor: anchorOf(SUPPLY), quantity: 50 };
    const item = byId(applyBillEdits(BILL, [edit]).sections, "a-3");
    expect(item?.customerPrice?.total).toBe(100_000);
  });

  it("изменить единицу на другую величину: цена заказчика к ней не относится и снимается", () => {
    const edit: BillEdit = { kind: "change", anchor: anchorOf(SUPPLY), unit: "т" };
    const item = byId(applyBillEdits(BILL, [edit]).sections, "a-3");
    expect(item?.customerPrice).toBeNull();
  });

  it("удалить: позиции в ведомости нет, она названа в removed", () => {
    const applied = applyBillEdits(BILL, [{ kind: "remove", anchor: anchorOf(WALLS) }]);
    expect(byId(applied.sections, "a-1")).toBeUndefined();
    expect(applied.removed.map((item) => item.id)).toEqual(["a-1"]);
    expect(itemsOf(applied.sections)).toHaveLength(2);
  });

  it("норма: код и книга выбранной нормы, поставка превращается в работу, выбор помечен ручным", () => {
    const edit: BillEdit = { kind: "norm", anchor: anchorOf(SUPPLY), norm: { code: "46-04-010-01", baseType: "ГЭСН" } };
    const applied = applyBillEdits(BILL, [edit]);
    const item = byId(applied.sections, "a-3");

    expect(item?.normCode).toBe("46-04-010-01");
    expect(item?.normBaseType).toBe("ГЭСН");
    expect(item?.resourceCode).toBeNull();
    expect(applied.manualNorm.has("a-3")).toBe(true);
    expect(applied.manualNorm.has("a-1")).toBe(false);
  });

  it("цена: своя цена за единицу кладётся в позицию", () => {
    const applied = applyBillEdits(BILL, [{ kind: "price", anchor: anchorOf(WALLS), unitPrice: 950.5 }]);
    expect(byId(applied.sections, "a-1")?.ownUnitPrice).toBe(950.5);
  });

  it("добавить: строка попадает в раздел «Добавлено вручную» со своей ценой", () => {
    const applied = applyBillEdits(BILL, [{ kind: "add", id: "add-1", row: NEW_ROW }]);
    const added = applied.sections.find((section) => section.title === ADDED_SECTION_TITLE);

    expect(added?.items).toHaveLength(1);
    expect(added?.items[0]).toMatchObject({
      id: "add-1",
      workName: "Устройство ограждения",
      quantity: 15,
      quantityUnit: "м",
      ownUnitPrice: 1200,
      normCode: null,
    });
    expect(applied.edited.has("add-1")).toBe(true);
  });

  it("добавить с нормой: норма помечена выбранной человеком", () => {
    const row: AddedRow = { ...NEW_ROW, unitPrice: null, norm: { code: "01-01-111-01", baseType: "ГЭСН" } };
    const applied = applyBillEdits(BILL, [{ kind: "add", id: "add-1", row }]);
    expect(applied.manualNorm.has("add-1")).toBe(true);
    expect(byId(applied.sections, "add-1")?.normCode).toBe("01-01-111-01");
  });

  it("вернуть отклонённую: строка идёт в раздел «Возвращено в расчёт» с цитатой и файлом", () => {
    const rejected: RejectedBillRow = {
      reason: "UNKNOWN_UNIT",
      row: { workName: "Вывоз мусора", quantity: "12,5", unit: "м3", evidenceQuote: "Вывоз мусора 12,5 м3" },
      message: "…",
      documentName: "ВОР.docx",
    };
    const edit = restoreEdit(rejected, { quantity: null, unit: null });
    expect(edit).not.toBeNull();

    const applied = applyBillEdits(BILL, [edit as BillEdit]);
    const section = applied.sections.find((item) => item.title === RESTORED_SECTION_TITLE);
    expect(section?.items[0]).toMatchObject({
      workName: "Вывоз мусора",
      quantity: 12.5,
      quantityUnit: "м3",
      sourceQuote: "Вывоз мусора 12,5 м3",
      sourceDocument: "ВОР.docx",
    });
  });

  it("правка строки, которой нет, не падает: уходит в unmatched, остальные применяются", () => {
    const ghost = { ...anchorOf(WALLS), itemId: "нет-такой" };
    const edits: BillEdit[] = [
      { kind: "change", anchor: ghost, quantity: 5 },
      { kind: "price", anchor: anchorOf(WALLS), unitPrice: 10 },
    ];
    const applied = applyBillEdits(BILL, edits);
    expect(applied.unmatched).toEqual([edits[0]]);
    expect(byId(applied.sections, "a-1")?.ownUnitPrice).toBe(10);
  });
});

describe("recordEdit и clearEdit: список правок остаётся коротким", () => {
  it("правка того же вида над той же строкой заменяет прежнюю", () => {
    let edits: BillEdit[] = [];
    edits = recordEdit(edits, { kind: "change", anchor: anchorOf(WALLS), quantity: 130 });
    edits = recordEdit(edits, { kind: "change", anchor: anchorOf(WALLS), quantity: 140 });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ quantity: 140 });
  });

  it("«изменить» без отличий от исходной строки правкой не считается", () => {
    const edits = recordEdit([{ kind: "change", anchor: anchorOf(WALLS), quantity: 130 }], {
      kind: "change",
      anchor: anchorOf(WALLS),
    });
    expect(edits).toEqual([]);
  });

  it("удаление снимает остальные правки строки; правки удалённой строки не копятся", () => {
    let edits: BillEdit[] = [
      { kind: "change", anchor: anchorOf(WALLS), quantity: 130 },
      { kind: "price", anchor: anchorOf(WALLS), unitPrice: 5 },
      { kind: "price", anchor: anchorOf(GRADING), unitPrice: 7 },
    ];
    edits = recordEdit(edits, { kind: "remove", anchor: anchorOf(WALLS) });
    expect(edits.map((edit) => edit.kind)).toEqual(["price", "remove"]);
  });

  it("удаление добавленной строки отменяет её добавление, а не пишет «удалено»", () => {
    let edits = recordEdit([], { kind: "add", id: "add-1", row: NEW_ROW });
    edits = recordEdit(edits, { kind: "remove", anchor: { ...anchorOf(WALLS), itemId: "add-1" } });
    expect(edits).toEqual([]);
  });

  it("правка добавленной строки вносится в саму строку, отдельной правкой не становится", () => {
    let edits = recordEdit([], { kind: "add", id: "add-1", row: NEW_ROW });
    edits = recordEdit(edits, { kind: "change", anchor: { ...anchorOf(WALLS), itemId: "add-1" }, quantity: 99 });
    edits = recordEdit(edits, { kind: "price", anchor: { ...anchorOf(WALLS), itemId: "add-1" }, unitPrice: 77 });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: "add", row: { quantity: 99, unitPrice: 77 } });
  });

  it("clearEdit возвращает автоматический подбор и убирает свою цену", () => {
    const edits: BillEdit[] = [
      { kind: "norm", anchor: anchorOf(WALLS), norm: { code: "01-01-111-01", baseType: "ГЭСН" } },
      { kind: "price", anchor: anchorOf(WALLS), unitPrice: 5 },
      { kind: "remove", anchor: anchorOf(GRADING) },
    ];
    expect(clearEdit(edits, "a-1", "norm").map((edit) => edit.kind)).toEqual(["price", "remove"]);
    expect(clearEdit(edits, "a-1", "price").map((edit) => edit.kind)).toEqual(["norm", "remove"]);
    expect(clearEdit(edits, "a-2", "remove").map((edit) => edit.kind)).toEqual(["norm", "price"]);
  });

  it("nextAddedId не повторяет номера", () => {
    expect(nextAddedId([])).toBe("add-1");
    const edits = recordEdit(recordEdit([], { kind: "add", id: "add-1", row: NEW_ROW }), { kind: "add", id: "add-2", row: NEW_ROW });
    expect(nextAddedId(edits)).toBe("add-3");
  });
});

describe("сопоставление правок с новой ведомостью", () => {
  /** Новая ведомость: номера строк другие, одна строка пропала, одна поменяла объём. */
  const NEW_BILL: BillOfWorkSection[] = [
    makeBillSection("ВОР.docx", [
      { ...GRADING, id: "z-9", volumeVariants: undefined },
      { ...WALLS, id: "z-7" },
      { ...SUPPLY, id: "z-5", quantity: 31, workName: "Щебень фракции 20-40 мм" },
    ]),
  ];

  const edits: BillEdit[] = [
    { kind: "change", anchor: anchorOf(WALLS), quantity: 150 },
    { kind: "norm", anchor: anchorOf(WALLS), norm: { code: "46-04-010-01", baseType: "ГЭСН" } },
    { kind: "price", anchor: anchorOf(GRADING), unitPrice: 100 },
    { kind: "remove", anchor: anchorOf(SUPPLY) },
    { kind: "add", id: "add-1", row: NEW_ROW },
  ];

  it("находит строку по наименованию и объёму, даже если идентификатор другой", () => {
    const remapped = remapEdits(edits, NEW_BILL);
    const wall = remapped.edits.filter((edit) => edit.kind !== "add" && edit.kind !== "restore" && edit.anchor.itemId === "z-7");
    expect(wall.map((edit) => edit.kind)).toEqual(["change", "norm"]);
    const grading = remapped.edits.find((edit) => edit.kind === "price");
    expect(grading && grading.kind === "price" && grading.anchor.itemId).toBe("z-9");
  });

  it("строка, у которой изменились и наименование, и объём, правку не получает — она в unmatched", () => {
    const remapped = remapEdits(edits, NEW_BILL);
    expect(remapped.unmatched.map((edit) => edit.kind)).toEqual(["remove"]);
  });

  it("находит строку по номеру позиции и шифру, когда наименование записано иначе", () => {
    const renamed: BillOfWorkSection[] = [
      makeBillSection("ВОР.docx", [{ ...GRADING, id: "q-1", workName: "Планировка дна каналов вручную", quantity: 810 }]),
    ];
    const remapped = remapEdits([{ kind: "price", anchor: anchorOf(GRADING), unitPrice: 100 }], renamed);
    expect(remapped.unmatched).toEqual([]);
    expect(remapped.edits[0] && remapped.edits[0].kind === "price" && remapped.edits[0].anchor.itemId).toBe("q-1");
  });

  it("добавленные строки переносятся как есть", () => {
    const remapped = remapEdits(edits, NEW_BILL);
    expect(remapped.edits.some((edit) => edit.kind === "add" && edit.id === "add-1")).toBe(true);
  });

  it("возвращённая строка, которая уже есть в новой ведомости, повторно не добавляется", () => {
    const restore: BillEdit = {
      kind: "restore",
      id: "rej-1",
      sourceKey: "k",
      row: { ...NEW_ROW, workName: "Демонтаж наружных стен", quantity: 120, unit: "м2" },
    };
    const remapped = remapEdits([restore], NEW_BILL);
    expect(remapped.alreadyPresent).toEqual([restore]);
    expect(remapped.edits).toEqual([]);
  });

  it("две одинаковые строки получают каждая свою правку", () => {
    const twin = (id: string): BillOfWorkItem => ({ ...WALLS, id });
    const old = [twin("t-1"), twin("t-2")];
    const fresh: BillOfWorkSection[] = [makeBillSection("ВОР.docx", [twin("n-1"), twin("n-2")])];
    const remapped = remapEdits(
      [
        { kind: "price", anchor: anchorOf(old[0] as BillOfWorkItem), unitPrice: 1 },
        { kind: "price", anchor: anchorOf(old[1] as BillOfWorkItem), unitPrice: 2 },
      ],
      fresh,
    );
    const ids = remapped.edits.map((edit) => (edit.kind === "price" ? edit.anchor.itemId : ""));
    expect(ids).toEqual(["n-1", "n-2"]);
  });

  it("отпечаток ведомости не зависит от порядка и идентификаторов, но замечает изменение объёма", () => {
    const same = [makeBillSection("Другой файл", [...itemsOf(BILL)].reverse().map((item, index) => ({ ...item, id: `x-${String(index)}` })))];
    expect(billSignature(same)).toBe(billSignature(BILL));
    const changed = [makeBillSection("ВОР.docx", [{ ...WALLS, quantity: 121 }, GRADING, SUPPLY])];
    expect(billSignature(changed)).not.toBe(billSignature(BILL));
  });
});

describe("отклонённые строки", () => {
  const row = (quantity: string | number, unit: string) => ({ workName: "Вывоз мусора", quantity, unit, evidenceQuote: "q" });

  it("объём и единица читаются: запятая, пробелы, множитель единицы", () => {
    expect(parseRejectedVolume(row("1 200,5", "м3"))).toEqual({ quantity: 1200.5, unit: "м3" });
    expect(parseRejectedVolume(row(5, "100 м3"))).toEqual({ quantity: 500, unit: "м3" });
  });

  it("не читаются: «много», ноль, незнакомая единица — вернуть без правки нельзя", () => {
    expect(parseRejectedVolume(row("много", "м3")).quantity).toBeNull();
    expect(parseRejectedVolume(row("0", "м3")).quantity).toBeNull();
    expect(parseRejectedVolume(row("5", "ящиков")).unit).toBeNull();
    const rejected: RejectedBillRow = { reason: "UNKNOWN_UNIT", row: row("5", "ящиков"), message: "" };
    expect(restoreEdit(rejected, { quantity: null, unit: null })).toBeNull();
    expect(restoreEdit(rejected, { quantity: null, unit: "шт" })).not.toBeNull();
  });

  it("возвращённая строка исчезает из списка отклонённых", () => {
    const rejected: RejectedBillRow[] = [
      { reason: "UNKNOWN_UNIT", row: row("5", "м3"), message: "" },
      { reason: "DUPLICATE", row: { ...row("7", "т"), workName: "Другая" }, message: "" },
    ];
    const edit = restoreEdit(rejected[0] as RejectedBillRow, { quantity: null, unit: null }) as BillEdit;
    expect(remainingRejected(rejected, [edit])).toEqual([rejected[1]]);
  });
});

describe("проверка формы и описание правок", () => {
  it("добавляемая строка: без наименования, объёма, единицы, нормы и цены — не принимается", () => {
    expect(validateAddedRow(NEW_ROW)).toBeNull();
    expect(validateAddedRow({ ...NEW_ROW, workName: " " })).toMatch(/наименование/);
    expect(validateAddedRow({ ...NEW_ROW, quantity: 0 })).toMatch(/Объём/);
    expect(validateAddedRow({ ...NEW_ROW, unit: "ящик" })).toMatch(/единицу/);
    expect(validateAddedRow({ ...NEW_ROW, unitPrice: null })).toMatch(/норму или укажите свою цену/);
  });

  it("запись правок проходит схему; отрицательная цена и нечисловой объём — нет", () => {
    const record = {
      version: 1,
      tenderId: "0123",
      baseJobId: "job-1",
      billSignature: "3-abc",
      updatedAt: "2026-10-09T00:00:00.000Z",
      edits: [{ kind: "price", anchor: anchorOf(WALLS), unitPrice: 5 }],
    };
    expect(billEditsRecordSchema.safeParse(record).success).toBe(true);
    expect(billEditsRecordSchema.safeParse({ ...record, edits: [{ kind: "price", anchor: anchorOf(WALLS), unitPrice: -1 }] }).success).toBe(false);
    expect(billEditsRecordSchema.safeParse({ ...record, edits: [{ kind: "change", anchor: anchorOf(WALLS), quantity: "много" }] }).success).toBe(false);
  });

  it("правки словами: объём, норма, цена, удаление, добавление — по одной записи на позицию", () => {
    const marks = describeBillEdits({
      baseSections: BILL,
      edits: [
        { kind: "change", anchor: anchorOf(WALLS), quantity: 150 },
        { kind: "price", anchor: anchorOf(WALLS), unitPrice: 1200 },
        { kind: "remove", anchor: anchorOf(GRADING) },
        { kind: "add", id: "add-1", row: NEW_ROW },
      ],
    });
    expect(marks).toHaveLength(3);
    expect(marks[0]?.title).toBe("Демонтаж наружных стен");
    expect(marks[0]?.notes[0]).toMatch(/^объём 120 → 150 м2$/);
    expect(marks[0]?.notes[1]).toMatch(/своя цена 1\s?200 ₽ за м2 без НДС/);
    expect(marks[1]?.notes).toEqual(["удалена из расчёта"]);
    expect(marks[2]?.notes[0]).toBe("добавлена вручную");
  });

  it("склонение счётчика", () => {
    expect([1, 2, 5, 11, 21, 22].map(editsWord)).toEqual(["правка", "правки", "правок", "правок", "правка", "правки"]);
  });
});
