import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseContractEstimates } from "@/domain/estimate/contractEstimate";
import { parseCustomerBim } from "@/domain/estimate/customerBim";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { parseCustomerNmck } from "@/domain/estimate/customerNmck";
import { cutSpans, findEstimateLeaks, stripCustomerEstimates } from "@/domain/estimate/estimateRemoval";
import { CONTRACT_ESTIMATE_TEXT, DOCUMENTS_1118, LSR_05_13_TEXT, LSR_08_TEXT, NMCK_CALCULATION_TEXT, NMCK_NAME } from "@/test/t1118Fixtures";
import { RIM_DEMOLITION_TEXT, RIM_SECTIONS_TEXT, TSN_2001_TEXT } from "@/test/smetaRuFixtures";

/*
  Вырезание смет заказчика проверяется на настоящих вырезках из документации закупок (src/domain/estimate/__fixtures__):
  три разбора смет и разбор НМЦК после него в остатке не находят ничего, а ТЗ рядом со сметой остаётся нетронутым.
*/

const bim = (name: string): string => readFileSync(resolve("src/domain/estimate/__fixtures__/bim", name), "utf8");
const lsr0377 = readFileSync(resolve("src/domain/estimate/__fixtures__/t0377/lsr-irkutsk-no-groups.txt"), "utf8");

/** Техническое задание: то, что в архиве рядом со сметой и обязано уцелеть. */
const TZ_TEXT = [
  "ТЕХНИЧЕСКОЕ ЗАДАНИЕ",
  "на выполнение ремонтных работ в вентиляционной камере",
  "1. Заменить задвижки диаметром 100 мм в количестве 4 шт., краны водоразборные в количестве 8 шт.",
  "2. Выполнить окраску стен водоэмульсионной краской, площадь 340 м2, и изоляцию воздуховодов матами минераловатными, 75 м2.",
  "3. Работы выполнить в срок до 30 ноября, гарантия на работы 24 месяца, качество материалов подтвердить сертификатами.",
].join("\n");

/** Ведомость объёмов: в ней есть «Итого по разделу», но формы 421/пр у неё нет — она остаётся. */
const BILL_TEXT = [
  "Ведомость объёмов работ",
  "№ п/п,Наименование работ,Ед. изм.,Количество",
  "Раздел 1. Кровля",
  "1,Устройство кровли из профнастила,м2,420",
  "2,Устройство водосточных желобов,м,64",
  "Итого по разделу 1,,,484",
  "Раздел 2. Фасад",
  "3,Окраска фасада,м2,310",
  "Итого по разделу 2,,,310",
].join("\n");

const archive = (name: string, entries: readonly { readonly file: string; readonly text: string }[]): string =>
  [`=== ${name} ===`, ...entries.map((entry) => `=== ${entry.file} ===\n${entry.text}`)].join("\n");

const noEstimates = (documents: readonly { name: string; text: string }[]): void => {
  expect(parseCustomerLsr(documents).estimates).toEqual([]);
  expect(parseCustomerBim(documents).estimates).toEqual([]);
  expect(parseContractEstimates(documents).rows).toEqual([]);
  expect(parseCustomerNmck(documents)).toBeNull();
};

