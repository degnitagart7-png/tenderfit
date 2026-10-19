import { describe, expect, it } from "vitest";
import { PLANS, formatFirstMonthPrice, formatPlanPrice, invoiceRequestHref, planById } from "@/domain/plans";

describe("пакеты подписки", () => {
  it("три пакета с ценами из коммерческого предложения; премиум — по запросу", () => {
    expect(PLANS.map((p) => [p.id, p.priceRub])).toEqual([
      ["start", 9_000],
      ["calc", 39_000],
      ["premium", null],
    ]);
  });

  it("цена печатается с неразрывным пробелом, у премиума — «по запросу»", () => {
    expect(formatPlanPrice(planById("start")!)).toBe("9 000 ₽");
    expect(formatPlanPrice(planById("calc")!)).toBe("39 000 ₽");
    expect(formatPlanPrice(planById("premium")!)).toBe("по запросу");
  });

  it("заявка на счёт — письмо на почту оператора с темой и составом", () => {
    const href = invoiceRequestHref(planById("calc")!, "client@example.ru");
    expect(href.startsWith("mailto:degnitagart7@gmail.com?")).toBe(true);
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("subject")).toBe("Счёт на оплату — пакет «Расчёт»");
    expect(params.get("body")).toContain(
      "Прошу выставить счёт на оплату: пакет «Расчёт», первый месяц — 9 000 ₽ (далее 39 000 ₽ в месяц).",
    );
    expect(params.get("body")).toContain("client@example.ru");
  });

  it("у «Старта» письмо без вводной цены", () => {
    const params = new URLSearchParams(invoiceRequestHref(planById("start")!, null).split("?")[1]);
    expect(params.get("body")).toContain("пакет «Старт», 9 000 ₽ в месяц.");
    expect(params.get("body")).not.toContain("первый месяц");
  });

  it("вводная цена первого месяца — только у «Расчёта»", () => {
    expect(PLANS.map((p) => [p.id, p.firstMonthRub])).toEqual([
      ["start", undefined],
      ["calc", 9_000],
      ["premium", undefined],
    ]);
  });

  it("formatFirstMonthPrice: «9 000 ₽» для «Расчёта», null для остальных", () => {
    expect(formatFirstMonthPrice(planById("calc")!)).toBe("9 000 ₽");
    expect(formatFirstMonthPrice(planById("start")!)).toBeNull();
    expect(formatFirstMonthPrice(planById("premium")!)).toBeNull();
  });

  it("для пакета по запросу письмо про условия, а не про счёт", () => {
    const params = new URLSearchParams(invoiceRequestHref(planById("premium")!, null).split("?")[1]);
    expect(params.get("subject")).toBe("Условия пакета «Премиум»");
    expect(params.get("body")).not.toContain("выставить счёт");
  });
});
