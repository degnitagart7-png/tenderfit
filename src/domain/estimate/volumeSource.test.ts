import { describe, expect, it } from "vitest";

import {
  chooseVolumeSource,
  classifyDocument,
  classifyHeading,
  documentHeadings,
  headingInfoAt,
  isNonWorkHeading,
  volumeSourceLabel,
  volumeSourceLine,
} from "@/domain/estimate/volumeSource";
import {
  NMCK_NAME,
  PROJECT_001_TABLES,
  PROJECT_NAME,
  SMETA_001_OCR,
  SMETA_NAME,
  TZ_NAME,
} from "@/test/volumeSourceFixtures";

describe("classifyHeading", () => {
  it.each([
    ["Таблица 4 - Ведомость потребности машин, механизмов и приспособлений"],
    ["Ведомость потребности машин, механизмов и приспособлений"],
    ["Потребность в кадрах"],
    ["Таблица 5 — Потребность в рабочих кадрах"],
    ["Таблица 6 - Индивидуальные средства защиты для одного работника"],
    ["Средства индивидуальной защиты"],
    ["СИЗ работников"],
    ["Перечень инструмента и приспособлений"],
    ["График производства работ"],
    ["Календарный план выполнения работ"],
    ["Календарный график"],
  ])("«%s» — таблица, которая не работа", (title) => {
    expect(classifyHeading(title)).toBe("NON_WORK");
    expect(isNonWorkHeading(title)).toBe(true);
  });

  it("слово «ведомость» в «Ведомости потребности машин» не делает таблицу ведомостью работ", () => {
    expect(classifyHeading("Ведомость потребности машин, механизмов и приспособлений")).not.toBe("BILL");
  });

  it.each([
    ["ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ"],
    ["Ведомость объёмов работ № 1"],
    ["Приложение № 2. Ведомость работ"],
    ["Дефектная ведомость"],
    ["Ведомость дефектов"],
    ["Таблица 2 - Ведомость объемов работ"],
    ["Сводная ведомость объёмов работ"],
    ["Уточнённая ведомость объемов строительных работ"],
    ["ВОР"],
  ])("«%s» — ведомость объёмов", (title) => {
    expect(classifyHeading(title)).toBe("BILL");
  });

  it.each([
    ['ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01'],
    ["Локальная смета №1"],
    ["Сметный расчёт стоимости"],
    ["Объектный сметный расчёт"],
    ["ЛСР 02-01-01"],
  ])("«%s» — смета заказчика", (title) => {
    expect(classifyHeading(title)).toBe("CUSTOMER_ESTIMATE");
  });

  it("фраза посреди строки заголовком не считается", () => {
    expect(classifyHeading("Основание: ведомость объемов работ № 1")).toBeNull();
    expect(classifyHeading("Подрядчик составляет локальный сметный расчёт самостоятельно")).toBeNull();
    expect(classifyHeading("Таблица 1 - Объем, вес строительного мусора после демонтажа")).toBeNull();
    expect(classifyHeading("")).toBeNull();
  });
});

