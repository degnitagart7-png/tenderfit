import { describe, expect, it, vi } from "vitest";

import {
  CBR_DAILY_URL,
  computeCost,
  createUsdRubProvider,
  DEFAULT_PRICE_IN_RUB_PER_M,
  DEFAULT_PRICE_OUT_RUB_PER_M,
  parseUsage,
  priceTableCost,
  resolvePriceTable,
} from "@/services/llmCost";

/**
 * Стоимость вызова модели в рублях: из ответа шлюза, из таблицы цен, по курсу ЦБ.
 */

describe("parseUsage", () => {
  it("читает токены и стоимость шлюза; валюта по умолчанию — рубли", () => {
    expect(
      parseUsage({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cost: 0.0875 }, {}),
    ).toEqual({ promptTokens: 1000, completionTokens: 200, providerCost: 0.0875, providerCurrency: "RUB" });
  });

  it("валюту стоимости берёт из ответа или из LLM_COST_CURRENCY", () => {
    expect(parseUsage({ cost: 1, currency: "usd" }, {}).providerCurrency).toBe("USD");
    expect(parseUsage({ cost: 1 }, { LLM_COST_CURRENCY: "usd" }).providerCurrency).toBe("USD");
  });

  it("нет completion_tokens — выход считается как total минус вход", () => {
    expect(parseUsage({ prompt_tokens: 900, total_tokens: 1000 }, {})).toMatchObject({
      promptTokens: 900,
      completionTokens: 100,
    });
  });

  it("мусор и отсутствие usage дают нули, а не исключение", () => {
    for (const raw of [undefined, null, "строка", 42, {}, { cost: "много" }, { cost: -5 }]) {
      const usage = parseUsage(raw, {});
      expect(usage.promptTokens).toBe(0);
      expect(usage.completionTokens).toBe(0);
      expect(usage.providerCost).toBeNull();
      expect(usage.providerCurrency).toBeNull();
    }
  });

  it("стоимость строкой тоже принимается", () => {
    expect(parseUsage({ cost: "0.5" }, {}).providerCost).toBe(0.5);
  });
});

describe("таблица цен", () => {
  it("по умолчанию — цены routerai.ru на anthropic/claude-haiku-5.5: 11 и 55 ₽ за миллион", () => {
    expect(DEFAULT_PRICE_IN_RUB_PER_M).toBe(11);
    expect(DEFAULT_PRICE_OUT_RUB_PER_M).toBe(55);
    expect(resolvePriceTable({})).toEqual({ inRubPerM: 11, outRubPerM: 55 });
  });

  it("цены переопределяются окружением; кривое значение заменяется умолчанием", () => {
    expect(
      resolvePriceTable({ LLM_PRICE_IN_RUB_PER_M: "40", LLM_PRICE_OUT_RUB_PER_M: "300.5" }),
    ).toEqual({ inRubPerM: 40, outRubPerM: 300.5 });
    expect(
      resolvePriceTable({ LLM_PRICE_IN_RUB_PER_M: "дорого", LLM_PRICE_OUT_RUB_PER_M: "-1" }),
    ).toEqual({ inRubPerM: 11, outRubPerM: 55 });
  });

  it("стоимость = токены × цена за миллион", () => {
    // 100 тыс. входа × 11 ₽/млн + 10 тыс. выхода × 55 ₽/млн = 1,1 + 0,55.
    expect(priceTableCost(100_000, 10_000, {})).toBeCloseTo(1.65, 6);
    expect(priceTableCost(0, 0, {})).toBe(0);
  });
});

