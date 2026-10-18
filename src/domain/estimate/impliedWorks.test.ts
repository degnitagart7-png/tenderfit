import { describe, expect, it } from "vitest";

import {
  buildImpliedWorksPrompt,
  checkAddition,
  duplicateOf,
  evaluateFormula,
  isTemporaryMeasureNorm,
  IMPLIED_CATEGORY_DEFINITIONS,
  sameNormTable,
  workSubject,
  extractObjectFacts,
  IMPLIED_CATEGORIES,
  impliedNote,
  impliedWorksMaxTokens,
  impliedWorksRequestSchema,
  MAX_IMPLIED_ADDITIONS,
  parseFormula,
  parseImpliedWorksResponse,
  type ImpliedCatalogItem,
  type ImpliedRequest,
  type RawAddition,
} from "@/domain/estimate/impliedWorks";

/*
  Формула объёма (разбор без eval), сведения об объекте из ТЗ, разбор ответа модели и проверка дополнений кодом. Модели здесь нет.
*/

const CATALOG = new Map<string, ImpliedCatalogItem>([
  ["1", { id: "1", name: "Демонтаж профлиста", quantity: 199.1, unit: "м2" }],
  ["2", { id: "2", name: "Монтаж утеплителя", quantity: 56.5, unit: "м2" }],
  ["3", { id: "3", name: "Монтаж мембраны", quantity: 73.3, unit: "м2" }],
  ["4", { id: "4", name: "Заполнение проёмов", quantity: 12, unit: "шт" }],
  ["10", { id: "10", name: "Объём бетона", quantity: 8, unit: "м3" }],
]);

const value = (formula: string, lookup: (id: string) => number | undefined = (id) => CATALOG.get(id)?.quantity) => {
  const parsed = parseFormula(formula);
  if (!parsed.ok) throw new Error(parsed.error);
  return evaluateFormula(parsed.node, lookup);
};

describe("формула объёма: разбор и вычисление", () => {
  it("числа, ссылки, + − × /, скобки, max; результат округлён до 0,001", () => {
    expect(value("max(#1, #3)")).toEqual({ ok: true, value: 199.1 });
    expect(value("#1 + #2")).toEqual({ ok: true, value: 255.6 });
    expect(value("(#1 - #2) * 2")).toEqual({ ok: true, value: 285.2 });
    expect(value("#2 × 1.2")).toEqual({ ok: true, value: 67.8 });
    expect(value("#3 / 3")).toEqual({ ok: true, value: 24.433 });
    expect(value("max(#1, #2 + #3, 10) / 2")).toEqual({ ok: true, value: 99.55 });
    expect(value("МАКС(#2,#3)")).toEqual({ ok: true, value: 73.3 });
    expect(value("−5 + #1")).toEqual({ ok: true, value: 194.1 });
  });

  it("приоритет операций и ассоциативность: 2 + 3 × 4 = 14, 10 − 4 − 3 = 3, 12 / 3 / 2 = 2", () => {
    expect(value("2 + 3 * 4 + #4 - #4")).toEqual({ ok: true, value: 14 });
    expect(value("10 - 4 - 3 + #4 - #4")).toEqual({ ok: true, value: 3 });
    expect(value("12 / 3 / 2 + #4 - #4")).toEqual({ ok: true, value: 2 });
  });

  it("ссылки перечисляются в порядке появления, без повторов", () => {
    const parsed = parseFormula("max(#3, #1) + #3 + #10");
    expect(parsed.ok && parsed.refs).toEqual(["3", "1", "10"]);
  });

  it("недопустимое отвергается с причиной: код, вызовы функций, имена, запятая как десятичная, пустота, обрыв, лишний текст", () => {
    const invalid = [
      "",
      "   ",
      "process.exit(1)",
      "eval('1')",
      "constructor",
      "__proto__",
      "#1; #2",
      "#1 #2",
      "(#1 + #2",
      "#1 + ",
      "max(#1, )",
      "max #1",
      "max(#1 #2)",
      "1,2 * #1",
      "min(#1, #2)",
      "#1 ** 2",
      "#1 % 2",
      "$1",
      "#",
      "#1 + [2]",
      "#1 + #2 )",
    ];
    for (const formula of invalid) expect(parseFormula(formula), formula).toMatchObject({ ok: false });
    expect((parseFormula("eval('1')") as { error: string }).error).toContain("недопустимый знак");
  });

  it("слишком длинная и слишком вложенная формулы отвергаются", () => {
    expect(parseFormula(`#1${" + #2".repeat(40)}`)).toMatchObject({ ok: false, error: expect.stringContaining("длиннее") });
    expect(parseFormula(`${"(".repeat(30)}#1${")".repeat(30)}`)).toMatchObject({ ok: false, error: expect.stringContaining("вложена") });
    expect(parseFormula(`${"1+".repeat(50)}1`)).toMatchObject({ ok: false });
  });

  it("вычисление: деление на ноль, неположительный и неправдоподобный результат, неизвестная ссылка", () => {
    expect(value("#1 / (#2 - #2)")).toMatchObject({ ok: false, error: "деление на ноль" });
    expect(value("#2 - #1")).toMatchObject({ ok: false, error: expect.stringContaining("не положителен") });
    expect(value("#1 * 1000000")).toMatchObject({ ok: false, error: expect.stringContaining("велик") });
    expect(value("#99 + 1")).toMatchObject({ ok: false, error: expect.stringContaining("#99") });
  });
});

