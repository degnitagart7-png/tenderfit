import Link from "next/link";
import { LEGAL_PAGES, OPERATOR } from "@/lib/legal";

/**
 * Подвал приложения: реквизиты владельца и ссылки на юридические документы.
 *
 * Показывается на каждой странице. Для B2B-сервиса реквизиты — первое, что
 * проверяет покупатель, а ссылка на политику обязана быть доступна с любого
 * экрана, где собираются данные.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-border px-4 py-6 lg:px-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 text-[14.5px] leading-relaxed text-muted-foreground">
          <p className="text-foreground">{OPERATOR.fullName}</p>
          <p className="mt-0.5">
            ИНН <span className="num">{OPERATOR.inn}</span> · ОГРНИП{" "}
            <span className="num">{OPERATOR.ogrnip}</span>
          </p>
          <p className="mt-0.5">
            <a
              href={`mailto:${OPERATOR.email}`}
              className="text-accent-fg hover:underline"
            >
              {OPERATOR.email}
            </a>
          </p>
        </div>

        <nav aria-label="Юридические документы">
          <ul className="flex flex-col gap-1 sm:items-end">
            {LEGAL_PAGES.map((p) => (
              <li key={p.href}>
                <Link
                  href={p.href}
                  className="inline-flex py-1 text-[14.5px] text-muted-foreground hover:text-foreground"
                >
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <p className="mt-5 max-w-3xl text-[13.5px] leading-relaxed text-faint">
        Сервис носит информационно-аналитический характер. Оценка отражает соответствие
        закупки профилю компании и не является вероятностью победы или гарантией допуска к
        закупке. Сведения о закупках получены из открытых источников.
      </p>
    </footer>
  );
}
