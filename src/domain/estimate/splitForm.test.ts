import { describe, expect, it } from "vitest";

import {
  parseSplitForm,
  splitFormCoverage,
  toCurrentPrice,
  type SheetRow,
} from "@/domain/estimate/splitForm";

/**
 * Строки взяты из выгрузки «Сплит-форма Амурская область (1 зона) на 3 квартал
 * 2026 года» дословно, вместе с прочерками в пустых колонках: на прочерках
 * разбор и ломается, если принять их за ноль.
 */
const HEAD: readonly SheetRow[] = [
  [
    "Сплит-форма индексов и сметных цен для ценовой зоны Амурская область (1 зона) на 3 квартал 2026 года",
  ],
  [
    "Реквизиты письма Минстроя России об индексах изменения сметной стоимости строительства",
    "",
    "",
    "",
    "",
    "",
    "Письмо Минстроя России от 24.08.2026 № 52419-ИФ/09",
  ],
  [
    "Реквизиты нормативного правового акта об утверждении оплаты труда",
    "",
    "",
    "",
    "",
    "",
    "ПРИКАЗ МИНИСТЕРСТВА СТРОИТЕЛЬСТВА И АРХИТЕКТУРЫ АМУРСКОЙ ОБЛАСТИ от 08.04.2026 № 78-ОД",
  ],
  ["Наименование субъекта Российской Федерации", "", "", "", "", "", "Амурская область"],
  [
    "Наименование зоны субъекта Российской Федерации",
    "",
    "",
    "",
    "",
    "",
    "Амурская область (1 зона)",
  ],
  ["1. Настоящие индексы по группам однородных строительных ресурсов рассчитаны…"],
  [
    "Код ресурса, услуги",
    "Наименование строительного ресурса, услуги",
    "Единица измерения",
    "Отпускная цена в уровне цен по состоянию на 01.01.2022, руб.",
    "Сметная цена в уровне цен по состоянию на 01.01.2022, руб.",
    "Номер группы однородных строительных ресурсов",
    "Наименование группы однородных строительных ресурсов",
    "Сметная цена в текущем уровне цен, руб.",
    "Индекс изменения сметной стоимости к группе однородных строительных ресурсов",
  ],
  [1, 2, 3, 4, 5, 6, 7, 8, 9],
];

/** Ресурс с измеренной текущей ценой. */
const WITH_PRICE: SheetRow = [
  "01.1.01.04-1018",
  "Листы хризотилцементные волнистые, профиль 40/150, 7-волновые, толщина 5,2 мм",
  "м2",
  164.14,
  171.17,
  612,
  "Листы хризотилцементные и фиброцементные прочие",
  232.74,
  "-",
];

/** Ресурс, которого на рынке зоны нет: дан индекс к группе. */
const WITH_INDEX: SheetRow = [
  "01.1.01.04-1022",
  "Листы хризотилцементные волнистые, профиль 40/150, 8-волновые, толщина 5,2 мм",
  "м2",
  171.29,
  178.51,
  612,
  "Листы хризотилцементные и фиброцементные прочие",
  "-",
  1.93,
];

/** Машина: отпускной цены нет вовсе, сметная есть, задан индекс. */
const MACHINE: SheetRow = [
  "91.01.01-014",
  "Бульдозеры-рыхлители на тракторе, мощность 79 кВт (108 л.с.)",
  "маш.-ч",
  "-",
  961.73,
  1030,
  "Бульдозеры",
  "-",
  1.68,
];

function sheet(...rows: readonly SheetRow[]): SheetRow[] {
  return [...HEAD, ...rows];
}

