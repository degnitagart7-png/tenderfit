import { describe, expect, it } from "vitest";
import {
  ROSELTORG_DEFAULT_SECTIONS,
  ROSELTORG_OPEN_STATUSES,
  ROSELTORG_SECTIONS,
  parseRoseltorgAmount,
  parseRoseltorgDeadline,
  parseRoseltorgSearch,
  roseltorgSearchUrl,
} from "./roseltorgSearch";
import {
  ROSELTORG_COMMERCIAL_ITEM,
  ROSELTORG_FZ223_ITEM,
  ROSELTORG_FZ44_ITEM,
  ROSELTORG_MULTI_LOT_ITEMS,
  ROSELTORG_PRICED_ITEM,
  ROSELTORG_STALE_ITEM,
  ROSELTORG_UNKNOWN_REGION_ITEM,
  ROSELTORG_VERBATIM_ITEM,
  buildRoseltorgSearchPage,
  roseltorgItem,
} from "./roseltorgTestFixtures";

describe("roseltorgSearchUrl", () => {
  it("собирает адрес фрагмента выдачи с фильтрами секций и статусов", () => {
    const url = roseltorgSearchUrl({ page: 0, sections: [2, 24], statuses: [5, 0] });
    expect(url).toBe(
      "https://www.roseltorg.ru/procedures/search_ajax?page=0" +
        "&source%5B%5D=2&source%5B%5D=24&status%5B%5D=5&status%5B%5D=0",
    );
  });

  it("кодирует ключевое слово, не полагаясь на локаль", () => {
    const url = roseltorgSearchUrl({ page: 1, query: "насадка" });
    expect(url).toBe(
      "https://www.roseltorg.ru/procedures/search_ajax?page=1" +
        "&query_field=%D0%BD%D0%B0%D1%81%D0%B0%D0%B4%D0%BA%D0%B0",
    );
  });

  it("не добавляет пустые параметры", () => {
    expect(roseltorgSearchUrl()).toBe("https://www.roseltorg.ru/procedures/search_ajax?page=0");
    expect(roseltorgSearchUrl({ query: "   " })).not.toContain("query_field");
    expect(roseltorgSearchUrl({ sections: [] })).not.toContain("source");
  });
});

describe("parseRoseltorgAmount", () => {
  it("собирает число из разрядов, неразрывных пробелов и копеек в <sub>", () => {
    expect(parseRoseltorgAmount("986\u00a0<sub>,23</sub> ₽")).toBe(986.23);
    expect(parseRoseltorgAmount("3 500 000,00 ₽")).toBe(3_500_000);
    expect(parseRoseltorgAmount("0,00 ₽")).toBe(0);
  });

  it("возвращает null, когда цена не опубликована", () => {
    expect(parseRoseltorgAmount("-")).toBeNull();
    expect(parseRoseltorgAmount("")).toBeNull();
    expect(parseRoseltorgAmount("   ")).toBeNull();
  });
});

describe("parseRoseltorgDeadline", () => {
  it("разбирает дату и время площадки в московский момент", () => {
    expect(parseRoseltorgDeadline("01.12.2025 в 08:42")).toBe("2025-12-01T08:42:00+03:00");
    expect(parseRoseltorgDeadline("19.10.2026 в 07:00\n")).toBe("2026-10-19T07:00:00+03:00");
  });

  it("допускает дату без времени", () => {
    expect(parseRoseltorgDeadline("12.10.2026")).toBe("2026-10-12T00:00:00+03:00");
  });

  it("не выдумывает дату, которую не смог прочитать", () => {
    expect(parseRoseltorgDeadline("")).toBe("");
    expect(parseRoseltorgDeadline("в ближайшее время")).toBe("");
    expect(parseRoseltorgDeadline("99.99.9999 в 00:00")).toBe("");
  });
});

