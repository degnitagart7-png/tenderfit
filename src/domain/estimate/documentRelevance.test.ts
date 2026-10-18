import { describe, expect, it } from "vitest";

import {
  QUANTITY_LINES_MIN,
  countQuantityLines,
  isDenseInQuantities,
  readAllDocuments,
  selectDocumentForModel,
  shouldReadWithModel,
} from "@/domain/estimate/documentRelevance";

/**
 * Какие документы читает модель, а какие заведомо без объёмов. Фикстуры — типичные куски документации закупок: проект
 * контракта, требования к заявке, ТЗ с таблицей работ, обоснование НМЦК, архив из нескольких файлов.
 */

/** Проект контракта: юридический текст, в котором встречаются «случайные» числа с единицами (срок, штраф, тоннаж лимита). */
const CONTRACT_TEXT = [
  "ПРОЕКТ",
  "МУНИЦИПАЛЬНЫЙ КОНТРАКТ № ____",
  "на выполнение работ по капитальному ремонту здания",
  "г. Иркутск                                                        «___» __________ 2026 г.",
  "Заказчик, именуемый в дальнейшем «Заказчик», и Подрядчик, именуемый в дальнейшем «Подрядчик», заключили настоящий Контракт о нижеследующем:",
  "1. Предмет Контракта",
  "1.1. Подрядчик обязуется выполнить работы по капитальному ремонту здания в соответствии с Техническим заданием (Приложение № 1) и сдать результат Заказчику.",
  "1.2. Срок выполнения работ — 90 календарных дней с даты заключения Контракта.",
  "2. Цена Контракта и порядок расчётов",
  "2.1. Цена Контракта составляет 12 450 000 (двенадцать миллионов четыреста пятьдесят тысяч) рублей 00 копеек, в том числе НДС 20 %.",
  "2.2. Оплата производится в течение 7 рабочих дней с даты подписания акта о приёмке выполненных работ.",
  "3. Ответственность Сторон",
  "3.1. За каждый день просрочки начисляется пеня в размере 1/300 ключевой ставки Центрального банка Российской Федерации.",
  "3.2. Гарантийный срок на выполненные работы составляет 5 лет; вывоз строительного мусора массой более 5 т согласуется с Заказчиком.",
  "4. Порядок приёмки",
  "4.1. Приёмка результатов работ осуществляется комиссией в течение 10 рабочих дней.",
  "5. Приложения к Контракту",
  "Приложение № 1 – Техническое задание",
  "Приложение № 2 – График выполнения работ",
].join("\n");

/** Приложение к проекту контракта: ведомость объёмов работ с таблицей. */
const BILL_APPENDIX = [
  "Приложение № 3",
  "Ведомость объёмов работ",
  "№ п/п | Наименование работ | Ед. изм. | Количество",
  "1 | Демонтаж штукатурки с поверхностей стен | м2 | 412,5",
  "2 | Оштукатуривание поверхностей стен цементно-известковым раствором | м2 | 412,5",
  "3 | Окраска стен водоэмульсионными составами | м2 | 380",
].join("\n");

/** ТЗ с таблицей работ: строки «наименование — единица — объём». */
const TZ_TEXT = [
  "Техническое задание на выполнение работ по капитальному ремонту кровли",
  "1. Общие требования",
  "Работы выполняются в соответствии с действующими нормами и правилами.",
  "2. Перечень и объёмы работ",
  "Демонтаж кровельного покрытия из металлочерепицы | м2 | 640",
  "Устройство пароизоляции | м2 | 640",
  "Монтаж утеплителя из минеральной ваты | м3 | 96",
  "Устройство кровельного покрытия из профнастила | м2 | 640",
  "Установка снегозадержателей | м | 120",
  "Монтаж водосточной системы | м | 84",
  "Установка кровельных люков | шт | 4",
].join("\n");

const REQUIREMENTS_TEXT = [
  "Требования к содержанию и составу заявки на участие в закупке",
  "Заявка на участие в закупке должна содержать следующие документы и сведения:",
  "1) полное наименование участника закупки, адрес места нахождения, номер контактного телефона;",
  "2) копия выписки из ЕГРЮЛ, полученная не ранее чем за 6 месяцев до даты подачи заявки;",
  "3) документы, подтверждающие полномочия лица на осуществление действий от имени участника;",
  "4) декларация о принадлежности участника к субъектам малого предпринимательства.",
].join("\n");

