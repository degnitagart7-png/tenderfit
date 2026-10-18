import type { Article } from "@/content/poleznoe/types";

/**
 * Образцовая статья для тестов раздела «Полезное»: проходит validateArticle,
 * содержит блок каждого типа. Тесты ломают отдельные поля через overrides.
 */
export function makeArticle(slug: string, overrides: Partial<Article> = {}): Article {
  return {
    slug,
    cluster: "documents",
    title: `Тестовая статья ${slug}`,
    h1: `Тестовая статья ${slug}: что важно знать подрядчику`,
    description:
      "Проверочное описание статьи для тестов: оно намеренно длиннее ста двадцати знаков, но короче ста шестидесяти, как требует проверка.",
    keywords: ["тестовая статья", "госзакупки", "44-фз", "подрядчик"],
    published: "2026-10-01",
    updated: "2026-10-12",
    lead: "Коротко: **ответ** на главный вопрос статьи. Подробности — в разделах ниже.",
    blocks: [
      { type: "h2", id: "pervyi-razdel", text: "Первый раздел" },
      { type: "p", text: "Абзац с [внутренней ссылкой](/poleznoe/vtoraya-statya) и [внешней](https://www.consultant.ru/)." },
      { type: "ul", items: ["Первый пункт", "Второй **важный** пункт"] },
      { type: "h2", id: "vtoroi-razdel", text: "Второй раздел" },
      { type: "h3", text: "Подраздел" },
      { type: "ol", items: ["Шаг один", "Шаг два"] },
      { type: "table", caption: "Сроки", head: ["Этап", "Срок"], rows: [["Подача", "7 дней"], ["Оплата", "7 рабочих дней"]] },
      { type: "h2", id: "tretii-razdel", text: "Третий раздел" },
      { type: "note", title: "Важно", text: "Норма закона: срок считается в **рабочих** днях." },
      { type: "cta" },
      { type: "h2", id: "chetvertyi-razdel", text: "Четвёртый раздел" },
      { type: "p", text: "Заключительный абзац, [попробовать сервис](/login?mode=register)." },
    ],
    faq: [
      { q: "Первый вопрос?", a: "Первый ответ." },
      { q: "Второй вопрос?", a: "Второй ответ со ссылкой на [демо](/demo)." },
      { q: "Третий вопрос?", a: "Третий ответ." },
    ],
    related: ["vtoraya-statya", "tretya-statya"],
    sources: [
      { title: "Федеральный закон № 44-ФЗ", url: "https://www.consultant.ru/document/cons_doc_LAW_144624/" },
      { title: "Постановление без ссылки" },
    ],
    ...overrides,
  };
}

/** Три связанные статьи: главная и две, на которые она ссылается. */
export function makeFixtureSet(): Article[] {
  return [
    makeArticle("glavnaya-statya", { related: ["vtoraya-statya", "tretya-statya"] }),
    makeArticle("vtoraya-statya", { cluster: "estimate", updated: "2026-10-05", related: ["glavnaya-statya", "tretya-statya"] }),
    makeArticle("tretya-statya", { cluster: "search", related: ["glavnaya-statya", "vtoraya-statya"] }),
  ];
}
