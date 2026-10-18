import { describe, expect, it, vi } from "vitest";
import {
  documentationUnavailableReason,
  eis223CardUrl,
  eisPrintFormUrl,
  expectedDocumentFilename,
  fetchTenderDocumentation,
  htmlToText,
  publishedInEis,
} from "@/services/tenderDocumentsFetcher";

/** HTML-заглушка печатной формы извещения 44-ФЗ. */
const PRINT_FORM_HTML = `
<html><head><style>.x{color:red}</style><script>var a=1;</script></head>
<body>
<h1>Печатная форма</h1>
<p>Извещение о проведении электронного аукциона для закупки №0573100026626000009</p>
<div class="section">
  <h2>Требования к участникам</h2>
  <ul><li>Наличие лицензии ФСБ</li><li>Опыт работ не менее 3 лет</li></ul>
</div>
<table><tr><td>Начальная цена</td><td>1&nbsp;000&nbsp;000&nbsp;&#8381;</td></tr></table>
<p>Заказчик: АО &quot;ЭНЕРГОТРАНССНАБ&quot;</p>
</body></html>`;

describe("htmlToText", () => {
  it("убирает теги, скрипты и стили, оставляет текст", () => {
    const text = htmlToText(PRINT_FORM_HTML);
    expect(text).toContain("Извещение о проведении электронного аукциона");
    expect(text).toContain("Наличие лицензии ФСБ");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("var a=1");
    expect(text).not.toContain("color:red");
  });

  it("раскрывает HTML-сущности, включая неразрывные пробелы и знак рубля", () => {
    const text = htmlToText(PRINT_FORM_HTML);
    expect(text).toContain("1 000 000 ₽");
    expect(text).toContain('АО "ЭНЕРГОТРАНССНАБ"');
  });

  it("сохраняет разделение блоков переносами строк", () => {
    const text = htmlToText("<p>Первый</p><p>Второй</p>");
    expect(text).toBe("Первый\nВторой");
  });

  it("на пустой разметке возвращает пустую строку", () => {
    expect(htmlToText("<div>   </div>")).toBe("");
  });
});

describe("адреса страниц ЕИС", () => {
  it("печатная форма 44-ФЗ строится по реестровому номеру", () => {
    expect(eisPrintFormUrl("0573100026626000009")).toBe(
      "https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=0573100026626000009",
    );
  });

  it("карточка 223-ФЗ строится по реестровому номеру", () => {
    expect(eis223CardUrl("32616394130")).toBe(
      "https://zakupki.gov.ru/epz/order/notice/notice223/common-info.html?regNumber=32616394130",
    );
  });
});

