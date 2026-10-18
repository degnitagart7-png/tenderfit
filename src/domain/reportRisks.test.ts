import { describe, expect, it } from "vitest";
import {
  cleanRisks,
  estimateFactLines,
  isEstimateFact,
  isFastPayment,
  otherFactLines,
  paymentTermOf,
  riskAction,
  riskTopic,
  routeNeutral,
} from "@/domain/reportRisks";
import type { AnalysisFinding } from "@/types/database";

const NOW = new Date("2026-10-07T19:11:00Z");

function risk(patch: Partial<AnalysisFinding>): AnalysisFinding {
  return {
    category: "risk",
    title: "Риск",
    detail: "Пояснение.",
    evidence_quote: "цитата",
    evidence_section: "5. Проект контракта",
    severity: "medium",
    ...patch,
  };
}

describe("isEstimateFact: сметные сведения — не риски договора", () => {
  it.each([
    ["НДС 22%", "НДС - 22%", "Контракт"],
    ["Индекс прогнозной инфляции", "Индекс инфляции И=1,0045", "Контракт"],
    ["Индекс-дефлятор и инфляция", "применён индекс, учитывающий инфляцию", "Контракт"],
    ["Непредвиденные затраты", "2%", "Контракт"],
    ["Повышающий коэффициент", "коэффициент 1,15", "Контракт"],
    ["Стоимость", "сметная стоимость 100 ₽", "Контракт"],
  ])("«%s» — по заголовку или цитате", (title, quote, section) => {
    expect(isEstimateFact(risk({ title, evidence_quote: quote, evidence_section: section }))).toBe(true);
  });

  it.each(["Смета", "ССРСС по объекту", "ЛСР № 1", "НМЦК_Возрождения", "Обоснование НМЦК.doc"])(
    "раздел или файл «%s» — тоже смета",
    (section) => {
      expect(isEstimateFact(risk({ evidence_section: section }))).toBe(true);
    },
  );

  it("настоящий риск договора смету не задевает", () => {
    expect(isEstimateFact(risk({ title: "Односторонний отказ заказчика", evidence_section: "8. Расторжение" }))).toBe(false);
    // «ндс» внутри слова не считается НДС.
    expect(isEstimateFact(risk({ title: "Нарушение стандартов", evidence_quote: "по стандартам" }))).toBe(false);
  });
});

