import type { MetadataRoute } from "next";
import { ARTICLES, lastUpdated } from "@/content/poleznoe";
import { LEGAL_PAGES } from "@/lib/legal";
import { SITE_URL } from "@/lib/site";

/**
 * В карту попадают только публичные страницы: главная, демо, раздел «Полезное» и
 * каждая его статья, вход и юридические документы. Дата изменения статьи — её
 * поле `updated`, а не момент запроса: по нему поисковик решает, перечитывать ли страницу.
 * Личный кабинет закрыт в robots.ts, и дублировать его здесь нельзя —
 * противоречивые указания поисковику хуже отсутствующей карты.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/demo`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    {
      url: `${SITE_URL}/poleznoe`,
      lastModified: new Date(lastUpdated() ?? now),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...ARTICLES.map((article) => ({
      url: `${SITE_URL}/poleznoe/${article.slug}`,
      lastModified: new Date(article.updated),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    { url: `${SITE_URL}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    ...LEGAL_PAGES.map((page) => ({
      url: `${SITE_URL}${page.href}`,
      lastModified: now,
      changeFrequency: "yearly" as const,
      priority: 0.5,
    })),
  ];
}