describe("fetchTenderDocumentation", () => {
  it("для 44-ФЗ забирает печатную форму извещения", async () => {
    const fetchHtml = vi.fn().mockResolvedValue(PRINT_FORM_HTML);

    const result = await fetchTenderDocumentation(
      { regNumber: "0573100026626000009", law: "FZ_44", dataSource: "EIS" },
      fetchHtml,
    );

    expect(fetchHtml).toHaveBeenCalledWith(eisPrintFormUrl("0573100026626000009"));
    expect(result.reason).toBeNull();
    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0]!;
    expect(doc.documentType).toBe("notice");
    expect(doc.sourceType).toBe("eis_api");
    expect(doc.mimeType).toBe("text/html");
    expect(doc.text).toContain("Наличие лицензии ФСБ");
  });

  it("для 223-ФЗ берёт карточку закупки и отрезает сквозную навигацию сайта", async () => {
    const fetchHtml = vi.fn().mockResolvedValue(
      "<html><body><header>Все разделы Закупки Контракты Библиотека типовых контрактов</header>" +
        "<main><a>Назад к результатам поиска</a>" +
        "<h1>№ 32616394130</h1>" +
        "<p>Объект закупки: Перевозка угля автомобильным транспортом для нужд филиалов " +
        "в течение отопительного сезона 2026–2027 годов</p>" +
        "<table><tr><td>Начальная цена</td><td>38 169 600 ₽</td></tr>" +
        "<tr><td>Окончание подачи заявок</td><td>07.10.2026</td></tr></table>" +
        "<p>Заказчик: АО «ЭНЕРГОТРАНССНАБ»</p></main></body></html>",
    );

    const result = await fetchTenderDocumentation(
      { regNumber: "32616394130", law: "FZ_223", dataSource: "EIS" },
      fetchHtml,
    );

    expect(fetchHtml).toHaveBeenCalledWith(eis223CardUrl("32616394130"));
    expect(result.reason).toBeNull();
    const text = result.documents[0]?.text ?? "";
    expect(text).toContain("Перевозка угля");
    expect(text).not.toContain("Библиотека типовых контрактов");
  });

  it("для Сбербанк-АСТ честно сообщает, что документация недоступна", async () => {
    const fetchHtml = vi.fn();

    const result = await fetchTenderDocumentation(
      { regNumber: "SBR028-2609080053", law: "COMMERCIAL", dataSource: "SBER_AST" },
      fetchHtml,
    );

    expect(fetchHtml).not.toHaveBeenCalled();
    expect(result.documents).toHaveLength(0);
    expect(result.reason).toMatch(/Сбербанк-АСТ/);
  });

  it("страница-заглушка «не найдено» — это причина, а не документ", async () => {
    const fetchHtml = vi
      .fn()
      .mockResolvedValue("<html><body>Страница не найдена</body></html>");

    const result = await fetchTenderDocumentation(
      { regNumber: "99999999999", law: "FZ_44", dataSource: "EIS" },
      fetchHtml,
    );

    expect(result.documents).toHaveLength(0);
    expect(result.reason).toMatch(/не найдена|Недостаточно текста/);
  });

  it("сетевая ошибка не роняет вызывающий код", async () => {
    const fetchHtml = vi.fn().mockRejectedValue(new Error("fetch failed (ETIMEDOUT)"));

    const result = await fetchTenderDocumentation(
      { regNumber: "0573100026626000009", law: "FZ_44", dataSource: "EIS" },
      fetchHtml,
    );

    expect(result.documents).toHaveLength(0);
    expect(result.reason).toContain("ETIMEDOUT");
  });
});

describe("ТЭК-Торг: документацию отдаёт площадка, а не реестр", () => {
  const target = {
    regNumber: "TEKTORG-ЗП610102",
    law: "COMMERCIAL" as const,
    dataSource: "TEK_TORG" as const,
  };

  it("не публикуется в ЕИС: обход не идёт в реестр с номером площадки", () => {
    expect(publishedInEis({ dataSource: "TEK_TORG" })).toBe(false);
    // Контур.Закупки остаются в реестре: агрегатор отдаёт тот же номер извещения.
    expect(publishedInEis({ dataSource: "KONTUR" })).toBe(true);
    expect(publishedInEis({ dataSource: "EIS" })).toBe(true);
  });

  it("план не строит адрес печатной формы ЕИС", () => {
    expect(expectedDocumentFilename(target)).toBeNull();
  });

  it("план не строит адрес ЕИС и по номеру извещения, который площадка принесла первой", () => {
    // У 49 из 75 процедур ТЭК-Торга за сутки есть номер ЕИС, и закон у них
    // FZ_223. Если такая строка записана от имени площадки, номер выглядит
    // реестровым — и план ушёл бы в ЕИС за закупкой, которую реестр мог ещё не
    // опубликовать. Проверка на законе, для которого печатная форма существует.
    expect(
      expectedDocumentFilename({
        regNumber: "32616428629",
        law: "FZ_223",
        dataSource: "TEK_TORG",
      }),
    ).toBeNull();
  });

  it("загрузчик не трогает сеть: файлы площадки читает отдельный прогон", async () => {
    const fetchHtml = vi.fn();

    const result = await fetchTenderDocumentation(target, fetchHtml);

    expect(fetchHtml).not.toHaveBeenCalled();
    expect(result.documents).toHaveLength(0);
    // Причина объясняет, где документация есть, а не жалуется на источник:
    // байты площадка отдаёт, их загружает другой модуль.
    expect(result.reason).toMatch(/ТЭК-Торг/);
    expect(result.reason).not.toMatch(/не отдаёт документацию/);
  });

  it("причина отказа называет площадку и не обещает ЕИС", () => {
    const reason = documentationUnavailableReason(target);
    expect(reason).toMatch(/ТЭК-Торг/);
    expect(reason).not.toMatch(/ЕИС не отдала/);
  });
});
