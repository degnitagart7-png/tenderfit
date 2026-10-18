import { describe, expect, it } from "vitest";

import { buildRowInfos } from "@/domain/estimate/billReview";
import { compareWithCustomerEstimate, describeComparisonEstimate } from "@/domain/estimate/customerComparison";
import { parseCustomerEstimates } from "@/domain/estimate/customerEstimate";
import { parseCustomerLsr, type CustomerLsr, type CustomerPosition } from "@/domain/estimate/customerLsr";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet, lsrSourceInfo } from "@/domain/estimate/customerLsrSet";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { CustomerAuditUnavailableError, runCustomerAudit } from "@/services/customerAuditService";
import { customerBaseGaps } from "@/services/estimateService";
import type { EstimateLine } from "@/domain/estimate/types";
import { NORM_MANUAL_GRADING, makeBillItem } from "@/test/estimateFixtures";
import {
  RIM_DEMOLITION_NAME,
  RIM_DEMOLITION_TEXT,
  RIM_DEMOLITION_TOTALS,
  RIM_SECTIONS_NAME,
  RIM_SECTIONS_TEXT,
  RIM_SUPPLY_NAME,
  RIM_SUPPLY_TEXT,
  TSN_2001_NAME,
  TSN_2001_TEXT,
} from "@/test/smetaRuFixtures";

/*
  ЛСР Smeta.RU → ведомость кодом. Ресурсно-индексная смета читается как Гранд-Смета (шифры ГЭСН, цены заказчика, остаток позиции, коэффициенты).
  Смета по ТСН-2001 Москвы: норм ТСН у нас нет — шифр в подсказку не читается, подбор по наименованию с пометкой «проверьте», цена заказчика
  как запасной вариант, одна пометка о базе на документ.
*/

const setOf = (documents: readonly { name: string; text: string }[]) => buildLsrSet(parseCustomerLsr(documents).estimates);
const billOf = (set: ReturnType<typeof setOf>, index: number) => lsrBillSection(set.entries[index] as (typeof set.entries)[number], index + 1);

describe("lsrBillSection: ресурсно-индексная ЛСР Smeta.RU (вырезка закупки 32616439079)", () => {
  const set = setOf([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }]);
  const { section, skipped } = billOf(set, 0);
  const item = (label: string) => section.items.find((candidate) => candidate.positionNumber === label);

  it("все 8 позиций в ведомости; цены заказчика складываются в итог сметы без НДС — деньги не теряются", () => {
    expect(skipped).toEqual([]);
    expect(section.items.filter((candidate) => candidate.unaccountedOf === undefined)).toHaveLength(8);
    const sum = section.items.reduce((total, candidate) => total + (candidate.customerPrice?.total ?? 0), 0);
    expect(sum).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
    expect(set.entries[0]?.totalExVat).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
    expect(set.entries[0]?.totalWithVat).toBeCloseTo(RIM_DEMOLITION_TOTALS.total, 2);
  });

  it("шифр расценки читается из «ГЭСНр 58-01-003-01», объём «100 м × 0,0346» → 3,46 м; ГЭСН/ГЭСНм/ГЭСНр различаются", () => {
    expect(item("1")?.normCodeHint).toMatchObject({ baseType: "ГЭСНр", code: "58-01-003-01" });
    expect(item("1")?.quantity).toBeCloseTo(3.46, 9);
    expect(item("1")?.quantityUnit).toBe("м");
    expect(item("1")?.foreignBase).toBeUndefined();
    expect(item("3")?.normCodeHint).toMatchObject({ baseType: "ГЭСН", code: "09-04-012-01" });
    expect(item("8")?.normCodeHint).toMatchObject({ baseType: "ГЭСНм", code: "10-08-002-02" });
    expect(item("1")?.customerPrice?.total).toBeCloseTo(447.4, 2);
  });

  it("демонтаж по 571/пр: коэффициент подтверждён по значению и идёт в позицию; 0,3 и поправки ремонта — подсказка", () => {
    expect(item("3")?.customerConditions?.special).toMatchObject({ id: "M571-P83-T2-R4", labour: 0.7, machines: 0.7, materials: 0 });
    expect(item("8")?.customerConditions?.special).toMatchObject({ id: "M571-P84-T3-R2", labour: 0.6 });
    expect(item("9")?.customerConditions?.special?.id).toBe("M571-P83-T2-R4");
    expect(item("6")?.customerConditions?.special).toBeUndefined();
    expect(item("6")?.customerConditions?.rejected).toHaveLength(1);
    expect(item("17")?.customerConditions?.confirmed).toBeNull();
    expect(item("17")?.customerCoefficients).toBe("ЭМ *1,25; ЗТ *1,15; ЗТм *1,25; НР *0,9; СП *0,85");
  });

  it("подстрока «8.1 2 %» входит в «Всего по позиции»: невидимый остаток позиции 8 — отдельной строкой по сумме заказчика", () => {
    const rest = section.items.find((candidate) => candidate.unaccountedOf === "l1-8");
    expect(rest?.customerPrice?.total).toBeCloseTo(29.84, 2);
    expect(item("8")?.customerPrice?.total).toBeCloseTo(3521.26, 2);
  });

  it("ТЦ — оборудование по цене заказчика без нормы; код ФСБЦ — поставка по справочнику цен", () => {
    expect(item("15")).toMatchObject({ customerPriceOnly: true, normCodeHint: null, resourceCode: null });
    expect(item("15")?.customerPrice?.total).toBeCloseTo(23_133.94, 2);
    expect(item("16")).toMatchObject({ resourceCode: "01.7.04.01-1012", normCodeHint: null });
  });

  it("позиция в разделе заказчика; идентификаторы уникальны", () => {
    expect(item("1")?.billSection).toBe("Коридор 1-й этаж");
    expect(new Set(section.items.map((candidate) => candidate.id)).size).toBe(section.items.length);
  });
});

