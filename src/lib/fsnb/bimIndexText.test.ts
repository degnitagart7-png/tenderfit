import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { BimElementRecord } from "@/domain/estimate/bimIndicesTypes";
import { resolveSubject, zoneOfName } from "@/domain/estimate/bimSubjects";
import {
  categoryOfFerOnlyTable,
  cleanColumnName,
  cleanObjectName,
  objectNamesOfBlocks,
  parseBimIndexLetter,
  quarterOfLetter,
  splitPages,
  type ParsedLetter,
} from "@/lib/fsnb/bimIndexText";

/*
  Разбор писем Минстроя проверяется на СОХРАНЁННЫХ текстах писем III квартала 2026 года (pdftotext -layout,
  data/fsnb/normatives/sources/bim-indices-2026q3-*.txt) и на маленьких кусках раскладки, повторяющих
  их особенности: сползший на строку выше прочерк, группа объектов на соседней странице, имя субъекта,
  разорванное по строкам.
*/

const SOURCES = resolve("data/fsnb/normatives/sources");
const read = (id: string): string => readFileSync(resolve(SOURCES, `bim-indices-2026q3-${id}.txt`), "utf8");

const cache = new Map<string, ParsedLetter>();
function letter(id: string): ParsedLetter {
  let parsed = cache.get(id);
  if (parsed === undefined) {
    parsed = parseBimIndexLetter(read(id), id);
    cache.set(id, parsed);
  }
  return parsed;
}

const find = (records: readonly BimElementRecord[], subject: string, object: string, base: "FER" | "TER", zone: number | null = null): BimElementRecord | undefined =>
  records.find((record) => record.subject === subject && record.object === object && record.base === base && record.zone === zone);

describe("страницы письма", () => {
  it("делятся по колонтитулу ФГИС ЦС; номер — из «-» и числа, без них — следующий по порядку", () => {
    const text = [
      "Сведения сформированы ФГИС ЦС https://fgiscs.minstroyrf.ru/ 08.10.2026 22:08 (МСК)",
      "первая страница",
      "Сведения сформированы ФГИС ЦС https://fgiscs.minstroyrf.ru/ 08.10.2026 22:08 (МСК)",
      "-",
      "                  7",
      "седьмая страница",
      "Сведения сформированы ФГИС ЦС https://fgiscs.minstroyrf.ru/ 08.10.2026 22:08 (МСК)",
      "следующая без номера",
    ].join("\n");
    expect(splitPages(text).map((page) => page.page)).toEqual([1, 7, 8]);
  });

  it("письмо 13.08 начинается со 2-й страницы: первая пуста и не считается", () => {
    const pages = splitPages(read("862c733b"));
    expect(pages[0]?.page).toBe(2);
  });
});

