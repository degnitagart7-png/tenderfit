import { describe, expect, it } from "vitest";

import {
  parseDecimal,
  parseNormsXml,
  parsePriceCatalogXml,
  parseQuantity,
  type CatalogResource,
} from "@/lib/fsnb/fsnbXml";
import { XmlTokenizer, type XmlToken } from "@/lib/fsnb/xmlTokenizer";
import type { NormRecord } from "@/domain/estimate/types";
import { NORM_DRAGLINE_15 } from "@/test/estimateFixtures";

/**
 * Разбор выгрузок ФСНБ-2022.
 *
 * XML в этом файле — не сочинённый пример, а настоящие строки из
 * `data/fsnb/raw/xml/ГЭСН.xml` и `ФСБЦ_Маш.xml`, включая порядок атрибутов
 * (`Name` раньше `Type`), объявления пространств имён и блок
 * `<ExpendableMaterials>`, который парсер обязан игнорировать.
 *
 * Главный тест — первый: фрагмент книги норм разбирается ровно в
 * `NORM_DRAGLINE_15`, ту самую фикстуру, на которой считаются ожидаемые суммы в
 * `calculate.test.ts`. Пока он зелёный, расчёт и парсер не разошлись.
 */

function tokensOf(xml: string): XmlToken[] {
  const tokenizer = new XmlTokenizer();
  const tokens = tokenizer.push(xml);
  tokens.push(...tokenizer.flush());
  return tokens;
}

function normsOf(xml: string, fallbackBaseType = "ГЭСН"): NormRecord[] {
  return [...parseNormsXml(tokensOf(xml), fallbackBaseType)];
}

function pricesOf(xml: string, kind: "material" | "machine"): CatalogResource[] {
  return [...parsePriceCatalogXml(tokensOf(xml), kind)];
}

/**
 * Фрагмент «ГЭСН.xml»: сборник 01, раздел, подраздел, таблица 01-01-001 и
 * работа 01-01-001-01 — экскаватор-драглайн 15 м3, группа грунтов 1.
 */
const DRAGLINE_BOOK = `<?xml version="1.0" encoding="utf-8"?>
<base xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" PriceLevel="01.01.2022" CreationDate="14.08.2026" ProgramName="ИАС ЦС" BaseName="ГЭСН от 14.08.2026 14:02:53" BaseType="ГЭСН">
  <Decrees>
    <Decree Name="ГОСУДАРСТВЕННЫЕ ЭЛЕМЕНТНЫЕ СМЕТНЫЕ НОРМЫ ГЭСН-2022 доп. № 19" />
  </Decrees>
  <ResourcesDirectory>
    <ResourceCategory Type="Сметные нормы и расценки" CodePrefix="ГЭСН">
      <Section Name="Земляные работы" Type="Сборник" Code="01">
        <Section Name="МЕХАНИЗИРОВАННАЯ РАЗРАБОТКА ГРУНТОВ (ЭКСКАВАТОРАМИ, СКРЕПЕРАМИ, БУЛЬДОЗЕРАМИ, ГРЕЙДЕРАМИ, МЕТОДОМ ГИДРОМЕХАНИЗАЦИИ И ПР.)" Type="Раздел" Code="1">
          <Section Name="РАЗРАБОТКА ГРУНТА ЭКСКАВАТОРАМИ В ОТВАЛ" Type="Подраздел" Code="1">
            <Section Name="Разработка грунта в отвал экскаваторами &quot;драглайн&quot;" Type="Таблица" Code="01-01-001">
              <NameGroup BeginName="Разработка грунта в отвал экскаваторами &quot;драглайн&quot; одноковшовыми электрическими шагающими при работе на гидроэнергетическом строительстве с ковшом вместимостью:">
                <Work Code="01-01-001-01" EndName="15 м3, группа грунтов 1" MeasureUnit="1000 м3">
                  <Content>
                    <Item Text="Разработка грунта навымет." />
                    <Item Text="Устройство и содержание водоотводных канав или ограждающих валиков." />
                    <Item Text="Вспомогательные работы, связанные с перемещением экскаватора из забоя в забой." />
                  </Content>
                  <Resources>
                    <Resource Code="1-100-38" EndName="Средний разряд работы 3,8" Quantity="1.54" MeasureUnit="чел.-ч" />
                    <Resource Code="2" Quantity="6.4" MeasureUnit="чел.-ч" />
                    <Resource Code="91.01.01-035" EndName="Бульдозеры, мощность 79 кВт (108 л.с.)" Quantity="1.6" MeasureUnit="маш.-ч" />
                    <Resource Code="91.01.05-128" EndName="Экскаваторы одноковшовые электрические шагающие с рабочим оборудованием &quot;драглайн&quot;, емкость ковша 15 м3" Quantity="1.6" MeasureUnit="маш.-ч" />
                  </Resources>
                  <NrSp>
                    <ReasonItem Nr="Пр/812-001.1" Sp="Пр/774-001.1" />
                  </NrSp>
                </Work>
              </NameGroup>
            </Section>
          </Section>
        </Section>
      </Section>
    </ResourceCategory>
  </ResourcesDirectory>
</base>`;

