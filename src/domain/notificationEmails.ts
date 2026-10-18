import { appBaseUrl, formatDeadline, type DigestItem, type DigestResult } from "@/domain/digest";
import { BORDER, FAINT, INK, MUTED, button, escapeHtml, layout, type EmailMessage } from "@/domain/emailTemplates";
import { OPERATOR } from "@/lib/legal";
import { formatCompactRub, formatCurrency, pluralRu } from "@/utils/format";

/**
 * Письма-уведомления: утренняя сводка и «готов анализ / смета».
 *
 * Чистые функции, как и остальные письма сервиса (`emailTemplates.ts`): тема, текст и HTML,
 * общая рамка и стили оттуда же. Всё, что приходит из закупки (предмет, заказчик, итог
 * разбора), — чужой текст и в HTML экранируется; в тему письма он идёт без переводов строк.
 */

/** Предмет в теме письма: до 70 знаков, без переводов строк, обрезка с многоточием. */
const SUBJECT_LIMIT = 70;

/** Предмет закупки в строке сводки: названия ЕИС бывают по 300 знаков, полностью их видно в карточке. */
const DIGEST_ITEM_SUBJECT_LIMIT = 160;

export function shortSubject(subject: string, limit: number = SUBJECT_LIMIT): string {
  const flat = subject.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/** Разделы сводки: заголовок и строки. */
interface Section {
  title: string;
  items: DigestItem[];
  /** Сколько было всего, если показана только часть. */
  total?: number;
}

function priceText(item: DigestItem): string {
  if (item.price === null) return "НМЦК не указана";
  const rub = item.currency === "" || item.currency.toUpperCase() === "RUB";
  return `НМЦК ${rub ? formatCompactRub(item.price) : formatCurrency(item.price, item.currency)}`;
}

/** «Заказчик · регион»: пустое пропускается. */
function whoWhere(item: DigestItem): string {
  return [item.customer, item.region].map((part) => part.trim()).filter((part) => part !== "").join(" · ");
}

function factsLine(item: DigestItem, timeZone: string): string {
  return [priceText(item), `подача до ${formatDeadline(item.submissionEnd, timeZone)}`, `оценка ${String(item.fitScore)}`].join(" · ");
}

/** Тема сводки: «ТендерФит: 3 новые закупки по вашему профилю» или, если новых нет, про сроки. */
export function digestSubject(digest: Pick<DigestResult, "totalFresh">): string {
  if (digest.totalFresh > 0) {
    const n = digest.totalFresh;
    return `ТендерФит: ${String(n)} ${pluralRu(n, ["новая закупка", "новые закупки", "новых закупок"])} по вашему профилю`;
  }
  return "ТендерФит: сроки по вашим закупкам";
}

function digestSections(digest: DigestResult): Section[] {
  const sections: Section[] = [];
  if (digest.fresh.length > 0) sections.push({ title: "Новые", items: digest.fresh, total: digest.totalFresh });
  if (digest.closing.length > 0) sections.push({ title: "Закрываются в ближайшие 48 часов", items: digest.closing });
  if (digest.inWork.length > 0) sections.push({ title: "В работе", items: digest.inWork });
  return sections;
}

/**
 * Утренняя сводка. `timeZone` — пояс клиента: в нём печатаются сроки подачи.
 * Ссылки ведут на закупки, ленту и настройки писем по адресу `baseUrl`.
 */
export function buildDigestEmail(input: { digest: DigestResult; timeZone: string; baseUrl?: string }): EmailMessage {
  const { digest, timeZone } = input;
  const base = input.baseUrl ?? appBaseUrl();
  const feedUrl = `${base}/tenders`;
  const settingsUrl = `${base}/settings/notifications`;
  const subject = digestSubject(digest);
  const sections = digestSections(digest);

  const textParts: string[] = ["Доброе утро!", ""];
  for (const section of sections) {
    textParts.push(section.title.toUpperCase());
    for (const item of section.items) {
      textParts.push(`• ${shortSubject(item.subject, DIGEST_ITEM_SUBJECT_LIMIT)}`);
      const who = whoWhere(item);
      if (who !== "") textParts.push(`  ${who}`);
      textParts.push(`  ${factsLine(item, timeZone)}`);
      textParts.push(`  ${item.url}`);
    }
    if (section.total !== undefined && section.total > section.items.length) {
      textParts.push(`  …и ещё ${String(section.total - section.items.length)} в ленте`);
    }
    textParts.push("");
  }
  textParts.push(`Открыть все в ленте: ${feedUrl}`);
  textParts.push(`Настроить или отключить письма: ${settingsUrl}`);
  textParts.push("", `ТендерФит · ${OPERATOR.site}`);

  const sectionHtml = sections
    .map((section) => {
      const rows = section.items
        .map((item) => {
          const who = whoWhere(item);
          return `<tr><td style="padding:12px 0;border-top:1px solid ${BORDER};">
<a href="${escapeHtml(item.url)}" style="font-size:15px;font-weight:600;line-height:1.4;color:${INK};text-decoration:none;">${escapeHtml(shortSubject(item.subject, DIGEST_ITEM_SUBJECT_LIMIT))}</a>
${who === "" ? "" : `<div style="margin-top:3px;font-size:13px;line-height:1.45;color:${MUTED};">${escapeHtml(who)}</div>`}
<div style="margin-top:2px;font-size:13px;line-height:1.45;color:${FAINT};">${escapeHtml(factsLine(item, timeZone))}</div>
</td></tr>`;
        })
        .join("\n");
      const more =
        section.total !== undefined && section.total > section.items.length
          ? `<tr><td style="padding:10px 0 0;border-top:1px solid ${BORDER};font-size:13px;color:${MUTED};">…и ещё ${String(section.total - section.items.length)} в ленте</td></tr>`
          : "";
      return `<h2 style="margin:22px 0 4px;font-size:16px;font-weight:600;color:${INK};">${escapeHtml(section.title)}</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${rows}
${more}
</table>`;
    })
    .join("\n");

  const body = `<h1 style="margin:0 0 4px;font-size:20px;font-weight:600;letter-spacing:-0.01em;color:${INK};">${escapeHtml(subject.replace(/^ТендерФит:\s*/, "").replace(/^./, (c) => c.toUpperCase()))}</h1>
<p style="margin:0;font-size:14px;line-height:1.5;color:${MUTED};">Утренняя сводка: что нового и что горит.</p>
${sectionHtml}
<p style="margin:24px 0 16px;">${button(feedUrl, "Открыть все в ленте")}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${FAINT};"><a href="${escapeHtml(settingsUrl)}" style="color:${FAINT};">Настроить или отключить письма</a></p>`;

  return {
    subject,
    text: textParts.join("\n"),
    html: layout({ preheader: subject, title: subject, body, maxWidth: 600 }),
  };
}

/** Что известно о готовом глубоком анализе. */
export interface AnalysisReadyInput {
  regNumber: string;
  subject: string;
  /** Итог сводки (`ConsolidatedAnalysis.summary`); нет или пусто — строка «Найдено выводов: N». */
  summary: string | null;
  findings: number;
  /** Число противоречий и вопросов заказчику; null — сводки нет, строка о них не печатается. */
  conflicts: number | null;
  questions: number | null;
  baseUrl?: string;
}

/** Ссылка на закупку со вкладкой разбора. */
function analysisUrl(regNumber: string, base: string): string {
  return `${base}/tenders/${encodeURIComponent(regNumber)}?tab=analysis`;
}

export function buildAnalysisReadyEmail(input: AnalysisReadyInput): EmailMessage {
  const base = input.baseUrl ?? appBaseUrl();
  const subject = `Анализ готов: ${shortSubject(input.subject)}`;
  const url = analysisUrl(input.regNumber, base);
  const summary = (input.summary ?? "").replace(/\s+/g, " ").trim();
  const headline = summary !== "" ? summary : `Найдено выводов: ${String(input.findings)}`;
  const counts =
    input.conflicts !== null && input.questions !== null
      ? `противоречий: ${String(input.conflicts)}, вопросов заказчику: ${String(input.questions)}`
      : null;
  const tender = input.subject.replace(/\s+/g, " ").trim();

  const text = [
    "Глубокий анализ закупки готов.",
    "",
    tender,
    "",
    headline,
    ...(counts === null ? [] : [counts]),
    "",
    `Открыть анализ: ${url}`,
    "",
    `Не хотите получать такие письма? Отключить: ${base}/settings/notifications`,
    "",
    `ТендерФит · ${OPERATOR.site}`,
  ].join("\n");

  const body = `<h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em;color:${INK};">Анализ готов</h1>
<p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(tender)}</p>
<p style="margin:0 0 ${counts === null ? 20 : 8}px;font-size:15px;line-height:1.55;color:${INK};">${escapeHtml(headline)}</p>
${counts === null ? "" : `<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(counts)}</p>`}
<p style="margin:0 0 20px;">${button(url, "Открыть анализ")}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${FAINT};"><a href="${escapeHtml(`${base}/settings/notifications`)}" style="color:${FAINT};">Отключить такие письма</a></p>`;

  return { subject, text, html: layout({ preheader: headline, title: subject, body }) };
}