describe("названия субъектов и объектов", () => {
  it("колонка: перенос с дефисом, слипшийся повтор, сноска", () => {
    expect(cleanColumnName("Кабардино- Балкарская Республика")).toBe("Кабардино-Балкарская Республика");
    expect(cleanColumnName("РеспубликаРеспублика Карелия (1 зона)")).toBe("Республика Карелия (1 зона)");
    expect(cleanColumnName("Сахалинская область (1 зона) 6")).toBe("Сахалинская область (1 зона)");
    expect(cleanColumnName("Ленинградская область9")).toBe("Ленинградская область");
  });

  it("субъект приводится к названию справочника зон; зона — из «(N зона)»", () => {
    expect(resolveSubject("г. Москва")).toBe("город Москва");
    expect(resolveSubject("г. Санкт-Петербург")).toBe("город Санкт-Петербург");
    expect(resolveSubject("Карелия (2 зона)")).toBe("Республика Карелия");
    expect(resolveSubject("Нижегородская область")).toBe("Нижегородская область");
    expect(resolveSubject("г. Саров (Нижегородская область)")).toBe("город Саров (Нижегородская область)");
    expect(resolveSubject("Ханты-Мансийский автономный округ – Югра (2 зона)")).toBe("Ханты-Мансийский автономный округ - Югра");
    expect(resolveSubject("Республика")).toBeNull();
    expect(resolveSubject("Нет такого субъекта")).toBeNull();
    expect(zoneOfName("Республика Коми (3 зона)")).toBe(3);
    expect(zoneOfName("Белгородская область")).toBeNull();
  });

  it("объект: сноски убираются, «ВЛ 2203,4» — это ВЛ 220 кВ", () => {
    expect(cleanObjectName("ВЛ 2203,4")).toBe("ВЛ 220 кВ");
    expect(cleanObjectName("ВЛ 330 кВ4")).toBe("ВЛ 330 кВ");
    expect(cleanObjectName("ВЛ 110 кВ на металлических опорах3,4,5")).toBe("ВЛ 110 кВ на металлических опорах");
    expect(cleanObjectName("Аэродромы гражданского назначения6")).toBe("Аэродромы гражданского назначения");
    expect(cleanObjectName("ВЛ 0,4-20 кВ с самонесущими изолированными проводами на железобетонных опорах3")).toBe(
      "ВЛ 0,4-20 кВ с самонесущими изолированными проводами на железобетонных опорах",
    );
  });

  it("группа объектов: вид без группы берёт ближайший якорь, самостоятельный объект — границу; нет якоря — null", () => {
    expect(
      objectNamesOfBlocks([
        { group: null, subtype: "Прочие" },
        { group: "Административные здания", subtype: null },
        { group: null, subtype: "Детские сады" },
        { group: "Объекты образования", subtype: "Школы" },
        { group: null, subtype: "Прочие" },
        { group: null, subtype: "Поликлиники" },
        { group: "Объекты здравоохранения", subtype: "Больницы" },
        { group: null, subtype: "Прочие" },
      ]),
    ).toEqual([
      null, // группа осталась на потерянной странице
      "Административные здания",
      "Объекты образования: Детские сады",
      "Объекты образования: Школы",
      "Объекты образования: Прочие",
      "Объекты здравоохранения: Поликлиники",
      "Объекты здравоохранения: Больницы",
      "Объекты здравоохранения: Прочие",
    ]);
  });

  it("квартал письма и категория таблицы только с ФЕР", () => {
    expect(quarterOfLetter("на III квартал 2026 года")).toEqual({ year: 2026, quarter: 3 });
    expect(categoryOfFerOnlyTable(["ВЛ 35 кВ", "ВЛ 220 кВ"])).toBe("ВЛ ПАО «Россети»");
    expect(categoryOfFerOnlyTable(["Градирня", "Здание реактора"])).toBe("Объекты использования атомной энергии");
    expect(categoryOfFerOnlyTable(["Школы"])).toBeNull();
  });
});

describe("письмо 30.07 № 46728-ИФ/09: Белгородская область — пример из задания", () => {
  const elements = letter("4a127ad8").elements;

  it("кирпичные жилые дома: верхние строки ОТ 47,58 / материалы 9,58 / ЭМ 15,15 — это ФЕР", () => {
    const record = find(elements, "Белгородская область", "Многоквартирные жилые дома: Кирпичные", "FER");
    expect(record).toMatchObject({ labour: 47.58, materials: 9.58, machines: 15.15, letter: "4a127ad8", page: 1 });
  });

  it("нижние строки ОТ 50,75 / материалы 12,09 / ЭМ 14,22 — это ТЕР-2001 субъекта", () => {
    const record = find(elements, "Белгородская область", "Многоквартирные жилые дома: Кирпичные", "TER");
    expect(record).toMatchObject({ labour: 50.75, materials: 12.09, machines: 14.22 });
  });

  it("у субъекта без собственных ТЕР нижняя строка — прочерк: записи ТЕР нет (Калужская область)", () => {
    expect(find(elements, "Калужская область", "Многоквартирные жилые дома: Кирпичные", "FER")).toMatchObject({ labour: 42.76, materials: 9.53, machines: 15.4 });
    expect(find(elements, "Калужская область", "Многоквартирные жилые дома: Кирпичные", "TER")).toBeUndefined();
  });

  it("группа «Многоквартирные жилые дома» стоит против средних объектов и достаётся всем четырём, в том числе «Прочие» на следующей странице", () => {
    const objects = elements.filter((record) => record.subject === "Белгородская область" && record.base === "FER").map((record) => record.object);
    expect(objects).toEqual(
      expect.arrayContaining([
        "Многоквартирные жилые дома: Кирпичные",
        "Многоквартирные жилые дома: Панельные",
        "Многоквартирные жилые дома: Монолитные",
        "Многоквартирные жилые дома: Прочие",
        "Административные здания",
        "Объекты образования: Школы",
        "Объекты здравоохранения: Больницы",
      ]),
    );
    expect(find(elements, "Белгородская область", "Многоквартирные жилые дома: Панельные", "FER")).toMatchObject({ materials: 11.2, machines: 14.64 });
  });

  it("колонки: зоны Республики Коми и Карелии с разорванным названием", () => {
    expect(find(elements, "Республика Коми", "Многоквартирные жилые дома: Кирпичные", "FER", 1)).toMatchObject({ labour: 53.34, materials: 11.02, machines: 16.9 });
    expect(find(elements, "Республика Коми", "Многоквартирные жилые дома: Кирпичные", "TER", 5)).toMatchObject({ labour: 39.09, materials: 10.83, machines: 13.58 });
    expect(find(elements, "Республика Карелия", "Многоквартирные жилые дома: Кирпичные", "FER", 1)).toBeDefined();
    expect(find(elements, "Республика Карелия", "Многоквартирные жилые дома: Кирпичные", "FER", 2)).toBeDefined();
  });
});

