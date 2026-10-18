import { z } from "zod";
import type { TenderFinancialTerms } from "@/domain/entities";

/**
 * Обеспечение заявки, обеспечение контракта и аванс из текста документации.
 *
 * Зачем: ЕИС, Росэлторг, ТЭК-Торг и Сбербанк-АСТ в выдаче этих условий не
 * отдают — в ленте под ценой было пусто у большинства закупок. А извещение ЕИС
 * печатает их строками («Размер обеспечения заявки» / «4353541.53 РОССИЙСКИЙ
 * РУБЛЬ», «Аванс, %» / «30.00»), проект контракта — прозой («с авансовым
 * платежом в размере 30%»). Оба вида читаются регулярными выражениями: без
 * модели, бесплатно и одинаково при каждом прогоне.
 *
 * Шаблоны подобраны по живым документам базы, и ловушки в них тоже живые:
 *  - текст закона: «аванс в размере не более 30%», «от 0,5 до 1%» — это рамки,
 *    а не условия закупки, такое число не берётся;
 *  - условные фразы: «в случае если обеспечение заявки не требуется» — не отказ;
 *  - оглавление: «обеспечения заявки\t43» — номер страницы, не сумма;
 *  - «обеспечение гарантийных обязательств» — другое обеспечение, не контракта.
 *
 * Неизвестное остаётся неизвестным: если ни одна фраза не прошла, условия нет
 * в результате вовсе, и лента ничего не печатает — как и раньше.
 */

export type DocumentTermKind = "bidSecurity" | "contractSecurity" | "advance";

export interface DocumentTerm {
  /** false — документация прямо пишет «не требуется» / «не предусмотрен». */
  required: boolean;
  percent: number | null;
  amount: number | null;
  /** Фраза из документа, на которой основан вывод, — для подсказки в ленте. */
  quote: string;
  /**
   * Вывод опирается на «размер …» рядом с числом. Такая строка — реквизит
   * извещения или условие проекта контракта, а не упоминание в тексте, и при
   * слиянии нескольких документов она важнее.
   */
  strong: boolean;
}

export type DocumentTerms = Partial<Record<DocumentTermKind, DocumentTerm>>;

export const DOCUMENT_TERM_KINDS: readonly DocumentTermKind[] = [
  "bidSecurity",
  "contractSecurity",
  "advance",
];

const ANCHORS: Record<DocumentTermKind, RegExp> = {
  // «заяв[а-я]*» ловит и склеенное разбором «заявкина участие».
  bidSecurity: /обеспечени[а-я]*\s+заяв[а-я]*/giu,
  // Только исполнение контракта/договора: гарантийные обязательства не в счёт.
  contractSecurity:
    /обеспечени[а-я]*\s+исполнени[а-я]*\s+(?:настоящего\s+)?(?:контракт|договор)[а-я]*/giu,
  advance: /аванс[а-я]*/giu,
};

/** Верхние границы процента: больше — это не условие закупки, а ошибка чтения. */
const MAX_PERCENT: Record<DocumentTermKind, number> = {
  bidSecurity: 10,
  contractSecurity: 50,
  advance: 100,
};

/** Сколько знаков после якоря смотрим: строка извещения укладывается в ~120. */
const TAIL = 200;

/*
  Границы слов — через «не буква», а не `\b`: в JS `\b` знает только латиницу,
  и `\bне` не срабатывает ни перед одним русским словом.
*/
const NEGATION =
  /^[^\d%]{0,80}?(?:^|[^а-яё])не\s+(?:требуется|установлен[оаы]?|устанавливается|предусмотрен[оаы]?|предоставляется)/iu;
/** Отрицание перед якорем: «Не требуется обеспечение заявки». */
const NEGATION_BEFORE = /(?:^|[^а-яё])не\s+требуется\s*$/iu;
/** «Обеспечение возврата аванса» — про гарантию, а не про сам аванс. */
const RETURN_BEFORE = /возврат[а-я]*\s*$/iu;
/** Условная фраза — не утверждение о закупке. */
const CONDITIONAL_BEFORE = /(?:если|случае|случаях)[^.\n]{0,40}$/iu;
/** Рамки из закона: «не более 30%», «от 0,5 до 1%», «до 5%». */
const BOUND_BEFORE =
  /(?:^|[^а-яё])(?:не\s+более|не\s+менее|не\s+выше|свыше|от|до|превышать)\s*$/iu;

const PERCENT = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|процент)/iu;
/** «Аванс, %» / «30.00» — знак процента в подписи, число на следующей строке. */
const PERCENT_HEADER =
  /^\s*[,(]?\s*%\s*\)?\s*[:\-–]?\s*(\d{1,3}(?:[.,]\d{1,2})?)(?!\d)/u;
const AMOUNT =
  /(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:₽|руб|российск[а-я]*\s+рубл)/iu;

function toNumber(raw: string): number {
  return Number(raw.replace(/[  ]/g, "").replace(",", "."));
}

function quoteOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

