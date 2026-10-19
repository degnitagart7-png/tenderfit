import { describe, expect, it } from "vitest";

import {
  buyerTypeByInn,
  documentIdsInPurpose,
  formatInvoiceNumber,
  invoiceAmount,
  invoiceNumbersInPurpose,
  invoicePositionName,
  isValidInn,
  isValidKpp,
  moscowDate,
  normalizeInvoiceNumber,
  parseBuyer,
  payablePlan,
  sameAmount,
  toInvoiceView,
  toKopecks,
  type PaymentInvoice,
} from "@/domain/payments";

describe("ИНН", () => {
  it.each(["7707083893", "7728168971", "7743013901"])("организация %s — верная контрольная сумма", (inn) => {
    expect(isValidInn(inn)).toBe(true);
  });

  it.each(["500100732259", "032631178302"])("ИП или физлицо %s — две контрольные цифры сходятся", (inn) => {
    expect(isValidInn(inn)).toBe(true);
  });

  it.each([
    ["7707083894", "последняя цифра неверна"],
    ["500100732258", "контрольная цифра ИП неверна"],
    ["123456789012", "случайные двенадцать цифр"],
    ["0000000000", "нули"],
    ["770708389", "девять цифр"],
    ["77070838931", "одиннадцать цифр"],
    ["77070838ab", "буквы"],
    ["", "пусто"],
  ])("%s отклоняется (%s)", (inn) => {
    expect(isValidInn(inn)).toBe(false);
  });

  it("тип покупателя для банка: 10 цифр — организация, 12 — ИП", () => {
    expect(buyerTypeByInn("7707083893")).toBe("company");
    expect(buyerTypeByInn("500100732259")).toBe("ip");
  });
});

describe("КПП", () => {
  it("четыре цифры, два знака, три цифры", () => {
    expect(isValidKpp("770701001")).toBe(true);
    expect(isValidKpp("770A01001")).toBe(false);
    expect(isValidKpp("77070100A")).toBe(false);
    expect(isValidKpp("77070100")).toBe(false);
    expect(isValidKpp("7707AB001")).toBe(true);
  });
});

describe("parseBuyer", () => {
  const ok = { inn: "7707083893", kpp: "770701001", name: "  ООО   «Ромашка» ", email: " Buh@Romashka.RU " };

  it("нормализует: пробелы в названии сжаты, почта в нижнем регистре", () => {
    const result = parseBuyer(ok);
    expect(result).toEqual({
      ok: true,
      buyer: { inn: "7707083893", kpp: "770701001", name: "ООО «Ромашка»", email: "buh@romashka.ru" },
    });
  });

  it("КПП необязателен у организации, а у ИП отбрасывается", () => {
    expect(parseBuyer({ ...ok, kpp: "" })).toMatchObject({ ok: true, buyer: { kpp: null } });
    expect(parseBuyer({ ...ok, inn: "500100732259", kpp: "770701001" })).toMatchObject({ ok: true, buyer: { kpp: null } });
  });

  it("называет поле с ошибкой", () => {
    expect(parseBuyer({ ...ok, inn: "7707083894" })).toMatchObject({ ok: false, field: "inn" });
    expect(parseBuyer({ ...ok, kpp: "12" })).toMatchObject({ ok: false, field: "kpp" });
    expect(parseBuyer({ ...ok, name: " " })).toMatchObject({ ok: false, field: "name" });
    expect(parseBuyer({ ...ok, email: "не почта" })).toMatchObject({ ok: false, field: "email" });
  });

  it("не-строки не проходят", () => {
    expect(parseBuyer({ inn: 7707083893, name: null, email: undefined })).toMatchObject({ ok: false, field: "inn" });
  });
});