describe("письмо 23.07 № 45358-ИФ/09: ЦФО, Юг, Сибирь, Дальний Восток", () => {
  const parsed = letter("d465eb3f");

  it("прочерк, сползший на строку выше, не сдвигает значения: у каждой колонки значений поровну", () => {
    // Страница 5 письма 30.07 с таким сдвигом — блок «ВЛ 0,4-20 кВ…»: пятая колонка (Тверская) вся прочерки.
    const tver = find(letter("4a127ad8").elements, "Тверская область", "Воздушная прокладка провода с медными жилами", "FER");
    expect(tver).toMatchObject({ labour: 49.32, materials: 6.85, machines: 8.86 });
    expect(find(letter("4a127ad8").elements, "Тверская область", "ВЛ 0,4-20 кВ с самонесущими изолированными проводами на железобетонных опорах", "FER")).toBeUndefined();
  });

  it("блок, разорванный границей страницы (27 значений в колонке), собирается из двух страниц", () => {
    const amur = parsed.elements.filter((record) => record.subject === "Амурская область" && record.zone === 1 && record.base === "FER");
    expect(amur.length).toBeGreaterThan(30);
    expect(amur.some((record) => record.object === "Объекты здравоохранения: Поликлиники")).toBe(true);
  });

  it("зоны Сахалинской области со сноской 9", () => {
    expect(find(parsed.elements, "Сахалинская область", "Административные здания", "FER", 5)).toMatchObject({ labour: 128.82 });
  });

  it("линейные объекты ПАО «Россети» (только ФЕР) не смешиваются с общими: одинаковые названия объектов", () => {
    const rossetiVl = parsed.elements.filter((record) => record.object === "ВЛ ПАО «Россети»: ВЛ 110 кВ на металлических опорах");
    const generalVl = parsed.elements.filter((record) => record.object === "ВЛ 110 кВ на металлических опорах");
    expect(rossetiVl.length).toBeGreaterThan(0);
    expect(generalVl.length).toBeGreaterThan(0);
    expect(rossetiVl.every((record) => record.base === "FER")).toBe(true);
  });

  it("электрификация и железные дороги: индекс СМР к ФЕР; индексы ПИР общие для страны", () => {
    const bryansk = parsed.smr.filter((record) => record.subject === "Брянская область");
    expect(bryansk.map((record) => [record.object, record.value])).toEqual(
      expect.arrayContaining([
        ["Электрификация железных дорог", 7.52],
        ["Железные дороги", 11],
      ]),
    );
    const design = parsed.design.filter((record) => record.kind === "DESIGN").map((record) => [record.level, record.value]);
    expect(design).toEqual(expect.arrayContaining([["2001-01-01", 7.22], ["2025-01-01", 1.17], ["1995-01-01", 55.26]]));
    expect(parsed.design.filter((record) => record.kind === "SURVEY").map((record) => [record.level, record.value])).toEqual(
      expect.arrayContaining([["2001-01-01", 7.19], ["1991-01-01", 81.95]]),
    );
  });

  it("перевозка: тип автотранспорта берётся из положения заголовка над колонкой", () => {
    const transport = parsed.transport.filter((record) => record.subject === "Брянская область").map((record) => [record.vehicle, record.value]);
    expect(transport).toEqual(
      expect.arrayContaining([
        ["автомобили бортовые", 17.9],
        ["автомобили-самосвалы", 14.62],
        ["автомобили-панелевозы", 15.88],
        ["автомобили-трубоплетевозы", 12.26],
        ["автобетоносмесители", 12.04],
      ]),
    );
  });
});

