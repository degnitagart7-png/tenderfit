import { describe, expect, it } from "vitest";
import type {
  Tender,
  TenderDocument,
  TenderLot,
  TenderRequirement,
} from "@/domain/entities";
import type {
  MatchOptions,
  MatchResult,
  ParsedQuery,
  SearchCorpus,
  SearchScope,
} from "@/domain/textSearch";
import {
  buildCorpus,
  buildSearchIndex,
  buildSnippetCorpus,
  makeSnippet,
  matchCorpus,
  matchIndex,
  parseExcluded,
  parseSearchInput,
  snippetForMatch,
  snippetIsRedundant,
  stemRu,
} from "@/domain/textSearch";

/* ============================== Фабрики тестовых данных ============================== */

function makeLot(patch: Partial<TenderLot> = {}): TenderLot {
  return {
    id: "lot-1",
    number: 1,
    subject: "",
    price: 0,
    okpd2Codes: [],
    deliveryRegion: "",
    deliveryAddress: "",
    deliveryTermDays: null,
    ...patch,
  };
}

function makeRequirement(
  patch: Partial<TenderRequirement> = {},
): TenderRequirement {
  return {
    id: "req-1",
    kind: "OTHER",
    title: "",
    description: "",
    mandatory: false,
    requiredValue: null,
    evidenceId: null,
    ...patch,
  };
}

function makeDocument(patch: Partial<TenderDocument> = {}): TenderDocument {
  return {
    id: "doc-1",
    type: "OTHER",
    title: "",
    fileName: "",
    url: "",
    text: "",
    pageCount: null,
    lastModified: null,
    ...patch,
  };
}

function makeTender(patch: Partial<Tender> = {}): Tender {
  return {
    id: "t-1",
    regNumber: "01234567890",
    externalId: null,
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка оборудования",
    customerName: "ГБУЗ Городская больница",
    customerInn: "7701234567",
    region: "Московская область",
    deliveryAddress: "г. Москва, ул. Ленина, д. 1",
    financial: {
      price: 1_000_000,
      currency: "RUB",
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
    },
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
    eisUrl: "https://zakupki.gov.ru/placeholder",
    dataSource: "MOCK",
    changeLog: [],
    ...patch,
  };
}

function corpus(patch: Partial<SearchCorpus> = {}): SearchCorpus {
  return { subject: "", items: "", documents: "", codes: [], ...patch };
}

function query(patch: Partial<ParsedQuery> = {}): ParsedQuery {
  return { terms: [], anyGroups: [], excluded: [], codes: [], phrase: null, ...patch };
}

/* ============================== stemRu ============================== */

describe("stemRu", () => {
  it("приводит «вентиль», «вентиля» и «вентилей» к одной основе", () => {
    // Ключевой случай из кабинета Контур.Закупок: запрос «вентиля» находит
    // «ВЕНТИЛЬ» и «вентилей». Проверяем именно эту тройку.
    const base = stemRu("вентиль");
    expect(base).toBe(stemRu("вентиля"));
    expect(base).toBe(stemRu("вентилей"));
    expect(base).toBe("вентил");
  });

  it("работает в нижнем регистре и заменяет ё на е", () => {
    expect(stemRu("ВЕНТИЛЬ")).toBe("вентил");
    expect(stemRu("Ёлка")).toBe(stemRu("елка"));
  });

  it("сохраняет минимум три символа основы", () => {
    // Иначе «он», «у», «я» схлопнулись бы в пустоту и дали ложные совпадения.
    expect(stemRu("он")).toBe("он");
    expect(stemRu("у")).toBe("у");
    expect(stemRu("я")).toBe("я");
    expect(stemRu("дом")).toBe("дом");
  });

  it("не меняет латиницу и цифры", () => {
    expect(stemRu("Samsung")).toBe("samsung");
    expect(stemRu("2026")).toBe("2026");
    expect(stemRu("15б1бк")).toBe("15б1бк");
  });

  it("кэш основ не меняет результат при повторных вызовах", () => {
    // stemRu кэшируется, потому что поиск пересчитывается на каждый символ
    // ввода. Первый вызов заполняет кэш, второй обязан вернуть ровно то же.
    expect(stemRu("вентиля")).toBe("вентил");
    expect(stemRu("вентиля")).toBe("вентил");
    // Ключ кэша — нормализованное слово, поэтому регистр не создаёт вторую запись.
    expect(stemRu("ВЕНТИЛЯ")).toBe("вентил");
    expect(stemRu("вентиль")).toBe("вентил");
    expect(stemRu("вентилей")).toBe("вентил");
  });

  it("разные падежные формы одного слова дают одинаковую основу", () => {
    // Снимается самое длинное подходящее окончание: у «книгами» это «ами»,
    // а не «и», поэтому основа совпадает с «книга»/«книги».
    expect(stemRu("книгами")).toBe("книг");
    expect(stemRu("книга")).toBe("книг");
    expect(stemRu("книги")).toBe(stemRu("книга"));
  });
});

/* ============================== parseSearchInput ============================== */

