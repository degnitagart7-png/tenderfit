import { describe, it, expect } from "vitest";
import { buildEisUrl } from "./index";

describe("buildEisUrl", () => {
  it("builds correct URL for electronic auction (44-ФЗ)", () => {
    const url = buildEisUrl("FZ_44", "0123456789", "ELECTRONIC_AUCTION");
    expect(url).toBe(
      "https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0123456789",
    );
  });

  it("builds correct URL for open contest (44-ФЗ)", () => {
    const url = buildEisUrl("FZ_44", "0123456789", "OPEN_CONTEST");
    expect(url).toBe(
      "https://zakupki.gov.ru/epz/order/notice/ok20/view/common-info.html?regNumber=0123456789",
    );
  });

  it("builds correct URL for request for quotation (44-ФЗ)", () => {
    const url = buildEisUrl("FZ_44", "0123456789", "REQUEST_FOR_QUOTATION");
    expect(url).toBe(
      "https://zakupki.gov.ru/epz/order/notice/zk20/view/common-info.html?regNumber=0123456789",
    );
  });

  it("builds correct URL for sole supplier (44-ФЗ)", () => {
    const url = buildEisUrl("FZ_44", "0123456789", "SOLE_SUPPLIER");
    expect(url).toBe(
      "https://zakupki.gov.ru/epz/order/notice/ep44/view/common-info.html?regNumber=0123456789",
    );
  });

  it("builds correct URL for 223-ФЗ (any placing way)", () => {
    const url = buildEisUrl("FZ_223", "32616383318", "ELECTRONIC_AUCTION");
    expect(url).toBe(
      "https://zakupki.gov.ru/223/purchase/public/purchase/info/common-info.html?regNumber=32616383318",
    );
  });

  it("223-ФЗ URL does not depend on placing way", () => {
    const url1 = buildEisUrl("FZ_223", "123", "ELECTRONIC_AUCTION");
    const url2 = buildEisUrl("FZ_223", "123", "REQUEST_FOR_QUOTATION");
    expect(url1).toBe(url2);
  });
});

/**
 * Тесты с реальными номерами закупок с zakupki.gov.ru (сентябрь 2026).
 * Проверяют, что URL совпадает с тем, что использует сам сайт ЕИС.
 */
describe("buildEisUrl — реальные номера закупок", () => {
  it("44-ФЗ электронный аукцион → ea20 (реальная закупка 0318200057126000250)", () => {
    const url = buildEisUrl("FZ_44", "0318200057126000250", "ELECTRONIC_AUCTION");
    expect(url).toBe(
      "https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0318200057126000250",
    );
  });

  it("44-ФЗ электронный аукцион → ea20 (реальная закупка 0811300008326000602)", () => {
    const url = buildEisUrl("FZ_44", "0811300008326000602", "ELECTRONIC_AUCTION");
    expect(url).toBe(
      "https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0811300008326000602",
    );
  });

  it("44-ФЗ открытый конкурс → ok20 (реальная закупка 0873200009826004473)", () => {
    const url = buildEisUrl("FZ_44", "0873200009826004473", "OPEN_CONTEST");
    expect(url).toBe(
      "https://zakupki.gov.ru/epz/order/notice/ok20/view/common-info.html?regNumber=0873200009826004473",
    );
  });

  it("44-ФЗ открытый конкурс → ok20 (реальная закупка 0173200001426001724)", () => {
    const url = buildEisUrl("FZ_44", "0173200001426001724", "OPEN_CONTEST");
    expect(url).toBe(
      "https://zakupki.gov.ru/epz/order/notice/ok20/view/common-info.html?regNumber=0173200001426001724",
    );
  });

  it("223-ФЗ (реальная закупка 32616394338 — аренда самосвалов)", () => {
    const url = buildEisUrl("FZ_223", "32616394338", "OPEN_CONTEST");
    expect(url).toBe(
      "https://zakupki.gov.ru/223/purchase/public/purchase/info/common-info.html?regNumber=32616394338",
    );
  });

  it("223-ФЗ (реальная закупка 32616370540 — поставка насосов)", () => {
    const url = buildEisUrl("FZ_223", "32616370540", "ELECTRONIC_AUCTION");
    expect(url).toBe(
      "https://zakupki.gov.ru/223/purchase/public/purchase/info/common-info.html?regNumber=32616370540",
    );
  });

  it("не использует zk20 для электронного аукциона (баг-регрессия)", () => {
    const url = buildEisUrl("FZ_44", "0318200057126000250", "ELECTRONIC_AUCTION");
    expect(url).not.toContain("/zk20/");
    expect(url).toContain("/ea20/");
  });

  it("не использует zk20 для открытого конкурса (баг-регрессия)", () => {
    const url = buildEisUrl("FZ_44", "0873200009826004473", "OPEN_CONTEST");
    expect(url).not.toContain("/zk20/");
    expect(url).toContain("/ok20/");
  });
});
