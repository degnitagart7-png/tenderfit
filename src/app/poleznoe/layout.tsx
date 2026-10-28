import type { ReactNode } from "react";

import { PublicFooter } from "@/components/poleznoe/PublicFooter";
import { PublicHeader } from "@/components/poleznoe/PublicHeader";

import "@fontsource/onest/600.css";
import "@fontsource/onest/700.css";
import "@fontsource/onest/800.css";
import "./poleznoe.css";

/**
 * Каркас раздела «Полезное»: публичная шапка и подвал вместо оболочки кабинета.
 *
 * Страницы раздела открыты без входа (middleware.ts) и целиком рендерятся на
 * сервере: поисковик и ИИ-краулеры получают готовый HTML без JavaScript.
 * Onest — шрифт заголовков промо-страницы; отдаётся нашим же сервером, как
 * Inter в корневом layout (без запросов к Google). Без него срабатывает Inter.
 */
export default function PoleznoeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="pz">
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
