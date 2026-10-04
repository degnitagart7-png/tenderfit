import { describe, expect, it } from "vitest";
import {
  attachmentDocumentType,
  attachmentFilename,
  attachmentPriority,
  eis223DocumentsTabUrl,
  eis44DocumentsTabUrl,
  eisDocumentsTabUrl,
  extractAttachmentLinks,
  extractNoticeGuid,
  planAttachments,
  PRIORITY_CONTRACT,
  PRIORITY_REST,
  PRIORITY_SPEC,
  type AttachmentLink,
} from "./eisAttachments";

/**
 * Разбор вкладки документов ЕИС.
 *
 * Фикстуры — обрезанные фрагменты настоящих страниц, скачанных 22.09.2026
 * (реестровые номера 0573100026626000009 и 32616394259). Целые страницы весят
 * 140–260 КБ и в репозитории не нужны; разметка якоря скопирована дословно,
 * включая соседний якорь электронной подписи и `<img>` с собственным тултипом —
 * именно на них разбор ломался дважды.
 */

/** 44-ФЗ: имя файла в `title` якоря, расширение только там. */
const FZ44_ROW = `
<div class="attachment row ">
  <div class="col clipText">
    <a data-modalup class="pWidth_840 vAlignMiddle margRight5 cryptoSignsSmall"
       href="/epz/order/notice/signview/ep/listModal.html?reestrNumber=0573100026626000009&uid=01A0C442AF837CBBB8FF5D6126868B57">
      <span class="icon icon-small icon-cryptoSign_small vAlignMiddle"></span>
    </a>
    <img alt="Microsoft Word Document" src="/epz/static/img/icons/type/docx.svg"
         class="vAlignMiddle margRight5"
         data-tooltip="<span class='custom-tooltiptext'>Microsoft Word Document</span>"/>
    <span class="section__value">
      <a href="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=01A0C442AF837CBBB8FF5D6126868B57"
         title="Приложение № 1 - Обоснование начальной (максимальной) цены.docx">
        Приложение № 1 - Обоснование начальной (максимальной) цены
      </a>
    </span>
  </div>
</div>`;

/** 223-ФЗ: имя файла в `data-tooltip`, внутри атрибута есть символ `>`. */
const FZ223_ROW = `
<div class="">
  <span class="vAlignMiddle successCheckAntivirus" title="Проведена проверка на наличие вирусов"></span>
  <span class="count ">
    <a class="newExternalPopUpLink" shablon-pattern="223FZModal" data-modalup class="pr-2"
       href="/epz/order/notice/notice223/document/signview/listModal.html?documentGuid=b983cb2f-f5df-429d-874a-a3697f63dcb7&purchaseNoticeNumber=32616394259&entityGuid=336dfd67-d2cd-4913-a72f-2d74d4920d50"
       data-tooltip='<span class="custom-tooltiptext">Просмотреть ЭП</span>'>
      <img src="/epz/static/img/icons/icon_key.svg" alt="">
    </a>
    <img alt="RAR архив" src="/epz/static/img/icons/type/rar.svg" class="vAlignMiddle margRight5"
         data-tooltip="<span class='custom-tooltiptext'>RAR архив</span>"/>
    <a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=DE0A69325CEF4F5D86235CAC3B9D80E7"
       data-tooltip='<span class="custom-tooltiptext">341 143 МФУ.rar</span>'
    >
      341 143 МФУ
    </a>
  </span>
</div>`;

/** Карточка 223-ФЗ: noticeGuid встречается и сам по себе, и как purchaseNoticeGuid. */
const FZ223_CARD = `
<a href="/epz/order/notice/notice223/card/rss?purchaseNoticeNumber=32616394259&purchaseNoticeGuid=336dfd67-d2cd-4913-a72f-2d74d4920d50">RSS</a>
<a href="/epz/order/notice/notice223/documents.html?purchaseNoticeNumber=32616394259&noticeGuid=8e3c465e-0fbb-496c-9d39-674df7c1710d">Документы</a>`;

/**
 * Блок документа 223-ФЗ: метка редакции стоит перед ссылкой на файл.
 * Разметка скопирована с живой страницы закупки 32616242641. Идентификаторы
 * файлов в ЕИС — шестнадцатеричные, это учитывает шаблон поиска ссылок.
 */
function fz223Block(edition: "Действующая" | "Недействующая", name: string, uid: string): string {
  return `
<div class="attachment row">
  <div class="col-6">
    <div class="attachment__text">Редакция</div>
    <div class="attachment__value">${edition}</div>
  </div>
  <div class="col-6">
    <a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=${uid}"
       data-tooltip='<span class="custom-tooltiptext">${name}</span>'>
      ${name.replace(/\.[a-z0-9]+$/i, "")}
    </a>
  </div>
</div>`;
}