describe("parseSearchInput", () => {
  it("разделяет слова пробелами и запятыми", () => {
    const parsed = parseSearchInput("лыжи, лыжные палки");
    expect(parsed.terms).toEqual(["лыжи", "лыжные", "палки"]);
    expect(parsed.excluded).toEqual([]);
    expect(parsed.codes).toEqual([]);
    expect(parsed.phrase).toBeNull();
  });

  it("слово с ведущим минусом уходит в исключения", () => {
    const parsed = parseSearchInput("ремонт -гарантия");
    expect(parsed.terms).toEqual(["ремонт"]);
    expect(parsed.excluded).toEqual(["гарантия"]);
  });

  it("выделяет коды ОКПД2, а числа без точек оставляет словами", () => {
    const parsed = parseSearchInput("36.40.11.133 30.01 2026");
    expect(parsed.codes).toEqual(["36.40.11.133", "30.01"]);
    expect(parsed.terms).toEqual(["2026"]);
  });

  it("короткий токен с точкой не считается кодом", () => {
    // «1.2» короче 5 символов — это не ОКПД2, а обычный текст.
    const parsed = parseSearchInput("1.2");
    expect(parsed.codes).toEqual([]);
    expect(parsed.terms).toEqual(["1", "2"]);
  });

  it("фраза в прямых кавычках идёт в phrase и не попадает в terms", () => {
    const parsed = parseSearchInput('"техническое обслуживание" вентиляция');
    expect(parsed.phrase).toBe("техническое обслуживание");
    expect(parsed.terms).toEqual(["вентиляция"]);
  });

  it("поддерживает типографские кавычки «»", () => {
    const parsed = parseSearchInput("«лыжные палки»");
    expect(parsed.phrase).toBe("лыжные палки");
    expect(parsed.terms).toEqual([]);
  });

  it("из нескольких фраз берёт первую, остальные слова — в terms", () => {
    const parsed = parseSearchInput('"первая фраза" "вторая фраза" слово');
    expect(parsed.phrase).toBe("первая фраза");
    expect(parsed.terms).toEqual(["вторая", "фраза", "слово"]);
  });

  it("пустая строка и строка из пробелов дают пустые массивы", () => {
    for (const input of ["", "   ", "\t\n  "]) {
      expect(parseSearchInput(input)).toEqual({
        terms: [],
        anyGroups: [],
        excluded: [],
        codes: [],
        phrase: null,
      });
    }
  });

  it("смешанный запрос: слова, минус-слово, код и фраза вместе", () => {
    const parsed = parseSearchInput(
      '"техническое обслуживание" вентиляция -ремонт 30.01.24.190',
    );
    expect(parsed.phrase).toBe("техническое обслуживание");
    expect(parsed.terms).toEqual(["вентиляция"]);
    expect(parsed.excluded).toEqual(["ремонт"]);
    expect(parsed.codes).toEqual(["30.01.24.190"]);
  });
});

/* ============================== parseExcluded ============================== */

describe("parseExcluded", () => {
  it("разбирает слова через запятую и пробел", () => {
    expect(parseExcluded("ремонт, монтаж гарантия")).toEqual([
      "ремонт",
      "монтаж",
      "гарантия",
    ]);
  });

  it("приводит к нижнему регистру и убирает дубликаты", () => {
    expect(parseExcluded("Ремонт ремонт РЕМОНТ")).toEqual(["ремонт"]);
  });

  it("пустая строка даёт пустой список", () => {
    expect(parseExcluded("   ")).toEqual([]);
  });
});

/* ============================== buildCorpus ============================== */

describe("buildCorpus", () => {
  it("собирает subject из предмета, заказчика и адреса поставки", () => {
    const tender = makeTender({
      subject: "Предмет закупки",
      customerName: "Заказчик ООО",
      deliveryAddress: "Адрес поставки",
    });
    const built = buildCorpus(tender);
    expect(built.subject).toContain("Предмет закупки");
    expect(built.subject).toContain("Заказчик ООО");
    expect(built.subject).toContain("Адрес поставки");
  });

  it("собирает items из лотов и требований", () => {
    const tender = makeTender({
      lots: [makeLot({ subject: "Позиция номенклатуры" })],
      requirements: [
        makeRequirement({ title: "Заголовок требования", description: "Текст требования" }),
      ],
    });
    const built = buildCorpus(tender);
    expect(built.items).toContain("Позиция номенклатуры");
    expect(built.items).toContain("Заголовок требования");
    expect(built.items).toContain("Текст требования");
  });

  it("собирает documents из заголовков и текстов документов", () => {
    const tender = makeTender({
      documents: [makeDocument({ title: "Извещение", text: "Текст документации" })],
    });
    const built = buildCorpus(tender);
    expect(built.documents).toContain("Извещение");
    expect(built.documents).toContain("Текст документации");
  });

  it("коды включают ОКПД2 закупки и лотов без дубликатов", () => {
    const tender = makeTender({
      okpd2Codes: ["30.01.24.190"],
      lots: [
        makeLot({ okpd2Codes: ["36.40.11.133"] }),
        makeLot({ id: "lot-2", okpd2Codes: ["30.01.24.190"] }),
      ],
    });
    const built = buildCorpus(tender);
    expect(built.codes).toContain("30.01.24.190");
    expect(built.codes).toContain("36.40.11.133");
    expect(built.codes.filter((c) => c === "30.01.24.190")).toHaveLength(1);
  });

  it("закупка без текста оставляет в корпусе реестровый номер", () => {
    const tender = makeTender({
      subject: "",
      customerName: "",
      deliveryAddress: "",
      lots: [],
      requirements: [],
      documents: [],
      okpd2Codes: [],
    });
    const built = buildCorpus(tender);
    // Номер входит в область «Название» намеренно: номер извещения копируют в
    // строку поиска чаще, чем формулируют предмет словами.
    expect(built.subject).toBe("01234567890");
    expect(built.items).toBe("");
    expect(built.documents).toBe("");
    expect(built.codes).toEqual([]);
  });

  it("пустая закупка без номера даёт пустой корпус", () => {
    const tender = makeTender({
      subject: "",
      customerName: "",
      deliveryAddress: "",
      regNumber: "",
      externalId: null,
      lots: [],
      requirements: [],
      documents: [],
      okpd2Codes: [],
    });
    expect(buildCorpus(tender)).toEqual({
      subject: "",
      items: "",
      documents: "",
      codes: [],
    });
  });

  it("реестровый номер находится поиском", () => {
    const tender = makeTender({
      subject: "Поставка вентилей",
      regNumber: "0345600001224000123",
    });
    expect(buildCorpus(tender).subject).toContain("0345600001224000123");
    const result = matchIndex(
      buildSearchIndex(tender),
      parseSearchInput("0345600001224000123"),
    );
    expect(result.matched).toBe(true);
  });

  it("отсутствующие массивы не приводят к падению", () => {
    // Данные из ЕИС/localStorage могут прийти без массивов — корпус обязан
    // собраться без исключений.
    const broken = {
      ...makeTender({ subject: "Только предмет" }),
      lots: undefined,
      requirements: undefined,
      documents: undefined,
      okpd2Codes: undefined,
    } as unknown as Tender;
    expect(() => buildCorpus(broken)).not.toThrow();
    const built = buildCorpus(broken);
    expect(built.items).toBe("");
    expect(built.documents).toBe("");
    expect(built.codes).toEqual([]);
    expect(built.subject).toContain("Только предмет");
  });

  it("кэширует корпус на объекте закупки и не смешивает разные закупки", () => {
    // Лента пересчитывает поиск на каждый keystroke; без кэша корпус
    // собирался бы заново сотни раз за минуту.
    const tender = makeTender({ subject: "Поставка вентилей" });
    expect(buildCorpus(tender)).toBe(buildCorpus(tender));

    const other = makeTender({ subject: "Ремонт насосов" });
    expect(buildCorpus(other).subject).toContain("Ремонт насосов");
    expect(buildCorpus(tender).subject).toContain("Поставка вентилей");
  });
});

