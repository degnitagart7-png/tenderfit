import { describe, expect, it } from "vitest";
import type { TenderFinancialTerms } from "@/domain/entities";
import {
  applyDocumentTerms,
  extractDocumentTerms,
  mergeDocumentTerms,
  parseDocumentTerms,
  type DocumentTerm,
} from "@/domain/documentTerms";

/*
  Фрагменты взяты из живых документов базы (форма извещения ЕИС, проекты
  контрактов и документация 223-ФЗ) — именно на них подбирались шаблоны.
*/
const EIS_NOTICE = `оказываемых услуг иностранными лицами
Обеспечение заявки
Требуется обеспечение заявки
Размер обеспечения заявки
4353541.53 РОССИЙСКИЙ РУБЛЬ
Порядок внесения денежных средств в качестве обеспечения заявки на участие в закупке
Обеспечение исполнения контракта
Требуется обеспечение исполнения контракта
Размер обеспечения исполнения контракта
5.00%
Порядок обеспечения исполнения контракта, требования к обеспечению`;

describe("extractDocumentTerms: извещение ЕИС", () => {
  it("читает сумму обеспечения заявки и процент обеспечения контракта", () => {
    const terms = extractDocumentTerms(EIS_NOTICE);
    expect(terms.bidSecurity).toMatchObject({
      required: true,
      amount: 4353541.53,
      percent: null,
      strong: true,
    });
    expect(terms.bidSecurity?.quote).toBe(
      "Размер обеспечения заявки 4353541.53 РОССИЙСКИЙ РУБЛЬ",
    );
    expect(terms.contractSecurity).toMatchObject({
      required: true,
      percent: 5,
      amount: null,
    });
  });

  it("сумма обеспечения контракта в рублях", () => {
    const terms = extractDocumentTerms(
      "Размер обеспечения исполнения контракта\n21767707.64 РОССИЙСКИЙ РУБЛЬ\nПорядок",
    );
    expect(terms.contractSecurity?.amount).toBe(21767707.64);
  });

  it("аванс: знак процента в подписи, число на следующей строке", () => {
    const terms = extractDocumentTerms(
      "Начальная (максимальная) цена контракта\n252188697.22 РОССИЙСКИЙ РУБЛЬ\nАванс, %\n30.00\nНомер принимаемого бюджетного обязательства\n3020011826380000911",
    );
    expect(terms.advance).toMatchObject({ required: true, percent: 30 });
  });
});

describe("extractDocumentTerms: проза документации", () => {
  it("аванс в проекте контракта", () => {
    const terms = extractDocumentTerms(
      "Оплата по Контракту производится с авансовым платежом в размере 30% от стоимости Контракта.",
    );
    expect(terms.advance).toMatchObject({
      required: true,
      percent: 30,
      strong: true,
    });
  });

  it("явные отказы", () => {
    expect(
      extractDocumentTerms("Обеспечение заявок не требуется.").bidSecurity
        ?.required,
    ).toBe(false);
    expect(
      extractDocumentTerms(
        "Обеспечение заявки на участие в закупке\n\nне требуется",
      ).bidSecurity?.required,
    ).toBe(false);
    expect(
      extractDocumentTerms("Обеспечение исполнения контракта не установлено.")
        .contractSecurity?.required,
    ).toBe(false);
    expect(
      extractDocumentTerms(
        "Размер аванса (если предусмотрена выплата аванса)\n\nВыплата аванса не предусмотрена.",
      ).advance,
    ).toMatchObject({ required: false, percent: null });
    expect(
      extractDocumentTerms("Аванс в размере  0,00 %").advance?.required,
    ).toBe(false);
  });
});

