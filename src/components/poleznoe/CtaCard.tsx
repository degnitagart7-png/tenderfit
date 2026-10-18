import Link from "next/link";

import { LogoMark } from "@/components/brand/LogoMark";

import { Inline } from "./Inline";

/** Текст по умолчанию: что делает сервис и что даёт попробовать бесплатно. */
export const DEFAULT_CTA_TEXT =
  "ТендерФит читает документацию закупки целиком, находит риски договора с цитатами и считает смету по форме 421/пр. Первые 7 дней бесплатно.";

/**
 * Карточка с предложением попробовать сервис: в тексте статьи (блок cta) и в
 * конце страницы. Две кнопки: основная ведёт на регистрацию, вторая — на демо
 * без регистрации для тех, кто не готов сразу.
 */
export function CtaCard({ text }: { text?: string }) {
  return (
    <aside className="pz-cta" aria-label="Попробовать ТендерФит">
      <LogoMark size={40} className="pz-cta-mark" />
      <div className="pz-cta-body">
        <p className="pz-cta-text">
          <Inline text={text ?? DEFAULT_CTA_TEXT} />
        </p>
        <div className="pz-cta-actions">
          <Link className="pz-btn pz-btn-primary" href="/login?mode=register">
            Попробовать бесплатно
          </Link>
          <Link className="pz-btn pz-btn-ghost" href="/demo">
            Посмотреть демо
          </Link>
        </div>
      </div>
    </aside>
  );
}