describe("архив с ТЗ и ЛСР: уходит только смета", () => {
  const text = archive("Описание объекта закупки.rar", [
    { file: "Описание объекта закупки/Техническое задание.docx", text: TZ_TEXT },
    { file: "Описание объекта закупки/ЛСР 02-02-08 Ремонтные работы по вентиляции.xlsx", text: LSR_08_TEXT },
    { file: "Описание объекта закупки/Ведомость объёмов работ.xlsx", text: BILL_TEXT },
  ]);

  it("ЛСР вырезана целиком с меткой файла, ТЗ и ведомость уцелели как были", () => {
    expect(parseCustomerLsr([{ name: "Описание.rar", text }]).estimates).toHaveLength(1);
    const result = stripCustomerEstimates([{ name: "Описание.rar", text }]);

    expect(result.documents).toHaveLength(1);
    const rest = result.documents[0]?.text ?? "";
    expect(rest).toBe(archive("Описание объекта закупки.rar", [
      { file: "Описание объекта закупки/Техническое задание.docx", text: TZ_TEXT },
      { file: "Описание объекта закупки/Ведомость объёмов работ.xlsx", text: BILL_TEXT },
    ]));
    expect(rest).not.toContain("ЛСР 02-02-08");
    expect(rest).not.toContain("ГЭСН");
    expect(result.removed).toEqual([expect.objectContaining({ kind: "LSR", label: "ЛСР 02-02-08" })]);
    expect(result.leaks).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.documents[0]?.removedChars).toBe(text.length - rest.length);
    noEstimates(result.documents);
  });

  it("ЛСР в середине архива: до и после неё текст не затронут", () => {
    const middle = archive("Архив.zip", [
      { file: "a/ТЗ.docx", text: TZ_TEXT },
      { file: "a/ЛСР.xlsx", text: LSR_05_13_TEXT },
      { file: "a/Ведомость.xlsx", text: BILL_TEXT },
    ]);
    const result = stripCustomerEstimates([{ name: "Архив.zip", text: middle }]);
    expect(result.documents[0]?.text).toBe(archive("Архив.zip", [
      { file: "a/ТЗ.docx", text: TZ_TEXT },
      { file: "a/Ведомость.xlsx", text: BILL_TEXT },
    ]));
    expect(result.leaks).toEqual([]);
  });

  it("две ЛСР и ТЗ в одном файле-листе: остаётся только ТЗ, метки пустых листов уходят", () => {
    const two = archive("Архив.rar", [
      { file: "ТЗ.docx", text: TZ_TEXT },
      { file: "Сметы.xlsx", text: `${LSR_05_13_TEXT}\n${LSR_08_TEXT}` },
    ]);
    const result = stripCustomerEstimates([{ name: "Архив.rar", text: two }]);
    expect(result.removed.filter((item) => item.kind === "LSR")).toHaveLength(2);
    expect(result.documents[0]?.text.trimEnd()).toBe(archive("Архив.rar", [{ file: "ТЗ.docx", text: TZ_TEXT }]));
    expect(result.leaks).toEqual([]);
  });
});

describe("плоский документ: ТЗ перед сметой", () => {
  it("режется с шапки сметы, ТЗ остаётся", () => {
    const flat = `${TZ_TEXT}\n\n${LSR_08_TEXT.split("\n").slice(1).join("\n")}`;
    const result = stripCustomerEstimates([{ name: "ТЗ с приложением.docx", text: flat }]);
    expect(result.documents[0]?.text).toBe(`${TZ_TEXT}\n\n`);
    expect(result.warnings).toEqual([]);
    expect(result.leaks).toEqual([]);
  });
});

describe("закупка 0302300048726001118: три документа", () => {
  const result = stripCustomerEstimates(DOCUMENTS_1118);

  it("документы, состоявшие из смет и расчётов НМЦК, ушли целиком; от проекта контракта остались условия", () => {
    expect(result.dropped.map((item) => item.name).sort()).toEqual(["Обоснование НМЦК.rar.zip", "Описание объекта закупки.rar.zip"]);
    expect(result.documents.map((item) => item.name)).toEqual(["Проект Муниципального контракта.doc.zip"]);
    const contract = result.documents[0]?.text ?? "";
    expect(contract).toContain("3.6. Муниципальный заказчик производит оплату работ по форме сметы контракта");
    expect(contract).not.toMatch(/ЛС\s+02-02-08\s+Поз/);
    expect(contract).not.toContain("Смена задвижек диаметром");
    expect(contract).toContain("Приложение № 1.5 к Муниципальному контракту");
  });

  it("вырезаны ЛСР (по два экземпляра), сметы контракта и проект сметы контракта из обоснования НМЦК", () => {
    const kinds = new Map<string, number>();
    for (const item of result.removed) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
    expect(kinds.get("LSR")).toBe(6);
    expect(kinds.get("CONTRACT_ESTIMATE")).toBeGreaterThanOrEqual(2);
    expect(kinds.get("NMCK_CONTRACT")).toBe(1);
    // Лист проекта сметы контракта вырезан разбором НМЦК, поэтому замечания «не по форме 421/пр» о нём нет.
    expect(result.warnings).toEqual([]);
  });

  it("разборы смет в остатке ничего не находят", () => {
    expect(result.leaks).toEqual([]);
    noEstimates(result.documents);
  });
});

