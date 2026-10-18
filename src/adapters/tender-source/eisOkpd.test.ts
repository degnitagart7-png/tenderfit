import { describe, expect, it, vi } from "vitest";

import {
  extractOkpd2Codes,
  fetchEisOkpd2,
  findLotListHref,
} from "@/adapters/tender-source/eisOkpd";

/**
 * ОКПД2 из карточки ЕИС.
 *
 * Ни у одной закупки в базе не было кода: у Контура в выдаче его нет, у
 * Сбербанк-АСТ он только в карточке, ЕИС отдаёт его на вкладке карточки, а
 * адаптер выдачу читал, но в карточку не ходил. Разбор построен по
 * настоящей разметке, снятой 04.10.2026 с живого сайта.
 */

/** 44-ФЗ, печатная форма: код — ячейка таблицы «Объект закупки». */
const PRINT_FORM_44 = `
<table class="blockInfo__table tableBlock">
  <tr><th>Наименование</th><th>Код позиции</th><th>Тип</th><th>Единица</th></tr>
  <tr>
    <td>Содержание дорог Кувандыкского муниципального округа (г. Кувандык, участок № 4)<br> Идентификатор: 224001647</td>
    <td>42.11.20.300</td>
    <td>Работа</td>
    <td class="centered">Условная единица</td>
  </tr>
</table>
<p>Размещено 01.10.2026, обновлено 03.10.2026, срок до 15.10.2026 08:00</p>
<p>Начальная цена 48 520 472,72</p>`;

/** 223-ФЗ, вкладка лотов: колонки «ОКПД2» и «ОКВЭД2» рядом. */
const LOT_LIST_223 = `
<table>
  <tr><th>№</th><th>Предмет</th><th>Классификация по ОКПД2</th><th>Классификация по ОКВЭД2</th></tr>
  <tr>
    <td>1</td>
    <td>Поставка сервера с целью обеспечения администрирования ИТ-инфраструктуры
        Начальная (максимальная) цена договора: 48 520 472,72 &#8381;</td>
    <td class=""> 26.20.14.120 Серверы (однопроцессорные, двухпроцессорные) <br /> </td>
    <td class=""> 26.20 Производство компьютеров и периферийного оборудования </td>
  </tr>
</table>`;

describe("extractOkpd2Codes", () => {
  it("читает код из ячейки печатной формы 44-ФЗ", () => {
    expect(extractOkpd2Codes(PRINT_FORM_44)).toEqual(["42.11.20.300"]);
  });

  it("читает код ОКПД2 из вкладки лотов 223-ФЗ и не берёт короткий код ОКВЭД2", () => {
    expect(extractOkpd2Codes(LOT_LIST_223)).toEqual(["26.20.14.120"]);
  });

  it("даты, цены и номера не принимаются за коды", () => {
    const html = "<td>01.10.2026</td><td>48 520 472,72</td><td>12.09.26</td><td>№ 3.14.15</td>";

    expect(extractOkpd2Codes(html)).toEqual([]);
  });

  it("повторы убираются, порядок первого вхождения сохраняется", () => {
    const html = "<td>26.20.14.120</td><td>26.20.11.110</td><td>26.20.14.120</td>";

    expect(extractOkpd2Codes(html)).toEqual(["26.20.14.120", "26.20.11.110"]);
  });

  it("код КТРУ даёт код ОКПД2 без суффикса", () => {
    expect(extractOkpd2Codes("<td>26.20.11.110-00000001</td>")).toEqual(["26.20.11.110"]);
  });

  it("код, склеенный с соседним числом, не принимается: это часть другого числа", () => {
    expect(extractOkpd2Codes("<td>126.20.14.1200</td>")).toEqual([]);
  });

  it("пустая страница — пустой список", () => {
    expect(extractOkpd2Codes("")).toEqual([]);
  });
});