const NMCK_PLAIN = [
  "Обоснование начальной (максимальной) цены контракта",
  "Начальная (максимальная) цена контракта определена методом сопоставимых рыночных цен (анализа рынка).",
  "Информация о ценах получена по запросам трёх поставщиков, коммерческие предложения приложены.",
  "НМЦК составляет 12 450 000,00 рублей.",
].join("\n");

const NMCK_WITH_ESTIMATE = [
  "Обоснование начальной (максимальной) цены контракта",
  "Начальная (максимальная) цена контракта определена сметным методом.",
  "Локальный сметный расчёт № 02-01-01",
  "Наименование работ и затрат | Ед. изм. | Кол-во",
  "1 ГЭСН 15-02-001-01 Оштукатуривание стен | 100 м2 | 4,125",
  "2 ГЭСН 15-04-024-01 Окраска стен | 100 м2 | 3,8",
  "Всего по смете: 1 245 000,00",
].join("\n");

describe("countQuantityLines: число рядом с единицей", () => {
  it("считает строки таблицы с единицей после числа и до него", () => {
    expect(countQuantityLines("Окраска стен | м2 | 125,5")).toBe(1);
    expect(countQuantityLines("Окраска стен 125,5 м²")).toBe(1);
    expect(countQuantityLines("Кладка 1 240,5 м3")).toBe(1);
    expect(countQuantityLines("Устройство ограждений 100 м")).toBe(1);
    expect(countQuantityLines("Плиты перекрытия 12 шт.")).toBe(1);
    expect(countQuantityLines("Сталь арматурная 2,2 кг")).toBe(1);
    expect(countQuantityLines("Работа машин 14 маш.-ч")).toBe(1);
    expect(countQuantityLines("Земляные работы 100 m3")).toBe(1);
  });

  it("не считает сроки, проценты, подписи колонок и «т.е.»", () => {
    expect(countQuantityLines("Срок выполнения работ — 90 календарных дней")).toBe(0);
    expect(countQuantityLines("Пеня 1/300 ключевой ставки, НДС 20 %")).toBe(0);
    expect(countQuantityLines("№ п/п | Наименование | Ед. изм. | Количество")).toBe(0);
    expect(countQuantityLines("в течение 5 т.е. рабочих дней")).toBe(0);
    expect(countQuantityLines("двигатель 150 л.с.")).toBe(0);
    expect(countQuantityLines("")).toBe(0);
  });

  it("считает вхождения, а не переводы строк: таблица PDF одной длинной строкой не схлопывается в одну", () => {
    const oneLine = Array.from({ length: 6 }, (_, index) => `Работа номер ${String(index + 1)} в объёме ${String(100 + index)} м2 по проекту заказчика`).join(" ");
    expect(countQuantityLines(oneLine)).toBe(6);
  });

  it("два вхождения в одной строке ближе 30 знаков — одна строка", () => {
    expect(countQuantityLines("Плиты 12 шт 3 м")).toBe(1);
  });
});

describe("isDenseInQuantities: порог", () => {
  it("пять и больше строк — достаточно на любом объёме текста", () => {
    expect(isDenseInQuantities(QUANTITY_LINES_MIN, 5_000_000)).toBe(true);
    expect(isDenseInQuantities(4, 5_000_000)).toBe(false);
  });

  it("одна строка — мало даже в коротком тексте (пол — две)", () => {
    expect(isDenseInQuantities(1, 500)).toBe(false);
    expect(isDenseInQuantities(2, 3_900)).toBe(true);
    expect(isDenseInQuantities(2, 4_100)).toBe(false);
  });
});

