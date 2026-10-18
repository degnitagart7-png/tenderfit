import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseFerResourcesXml, parseFerTransportXml, parseFerXml, type FerRate } from "../../src/lib/fsnb/ferXml";
import { fer2020ZipUrl, FER2020_ZIP_PATH } from "../../src/lib/fsnb/fgisBimApi";
import { assertPayload } from "../../src/lib/fsnb/fgisZoneApi";
import { decodeZipName, findZipEntry, readZipDirectory, readZipEntry } from "../../src/lib/fsnb/zipArchive";
import { makeZip, toCp1251, toCp866 } from "../../src/test/zipFixture";
import { buildFer2020, compactRate, isFer2020Built, parseBuildFerArgs, xmlEncodingOf, xmlTokensOf } from "./build-fer2020";

/*
  Сборка ФЕР-2020 проверяется на маленьком куске, повторяющем структуру настоящей выгрузки «ФСНБ-2020 включая дополнение №9»:
  имена файлов в архиве — cp866 без флага UTF-8 (на них падает системный unzip), ФССЦпг — windows-1251, остальное — UTF-8.
  Числа в расценках — реальные строки выгрузки (12-12-001-13: 232,30 = 68,30 + 154,55 + 9,45; ЗПМ 18,35 уже внутри ЭМ).
*/

const FER_XML = `<?xml version="1.0"?>
<base xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" PriceLevel="01.01.2000" BaseType="ФЕР">
  <Decrees><Decree Name="ГЭСН-2020 / ФЕР-2020" /></Decrees>
  <ResourcesDirectory>
    <ResourceCategory Type="СТРОИТЕЛЬНЫЕ РАБОТЫ" CodePrefix="ФЕР">
      <Section Name="Земляные работы" Type="Сборник" Code="01">
        <Section Name="МЕХАНИЗИРОВАННАЯ РАЗРАБОТКА ГРУНТОВ" Type="Раздел" Code="1">
          <Section Name="РАЗРАБОТКА ГРУНТА ЭКСКАВАТОРАМИ В ОТВАЛ" Type="Подраздел" Code="1.1">
            <Section Name="Разработка грунта в отвал экскаваторами &quot;драглайн&quot;" Type="Таблица" Code="01-01-001">
              <NameGroup BeginName="Разработка грунта в отвал экскаваторами &quot;драглайн&quot; с ковшом вместимостью:">
                <Work Code="01-01-001-01" EndName="15 м3, группа грунтов 1" MeasureUnit="1000 м3">
                  <Content><Item Text="Разработка грунта навымет." /></Content>
                  <Resources>
                    <Resource Code="1-100-38" EndName="Затраты труда рабочих (Средний разряд - 3,8)" Quantity="1.54" />
                    <Resource Code="1" Quantity="1.54" />
                    <Resource Code="2" Quantity="6.4" />
                    <Resource Code="91.01.01-035" EndName="Бульдозеры, мощность 79 кВт (108 л.с.)" Quantity="1.6" />
                  </Resources>
                  <NrSp><ReasonItem Nr="812/пр-001.1" Sp="774/пр-001.1" /></NrSp>
                  <Prices>
                    <Price Cost="2968.03" SalaryMach="87.84" Salary="14.48" Machines="2953.55" Materials="0">
                      <Correction Coeff="0" />
                    </Price>
                  </Prices>
                </Work>
                <Work Code="01-01-001-02" EndName="15 м3, группа грунтов 2" MeasureUnit="1000 м3">
                  <Resources><Resource Code="1" Quantity="1.85" /></Resources>
                  <NrSp><ReasonItem Nr="812/пр-001.1" Sp="774/пр-001.1" /></NrSp>
                  <Prices><Price Cost="3580.12" SalaryMach="105.96" Salary="17.39" Machines="3562.73" Materials="0"><Correction Coeff="0" /></Price></Prices>
                </Work>
              </NameGroup>
            </Section>
          </Section>
        </Section>
      </Section>
    </ResourceCategory>
  </ResourcesDirectory>
</base>`;

