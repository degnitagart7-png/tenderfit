/**
 * Тесты разбора выдачи Фабриканта. Сети нет: страницы собирают фикстуры.
 */
import { describe, expect, it } from "vitest";

import {
  FABRIKANT_BASE_URL,
  FABRIKANT_DEFAULT_SECTIONS,
  FABRIKANT_OPEN_STATUSES,
  FABRIKANT_PAGE_LIMIT,
  FABRIKANT_SECTIONS,
  fabrikantFlightText,
  fabrikantHasNextPage,
  fabrikantSearchUrl,
  isFabrikantSearchPage,
  parseFabrikantSearch,
} from "./fabrikantSearch";
import {
  FABRIKANT_VERBATIM_CARD_PROPS,
  buildFabrikantSearchPage,
} from "./fabrikantTestFixtures";

describe("fabrikantSearchUrl", () => {
  it("собирает адрес поиска с номером страницы, пределом и сортировкой по дате", () => {
    const url = fabrikantSearchUrl({ page: 2, sections: [2, 5], statuses: [1, 5], query: "насадка" });

    expect(url.startsWith(`${FABRIKANT_BASE_URL}/procedure/search/purchases?`)).toBe(true);
    expect(url).toContain("page_number=2");
    expect(url).toContain(`page_limit=${FABRIKANT_PAGE_LIMIT}`);
    expect(url).toContain("section_ids%5B%5D=2");
    expect(url).toContain("section_ids%5B%5D=5");
    expect(url).toContain("statuses%5B%5D=1");
    expect(url).toContain("statuses%5B%5D=5");
    expect(url).toContain("sort_order=date_publication");
    expect(url).toContain("sort_direction=desc");
    // Кириллица кодируется всегда одинаково и не зависит от локали машины.
    expect(url).toContain("query=%D0%BD%D0%B0%D1%81%D0%B0%D0%B4%D0%BA%D0%B0");
  });

  it("не добавляет пустое ключевое слово и пустые границы цены", () => {
    const url = fabrikantSearchUrl({ query: "   ", priceFrom: null, priceTo: undefined });

    expect(url).not.toContain("query=");
    expect(url).not.toContain("price_from");
    expect(url).not.toContain("price_to");
  });

  it("добавляет границы цены, когда они заданы", () => {
    const url = fabrikantSearchUrl({ priceFrom: 100_000, priceTo: 5_000_000 });

    expect(url).toContain("price_from=100000");
    expect(url).toContain("price_to=5000000");
  });

  it("первая страница по умолчанию и хост можно заменить", () => {
    expect(fabrikantSearchUrl({}, "https://example.test")).toBe(
      `https://example.test/procedure/search/purchases?page_number=1&page_limit=${FABRIKANT_PAGE_LIMIT}&sort_order=date_publication&sort_direction=desc`,
    );
  });
});

describe("словари площадки", () => {
  it("секция описана до того, как попадёт в набор по умолчанию", () => {
    for (const section of FABRIKANT_DEFAULT_SECTIONS) {
      expect(FABRIKANT_SECTIONS[section], `секция ${section} не описана`).toBeTruthy();
    }
  });

  it("набор по умолчанию не содержит зеркала ЕИС, Маркета и капремонта", () => {
    // 12 — зеркало ЕИС: 40 из 40 открытых закупок несут номер извещения.
    expect(FABRIKANT_DEFAULT_SECTIONS).not.toContain(12);
    // 16 — Маркет: карточки живут на `market.fabrikant.ru`, страницы `/v2` у них нет.
    expect(FABRIKANT_DEFAULT_SECTIONS).not.toContain(16);
    // 14 — капремонт: на `/purchases` идентификатор молча игнорируется.
    expect(FABRIKANT_DEFAULT_SECTIONS).not.toContain(14);
    // 8 — продажи, а не закупки.
    expect(FABRIKANT_DEFAULT_SECTIONS).not.toContain(8);
  });

  it("открытые статусы — приём заявок и ожидание приёма", () => {
    expect(FABRIKANT_OPEN_STATUSES).toEqual([1, 5]);
  });
});

