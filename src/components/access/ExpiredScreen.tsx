import Link from "next/link";
import { ArrowRight, Check, LockKeyhole, Mail } from "lucide-react";

import { PLANS, formatPlanPrice } from "@/domain/plans";
import { OPERATOR } from "@/lib/legal";

/**
 * Экран вместо страницы, когда пробный период закончился.
 *
 * Тон не строгий: ничего не потеряно, данные на месте, нужно выбрать тариф. Показывает, что
 * человек получит после оплаты, и два действия — выбрать тариф (там же запрос
 * счёта, оплата идёт по счёту) и написать оператору. Закрыты закупки, смета и
 * сводки; оплата, кабинет и настройки открыты (см. isOpenWhenExpired).
 */

const BENEFITS = [
  "Поиск закупок под вашу компанию",
  "Глубокий анализ документации с рисками и стоп-факторами",
  "Расчёт и проверка сметы",
  "Отчёт с выводами в Word",
] as const;

const MAILTO = `mailto:${OPERATOR.email}?subject=${encodeURIComponent("ТендерФит: вопрос по доступу")}`;

export function ExpiredScreen({ email }: { email?: string | null }) {
  const start = PLANS[0];
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-8 text-center sm:py-14" data-testid="expired-screen">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-subtle text-accent-fg ring-8 ring-accent-subtle/50">
        <LockKeyhole className="h-6 w-6" strokeWidth={1.75} aria-hidden />
      </span>
      <h1 className="mt-6 text-[28px] font-semibold leading-tight tracking-tight text-foreground sm:text-[32px]">
        Пробный период закончился
      </h1>
      <p className="mt-3 max-w-[48ch] text-[15.5px] leading-relaxed text-muted-foreground">
        Ваши данные сохранены: профиль компании, настройки поиска и воронка никуда не делись.
        Выберите тариф, и доступ откроется после оплаты.
        {email ? (
          <>
            {" "}
            Аккаунт: <span className="whitespace-nowrap font-medium text-foreground">{email}</span>.
          </>
        ) : null}
      </p>

      <section aria-label="Что вы получите" className="card mt-8 w-full p-5 text-left sm:p-6">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-faint">После оплаты</h2>
        <ul className="mt-3 space-y-2.5">
          {BENEFITS.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-[15px] leading-snug text-foreground">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-olive" strokeWidth={2.5} aria-hidden />
              {item}
            </li>
          ))}
        </ul>
        {start ? (
          <p className="mt-4 border-t border-border pt-4 text-[14.5px] text-muted-foreground">
            Пакет «{start.name}» — <span className="num font-semibold text-foreground">{formatPlanPrice(start)}</span> в
            месяц. Оплата по счёту, онлайн-платежей нет.
          </p>
        ) : null}
      </section>

      <div className="mt-7 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
        <Link
          href="/billing"
          className="inline-flex items-center justify-center gap-2 rounded-full bg-accent-strong px-6 py-3 text-[15.5px] font-medium text-white shadow-[0_1px_2px_rgb(28_25_23_/_0.12)] transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent/35 focus:ring-offset-1"
        >
          Выбрать тариф
          <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
        </Link>
        <a
          href={MAILTO}
          className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-panel px-6 py-3 text-[15.5px] font-medium text-foreground transition-colors hover:border-border-strong hover:bg-panel-raised focus:outline-none focus:ring-2 focus:ring-accent/35 focus:ring-offset-1"
        >
          <Mail className="h-4 w-4 text-faint" strokeWidth={1.75} aria-hidden />
          Написать нам
        </a>
      </div>
      <p className="mt-5 text-[13.5px] text-faint">
        Профиль, настройки и{" "}
        <Link href="/account" className="underline underline-offset-2 hover:text-foreground">
          личный кабинет
        </Link>{" "}
        остаются доступны.
      </p>
    </div>
  );
}