describe("shouldReadWithModel: проект контракта", () => {
  it("проект контракта без объёмов не читается: срок, штраф и «5 т» — не ведомость", () => {
    const decision = shouldReadWithModel("Проект контракта.docx", CONTRACT_TEXT);
    expect(decision.read).toBe(false);
    expect(decision.reason).toContain("проект контракта");
  });

  it("безымянный файл узнаётся по заголовку: «МУНИЦИПАЛЬНЫЙ КОНТРАКТ №» в первых строках", () => {
    const decision = shouldReadWithModel("Документ.docx", CONTRACT_TEXT);
    expect(decision.read).toBe(false);
    expect(decision.reason).toContain("заголовку");
  });

  it("проект контракта с «Ведомостью объёмов работ» читается", () => {
    const decision = shouldReadWithModel("Проект контракта.docx", `${CONTRACT_TEXT}\n\n${BILL_APPENDIX}`);
    expect(decision.read).toBe(true);
    expect(decision.reason).toContain("ведомост");
  });

  it("проект контракта с таблицей работ без заголовка ведомости читается по плотности строк", () => {
    const table = Array.from({ length: 8 }, (_, index) => `Устройство стяжки пола, этаж ${String(index + 1)} | м2 | ${String(40 + index)}`).join("\n");
    const decision = shouldReadWithModel("Договор подряда.docx", `${CONTRACT_TEXT}\n${table}`);
    expect(decision.read).toBe(true);
    expect(decision.reason).toContain("строк с количеством");
  });

  it("ссылка «Приложение № 1 – Техническое задание» сама проект контракта не включает: слабый заголовок без строк с количеством", () => {
    expect(CONTRACT_TEXT).toContain("Приложение № 1 – Техническое задание");
    expect(shouldReadWithModel("Проект контракта.docx", CONTRACT_TEXT).read).toBe(false);
  });

  it("слабый заголовок + две строки с количеством включают чтение, даже когда имя — контракт", () => {
    const text = `${CONTRACT_TEXT}\nТехническое задание\nМонтаж ограждения | м | 120\nУстановка калитки | шт | 2`;
    expect(shouldReadWithModel("Проект контракта.docx", text).read).toBe(true);
  });

  it("слова «ТЗ», «спецификация» в имени отменяют пропуск: «Проект контракта и ТЗ» читается", () => {
    const decision = shouldReadWithModel("Проект контракта и ТЗ.docx", "Общие требования к работам. Подрядчик обязан соблюдать нормы.");
    expect(decision.read).toBe(true);
    expect(decision.reason).toContain("в имени файла");
  });

  it("«ТЗ к проекту контракта» и подобное имя — не проект контракта, а приложение к нему: читается", () => {
    expect(shouldReadWithModel("ТЗ к проекту контракта.docx", "Общие требования к работам.").read).toBe(true);
  });

  it("приложение к контракту — не проект контракта: имя «Приложение № 1 к контракту» не пропускается", () => {
    expect(shouldReadWithModel("Приложение № 1 к проекту контракта.docx", "Описание работ без таблицы.").read).toBe(true);
  });
});

