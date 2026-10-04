import { sourceFacts } from "@/domain/sources";
import type { TenderDataSource, TenderLaw } from "@/types/database";

/**
 * Загрузка текста документации закупки из открытых источников.
 *
 * Работает только с российской машины: ЕИС, как и поисковый API, не пускает
 * зарубежные IP, поэтому с Vercel эти страницы недоступны. Скрипт
 * scripts/fetch-tender-documents.ts вызывает модуль локально, кладёт текст в
 * tender_documents.parsed_text, а AI-разбор докручивает воркер на Vercel.
 *
 * Что реально отдаёт ЕИС (проверено 21.09.2026 на живых номерах):
 *  - 44-ФЗ: печатная форма извещения — полноценный текст закупки, ~240 тыс. знаков;
 *  - 223-ФЗ: карточка common-info — сведения о закупке без вложений, ~3 тыс. знаков
 *    после отсечения сквозной навигации сайта;
 *  - коммерческие торги Сбербанк-АСТ: документация лежит в карточке площадки,
 *    отдельного парсера для неё нет.
 *
 * Закупки Контур.Закупок читаются здесь же: агрегатор отдаёт тот же номер
 * извещения ЕИС, а файлы в его карточке — ссылки на filestore zakupki.gov.ru.
 * Поэтому документацию по ним ЕИС отдаёт бесплатно, без ключа Контура.
 *
 * ТЭК-Торг здесь не читается: его процедуры публикуются на площадке, а файлы
 * отдаёт её собственный метод (см. `tektorgDocumentFetch`). Этот модуль отвечает
 * только за страницы реестра, и `publishedInEis` разделяет два вопроса, которые
 * раньше задавали одному списку: «можно ли разобрать документацию» и «где искать
 * байты».
 */

/** Что нужно знать о закупке, чтобы найти её документацию. */
export interface TenderDocumentTarget {
  regNumber: string;
  law: TenderLaw;
  dataSource: TenderDataSource;
}

/**
 * Публикуется ли закупка этого источника в ЕИС под тем же номером.
 *
 * Отсюда растёт одно решение: обходит ли скрипт печатную форму и вкладку
 * документов реестра. Доступность глубокого разбора задаёт другой факт каталога
 * (`documents`), и до 02.10.2026 оба читали один список DOCUMENTATION_SOURCES.
 * ТЭК-Торг их развёл: байты он отдаёт сам, а номера площадки в реестре нет —
 * общий список послал бы загрузчик в ЕИС с номером «ЗП610102».
 */
export function publishedInEis(target: Pick<TenderDocumentTarget, "dataSource">): boolean {
  return sourceFacts(target.dataSource).publishedInEis;
}

/** Тип документа — значения повторяют CHECK-ограничение tender_documents. */
export type StoredDocumentType =
  | "notice"
  | "protocol"
  | "contract"
  | "attachment"
  | "other";

/** Источник документа — значения повторяют CHECK-ограничение tender_documents. */
export type StoredSourceType =
  | "torgi_open_data"
  | "eis_api"
  | "manual_upload"
  | "kontur_api"
  | "tektorg_api";

/** Текст документа, готовый к записи в tender_documents. */
export interface FetchedTenderDocument {
  filename: string;
  title: string;
  documentType: StoredDocumentType;
  sourceType: StoredSourceType;
  fileUrl: string;
  mimeType: string;
  text: string;
}

export interface TenderDocumentationResult {
  documents: FetchedTenderDocument[];
  /** Почему документов нет: источник не отдаёт текст, страница недоступна и т. п. */
  reason: string | null;
}

/** Загрузка HTML-страницы. Инжектируется, чтобы модуль можно было тестировать без сети. */
export type FetchHtml = (url: string) => Promise<string>;

/** Печатная форма извещения 44-ФЗ: полный текст закупки одной страницей. */
export function eisPrintFormUrl(regNumber: string): string {
  return `https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=${encodeURIComponent(regNumber)}`;
}

/** Карточка закупки 223-ФЗ: сведения о закупке, вложения отдаются отдельными запросами. */
export function eis223CardUrl(regNumber: string): string {
  return `https://zakupki.gov.ru/epz/order/notice/notice223/common-info.html?regNumber=${encodeURIComponent(regNumber)}`;
}

/** Меньше этого объёма страница считается пустой или служебной (404, заглушка). */
const MIN_USEFUL_TEXT = 200;

/** Маркер начала полезного содержимого на страницах ЕИС со сквозной навигацией. */
const CONTENT_MARKER = "Назад к результатам поиска";

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  laquo: "«",
  raquo: "»",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  deg: "°",
  plusmn: "±",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Раскрывает числовые и именованные HTML-сущности. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/**
 * Превращает HTML в читаемый текст: убирает скрипты, стили и комментарии,
 * ставит перенос строки на границах блоков, схлопывает пробелы.
 * Чистая функция — её же использует скрипт загрузки документов.
 */
