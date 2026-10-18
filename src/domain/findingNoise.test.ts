import { describe, expect, it } from "vitest";
import {
  assessFinding,
  classifyFinding,
  filterFindingNoise,
  isPureNoiseNeutral,
  mergeStandardTopics,
  paymentTermDays,
  standardLineText,
} from "@/domain/findingNoise";
import type { AnalysisFinding } from "@/types/database";

function finding(patch: Partial<AnalysisFinding>): AnalysisFinding {
  return {
    category: "risk",
    title: "Риск",
    detail: "",
    evidence_quote: "",
    evidence_section: "Проект контракта",
    severity: "medium",
    ...patch,
  };
}

describe("classifyFinding: DROP — типовое, не находка ни при каком законе", () => {
  const boilerplate: [string, Partial<AnalysisFinding>][] = [
    ["РНП", { category: "blocker", severity: "high", title: "Отсутствие в реестре недобросовестных поставщиков" }],
    ["приостановление деятельности", { category: "blocker", title: "Отсутствие приостановления деятельности" }],
    ["иноагент", { category: "blocker", title: "Отсутствие статуса иностранного агента" }],
    ["офшор", { category: "blocker", title: "Отсутствие офшорных компаний" }],
    ["коррупция", { category: "blocker", title: "Отсутствие административной ответственности за коррупцию" }],
    ["недоимки", { category: "requirement", title: "Отсутствие недоимки по налогам" }],
    ["единые требования", { category: "requirement", title: "Единые требования к участникам" }],
    ["ч. 1.1 ст. 31", { category: "requirement", title: "Требования по ч. 1.1 ст. 31" }],
    ["согласие", { category: "requirement", title: "Согласие с условиями закупки" }],
    ["крупная сделка", { category: "requirement", title: "Решение о крупной сделке" }],
    ["антимонопольная", { severity: "high", title: "Ответственность за антимонопольные нарушения" }],
    ["административная и уголовная", { title: "Административная и уголовная ответственность за нарушения" }],
    ["НДС", { severity: "high", title: "НДС 22%" }],
    ["все расходы", { title: "Включение всех расходов в НМЦК" }],
    ["реквизиты", { category: "requirement", title: "Реквизиты счета для оплаты" }],
    ["валюта", { category: "neutral", title: "Валюта расчетов" }],
    ["контакты", { category: "neutral", title: "Контактное лицо" }],
    ["площадка", { category: "neutral", title: "Электронная площадка" }],
    ["итоги", { category: "neutral", title: "Дата подведения итогов" }],
    ["финансирование", { category: "neutral", title: "Источник финансирования" }],
    ["способ", { category: "neutral", title: "Способ определения поставщика" }],
    ["срок подачи", { category: "neutral", title: "Срок подачи заявок" }],
    ["предмет", { category: "neutral", title: "Предмет закупки" }],
    ["заказчик", { category: "neutral", title: "Заказчик" }],
    ["НМЦК", { category: "neutral", title: "НМЦК" }],
    ["место", { category: "neutral", title: "Место выполнения работ" }],
  ];

  it.each(boilerplate)("%s — drop при 44-ФЗ, 223-ФЗ и коммерческой", (_name, patch) => {
    for (const law of ["FZ_44", "FZ_223", "COMMERCIAL"] as const) {
      expect(classifyFinding(finding(patch), law)).toBe("drop");
    }
  });

  it("настоящий блокер с лицензией не теряется, даже если рядом РНП", () => {
    const f = finding({
      category: "blocker",
      title: "Лицензия МЧС; отсутствие в реестре недобросовестных поставщиков",
    });
    expect(classifyFinding(f, "FZ_44")).toBe("keep");
  });

  it("«ликвидация последствий аварии» — это работа, а не состояние участника", () => {
    expect(classifyFinding(finding({ category: "requirement", title: "Ликвидация последствий аварии в течение суток" }), "FZ_44")).toBe(
      "keep",
    );
  });

  it("требования к телефонной связи не принимаются за контактные данные", () => {
    expect(classifyFinding(finding({ category: "requirement", title: "Диспетчерская телефонная связь" }), "FZ_44")).toBe("keep");
  });

  it("служебное neutral отличается от сведений, нужных блокам фактов", () => {
    expect(isPureNoiseNeutral(finding({ category: "neutral", title: "Контактное лицо" }))).toBe(true);
    expect(isPureNoiseNeutral(finding({ category: "neutral", title: "Место выполнения работ" }))).toBe(false);
    expect(isPureNoiseNeutral(finding({ category: "neutral", title: "НДС 22%" }))).toBe(false);
  });
});

