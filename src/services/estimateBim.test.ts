import { describe, expect, it } from "vitest";

import { computeAssurance } from "@/domain/estimate/assurance";
import { anchorOf, type BillEdit } from "@/domain/estimate/billEdits";
import { bundledBimIndexBook } from "@/domain/estimate/bimIndices";
import { auditEstimateArithmetic, estimateDocumentSchema } from "@/domain/estimate/schema";
import type { BillOfWorkItem, EstimateDocument } from "@/domain/estimate/types";
import { recalculateEstimate } from "@/services/estimateRecalc";
import { buildEstimateFromDocuments, type EstimateDeps, type EstimateRequestInput } from "@/services/estimateService";
import { BIM_DOC_TEXT, BIM_PARAMETERS, OVERHEAD_RATES, bimCalls, bimFetcher, makeFerBase } from "@/test/bimFixtures";
import { makeEditBase, editFetcher, EDIT_DOC_TEXT } from "@/test/billEditFixtures";

/*
  Расчёт БИМ по документам: ведомость на расценках ФЕР, письма Минстроя встроены в проект. Модель подменена; ФЕР-2020 — малая
  выгрузка из трёх расценок. Проверяется то, что видит пользователь: метод, расценки, индексы, пометки и пересчёт после правок.
*/

const deps = (): EstimateDeps => ({ fer: makeFerBase(), bimIndices: bundledBimIndexBook(), overheadRates: OVERHEAD_RATES, fetcher: bimFetcher });

function input(patch: Partial<EstimateRequestInput> = {}): EstimateRequestInput {
  return {
    regNumber: "0123",
    subject: "Капитальный ремонт кирпичного многоквартирного дома",
    documents: [{ name: "ВОР.docx", text: BIM_DOC_TEXT }],
    parameters: BIM_PARAMETERS,
    priceZoneId: 5,
    priceZoneName: "Белгородская область",
    priceZoneChoice: { basis: "USER", matched: null, northZone: "TERRITORY" },
    now: new Date("2026-10-09T00:00:00.000Z"),
    ...patch,
  };
}

const lines = (document: EstimateDocument) => document.sections.flatMap((section) => section.lines);
const lineOf = (document: EstimateDocument, name: string) => lines(document).find((line) => line.normName.startsWith(name));

