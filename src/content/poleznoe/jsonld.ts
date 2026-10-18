import { SITE_URL } from "@/lib/site";

import { CLUSTER_TITLES } from "./clusters";
import { inlineToPlain } from "./inline";
import type { Article } from "./types";

/**
 * Микроразметка schema.org для страниц раздела «Полезное».
 *
 * Зачем. Article даёт поисковику дату правки и издателя, FAQPage — готовые
 * ответы для расширенной выдачи и для ИИ-ассистентов, BreadcrumbList — путь
 * вместо адреса в сниппете. Все данные берутся из тех же полей статьи, что и
 * видимый текст страницы: разметка, не совпадающая с текстом, считается
 * нарушением правил поисковиков.
 */

export const SITE_NAME = "ТендерФит";

/** Картинка превью ссылки сайта (src/app/opengraph-image.tsx) — общая для всех страниц. */
export const OG_IMAGE_URL = `${SITE_URL}/opengraph-image`;

/** Логотип издателя: PNG 180×180 из src/app/apple-icon.tsx (SVG-иконку Google как логотип не принимает). */
const LOGO_URL = `${SITE_URL}/apple-icon`;

type Json = Record<string, unknown>;

const organization = (): Json => ({
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  logo: { "@type": "ImageObject", url: LOGO_URL, width: 180, height: 180 },
});

export const articleUrl = (slug: string): string => `${SITE_URL}/poleznoe/${slug}`;

export function articleJsonLd(article: Article): Json {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    // Google обрезает заголовок Article на 110 знаках.
    headline: article.h1.length > 110 ? `${article.h1.slice(0, 107)}…` : article.h1,
    description: article.description,
    datePublished: article.published,
    dateModified: article.updated,
    author: organization(),
    publisher: organization(),
    mainEntityOfPage: { "@type": "WebPage", "@id": articleUrl(article.slug) },
    url: articleUrl(article.slug),
    image: [OG_IMAGE_URL],
    articleSection: CLUSTER_TITLES[article.cluster],
    inLanguage: "ru-RU",
    keywords: article.keywords.join(", "),
  };
}

export function faqJsonLd(article: Article): Json {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: article.faq.map((item) => ({
      "@type": "Question",
      name: inlineToPlain(item.q),
      acceptedAnswer: { "@type": "Answer", text: inlineToPlain(item.a) },
    })),
  };
}

export function breadcrumbJsonLd(trail: { name: string; url: string }[]): Json {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function articleBreadcrumbJsonLd(article: Article): Json {
  return breadcrumbJsonLd([
    { name: "Главная", url: `${SITE_URL}/` },
    { name: "Полезное", url: `${SITE_URL}/poleznoe` },
    { name: article.title, url: articleUrl(article.slug) },
  ]);
}

export function indexJsonLd(articles: readonly Article[], description: string): Json {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Полезное для участников госзакупок",
    description,
    url: `${SITE_URL}/poleznoe`,
    inLanguage: "ru-RU",
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: articles.length,
      itemListElement: articles.map((a, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: articleUrl(a.slug),
        name: a.h1,
      })),
    },
  };
}

/**
 * JSON для тега <script>: символы «<», «>», «&» и разделители строк JS
 * экранируются, чтобы текст статьи не мог закрыть тег или сломать разбор.
 */
export function jsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}