describe("classifyFinding: STANDARD — типовое для 44-ФЗ", () => {
  const standard44: [string, Partial<AnalysisFinding>][] = [
    ["односторонний отказ", { title: "Возможность одностороннего отказа заказчика", evidence_quote: "Заказчик вправе принять решение об одностороннем отказе от исполнения контракта в порядке ст. 95 44-ФЗ." }],
    ["пени без ставки", { title: "Пеня за просрочку исполнения обязательств" }],
    ["пени 1/300", { title: "Пени за просрочку", evidence_quote: "пени в размере одной трехсотой ключевой ставки Банка России за каждый день просрочки" }],
    ["штрафы", { title: "Штрафы за неисполнение", evidence_quote: "штраф в размере 10 процентов цены контракта" }],
    ["удержание неустоек", { title: "Удержание неустоек из оплаты" }],
    ["казначейское сопровождение", { severity: "high", title: "Казначейское сопровождение аванса" }],
    ["обеспечение заявки", { category: "requirement", title: "Обеспечение заявки", evidence_quote: "Размер обеспечения заявки 1 % НМЦК" }],
    ["обеспечение исполнения", { category: "requirement", title: "Обеспечение исполнения контракта", evidence_quote: "в размере 5 % от НМЦК" }],
    ["гарантийное обеспечение", { category: "requirement", title: "Обеспечение гарантийных обязательств", evidence_quote: "5 процентов цены контракта" }],
    ["способ обеспечения", { category: "requirement", title: "Способ обеспечения исполнения контракта" }],
    ["оплата 7 раб. дней", { category: "neutral", title: "Срок оплаты", evidence_quote: "Оплата в течение 7 (семи) рабочих дней с даты подписания акта" }],
    ["оплата 10 раб. дней", { category: "neutral", title: "Срок оплаты", evidence_quote: "оплата не более 10 рабочих дней с даты приемки" }],
  ];

  it.each(standard44)("%s — standard при 44-ФЗ", (_name, patch) => {
    expect(classifyFinding(finding(patch), "FZ_44")).toBe("standard");
  });

  it("для 223-ФЗ те же условия остаются обычными находками", () => {
    for (const [, patch] of standard44) {
      expect(classifyFinding(finding(patch), "FZ_223")).toBe("keep");
    }
  });

  it("для коммерческой закупки и неизвестного закона казначейство и отказ — тоже находки", () => {
    const treasury = finding({ title: "Казначейское сопровождение аванса" });
    expect(classifyFinding(treasury, "COMMERCIAL")).toBe("keep");
    expect(classifyFinding(treasury, null)).toBe("keep");
    expect(classifyFinding(treasury, undefined)).toBe("keep");
  });
});

