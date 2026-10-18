import { describe, expect, it } from "vitest";

import { bundledBimIndexBook, createBimIndexBook, describeLetter, detectBimObject, findElementIndex, objectKey, quarterLabel } from "@/domain/estimate/bimIndices";
import type { BimIndicesData } from "@/domain/estimate/bimIndicesTypes";
import { resolveSubject, zoneOfName } from "@/domain/estimate/bimSubjects";

/*
  Справочник индексов Минстроя (встроенное письмо III кв. 2026) и определение объекта строительства по наименованию стройки.
  Белгородская область, кирпичные многоквартирные дома: ФЕР — ОТ 47,58, материалы 9,58, ЭМ 15,15; ТЕР — 50,75 / 12,09 / 14,22.
*/

const book = bundledBimIndexBook();
const Q3 = { year: 2026, quarter: 3 };
const query = (patch: Partial<Parameters<typeof findElementIndex>[1]> = {}) => ({
  quarter: Q3,
  subject: "Белгородская область",
  zone: null,
  object: "Многоквартирные жилые дома: Кирпичные",
  base: "FER" as const,
  ...patch,
});

describe("поиск индексов в письме", () => {
  it("верхняя строка клетки — ФЕР, нижняя — ТЕР: два набора индексов к одному объекту", () => {
    const fer = findElementIndex(book, query());
    expect(fer).toMatchObject({ status: "FOUND", base: "FER", record: { labour: 47.58, materials: 9.58, machines: 15.15, page: 1 } });
    const ter = findElementIndex(book, query({ base: "TER" }));
    expect(ter).toMatchObject({ status: "FOUND", base: "TER", record: { labour: 50.75, materials: 12.09, machines: 14.22 } });
  });

  it("письмо названо реквизитами: номер, дата, страница", () => {
    const found = findElementIndex(book, query());
    if (found.status !== "FOUND" || found.letter === null) throw new Error("ожидалась запись с письмом");
    expect(describeLetter(found.letter.info)).toBe("письмо Минстроя России от 30.07.2026 № 46728-ИФ/09");
    expect(quarterLabel(Q3)).toBe("III кв. 2026");
  });

  it("квартал входит в ключ: за другой квартал письма нет — ответ «нет квартала» с перечнем имеющихся, а не индекс соседнего", () => {
    expect(findElementIndex(book, query({ quarter: { year: 2026, quarter: 2 } }))).toEqual({ status: "NO_QUARTER", available: [Q3] });
  });

  it("субъект называется в любой форме: «Белгородская обл.», с зоной, «г. Москва»", () => {
    expect(findElementIndex(book, query({ subject: "Белгородская область (1 зона)" })).status).toBe("FOUND");
    expect(findElementIndex(book, query({ subject: "г. Москва", object: "Котельные" })).status).toBe("FOUND");
    expect(findElementIndex(book, query({ subject: "Республика Нигде" })).status).toBe("NO_SUBJECT");
  });

  it("объекта нет у субъекта — список объектов; название сравнивается без регистра и «ё»", () => {
    const missing = findElementIndex(book, query({ object: "Космодромы" }));
    expect(missing.status).toBe("NO_OBJECT");
    expect(findElementIndex(book, query({ object: "многоквартирные ЖИЛЫЕ дома: кирпичные" })).status).toBe("FOUND");
    expect(objectKey("Объекты  образования: Школы")).toBe("объекты образования школы");
  });

  it("ТЕР у субъекта без собственных ТЕР — «нет базы», а не подмена значением ФЕР", () => {
    expect(findElementIndex(book, query({ subject: "Владимирская область", object: "Котельные", base: "FER" })).status).toBe("FOUND");
    expect(findElementIndex(book, query({ subject: "Владимирская область", object: "Котельные", base: "TER" })).status).toBe("NO_BASE");
  });

  it("несколько зон у субъекта: зона нужна; названа — точное значение, не названа — неоднозначность со списком зон", () => {
    const ambiguous = findElementIndex(book, query({ subject: "Иркутская область", object: "Котельные" }));
    expect(ambiguous).toMatchObject({ status: "ZONE_AMBIGUOUS", zones: [1, 2, 3, 4, 5, 6] });
    const third = findElementIndex(book, query({ subject: "Иркутская область", object: "Котельные", zone: 3 }));
    expect(third).toMatchObject({ status: "FOUND", record: { zone: 3 } });
    expect(zoneOfName("Иркутская область (3 зона)")).toBe(3);
  });

  it("серверный справочник квартала заменяет встроенный целиком; кварталы по убыванию", () => {
    const newer = {
      version: 1,
      quarter: { year: 2026, quarter: 4 },
      baseRowMeaning: "",
      letters: [],
      elements: [{ subject: "Белгородская область", zone: null, object: "Котельные", base: "FER", labour: 1, materials: 2, machines: 3, letter: "x", page: 1 }],
      smr: [],
      transport: [],
      design: [],
      notes: [],
    } as unknown as BimIndicesData;
    const merged = createBimIndexBook([...[...book.byQuarter.values()], newer]);
    expect(merged.quarters).toEqual([{ year: 2026, quarter: 4 }, Q3]);
    expect(findElementIndex(merged, query({ quarter: { year: 2026, quarter: 4 }, object: "Котельные" }))).toMatchObject({ status: "FOUND", record: { labour: 1 } });
  });
});

describe("объект строительства по наименованию стройки", () => {
  it("однозначное слово назначает объект", () => {
    expect(detectBimObject("Капитальный ремонт кирпичного многоквартирного дома по ул. Садовой").object).toBe("Многоквартирные жилые дома: Кирпичные");
    expect(detectBimObject("Реконструкция МКД, панельный дом").object).toBe("Многоквартирные жилые дома: Панельные");
    expect(detectBimObject("Строительство детского сада на 220 мест").object).toBe("Объекты образования: Детские сады");
    expect(detectBimObject("Капитальный ремонт здания школы").object).toBe("Объекты образования: Школы");
    expect(detectBimObject("Замена тепловых сетей от котельной").object).toBeNull();
    expect(detectBimObject("Ремонт водопровода").object).toBe("Внешние инженерные сети водопровода");
  });

  it("жилой дом без материала стен — не назначается: у кирпичных, панельных и монолитных индексы разные", () => {
    const found = detectBimObject("Ремонт жилого дома");
    expect(found.object).toBeNull();
    expect(found.candidates).toEqual(expect.arrayContaining(["Многоквартирные жилые дома: Кирпичные", "Многоквартирные жилые дома: Панельные", "Многоквартирные жилые дома: Монолитные"]));
    expect(found.reason).toContain("без материала стен");
  });

  it("два объекта в одном наименовании — не назначается, кандидаты названы", () => {
    const found = detectBimObject("Ремонт школы и детского сада");
    expect(found.object).toBeNull();
    expect(found.candidates).toEqual(["Объекты образования: Школы", "Объекты образования: Детские сады"]);
    expect(found.reason).toContain("несколько объектов");
  });

  it("ничего не узнано — причина, без кандидатов", () => {
    const found = detectBimObject("Благоустройство территории");
    expect(found).toMatchObject({ object: null, candidates: [] });
    expect(found.reason).toContain("не определяется");
  });
});

describe("справочник субъектов", () => {
  it("названия приводятся к субъекту письма; одно слово «область» — не название", () => {
    expect(resolveSubject("Республика Бурятия (5 зона)")).toBe("Республика Бурятия");
    expect(resolveSubject("г. Москва")).toBe("город Москва");
    expect(resolveSubject("область")).toBeNull();
  });
});
