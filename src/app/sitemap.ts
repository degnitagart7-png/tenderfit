import type { MetadataRoute } from "next";
import { LEGAL_PAGES } from "@/lib/legal";
import { SITE_URL } from "@/lib/site";

/**
 * В карту попадают только публичные страницы: вход и юридические документы.
 * Личный кабинет закрыт в robots.ts, и дублировать его здесь нельзя —
 * противоречивые указания поисковику хуже отсутствующей карты.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE_URL}/login`, lastModified: now, changeFrequency: "monthly", priority: 1 },
    ...LEGAL_PAGES.map((page) => ({
      url: `${SITE_URL}${page.href}`,
      lastModified: now,
      changeFrequency: "yearly" as const,
      priority: 0.5,
    })),
  ];
}