/* ============================== buildSearchIndex ============================== */

describe("buildSearchIndex", () => {
  it("кэширует индекс на объекте закупки", () => {
    // Разбор текста на слова и основы — самая дорогая часть сопоставления, а
    // запрос человек меняет на каждый символ ввода.
    const tender = makeTender({ subject: "Поставка вентилей" });
    expect(buildSearchIndex(tender)).toBe(buildSearchIndex(tender));
  });

  it("индекс одной закупки не подмешивается в другую", () => {
    const first = makeTender({ subject: "Поставка вентилей" });
    const second = makeTender({ subject: "Ремонт насосов" });
    buildSearchIndex(first);
    expect(buildSearchIndex(second).corpus.subject).toContain("Ремонт насосов");
    expect(buildSearchIndex(first).corpus.subject).toContain("Поставка вентилей");
  });

  it("даёт тот же результат, что и matchCorpus", () => {
    // `matchCorpus` — обёртка для разовых вызовов, `matchIndex` — путь ленты.
    // Если они разойдутся, тесты перестанут описывать поведение продакшена.
    const tender = makeTender({
      subject: "Вентиляционные системы",
      okpd2Codes: ["30.01.24.190"],
    });
    const parsed = parseSearchInput("вент -аренда 30.01");
    const viaIndex = matchIndex(buildSearchIndex(tender), parsed);
    const viaCorpus = matchCorpus(buildCorpus(tender), parsed);
    expect(viaIndex).toEqual(viaCorpus);
    expect(viaIndex.matched).toBe(true);
  });

  it("повторные вызовы не меняют результат", () => {
    // Кэш основ обязан быть прозрачным: второй проход по тем же словам даёт то же.
    const tender = makeTender({ subject: "Вентиляция" });
    const parsed = parseSearchInput("вентиляционные");
    const first = matchIndex(buildSearchIndex(tender), parsed);
    const second = matchIndex(buildSearchIndex(tender), parsed);
    expect(first).toEqual(second);
    expect(first.matched).toBe(true);
  });
});

/* ============================== matchCorpus ============================== */

