import { describe, expect, it } from "vitest";

import { actualIndexAvailability, auditCustomerNmck, parseCustomerNmck, type CustomerNmck } from "@/domain/estimate/customerNmck";
import { computeSsrLayer } from "@/domain/estimate/ssrLayer";
import { NO_ESTIMATE_OPTIONS } from "@/domain/estimate/estimateOptions";
import { NMCK_CALCULATION_TEXT, NMCK_NAME } from "@/test/t1118Fixtures";

/*
  «Обоснование НМЦК» закупки 0302300048726001118: шесть листов «ССР Расчёт НМЦК» (приложения 1.1-1.6), шесть проектов смет
  контракта (3.1-3.6) и обоснование иным методом с лимитом финансирования. «Сегодня» — 10.10.2026.
*/

const NMCK = parseCustomerNmck([{ name: NMCK_NAME, text: NMCK_CALCULATION_TEXT }]) as CustomerNmck;
const TODAY = "2026-10-10";
const report = auditCustomerNmck(NMCK, { today: TODAY });
/** Суммы форматируются с неразрывным пробелом: в проверках он приводится к обычному. */
const finding = (type: string) => {
  const found = report.findings.find((item) => item.type === type);
  return found === undefined ? undefined : { ...found, message: found.message.replace(/\s/gu, " ") };
};

describe("разбор расчёта НМЦК и проектов смет контракта", () => {
  it("шесть листов расчёта: суммы в трёх уровнях, индексы, сроки, годовой индекс", () => {
    expect(NMCK.sheets).toHaveLength(6);
    const first = NMCK.sheets[0];
    expect(first?.exVat).toEqual([143_810.48, 146_212.12, 146_870.07]);
    expect(first?.withVat).toEqual([175_448.79, 178_378.79, 179_181.49]);
    expect(first).toMatchObject({ vatPercent: 22, actualIndex: 1.0167, forecastIndex: 1.0045, startMonth: "2026-11", endMonth: "2026-12", months: 2, formationMonth: "2026-10" });
    expect(first?.actualBasis).toMatchObject({ numerator: "2026-10", denominator: "2026-09" });
    expect(first?.annual).toEqual([{ year: 2026, percent: 105.5 }]);
    expect(first?.appendix).toBe("1.1");
  });

  it("шесть проектов смет контракта: итоги и число позиций; обоснование — лимит, названная цена по ЛСР, дата", () => {
    expect(NMCK.contracts.map((item) => item.appendix)).toEqual(["3.1", "3.2", "3.3", "3.4", "3.5", "3.6"]);
    expect(NMCK.contracts[1]).toMatchObject({ totalExVat: 933_127.99, vat: 205_288.16, totalWithVat: 1_138_416.15, positions: 13 });
    expect(NMCK.justification).toMatchObject({ limit: 1_877_900.36, namedLsrPrice: 1_904_114.87, nmck: 1_877_900.36, date: "2026-09-30" });
  });

  it("лист без расчёта НМЦК и документ без листов — null", () => {
    expect(parseCustomerNmck([{ name: "ВОР.docx", text: "Ведомость объёмов работ: земляные работы, 120 м3" }])).toBeNull();
    expect(parseCustomerNmck([{ name: "пусто", text: "" }])).toBeNull();
  });
});

describe("индекс фактической инфляции за месяц, которого нет в статистике", () => {
  it("октябрь 2026 на 10.10.2026 не закончился: WARNING, влияние — без индекса 1,0167 по всем объектам", () => {
    const item = finding("NMCK_FUTURE_ACTUAL_INDEX");

    expect(item?.severity).toBe("WARNING");
    expect(item?.message).toContain("ещё не закончился");
    // Σ (цена ЛСР × 1,0045) − Σ итога расчёта НМЦК: с НДС, по шести листам.
    expect(item?.impact).toBeCloseTo(1_864_448.42 * 1.0045 - 1_904_114.87, 0);
    expect(item?.impact).toBeLessThan(0);
  });

  it("доступность данных Росстата: месяц не закончился → середина следующего → опубликовано", () => {
    expect(actualIndexAvailability("2026-10", "2026-10-10")).toBe("NOT_ENDED");
    expect(actualIndexAvailability("2026-10", "2026-10-31")).toBe("NOT_ENDED");
    expect(actualIndexAvailability("2026-09", "2026-10-10")).toBe("MAYBE");
    expect(actualIndexAvailability("2026-09", "2026-10-20")).toBe("PUBLISHED");
  });

  it("месяц уже опубликован — находки нет; месяц закончился, но данные могли не выйти — INFO без суммы", () => {
    const published = auditCustomerNmck(NMCK, { today: "2026-11-20" });
    expect(published.findings.some((item) => item.type === "NMCK_FUTURE_ACTUAL_INDEX")).toBe(false);

    const maybe = auditCustomerNmck(NMCK, { today: "2026-11-05" });
    const item = maybe.findings.find((entry) => entry.type === "NMCK_FUTURE_ACTUAL_INDEX");
    expect(item?.severity).toBe("INFO");
    expect(item?.impact).toBeNull();
  });
});

