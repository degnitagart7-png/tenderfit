import type { ReactNode } from "react";

import { PublicFooter } from "@/components/poleznoe/PublicFooter";
import { PublicHeader } from "@/components/poleznoe/PublicHeader";

import "./poleznoe.css";

/**
 * Каркас раздела «Полезное»: публичная шапка и подвал вместо оболочки кабинета.
 *
 * Страницы раздела открыты без входа (middleware.ts) и целиком рендерятся на
 * сервере: поисковик и ИИ-краулеры получают готовый HTML без JavaScript.
 * Onest — шрифт заголовков промо-страницы; подключён ссылкой, как Inter в
 * корневом layout, чтобы сборка не зависела от сети. Без него срабатывает Inter.
 */
export default function PoleznoeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="pz">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Onest:wght@600;700;800&display=swap"
      />
      <a className="pz-skip" href="#pz-main">
        К содержимому
      </a>
      <PublicHeader />
      <main id="pz-main" className="pz-main">
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}
