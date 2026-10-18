import { articlesByCluster, ARTICLES } from "@/content/poleznoe";
import { articleUrl } from "@/content/poleznoe/jsonld";
import { articleToPlainText } from "@/content/poleznoe/text";
import { SITE_URL } from "@/lib/site";

/**
 * Тексты для ИИ-ассистентов по соглашению llms.txt (llmstxt.org).
 *
 * llms.txt — короткий указатель: что за сервис и где лежат разборы, с одной
 * строкой описания на страницу. llms-full.txt — те же статьи целиком обычным
 * текстом, чтобы модель могла прочитать их без разбора HTML. Оба файла
 * строятся из реестра статей, и вручную их вести не нужно.
 */

export const SERVICE_SUMMARY =
  "ТендерФит — сервис для подрядчиков, участвующих в госзакупках по 44-ФЗ и 223-ФЗ. Он читает документацию закупки целиком, говорит, стоит ли участвовать, находит риски проекта договора с цитатами и номерами пунктов, считает смету по форме 421/пр (нормы ФСНБ-2022, цены ФГИС ЦС) и показывает, до какой цены можно снижаться. Первые 7 дней бесплатно, без карты.";

/** Одна строка описания: без переводов строк, иначе список в Markdown развалится. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export function buildLlmsTxt(): string {
  const lines: string[] = ["# ТендерФит", "", `> ${SERVICE_SUMMARY}`, ""];

  for (const group of articlesByCluster()) {
    lines.push(`## ${group.title}`, "");
    for (const article of group.articles) {
      lines.push(`- [${article.h1}](${articleUrl(article.slug)}): ${oneLine(article.description)}`);
    }
    lines.push("");
  }

  lines.push(
    "## О сервисе",
    "",
    `- [Главная страница](${SITE_URL}/): возможности, тарифы и ответы на частые вопросы.`,
    `- [Демо-лента закупок](${SITE_URL}/demo): лента на вымышленных данных, без регистрации.`,
    `- [Все статьи раздела «Полезное»](${SITE_URL}/poleznoe): оглавление по рубрикам.`,
    "",
    "## Optional",
    "",
    `- [Полные тексты статей](${SITE_URL}/llms-full.txt): все статьи одним файлом, обычным текстом.`,
    "",
  );
  return lines.join("\n");
}

export function buildLlmsFullTxt(): string {
  const parts: string[] = [
    "# ТендерФит",
    `> ${SERVICE_SUMMARY}`,
    `Раздел «Полезное»: ${ARTICLES.length} ${plural(ARTICLES.length)}. Каталог: ${SITE_URL}/poleznoe`,
  ];
  for (const group of articlesByCluster()) {
    parts.push(`# ${group.title}`);
    for (const article of group.articles) parts.push(articleToPlainText(article, SITE_URL));
  }
  return `${parts.join("\n\n")}\n`;
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "статья";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "статьи";
  return "статей";
}

/** Сутки: содержимое меняется только с выкладкой, но ИИ-краулеры не должны долбить сервер. */
export const LLMS_CACHE_SECONDS = 86400;

export function textResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${LLMS_CACHE_SECONDS}, s-maxage=${LLMS_CACHE_SECONDS}`,
    },
  });
}