describe("parseDecimal", () => {
  it("читает число с точкой и с запятой", () => {
    expect(parseDecimal("1.54")).toBe(1.54);
    expect(parseDecimal("1,54")).toBe(1.54);
  });

  it("убирает пробелы и неразрывные пробелы внутри числа", () => {
    expect(parseDecimal(" 88 134.75 ")).toBe(88134.75);
  });

  it("пустая строка и мусор дают запасное значение", () => {
    expect(parseDecimal("")).toBe(0);
    expect(parseDecimal("   ")).toBe(0);
    expect(parseDecimal("П")).toBe(0);
    expect(parseDecimal("не число", -1)).toBe(-1);
  });

  it("отсутствующий атрибут даёт запасное значение", () => {
    expect(parseDecimal(undefined, Number.NaN)).toBeNaN();
    expect(parseDecimal(null, 7)).toBe(7);
  });

  it("ноль остаётся нулём, а не превращается в запасное значение", () => {
    expect(parseDecimal("0", -1)).toBe(0);
    expect(parseDecimal("0.00", -1)).toBe(0);
  });
});

describe("parseQuantity", () => {
  it("численный расход возвращается как есть", () => {
    expect(parseQuantity("1.38000")).toEqual({ value: 1.38, note: null });
  });

  it("расход «по проекту» сохраняет пометку и не выдаёт ноль за число", () => {
    expect(parseQuantity("П")).toEqual({ value: 0, note: "П" });
  });

  it("пустая строка — это ноль без пометки", () => {
    expect(parseQuantity("  ")).toEqual({ value: 0, note: null });
  });

  it("любой нечисловой текст сохраняется как пометка", () => {
    expect(parseQuantity("по проекту")).toEqual({ value: 0, note: "по проекту" });
  });
});

describe("parseNormsXml: настоящая книга норм", () => {
  // Запасная книга намеренно другая: если парсер перестанет читать BaseType из
  // корневого элемента, сравнение с фикстурой сразу покраснеет.
  const [norm] = normsOf(DRAGLINE_BOOK, "ГЭСНр");

  it("разбирает фрагмент выгрузки ровно в ту фикстуру, по которой считается смета", () => {
    expect(norm).toEqual(NORM_DRAGLINE_15);
  });

  it("даёт одну запись на один элемент Work", () => {
    expect(normsOf(DRAGLINE_BOOK)).toHaveLength(1);
  });

  it("собирает наименование из начала группы и окончания работы", () => {
    expect(norm?.fullName).toBe(
      'Разработка грунта в отвал экскаваторами "драглайн" одноковшовыми электрическими ' +
        "шагающими при работе на гидроэнергетическом строительстве с ковшом вместимостью: " +
        "15 м3, группа грунтов 1",
    );
  });

  it("берёт книгу из атрибута BaseType корневого элемента, а не из запасного значения", () => {
    expect(norm?.baseType).toBe("ГЭСН");
  });

  it("разворачивает цепочку разделов: сборник, раздел и подраздел", () => {
    expect(norm?.collectionCode).toBe("01");
    expect(norm?.collectionName).toBe("Земляные работы");
    expect(norm?.sectionName).toContain("МЕХАНИЗИРОВАННАЯ РАЗРАБОТКА ГРУНТОВ");
    expect(norm?.subsectionName).toBe("РАЗРАБОТКА ГРУНТА ЭКСКАВАТОРАМИ В ОТВАЛ");
  });

  it("переносит указатели нормативов накладных расходов и сметной прибыли", () => {
    expect(norm?.overheadRef).toBe("Пр/812-001.1");
    expect(norm?.profitRef).toBe("Пр/774-001.1");
  });
});