describe("расчёт по документам: метод заказчика", () => {
  it("в документации расценки ФЕР — считается БИМ, метод «как у заказчика», модель не вызывается лишний раз", async () => {
    const before = bimCalls.count;
    const result = await buildEstimateFromDocuments(input(), deps());
    expect(bimCalls.count).toBe(before + 1);
    expect(result.document.method).toBe("BASE_INDEX");
    expect(result.document.bim).toMatchObject({ basis: "CUSTOMER", subject: "Белгородская область", object: "Многоквартирные жилые дома: Кирпичные", objectDetected: true, customerBase: "FER" });
    expect(result.document.region).toBe("Белгородская область");
    expect(result.document.disclaimer).toContain("базисно-индексным методом");
  });

  it("расценки подобраны по шифру с книгой: ФЕР и ФЕРм с одним кодом не путаются", async () => {
    const { document, normHints } = await buildEstimateFromDocuments(input(), deps());
    expect(lines(document).map((line) => `${line.normBaseType} ${line.normCode}`)).toEqual(["ФЕР 01-01-001-01", "ФЕР 08-02-001-01", "ФЕРм 08-02-001-01", "ФССЦ 18.1.02.01-0085"]);
    expect(normHints.map((hint) => hint.baseType)).toEqual(["ФЕР", "ФЕР", "ФЕРм"]);
  });

  it("цифры: ЭМ, ОЗП и материалы × индексы письма; НР и СП по приказам от ФОТ в текущих ценах", async () => {
    const { document } = await buildEstimateFromDocuments(input(), deps());
    expect(lineOf(document, "Разработка грунта")).toMatchObject({ directCost: 250492, overheadCost: 142740, profitCost: 71370 });
    // Кладка 10 м3: ОЗП 3000 × 47,58, ЭМ 1000 × 15,15, М 11000 × 9,58; ФОТ = 142 740 + 200 × 10 × 47,58 / 10 … = 152 256
    expect(lineOf(document, "Кладка")).toMatchObject({ labourCost: 142740, machineCost: 15150, materialCost: 105380, overheadPercent: 120, profitPercent: 60 });
    expect(lineOf(document, "Клапан")).toMatchObject({ directCost: 3832, overheadCost: 0 });
    const parsed = estimateDocumentSchema.parse(JSON.parse(JSON.stringify(document)));
    expect(auditEstimateArithmetic(parsed)).toEqual([]);
  });

  it("пометки: материал вне цены расценки, резерв НР у монтажа, допущений по индексам нет (объект определён)", async () => {
    const { document } = await buildEstimateFromDocuments(input(), deps());
    expect(document.gaps.some((gap) => gap.kind === "QUANTITY_BY_PROJECT" && gap.baseType === "ФЕР")).toBe(true);
    expect(document.gaps.some((gap) => gap.kind === "NO_OVERHEAD_RATE" && gap.baseType === "ФЕРм")).toBe(true);
    expect(computeAssurance(document).assumptions.map((assumption) => assumption.kind)).not.toContain("BIM_INDEX_ASSUMED");
  });

  it("объект не определился — индексы по «Прочим объектам», пометка и допущение в надёжности расчёта", async () => {
    const { document } = await buildEstimateFromDocuments(input({ subject: "Выполнение работ по благоустройству" }), deps());
    expect(document.bim).toMatchObject({ object: "Прочие объекты", objectDetected: false, indexLabour: 47.58, indexMachines: 14.92, indexMaterials: 10.4 });
    expect(document.gaps.some((gap) => gap.kind === "BIM_NO_INDEX")).toBe(true);
    const assumption = computeAssurance(document).assumptions.find((item) => item.kind === "BIM_INDEX_ASSUMED");
    expect(assumption?.percent).toBe(100);
    expect(assumption?.message).toContain("«Прочие объекты»");
  });

  it("заказчик считает по ТЕР региона: посчитано по ФЕР, оговорка в пометках и в допущениях", async () => {
    const terText = BIM_DOC_TEXT.replace(/ФЕРм? /gu, "ТЕР ");
    const { document } = await buildEstimateFromDocuments(input({ documents: [{ name: "ВОР.docx", text: terText }] }), deps());
    expect(document.bim?.customerBase).toBe("TER");
    expect(document.gaps.find((gap) => gap.kind === "BIM_TER_AS_FER")?.message).toBe(
      "ТЕР Белгородская область недоступны в открытых данных — посчитано по ФЕР с индексами к ФЕР; возможна разница",
    );
    expect(computeAssurance(document).assumptions.map((item) => item.kind)).toContain("BIM_INDEX_ASSUMED");
  });

  it("выбор пользователя «ресурсно-индексный» важнее документации: считается по ГЭСН, как до появления БИМ", async () => {
    const base = makeEditBase();
    const result = await buildEstimateFromDocuments(
      {
        regNumber: "0123",
        subject: "Реконструкция",
        documents: [{ name: "ВОР.docx", text: `${EDIT_DOC_TEXT}\nСметные нормативы ФЕР 01-01-001-01` }],
        parameters: BIM_PARAMETERS,
        priceZoneId: 282,
        priceZoneChoice: { basis: "USER", matched: null, northZone: "TERRITORY" },
        options: { phase: null, workKind: null, conditionIds: [], newConstructionNorms: false, winterWork: null, workPeriod: null, winterPartId: null, method: "RESOURCE_INDEX" },
        now: new Date("2026-09-28T00:00:00.000Z"),
      },
      { base, fetcher: editFetcher },
    );
    expect(result.document.method).toBe("RESOURCE_INDEX");
    expect(result.document.bim).toBeUndefined();
  });

  it("выбор «базисно-индексный» работает и тогда, когда документация о методе молчит", async () => {
    const result = await buildEstimateFromDocuments(
      input({
        documents: [{ name: "ВОР.docx", text: BIM_DOC_TEXT.replace(/ \| (?:ФЕРм?|ФССЦ-)[^|\n]*$/gmu, "") }],
        options: { phase: null, workKind: null, conditionIds: [], newConstructionNorms: false, winterWork: null, workPeriod: null, winterPartId: null, method: "BASE_INDEX" },
      }),
      deps(),
    );
    expect(result.document.method).toBe("BASE_INDEX");
    expect(result.document.bim?.basis).toBe("USER");
  });
});

