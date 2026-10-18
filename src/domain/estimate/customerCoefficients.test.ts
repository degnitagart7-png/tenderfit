import { describe, expect, it } from "vitest";

import { evaluateCustomerConditions, statedFactors, summarizeCustomerConditions } from "@/domain/estimate/customerCoefficients";
import { parseCustomerLsr, type CustomerPosition } from "@/domain/estimate/customerLsr";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { DOCUMENTS_1118 } from "@/test/t1118Fixtures";

/*
  Коэффициенты заказчика к позициям ЛСР: подтверждённые приложением 10 к 421/пр применяются, остальные — нет.
  Живые позиции — из ЛСР закупки 0302300048726001118; граничные случаи — синтетические позиции.
*/

const set = buildLsrSet(parseCustomerLsr(DOCUMENTS_1118).estimates);
const positionOf = (number: string, label: string): CustomerPosition => {
  const entry = set.entries.find((candidate) => candidate.number === number);
  const all = [...(entry?.estimate.positions ?? []), ...(entry?.estimate.subPositions ?? [])];
  return all.find((position) => position.label === label) as CustomerPosition;
};

function synthetic(patch: Partial<CustomerPosition> & { notes: CustomerPosition["notes"] }): CustomerPosition {
  return {
    number: 1,
    label: "1",
    code: "ГЭСН15-01-050-04",
    rawJustification: "ГЭСН15-01-050-04",
    book: "GESN",
    coefficients: null,
    hasCoefficients: false,
    name: "Облицовка стен",
    unit: "100 м2",
    quantity: 1,
    section: null,
    ownUnitPrice: null,
    ownTotal: null,
    ownBasePrice: null,
    ownIndex: null,
    ownPriceCoefficient: null,
    resources: [],
    groupTotals: { labour: 1000, machines: 200, machinistLabour: 100, materials: 0 },
    directTotal: 1300,
    wageFund: 1100,
    overhead: null,
    profit: null,
    perUnit: null,
    total: 3000,
    truncated: false,
    ...patch,
  };
}

const P58 = { ref: "421/пр_2020_п.58_пп.б", text: "При применении сметных норм ГЭСН, аналогичных технологическим процессам в новом строительстве, с применением коэффициентов 1,15 к затратам труда (оплате труда) рабочих и 1,25 к нормам времени эксплуатации машин" };
const PREMISES = { ref: "421/пр_2020_прил.10_т.3_п.1.1_гр.3", text: "Производство работ осуществляется в помещениях эксплуатируемого объекта" };

describe("подтверждённые коэффициенты", () => {
  it("«в помещениях эксплуатируемого объекта» (т. 3, п. 1.1) у ГЭСНм: значение 1,2 есть в таблице — подтверждено", () => {
    const conditions = evaluateCustomerConditions(positionOf("02-02-08", "8"));

    expect(conditions?.confirmed).toEqual({ conditionIds: ["T3-1.1"], p58: false, phase: "RECONSTRUCTION" });
    expect(conditions?.rejected).toEqual([]);
    expect(conditions?.label).toBe("как у заказчика: приложение 10 к 421/пр, таблица 3, п. 1.1 (К = 1,2)");
    expect(conditions?.enabled).toBe(true);
  });

  it("п. 58 у ГЭСН (ремонт по нормам нового строительства) — подтверждён: 1,15 к труду, 1,25 к машинам", () => {
    const conditions = evaluateCustomerConditions(positionOf("02-02-12", "2"));

    expect(conditions?.confirmed).toMatchObject({ conditionIds: [], p58: true, phase: "CAPITAL_REPAIR" });
    expect(conditions?.label).toContain("п. 58 Методики 421/пр (1,15 к труду, 1,25 к машинам)");
  });

  it("условие и п. 58 вместе подтверждаются оба", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [PREMISES, P58] }));

    expect(conditions?.confirmed?.conditionIds).toEqual(["T3-1.1"]);
    expect(conditions?.confirmed?.p58).toBe(true);
  });

  it("позиции по ТЦ, КП и поставки ФСБЦ коэффициентов приложения 10 не получают", () => {
    expect(evaluateCustomerConditions(positionOf("02-02-08", "3.2"))).toBeNull();
    expect(evaluateCustomerConditions(positionOf("02-02-08", "3.3"))).toBeNull();
  });
});

