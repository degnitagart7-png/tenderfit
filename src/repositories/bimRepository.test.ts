import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findElementIndex } from "@/domain/estimate/bimIndices";
import type { BimIndicesData } from "@/domain/estimate/bimIndicesTypes";
import { searchNorms } from "@/domain/estimate/normSearch";
import { makeZip } from "@/test/zipFixture";
import { buildFer2020 } from "../../scripts/fsnb/build-fer2020";
import {
  FerBaseUnavailableError,
  clearFerBaseCache,
  ferLookupOf,
  loadBimIndexBook,
  loadFerBase,
  parseFerRate,
} from "@/repositories/bimRepository";

/*
  Данные БИМ на диске: каталог fer2020/ собирается настоящей сборкой из малого архива и читается репозиторием; квартальные файлы
  индексов (их ночью кладёт fetch-bim-indices) заменяют встроенные письма того же квартала.
*/

const FER_XML = `<?xml version="1.0"?>
<base PriceLevel="01.01.2000" BaseType="ФЕР">
  <ResourcesDirectory><ResourceCategory CodePrefix="ФЕР">
    <Section Name="Земляные работы" Type="Сборник" Code="01">
      <Section Name="Разработка грунта в отвал экскаваторами драглайн" Type="Таблица" Code="01-01-001">
        <NameGroup BeginName="Разработка грунта в отвал экскаваторами драглайн с ковшом вместимостью:">
          <Work Code="01-01-001-01" EndName="15 м3, группа грунтов 1" MeasureUnit="1000 м3">
            <Resources><Resource Code="1" Quantity="1.54" /><Resource Code="2" Quantity="6.4" /></Resources>
            <NrSp><ReasonItem Nr="812/пр-001.1" Sp="774/пр-001.1" /></NrSp>
            <Prices><Price Cost="2968.03" SalaryMach="87.84" Salary="14.48" Machines="2953.55" Materials="0" /></Prices>
          </Work>
        </NameGroup>
      </Section>
    </Section>
  </ResourceCategory></ResourcesDirectory>
</base>`;

const FSSC_XML = `<?xml version="1.0" encoding="utf-8"?>
<ResourceCatalog><ResourcesDirectory><ResourceCategory Type="Материал"><Section Name="М" Code="01" Type="Книга">
  <Resource Code="18.1.02.01-0085" Name="Задвижка клиновая" MeasureUnit="шт"><Prices><Price Cost="3472.30" /></Prices></Resource>
</Section></ResourceCategory></ResourcesDirectory></ResourceCatalog>`;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bim-repo-"));
  clearFerBaseCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearFerBaseCache();
});

function build(): void {
  const zip = makeZip([
    { name: "ФСНБ-2020/ФЕР.xml", content: FER_XML },
    { name: "ФСНБ-2020/ФССЦ.xml", content: FSSC_XML },
  ]);
  buildFer2020({ zip, indexDir: dir, source: "тест", log: () => undefined });
}

describe("ФЕР-2020 с диска", () => {
  it("каталог не собран — ошибка с каталогом индекса и командой сборки", async () => {
    await expect(loadFerBase({ indexDir: dir })).rejects.toBeInstanceOf(FerBaseUnavailableError);
    await expect(loadFerBase({ indexDir: dir })).rejects.toThrow(/build-fer2020\.ts/);
  });

  it("собранный каталог читается: расценка, цены, поиск по наименованию и по шифру с книгой", async () => {
    build();
    const base = await loadFerBase({ indexDir: dir });
    expect(base.rates.size).toBe(1);
    const lookup = ferLookupOf(base);
    expect(lookup.rate("ФЕР", "01-01-001-01")).toMatchObject({ cost: 2968.03, wage: 14.48, machinistWage: 87.84, overheadRef: "812/пр-001.1", unit: "1000 м3" });
    expect(lookup.rate("ФЕРм", "01-01-001-01")).toBeNull();
    expect(lookup.material("18.1.02.01-0085")).toMatchObject({ cost: 3472.3, unit: "шт" });
    expect(searchNorms(base.searchIndex, { query: "ФЕР 01-01-001-01" }).items[0]).toMatchObject({ baseType: "ФЕР", code: "01-01-001-01", exact: true });
    expect(searchNorms(base.searchIndex, { query: "разработка грунта драглайн" }).items[0]?.code).toBe("01-01-001-01");
    // Книга в запросе ограничивает выдачу: в ФЕРм такого шифра нет.
    expect(searchNorms(base.searchIndex, { query: "ФЕРм 01-01-001-01" }).items.every((hit) => hit.baseType === "ФЕРм")).toBe(true);
  });

  it("загрузка кэшируется на процесс; повреждённая строка расценок — отказ, а не пропуск", async () => {
    build();
    expect(await loadFerBase({ indexDir: dir })).toBe(await loadFerBase({ indexDir: dir }));
    expect(() => parseFerRate({ code: "01-01-001-01", book: "ГЭСН" }, 7)).toThrow(/строка 7/);
  });
});

describe("индексы Минстроя: встроенные и серверные", () => {
  const server: BimIndicesData = {
    version: 1,
    quarter: { year: 2026, quarter: 4 },
    baseRowMeaning: "",
    letters: [{ id: "abc", number: "1-ИФ/09", date: "2026-10-20", title: "тест", file: "x.txt", pages: 1 }],
    elements: [{ subject: "Белгородская область", zone: null, object: "Прочие объекты", base: "FER", labour: 50, materials: 11, machines: 16, letter: "abc", page: 1 }],
    smr: [],
    transport: [],
    design: [],
    notes: [],
  } as unknown as BimIndicesData;

  it("без серверных файлов — только встроенный III кв. 2026", () => {
    const book = loadBimIndexBook({ indexDir: dir });
    expect(book.quarters).toEqual([{ year: 2026, quarter: 3 }]);
  });

  it("квартальный файл сервера добавляет новый квартал: он становится последним, а старый остаётся для сверки", () => {
    mkdirSync(join(dir, "bim-indices"), { recursive: true });
    writeFileSync(join(dir, "bim-indices", "bim-indices-2026q4.json"), JSON.stringify(server));
    writeFileSync(join(dir, "bim-indices", "bim-indices-2026q1.json"), "{повреждён");
    const book = loadBimIndexBook({ indexDir: dir });
    expect(book.quarters).toEqual([
      { year: 2026, quarter: 4 },
      { year: 2026, quarter: 3 },
    ]);
    const found = findElementIndex(book, { quarter: { year: 2026, quarter: 4 }, subject: "Белгородская область", zone: null, object: "Прочие объекты", base: "FER" });
    expect(found).toMatchObject({ status: "FOUND", record: { labour: 50 } });
    expect(findElementIndex(book, { quarter: { year: 2026, quarter: 3 }, subject: "Белгородская область", zone: null, object: "Прочие объекты", base: "FER" })).toMatchObject({ status: "FOUND", record: { labour: 47.58 } });
  });
});
