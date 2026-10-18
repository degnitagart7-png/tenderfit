import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { BimIndicesData } from "../../src/domain/estimate/bimIndicesTypes";
import { parseBimIndexLetter } from "../../src/lib/fsnb/bimIndexText";
import {
  APP_COPY_DIR,
  BASE_ROW_MEANING,
  buildBimIndices,
  LETTERS_2026Q3,
  OUTPUT_DIR,
  readLetters2026q3,
  stringifyBimIndices,
  type LetterInput,
} from "./build-bim-indices";

/*
  Справочник индексов БИМ собран скриптом из сохранённых текстов писем: тест перестраивает его и сверяет с файлом, поэтому
  правка JSON вручную не пройдёт незамеченной. Копия для приложения (data/ на сервер не выкладывается) обязана совпадать.
*/

const FILE = "bim-indices-2026q3.json";
const stored = readFileSync(resolve(OUTPUT_DIR, FILE), "utf8");
const data = JSON.parse(stored) as BimIndicesData;

describe("bim-indices-2026q3.json", () => {
  it("совпадает с результатом сборки из текстов писем", () => {
    const rebuilt = buildBimIndices(readLetters2026q3()).data;
    expect(stored).toBe(stringifyBimIndices(rebuilt));
  });

  it("копия для приложения совпадает с data/fsnb/normatives", () => {
    expect(readFileSync(resolve(APP_COPY_DIR, FILE), "utf8")).toBe(stored);
  });

  it("квартал, письма и ссылки: у каждой записи есть письмо и страница", () => {
    expect(data.quarter).toEqual({ year: 2026, quarter: 3 });
    expect(data.letters.map((letter) => letter.number)).toEqual(LETTERS_2026Q3.map((letter) => letter.number));
    expect(data.letters.map((letter) => letter.number)).toEqual(["45358-ИФ/09", "46728-ИФ/09", "50058-ИФ/09", "53691-АЛ/09", "58705-ИФ/09"]);
    const ids = new Set(data.letters.map((letter) => letter.id));
    for (const record of [...data.elements, ...data.smr, ...data.transport, ...data.design]) {
      expect(ids.has(record.letter)).toBe(true);
      expect(record.page).toBeGreaterThanOrEqual(1);
    }
  });

  it("смысл двух строк записан в справочнике и сказано, что вывод — по заголовку, а не по сноске", () => {
    expect(data.baseRowMeaning).toBe(BASE_ROW_MEANING);
    expect(data.baseRowMeaning).toContain("верхняя — индекс к единичным расценкам ФЕР-2001, нижняя — к ТЕР-2001");
    expect(data.baseRowMeaning).toContain("Явной сноски");
  });

  it("объём: тысячи записей по элементам, 83 субъекта, ФЕР и ТЕР", () => {
    expect(data.elements.length).toBeGreaterThan(5000);
    expect(new Set(data.elements.map((record) => record.subject)).size).toBeGreaterThanOrEqual(80);
    expect(data.elements.some((record) => record.base === "TER")).toBe(true);
    expect(data.elements.some((record) => record.base === "FER")).toBe(true);
    // ни одной записи целиком из прочерков
    expect(data.elements.every((record) => record.labour !== null || record.materials !== null || record.machines !== null)).toBe(true);
  });

  it("потери названы: страница ОСНБЖ, потерянная страница письма Москвы", () => {
    expect(data.notes.some((note) => note.includes("ОСНБЖ-2001"))).toBe(true);
    expect(data.notes.some((note) => note.includes("50058-ИФ/09") && note.includes("не определена группа"))).toBe(true);
  });
});

/* ------------------------------ Слияние писем ------------------------------ */

function miniLetter(options: { quarterLine: string; values: readonly string[]; tver?: boolean }): string {
  const [labour, labourTer, materials, materialsTer, machines, machinesTer] = options.values;
  return [
    "Сведения сформированы ФГИС ЦС https://fgiscs.minstroyrf.ru/ 08.10.2026 22:08 (МСК)",
    "                       Индексы изменения сметной стоимости",
    `        по элементам прямых затрат по объектам строительства, на ${options.quarterLine}1`,
    "                                  Индексы к ФЕР-2001/ТЕР-2001 по объектам строительства",
    "",
    "                                                              Белгородская         Калужская",
    "            Объект                       Элемент прямых",
    "         строительства                       затрат2",
    "                                                                область             область",
    "",
    `                                                                ${labour}               42,76`,
    "                                      Оплата труда",
    `                                                                ${labourTer}                 -`,
    `                                      Материалы, изделия и      ${materials}                9,53`,
    "                     Административные здания",
    "                                      конструкции",
    `                                                                ${materialsTer}                 -`,
    `                                      Эксплуатация машин и      ${machines}               15,40`,
    "                                      механизмов",
    `                                                                ${machinesTer}                 -`,
    "",
    "Сведения сформированы ФГИС ЦС https://fgiscs.minstroyrf.ru/ 08.10.2026 22:08 (МСК)",
  ].join("\n");
}

