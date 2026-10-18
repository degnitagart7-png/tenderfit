import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Главная (промо), раздел «Полезное», вход и юридические документы открыты поисковику.
 * Личный кабинет закрыт от индексации: выдача закупок собирается под профиль
 * конкретной компании и в поиске бессмысленна. Открыты вход и юридические
 * документы — именно их ищут снаружи.
 *
 * «Полезное» (/poleznoe) — статьи, ради которых сайт ищут и цитируют ИИ-ассистенты;
 * там же llms.txt и llms-full.txt для них. Отдельных правил для ИИ-краулеров
 * (GPTBot, YandexGPT и др.) нет намеренно: общее правило `*` их пускает, а закрывать
 * публичные статьи от цитирования незачем.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/demo", "/poleznoe", "/llms.txt", "/llms-full.txt", "/login", "/legal/"],
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
