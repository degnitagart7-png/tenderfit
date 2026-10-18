import Link from "next/link";

import { articleBreadcrumbJsonLd, articleJsonLd, faqJsonLd } from "@/content/poleznoe/jsonld";
import { CLUSTER_TITLES } from "@/content/poleznoe/clusters";
import { formatDateRu, readingMinutes, tocOf } from "@/content/poleznoe/text";
import type { Article } from "@/content/poleznoe/types";

import { ArticleBody } from "./ArticleBody";
import { CtaCard } from "./CtaCard";
import { Inline } from "./Inline";
import { JsonLd } from "./JsonLd";

/**
 * Страница статьи: хлебные крошки, заголовок, оглавление, текст, вопросы и
 * ответы, источники, связанные статьи, призыв.
 *
 * Вопросы и ответы показываются открытым текстом, а не в раскрывашках: текст
 * должен быть виден и в разметке FAQPage, и на странице, иначе поисковик
 * сочтёт разметку скрытым контентом.
 */
export function ArticleView({ article, related }: { article: Article; related: Article[] }) {
  const toc = tocOf(article);
  const minutes = readingMinutes(article);

  return (
    <article className="pz-wrap pz-article">
      <JsonLd data={articleJsonLd(article)} />
      <JsonLd data={faqJsonLd(article)} />
      <JsonLd data={articleBreadcrumbJsonLd(article)} />

      <nav aria-label="Хлебные крошки" className="pz-crumbs">
        <ol>
          <li>
            <Link href="/">Главная</Link>
          </li>
          <li>
            <Link href="/poleznoe">Полезное</Link>
          </li>
          <li aria-current="page">{article.title}</li>
        </ol>
      </nav>

      <header className="pz-head">
        <p className="pz-eyebrow">{CLUSTER_TITLES[article.cluster]}</p>
        <h1>{article.h1}</h1>
        <p className="pz-lead">
          <Inline text={article.lead} />
        </p>
        <p className="pz-meta">
          <span>
            Обновлено <time dateTime={article.updated}>{formatDateRu(article.updated)}</time>
          </span>
          <span aria-hidden="true">·</span>
          <span>~{minutes} мин чтения</span>
        </p>
      </header>

      {toc.length >= 2 && (
        <nav aria-label="Содержание" className="pz-toc">
          <p className="pz-toc-title">Содержание</p>
          <ol>
            {toc.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`}>{item.text}</a>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="pz-prose">
        <ArticleBody blocks={article.blocks} />

        <section aria-labelledby="pz-faq" className="pz-faq">
          <h2 id="pz-faq">Вопросы и ответы</h2>
          {article.faq.map((item, i) => (
            <div key={i} className="pz-faq-item">
              <h3>
                <Inline text={item.q} />
              </h3>
              <p>
                <Inline text={item.a} />
              </p>
            </div>
          ))}
        </section>

        <section aria-labelledby="pz-sources" className="pz-sources">
          <h2 id="pz-sources">Нормативные акты и источники</h2>
          <ul>
            {article.sources.map((source, i) => (
              <li key={i}>
                {source.url ? (
                  <a href={source.url} rel="noopener" target="_blank">
                    {source.title}
                  </a>
                ) : (
                  source.title
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {related.length > 0 && (
        <section aria-labelledby="pz-related" className="pz-related">
          <h2 id="pz-related">Читайте также</h2>
          <ul className="pz-cards">
            {related.map((item) => (
              <li key={item.slug}>
                <Link href={`/poleznoe/${item.slug}`} className="pz-card">
                  <span className="pz-card-eyebrow">{CLUSTER_TITLES[item.cluster]}</span>
                  <span className="pz-card-title">{item.h1}</span>
                  <span className="pz-card-text">{item.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <CtaCard />
    </article>
  );
}