describe("parseNormsXml: края формата", () => {
  /**
   * Оборачивает тело работы в минимальную книгу.
   *
   * Атрибут `BaseType` и запасное значение по умолчанию разные («ГЭСНм» против
   * «ГЭСН»), чтобы тест мог показать, откуда именно взялась книга.
   */
  function book(
    body: string,
    baseAttrs = ' BaseType="ГЭСНм"',
    fallbackBaseType = "ГЭСН",
  ): NormRecord[] {
    return normsOf(
      `<base${baseAttrs}><ResourcesDirectory><ResourceCategory CodePrefix="ГЭСНм">` +
        `<Section Name="Монтаж" Type="Сборник" Code="01">${body}</Section>` +
        `</ResourceCategory></ResourcesDirectory></base>`,
      fallbackBaseType,
    );
  }

  it("книга берётся из атрибута BaseType, когда он задан", () => {
    const [norm] = book(
      '<Section Type="Таблица" Code="01-02-003"><Work Code="01-02-003-04" EndName="до 5 т" MeasureUnit="т"><Resources /></Work></Section>',
    );

    expect(norm?.baseType).toBe("ГЭСНм");
  });

  it("без атрибута BaseType книга берётся из запасного значения", () => {
    const [norm] = book(
      '<Section Type="Таблица" Code="01-02-003"><Work Code="01-02-003-04" EndName="до 5 т" MeasureUnit="т"><Resources /></Work></Section>',
      "",
    );

    expect(norm?.baseType).toBe("ГЭСН");
  });

  it("пустой BaseType не принимается за название книги", () => {
    const [norm] = book(
      '<Section Type="Таблица" Code="01-02-003"><Work Code="01-02-003-04" EndName="до 5 т" MeasureUnit="т"><Resources /></Work></Section>',
      ' BaseType=""',
    );

    expect(norm?.baseType).toBe("ГЭСН");
  });

  it("без раздела «Таблица» код таблицы выводится из шифра нормы", () => {
    const [norm] = book(
      '<NameGroup BeginName="Установка:"><Work Code="01-02-003-04" EndName="до 5 т" MeasureUnit="т"><Resources /></Work></NameGroup>',
    );

    expect(norm?.tableCode).toBe("01-02-003");
  });

  it("две работы в одной группе наименований делят общее начало", () => {
    const norms = book(
      '<Section Type="Таблица" Code="01-02-003"><NameGroup BeginName="Установка:">' +
        '<Work Code="01-02-003-01" EndName="до 1 т" MeasureUnit="т"><Resources /></Work>' +
        '<Work Code="01-02-003-02" EndName="до 5 т" MeasureUnit="т"><Resources /></Work>' +
        "</NameGroup></Section>",
    );

    expect(norms.map((norm) => norm.fullName)).toEqual([
      "Установка: до 1 т",
      "Установка: до 5 т",
    ]);
  });

  it("абстрактный и служебный ресурсы помечаются как заданные проектом", () => {
    const [norm] = book(
      '<Section Type="Таблица" Code="01-02-003"><Work Code="01-02-003-04" EndName="до 5 т" MeasureUnit="т"><Resources>' +
        '<AbstractResource Code="01.7.12.16" Name="Сетка геотехническая" Quantity="1428.3" TechnologyGroups="54.08.005" />' +
        '<ServiceResource Code="999-9901" Category="Материал" Name="МАТЕРИАЛЫ (см. приложение)" Quantity="П" />' +
        "</Resources></Work></Section>",
    );

    const [abstract, service] = norm?.resources ?? [];
    expect(abstract?.projectSpecific).toBe(true);
    expect(abstract?.technologyGroup).toBe("54.08.005");
    expect(abstract?.quantity).toBe(1428.3);
    expect(service?.projectSpecific).toBe(true);
    expect(service?.quantity).toBe(0);
    expect(service?.quantityNote).toBe("П");
  });

  it("обычный Resource не помечается как заданный проектом", () => {
    const [norm] = book(
      '<Section Type="Таблица" Code="01-02-003"><Work Code="01-02-003-04" EndName="до 5 т" MeasureUnit="т"><Resources>' +
        '<Resource Code="91.01.01-035" EndName="Бульдозеры, мощность 79 кВт" Quantity="1.6" MeasureUnit="маш.-ч" />' +
        "</Resources></Work></Section>",
    );

    expect(norm?.resources[0]?.projectSpecific).toBe(false);
    expect(norm?.resources[0]?.kind).toBe("MACHINE");
  });

  it("ресурсы вне блока Resources не попадают в норму", () => {
    const [norm] = book(
      '<Section Type="Таблица" Code="01-02-003"><Work Code="01-02-003-04" EndName="до 5 т" MeasureUnit="т">' +
        '<Resource Code="91.01.01-035" Quantity="1.6" />' +
        "<Resources /></Work></Section>",
    );

    expect(norm?.resources).toEqual([]);
  });

  it("ресурс без кода пропускается: оценивать нечего", () => {
    const [norm] = book(
      '<Section Type="Таблица" Code="01-02-003"><Work Code="01-02-003-04" EndName="до 5 т" MeasureUnit="т"><Resources>' +
        '<Resource Code="" EndName="Без кода" Quantity="1" />' +
        '<Resource Code="1-100-30" EndName="Средний разряд работы 3,0" Quantity="2" MeasureUnit="чел.-ч" />' +
        "</Resources></Work></Section>",
    );

    expect(norm?.resources).toHaveLength(1);
    expect(norm?.resources[0]?.code).toBe("1-100-30");
  });

  it("пункты состава работ без текста не дают пустых строк", () => {
    const [norm] = book(
      '<Section Type="Таблица" Code="01-02-003"><Work Code="01-02-003-04" EndName="до 5 т" MeasureUnit="т">' +
        '<Content><Item Text="Разработка грунта." /><Item Text="  " /><Item Text="" /></Content>' +
        "<Resources /></Work></Section>",
    );

    expect(norm?.content).toEqual(["Разработка грунта."]);
  });

  it("код закрытой таблицы не остаётся у работ следующей таблицы", () => {
    const norms = book(
      '<Section Type="Подраздел" Code="2">' +
        '<Section Type="Таблица" Code="01-02-003"><NameGroup BeginName="Установка:">' +
        '<Work Code="01-02-003-01" EndName="до 1 т" MeasureUnit="т"><Resources /></Work>' +
        "</NameGroup></Section>" +
        '<Section Type="Таблица" Code="01-02-004"><NameGroup BeginName="Демонтаж:">' +
        '<Work Code="01-02-004-01" EndName="до 5 т" MeasureUnit="т"><Resources /></Work>' +
        "</NameGroup></Section>" +
        "</Section>",
    );

    expect(norms.map((norm) => norm.tableCode)).toEqual(["01-02-003", "01-02-004"]);
  });

  it("вложенная таблица переопределяет код, а после её закрытия возвращается внешний", () => {
    // В выгрузке таблицы не вкладываются друг в друга — форма защитная. Но стек
    // разделов обязан возвращать внешний код: иначе чужой код таблицы уедет во
    // все оставшиеся работы книги, а норма перестанет находиться по шифру.
    const norms = book(
      '<Section Type="Таблица" Code="01-02-003"><NameGroup BeginName="Установка:">' +
        '<Work Code="01-02-003-01" EndName="до 1 т" MeasureUnit="т"><Resources /></Work>' +
        '<Section Type="Таблица" Code="01-02-999"><NameGroup BeginName="Демонтаж:">' +
        '<Work Code="01-02-999-01" EndName="до 5 т" MeasureUnit="т"><Resources /></Work>' +
        "</NameGroup></Section>" +
        '<Work Code="01-02-003-02" EndName="до 10 т" MeasureUnit="т"><Resources /></Work>' +
        "</NameGroup></Section>",
    );

    expect(norms.map((norm) => norm.tableCode)).toEqual([
      "01-02-003",
      "01-02-999",
      "01-02-003",
    ]);
  });
});

