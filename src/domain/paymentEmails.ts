import { appBaseUrl } from "@/domain/digest";
import { BORDER, FAINT, INK, MUTED, PAGE, button, escapeHtml, layout, type EmailMessage } from "@/domain/emailTemplates";
import { STATUS_LABEL, type PaymentInvoice } from "@/domain/payments";
import { planById } from "@/domain/plans";
import { OPERATOR } from "@/lib/legal";

/**
 * Письма об оплате: клиенту — «подписка включена», владельцу — «оплачено», «не удалось сопоставить
 * платёж», «заявка по QR ждёт подтверждения». Чистые функции, рамка и стили — общие с остальными письмами.
 */

/** Сумма в письме: обычные пробелы, чтобы тема и текст искались и копировались как есть. */
const rub = (value: number): string => `${value.toLocaleString("ru-RU", { maximumFractionDigits: 2 }).replace(/\s/g, "\u0020")} ₽`;
const planName = (id: string): string => planById(id)?.name ?? id;
/** «20 ноября 2026» — без «г.» и без времени: срок подписки считается сутками (по Москве). */
const DAY_FORMAT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" });
const day = (ms: number): string => {
  const parts = Object.fromEntries(DAY_FORMAT.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts["day"] ?? ""} ${parts["month"] ?? ""} ${parts["year"] ?? ""}`;
};

function rows(items: Array<[string, string]>): { text: string; html: string } {
  return {
    text: items.map(([k, v]) => `${k}: ${v}`).join("\n"),
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">${items
      .map(
        ([k, v]) =>
          `<tr><td style="padding:7px 0;border-top:1px solid ${BORDER};font-size:13px;color:${FAINT};width:38%;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:7px 0;border-top:1px solid ${BORDER};font-size:14px;color:${INK};">${escapeHtml(v)}</td></tr>`,
      )
      .join("")}</table>`,
  };
}

function invoiceRows(invoice: PaymentInvoice): Array<[string, string]> {
  const items: Array<[string, string]> = [
    ["Тариф", `«${planName(invoice.plan)}», ${String(invoice.months)} мес.`],
    ["Сумма", rub(invoice.amountRub)],
  ];
  if (invoice.invoiceNumber !== null) items.push(["Счёт", `№ ${invoice.invoiceNumber}`]);
  if (invoice.buyerName !== null) items.push(["Плательщик", invoice.buyerName]);
  if (invoice.buyerInn !== null) items.push(["ИНН", invoice.buyerInn]);
  items.push(["Аккаунт", invoice.userEmail]);
  return items;
}

/** Клиенту: оплата получена, подписка включена. */
export function buildPaidUserEmail(input: { invoice: PaymentInvoice; activatedUntilMs: number; baseUrl?: string }): EmailMessage {
  const base = input.baseUrl ?? appBaseUrl();
  const plan = planName(input.invoice.plan);
  const until = day(input.activatedUntilMs);
  const subject = `Оплата получена — подписка «${plan}» активна до ${until}`;
  const url = `${base}/billing`;
  const text = [
    "Здравствуйте!",
    "",
    `Оплата получена, подписка «${plan}» активна до ${until}.`,
    input.invoice.invoiceNumber !== null ? `Счёт № ${input.invoice.invoiceNumber} на ${rub(input.invoice.amountRub)} оплачен.` : `Сумма: ${rub(input.invoice.amountRub)}.`,
    "",
    "Все возможности тарифа уже доступны.",
    url,
    "",
    `Вопросы — ответом на это письмо или на ${OPERATOR.email}.`,
    "",
    `ТендерФит · ${OPERATOR.site}`,
  ].join("\n");
  const body = `<h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em;color:${INK};">Оплата получена</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${MUTED};">Подписка «${escapeHtml(plan)}» активна до <strong style="color:${INK};">${escapeHtml(until)}</strong>. Все возможности тарифа уже доступны.</p>
${rows(invoiceRows(input.invoice).filter(([k]) => k !== "Аккаунт")).html}
<p style="margin:0 0 20px;">${button(url, "Открыть ТендерФит")}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${FAINT};">Закрывающие документы придут отдельным письмом от банка. Вопросы — ответом на это письмо.</p>`;
  return { subject, text, html: layout({ preheader: `Подписка активна до ${until}`, title: subject, body }) };
}