/** Что известно о готовой смете. */
export interface EstimateReadyInput {
  subject: string;
  /** Итог сметы с НДС, ₽; null — суммы в отчёте нет, письмо идёт без неё. */
  totalRub: number | null;
  /** Номер закупки; нет — смета посчитана на экране «Смета» без закупки. */
  tenderId: string | null;
  baseUrl?: string;
}

export function buildEstimateReadyEmail(input: EstimateReadyInput): EmailMessage {
  const base = input.baseUrl ?? appBaseUrl();
  const subject = `Смета готова: ${shortSubject(input.subject)}`;
  const url = input.tenderId !== null ? analysisUrl(input.tenderId, base) : `${base}/estimate`;
  const label = input.tenderId !== null ? "Открыть закупку" : "Открыть смету";
  const object = input.subject.replace(/\s+/g, " ").trim();
  const total = input.totalRub !== null && input.totalRub > 0 ? `Итого с НДС: ${formatCurrency(input.totalRub)}` : null;

  const text = [
    "Смета готова.",
    "",
    object,
    ...(total === null ? [] : ["", total]),
    "",
    `${label}: ${url}`,
    "",
    `Не хотите получать такие письма? Отключить: ${base}/settings/notifications`,
    "",
    `ТендерФит · ${OPERATOR.site}`,
  ].join("\n");

  const body = `<h1 style="margin:0 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.01em;color:${INK};">Смета готова</h1>
<p style="margin:0 0 ${total === null ? 20 : 14}px;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(object)}</p>
${total === null ? "" : `<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:${INK};">${escapeHtml(total)}</p>`}
<p style="margin:0 0 20px;">${button(url, label)}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${FAINT};"><a href="${escapeHtml(`${base}/settings/notifications`)}" style="color:${FAINT};">Отключить такие письма</a></p>`;

  return { subject, text, html: layout({ preheader: total ?? object, title: subject, body }) };
}