describe("сведения об объекте из ТЗ", () => {
  const text = [
    "Предмет закупки: ремонт утепления фасада 5-этажного здания. Высота здания до 16,5 м.",
    "Высота потолков в помещениях 2,7 м. Внутренние работы не предусмотрены.",
    "Кровля — рулонная, ремонт не требуется.",
  ].join("\n");

  it("высота здания и этажность найдены, высота потолков и этажа не путается с высотой здания", () => {
    const facts = extractObjectFacts([text]);
    expect(facts.heightM).toBe(16.5);
    expect(facts.floors).toBe(5);
    expect(facts.mentions).toEqual({ facade: true, roof: true, interior: true });
    expect(facts.snippets.some((snippet) => snippet.includes("Высота здания до 16,5 м"))).toBe(true);
    expect(facts.snippets.length).toBeLessThanOrEqual(8);
    expect(facts.snippets.every((snippet) => snippet.length <= 200)).toBe(true);
  });

  it("«этажность: 9», «12 этажей»; высота этажа не берётся", () => {
    expect(extractObjectFacts(["Этажность: 9"]).floors).toBe(9);
    expect(extractObjectFacts(["Жилой дом, 12 этажей"]).floors).toBe(12);
    const floor = extractObjectFacts(["Высота этажа 3 м"]);
    expect(floor.heightM).toBeNull();
  });

  it("нет сведений — пусто, а не придумано", () => {
    expect(extractObjectFacts(["Замена светильников в коридоре."])).toEqual({
      heightM: null,
      floors: null,
      mentions: { facade: false, roof: false, interior: false },
      snippets: [],
    });
  });
});

describe("разбор ответа модели", () => {
  const addition = { workName: "Устройство и разборка наружных инвентарных лесов", category: "SCAFFOLD", unit: "м2", formula: "max(#1, #3)", reason: "Работы на фасаде выше 1,8 м" };

  it("объект additions, голый массив и ограждение ``` читаются; регистр категории не важен", () => {
    expect(parseImpliedWorksResponse(JSON.stringify({ additions: [addition] })).additions).toHaveLength(1);
    expect(parseImpliedWorksResponse(JSON.stringify([{ ...addition, category: "scaffold" }])).additions[0]?.category).toBe("SCAFFOLD");
    expect(parseImpliedWorksResponse(`\`\`\`json\n${JSON.stringify({ additions: [addition] })}\n\`\`\``).additions).toHaveLength(1);
    expect(parseImpliedWorksResponse(JSON.stringify({ additions: [] }))).toEqual({ additions: [], malformed: 0 });
  });

  it("категория вне белого списка, нет формулы, мусор — кривые элементы считаются, остальные живут", () => {
    const parsed = parseImpliedWorksResponse(
      JSON.stringify({ additions: [addition, { ...addition, category: "MAIN_WORK" }, { ...addition, formula: "" }, "мусор", { ...addition, workName: "ab" }] }),
    );
    expect(parsed.additions).toHaveLength(1);
    expect(parsed.malformed).toBe(4);
  });

  it("не больше восьми дополнений: лишние отбрасываются и считаются", () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ ...addition, workName: `Леса ${String(index)} секция` }));
    const parsed = parseImpliedWorksResponse(JSON.stringify({ additions: many }));
    expect(parsed.additions).toHaveLength(MAX_IMPLIED_ADDITIONS);
    expect(parsed.malformed).toBe(3);
  });

  it("не JSON и ответ без списка — ошибка с началом ответа", () => {
    expect(() => parseImpliedWorksResponse("Извините, не могу")).toThrow(/не JSON/);
    expect(() => parseImpliedWorksResponse(JSON.stringify({ ответ: 1 }))).toThrow(/additions/);
  });
});