describe("lsrBillSection: другие листы Smeta.RU — подпозиции поставки и ТЦ", () => {
  it("Смета_9: подстроки 4.1 (ФСБЦ), 4.2 (2 %) — остаток позиции 4 по сумме заказчика; сумма цен — итог сметы", () => {
    const set = setOf([{ name: RIM_SUPPLY_NAME, text: RIM_SUPPLY_TEXT }]);
    const { section, skipped } = billOf(set, 0);
    expect(skipped).toEqual([]);
    const rest = section.items.find((candidate) => candidate.unaccountedOf === "l1-4");
    expect(rest?.customerPrice?.total).toBeCloseTo(9727.98 + 476.85, 2);
    const sum = section.items.reduce((total, candidate) => total + (candidate.customerPrice?.total ?? 0), 0);
    expect(sum).toBeCloseTo(503_149.79, 1);
    expect(set.entries[0]?.totalExVat).toBeCloseTo(503_149.79, 2);
  });

  it("Смета_3: ТЦ-подпозиция 4.1 (245 640,61 ₽) не теряется: цена позиции 4 — «Всего по позиции» целиком", () => {
    const set = setOf([{ name: RIM_SECTIONS_NAME, text: RIM_SECTIONS_TEXT }]);
    const { section } = billOf(set, 0);
    const sum = section.items.reduce((total, candidate) => total + (candidate.customerPrice?.total ?? 0), 0);
    expect(sum).toBeCloseTo(951_062.01, 1);
    expect(section.items.find((candidate) => candidate.positionNumber === "4")?.customerPrice?.total).toBeCloseTo(283_305.34, 2);
  });
});