describe("classifyFinding: KEEP — отклонения от нормы", () => {
  it("оплата 30 рабочих дней по 44-ФЗ — нарушение, пояснение про жалобу в ФАС и подъём до риска", () => {
    const f = finding({
      category: "requirement",
      severity: "low",
      title: "Оплата в течение 30 рабочих дней",
      evidence_quote: "Заказчик оплачивает работы в течение 30 рабочих дней с даты подписания акта",
    });
    const verdict = assessFinding(f, "FZ_44");
    expect(verdict.class).toBe("keep");
    expect(verdict.deviation).toMatch(/ФАС/);
    expect(verdict.deviation).toMatch(/ч\. 13\.1 ст\. 34/);

    const { kept, standardLine } = filterFindingNoise([f], "FZ_44");
    expect(kept).toHaveLength(1);
    expect(kept[0]!.category).toBe("risk");
    expect(kept[0]!.severity).toBe("high");
    expect(kept[0]!.legal_note).toMatch(/жалобу в ФАС/);
    expect(standardLine).toBeNull();
  });

  it("оплата 30 календарных дней по 44-ФЗ — тоже отклонение, по 223-ФЗ — обычная находка", () => {
    const f = finding({ category: "neutral", title: "Срок оплаты 30 календарных дней", evidence_quote: "оплата в течение 30 календарных дней" });
    expect(assessFinding(f, "FZ_44").deviation).not.toBeNull();
    expect(assessFinding(f, "FZ_223").deviation).toBeNull();
  });

  it("срок оплаты в цитате берётся рядом со словом «оплата», а не срок приёмки", () => {
    expect(paymentTermDays("Приемка в течение 5 рабочих дней. Оплата в течение 30 рабочих дней")).toEqual({
      days: 30,
      unit: "working",
    });
  });

  it("неустойка 0,5 % за каждый день — выше нормы, находка с пояснением", () => {
    const f = finding({
      title: "Пеня за просрочку",
      evidence_quote: "неустойка в размере 0,5 % от цены контракта за каждый день просрочки",
    });
    const verdict = assessFinding(f, "FZ_44");
    expect(verdict.class).toBe("keep");
    expect(verdict.deviation).toMatch(/1\/300/);
    const { kept } = filterFindingNoise([f], "FZ_44");
    expect(kept[0]!.severity).toBe("high");
  });

  it("штраф 20 % цены контракта — выше предела ПП № 1042", () => {
    const f = finding({ title: "Штраф за неисполнение", evidence_quote: "штраф в размере 20 % цены контракта" });
    expect(assessFinding(f, "FZ_44").deviation).toMatch(/1042/);
  });

  it("гарантия 60 месяцев — остаётся находкой", () => {
    const f = finding({ category: "requirement", title: "Гарантия 60 месяцев", evidence_quote: "гарантийный срок 60 месяцев" });
    expect(classifyFinding(f, "FZ_44")).toBe("keep");
  });

  it("обеспечение исполнения 40 % без аванса — выше предела 30 % по 44-ФЗ", () => {
    const f = finding({ category: "requirement", title: "Обеспечение исполнения контракта", evidence_quote: "в размере 40 % НМЦК" });
    const verdict = assessFinding(f, "FZ_44");
    expect(verdict.class).toBe("keep");
    expect(verdict.deviation).toMatch(/30 %/);
    // Нарушение закона показывается риском; блок «Деньги» берёт числа из allFindings, где категория прежняя.
    const { kept } = filterFindingNoise([f], "FZ_44");
    expect(kept[0]!.category).toBe("risk");
    expect(kept[0]!.severity).toBe("high");
    expect(f.category).toBe("requirement");
  });

  it("обеспечение заявки 7 % — выше 5 %", () => {
    const f = finding({ category: "requirement", title: "Обеспечение заявки", evidence_quote: "Размер обеспечения заявки — 7 % НМЦК" });
    expect(assessFinding(f, "FZ_44").deviation).toMatch(/ч\. 14 ст\. 44/);
  });

  it("обеспечение гарантийных обязательств 15 % — выше 10 %", () => {
    const f = finding({ category: "requirement", title: "Обеспечение гарантийных обязательств", evidence_quote: "15 % цены контракта" });
    expect(classifyFinding(f, "FZ_44")).toBe("keep");
  });

  it("односторонний отказ «в любое время и без объяснения причин» — сверх закона", () => {
    const f = finding({
      title: "Право заказчика на односторонний отказ",
      evidence_quote: "Заказчик вправе в любое время отказаться от контракта в одностороннем порядке без объяснения причин",
    });
    const verdict = assessFinding(f, "FZ_44");
    expect(verdict.class).toBe("keep");
    expect(verdict.deviation).toMatch(/ч\. 9 ст\. 95/);
  });

  it("зимние работы, аванс, СРО, опыт и прочее неопознанное остаётся", () => {
    for (const title of ["Работы в зимний период", "Нет аванса", "Членство в СРО", "Опыт по ПП № 2571", "Материалы заказчика"]) {
      expect(classifyFinding(finding({ category: "requirement", title }), "FZ_44")).toBe("keep");
    }
  });
});

describe("filterFindingNoise: строка «типовые условия»", () => {
  const set = [
    finding({ title: "Возможность одностороннего отказа заказчика" }),
    finding({ title: "Пеня за просрочку исполнения обязательств" }),
    finding({ title: "Удержание неустоек из оплаты" }),
    finding({ title: "Казначейское сопровождение аванса", severity: "high" }),
    finding({ category: "requirement", title: "Обеспечение заявки" }),
    finding({ category: "blocker", severity: "high", title: "Отсутствие в реестре недобросовестных поставщиков" }),
    finding({ title: "Работы в зимний период" }),
  ];

  it("44-ФЗ: типовое схлопнуто в одну строку, остальное остаётся", () => {
    const out = filterFindingNoise(set, "FZ_44");
    expect(out.kept.map((f) => f.title)).toEqual(["Работы в зимний период"]);
    expect(out.dropped).toHaveLength(1);
    expect(out.standard).toHaveLength(5);
    expect(out.standardLine).toBe(
      "Типовые условия 44-ФЗ без отклонений: односторонний отказ заказчика (ч. 9 ст. 95), пени и штрафы по ПП № 1042, удержание неустойки из оплаты, казначейское сопровождение аванса, обеспечение в пределах закона.",
    );
  });

  it("223-ФЗ: строки нет, типовые риски остаются, РНП убран", () => {
    const out = filterFindingNoise(set, "FZ_223");
    expect(out.standardLine).toBeNull();
    expect(out.kept).toHaveLength(6);
    expect(out.dropped).toHaveLength(1);
  });

  it("тема с отклонением не попадает в строку «без отклонений»", () => {
    const out = filterFindingNoise(
      [
        finding({ title: "Пеня за просрочку исполнения обязательств" }),
        finding({ title: "Неустойка 0,5 % за каждый день", evidence_quote: "0,5 % за каждый день просрочки" }),
        finding({ title: "Казначейское сопровождение" }),
      ],
      "FZ_44",
    );
    expect(out.standardLine).toBe("Типовые условия 44-ФЗ без отклонений: казначейское сопровождение аванса.");
  });

  it("повторный прогон не дублирует пояснение", () => {
    const f = finding({ category: "neutral", title: "Срок оплаты", evidence_quote: "оплата в течение 30 рабочих дней" });
    const once = filterFindingNoise([f], "FZ_44").kept;
    const twice = filterFindingNoise(once, "FZ_44").kept;
    expect(twice[0]!.legal_note).toBe(once[0]!.legal_note);
  });

  it("не меняет входные объекты", () => {
    const f = finding({ category: "neutral", title: "Срок оплаты", evidence_quote: "оплата в течение 30 рабочих дней" });
    filterFindingNoise([f], "FZ_44");
    expect(f.category).toBe("neutral");
  });

  it("темы собираются из нескольких списков: сводка и разборы документов", () => {
    const consolidated = filterFindingNoise([finding({ title: "Работы в зимний период" })], "FZ_44");
    const perDocument = filterFindingNoise([finding({ title: "Казначейское сопровождение" })], "FZ_44");
    const merged = mergeStandardTopics([consolidated, perDocument], "FZ_44");
    expect(merged.topics).toEqual(["TREASURY"]);
    expect(merged.line).toMatch(/казначейское/);
    expect(mergeStandardTopics([perDocument], "FZ_223").line).toBeNull();
  });

  it("пустой набор тем — строки нет", () => {
    expect(standardLineText([])).toBeNull();
  });
});