interface Candidate {
  term: DocumentTerm;
  /** 3 — число при «размер», 2 — явный отказ, 1 — число без «размер». */
  score: number;
  at: number;
}

/** Где кончается хвост якоря: на ближайшем якоре другого условия. */
function tailEnd(text: string, from: number, kind: DocumentTermKind): number {
  let end = Math.min(text.length, from + TAIL);
  for (const other of DOCUMENT_TERM_KINDS) {
    if (other === kind) continue;
    const re = new RegExp(ANCHORS[other].source, "iu");
    const m = re.exec(text.slice(from, end));
    if (m) end = from + m.index;
  }
  return end;
}

function candidatesFor(
  text: string,
  kind: DocumentTermKind,
  price: number | null,
): Candidate[] {
  const found: Candidate[] = [];
  const anchor = new RegExp(ANCHORS[kind].source, "giu");
  for (let m = anchor.exec(text); m !== null; m = anchor.exec(text)) {
    const start = m.index;
    const from = start + m[0].length;
    const before = text.slice(Math.max(0, start - 60), start);
    if (CONDITIONAL_BEFORE.test(before)) continue;
    if (kind === "advance" && RETURN_BEFORE.test(before)) continue;
    const tail = text.slice(from, tailEnd(text, from, kind));
    // «Размер» стоит перед якорем («Размер обеспечения заявки») — цитата
    // начинается с него, иначе читается обрубком «обеспечения заявки 5%».
    const lead = /размер[а-я]*\s+$/iu.exec(before)?.[0].length ?? 0;
    const hasSize = /размер/iu.test(
      text.slice(Math.max(0, start - 40), from + 60),
    );

    if (NEGATION_BEFORE.test(before) || NEGATION.test(tail)) {
      const neg = NEGATION.exec(tail);
      const end = neg ? from + neg[0].length : from;
      const quoteStart = neg ? start - lead : Math.max(0, start - 15);
      found.push({
        term: {
          required: false,
          percent: null,
          amount: null,
          quote: quoteOf(text.slice(quoteStart, end)),
          strong: false,
        },
        score: 2,
        at: start,
      });
      continue;
    }

    const value = valueIn(tail, kind, price);
    if (value === null) continue;
    // Цитата — от ближайшего «Размер …» (а не от заголовка раздела) до конца
    // слова после числа: «РУБЛЬ», а не обрубок «РУБЛ», на котором стоп шаблона.
    let end = from + value.end;
    end += /^[а-яёa-z]*/iu.exec(text.slice(end))![0].length;
    const span = text.slice(start - lead, end);
    const sizeAt = span.search(/размер[а-я]*\s+(?:обеспечени|аванс)/iu);
    found.push({
      term: {
        required: value.percent === 0 ? false : true,
        percent: value.percent === 0 ? null : value.percent,
        amount: value.amount,
        quote: quoteOf(sizeAt > 0 ? span.slice(sizeAt) : span),
        strong: hasSize,
      },
      score: hasSize ? 3 : 1,
      at: start,
    });
  }
  return found;
}

function valueIn(
  tail: string,
  kind: DocumentTermKind,
  price: number | null,
): { percent: number | null; amount: number | null; end: number } | null {
  // Сначала то, что ближе к якорю: в строке извещения сумма идёт сразу за
  // подписью, а в прозе после числа часто стоит ещё одно — «(пять) процентов».
  const options: {
    index: number;
    end: number;
    percent: number | null;
    amount: number | null;
  }[] = [];

  const header = PERCENT_HEADER.exec(tail);
  if (header) {
    options.push({
      index: header.index,
      end: header[0].length,
      percent: toNumber(header[1]!),
      amount: null,
    });
  }
  const pct = PERCENT.exec(tail);
  if (pct) {
    options.push({
      index: pct.index,
      end: pct.index + pct[0].length,
      percent: toNumber(pct[1]!),
      amount: null,
    });
  }
  const amt = AMOUNT.exec(tail);
  if (amt) {
    const whole = amt[1]!.replace(/[  ]/g, "");
    const cents = amt[2] ?? "0";
    options.push({
      index: amt.index,
      end: amt.index + amt[0].length,
      percent: null,
      amount: Number(`${whole}.${cents}`),
    });
  }

  options.sort((a, b) => a.index - b.index);
  for (const option of options) {
    if (
      BOUND_BEFORE.test(
        tail.slice(Math.max(0, option.index - 20), option.index),
      )
    )
      continue;
    if (option.percent !== null) {
      if (
        !Number.isFinite(option.percent) ||
        option.percent > MAX_PERCENT[kind]
      )
        continue;
      return option;
    }
    if (option.amount !== null) {
      if (!(option.amount > 0)) continue;
      // Сумма больше цены закупки — это цена или чужое число, а не обеспечение.
      if (price !== null && price > 0 && option.amount > price) continue;
      return option;
    }
  }
  return null;
}

/**
 * Условия из текста одного документа.
 *
 * Из нескольких упоминаний берётся сильнейшее: число при «размер …» важнее
 * отказа, отказ — важнее голого числа; при равенстве — первое по тексту.
 */
