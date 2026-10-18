import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NO_ESTIMATE_OPTIONS, normalizeEstimateOptions, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { NO_LIMITED_SOURCE, resolveLimited } from "@/domain/estimate/limitedCosts";
import { computeTemporaryStructures } from "@/domain/estimate/temporaryStructures";
import { computeWinterSurcharge, overlapsWinter, resolveWinterZone, winterPartsOf } from "@/domain/estimate/winterSurcharge";
import { brokenKindReferences, detectKindHint, detectPhaseHint, workKindById, WORK_KINDS } from "@/domain/estimate/workKinds";
import { extractWorkPeriod, detectWinterMention } from "@/domain/estimate/workPeriod";
import { winterZonePart } from "@/domain/estimate/normatives";
import { normalizeRegionText } from "@/domain/regions";

/*
  Зимнее удорожание (325/пр) и временные здания (332/пр): зона по региону и муниципалитету, период
  работ, вид работ. Числа — из приложений приказов (data/fsnb/normatives), закупка 0134600012126000001:
  снос жилого дома, Иркутская область, Иркутский район, д. Сосновый бор.
*/

const words = (text: string): string[] => normalizeRegionText(text).split(" ").filter((word) => word !== "");
const IRKUTSK_ADDRESS = "Иркутская область, Иркутский район, д. Сосновый бор, ул. Мелехова, д. 4";

function winter(kind: string | null, overrides: Partial<Parameters<typeof computeWinterSurcharge>[0]> = {}) {
  return computeWinterSurcharge({
    kind: workKindById(kind),
    subject: "Иркутская область",
    words: words(IRKUTSK_ADDRESS),
    ...overrides,
  });
}

describe("справочник видов работ", () => {
  it("каждая ссылка каталога указывает на строку справочников нормативов", () => {
    expect(brokenKindReferences()).toEqual([]);
    expect(new Set(WORK_KINDS.map((kind) => kind.id)).size).toBe(WORK_KINDS.length);
  });

  it("подсказка по названию закупки: снос, капремонт кровли", () => {
    expect(detectPhaseHint("Снос (демонтаж) объекта капитального строительства, расположенное по адресу: Иркутская область")?.phase).toBe("DEMOLITION");
    expect(detectPhaseHint("Капитальный ремонт кровли здания школы")?.phase).toBe("CAPITAL_REPAIR");
    expect(detectKindHint("CAPITAL_REPAIR", "Капитальный ремонт кровли здания школы")?.kind.id).toBe("CR_ROOF_PIECE");
    expect(detectPhaseHint("Поставка канцелярских товаров")).toBeNull();
  });
});

