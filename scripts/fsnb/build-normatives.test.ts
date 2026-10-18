import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isSameRegion, regionCodeOf } from "../../src/domain/regionCodes";
import { buildAll, pageless, parseNorthEntries, readSource } from "./build-normatives";

/*
  Справочники нормативов сверяются с СОХРАНЁННЫМ текстом первоисточников
  (data/fsnb/normatives/sources/): каждое число в JSON должно находиться в тексте приказа.
  Сверка идёт по тексту без пробелов и переносов — числа в PDF переносятся («11,7» + «0» = 11,70).
*/

const OUT = resolve("data/fsnb/normatives");
const built = buildAll();
const json = <T>(name: string): T => JSON.parse(readFileSync(resolve(OUT, name), "utf8")) as T;

/** Текст источника без служебных строк печати и без пробельных символов. */
function squashed(file: string): string {
  return pageless(readSource(file)).join("").replace(/\s+/gu, "");
}
const strip = (value: string): string => value.replace(/\s+/gu, "");

/** Слова текста без чисел таблицы (коэффициентов, номеров пунктов): так строки условий, разорванные числами, склеиваются. */
function words(value: string): string {
  return value
    .split(/\s+/u)
    .filter((token) => token !== "" && !/^\d+(?:[.,]\d+)*$/u.test(token) && token !== "-" && !/^=== стр\./u.test(token) && !/^Страница$/u.test(token))
    .join(" ")
    .toLowerCase()
    .replace(/[^а-яa-z0-9\s-]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("JSON собран скриптом из источников, а не правился вручную", () => {
  it("winter.json, temporary.json, north.json, work-conditions.json совпадают с результатом сборки", () => {
    expect(json("winter.json")).toEqual(JSON.parse(JSON.stringify(built.winter)));
    expect(json("temporary.json")).toEqual(JSON.parse(JSON.stringify(built.temporary)));
    expect(json("north.json")).toEqual(JSON.parse(JSON.stringify(built.north)));
    expect(json("work-conditions.json")).toEqual(JSON.parse(JSON.stringify(built.workConditions)));
  });

  it("копия для приложения (src/domain/estimate/normativesData) совпадает с data/fsnb/normatives: data/ на сервер не выкладывается", () => {
    for (const name of ["winter.json", "temporary.json", "north.json", "work-conditions.json"]) {
      expect(readFileSync(resolve("src/domain/estimate/normativesData", name), "utf8"), name).toBe(readFileSync(resolve(OUT, name), "utf8"));
    }
  });

  it("у каждого справочника есть реквизиты источника и сохранённый файл", () => {
    for (const data of [built.winter, built.temporary, built.north, built.workConditions]) {
      expect(data.source.title.length).toBeGreaterThan(20);
      expect(data.source.url).toMatch(/^https?:\/\//u);
      expect(data.source.edition.length).toBeGreaterThan(5);
      expect(() => readSource(data.source.file)).not.toThrow();
    }
  });
});

describe("зимнее удорожание (приказ 325/пр): числа найдены в тексте приказа", () => {
  const source = squashed("325-pr-zimnee-udorozhanie.txt");

  it("таблица N 1: восемь зон и удельный вес зимнего периода", () => {
    expect(built.winter.temperatureZones.map((zone) => [zone.zone, zone.winterShare])).toEqual([
      ["I", 0.23], ["II", 0.33], ["III", 0.4], ["IV", 0.45], ["V", 0.52], ["VI", 0.6], ["VII", 0.65], ["VIII", 0.65],
    ]);
    for (const zone of built.winter.temperatureZones) expect(source).toContain(strip(zone.fragment));
  });

  it("приложения 1 и 2: каждая строка чисел есть в тексте, значения равны числам фрагмента", () => {
    expect(built.winter.rows.filter((row) => row.table === "A1").length).toBeGreaterThanOrEqual(85);
    expect(built.winter.rows.filter((row) => row.table === "A2").length).toBe(22);
    for (const row of built.winter.rows) {
      expect(source, row.id).toContain(strip(row.fragment));
      // Числа фрагмента: перенесённые цифры («11,7 0») склеиваются, прочерк — зона без норматива.
      const joined = row.fragment
        .replace(/(\d,\d) (\d)(?= |$)/gu, "$1$2")
        .split(/\s+/u)
        .map((token) => token.replace(/(\d)-$/u, "$1"));
      const expected = joined.filter((token) => /^\d+,\d+$/u.test(token)).map((token) => Number(token.replace(",", ".")));
      expect(Object.values(row.percent), row.id).toEqual(expected);
      expect(row.name.length, row.id).toBeGreaterThan(3);
    }
  });

  it("сносы: п. 88 и 89 приложения 1 (введены приказом 170/пр)", () => {
    const demolish = built.winter.rows.find((row) => row.id === "A1-88");
    expect(demolish?.percent).toEqual({ I: 0.88, II: 1.83, III: 3.18, IV: 4.89, V: 6.77, VI: 11.7, VII: 16.17, VIII: 23.06 });
    const destroy = built.winter.rows.find((row) => row.id === "A1-89");
    expect(destroy?.percent).toEqual({ I: 0.53, II: 1.05, III: 1.77, IV: 2.61, V: 3.65, VI: 6.17, VII: 8.96, VIII: 11.18 });
  });

  it("приложение 4: каждая часть субъекта — зона, даты и коэффициент рядом с описанием в тексте", () => {
    expect(built.winter.zoneParts.length).toBe(143);
    expect(new Set(built.winter.zoneParts.map((part) => part.subject)).size).toBe(86);
    for (const part of built.winter.zoneParts) {
      const tail = strip(part.fragment);
      expect(source, part.id).toContain(tail);
      if (part.description !== "") {
        const head = strip(part.description.slice(0, 28));
        expect(source, `${part.id}: описание`).toContain(head);
      }
      // Коэффициент в источнике — число с запятой (в одной строке опечатка «1.2»).
      expect(part.coefficient).toBeGreaterThan(0);
      expect(part.winterStart).toMatch(/^\d{1,2}\.\d{1,2}$/u);
    }
  });

  it("Иркутская область и Бурятия: зоны по приложению 4", () => {
    const irkutsk = built.winter.zoneParts.filter((part) => part.subject === "Иркутская область");
    expect(irkutsk.map((part) => [part.item, part.zone, part.winterStart, part.winterEnd, part.coefficient, part.rest])).toEqual([
      ["42.1", "VI", "1.10", "5.05", 1, false],
      ["42.2", "VI", "5.10", "30.04", 0.9, false],
      ["42.3", "V", "10.10", "25.04", 1, true],
    ]);
    const buryatia = built.winter.zoneParts.filter((part) => part.subject === "Республика Бурятия");
    expect(buryatia.map((part) => [part.item, part.zone, part.coefficient, part.rest])).toEqual([
      ["4.1", "VI", 0.9, false],
      ["4.2", "V", 1, true],
    ]);
  });

  it("правила: дословные фрагменты пунктов Методики найдены в тексте", () => {
    for (const rule of built.winter.rules) {
      expect(words(pageless(readSource("325-pr-zimnee-udorozhanie.txt")).join(" ")), rule.id).toContain(words(rule.fragment));
    }
  });

  it("источник честно говорит про приказ 192/пр от 30.03.2026, которого нет в сохранённом тексте", () => {
    expect(built.winter.source.edition).toContain("192/пр");
    expect(built.winter.rows.some((row) => row.id === "A1-55.4")).toBe(true);
  });
});

describe("временные здания (приказ 332/пр)", () => {
  const source = squashed("332-pr-vremennye-zdaniya.txt");

  it("каждый норматив приложений 1 и 2 найден в тексте рядом с названием", () => {
    expect(built.temporary.rows.filter((row) => row.table === "A2").length).toBe(12);
    expect(built.temporary.rows.filter((row) => row.table === "A1").length).toBeGreaterThanOrEqual(65);
    for (const row of built.temporary.rows) {
      // «номер наименование норматив» подряд (наименование без родителя группы).
      const own = row.fragment;
      expect(source.includes(strip(own)) || source.includes(strip(own).replace(/^\d+(?:\.\d+)*/u, "")), row.id).toBe(true);
      expect(row.percent).toBeGreaterThan(0);
    }
  });

  it("ключевые нормативы", () => {
    const byId = (id: string): number | undefined => built.temporary.rows.find((row) => row.id === id)?.percent;
    expect(byId("A2-1.1")).toBe(0.9);
    expect(byId("A2-1.2")).toBe(1.2);
    expect(byId("A2-2.2")).toBe(0.4);
    expect(byId("A1-48.1")).toBe(1.1);
    expect(byId("A1-50")).toBe(1.8);
    expect(byId("A1-37")).toBe(10.1);
    expect(byId("A1-47.1")).toBe(4);
  });

  it("правила: сносу норматив в процентах не положен (п. 29), капремонт и реконструкция — ×0,8 (п. 25)", () => {
    const text = pageless(readSource("332-pr-vremennye-zdaniya.txt")).join(" ");
    for (const rule of built.temporary.rules) expect(words(text), rule.id).toContain(words(rule.fragment));
  });
});

describe("районы Крайнего Севера (постановление Правительства РФ N 1946)", () => {
  const raw = readSource("1946-north-perechen.txt").replace(/\s+/gu, " ");

  it("каждая запись субъекта найдена в сохранённой выписке", () => {
    for (const subject of built.north.subjects) {
      for (const line of subject.fragment.split("\n")) expect(raw, subject.subject).toContain(line.replace(/\s+/gu, " "));
    }
  });

  it("контрольные числа выписки: 17 субъектов в РКС (с островами) и 17 в МПРКС, 9 в обоих", () => {
    const rks = built.north.subjects.filter((s) => s.whole === "RKS" || s.rks.length > 0);
    const mprks = built.north.subjects.filter((s) => s.mprks.length > 0);
    expect(rks).toHaveLength(17);
    expect(mprks).toHaveLength(17);
    expect(built.north.subjects.filter((s) => (s.whole === "RKS" || s.rks.length > 0) && s.mprks.length > 0)).toHaveLength(9);
    expect(built.north.subjects).toHaveLength(25);
  });

  it("весь субъект: Якутия, Камчатка, Магаданская, Мурманская, НАО, Чукотка, ЯНАО", () => {
    const whole = built.north.subjects.filter((s) => s.whole !== null).map((s) => s.subject);
    expect(whole).toEqual(
      expect.arrayContaining(["Республика Саха (Якутия)", "Камчатский край", "Магаданская область", "Мурманская область", "Ненецкий автономный округ", "Чукотский автономный округ", "Ямало-Ненецкий автономный округ"]),
    );
  });

  it("Бурятия — МПРКС: Северобайкальск и шесть районов, среди них Баргузинский, Курумканский, Окинский", () => {
    const buryatia = built.north.subjects.find((s) => s.subject === "Республика Бурятия");
    expect(buryatia?.mprks.map((entry) => entry.name)).toEqual(["Северобайкальск", "Баунтовский эвенкийский", "Баргузинский", "Курумканский", "Окинский", "Муйский", "Северо-Байкальский"]);
    expect(buryatia?.rks).toEqual([]);
  });

  it("Иркутская область: РКС — Катангский, МПРКС — Усть-Илимск, Братск и восемь районов", () => {
    const irkutsk = built.north.subjects.find((s) => s.subject === "Иркутская область");
    expect(irkutsk?.rks.map((entry) => entry.name)).toEqual(["Катангский"]);
    expect(irkutsk?.mprks.map((entry) => entry.name)).toEqual(["Усть-Илимск", "Братск", "Бодайбинский", "Братский", "Казачинско-Ленский", "Киренский", "Мамско-Чуйский", "Нижнеилимский", "Усть-Илимский", "Усть-Кутский"]);
  });

  it("каждый субъект перечня сопоставляется с регионом справочника", () => {
    for (const subject of built.north.subjects) {
      if (subject.subject.startsWith("Все острова")) continue;
      expect(regionCodeOf(subject.subject.toLowerCase()), subject.subject).not.toBeNull();
    }
    expect(isSameRegion("Ханты-Мансийский автономный округ — Югра", "Ханты-Мансийский автономный округ - Югра")).toBe(true);
  });

  it("разбор записей: тип единицы наследуется, оговорка отделяется", () => {
    expect(parseNorthEntries("городские округа: Зея; Тында; муниципальные районы: Зейский; муниципальный округ Тындинский (за исключением поселка Муртыгит)")).toEqual([
      { kind: "городской округ", name: "Зея", note: null },
      { kind: "городской округ", name: "Тында", note: null },
      { kind: "муниципальный район", name: "Зейский", note: null },
      { kind: "муниципальный округ", name: "Тындинский", note: "за исключением поселка Муртыгит" },
    ]);
  });
});

describe("условия производства работ (421/пр, приложение 10)", () => {
  const text = pageless(readSource("421-pr-pp52-62-prilozhenie-10.txt")).join(" ");
  const appendix = text.slice(text.indexOf("##### ===== Приложение N 10"));

  /** Фрагмент текста одной таблицы: от «Таблица N» до следующей. */
  function tableText(table: number): string {
    const start = appendix.indexOf(`Таблица ${String(table)} `);
    const next = appendix.indexOf(`Таблица ${String(table + 1)} `, start + 1);
    return appendix.slice(start, next < 0 ? undefined : next);
  }

  it("все восемь таблиц на месте, девятая (ГЭСНрр) не переносилась", () => {
    expect(built.workConditions.tables.map((table) => table.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(built.workConditions.notInAppendix.some((line) => line.includes("Таблица 9"))).toBe(true);
  });

  it("каждое условие найдено в своей таблице слово в слово", () => {
    for (const condition of built.workConditions.conditions) {
      expect(words(tableText(condition.table)), condition.id).toContain(words(condition.textFragment));
    }
  });

  it("коэффициенты стоят в тексте таблицы рядом с условием (по строке чисел)", () => {
    for (const condition of built.workConditions.conditions) {
      const table = tableText(condition.table);
      const anchor = table.indexOf(condition.textFragment.split(" ").slice(-4).join(" ").trim());
      const section = anchor >= 0 ? table.slice(anchor) : table;
      expect(strip(section), `${condition.id}: ${condition.valueFragment}`).toContain(strip(condition.valueFragment));
    }
  });

  it("значения: капремонт в эксплуатируемом здании, жилые помещения без расселения, стеснённость", () => {
    const c = (id: string) => built.workConditions.conditions.find((item) => item.id === id);
    expect(c("T5-1.1")?.coefficients).toEqual({ gesn: 1.2, gesnm: 1.2, gesnr: null });
    expect(c("T5-1.2")?.coefficients).toEqual({ gesn: 1.35, gesnm: 1.35, gesnr: 1.15 });
    expect(c("T5-8")?.coefficients).toEqual({ gesn: 1.5, gesnm: 1.5, gesnr: 1.5 });
    expect(c("T5-9.1")?.coefficients).toEqual({ gesn: 1.15, gesnm: 1.15, gesnr: 1.15 });
    expect(c("T5-9.2")?.coefficients).toEqual({ gesn: 1.25, gesnm: null, gesnr: 1.25 });
    expect(c("T5-9.2")?.scope).toBe("ROOF");
    expect(c("T5-9.3")?.scope).toBe("PUBLIC_AREA");
    expect(c("T3-1.1")?.coefficients.gesn).toBe(1.2);
  });

  it("правила п. 52, 56, 58-59 сверены с текстом Методики", () => {
    const methodology = words(text);
    for (const rule of built.workConditions.rules) expect(methodology, rule.id).toContain(words(rule.fragment));
    for (const adjustment of built.workConditions.adjustments) expect(methodology).toContain(words(adjustment.fragment));
  });

  it("у каждого условия есть источник «таблица, пункт»", () => {
    for (const condition of built.workConditions.conditions) {
      expect(condition.source).toMatch(/^Приложение 10 к 421\/пр, таблица \d, п\. [\d.]+$/u);
    }
  });
});
