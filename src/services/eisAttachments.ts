import { EIS_PROCEDURE_CODE } from "@/domain/enums";
import type { PlacingWay, TenderLaw } from "@/domain/enums";
import { fileExtension } from "@/services/fileFormats";

/**
 * Вкладка документов ЕИС: адреса, разбор списка файлов, приоритет.
 *
 * Чистые функции без сети — их проверяют на обрезанных фикстурах настоящих
 * страниц, а обходом и скачиванием занимается tenderAttachmentsFetcher.
 *
 * Что проверено на живых закупках 22.09.2026:
 *
 * 44-ФЗ. Вкладка `…/epz/order/notice/{код}/view/documents.html?regNumber=…`,
 * код зависит от способа размещения (ea20, ok20, zk20, ep44). Неверный код не
 * страшен: ЕИС отвечает 302 на правильный, а `fetchHtml` работает с
 * `redirect: "follow"`. Проверено: запрос по ea20 для конкурса ok20 вернул 302
 * → ok20 и те же 54 файла. Несуществующий код даёт 404.
 *
 * 223-ФЗ. Вкладка требует `noticeGuid`, без него 404. GUID лежит в карточке
 * `…/notice/notice223/common-info.html?regNumber=…`, поэтому обход идёт в два
 * шага: карточка → вкладка документов.
 *
 * Имя файла. У 44-ФЗ оно в `title="…"` якоря, у 223-ФЗ — в
 * `data-tooltip='<span class="custom-tooltiptext">имя</span>'`. Внутри этого
 * атрибута есть символ `>`, поэтому regular «от `<a` до первой угловой скобки»
 * обрывает тег на середине, а окно «N символов до ссылки» цепляет соседний
 * якорь электронной подписи с тултипом «Просмотреть ЭП». Обе ошибки уже
 * случались на реальных страницах: тег обходится посимвольно с учётом кавычек.
 */

/** Ссылка на файл вложения вместе с именем, которое показал сайт. */
export interface AttachmentLink {
  url: string;
  /** Имя файла с расширением: берётся из title, тултипа или текста якоря. */
  name: string;
  /** Идентификатор файла в ЕИС; часть адреса скачивания. */
  uid: string;
}

/**
 * Ссылки на файлы во filestore ЕИС.
 *
 * Абсолютные — именно так их отдаёт страница. Относительный вариант учтён
 * на всякий случай: шаблон сайта менялся, и корневой путь `/44fz/filestore/…`
 * тоже был бы рабочим.
 */
const FILE_HREF =
  /(?:https:\/\/zakupki\.gov\.ru)?\/(?:44fz|223)\/filestore\/public\/[^"']*?file\.html\?uid=[0-9A-Fa-f]+/g;

const UID_QUERY = /[?&]uid=([0-9A-Fa-f]+)/i;

/** Максимальная длина имени, с которой страница отдаёт файл. */
const MAX_NAME_CHARS = 200;

/** Максимальная длина имени файла в tender_documents. */
const MAX_FILENAME_CHARS = 180;

/**
 * `title` якоря. Пробел перед именем атрибута обязателен: без него регулярка
 * нашла бы `title=` внутри `data-title=` и взяла чужой текст.
 */
const TITLE_ATTR = /\stitle\s*=\s*"([^"]{1,200})"/i;
const TOOLTIP_TEXT = /custom-tooltiptext["']?\s*>?\s*([^<]{1,200})</i;

/**
 * Метка редакции блока документа: «Редакция», затем «Действующая» или
 * «Недействующая».
 *
 * Классы не используются намеренно: у 44-ФЗ это `section__attrib` и
 * `section__value`, у 223-ФЗ — `attachment__text` и `attachment__value`, а
 * между словом и значением лежит пустая разметка с переносами строк. Окно в 400
 * знаков с ленивым квантификатором берёт ближайшее значение, на реальных
 * страницах до него 60–150 знаков. «Недействующая» перечислена первой: иначе
 * регулярка нашла бы внутри неё «Действующая».
 */
const EDITION_MARKER = /Редакция[\s\S]{0,400}?(Недействующая|Действующая)/gi;

/** Значение метки, при котором файлы блока уже заменены новой редакцией. */
const SUPERSEDED_EDITION = "недействующая";

/** Сколько символов идентификатора файла попадает в имя при повторяющемся имени. */
const UID_SUFFIX_CHARS = 8;

/** HTML-сущности, которые реально встречаются в атрибутах якорей ЕИС. */
const ATTR_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  laquo: "«",
  raquo: "»",
};