describe("неподтверждённые коэффициенты: не применяются, называются с причиной и суммой", () => {
  it("ОЗП=0,3 при демонтаже оборудования: ссылка 648/пр п. 145 табл. 3 — та же строка, что 571/пр п. 84 табл. 3 (значение сверено по 571/пр)", () => {
    const conditions = evaluateCustomerConditions(positionOf("02-02-05/13", "1"));

    expect(conditions?.rejected).toEqual([]);
    expect(conditions).toMatchObject({ special: { id: "M571-P84-T3-R4", labour: 0.3, machines: 0.3, materials: 0, valueVerified: true } });
    expect(conditions?.label).toContain("648/пр");
  });

  it("65 % при наладке по Прил. 3.3 у ГЭСНп", () => {
    const conditions = evaluateCustomerConditions(positionOf("02-02-05/13", "3"));

    expect(conditions?.confirmed).toBeNull();
    expect(conditions?.rejected[0]?.text).toContain("ОЗП=0,65");
    // Первоисточник технической части ГЭСНп недоступен: коэффициент не применяется, а причина называет проверку вручную.
    expect(conditions?.rejected[0]?.reason).toContain("проверьте вручную");
  });

  it("п. 58 у разборки (п. 59) и у ГЭСНм — не подтверждён", () => {
    const demolition = evaluateCustomerConditions(synthetic({ name: "Демонтаж облицовки стен", notes: [P58] }));
    expect(demolition?.confirmed).toBeNull();
    expect(demolition?.rejected[0]?.reason).toContain("п. 59");

    const machines = evaluateCustomerConditions(synthetic({ book: "GESNM", code: "ГЭСНм10-01-053-01", rawJustification: "ГЭСНм10-01-053-01", notes: [P58] }));
    expect(machines?.confirmed).toBeNull();
    expect(machines?.rejected[0]?.reason).toContain("п. 59");

    const collection46 = evaluateCustomerConditions(synthetic({ code: "ГЭСН46-02-009-02", rawJustification: "ГЭСН46-02-009-02", notes: [P58] }));
    expect(collection46?.confirmed).toBeNull();
  });

  it("значение в смете не сходится с таблицей: 1,3 вместо 1,2", () => {
    const conditions = evaluateCustomerConditions(
      synthetic({ notes: [PREMISES, { ref: "", text: "Коэффициент к заработной плате основных рабочих ОЗП=1,3; ТЗ=1,3" }] }),
    );

    // Пояснение со ссылкой подтверждено само; строка без ссылки со значением 1,3 — отдельное неподтверждённое заявление.
    expect(conditions?.confirmed?.conditionIds).toEqual(["T3-1.1"]);
    expect(conditions?.rejected[0]?.reason).toContain("ссылки на пункт приложения 10");
  });

  it("строка без ссылки с тем же значением, что подтверждённое выше, — повторное применение заказчика", () => {
    const conditions = evaluateCustomerConditions(positionOf("02-02-08", "12"));

    expect(conditions?.confirmed?.conditionIds).toEqual(["T3-1.1"]);
    // Коэффициенты условий работ: две строки без ссылки с тем же значением; множители к НР и СП (п. 25 без п. 58) — отдельно.
    const repeats = (conditions?.rejected ?? []).filter((claim) => claim.overheadMultiplier == null && claim.profitMultiplier == null);
    expect(repeats).toHaveLength(2);
    expect(repeats.every((claim) => claim.reason.includes("второй раз"))).toBe(true);
    expect(repeats.map((claim) => claim.labour ?? claim.machines)).toEqual([1.2, 1.2]);
  });

  it("1,2 к материалам: приложение 10 к материалам коэффициентов не применяет", () => {
    const conditions = evaluateCustomerConditions(
      synthetic({ notes: [{ ref: PREMISES.ref, text: "в помещениях ОЗП=1,2; ЭМ=1,2; МАТ=1,2" }] }),
    );

    expect(conditions?.confirmed).toBeNull();
    expect(conditions?.rejected[0]?.reason).toContain("МАТ=1,2");
  });

  it("в таблице для книги прочерк (ГЭСНр, т. 3 п. 1.1) — не подтверждено", () => {
    const conditions = evaluateCustomerConditions(synthetic({ book: "GESNR", code: "ГЭСНр56-01-009-01", rawJustification: "ГЭСНр56-01-009-01", notes: [PREMISES] }));

    expect(conditions?.confirmed).toBeNull();
    expect(conditions?.rejected[0]?.reason).toContain("прочерк");
  });

  it("пункта нет в приложении 10", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [{ ref: "421/пр_2020_прил.10_т.3_п.77_гр.3", text: "Условие" }] }));

    expect(conditions?.rejected[0]?.reason).toContain("нет таблицы 3, п. 77");
  });

  it("пояснения без коэффициентов («Транспортные затраты…») — не заявление", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [{ ref: "421/пр_2020_п.91_абз.4", text: "Транспортные затраты, в случае невозможности их определения" }] }));

    expect(conditions).toBeNull();
  });
});

describe("statedFactors", () => {
  it("ОЗП и ТЗ — к труду, ЭМ, ЗПМ, ТЗМ — к машинам, МАТ — к материалам", () => {
    expect(statedFactors("ОЗП=1,2; ТЗ=1,2")).toMatchObject({ labour: 1.2, machines: null, materials: null });
    expect(statedFactors("ЭМ=1,25 к расх.; ЗПМ=1,25; ТЗМ=1,25; МАТ=1,1")).toMatchObject({ machines: 1.25, materials: 1.1 });
  });
});

describe("summarizeCustomerConditions: ЛСР 02-02-08", () => {
  const entry = set.entries.find((candidate) => candidate.number === "02-02-08");
  const items = lsrBillSection(entry as NonNullable<typeof entry>, 1).section.items;

  it("позиции с коэффициентами и подтверждённые", () => {
    const summary = summarizeCustomerConditions(items, "ЛСР 02-02-08");

    expect(summary.positions).toBe(6);
    expect(summary.confirmed).toBe(6);
    expect(summary.notes[0]).toContain("коэффициенты заказчика применены к 6 из 27 позиций");
    // Поз. 12 несёт ещё и повтор коэффициента строкой без ссылки; у поз. 3.1, 5.1, 12 и 13 множители к НР и СП без п. 58 не подтверждены.
    expect(summary.rejected).toBe(4);
    expect(summary.notes.some((note) => note.includes("второй раз"))).toBe(true);
    expect(summary.rejectedAmount).toBeGreaterThan(0);
  });

  it("снятое применение называется", () => {
    const off = items.map((item) => (item.customerConditions === undefined ? item : { ...item, customerConditions: { ...item.customerConditions, enabled: false } }));

    expect(summarizeCustomerConditions(off).disabled).toBe(6);
    expect(summarizeCustomerConditions(off).notes[0]).toContain("применение отключено");
  });
});
