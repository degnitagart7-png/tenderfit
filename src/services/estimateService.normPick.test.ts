import { describe, expect, it, vi } from "vitest";

import { NO_ESTIMATE_OPTIONS } from "@/domain/estimate/estimateOptions";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { CANDIDATE_NORMS } from "@/domain/estimate/normCandidates.fixtures";
import { NO_NORM_PICKER, type NormPicker, type RawNormPick } from "@/domain/estimate/normPick";
import type { NormRecord } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments } from "@/services/estimateService";
import { AMUR_WAGE_ANCHORS, AMUR_ZONE, NORM_MANUAL_GRADING, makeParameters, makePriceBook } from "@/test/estimateFixtures";

/**
 * «ИИ-сметчик» в сборке сметы: выбор модели против подбора по наименованию и против шифра из документа.
 *
 * Корпус норм — выдержка из настоящей базы (фасадные нормы закупки 0134300025826000377) плюс деревянный настил с настоящим ресурсом
 * (труд рабочих), чтобы коэффициент 571/пр на демонтаж было видно в деньгах. Модель подменена: она «выбирает» то, что скажет тест.
 */

/** Деревянный настил на основе настоящей нормы 01-01-111-01: единственный ресурс — труд рабочих, значит, смета зависит только от часов. */
const WOOD_FLOOR: NormRecord = {
  ...NORM_MANUAL_GRADING,
  code: "10-01-111-01",
  tableCode: "10-01-111",
  fullName: "Устройство деревянных настилов: полов из досок",
  endName: "полов из досок",
  collectionCode: "10",
  collectionName: "Деревянные конструкции",
};

const NORMS: readonly NormRecord[] = [...CANDIDATE_NORMS, WOOD_FLOOR];

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

function fetcherFor(rows: readonly Record<string, string>[]): BillRowsFetcher {
  return async () => ({
    rows: rows.map((row) => ({
      workName: row["work_name"] as string,
      quantity: row["quantity"] as string,
      unit: row["unit"] as string,
      evidenceQuote: row["evidence_quote"] as string,
      ...(row["justification"] === undefined ? {} : { justification: row["justification"] }),
    })),
    hasBill: true,
    tokens: 100,
    malformed: 0,
    truncated: false,
  });
}

const TEXT = [
  "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
  "1 Демонтаж оконных откосов | м2 | 120",
  "2 Демонтаж деревянных настилов полов | м2 | 450",
  "3 Демонтаж ограждения | м2 | 30",
].join("\n");

const ROW_SLOPES = { work_name: "Демонтаж оконных откосов", quantity: "120", unit: "м2", evidence_quote: "Демонтаж оконных откосов | м2 | 120" };
const ROW_FLOOR = { work_name: "Демонтаж деревянных настилов полов", quantity: "450", unit: "м2", evidence_quote: "Демонтаж деревянных настилов полов | м2 | 450" };
const ROW_FENCE = { work_name: "Демонтаж ограждения", quantity: "30", unit: "м2", evidence_quote: "Демонтаж ограждения | м2 | 30" };

function run(rows: readonly Record<string, string>[], normPicker?: NormPicker, jobId?: string) {
  return buildEstimateFromDocuments(
    {
      regNumber: "0134300025826000377",
      subject: "Ремонт фасада",
      documents: [{ name: "ВОР.docx", text: TEXT }],
      parameters: makeParameters(),
      now: new Date("2026-09-28T00:00:00.000Z"),
      ...(jobId === undefined ? {} : { jobId }),
    },
    { base: makeBase(), fetcher: fetcherFor(rows), ...(normPicker === undefined ? {} : { normPicker }) },
  );
}

/** Модель отвечает по тексту работы: на каждую позицию — свой выбор. */
function picksBy(choose: (workName: string) => Partial<RawNormPick> | null): NormPicker {
  return async (batch) => ({
    picks: batch.items.flatMap((item) => {
      const choice = choose(item.workName);
      return choice === null ? [] : [{ id: item.id, pick: null, demolition: false, confidence: "high" as const, reason: "причина", ...choice }];
    }),
    tokens: 500,
    malformed: 0,
  });
}

const itemsOf = (result: Awaited<ReturnType<typeof run>>) => result.bill.sections.flatMap((section) => section.items);

