import { describe, expect, it } from "vitest";

import { planOkpd2Enrichment, type EnrichCandidate } from "@/domain/okpd2Enrichment";

/**
 * Что делать с кодами ОКПД2 в этом прогоне.
 *
 * Плановый прогон пересоздаёт строки источника целиком, поэтому код, добытый
 * из карточки в прошлый раз, пропал бы вместе со строкой, и каждый прогон
 * ходил бы в ЕИС за теми же кодами заново. Планировщик сначала берёт уже
 * известное из базы и только потом тратит запросы на новое, не выходя за
 * бюджет: сто пятьдесят карточек подряд — это минуты и лишняя нагрузка на
 * чужой сайт.
 */

function tender(over: Partial<EnrichCandidate> & { regNumber: string }): EnrichCandidate {
  return {
    dataSource: "EIS",
    law: "FZ_44",
    okpd2Codes: [],
    eisUrl: "",
    ...over,
  };
}

describe("planOkpd2Enrichment", () => {
  it("известный код берётся из прошлого прогона, а не из карточки", () => {
    const plan = planOkpd2Enrichment({
      tenders: [tender({ regNumber: "A" })],
      existing: new Map([["A", ["26.20.14.120"]]]),
      sources: ["EIS"],
      budget: 10,
    });

    expect(plan.carry.get("A")).toEqual(["26.20.14.120"]);
    expect(plan.fetch).toEqual([]);
  });

  it("неизвестный код идёт в список запросов", () => {
    const plan = planOkpd2Enrichment({
      tenders: [tender({ regNumber: "A" })],
      existing: new Map(),
      sources: ["EIS"],
      budget: 10,
    });

    expect(plan.fetch).toEqual(["A"]);
  });

  it("закупка, у которой код уже есть, не трогается", () => {
    const plan = planOkpd2Enrichment({
      tenders: [tender({ regNumber: "A", okpd2Codes: ["69.10.10.000"] })],
      existing: new Map(),
      sources: ["EIS"],
      budget: 10,
    });

    expect(plan.carry.size).toBe(0);
    expect(plan.fetch).toEqual([]);
  });

  it("чужой источник не трогается: путь к его карточке мы не знаем", () => {
    const plan = planOkpd2Enrichment({
      tenders: [tender({ regNumber: "S", dataSource: "SBER_AST" })],
      existing: new Map(),
      sources: ["EIS"],
      budget: 10,
    });

    expect(plan.fetch).toEqual([]);
  });

  it("запросов не больше бюджета, остаток откладывается и считается", () => {
    const tenders = ["A", "B", "C", "D", "E"].map((regNumber) => tender({ regNumber }));

    const plan = planOkpd2Enrichment({ tenders, existing: new Map(), sources: ["EIS"], budget: 3 });

    expect(plan.fetch).toEqual(["A", "B", "C"]);
    expect(plan.deferred).toBe(2);
  });

  it("известные из прошлого прогона бюджет не тратят", () => {
    const tenders = ["A", "B", "C"].map((regNumber) => tender({ regNumber }));

    const plan = planOkpd2Enrichment({
      tenders,
      existing: new Map([["A", ["1.1.1.1"]], ["B", ["2.2.2.2"]]]),
      sources: ["EIS"],
      budget: 1,
    });

    expect(plan.fetch).toEqual(["C"]);
    expect(plan.deferred).toBe(0);
  });

  it("порядок выдачи сохраняется: сначала самые свежие", () => {
    const tenders = ["new", "mid", "old"].map((regNumber) => tender({ regNumber }));

    const plan = planOkpd2Enrichment({ tenders, existing: new Map(), sources: ["EIS"], budget: 2 });

    expect(plan.fetch).toEqual(["new", "mid"]);
  });

  it("нулевой бюджет: ничего не запрашиваем, всё откладываем", () => {
    const plan = planOkpd2Enrichment({
      tenders: [tender({ regNumber: "A" }), tender({ regNumber: "B" })],
      existing: new Map(),
      sources: ["EIS"],
      budget: 0,
    });

    expect(plan.fetch).toEqual([]);
    expect(plan.deferred).toBe(2);
  });
});
