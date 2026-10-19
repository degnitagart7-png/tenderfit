"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { accountApiService } from "@/services/accountApiService";
import { OPERATOR } from "@/lib/legal";
import { cn } from "@/lib/cn";
import { effectiveAccess, formatTimeLeft, type AccessInfo } from "@/domain/access";
import { PLANS, formatFirstMonthPrice, formatPlanPrice, invoiceRequestHref, planById, type Plan } from "@/domain/plans";

/** Строка о текущем доступе над тарифами: пробный период, оплата или «закончился». */
function accessNote(access: AccessInfo | null): { text: string; tone: "info" | "warn" } | null {
  if (access === null || access.status === "admin") return null;
  const now = effectiveAccess(access, Date.now());
  if (now.status === "trial") {
    return { text: `Пробный период: осталось ${formatTimeLeft(now)}. Выберите пакет, чтобы не прерывать работу.`, tone: "info" };
  }
  if (now.status === "paid" && now.endsAt !== null) {
    const until = new Date(now.endsAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
    const plan = now.plan === null ? undefined : planById(now.plan);
    return { text: `Оплачено до ${until}${plan ? `, пакет «${plan.name}»` : ""}.`, tone: "info" };
  }
  return { text: "Пробный период закончился. Ваши данные сохранены: выберите пакет и запросите счёт.", tone: "warn" };
}

/**
 * Оплата и тарифы.
 *
 * Страница ведёт к одному действию: выбрать пакет и запросить счёт. Онлайн-приём
 * платежей не подключён, и об этом сказано прямо — кнопка «Оплатить картой»,
 * которая ничего не списывает, была бы хуже честной оплаты по счёту.
 */
export function BillingView() {
  const [selected, setSelected] = useState<Plan["id"]>("calc");
  const [email, setEmail] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessInfo | null>(null);

  useEffect(() => {
    // Почта вошедшего подставляется в письмо; гостю страница работает так же.
    void accountApiService
      .me()
      .then((me) => {
        setEmail(me.user?.email ?? null);
        setAccess(me.user?.access ?? null);
      })
      .catch(() => {
        setEmail(null);
        setAccess(null);
      });
  }, []);

  const note = accessNote(access);

  const plan = planById(selected) ?? PLANS[0]!;
  const priced = plan.priceRub !== null;
  const planFirstMonth = formatFirstMonthPrice(plan);

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <header>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-foreground">
          Оплата и тарифы
        </h1>
        <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-muted-foreground">
          Подписка на месяц. Выберите пакет — состав и стоимость ниже. Оплата по счёту: запросите его
          одним письмом, реквизиты компании допишете сами.
        </p>
      </header>

      {note && (
        <p
          role="status"
          data-testid="access-note"
          className={cn(
            "rounded-control border px-4 py-3 text-[14.5px] leading-snug",
            note.tone === "warn"
              ? "border-mustard-line bg-mustard-subtle text-mustard-fg"
              : "border-accent-line bg-accent-subtle text-accent-fg",
          )}
        >
          {note.text}
        </p>
      )}

      <div role="radiogroup" aria-label="Пакет подписки" className="grid gap-4 md:grid-cols-3">
        {PLANS.map((p) => {
          const active = p.id === selected;
          const firstMonth = formatFirstMonthPrice(p);
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`Пакет «${p.name}»${
                p.priceRub === null
                  ? ""
                  : firstMonth
                    ? `, первый месяц ${firstMonth}, далее ${formatPlanPrice(p)} в месяц`
                    : `, ${formatPlanPrice(p)} в месяц`
              }`}
              onClick={() => setSelected(p.id)}
              className={cn(
                "flex flex-col rounded-card border bg-panel p-6 text-left transition-colors",
                active ? "border-accent ring-1 ring-accent" : "border-border hover:border-border-strong",
              )}
            >
              <span className="text-[13px] font-semibold uppercase tracking-[0.08em] text-faint">{p.name}</span>
              <span className="mt-3 block text-[34px] font-semibold leading-none tracking-tight text-foreground">
                {p.priceRub === null ? (
                  "По запросу"
                ) : firstMonth ? (
                  <>
                    {firstMonth}
                    <span className="ml-1.5 text-[15px] font-medium text-muted-foreground">первый месяц</span>
                  </>
                ) : (
                  <>
                    {formatPlanPrice(p)}
                    <span className="ml-1.5 text-[15px] font-medium text-muted-foreground">в месяц</span>
                  </>
                )}
              </span>
              {firstMonth && p.priceRub !== null && (
                <span className="mt-1.5 block text-[14px] font-medium text-muted-foreground">
                  далее {formatPlanPrice(p)} в месяц
                </span>
              )}
              <span className="mt-3 block min-h-[3.2em] text-[14px] leading-snug text-muted-foreground">
                {p.tagline}
              </span>
              <ul className="mt-5 space-y-2.5 border-t border-border pt-5">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-[14.5px] leading-snug text-foreground">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-olive" strokeWidth={2.5} aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      <section aria-label="Ваш заказ" className="grid gap-8 md:grid-cols-[1.2fr_1fr]">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-foreground">Ваш заказ</h2>
          <dl className="mt-4 divide-y divide-border border-y border-border text-[15px]">
            <div className="flex justify-between py-3.5">
              <dt className="text-muted-foreground">Пакет</dt>
              <dd className="font-medium text-foreground">{plan.name}</dd>
            </div>
            <div className="flex justify-between py-3.5">
              <dt className="text-muted-foreground">Срок</dt>
              <dd className="font-medium text-foreground">{priced ? "1 месяц" : "по договорённости"}</dd>
            </div>
            <div className="flex justify-between py-3.5">
              <dt className="font-medium text-foreground">К оплате</dt>
              <dd className="text-[19px] font-semibold tabular-nums text-foreground" data-testid="total">
                {planFirstMonth ?? formatPlanPrice(plan)}
              </dd>
            </div>
            {planFirstMonth && (
              <div className="flex justify-between py-3.5">
                <dt className="text-muted-foreground">Со второго месяца</dt>
                <dd className="font-medium text-foreground" data-testid="then-price">
                  далее {formatPlanPrice(plan)} в месяц
                </dd>
              </div>
            )}
          </dl>

          <a
            href={invoiceRequestHref(plan, email)}
            className="mt-6 inline-flex items-center justify-center rounded-full bg-accent-strong px-6 py-3 text-[15px] font-medium text-white shadow-card transition-colors hover:bg-accent-hover"
          >
            {priced ? "Запросить счёт" : "Обсудить условия"}
          </a>
          <p className="mt-3 max-w-[56ch] text-[13px] leading-snug text-faint">
            Откроется письмо с готовой темой и составом заказа. Оплата картой онлайн пока не подключена —
            платёж проходит по счёту.
          </p>
        </div>

        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-foreground">Исполнитель</h2>
          <dl className="mt-4 space-y-3 text-[14.5px]">
            <div>
              <dt className="text-[12.5px] text-faint">Получатель</dt>
              <dd className="text-foreground">{OPERATOR.fullName}</dd>
            </div>
            <div className="flex gap-8">
              <div>
                <dt className="text-[12.5px] text-faint">ИНН</dt>
                <dd className="tabular-nums text-foreground">{OPERATOR.inn}</dd>
              </div>
              <div>
                <dt className="text-[12.5px] text-faint">ОГРНИП</dt>
                <dd className="tabular-nums text-foreground">{OPERATOR.ogrnip}</dd>
              </div>
            </div>
            <div>
              <dt className="text-[12.5px] text-faint">Почта для вопросов по оплате</dt>
              <dd className="text-foreground">{OPERATOR.email}</dd>
            </div>
          </dl>
          <p className="mt-4 text-[13px] leading-snug text-faint">
            Банковские реквизиты придут в счёте. Условия оказания услуг —{" "}
            <Link href="/legal/offer" className="text-accent-fg underline underline-offset-2">
              публичная оферта
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
