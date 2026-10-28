import type { Metadata } from "next";
import { Agentation } from "agentation";
import { SITE_URL } from "@/lib/site";
/*
  Шрифты отдаёт наш же сервер, а не Google: вся инфраструктура в России, а запрос
  к Google Fonts из браузера посетителя то не отвечает, то блокируется, и
  страница ждала бы шрифт впустую. Подключены файлы целиком по весам («400.css», а не
  «cyrillic-400.css»): только в них есть unicode-range, и браузер скачивает нужную часть —
  кириллицу, латиницу или знак ₽ из latin-ext, — а не всё сразу. Inter — UI и заголовки, JetBrains Mono — данные.
  Если файл не загрузился, срабатывают фолбэки из tailwind.config.ts.
*/
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "ТендерФит — объяснимый анализ закупок 44-ФЗ и 223-ФЗ",
    // Страницы задают свой заголовок и получают приписку автоматически:
    // раньше половина разделов сидела на общем заголовке главной.
    template: "%s — ТендерФит",
  },
  description:
    "Сервис поиска и анализа закупок по 44-ФЗ и 223-ФЗ: вердикт «участвовать, проверить или отказаться» с доказательствами из документации закупки.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "ru_RU",
    siteName: "ТендерФит",
    title: "ТендерФит — объяснимый анализ закупок 44-ФЗ и 223-ФЗ",
    description:
      "Какие закупки ваши — и почему. Оценка по профилю компании с указанием источника каждого вывода.",
    url: "/",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    /* Фон не задаётся инлайном: globals.css красит html и body из
       rgb(var(--background)). Инлайновое значение здесь уже расходилось с
       токеном на два пункта, и разница была видна при overscroll-подтяжке. */
    <html lang="ru">
      <body>
        {children}
        {/* Панель пометок для разработки: клик по элементу на странице даёт
            селектор и заметку, которые уходят ИИ-помощнику через MCP-сервер (.mcp.json, порт 4747).
            Только в `next dev` — на боевой сайт не попадает. */}
        {process.env.NODE_ENV === "development" && (
          <Agentation endpoint="http://localhost:4747" />
        )}
      </body>
    </html>
  );
}
