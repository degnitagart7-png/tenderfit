"use client";

import { useState } from "react";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/primitives";
import { AUTO_ACTIVATION_NOTE, formatRub } from "@/components/billing/paymentFormat";
import type { PaymentInvoiceView } from "@/domain/payments";
import type { Plan } from "@/domain/plans";
import { paymentsApiService } from "@/services/paymentsApiService";

/** Статический СБП-QR владельца (ИП Цыретаров С. А., Точка): плательщик вводит сумму сам. */
export const SBP_QR_LINK = "https://qr.nspk.ru/AS1A002LRS3K859M9S7OSH4UTKRFIFSC?type=01&bank=100000000284&crc=27F8";
export const SBP_QR_IMAGE = "/payment/sbp-qr.png";

/**
 * «Оплатить по QR (СБП)»: для физлиц и ИП, платящих со своего счёта.
 *
 * QR статический, сумма в нём не зашита, поэтому она названа крупно. После оплаты человек нажимает
 * «Я оплатил»: заявка уходит владельцу, и подписка включается, когда банк подтвердит платёж на эту
 * сумму или владелец подтвердит заявку. До подтверждения доступ не открывается.
 */
export function SbpPanel({
  plan,
  pending,
  onClaimed,
}: {
  plan: Plan & { priceRub: number };
  /** Открытая заявка на этот тариф, если человек уже нажимал. */
  pending: PaymentInvoiceView | null;
  onClaimed: (claim: PaymentInvoiceView, confirmed: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const result = await paymentsApiService.claimSbp(plan.id);
      onClaimed(result.claim, result.confirmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить заявку");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 sm:grid-cols-[auto_1fr]">
      <div className="mx-auto w-[220px] shrink-0 rounded-card border border-border bg-white p-3 sm:mx-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={SBP_QR_IMAGE} alt="QR-код СБП для оплаты подписки" width={196} height={196} className="h-auto w-full" />
      </div>
      <div>
        <ol className="space-y-2 text-[14.5px] leading-snug text-foreground">
          <li>1. Откройте приложение банка и отсканируйте QR-код (на телефоне — кнопка ниже).</li>
          <li>
            2. Введите сумму ровно{" "}
            <strong className="text-[17px] tabular-nums" data-testid="sbp-amount">
              {formatRub(plan.priceRub)}
            </strong>
            .
          </li>
          <li>3. После перевода нажмите «Я оплатил».</li>
        </ol>
        <a
          href={SBP_QR_LINK}
          className="mt-4 inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[14.5px] text-foreground hover:border-border-strong md:hidden"
        >
          <Smartphone className="h-4 w-4" aria-hidden /> Открыть в приложении банка
        </a>
        <div className="mt-5">
          {pending ? (
            <p role="status" data-testid="sbp-pending" className="rounded-control border border-mustard-line bg-mustard-subtle px-4 py-3 text-[14.5px] leading-snug text-mustard-fg">
              Заявка отправлена. Как только платёж будет подтверждён, подписка включится сама — страница обновится.
            </p>
          ) : (
            <Button size="lg" loading={busy} onClick={() => void claim()}>
              Я оплатил
            </Button>
          )}
          {error && (
            <p role="alert" className="mt-3 text-[14px] text-brick-fg">
              {error}
            </p>
          )}
          <p className="mt-3 max-w-[60ch] text-[13px] leading-snug text-faint">
            {AUTO_ACTIVATION_NOTE} Оплата по QR — для физлиц и ИП; организациям удобнее счёт.
          </p>
        </div>
      </div>
    </div>
  );
}
