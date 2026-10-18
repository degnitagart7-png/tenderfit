import { describe, expect, it } from "vitest";

import {
  buildWageAnchors,
  machinistWageFactor,
  normalizePeriod,
  parseFscsr,
  readFscsrMeta,
  type SheetRow,
} from "@/domain/estimate/zoneBuild";

/*
  Разбор ФСЦСР и реестра ставок на нескольких строках в формате выгрузки. Два
  сборщика — общий индекс и сборщик зоны — используют эти функции, поэтому здесь
  фиксируется, что именно они делают с дублями, нулями и подписью зоны.
*/

const HEAD = (zoneLine: string): SheetRow[] => [
  [zoneLine],
  ["(наименование субъекта)"],
  [],
  ["Отчетный период: 3 квартал 2026 года"],
  ["ВЫХОДНАЯ ТАБЛИЦА"],
  [],
  ["Код ресурса", "Наименование", "Ед.", "Цена", "ОТм", "Разряд", "Код", "Часы"],
  ["1", 2, 3, 4, 5, 6, 7, 8],
];

const machine = (code: string, price: unknown, salary: unknown, rank: unknown, hours: unknown): SheetRow => [
  code, `Машина ${code}`, "маш.-ч", price, salary, rank, "", hours,
];

describe("readFscsrMeta", () => {
  it("зона, субъект и период из шапки листа, а не из имени файла", () => {
    expect(readFscsrMeta(HEAD("Республика Бурятия (5 зона), г. Улан-Удэ"))).toEqual({
      region: "Республика Бурятия",
      zone: "Республика Бурятия (5 зона)",
      period: "3 квартал 2026 г.",
      titleLine: "Республика Бурятия (5 зона), г. Улан-Удэ",
    });
  });

  it("период в соседней ячейке («Отчетный период:» | «3 квартал 2026»)", () => {
    const rows: SheetRow[] = [["Амурская область (1 зона), г. Благовещенск"], [], [], [], ["Отчетный период:", "3 квартал 2026"]];
    expect(readFscsrMeta(rows).period).toBe("3 квартал 2026 г.");
  });

  it("центр зоны — село или посёлок, а не город (реальные шапки зон 1 и 8 Бурятии)", () => {
    const period = ["Отчетный период:", "3 квартал 2026"];
    const orlik = readFscsrMeta([["Сметные цены на материалы"], ["Республика Бурятия (1 зона), с. Орлик"], [], [], period]);
    expect(orlik.zone).toBe("Республика Бурятия (1 зона)");
    expect(orlik.region).toBe("Республика Бурятия");
    const uoyan = readFscsrMeta([["Сметные цены на материалы"], ["Республика Бурятия (8 зона), пгт. Новый Уоян"], [], [], period]);
    expect(uoyan.zone).toBe("Республика Бурятия (8 зона)");
  });

  it("центр зоны — городской посёлок «гп.» (реальная шапка 11-й зоны Красноярского края)", () => {
    const period = ["Отчетный период:", "3 квартал 2026"];
    const meta = readFscsrMeta([
      ["Сметные цены на материалы, изделия, конструкции и оборудование"],
      ["Красноярский край (11 зона), гп. Северо-Енисейский"],
      [],
      [],
      period,
    ]);
    expect(meta.zone).toBe("Красноярский край (11 зона)");
    expect(meta.region).toBe("Красноярский край");
  });

  it("нет периода или зоны — ошибка, а не пустые поля", () => {
    expect(() => readFscsrMeta([["Республика Бурятия (5 зона), г. Улан-Удэ"]])).toThrow(/отчётный период/);
    expect(() => readFscsrMeta([["Отчетный период: 3 квартал 2026"]])).toThrow(/ценовую зону/);
  });

  it("период приводится к одному виду", () => {
    expect(normalizePeriod("3 квартал 2026 года")).toBe("3 квартал 2026 г.");
    expect(normalizePeriod("3 квартал 2026")).toBe("3 квартал 2026 г.");
    expect(normalizePeriod("  ")).toBe("");
  });
});

