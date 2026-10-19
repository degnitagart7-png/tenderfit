"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui/primitives";
import { InvoiceRow } from "@/components/billing/MyInvoices";
import { AUTO_ACTIVATION_NOTE, formatRub } from "@/components/billing/paymentFormat";
import { parseBuyer, type PaymentInvoiceView } from "@/domain/payments";
import type { Plan } from "@/domain/plans";
import { paymentsApiService } from "@/services/paymentsApiService";

export interface InvoiceFormDefaults {
  inn: string;
  name: string;
  email: string;
}

/**
 * «Оплатить по счёту»: реквизиты покупателя → счёт в банке → PDF и письмо.
 *
 * Те же проверки, что на сервере (ИНН с контрольной суммой, КПП, почта), делает `parseBuyer`:
 * ошибка показывается у поля до обращения к банку. Выставленный счёт остаётся под формой с файлом
 * и кнопкой повторной отправки; его статус страница обновляет сама (см. BillingView).
 */
export function InvoiceForm({
  plan,
  defaults,
  created,
  onCreated,
}: {
  plan: Plan & { priceRub: number };
  defaults: InvoiceFormDefaults;
  /** Свежевыставленный счёт: он показывается под формой, пока человек на странице. */
  created: PaymentInvoiceView | null;
  onCreated: (invoice: PaymentInvoiceView, emailSent: boolean) => void;
}) {
  const [inn, setInn] = useState(defaults.inn);
  const [kpp, setKpp] = useState("");
  const [name, setName] = useState(defaults.name);
  const [email, setEmail] = useState(defaults.email);
  const [errors, setErrors] = useState<Partial<Record<"inn" | "kpp" | "name" | "email", string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailSent, setEmailSent] = useState<boolean | null>(null);

  // Реквизиты и почта аккаунта могут дойти уже после появления формы: пустые поля дозаполняются,
  // а то, что человек начал вводить сам, не трогается.
  useEffect(() => {
    setInn((value) => (value === "" ? defaults.inn : value));
    setName((value) => (value === "" ? defaults.name : value));
    setEmail((value) => (value === "" ? defaults.email : value));
  }, [defaults.inn, defaults.name, defaults.email]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setServerError(null);
    const parsed = parseBuyer({ inn, kpp, name, email });
    if (!parsed.ok) {
      setErrors({ [parsed.field]: parsed.error });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const result = await paymentsApiService.createInvoice({
        planId: plan.id,
        inn: parsed.buyer.inn,
        ...(parsed.buyer.kpp === null ? {} : { kpp: parsed.buyer.kpp }),
        name: parsed.buyer.name,
        email: parsed.buyer.email,
      });
      setEmailSent(result.emailSent);
      onCreated(result.invoice, result.emailSent);
    } catch (error) {
      setServerError(error instanceof Error ? error.message : "Не удалось выставить счёт");
    } finally {
      setBusy(false);
    }
  }

  const tenDigits = inn.replace(/\s/g, "").length === 10;

  return (
    <div>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4 sm:grid-cols-2" noValidate aria-label="Реквизиты для счёта">
        <Field label="ИНН" error={errors.inn} hint="10 цифр у организации, 12 у ИП">
          <Input value={inn} onChange={(e) => setInn(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={12} placeholder="7707083893" aria-label="ИНН" aria-invalid={errors.inn ? true : undefined} />
        </Field>
        <Field label="КПП" error={errors.kpp} hint={tenDigits ? "Необязательно" : "У ИП КПП нет"}>
          <Input value={kpp} onChange={(e) => setKpp(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="770701001" disabled={inn.replace(/\s/g, "").length === 12} aria-label="КПП" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Название организации или ФИО ИП" error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" maxLength={300} placeholder="ООО «Ромашка»" aria-label="Название организации" aria-invalid={errors.name ? true : undefined} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Почта для счёта" error={errors.email} hint="Банк пришлёт счёт в PDF на этот адрес">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="buh@romashka.ru" aria-label="Почта для счёта" aria-invalid={errors.email ? true : undefined} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" size="lg" loading={busy}>
            Выставить счёт на {formatRub(plan.priceRub)}
          </Button>
          {serverError && (
            <p role="alert" className="mt-3 text-[14px] text-brick-fg">
              {serverError}
            </p>
          )}
          <p className="mt-3 max-w-[60ch] text-[13px] leading-snug text-faint">
            Счёт «Без НДС» (исполнитель на УСН). {AUTO_ACTIVATION_NOTE}
          </p>
        </div>
      </form>

      {created && (
        <div role="status" data-testid="created-invoice" className="mt-6 rounded-card border border-accent-line bg-accent-subtle px-4 py-3">
          <p className="text-[14.5px] text-accent-fg">
            Счёт № {created.invoiceNumber} на {formatRub(created.amountRub)} выставлен
            {emailSent === true && created.buyerEmail ? ` и отправлен на ${created.buyerEmail}` : ""}.
            {emailSent === false ? " Письмо не ушло — скачайте счёт или отправьте его ещё раз." : ""}
          </p>
          <ul>
            <InvoiceRow invoice={created} />
          </ul>
        </div>
      )}
    </div>
  );
}
