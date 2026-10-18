import { describe, expect, it } from "vitest";

import { UNKNOWN_REGION } from "@/domain/entities";
import { regionFromDocuments, resolveZoneTender } from "@/domain/estimate/documentRegion";

const NOTICE = [
  "Извещение о проведении закупки",
  "Заказчик: ГУП «Теплоэнерго»",
  "Адрес заказчика: г. Москва, ул. Ленина, д. 1",
  "Место поставки товара, выполнения работы, оказания услуги: Республика Бурятия, Заиграевский район, п. Заиграево, ул. Мира, 5",
  "Срок выполнения работ: 90 дней",
].join("\n");

describe("regionFromDocuments", () => {
  it("читает место поставки из извещения, а не адрес заказчика", () => {
    const found = regionFromDocuments([{ name: "Извещение.docx", text: NOTICE }]);
    expect(found?.region).toBe("Республика Бурятия");
    expect(found?.address).toContain("Заиграевский район");
    expect(found?.source).toContain("Извещение.docx");
  });

  it("карточка закупки в табличном виде: подпись и значение через табуляцию", () => {
    const card = "Карточка закупки\nРегион\tТомская область\nСпособ закупки\tЗапрос предложений";
    expect(regionFromDocuments([{ name: "Карточка закупки.pdf", text: card }])?.region).toBe("Томская область");
  });

  it("значение на следующей строке после подписи", () => {
    const text = "Субъект РФ\n\nКамчатский край\nСрок: 30 дней";
    expect(regionFromDocuments([{ name: "Извещение.pdf", text }])?.region).toBe("Камчатский край");
  });

  it("извещение важнее прочих документов", () => {
    const other = { name: "Проект договора.docx", text: "Место выполнения работ: Томская область, г. Томск" };
    const notice = { name: "Извещение.docx", text: NOTICE };
    expect(regionFromDocuments([other, notice])?.region).toBe("Республика Бурятия");
  });

  it("без подписи поля и по одному адресу заказчика регион не угадывается", () => {
    const text = "Заказчик находится по адресу: г. Москва, ул. Ленина, д. 1. Работы выполняются на объекте.";
    expect(regionFromDocuments([{ name: "Извещение.docx", text }])).toBeNull();
  });

  it("значение подписи без региона даёт null", () => {
    expect(regionFromDocuments([{ name: "Извещение.docx", text: "Регион: по месту нахождения заказчика" }])).toBeNull();
  });
});