describe("matchCorpus", () => {
  it("пустой запрос подходит любой закупке и ничего не фильтрует", () => {
    const result = matchCorpus(corpus({ subject: "что угодно" }), query());
    expect(result).toEqual({
      matched: true,
      scopes: [],
      matchedTerms: [],
      matchedCodes: [],
      phraseMatched: false,
      excludedHit: false,
    });
  });

  it("находит слово по основе в предмете", () => {
    const result = matchCorpus(
      corpus({ subject: "ВЕНТИЛЬ 15Б1БК ДУ20 РУ16" }),
      query({ terms: ["вентиля"] }),
    );
    expect(result.matched).toBe(true);
    expect(result.scopes).toEqual(["subject"]);
    expect(result.matchedTerms).toEqual(["вентиля"]);
  });

  it("совпадение в номенклатуре и документах попадает в scopes в каноническом порядке", () => {
    const result = matchCorpus(
      corpus({ items: "вентиль", documents: "вентилей" }),
      query({ terms: ["вентиля"] }),
    );
    expect(result.matched).toBe(true);
    expect(result.scopes).toEqual(["items", "documents"]);
  });

  it("фраза ищется дословно", () => {
    const hit = matchCorpus(
      corpus({ subject: "техническое обслуживание инженерных систем" }),
      query({ phrase: "техническое обслуживание" }),
    );
    expect(hit.matched).toBe(true);
    expect(hit.scopes).toEqual(["subject"]);

    const miss = matchCorpus(
      corpus({ subject: "обслуживание техническое" }),
      query({ phrase: "техническое обслуживание" }),
    );
    expect(miss.matched).toBe(false);
  });

  it("код ОКПД2 совпадает по префиксу, но не наоборот", () => {
    const prefix = matchCorpus(
      corpus({ codes: ["30.01.24.190"] }),
      query({ codes: ["30.01"] }),
    );
    expect(prefix.matched).toBe(true);

    const reverse = matchCorpus(
      corpus({ codes: ["30.01"] }),
      query({ codes: ["30.01.24.190"] }),
    );
    expect(reverse.matched).toBe(false);
  });

  it("совпадение только по коду даёт matched без текстовых областей", () => {
    const result = matchCorpus(
      corpus({ codes: ["30.01.24.190"] }),
      query({ codes: ["30.01"] }),
    );
    expect(result.matched).toBe(true);
    expect(result.scopes).toEqual([]);
    expect(result.matchedTerms).toEqual([]);
    expect(result.matchedCodes).toEqual(["30.01"]);
  });

  it("matchedCodes перечисляет только те коды запроса, которые совпали", () => {
    const result = matchCorpus(
      corpus({ codes: ["30.01.24.190", "43.12.10.000"] }),
      query({ codes: ["30.01", "99.99", "43.12"] }),
    );
    expect(result.matchedCodes).toEqual(["30.01", "43.12"]);
  });

  it("phraseMatched отличает дословную фразу от совпадения по одному слову", () => {
    const whole = matchCorpus(
      corpus({ subject: "техническое обслуживание инженерных систем" }),
      query({ phrase: "техническое обслуживание" }),
    );
    expect(whole.phraseMatched).toBe(true);

    // Слова из фразы есть, но порядок другой: дословного совпадения нет,
    // хотя закупка всё равно подходит по словам.
    const scattered = matchCorpus(
      corpus({ subject: "обслуживание техническое" }),
      query({ terms: ["техническое", "обслуживание"], phrase: "техническое обслуживание" }),
    );
    expect(scattered.phraseMatched).toBe(false);
    expect(scattered.matched).toBe(true);
  });

  it("исключённое слово отсекает закупку даже при совпадении ключевого", () => {
    const result = matchCorpus(
      corpus({ subject: "ремонт вентилей" }),
      query({ terms: ["вентиля"], excluded: ["ремонт"] }),
    );
    expect(result.matched).toBe(false);
    expect(result.excludedHit).toBe(true);
  });

  it("exact ищет дословное вхождение подстрок без основ", () => {
    const text = corpus({ subject: "вентиляция" });
    const q = query({ terms: ["ентил"] });
    // Нечёткий поиск сопоставляет основы слов, а «ентил» началом основы
    // «вентиляци» не является — совпадение даёт только дословный режим.
    expect(matchCorpus(text, q).matched).toBe(false);
    expect(matchCorpus(text, q, { exact: true }).matched).toBe(true);
  });

  it("недобор букв находит слово по префиксу основы", () => {
    // Человек печатает «вент» и ждёт выдачу про вентиляцию: основы «вент» и
    // «вентиляцион» не равны, но одна является началом другой.
    const result = matchCorpus(
      corpus({ subject: "Вентиляционные системы" }),
      query({ terms: ["вент"] }),
    );
    expect(result.matched).toBe(true);
  });

  it("префикс основы работает в обе стороны", () => {
    // Запрос длиннее текста закупки: «вентиляционные» обязано находить
    // закупку, где написано просто «вентиляция».
    const result = matchCorpus(
      corpus({ subject: "Вентиляция" }),
      query({ terms: ["вентиляционные"] }),
    );
    expect(result.matched).toBe(true);
  });

  it("огрызок из двух букв не тянет в выдачу всё подряд", () => {
    // Иначе «об» нашло бы и оборудование, и обслуживание, и обувь.
    const result = matchCorpus(
      corpus({ subject: "Оборудование" }),
      query({ terms: ["об"] }),
    );
    expect(result.matched).toBe(false);
  });

  it("области поиска ограничивают просмотр", () => {
    const result = matchCorpus(
      corpus({ subject: "вентиль", documents: "вентиль" }),
      query({ terms: ["вентиля"] }),
      { scopes: ["documents"] },
    );
    expect(result.matched).toBe(true);
    expect(result.scopes).toEqual(["documents"]);
  });

  it("пустая область documents не даёт совпадений и не считается ошибкой", () => {
    const result = matchCorpus(
      corpus({ documents: "" }),
      query({ terms: ["вентиля"] }),
    );
    expect(result.matched).toBe(false);
    expect(result.scopes).toEqual([]);
  });

  it("MatchOptions и MatchResult используются как типы", () => {
    const options: MatchOptions = { exact: false, scopes: ["subject"] as SearchScope[] };
    const result: MatchResult = matchCorpus(
      corpus({ subject: "вентиль" }),
      query({ terms: ["вентиля"] }),
      options,
    );
    expect(result.matched).toBe(true);
  });
});

/* ============================== makeSnippet ============================== */

describe("makeSnippet", () => {
  it("возвращает null при отсутствии совпадений", () => {
    expect(makeSnippet("просто текст без совпадений", ["вентиля"])).toBeNull();
  });

  it("возвращает null для пустого текста и пустых terms", () => {
    expect(makeSnippet("", ["вентиля"])).toBeNull();
    expect(makeSnippet("   ", ["вентиля"])).toBeNull();
    expect(makeSnippet("текст про вентиль", [])).toBeNull();
  });

  it("короткий текст возвращается целиком без многоточий", () => {
    expect(makeSnippet("Комплект деталей вентиля", ["вентиля"])).toBe(
      "Комплект деталей вентиля",
    );
  });

  it("схлопывает переносы строк и лишние пробелы", () => {
    const snippet = makeSnippet(
      "first\n\n   second   вентиль   third",
      ["вентиля"],
    );
    expect(snippet).toBe("first second вентиль third");
  });

  it("обрезает длинный текст по границам слов с многоточиями с обеих сторон", () => {
    const long = `${"слово ".repeat(100)}вентиль ${"слово ".repeat(100)}`;
    const snippet = makeSnippet(long, ["вентиля"], 60);
    expect(snippet).not.toBeNull();
    expect(snippet?.startsWith("…")).toBe(true);
    expect(snippet?.endsWith("…")).toBe(true);
    expect((snippet ?? "").replace(/…/g, "").length).toBeLessThanOrEqual(60);
    expect(snippet).toContain("вентиль");
  });

  it("строит сниппет вокруг первого совпадения без обрезки в начале", () => {
    const snippet = makeSnippet("вентиль начало середина конец", ["вентиля"], 20);
    expect(snippet).toContain("вентиль");
    // Совпадение в самом начале — спереди нечего обрезать, значит нет «…».
    expect(snippet?.startsWith("…")).toBe(false);
  });

  it("находит совпадение по основе русской словоформы", () => {
    const snippet = makeSnippet(
      "Поставка баллонов БК-7-300Н и вентилей для газовой системы",
      ["вентиля"],
      220,
    );
    expect(snippet).toContain("вентилей");
  });

  it("строит сниппет и для совпадения по префиксу основы", () => {
    // Правило сниппета обязано совпадать с правилом поиска: закупка, попавшая
    // в выдачу по недобору «вент», не может остаться без пояснения — иначе
    // человек видит результат и не понимает, что именно в нём нашлось.
    const snippet = makeSnippet(
      "Вентиляционные системы для производственного цеха",
      ["вент"],
      220,
    );
    expect(snippet).toContain("Вентиляционные");
  });
});