describe("номер счёта", () => {
  it("форматируется «ТФ-0001»", () => {
    expect(formatInvoiceNumber(1)).toBe("ТФ-0001");
    expect(formatInvoiceNumber(12345)).toBe("ТФ-12345");
  });

  it.each([
    ["Оплата по счету № ТФ-0001 от 20.10.2026. Без НДС", ["ТФ-0001"]],
    ["оплата тф 1", ["ТФ-0001"]],
    ["счет TF-0012 за подписку", ["ТФ-0012"]],
    ["Оплата по счёту ТФ№0007", ["ТФ-0007"]],
    ["счета ТФ-0001 и ТФ-0002", ["ТФ-0001", "ТФ-0002"]],
    ["ЛЕТФ 5 офис", []],
    ["счёт № 12 от 01.01", []],
    ["ТФ-0000", []],
  ])("«%s» → %j", (purpose, expected) => {
    expect(invoiceNumbersInPurpose(purpose)).toEqual(expected);
  });

  it("нормализация для сравнения", () => {
    expect(normalizeInvoiceNumber("тф-1")).toBe("ТФ-0001");
    expect(normalizeInvoiceNumber(null)).toBeNull();
  });

  it("documentId банка в назначении находится без учёта регистра", () => {
    expect(documentIdsInPurpose("оплата 1CF95C4F-E794-4407-BAC4-0829F19BD2BE готово")).toEqual(["1cf95c4f-e794-4407-bac4-0829f19bd2be"]);
    expect(documentIdsInPurpose("без номера")).toEqual([]);
  });
});

describe("деньги и тарифы", () => {
  it("копейки без плавающей точки", () => {
    expect(toKopecks("40.0")).toBe(4000);
    expect(toKopecks("9 000,50")).toBe(900050);
    expect(toKopecks(0.1 + 0.2)).toBe(30);
    expect(sameAmount(9000, "9000.00")).toBe(true);
    expect(sameAmount(9000, "9000.01")).toBe(false);
    expect(sameAmount(9000, "abc")).toBe(false);
  });

  it("счёт выставляется на «Старт» и «Расчёт»; у «Премиума» цены нет", () => {
    expect(payablePlan("start")?.priceRub).toBe(9000);
    expect(payablePlan("calc")?.priceRub).toBe(39000);
    expect(payablePlan("premium")).toBeNull();
    expect(payablePlan("unknown")).toBeNull();
  });

  it("сумма и позиция счёта", () => {
    expect(invoiceAmount({ priceRub: 9000 }, 1)).toBe(9000);
    expect(invoiceAmount({ priceRub: 39000 }, 3)).toBe(117000);
    expect(invoicePositionName({ name: "Старт" }, 1)).toBe("Подписка ТендерФит, тариф «Старт», 1 мес.");
  });

  it("дата счёта — по Москве: в 22:30 UTC уже следующие сутки", () => {
    expect(moscowDate(Date.parse("2026-10-20T22:30:00Z"))).toBe("2026-10-21");
    expect(moscowDate(Date.parse("2026-10-20T10:00:00Z"))).toBe("2026-10-20");
  });
});

describe("представление для клиента", () => {
  it("не раскрывает идентификаторы банка и ссылку на платёж", () => {
    const invoice: PaymentInvoice = {
      id: "i1",
      userEmail: "a@b.ru",
      plan: "start",
      amountRub: 9000,
      months: 1,
      status: "paid",
      method: "invoice",
      buyerInn: "7707083893",
      buyerKpp: null,
      buyerName: "ООО",
      buyerEmail: "a@b.ru",
      invoiceNumber: "ТФ-0001",
      tochkaDocumentId: "secret-doc",
      tochkaPaymentRef: "secret-ref",
      paidAt: 1,
      activatedUntil: 2,
      closingDocumentId: "act",
      closingSentAt: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const view = toInvoiceView(invoice);
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(view.hasPdf).toBe(true);
    expect(toInvoiceView({ ...invoice, method: "sbp_claim", tochkaDocumentId: null }).hasPdf).toBe(false);
  });
});