describe("ТСН-2001 Москвы: позиции, объёмы и итоги читаются; база названа", () => {
  const parsed = parseCustomerLsr([{ name: TSN_2001_NAME, text: TSN_2001_TEXT }]);
  const [reconstruction, commissioning] = parsed.estimates as [CustomerLsr, CustomerLsr];
  const position = (estimate: CustomerLsr, label: string): CustomerPosition => estimate.positions.find((item) => item.label === label) as CustomerPosition;

  it("две сметы, номера и наименования из шапки, база «ТСН-2001 (Москва)»", () => {
    expect(parsed.estimates).toHaveLength(2);
    expect([reconstruction.estimateNumber, reconstruction.title]).toEqual(["02-01-01", "Реконструкция РП-10кВ"]);
    expect([commissioning.estimateNumber, commissioning.title]).toEqual(["09-01-01", "ПНР РП"]);
    expect(reconstruction.base).toBe("TSN_2001_MOSCOW");
    expect(reconstruction.method).toBeUndefined();
  });

  it("итог сметы — в текущем уровне цен (вторая колонка пары «базис, текущий»), а не в базисном уровне 2001 года", () => {
    expect(reconstruction.total).toBeCloseTo(2_995_912.9, 2);
    expect(reconstruction.sectionsTotal).toBeCloseTo(2_995_912.9, 2);
    expect(reconstruction.positionsTotal).toBeCloseTo(2_995_912.9, 2);
    expect(reconstruction.headerTotalThousands).toBeCloseTo(2995.92, 2);
    expect(commissioning.total).toBeCloseTo(200_277, 2);
    expect(commissioning.positionsTotal).toBeCloseTo(200_277, 2);
    expect(reconstruction.vatPercent).toBeNull();
    const [first, second] = parseCustomerEstimates([{ name: TSN_2001_NAME, text: TSN_2001_TEXT }]);
    expect([first?.method, first?.base, first?.checked, first?.statedTotal]).toEqual(["BASE_2001", "TSN_2001_MOSCOW", true, 2_995_912.9]);
    expect([second?.method, second?.base, second?.checked, second?.statedTotal]).toEqual(["BASE_2001", "TSN_2001_MOSCOW", true, 200_277]);
  });

  it("позиция по норме ТСН: шифр «4.8-61-4», единица «1 ШТ.» → «ШТ.», группы ЗП / ЭМ / в т. ч. ЗПМ / МР, НР и СП от ФОТ", () => {
    const camera = position(reconstruction, "1");
    expect(camera).toMatchObject({ code: "4.8-61-4", book: "OTHER_BASE", unit: "ШТ.", quantity: 1, total: 41_517.41, directTotal: null });
    expect(camera.name).toBe("Монтаж сборной камеры распределительных устройств с выключателем нагрузки серии КСО");
    expect(camera.groupTotals).toEqual({ labour: 16_282.07, machines: 607.26, machinistLabour: 301.79, materials: 83.97 });
    expect(camera.overhead).toMatchObject({ ref: null, basePercent: 97, percent: 97, amount: 16_086.34 });
    expect(camera.profit).toMatchObject({ ref: null, basePercent: 51, percent: 51, amount: 8457.77 });
    // ЗП + ЭМ (с ЗПМ) + МР + НР + СП = стоимость позиции.
    const { labour, machines, materials } = camera.groupTotals;
    expect((labour ?? 0) + (machines ?? 0) + (materials ?? 0) + (camera.overhead?.amount ?? 0) + (camera.profit?.amount ?? 0)).toBeCloseTo(41_517.41, 2);
    expect(position(commissioning, "2")).toMatchObject({ code: "2.1-8-3", quantity: 8, unit: "маш.-ч", total: 30_776.89 });
  });

  it("оборудование по КП: цена заказчика, итог позиции — 2 954 395,49 ₽ в текущем уровне цен (в базисном 391 829,64)", () => {
    const rack = position(reconstruction, "2");
    expect(rack.book).toBe("CUSTOMER_PRICE");
    expect(rack.unit).toBe("КОМПЛ");
    expect(rack.total).toBeCloseTo(2_954_395.49, 2);
    expect(rack.ownBasePrice).toBeCloseTo(391_829.64, 2);
    expect(rack.ownIndex).toBeCloseTo(7.54, 2);
  });

  it("набор смет и сведения о ней несут базу; подпись источника называет её", () => {
    const set = buildLsrSet(parsed.estimates);
    expect(set.entries.map((entry) => entry.base)).toEqual(["TSN_2001_MOSCOW", "TSN_2001_MOSCOW"]);
    expect(set.entries.map((entry) => entry.totalExVat)).toEqual([2_995_912.9, 200_277]);
    expect(lsrSourceInfo(set.entries[0] as (typeof set.entries)[number]).base).toBe("TSN_2001_MOSCOW");

    const [estimate] = parseCustomerEstimates([{ name: TSN_2001_NAME, text: TSN_2001_TEXT }]);
    const comparison = compareWithCustomerEstimate({ sections: [], gaps: [], totals: { workCost: 0 } } as never, estimate === undefined ? [] : [estimate]);
    expect(comparison.status).toBe("BASE_PRICES_ONLY");
    expect(comparison.baseEstimates[0]?.base).toBe("TSN_2001_MOSCOW");
    expect(describeComparisonEstimate(comparison.baseEstimates[0] as (typeof comparison.baseEstimates)[number])).toContain("база норм: ТСН-2001 (Москва)");
  });
});

