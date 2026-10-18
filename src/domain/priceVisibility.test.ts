import { describe, expect, it } from "vitest";
import type { Tender, TenderFinancialTerms } from "@/domain/entities";
import {
  RUB_CURRENCY,
  defaultPriceVisibility,
  isForeignCurrency,
  isPricePublished,
  isRub,
  passesPriceBounds,
  passesPriceVisibility,
  priceNote,
  unknownPriceLabel,
  type PriceVisibility,
} from "@/domain/priceVisibility";

/* ============================== Фабрика ============================== */

function makeFinancial(
  patch: Partial<TenderFinancialTerms> = {},
): TenderFinancialTerms {
  return {
    price: 1_000_000,
    currency: RUB_CURRENCY,
    advancePercent: null,
    advanceAmount: null,
    paymentTermDays: 30,
    postpaymentDays: null,
    bidSecurityAmount: null,
    bidSecurityPercent: null,
    contractSecurityAmount: null,
    contractSecurityPercent: null,
    treasurySupport: false,
    expectedMarginPercent: null,
    ...patch,
  };
}

function makeTender(patch: Partial<Tender> = {}): Tender {
  return {
    id: "t-1",
    regNumber: "01234567890",
    externalId: null,
    law: "COMMERCIAL",
    placingWay: "REQUEST_FOR_PROPOSALS",
    subject: "Поставка оборудования",
    customerName: "ООО «Заказчик»",
    customerInn: "7701234567",
    region: "Московская область",
    deliveryAddress: "г. Москва, ул. Ленина, д. 1",
    financial: makeFinancial(),
    deadlines: {
      submissionEnd: "2026-10-01T10:00:00+03:00",
      publicationDate: "2026-09-20T10:00:00+03:00",
      lastUpdateDate: "2026-09-20T10:00:00+03:00",
      deliveryTermDays: 30,
      warrantyMonths: 12,
    },
    okpd2Codes: [],
    lots: [],
    requirements: [],
    documents: [],
    nationalRegime: false,
    onlyForSmp: false,
    eisUrl: "",
    dataSource: "SBER_AST",
    changeLog: [],
    ...patch,
  };
}

/** Закупка с финансовым блоком по патчу — короткий путь для большинства кейсов. */
function tenderWithFinancial(patch: Partial<TenderFinancialTerms>): Tender {
  return makeTender({ financial: makeFinancial(patch) });
}

/* ============================== isRub / isForeignCurrency ============================== */

describe("isRub", () => {
  it("признаёт рублём RUB в любом регистре и с пробелами", () => {
    expect(isRub("RUB")).toBe(true);
    expect(isRub("rub")).toBe(true);
    expect(isRub(" RUB ")).toBe(true);
  });

  it("отсутствующая и пустая валюта считается рублём", () => {
    // Иначе закупки с неполной карточкой попали бы в «валютные» и исчезли
    // при выключенном переключателе — за отсутствующее поле выдача не наказывает.
    expect(isRub(null)).toBe(true);
    expect(isRub(undefined)).toBe(true);
    expect(isRub("")).toBe(true);
    expect(isRub("   ")).toBe(true);
  });

  it("прочие коды рублём не считаются", () => {
    expect(isRub("USD")).toBe(false);
    expect(isRub("CNY")).toBe(false);
    expect(isRub("EUR")).toBe(false);
  });
});

describe("isForeignCurrency", () => {
  it("обратна isRub", () => {
    expect(isForeignCurrency("RUB")).toBe(false);
    expect(isForeignCurrency("")).toBe(false);
    expect(isForeignCurrency(null)).toBe(false);
    expect(isForeignCurrency("USD")).toBe(true);
  });
});

/* ============================== isPricePublished ============================== */

describe("isPricePublished", () => {
  it("нуль — это «не опубликована», а не «0 ₽»", () => {
    expect(isPricePublished(tenderWithFinancial({ price: 0 }))).toBe(false);
    expect(isPricePublished(tenderWithFinancial({ price: 1_000 }))).toBe(true);
  });

  it("отрицательная цена тоже считается неопубликованной", () => {
    expect(isPricePublished(tenderWithFinancial({ price: -5 }))).toBe(false);
  });
});

/* ============================== passesPriceVisibility ============================== */