describe("температурная зона: Иркутская область и Бурятия", () => {
  it("Иркутский район — «остальная территория области», V зона, 10.10-25.04, коэффициент 1 (приложение 4, п. 42.3), с допущением", () => {
    const result = resolveWinterZone("Иркутская область", words(IRKUTSK_ADDRESS));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.part).toMatchObject({ item: "42.3", zone: "V", winterStart: "10.10", winterEnd: "25.04", coefficient: 1 });
    expect(result.basis).toBe("REST");
    expect(result.assumption).toContain("остальная территория области");
  });

  it("Бурятия, Улан-Удэ — остальная территория, V зона; севернее линии Нижнеангарск - Шипишка — VI зона ×0,9, по выбору", () => {
    const rest = resolveWinterZone("Республика Бурятия", words("г. Улан-Удэ"));
    expect(rest.ok && rest.part).toMatchObject({ item: "4.2", zone: "V", winterStart: "15.10", winterEnd: "25.04", coefficient: 1 });
    const north = winterZonePart("A4-4.1");
    expect(north).toMatchObject({ zone: "VI", coefficient: 0.9 });
    const chosen = resolveWinterZone("Республика Бурятия", [], "A4-4.1");
    expect(chosen.ok && chosen.basis).toBe("USER");
  });

  it("Бурятия, Северо-Байкальский район: северная часть линией — часть по закупке не выбирается, нужен выбор человека", () => {
    const result = resolveWinterZone("Республика Бурятия", words("Северо-Байкальский район, п. Нижнеангарск"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.candidates.map((part) => part.item)).toEqual(["4.1", "4.2"]);
    expect(result.reason).toContain("вручную");
  });

  it("Якутия: часть названа списком улусов — Якутск → п. 15.6; без названия — выбор человека (остальной территории нет)", () => {
    const byUnit = resolveWinterZone("Республика Саха (Якутия)", words("г. Якутск, ул. Ленина"));
    expect(byUnit.ok && byUnit.part.item).toBe("15.6");
    const none = resolveWinterZone("Республика Саха (Якутия)", words("Вилюйский район"));
    expect(none.ok && none.part.item).toBe("15.6");
    const unknown = resolveWinterZone("Республика Саха (Якутия)", []);
    expect(unknown.ok).toBe(false);
  });

  it("субъект без деления и субъект вне приложения; ХМАО — по Тюменской области", () => {
    expect(winterPartsOf("Воронежская область")).toHaveLength(1);
    expect(winterPartsOf("Республика Адыгея")).toHaveLength(1);
    expect(winterPartsOf("Ханты-Мансийский автономный округ — Югра").length).toBeGreaterThan(1);
    expect(winterPartsOf("Не субъект")).toEqual([]);
    const unknown = resolveWinterZone(null, []);
    expect(unknown.ok).toBe(false);
  });
});

describe("период работ и зимний период части субъекта", () => {
  const part = winterZonePart("A4-42.3");
  if (part === null) throw new Error("нет части Иркутской области");

  it("сентябрь-ноябрь: пересекается (с 10 октября)", () => {
    expect(overlapsWinter(part, "2026-09-01", "2026-11-30")).toBe(true);
    expect(overlapsWinter(part, "2026-09-01", "2026-10-09")).toBe(false);
    expect(overlapsWinter(part, "2026-10-10", "2026-10-10")).toBe(true);
  });

  it("лето — не пересекается; декабрь-февраль пересекается; зимний период переходит через Новый год", () => {
    expect(overlapsWinter(part, "2026-06-01", "2026-08-31")).toBe(false);
    expect(overlapsWinter(part, "2026-12-01", "2027-02-28")).toBe(true);
    expect(overlapsWinter(part, "2027-04-26", "2027-10-09")).toBe(false);
    expect(overlapsWinter(part, "2027-04-20", "2027-05-20")).toBe(true);
  });

  it("год и больше всегда задевает зиму; перевёрнутые даты — нет", () => {
    expect(overlapsWinter(part, "2026-06-01", "2027-06-01")).toBe(true);
    expect(overlapsWinter(part, "2026-12-01", "2026-06-01")).toBe(false);
  });

  it("зимний период внутри года (Краснодарский край, г. Анапа 5.01-31.01)", () => {
    const anapa = winterZonePart("A4-26.3");
    if (anapa === null) throw new Error("нет части");
    expect(overlapsWinter(anapa, "2026-02-01", "2026-12-31")).toBe(false);
    expect(overlapsWinter(anapa, "2026-01-20", "2026-02-10")).toBe(true);
  });
});