describe("regionFromDocuments: адрес объекта в других подписях (0848300051626001016, 32616420962)", () => {
  it("«Место выполнения работ: в соответствии с приложением 2» пусто — адрес берётся из «по адресу:» в предложении про объект", () => {
    const text = [
      "Место выполнения работ: в соответствии с приложением 2 к Контракту.",
      "Выполнение работ по капитальному ремонту здания школы по адресу: Московская область муниципальный округ Раменский д. Юрово ул. Школьная д. 33а.",
    ].join("\n");
    const found = regionFromDocuments([{ name: "Описание объекта закупки.docx", text }]);
    expect(found?.region).toBe("Московская область");
    expect(found?.address).toContain("Юрово");
    expect(found?.source).toContain("по адресу");
  });

  it("«… расположенного по адресу: Московская область, г. Балашиха, мкр. Железнодорожный, ул. Юбилейная, д.16А»", () => {
    const text = "Объектом закупки является ремонт помещений, расположенных по адресу: Московская область, г. Балашиха, мкр. Железнодорожный, ул. Юбилейная, д.16А";
    expect(regionFromDocuments([{ name: "ТЗ.docx", text }])?.region).toBe("Московская область");
  });

  it("шапка xlsx ЛСР/ВОР: «Наименование субъекта Российской Федерации ,,,,,,50. Московская область»", () => {
    const text = ["Локальная смета,,,,,,", "Наименование субъекта Российской Федерации ,,,,,,50. Московская область", "Наименование объекта,,,,,,Школа"].join("\n");
    const found = regionFromDocuments([{ name: "ВОР.xlsx", text }]);
    expect(found?.region).toBe("Московская область");
    expect(found?.source).toContain("субъекта Российской Федерации");
  });

  it("печатная форма: подпись в одной строке, значение в следующей (через строку-пояснение)", () => {
    const text = "Наименование субъекта Российской Федерации\n(наименование)\nМосковская область\nНаименование объекта";
    expect(regionFromDocuments([{ name: "Печатная форма.pdf", text }])?.region).toBe("Московская область");
    const csv = "Адрес объекта,,,,\nТомская область, г. Томск, ул. Ленина, 5";
    expect(regionFromDocuments([{ name: "Карточка закупки.xlsx", text: csv }])?.region).toBe("Томская область");
  });

  it("«Адрес объекта строительства» и «Адрес (местоположение) объекта»", () => {
    expect(regionFromDocuments([{ name: "ТЗ.docx", text: "Адрес объекта строительства: Республика Бурятия, г. Улан-Удэ, ул. Ленина, 1" }])?.region).toBe("Республика Бурятия");
    expect(regionFromDocuments([{ name: "ТЗ.docx", text: "Адрес (местоположение) объекта: Камчатский край, г. Петропавловск-Камчатский" }])?.region).toBe("Камчатский край");
  });

  it("юридический и почтовый адрес заказчика, адрес площадки — игнорируются, даже со словами «по адресу»", () => {
    const customer = [
      "Заказчик: МБОУ СОШ, находящийся по адресу: Московская область, г. Раменское, ул. Мира, 1",
      "Юридический адрес: Томская область, г. Томск, ул. Ленина, 5",
      "Почтовый адрес заказчика по адресу: Республика Бурятия, г. Улан-Удэ",
      "Электронная площадка расположена по адресу: г. Москва, ул. Тверская, 1",
    ].join("\n");
    expect(regionFromDocuments([{ name: "Извещение.docx", text: customer }])).toBeNull();
  });

  it("«по адресу:» без слов про объект и работы — не берётся", () => {
    expect(regionFromDocuments([{ name: "Письмо.docx", text: "Направлять корреспонденцию по адресу: Томская область, г. Томск" }])).toBeNull();
  });

  it("подпись приоритетнее: «Место поставки» с регионом побеждает «по адресу» из другого абзаца", () => {
    const text = [
      "Выполнение работ по ремонту здания по адресу: Томская область, г. Томск, ул. Ленина, 5",
      "Место поставки товара, выполнения работы, оказания услуги: Республика Бурятия, г. Улан-Удэ",
    ].join("\n");
    expect(regionFromDocuments([{ name: "Извещение.docx", text }])?.region).toBe("Республика Бурятия");
  });
});

describe("resolveZoneTender", () => {
  const documents = [{ name: "Извещение.docx", text: NOTICE }];

  it("регион в карточке известен — документы не нужны", () => {
    const tender = { region: "Томская область", address: null, customerName: "Заказчик" };
    const result = resolveZoneTender(tender, documents);
    expect(result.tender).toBe(tender);
    expect(result.note).toBeNull();
  });

  it("адрес поставки опознаётся — тоже", () => {
    const tender = { region: UNKNOWN_REGION, address: "г. Томск, ул. Ленина, 5", customerName: null };
    expect(resolveZoneTender(tender, documents).tender).toBe(tender);
  });

  it("региона нет — берётся из документов, имя заказчика сохраняется, причина названа", () => {
    const tender = { region: UNKNOWN_REGION, address: null, customerName: "ГУП Теплоэнерго" };
    const result = resolveZoneTender(tender, documents);
    expect(result.tender?.region).toBe("Республика Бурятия");
    expect(result.tender?.customerName).toBe("ГУП Теплоэнерго");
    expect(result.note).toContain("взят из документов");
  });

  it("закупки в базе нет — регион из документов создаёт закупку для выбора зоны", () => {
    const result = resolveZoneTender(null, documents);
    expect(result.tender?.region).toBe("Республика Бурятия");
  });

  it("в документах региона нет — всё как было", () => {
    const tender = { region: null, address: null, customerName: null };
    const result = resolveZoneTender(tender, [{ name: "ТЗ.docx", text: "Выполнить ремонт кровли." }]);
    expect(result.tender).toBe(tender);
    expect(result.note).toBeNull();
    expect(resolveZoneTender(null, []).tender).toBeNull();
  });
});