describe("cleanRisks", () => {
  it("сметные сведения уходят в «Смету», а не пропадают", () => {
    const result = cleanRisks(
      [
        risk({ title: "НДС 22%", evidence_quote: "НДС - 22%", severity: "low" }),
        risk({ title: "Штраф 1%", evidence_quote: "штраф 1 процент", severity: "medium" }),
      ],
      NOW,
    );
    expect(result.estimate.map((f) => f.title)).toEqual(["НДС 22%"]);
    expect(result.rows.map((r) => r.finding.title)).toEqual(["Штраф 1%"]);
  });

  it("«односторонн…отказ» дважды — одна строка с наибольшей важностью и обоими источниками", () => {
    const result = cleanRisks(
      [
        risk({ title: "Односторонний отказ заказчика", severity: "medium", evidence_section: "Условия контрактов" }),
        risk({ title: "Право Заказчика на односторонний отказ от Контракта", severity: "high", evidence_section: "8. Расторжение" }),
        risk({ title: "Расторжение контракта в одностороннем порядке", severity: "low", evidence_section: "Приложение" }),
      ],
      NOW,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.finding.severity).toBe("high");
    expect(result.rows[0]!.finding.title).toBe("Право Заказчика на односторонний отказ от Контракта");
    expect(result.rows[0]!.sources).toEqual(["8. Расторжение", "Условия контрактов", "Приложение"]);
    expect(result.low).toHaveLength(0);
  });

  it("одинаково названные штрафы с разными числами — разные условия, не склеиваются", () => {
    const result = cleanRisks(
      [
        risk({
          title: "Штраф за неисполнение обязательств Подрядчиком",
          evidence_quote: "штраф в размере 1 процента цены Контракта",
          severity: "medium",
        }),
        risk({
          title: "Штраф за неисполнение обязательств Подрядчиком",
          evidence_quote: "штраф в размере 1 000 рублей",
          severity: "low",
        }),
      ],
      NOW,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.low).toHaveLength(1);
  });

  it("близкие по теме штрафы с разными числами остаются двумя", () => {
    const result = cleanRisks(
      [
        risk({
          title: "Штраф за ненадлежащее исполнение обязательств Подрядчиком",
          evidence_quote: "штраф в размере 1 процента цены Контракта",
          severity: "medium",
        }),
        risk({
          title: "Штраф за неисполнение обязательств, не имеющих стоимостного выражения",
          evidence_quote: "штраф в размере 1 000 рублей",
          severity: "low",
        }),
      ],
      NOW,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.low).toHaveLength(1);
  });

  it("тот же штраф из двух документов (общие слова, то же число) — одна строка", () => {
    const result = cleanRisks(
      [
        risk({
          title: "Штраф за неисполнение обязательств Подрядчиком",
          evidence_quote: "штраф 1 процент цены",
          evidence_section: "Проект контракта",
        }),
        risk({
          title: "Штраф за ненадлежащее неисполнение обязательств подрядчика",
          evidence_quote: "штраф устанавливается в размере 1 процента цены",
          evidence_section: "Документация",
        }),
      ],
      NOW,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.sources).toHaveLength(2);
  });

  describe("«длительный срок оплаты»", () => {
    const payment = (quote: string) =>
      risk({ title: "Длительный срок оплаты", evidence_quote: quote, severity: "low" });

    it.each([
      "Оплата в течение 7 рабочих дней с даты подписания акта",
      "Оплата в течение 10 рабочих дней",
      "оплата в течение 15 календарных дней",
      "в течение 5 (пяти) рабочих дней",
    ])("«%s» — не риск, убирается", (quote) => {
      const result = cleanRisks([payment(quote)], NOW);
      expect(result.rows).toHaveLength(0);
      expect(result.low).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
    });

    it.each([
      "Оплата в течение 11 рабочих дней",
      "оплата в течение 16 календарных дней",
      "оплата в течение 30 календарных дней",
      "оплата по факту финансирования",
    ])("«%s» — остаётся", (quote) => {
      const result = cleanRisks([payment(quote)], NOW);
      expect(result.low).toHaveLength(1);
      expect(result.dropped).toHaveLength(0);
    });
  });

  describe("«длительный срок выполнения»", () => {
    const execution = (quote: string) =>
      risk({ title: "Длительный срок выполнения работ", evidence_quote: quote, severity: "medium" });

    it("до конца работ 54 дня — не длительный, а сжатый: риск убирается", () => {
      const result = cleanRisks([execution("Срок выполнения работы: по 30 ноября 2026 г.")], NOW);
      expect(result.rows).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
    });

    it("граница: 119 дней — убирается, 120 — остаётся", () => {
      // 7 октября 2026, 22:11 МСК + 119 дней = 3 февраля 2027; +120 = 4 февраля.
      expect(cleanRisks([execution("работы по 3 февраля 2027 года")], NOW).rows).toHaveLength(0);
      expect(cleanRisks([execution("работы по 5 февраля 2027 года")], NOW).rows).toHaveLength(1);
    });

    it("срок больше 120 дней или даты в цитате нет — риск остаётся", () => {
      expect(cleanRisks([execution("до 31 декабря 2027 г.")], NOW).rows).toHaveLength(1);
      expect(cleanRisks([execution("срок выполнения 12 месяцев")], NOW).rows).toHaveLength(1);
    });
  });

  it("высокие и средние — строками, низкие — отдельно, самые важные первыми", () => {
    const result = cleanRisks(
      [
        risk({ title: "Пеня 0,1%", severity: "low" }),
        risk({ title: "Приёмка работ", severity: "medium" }),
        risk({ title: "Субподряд запрещён", severity: "high" }),
      ],
      NOW,
    );
    expect(result.rows.map((r) => r.finding.title)).toEqual(["Субподряд запрещён", "Приёмка работ"]);
    expect(result.low.map((f) => f.title)).toEqual(["Пеня 0,1%"]);
  });

  it("находки других категорий в риски не попадают", () => {
    expect(cleanRisks([risk({ category: "requirement" })], NOW).rows).toHaveLength(0);
  });
});

describe("срок оплаты", () => {
  it("рабочие и календарные дни различаются", () => {
    expect(paymentTermOf("в течение 7 рабочих дней")).toEqual({ days: 7, working: true });
    expect(paymentTermOf("в течение 15 календарных дней")).toEqual({ days: 15, working: false });
    expect(paymentTermOf("оплата по факту")).toBeNull();
  });

  it("быстро: до 10 рабочих или 15 календарных", () => {
    expect(isFastPayment({ days: 10, working: true })).toBe(true);
    expect(isFastPayment({ days: 11, working: true })).toBe(false);
    expect(isFastPayment({ days: 15, working: false })).toBe(true);
    expect(isFastPayment({ days: 16, working: false })).toBe(false);
  });
});

