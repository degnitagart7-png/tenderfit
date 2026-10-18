import { describe, expect, it } from "vitest";

import { classifyBill, classifyBillRow, parentPositionNumber } from "@/domain/estimate/billMaterial";
import { readBillTables } from "@/domain/estimate/billTable";
import type { BillOfWorkItem } from "@/domain/estimate/types";

/**
 * Работа или материал: ВОР закупки 0891200000626010037 — материалы стоят подстроками под работой («11.1» под «11»), а «Штуцер стальной
 * приварной» — отдельной пронумерованной строкой. Опознание — документированная эвристика: проверяется и то, что она берёт, и то, чего не берёт.
 */

const VOR = [
  "Ведомость объемов работ",
  "№ п/п\tНаименование\tЕд. изм.\tКол-во",
  "10\tУстройство основания под трубопроводы: песчаного\tм3\t22,5",
  "10.1\tПесок природный для строительных работ II класс, средний\tм3\t24,75",
  "11\tУкладка стальных водопроводных труб диаметром: 75 мм Наружный диаметр трубопровода 89 мм\tкм\t0,675",
  "11.1\tТрубы стальные электросварные прямошовные из стали марок Ст2, 10, наружный диаметр 89 мм, толщина стенки 5 мм\tм\t681,75",
  "12\tУстановка фасонных частей стальных сварным соединением диаметром до 100 мм\tшт\t26",
  "12.1\tОтвод 90° с радиусом кривизны R=1,5 Ду на давление до 16 МПа\tшт\t26",
  "13\tУстановка задвижек диаметром до 100 мм\tшт\t2",
  "13.1\tЗадвижка клиновая с выдвижным шпинделем 30с41нж\tшт\t2",
  "15\tШтуцер стальной приварной, диаметр 50 мм\tшт\t4",
].join("\n");

function billItems(): BillOfWorkItem[] {
  const reading = readBillTables({ documentName: "ВОР.xlsx", text: VOR, documentLevel: "BILL", idPrefix: "d1" });
  expect(reading).not.toBeNull();
  return reading?.items ?? [];
}

describe("classifyBill: ВОР закупки 0891200000626010037", () => {
  const items = billItems();
  const classes = classifyBill([{ title: "ВОР.xlsx", items }]);
  const kindOf = (position: string) => classes.get(items.find((item) => item.positionNumber === position)?.id ?? "")?.kind;

  it("работы с глаголом в начале — работы, в том числе с подстрокой-материалом под ними", () => {
    for (const position of ["10", "11", "12", "13"]) expect(kindOf(position), position).toBe("WORK");
  });

  it("подстроки с названием изделия — материалы: песок, трубы, отвод, задвижка", () => {
    for (const position of ["10.1", "11.1", "12.1", "13.1"]) expect(kindOf(position), position).toBe("MATERIAL");
  });

  it("«Штуцер стальной приварной» — пронумерованная строка без глагола работы и в штуках: материал", () => {
    expect(kindOf("15")).toBe("MATERIAL");
  });

  it("причина называет признак: подномер и название изделия", () => {
    const pipe = items.find((item) => item.positionNumber === "11.1");
    const verdict = classes.get(pipe?.id ?? "");
    expect(verdict?.reason).toContain("подстрока 11.1");
    expect(verdict?.reason).toContain("«11 Укладка стальных водопроводных труб");
  });
});