describe("месячный индекс выше 1 %", () => {
  it("1,0167 за месяц — 1,67 % при прогнозе Минэкономразвития около 0,95 %: WARNING без суммы (она в находке про фактическую инфляцию)", () => {
    const item = finding("NMCK_MONTHLY_INDEX");

    expect(item?.severity).toBe("WARNING");
    expect(item?.message).toContain("1,67 % в месяц");
    expect(item?.message).toContain("0,95 % в месяц");
    expect(item?.message).toContain("112,0 % г/г");
    expect(item?.impact).toBeNull();
  });

  it("месячный индекс 1,008 (меньше 1 %) находки не даёт", () => {
    const calm: CustomerNmck = { ...NMCK, sheets: NMCK.sheets.map((sheet) => ({ ...sheet, actualIndex: 1.008 })) };
    expect(auditCustomerNmck(calm, { today: "2026-11-20" }).findings.some((item) => item.type === "NMCK_MONTHLY_INDEX")).toBe(false);
  });
});

describe("годовой индекс прогнозной инфляции", () => {
  it("105,5 % против дефлятора 112,0 %: по формуле заказчика индекс 1,0095 вместо 1,0045 — плюс к НМЦК", () => {
    const item = finding("NMCK_FORECAST_INDEX");

    expect(item?.message).toContain("105,5 %");
    expect(item?.message).toContain("112,0 %");
    expect(item?.message).toContain("1,0095 вместо 1,0045");
    expect(item?.impact).toBeCloseTo(1_895_584.74 * ((1.12 ** (2 / 12) - 1) / 2 + 1 - 1.0045), 0);
  });
});

describe("«цена по ЛСР» на сумме с индексами", () => {
  it("1 904 114,87 названа ценой по ЛСР, а это сумма расчёта с инфляцией; цена по ЛСР — 1 864 448,42, лимит выше неё", () => {
    const item = finding("NMCK_LSR_LABEL");

    expect(item?.severity).toBe("WARNING");
    expect(item?.message).toContain("1 904 114,87");
    expect(item?.message).toContain("после фактической и прогнозной инфляции");
    expect(item?.message).toContain("1 864 448,42");
    expect(item?.message).toContain("больше цены по ЛСР на 13 451,94");
    expect(item?.message).toContain("только из-за индексов");
  });

  it("названная цена равна цене по ЛСР — находки нет", () => {
    const honest: CustomerNmck = { ...NMCK, justification: { ...(NMCK.justification as NonNullable<CustomerNmck["justification"]>), namedLsrPrice: 1_864_448.42 } };
    expect(auditCustomerNmck(honest, { today: TODAY }).findings.some((item) => item.type === "NMCK_LSR_LABEL")).toBe(false);
  });
});

describe("лимит по приложениям сметы контракта", () => {
  it("сумма смет контракта равна лимиту, сокращение неравномерно: 3.1 и 3.5 без изменений, 3.2 — 98,17 %", () => {
    const item = finding("NMCK_LIMIT_UNEVEN");

    expect(item?.severity).toBe("WARNING");
    expect(item?.message).toContain("равна лимиту финансирования");
    expect(item?.message).toMatch(/3\.1[^;]*— без изменений/u);
    expect(item?.message).toMatch(/3\.5[^;]*— без изменений/u);
    expect(item?.message).toContain("98,17 %");
    expect(item?.message).toContain("98,62 %");
    expect(item?.impact).toBeNull();
  });

  it("равномерное сокращение — находки нет", () => {
    const k = 0.98;
    const even: CustomerNmck = {
      ...NMCK,
      contracts: NMCK.contracts.map((contract) => {
        const sheet = NMCK.sheets.find((candidate) => candidate.appendix?.split(".")[1] === contract.appendix?.split(".")[1]);
        return { ...contract, totalWithVat: Math.round((sheet?.withVat?.[2] ?? 0) * k * 100) / 100 };
      }),
    };
    expect(auditCustomerNmck(even, { today: TODAY }).findings.some((item) => item.type === "NMCK_LIMIT_UNEVEN")).toBe(false);
  });
});

describe("отчёт и подключение к слою ССР", () => {
  it("пять замечаний, отчёт называет итог расчёта и индекс", () => {
    expect(report.warnings).toBe(5);
    expect(report.customer).toMatchObject({ total: 1_904_114.87, vatPercent: 22, inflationIndex: 1.0045 });
    expect(report.conclusion).toContain("Замечаний: 5");
  });

  it("computeSsrLayer: отчёт НМЦК идёт в списке аудитов рядом с аудитом ССР; без листов расчёта его нет", () => {
    const layer = computeSsrLayer({
      estimate: null,
      options: NO_ESTIMATE_OPTIONS,
      nmc: 1_877_900.36,
      nmcIncludesVat: true,
      priceDate: "2026-09-30",
      today: TODAY,
      documents: [{ name: NMCK_NAME, text: NMCK_CALCULATION_TEXT }],
    });
    expect(layer.audits).toHaveLength(1);
    expect(layer.audits[0]?.estimateName).toContain("Расчёт НМЦК заказчика");

    const none = computeSsrLayer({ estimate: null, options: NO_ESTIMATE_OPTIONS, nmc: null, nmcIncludesVat: true, priceDate: null, today: TODAY, documents: [{ name: "ВОР.docx", text: "ведомость" }] });
    expect(none.audits).toEqual([]);
  });
});