describe("riskAction: что делать по теме риска", () => {
  const ctx = { nmc: 2_032_153.32 };

  it("расторжение — запас в графике по наименьшему сроку из цитаты", () => {
    const action = riskAction(
      risk({
        title: "Односторонний отказ заказчика",
        evidence_quote: "срок начала на срок не менее 10 календарных дней; выполнения не менее 5 календарных дней",
        severity: "high",
      }),
      ctx,
    );
    expect(action.text).toBe(
      "Заложите в график запас: при просрочке уже на 5 календарных дней заказчик вправе расторгнуть контракт и потребовать убытки.",
    );
    expect(action.tone).toBe("bad");
  });

  it("склонение: 1 календарный день, 2 календарных дня", () => {
    const one = riskAction(
      risk({ title: "Расторжение контракта", evidence_quote: "не менее 1 календарного дня" }),
      ctx,
    );
    expect(one.text).toMatch(/на 1 календарный день/);
    const two = riskAction(
      risk({ title: "Расторжение контракта", evidence_quote: "не менее 2 рабочих дней" }),
      ctx,
    );
    expect(two.text).toMatch(/на 2 рабочих дня/);
  });

  it("пени 1/300 — в резерв цены", () => {
    expect(
      riskAction(risk({ title: "Пеня за просрочку", evidence_quote: "в размере одной трехсотой ключевой ставки" }), ctx).text,
    ).toMatch(/Учтите пени 1\/300 ключевой ставки в день в резерве цены/);
  });

  it("штраф в процентах пересчитан в рубли по НМЦК", () => {
    const text = riskAction(
      risk({ title: "Штраф за неисполнение", evidence_quote: "штраф 1 процента цены Контракта" }),
      ctx,
    ).text.replace(/\s/g, " ");
    expect(text).toContain("Штраф 1 % цены контракта за каждое нарушение (≈ 20 321,53 ₽");
  });

  it("без числа и без темы — «Прочитайте пункт перед подачей»", () => {
    expect(riskAction(risk({ title: "Особое условие" }), ctx).text).toMatch(/^Прочитайте пункт перед подачей/);
    expect(riskAction(risk({ title: "Приёмка", detail: "" }), ctx).text).toMatch(/приёмки/);
  });

  it("темы определяются по заголовку, а не по пояснению", () => {
    expect(riskTopic(risk({ title: "Неустойка 0,5 % за день просрочки" }))).toBe("PENALTY");
    expect(riskTopic(risk({ title: "Гарантийный срок 5 лет" }))).toBe("WARRANTY");
    expect(riskTopic(risk({ title: "Казначейское сопровождение" }))).toBe("TREASURY");
    expect(riskTopic(risk({ title: "Особое условие", detail: "расторжение контракта" }))).toBeNull();
  });
});

describe("нейтральные находки: куда идут", () => {
  const neutral = (title: string, detail = ""): AnalysisFinding => ({
    category: "neutral",
    title,
    detail,
    evidence_quote: "",
    evidence_section: "",
    severity: "low",
  });
  const SUBJECT = "Выполнение работ по ремонту теплоизоляции фасада ул. Возрождения, дом 46";

  it("место и адрес — в шапку, без вводных слов", () => {
    const routed = routeNeutral(
      [neutral("Место выполнения работ", "Работы будут выполняться по адресу: Иркутская область, г. Братск, ул. Возрождения, 46.")],
      SUBJECT,
    );
    expect(routed.place).toBe("Иркутская область, г. Братск, ул. Возрождения, 46");
  });

  it("сметное — в «Смету», деньги — в «Деньги», сроки — в «Сроки», остальное — в приложение", () => {
    const routed = routeNeutral(
      [
        neutral("Метод составления сметы", "Ресурсно-индексный."),
        neutral("Оплата труда рабочих", "557 750 рублей"),
        neutral("Порядок оплаты", "Оплата безналичным расчётом."),
        neutral("Срок исполнения контракта", "до 23 декабря"),
        neutral("Порядок рассмотрения заявок", "в течение 3 дней"),
      ],
      SUBJECT,
    );
    expect(routed.estimate.map((f) => f.title)).toEqual(["Метод составления сметы", "Оплата труда рабочих"]);
    expect(routed.money.map((f) => f.title)).toEqual(["Порядок оплаты"]);
    expect(routed.terms.map((f) => f.title)).toEqual(["Срок исполнения контракта"]);
    expect(routed.other.map((f) => f.title)).toEqual(["Порядок рассмотрения заявок"]);
  });

  it("НМЦК и предмет закупки не повторяются", () => {
    const routed = routeNeutral(
      [
        neutral("НМЦК", "Начальная (максимальная) цена контракта составляет 1 ₽."),
        neutral("Предмет закупки", SUBJECT),
        neutral("Объект", `Выполнение работ по ремонту теплоизоляции фасада ул. Возрождения, дом 46 — ремонт.`),
      ],
      SUBJECT,
    );
    expect(routed.other).toEqual([]);
    expect(routed.estimate).toEqual([]);
  });

  it("приложение — не больше 8 пунктов, без повторов названий", () => {
    const findings = Array.from({ length: 12 }, (_, i) => neutral(i === 1 ? "Пункт 0" : `Пункт ${String(i)}`, "детали"));
    const lines = otherFactLines(findings, 8);
    expect(lines).toHaveLength(8);
    expect(new Set(lines).size).toBe(8);
  });

  it("сметные сведения: одна тема и те же числа — одна строка; разные суммы остаются разными", () => {
    const lines = estimateFactLines([
      neutral("Уровень цен", "Смета составлена в текущем уровне цен III квартала 2026 года."),
      neutral("Составление сметы", "ССР составлен в текущем уровне цен III квартал 2026 года."),
      neutral("Сметная стоимость", "Общая сметная стоимость составляет 1 625 720 рублей."),
      neutral("Стоимость строительных работ", "Стоимость строительных работ составляет 1 623 390 рублей."),
    ]);
    expect(lines).toHaveLength(3);
  });
});