describe("parseRoseltorgSearch — дословная строка площадки", () => {
  const page = parseRoseltorgSearch(
    buildRoseltorgSearchPage({ items: [ROSELTORG_VERBATIM_ITEM] }),
  );

  it("читает номер процедуры и лота из атрибутов строки", () => {
    expect(page.rows).toHaveLength(1);
    const row = page.rows[0];
    expect(row?.procedureNumber).toBe("SP10087155");
    expect(row?.lotNumber).toBe(11);
    expect(row?.url).toBe("https://www.roseltorg.ru/procedure/SP10087155/11");
  });

  it("снимает подсветку совпадения и склеивает текст без лишних пробелов", () => {
    expect(page.rows[0]?.subject).toBe(
      "Швабра с флаундером 40 см с насадкой МОП, черенок 85-140 см, насадка МОП (608414), YORK «Pepita», 81302",
    );
    expect(page.rows[0]?.subject).not.toContain("<b");
  });

  it("читает секцию, регион, организатора и его ИНН", () => {
    const row = page.rows[0];
    expect(row?.sectionTitle).toBe("Портал Поставщиков");
    expect(row?.region).toBe("77. г. Москва");
    expect(row?.organizerName).toBe("управа Нижегородского района города Москвы");
    expect(row?.organizerInn).toBe("7722275279");
  });

  it("читает цену, признак НДС и способ размещения", () => {
    const row = page.rows[0];
    expect(row?.price).toBe(986.23);
    expect(row?.currency).toBe("RUB");
    expect(row?.vatIncluded).toBe(true);
    expect(row?.placingWayTitle).toBe("Аукцион");
  });

  it("приводит срок приёма заявок к московскому моменту", () => {
    expect(page.rows[0]?.submissionEnd).toBe("2025-12-01T08:42:00+03:00");
  });

  it("без кнопки «Далее» считает выдачу последней страницей", () => {
    expect(page.hasNextPage).toBe(false);
    expect(page.noResults).toBe(false);
  });
});

describe("parseRoseltorgSearch — варианты строк", () => {
  it("строка без блока цены даёт price null, а не нуль", () => {
    const page = parseRoseltorgSearch(
      buildRoseltorgSearchPage({ items: [ROSELTORG_COMMERCIAL_ITEM] }),
    );
    expect(page.rows[0]?.price).toBeNull();
    expect(page.rows[0]?.vatIncluded).toBeNull();
    expect(page.rows[0]?.placingWayTitle).toBe(
      "Процедура по закупке с выбором победителя",
    );
  });

  it("«Без учета НДС» распознаётся как ложный признак", () => {
    const page = parseRoseltorgSearch(buildRoseltorgSearchPage({ items: [ROSELTORG_FZ223_ITEM] }));
    expect(page.rows[0]?.vatIncluded).toBe(false);
    expect(page.rows[0]?.price).toBe(9927.2);
  });

  it("различает номера ЕИС по длине и ведущей цифре", () => {
    const page = parseRoseltorgSearch(
      buildRoseltorgSearchPage({ items: [ROSELTORG_FZ44_ITEM, ROSELTORG_FZ223_ITEM] }),
    );
    expect(page.rows.map((row) => row.procedureNumber)).toEqual([
      "0373200045226001469",
      "32616431984",
    ]);
  });

  it("сохраняет порядок лотов многолотовой процедуры", () => {
    const page = parseRoseltorgSearch(
      buildRoseltorgSearchPage({ items: ROSELTORG_MULTI_LOT_ITEMS }),
    );
    expect(page.rows).toHaveLength(3);
    expect(page.rows.map((row) => row.lotNumber)).toEqual([1, 2, 3]);
    expect(page.rows.map((row) => row.procedureNumber)).toEqual([
      "B2509261618185",
      "B2509261618185",
      "B2509261618185",
    ]);
  });

  it("читает регион, который площадка не смогла определить", () => {
    const page = parseRoseltorgSearch(
      buildRoseltorgSearchPage({ items: [ROSELTORG_UNKNOWN_REGION_ITEM] }),
    );
    expect(page.rows[0]?.region).toBe("99. Не указан");
  });

  it("читает прошедший срок как есть: отбрасывать его — работа адаптера", () => {
    const page = parseRoseltorgSearch(
      buildRoseltorgSearchPage({ items: [ROSELTORG_STALE_ITEM] }),
    );
    expect(page.rows[0]?.submissionEnd).toBe("2025-09-17T08:00:00+03:00");
  });

  it("убирает счётчик дней из статуса", () => {
    const page = parseRoseltorgSearch(
      buildRoseltorgSearchPage({
        items: [
          roseltorgItem({
            procedureNumber: "COM02102600102",
            lotNumber: 1,
            subject: "Поставка оборудования",
            sectionTitle: "Коммерческие закупки и закупки по 223-ФЗ",
            region: "66. Свердловская область",
            organizerName: "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ",
            organizerInn: "6664003909",
            price: "1000,00",
            placingWayTitle: "Запрос предложений",
            statusTitle: "Прием заявок 5 д",
            deadline: "10.10.2026 в 10:00",
          }),
        ],
      }),
    );
    expect(page.rows[0]?.statusTitle).toBe("Прием заявок");
  });

  it("не падает на строке, из которой площадка убрала часть полей", () => {
    const page = parseRoseltorgSearch(
      '<div class="search-results"><div class="search-results__item autoload-post"></div></div>',
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.procedureNumber).toBe("");
    expect(page.rows[0]?.subject).toBe("");
    expect(page.rows[0]?.price).toBeNull();
    expect(page.rows[0]?.submissionEnd).toBe("");
  });
});

