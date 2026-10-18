import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ArticleView } from "@/components/poleznoe/ArticleView";
import { ARTICLES, getArticle, relatedArticles } from "@/content/poleznoe";
import { articleUrl, OG_IMAGE_URL, SITE_NAME } from "@/content/poleznoe/jsonld";

/**
 * Страница статьи /poleznoe/[slug].
 *
 * Адреса известны на сборке (реестр статей), поэтому страницы статичны, а
 * любой другой адрес — честный 404 (`dynamicParams = false`), без рендера
 * «на лету». Для поисковика и ИИ-краулера это готовый HTML.
 */

export const dynamicParams = false;

interface Props {
  params: { slug: string };
}

export function generateStaticParams(): { slug: string }[] {
  return ARTICLES.map((article) => ({ slug: article.slug }));
}

export function generateMetadata({ params }: Props): Metadata {
  const article = getArticle(params.slug);
  if (!article) return {};
  const url = articleUrl(article.slug);
  // absolute: шаблон корневого layout дописал бы «— ТендерФит» второй раз.
  const title = `${article.title} — ${SITE_NAME}`;

  return {
    title: { absolute: title },
    description: article.description,
    keywords: article.keywords,
    authors: [{ name: SITE_NAME }],
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      url,
      title,
      description: article.description,
      siteName: SITE_NAME,
      locale: "ru_RU",
      publishedTime: article.published,
      modifiedTime: article.updated,
      images: [{ url: OG_IMAGE_URL, width: 1200, height: 630, alt: "ТендерФит — какие закупки ваши и почему" }],
    },
    twitter: { card: "summary_large_image", title, description: article.description, images: [OG_IMAGE_URL] },
  };
}

export default function ArticlePage({ params }: Props) {
  const article = getArticle(params.slug);
  if (!article) notFound();
  return <ArticleView article={article} related={relatedArticles(article)} />;
}