describe("classifyBillRow: границы эвристики", () => {
  const unit = (name: string, quantityUnit = "м2", positionNumber: string | null = null) => ({ workName: name, quantityUnit, positionNumber });

  it("глагол работы в начале решает: «Монтаж задвижек», «Окраска труб», «Погрузка песка» — работы, хотя в названии есть изделие", () => {
    for (const name of ["Монтаж задвижек клиновых", "Окраска труб стальных", "Погрузка песка в автосамосвалы", "Огрунтовка поверхностей", "Обратная засыпка траншей"]) {
      expect(classifyBillRow(unit(name, "шт", "11.1"), { workName: "Работа", positionNumber: "11" }).kind, name).toBe("WORK");
    }
  });

  it("изделие в середине наименования не мешает: «Песок для устройства основания» — материал", () => {
    expect(classifyBillRow(unit("Песок для устройства основания", "м3", "10.1"), { workName: "Основание", positionNumber: "10" }).kind).toBe("MATERIAL");
  });

  it("название изделия без подномера и с «площадной» единицей — неясно, а не материал: «Грунтовка стен», «Плитка керамическая»", () => {
    expect(classifyBillRow(unit("Грунтовка стен", "м2"), null).kind).toBe("AMBIGUOUS");
    expect(classifyBillRow(unit("Плитка керамическая", "м2"), null).kind).toBe("AMBIGUOUS");
    expect(classifyBillRow(unit("Песок природный", "м3"), null).kind).toBe("AMBIGUOUS");
  });

  it("то же изделие в штуках, тоннах или метрах — материал", () => {
    expect(classifyBillRow(unit("Кабель силовой ВВГнг 3х2,5", "м"), null).kind).toBe("MATERIAL");
    expect(classifyBillRow(unit("Арматура класса А500", "т"), null).kind).toBe("MATERIAL");
    expect(classifyBillRow(unit("Кран шаровой Ду 25", "шт"), null).kind).toBe("MATERIAL");
  });

  it("изделие, которое бывает и установкой («Двери», «Светильники», «Люки»), без подномера — неясно; с подномером — материал", () => {
    expect(classifyBillRow(unit("Двери металлические", "шт"), null).kind).toBe("AMBIGUOUS");
    expect(classifyBillRow(unit("Светильники светодиодные", "шт"), null).kind).toBe("AMBIGUOUS");
    expect(classifyBillRow(unit("Люк чугунный", "шт", "7.2"), { workName: "Устройство колодцев", positionNumber: "7" }).kind).toBe("MATERIAL");
  });

  it("подстрока под работой с названием не из перечня и без глагола — неясно; без родителя — работа (нумерация по главам)", () => {
    expect(classifyBillRow(unit("Тройник равнопроходной", "шт", "12.2"), { workName: "Установка фасонных частей", positionNumber: "12" }).kind).toBe("MATERIAL");
    expect(classifyBillRow(unit("Прочие элементы обвязки", "шт", "12.3"), { workName: "Установка фасонных частей", positionNumber: "12" }).kind).toBe("AMBIGUOUS");
    expect(classifyBillRow(unit("Прочие элементы обвязки", "шт", "2.3"), null).kind).toBe("WORK");
  });

  it("обычная работа без признаков поставки — работа", () => {
    expect(classifyBillRow(unit("Разработка грунта экскаватором", "м3"), null).kind).toBe("WORK");
    expect(classifyBillRow(unit("Стены и перегородки", "м2"), null).kind).toBe("WORK");
  });

  it("«проводка» и «плитка» не совпадают с корнями «провод» и «плит»: слова с другим смыслом не путаются", () => {
    expect(classifyBillRow(unit("Проводка электрическая скрытая", "м"), null).kind).toBe("WORK");
    // «Плитка» — отдельный корень изделия, а «плитняк» — нет.
    expect(classifyBillRow(unit("Плитняк колотый", "м2"), null).kind).toBe("WORK");
  });

  it("номер позиции из PDF в начале наименования не считается словом", () => {
    expect(classifyBillRow(unit("4 Монтаж трубопровода", "м"), null).kind).toBe("WORK");
  });
});

describe("строки смет заказчика не классифицируются", () => {
  it("позиция уровня CUSTOMER_ESTIMATE — работа по определению: у неё свой шифр", () => {
    const item = { id: "x", workName: "Трубы стальные", quantity: 1, quantityUnit: "м", unitDivisor: 1, normCode: null, normBaseType: null, resourceCode: null, sourceQuote: null, sourceDocument: null, sourceLevel: "CUSTOMER_ESTIMATE" as const } satisfies BillOfWorkItem;
    expect(classifyBill([{ title: "ЛСР", items: [item] }]).get("x")?.kind).toBe("WORK");
  });
});

describe("parentPositionNumber", () => {
  it("«11.1» → «11», «2.3.4» → «2.3», у «11» родителя нет", () => {
    expect(parentPositionNumber("11.1")).toBe("11");
    expect(parentPositionNumber("2.3.4")).toBe("2.3");
    expect(parentPositionNumber("11")).toBeNull();
    expect(parentPositionNumber(null)).toBeNull();
  });
});