describe("fabrikantFlightText", () => {
  it("собирает текст из нескольких кусков push, а не берёт первый", () => {
    const html = buildFabrikantSearchPage({
      cards: [{ name: "Поставка первой", lotId: 1, procedureNumber: 100 }],
      total: 1,
      pages: 1,
    });

    const flight = fabrikantFlightText(html);

    expect(flight).toContain("Поставка первой");
    expect(flight).toContain('"total":1');
  });

  it("возвращает пустую строку, когда flight в ответе нет вовсе", () => {
    expect(fabrikantFlightText("<html><body>Доступ ограничен</body></html>")).toBe("");
  });

  it("восстанавливает вложенные кавычки названия одним разбором JSON", () => {
    const html = buildFabrikantSearchPage({ verbatimProps: [FABRIKANT_VERBATIM_CARD_PROPS] });

    const page = parseFabrikantSearch(html);

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.subject).toBe(
      'Строительно-монтажные работы по объекту "Склад сырьевой соли с узлом солерастворения", часть КМ',
    );
  });
});

describe("parseFabrikantSearch", () => {
  it("разбирает карточки выдачи в строки-лоты", () => {
    const html = buildFabrikantSearchPage({
      cards: [
        {
          name: "Поставка смазочных материалов",
          lotId: 679661088,
          procedureNumber: 5581328,
          sectionEnum: "commercial",
          sequenceNumber: 1,
          url: "https://fabrikant.ru/v2/trades/procedure/view/VEfh8dM8T7aBMwFbWZ4HXg",
        },
        {
          name: "Выполнение работ по ремонту",
          lotId: 679700001,
          procedureNumber: 5582001,
          sectionEnum: "223fz",
          purchaseOosNumber: "32616400001",
          sequenceNumber: 2,
          url: "https://fabrikant.ru/v2/trades/procedure/view/uGv6xMzUFpVXTEsOwXLGfw",
        },
      ],
      total: 179,
      pages: 5,
    });

    const page = parseFabrikantSearch(html);

    expect(page.noResults).toBe(false);
    expect(page.total).toBe(179);
    expect(page.pages).toBe(5);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toEqual({
      procedureNumber: "5581328",
      lotId: "679661088",
      sequenceNumber: 1,
      subject: "Поставка смазочных материалов",
      sectionEnum: "commercial",
      eisNumber: null,
      cardUrl: "https://fabrikant.ru/v2/trades/procedure/view/VEfh8dM8T7aBMwFbWZ4HXg",
    });
    expect(page.rows[1]?.eisNumber).toBe("32616400001");
    expect(page.rows[1]?.sectionEnum).toBe("223fz");
  });

  it("не принимает объект-приманку за карточку", () => {
    // Площадка печатает рядом с каждой карточкой `{"url":null,"oosNumber":null,"lotId":…}`:
    // в живой выдаче 80 вхождений `{"url":` на 40 закупок.
    const html = buildFabrikantSearchPage({
      cards: [{ name: "Поставка одной позиции", lotId: 42, procedureNumber: 4242 }],
      total: 1,
      pages: 1,
    });

    expect(parseFabrikantSearch(html).rows).toHaveLength(1);
  });

  it("кодирует `$undefined` секции пустой строкой, а не словом площадки", () => {
    const html = buildFabrikantSearchPage({
      cards: [
        {
          name: "Поставка канальных фанкойлов",
          lotId: 679703808,
          procedureNumber: 5582381,
          sectionEnum: null,
          url: "https://market.fabrikant.ru/purchase_notice_es/view?id=01m3ycgche2yja6epmk88912k2",
        },
      ],
      total: 1,
      pages: 1,
    });

    const page = parseFabrikantSearch(html);

    expect(page.rows[0]?.sectionEnum).toBe("");
    expect(page.rows[0]?.cardUrl).toContain("market.fabrikant.ru");
  });

  it("отдаёт пустой адрес карточки, когда площадка его не напечатала", () => {
    const html = buildFabrikantSearchPage({
      cards: [{ name: "Позиция без адреса", lotId: 7, procedureNumber: 777, url: null }],
      total: 1,
      pages: 1,
    });

    expect(parseFabrikantSearch(html).rows[0]?.cardUrl).toBe("");
  });

  it("сохраняет порядок строк выдачи", () => {
    const html = buildFabrikantSearchPage({
      cards: [3, 1, 2].map((number) => ({
        name: `Закупка ${number}`,
        lotId: number,
        procedureNumber: number,
      })),
      total: 3,
      pages: 1,
    });

    expect(parseFabrikantSearch(html).rows.map((row) => row.procedureNumber)).toEqual(["3", "1", "2"]);
  });

  it("читает пустую выдачу как ответ площадки, а не как сбой", () => {
    const html = buildFabrikantSearchPage({ noResults: true });

    const page = parseFabrikantSearch(html);

    expect(page.rows).toHaveLength(0);
    expect(page.noResults).toBe(true);
    expect(page.total).toBeNull();
    expect(page.pages).toBeNull();
  });

  it("не выдаёт пустой ответ за «ничего не найдено»", () => {
    const page = parseFabrikantSearch("<html><body></body></html>");

    expect(page.noResults).toBe(false);
    expect(page.rows).toHaveLength(0);
    expect(page.pages).toBeNull();
  });

  it("читает отказ показать закупку как ответ площадки, а не как сбой разбора", () => {
    // Живой замер 02.10.2026: на запрос «МФУ» площадка отвечает HTTP 200 и
    // страницей, в которой нет ни строк, ни пагинации, ни отметки «ничего не
    // найдено» — вместо них «Доступ к просмотру процедуры ограничен …
    // авторизуйтесь на ЭТП». Закупки она нашла и не показала анонимному
    // посетителю, и это третий исход, отличный и от выдачи, и от пустоты.
    const page = parseFabrikantSearch(buildFabrikantSearchPage({ restricted: true }));

    expect(page.rows).toHaveLength(0);
    expect(page.restricted).toBe(true);
    // Подмена ограничения пустотой сказала бы владельцу, что таких закупок нет
    // вовсе, — журнал прогона обязан называть причину площадкой, а не нами.
    expect(page.noResults).toBe(false);
    expect(page.pages).toBeNull();
  });

  it("у выдачи и у честной пустоты признака ограничения нет", () => {
    const withCards = parseFabrikantSearch(
      buildFabrikantSearchPage({
        cards: [{ name: "Поставка", lotId: 1, procedureNumber: 1 }],
        total: 1,
        pages: 1,
      }),
    );
    const empty = parseFabrikantSearch(buildFabrikantSearchPage({ noResults: true }));

    expect(withCards.restricted).toBe(false);
    expect(empty.restricted).toBe(false);
  });
});

