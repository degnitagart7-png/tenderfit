"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { SegButton } from "@/components/ui/primitives";
import { accountApiService } from "@/services/accountApiService";
import { paymentsApiService } from "@/services/paymentsApiService";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { InvoiceForm, type InvoiceFormDefaults } from "@/components/billing/InvoiceForm";
import { MyInvoices } from "@/components/billing/MyInvoices";
import { SbpPanel } from "@/components/billing/SbpPanel";
import { AUTO_ACTIVATION_NOTE, formatDay } from "@/components/billing/paymentFormat";
import { OPERATOR } from "@/lib/legal";
import { cn } from "@/lib/cn";
import { effectiveAccess, formatTimeLeft, type AccessInfo } from "@/domain/access";
import { isValidInn, payablePlan, type PaymentInvoiceView } from "@/domain/payments";
import { PLANS, formatPlanPrice, invoiceRequestHref, planById, type Plan } from "@/domain/plans";

/** Как часто страница спрашивает статус, пока есть ждущий счёт или заявка. */
export const INVOICE_POLL_MS = 20_000;

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

type PayMethod = "invoice" | "qr";

/**
 * Оплата и тарифы.
 *
 * Выбрать пакет и оплатить: по счёту с расчётного счёта (компании, ИП) или по статическому
 * СБП-QR (физлица, ИП). Счёт выставляет банк, подписка включается сама, как только он
 * подтвердит оплату; страница обновляет статус раз в 20 секунд, пока есть ждущий счёт. Если
 * выставление счетов на сервере не настроено, остаётся запрос счёта письмом. Карточной
 * оплаты нет, и страница этого не обещает.
 */
