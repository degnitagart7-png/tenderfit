import type { Metadata } from "next";
import Link from "next/link";

import { JsonLd } from "@/components/poleznoe/JsonLd";
import { ARTICLES, articlesByCluster } from "@/content/poleznoe";
import { breadcrumbJsonLd, indexJsonLd, OG_IMAGE_URL, SITE_NAME } from "@/content/poleznoe/jsonld";
import { formatDateRu } from "@/content/poleznoe/text";
import { SITE_URL } from "@/lib/site";

/**
 * Оглавление раздела «Полезное»: статьи по рубрикам.
 *
 * Страница статична: список меняется только вместе с кодом (реестр статей),
 * поэтому она собирается один раз и отдаётся готовым HTML.
 */

const TITLE = "Полезное для участников госзакупок";
const DESCRIPTION =
  "Практические разборы по 44-ФЗ и 223-ФЗ: как искать закупки, читать документацию и договор, проверять смету заказчика, считать цену и участвовать без штрафов.";

export const metadata: Metadata = {
  title: { absolute: `${TITLE} — ${SITE_NAME}` },
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/poleznoe` },
  openGraph: {
    type: "website",
    url: `${SITE_URL}/poleznoe`,
    title: `${TITLE} — ${SITE_NAME}`,
    description: DESCRIPTION,
    siteName: SITE_NAME,
    locale: "ru_RU",
    images: [{ url: OG_IMAGE_URL, width: 1200, height: 630, alt: "ТендерФит — какие закупки ваши и почему" }],
  },
  twitter: { card: "summary_large_image", title: `${TITLE} — ${SITE_NAME}`, description: DESCRIPTION, images: [OG_IMAGE_URL] },
};

export default function PoleznoeIndexPage() {
  const groups = articlesByCluster();

  return (
    <div className="pz-wrap pz-wrap-wide">
      <JsonLd data={indexJsonLd(ARTICLES, DESCRIPTION)} />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Главная", url: `${SITE_URL}/` },
          { name: "Полезное", url: `${SITE_URL}/poleznoe` },
        ])}
      />

      <nav aria-label="Хлебные крошки" className="pz-crumbs">
        <ol>
          <li>
            <Link href="/">Главная</Link>
          </li>
          <li aria-current="page">Полезное</li>
        </ol>
      </nav>

      <header className="pz-head">
        <h1>Полезное для подрядчика</h1>
        <p className="pz-lead">
          Разборы для тех, кто участвует в закупках по 44-ФЗ и 223-ФЗ: что написано в документации и договоре,
          как проверить смету заказчика и посчитать свою цену, какие сроки и штрафы грозят на участии и
          исполнении. Каждая статья опирается на нормы закона, со ссылками на источники.
        </p>
      </header>

      {groups.length === 0 && <p className="pz-empty">Статьи скоро появятся.</p>}

      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`pz-cluster-${group.id}`} className="pz-cluster">
          <h2 id={`pz-cluster-${group.id}`}>{group.title}</h2>
          <p className="pz-cluster-text">{group.description}</p>
          <ul className="pz-cards pz-cards-list">
            {group.articles.map((article) => (
              <li key={article.slug}>
                <Link href={`/poleznoe/${article.slug}`} className="pz-card">
                  <span className="pz-card-title">{article.h1}</span>
                  <span className="pz-card-text">{article.description}</span>
                  <span className="pz-card-meta">Обновлено {formatDateRu(article.updated)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