describe("parseFscsr", () => {
  const materials: SheetRow[] = [...HEAD("Республика Бурятия (5 зона), г. Улан-Удэ"), ["01.1.01.04-1018", "Листы", "м2", "1,232.5"]];

  it("дубль машины схлопывается, ставки машинистов — якорями по разрядам", () => {
    const machines: SheetRow[] = [
      ...HEAD("Республика Бурятия (5 зона), г. Улан-Удэ"),
      machine("91.01.01-038", 2399.26, 749.32, 6, 1),
      machine("91.01.01-038", 2399.26, 749.32, 6, 1),
      machine("91.01.05-134", 3000, 2250.32, 8, 2),
      machine("91.01.09-001", 100, "-", "", ""),
    ];
    const data = parseFscsr(machines, materials);

    expect(data.machines.map((item) => item.code)).toEqual(["91.01.01-038", "91.01.05-134", "91.01.09-001"]);
    expect(data.anchors.map((anchor) => [anchor.rank, anchor.salary])).toEqual([
      [6, 749.32],
      [8, 1125.16],
    ]);
    // Машина без звена: нули — законные, якоря она не даёт.
    expect(data.machines[2]).toMatchObject({ machinistSalary: 0, machinistHours: 0 });
    expect(data.notes.join(" ")).toContain("3 уникальных кодов");
  });

  it("расхождение разрядов и дублей с разной ценой попадает в замечания", () => {
    const machines: SheetRow[] = [
      ...HEAD("Республика Бурятия (5 зона), г. Улан-Удэ"),
      machine("91.01.01-038", 100, 600, 6, 1),
      machine("91.01.01-038", 120, 600, 6, 1),
      machine("91.01.01-039", 100, 700, 6, 1),
    ];
    const notes = parseFscsr(machines, materials).notes.join(" ");

    expect(notes).toContain("Расхождений цены или зарплаты машинистов между дублями строк: 1");
    expect(notes).toContain("Разряды, которым в листе машин соответствует больше одной ставки: 6: 600 / 700");
  });

  it("примечания под таблицей (выгрузка Москвы) не становятся ресурсами", () => {
    const note =
      "1. Сметные цены и индексы по группам однородных строительных ресурсов для города Москвы применяются для определения сметной стоимости строительства";
    const head = HEAD("город Москва, г. Москва");
    const data = parseFscsr(
      [...head, machine("91.01.01-038", 2399.26, 749.32, 6, 1), [note, "", "", "1"], [note, "", "", "1"]],
      [...head, ["01.1.01.04-1018", "Листы", "м2", "1,232.5"], [note, "", "", "2"]],
    );

    expect(data.machines.map((item) => item.code)).toEqual(["91.01.01-038"]);
    expect(data.materials.map((item) => item.code)).toEqual(["01.1.01.04-1018"]);
    expect(data.notes.join(" ")).toContain("Строк без кода ресурса (примечания под таблицей) пропущено: 3");
  });

  it("материал: цена «1,232.5» (запятая — разряды, точка — десятичная) читается числом, строка без цены пропускается", () => {
    const rows: SheetRow[] = [...materials, ["01.1.01.04-1068", "Листы 2", "м2", "-"]];
    const data = parseFscsr([...HEAD("Республика Бурятия (5 зона), г. Улан-Удэ")], rows);

    expect(data.materials).toHaveLength(1);
    expect(data.materials[0]).toMatchObject({ code: "01.1.01.04-1018", price: 1232.5, machinistSalary: null, zone: "Республика Бурятия (5 зона)" });
    expect(data.notes.join(" ")).toContain("Строк материалов без числовой цены пропущено: 1");
  });
});

