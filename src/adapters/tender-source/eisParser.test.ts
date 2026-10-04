import { describe, expect, it } from "vitest";
import {
  buildCustomerIdOrg,
  buildEisSearchUrl,
  parseCustomerRefsFromOrgSearch,
  parseInnFromHref,
  parseLaw,
  parsePlacingWay,
  parsePrice,
  parseRuDate,
} from "@/adapters/tender-source/eisParser";

describe("parsePrice", () => {
  it("разбирает цену с неразрывным пробелом и рублём", () => {
    expect(parsePrice("327\u00a0148\u00a0627,57 ₽")).toBe(327148627.57);
  });
  it("разбирает цену с обычными пробелами", () => {
    expect(parsePrice("1 320 332 ₽")).toBe(1320332);
  });
  it("возвращает null для пустой строки", () => {
    expect(parsePrice("")).toBeNull();
  });
});

describe("parseRuDate", () => {
  it("преобразует дд.мм.гггг в ISO", () => {
    expect(parseRuDate("15.09.2026")).toBe("2026-09-15T00:00:00.000Z");
  });
  it("возвращает null для мусора", () => {
    expect(parseRuDate("не дата")).toBeNull();
  });
});

describe("parseLaw / parsePlacingWay", () => {
  it("определяет 44-ФЗ", () => {
    expect(parseLaw("44-ФЗ Электронный аукцион")).toBe("FZ_44");
  });
  it("определяет 223-ФЗ", () => {
    expect(parseLaw("223-ФЗ Иной способ")).toBe("FZ_223");
  });
  it("определяет аукцион", () => {
    expect(parsePlacingWay("44-ФЗ Электронный аукцион")).toBe(
      "ELECTRONIC_AUCTION",
    );
  });
  it("определяет запрос котировок", () => {
    expect(parsePlacingWay("223-ФЗ Запрос котировок в электронной форме")).toBe(
      "REQUEST_FOR_QUOTATION",
    );
  });
});

describe("buildEisSearchUrl", () => {
  it("формирует URL с параметрами поиска", () => {
    const url = buildEisSearchUrl({
      searchString: "поставка компьютеров",
      laws: ["FZ_44"],
      minPrice: 100000,
      maxPrice: 5000000,
      offset: 0,
    });
    expect(url).toContain("zakupki.gov.ru/epz/order/extendedsearch/results.html");
    expect(url).toContain("fz44=on");
    expect(url).not.toContain("fz223=on");
    expect(url).toContain("priceMin=100000");
    expect(url).toContain("priceMax=5000000");
    expect(url).toContain("searchString=");
  });
});

describe("parseInnFromHref", () => {
  it("извлекает ИНН из ссылки на организацию 223-ФЗ", () => {
    expect(
      parseInnFromHref(
        "/epz/organization/view223/info.html?&inn=2537139561&kpp=251201001",
      ),
    ).toBe("2537139561");
  });
  it("возвращает null если ИНН нет", () => {
    expect(parseInnFromHref("/epz/organization/view/info.html?organizationCode=1")).toBeNull();
  });
});

/* ==================== Поиск по конкретному заказчику ==================== */

const RZD_TITLE =
  'ОТКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "РОССИЙСКИЕ ЖЕЛЕЗНЫЕ ДОРОГИ"';
const RZD_INN = "7708503727";
const RZD_KPP = "770801001";
const RZD_ORG_ID = "1037739877295";
const RZD_CUSTOMER_ID_ORG = `-1:${RZD_TITLE}zZzZzZzZ${RZD_INN}zZzZ${RZD_KPP}zZ${RZD_ORG_ID}`;

