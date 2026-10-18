import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { ForecastDeflatorsData, SsrCitation, SsrData } from "../../src/domain/estimate/ssrTypes";
import { buildForecastDeflators, buildSsr, readSource, squash, squashedSource } from "./build-ssr";

/*
  Справочники ССР и прогнозных дефляторов сверяются с СОХРАНЁННЫМ текстом первоисточников
  (data/fsnb/normatives/sources/): каждое число и каждый фрагмент в JSON должны находиться в тексте приказа или письма.
  Сам скрипт тоже падает на ненайденном фрагменте; тест дублирует проверку по готовым JSON, чтобы правка JSON вручную
  не прошла незамеченной.
*/

const OUT = resolve("data/fsnb/normatives");
const APP = resolve("src/domain/estimate/normativesData");
const read = (dir: string, name: string): string => readFileSync(resolve(dir, name), "utf8");
const ssr = JSON.parse(read(OUT, "ssr.json")) as SsrData;
const deflators = JSON.parse(read(OUT, "forecast-deflators.json")) as ForecastDeflatorsData;

const squashedCache = new Map<string, string>();
function inSource(file: string, fragment: string): boolean {
  let text = squashedCache.get(file);
  if (text === undefined) {
    text = squashedSource(file);
    squashedCache.set(file, text);
  }
  return text.includes(squash(fragment));
}

function allCitations(data: SsrData, deflator: ForecastDeflatorsData): SsrCitation[] {
  return [
    ...data.chapters.flatMap((chapter) => [chapter.nameCitation, ...chapter.scopeCitations]),
    data.groupTotalsCitation,
    ...data.reserve.rates.map((rate) => rate.citation),
    ...data.reserve.citations,
    data.vat.baseCitation,
    data.vat.positionCitation,
    data.vat.priceCitation,
    data.authorSupervision.citation,
    ...data.customerRows.map((row) => row.citation),
    ...data.contract.includes.map((item) => item.citation),
    ...data.contract.excludes.map((item) => item.citation),
    data.inflation.indicatorCitation,
    ...data.inflation.formulaCitations,
    deflator.indicators.investments.citation,
    deflator.indicators.construction.citation,
    deflator.usedCitation,
  ];
}