/**
 * Фрагмент «ФСБЦ_Маш.xml»: бульдозер со звеном из одного машиниста, землесос
 * без звена, у которого все три составляющие цены равны нулю, и третья машина
 * без элемента `<Price>` вовсе — только стоимость электроэнергии внутри
 * `<ExpendableMaterials>`. Атрибуты и порядок элементов взяты из выгрузки.
 */
const MACHINE_CATALOG = `<?xml version="1.0" encoding="utf-8"?>
<ResourceCatalog xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Decrees>
    <ApprovingActNumber>527/пр</ApprovingActNumber>
    <ApprovingActDate>12.08.2026</ApprovingActDate>
  </Decrees>
  <ResourcesDirectory>
    <ResourceCategory Type="МашиныМеханизмы">
      <Section Name="Строительные машины и механизмы" Code="91" Type="Книга">
        <Section Name="Машины для земляных работ" Code="91.01" Type="Раздел">
          <Section Name="Бульдозеры" Code="91.01.01" Type="Группа">
            <Resource Code="91.01.01-035" Name="Бульдозеры, мощность 79 кВт (108 л.с.)" MeasureUnit="маш.-ч">
              <Prices>
                <Price SalaryMach="451.93" LabourMach="1.00" PriceCostWithoutSalary="887.54" WithRelocation="true" DriverCode="4-100-060" MachinistCategory="6.0" />
              </Prices>
              <ExpendableMaterials>
                <Material Electricity="0" ElectricityCost="0" />
              </ExpendableMaterials>
            </Resource>
            <Resource Code="91.20.12-101" Name="Землесосы папильонажные рефулерные самоходные с фрезерным разрыхлителем, мощность привода фрезы 800 кВт" MeasureUnit="маш.-ч">
              <Prices>
                <Price SalaryMach="0" LabourMach="0" PriceCostWithoutSalary="0.00" WithRelocation="false" MachinistCategory="" />
              </Prices>
              <ExpendableMaterials>
                <Material Electricity="0" ElectricityCost="0" />
              </ExpendableMaterials>
            </Resource>
            <Resource Code="91.99.99-999" Name="Машина без сметной цены" MeasureUnit="маш.-ч">
              <Prices />
              <ExpendableMaterials>
                <Material Electricity="120" ElectricityCost="3456.78" />
              </ExpendableMaterials>
            </Resource>
          </Section>
        </Section>
      </Section>
    </ResourceCategory>
  </ResourcesDirectory>
</ResourceCatalog>`;