/** Владельцу: пришла оплата и подписка включена. */
export function buildPaidAdminEmail(input: {
  invoice: PaymentInvoice;
  activatedUntilMs: number;
  /** Чем подтверждено: платёж банка, опрос статуса, ссылка владельца. */
  source: string;
}): EmailMessage {
  const who = input.invoice.buyerName ?? input.invoice.userEmail;
  const subject = `Оплачено: ${who} — ${rub(input.invoice.amountRub)}${input.invoice.invoiceNumber !== null ? `, счёт ${input.invoice.invoiceNumber}` : ""}`;
  const table = rows([
    ...invoiceRows(input.invoice),
    ["Подписка до", day(input.activatedUntilMs)],
    ["Подтверждено", input.source],
  ]);
  const text = [`Оплата получена, подписка включена.`, "", table.text].join("\n");
  const body = `<h1 style="margin:0 0 12px;font-size:18px;font-weight:600;color:${INK};">Оплата получена, подписка включена</h1>
${table.html}`;
  return { subject, text, html: layout({ preheader: subject, title: subject, body }) };
}

/** Владельцу: платёж банка не удалось сопоставить со счётом. */
export function buildUnmatchedAdminEmail(input: {
  reason: "unmatched" | "ambiguous" | "amount_mismatch" | "no_user" | "not_payable";
  amountRub: number;
  purpose: string;
  payerInn: string | null;
  payerName: string | null;
  kindLabel: string;
  ref: string;
  invoices?: PaymentInvoice[];
}): EmailMessage {
  const reasonText: Record<typeof input.reason, string> = {
    unmatched: "не нашлось ни счёта, ни заявки с такой суммой",
    ambiguous: "под платёж подходит несколько заявок на эту сумму, автоматически выбрать нельзя",
    amount_mismatch: "счёт найден по номеру в назначении, но сумма отличается (недоплата или переплата)",
    no_user: "счёт найден, но аккаунт пользователя не найден",
    not_payable: "счёт найден, но он уже закрыт или отменён",
  };
  const subject = `Платёж ${rub(input.amountRub)} не сопоставлен — подписка не включена`;
  const items: Array<[string, string]> = [
    ["Причина", reasonText[input.reason]],
    ["Сумма", rub(input.amountRub)],
    ["Способ", input.kindLabel],
    ["Назначение", input.purpose === "" ? "—" : input.purpose],
    ["Плательщик", [input.payerName, input.payerInn].filter((v): v is string => v !== null && v !== "").join(", ") || "—"],
    ["Номер операции", input.ref],
  ];
  for (const invoice of input.invoices ?? []) {
    items.push([`Кандидат ${invoice.invoiceNumber ?? invoice.id.slice(0, 8)}`, `${invoice.userEmail} · ${rub(invoice.amountRub)} · ${STATUS_LABEL[invoice.status]}`]);
  }
  const table = rows(items);
  const hint = "Если это оплата подписки — включите её вручную: npx tsx scripts/grant-access.ts --email … --days 30 --plan …";
  const text = ["Входящий платёж не удалось сопоставить автоматически.", "", table.text, "", hint].join("\n");
  const body = `<h1 style="margin:0 0 12px;font-size:18px;font-weight:600;color:${INK};">Платёж не сопоставлен</h1>
${table.html}
<p style="margin:0;font-size:13px;line-height:1.5;color:${MUTED};background:${PAGE};padding:10px 12px;border-radius:10px;">${escapeHtml(hint)}</p>`;
  return { subject, text, html: layout({ preheader: reasonText[input.reason], title: subject, body }) };
}