describe("passesPriceVisibility", () => {
  const noPrice = tenderWithFinancial({ price: 0 });
  const usd = tenderWithFinancial({ currency: "USD" });
  const rub = tenderWithFinancial({ price: 500_000, currency: "RUB" });

  it("по умолчанию показывает всё", () => {
    expect(defaultPriceVisibility).toEqual({
      includeUnknown: true,
      includeForeignCurrency: true,
    });
    expect(passesPriceVisibility(noPrice)).toBe(true);
    expect(passesPriceVisibility(usd)).toBe(true);
    expect(passesPriceVisibility(rub)).toBe(true);
  });

  it("выключенный переключатель скрывает закупки без НМЦ", () => {
    const off: PriceVisibility = {
      includeUnknown: false,
      includeForeignCurrency: true,
    };
    expect(passesPriceVisibility(noPrice, off)).toBe(false);
    expect(passesPriceVisibility(rub, off)).toBe(true);
  });

  it("выключенный переключатель скрывает закупки в валюте", () => {
    const off: PriceVisibility = {
      includeUnknown: true,
      includeForeignCurrency: false,
    };
    expect(passesPriceVisibility(usd, off)).toBe(false);
    expect(passesPriceVisibility(rub, off)).toBe(true);
  });

  it("оба переключателя выключены — остаются только рублёвые с ценой", () => {
    const off: PriceVisibility = {
      includeUnknown: false,
      includeForeignCurrency: false,
    };
    expect(passesPriceVisibility(noPrice, off)).toBe(false);
    expect(passesPriceVisibility(usd, off)).toBe(false);
    expect(
      passesPriceVisibility(tenderWithFinancial({ price: 0, currency: "USD" }), off),
    ).toBe(false);
    expect(passesPriceVisibility(rub, off)).toBe(true);
  });

  it("закупка в валюте с опубликованной ценой не скрывается переключателем НМЦ", () => {
    const off: PriceVisibility = {
      includeUnknown: false,
      includeForeignCurrency: true,
    };
    expect(passesPriceVisibility(tenderWithFinancial({ price: 900, currency: "USD" }), off)).toBe(
      true,
    );
  });
});

/* ============================== passesPriceBounds ============================== */

describe("passesPriceBounds", () => {
  it("неопубликованная цена границам не препятствует", () => {
    // Главный дефект, который чиним: «от 100 000 ₽» не должен скрывать
    // коммерческие закупки без НМЦ.
    expect(passesPriceBounds(0, 100_000, 5_000_000)).toBe(true);
    expect(passesPriceBounds(null, 100_000, null)).toBe(true);
    expect(passesPriceBounds(undefined, null, 500)).toBe(true);
  });

  it("опубликованная цена проверяется по обеим границам", () => {
    expect(passesPriceBounds(50, 100, null)).toBe(false);
    expect(passesPriceBounds(150, 100, null)).toBe(true);
    expect(passesPriceBounds(150, null, 100)).toBe(false);
    expect(passesPriceBounds(50, null, 100)).toBe(true);
  });

  it("границы включительно", () => {
    expect(passesPriceBounds(100, 100, 100)).toBe(true);
  });

  it("без границ проходит любая цена", () => {
    expect(passesPriceBounds(1, null, null)).toBe(true);
    expect(passesPriceBounds(0, null, null)).toBe(true);
  });
});

/* ============================== priceNote ============================== */

describe("priceNote", () => {
  it("без цены — пометка «Цена не указана»", () => {
    expect(priceNote(tenderWithFinancial({ price: 0 }))).toBe(unknownPriceLabel);
    expect(unknownPriceLabel).toBe("Цена не указана");
  });

  it("цена в валюте — пометка с кодом валюты", () => {
    expect(priceNote(tenderWithFinancial({ currency: "USD" }))).toBe("Цена в USD");
    expect(priceNote(tenderWithFinancial({ currency: "cny" }))).toBe("Цена в CNY");
  });

  it("отсутствие цены важнее валюты", () => {
    expect(priceNote(tenderWithFinancial({ price: 0, currency: "USD" }))).toBe(
      unknownPriceLabel,
    );
  });

  it("обычная рублёвая закупка подписи не получает", () => {
    expect(priceNote(tenderWithFinancial({ price: 500_000, currency: "RUB" }))).toBeNull();
    // Пустая валюта — тоже рубли, иначе половина импорта получила бы подпись.
    expect(priceNote(tenderWithFinancial({ price: 500_000, currency: "" }))).toBeNull();
  });
});