describe("shouldReadWithModel: прочие документы", () => {
  it("ТЗ с таблицей единиц читается", () => {
    const decision = shouldReadWithModel("Техническое задание.docx", TZ_TEXT);
    expect(decision.read).toBe(true);
  });

  it("безымянное ТЗ с таблицей работ читается и без слов «техническое задание» в имени", () => {
    expect(shouldReadWithModel("Приложение 1.docx", TZ_TEXT).read).toBe(true);
  });

  it("требования к содержанию и составу заявки не читаются", () => {
    const decision = shouldReadWithModel("Требования к содержанию и составу заявки.docx", REQUIREMENTS_TEXT);
    expect(decision.read).toBe(false);
    expect(decision.reason).toContain("заявк");
  });

  it("то же без имени: заголовок первой строки", () => {
    expect(shouldReadWithModel("Приложение 3.docx", REQUIREMENTS_TEXT).read).toBe(false);
  });

  it.each([
    ["Инструкция участникам закупки.docx", "Инструкция по подготовке заявки. Участник подаёт заявку в электронной форме."],
    ["Формы документов.docx", "Форма 1. Заявка на участие в закупке. Форма 2. Анкета участника."],
    ["Образцы форм для заполнения.doc", "Образец заполнения. Наименование участника: ______"],
    ["Анкета участника.docx", "Анкета. Полное наименование: ______ ИНН: ______"],
    ["Декларация о соответствии.docx", "Декларация о соответствии участника требованиям закупки."],
    ["Согласие на обработку персональных данных.docx", "Я, ______, даю согласие на обработку персональных данных."],
    ["Доверенность.docx", "Доверенность № ____. Настоящей доверенностью уполномочиваем."],
    ["Банковская гарантия.docx", "Банк-гарант обязуется уплатить бенефициару сумму гарантии."],
    ["Протокол рассмотрения заявок.pdf", "Протокол заседания комиссии. Рассмотрены заявки участников."],
    ["Разъяснения положений документации.docx", "Ответ на запрос о даче разъяснений положений документации о закупке."],
    ["Извещение о проведении закупки.pdf", "Извещение о проведении запроса котировок. Заказчик: муниципальное учреждение."],
  ])("%s не читается", (name, text) => {
    expect(shouldReadWithModel(name, text).read).toBe(false);
  });

  it("безобъёмный документ с настоящей таблицей объёмов читается: имя не решает, когда объёмы видны", () => {
    const withTable = `${REQUIREMENTS_TEXT}\n${TZ_TEXT}`;
    expect(shouldReadWithModel("Требования к составу заявки.docx", withTable).read).toBe(true);
  });

  it("обоснование НМЦК без объёмов не читается", () => {
    const decision = shouldReadWithModel("Обоснование НМЦК.docx", NMCK_PLAIN);
    expect(decision.read).toBe(false);
    expect(decision.reason).toContain("НМЦК");
  });

  it("обоснование НМЦК со сметой читается (уровень сметы по заголовку)", () => {
    expect(shouldReadWithModel("Обоснование НМЦК.docx", NMCK_WITH_ESTIMATE).read).toBe(true);
  });

  it("обоснование НМЦК с плотной таблицей позиций читается по строкам с количеством", () => {
    const rows = Array.from({ length: 7 }, (_, index) => `Плитка керамическая, тип ${String(index + 1)} | ${String(20 + index)} м2 | цена 1 200,00`).join("\n");
    expect(shouldReadWithModel("Обоснование НМЦК.docx", `${NMCK_PLAIN}\n${rows}`).read).toBe(true);
  });

  it("незнакомое имя без признаков читается: пропускается только заведомо безобъёмное", () => {
    const decision = shouldReadWithModel("Пояснительная записка.docx", "Раздел 5. Ответственность");
    expect(decision.read).toBe(true);
    expect(decision.reason).toContain("не опознан");
  });

  it("ссылка в заголовке «Приложение к извещению» не делает ТЗ извещением", () => {
    const text = "Приложение № 1 к извещению о проведении закупки\nОписание работ: выполнить ремонт помещений по проекту заказчика.";
    expect(shouldReadWithModel("ТЗ.docx", text).read).toBe(true);
    expect(shouldReadWithModel("Документ.docx", text).read).toBe(true);
  });

  it("ведомость, смета и смета контракта не пропускаются ни при каком содержании", () => {
    expect(shouldReadWithModel("Ведомость объемов работ.docx", "пусто").read).toBe(true);
    expect(shouldReadWithModel("Смета.xlsx", "пусто").read).toBe(true);
    expect(shouldReadWithModel("Смета контракта.xlsx", "пусто").read).toBe(true);
  });

  it("таблица-не-работа («Ведомость потребности машин») слабым заголовком объёмов не считается", () => {
    const filler = "Стороны несут ответственность за неисполнение или ненадлежащее исполнение обязательств по Контракту. ".repeat(80);
    const text = `${CONTRACT_TEXT}\n${filler}\nВедомость потребности машин и механизмов\nБульдозер | шт | 1\nКран | шт | 1`;
    expect(shouldReadWithModel("Проект контракта.docx", text).read).toBe(false);
  });

  it("слабый заголовок считает только строки под собой: «Спецификация» в конце без данных не включает чтение", () => {
    const filler = "Стороны несут ответственность за неисполнение или ненадлежащее исполнение обязательств по Контракту. ".repeat(80);
    const text = `${CONTRACT_TEXT}\nОплата 10 шт образцов\nПоставка 20 шт образцов\n${filler}\nСпецификация\nПодписи сторон`;
    expect(shouldReadWithModel("Проект контракта.docx", text).read).toBe(false);
  });
});

const ZIP = "Документация.zip";

function archive(...files: readonly [string, string][]): string {
  return files.map(([name, body]) => `=== ${name} ===\n${body}\n`).join("");
}