/**
 * Страница 44-ФЗ: метка редакции одна, в шапке, до всех блоков документов.
 * Между словом и значением — пустая разметка, как на настоящей странице.
 */
const FZ44_EDITION_HEADER = `
<div class="col-sm">
  <div class="section__attrib">Редакция</div>
  <div class="section__value ">


    Действующая

</div>
</div>`;

function link(name: string, uid = "AAAA"): AttachmentLink {
  return {
    name,
    uid,
    url: `https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=${uid}`,
  };
}

describe("extractAttachmentLinks: 44-ФЗ", () => {
  it("берёт имя из title вместе с расширением", () => {
    const links = extractAttachmentLinks(FZ44_ROW);

    expect(links).toHaveLength(1);
    expect(links[0]?.name).toBe("Приложение № 1 - Обоснование начальной (максимальной) цены.docx");
    expect(links[0]?.uid).toBe("01A0C442AF837CBBB8FF5D6126868B57");
    expect(links[0]?.url).toBe(
      "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=01A0C442AF837CBBB8FF5D6126868B57",
    );
  });

  it("не цепляет тултип соседней картинки", () => {
    const [first] = extractAttachmentLinks(FZ44_ROW);
    expect(first?.name).not.toContain("Microsoft Word Document");
  });

  it("убирает повтор адреса", () => {
    expect(extractAttachmentLinks(`${FZ44_ROW}${FZ44_ROW}`)).toHaveLength(1);
  });

  it("раскрывает HTML-сущности в имени", () => {
    const html = `<a href="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=BB01"
       title="Смета&nbsp;&amp;&nbsp;ТЗ &quot;Магадан&quot;.docx">Смета</a>`;
    expect(extractAttachmentLinks(html)[0]?.name).toBe('Смета & ТЗ "Магадан".docx');
  });

  it("доводит относительный адрес до абсолютного", () => {
    const html = `<a href="/223/filestore/public/1.0/download/fz223/file.html?uid=CC02">Файл.pdf</a>`;
    expect(extractAttachmentLinks(html)[0]?.url).toBe(
      "https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=CC02",
    );
  });

  it("не принимает <article> за начало якоря", () => {
    const html = `<article data-file="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=DD03"></article>`;
    const [first] = extractAttachmentLinks(html);
    expect(first?.name).toBe("attachment-DD03");
  });

  it("без имени в атрибутах берёт видимый текст якоря", () => {
    const html = `<a href="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=EE04">
      <span>Проект контракта</span>
    </a>`;
    expect(extractAttachmentLinks(html)[0]?.name).toBe("Проект контракта");
  });
});

describe("extractAttachmentLinks: 223-ФЗ", () => {
  it("читает имя из data-tooltip, а не из соседнего якоря подписи", () => {
    const links = extractAttachmentLinks(FZ223_ROW);

    expect(links).toHaveLength(1);
    // Именно здесь разбор ломался: тултип «Просмотреть ЭП» принадлежит другому якорю.
    expect(links[0]?.name).toBe("341 143 МФУ.rar");
  });

  it("не обрывает тег на символе > внутри атрибута", () => {
    const [first] = extractAttachmentLinks(FZ223_ROW);
    expect(first?.uid).toBe("DE0A69325CEF4F5D86235CAC3B9D80E7");
    expect(first?.name).toContain(".rar");
  });

  it("предпочитает кандидата с расширением, даже если он не первый", () => {
    const html = `<a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=FF05"
       title="Документация" data-tooltip='<span class="custom-tooltiptext">Документация о закупке.rar</span>'>
      Документация
    </a>`;
    expect(extractAttachmentLinks(html)[0]?.name).toBe("Документация о закупке.rar");
  });

  it("без расширения ни у одного кандидата оставляет то, что показал сайт", () => {
    const html = `<a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=FF06"
       title="Документация о закупке">Документация о закупке</a>`;
    expect(extractAttachmentLinks(html)[0]?.name).toBe("Документация о закупке");
  });
});

