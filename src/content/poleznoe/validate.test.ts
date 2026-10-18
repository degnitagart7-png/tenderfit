import { describe, expect, it } from "vitest";

import { makeArticle } from "@/test/poleznoeFixture";

import { validateArticle } from "./validate";
import type { Article } from "./types";

const SLUGS = ["glavnaya-statya", "vtoraya-statya", "tretya-statya"];
const good = (over: Partial<Article> = {}): Article =>
  makeArticle("glavnaya-statya", { related: ["vtoraya-statya", "tretya-statya"], ...over });
const problems = (over: Partial<Article> = {}): string[] => validateArticle(good(over), SLUGS);
const has = (list: string[], part: string): boolean => list.some((p) => p.includes(part));

describe("validateArticle", () => {
  it("образцовая статья проходит без замечаний", () => {
    expect(problems()).toEqual([]);
  });

  it("slug: только латиница, цифры и дефисы", () => {
    expect(has(validateArticle(good({ slug: "Bad_Slug" }), [...SLUGS, "Bad_Slug"]), "slug")).toBe(true);
    expect(has(validateArticle(good({ slug: "срок" }), SLUGS), "slug")).toBe(true);
  });

  it("title не длиннее 65 знаков, description 120–160", () => {
    expect(has(problems({ title: "а".repeat(66) }), "title 66")).toBe(true);
    expect(has(problems({ description: "коротко" }), "description 7")).toBe(true);
    expect(has(problems({ description: "а".repeat(161) }), "description 161")).toBe(true);
    expect(problems({ description: "а".repeat(120) })).toEqual([]);
    expect(problems({ description: "а".repeat(160) })).toEqual([]);
  });

  it("ключевых слов не меньше четырёх", () => {
    expect(has(problems({ keywords: ["раз", "два", "три"] }), "ключевых слов 3")).toBe(true);
  });

  it("нужны вступление и не меньше четырёх разделов h2", () => {
    expect(has(problems({ lead: "  " }), "lead")).toBe(true);
    const blocks = good().blocks.filter((b) => !(b.type === "h2" && b.id === "chetvertyi-razdel"));
    expect(has(problems({ blocks }), "разделов h2 3")).toBe(true);
  });

  it("id разделов уникальны и латинские", () => {
    const dup = good().blocks.map((b) => (b.type === "h2" && b.id === "vtoroi-razdel" ? { ...b, id: "pervyi-razdel" } : b));
    expect(has(problems({ blocks: dup }), "повторяются")).toBe(true);
    const ru = good().blocks.map((b) => (b.type === "h2" && b.id === "vtoroi-razdel" ? { ...b, id: "раздел" } : b));
    expect(has(problems({ blocks: ru }), "латиницей")).toBe(true);
  });

  it("строка таблицы должна совпадать с шапкой по длине", () => {
    const blocks = [
      ...good().blocks,
      { type: "table" as const, head: ["А", "Б"], rows: [["1", "2"], ["только одна"]] },
    ];
    expect(has(problems({ blocks }), "в строке 2 1 ячеек при 2 колонках")).toBe(true);
  });

  it("вопросов 3–5", () => {
    expect(has(problems({ faq: good().faq.slice(0, 2) }), "вопросов 2")).toBe(true);
    const six = Array.from({ length: 6 }, (_, i) => ({ q: `Вопрос ${i}?`, a: "Ответ." }));
    expect(has(problems({ faq: six }), "вопросов 6")).toBe(true);
  });

  it("related: 2–4, существуют, не сама статья", () => {
    expect(has(problems({ related: ["vtoraya-statya"] }), "связанных статей 1")).toBe(true);
    expect(has(problems({ related: ["vtoraya-statya", "net-takoi"] }), "«net-takoi» нет")).toBe(true);
    expect(has(problems({ related: ["vtoraya-statya", "glavnaya-statya"] }), "саму статью")).toBe(true);
    expect(has(problems({ related: ["a-1", "a-2", "a-3", "a-4", "a-5"] }), "связанных статей 5")).toBe(true);
  });

  it("нужен хотя бы один источник; адрес источника — http(s)", () => {
    expect(has(problems({ sources: [] }), "нет источников")).toBe(true);
    expect(has(problems({ sources: [{ title: "Закон", url: "consultant.ru" }] }), "http(s)")).toBe(true);
  });

  it("строчная разметка: незакрытый ** и HTML ловятся", () => {
    const bad = (text: string) => problems({ blocks: [...good().blocks, { type: "p", text }] });
    expect(has(bad("текст с **незакрытым"), "незакрытый **")).toBe(true);
    expect(has(bad("текст <b>тег</b>"), "HTML")).toBe(true);
    expect(has(bad("[ссылка](/poleznoe/vtoraya-statya плохая)"), "ссылка записана неверно")).toBe(true);
    expect(has(bad("[x](javascript:alert(1))"), "недопустимый адрес")).toBe(true);
  });

  it("в заголовках и описании разметка недопустима", () => {
    expect(has(problems({ title: "Про **срок**" }), "title")).toBe(true);
    expect(has(problems({ description: `${"а".repeat(130)} [x](/demo)` }), "description")).toBe(true);
  });

  it("внутренние ссылки: на существующие статьи и известные страницы приложения", () => {
    const withLinks = (text: string) => problems({ blocks: [...good().blocks, { type: "p", text }] });
    expect(withLinks("[a](/poleznoe/vtoraya-statya) [b](/) [c](/demo) [d](/login) [e](/login?mode=register) [f](/poleznoe)")).toEqual([]);
    expect(has(withLinks("[a](/poleznoe/net-takoi)"), "несуществующую страницу")).toBe(true);
    expect(has(withLinks("[a](/tenders)"), "несуществующую страницу")).toBe(true);
    expect(has(withLinks("[a](#pervyi-razdel)"), "якорь")).toBe(false);
    expect(has(withLinks("[a](#net-takogo)"), "якорь")).toBe(true);
  });

  it("абсолютная ссылка на свой сайт должна быть относительной", () => {
    const list = problems({ blocks: [...good().blocks, { type: "p", text: "[a](https://tender-fit.ru/demo)" }] });
    expect(has(list, "должна быть относительной")).toBe(true);
  });

  it("даты: ISO, updated не раньше published", () => {
    expect(has(problems({ published: "14.10.2026" }), "published")).toBe(true);
    expect(has(problems({ published: "2026-10-12", updated: "2026-10-01" }), "updated раньше")).toBe(true);
  });

  it("замечания начинаются со slug статьи", () => {
    const list = problems({ lead: "" });
    expect(list.every((p) => p.startsWith("glavnaya-statya: "))).toBe(true);
  });
});
