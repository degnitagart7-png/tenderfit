import { describe, expect, it } from "vitest";

import {
  parseCurrentPricesMeta,
  parseMachinePrices,
  parseMaterialPrices,
  zoneSlug,
  type SheetRow,
} from "@/domain/estimate/currentPrices";

/**
 * Строки взяты из публикации «Сметные цены строительных ресурсов за 3 квартал
 * 2026 г. (город Москва)» дословно, вместе с переносами внутри подписей
 * колонок: именно на них ломается поиск шапки.
 */
const MATERIALS: readonly SheetRow[] = [
  ["Сметные цены на материалы, изделия, конструкции и оборудование*"],
  ["город Москва, г. Москва"],
  ["(наименование субъекта Российской Федерации…)"],
  ["Отчетный период:", "3 квартал 2026"],
  [
    "Код материала, изделия, конструкции\nили оборудования по КСР ",
    "Наименование материала, изделия, конструкции или оборудования по КСР",
    "Единица измерения материала, изделия, конструкции или оборудования по КСР",
    "Сметная цена на материал, изделие, конструкцию или оборудование, руб.",
  ],
  [1, 2, 3, 4],
  ["01.2.01.01-1008", "Битум нефтяной дорожный БНД 100/130", "т", 28369.92],
  ["01.3.01.08-0001", "Топливо дизельное", "т", 61416.12],
];

const MACHINES: readonly SheetRow[] = [
  ["Сметные цены эксплуатации машин и механизмов"],
  ["город Москва, г. Москва"],
  ["Отчетный период:", "3 квартал 2026"],
  [
    "Код ресурса",
    "Наименование ресурса",
    "Ед. изм.",
    "Сметная цена, руб./маш.-ч",
    "Оплата труда машинистов, руб./маш.-ч",
    "Средний разряд машинистов",
    "Код среднего разряда машинистов",
    "Трудозатраты машинистов, чел.-ч",
    "Затраты на электроэнергию,",
  ],
  [1, 2, 3, 4, 5, 6, 7, 8, 9],
  [
    "91.01.01-039",
    "Бульдозеры, мощность 132 кВт (180 л.с.)",
    "маш.-ч",
    2713.62,
    1589.89,
    6,
    "4-100-060",
    1,
    "-",
  ],
];

const META = { zone: "город Москва, г. Москва", period: "3 квартал 2026" };

describe("parseCurrentPricesMeta", () => {
  it("читает зону и отчётный период из шапки", () => {
    expect(parseCurrentPricesMeta(MATERIALS)).toEqual(META);
  });

  it("на листе без шапки отдаёт пустые значения, а не выдумывает", () => {
    expect(parseCurrentPricesMeta([["что-то"]])).toEqual({
      zone: "",
      period: "",
    });
  });
});

describe("parseMaterialPrices", () => {
  it("собирает цену материала с зоной и периодом", () => {
    const [price] = parseMaterialPrices(MATERIALS, META);

    expect(price).toEqual({
      code: "01.2.01.01-1008",
      name: "Битум нефтяной дорожный БНД 100/130",
      unit: "т",
      price: 28369.92,
      machinistSalary: null,
      machinistHours: null,
      source: "CURRENT_ZONE",
      period: "3 квартал 2026",
      zone: "город Москва, г. Москва",
    });
  });

  it("у материала не выдумывает оплату труда машинистов", () => {
    for (const price of parseMaterialPrices(MATERIALS, META)) {
      expect(price.machinistSalary).toBeNull();
    }
  });

  it("строку нумерации колонок за ресурс не принимает", () => {
    expect(parseMaterialPrices(MATERIALS, META)).toHaveLength(2);
  });
});

describe("parseMachinePrices", () => {
  it("берёт оплату труда звена и его трудозатраты как опубликованы", () => {
    const [price] = parseMachinePrices(MACHINES, META);

    expect(price).toMatchObject({
      code: "91.01.01-039",
      price: 2713.62,
      machinistSalary: 1589.89,
      machinistHours: 1,
    });
  });

  it("ресурс без цены в справочник не попадает", () => {
    const withoutPrice = [
      ...MACHINES,
      ["91.01.01-040", "Бульдозер без цены", "маш.-ч", "-", "-", 6, "", 1, "-"],
    ];

    expect(parseMachinePrices(withoutPrice, META)).toHaveLength(1);
  });
});

describe("zoneSlug", () => {
  it("делает из названия зоны имя файла", () => {
    expect(zoneSlug("город Москва, г. Москва")).toBe("gorod-moskva");
  });

  it("разные зоны дают разные имена: цены не затирают друг друга", () => {
    expect(zoneSlug("Амурская область (1 зона)")).not.toBe(
      zoneSlug("Амурская область (2 зона)"),
    );
  });
});