describe("parseRoseltorgSearch — пагинация и пустая выдача", () => {
  it("кнопка «Далее» означает, что страница не последняя", () => {
    const page = parseRoseltorgSearch(
      buildRoseltorgSearchPage({ items: [ROSELTORG_PRICED_ITEM], hasNextPage: true, nextPage: 1 }),
    );
    expect(page.hasNextPage).toBe(true);
    expect(page.rows).toHaveLength(1);
  });

  it("фрагмент «Нет результатов» отличается от пустого списка", () => {
    const page = parseRoseltorgSearch(buildRoseltorgSearchPage({ items: [], noResults: true }));
    expect(page.noResults).toBe(true);
    expect(page.rows).toHaveLength(0);
    expect(page.hasNextPage).toBe(false);
  });

  it("пустой ответ не считается ни концом выдачи, ни ошибкой разбора", () => {
    const page = parseRoseltorgSearch("");
    expect(page.rows).toHaveLength(0);
    expect(page.noResults).toBe(false);
    expect(page.hasNextPage).toBe(false);
  });
});

describe("словари площадки", () => {
  it("секции сняты с формы поиска целиком", () => {
    // Полный словарь из разметки формы; проверка мешает молча потерять секцию
    // при правке списка по умолчанию.
    expect(Object.keys(ROSELTORG_SECTIONS)).toHaveLength(15);
    expect(ROSELTORG_SECTIONS[24]).toBe("Росэлторг.Бизнес");
    expect(ROSELTORG_SECTIONS[25]).toBe("Портал Поставщиков");
    expect(ROSELTORG_SECTIONS[1]).toBe("Государственные закупки (44-ФЗ)");
  });

  it("набор по умолчанию не содержит ни ЕИС-зеркала, ни интернет-магазинов", () => {
    expect(ROSELTORG_DEFAULT_SECTIONS).toEqual([2, 28, 24, 3, 6, 8, 12, 14, 18, 29]);
    // 1 и 13 — зеркало ЕИС, 20 и 21 — интернет-магазины, 25 — Портал Поставщиков.
    for (const excluded of [1, 13, 20, 21, 25]) {
      expect(ROSELTORG_DEFAULT_SECTIONS).not.toContain(excluded);
    }
    for (const section of ROSELTORG_DEFAULT_SECTIONS) {
      expect(ROSELTORG_SECTIONS[section]).toBeTruthy();
    }
  });

  it("в выдачу берутся только открытые статусы", () => {
    expect(ROSELTORG_OPEN_STATUSES).toEqual([5, 0]);
  });
});
