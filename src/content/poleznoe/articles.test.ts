import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ARTICLES } from "./index";
import { validateArticle } from "./validate";

/**
 * Страж реестра статей: пока он пуст, тест проходит; как только статьи
 * подключены, каждая проверяется целиком (длина описания, связи, таблицы,
 * вопросы, ссылки), а забытая регистрация файла-статьи ловится отдельно.
 */

const slugs = ARTICLES.map((a) => a.slug);

describe("реестр статей «Полезное»", () => {
  it("адреса статей уникальны", () => {
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it.each(ARTICLES.map((a) => [a.slug, a] as const))("статья %s проходит проверку", (_slug, article) => {
    expect(validateArticle(article, slugs)).toEqual([]);
  });

  it("каждый модуль-статья в каталоге подключён в реестр и назван по slug", () => {
    const dir = __dirname;
    const unregistered: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(join(dir, file), "utf8");
      // Модуль-статья экспортирует `article`; служебные файлы (types, validate…) — нет.
      if (!/^export const article\b/m.test(source)) continue;
      const slug = /slug:\s*["']([^"']+)["']/.exec(source)?.[1];
      if (!slug) {
        unregistered.push(`${file}: не найден slug`);
        continue;
      }
      if (file !== `${slug}.ts`) unregistered.push(`${file}: имя файла должно совпадать со slug «${slug}»`);
      if (!slugs.includes(slug)) unregistered.push(`${file}: статья «${slug}» не добавлена в ARTICLES (index.ts)`);
    }
    expect(unregistered).toEqual([]);
  });
});