describe("extractAttachmentLinks: редакции извещения", () => {
  it("отбрасывает файлы устаревшей редакции 223-ФЗ", () => {
    const html =
      fz223Block("Недействующая", "Извещение.docx", "AA01") +
      fz223Block("Действующая", "Извещение_ред.2.docx", "BB02");

    const links = extractAttachmentLinks(html);

    expect(links.map((item) => item.uid)).toEqual(["BB02"]);
  });

  it("считает действующей ближайшую метку перед файлом", () => {
    const html =
      fz223Block("Недействующая", "Документация о закупке.7z", "AA02") +
      fz223Block("Действующая", "Документация о закупке_корр.rar", "BB03") +
      fz223Block("Недействующая", "Протокол_1_перенос.pdf", "AA04");

    expect(extractAttachmentLinks(html).map((item) => item.uid)).toEqual(["BB03"]);
  });

  it("страница 44-ФЗ с одной меткой в шапке сохраняет все файлы", () => {
    const html =
      FZ44_EDITION_HEADER +
      FZ44_ROW +
      FZ44_ROW.replace(/01A0C442AF837CBBB8FF5D6126868B57/g, "02B0C442AF837CBBB8FF5D6126868B57");

    expect(extractAttachmentLinks(html)).toHaveLength(2);
  });

  it("без метки редакции файлы остаются — так устроена страница 44-ФЗ без шапки", () => {
    expect(extractAttachmentLinks(FZ44_ROW)).toHaveLength(1);
  });

  it("значение метки читается через пустую разметку и переносы строк", () => {
    const html = `
<div class="section__attrib">Редакция</div>
<div class="section__value ">


    Недействующая

</div>
${FZ44_ROW}`;

    expect(extractAttachmentLinks(html)).toHaveLength(0);
  });
});

describe("extractNoticeGuid", () => {
  it("находит noticeGuid вкладки документов, а не purchaseNoticeGuid рядом", () => {
    expect(extractNoticeGuid(FZ223_CARD)).toBe("8e3c465e-0fbb-496c-9d39-674df7c1710d");
  });

  it("без noticeGuid берёт purchaseNoticeGuid — значение то же", () => {
    const html = `<a href="?purchaseNoticeGuid=336dfd67-d2cd-4913-a72f-2d74d4920d50">RSS</a>`;
    expect(extractNoticeGuid(html)).toBe("336dfd67-d2cd-4913-a72f-2d74d4920d50");
  });

  it("без GUID возвращает null — вкладка документов тогда недоступна", () => {
    expect(extractNoticeGuid("<div>Карточка закупки</div>")).toBeNull();
  });
});

describe("адрес вкладки документов", () => {
  it("для 44-ФЗ подставляет код способа размещения", () => {
    expect(eis44DocumentsTabUrl("0138300000426000770", "ELECTRONIC_AUCTION")).toBe(
      "https://zakupki.gov.ru/epz/order/notice/ea20/view/documents.html?regNumber=0138300000426000770",
    );
    expect(eis44DocumentsTabUrl("0373100096726000028", "OPEN_CONTEST")).toContain("/ok20/");
    expect(eis44DocumentsTabUrl("0158300047126000034", "REQUEST_FOR_QUOTATION")).toContain("/zk20/");
    expect(eis44DocumentsTabUrl("0573100026626000009", "SOLE_SUPPLIER")).toContain("/ep44/");
  });

  it("без способа размещения берёт zk20: неверный код ЕИС исправляет редиректом", () => {
    expect(eis44DocumentsTabUrl("0373100096726000028", null)).toContain("/zk20/");
  });

  it("кодирует реестровый номер", () => {
    expect(eis44DocumentsTabUrl("номер 1", "OTHER")).toContain("regNumber=%D0%BD%D0%BE%D0%BC%D0%B5%D1%80%201");
  });

  it("для 223-ФЗ требует noticeGuid", () => {
    expect(eis223DocumentsTabUrl("32616347400", "8e3c465e-0fbb-496c-9d39-674df7c1710d")).toBe(
      "https://zakupki.gov.ru/epz/order/notice/notice223/documents.html" +
        "?purchaseNoticeNumber=32616347400&noticeGuid=8e3c465e-0fbb-496c-9d39-674df7c1710d",
    );
  });

  it("по закупке: 44-ФЗ и ПП РФ 615 — сразу, 223-ФЗ — только с GUID", () => {
    expect(
      eisDocumentsTabUrl({ law: "FZ_44", regNumber: "1", placingWay: "OPEN_CONTEST" }),
    ).toContain("/ok20/");
    expect(
      eisDocumentsTabUrl({ law: "PP_RF_615", regNumber: "1", placingWay: "OPEN_CONTEST" }),
    ).toContain("/ok20/");
    expect(
      eisDocumentsTabUrl({ law: "FZ_223", regNumber: "32616347400", placingWay: null }),
    ).toBeNull();
    expect(
      eisDocumentsTabUrl({
        law: "FZ_223",
        regNumber: "32616347400",
        placingWay: null,
        noticeGuid: "8e3c465e-0fbb-496c-9d39-674df7c1710d",
      }),
    ).toContain("notice223/documents.html");
    expect(
      eisDocumentsTabUrl({ law: "COMMERCIAL", regNumber: "1", placingWay: "OTHER" }),
    ).toBeNull();
  });
});