/* ============================== snippetForMatch ============================== */

describe("snippetForMatch", () => {
  function matchResult(patch: Partial<MatchResult> = {}): MatchResult {
    return {
      matched: true,
      scopes: [],
      matchedTerms: [],
      matchedCodes: [],
      phraseMatched: false,
      excludedHit: false,
      ...patch,
    };
  }

  const tender = makeTender({
    subject: "Поставка вентиляционного оборудования для котельной",
    lots: [makeLot({ subject: "Вентиль 15Б1БК для трубопровода" })],
    documents: [
      makeDocument({
        title: "Проект контракта",
        text: "Пункт 1. Поставщик обязуется передать вентиль 15Б1БК в срок до 30 дней.",
      }),
    ],
    okpd2Codes: ["28.25.13"],
  });
  const built = buildSnippetCorpus(tender);

  it("закупка вне выдачи остаётся без сниппета", () => {
    expect(
      snippetForMatch(built, matchResult({ matched: false }), query({ terms: ["вентиля"] })),
    ).toBeNull();
  });

  it("сниппет берётся из названия, когда слово нашлось и там, и в документации", () => {
    // Порядок областей фиксирован и не зависит от того, в каком порядке их
    // вернул `matchIndex`: название — самый сильный сигнал, и показывать
    // вместо него кусок извещения значило бы прятать лучшую подсказку.
    const snippet = snippetForMatch(
      built,
      matchResult({ scopes: ["documents", "subject"], matchedTerms: ["вентиля"] }),
      query({ terms: ["вентиля"] }),
    );
    expect(snippet).toBe("Поставка вентиляционного оборудования для котельной");
  });

  it("сниппет не повторяет заказчика, номер извещения и адрес", () => {
    // У этих полей в таблице свои колонки. Цитировать их ещё и под предметом
    // закупки — значит заменить подсказку шумом.
    const snippet = snippetForMatch(
      built,
      matchResult({ scopes: ["subject"], matchedTerms: ["вентиля"] }),
      query({ terms: ["вентиля"] }),
    );
    expect(snippet).not.toContain("ГБУЗ");
    expect(snippet).not.toContain("01234567890");
    expect(snippet).not.toContain("ул. Ленина");
    // Поиск при этом по номеру извещения работает: корпус шире сниппета.
    expect(buildCorpus(tender).subject).toContain("01234567890");
    expect(
      matchIndex(buildSearchIndex(tender), parseSearchInput("01234567890")).matched,
    ).toBe(true);
  });

  it("номенклатура важнее документации", () => {
    const snippet = snippetForMatch(
      built,
      matchResult({ scopes: ["documents", "items"], matchedTerms: ["вентиля"] }),
      query({ terms: ["вентиля"] }),
    );
    expect(snippet).toContain("Вентиль 15Б1БК");
  });

  it("области вне совпадения в сниппет не попадают", () => {
    const snippet = snippetForMatch(
      built,
      matchResult({ scopes: ["documents"], matchedTerms: ["вентиля"] }),
      query({ terms: ["вентиля"] }),
    );
    expect(snippet).toContain("Пункт 1. Поставщик");
    expect(snippet).not.toContain("котельной");
    expect(snippet).not.toContain("для трубопровода");
  });

  it("фраза без разбора на слова объясняется самой фразой", () => {
    const snippet = snippetForMatch(
      built,
      matchResult({ phraseMatched: true }),
      query({ phrase: "15б1бк" }),
    );
    expect(snippet).toContain("15Б1БК");
  });

  it("совпадение только по коду ОКПД2 сниппета не даёт", () => {
    // Кода нет ни в названии, ни в номенклатуре, ни в тексте документации —
    // подсвечивать нечего. Закупка объясняется подписью релевантности
    // («Совпадение по коду ОКПД2»), а предмет и так виден в своей колонке.
    expect(
      snippetForMatch(
        built,
        matchResult({ matchedCodes: ["28.25.13"] }),
        query({ codes: ["28.25.13"] }),
      ),
    ).toBeNull();
  });

  it("пустой запрос не рисует пустую строку под предметом", () => {
    expect(snippetForMatch(built, matchResult(), query())).toBeNull();
  });

  it("слово запроса ищется в сниппете по основе, как и в поиске", () => {
    const snippet = snippetForMatch(
      built,
      matchResult({ scopes: ["subject"], matchedTerms: ["вент"] }),
      query({ terms: ["вент"] }),
    );
    expect(snippet).toContain("вентиляционного");
  });

  it("длина сниппета ограничена", () => {
    const long = makeTender({
      subject: `${"документация ".repeat(40)}вентиль`,
    });
    const snippet = snippetForMatch(
      buildSnippetCorpus(long),
      matchResult({ scopes: ["subject"], matchedTerms: ["вентиля"] }),
      query({ terms: ["вентиля"] }),
      60,
    );
    expect(snippet).toContain("вентиль");
    expect((snippet ?? "").replace(/…/g, "").length).toBeLessThanOrEqual(60);
  });
});