describe("parsePriceCatalogXml: машины", () => {
  const items = pricesOf(MACHINE_CATALOG, "machine");

  it("собирает полную стоимость маш.-ч из двух частей", () => {
    const bulldozer = items.find((item) => item.price.code === "91.01.01-035");

    // 887,54 + 451,93 × 1,00 = 1 339,47.
    expect(bulldozer?.price.price).toBe(1339.47);
    expect(bulldozer?.price.machinistSalary).toBe(451.93);
    expect(bulldozer?.price.machinistHours).toBe(1);
    expect(bulldozer?.price.name).toBe("Бульдозеры, мощность 79 кВт (108 л.с.)");
    expect(bulldozer?.price.unit).toBe("маш.-ч");
    expect(bulldozer?.price.source).toBe("BASE_2022");
  });

  it("зарплата машинистов отдаётся за весь маш.-ч, а не на одного человека", () => {
    const catalog = MACHINE_CATALOG.replace(
      'SalaryMach="451.93" LabourMach="1.00" PriceCostWithoutSalary="887.54"',
      'SalaryMach="1692.45" LabourMach="3.00" PriceCostWithoutSalary="83057.40"',
    );
    const [item] = pricesOf(catalog, "machine");

    // 83 057,40 + 1 692,45 × 3,00 = 88 134,75 — шагающий драглайн 15 м3.
    expect(item?.price.price).toBe(88134.75);
    expect(item?.price.machinistSalary).toBe(5077.35);
    expect(item?.price.machinistHours).toBe(3);
  });

  it("нулевая цена проходит через парсер: решать, цена это или пробел, вправе расчёт", () => {
    const dredger = items.find((item) => item.price.code === "91.20.12-101");

    expect(dredger?.price.price).toBe(0);
    expect(dredger?.price.machinistSalary).toBe(0);
    expect(dredger?.price.machinistHours).toBe(0);
  });

  it("ресурс без элемента Price не выдаёт запись, даже если цена у него есть", () => {
    // У 91.99.99-999 внутри <ExpendableMaterials> стоит Cost="3456.78" — это
    // стоимость электроэнергии, а не сметная цена маш.-ч. Парсер обязан не
    // выдать запись вовсе: цена «из другой колонки» превратилась бы в молча
    // посчитанную позицию.
    expect(items.map((item) => item.price.code)).toEqual(["91.01.01-035", "91.20.12-101"]);
  });

  it("блок расходных материалов не принимается за цену машины", () => {
    // В «ФСБЦ_Маш.xml» 1 112 атрибутов Cost="0" принадлежат <Material> внутри
    // <ExpendableMaterials>, а не <Price>. Если бы парсер читал Cost у любого
    // элемента, бульдозер получил бы 0 ₽ вместо 1 339,47.
    expect(items.map((item) => [item.price.code, item.price.price])).toEqual([
      ["91.01.01-035", 1339.47],
      ["91.20.12-101", 0],
    ]);
  });

  it("номер приказа берётся из текста Decrees и прикладывается к каждой записи", () => {
    expect(items.every((item) => item.approvingAct === "527/пр")).toBe(true);
  });

  it("без блока Decrees реквизит приказа остаётся пустым, а не выдуманным", () => {
    const withoutDecrees = MACHINE_CATALOG.replace(
      /<Decrees>[\s\S]*?<\/Decrees>/,
      "",
    );

    expect(pricesOf(withoutDecrees, "machine")[0]?.approvingAct).toBeNull();
  });
});