describe("письма 13.08, 28.08, 21.09", () => {
  it("Москва (письмо 13.08): страница 1 письма не извлеклась — объекты её группы пропущены с предупреждением, а не угаданы", () => {
    const moscow = letter("862c733b");
    expect(find(moscow.elements, "город Москва", "Объекты образования: Школы", "FER")).toMatchObject({ labour: 76.82, materials: 7.35, machines: 14.87 });
    expect(find(moscow.elements, "город Москва", "Многоквартирные жилые дома: Прочие", "FER")).toBeUndefined();
    expect(find(moscow.elements, "город Москва", "Объекты образования: Прочие", "FER")).toMatchObject({ materials: 7.75 });
    expect(moscow.warnings.some((warning) => warning.includes("не определена группа"))).toBe(true);
  });

  it("атомная энергетика (одна строка на элемент) с префиксом приложения", () => {
    const atom = letter("73448900").elements.filter((record) => record.object.startsWith("Объекты использования атомной энергии"));
    expect(atom.length).toBeGreaterThan(0);
    expect(atom.every((record) => record.base === "FER")).toBe(true);
    expect(find(letter("862c733b").elements, "Ленинградская область", "Объекты использования атомной энергии: Градирня", "FER")).toMatchObject({ labour: 107.45, materials: 6.94, machines: 13.25 });
  });

  it("СМР и ПНР по объектам (две строки на объект: ФЕР и ТЕР)", () => {
    const kuzbass = letter("73448900").smr.filter((record) => record.subject === "Кемеровская область - Кузбасс" && record.kind === "SMR_PNR");
    const brick = kuzbass.filter((record) => record.object === "Многоквартирные жилые дома: Кирпичные");
    expect(brick.map((record) => [record.base, record.value])).toEqual([
      ["FER", 22.37],
      ["TER", 19.68],
    ]);
  });

  it("автомобильные дороги (письмо 21.09): СМР по зонам Ямало-Ненецкого округа", () => {
    const roads = letter("1ae7a169").smr.filter((record) => record.subject === "Ямало-Ненецкий автономный округ");
    const first = roads.find((record) => record.zone === 1 && record.object === "Автомобильные дороги");
    expect(first).toMatchObject({ value: 26.06, base: "FER", kind: "SMR" });
    expect(roads.find((record) => record.zone === 1 && record.object.startsWith("Искусственные"))).toMatchObject({ value: 32.64 });
    // ЗОНА 3 — прочерки: записи нет
    expect(roads.some((record) => record.zone === 3)).toBe(false);
  });
});

describe("согласованность всех писем", () => {
  const ids = ["d465eb3f", "4a127ad8", "862c733b", "73448900", "1ae7a169"];

  it("все письма с заголовком — III квартал 2026 года; у письма Москвы заголовка в тексте нет, квартал тогда берётся у соседних писем", () => {
    for (const id of ids.filter((item) => item !== "862c733b")) expect(letter(id).quarter).toEqual({ year: 2026, quarter: 3 });
    expect(letter("862c733b").quarter).toBeNull();
  });

  it("каждый субъект опознан: предупреждений о неопознанных колонках нет", () => {
    for (const id of ids) expect(letter(id).warnings.filter((warning) => warning.includes("не опознан"))).toEqual([]);
  });

  it("предупреждения — только известные потери: страница 1 письма Москвы и плотные объекты стр. 45 письма 28.08", () => {
    const lost = ids.flatMap((id) => letter(id).warnings.map((warning) => `${id}: ${warning}`));
    expect(lost.length).toBeLessThanOrEqual(4);
    expect(lost.every((line) => line.startsWith("862c733b: стр. 2:") || line.startsWith("73448900: стр. 45:"))).toBe(true);
  });

  it("оплата труда у субъекта одна для всех объектов базы (проверка выравнивания колонок и блоков)", () => {
    const labour = new Map<string, Set<number>>();
    for (const id of ids) {
      for (const record of letter(id).elements) {
        if (record.labour === null || record.object.includes("дорог") || record.object.includes("алмаз") || record.object.includes("Подземные рудники") || record.object.includes("Карьеры") || record.object.includes("радиоактивных")) continue;
        const key = `${record.subject}|${String(record.zone)}|${record.base}|${record.object.startsWith("ВЛ ПАО") ? "vl" : record.object.startsWith("Объекты использования") ? "npp" : "common"}`;
        labour.set(key, (labour.get(key) ?? new Set()).add(record.labour));
      }
    }
    const inconsistent = [...labour.entries()].filter(([, values]) => values.size > 1).map(([key]) => key);
    expect(inconsistent).toEqual([]);
  });

  it("индексы правдоподобны: ОТ 20–200, материалы 3–120, машины 4–60", () => {
    for (const id of ids) {
      for (const record of letter(id).elements) {
        if (record.labour !== null) expect(record.labour).toBeGreaterThan(20);
        if (record.labour !== null) expect(record.labour).toBeLessThan(200);
        if (record.materials !== null) expect(record.materials).toBeGreaterThan(3);
        if (record.materials !== null) expect(record.materials).toBeLessThan(120);
        if (record.machines !== null) expect(record.machines).toBeGreaterThan(4);
        if (record.machines !== null) expect(record.machines).toBeLessThan(60);
      }
    }
  });
});