describe("extractDocumentTerms: ловушки", () => {
  it("рамки закона — не условие закупки", () => {
    expect(
      extractDocumentTerms(
        "Заказчик вправе перечислить Подрядчику аванс в размере не более 1 029 415 (один миллион) рублей",
      ).advance,
    ).toBeUndefined();
    expect(
      extractDocumentTerms(
        "Размер обеспечения заявки составляет от 0,5 до 1% НМЦК",
      ).bidSecurity,
    ).toBeUndefined();
  });

  it("условная фраза не считается отказом", () => {
    expect(
      extractDocumentTerms(
        "В случае если обеспечение заявки не требуется, участник вправе",
      ).bidSecurity,
    ).toBeUndefined();
  });

  it("оглавление, гарантийные обязательства и чужое упоминание пропускаются", () => {
    const terms = extractDocumentTerms(
      "4.18 Особенности проведения закупки с необходимостью обеспечения заявки\t43\n" +
        "Требование к обеспечению исполнения гарантийных обязательств не устанавливается.\n" +
        "внесение денежных средств в качестве обеспечения заявки на участие в закупке, обеспечения исполнения контракта является крупной сделкой;",
    );
    expect(terms).toEqual({});
  });

  it("обеспечение возврата аванса — не про сам аванс", () => {
    expect(
      extractDocumentTerms("Обеспечение возврата аванса не предусмотрено.")
        .advance,
    ).toBeUndefined();
  });

  it("сумма больше цены закупки отбрасывается", () => {
    expect(
      extractDocumentTerms(
        "Размер обеспечения заявки\n4353541.53 РОССИЙСКИЙ РУБЛЬ",
        {
          price: 100_000,
        },
      ).bidSecurity,
    ).toBeUndefined();
  });
});

const weak: DocumentTerm = {
  required: false,
  percent: null,
  amount: null,
  quote: "нет",
  strong: false,
};
const strong: DocumentTerm = {
  required: true,
  percent: 5,
  amount: null,
  quote: "5%",
  strong: true,
};

describe("mergeDocumentTerms", () => {
  it("сильный реквизит заменяет слабый вывод, но не наоборот", () => {
    expect(
      mergeDocumentTerms(
        { contractSecurity: weak },
        { contractSecurity: strong },
      ),
    ).toEqual({
      contractSecurity: strong,
    });
    expect(
      mergeDocumentTerms(
        { contractSecurity: strong },
        { contractSecurity: weak },
      ),
    ).toEqual({
      contractSecurity: strong,
    });
  });

  it("новое условие добавляется к найденному раньше", () => {
    expect(
      mergeDocumentTerms({ advance: weak }, { bidSecurity: strong }),
    ).toEqual({
      advance: weak,
      bidSecurity: strong,
    });
  });
});

describe("parseDocumentTerms", () => {
  it("пустое и битое — null", () => {
    expect(parseDocumentTerms(null)).toBeNull();
    expect(parseDocumentTerms({ bidSecurity: { required: "да" } })).toBeNull();
    expect(parseDocumentTerms({})).toBeNull();
  });

  it("читает сохранённое", () => {
    expect(parseDocumentTerms({ advance: weak })).toEqual({ advance: weak });
  });
});

function financial(
  patch: Partial<TenderFinancialTerms> = {},
): TenderFinancialTerms {
  return {
    price: 2_000_000,
    currency: "RUB",
    advancePercent: null,
    advanceAmount: null,
    paymentTermDays: 0,
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

describe("applyDocumentTerms", () => {
  it("дополняет пустые поля и пересчитывает процент в сумму", () => {
    const { financial: f, applied } = applyDocumentTerms(financial(), {
      contractSecurity: strong,
      advance: weak,
    });
    expect(f.contractSecurityPercent).toBe(5);
    expect(f.contractSecurityAmount).toBe(100_000);
    expect(f.advancePercent).toBeNull();
    expect(applied).toEqual({ contractSecurity: strong, advance: weak });
  });

  it("реквизит площадки главнее документации", () => {
    const { financial: f, applied } = applyDocumentTerms(
      financial({ contractSecurityAmount: 50_000 }),
      { contractSecurity: strong },
    );
    expect(f.contractSecurityAmount).toBe(50_000);
    expect(applied).toBeNull();
  });

  it("к долларовой закупке рублёвая сумма не прикладывается", () => {
    const { financial: f, applied } = applyDocumentTerms(
      financial({ currency: "USD" }),
      {
        bidSecurity: {
          required: true,
          percent: null,
          amount: 1000,
          quote: "1000 руб",
          strong: true,
        },
      },
    );
    expect(f.bidSecurityAmount).toBeNull();
    expect(applied).toBeNull();
  });
});