const FERM_XML = `<?xml version="1.0"?>
<base PriceLevel="01.01.2000" BaseType="ФЕРм">
  <ResourcesDirectory><ResourceCategory CodePrefix="ФЕРм">
    <Section Name="Технологические трубопроводы" Type="Сборник" Code="12">
      <Section Name="Арматура" Type="Таблица" Code="12-12-001">
        <NameGroup BeginName="Арматура фланцевая на номинальное давление до 4 МПа, номинальный диаметр:">
          <Work Code="12-12-001-13" EndName="200 мм" MeasureUnit="шт">
            <Resources>
              <Resource Code="1-100-40" Quantity="7.1" />
              <Resource Code="1" Quantity="7.1" />
              <Resource Code="2" Quantity="1.37" />
              <Resource Code="01.7.19.04-0031" EndName="Прокладки резиновые" MeasureUnit="кг" Quantity="0.35" />
              <AbstractResource Code="08.3.05.02" Name="Прокат листовой горячекатаный" MeasureUnit="т" Quantity="П" />
              <AbstractResource Code="07.2.07.13" Name="Конструкции стальные" MeasureUnit="т" Quantity="1" />
            </Resources>
            <NrSp><ReasonItem Nr="812/пр-054.0" Sp="774/пр-054.0" /></NrSp>
            <Prices>
              <Price Cost="232.30" SalaryMach="18.35" Salary="68.30" Machines="154.55" Materials="9.45">
                <Correction From="ЗПР" To="МР" Coeff="1.02" />
              </Price>
            </Prices>
          </Work>
          <Work Code="12-12-001-14" EndName="без цены" MeasureUnit="шт">
            <Resources><Resource Code="1" Quantity="1" /></Resources>
          </Work>
        </NameGroup>
      </Section>
    </Section>
  </ResourceCategory></ResourcesDirectory>
</base>`;

const FSSC_XML = `<?xml version="1.0" encoding="utf-8"?>
<ResourceCatalog>
  <ResourcesDirectory><ResourceCategory Type="Материал">
    <Section Name="Материалы" Code="01" Type="Книга">
      <Resource Code="18.1.02.01-0085" Name="Задвижка клиновая 30с41нж, DN 200" MeasureUnit="шт">
        <Prices><Price Cost="3472.30" OptCost="3399.44" /></Prices>
      </Resource>
    </Section>
  </ResourceCategory></ResourcesDirectory>
</ResourceCatalog>`;

const FSEM_XML = `<?xml version="1.0" encoding="utf-8"?>
<ResourceCatalog>
  <ResourcesDirectory><ResourceCategory Type="МашиныМеханизмы">
    <Resource Code="91.01.01-001" Name="Бульдозеры в составе кабелеукладочной колонны" MeasureUnit="маш.-ч.">
      <Prices><Price Cost="332.31" SalaryMach="13.50" /></Prices>
      <ExpendableMaterials><Material Cost="999" /></ExpendableMaterials>
    </Resource>
  </ResourceCategory></ResourcesDirectory>
</ResourceCatalog>`;

const FSSCPG_XML = `<?xml version="1.0" encoding="windows-1251"?>
<base PriceLevel="01.01.2000">
  <WorkCategory Type="Автомобильные перевозки">
    <Section Name="Раздел 1" Code="01" Type="Раздел" MeasureUnit="">
      <Section Name="Таблица 1-01" Code="01-01" Type="Таблица" MeasureUnit="1 т груза">
        <NameGroup BeginName="Погрузка при автомобильных перевозках">
          <Work Code="01-01-01-001" EndName="бетона или раствора" MeasureUnit="1 т груза">
            <Prices><Price Cost="45.01" /><Overhead Percent="100" /><Profit Percent="60" /></Prices>
          </Work>
        </NameGroup>
      </Section>
    </Section>
  </WorkCategory>
</base>`;

const DIR = "ФСНБ-2020 включая дополнение №9 (приказы Минстроя России от 20.12.2021 № 961_пр) действует с 01.02.2022";