/** Владельцу: заявка «Я оплатил» по QR; кнопка подтверждает оплату после проверки в банке. */
export function buildClaimAdminEmail(input: { claim: PaymentInvoice; confirmUrl: string; expiresAtMs: number }): EmailMessage {
  const subject = `Заявка на оплату по QR: ${input.claim.userEmail} — ${rub(input.claim.amountRub)}`;
  const table = rows([
    ["Аккаунт", input.claim.userEmail],
    ["Тариф", `«${planName(input.claim.plan)}», ${String(input.claim.months)} мес.`],
    ["Сумма", rub(input.claim.amountRub)],
    ["Ссылка действует до", day(input.expiresAtMs)],
  ]);
  const text = [
    "Клиент нажал «Я оплатил» после оплаты по СБП-QR. Проверьте поступление в банке (сумма точно такая) и подтвердите:",
    "",
    table.text,
    "",
    `Подтвердить оплату: ${input.confirmUrl}`,
    "",
    "Ссылку нужно открыть, войдя под аккаунтом администратора; она одноразовая. Если деньги не пришли — ничего не делайте.",
  ].join("\n");
  const body = `<h1 style="margin:0 0 12px;font-size:18px;font-weight:600;color:${INK};">Заявка на оплату по QR</h1>
<p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:${MUTED};">Клиент нажал «Я оплатил». Проверьте поступление в банке — сумма должна быть точно такой, — и подтвердите.</p>
${table.html}
<p style="margin:0 0 16px;">${button(input.confirmUrl, "Подтвердить оплату")}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${FAINT};">Откройте ссылку под аккаунтом администратора; она одноразовая. Если деньги не пришли — ничего не делайте. Банк тоже сообщит о платеже по QR, и если сумма совпадёт, подписка включится сама.</p>`;
  return { subject, text, html: layout({ preheader: `${rub(input.claim.amountRub)} — ждёт подтверждения`, title: subject, body }) };
}

/** Владельцу: сбой на шаге после оплаты (акт, письмо клиенту); сама подписка уже включена. */
export function buildPaymentProblemAdminEmail(input: { invoice: PaymentInvoice; what: string; error: string }): EmailMessage {
  const subject = `Оплата прошла, но ${input.what} не удалось — ${input.invoice.invoiceNumber ?? input.invoice.userEmail}`;
  const table = rows([...invoiceRows(input.invoice), ["Ошибка", input.error.slice(0, 500)]]);
  const text = [`Подписка включена, но не удалось: ${input.what}.`, "", table.text].join("\n");
  const body = `<h1 style="margin:0 0 12px;font-size:18px;font-weight:600;color:${INK};">${escapeHtml(`Не удалось: ${input.what}`)}</h1>
<p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:${MUTED};">Подписка клиента уже включена, на неё сбой не влияет.</p>
${table.html}`;
  return { subject, text, html: layout({ preheader: input.error.slice(0, 120), title: subject, body }) };
}

/** Страница-ответ ссылки подтверждения (HTML целиком: это ответ ручки, а не письмо). */
export function confirmPageHtml(input: { title: string; message: string; baseUrl?: string }): string {
  const base = input.baseUrl ?? appBaseUrl();
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)}</title></head>
<body style="margin:0;background:${PAGE};font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${INK};">
<div style="max-width:480px;margin:12vh auto;padding:28px 24px;background:#fff;border:1px solid ${BORDER};border-radius:16px;">
<h1 style="margin:0 0 10px;font-size:20px;">${escapeHtml(input.title)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:${MUTED};">${escapeHtml(input.message)}</p>
<a href="${escapeHtml(base)}/billing" style="color:${INK};font-size:14px;">Перейти в приложение</a>
</div></body></html>`;
}
