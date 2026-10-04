import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";
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
      "Не список закупок, а решение: участвовать или нет. Вердикт по профилю компании с указанием источника каждого вывода.",
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
      <head>
        {/*
          Шрифты подключаются ссылкой, а не next/font, чтобы сборка не падала
          без сети; в офлайне срабатывают фолбэки из tailwind.config.ts.
          Inter — UI и заголовки, JetBrains Mono — данные.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