describe("расчёт НМЦК", () => {
  it("листы расчёта и проекты смет контракта вырезаны, обоснование (лимит, цена по ЛСР) остаётся", () => {
    const documents = [{ name: NMCK_NAME, text: NMCK_CALCULATION_TEXT }];
    expect(parseCustomerNmck(documents)?.sheets.length).toBeGreaterThan(0);
    const result = stripCustomerEstimates(documents);
    const kinds = new Set(result.removed.map((item) => item.kind));
    expect(kinds.has("NMCK_CALC")).toBe(true);
    expect(kinds.has("NMCK_CONTRACT")).toBe(true);
    expect(result.leaks).toEqual([]);
    expect(parseCustomerNmck(result.documents)).toBeNull();
    const rest = result.documents[0]?.text ?? "";
    expect(rest).toContain("Обоснование начальной (максимальной) цены контракта");
    expect(rest).not.toMatch(/индекс\s+фактической\s+инфляции/i);
  });
});

describe("смета контракта по 841/пр", () => {
  it("таблица вырезана вместе с шапкой столбцов и итогами, условия контракта остаются", () => {
    const text = ["Условия контракта: оплата по этапам.", "", CONTRACT_ESTIMATE_TEXT, "", "Порядок приёмки: по акту."].join("\n");
    expect(parseContractEstimates([{ name: "Проект контракта", text }]).rows.length).toBeGreaterThan(5);
    const result = stripCustomerEstimates([{ name: "Проект контракта", text }]);
    const rest = result.documents[0]?.text ?? "";
    expect(rest).toContain("Условия контракта: оплата по этапам.");
    expect(rest).toContain("Порядок приёмки: по акту.");
    expect(rest).not.toContain("Номер сметы");
    expect(rest).not.toContain("Смена задвижек");
    expect(rest).not.toContain("Итого по смете");
    expect(result.removed.every((item) => item.kind === "CONTRACT_ESTIMATE")).toBe(true);
    expect(result.leaks).toEqual([]);
  });
});

describe("выгрузки других программ и БИМ", () => {
  it("Smeta.RU: смета и служебный лист Source уходят, документ остаётся пустым и в расчёт не идёт", () => {
    const result = stripCustomerEstimates([{ name: "Смета.xlsx", text: RIM_DEMOLITION_TEXT }]);
    expect(result.removed.map((item) => item.kind).sort()).toEqual(["LSR", "SERVICE_SHEET"]);
    expect(result.documents).toEqual([]);
    expect(result.dropped).toEqual([expect.objectContaining({ name: "Смета.xlsx" })]);
    expect(result.leaks).toEqual([]);
  });

  it("ТСН-2001 (форма № 4б) и смета с разделами и ценой заказчика", () => {
    for (const [name, text] of [
      ["Архив.rar", TSN_2001_TEXT],
      ["Смета_3.xlsx", RIM_SECTIONS_TEXT],
      ["Иркутск.xlsx", lsr0377],
    ] as const) {
      const result = stripCustomerEstimates([{ name, text }]);
      expect(result.removed.length, name).toBeGreaterThan(0);
      expect(result.leaks, name).toEqual([]);
      noEstimates(result.documents);
    }
  });

  it("БИМ: таблица листа и текст-поток PDF; перед смета-потоком остаётся пояснительная записка", () => {
    const grid = stripCustomerEstimates([{ name: "БИМ.xlsx", text: bim("grid-nnk-dop.txt") }]);
    expect(grid.removed.some((item) => item.kind === "BIM_GRID")).toBe(true);
    expect(grid.leaks).toEqual([]);

    const stream = bim("stream-tyumen.txt");
    expect(parseCustomerBim([{ name: "ПЭИ.pdf", text: stream }]).estimates.length).toBeGreaterThan(0);
    const result = stripCustomerEstimates([{ name: "ПЭИ.pdf", text: stream }]);
    expect(result.removed.some((item) => item.kind === "BIM_STREAM")).toBe(true);
    expect(result.leaks).toEqual([]);
    noEstimates(result.documents);
  });

  it("смета, которую разбор не читает, остаётся, а в предупреждениях названа", () => {
    // Вторая смета fixtures БИМ — выгрузка без итога сметы: разбор её не распознаёт, расчёт тоже, а модель в боевом прогоне прочла бы.
    const result = stripCustomerEstimates([{ name: "БИМ.xlsx", text: bim("grid-nnk-ti.txt") }]);
    expect(result.leaks).toEqual([]);
    expect(result.warnings.some((item) => item.includes("признаки сметы"))).toBe(true);
  });
});