describe("JSON собран скриптом из источников, а не правился вручную", () => {
  it("ssr.json и forecast-deflators.json совпадают с результатом сборки", () => {
    expect(ssr).toEqual(JSON.parse(JSON.stringify(buildSsr())));
    expect(deflators).toEqual(JSON.parse(JSON.stringify(buildForecastDeflators())));
  });

  it("копия для приложения (src/domain/estimate/normativesData) совпадает с data/fsnb/normatives: data/ на сервер не выкладывается", () => {
    for (const name of ["ssr.json", "forecast-deflators.json"]) {
      expect(read(APP, name), name).toBe(read(OUT, name));
    }
  });

  it("у справочников есть реквизиты и сохранённые файлы", () => {
    expect(ssr.source.title.length).toBeGreaterThan(20);
    expect(ssr.source.url).toMatch(/^https?:\/\//u);
    expect(() => readSource(ssr.source.file)).not.toThrow();
    for (const related of ssr.relatedSources) expect(() => readSource(related.file), related.file).not.toThrow();
    expect(() => readSource(deflators.letter.file)).not.toThrow();
    expect(() => readSource(deflators.letter.pdfFile)).not.toThrow();
  });
});

describe("каждая ссылка на пункт подтверждена дословным фрагментом сохранённого текста", () => {
  const citations = allCitations(ssr, deflators);

  it("их больше сорока, и у каждой есть файл, пункт и фрагмент", () => {
    expect(citations.length).toBeGreaterThan(40);
    for (const citation of citations) {
      expect(citation.file).not.toBe("");
      expect(citation.ref).not.toBe("");
      expect(citation.fragment.length).toBeGreaterThan(10);
    }
  });

  it("фрагмент стоит в тексте источника (без учёта пробелов и переносов)", () => {
    const missing = citations.filter((citation) => !inSource(citation.file, citation.fragment));
    expect(missing.map((citation) => `${citation.ref}: ${citation.fragment.slice(0, 80)}`)).toEqual([]);
  });
});

describe("состав глав 1-12 (421/пр, п. 138)", () => {
  it("двенадцать глав подряд, наименование каждой — в п. 138 с её номером", () => {
    expect(ssr.chapters.map((chapter) => chapter.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const chapter of ssr.chapters) {
      expect(chapter.nameCitation.fragment, String(chapter.number)).toContain(`(глава ${String(chapter.number)})`);
      expect(chapter.nameCitation.ref).toBe("421/пр, п. 138");
    }
  });

  it("главы 10-12 — затраты заказчика, 2-8 — подрядчика, 1 и 9 — смешанные", () => {
    const scope = (number: number) => ssr.chapters.find((chapter) => chapter.number === number)?.scope;
    for (const number of [2, 3, 4, 5, 6, 7, 8]) expect(scope(number), String(number)).toBe("CONTRACT");
    for (const number of [1, 9]) expect(scope(number), String(number)).toBe("PARTIAL");
    for (const number of [10, 11, 12]) expect(scope(number), String(number)).toBe("CUSTOMER");
  });

  it("итоги по главам 1-7, 1-8, 1-9, 1-12 названы в п. 143", () => {
    expect(ssr.groupTotals.map((group) => group.id)).toEqual(["1-7", "1-8", "1-9", "1-12"]);
    expect(ssr.groupTotalsCitation.ref).toBe("421/пр, п. 143");
    expect(ssr.groupTotalsCitation.fragment).toContain("по итогам глав 1 - 7, 1 - 8, 1 - 9, 1 - 12");
  });
});

describe("резерв на непредвиденные работы и затраты (421/пр, п. 179)", () => {
  it("2 % — непроизводственные, 3 % — производственные и линейные, 10 % — уникальные: числа есть в тексте п. 179", () => {
    const byId = Object.fromEntries(ssr.reserve.rates.map((rate) => [rate.id, rate]));
    expect(byId["NON_PRODUCTION"]?.percent).toBe(2);
    expect(byId["PRODUCTION"]?.percent).toBe(3);
    expect(byId["UNIQUE"]?.percent).toBe(10);
    expect(byId["NON_PRODUCTION"]?.citation.fragment).toContain("2 (двух) процентов");
    expect(byId["PRODUCTION"]?.citation.fragment).toContain("3 (трех) процентов");
    expect(byId["PRODUCTION"]?.citation.fragment).toContain("линейных объектов");
    expect(byId["UNIQUE"]?.citation.fragment).toContain("10 (десяти) процентов");
  });

  it("размеры подтверждены и в новой редакции п. 179 (приказ 42/пр, официальный скан)", () => {
    for (const fragment of ["2 (двух) процентов - для объектов капитального строительства", "3 (трех) процентов", "10 (десяти) процентов"]) {
      expect(inSource("42-pr-izmeneniya-421-official-ocr.txt", fragment), fragment).toBe(true);
    }
  });

  it("база — итоги глав 1-12, строка за итогом глав 1-12 с распределением по графам 4-8", () => {
    expect(ssr.reserve.baseChapters).toEqual({ from: 1, to: 12 });
    expect(ssr.reserve.citations[0]?.fragment).toContain("определяется от итогов по главам 1 - 12");
    expect(ssr.reserve.citations[0]?.fragment).toContain("распределением по графам 4 - 8");
  });

  it("для капремонта и ремонта отдельного размера в тексте нет — об этом сказано в справочнике", () => {
    expect(ssr.reserve.repairNote).toContain("отдельного размера для капитального ремонта");
    const p179 = squashedSource("421-pr-gl9-ssr-p135-181-prilozhenie-6-9.txt");
    const start = p179.indexOf("179. Резерв средств на непредвиденные работы и затраты предназначен");
    const end = p179.indexOf("180. За итогом сводного сметного расчета");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(p179.slice(start, end)).not.toMatch(/капитальн[а-я]+\s+ремонт/u);
  });
});

describe("НДС, авторский надзор, затраты заказчика", () => {
  it("НДС — на итоги глав 1-12 с резервом; ставка в приказе не названа", () => {
    expect(ssr.vat.baseCitation.ref).toBe("421/пр, п. 181");
    expect(ssr.vat.baseCitation.fragment).toContain("от итогов глав 1 - 12 сводного сметного расчета с учетом резерва");
    expect(ssr.vat.positionCitation.fragment).toContain("в размере, установленном законодательством");
    expect(ssr.vat.rateNote).toContain("не названа");
  });

  it("авторский надзор — 0,2 % от итога графы 8 глав 1-9 (п. 173)", () => {
    expect(ssr.authorSupervision.percent).toBe(0.2);
    expect(ssr.authorSupervision.citation.fragment).toContain("0,2 процентов от итога графы 8 глав 1 - 9");
  });

  it("строки приложения 9, названные затратами заказчика: 2.22 и 2.32", () => {
    expect(ssr.customerRows.map((row) => row.row)).toEqual(["2.22", "2.32"]);
  });

  it("в цену контракта: п. 21, 37, 22, 3 приказа 841/пр; не входят главы 10-12", () => {
    expect(ssr.contract.includes.map((item) => item.citation.ref)).toEqual(["841/пр, п. 21", "841/пр, п. 37", "841/пр, п. 22, подп. «б»", "841/пр, п. 3"]);
    expect(ssr.contract.excludes.map((item) => item.citation.ref)).toContain("421/пр, п. 162");
    expect(ssr.contract.excludes.map((item) => item.citation.ref)).toContain("421/пр, п. 170");
    expect(ssr.contract.excludes.map((item) => item.citation.ref)).toContain("421/пр, п. 171");
  });
});

describe("прогнозные дефляторы Минэкономразвития", () => {
  const raw = readSource(deflators.letter.file);

  it("годы 2025-2029: отчёт, оценка, три прогнозных", () => {
    expect(deflators.years).toEqual([
      { year: 2025, status: "REPORT" },
      { year: 2026, status: "ESTIMATE" },
      { year: 2027, status: "FORECAST" },
      { year: 2028, status: "FORECAST" },
      { year: 2029, status: "FORECAST" },
    ]);
  });

  it("«Инвестиции в основной капитал»: 109,3 / 112,0 / 109,0 / 104,6 / 104,5 — найдены в письме", () => {
    expect(deflators.indicators.investments.values.map((item) => item.percent)).toEqual([109.3, 112, 109, 104.6, 104.5]);
    expect(raw.replace(/\s+/gu, " ")).toContain("Индекс-дефлятор % г/г 109,3 112,0 109,0 104,6 104,5");
  });

  it("«Строительство» (справочно): 107,2 / 107,2 / 105,5 / 104,2 / 103,9", () => {
    expect(deflators.indicators.construction.values.map((item) => item.percent)).toEqual([107.2, 107.2, 105.5, 104.2, 103.9]);
    expect(raw.replace(/\s+/gu, " ")).toContain("Строительство дефлятор 107,2 107,2 105,5 104,2 103,9");
  });

  it("расчёт идёт по «Инвестициям в основной капитал» (841/пр, п. 8, подп. «б»), а не по «Строительству»", () => {
    expect(deflators.used).toBe("investments");
    expect(deflators.usedCitation.fragment).toContain("Инвестиции в основной капитал (капитальные вложения)");
    expect(ssr.inflation.indicator).toContain("Инвестиции в основной капитал");
  });

  it("письмо: дата и номер названы, но в распознанном тексте их нет — это сказано; прогноз одобрен 24.09.2026", () => {
    expect(deflators.letter.date).toBe("2026-09-30");
    expect(deflators.letter.number).toBe("36459-ПК/Д03и");
    expect(deflators.letter.datedInText).toBe(false);
    expect(raw).not.toContain("36459");
    expect(deflators.letter.notes.join(" ")).toContain("сообщены владельцем");
    expect(raw.replace(/\s+/gu, " ")).toContain("одобрен на заседании Правительства Российской Федерации 24 сентября 2026 г.");
  });
});