describe("зимнее удорожание: расчёт процента", () => {
  it("снос (разборка) в Иркутском районе, работы сентябрь-ноябрь: НДЗ п. 88 для V зоны 6,77 % × 1 (закупка 0134600012126000001)", () => {
    const result = winter("DEM_DISMANTLE", { period: { start: "2026-09-01", end: "2026-11-30" } });
    expect(result.percent).toBe(6.77);
    expect(result.applied).toMatchObject({ code: "WINTER", applied: true, value: "6,77 %" });
    expect(result.applied.source).toContain("приложение 1, п. 88");
    expect(result.applied.source).toContain("приложение 4, п. 42.3");
    expect(result.applied.assumption).toContain("остальная территория области");
  });

  it("ремонт летом — 0 по п. 9: не из-за неизвестных данных, а потому что НДЗ летом не применяются", () => {
    const result = winter("CR_RES_BRICK", { period: { start: "2026-06-01", end: "2026-08-31" } });
    expect(result.percent).toBe(0);
    expect(result.applied).toMatchObject({ applied: false });
    expect(result.applied.missingData).toBe(false);
    expect(result.applied.reason).toContain("п. 9");
  });

  it("ремонт с декабря по февраль: норматив таблицы приложения 2 (кирпичное жилое здание, V зона) 2,35 %", () => {
    const result = winter("CR_RES_BRICK", { period: { start: "2026-12-01", end: "2027-02-28" } });
    expect(result.percent).toBe(2.35);
    expect(result.applied.source).toContain("приложение 2, п. 1.1");
  });

  it("часть зимы: норматив среднегодовой и применяется на весь период (п. 11) — пропорции нет", () => {
    const winterOnly = winter("CR_RES_BRICK", { period: { start: "2026-12-01", end: "2027-02-28" } });
    const partial = winter("CR_RES_BRICK", { period: { start: "2027-04-20", end: "2027-05-20" } });
    expect(partial.percent).toBe(winterOnly.percent);
    expect(partial.applied.text).toContain("п. 11");
  });

  it("коэффициент части субъекта: Бурятия севернее линии — VI зона ×0,9 (5,95 % для кровли из рулонных материалов × 0,9)", () => {
    const result = computeWinterSurcharge({
      kind: workKindById("CR_ROOF_ROLL"),
      subject: "Республика Бурятия",
      words: [],
      partId: "A4-4.1",
      winterWork: "YES",
    });
    expect(result.percent).toBeCloseTo(5.355, 4);
    expect(result.applied.value).toBe("5,355 %");
  });

  it("периода нет и пользователь не указал: 0 и причина «не известен период работ» — данные неизвестны", () => {
    const result = winter("DEM_DISMANTLE");
    expect(result.percent).toBe(0);
    expect(result.applied).toMatchObject({ applied: false, missingData: true });
    expect(result.applied.reason).toBe("зимнее удорожание не начислено: не известен период работ");
  });

  it("выбор «зимой: да / часть» без дат — по ответу; «нет» — 0 без пробела данных; даты главнее ответа", () => {
    expect(winter("DEM_DISMANTLE", { winterWork: "YES" }).percent).toBe(6.77);
    expect(winter("DEM_DISMANTLE", { winterWork: "PART" }).percent).toBe(6.77);
    const no = winter("DEM_DISMANTLE", { winterWork: "NO" });
    expect(no.percent).toBe(0);
    expect(no.applied.missingData).toBe(false);
    expect(winter("DEM_DISMANTLE", { winterWork: "NO", period: { start: "2026-12-01", end: "2027-01-31" } }).percent).toBe(6.77);
  });

  it("вид работ не указан — 0 и причина; зона не определена — 0 и причина", () => {
    const noKind = winter(null, { winterWork: "YES" });
    expect(noKind.applied).toMatchObject({ applied: false, missingData: true });
    expect(noKind.applied.reason).toContain("не указан вид работ");
    const noZone = computeWinterSurcharge({ kind: workKindById("DEM_DISMANTLE"), subject: null, words: [], winterWork: "YES" });
    expect(noZone.applied.reason).toContain("регион закупки не определён");
  });

  it("прочерк в таблице (озеленение, VII зона) — норматива нет, 0", () => {
    const result = computeWinterSurcharge({
      kind: workKindById("CR_GREENING"),
      subject: "Республика Саха (Якутия)",
      words: words("г. Якутск"),
      winterWork: "YES",
    });
    expect(result.percent).toBe(0);
    expect(result.applied.reason).toContain("прочерк");
  });
});

