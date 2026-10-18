import Link from "next/link";

import { LEGAL_PAGES, OPERATOR } from "@/lib/legal";

/** Подвал публичных страниц: реквизиты оператора и юридические документы, как на промо-странице. */
export function PublicFooter() {
  return (
    <footer className="pz-footer">
      <div className="pz-footer-in">
        <p>
          {OPERATOR.shortName} · ИНН {OPERATOR.inn} · ОГРНИП {OPERATOR.ogrnip}
        </p>
        <nav aria-label="Ссылки подвала" className="pz-footer-links">
          <Link href="/poleznoe">Полезное</Link>
          <Link href="/login">Войти</Link>
          {LEGAL_PAGES.filter((p) => p.href !== "/legal/requisites").map((p) => (
            <Link key={p.href} href={p.href}>
              {p.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
