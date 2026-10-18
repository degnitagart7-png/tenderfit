import { describe, expect, it } from "vitest";

import type { ConsolidatedAnalysis, ContractFacts, DocumentConflict } from "@/domain/analysisConsolidation";
import {
  deepRiskCounts,
  analysisScorecard,
  clarificationDeadline,
  compactRub,
  cutLabel,
  daysUntil,
  nextSteps,
  priceCushion,
  shortDocName,
  splitVerdictReason,
  type ScorecardInput,
} from "@/domain/analysisDigest";
import type { MarginOutlook, MoneyOutlook } from "@/domain/moneyOutlook";
import type { ProfileCheck, ProfileMatch } from "@/domain/profileMatch";
import type { AnalysisFinding } from "@/types/database";

const NOW = new Date("2026-10-15T09:00:00Z");

describe("shortDocName", () => {
  it.each([
    ["print-form-0848300041226000311.html", "Извещение"],
    ["Извещение о проведении электронного аукциона.pdf", "Извещение"],
    ["Обоснование НМЦК.xlsx", "Обоснование НМЦК"],
    ["Обоснование начальной (максимальной) цены контракта.docx", "Обоснование НМЦК"],
    ["ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ.xlsx", "Смета"],
    ["ЛСР-1.xls", "Смета"],
    [
      "Приложение № 1 к Описанию объекта закупки (Техническому заданию) ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА).xlsx",
      "Смета (прил. к ТЗ)",
    ],
    ["Смета к техническому заданию.xlsx", "Смета (прил. к ТЗ)"],
    ["Проект контракта.docx", "Проект контракта"],
    ["Проект договора подряда.doc", "Проект контракта"],
    ["Договор.pdf", "Проект контракта"],
    ["Приложение 2 к контракту.docx", "Приложение к контракту"],
    ["Описание объекта закупки.docx", "Описание объекта (ТЗ)"],
    ["Техническое задание.docx", "Описание объекта (ТЗ)"],
    ["Приложение ТЗ.docx", "Описание объекта (ТЗ)"],
    ["Требования к заявке.docx", "Требования к заявке"],
    ["Требования к содержанию, составу заявки.pdf", "Требования к заявке"],
  ])("%s → %s", (name, expected) => {
    expect(shortDocName(name)).toBe(expected);
  });

  it("регистр не важен, «ТЗ» ищется отдельным словом", () => {
    expect(shortDocName("ПРОЕКТ КОНТРАКТА.DOCX")).toBe("Проект контракта");
    // «тз» внутри слова — не техническое задание.
    expect(shortDocName("Ситзавод.docx")).toBe("Ситзавод");
  });

  it("неизвестное имя — без расширения, длинное обрезано до 40 знаков с многоточием", () => {
    expect(shortDocName("График работ.docx")).toBe("График работ");
    const long = shortDocName(`${"Очень длинное название документа ".repeat(3)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
  });

  it("пустое имя — «документ»", () => {
    expect(shortDocName("")).toBe("документ");
    expect(shortDocName("   ")).toBe("документ");
    expect(shortDocName(".pdf")).toBe("документ");
  });
});

describe("clarificationDeadline и daysUntil", () => {
  it("срок запроса — за три дня до окончания подачи, дни считаются вверх", () => {
    const d = clarificationDeadline("2026-10-20T07:00:00Z", NOW)!;
    expect(d.date.toISOString()).toBe("2026-10-17T07:00:00.000Z");
    // От 15.10 09:00 до 17.10 07:00 — меньше двух суток: вверх до двух.
    expect(d.daysLeft).toBe(2);
    expect(d.passed).toBe(false);
  });

  it("срок прошёл — passed, а дней осталось 0, не меньше", () => {
    const d = clarificationDeadline("2026-10-16T07:00:00Z", NOW)!;
    expect(d.passed).toBe(true);
    expect(d.daysLeft).toBe(0);
  });

  it("нет даты или она битая — null", () => {
    expect(clarificationDeadline(null, NOW)).toBeNull();
    expect(clarificationDeadline("не дата", NOW)).toBeNull();
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil("мусор", NOW)).toBeNull();
  });

  it("daysUntil округляет вверх и не возвращает «-0»", () => {
    expect(daysUntil("2026-10-16T08:00:00Z", NOW)).toBe(1);
    expect(daysUntil("2026-10-15T10:00:00Z", NOW)).toBe(1);
    expect(daysUntil("2026-10-15T08:00:00Z", NOW)).toBe(0);
    expect(Object.is(daysUntil("2026-10-15T08:00:00Z", NOW), -0)).toBe(false);
    expect(daysUntil("2026-10-10T09:00:00Z", NOW)).toBe(-5);
  });
});

describe("compactRub и cutLabel", () => {
  it("тысячи, миллионы, миллиарды", () => {
    expect(compactRub(495_000)).toBe("495 тыс. ₽");
    expect(compactRub(1_234_567)).toBe("1,2 млн ₽");
    expect(compactRub(12_000_000)).toBe("12 млн ₽");
    expect(compactRub(250_400_000)).toBe("250 млн ₽");
    expect(compactRub(3_000_000_000)).toBe("3 млрд ₽");
    expect(compactRub(1_500)).toBe("1,5 тыс. ₽");
    expect(compactRub(850)).toBe("850 ₽");
  });

  it("на границе разряда не печатает «1000 тыс.»", () => {
    expect(compactRub(999_700)).toBe("1 млн ₽");
  });

  it("ноль и мусор — прочерк", () => {
    expect(compactRub(0)).toBe("—");
    expect(compactRub(Number.NaN)).toBe("—");
  });

  it("порог снижения — вниз до десятой, с запятой", () => {
    expect(cutLabel(0.199005)).toBe("−19,9 %");
    expect(cutLabel(0.069)).toBe("−6,9 %");
    expect(cutLabel(0.2)).toBe("−20,0 %");
  });
});

/** Запас: прибыль 103 261,12 и накладные 200 221,78 при базе 1 525 000 → без убытка до −19,9 %. */
const MARGIN: MarginOutlook = { profit: 103_261.12, overhead: 200_221.78, base: 1_525_000, scenarios: [] };

describe("priceCushion", () => {
  it("доли — как в computeMoneyOutlook: прибыль к базе и прибыль с накладными к базе", () => {
    const c = priceCushion(MARGIN)!;
    expect(c.profitShare).toBeCloseTo(103_261.12 / 1_525_000, 10);
    expect(c.breakEvenShare).toBeCloseTo(303_482.9 / 1_525_000, 10);
    expect(cutLabel(c.breakEvenShare)).toBe("−19,9 %");
    expect(cutLabel(c.profitShare)).toBe("−6,7 %");
  });

  it("нет сметы или база не положительна — null", () => {
    expect(priceCushion(null)).toBeNull();
    expect(priceCushion({ ...MARGIN, base: 0 })).toBeNull();
    expect(priceCushion({ ...MARGIN, base: -5 })).toBeNull();
  });
});

describe("splitVerdictReason", () => {
  it("делит по двоеточию и «;», убирает пустое и повторы", () => {
    expect(splitVerdictReason("Обнаружены риски: A; B;  ; C; A")).toEqual({
      lead: "Обнаружены риски",
      items: ["A", "B", "C"],
    });
  });

  it("без двоеточия — вся строка заголовком", () => {
    expect(splitVerdictReason("Нужна лицензия")).toEqual({ lead: "Нужна лицензия", items: [] });
    expect(splitVerdictReason("")).toEqual({ lead: "", items: [] });
  });

  it("двоеточие внутри пункта не делит пункт", () => {
    expect(splitVerdictReason("Риски: Срок: 10 дней; Пеня")).toEqual({ lead: "Риски", items: ["Срок: 10 дней", "Пеня"] });
  });
});

/* ------------------------------- Скоркарта ------------------------------- */

function finding(patch: Partial<AnalysisFinding>): AnalysisFinding {
  return {
    category: "risk",
    title: "Риск",
    detail: "",
    evidence_quote: "",
    evidence_section: "",
    severity: "medium",
    ...patch,
  };
}

function check(status: ProfileCheck["status"], title: string): ProfileCheck {
  return { finding: finding({ category: "requirement", title }), kind: "OTHER", status, reason: "" } as ProfileCheck;
}

function matchOf(checks: ProfileCheck[], verdict: ProfileMatch["verdict"] = "REVIEW"): ProfileMatch {
  return {
    verdict,
    headline: "",
    checks,
    met: checks.filter((c) => c.status === "MET").length,
    notMet: checks.filter((c) => c.status === "NOT_MET").length,
    toCheck: checks.filter((c) => c.status === "CHECK").length,
  };
}

const FACTS: ContractFacts = {
  work_start: null,
  work_end: "2026-11-30",
  warranty_months: null,
  bid_security_percent: null,
  contract_security_percent: null,
  warranty_security_percent: null,
  advance_percent: null,
  payment_days: null,
};

function consolidation(conflicts: number, facts: Partial<ContractFacts> = {}): ConsolidatedAnalysis {
  const conflict: DocumentConflict = { topic: "Срок", values: [], resolution: "", needs_question: true };
  return {
    kind: "consolidated",
    summary: "",
    findings: [],
    conflicts: Array.from({ length: conflicts }, () => conflict),
    questions: [],
    facts: { ...FACTS, ...facts },
  };
}

function outlook(patch: Partial<MoneyOutlook> = {}): MoneyOutlook {
  return {
    securities: [],
    frozenPeak: 495_000,
    advancePercent: 30,
    paymentDays: 15,
    margin: MARGIN,
    winter: null,
    ...patch,
  };
}

function input(patch: Partial<ScorecardInput> = {}): ScorecardInput {
  return {
    match: null,
    findings: [],
    consolidation: consolidation(0),
    documentsTotal: 4,
    documentsWithText: 4,
    documentsSkipped: 0,
    outlook: outlook(),
    price: 6_000_000,
    submissionEnd: "2026-10-25T07:00:00Z",
    now: NOW,
    ...patch,
  };
}

const card = (patch: Partial<ScorecardInput>, key: string) =>
  analysisScorecard(input(patch)).find((i) => i.key === key)!;

describe("analysisScorecard", () => {
  it("шесть направлений в заданном порядке с якорями секций", () => {
    const items = analysisScorecard(input());
    expect(items.map((i) => i.key)).toEqual(["access", "docs", "time", "money", "cushion", "contract"]);
    expect(items.map((i) => i.anchor)).toEqual([
      "analysis-access",
      "analysis-conflicts",
      "analysis-questions",
      "analysis-money",
      "analysis-money",
      "analysis-risks",
    ]);
  });

  describe("допуск", () => {
    it("профиля нет — нейтрально", () => {
      expect(card({ match: null }, "access")).toMatchObject({
        status: "neutral",
        value: "Профиль не заполнен",
        note: "Заполните — сверим требования",
      });
      expect(card({ match: matchOf([], "NO_PROFILE") }, "access").status).toBe("neutral");
    });

    it("есть невыполненное — bad, в заметке первое невыполненное", () => {
      const a = card({ match: matchOf([check("MET", "Лицензия"), check("CHECK", "Опыт"), check("NOT_MET", "СРО")]) }, "access");
      expect(a).toMatchObject({ status: "bad", value: "1 из 3 требований", note: "СРО" });
    });

    it("есть только «проверить» — warn", () => {
      const a = card({ match: matchOf([check("MET", "Лицензия"), check("CHECK", "Опыт")]) }, "access");
      expect(a).toMatchObject({ status: "warn", note: "Опыт" });
    });

    it("всё закрыто — good", () => {
      const a = card({ match: matchOf([check("MET", "Лицензия"), check("MET", "СРО")], "READY") }, "access");
      expect(a).toMatchObject({ status: "good", value: "2 из 2 требований", note: "Всё закрыто профилем" });
    });
  });

  describe("документация", () => {
    it("противоречия — warn и склонение", () => {
      expect(card({ consolidation: consolidation(1) }, "docs")).toMatchObject({
        status: "warn",
        value: "1 противоречие",
        note: "прочитано 4 из 4 файлов",
      });
      expect(card({ consolidation: consolidation(2) }, "docs").value).toBe("2 противоречия");
      expect(card({ consolidation: consolidation(6) }, "docs").value).toBe("6 противоречий");
    });

    it("противоречий нет, всё прочитано — good", () => {
      expect(card({}, "docs")).toMatchObject({ status: "good", value: "Противоречий нет" });
    });

    it("пропущенные файлы — warn даже без противоречий", () => {
      expect(card({ documentsSkipped: 2, documentsWithText: 2 }, "docs")).toMatchObject({
        status: "warn",
        note: "прочитано 2 из 4 файлов",
      });
    });

    it("сводки нет — нейтрально и счёт файлов", () => {
      expect(card({ consolidation: null, documentsWithText: 3 }, "docs")).toMatchObject({
        status: "neutral",
        value: "3 из 4 файлов прочитано",
      });
    });
  });

  describe("сроки", () => {
    it("подача с остатком дней, работы до даты — good", () => {
      expect(card({}, "time")).toMatchObject({
        status: "good",
        value: "Подача до 25.10 · 10 дн.",
        note: "работы до 30.11.2026",
      });
    });

    it("зима — warn и пометка в заметке", () => {
      const t = card({ outlook: outlook({ winter: { months: ["ноябрь"], included: null } }) }, "time");
      expect(t).toMatchObject({ status: "warn", note: "работы до 30.11.2026, зима" });
    });

    it("подача через три дня и меньше — warn", () => {
      expect(card({ submissionEnd: "2026-10-18T08:00:00Z" }, "time")).toMatchObject({ status: "warn", value: "Подача до 18.10 · 3 дн." });
      expect(card({ submissionEnd: "2026-10-17T07:00:00Z" }, "time").status).toBe("warn");
      // Четыре дня — ещё не «горит».
      expect(card({ submissionEnd: "2026-10-18T10:00:00Z" }, "time")).toMatchObject({ status: "good", value: "Подача до 18.10 · 4 дн." });
    });

    it("подача прошла — bad", () => {
      expect(card({ submissionEnd: "2026-10-10T07:00:00Z" }, "time").status).toBe("bad");
    });

    it("даты подачи нет — нейтрально", () => {
      expect(card({ submissionEnd: null }, "time")).toMatchObject({ status: "neutral" });
    });
  });

  describe("деньги", () => {
    it("аванс и оплата в заметке, мало заморожено — good", () => {
      expect(card({}, "money")).toMatchObject({
        status: "good",
        value: "Заморозится до 495 тыс. ₽",
        note: "аванс 30 % · оплата 15 дн.",
      });
    });

    it("аванса нет — warn", () => {
      expect(card({ outlook: outlook({ advancePercent: 0 }) }, "money")).toMatchObject({
        status: "warn",
        note: "аванса нет · оплата 15 дн.",
      });
    });

    it("заморожено больше десятой НМЦК — warn", () => {
      expect(card({ outlook: outlook({ frozenPeak: 1_200_000 }), price: 6_000_000 }, "money")).toMatchObject({
        status: "warn",
        value: "Заморозится до 1,2 млн ₽",
      });
    });

    it("данных нет — нейтрально", () => {
      expect(card({ outlook: null }, "money")).toMatchObject({ status: "neutral", value: "Нет данных об обеспечении" });
      expect(card({ outlook: outlook({ frozenPeak: null }) }, "money").status).toBe("neutral");
    });
  });

  describe("запас по цене", () => {
    it("пример из жизни: без убытка до −19,9 %, прибыль до −6,7 % — warn", () => {
      expect(card({}, "cushion")).toMatchObject({
        status: "warn",
        value: "без убытка до −19,9 %",
        note: "прибыль сохраняется до −6,7 %",
      });
    });

    it("порог меньше 10 % — bad, от 20 % — good", () => {
      const margin = (share: number): MarginOutlook => ({ profit: share * 1000 * 0.4, overhead: share * 1000 * 0.6, base: 1000, scenarios: [] });
      expect(card({ outlook: outlook({ margin: margin(0.09) }) }, "cushion").status).toBe("bad");
      expect(card({ outlook: outlook({ margin: margin(0.1) }) }, "cushion").status).toBe("warn");
      expect(card({ outlook: outlook({ margin: margin(0.2) }) }, "cushion").status).toBe("good");
    });

    it("сметы нет — нейтрально", () => {
      expect(card({ outlook: outlook({ margin: null }) }, "cushion")).toMatchObject({
        status: "neutral",
        value: "Нет сметы заказчика",
        note: "запас при снижении не посчитать",
      });
      expect(card({ outlook: null }, "cushion").status).toBe("neutral");
    });
  });

  describe("договор", () => {
    const risks = (high: number, other = 0): AnalysisFinding[] => [
      ...Array.from({ length: high }, () => finding({ severity: "high" })),
      ...Array.from({ length: other }, () => finding({ severity: "medium" })),
      finding({ category: "requirement", severity: "high" }),
    ];

    it("высоких нет — good", () => {
      expect(card({ findings: risks(0, 3) }, "contract")).toMatchObject({ status: "good", value: "3 риска", note: "высоких нет" });
    });

    it("от одного высокого — warn, от пяти — bad", () => {
      expect(card({ findings: risks(1, 4) }, "contract")).toMatchObject({ status: "warn", value: "5 рисков", note: "высоких 1" });
      expect(card({ findings: risks(4) }, "contract").status).toBe("warn");
      expect(card({ findings: risks(5) }, "contract").status).toBe("bad");
    });

    it("считает только риски, не требования", () => {
      expect(card({ findings: risks(0, 1) }, "contract").value).toBe("1 риск");
      expect(card({ findings: [] }, "contract").value).toBe("0 рисков");
    });
  });
});

describe("nextSteps", () => {
  const scorecard = (match: ProfileMatch | null) => analysisScorecard(input({ match }));
  const base = {
    questionsCount: 6,
    clarifyBy: clarificationDeadline("2026-10-25T07:00:00Z", NOW),
    submissionEnd: "2026-10-25T07:00:00Z",
    scorecard: scorecard(null),
    now: NOW,
  };

  it("вопросы с датой и подача с остатком дней", () => {
    expect(nextSteps(base)).toEqual([
      { key: "ask", label: "Задать 6 вопросов заказчику до 22.10", tone: "neutral", anchor: "analysis-questions" },
      { key: "submit", label: "Подать заявку до 25.10 · осталось 10 дн.", tone: "neutral", anchor: null },
    ]);
  });

  it("срок запроса горит — шаг красный; прошёл — шага нет", () => {
    const burning = nextSteps({ ...base, questionsCount: 1, clarifyBy: clarificationDeadline("2026-10-19T07:00:00Z", NOW) });
    expect(burning[0]).toMatchObject({ label: "Задать 1 вопрос заказчику до 16.10", tone: "brick" });
    const passed = nextSteps({ ...base, clarifyBy: clarificationDeadline("2026-10-16T07:00:00Z", NOW) });
    expect(passed.map((s) => s.key)).toEqual(["submit"]);
  });

  it("вопросов нет — шага нет; даты нет — вопросы без даты", () => {
    expect(nextSteps({ ...base, questionsCount: 0 }).map((s) => s.key)).toEqual(["submit"]);
    const noDate = nextSteps({ ...base, clarifyBy: null, submissionEnd: null });
    expect(noDate).toEqual([{ key: "ask", label: "Задать 6 вопросов заказчику", tone: "neutral", anchor: "analysis-questions" }]);
  });

  it("подача прошла — красный шаг вместо «подать»", () => {
    const steps = nextSteps({ ...base, questionsCount: 0, submissionEnd: "2026-10-10T07:00:00Z" });
    expect(steps).toEqual([{ key: "submit", label: "Срок подачи заявок прошёл", tone: "brick", anchor: null }]);
  });

  it("допуск закрыт не полностью — шаг «закрыть требование» с названием", () => {
    const steps = nextSteps({ ...base, scorecard: scorecard(matchOf([check("NOT_MET", "Членство в СРО")])) });
    expect(steps.at(-1)).toEqual({
      key: "requirement",
      label: "Закрыть требование: Членство в СРО",
      tone: "neutral",
      anchor: "analysis-access",
    });
  });
});

describe("deepRiskCounts", () => {
  it("считает риски договора только по законченному разбору", () => {
    const findings = [
      { category: "risk" as const, severity: "high" as const },
      { category: "risk" as const, severity: "medium" as const },
      { category: "requirement" as const, severity: "high" as const },
    ];
    expect(deepRiskCounts({ state: "completed", findings })).toEqual({ total: 2, high: 1 });
    expect(deepRiskCounts({ state: "analyzing", findings })).toBeNull();
    expect(deepRiskCounts(null)).toBeNull();
  });
});
