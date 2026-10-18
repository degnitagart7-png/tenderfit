import { describe, expect, it } from "vitest";
import { PLANS, formatPlanPrice, invoiceRequestHref, planById } from "@/domain/plans";

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
    expect(params.get("body")).toContain("39 000 ₽ в месяц");
    expect(params.get("body")).toContain("client@example.ru");
  });

  it("для пакета по запросу письмо про условия, а не про счёт", () => {
    const params = new URLSearchParams(invoiceRequestHref(planById("premium")!, null).split("?")[1]);
    expect(params.get("subject")).toBe("Условия пакета «Премиум»");
    expect(params.get("body")).not.toContain("выставить счёт");
  });
});