describe("временные здания и сооружения (332/пр)", () => {
  it("снос: норматива в процентах нет (п. 29), 0 без пробела данных", () => {
    const result = computeTemporaryStructures(workKindById("DEM_DISMANTLE"));
    expect(result.percent).toBe(0);
    expect(result.applied).toMatchObject({ applied: false, missingData: false });
    expect(result.applied.reason).toContain("п. 29");
  });

  it("капремонт жилого здания в целом — приложение 2, п. 1.1: 0,9 %; общественного — 1,2 %; кровли — 0,4 %", () => {
    expect(computeTemporaryStructures(workKindById("CR_RES_BRICK")).percent).toBe(0.9);
    expect(computeTemporaryStructures(workKindById("CR_PUBLIC")).percent).toBe(1.2);
    expect(computeTemporaryStructures(workKindById("CR_ROOF_PIECE")).percent).toBe(0.4);
    expect(computeTemporaryStructures(workKindById("CR_RES_BRICK")).applied.source).toContain("приложение 2, п. 1.1");
  });

  it("реконструкция — приложение 1 с коэффициентом 0,8 (п. 25): жилое 1,1 × 0,8 = 0,88 %; новое строительство — 1,1 %", () => {
    const reconstruction = computeTemporaryStructures(workKindById("RC_RES_BRICK"));
    expect(reconstruction.percent).toBe(0.88);
    expect(reconstruction.applied.text).toContain("п. 25");
    expect(computeTemporaryStructures(workKindById("NC_RES_BRICK")).percent).toBe(1.1);
  });

  it("вид работ не указан — 0 и пробел данных", () => {
    expect(computeTemporaryStructures(null).applied).toMatchObject({ applied: false, missingData: true });
  });
});

describe("resolveLimited: сведение выбора пользователя в параметры расчёта", () => {
  const context = { region: "Иркутская область", address: IRKUTSK_ADDRESS, customerName: "", subject: "Снос (демонтаж) объекта" };

  it("без выбора — нули и прежняя подпись, нет условий и записей: старые суммы сохраняются", () => {
    const resolved = resolveLimited(NO_ESTIMATE_OPTIONS, context);
    expect(resolved.limited).toEqual({ winterSurchargePercent: 0, temporaryStructuresPercent: 0, source: NO_LIMITED_SOURCE });
    expect(resolved.workConditions).toBeUndefined();
    expect(resolved.appliedNormatives).toEqual([]);
  });

  it("снос, сентябрь-ноябрь: зимнее 6,77 %, временные 0 с причиной; обе записи в нормативах", () => {
    const options: EstimateOptions = {
      ...NO_ESTIMATE_OPTIONS,
      phase: "DEMOLITION",
      workKind: "DEM_DISMANTLE",
      workPeriod: { start: "2026-09-01", end: "2026-11-30" },
    };
    const resolved = resolveLimited(options, context);
    expect(resolved.limited.winterSurchargePercent).toBe(6.77);
    expect(resolved.limited.temporaryStructuresPercent).toBe(0);
    expect(resolved.appliedNormatives.map((item) => [item.code, item.applied])).toEqual([
      ["WINTER", true],
      ["TEMPORARY", false],
    ]);
    expect(resolved.sources.map((source) => source.title).join(" ")).toContain("325/пр");
    expect(resolved.limited.source).toContain("зимнее удорожание 6,77 %");
  });

  it("ремонт и условия: параметры несут условия работ, источники включают 421/пр", () => {
    const resolved = resolveLimited(
      { ...NO_ESTIMATE_OPTIONS, phase: "CAPITAL_REPAIR", workKind: "CR_RES_BRICK", conditionIds: ["T5-8"], winterWork: "NO" },
      context,
    );
    expect(resolved.workConditions).toEqual({ phase: "CAPITAL_REPAIR", conditionIds: ["T5-8"], newConstructionNorms: false });
    expect(resolved.limited.temporaryStructuresPercent).toBe(0.9);
    expect(resolved.limited.winterSurchargePercent).toBe(0);
    expect(resolved.sources.some((source) => source.title.includes("421/пр"))).toBe(true);
  });

  it("Север: Якутия — запись о РКС и о том, что районные коэффициенты уже в ставках; северность не определена — допущение", () => {
    const yakutia = resolveLimited(NO_ESTIMATE_OPTIONS, { ...context, region: "Республика Саха (Якутия)", north: { zone: "RKS", basis: "SUBJECT", matched: "Республика Саха (Якутия)" } });
    expect(yakutia.appliedNormatives.map((item) => item.code)).toEqual(["NORTH", "NORTH_WAGE"]);
    expect(yakutia.appliedNormatives[1]).toMatchObject({ applied: false });
    const unknown = resolveLimited(NO_ESTIMATE_OPTIONS, { ...context, north: { zone: "TERRITORY", basis: "UNDETERMINED" } });
    expect(unknown.appliedNormatives[0]).toMatchObject({ code: "NORTH", applied: false, missingData: true });
    const plain = resolveLimited(NO_ESTIMATE_OPTIONS, { ...context, north: { zone: "TERRITORY", basis: "NONE" } });
    expect(plain.appliedNormatives).toEqual([]);
  });
});

