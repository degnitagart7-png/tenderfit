import { describe, expect, it } from "vitest";

import {
  MAX_EXPANSIONS,
  MAX_RERANK_ITEMS,
  buildExpandPrompt,
  buildRerankPrompt,
  parseExpansions,
  parseRerank,
} from "@/domain/searchAssist";

/**
 * Помощник поиска на языковой модели: расширение запроса и переоценка выдачи.
 *
 * Зачем он нужен, показал замер на живой базе. Слова запроса ищутся по основе, и
 * никакие правила стемминга не отличат «услуги юридическому лицу» от «юридических
 * услуг»: корень один, смысл разный. Векторный поиск тоже не помог — проверено
 * 04.10.2026 на двух моделях шлюза: у `text-embedding-3-small` «услуги связи
 * юридическому лицу» (0,617) оказались ближе к запросу, чем настоящие
 * юридические услуги (0,537 и 0,550). Остаётся то, что понимает смысл фразы, —
 * языковая модель, но только там, где её об этом просят: на явное нажатие и на
 * малом числе кандидатов.
 */

describe("buildExpandPrompt", () => {
  it("называет запрос и просит ответ JSON-ом", () => {
    const prompt = buildExpandPrompt("юридические услуги");

    expect(prompt).toContain("юридические услуги");
    expect(prompt).toContain("JSON");
  });

  it("предупреждает об омонимах: слово с тем же корнем, но другим смыслом не нужно", () => {
    const prompt = buildExpandPrompt("юридические услуги");

    expect(prompt.toLowerCase()).toContain("омоним");
    expect(prompt).toContain("юридическое лицо");
  });

  it("просит короткие формулировки, а не общие слова", () => {
    expect(buildExpandPrompt("охрана объектов")).toContain(String(MAX_EXPANSIONS));
  });
});

describe("parseExpansions", () => {
  const QUERY = "юридические услуги";

  it("читает чистый JSON", () => {
    const raw = '{"synonyms":["юрист","правовое сопровождение","адвокат"]}';

    expect(parseExpansions(raw, QUERY)).toEqual(["юрист", "правовое сопровождение", "адвокат"]);
  });

  it("читает JSON в блоке кода: модели любят оборачивать ответ", () => {
    const raw = '```json\n{"synonyms":["юрист"]}\n```';

    expect(parseExpansions(raw, QUERY)).toEqual(["юрист"]);
  });

  it("читает JSON, окружённый пояснением", () => {
    const raw = 'Вот варианты: {"synonyms":["адвокат"]} Надеюсь, помогло.';

    expect(parseExpansions(raw, QUERY)).toEqual(["адвокат"]);
  });

  it("убирает повторы, пустое и сам запрос", () => {
    const raw = '{"synonyms":["юрист"," юрист ","","Юридические услуги","адвокат"]}';

    expect(parseExpansions(raw, QUERY)).toEqual(["юрист", "адвокат"]);
  });

  it("обрезает список по пределу", () => {
    const many = Array.from({ length: 30 }, (_, i) => `слово${String(i)}`);
    const out = parseExpansions(JSON.stringify({ synonyms: many }), QUERY);

    expect(out).toHaveLength(MAX_EXPANSIONS);
  });

  it("отбрасывает слишком длинное: это уже предложение, а не поисковая фраза", () => {
    const long = "а".repeat(90);

    expect(parseExpansions(JSON.stringify({ synonyms: [long, "юрист"] }), QUERY)).toEqual(["юрист"]);
  });

  it("не слова, а мусор в массиве не ломает разбор", () => {
    expect(parseExpansions('{"synonyms":[1,null,{"a":1},"юрист"]}', QUERY)).toEqual(["юрист"]);
  });

  it("не JSON — пустой список, а не исключение", () => {
    expect(parseExpansions("не могу помочь", QUERY)).toEqual([]);
  });

  it("JSON без нужного поля — пустой список", () => {
    expect(parseExpansions('{"other":["юрист"]}', QUERY)).toEqual([]);
  });
});

