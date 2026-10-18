import { CLUSTER_TITLES } from "./clusters";
import { inlineToPlain } from "./inline";
import type { Article, ArticleBlock } from "./types";

/**
 * Тексты статьи для служебных нужд: дата по-русски, время чтения, плоский текст.
 * Чистые функции без React: их зовут и страница, и llms-full.txt, и тесты.
 */

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
] as const;

/**
 * «2026-10-14» → «14 октября 2026».
 * Дата берётся из строки, а не через Date: часовой пояс сервера не должен
 * сдвигать день, а Intl с русской локалью зависит от сборки Node.
 */
export function formatDateRu(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const month = MONTHS_GENITIVE[Number(match[2]) - 1];
  if (!month) return iso;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/** Склейка всех строк блока: нужна и для подсчёта слов, и для плоского текста. */
function blockStrings(block: ArticleBlock): string[] {
  switch (block.type) {
    case "p":
    case "h2":
    case "h3":
      return [block.text];
    case "ul":
    case "ol":
      return block.items;
    case "table":
      return [...(block.caption ? [block.caption] : []), ...block.head, ...block.rows.flat()];
    case "note":
      return [...(block.title ? [block.title] : []), block.text];
    case "cta":
      return [];
  }
}

/** Слова основного текста: вступление, тело, вопросы. Врезка CTA не читается — не считается. */
export function countWords(article: Article): number {
  const strings = [
    article.lead,
    ...article.blocks.flatMap(blockStrings),
    ...article.faq.flatMap((f) => [f.q, f.a]),
  ];
  const text = strings.map((s) => inlineToPlain(s)).join(" ");
  return text.split(/\s+/).filter(Boolean).length;
}

/** Скорость чтения делового текста с таблицами — около 180 слов в минуту. */
export function readingMinutes(article: Article): number {
  return Math.max(1, Math.round(countWords(article) / 180));
}

/** Оглавление: разделы h2 в порядке следования. */
export function tocOf(article: Article): { id: string; text: string }[] {
  return article.blocks.flatMap((b) => (b.type === "h2" ? [{ id: b.id, text: b.text }] : []));
}

/**
 * Статья обычным текстом для llms-full.txt: заголовки, абзацы, списки, таблицы,
 * вопросы и источники. Ссылки сохраняют адрес, потому что у ИИ нет кликов.
 */
export function articleToPlainText(article: Article, siteUrl: string): string {
  const plain = (s: string): string => inlineToPlain(s, { withUrls: true, base: siteUrl });
  const out: string[] = [];

  out.push(`## ${article.h1}`);
  out.push(`Адрес: ${siteUrl}/poleznoe/${article.slug}`);
  out.push(`Рубрика: ${CLUSTER_TITLES[article.cluster]}. Обновлено: ${formatDateRu(article.updated)}.`);
  out.push(plain(article.lead));

  for (const block of article.blocks) {
    switch (block.type) {
      case "h2":
        out.push(`### ${block.text}`);
        break;
      case "h3":
        out.push(`#### ${block.text}`);
        break;
      case "p":
        out.push(plain(block.text));
        break;
      case "ul":
        out.push(block.items.map((item) => `- ${plain(item)}`).join("\n"));
        break;
      case "ol":
        out.push(block.items.map((item, i) => `${i + 1}. ${plain(item)}`).join("\n"));
        break;
      case "table": {
        const line = (cells: string[]): string => `| ${cells.map(plain).join(" | ")} |`;
        out.push(
          [
            ...(block.caption ? [plain(block.caption)] : []),
            line(block.head),
            line(block.head.map(() => "---")),
            ...block.rows.map(line),
          ].join("\n"),
        );
        break;
      }
      case "note":
        out.push(`${block.title ? `${block.title}: ` : "Важно: "}${plain(block.text)}`);
        break;
      case "cta":
        // Призыв к действию для ИИ — шум, а не знание.
        break;
    }
  }

  out.push("### Вопросы и ответы");
  for (const item of article.faq) out.push(`Вопрос: ${plain(item.q)}\nОтвет: ${plain(item.a)}`);

  out.push("### Нормативные акты и источники");
  out.push(article.sources.map((s) => `- ${s.title}${s.url ? ` — ${s.url}` : ""}`).join("\n"));

  return out.join("\n\n");
}
