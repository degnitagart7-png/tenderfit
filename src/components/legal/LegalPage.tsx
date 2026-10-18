import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { LEGAL_PAGES, LEGAL_VERSION_DATE, OPERATOR } from "@/lib/legal";
import { LogoMark } from "@/components/brand/LogoMark";

/**
 * Обёртка юридического документа.
 *
 * Документы открыты без авторизации и живут вне (app): требовать вход, чтобы
 * прочитать политику обработки данных, — прямое противоречие смыслу документа.
 * Внизу — переходы между остальными документами, чтобы из любого из них были
 * доступны все четыре.
 */
export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-panel">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-4">
          <Link href="/dashboard" className="flex items-center gap-2.5" aria-label="На главную">
            <LogoMark size={32} />
            <span className="text-[16px] font-semibold tracking-tight text-foreground">
              {OPERATOR.serviceName}
            </span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-10">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 py-1 text-[15.5px] text-accent-fg hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Вернуться в сервис
        </Link>

        <h1 className="mt-5 text-[26px] font-semibold leading-tight tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-2 text-[14.5px] text-muted-foreground">
          Редакция от {LEGAL_VERSION_DATE}
        </p>
        {intro && (
          <p className="mt-4 text-[16px] leading-relaxed text-muted-foreground">{intro}</p>
        )}

        <article className="legal-prose mt-8">{children}</article>

        <nav
          aria-label="Другие документы"
          className="mt-12 border-t border-border pt-6"
        >
          <p className="text-[14.5px] font-medium text-foreground">Другие документы</p>
          <ul className="mt-3 flex flex-col gap-2">
            {LEGAL_PAGES.filter((p) => p.label !== title).map((p) => (
              <li key={p.href}>
                <Link
                  href={p.href}
                  className="inline-flex py-1 text-[15.5px] text-accent-fg hover:underline"
                >
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[14.5px] text-muted-foreground">
            {OPERATOR.fullName} · ИНН {OPERATOR.inn} · ОГРНИП {OPERATOR.ogrnip}
          </p>
        </nav>
      </main>
    </div>
  );
}