describe("пересчёт сметы БИМ после правок", () => {
  async function setup() {
    const result = await buildEstimateFromDocuments(input(), deps());
    const source = { document: result.document, bill: result.bill };
    const item = (name: string): BillOfWorkItem => {
      const found = result.bill.sections.flatMap((section) => section.items).find((candidate) => candidate.workName.startsWith(name));
      if (found === undefined) throw new Error(`нет позиции ${name}`);
      return found;
    };
    const run = (edits: readonly BillEdit[]) => recalculateEstimate(source, edits, { fer: makeFerBase(), overheadRates: OVERHEAD_RATES });
    return { result, item, run };
  }

  it("в записи расчёта лежат индексы письма: пересчёт идёт по ним и без обращения к модели", async () => {
    const { result, run } = await setup();
    expect(result.bill.calc?.bim?.selection).toMatchObject({ labour: 47.58, machines: 15.15, materials: 9.58 });
    const calls = bimCalls.count;
    const again = await run([]);
    expect(again.document.totals).toEqual(result.document.totals);
    expect(again.document.method).toBe("BASE_INDEX");
    expect(again.tokensUsed).toBe(0);
    expect(bimCalls.count).toBe(calls);
  });

  it("объём 2000 → 4000 м3: стоимость расценки удваивается, остальные позиции не меняются", async () => {
    const { result, item, run } = await setup();
    const earth = item("Разработка грунта");
    // В ведомости объём в м3 (2000), в расценке — 1000 м3: делитель назначен по единице расценки.
    expect(earth).toMatchObject({ quantity: 2000, unitDivisor: 1000 });
    const recalculated = await run([{ kind: "change", anchor: anchorOf(earth), quantity: 4000 }]);
    expect(lineOf(recalculated.document, "Разработка грунта")?.directCost).toBe(500984);
    expect(lineOf(recalculated.document, "Кладка")).toEqual(lineOf(result.document, "Кладка"));
  });

  it("выбранная вручную расценка берётся по паре «книга + шифр» из ФЕР-2020", async () => {
    const { item, run } = await setup();
    const brick = item("Кладка");
    const recalculated = await run([{ kind: "norm", anchor: anchorOf(brick), norm: { code: "08-02-002-01", baseType: "ФЕР" } }]);
    const line = lines(recalculated.document).find((candidate) => candidate.itemId === brick.id);
    // ОЗП 400 × 10 × 47,58 вместо 300 × 10 × 47,58
    expect(line).toMatchObject({ normBaseType: "ФЕР", normCode: "08-02-002-01", normName: "Кладка стен кирпичных наружных сложных", labourCost: 190320 });
    expect(recalculated.bill.rows.find((row) => row.itemId === brick.id)?.basis).toBe("MANUAL");
  });

  it("своя цена: объём × цена, НР и СП не начисляются, метод остаётся базисно-индексным", async () => {
    const { item, run } = await setup();
    const earth = item("Разработка грунта");
    const recalculated = await run([{ kind: "price", anchor: anchorOf(earth), unitPrice: 1000 }]);
    // 2000 м3 × 1000 ₽
    expect(lineOf(recalculated.document, "Разработка грунта")).toMatchObject({ priceSource: "OWN_PRICE", directCost: 2_000_000, overheadCost: 0 });
    expect(recalculated.document.method).toBe("BASE_INDEX");
  });
});