describe("parsePriceCatalogXml: материалы", () => {
  const MATERIAL_CATALOG = `<ResourceCatalog>
  <Decrees><ApprovingActNumber>527/пр</ApprovingActNumber></Decrees>
  <ResourcesDirectory>
    <ResourceCategory Type="Материал">
      <Section Name="Материалы" Code="01" Type="Книга">
        <Resource Code="01.1.01.01-0002" Name="Конструкции железобетонные" MeasureUnit="100 компл">
          <Prices><Price Cost="35537.67" OptCost="34458.33" /></Prices>
        </Resource>
        <Resource Code="01.7.12.16-0001" Name="Сетка геотехническая" MeasureUnit="м2">
          <Prices><Price OptCost="120.00" /></Prices>
        </Resource>
      </Section>
    </ResourceCategory>
  </ResourcesDirectory>
</ResourceCatalog>`;

  it("берёт цену из Cost и не подставляет зарплату машинистов", () => {
    const [item] = pricesOf(MATERIAL_CATALOG, "material");

    expect(item?.price.price).toBe(35537.67);
    expect(item?.price.machinistSalary).toBeNull();
    expect(item?.price.machinistHours).toBeNull();
    expect(item?.price.unit).toBe("100 компл");
  });

  it("оптовая цена OptCost не подменяет сметную, а без Cost запись не выдаётся", () => {
    const items = pricesOf(MATERIAL_CATALOG, "material");

    // У второго ресурса есть только OptCost: это не сметная цена, поэтому
    // записи нет вовсе — лучше пробел, чем цена из другой колонки.
    expect(items).toHaveLength(1);
    expect(items[0]?.price.code).toBe("01.1.01.01-0002");
  });

  it("период и зона у базы 2022 года остаются пустыми", () => {
    const [item] = pricesOf(MATERIAL_CATALOG, "material");

    expect(item?.price.period).toBeNull();
    expect(item?.price.zone).toBeNull();
  });
});
