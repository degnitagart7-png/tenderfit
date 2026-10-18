import { describe, expect, it, vi } from "vitest";

vi.mock("@/content/poleznoe", async () => {
  const { createRegistry } = await import("@/content/poleznoe/registry");
  const { makeFixtureSet } = await import("@/test/poleznoeFixture");
  const fixtures = makeFixtureSet();
  return { ARTICLES: fixtures, ...createRegistry(fixtures) };
});

import { GET as getLlms } from "@/app/llms.txt/route";
import { GET as getLlmsFull } from "@/app/llms-full.txt/route";
import { SITE_URL } from "@/lib/site";

describe("llms.txt", () => {
  it("заголовок, краткое описание и ссылки по рубрикам с абсолютными адресами", async () => {
    const response = getLlms();
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("cache-control")).toContain("max-age=86400");
    const text = await response.text();
    expect(text.startsWith("# ТендерФит\n")).toBe(true);
    expect(text).toMatch(/\n> ТендерФит — сервис/);
    expect(text).toContain("## Поиск и выбор закупок");
    expect(text).toContain("## Документация и риски");
    expect(text).toMatch(new RegExp(`- \\[[^\\]]+\\]\\(${SITE_URL}/poleznoe/glavnaya-statya\\): Проверочное описание`));
    expect(text).toContain(`${SITE_URL}/llms-full.txt`);
  });
});

describe("llms-full.txt", () => {
  it("полные тексты: разделы, абзацы, списки, таблица, вопросы и источники без разметки", async () => {
    const response = getLlmsFull();
    expect(response.headers.get("cache-control")).toContain("max-age=86400");
    const text = await response.text();
    expect(text).toContain("## Тестовая статья glavnaya-statya: что важно знать подрядчику");
    expect(text).toContain(`Адрес: ${SITE_URL}/poleznoe/glavnaya-statya`);
    expect(text).toContain("### Первый раздел");
    expect(text).toContain("- Второй важный пункт");
    expect(text).toContain("1. Шаг один");
    expect(text).toContain("| Этап | Срок |");
    expect(text).toContain("Вопрос: Первый вопрос?\nОтвет: Первый ответ.");
    expect(text).toContain("### Нормативные акты и источники");
    // Разметка снята, адреса внутренних ссылок абсолютные.
    expect(text).not.toContain("**");
    expect(text).toContain(`внутренней ссылкой (${SITE_URL}/poleznoe/vtoraya-statya)`);
    // Призыв к действию в тексты для ИИ не попадает.
    expect(text).not.toContain("Попробовать бесплатно");
  });
});