describe("attachmentDocumentType", () => {
  it("проект контракта и договора", () => {
    expect(attachmentDocumentType("Проект_контракта_ИКЗ_119.docx")).toBe("contract");
    expect(attachmentDocumentType("Приложение 2_Проект договора_Лот 3188.1.docx")).toBe("contract");
    expect(attachmentDocumentType("Приложение № 2 к извещению (Проект ГК +Приложения).zip")).toBe(
      "contract",
    );
  });

  it("протокол важнее упоминания контракта в названии", () => {
    expect(attachmentDocumentType("Протокол разногласий к проекту контракта.docx")).toBe("protocol");
    expect(attachmentDocumentType("Протокол_1_перенос от 07.08.26.pdf")).toBe("protocol");
  });

  it("остальное — вложения", () => {
    expect(attachmentDocumentType("Описание_объекта_закупки.docx")).toBe("attachment");
    expect(attachmentDocumentType("Документация о закупке.rar")).toBe("attachment");
    expect(attachmentDocumentType("Обоснование НМЦК.PDF")).toBe("attachment");
  });
});

describe("attachmentPriority", () => {
  it("первым идёт проект контракта", () => {
    expect(attachmentPriority("Проект контракта.doc")).toBe(PRIORITY_CONTRACT);
    expect(attachmentPriority("Приложение № 5 (Проект контракта).doc")).toBe(PRIORITY_CONTRACT);
    expect(attachmentPriority("Контракт (проект).docx")).toBe(PRIORITY_CONTRACT);
  });

  it("вторым — описание объекта, техзадание и требования к заявке", () => {
    expect(attachmentPriority("Описание_объекта_закупки.docx")).toBe(PRIORITY_SPEC);
    expect(attachmentPriority("Приложение № 1 (Описание предмета закупки).docx")).toBe(PRIORITY_SPEC);
    expect(attachmentPriority("+Техническое задание Магадан-Палатка-Магадан 2025.docx")).toBe(
      PRIORITY_SPEC,
    );
    expect(attachmentPriority("Приложение 1 к ДоЗ_Тех требования_Лот 3188.1.docx")).toBe(
      PRIORITY_SPEC,
    );
    expect(attachmentPriority("Приложение №6 к Техническим требованиям - Проектная документация_2.zip")).toBe(
      PRIORITY_SPEC,
    );
    expect(attachmentPriority("Приложение 4 к ТТ_Сметная документация.xlsx")).toBe(PRIORITY_SPEC);
    expect(attachmentPriority("Приложение № 1 к извещению (Смета +Техническое задание СМР).zip")).toBe(
      PRIORITY_SPEC,
    );
    expect(attachmentPriority("Приложение № 3 (Содержание и требования к заявке ).docx")).toBe(
      PRIORITY_SPEC,
    );
    expect(attachmentPriority("Запрос котировок. Требования к заявке (1).docx")).toBe(PRIORITY_SPEC);
    expect(
      attachmentPriority("Приложение № 4 к извещению Требования к содержанию заявки  (РД+СМР).doc"),
    ).toBe(PRIORITY_SPEC);
  });

  it("остальное — в порядке страницы", () => {
    expect(attachmentPriority("Обоснование НМЦК.PDF")).toBe(PRIORITY_REST);
    expect(attachmentPriority("НМЦК Палатка на 4кв.xlsx")).toBe(PRIORITY_REST);
    expect(attachmentPriority("радиаторы 2.xlsx")).toBe(PRIORITY_REST);
    expect(attachmentPriority("Документация о закупке.7z")).toBe(PRIORITY_REST);
    expect(attachmentPriority("Приложение № 4 (Порядок рассмотрения и оценки заявок).docx")).toBe(
      PRIORITY_REST,
    );
    expect(attachmentPriority("Протокол_1_перенос от 07.08.26.pdf")).toBe(PRIORITY_REST);
  });

  it("не принимает «проектно-сметная документация» за проект контракта", () => {
    expect(attachmentPriority("Приложение № 1.1 (Проектно-сметная документация).rar")).toBe(
      PRIORITY_SPEC,
    );
  });
});