describe("findLotListHref", () => {
  /*
    Ловушка настоящей разметки: в ссылке на лоты стоит «&noticeGuid=», а
    «&not» — устаревшая HTML-сущность. Библиотека, которая разворачивает
    сущности без точки с запятой, превратила бы её в «¬iceGuid», и запрос ушёл
    бы по ссылке, которой нет. Поэтому ссылка берётся сырой, а заменяется
    только «&amp;».
  */
  it("берёт ссылку с настоящим параметром noticeGuid", () => {
    const html =
      '<a href="/epz/order/notice/notice223/lot-list.html?purchaseNoticeNumber=32616434036&noticeGuid=397e69b4-4350-4db8-b41b-ff2571a67182">Лоты</a>';

    expect(findLotListHref(html)).toBe(
      "/epz/order/notice/notice223/lot-list.html?purchaseNoticeNumber=32616434036&noticeGuid=397e69b4-4350-4db8-b41b-ff2571a67182",
    );
  });

  it("экранированный амперсанд превращается в обычный", () => {
    const html =
      '<a href="/epz/order/notice/notice223/lot-list.html?purchaseNoticeNumber=1&amp;noticeGuid=abc">Лоты</a>';

    expect(findLotListHref(html)).toBe(
      "/epz/order/notice/notice223/lot-list.html?purchaseNoticeNumber=1&noticeGuid=abc",
    );
  });

  it("нет ссылки — null", () => {
    expect(findLotListHref("<html><body>Нет лотов</body></html>")).toBeNull();
  });
});

describe("fetchEisOkpd2", () => {
  const BASE = "https://zakupki.gov.ru";

  it("44-ФЗ: один запрос — печатная форма", async () => {
    const get = vi.fn(async (_url: string) => PRINT_FORM_44);

    const codes = await fetchEisOkpd2(
      { regNumber: "0153600002526000010", law: "FZ_44", cardUrl: "" },
      get,
      BASE,
    );

    expect(codes).toEqual(["42.11.20.300"]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(String(get.mock.calls[0]?.[0])).toBe(
      `${BASE}/epz/order/notice/printForm/view.html?regNumber=0153600002526000010`,
    );
  });

  it("223-ФЗ: карточка, затем вкладка лотов по найденной в ней ссылке", async () => {
    const card =
      '<a href="/epz/order/notice/notice223/lot-list.html?purchaseNoticeNumber=32616434036&noticeGuid=guid-1">Лоты</a>';
    const get = vi.fn(async (url: string) => (url.includes("lot-list") ? LOT_LIST_223 : card));

    const codes = await fetchEisOkpd2(
      {
        regNumber: "32616434036",
        law: "FZ_223",
        cardUrl: `${BASE}/223/purchase/public/purchase/info/common-info.html?regNumber=32616434036`,
      },
      get,
      BASE,
    );

    expect(codes).toEqual(["26.20.14.120"]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(String(get.mock.calls[1]?.[0])).toBe(
      `${BASE}/epz/order/notice/notice223/lot-list.html?purchaseNoticeNumber=32616434036&noticeGuid=guid-1`,
    );
  });

  it("223-ФЗ без ссылки на лоты — пусто, второго запроса нет", async () => {
    const get = vi.fn(async (_url: string) => "<html>нет</html>");

    const codes = await fetchEisOkpd2(
      { regNumber: "1", law: "FZ_223", cardUrl: `${BASE}/card` },
      get,
      BASE,
    );

    expect(codes).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("сбой запроса — пустой список, а не исключение: код не стоит упавшего прогона", async () => {
    const get = vi.fn(async (_url: string): Promise<string> => {
      throw new Error("ЕИС недоступна");
    });

    await expect(
      fetchEisOkpd2({ regNumber: "1", law: "FZ_44", cardUrl: "" }, get, BASE),
    ).resolves.toEqual([]);
  });

  it("закон, для которого пути не знаем, — пусто и без запросов", async () => {
    const get = vi.fn(async (_url: string) => "x");

    const codes = await fetchEisOkpd2(
      { regNumber: "1", law: "COMMERCIAL", cardUrl: "" },
      get,
      BASE,
    );

    expect(codes).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});
