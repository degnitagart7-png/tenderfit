import { planById, type Plan } from "@/domain/plans";

/**
 * Оплата подписки: счета и заявки по QR. Чистые правила без базы, сети и часов.
 *
 * Деньги и ИНН проверяются здесь, а не в ручках: ту же проверку делает форма на
 * экране, и расхождение «форма пропустила, сервер отказал» выглядело бы как сбой банка.
 */

/* ------------------------------------ Типы ------------------------------------ */

export type PaymentStatus = "issued" | "paid" | "cancelled" | "expired";
/** invoice — счёт в Точке; sbp_claim — «Я оплатил» по статическому QR. */
export type PaymentMethod = "invoice" | "sbp_claim";

export interface PaymentInvoice {
  id: string;
  userEmail: string;
  plan: string;
  amountRub: number;
  months: number;
  status: PaymentStatus;
  method: PaymentMethod;
  buyerInn: string | null;
  buyerKpp: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  invoiceNumber: string | null;
  tochkaDocumentId: string | null;
  tochkaPaymentRef: string | null;
  paidAt: number | null;
  activatedUntil: number | null;
  closingDocumentId: string | null;
  closingSentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Что видит клиент: без идентификаторов банка и ссылки на платёж. */
export interface PaymentInvoiceView {
  id: string;
  plan: string;
  amountRub: number;
  months: number;
  status: PaymentStatus;
  method: PaymentMethod;
  invoiceNumber: string | null;
  buyerName: string | null;
  buyerInn: string | null;
  buyerEmail: string | null;
  createdAt: string;
  paidAt: string | null;
  activatedUntil: string | null;
  /** PDF можно скачать: счёт выставлен в банке. */
  hasPdf: boolean;
}

export function toInvoiceView(invoice: PaymentInvoice): PaymentInvoiceView {
  return {
    id: invoice.id,
    plan: invoice.plan,
    amountRub: invoice.amountRub,
    months: invoice.months,
    status: invoice.status,
    method: invoice.method,
    invoiceNumber: invoice.invoiceNumber,
    buyerName: invoice.buyerName,
    buyerInn: invoice.buyerInn,
    buyerEmail: invoice.buyerEmail,
    createdAt: new Date(invoice.createdAt).toISOString(),
    paidAt: invoice.paidAt === null ? null : new Date(invoice.paidAt).toISOString(),
    activatedUntil: invoice.activatedUntil === null ? null : new Date(invoice.activatedUntil).toISOString(),
    hasPdf: invoice.method === "invoice" && invoice.tochkaDocumentId !== null,
  };
}

/* ------------------------------------ Сроки ------------------------------------ */

const DAY_MS = 24 * 3_600_000;

/** Счёт ждёт оплату столько дней, потом считается просроченным (решение владельца). */
export const INVOICE_TTL_DAYS = 45;
export const INVOICE_TTL_MS = INVOICE_TTL_DAYS * DAY_MS;
/** Заявка «Я оплатил» живёт дольше недели: человек мог отложить письмо владельцу. */
export const CLAIM_TTL_DAYS = 14;
export const CLAIM_TTL_MS = CLAIM_TTL_DAYS * DAY_MS;
/** Платёж по QR, пришедший до заявки, ждёт её столько часов. */
export const EARLY_SBP_WINDOW_MS = 24 * 3_600_000;
/** Сколько открытых счетов может быть у одного человека: защита банковского документооборота от мусора. */
export const MAX_OPEN_INVOICES_PER_USER = 10;

/* ------------------------------------ Деньги ------------------------------------ */

/** Рубли в копейки целым числом: сравнение сумм без плавающей точки. */
export function toKopecks(value: number | string): number {
  const n = typeof value === "number" ? value : Number.parseFloat(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
}

export function sameAmount(a: number | string, b: number | string): boolean {
  const ka = toKopecks(a);
  const kb = toKopecks(b);
  return Number.isFinite(ka) && ka === kb;
}

/** Тариф, за который можно выставить счёт онлайн: у «Премиума» цены нет. */
export function payablePlan(planId: string): (Plan & { priceRub: number }) | null {
  const plan = planById(planId);
  if (!plan || plan.priceRub === null) return null;
  return plan as Plan & { priceRub: number };
}

export function invoiceAmount(plan: { priceRub: number }, months: number): number {
  return Math.round(plan.priceRub * months * 100) / 100;
}

/** Наименование позиции счёта. */
export function invoicePositionName(plan: Pick<Plan, "name">, months: number): string {
  return `Подписка ТендерФит, тариф «${plan.name}», ${String(months)} мес.`;
}

/* ------------------------------------ ИНН, КПП, покупатель ------------------------------------ */

const INN10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12_A = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12_B = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function checkDigit(digits: readonly number[], weights: readonly number[]): number {
  const sum = weights.reduce((acc, w, i) => acc + w * (digits[i] ?? 0), 0);
  return (sum % 11) % 10;
}

/** ИНН: 10 цифр (организация) или 12 (ИП, физлицо) с верной контрольной суммой. */
export function isValidInn(inn: string): boolean {
  if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;
  if (/^0+$/.test(inn)) return false;
  const digits = [...inn].map(Number);
  if (digits.length === 10) return checkDigit(digits, INN10) === digits[9];
  return checkDigit(digits, INN12_A) === digits[10] && checkDigit(digits, INN12_B) === digits[11];
}

/** КПП: четыре цифры, два знака (цифры или заглавные латинские), три цифры. */
export function isValidKpp(kpp: string): boolean {
  return /^\d{4}[0-9A-Z]{2}\d{3}$/.test(kpp);
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email);
}

/** Тип покупателя для Точки: `company` — организация, `ip` — ИП. */
export function buyerTypeByInn(inn: string): "company" | "ip" {
  return inn.length === 10 ? "company" : "ip";
}

export interface BuyerInput {
  inn: unknown;
  kpp?: unknown;
  name: unknown;
  email: unknown;
}

export interface Buyer {
  inn: string;
  kpp: string | null;
  name: string;
  email: string;
}

export type BuyerResult = { ok: true; buyer: Buyer } | { ok: false; error: string; field: "inn" | "kpp" | "name" | "email" };

/** Название без управляющих знаков и двойных пробелов: оно уходит в документ банка. */
function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
}