describe("ведомость и ТЗ не режутся", () => {
  it("«Итого по разделу» без формы 421/пр сметой не считается", () => {
    const text = archive("Ведомость.zip", [
      { file: "ТЗ.docx", text: TZ_TEXT },
      { file: "Ведомость.xlsx", text: BILL_TEXT },
    ]);
    const result = stripCustomerEstimates([{ name: "Ведомость.zip", text }]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.text).toBe(text);
    expect(result.documents[0]?.removedChars).toBe(0);
    expect(result.removed).toEqual([]);
    expect(result.leaks).toEqual([]);
  });

  it("документ без смет возвращается как есть, в том же порядке", () => {
    const documents = [
      { name: "ТЗ.docx", text: TZ_TEXT },
      { name: "Ведомость.xlsx", text: BILL_TEXT },
    ];
    const result = stripCustomerEstimates(documents);
    expect(result.documents.map((item) => [item.name, item.text])).toEqual(documents.map((item) => [item.name, item.text]));
  });
});

describe("проверка остатка", () => {
  it("findEstimateLeaks называет документ и разбор, нашедший смету", () => {
    const leaks = findEstimateLeaks([
      { name: "ТЗ.docx", text: TZ_TEXT },
      { name: "ЛСР.xlsx", text: LSR_08_TEXT },
      { name: "Контракт.docx", text: CONTRACT_ESTIMATE_TEXT },
    ]);
    expect(leaks.map((item) => `${item.document}:${item.detector}`)).toEqual(["ЛСР.xlsx:LSR", "Контракт.docx:CONTRACT_ESTIMATE"]);
    expect(findEstimateLeaks([{ name: "ТЗ.docx", text: TZ_TEXT }])).toEqual([]);
  });
});

describe("cutSpans", () => {
  const text = ["=== a.rar ===", "=== f1.xlsx ===", "x1", "=== f2.xlsx ===", "=== Лист ===", "y1", "y2", "=== f3.xlsx ===", "z1"].join("\n");
  const at = (needle: string): number => text.indexOf(needle);

  it("метка файла, за которой ничего не осталось, уходит; метка контейнера остаётся", () => {
    // Вырезан лист «Лист» целиком вместе с меткой листа: f2 пуст — уходит и она.
    const cut = cutSpans(text, [{ start: at("=== Лист ==="), end: at("=== f3.xlsx ===") }]);
    expect(cut).toBe(["=== a.rar ===", "=== f1.xlsx ===", "x1", "=== f3.xlsx ===", "z1"].join("\n"));
  });

  it("метка файла остаётся, если дальше идёт другой лист того же файла", () => {
    const sheets = ["=== f.xlsx ===", "=== A ===", "a1", "=== B ===", "b1"].join("\n");
    const cut = cutSpans(sheets, [{ start: sheets.indexOf("=== A ==="), end: sheets.indexOf("=== B ===") }]);
    expect(cut).toBe(["=== f.xlsx ===", "=== B ===", "b1"].join("\n"));
  });

  it("пересекающиеся и соседние отрезки сливаются", () => {
    const plain = "0123456789";
    expect(cutSpans(plain, [{ start: 5, end: 8 }, { start: 2, end: 6 }, { start: 8, end: 9 }])).toBe("019");
  });
});
