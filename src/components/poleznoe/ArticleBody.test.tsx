import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { inlineToPlain, parseInline } from "@/content/poleznoe/inline";
import type { ArticleBlock } from "@/content/poleznoe/types";

import { ArticleBody } from "./ArticleBody";
import { Inline } from "./Inline";

afterEach(cleanup);

/** Строчная разметка: жирный и ссылки, остальное — текст. */
describe("Inline", () => {
  it("**жирный** становится <strong>", () => {
    const { container } = render(<Inline text="до **важного** срока" />);
    expect(container.querySelector("strong")?.textContent).toBe("важного");
    expect(container.textContent).toBe("до важного срока");
  });

  it("внутренняя ссылка — без target, внешняя — в новой вкладке с noopener", () => {
    render(<Inline text="см. [статью](/poleznoe/a) и [закон](https://example.org/x)" />);
    const internal = screen.getByRole("link", { name: "статью" });
    expect(internal.getAttribute("href")).toBe("/poleznoe/a");
    expect(internal.getAttribute("target")).toBeNull();
    const external = screen.getByRole("link", { name: "закон" });
    expect(external.getAttribute("href")).toBe("https://example.org/x");
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noopener");
  });

  it("HTML в тексте экранируется и не становится разметкой", () => {
    const { container } = render(<Inline text={'a <script>alert(1)</script> <b>b</b> & "q"'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe('a <script>alert(1)</script> <b>b</b> & "q"');
  });

  it("небезопасный адрес ссылки (javascript:) не создаёт ссылку, остаётся подпись", () => {
    const { container } = render(<Inline text="[нажми](javascript:alert(1))" />);
    expect(container.querySelector("a")).toBeNull();
    const { container: c2 } = render(<Inline text="[нажми](//evil.example/x) и [почта](data:text/html,x)" />);
    expect(c2.querySelector("a")).toBeNull();
  });

  it("жирный внутри ссылки и ссылка внутри жирного разбираются", () => {
    const { container } = render(<Inline text="[**срок** оплаты](/poleznoe/a) и **см. [закон](https://e.org)**" />);
    expect(container.querySelector("a[href='/poleznoe/a'] strong")?.textContent).toBe("срок");
    expect(container.querySelector("strong a[href='https://e.org']")).not.toBeNull();
  });

  it("незакрытые конструкции остаются буквальным текстом", () => {
    const { container } = render(<Inline text="**без закрытия и [ссылка]( без адреса" />);
    expect(container.textContent).toBe("**без закрытия и [ссылка]( без адреса");
    expect(container.querySelector("strong, a")).toBeNull();
  });
});

describe("inlineToPlain / parseInline", () => {
  it("плоский текст без разметки; с withUrls ссылки получают абсолютный адрес", () => {
    expect(inlineToPlain("**а** [б](/x) в")).toBe("а б в");
    expect(inlineToPlain("[б](/x) [в](https://e.org)", { withUrls: true, base: "https://tender-fit.ru" })).toBe(
      "б (https://tender-fit.ru/x) в (https://e.org)",
    );
  });

  it("якорные ссылки считаются внутренними", () => {
    expect(parseInline("[к разделу](#razdel)")[0]).toMatchObject({ kind: "link", external: false });
  });
});

describe("ArticleBody", () => {
  const blocks: ArticleBlock[] = [
    { type: "h2", id: "razdel-odin", text: "Раздел один" },
    { type: "p", text: "Абзац с **жирным**." },
    { type: "h3", text: "Подраздел" },
    { type: "ul", items: ["пункт а", "пункт б"] },
    { type: "ol", items: ["шаг 1", "шаг 2"] },
    { type: "table", caption: "Сроки оплаты", head: ["Этап", "Срок"], rows: [["Приёмка", "5 дней"], ["Оплата", "7 дней"]] },
    { type: "note", title: "Важно", text: "Норма закона." },
    { type: "cta" },
    { type: "cta", text: "Своя фраза призыва." },
  ];

  it("каждый тип блока выводится своим элементом", () => {
    const { container } = render(<ArticleBody blocks={blocks} />);
    expect(screen.getByRole("heading", { level: 2, name: "Раздел один" }).id).toBe("razdel-odin");
    expect(screen.getByRole("heading", { level: 3, name: "Подраздел" })).toBeTruthy();
    expect(container.querySelector("p strong")?.textContent).toBe("жирным");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(screen.getByRole("note").textContent).toContain("Норма закона.");
    expect(screen.getByRole("note").textContent).toContain("Важно");
  });

  it("таблица лежит в прокручиваемом контейнере с подписью и шапкой", () => {
    const { container } = render(<ArticleBody blocks={blocks} />);
    const wrap = container.querySelector(".pz-table-wrap");
    expect(wrap).not.toBeNull();
    expect(wrap?.getAttribute("tabindex")).toBe("0");
    expect(wrap?.getAttribute("aria-label")).toBe("Сроки оплаты");
    expect(wrap?.querySelector("table")).not.toBeNull();
    expect(wrap?.querySelector("caption")?.textContent).toBe("Сроки оплаты");
    const headers = within(wrap as HTMLElement).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["Этап", "Срок"]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("cta: текст по умолчанию и кнопки на регистрацию и демо", () => {
    render(<ArticleBody blocks={[{ type: "cta" }]} />);
    expect(screen.getByText(/читает документацию закупки целиком/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Попробовать бесплатно" }).getAttribute("href")).toBe("/login?mode=register");
    expect(screen.getByRole("link", { name: "Посмотреть демо" }).getAttribute("href")).toBe("/demo");
  });

  it("cta со своим текстом заменяет стандартный", () => {
    render(<ArticleBody blocks={[{ type: "cta", text: "Своя фраза призыва." }]} />);
    expect(screen.getByText("Своя фраза призыва.")).toBeTruthy();
    expect(screen.queryByText(/читает документацию закупки целиком/)).toBeNull();
  });
});
