import { describe, expect, it } from "vitest";

import robots from "@/app/robots";
import { SITE_URL } from "@/lib/site";

/** Что открыто и что закрыто от поисковика: ошибка здесь прячет статьи или открывает кабинет. */
describe("robots", () => {
  const rule = robots().rules;
  const first = Array.isArray(rule) ? rule[0] : rule;
  const allow = [first?.allow ?? []].flat();
  const disallow = [first?.disallow ?? []].flat();

  it("раздел «Полезное» и файлы для ИИ открыты", () => {
    expect(allow).toEqual(expect.arrayContaining(["/poleznoe", "/llms.txt", "/llms-full.txt"]));
  });

  it("главная, демо, вход и юридические документы открыты", () => {
    expect(allow).toEqual(expect.arrayContaining(["/", "/demo", "/login", "/legal/"]));
  });

  it("кабинет и API закрыты, а статьи под закрытые префиксы не попадают", () => {
    expect(disallow).toEqual(expect.arrayContaining(["/dashboard", "/tenders", "/api/"]));
    expect(disallow.some((path) => "/poleznoe".startsWith(path) || path.startsWith("/poleznoe"))).toBe(false);
  });

  it("карта сайта указана с полным адресом", () => {
    expect(robots().sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });
});