/* ============================== buildSnippetCorpus ============================== */

describe("buildSnippetCorpus", () => {
  it("кэшируется на объекте закупки", () => {
    const tender = makeTender();
    expect(buildSnippetCorpus(tender)).toBe(buildSnippetCorpus(tender));
  });

  it("не смешивает закупки между собой", () => {
    const first = makeTender({ id: "t-1", subject: "Первая закупка" });
    const second = makeTender({ id: "t-2", subject: "Вторая закупка" });
    expect(buildSnippetCorpus(first).subject).toBe("Первая закупка");
    expect(buildSnippetCorpus(second).subject).toBe("Вторая закупка");
  });

  it("отличается от поискового корпуса только названием", () => {
    const tender = makeTender({
      subject: "Поставка вентилей",
      lots: [makeLot({ subject: "Вентиль 15Б1БК" })],
      documents: [makeDocument({ title: "Извещение", text: "Текст извещения" })],
      okpd2Codes: ["28.14.12"],
    });
    const snippet = buildSnippetCorpus(tender);
    const search = buildCorpus(tender);
    expect(snippet).not.toBe(search);
    expect(snippet.subject).toBe("Поставка вентилей");
    expect(search.subject).toContain("Поставка вентилей");
    expect(search.subject).toContain("01234567890");
    expect(snippet.items).toBe(search.items);
    expect(snippet.documents).toBe(search.documents);
    expect(snippet.codes).toEqual([]);
    expect(search.codes).toEqual(["28.14.12"]);
  });
});

/* ============================== snippetIsRedundant ============================== */

describe("snippetIsRedundant", () => {
  it("сниппет, дословно равный названию, ничего не добавляет", () => {
    expect(snippetIsRedundant("Поставка ноутбуков для офиса", "Поставка ноутбуков для офиса")).toBe(
      true,
    );
  });

  it("регистр и переносы строк не мешают сравнению", () => {
    expect(snippetIsRedundant("Поставка\n  ноутбуков", "поставка НОУТБУКОВ")).toBe(true);
  });

  it("отсутствие сниппета — тоже нечего показывать", () => {
    expect(snippetIsRedundant(null, "Поставка ноутбуков")).toBe(true);
  });

  it("окно вокруг совпадения в длинном названии остаётся полезным", () => {
    const subject = `${"документация ".repeat(40)}вентиль ${"приложение ".repeat(40)}`;
    const snippet = makeSnippet(subject, ["вентиля"], 60);
    expect(snippetIsRedundant(snippet, subject)).toBe(false);
  });

  it("сниппет из номенклатуры не равен названию", () => {
    expect(snippetIsRedundant("Вентиль 15Б1БК для трубопровода", "Поставка оборудования")).toBe(
      false,
    );
  });
});

/* ============================== Сквозные сценарии ============================== */

describe("сквозные сценарии (parse → build → match)", () => {
  it("запрос Контура находит закупку по основе слова", () => {
    const parsed = parseSearchInput("вентиля -ремонт");
    const tender = makeTender({ subject: "Поставка вентилей 15Б1БК" });
    const result = matchCorpus(buildCorpus(tender), parsed);
    expect(result.matched).toBe(true);
    expect(result.matchedTerms).toEqual(["вентиля"]);
  });

  it("минус-слово отсекает закупку, где оно встретилось", () => {
    const parsed = parseSearchInput("вентиля -ремонт");
    const tender = makeTender({ subject: "Ремонт вентилей" });
    const result = matchCorpus(buildCorpus(tender), parsed);
    expect(result.matched).toBe(false);
    expect(result.excludedHit).toBe(true);
  });

  it("поиск по коду ОКПД2 находит закупку из лота", () => {
    const parsed = parseSearchInput("30.01");
    const tender = makeTender({
      subject: "Картридж для принтера",
      lots: [makeLot({ okpd2Codes: ["30.01.24.190"] })],
    });
    const result = matchCorpus(buildCorpus(tender), parsed);
    expect(result.matched).toBe(true);
  });

  it("сниппет строится из найденного в документах текста", () => {
    const parsed = parseSearchInput("вентиля");
    const tender = makeTender({
      subject: "Оказание комплекса услуг",
      documents: [
        makeDocument({
          title: "Техническое задание",
          text: `${"Закупка деталей. ".repeat(20)}Комплект деталей запорного органа вентиля 12.0103.00.000 ${"продолжение текста ".repeat(20)}`,
        }),
      ],
    });
    const built = buildCorpus(tender);
    const result = matchCorpus(built, parsed, { scopes: ["documents"] });
    expect(result.matched).toBe(true);
    const snippet = makeSnippet(built.documents, result.matchedTerms, 80);
    expect(snippet).not.toBeNull();
    expect(snippet).toContain("вентиля");
  });
});

/**
 * Слова запроса складываются по «и», а не по «или».
 *
 * Замер на живой ленте 01.10.2026: запрос «Юридические услуги» вернул
 * транспортировку отходов, лизинг автомобилей, индор-рекламу МТС и
 * техобслуживание — всё, где встречается слово «услуги». Второе слово запроса
 * не участвовало в отборе вовсе: совпадения по любому слову хватало.
 *
 * Для поиска это не придирка, а разница между инструментом и генератором шума:
 * «юридические услуги» — одно понятие из двух слов, и ни одно из них по
 * отдельности запроса не выражает.
 *
 * Дополнительные ключевые слова — другое дело. Они приходят из профиля поиска
 * списком («ноутбук, принтер, МФУ, сервер») и означают «любое из»: требовать
 * их все значило бы искать закупку, где есть сразу всё перечисленное.
 */