export function extractDocumentTerms(
  text: string,
  options: { price?: number | null } = {},
): DocumentTerms {
  const normalized = text.replace(/\r/g, "").replace(/ /g, " ");
  const price = options.price ?? null;
  const result: DocumentTerms = {};
  for (const kind of DOCUMENT_TERM_KINDS) {
    const best = candidatesFor(normalized, kind, price).sort(
      (a, b) => b.score - a.score || a.at - b.at,
    )[0];
    if (best) result[kind] = best.term;
  }
  return result;
}

/**
 * Слияние с тем, что уже найдено в других документах закупки.
 *
 * Документы приходят по одному и в любом порядке, поэтому правило не зависит
 * от порядка: уже найденное остаётся, пока новое не сильнее — реквизит при
 * «размер …» заменяет слабый вывод, но не наоборот.
 */
export function mergeDocumentTerms(
  current: DocumentTerms | null,
  found: DocumentTerms,
): DocumentTerms {
  const merged: DocumentTerms = { ...(current ?? {}) };
  for (const kind of DOCUMENT_TERM_KINDS) {
    const next = found[kind];
    if (!next) continue;
    const prev = merged[kind];
    if (!prev || (next.strong && !prev.strong)) merged[kind] = next;
  }
  return merged;
}

const termSchema = z.object({
  required: z.boolean(),
  percent: z.number().nullable(),
  amount: z.number().nullable(),
  quote: z.string(),
  strong: z.boolean().default(false),
});

const termsSchema = z
  .object({
    bidSecurity: termSchema.optional(),
    contractSecurity: termSchema.optional(),
    advance: termSchema.optional(),
  })
  .passthrough();

/** Чтение `tenders.doc_terms`: битый JSON не должен ронять ленту. */
export function parseDocumentTerms(json: unknown): DocumentTerms | null {
  if (json === null || json === undefined) return null;
  const parsed = termsSchema.safeParse(json);
  if (!parsed.success) return null;
  const { bidSecurity, contractSecurity, advance } = parsed.data;
  const terms: DocumentTerms = {};
  if (bidSecurity) terms.bidSecurity = bidSecurity;
  if (contractSecurity) terms.contractSecurity = contractSecurity;
  if (advance) terms.advance = advance;
  return Object.keys(terms).length > 0 ? terms : null;
}

function isRubCurrency(currency: string): boolean {
  const c = currency.trim().toUpperCase();
  return c === "" || c === "RUB";
}

function amountFrom(term: DocumentTerm, price: number): number | null {
  if (term.amount !== null) return term.amount;
  if (term.percent !== null && price > 0) {
    return Math.round(price * term.percent) / 100;
  }
  return null;
}

/**
 * Дополняет реквизиты площадки найденным в документации.
 *
 * Площадка главнее: её поле переписывается, только когда оно пустое. В
 * `applied` попадают лишь условия, которые реально пошли в дело, — по ним
 * лента и карточка помечают значение как «из документации».
 */
export function applyDocumentTerms(
  financial: TenderFinancialTerms,
  terms: DocumentTerms | null,
): { financial: TenderFinancialTerms; applied: DocumentTerms | null } {
  if (!terms) return { financial, applied: null };
  const next = { ...financial };
  const applied: DocumentTerms = {};
  // Сумма в рублях из документа к долларовой закупке не прикладывается.
  const rub = isRubCurrency(financial.currency);

  const bid = terms.bidSecurity;
  if (
    bid &&
    financial.bidSecurityAmount === null &&
    financial.bidSecurityPercent === null
  ) {
    if (bid.required) {
      next.bidSecurityPercent = bid.percent;
      next.bidSecurityAmount = rub ? amountFrom(bid, financial.price) : null;
    }
    if (
      !bid.required ||
      next.bidSecurityPercent !== null ||
      next.bidSecurityAmount !== null
    ) {
      applied.bidSecurity = bid;
    }
  }

  const contract = terms.contractSecurity;
  if (
    contract &&
    financial.contractSecurityAmount === null &&
    financial.contractSecurityPercent === null
  ) {
    if (contract.required) {
      next.contractSecurityPercent = contract.percent;
      next.contractSecurityAmount = rub
        ? amountFrom(contract, financial.price)
        : null;
    }
    if (
      !contract.required ||
      next.contractSecurityPercent !== null ||
      next.contractSecurityAmount !== null
    ) {
      applied.contractSecurity = contract;
    }
  }

  const advance = terms.advance;
  if (
    advance &&
    financial.advancePercent === null &&
    financial.advanceAmount === null
  ) {
    if (advance.required) {
      next.advancePercent = advance.percent;
      next.advanceAmount = rub ? advance.amount : null;
    }
    if (
      !advance.required ||
      next.advancePercent !== null ||
      next.advanceAmount !== null
    ) {
      applied.advance = advance;
    }
  }

  return {
    financial: next,
    applied: Object.keys(applied).length > 0 ? applied : null,
  };
}