describe("проверка дополнения кодом", () => {
  const raw = (patch: Partial<RawAddition> = {}): RawAddition => ({
    workName: "Устройство и разборка наружных трубчатых инвентарных лесов",
    category: "SCAFFOLD",
    unit: "м2",
    formula: "max(#1, #3)",
    reason: "Работы на фасаде выше 1,8 м ведутся с лесов",
    ...patch,
  });
  const existing = ["Демонтаж профлиста", "Монтаж утеплителя", "Монтаж мембраны"];

  it("принято: объём по формуле, единица базовая, ссылки названы; пояснение с расшифровкой ссылок", () => {
    const check = checkAddition(raw(), CATALOG, existing);
    expect(check.status).toBe("ACCEPTED");
    if (check.status !== "ACCEPTED") return;
    expect(check.draft).toMatchObject({ quantity: 199.1, unit: "м2", category: "SCAFFOLD", formula: "max(#1, #3)" });
    expect(check.draft.refs.map((ref) => ref.id)).toEqual(["1", "3"]);
    const note = impliedNote(check.draft);
    expect(note).toBe(
      "добавлено ИИ: Работы на фасаде выше 1,8 м ведутся с лесов; объём = max(#1, #3) = 199,1 м2 (#1 — «Демонтаж профлиста» 199,1 м2; #3 — «Монтаж мембраны» 73,3 м2)",
    );
  });

  it("ссылка на позицию, которой нет в списке, — отказ", () => {
    const check = checkAddition(raw({ formula: "max(#1, #77)" }), CATALOG, existing);
    expect(check).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("#77") });
  });

  it("формула без ссылок (число из головы), невалидная формула, деление на ноль — отказ", () => {
    expect(checkAddition(raw({ formula: "250" }), CATALOG, existing)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("нет ссылок") });
    expect(checkAddition(raw({ formula: "eval('1')" }), CATALOG, existing)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("формула") });
    expect(checkAddition(raw({ formula: "#1 / (#2 - #2)" }), CATALOG, existing)).toMatchObject({ status: "REJECTED", reason: "«Устройство и разборка наружных трубчатых инвентарных лесов»: деление на ноль" });
  });

  it("единицы: работа в м2, а позиция в формуле в м3 или шт — отказ; небазовая или нечитаемая единица — отказ", () => {
    expect(checkAddition(raw({ formula: "#10" }), CATALOG, existing)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("единицы разных величин") });
    expect(checkAddition(raw({ formula: "max(#1, #4)" }), CATALOG, existing)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("#4") });
    expect(checkAddition(raw({ unit: "100 м2" }), CATALOG, existing)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("не базовая") });
    expect(checkAddition(raw({ unit: "ящиков" }), CATALOG, existing)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("не читается") });
  });

  it("штуки по штукам — можно: единицы одной величины", () => {
    const check = checkAddition(raw({ workName: "Устройство защитных козырьков над входами", category: "PROTECTION", unit: "шт", formula: "#4 / 4" }), CATALOG, existing);
    expect(check).toMatchObject({ status: "ACCEPTED", draft: { quantity: 3, unit: "шт" } });
  });

  it("дубль: леса уже есть в ведомости — отказ; общие слова наименования — тоже", () => {
    expect(checkAddition(raw(), CATALOG, [...existing, "Установка и разборка лесов"])).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("уже есть") });
    expect(duplicateOf("SCAFFOLD", "Леса", ["Монтаж подмостей"])).toBe("Монтаж подмостей");
    expect(duplicateOf("PROTECTION", "Сетка защитная", ["Установка сеток"])).toBe("Установка сеток");
    expect(duplicateOf("ENCLOSURE", "Ограждение зоны работ", ["Устройство ограждения"])).toBe("Устройство ограждения");
    expect(duplicateOf("OTHER_TECH", "Закрытие оконных проёмов плёнкой на время работ", ["Закрытие оконных проёмов плёнкой на время работ"])).not.toBeNull();
    expect(duplicateOf("SCAFFOLD", "Леса строительные", ["Монтаж профлиста", "Демонтаж утеплителя"])).toBeNull();
  });
});