describe("buildWageAnchors", () => {
  const AUTH = "МИНИСТЕРСТВО";
  const item = (code: string, rank: unknown, salary: unknown, name = "Средний разряд работы") => ({
    code,
    salaryRateName: name,
    salaryRateRank: rank,
    salary,
    authorityName: AUTH,
  });

  it("первая страница реестра: рабочие 1-100 и якоря машинистов ФСЦСР; разряд — число из кода", () => {
    const built = buildWageAnchors(
      { total: 186, items: [item("1-100-10", "1.0", "416.29"), item("1-100-34", null, 700), item("", "2.0", "1"), item("1-100-20", "2.0", "bad")] },
      [{ rank: 6, salary: 749.32, source: "ФСЦСР" }],
    );

    expect(built.anchors.map((anchor) => [anchor.rank, anchor.salary])).toEqual([
      [1, 416.29],
      [3.4, 700],
      [6, 749.32],
    ]);
    expect(built.registryCount).toBe(2);
    expect(built.anchors[0]?.source).toBe("Реестр ставок оплаты труда рабочих: МИНИСТЕРСТВО");
    expect(built.notes.join(" ")).toContain("Реестр дал 2 ставок рабочих (разряды 1–3.4)");
    // На первой странице специалистов нет — и это сказано, а не молчит.
    expect(built.specialists).toEqual([]);
    expect(built.notes.join(" ")).toContain("Ставок специалистов (коды «3-*») в реестре нет");
  });

  it("полный реестр: 1-100 — опорные точки, 4-100 — машинисты, 3-* — специалисты по коду и наименованию", () => {
    const built = buildWageAnchors(
      {
        total: 8,
        items: [
          item("1-100-10", "1.0", "548.86"),
          item("1-100-80", "8.0", "1125.16"),
          item("4-100-043", "4.3", "768.40", "Средний разряд машинистов 4,3"),
          item("4-100-100", "10.0", "1300"),
          item("3-200-03", "3.0", "965.99", "Инженер III категории"),
          item("3-100-01", "1.0", "779.38", "Техник I категории"),
          item("3-300-01", "1.0", "1289.82", "Ведущий инженер"),
          item("5-100-01", "1.0", "548.86", "Работник-исполнитель реставрационных работ 1 разряда"),
        ],
      },
      [],
    );

    expect(built.anchors.map((anchor) => [anchor.rank, anchor.salary])).toEqual([
      [1, 548.86],
      [8, 1125.16],
    ]);
    expect(built.machinists.map((anchor) => [anchor.rank, anchor.salary])).toEqual([
      [4.3, 768.4],
      [10, 1300],
    ]);
    expect(built.specialists.map((entry) => [entry.code, entry.name, entry.salary])).toEqual([
      ["3-200-03", "Инженер III категории", 965.99],
      ["3-100-01", "Техник I категории", 779.38],
      ["3-300-01", "Ведущий инженер", 1289.82],
    ]);
    expect(built.notes.join(" ")).toContain("Ставок специалистов в реестре: 3 (3-200-03, 3-100-01, 3-300-01)");
    expect(built.notes.join(" ")).toContain("Ставок среднего разряда машинистов в реестре: 2");
  });

  it("«3.0» в поле разряда у инженера — номер категории, а не разряд рабочих", () => {
    const built = buildWageAnchors({ items: [item("3-200-03", "3.0", "965.99", "Инженер III категории")] }, []);

    expect(built.anchors).toEqual([]);
    expect(built.specialists).toHaveLength(1);
  });

  it("5-100 (реставраторы) нормы не используют — пропускаются и это отмечено", () => {
    const built = buildWageAnchors({ items: [item("5-100-01", "1.0", "1"), item("9-999-99", "1.0", "1")] }, []);

    expect(built.anchors).toEqual([]);
    expect(built.notes.join(" ")).toContain("Записей реестра, на которые нормы не ссылаются (реставраторы «5-100-*» и прочие), пропущено: 2");
  });

  it("2-100 («Рабочий N разряда») совпадает с 1-100 — в шкалу не добавляется; расхождение — в замечаниях", () => {
    const good = buildWageAnchors({ items: [item("1-100-40", "4.0", "735.47"), item("2-100-04", "4.0", "735.47")] }, []);
    expect(good.anchors).toHaveLength(1);
    expect(good.notes.join(" ")).not.toContain("расходится");

    const bad = buildWageAnchors({ items: [item("1-100-40", "4.0", "735.47"), item("2-100-04", "4.0", "700")] }, []);
    expect(bad.anchors.map((anchor) => anchor.salary)).toEqual([735.47]);
    expect(bad.notes.join(" ")).toContain("2-100-04: 700 против 735.47");
  });

  it("реестр может быть голым массивом; пустой — только якоря машинистов и замечание", () => {
    expect(buildWageAnchors([item("1-100-10", "1.0", 1)], []).registryCount).toBe(1);
    const empty = buildWageAnchors({ items: [] }, [{ rank: 6, salary: 1, source: "x" }]);
    expect(empty.anchors).toHaveLength(1);
    expect(empty.notes.join(" ")).toContain("Реестр не назвал издавший орган");
  });
});

describe("machinistWageFactor", () => {
  const machine = (code: string, salary: number) => ({
    code,
    name: code,
    unit: "маш.-ч",
    price: 1,
    machinistSalary: salary,
    machinistHours: 1,
    source: "CURRENT_ZONE" as const,
    period: null,
    zone: null,
  });
  const make = (count: number, factor: number, odd = 0) => {
    const measured = [];
    const base = new Map<string, { machinistSalary: number }>();
    for (let i = 0; i < count; i += 1) {
      const code = `91.01.01-${String(i).padStart(3, "0")}`;
      const reference = 100 + i * 3;
      base.set(code, { machinistSalary: reference });
      measured.push(machine(code, Math.round(reference * (i < odd ? factor / 3 : factor) * 100) / 100));
    }
    return { measured, base };
  };

  it("медиана отношения «оплата труда в ФСЦСР / в базе 2022»", () => {
    const { measured, base } = make(40, 2.1861, 4);
    const result = machinistWageFactor(measured, base);

    expect(result?.factor).toBeCloseTo(2.1861, 3);
    expect(result?.compared).toBe(40);
    expect(result?.fitting).toBe(36);
  });

  it("машины без звена (0) и без базы в сравнение не идут", () => {
    const { measured, base } = make(30, 1.6581);
    const result = machinistWageFactor([...measured, machine("91.99.99-001", 0), machine("91.99.99-002", 500)], base);

    expect(result?.compared).toBe(30);
  });

  it("мало машин или разнобой — множителя нет, сборщик остаётся на прежнем выводе", () => {
    expect(machinistWageFactor(...Object.values(make(10, 2)) as [never, never])).toBeNull();
    const { measured, base } = make(40, 2, 20);
    expect(machinistWageFactor(measured, base)).toBeNull();
  });
});