function testZip(): Buffer {
  return makeZip([
    { name: `${DIR}/`, content: "" },
    { name: `${DIR}/ФЕР.xml`, content: FER_XML },
    { name: `${DIR}/ФЕРм.xml`, content: FERM_XML },
    { name: `${DIR}/ФССЦ.xml`, content: FSSC_XML },
    { name: `${DIR}/ФСЭМ.xml`, content: FSEM_XML, stored: true },
    { name: `${DIR}/ФССЦпг.xml`, content: toCp1251(FSSCPG_XML) },
    { name: `${DIR}/ГЭСН.xml`, content: "<base/>" },
  ]);
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fer2020-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tokensOf(xml: string) {
  return xmlTokensOf(Buffer.from(xml, "utf8"));
}

describe("разбор расценок ФЕР (ferXml)", () => {
  it("цена: Всего = ОЗП + ЭМ + материалы, ЗПМ внутри ЭМ; имя — начало таблицы + окончание строки", () => {
    const rates = [...parseFerXml(tokensOf(FER_XML), "ФЕР")];
    expect(rates).toHaveLength(2);
    const first = rates[0] as FerRate;
    expect(first).toMatchObject({
      code: "01-01-001-01",
      book: "ФЕР",
      table: "01-01-001",
      unit: "1000 м3",
      collectionCode: "01",
      collectionName: "Земляные работы",
      cost: 2968.03,
      wage: 14.48,
      machines: 2953.55,
      machinistWage: 87.84,
      materials: 0,
      labourHours: 1.54,
      machinistHours: 6.4,
      overheadRef: "812/пр-001.1",
      profitRef: "774/пр-001.1",
    });
    expect(first.name).toBe('Разработка грунта в отвал экскаваторами "драглайн" с ковшом вместимостью: 15 м3, группа грунтов 1');
    expect(first.endName).toBe("15 м3, группа грунтов 1");
    expect(first.wage + first.machines + first.materials).toBeCloseTo(first.cost, 2);
    expect(first.machinistWage).toBeLessThan(first.machines);
    expect(first.correction).toBeNull();
  });

  it("материалы «по проекту» и в количестве из приложения — вне цены; поправка ЗПР→МР сохраняется; Correction Coeff=0 — заглушка", () => {
    const rates = [...parseFerXml(tokensOf(FERM_XML), "ФЕРм")];
    expect(rates).toHaveLength(1); // расценка без <Price> в каталог не попадает
    const rate = rates[0] as FerRate;
    expect(rate.book).toBe("ФЕРм");
    expect(rate.cost).toBe(232.3);
    expect(rate.unaccounted).toEqual([
      { code: "08.3.05.02", name: "Прокат листовой горячекатаный", unit: "т", quantity: null },
      { code: "07.2.07.13", name: "Конструкции стальные", unit: "т", quantity: 1 },
    ]);
    expect(rate.correction).toEqual({ from: "ЗПР", to: "МР", coeff: 1.02 });
    expect(rate.labourHours).toBe(7.1);
    expect(rate.machinistHours).toBe(1.37);
  });

  it("сумма труда по разрядным строкам берётся, когда итоговой строки «1» нет", () => {
    const xml = `<base BaseType="ФЕР"><Section Type="Таблица" Code="01-01-002"><Work Code="01-01-002-01" EndName="x" MeasureUnit="шт">
      <Resources><Resource Code="2-100-04" Quantity="1.5"/><Resource Code="2-100-05" Quantity="2"/><Resource Code="4-100-060" Quantity="0.3"/></Resources>
      <Prices><Price Cost="10" Salary="10" Machines="0" Materials="0" SalaryMach="0"/></Prices></Work></Section></base>`;
    const rate = [...parseFerXml(tokensOf(xml), "ФЕР")][0] as FerRate;
    expect(rate.labourHours).toBe(3.5);
    expect(rate.machinistHours).toBe(0.3);
  });

  it("справочник материалов и машин: цена из <Prices>, а не из <ExpendableMaterials>", () => {
    expect([...parseFerResourcesXml(tokensOf(FSSC_XML))]).toEqual([
      { code: "18.1.02.01-0085", name: "Задвижка клиновая 30с41нж, DN 200", unit: "шт", cost: 3472.3, optCost: 3399.44, salaryMach: null },
    ]);
    expect([...parseFerResourcesXml(tokensOf(FSEM_XML))]).toEqual([
      { code: "91.01.01-001", name: "Бульдозеры в составе кабелеукладочной колонны", unit: "маш.-ч.", cost: 332.31, optCost: null, salaryMach: 13.5 },
    ]);
  });
});

describe("чтение архива с именами в cp866", () => {
  it("имя без флага UTF-8 декодируется как cp866, с флагом — как UTF-8", () => {
    expect(decodeZipName(toCp866("ФЕР.xml"), 0)).toBe("ФЕР.xml");
    expect(decodeZipName(Buffer.from("ФЕР.xml", "utf8"), 0x0800)).toBe("ФЕР.xml");
    expect(decodeZipName(Buffer.from("ФЕР.xml", "utf8"), 0)).toBe("ФЕР.xml");
    expect(decodeZipName(Buffer.from("plain.xml"), 0)).toBe("plain.xml");
  });

  it("запись находится по последнему компоненту имени, сжатая и хранимая читаются одинаково", () => {
    const zip = testZip();
    const entries = readZipDirectory(zip);
    expect(entries.map((entry) => entry.baseName)).toContain("ФЕР.xml");
    const fer = findZipEntry(entries, "ФЕР.xml");
    expect(fer).not.toBeNull();
    expect(readZipEntry(zip, fer as never).toString("utf8")).toBe(FER_XML);
    expect(readZipEntry(zip, findZipEntry(entries, "ФСЭМ.xml") as never).toString("utf8")).toBe(FSEM_XML);
    expect(findZipEntry(entries, "нет.xml")).toBeNull();
  });

  it("не zip — понятная ошибка", () => {
    expect(() => readZipDirectory(Buffer.from("это не архив, а просто текст достаточной длины"))).toThrow(/не похож на zip/);
  });
});

describe("кодировка XML", () => {
  it("windows-1251 по декларации; без декларации — utf-8", () => {
    expect(xmlEncodingOf(Buffer.from('<?xml version="1.0" encoding="windows-1251"?><a/>'))).toBe("windows-1251");
    expect(xmlEncodingOf(Buffer.from('<?xml version="1.0" encoding="utf-8"?><a/>'))).toBe("utf-8");
    expect(xmlEncodingOf(Buffer.from("<a/>"))).toBe("utf-8");
  });

  it("многобайтовая кириллица не режется на границе окна 1 МиБ", () => {
    // Двухбайтовые символы; пробел в начале комментария сдвигает границу окна на середину символа.
    const filler = "я".repeat((1 << 20) - 1);
    // Окно режет посередине двухбайтового символа «ё»: имя расценки должно дойти целым.
    const xml = `<base BaseType="ФЕР"><!-- ${filler}--><Section Type="Таблица" Code="01-01-001"><Work Code="01-01-001-01" EndName="Ёж" MeasureUnit="шт"><Prices><Price Cost="1" Salary="1" Machines="0" Materials="0" SalaryMach="0"/></Prices></Work></Section></base>`;
    const rate = [...parseFerXml(tokensOf(xml), "ФЕР")][0] as FerRate;
    expect(rate.endName).toBe("Ёж");
  });
});

describe("сборка каталога fer2020", () => {
  it("собирает расценки, материалы, машины и перевозку; паспорт без расхождений и с замером памяти", () => {
    const logs: string[] = [];
    const report = buildFer2020({
      zip: testZip(),
      indexDir: dir,
      source: "тест",
      log: (message) => logs.push(message),
      now: () => new Date("2026-10-09T00:00:00Z"),
    });

    expect(report.books).toEqual({ ФЕР: 2, ФЕРм: 1 });
    expect(report.files["rates.jsonl"]?.lines).toBe(3);
    expect(report.costMismatches).toBe(0);
    expect(report.duplicateCodes).toBe(0);
    expect(report.priceLevel).toBe("01.01.2000");
    expect(report.peakRssMb).toBeGreaterThan(0);
    expect(report.notes.some((note) => note.includes("ФЕРр.xml"))).toBe(true);

    const base = join(dir, "fer2020");
    const lines = readFileSync(join(base, "rates.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const last = JSON.parse(lines[2] as string) as Record<string, unknown>;
    expect(last).toMatchObject({ code: "12-12-001-13", book: "ФЕРм", cost: 232.3, wage: 68.3, machines: 154.55, machinistWage: 18.35, materials: 9.45 });
    // пустые поля в файл не пишутся
    expect(Object.keys(JSON.parse(lines[0] as string) as object)).not.toContain("unaccounted");
    expect(Object.keys(JSON.parse(lines[0] as string) as object)).not.toContain("correction");

    expect(readFileSync(join(base, "materials.jsonl"), "utf8")).toContain("18.1.02.01-0085");
    expect(readFileSync(join(base, "machines.jsonl"), "utf8")).toContain('"salaryMach":13.5');
    const transport = JSON.parse(readFileSync(join(base, "transport.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(transport).toEqual({
      code: "01-01-01-001",
      name: "Погрузка при автомобильных перевозках бетона или раствора",
      unit: "1 т груза",
      cost: 45.01,
      overheadPercent: 100,
      profitPercent: 60,
    });
    const info = JSON.parse(readFileSync(join(base, "build-info.json"), "utf8")) as { format: number; zipSha256: string };
    expect(info.format).toBe(1);
    expect(info.zipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(isFer2020Built(dir)).toBe(true);
    expect(logs.join("\n")).toContain("ФЕР: 2 расценок");
  });

  it("повторная сборка заменяет каталог целиком и не оставляет временных каталогов", () => {
    buildFer2020({ zip: testZip(), indexDir: dir, source: "1", log: () => undefined });
    const second = buildFer2020({ zip: testZip(), indexDir: dir, source: "2", log: () => undefined });
    expect(second.source).toBe("2");
    expect(readFileSync(join(dir, "fer2020", "build-info.json"), "utf8")).toContain('"source": "2"');
    const leftovers = readdirSync(dir);
    expect(leftovers).toEqual(["fer2020"]);
  });

  it("архив без книг ФЕР — ошибка, каталог не создаётся", () => {
    const zip = makeZip([{ name: "ГЭСН.xml", content: "<base/>" }]);
    expect(() => buildFer2020({ zip, indexDir: dir, source: "x", log: () => undefined })).toThrow(/нет ни одной книги ФЕР/);
    expect(existsSync(join(dir, "fer2020"))).toBe(false);
  });

  it("расхождение «Всего» с суммой частей попадает в паспорт, а не теряется", () => {
    const broken = FER_XML.replace('Cost="2968.03"', 'Cost="3000.00"');
    const zip = makeZip([{ name: `${DIR}/ФЕР.xml`, content: broken }]);
    const report = buildFer2020({ zip, indexDir: dir, source: "x", log: () => undefined });
    expect(report.costMismatches).toBe(1);
    expect(report.notes.join(" ")).toContain("Всего");
  });

  it("compactRate не пишет пустое", () => {
    const rate = [...parseFerXml(tokensOf(FER_XML), "ФЕР")][0] as FerRate;
    const compact = compactRate(rate);
    expect(compact).not.toHaveProperty("unaccounted");
    expect(compact).toHaveProperty("endName", "15 м3, группа грунтов 1");
  });
});

describe("transport (ФССЦпг, windows-1251)", () => {
  it("читается через декларацию кодировки", () => {
    const records = [...parseFerTransportXml(xmlTokensOf(toCp1251(FSSCPG_XML)))];
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("Погрузка при автомобильных перевозках бетона или раствора");
  });
});

describe("запуск и адреса", () => {
  it("аргументы: --from-file, --if-missing, --index, --keep-zip; неизвестный флаг — ошибка", () => {
    const args = parseBuildFerArgs(["--from-file", "a.zip", "--if-missing", "--index", "/tmp/idx", "--keep-zip", "/tmp/k.zip"]);
    expect(args.fromFile?.endsWith("a.zip")).toBe(true);
    expect(args.ifMissing).toBe(true);
    expect(args.indexDir).toBe("/tmp/idx");
    expect(args.keepZip).toBe("/tmp/k.zip");
    expect(() => parseBuildFerArgs(["--зачем"])).toThrow(/Неизвестный флаг/);
  });

  it("архив скачивается по datasetFile.path набора id=3", () => {
    expect(FER2020_ZIP_PATH).toBe("6b5f31bd-879d-4578-bb7e-bcfb64cd8bbf");
    expect(fer2020ZipUrl()).toBe("https://fgiscs.minstroyrf.ru/api/values/GetFileContent/6b5f31bd-879d-4578-bb7e-bcfb64cd8bbf");
  });

  it("ответ проверяется как zip: страница ошибки и чужой файл отвергаются", () => {
    expect(() => assertPayload("zip", Buffer.from("<html>ошибка</html>"), "text/html", "набор")).toThrow(/HTML/);
    expect(() => assertPayload("zip", Buffer.from("не архив"), null, "набор")).toThrow(/не похож на zip/);
    expect(() => assertPayload("zip", Buffer.from([0x50, 0x4b, 3, 4]), null, "набор")).not.toThrow();
  });

  it("isFer2020Built: нет каталога или старый формат — не собрано", () => {
    expect(isFer2020Built(dir)).toBe(false);
    mkdirSync(join(dir, "fer2020"));
    writeFileSync(join(dir, "fer2020", "build-info.json"), JSON.stringify({ format: 0 }));
    expect(isFer2020Built(dir)).toBe(false);
  });
});