describe("запрос и промпт", () => {
  const request: ImpliedRequest = {
    context: { regNumber: "0134300025826000377", subject: "Ремонт утепления фасада", jobId: null },
    facts: { heightM: 12, floors: 4, mentions: { facade: true, roof: false, interior: false }, snippets: ["Высота здания до 12 м"] },
    items: [
      { id: "1", name: "Демонтаж профлиста", quantity: 199.1, unit: "м2", norm: { book: "ГЭСНр", code: "63-03-007-02", name: "Замена облицовки наружных стен из металлического сайдинга" }, machines: false },
      { id: "2", name: "Монтаж утеплителя", quantity: 56.5, unit: "м2", norm: null, machines: null },
    ],
  };

  it("в промпте: белый список категорий с определениями, грамматика формулы, факты об объекте, позиции с нормой и машинами", () => {
    const prompt = buildImpliedWorksPrompt(request);
    for (const category of IMPLIED_CATEGORIES) expect(prompt).toContain(`- ${category} — `);
    expect(prompt).toContain("леса, подмости, люльки");
    expect(prompt).toContain("защитные сетки");
    expect(prompt).toContain("временные ограждения и укрытия");
    expect(prompt).toContain("подъём материалов");
    expect(prompt).toContain("max(a, b, …)");
    expect(prompt).toContain("Хотя бы одна ссылка обязательна");
    expect(prompt).toContain("Не материалы норм");
    expect(prompt).toContain("Не дубли");
    expect(prompt).toContain("Не больше 8 дополнений");
    expect(prompt).toContain("Закупка № 0134300025826000377");
    expect(prompt).toContain("Высота здания по ТЗ: 12 м");
    expect(prompt).toContain("Этажность по ТЗ: 4");
    expect(prompt).toContain("#1 | Демонтаж профлиста | 199,1 м2 | норма ГЭСНр 63-03-007-02");
    expect(prompt).toContain("машины: нет");
    expect(prompt).toContain("#2 | Монтаж утеплителя | 56,5 м2 | норма не подобрана | машины: неизвестно");
    expect(impliedWorksMaxTokens()).toBeGreaterThan(1000);
  });

  it("схема запроса: от 1 до 80 позиций, длинное обрезается, лишних полей нет", () => {
    const body = { regNumber: "R", subject: "s".repeat(2000), facts: request.facts, items: request.items };
    const parsed = impliedWorksRequestSchema.safeParse(body);
    expect(parsed.success && parsed.data.subject.length).toBe(1000);
    expect(impliedWorksRequestSchema.safeParse({ ...body, items: [] }).success).toBe(false);
    const many = Array.from({ length: 81 }, (_, index) => ({ ...request.items[0], id: String(index + 1) }));
    expect(impliedWorksRequestSchema.safeParse({ ...body, items: many }).success).toBe(false);
  });
});

describe("дубль дополнения: предмет работы, а не общие слова (реальные отказы)", () => {
  it("леса не дубль строки «Расчистка вручную поверхностей тяг от старых покрасок …»: подмости — место работы, а не предмет", () => {
    const existing = ["Расчистка вручную поверхностей тяг от старых покрасок с подмостей и лесов с помощью шпателей"];
    expect(duplicateOf("SCAFFOLD", "Установка и разборка внутренних трубчатых инвентарных лесов для отделочных работ", existing)).toBeNull();
    expect(workSubject(existing[0] as string)).toBe("расчистка вручную поверхностей тяг");
  });

  it("сетки не дубль строки «Замена облицовки подшивки козырька …»: козырёк — ремонтируемая конструкция, не защитная мера", () => {
    const existing = ["Замена облицовки подшивки козырька из профилированного листа"];
    expect(duplicateOf("PROTECTION", "Установка защитно-улавливающих сеток", existing)).toBeNull();
  });

  it("но те же леса и те же сетки в ведомости — дубль: предмет совпал", () => {
    expect(duplicateOf("SCAFFOLD", "Установка и разборка внутренних трубчатых инвентарных лесов", ["Леса трубчатые наружные для ремонта фасада"])).not.toBeNull();
    expect(duplicateOf("SCAFFOLD", "Устройство лесов", ["Монтаж подмостей с настилом"])).not.toBeNull();
    expect(duplicateOf("PROTECTION", "Установка защитно-улавливающих сеток", ["Устройство защитной сетки на фасаде"])).not.toBeNull();
    expect(duplicateOf("PROTECTION", "Устройство защитных козырьков над входами", ["Монтаж защитного козырька над крыльцом"])).not.toBeNull();
  });

  it("постоянное ограждение кровли — не дубль временного ограждения зоны работ", () => {
    expect(duplicateOf("ENCLOSURE", "Устройство временного ограждения зоны работ", ["Монтаж ограждения кровли из труб"])).toBeNull();
  });

  it("общие слова («установка», «разборка», «инвентарный») дублем не считаются, высокое сходство фразы — считается", () => {
    expect(duplicateOf("OTHER_TECH", "Установка и разборка инвентарных щитов", ["Установка и разборка инвентарных ограждений"])).toBeNull();
    expect(duplicateOf("OTHER_TECH", "Закрытие оконных проёмов плёнкой", ["Закрытие оконных проёмов плёнкой на время работ"])).not.toBeNull();
  });

  it("одна таблица норм: книга + первые три группы шифра", () => {
    expect(sameNormTable({ book: "ГЭСН", code: "08-07-001-02" }, { book: "ГЭСН", code: "08-07-001-05" })).toBe(true);
    expect(sameNormTable({ book: "ГЭСН", code: "08-07-001-02" }, { book: "ГЭСН", code: "08-07-002-01" })).toBe(false);
    expect(sameNormTable({ book: "ГЭСН", code: "08-07-001-02" }, { book: "ГЭСНр", code: "08-07-001-02" })).toBe(false);
  });
});