/**
 * Письмо администратору: задача клиента упала. Анализ клиента 14.10.2026 упал с
 * «[object Object]», и о сбое никто не узнал, — теперь о каждом сбое приходит письмо с
 * причиной, кто запускал и ссылкой на закупку.
 */
export function buildFailureAlertEmail(input: {
  kind: "analysis" | "estimate";
  tenderId: string | null;
  subject: string | null;
  requestedBy: string | null;
  error: string;
  baseUrl: string;
}): { subject: string; text: string; html: string } {
  const what = input.kind === "analysis" ? "Глубокий анализ" : "Расчёт сметы";
  const object = input.subject !== null && input.subject.trim() !== "" ? shortSubject(input.subject) : input.tenderId ?? "без закупки";
  const subject = `ТендерФит: ${what.toLowerCase()} не удался — ${object}`;
  const url = input.tenderId === null ? `${input.baseUrl}/estimate` : `${input.baseUrl}/tenders/${encodeURIComponent(input.tenderId)}?tab=analysis`;
  const who = input.requestedBy !== null && input.requestedBy.includes("@") ? input.requestedBy : "служебный запуск";
  const error = input.error.trim() === "" ? "причина не записана" : input.error.trim().slice(0, 600);
  const text = [`${what} не удался.`, "", `Закупка: ${input.tenderId ?? "—"} ${input.subject ?? ""}`.trim(), `Запустил: ${who}`, `Причина: ${error}`, "", url].join("\n");
  const body = `<h1 style="margin:0 0 8px;font-size:18px;font-weight:600;color:${INK};">${escapeHtml(what)} не удался</h1>
<p style="margin:0 0 4px;font-size:14px;color:${INK};"><b>Закупка:</b> ${escapeHtml(input.tenderId ?? "—")} ${escapeHtml(input.subject ?? "")}</p>
<p style="margin:0 0 4px;font-size:14px;color:${INK};"><b>Запустил:</b> ${escapeHtml(who)}</p>
<p style="margin:0 0 16px;font-size:14px;color:${INK};"><b>Причина:</b> ${escapeHtml(error)}</p>
${button(url, "Открыть закупку")}`;
  return { subject, text, html: layout({ preheader: error, title: subject, body }) };
}