describe("classifyDocument", () => {
  it("по имени файла: ведомость, ВОР, дефектная ведомость", () => {
    expect(classifyDocument("Ведомость объемов работ.xlsx", "").level).toBe("BILL");
    expect(classifyDocument("ВОР.docx", "").level).toBe("BILL");
    expect(classifyDocument("Дефектная ведомость.pdf", "").level).toBe("BILL");
    expect(classifyDocument("Приложение 3. Ведомость работ.docx", "").level).toBe("BILL");
  });

  it("по имени файла: смета, ЛСР", () => {
    expect(classifyDocument(SMETA_NAME, "").level).toBe("CUSTOMER_ESTIMATE");
    expect(classifyDocument("ЛСР 02-01.xlsx", "").level).toBe("CUSTOMER_ESTIMATE");
    expect(classifyDocument("Локальный сметный расчет.pdf", "").level).toBe("CUSTOMER_ESTIMATE");
  });

  it("«сметный метод» в НМЦК и «сметная документация» сметой заказчика не являются", () => {
    expect(classifyDocument(NMCK_NAME, "").level).toBe("SPEC");
    expect(classifyDocument("Проектная и сметная документация.zip", "").level).toBe("SPEC");
  });

  it("по шапке текста, когда имя говорит мало", () => {
    expect(classifyDocument("Приложение 1.docx", "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ\n1 Кладка | м3 | 12").level).toBe("BILL");
    expect(
      classifyDocument("Приложение 2.pdf", "[Текст распознан со скана]\nЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01").level,
    ).toBe("CUSTOMER_ESTIMATE");
  });

  it("шапка сметы с «Основание: ведомость объемов» ведомостью не становится", () => {
    const text = [
      "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 1",
      "Основание: ведомость объемов работ № 1",
      "1 ГЭСН01-01-001-01 Разработка грунта 1000 м3 1,2",
    ].join("\n");

    expect(classifyDocument("Приложение 2.pdf", text).level).toBe("CUSTOMER_ESTIMATE");
  });

  it("по форме сметы: «Наименование работ и затрат» и «Всего по смете»", () => {
    const text = "Обоснование Наименование работ и затрат Единица\n...\nВсего по смете 100,00";

    expect(classifyDocument("Приложение 4.pdf", text).level).toBe("CUSTOMER_ESTIMATE");
  });

  it("ведомость выигрывает у сметы: «Приложение 1. Ведомость объёмов работ» к смете", () => {
    expect(classifyDocument("Смета с приложениями.docx", "Ведомость объёмов работ\n1 ...").level).toBe("BILL");
  });

  it("ТЗ, проект, спецификация — SPEC", () => {
    expect(classifyDocument(PROJECT_NAME, PROJECT_001_TABLES).level).toBe("SPEC");
    expect(classifyDocument(TZ_NAME, "Техническое задание").level).toBe("SPEC");
  });

  it("живая смета закупки 001 определяется и по имени, и по тексту", () => {
    expect(classifyDocument(SMETA_NAME, SMETA_001_OCR).level).toBe("CUSTOMER_ESTIMATE");
    expect(classifyDocument("Приложение.pdf", SMETA_001_OCR).level).toBe("CUSTOMER_ESTIMATE");
  });
});

describe("заголовки внутри документа", () => {
  const text = [
    "6. Организация работ",
    "Таблица 3 - Календарный план работ",
    "1 Демонтаж стен 10 м3 | 5 дней",
    "2 Вывоз мусора 5 т | 2 дня",
    "Таблица 4 - Ведомость потребности машин, механизмов и приспособлений",
    "1 | Бульдозер - 1 шт.",
    "2 | Каска - 5 шт.",
    "Таблица 5 - Объем работ",
    "1 Демонтаж стен м3 12",
    "7. Мероприятия по охране труда",
    "1 Устройство ограждения м 50",
  ].join("\n");
  const headings = documentHeadings(text);
  const offsetOf = (needle: string): number => text.indexOf(needle);

  it("строка под таблицей-не-работой знает её заголовок", () => {
    const info = headingInfoAt(headings, offsetOf("1 | Бульдозер"));

    expect(info.nonWork).toContain("Ведомость потребности машин");
    expect(info.nonWorkDistance).toBeGreaterThan(0);
  });

  it("следующая таблица обрывает действие заголовка не-работы", () => {
    expect(headingInfoAt(headings, offsetOf("1 Демонтаж стен м3 12")).nonWork).toBeNull();
  });

  it("нумерованный заголовок пункта — тоже граница", () => {
    expect(headingInfoAt(headings, offsetOf("1 Устройство ограждения")).nonWork).toBeNull();
  });

  it("календарный план — не работа", () => {
    expect(headingInfoAt(headings, offsetOf("2 Вывоз мусора")).nonWork).toContain("Календарный план");
  });

  it("ведомость внутри ТЗ задаёт уровень строкам под ней", () => {
    const tz = ["Техническое задание", "Ведомость объёмов работ", "1 Кладка стен м3 12"].join("\n");
    const info = headingInfoAt(documentHeadings(tz), tz.indexOf("1 Кладка"));

    expect(info.level).toBe("BILL");
  });

  it("смета, встроенная в документ, задаёт уровень сметы", () => {
    const info = headingInfoAt(documentHeadings(SMETA_001_OCR), SMETA_001_OCR.indexOf("3 F3CH01"));

    expect(info.level).toBe("CUSTOMER_ESTIMATE");
  });
});

describe("архив: уровень у каждого файла свой", () => {
  const archive = [
    "=== Техническое задание.docx ===",
    "Техническое задание",
    "1 Устройство ограждения м 50",
    "=== ЛСР 02-01.xlsx ===",
    "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01",
    "Обоснование Наименование работ и затрат Единица",
    "1 ГЭСН01-02-027-02 Планировка площадей 1000 м2 0,3477",
    "Всего по смете 100,00",
    "=== Ведомость объемов работ.xlsx ===",
    "1 Кладка стен из кирпича м3 12,5",
  ].join("\n");
  const headings = documentHeadings(archive);
  const at = (needle: string) => headingInfoAt(headings, archive.indexOf(needle));

  it("сам архив по имени и без преамбулы — ТЗ: форма сметы одного файла его не поднимает", () => {
    expect(classifyDocument("Документация.zip", archive).level).toBe("SPEC");
  });

  it("строки файла-сметы — уровень сметы", () => {
    expect(at("1 ГЭСН01-02-027-02").level).toBe("CUSTOMER_ESTIMATE");
  });

  it("строки файла-ведомости (по имени) — уровень ведомости", () => {
    expect(at("1 Кладка стен").level).toBe("BILL");
  });

  it("строки ТЗ перед сметой уровня не получают: действует уровень документа", () => {
    expect(at("1 Устройство ограждения").level).toBeNull();
  });
});