export function parseBuyer(input: BuyerInput): BuyerResult {
  const inn = typeof input.inn === "string" ? input.inn.replace(/\s/g, "") : "";
  if (!isValidInn(inn)) {
    return { ok: false, field: "inn", error: "Проверьте ИНН: 10 цифр для организации или 12 для ИП, с верной контрольной суммой." };
  }

  // КПП есть только у организаций и необязателен; у ИП (12 цифр) его нет, и введённое отбрасывается.
  const rawKpp = typeof input.kpp === "string" ? input.kpp.replace(/\s/g, "").toUpperCase() : "";
  let kpp: string | null = null;
  if (inn.length === 10 && rawKpp !== "") {
    if (!isValidKpp(rawKpp)) return { ok: false, field: "kpp", error: "КПП — девять знаков, например 770101001." };
    kpp = rawKpp;
  }

  const name = cleanName(input.name);
  if (name.length < 2 || name.length > 300) {
    return { ok: false, field: "name", error: "Укажите название организации или ФИО индивидуального предпринимателя." };
  }

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) return { ok: false, field: "email", error: "Укажите почту, на которую отправить счёт." };

  return { ok: true, buyer: { inn, kpp, name, email } };
}

/* ------------------------------------ Номер счёта ------------------------------------ */

/** «ТФ-0001»: номер из последовательности базы. */
export function formatInvoiceNumber(seq: number): string {
  return `ТФ-${String(Math.trunc(seq)).padStart(4, "0")}`;
}

/**
 * Номера наших счетов в назначении платежа: «ТФ-0001», «ТФ 1», «тф№0001», латиницей «TF-0001».
 * Клиенты переписывают назначение руками, поэтому регистр, дефис и ведущие нули не важны, а
 * латинские T и F, похожие на русские, принимаются. Перед «ТФ» не должно быть буквы или цифры:
 * иначе «ЛЕТФ 5» дало бы чужой номер.
 */
export function invoiceNumbersInPurpose(purpose: string): string[] {
  const found = new Set<string>();
  const re = /(?<![\p{L}\d])[TТ][FФ]\s*[-–—№#.]?\s*0*(\d{1,6})(?!\d)/giu;
  for (const m of purpose.matchAll(re)) {
    const seq = Number(m[1]);
    if (seq > 0) found.add(formatInvoiceNumber(seq));
  }
  return [...found];
}

/** Нормализованный номер для сравнения («тф 1» и «ТФ-0001» — один и тот же). */
export function normalizeInvoiceNumber(number: string | null): string | null {
  if (number === null) return null;
  return invoiceNumbersInPurpose(number)[0] ?? null;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Идентификаторы документов банка (uuid), которые клиент оставил в назначении. */
export function documentIdsInPurpose(purpose: string): string[] {
  return [...new Set((purpose.match(UUID_RE) ?? []).map((id) => id.toLowerCase()))];
}

/* ------------------------------------ Подписи ------------------------------------ */

export const STATUS_LABEL: Record<PaymentStatus, string> = {
  issued: "ждёт оплаты",
  paid: "оплачен",
  cancelled: "отменён",
  expired: "просрочен",
};

/** Москва: дата счёта и срок оплаты в Точке считаются по московскому времени. */
export function moscowDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
}