describe("fabrikantHasNextPage", () => {
  const page = (pages: number | null) => ({
    rows: [],
    total: pages,
    pages,
    noResults: false,
    restricted: false,
  });

  it("страницы ещё есть, пока не дошли до объявленного площадкой числа", () => {
    expect(fabrikantHasNextPage(page(5), 1)).toBe(true);
    expect(fabrikantHasNextPage(page(5), 4)).toBe(true);
    expect(fabrikantHasNextPage(page(5), 5)).toBe(false);
    expect(fabrikantHasNextPage(page(5), 6)).toBe(false);
  });

  it("без объявленного числа страниц продолжать некуда", () => {
    expect(fabrikantHasNextPage(page(null), 1)).toBe(false);
  });

  it("на пустой выдаче следующей страницы нет", () => {
    expect(
      fabrikantHasNextPage({ rows: [], total: null, pages: null, noResults: true, restricted: false }, 1),
    ).toBe(false);
  });

  it("на странице с ограниченным доступом листать нечего", () => {
    expect(
      fabrikantHasNextPage({ rows: [], total: null, pages: null, noResults: false, restricted: true }, 1),
    ).toBe(false);
  });
});

describe("isFabrikantSearchPage", () => {
  it("узнаёт страницу выдачи с карточками", () => {
    const html = buildFabrikantSearchPage({
      cards: [{ name: "Поставка", lotId: 1, procedureNumber: 1 }],
      total: 1,
      pages: 1,
    });

    expect(isFabrikantSearchPage(html)).toBe(true);
  });

  it("узнаёт пустую выдачу", () => {
    expect(isFabrikantSearchPage(buildFabrikantSearchPage({ noResults: true }))).toBe(true);
  });

  it("узнаёт страницу с ограниченным доступом: это ответ площадки, а не заглушка", () => {
    // Без этого признания адаптер тратит три повтора на исправный ответ HTTP 200
    // и роняет весь профиль поиска — живой прогон 02.10.2026 потерял так все
    // пять слов профиля «Компьютеры и оргтехника».
    expect(isFabrikantSearchPage(buildFabrikantSearchPage({ restricted: true }))).toBe(true);
  });

  it("не принимает страницу антибота или заглушку провайдера за выдачу", () => {
    expect(isFabrikantSearchPage("<html><body>Доступ ограничен</body></html>")).toBe(false);
    expect(isFabrikantSearchPage("")).toBe(false);
    // Flight есть, но ни карточек, ни пагинации, ни слов площадки — это не выдача.
    expect(
      isFabrikantSearchPage('<script>self.__next_f.push([1,"1:\\"$L1\\"\\n"])</script>'),
    ).toBe(false);
  });
});