describe("parseSplitForm", () => {
  it("читает реквизиты, субъект, зону и период из шапки", () => {
    const { meta } = parseSplitForm(sheet(WITH_PRICE));

    expect(meta).toEqual({
      subject: "Амурская область",
      zone: "Амурская область (1 зона)",
      period: "3 квартал 2026 года",
      indexLetter: "Письмо Минстроя России от 24.08.2026 № 52419-ИФ/09",
      wageAct:
        "ПРИКАЗ МИНИСТЕРСТВА СТРОИТЕЛЬСТВА И АРХИТЕКТУРЫ АМУРСКОЙ ОБЛАСТИ от 08.04.2026 № 78-ОД",
    });
  });

  it("находит шапку по подписи колонки, а не по номеру строки", () => {
    const extraNotes = [
      ...HEAD.slice(0, 6),
      ["2. Дополнительное примечание про перевозку грузов"],
      ["3. И ещё одно"],
      ...HEAD.slice(6),
    ];

    const { rows } = parseSplitForm([...extraNotes, WITH_PRICE]);

    expect(rows).toHaveLength(1);
  });

  it("на листе без шапки падает, а не возвращает пустоту", () => {
    expect(() => parseSplitForm([["что-то не то"]])).toThrow(/шапк/);
  });

  it("разбирает строку с измеренной ценой", () => {
    const [row] = parseSplitForm(sheet(WITH_PRICE)).rows;

    expect(row).toEqual({
      code: "01.1.01.04-1018",
      name: "Листы хризотилцементные волнистые, профиль 40/150, 7-волновые, толщина 5,2 мм",
      unit: "м2",
      releasePrice: 164.14,
      basePrice: 171.17,
      groupNumber: 612,
      groupName: "Листы хризотилцементные и фиброцементные прочие",
      currentPrice: 232.74,
      index: null,
    });
  });

  it("прочерк читает как отсутствие значения, а не как ноль", () => {
    const [row] = parseSplitForm(sheet(MACHINE)).rows;

    expect(row?.releasePrice).toBeNull();
    expect(row?.currentPrice).toBeNull();
    expect(row?.index).toBe(1.68);
  });

  it("не принимает строку нумерации колонок за ресурс", () => {
    expect(parseSplitForm(sheet()).rows).toEqual([]);
  });
});

describe("toCurrentPrice", () => {
  const { meta } = parseSplitForm(sheet(WITH_PRICE));

  it("измеренную цену берёт как есть и помечает источник зоной", () => {
    const [row] = parseSplitForm(sheet(WITH_PRICE)).rows;
    const price = toCurrentPrice(row!, meta);

    expect(price).toMatchObject({
      code: "01.1.01.04-1018",
      price: 232.74,
      source: "CURRENT_ZONE",
      period: "3 квартал 2026 года",
      zone: "Амурская область (1 зона)",
    });
  });

  it("по индексу считает от сметной цены 2022 года той же сплит-формы", () => {
    const [row] = parseSplitForm(sheet(WITH_INDEX)).rows;
    const price = toCurrentPrice(row!, meta);

    // 178,51 × 1,93 = 344,52
    expect(price?.price).toBe(344.52);
    expect(price?.source).toBe("BASE_2022_INDEXED");
  });

  it("у материала не выдумывает оплату труда машинистов", () => {
    const [row] = parseSplitForm(sheet(WITH_PRICE)).rows;

    expect(toCurrentPrice(row!, meta)?.machinistSalary).toBeNull();
  });

  it("у машины двигает оплату труда звена тем же множителем, что и цену", () => {
    const [row] = parseSplitForm(sheet(MACHINE)).rows;
    const price = toCurrentPrice(row!, meta, {
      machinistSalary: 386.65,
      machinistHours: 1,
    });

    // 961,73 × 1,68 = 1615,71; тот же множитель к 386,65 даёт 649,57
    expect(price?.price).toBe(1615.71);
    expect(price?.machinistSalary).toBe(649.57);
    expect(price?.machinistHours).toBe(1);
  });

  it("без цены и без индекса не отдаёт ничего", () => {
    const empty: SheetRow = [
      "01.2.03.04-0001",
      "Ресурс без цены",
      "т",
      "-",
      "-",
      500,
      "Группа",
      "-",
      "-",
    ];
    const [row] = parseSplitForm(sheet(empty)).rows;

    expect(toCurrentPrice(row!, meta)).toBeNull();
  });
});

describe("splitFormCoverage", () => {
  it("делит строки на измеренные, индексные и пустые", () => {
    const { rows } = parseSplitForm(
      sheet(WITH_PRICE, WITH_INDEX, MACHINE, [
        "01.2.03.04-0001",
        "Ресурс без цены",
        "т",
        "-",
        "-",
        500,
        "Группа",
        "-",
        "-",
      ]),
    );

    expect(splitFormCoverage(rows)).toEqual({
      total: 4,
      withCurrentPrice: 1,
      withIndex: 2,
      withNothing: 1,
    });
  });
});