describe("белый список — только временные меры", () => {
  it("«Устройство козырька над сопряжением» в OTHER_TECH — отказ: элемент здания, а не временная мера", () => {
    const check = checkAddition(
      { workName: "Устройство козырька над сопряжением", category: "OTHER_TECH", unit: "м2", formula: "#1", reason: "нужен для защиты узла" },
      CATALOG,
      [],
    );
    expect(check).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("временные защитные меры") });
  });

  it("закрытие проёмов плёнкой на время работ в OTHER_TECH принимается", () => {
    const check = checkAddition({ workName: "Закрытие оконных проёмов плёнкой на время работ", category: "OTHER_TECH", unit: "м2", formula: "#2 / 4", reason: "пыль" }, CATALOG, []);
    expect(check.status).toBe("ACCEPTED");
  });

  it("норма: временная мера читается, постоянная конструкция — нет", () => {
    expect(isTemporaryMeasureNorm("SCAFFOLD", "Установка и разборка наружных инвентарных лесов высотой до 16 м")).toBe(true);
    expect(isTemporaryMeasureNorm("PROTECTION", "Устройство защитно-улавливающих сеток")).toBe(true);
    expect(isTemporaryMeasureNorm("OTHER_TECH", "Закрытие проёмов плёнкой на время работ")).toBe(true);
    expect(isTemporaryMeasureNorm("OTHER_TECH", "Устройство козырьков над входами")).toBe(false);
    expect(isTemporaryMeasureNorm("PROTECTION", "Устройство козырьков над входами")).toBe(false);
    expect(isTemporaryMeasureNorm("OTHER_TECH", "Огнезащитная обработка деревянных конструкций")).toBe(false);
  });

  it("определение OTHER_TECH — временные защитные меры; в промпте запрет новых элементов здания", () => {
    expect(IMPLIED_CATEGORY_DEFINITIONS.OTHER_TECH).toContain("ВРЕМЕННЫЕ");
    expect(IMPLIED_CATEGORY_DEFINITIONS.OTHER_TECH).toContain("НЕ новые конструктивные элементы здания");
    const prompt = buildImpliedWorksPrompt({ context: { regNumber: "1", subject: "s", jobId: null }, facts: { heightM: null, floors: null, mentions: { facade: true, roof: false, interior: false }, snippets: [] }, items: [{ id: "1", name: "Окраска фасада", quantity: 640, unit: "м2", norm: null, machines: null }] });
    expect(prompt).toContain("Только временные меры");
    expect(prompt).toContain("козырёк над сопряжением");
  });
});

describe("площадь лесов — по поверхности фасада (промпт)", () => {
  const prompt = buildImpliedWorksPrompt({
    context: { regNumber: "1", subject: "Ремонт фасада", jobId: null },
    facts: { heightM: 12, floors: 4, mentions: { facade: true, roof: false, interior: false }, snippets: [] },
    items: [
      { id: "2", name: "Расчистка поверхностей тяг", quantity: 18, unit: "м2", norm: null, machines: null },
      { id: "5", name: "Окраска фасада", quantity: 640, unit: "м2", norm: null, machines: null },
    ],
  });

  it("правило и пример: самая крупная позиция по стенам, а не мелкая", () => {
    expect(prompt).toContain("Леса считаются по поверхности фасада, а не по маленькой позиции");
    expect(prompt).toContain("самая крупная по площади позиция по стенам фасада");
    expect(prompt).toContain("max(#5, #6), объём 640 м2");
  });
});