/** Кодирует значение так же, как ЕИС: пробелы — «+», кириллица — percent-encoding. */
function encodeEis(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/** Мини-выдача /epz/organization/search/results.html с готовыми ссылками. */
function orgSearchPage(entries: { path: string; value: string }[]): string {
  const links = entries
    .map(
      (e) =>
        `<a href="${e.path}?fz223=on&customerIdOrg=${encodeEis(e.value)}">Закупки</a>`,
    )
    .join("\n");
  return `<html><body><div class="searchResult">${links}</div></body></html>`;
}

const ORDER_SEARCH_PATH = "/epz/order/extendedsearch/results.html";

describe("buildCustomerIdOrg", () => {
  it("собирает составной идентификатор заказчика в формате ЕИС", () => {
    expect(
      buildCustomerIdOrg({
        title: RZD_TITLE,
        inn: RZD_INN,
        kpp: RZD_KPP,
        orgId: RZD_ORG_ID,
      }),
    ).toBe(RZD_CUSTOMER_ID_ORG);
  });

  it("допускает отсутствие КПП", () => {
    expect(
      buildCustomerIdOrg({ title: "ООО Тест", inn: "1234567890", kpp: null, orgId: "42" }),
    ).toBe("-1:ООО ТестzZzZzZzZ1234567890zZzZzZ42");
  });
});

describe("parseCustomerRefsFromOrgSearch", () => {
  it("извлекает заказчика из ссылки на выдачу закупок", () => {
    const refs = parseCustomerRefsFromOrgSearch(
      orgSearchPage([{ path: ORDER_SEARCH_PATH, value: RZD_CUSTOMER_ID_ORG }]),
    );
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    expect(ref?.title).toBe(RZD_TITLE);
    expect(ref?.inn).toBe(RZD_INN);
    expect(ref?.kpp).toBe(RZD_KPP);
    expect(ref?.orgId).toBe(RZD_ORG_ID);
    expect(ref?.customerIdOrg).toBe(RZD_CUSTOMER_ID_ORG);
  });

  it("игнорирует ссылки реестра контрактов (там те же параметры с лишними id)", () => {
    const refs = parseCustomerRefsFromOrgSearch(
      orgSearchPage([
        { path: "/epz/contract/search/results.html", value: RZD_CUSTOMER_ID_ORG },
        { path: "/epz/contractfz223/search/results.html", value: RZD_CUSTOMER_ID_ORG },
      ]),
    );
    expect(refs).toHaveLength(0);
  });

  it("дедуплицирует по ИНН: карточка заказчика встречается в нескольких ссылках", () => {
    const refs = parseCustomerRefsFromOrgSearch(
      orgSearchPage([
        { path: ORDER_SEARCH_PATH, value: RZD_CUSTOMER_ID_ORG },
        { path: ORDER_SEARCH_PATH, value: RZD_CUSTOMER_ID_ORG },
      ]),
    );
    expect(refs).toHaveLength(1);
  });

  it("разбирает несколько разных заказчиков", () => {
    const other = `-1:ООО+ВТОРОЙ+ЗАКАЗЧИКzZzZzZzZ1234567890zZzZzZ42`;
    const refs = parseCustomerRefsFromOrgSearch(
      orgSearchPage([
        { path: ORDER_SEARCH_PATH, value: RZD_CUSTOMER_ID_ORG },
        { path: ORDER_SEARCH_PATH, value: other },
      ]),
    );
    expect(refs.map((r) => r.inn)).toEqual([RZD_INN, "1234567890"]);
    expect(refs[1]?.kpp).toBeNull();
  });

  it("пропускает значения с некорректным ИНН", () => {
    const refs = parseCustomerRefsFromOrgSearch(
      orgSearchPage([{ path: ORDER_SEARCH_PATH, value: "-1:ООО ТестzZzZzZzZ123zZzZzZ42" }]),
    );
    expect(refs).toHaveLength(0);
  });

  it("не падает на битой percent-последовательности", () => {
    const html = `<a href="${ORDER_SEARCH_PATH}?customerIdOrg=-1:%E0%A4zZzZzZzZ${RZD_INN}zZzZ${RZD_KPP}zZ${RZD_ORG_ID}">x</a>`;
    expect(parseCustomerRefsFromOrgSearch(html)).toHaveLength(0);
  });

  it("возвращает пустой массив для страницы без ссылок", () => {
    expect(parseCustomerRefsFromOrgSearch("<html><body>нет результатов</body></html>")).toEqual(
      [],
    );
  });
});

describe("buildEisSearchUrl c customerIdOrg", () => {
  it("добавляет параметр заказчика к URL выдачи", () => {
    const url = buildEisSearchUrl({
      laws: ["FZ_223"],
      customerIdOrg: RZD_CUSTOMER_ID_ORG,
      offset: 0,
    });
    expect(url).toContain("customerIdOrg=");
    expect(url).toContain("fz223=on");
    expect(url).toContain(encodeURIComponent(RZD_INN).replace(/%20/g, "+"));
    // Значение должно декокодироваться обратно в исходную строку.
    const param = new URL(url).searchParams.get("customerIdOrg");
    expect(param).toBe(RZD_CUSTOMER_ID_ORG);
  });

  it("без заказчика параметр не добавляется", () => {
    expect(buildEisSearchUrl({ laws: ["FZ_223"], offset: 0 })).not.toContain(
      "customerIdOrg",
    );
  });
});

describe("buildEisSearchUrl без регионального фильтра", () => {
  /**
   * Регионального параметра в билдере нет сознательно, а не «пока не сделали».
   * Единственный найденный на живом сайте кандидат — oktmoIds с кодами ОКТМО —
   * для пяти корректных субъектов из 85 возвращает ноль записей, то есть
   * молча опустошает ленту; измерения и разбор в docs/ACCESS_EIS.md, «Регион».
   * Тест фиксирует решение: параметр не должен появиться без проверки полноты.
   */
  it("не подставляет регион ни под одним из известных имён параметра", () => {
    const url = buildEisSearchUrl({
      laws: ["FZ_44", "FZ_223"],
      searchString: "капитальный ремонт",
      okpd2: ["43.99"],
      offset: 0,
    });
    for (const param of ["oktmo", "region", "district", "customerPlace"]) {
      expect(url.toLowerCase()).not.toContain(param);
    }
  });
});
