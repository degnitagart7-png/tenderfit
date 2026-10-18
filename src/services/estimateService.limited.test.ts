import { describe, expect, it } from "vitest";

import { computeAssurance } from "@/domain/estimate/assurance";
import { NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { buildWageScale } from "@/domain/estimate/wageScale";
import { estimateDocumentSchema } from "@/domain/estimate/schema";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments, type EstimateRequestInput } from "@/services/estimateService";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeParameters,
  makePriceBook,
} from "@/test/estimateFixtures";

/*
  Нормативы сверх норм в связке «текст документа → смета»: по умолчанию всё выключено и итоги те же,
  что раньше; выбор пользователя добавляет зимнее удорожание, временные здания и коэффициенты.
  Объект — закупка 0134600012126000001: снос жилого дома, Иркутская область, Иркутский район.
*/

const NORMS = [NORM_MANUAL_GRADING, NORM_DRAGLINE_15];
const TEXT = "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ\n1 Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405";

function makeBase(): EstimateBase {
  return {
    info: {
      indexDir: "data/fsnb/index",
      builtAt: "2026-09-28T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: AMUR_ZONE.region,
      priceZone: AMUR_ZONE.zone,
      period: AMUR_ZONE.period,
      decree: "Приказ Минстроя России от 30.12.2021 № 1046/пр",
      counts: { norms: NORMS.length, basePrices: 0, currentPrices: 0, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE)),
    searchIndex: createNormSearchIndex(NORMS),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

const fetcher: BillRowsFetcher = async () => ({
  rows: [
    {
      workName: "Разработка грунта в отвал экскаваторами",
      quantity: "1,2405",
      unit: "1000 м3",
      evidenceQuote: "Разработка грунта в отвал экскаваторами | 1000 м3 | 1,2405",
    },
  ],
  hasBill: true,
  tokens: 100,
  malformed: 0,
  truncated: false,
});

const PLACE = { region: "Иркутская область", address: "Иркутская область, Иркутский район, д. Сосновый бор, ул. Мелехова, д. 4", customerName: "" };

async function run(patch: Partial<EstimateRequestInput> = {}) {
  return buildEstimateFromDocuments(
    {
      regNumber: "0134600012126000001",
      subject: "Снос (демонтаж) объекта капитального строительства",
      documents: [{ name: "ВОР.docx", text: TEXT }],
      parameters: makeParameters(),
      now: new Date("2026-10-08T00:00:00.000Z"),
      place: PLACE,
      ...patch,
    },
    { base: makeBase(), fetcher },
  );
}

const opts = (patch: Partial<EstimateOptions>): EstimateOptions => ({ ...NO_ESTIMATE_OPTIONS, ...patch });

describe("смета: нормативы сверх норм по выбору пользователя", () => {
  it("без выбора — документ как прежде: ни записей о нормативах, ни зимнего, ни временных", async () => {
    const plain = await run();
    const explicit = await run({ options: NO_ESTIMATE_OPTIONS });
    expect(explicit.document.totals).toEqual(plain.document.totals);
    expect(plain.document.appliedNormatives).toBeUndefined();
    expect(plain.document.totals.winterSurcharge).toBe(0);
    expect(plain.document.totals.temporaryStructures).toBe(0);
    expect(plain.document.parameters.limited.source).toContain("Значения заданы для теста");
    expect(plain.document.gaps.some((gap) => gap.kind === "NORMATIVE_NOT_APPLIED")).toBe(false);
  });

  it("снос, работы сентябрь-ноябрь: зимнее 6,77 % от СМР, временные 0; в документе — приказ и пункт", async () => {
    const base = await run();
    const result = await run({
      options: opts({ phase: "DEMOLITION", workKind: "DEM_DISMANTLE", workPeriod: { start: "2026-09-01", end: "2026-11-30" } }),
    });
    const { totals } = result.document;
    expect(totals.workCost).toBe(base.document.totals.workCost);
    expect(totals.temporaryStructures).toBe(0);
    expect(totals.winterSurcharge).toBeCloseTo(Math.round(totals.workCost * 6.77) / 100, 2);
    expect(totals.total).toBeGreaterThan(base.document.totals.total);
    expect(result.document.parameters.limited.winterSurchargePercent).toBe(6.77);

    const normatives = result.document.appliedNormatives ?? [];
    expect(normatives.find((item) => item.code === "WINTER")?.source).toContain("325/пр");
    expect(normatives.find((item) => item.code === "TEMPORARY")).toMatchObject({ applied: false });
    expect(result.document.sources.some((source) => source.title.includes("325/пр"))).toBe(true);
    // Документ проходит схему и арифметическую сверку.
    expect(estimateDocumentSchema.safeParse(JSON.parse(JSON.stringify(result.document))).success).toBe(true);
  });

  it("капремонт жилого здания с декабря по февраль: зимнее 2,35 % считается от СМР вместе с временными 0,9 %", async () => {
    const result = await run({
      options: opts({ phase: "CAPITAL_REPAIR", workKind: "CR_RES_BRICK", workPeriod: { start: "2026-12-01", end: "2027-02-28" } }),
    });
    const { totals } = result.document;
    const temporary = Math.round(totals.workCost * 0.9) / 100;
    expect(totals.temporaryStructures).toBeCloseTo(temporary, 2);
    expect(totals.winterSurcharge).toBeCloseTo(Math.round((totals.workCost + totals.temporaryStructures) * 2.35) / 100, 2);
  });

  it("условия работ: «в жилых помещениях без расселения» повышает ФОТ и итог; строка и запись называют таблицу и пункт", async () => {
    const base = await run();
    const result = await run({
      options: opts({ phase: "CAPITAL_REPAIR", workKind: "CR_RES_BRICK", conditionIds: ["T5-8"], winterWork: "NO" }),
    });
    expect(result.document.totals.wageFund).toBeGreaterThan(base.document.totals.wageFund);
    expect(result.document.totals.workCost).toBeGreaterThan(base.document.totals.workCost);
    expect(result.document.sections[0]?.lines[0]?.coefficients?.conditionIds).toEqual(["T5-8"]);
    const condition = (result.document.appliedNormatives ?? []).find((item) => item.code === "WORK_CONDITION");
    expect(condition?.source).toBe("приложение 10 к 421/пр, таблица 5, п. 8");
    expect(result.document.parameters.workConditions).toEqual({ phase: "CAPITAL_REPAIR", conditionIds: ["T5-8"], newConstructionNorms: false });
  });

  it("неизвестные данные: вид работ выбран, периода нет — зимнее 0 с пробелом и строкой в «Надёжности расчёта»", async () => {
    const result = await run({ options: opts({ phase: "DEMOLITION", workKind: "DEM_DISMANTLE" }) });
    expect(result.document.totals.winterSurcharge).toBe(0);
    const gap = result.document.gaps.find((item) => item.kind === "NORMATIVE_NOT_APPLIED");
    expect(gap?.message).toBe("Зимнее удорожание: зимнее удорожание не начислено: не известен период работ");
    const assurance = computeAssurance(result.document);
    expect(assurance.unappliedNormatives?.map((item) => item.code)).toEqual(["WINTER"]);
    expect(assurance.unappliedNormatives?.[0]?.message).toContain("не известен период работ");
  });

  it("допущение о территории: часть области определена как «остальная территория» — сумма зимнего попадает в допущения", async () => {
    const result = await run({
      options: opts({ phase: "DEMOLITION", workKind: "DEM_DISMANTLE", winterWork: "YES" }),
    });
    const assurance = computeAssurance(result.document);
    const assumed = assurance.assumptions.find((item) => item.kind === "NORMATIVE_ASSUMED");
    expect(assumed?.cost).toBe(result.document.totals.winterSurcharge);
    expect(assumed?.message).toContain("остальная территория области");
  });

  it("Север: Якутия — запись РКС и «районные коэффициенты уже в ставках»; не применяется повторно", async () => {
    const result = await run({
      place: { region: "Республика Саха (Якутия)", address: "г. Якутск", customerName: "" },
      priceZoneChoice: { basis: "SINGLE_ZONE", matched: null, northZone: "RKS", northBasis: "SUBJECT" },
    });
    const codes = (result.document.appliedNormatives ?? []).map((item) => item.code);
    expect(codes).toEqual(["NORTH", "NORTH_WAGE"]);
    expect(result.document.totals.winterSurcharge).toBe(0);
  });
});