const info = (id: string, date: string) => ({ id, number: `${id}-ИФ/09`, date, title: id, file: null });

describe("слияние писем", () => {
  const early: LetterInput = { info: info("aaaaaaaa", "2026-07-23"), text: miniLetter({ quarterLine: "III квартал 2026 года", values: ["47,58", "50,75", "9,58", "12,09", "15,15", "14,22"] }) };
  const late: LetterInput = { info: info("bbbbbbbb", "2026-08-13"), text: miniLetter({ quarterLine: "III квартал 2026 года", values: ["48,00", "51,00", "9,60", "12,10", "15,20", "14,30"] }) };

  it("мини-письмо разбирается: две строки — ФЕР и ТЕР, три элемента", () => {
    const parsed = parseBimIndexLetter(early.text, "aaaaaaaa");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.elements.find((record) => record.subject === "Белгородская область" && record.base === "FER")).toMatchObject({
      object: "Административные здания",
      labour: 47.58,
      materials: 9.58,
      machines: 15.15,
    });
    expect(parsed.elements.find((record) => record.subject === "Белгородская область" && record.base === "TER")).toMatchObject({ labour: 50.75, materials: 12.09, machines: 14.22 });
    // Калужская: нижняя строка — прочерки, ТЕР нет
    expect(parsed.elements.filter((record) => record.subject === "Калужская область").map((record) => record.base)).toEqual(["FER"]);
  });

  it("одна запись в двух письмах: побеждает позднее по дате, замена названа в notes — в каком порядке письма ни передай", () => {
    for (const letters of [[early, late], [late, early]]) {
      const merged = buildBimIndices(letters).data;
      const record = merged.elements.find((item) => item.subject === "Белгородская область" && item.base === "FER");
      expect(record).toMatchObject({ labour: 48, letter: "bbbbbbbb" });
      expect(merged.elements.filter((item) => item.subject === "Белгородская область")).toHaveLength(2);
      expect(merged.notes.some((note) => note.includes("повторяются"))).toBe(true);
    }
  });

  it("письма разных кварталов — ошибка, а не смесь", () => {
    const other: LetterInput = { info: info("cccccccc", "2026-10-20"), text: miniLetter({ quarterLine: "IV квартал 2026 года", values: ["50,00", "-", "9,00", "-", "15,00", "-"] }) };
    expect(() => buildBimIndices([early, other])).toThrow(/кварталу/);
  });

  it("нет писем — ошибка; нет квартала ни в одном письме — ошибка", () => {
    expect(() => buildBimIndices([])).toThrow(/Нет ни одного письма/);
    expect(() => buildBimIndices([{ info: info("dddddddd", "2026-07-01"), text: "пусто" }])).toThrow(/квартал/);
  });
});

describe("сползший прочерк", () => {
  it("прочерк, напечатанный строкой выше своей клетки, остаётся в своей колонке и строке по порядку", () => {
    // У колонки «Калужская область» прочерк ТЕР-материалов напечатан на строке подписи объекта — выше «конструкции».
    const lines = miniLetter({ quarterLine: "III квартал 2026 года", values: ["47,58", "50,75", "9,58", "12,09", "15,15", "14,22"] }).split("\n");
    const label = lines.findIndex((line) => line.includes("Административные здания"));
    const dashAt = (lines.find((line) => line.includes("42,76")) as string).indexOf("42,76") + 2;
    // Прочерк ТЕР-материалов Калужской области печатается на строке подписи объекта — на две строки выше своей клетки.
    lines[label] = (lines[label] as string).padEnd(dashAt, " ") + "-";
    const dashed = lines.findIndex((line, index) => index > label && /12,09\s+-\s*$/.test(line));
    lines[dashed] = (lines[dashed] as string).replace(/(12,09)\s+-\s*$/, "$1");
    const text = lines.join("\n");
    const parsed = parseBimIndexLetter(text, "eeeeeeee");
    expect(parsed.warnings).toEqual([]);
    const belgorod = parsed.elements.filter((record) => record.subject === "Белгородская область");
    expect(belgorod.map((record) => [record.base, record.labour, record.materials, record.machines])).toEqual([
      ["FER", 47.58, 9.58, 15.15],
      ["TER", 50.75, 12.09, 14.22],
    ]);
  });
});