describe("выбор пользователя: разбор присланного", () => {
  it("мусор отбрасывается по полям, вид работ другого вида работ не принимается", () => {
    expect(normalizeEstimateOptions(null)).toEqual(NO_ESTIMATE_OPTIONS);
    expect(normalizeEstimateOptions({ phase: "REPAIR", conditionIds: ["T5-8", "bad"], winterWork: "YES" })).toMatchObject({
      phase: null,
      winterWork: "YES",
    });
    const mismatched = normalizeEstimateOptions({ phase: "DEMOLITION", workKind: "CR_RES_BRICK" });
    expect(mismatched.workKind).toBeNull();
    const ok = normalizeEstimateOptions({ workKind: "DEM_DISMANTLE", workPeriod: { start: "2026-09-01", end: "2026-11-30" } });
    expect(ok).toMatchObject({ phase: "DEMOLITION", workKind: "DEM_DISMANTLE", workPeriod: { start: "2026-09-01", end: "2026-11-30" } });
  });
});

describe("сроки и зима в тексте документации", () => {
  it("«Срок выполнения работ: с 01.09.2026 по 30.11.2026» → период; одна граница — по слову", () => {
    expect(extractWorkPeriod("Срок выполнения работ: с 01.09.2026 по 30.11.2026. Оплата — 30 дней.")).toMatchObject({ start: "2026-09-01", end: "2026-11-30" });
    expect(extractWorkPeriod("Срок окончания выполнения работ — до 15.12.2026")).toMatchObject({ start: null, end: "2026-12-15" });
    expect(extractWorkPeriod("Начало выполнения работ: 01.09.2026")).toMatchObject({ start: "2026-09-01", end: null });
  });

  it("сроков без дат («в течение 60 дней») и чужих дат нет — null", () => {
    expect(extractWorkPeriod("Срок выполнения работ: в течение 60 календарных дней с даты заключения контракта")).toBeNull();
    expect(extractWorkPeriod("Срок подачи заявок до 01.09.2026")).toBeNull();
  });

  it("зима упомянута", () => {
    expect(detectWinterMention("Работы выполняются в зимний период с применением тепляков")?.quote).toContain("зимний период");
    expect(detectWinterMention("Работы летом")).toBeNull();
  });
});

describe("покрытие субъектов справочника ценовых зон (если собран индекс)", () => {
  const file = "data/fsnb/index/zones.jsonl";
  it.skipIf(!existsSync(file))("каждый субъект ценовых зон находит свои температурные зоны; не находит только Севастополь (его нет в приложении 4)", () => {
    const subjects = [
      ...new Set(
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { subjectName: string }).subjectName),
      ),
    ];
    const without = subjects.filter((subject) => winterPartsOf(subject).length === 0);
    expect(without).toEqual(["город Севастополь"]);
  });
});