export function BillingView() {
  const [selected, setSelected] = useState<Plan["id"]>("calc");
  const [email, setEmail] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [method, setMethod] = useState<PayMethod>("invoice");
  const [invoices, setInvoices] = useState<PaymentInvoiceView[]>([]);
  /** null — список ещё грузится или не загрузился; false — банк на сервере не настроен. */
  const [billingReady, setBillingReady] = useState<boolean | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [created, setCreated] = useState<PaymentInvoiceView | null>(null);
  const [paidNotice, setPaidNotice] = useState<string | null>(null);
  const known = useRef<Map<string, string>>(new Map());

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

  const refresh = useCallback(async () => {
    try {
      const list = await paymentsApiService.list();
      setInvoices(list.invoices);
      setBillingReady(list.billingReady);
      setListLoaded(true);
      // Счёт перешёл из «ждёт» в «оплачен»: подписка уже включена, обновляем срок и говорим об этом.
      const justPaid = list.invoices.find((i) => i.status === "paid" && known.current.get(i.id) === "issued");
      known.current = new Map(list.invoices.map((i) => [i.id, i.status]));
      if (justPaid) {
        setPaidNotice(
          justPaid.activatedUntil
            ? `Оплата получена — подписка «${planById(justPaid.plan)?.name ?? justPaid.plan}» активна до ${formatDay(justPaid.activatedUntil)}.`
            : "Оплата получена — подписка активна.",
        );
        setCreated(null);
        void accountApiService
          .me()
          .then((me) => setAccess(me.user?.access ?? null))
          .catch(() => undefined);
      }
    } catch {
      // Нет сети или ручка недоступна: страница остаётся с запросом счёта письмом.
      setListLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasOpen = invoices.some((i) => i.status === "issued");
  useEffect(() => {
    if (!hasOpen) return;
    const timer = setInterval(() => void refresh(), INVOICE_POLL_MS);
    return () => clearInterval(timer);
  }, [hasOpen, refresh]);

  /** Реквизиты для формы: прошлый счёт важнее анкеты компании (там может быть другое юрлицо). */
  const defaults = useMemo<InvoiceFormDefaults>(() => {
    const last = invoices.find((i) => i.method === "invoice" && i.buyerInn);
    if (last) return { inn: last.buyerInn ?? "", name: last.buyerName ?? "", email: last.buyerEmail ?? email ?? "" };
    const profile = typeof window === "undefined" ? null : companyProfileRepository.get();
    const inn = profile && isValidInn(profile.inn.replace(/\s/g, "")) ? profile.inn.replace(/\s/g, "") : "";
    return { inn, name: inn ? (profile?.legalName ?? "") : "", email: email ?? "" };
    // Реквизиты читаются один раз, когда форма появляется: правка поля потом не должна сбрасываться.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listLoaded, email]);

  const note = accessNote(access);

  const plan = planById(selected) ?? PLANS[0]!;
  const priced = plan.priceRub !== null;
  const payable = payablePlan(plan.id);
  // Свежий счёт показывается над формой с живым статусом, а в «Мои счета» не дублируется.
  const liveCreated = created === null ? null : (invoices.find((i) => i.id === created.id) ?? created);
  const openClaim = invoices.find((i) => i.method === "sbp_claim" && i.status === "issued" && i.plan === plan.id) ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <header>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-foreground">
          Оплата и тарифы
        </h1>
        <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-muted-foreground">
          Подписка на месяц. Выберите пакет — состав и стоимость ниже. Компании и ИП оплачивают по счёту
          с расчётного счёта, физлица и ИП — по QR-коду через СБП. {AUTO_ACTIVATION_NOTE}
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

      {paidNotice && (
        <p
          role="status"
          data-testid="paid-notice"
          className="rounded-control border border-olive-line bg-olive-subtle px-4 py-3 text-[14.5px] leading-snug text-olive-fg"
        >
          {paidNotice}
        </p>
      )}

      <div role="radiogroup" aria-label="Пакет подписки" className="grid gap-4 md:grid-cols-3">
        {PLANS.map((p) => {
          const active = p.id === selected;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`Пакет «${p.name}»${p.priceRub === null ? "" : `, ${formatPlanPrice(p)} в месяц`}`}
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
                ) : (
                  <>
                    {formatPlanPrice(p)}
                    <span className="ml-1.5 text-[15px] font-medium text-muted-foreground">в месяц</span>
                  </>
                )}
              </span>
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
                {formatPlanPrice(plan)}
              </dd>
            </div>
          </dl>

          {payable && (
            <div className="mt-6" data-testid="pay-block">
              <div role="tablist" aria-label="Способ оплаты" className="flex flex-wrap gap-2">
                <SegButton role="tab" aria-selected={method === "invoice"} active={method === "invoice"} onClick={() => setMethod("invoice")}>
                  Оплатить по счёту
                </SegButton>
                <SegButton role="tab" aria-selected={method === "qr"} active={method === "qr"} onClick={() => setMethod("qr")}>
                  Оплатить по QR (СБП)
                </SegButton>
              </div>
              <div role="tabpanel" className="mt-5">
                {method === "invoice" ? (
                  billingReady === true ? (
                    <InvoiceForm plan={payable} defaults={defaults} created={liveCreated} onCreated={(invoice) => { setCreated(invoice); void refresh(); }} />
                  ) : billingReady === false || listLoaded ? (
                    <>
                      <a
                        href={invoiceRequestHref(plan, email)}
                        className="inline-flex items-center justify-center rounded-full bg-accent-strong px-6 py-3 text-[15px] font-medium text-white shadow-card transition-colors hover:bg-accent-hover"
                      >
                        Запросить счёт
                      </a>
                      <p className="mt-3 max-w-[56ch] text-[13px] leading-snug text-faint">
                        Выставление счетов на сайте сейчас недоступно: откроется письмо с готовой темой и составом заказа,
                        реквизиты допишете сами.
                      </p>
                    </>
                  ) : (
                    <p className="text-[14px] text-faint">Загружаем…</p>
                  )
                ) : (
                  <SbpPanel
                    plan={payable}
                    pending={openClaim}
                    onClaimed={(claim, confirmed) => {
                      void refresh();
                      if (!confirmed) setInvoices((list) => (list.some((i) => i.id === claim.id) ? list : [claim, ...list]));
                    }}
                  />
                )}
              </div>
            </div>
          )}

          {!priced && (
            <>
              <a
                href={invoiceRequestHref(plan, email)}
                className="mt-6 inline-flex items-center justify-center rounded-full bg-accent-strong px-6 py-3 text-[15px] font-medium text-white shadow-card transition-colors hover:bg-accent-hover"
              >
                Обсудить условия
              </a>
              <p className="mt-3 max-w-[56ch] text-[13px] leading-snug text-faint">
                Откроется письмо с готовой темой. У пакета нет фиксированной цены: условия согласуем по почте.
              </p>
            </>
          )}
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

      <MyInvoices invoices={liveCreated === null ? invoices : invoices.filter((i) => i.id !== liveCreated.id)} />
    </div>
  );
}