function decodeAttr(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return ATTR_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Начало открывающего тега `<a`, внутри которого стоит ссылка на файл.
 *
 * Поиск идёт назад от адреса, и `<a` принимается только за началом тега:
 * `<abbr`, `<article` и `<aside` начинаются с тех же двух символов.
 */
function findAnchorStart(html: string, urlAt: number): number {
  for (let i = Math.min(urlAt, html.length - 1); i >= 0; i -= 1) {
    if (html[i] !== "<") continue;
    if (html[i + 1]?.toLowerCase() !== "a") continue;
    const next = html[i + 2];
    if (next === undefined || /[\s>/]/.test(next)) return i;
  }
  return -1;
}

/**
 * Конец открывающего тега — индекс символа `>`.
 *
 * Обход посимвольный, потому что в 223-ФЗ внутри атрибута `data-tooltip` лежит
 * вложенная разметка с собственными кавычками и угловыми скобками.
 */
function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function anchorAround(html: string, urlAt: number): { tag: string; inner: string } | null {
  const start = findAnchorStart(html, urlAt);
  if (start === -1) return null;
  const end = findTagEnd(html, start);
  if (end === -1) return null;

  const close = html.indexOf("</a>", end);
  return {
    tag: html.slice(start, end + 1),
    inner: close === -1 ? "" : html.slice(end + 1, close),
  };
}

function stripTags(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Имя файла из якоря: title → тултип → видимый текст.
 *
 * Выбирается первый кандидат с расширением, а не первый непустой. У 44-ФЗ
 * расширение есть только в `title`, у 223-ФЗ — только в тултипе; видимый текст
 * якоря обрезан сайтом и расширения не содержит («341 143 МФУ» вместо
 * «341 143 МФУ.rar»), а по нему определяется формат файла.
 */
function pickName(anchor: { tag: string; inner: string } | null, uid: string): string {
  const candidates = [
    anchor ? (TITLE_ATTR.exec(anchor.tag)?.[1] ?? null) : null,
    anchor ? (TOOLTIP_TEXT.exec(anchor.tag)?.[1] ?? null) : null,
    anchor ? stripTags(anchor.inner) : "",
  ]
    .map((value) => decodeAttr(value ?? "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0 && value.length <= MAX_NAME_CHARS);

  const withExtension = candidates.find((value) => fileExtension(value) !== "");
  return (withExtension ?? candidates[0] ?? `attachment-${uid}`).slice(0, MAX_NAME_CHARS);
}

interface EditionMark {
  at: number;
  superseded: boolean;
}

/** Метки редакций в том порядке, в каком они стоят на странице. */
function editionMarks(html: string): EditionMark[] {
  return [...html.matchAll(EDITION_MARKER)].map((match) => ({
    at: match.index ?? 0,
    superseded: (match[1] ?? "").toLowerCase() === SUPERSEDED_EDITION,
  }));
}

/**
 * Заменён ли файл более поздней редакцией извещения.
 *
 * Берётся ближайшая метка перед ссылкой. Фиксированное окно не годится: на
 * живой странице 223-ФЗ от метки блока до ссылки на файл от 1,9 до 16,8 тыс.
 * знаков. Файл без метки впереди считается действующим — так устроены страницы
 * 44-ФЗ, где метка одна и стоит до первого блока документов.
 */
function isSuperseded(marks: readonly EditionMark[], urlAt: number): boolean {
  let superseded = false;
  for (const mark of marks) {
    if (mark.at >= urlAt) break;
    superseded = mark.superseded;
  }
  return superseded;
}

/**
 * Все ссылки на файлы вложения со страницы ЕИС, только из действующей редакции.
 *
 * Повторяющиеся адреса отбрасываются: одна и та же ссылка встречается и в списке
 * файлов, и во всплывающем окне просмотра.
 *
 * У 223-ФЗ вкладка показывает каждую редакцию извещения со своим набором файлов,
 * поэтому без фильтра метки «Редакция» в разбор ушли бы устаревшие документы —
 * на закупке 32616242641 это 20 ссылок из 40, включая три копии «Извещение.docx»
 * старше действующей. У 44-ФЗ фильтр ничего не меняет: метка одна и она
 * «Действующая».
 */
export function extractAttachmentLinks(html: string): AttachmentLink[] {
  const marks = editionMarks(html);
  const seen = new Set<string>();
  const links: AttachmentLink[] = [];

  for (const match of html.matchAll(FILE_HREF)) {
    const urlAt = match.index ?? 0;
    if (isSuperseded(marks, urlAt)) continue;

    const path = match[0];
    const url = path.startsWith("http") ? path : `https://zakupki.gov.ru${path}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const uid = UID_QUERY.exec(url)?.[1] ?? "";
    links.push({ url, uid, name: pickName(anchorAround(html, urlAt), uid) });
  }

  return links;
}

/**
 * GUID извещения 223-ФЗ из карточки закупки.
 *
 * `[?&]` в начале обязателен: в карточке есть и `noticeGuid`, и
 * `purchaseNoticeGuid`, и без разделителя регулярка нашла бы второе внутри
 * первого. Значения у них одинаковые, но полагаться на это не нужно.
 */
export function extractNoticeGuid(html: string): string | null {
  const direct = /[?&]noticeGuid=([0-9a-fA-F-]{36})/.exec(html)?.[1];
  if (direct) return direct;
  return /[?&]purchaseNoticeGuid=([0-9a-fA-F-]{36})/.exec(html)?.[1] ?? null;
}

/** Вкладка документов 44-ФЗ. Неверный код процедуры ЕИС исправляет редиректом. */
export function eis44DocumentsTabUrl(regNumber: string, placingWay: PlacingWay | null): string {
  const code = EIS_PROCEDURE_CODE[placingWay ?? "OTHER"] ?? "zk20";
  return `https://zakupki.gov.ru/epz/order/notice/${code}/view/documents.html?regNumber=${encodeURIComponent(regNumber)}`;
}

/** Вкладка документов 223-ФЗ: без noticeGuid отдаёт 404. */
export function eis223DocumentsTabUrl(regNumber: string, noticeGuid: string): string {
  return (
    `https://zakupki.gov.ru/epz/order/notice/notice223/documents.html` +
    `?purchaseNoticeNumber=${encodeURIComponent(regNumber)}&noticeGuid=${encodeURIComponent(noticeGuid)}`
  );
}

export interface DocumentsTabTarget {
  law: TenderLaw;
  regNumber: string;
  placingWay: PlacingWay | null;
  /** Для 223-ФЗ обязателен: берётся из карточки закупки. */
  noticeGuid?: string | null;
}

/**
 * Адрес вкладки документов; null — для этого закона или без GUID вкладки нет.
 *
 * 44-ФЗ и ПП РФ 615 живут в одном разделе ЕИС, поэтому путь общий. Для 223-ФЗ
 * null означает «сначала надо прочитать карточку» — именно так и делает
 * tenderAttachmentsFetcher.
 */
export function eisDocumentsTabUrl(target: DocumentsTabTarget): string | null {
  if (target.law === "FZ_44" || target.law === "PP_RF_615") {
    return eis44DocumentsTabUrl(target.regNumber, target.placingWay);
  }
  if (target.law === "FZ_223" && target.noticeGuid) {
    return eis223DocumentsTabUrl(target.regNumber, target.noticeGuid);
  }
  return null;
}

/**
 * Проект контракта или договора.
 *
 * Два шаблона, потому что заказчики пишут и «Проект контракта», и
 * «Контракт (проект)», и разделяют слова подчёркиванием: «Проект_контракта_ИКЗ_119».
 */
const CONTRACT_PATTERNS: readonly RegExp[] = [
  /проект[\s_\-–—]{0,4}(контракт|договор|госконтракт|гк)/i,
  /(контракт|договор|госконтракт)[\s_\-–—(«"]{0,8}проект/i,
];

/**
 * Описание объекта закупки, техзадание и требования к заявке.
 *
 * Ни `\b`, ни `\w` для кириллицы не годятся: в JavaScript `\w` — это
 * `[A-Za-z0-9_]`, поэтому «Техническое» после «техническ» нужно описывать
 * явным классом `[а-яё]`. Аббревиатура «ТЗ» ищется отдельным шаблоном
 * с русскими границами слова.
 */
const SPEC_PATTERNS: readonly RegExp[] = [
  /описани[ея][\s_\-–—]{0,6}(объект|предмет)/i,
  /техническ[а-яё]{0,4}[\s_\-–—]{0,6}(зада|требован)/i,
  /тех[\s_\-–—]{0,3}(требован|зада)/i,
  /(^|[^а-яёa-z0-9])тз([^а-яёa-z0-9]|$)/i,
  /требовани[^\n]{0,40}(содержани|состав)[^\n]{0,20}заявк/i,
  /требовани[а-яё]{0,4}[\s_\-–—]{0,4}к[\s_\-–—]{0,2}заявк/i,
  /проектн[\s_\-–—]{0,4}документаци/i,
  /смет/i,
  /*
    Всё, из чего считается стоимость работ. Ведомость объёмов — главный вход
    для расчёта сметы, и терять её из-за бюджета знаков нельзя: пока она шла в
    «прочее», том проектной документации на 800 тыс. знаков, стоявший на
    странице раньше, съедал бюджет целиком. Ведомость в ЕИС называют и
    «Ведомость объёмов работ», и «ВОР», и «Объём работ», и «Дефектная ведомость».
  */
  /ведомост/i,
  /(^|[^а-яёa-z0-9])вор([^а-яёa-z0-9]|$)/i,
  /объ[её]м[а-яё]{0,3}[\s_\-–—]{0,6}работ/i,
  /дефект(?:н|ац)/i,
  /спецификаци/i,
  /(^|[^а-яёa-z0-9])лср([^а-яёa-z0-9]|$)/i,
  /локальн[а-яё]{0,4}[\s_\-–—]{0,6}(смет|ресурс)/i,
  /(расч[её]т|обоснование)[\s_\-–—]{0,6}(начальн|нмц)/i,
];

/**
 * Что считается ведомостью или сметой: такие файлы не отодвигаются в хвост
 * приоритета, даже если в названии есть слова «проектная документация».
 */
const ESTIMATE_PATTERNS: readonly RegExp[] = [
  /ведомост/i,
  /(^|[^а-яёa-z0-9])вор([^а-яёa-z0-9]|$)/i,
  /объ[её]м[а-яё]{0,3}[\s_\-–—]{0,6}работ/i,
  /(^|[^а-яёa-z0-9])лср([^а-яёa-z0-9]|$)/i,
  /локальн[а-яё]{0,4}[\s_\-–—]{0,6}смет/i,
  /дефект(?:н|ац)/i,
];

/** Том проектной документации: большой, и текста в нём больше всего. */
const PROJECT_DOC_PATTERNS: readonly RegExp[] = [
  /проектн[а-яё]{0,4}[\s_\-–—]{0,4}документаци/i,
  /проектно[\s_\-–—]{0,2}сметн/i,
];

const PROTOCOL_PATTERN = /протокол/i;

function matches(name: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(name));
}

/** Тип документа вложения — значения повторяют CHECK-ограничение tender_documents. */
export type AttachmentDocumentType = "contract" | "protocol" | "attachment";

/**
 * Тип документа по имени файла.
 *
 * Протокол проверяется первым: «Протокол разногласий к проекту контракта» —
 * это протокол, а не проект контракта, и в карточке закупки его важно видеть
 * отдельной строкой.
 */
export function attachmentDocumentType(name: string): AttachmentDocumentType {
  if (PROTOCOL_PATTERN.test(name)) return "protocol";
  if (matches(name, CONTRACT_PATTERNS)) return "contract";
  return "attachment";
}

/** Проект контракта разбирается первым: в нём сроки, штрафы и порядок приёмки. */
export const PRIORITY_CONTRACT = 0;
/** Техзадание и описание объекта закупки — вторым. */
export const PRIORITY_SPEC = 1;
/** Всё остальное — в том порядке, в каком его отдала страница. */
export const PRIORITY_REST = 2;

/**
 * Насколько срочно читать файл, если весь объём закупки в лимит не влезает.
 * Порядок согласован: проект контракта → описание объекта, техзадание,
 * ведомость объёмов и смета → прочее.
 *
 * Ведомость и смета не подняты выше проекта контракта намеренно: контракт
 * короток (десятки тысяч знаков) и читается первым без ущерба для бюджета, а
 * срок, штрафы и порядок приёмки из него нужны любому разбору. Достаточно того,
 * что они идут раньше «прочего» и раньше тома проектной документации (см.
 * attachmentRank).
 */
export function attachmentPriority(name: string): number {
  if (matches(name, CONTRACT_PATTERNS)) return PRIORITY_CONTRACT;
  if (matches(name, SPEC_PATTERNS)) return PRIORITY_SPEC;
  return PRIORITY_REST;
}

/**
 * Порядок внутри одного приоритета: 0 — обычный файл, 1 — том проектной
 * документации.
 *
 * Проектная документация попадает в тот же приоритет, что техзадание, но
 * весит на порядок больше: том чертежей и пояснительных записок легко занимает
 * весь бюджет знаков. Стоя на странице раньше ведомости объёмов, он оставлял её
 * без места, хотя именно ведомость нужна для расчёта сметы. Поэтому внутри
 * приоритета том документации идёт после остальных файлов, а ведомость и смета
 * его в хвост не отодвигают.
 */
export function attachmentRank(name: string): number {
  if (matches(name, ESTIMATE_PATTERNS)) return 0;
  return matches(name, PROJECT_DOC_PATTERNS) ? 1 : 0;
}

/** Имя, под которым файл ляжет в tender_documents: без символов пути и лишних пробелов. */
export function attachmentFilename(link: AttachmentLink): string {
  const cleaned = link.name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length === 0) return `attachment-${link.uid}`;
  if (cleaned.length <= MAX_FILENAME_CHARS) return cleaned;

  // Обрезка не должна откусить расширение: по нему определяется формат файла.
  const extension = fileExtension(cleaned);
  if (extension === "") return cleaned.slice(0, MAX_FILENAME_CHARS);
  return `${cleaned.slice(0, MAX_FILENAME_CHARS - extension.length - 1)}.${extension}`;
}

/** Нормализованное имя: по нему считаются повторы, регистр и пробелы не важны. */
function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Имя с хвостом из идентификатора файла: «Разъяснение_32616242641 (3F0C7108).pdf».
 *
 * Суффикс вставляется перед расширением, потому что по расширению определяется
 * формат файла, а регистр расширения сохраняется как на странице.
 */
function withUidSuffix(link: AttachmentLink): AttachmentLink {
  if (link.uid === "") return link;
  const suffix = ` (${link.uid.slice(0, UID_SUFFIX_CHARS)})`;
  const dot = link.name.lastIndexOf(".");
  if (dot <= 0) return { ...link, name: `${link.name}${suffix}` };
  return { ...link, name: `${link.name.slice(0, dot)}${suffix}${link.name.slice(dot)}` };
}

/** Вложение в порядке обхода: имя для базы, приоритет и тип уже посчитаны. */
export interface PlannedAttachment extends AttachmentLink {
  /**
   * Имя для tender_documents — уникально в пределах закупки.
   * `name` при этом остаётся таким, каким файл показал сайт: суффикс из uid
   * нужен только базе, партнёру в карточке он ничего не говорит.
   */
  filename: string;
  /** 0 — проект контракта, 1 — описание объекта и техзадание, 2 — прочее. */
  priority: number;
  documentType: AttachmentDocumentType;
}

/**
 * План обхода вложений: по убыванию приоритета, с уникальными именами файлов.
 *
 * Повтор имени не отбрасывается, а различается суффиксом из идентификатора
 * файла. Отбрасывать нельзя: ЕИС хранит документы каждой редакции извещения
 * отдельно, и «Разъяснение_32616242641.pdf» на живой закупке 32616242641
 * встречается трижды в действующей редакции — это три разных ответа заказчика,
 * а не один и тот же файл. Суффикс получают все копии имени, а не только вторая
 * и дальше: иначе результат зависел бы от порядка блоков на странице.
 *
 * Сортировка устойчива (этого требует ES2019 от Array.prototype.sort), но
 * порядок страницы закреплён явным индексом — на него можно положиться.
 */
export function planAttachments(links: readonly AttachmentLink[]): PlannedAttachment[] {
  const counts = new Map<string, number>();
  for (const link of links) {
    const key = normalizeName(link.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return links
    .map((link, index) => {
      const repeated = (counts.get(normalizeName(link.name)) ?? 0) > 1;
      return {
        link,
        index,
        filename: attachmentFilename(repeated ? withUidSuffix(link) : link),
        priority: attachmentPriority(link.name),
        rank: attachmentRank(link.name),
        documentType: attachmentDocumentType(link.name),
      };
    })
    .sort(
      (a, b) =>
        a.priority - b.priority || a.rank - b.rank || a.index - b.index,
    )
    .map(({ link, filename, priority, documentType }) => ({
      ...link,
      filename,
      priority,
      documentType,
    }));
}