describe("архив из нескольких файлов", () => {
  const mixed = archive(
    ["Проект контракта.docx", CONTRACT_TEXT],
    ["Ведомость объемов работ.xlsx", BILL_APPENDIX],
    ["Анкета участника.docx", "Анкета. Полное наименование: ______"],
    ["ТЗ.pdf", TZ_TEXT],
  );

  it("читается, если нужна хотя бы одна часть", () => {
    expect(shouldReadWithModel(ZIP, mixed).read).toBe(true);
  });

  it("в модель уходит текст только нужных частей, метки читаемых сохраняются", () => {
    const selection = selectDocumentForModel(ZIP, mixed);
    expect(selection.read).toBe(true);
    expect(selection.text).toContain("=== Ведомость объемов работ.xlsx ===");
    expect(selection.text).toContain("=== ТЗ.pdf ===");
    expect(selection.text).not.toContain("=== Проект контракта.docx ===");
    expect(selection.text).not.toContain("=== Анкета участника.docx ===");
    expect(selection.text).toContain("Окраска стен водоэмульсионными составами");
    expect(selection.text).not.toContain("1/300 ключевой ставки");
  });

  it("пропущенные файлы названы с архивом и причиной", () => {
    const selection = selectDocumentForModel(ZIP, mixed);
    expect(selection.skipped.map((item) => item.name)).toEqual([`Проект контракта.docx (в ${ZIP})`, `Анкета участника.docx (в ${ZIP})`]);
    expect(selection.skipped[0]?.reason).toContain("проект контракта");
    expect(selection.skipped[0]?.chars).toBeGreaterThan(0);
    expect(selection.reason).toBe("пропущено файлов: 2 из 4");
  });

  it("срез читаемой части в урезанном тексте тот же, что в исходном: цитаты и смещения не плывут", () => {
    const selection = selectDocumentForModel(ZIP, mixed);
    const quote = "3 | Окраска стен водоэмульсионными составами | м2 | 380";
    expect(mixed).toContain(quote);
    expect(selection.text).toContain(quote);
    // Читаемая часть стоит в урезанном тексте целиком и подряд: метка, тело, перевод строки.
    expect(selection.text).toContain(`=== Ведомость объемов работ.xlsx ===\n${BILL_APPENDIX}\n`);
  });

  it("все части читаются — текст возвращается без изменений", () => {
    const allRead = archive(["Ведомость объемов работ.xlsx", BILL_APPENDIX], ["ТЗ.pdf", TZ_TEXT]);
    const selection = selectDocumentForModel(ZIP, allRead);
    expect(selection.text).toBe(allRead);
    expect(selection.skipped).toEqual([]);
  });

  it("все части без объёмов — документ не читается, текст пуст, пропущено каждое", () => {
    const none = archive(["Проект контракта.docx", CONTRACT_TEXT], ["Анкета участника.docx", "Анкета. Полное наименование: ______"]);
    const selection = selectDocumentForModel(ZIP, none);
    expect(selection.read).toBe(false);
    expect(selection.text).toBe("");
    expect(selection.skipped).toHaveLength(2);
    expect(selection.reason).toBe("все 2 файлов архива без объёмов");
    expect(shouldReadWithModel(ZIP, none).read).toBe(false);
  });

  it("часть архива с уровнем сметы читается независимо от имени архива", () => {
    const text = archive(["Анкета.docx", "Анкета участника: ______"], ["Смета.xlsx", "Итого по смете: 100"]);
    const selection = selectDocumentForModel("Заявка.zip", text);
    expect(selection.text).toContain("=== Смета.xlsx ===");
    expect(selection.text).not.toContain("=== Анкета.docx ===");
  });

  it("лист книги с незнакомым именем читается", () => {
    const text = archive(["Лист1", "Просто текст без единиц."], ["Анкета.docx", "Анкета: ______"]);
    const selection = selectDocumentForModel("Книга.xlsx", text);
    expect(selection.text).toContain("=== Лист1 ===");
    expect(selection.skipped.map((item) => item.name)).toEqual(["Анкета.docx (в Книга.xlsx)"]);
  });

  it("начало текста до первой метки решается под именем документа", () => {
    const text = `${TZ_TEXT}\n${archive(["Анкета.docx", "Анкета: ______"])}`;
    const selection = selectDocumentForModel("Пакет.zip", text);
    expect(selection.text.startsWith(TZ_TEXT)).toBe(true);
    expect(selection.text).not.toContain("=== Анкета.docx ===");
  });
});

describe("переключатель ESTIMATE_READ_ALL_DOCUMENTS", () => {
  it("«1» и «true» включают чтение всех документов; пусто и «0» — нет", () => {
    expect(readAllDocuments({ ESTIMATE_READ_ALL_DOCUMENTS: "1" })).toBe(true);
    expect(readAllDocuments({ ESTIMATE_READ_ALL_DOCUMENTS: " TRUE " })).toBe(true);
    expect(readAllDocuments({ ESTIMATE_READ_ALL_DOCUMENTS: "0" })).toBe(false);
    expect(readAllDocuments({ ESTIMATE_READ_ALL_DOCUMENTS: "" })).toBe(false);
    expect(readAllDocuments({})).toBe(false);
  });

  it("с readAll безобъёмный документ и архив уходят в модель целиком, пропусков нет", () => {
    const text = archive(["Проект контракта.docx", CONTRACT_TEXT], ["ТЗ.pdf", TZ_TEXT]);
    const selection = selectDocumentForModel(ZIP, text, { readAll: true });
    expect(selection.text).toBe(text);
    expect(selection.skipped).toEqual([]);
    expect(selection.read).toBe(true);

    const contract = selectDocumentForModel("Проект контракта.docx", CONTRACT_TEXT, { readAll: true });
    expect(contract.read).toBe(true);
    expect(contract.text).toBe(CONTRACT_TEXT);
  });
});
