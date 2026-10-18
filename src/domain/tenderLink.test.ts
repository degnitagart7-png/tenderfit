import { describe, expect, it } from "vitest";

import { parseTenderLink } from "@/domain/tenderLink";

describe("parseTenderLink", () => {
  it("карточка 44-ФЗ: номер из параметра regNumber", () => {
    expect(
      parseTenderLink("https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0302300083426000012"),
    ).toEqual({ ok: true, regNumber: "0302300083426000012" });
  });

  it("карточка 223-ФЗ и вкладка документов", () => {
    expect(
      parseTenderLink("https://zakupki.gov.ru/epz/order/notice/notice223/documents.html?regNumber=32616407955&tab=x"),
    ).toEqual({ ok: true, regNumber: "32616407955" });
  });

  it("просто номер, с пробелами вокруг", () => {
    expect(parseTenderLink("  0134300025826000377 ")).toEqual({ ok: true, regNumber: "0134300025826000377" });
    expect(parseTenderLink("№ 32616439079")).toEqual({ ok: true, regNumber: "32616439079" });
  });

  it("ссылка площадки с номером ЕИС внутри", () => {
    expect(parseTenderLink("https://www.sberbank-ast.ru/purchaseview.aspx?id=0302300083426000012")).toEqual({
      ok: true,
      regNumber: "0302300083426000012",
    });
  });

  it("длинное число (не 11 и не 19 цифр) номером не считается", () => {
    expect(parseTenderLink("123456789012345").ok).toBe(false);
  });

  it("ссылка ЕИС без номера — понятный отказ", () => {
    const result = parseTenderLink("https://zakupki.gov.ru/epz/order/notice/notice223/common-info.html?noticeInfoId=1234567");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/нет реестрового номера/);
  });

  it("пусто и мусор — отказ с подсказкой", () => {
    expect(parseTenderLink("").ok).toBe(false);
    const junk = parseTenderLink("закупка про кровлю");
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.error).toMatch(/19 цифр/);
  });
});