describe("classifyFinding: нормы ГК и 44-ФЗ из сохранённых разборов (замер 14.10.2026)", () => {
  const standardFor44: [string, Partial<AnalysisFinding>][] = [
    ["твёрдая цена", { title: "Твердая цена контракта без пересмотра" }],
    ["антидемпинг", { title: "Антидемпинг: снижение цены на 25% и более" }],
    ["электронная приёмка", { title: "Электронная приемка через АИС «Портал поставщиков» и ЕИС" }],
    ["риск гибели", { title: "Риск случайной гибели или повреждения результата работ" }],
    ["субподрядчики", { title: "Ответственность за субподрядчиков" }],
    ["дефекты за свой счёт", { title: "Устранение дефектов за 30 дней за свой счёт" }],
    ["гарантия 3 года", { title: "Гарантийный срок на работы", detail: "Гарантия 36 месяцев с даты приёмки" }],
  ];
  it.each(standardFor44)("%s — типовое по 44-ФЗ", (_name, patch) => {
    expect(classifyFinding(finding(patch), "FZ_44")).toBe("standard");
  });
  it.each(standardFor44)("%s — по 223-ФЗ остаётся находкой", (_name, patch) => {
    expect(classifyFinding(finding(patch), "FZ_223")).toBe("keep");
  });

  it("гарантия 5 лет и больше — отклонение, остаётся", () => {
    expect(classifyFinding(finding({ title: "Гарантийный срок 5 лет" }), "FZ_44")).toBe("keep");
  });
  it("устранение дефектов за 3 дня — жёстко, остаётся", () => {
    expect(classifyFinding(finding({ title: "Устранение дефектов за 3 рабочих дня" }), "FZ_44")).toBe("keep");
  });
  it("твёрдая цена без учёта инфляции — остаётся", () => {
    expect(classifyFinding(finding({ title: "Твёрдая цена без индексации на инфляцию" }), "FZ_44")).toBe("keep");
  });

  it.each([
    ["аккредитация", { category: "blocker" as const, title: "Аккредитация на электронной площадке и регистрация в ЕИС" }],
    ["правомочность", { category: "blocker" as const, title: "Правомочность заключать договор" }],
    ["уклонение", { title: "Уклонение от заключения контракта" }],
    ["недостоверные сведения", { title: "Ответственность за недостоверность сведений в заявке" }],
    ["победитель", { category: "neutral" as const, title: "Победитель аукциона" }],
    ["метод НМЦК", { category: "neutral" as const, title: "Метод определения НМЦК" }],
  ])("%s — не находка ни при каком законе", (_name, patch) => {
    expect(classifyFinding(finding(patch), "FZ_44")).toBe("drop");
    expect(classifyFinding(finding(patch), "FZ_223")).toBe("drop");
  });

  it("строка типовых условий называет новые темы", () => {
    const { standardLine } = filterFindingNoise(
      [finding({ title: "Твердая цена контракта" }), finding({ title: "Антидемпинговые меры" })],
      "FZ_44",
    );
    expect(standardLine).toBe("Типовые условия 44-ФЗ без отклонений: твёрдая цена (ч. 2 ст. 34), антидемпинговые меры (ст. 37).");
  });
});