describe("слова запроса сочетаются по «и»", () => {
  const legal = corpus({ subject: "Оказание юридических услуг для нужд учреждения" });
  const waste = corpus({ subject: "Оказание услуг по транспортировке отходов" });

  it("оба слова есть — совпадение", () => {
    expect(matchCorpus(legal, query({ terms: ["юридические", "услуги"] })).matched).toBe(true);
  });

  it("есть только одно слово — не совпадение", () => {
    expect(matchCorpus(waste, query({ terms: ["юридические", "услуги"] })).matched).toBe(false);
  });

  it("одно слово в запросе работает как раньше", () => {
    expect(matchCorpus(waste, query({ terms: ["услуги"] })).matched).toBe(true);
  });

  it("слова могут стоять в разных областях закупки", () => {
    const split = corpus({
      subject: "Оказание юридических услуг",
      documents: "Представительство в арбитраже",
    });

    expect(
      matchCorpus(split, query({ terms: ["юридических", "арбитраже"] })).matched,
    ).toBe(true);
  });

  it("дополнительные слова — любое из", () => {
    const laptops = corpus({ subject: "Закупка ноутбуков" });

    expect(
      matchCorpus(
        laptops,
        query({ anyGroups: [["ноутбук"], ["принтер"], ["сервер"]] }),
      ).matched,
    ).toBe(true);
  });

  it("ни одного из дополнительных — не совпадение", () => {
    expect(
      matchCorpus(
        waste,
        query({ anyGroups: [["ноутбук"], ["принтер"], ["сервер"]] }),
      ).matched,
    ).toBe(false);
  });

  /*
    Ключевое слово профиля может состоять из нескольких слов: «Юридические
    услуги». Внутри него слова складываются по «и», между ключевыми словами —
    по «или». Если разложить такое слово на отдельные, «услуги» станет
    самостоятельным ключевым словом и вернёт всю ленту.
  */
  it("многословное ключевое слово профиля требует все свои слова", () => {
    const groups = [["юридические", "услуги"], ["юристы"]];

    expect(matchCorpus(legal, query({ anyGroups: groups })).matched).toBe(true);
    expect(matchCorpus(waste, query({ anyGroups: groups })).matched).toBe(false);
  });

  it("другое ключевое слово профиля срабатывает само по себе", () => {
    const lawyers = corpus({ subject: "Привлечение юристов для представления интересов" });

    expect(
      matchCorpus(lawyers, query({ anyGroups: [["юридические", "услуги"], ["юристы"]] })).matched,
    ).toBe(true);
  });

  /*
    Строка поиска и ключевые слова профиля — альтернативы, а не сужение друг
    друга. Так читается и ссылка, сохранённая до этой правки: `q` несёт первое
    слово профиля, `q2` — остальные, и все вместе они означали «любое из».
  */
  it("строка поиска и ключевые слова профиля — альтернативы", () => {
    const lawyers = corpus({ subject: "Привлечение юристов для представления интересов" });
    const q = query({ terms: ["юридические", "услуги"], anyGroups: [["юристы"]] });

    expect(matchCorpus(legal, q).matched).toBe(true);
    expect(matchCorpus(lawyers, q).matched).toBe(true);
    expect(matchCorpus(waste, q).matched).toBe(false);
  });

  it("фраза в кавычках по-прежнему обязательна", () => {
    expect(matchCorpus(waste, query({ phrase: "юридических услуг" })).matched).toBe(false);
    expect(matchCorpus(legal, query({ phrase: "юридических услуг" })).matched).toBe(true);
  });
});

/**
 * «Юридическое лицо» — не юридические услуги.
 *
 * Замер на живой базе 01.10.2026: из 275 закупок слово «юридическ…» встречается
 * в 24, а о юридических услугах — в трёх. Остальные — «услуги юридическому
 * лицу», «страхование имущества юридических лиц», «проверка юридических и
 * физических лиц»: тот же корень, другой смысл. Запрос «юридические услуги»
 * возвращал их все, и настоящие закупки тонули среди связи, интернета и
 * образовательных программ.
 *
 * Идиома вычёркивается из текста перед сопоставлением, но только если человек
 * сам не ищет юридических лиц: «юридическому лицу» в строке запроса обязано
 * находить именно их.
 */