export function htmlToText(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th|section|article|table|ul|ol|blockquote|header|footer)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(cleaned)
    .split("\n")
    .map((line) => line.replace(/[\s\u00A0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Отсекает сквозную навигацию ЕИС, оставляя только содержимое карточки. */
function cutSiteChrome(text: string): string {
  const index = text.indexOf(CONTENT_MARKER);
  return index === -1 ? text : text.slice(index + CONTENT_MARKER.length).trim();
}

/** Какую страницу и под каким именем сохранять для конкретной закупки. */
function planFetch(target: TenderDocumentTarget): {
  url: string;
  filename: string;
  title: string;
  documentType: StoredDocumentType;
} | null {
  if (!publishedInEis(target)) return null;
  if (target.law === "FZ_223") {
    return {
      url: eis223CardUrl(target.regNumber),
      filename: `purchase-card-${target.regNumber}.html`,
      title: "Карточка закупки 223-ФЗ (сведения о закупке)",
      documentType: "notice",
    };
  }
  if (target.law === "FZ_44" || target.law === "PP_RF_615") {
    return {
      url: eisPrintFormUrl(target.regNumber),
      filename: `print-form-${target.regNumber}.html`,
      title: "Извещение о закупке (печатная форма)",
      documentType: "notice",
    };
  }
  return null;
}

/** Почему документацию не получить — текст показывается пользователю и пишется в журнал. */
export function documentationUnavailableReason(target: TenderDocumentTarget): string {
  const facts = sourceFacts(target.dataSource);
  // Источник вообще не отдаёт байты: причина одна и та же в карточке и в журнале,
  // иначе два слоя рассказывали бы про одно и то же разными словами.
  if (facts.documents === "none") {
    return (
      facts.documentsReason ??
      `Источник ${target.dataSource} не отдаёт документацию.`
    );
  }
  // Источник документацию отдаёт, но не через реестр: этот модуль читает только
  // страницы ЕИС, а файлы площадки загружает отдельный прогон. Текст собран из
  // каталога, а не прописан для каждого источника, поэтому новая площадка с
  // собственными файлами не получит чужое объяснение.
  if (!facts.publishedInEis) {
    return (
      `${facts.title}: документацию загружает отдельный прогон — ` +
      "файлы отдаёт сама площадка, а не реестр."
    );
  }
  // Источник документацию отдаёт, но эта попытка не удалась — объясняем попытку,
  // а не источник. Ветка `default` с чужим текстом про ручную загрузку исчезла:
  // новый источник больше не может молча получить чужую причину.
  if (target.dataSource === "KONTUR") {
    return (
      `ЕИС не отдала документацию по номеру ${target.regNumber} — вероятно, закупка размещена ` +
      "только на электронной площадке, а не в ЕИС. Файлы перечисляет карточка Контур.Закупок: " +
      "её загружает отдельный платный прогон с российского адреса, плановая синхронизация " +
      "такой запрос не делает."
    );
  }
  return `ЕИС не публикует печатную форму для закона ${target.law}.`;
}

/**
 * Под каким именем документация этой закупки ляжет в tender_documents.
 * null — источник документов не отдаёт.
 *
 * Нужно, чтобы повторный прогон не скачивал заново 240 КБ печатной формы:
 * по имени файла видно, что текст уже в базе.
 */
export function expectedDocumentFilename(target: TenderDocumentTarget): string | null {
  return planFetch(target)?.filename ?? null;
}

/**
 * Загружает текст документации закупки.
 * Ошибки сети и пустые страницы не бросаются наружу: вызывающий код получает
 * пустой список и человекочитаемую причину.
 */
export async function fetchTenderDocumentation(
  target: TenderDocumentTarget,
  fetchHtml: FetchHtml,
): Promise<TenderDocumentationResult> {
  const plan = planFetch(target);
  if (!plan) {
    return { documents: [], reason: documentationUnavailableReason(target) };
  }

  let html: string;
  try {
    html = await fetchHtml(plan.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { documents: [], reason: `Не удалось загрузить ${plan.url}: ${message}` };
  }

  const text = cutSiteChrome(htmlToText(html));
  if (text.length < MIN_USEFUL_TEXT) {
    return {
      documents: [],
      reason: `Недостаточно текста на странице ${plan.url} (${text.length} знаков): «${text.slice(0, 120)}»`,
    };
  }

  return {
    documents: [
      {
        filename: plan.filename,
        title: plan.title,
        documentType: plan.documentType,
        sourceType: "eis_api",
        fileUrl: plan.url,
        mimeType: "text/html",
        text,
      },
    ],
    reason: null,
  };
}