describe("ТСН-2001 в ведомости: подбор по наименованию, а не по шифру", () => {
  const set = setOf([{ name: TSN_2001_NAME, text: TSN_2001_TEXT }]);
  const { section, skipped } = billOf(set, 0);

  it("позиции по норме ТСН помечены чужой базой, подсказки шифра нет; цена заказчика — запасной вариант", () => {
    expect(skipped).toEqual([]);
    const [camera, rack] = section.items;
    expect(camera).toMatchObject({ positionNumber: "1", foreignBase: "TSN_2001_MOSCOW", normCodeHint: null, normCode: null, resourceCode: null });
    expect(camera?.customerPrice?.total).toBeCloseTo(41_517.41, 2);
    expect(camera?.quantity).toBe(1);
    expect(camera?.quantityUnit).toBe("шт");
    expect(camera?.sourceLevel).toBe("CUSTOMER_ESTIMATE");
    // КП — цена заказчика и ничего другого: подбор нормы для неё не запускается и чужой базой не помечается.
    expect(rack).toMatchObject({ customerPriceOnly: true, normCodeHint: null });
    expect(rack?.foreignBase).toBeUndefined();
    const sum = section.items.reduce((total, candidate) => total + (candidate.customerPrice?.total ?? 0), 0);
    expect(sum).toBeCloseTo(2_995_912.9, 1);
  });

  it("шифр ТСН, похожий на ГЭСН («13-02-004-01»), в подсказку не попадает; в ресурсной смете тот же шифр читается как ГЭСН", () => {
    const lookalike = TSN_2001_TEXT.replace("1,4.8-61-4,", "1,ТСН-2001.13 13-02-004-01,");
    expect(lookalike).not.toBe(TSN_2001_TEXT);
    const tsn = billOf(setOf([{ name: TSN_2001_NAME, text: lookalike }]), 0).section.items[0];
    expect(tsn?.normCodeHint).toBeNull();
    expect(tsn?.foreignBase).toBe("TSN_2001_MOSCOW");

    // Контроль: у ресурсно-индексной сметы шифр ГЭСН читается, и подсказка остаётся.
    const resource = billOf(setOf([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }]), 0).section.items[0];
    expect(resource?.normCodeHint?.code).toBe("58-01-003-01");
  });

  it("«Ведомость и нормы»: подбор по наименованию у позиции ТСН всегда «проверьте», причина названа; у обычной позиции — нет", () => {
    const index = createNormSearchIndex([NORM_MANUAL_GRADING]);
    const workName = "Планировка вручную дна и откосов выемок каналов";
    const plain = makeBillItem({ id: "p", workName, normCode: null, normBaseType: null });
    const tsn = makeBillItem({ id: "t", workName, normCode: null, normBaseType: null, foreignBase: "TSN_2001_MOSCOW" });

    // Расчёт подобрал норму по наименованию (строка без цены заказчика и без своей цены) — у обеих позиций.
    const lineOf = (itemId: string): EstimateLine =>
      ({ itemId, normCode: NORM_MANUAL_GRADING.code, normBaseType: NORM_MANUAL_GRADING.baseType, resources: [], gaps: [] }) as unknown as EstimateLine;
    const lines = new Map([["p", lineOf("p")], ["t", lineOf("t")]]);
    const rows = buildRowInfos({ items: [plain, tsn], lines, index });
    expect(rows.find((row) => row.itemId === "p")).toMatchObject({ basis: "NAME", review: false });
    const flagged = rows.find((row) => row.itemId === "t");
    expect(flagged).toMatchObject({ basis: "NAME", review: true });
    expect(flagged?.reviewReason).toContain("ТСН-2001 (Москва)");
    expect(flagged?.reviewReason).toContain("норм ТСН у нас нет");
  });
});

describe("пометка документа: смета заказчика по ТСН-2001, наша — по ФСНБ-2022", () => {
  it("одна пометка на документ, сколько бы смет по ТСН ни нашлось; называет обе базы и обе сметы", () => {
    const set = setOf([{ name: TSN_2001_NAME, text: TSN_2001_TEXT }]);
    const gaps = customerBaseGaps(set.entries.map(lsrSourceInfo));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "CUSTOMER_BASE_DIFFERS", code: null, baseType: null });
    expect(gaps[0]?.message).toContain("ТСН-2001 (Москва)");
    expect(gaps[0]?.message).toContain("ФСНБ-2022");
    expect(gaps[0]?.message).toContain("like-for-like");
    expect(gaps[0]?.message).toContain("02-01-01, 09-01-01");
    expect(gaps[0]?.message).toContain("позиций: 4");
  });

  it("у ресурсно-индексной сметы пометки нет; смесь — пометка только о ТСН", () => {
    expect(customerBaseGaps(setOf([{ name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT }]).entries.map(lsrSourceInfo))).toEqual([]);
    const mixed = setOf([
      { name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT },
      { name: TSN_2001_NAME, text: TSN_2001_TEXT },
    ]);
    const gaps = customerBaseGaps(mixed.entries.map(lsrSourceInfo));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.message).toContain("сметы 02-01-01, 09-01-01");
    expect(customerBaseGaps([])).toEqual([]);
  });
});

describe("проверка сметы заказчика (аудит): смету по ТСН построчно проверять нечем", () => {
  it("документ только со сметой ТСН — отказ с причиной «ТСН-2001 (Москва)», а не пустой отчёт с нулевым покрытием", async () => {
    const zone = { priceZoneId: 1, zoneName: "город Москва (1 зона)", basis: "AUTO", matched: null, northZone: "NONE" } as never;
    const error = await runCustomerAudit([{ name: TSN_2001_NAME, text: TSN_2001_TEXT }], zone).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CustomerAuditUnavailableError);
    expect((error as Error).message).toContain("ТСН-2001 (Москва)");
    expect((error as Error).message).toContain("норм этой базы у нас нет");
  });
});
