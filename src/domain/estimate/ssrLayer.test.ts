import { describe, expect, it } from "vitest";

import { SSR_377_CSV, SSR_BAD, NOT_SSR } from "@/domain/estimate/customerSsr.fixtures";
import { DEFAULT_SSR_OPTIONS, NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { computeSsrLayer, type SsrLayerInput } from "@/domain/estimate/ssrLayer";
import { ssrEstimate } from "@/test/ssrFixtures";

/** Слой сводного расчёта целиком: наш ССР, сравнение с НМЦК закупки, ССР заказчика и его аудит. */

const NMC = 2_032_153.32;
const DOCS_377 = [{ name: "НМЦК_Возрождения 46 - ССРСС.xlsx", text: SSR_377_CSV }];

function input(over: Partial<SsrLayerInput> = {}): SsrLayerInput {
  return {
    estimate: ssrEstimate({ sections: [{ title: "Ремонт теплоизоляции фасада", workCost: 1_623_390 }] }),
    options: { ...NO_ESTIMATE_OPTIONS, workKind: "CR_FACADE", workPeriod: { start: "2026-10-01", end: "2026-11-30" } } as EstimateOptions,
    nmc: NMC,
    nmcIncludesVat: true,
    priceDate: "2026-10-01",
    today: "2026-10-09",
    documents: DOCS_377,
    ...over,
  };
}

describe("закупка 377 целиком: наша оценка НМЦК против НМЦК закупки и ССР заказчика", () => {
  const layer = computeSsrLayer(input());

  it("наш ССР: резерв 2 % (фасад — здание), индекс 1,0047 по датам из «Условий работ»", () => {
    expect(layer.purpose).toMatchObject({ value: "NON_PRODUCTION", basis: "WORK_KIND" });
    expect(layer.ssr?.reserve.percent).toBe(2);
    expect(layer.ssr?.nmc.inflation.index).toBe(1.0047);
  });

  it("сравнение: наша оценка цены контракта на ~0,4 % ниже НМЦК (наша смета 1 623 390 без 2 330 ₽ главы 9 заказчика)", () => {
    expect(layer.comparison).not.toBeNull();
    expect(layer.comparison!.nmc).toBe(NMC);
    expect(layer.comparison!.diffPercent).toBeLessThan(0);
    expect(layer.comparison!.diffPercent).toBeGreaterThan(-0.5);
  });

  it("ССР заказчика найден и проверен: замечаний нет, строки сравнения готовы", () => {
    expect(layer.customer).toHaveLength(1);
    expect(layer.audits).toHaveLength(1);
    expect(layer.audits[0]?.warnings).toBe(0);
    expect(layer.audits[0]?.rows.map((row) => row.id)).toEqual(["LOCAL", "TEMPORARY", "WINTER", "RESERVE", "INFLATION", "VAT"]);
  });
});

describe("нет ССР в документах — аудит ССР не показывается", () => {
  it("документы без ССР: пустые списки", () => {
    const layer = computeSsrLayer(input({ documents: [{ name: "Локальная смета.xlsx", text: NOT_SSR }] }));
    expect(layer.customer).toEqual([]);
    expect(layer.audits).toEqual([]);
    expect(layer.ssr).not.toBeNull();
  });

  it("совсем без документов тоже", () => {
    expect(computeSsrLayer(input({ documents: [] })).audits).toEqual([]);
  });
});

describe("сметы нет", () => {
  it("наш ССР не строится, аудит ССР заказчика остаётся (по умолчанию НДС 22 %)", () => {
    const layer = computeSsrLayer(input({ estimate: null, documents: [{ name: "ССРСС.xlsx", text: SSR_BAD }], nmc: 1_813_280.4 }));
    expect(layer.ssr).toBeNull();
    expect(layer.comparison).toBeNull();
    expect(layer.audits).toHaveLength(1);
    expect(layer.audits[0]?.findings.some((finding) => finding.type === "VAT_RATE")).toBe(true);
    expect(layer.audits[0]?.rows).toEqual([]);
  });
});

describe("выбор пользователя доходит до расчёта", () => {
  it("назначение «производственное» — 3 %; срок в месяцах — индекс считается", () => {
    const layer = computeSsrLayer(
      input({ options: { ...NO_ESTIMATE_OPTIONS, ssr: { ...DEFAULT_SSR_OPTIONS, purpose: "PRODUCTION", periodMode: "MONTHS", months: 2 } } }),
    );
    expect(layer.ssr?.reserve.percent).toBe(3);
    expect(layer.ssr?.nmc.inflation.index).toBe(1.0047);
  });

  it("сроков нет — инфляция не применена, допущение в списке", () => {
    const layer = computeSsrLayer(input({ options: NO_ESTIMATE_OPTIONS }));
    expect(layer.ssr?.nmc.inflation.applied).toBe(false);
    expect(layer.ssr?.assumptions.map((item) => item.code)).toContain("PERIOD_UNKNOWN");
    expect(layer.ssr?.assumptions.map((item) => item.code)).toContain("PURPOSE_DEFAULT");
  });
});