describe("attachmentFilename", () => {
  it("убирает символы пути и схлопывает пробелы", () => {
    const name = attachmentFilename(
      link("Приложение 1/2: смета  (копия).xlsx", "1"),
    );
    expect(name).toBe("Приложение 1_2_ смета (копия).xlsx");
  });

  it("без имени подставляет uid", () => {
    expect(attachmentFilename({ name: "   ", uid: "AB12", url: "u" })).toBe("attachment-AB12");
  });

  it("обрезка сохраняет расширение", () => {
    const long = `${"а".repeat(190)}.docx`;
    const name = attachmentFilename(link(long, "1"));

    expect(name).toHaveLength(180);
    expect(name.endsWith(".docx")).toBe(true);
  });

  it("короткое имя не меняется", () => {
    expect(attachmentFilename(link("Извещение.docx", "1"))).toBe("Извещение.docx");
  });
});

describe("planAttachments", () => {
  it("сначала контракт, затем техзадание, затем прочее в порядке страницы", () => {
    const plan = planAttachments([
      link("Приложение № 3 Распоряжение НМЦК.pdf", "1"),
      link("Приложение № 2 к извещению (Проект ГК +Приложения).zip", "2"),
      link("Приложение № 1 к извещению (Смета +Техническое задание СМР).zip", "3"),
      link("Приложение № 4 к извещению Требования к содержанию заявки  (РД+СМР).doc", "4"),
      link("Протокол_1_перенос от 07.08.26.pdf", "5"),
    ]);

    expect(plan.map((item) => item.uid)).toEqual(["2", "3", "4", "1", "5"]);
    expect(plan.map((item) => item.priority)).toEqual([
      PRIORITY_CONTRACT,
      PRIORITY_SPEC,
      PRIORITY_SPEC,
      PRIORITY_REST,
      PRIORITY_REST,
    ]);
    expect(plan.map((item) => item.documentType)).toEqual([
      "contract",
      "attachment",
      "attachment",
      "attachment",
      "protocol",
    ]);
    // Имя единственное — суффикс из uid не нужен.
    expect(plan.map((item) => item.filename)).toEqual([
      "Приложение № 2 к извещению (Проект ГК +Приложения).zip",
      "Приложение № 1 к извещению (Смета +Техническое задание СМР).zip",
      "Приложение № 4 к извещению Требования к содержанию заявки (РД+СМР).doc",
      "Приложение № 3 Распоряжение НМЦК.pdf",
      "Протокол_1_перенос от 07.08.26.pdf",
    ]);
  });

  it("повтор имени различается суффиксом из uid, а не отбрасывается", () => {
    // Живая закупка 32616242641: три разных ответа заказчика с одним именем.
    const plan = planAttachments([
      link("Разъяснение_32616242641.pdf", "3F0C7108AABBCCDD"),
      link("Разъяснение_32616242641.pdf", "11AB6DDBAABBCCDD"),
      link("Разъяснение_32616242641.pdf", "4ABE6E76AABBCCDD"),
    ]);

    expect(plan).toHaveLength(3);
    expect(plan.map((item) => item.filename)).toEqual([
      "Разъяснение_32616242641 (3F0C7108).pdf",
      "Разъяснение_32616242641 (11AB6DDB).pdf",
      "Разъяснение_32616242641 (4ABE6E76).pdf",
    ]);
    expect(new Set(plan.map((item) => item.filename)).size).toBe(3);
  });

  it("суффикс получает и первое вхождение: план не зависит от порядка блоков", () => {
    const forward = planAttachments([
      link("Извещение.docx", "AAAA1111"),
      link("Извещение.docx", "BBBB2222"),
    ]);
    const reversed = planAttachments([
      link("Извещение.docx", "BBBB2222"),
      link("Извещение.docx", "AAAA1111"),
    ]);

    expect(new Set(forward.map((item) => item.filename))).toEqual(
      new Set(reversed.map((item) => item.filename)),
    );
    expect(forward.map((item) => item.filename)).toEqual([
      "Извещение (AAAA1111).docx",
      "Извещение (BBBB2222).docx",
    ]);
  });

  it("повтор видно и когда имена отличаются пробелами и регистром", () => {
    const plan = planAttachments([link("НМЦК  17.09.xlsx", "1111"), link("нмцк 17.09.xlsx", "2222")]);

    expect(plan.map((item) => item.filename)).toEqual([
      "НМЦК 17.09 (1111).xlsx",
      "нмцк 17.09 (2222).xlsx",
    ]);
  });

  it("без расширения суффикс добавляется в конец имени", () => {
    const plan = planAttachments([link("Документация о закупке", "AAAA"), link("Документация о закупке", "BBBB")]);

    expect(plan.map((item) => item.filename)).toEqual([
      "Документация о закупке (AAAA)",
      "Документация о закупке (BBBB)",
    ]);
  });

  it("пустой список не ломает план", () => {
    expect(planAttachments([])).toEqual([]);
  });
});