describe("computeCost", () => {
  const noRate = vi.fn(async () => null);

  it("стоимость шлюза в рублях берётся как есть", async () => {
    const cost = await computeCost(
      { promptTokens: 1000, completionTokens: 100, providerCost: 0.123, providerCurrency: "RUB" },
      { env: {}, usdRub: noRate },
    );
    expect(cost).toEqual({
      costRub: 0.123,
      costSource: "provider",
      providerCost: 0.123,
      providerCurrency: "RUB",
      usdRub: null,
    });
    expect(noRate).not.toHaveBeenCalled();
  });

  it("нет стоимости шлюза — считает по таблице, источник price_table", async () => {
    const cost = await computeCost(
      { promptTokens: 1_000_000, completionTokens: 1_000_000, providerCost: null, providerCurrency: null },
      { env: {}, usdRub: noRate },
    );
    expect(cost.costSource).toBe("price_table");
    expect(cost.costRub).toBeCloseTo(66, 6);
    expect(cost.providerCost).toBeNull();
  });

  it("таблица цен из окружения применяется", async () => {
    const cost = await computeCost(
      { promptTokens: 1_000_000, completionTokens: 0, providerCost: null, providerCurrency: null },
      { env: { LLM_PRICE_IN_RUB_PER_M: "50" }, usdRub: noRate },
    );
    expect(cost.costRub).toBe(50);
  });

  it("стоимость в долларах переводится по курсу, курс сохраняется рядом", async () => {
    const cost = await computeCost(
      { promptTokens: 10, completionTokens: 10, providerCost: 0.02, providerCurrency: "USD" },
      { env: {}, usdRub: async () => 95.5 },
    );
    expect(cost.costRub).toBeCloseTo(1.91, 6);
    expect(cost).toMatchObject({ costSource: "provider", providerCost: 0.02, providerCurrency: "USD", usdRub: 95.5 });
  });

  it("доллары без курса: считаем по таблице, а стоимость шлюза всё равно сохраняем", async () => {
    const cost = await computeCost(
      { promptTokens: 1_000_000, completionTokens: 0, providerCost: 0.4, providerCurrency: "USD" },
      { env: {}, usdRub: noRate },
    );
    expect(cost.costSource).toBe("price_table");
    expect(cost.costRub).toBe(11);
    expect(cost.providerCost).toBe(0.4);
    expect(cost.providerCurrency).toBe("USD");
    expect(cost.usdRub).toBeNull();
  });

  it("неизвестная валюта шлюза не принимается за рубли", async () => {
    const cost = await computeCost(
      { promptTokens: 1_000_000, completionTokens: 0, providerCost: 5, providerCurrency: "EUR" },
      { env: {}, usdRub: noRate },
    );
    expect(cost.costSource).toBe("price_table");
    expect(cost.costRub).toBe(11);
  });
});

describe("курс ЦБ", () => {
  const cbr = (value: number, nominal = 1) =>
    ({
      ok: true,
      json: async () => ({ Valute: { USD: { Value: value, Nominal: nominal } } }),
    }) as Response;

  it("читает курс и берёт его с официального адреса", async () => {
    const fetchImpl = vi.fn(async () => cbr(94.25));
    const rate = await createUsdRubProvider({ fetchImpl: fetchImpl as never })();
    expect(rate).toBe(94.25);
    expect(fetchImpl).toHaveBeenCalledWith(CBR_DAILY_URL, expect.anything());
  });

  it("учитывает номинал", async () => {
    const fetchImpl = vi.fn(async () => cbr(940, 10));
    expect(await createUsdRubProvider({ fetchImpl: fetchImpl as never })()).toBe(94);
  });

  it("кэш на сутки: второй вызов в тот же день сети не трогает", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => cbr(90));
    const provider = createUsdRubProvider({ fetchImpl: fetchImpl as never, now: () => now });

    await provider();
    now += 23 * 3_600_000;
    await provider();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("через сутки курс запрашивается заново", async () => {
    let now = 1_000_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(cbr(90))
      .mockResolvedValueOnce(cbr(92));
    const provider = createUsdRubProvider({ fetchImpl: fetchImpl as never, now: () => now });

    expect(await provider()).toBe(90);
    now += 25 * 3_600_000;
    expect(await provider()).toBe(92);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("сбой ЦБ: отдаёт последний известный курс", async () => {
    let now = 1_000_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(cbr(91.5))
      .mockRejectedValueOnce(new Error("сеть"));
    const provider = createUsdRubProvider({ fetchImpl: fetchImpl as never, now: () => now });

    expect(await provider()).toBe(91.5);
    now += 30 * 3_600_000;
    expect(await provider()).toBe(91.5);
  });

  it("сбой ЦБ и курса ещё не было — null, а не выдуманное число", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("сеть");
    });
    expect(await createUsdRubProvider({ fetchImpl: fetchImpl as never })()).toBeNull();
  });

  it("ответ без курса или с HTTP-ошибкой — тоже сбой", async () => {
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    expect(await createUsdRubProvider({ fetchImpl: empty as never })()).toBeNull();
    const bad = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    expect(await createUsdRubProvider({ fetchImpl: bad as never })()).toBeNull();
  });
});
