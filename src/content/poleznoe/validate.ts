import { CLUSTERS } from "./clusters";
import { inlineLeftovers, inlineLinks } from "./inline";
import type { Article, ArticleBlock } from "./types";

/**
 * Проверка статьи перед публикацией.
 *
 * Возвращает список проблем (пустой — статья годится). Правила взяты из того,
 * что реально ломает выдачу и ответы ИИ: слишком длинный заголовок обрезается,
 * описание вне 120–160 знаков заменяется поисковиком на случайный кусок
 * страницы, битая внутренняя ссылка уводит в 404, а ряд таблицы короче шапки
 * съезжает на экране. Тест articles.test.ts гоняет её по всему реестру.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/;
const SITE_HOST = /^https?:\/\/(?:www\.)?tender-fit\.ru(?:\/|$)/i;

/** Страницы приложения, на которые статьям можно ссылаться, кроме /poleznoe/<slug>. */
const KNOWN_APP_PATHS = new Set(["/", "/demo", "/login", "/login?mode=register", "/poleznoe"]);

export function validateArticle(article: Article, allSlugs: readonly string[]): string[] {
  const problems: string[] = [];
  const name = article.slug || "(без slug)";
  const fail = (message: string): void => {
    problems.push(`${name}: ${message}`);
  };

  // --- Адрес и заголовки ---
  if (!SLUG.test(article.slug)) fail(`slug «${article.slug}» должен быть латиницей, цифрами и дефисами`);
  if (!CLUSTERS.some((c) => c.id === article.cluster)) fail(`неизвестная рубрика «${String(article.cluster)}»`);
  if (article.title.trim() === "") fail("пустой title");
  else if (article.title.length > 65) fail(`title ${article.title.length} знаков, допустимо до 65`);
  if (article.h1.trim() === "") fail("пустой h1");
  const len = article.description.length;
  if (len < 120 || len > 160) fail(`description ${len} знаков, нужно 120–160`);

  const keywords = article.keywords.map((k) => k.trim()).filter(Boolean);
  if (keywords.length < 4) fail(`ключевых слов ${keywords.length}, нужно не меньше 4`);
  if (new Set(keywords.map((k) => k.toLowerCase())).size !== keywords.length) fail("ключевые слова повторяются");

  // --- Даты ---
  if (!ISO_DATE.test(article.published)) fail(`published «${article.published}» не ISO-дата`);
  if (!ISO_DATE.test(article.updated)) fail(`updated «${article.updated}» не ISO-дата`);
  else if (ISO_DATE.test(article.published) && article.updated < article.published) {
    fail("updated раньше published");
  }

  // --- Тело ---
  if (article.lead.trim() === "") fail("нет вступления (lead)");

  const h2s = article.blocks.filter((b): b is Extract<ArticleBlock, { type: "h2" }> => b.type === "h2");
  if (h2s.length < 4) fail(`разделов h2 ${h2s.length}, нужно не меньше 4`);
  const ids = h2s.map((h) => h.id);
  if (new Set(ids).size !== ids.length) fail("id разделов h2 повторяются");
  for (const h of h2s) {
    if (!SLUG.test(h.id)) fail(`id раздела «${h.id}» должен быть латиницей и дефисами`);
    if (h.text.trim() === "") fail(`пустой заголовок h2 «${h.id}»`);
  }

  for (const [i, block] of article.blocks.entries()) {
    const where = `блок ${i + 1} (${block.type})`;
    if (block.type === "table") {
      if (block.head.length === 0) fail(`${where}: нет заголовков колонок`);
      if (block.rows.length === 0) fail(`${where}: нет строк`);
      block.rows.forEach((row, r) => {
        if (row.length !== block.head.length) {
          fail(`${where}: в строке ${r + 1} ${row.length} ячеек при ${block.head.length} колонках`);
        }
      });
    }
    if ((block.type === "ul" || block.type === "ol") && block.items.length === 0) fail(`${where}: пустой список`);
    if (block.type === "p" && block.text.trim() === "") fail(`${where}: пустой абзац`);
  }

  // --- FAQ, связи, источники ---
  if (article.faq.length < 3 || article.faq.length > 5) fail(`вопросов ${article.faq.length}, нужно 3–5`);
  article.faq.forEach((item, i) => {
    if (item.q.trim() === "" || item.a.trim() === "") fail(`вопрос ${i + 1}: пустой вопрос или ответ`);
  });

  if (article.related.length < 2 || article.related.length > 4) {
    fail(`связанных статей ${article.related.length}, нужно 2–4`);
  }
  if (new Set(article.related).size !== article.related.length) fail("related повторяется");
  for (const slug of article.related) {
    if (slug === article.slug) fail("related ссылается на саму статью");
    else if (!allSlugs.includes(slug)) fail(`related: статьи «${slug}» нет`);
  }

  if (article.sources.length < 1) fail("нет источников");
  article.sources.forEach((s, i) => {
    if (s.title.trim() === "") fail(`источник ${i + 1}: пустое название`);
    if (s.url !== undefined && !/^https?:\/\//i.test(s.url)) fail(`источник ${i + 1}: адрес должен начинаться с http(s)://`);
  });

  // --- Строчная разметка ---
  /** Заголовки и описание — без разметки вовсе: они уходят в title, meta и оглавление как есть. */
  const plainOnly: [string, string][] = [
    ["title", article.title],
    ["h1", article.h1],
    ["description", article.description],
    ...h2s.map((h): [string, string] => [`h2 «${h.id}»`, h.text]),
    ...article.blocks.flatMap((b): [string, string][] => (b.type === "h3" ? [["h3", b.text]] : [])),
  ];
  for (const [label, text] of plainOnly) {
    if (/\*\*|\]\(|<\/?[a-z]/i.test(text)) fail(`${label}: разметка здесь не поддерживается`);
  }

  const marked: [string, string][] = [["lead", article.lead]];
  for (const [i, b] of article.blocks.entries()) {
    const label = `блок ${i + 1} (${b.type})`;
    if (b.type === "p") marked.push([label, b.text]);
    else if (b.type === "ul" || b.type === "ol") b.items.forEach((t, j) => marked.push([`${label}, пункт ${j + 1}`, t]));
    else if (b.type === "table") {
      if (b.caption) marked.push([`${label}, подпись`, b.caption]);
      b.head.forEach((t, j) => marked.push([`${label}, колонка ${j + 1}`, t]));
      b.rows.forEach((row, r) => row.forEach((t, c) => marked.push([`${label}, ячейка ${r + 1}.${c + 1}`, t])));
    } else if (b.type === "note") {
      if (b.title) marked.push([`${label}, заголовок`, b.title]);
      marked.push([label, b.text]);
    } else if (b.type === "cta" && b.text) marked.push([label, b.text]);
  }
  article.faq.forEach((f, i) => {
    marked.push([`вопрос ${i + 1}`, f.q], [`ответ ${i + 1}`, f.a]);
  });

  for (const [label, text] of marked) {
    const rest = inlineLeftovers(text);
    // Остатки разметки в тексте: незакрытый ** или ссылка с пробелом в адресе.
    if (rest.includes("**")) fail(`${label}: незакрытый ** (разрешены только **жирный** и [текст](ссылка))`);
    if (/\]\(/.test(rest)) fail(`${label}: ссылка записана неверно, адрес не должен содержать пробелов`);
    if (/<\/?[a-z][^>]*>/i.test(text)) fail(`${label}: HTML-теги не поддерживаются`);
    if (/`|^#{1,6}\s|^\s*[-*]\s/.test(text)) fail(`${label}: markdown-разметка кроме ** и [](...) не поддерживается`);

    for (const link of inlineLinks(text)) {
      checkLink(link.href, link.external, label);
    }
    // Схема, отличная от разрешённых, превращается в текст без ссылки — это ошибка автора.
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1] ?? "";
      if (!/^(?:\/(?!\/)|#|https?:\/\/|mailto:)/i.test(href)) fail(`${label}: недопустимый адрес ссылки «${href}»`);
    }
  }

  function checkLink(href: string, external: boolean, label: string): void {
    if (external) {
      if (SITE_HOST.test(href)) fail(`${label}: ссылка на свой сайт «${href}» должна быть относительной`);
      return;
    }
    if (href.startsWith("#")) {
      if (!ids.includes(href.slice(1))) fail(`${label}: якорь «${href}» не найден среди разделов h2`);
      return;
    }
    if (KNOWN_APP_PATHS.has(href)) return;
    const target = /^\/poleznoe\/([^/#?]+)(?:#.+)?$/.exec(href);
    if (target && allSlugs.includes(target[1] ?? "")) return;
    fail(`${label}: внутренняя ссылка «${href}» ведёт на несуществующую страницу`);
  }

  return problems;
}