describe("chooseVolumeSource", () => {
  const docs = (...levels: ["BILL" | "CUSTOMER_ESTIMATE" | "SPEC", string][]) =>
    levels.map(([level, name]) => ({ level, name }));

  it("ведомость есть — объёмы из неё; смета и проект не упоминаются как источник", () => {
    const source = chooseVolumeSource({
      accepted: [
        { level: "BILL", document: "ВОР.xlsx" },
        { level: "CUSTOMER_ESTIMATE", document: "ЛСР.pdf" },
        { level: "SPEC", document: "ТЗ.docx" },
      ],
      documentLevels: docs(["BILL", "ВОР.xlsx"], ["CUSTOMER_ESTIMATE", "ЛСР.pdf"], ["SPEC", "ТЗ.docx"]),
    });

    expect(source?.level).toBe("BILL");
    expect(source?.documents).toEqual(["ВОР.xlsx"]);
    expect(source?.note).toBe("Объёмы взяты из ведомости объёмов работ «ВОР.xlsx»");
  });

  it("ведомости нет — смета; формулировка из задания владельца", () => {
    const source = chooseVolumeSource({
      accepted: [
        { level: "CUSTOMER_ESTIMATE", document: SMETA_NAME },
        { level: "SPEC", document: PROJECT_NAME },
      ],
      documentLevels: docs(["CUSTOMER_ESTIMATE", SMETA_NAME], ["SPEC", PROJECT_NAME]),
    });

    expect(source?.level).toBe("CUSTOMER_ESTIMATE");
    expect(source?.documents).toEqual([SMETA_NAME]);
    expect(source?.note).toBe(
      "Ведомости объёмов в документации нет — объёмы взяты из сметы заказчика «7. смета снос Мелихова 4.pdf»",
    );
    expect(volumeSourceLine(source!)).toBe("Объёмы взяты из: сметы заказчика «7. смета снос Мелихова 4.pdf»");
  });

  it("несколько смет одного уровня берутся все", () => {
    const source = chooseVolumeSource({
      accepted: [
        { level: "CUSTOMER_ESTIMATE", document: "ЛСР раздел 1.pdf" },
        { level: "CUSTOMER_ESTIMATE", document: "ЛСР раздел 2.pdf" },
        { level: "CUSTOMER_ESTIMATE", document: "ЛСР раздел 1.pdf" },
      ],
      documentLevels: [],
    });

    expect(source?.documents).toEqual(["ЛСР раздел 1.pdf", "ЛСР раздел 2.pdf"]);
    expect(source?.note).toContain("смет заказчика «ЛСР раздел 1.pdf», «ЛСР раздел 2.pdf»");
  });

  it("только ТЗ и проект — SPEC, и об этом сказано", () => {
    const source = chooseVolumeSource({
      accepted: [{ level: "SPEC", document: PROJECT_NAME }],
      documentLevels: docs(["SPEC", PROJECT_NAME]),
    });

    expect(source?.level).toBe("SPEC");
    expect(source?.note).toContain("Ведомости объёмов в документации нет");
    expect(source?.note).toContain("сметы заказчика нет");
    expect(volumeSourceLabel(source!)).toContain("технического задания");
  });

  it("ведомость найдена, но ничего не подтвердилось — спуск ниже с объяснением", () => {
    const source = chooseVolumeSource({
      accepted: [{ level: "CUSTOMER_ESTIMATE", document: "ЛСР.pdf" }],
      documentLevels: docs(["BILL", "ВОР.xlsx"], ["CUSTOMER_ESTIMATE", "ЛСР.pdf"]),
    });

    expect(source?.level).toBe("CUSTOMER_ESTIMATE");
    expect(source?.note).toContain("Ведомость объёмов «ВОР.xlsx» найдена, но ни одной строки из неё подтвердить не удалось");
  });

  it("принятых строк нет — источника нет", () => {
    expect(chooseVolumeSource({ accepted: [], documentLevels: [] })).toBeNull();
  });
});