describe("омоним «юридическое лицо»", () => {
  const entity = corpus({ subject: "Оказание услуг связи юридическому лицу, финансируемому из бюджета" });
  const entityPlural = corpus({ subject: "Оказание услуг по страхованию имущества юридических лиц" });
  const both = corpus({ subject: "Проверка юридических и физических лиц: информационные услуги" });
  const law = corpus({ subject: "Оказание комплекса юридических услуг по оформлению документации" });
  const consulting = corpus({ subject: "Оказание услуг по юридическому консультированию сотрудников" });

  const legalQuery = query({ terms: ["юридические", "услуги"] });

  it("«юридическому лицу» не считается юридической услугой", () => {
    expect(matchCorpus(entity, legalQuery).matched).toBe(false);
  });

  it("«юридических лиц» тоже", () => {
    expect(matchCorpus(entityPlural, legalQuery).matched).toBe(false);
  });

  it("«юридических и физических лиц» тоже", () => {
    expect(matchCorpus(both, legalQuery).matched).toBe(false);
  });

  it("настоящие юридические услуги находятся", () => {
    expect(matchCorpus(law, legalQuery).matched).toBe(true);
    expect(matchCorpus(consulting, legalQuery).matched).toBe(true);
  });

  it("если человек ищет юридических лиц, они находятся", () => {
    expect(
      matchCorpus(entity, query({ terms: ["юридическому", "лицу"] })).matched,
    ).toBe(true);
  });

  it("слово «лицо» в запросе возвращает идиому и для «юридические»", () => {
    expect(
      matchCorpus(entityPlural, query({ terms: ["юридические", "лица"] })).matched,
    ).toBe(true);
  });

  /*
    Найдено на живой выдаче 01.10.2026: по запросу «юридические услуги»
    первой шла аренда помещения «в качестве юридического адреса» для филиала
    в Египте. Адрес регистрации компании — такой же омоним, как «лицо».
  */
  it("«юридический адрес» — не юридическая услуга", () => {
    const address = corpus({
      subject: "Оказание услуг по предоставлению нежилого помещения (с правом использования в качестве юридического адреса) для филиала",
    });

    expect(matchCorpus(address, legalQuery).matched).toBe(false);
  });

  it("если человек ищет юридический адрес, он находится", () => {
    const address = corpus({
      subject: "Оказание услуг по предоставлению нежилого помещения (с правом использования в качестве юридического адреса) для филиала",
    });

    expect(
      matchCorpus(address, query({ terms: ["юридический", "адрес"] })).matched,
    ).toBe(true);
  });

  it("запрос с одним словом «юридический» тоже не тянет юридических лиц", () => {
    expect(matchCorpus(entity, query({ terms: ["юридический"] })).matched).toBe(false);
    expect(matchCorpus(law, query({ terms: ["юридический"] })).matched).toBe(true);
  });

  it("точное совпадение работает так же", () => {
    expect(
      matchCorpus(entity, query({ terms: ["юридическ"] }), { exact: true }).matched,
    ).toBe(false);
    expect(
      matchCorpus(law, query({ terms: ["юридическ"] }), { exact: true }).matched,
    ).toBe(true);
  });
});

/**
 * Прилагательные сводятся к одной основе во всех падежах.
 *
 * В списке окончаний не хватало «ие», «ого», «его», «ому», «ему», и основы
 * расходились: «юридические» → «юридически», «юридического» → «юридическог»,
 * «юридическому» → «юридическом». Ни одна не была началом другой, поэтому
 * запрос «юридические услуги» не находил «услуги по юридическому
 * консультированию» — настоящую юридическую закупку.
 *
 * Провал не частный: так же теряются «технические», «медицинские»,
 * «электрические» и все прочие прилагательные на -ие/-ого/-ому.
 */
describe("основы прилагательных", () => {
  it.each([
    ["юридические", "юридическое"],
    ["юридического", "юридическое"],
    ["юридическому", "юридическое"],
    ["юридической", "юридическое"],
    ["юридических", "юридическое"],
    ["технические", "техническое"],
    ["технического", "техническое"],
    ["синего", "синее"],
    ["синему", "синее"],
  ])("«%s» и «%s» дают одну основу", (a, b) => {
    expect(stemRu(a)).toBe(stemRu(b));
  });

  it("существительные на -ие не ломаются: формы остаются совместимы по префиксу", () => {
    const forms = ["оборудование", "оборудования", "оборудованию", "оборудованием"].map(stemRu);
    const shortest = forms.reduce((a, b) => (a.length <= b.length ? a : b));

    for (const form of forms) expect(form.startsWith(shortest)).toBe(true);
  });
});

/**
 * Короткое слово в тексте не считается началом длинного слова запроса.
 *
 * Правило префикса было симметричным: подходило, если одно слово начинается с
 * другого, а короткое не короче трёх букв. Для запроса, набранного не до конца
 * («вент» → «вентиль»), это нужно. Но в обратную сторону оно пускало любое
 * трёхбуквенное слово текста: предлог «под» находил «подстанция», «при» —
 * «приобретение», «без» — «безопасность», а основа «рек» от слова «реку» —
 * «реклама».
 *
 * Замер на живой базе 01.10.2026: «подстанция» нашла 3 закупки, и ни в одной
 * этого слова не было; «приобретение» — 16, из них 9 по предлогу «при».
 * Дефект не зависит от сферы: страдают все слова, начинающиеся на «при-»,
 * «под-», «без-», «над-», «про-».
 */
describe("короткие слова текста не находят длинные слова запроса", () => {
  it.each([
    ["безопасность", "Поставка бумаги для офиса, цена без НДС"],
    ["подстанция", "Поставка бумаги, оплата под отчёт"],
    ["приобретение", "Поставка бумаги при условии доставки"],
    ["проектирование", "Поставка бумаги про запас"],
    ["надзор", "Поставка бумаги над столом"],
    ["реклама", "Ремонт пешеходного моста через реку"],
  ])("«%s» не находит «%s»", (term, text) => {
    expect(matchCorpus(corpus({ subject: text }), query({ terms: [term] })).matched).toBe(false);
  });

  it("слово, набранное не до конца, по-прежнему находит полное", () => {
    const text = corpus({ subject: "Поставка вентиля запорного" });

    expect(matchCorpus(text, query({ terms: ["вент"] })).matched).toBe(true);
    expect(matchCorpus(text, query({ terms: ["вен"] })).matched).toBe(true);
  });

  it("словоформы с разным хвостом по-прежнему находят друг друга", () => {
    const noun = corpus({ subject: "Монтаж вентиляция помещений" });
    const adjective = corpus({ subject: "Монтаж вентиляционных систем" });

    expect(matchCorpus(noun, query({ terms: ["вентиляционные"] })).matched).toBe(true);
    expect(matchCorpus(adjective, query({ terms: ["вентиляция"] })).matched).toBe(true);
  });

  it("настоящее слово по-прежнему находится, даже если рядом есть предлог", () => {
    const text = corpus({ subject: "Приобретение бумаги при условии доставки" });

    expect(matchCorpus(text, query({ terms: ["приобретение"] })).matched).toBe(true);
  });
});