describe("buildRerankPrompt", () => {
  const candidates = [
    { id: "t1", subject: "Оказание комплекса юридических услуг", customer: "ПАО МОЭК" },
    { id: "t2", subject: "Оказание услуг связи юридическому лицу", customer: "ГБУ" },
  ];

  it("нумерует закупки, а не показывает модели внутренние идентификаторы", () => {
    const prompt = buildRerankPrompt({ query: "юридические услуги", candidates });

    expect(prompt).toContain("1.");
    expect(prompt).toContain("2.");
    expect(prompt).not.toContain("t1");
  });

  it("называет запрос и предупреждает об омонимах", () => {
    const prompt = buildRerankPrompt({ query: "юридические услуги", candidates });

    expect(prompt).toContain("юридические услуги");
    expect(prompt.toLowerCase()).toContain("омоним");
  });

  it("описание компании, если есть, попадает в запрос", () => {
    const prompt = buildRerankPrompt({
      query: "юридические услуги",
      companyNote: "Юридическая фирма: арбитраж, договоры",
      candidates,
    });

    expect(prompt).toContain("арбитраж");
  });

  it("тексты закупок названы данными, а не указаниями: их пишут посторонние", () => {
    const prompt = buildRerankPrompt({ query: "юридические услуги", candidates });

    expect(prompt.toLowerCase()).toContain("не указания");
  });

  it("ограничивает число закупок", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `t${String(i)}`, subject: `Закупка ${String(i)}` }));
    const prompt = buildRerankPrompt({ query: "q", candidates: many });

    expect(prompt).toContain(`${String(MAX_RERANK_ITEMS)}.`);
    expect(prompt).not.toContain(`${String(MAX_RERANK_ITEMS + 1)}.`);
  });

  it("длинное название обрезается: модели не нужны страницы", () => {
    const prompt = buildRerankPrompt({
      query: "q",
      candidates: [{ id: "t1", subject: "в".repeat(2000) }],
    });

    expect(prompt.length).toBeLessThan(2000);
  });
});

describe("parseRerank", () => {
  const candidates = [
    { id: "t1", subject: "комплекс юридических услуг" },
    { id: "t2", subject: "услуги связи юридическому лицу" },
    { id: "t3", subject: "консультирование" },
  ];

  it("сопоставляет ответ с закупками по номеру", () => {
    const raw = JSON.stringify({
      items: [
        { n: 1, fit: "yes", reason: "это юридические услуги" },
        { n: 2, fit: "no", reason: "юридическое лицо — не услуга юриста" },
      ],
    });

    expect(parseRerank(raw, candidates)).toEqual({
      t1: { fit: "yes", reason: "это юридические услуги" },
      t2: { fit: "no", reason: "юридическое лицо — не услуга юриста" },
    });
  });

  it("читает ответ в блоке кода", () => {
    const raw = '```json\n{"items":[{"n":3,"fit":"maybe","reason":"смежное"}]}\n```';

    expect(parseRerank(raw, candidates).t3?.fit).toBe("maybe");
  });

  it("номер вне списка игнорируется", () => {
    const raw = JSON.stringify({ items: [{ n: 9, fit: "yes", reason: "?" }, { n: 0, fit: "yes", reason: "?" }] });

    expect(parseRerank(raw, candidates)).toEqual({});
  });

  it("неизвестная оценка — «возможно», а не уверенное «да»", () => {
    const raw = JSON.stringify({ items: [{ n: 1, fit: "отлично", reason: "x" }] });

    expect(parseRerank(raw, candidates).t1?.fit).toBe("maybe");
  });

  it("причина обрезается и очищается от переносов", () => {
    const raw = JSON.stringify({ items: [{ n: 1, fit: "yes", reason: `длинная\nпричина ${"я".repeat(300)}` }] });
    const reason = parseRerank(raw, candidates).t1?.reason ?? "";

    expect(reason.length).toBeLessThanOrEqual(120);
    expect(reason).not.toContain("\n");
  });

  it("повтор номера: остаётся первый ответ", () => {
    const raw = JSON.stringify({
      items: [
        { n: 1, fit: "yes", reason: "первая" },
        { n: 1, fit: "no", reason: "вторая" },
      ],
    });

    expect(parseRerank(raw, candidates).t1?.reason).toBe("первая");
  });

  it("не JSON — пусто", () => {
    expect(parseRerank("извините", candidates)).toEqual({});
  });
});