describe("подбор нормы «ИИ-сметчиком» в расчёте сметы", () => {
  it("без подборщика расчёт прежний: подбор по наименованию, счётчики нулевые", async () => {
    const result = await run([ROW_SLOPES]);
    const [item] = itemsOf(result);
    // Подбор по словам выбрал «Демонтаж оконных коробок» (ГЭСНр 56-01-001-01) — ровно та ошибка, ради которой нужен выбор ИИ.
    expect(item?.normCode).toBeNull();
    expect(item?.aiNormPick).toBeUndefined();
    expect(result.normPick).toMatchObject({ requested: 0, picked: 0, tokens: 0, fallback: 0 });
    // Деньги за позицию не посчитаны: норма «Демонтаж оконных коробок» измеряется в «100 шт», а откосы — в м2.
    expect(result.document.gaps.some((gap) => gap.kind === "UNIT_MISMATCH" && gap.code === "56-01-001-01")).toBe(true);
  });

  it("выбор ИИ побеждает слабый подбор по наименованию: норма лежит в позиции, в строке сметы, а подпись называет причину", async () => {
    const picker = picksBy(() => ({ pick: "ГЭСН|15-01-070-01", demolition: true, reason: "откосная планка — облицовка проёма" }));
    const result = await run([ROW_SLOPES], picker);

    const [item] = itemsOf(result);
    expect(item).toMatchObject({ normCode: "15-01-070-01", normBaseType: "ГЭСН", unitDivisor: 1 });
    expect(item?.aiNormPick).toMatchObject({ reason: "откосная планка — облицовка проёма", review: false, demolition: true });
    expect(result.document.sections[0]?.lines[0]).toMatchObject({ normCode: "15-01-070-01", normBaseType: "ГЭСН" });

    const info = result.bill.rows.find((row) => row.itemId === item?.id);
    expect(info).toMatchObject({ basis: "AI", review: false });
    expect(info?.reviewReason).toContain("норма подобрана ИИ: откосная планка");

    expect(result.normPick).toMatchObject({ requested: 1, picked: 1, declined: 0, rejected: 0, fallback: 0, failedBatches: 0, batches: 1, tokens: 500, demolitionCoefficients: 1 });
  });

  it("demolition=true по норме деревянного настила: труд и машины × 0,8 — смета на 20 % ниже, чем без флага", async () => {
    const pick = { pick: "ГЭСН|10-01-111-01", reason: "настил" };
    const plain = await run([ROW_FLOOR], picksBy(() => ({ ...pick, demolition: false })));
    const dismantled = await run([ROW_FLOOR], picksBy(() => ({ ...pick, demolition: true })));

    const plainLine = plain.document.sections[0]?.lines[0];
    const dismantledLine = dismantled.document.sections[0]?.lines[0];
    expect(plainLine?.labourCost).toBeGreaterThan(0);
    expect(dismantledLine?.labourCost).toBeCloseTo((plainLine?.labourCost ?? 0) * 0.8, 2);
    expect(dismantled.document.totals.workCost).toBeLessThan(plain.document.totals.workCost);

    const [item] = itemsOf(dismantled);
    expect(item?.customerConditions?.special).toMatchObject({ id: "M571-P83-T2-R2", labour: 0.8, machines: 0.8, materials: 0 });
    expect(item?.customerConditions?.enabled).toBe(true);
    expect(dismantled.normPick.demolitionCoefficients).toBe(1);
    expect(plain.normPick.demolitionCoefficients).toBe(0);
  });

  it("переключатель «Применять коэффициенты заказчика» коэффициенты 571/пр, выбранные при подборе, не снимает: они не заказчика", async () => {
    const picker = picksBy(() => ({ pick: "ГЭСН|10-01-111-01", demolition: true, reason: "настил" }));
    const result = await buildEstimateFromDocuments(
      {
        regNumber: "0134300025826000377",
        subject: "Ремонт фасада",
        documents: [{ name: "ВОР.docx", text: TEXT }],
        parameters: makeParameters(),
        options: { ...NO_ESTIMATE_OPTIONS, applyCustomerCoefficients: false },
        now: new Date("2026-09-28T00:00:00.000Z"),
      },
      { base: makeBase(), fetcher: fetcherFor([ROW_FLOOR]), normPicker: picker },
    );
    expect(itemsOf(result)[0]?.customerConditions).toMatchObject({ enabled: true });
  });

  it("шифр из документа сильнее выбора ИИ: позиция с подсказкой шифра модели не отправляется вовсе", async () => {
    const seen: string[] = [];
    const picker: NormPicker = async (batch) => {
      seen.push(...batch.items.map((item) => item.workName));
      return { picks: batch.items.map((item) => ({ id: item.id, pick: "ГЭСН|26-01-066-01", demolition: false, confidence: "high" as const, reason: "x" })), tokens: 1, malformed: 0 };
    };
    const withCode = { ...ROW_SLOPES, justification: "ГЭСН15-01-070-01" };
    const result = await run([withCode, ROW_FENCE], picker);

    expect(seen).toEqual(["Демонтаж ограждения"]);
    const slopes = itemsOf(result).find((item) => item.workName === "Демонтаж оконных откосов");
    expect(slopes).toMatchObject({ normCode: "15-01-070-01", normBaseType: "ГЭСН" });
    expect(slopes?.aiNormPick).toBeUndefined();
    expect(result.bill.rows.find((row) => row.itemId === slopes?.id)?.basis).toBe("CODE");
  });

  it("выбор вне списка кандидатов отклоняется: позиция остаётся на подборе по наименованию", async () => {
    const outside = await run([ROW_SLOPES], picksBy(() => ({ pick: "ГЭСН|99-99-999-99", reason: "выдумка" })));
    expect(outside.normPick).toMatchObject({ requested: 1, picked: 0, rejected: 1 });
    expect(outside.normPick.notes[0]).toContain("вне списка кандидатов");
    expect(itemsOf(outside)[0]?.aiNormPick).toBeUndefined();
  });

  it("шифр, который есть в базе, но предложен другой позиции пачки, отклоняется: проверка идёт по кандидатам именно этой позиции", async () => {
    const picker: NormPicker = async (batch) => ({
      // Первой позиции отдаём ключ, найденный только для второй (деревянный настил), второй — ключ откосов.
      picks: batch.items.map((item) => ({
        id: item.id,
        pick: item.workName.includes("откосов") ? "ГЭСН|10-01-111-01" : "ГЭСН|15-01-070-01",
        demolition: false,
        confidence: "high" as const,
        reason: "перепутано",
      })),
      tokens: 1,
      malformed: 0,
    });
    const result = await run([ROW_SLOPES, ROW_FLOOR], picker);
    expect(result.normPick).toMatchObject({ requested: 2, picked: 0, rejected: 2 });
    expect(itemsOf(result).every((item) => item.aiNormPick === undefined)).toBe(true);
  });

  it("модель ответила «нормы нет» — позиция остаётся на подборе по наименованию, это не отказ", async () => {
    const result = await run([ROW_SLOPES], picksBy(() => ({ pick: null, reason: "ничего не подходит" })));
    expect(result.normPick).toMatchObject({ requested: 1, picked: 0, declined: 1, rejected: 0, fallback: 0 });
  });

  it("сбой пачки (HTTP, не JSON, таймаут) — тихий откат на подбор по наименованию, но в счётчиках: fallback и failedBatches", async () => {
    const picker: NormPicker = vi.fn(async () => {
      throw new Error("Прод не отдал подбор норм (HTTP 502): Модель вернула не JSON");
    });
    const result = await run([ROW_SLOPES, ROW_FLOOR, ROW_FENCE], picker);
    expect(result.billItems).toBe(3);
    expect(result.normPick).toMatchObject({ requested: 3, picked: 0, fallback: 3, failedBatches: 1, batches: 1, tokens: 0 });
    expect(result.normPick.notes[0]).toContain("Прод не отдал подбор норм");
    expect(itemsOf(result).every((item) => item.aiNormPick === undefined)).toBe(true);
    // Расчёт дошёл до конца: деньги по позициям с подобранной по словам нормой те же, что без подборщика.
    const baseline = await run([ROW_SLOPES, ROW_FLOOR, ROW_FENCE]);
    expect(result.document.totals.workCost).toBe(baseline.document.totals.workCost);
  });

  it("модель пропустила позицию — она откатывается на подбор по наименованию и считается в fallback", async () => {
    const result = await run([ROW_SLOPES, ROW_FENCE], picksBy((name) => (name.includes("откосов") ? { pick: "ГЭСН|15-01-070-01", demolition: true, reason: "планка" } : null)));
    expect(result.normPick).toMatchObject({ requested: 2, picked: 1, fallback: 1 });
  });

  it("пачки идут по десять: двенадцать позиций — два вызова; ответ второй пачки не теряется при сбое первой", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      work_name: `Демонтаж оконных откосов № ${String(index + 1)}`,
      quantity: "10",
      unit: "м2",
      evidence_quote: `Демонтаж оконных откосов № ${String(index + 1)} | м2 | 10`,
    }));
    const text = rows.map((row) => row.evidence_quote).join("\n");
    let call = 0;
    const picker: NormPicker = async (batch) => {
      call += 1;
      if (call === 1) throw new Error("таймаут");
      return { picks: batch.items.map((item) => ({ id: item.id, pick: "ГЭСН|15-01-070-01", demolition: false, confidence: "high" as const, reason: "планка" })), tokens: 70, malformed: 0 };
    };
    const result = await buildEstimateFromDocuments(
      { regNumber: "T", subject: "s", documents: [{ name: "ВОР.docx", text }], parameters: makeParameters(), now: new Date("2026-09-28T00:00:00.000Z") },
      { base: makeBase(), fetcher: fetcherFor(rows), normPicker: picker },
    );
    expect(result.normPick).toMatchObject({ requested: 12, batches: 2, failedBatches: 1 });
    // Какая из двух пачек упала, зависит от порядка выполнения, но суммарно: 10 + 2 позиции, одна пачка потеряна целиком.
    expect(result.normPick.picked + result.normPick.fallback).toBe(12);
    expect(result.normPick.tokens).toBe(70);
  });

  it("заглушка NO_NORM_PICKER (бенчмарк по ЛСР) ничего не выбирает и не стоит вызовов", async () => {
    const result = await run([ROW_SLOPES], NO_NORM_PICKER);
    expect(result.normPick).toMatchObject({ requested: 0, picked: 0, fallback: 0, batches: 0 });
  });

  it("jobId расчёта доезжает до подборщика: расход ляжет в журнал с заданием", async () => {
    const batches: { jobId?: string | null; regNumber: string }[] = [];
    const picker: NormPicker = async (batch) => {
      batches.push({ jobId: batch.context.jobId, regNumber: batch.context.regNumber });
      return { picks: [], tokens: 0, malformed: 0 };
    };
    await run([ROW_SLOPES], picker, "sync-21");
    expect(batches).toEqual([{ jobId: "sync-21", regNumber: "0134300025826000377" }]);
  });
});
