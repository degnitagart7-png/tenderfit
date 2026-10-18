import { describe, expect, it } from "vitest";
import type { Tender, TenderDocument } from "@/domain/entities";
import type { TenderLaw } from "@/types/database";
import { analyzeContractRisks } from "@/domain/scoring";

/*
  Первичный разбор (без модели): норма закона не риск. По 44-ФЗ казначейское сопровождение
  и односторонний отказ заказчика (ч. 9 ст. 95) — типовые условия; «0,5 %» у обеспечения заявки
  не превращается в «повышенную неустойку».
*/

function tender(law: TenderLaw, text: string): Tender {
  const document: TenderDocument = {
    id: "d-1",
    type: "DRAFT_CONTRACT",
    title: "Проект контракта",
    fileName: "contract.docx",
    url: "https://example.test/contract.docx",
    text,
    pageCount: null,
    lastModified: null,
  };
  return {
    id: "t-1",
    law,
    subject: "Ремонт кровли",
    deliveryAddress: "",
    lots: [],
    requirements: [],
    documents: [document],
    financial: {
      price: 1_000_000,
      contractSecurityPercent: 5,
      advancePercent: 30,
      postpaymentDays: null,
    },
  } as unknown as Tender;
}

const titles = (t: Tender) => analyzeContractRisks(t).map((r) => r.title);

describe("analyzeContractRisks: закон решает, что риск", () => {
  const TREASURY = "Авансовый платёж подлежит казначейскому сопровождению в соответствии с законодательством.";
  const UNILATERAL = "Заказчик вправе принять решение об одностороннем отказе от исполнения контракта по ч. 9 ст. 95 44-ФЗ.";

  it("казначейское сопровождение по 44-ФЗ — не риск", () => {
    expect(titles(tender("FZ_44", TREASURY))).not.toContain("Казначейское сопровождение");
  });

  it("казначейское сопровождение по 223-ФЗ и в коммерческой закупке — риск", () => {
    expect(titles(tender("FZ_223", TREASURY))).toContain("Казначейское сопровождение");
    expect(titles(tender("COMMERCIAL", TREASURY))).toContain("Казначейское сопровождение");
  });

  it("односторонний отказ по закону 44-ФЗ — не риск", () => {
    expect(titles(tender("FZ_44", UNILATERAL))).toEqual([]);
  });

  it("односторонний отказ по 223-ФЗ — риск", () => {
    expect(titles(tender("FZ_223", UNILATERAL))).toContain("Право заказчика на односторонний отказ");
  });

  it("отказ «в любое время и без объяснения причин» по 44-ФЗ — риск сверх закона", () => {
    const text = "Заказчик вправе в любое время отказаться от контракта в одностороннем порядке без объяснения причин.";
    expect(titles(tender("FZ_44", text))).toContain("Односторонний отказ заказчика шире, чем в законе");
  });

  it("типовая связка «приёмка + односторонний отказ + удержание неустойки» не даёт критического риска", () => {
    const text =
      "Приёмка выполненных работ проводится заказчиком. Заказчик вправе принять решение об одностороннем отказе от контракта. Неустойка удерживается из оплаты.";
    expect(titles(tender("FZ_44", text))).toEqual([]);
  });

  it("приёмка в одностороннем порядке с удержанием оплаты — критический риск", () => {
    const text = "Приёмка осуществляется заказчиком в одностороннем порядке, заказчик вправе удерживать оплату.";
    expect(titles(tender("FZ_223", text))).toContain("Жёсткие условия приёмки и удержания оплаты");
  });

  it("0,5 % у обеспечения заявки не считается повышенной неустойкой", () => {
    const text =
      "Размер обеспечения заявки составляет от 0,5 % до 5 % НМЦК. За просрочку исполнения начисляется неустойка по ПП № 1042.";
    expect(titles(tender("FZ_44", text))).not.toContain("Повышенные штрафные санкции");
  });

  it("неустойка 0,5 % за каждый день — повышенная", () => {
    const text = "За просрочку заказчик начисляет неустойку в размере 0,5 % цены контракта за каждый день.";
    expect(titles(tender("FZ_44", text))).toContain("Повышенные штрафные санкции");
  });
});
