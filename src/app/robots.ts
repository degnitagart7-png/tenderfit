import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Личный кабинет закрыт от индексации: выдача закупок собирается под профиль
 * конкретной компании и в поиске бессмысленна. Открыты вход и юридические
 * документы — именно их ищут снаружи.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/login", "/legal/"],
        disallow: [
          "/dashboard",
          "/tenders",
          "/pipeline",
          "/reports/",
          "/settings/",
          "/admin/",
          "/api/",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
