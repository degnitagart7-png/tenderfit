import type { EstimateGap } from "@/domain/estimate/types";

/**
 * Документы закупки без объёмов: понятное сообщение вместо пустой сметы.
 *
 * Зачем. Когда ни ведомости объёмов, ни сметы заказчика (ЛСР), ни сметы контракта,
 * ни таблицы с количествами в документах не нашлось, расчёт не падает: он
 * честно отдаёт смету на 0 ₽ без позиций. Для человека это выглядит как поломка
 * или как «объект ничего не стоит», хотя причина другая — документация не
 * называет объёмов (чертежи без спецификаций, ТЗ без количеств, а родные файлы
 * сметных программ `.gsfx` и `.xml` наш разбор не читает вовсе). Сообщение
 * называет, что было просмотрено, и говорит, что сделать: загрузить ведомость
 * или смету заказчика на странице «Смета».
 *
 * Канал тот же, что у остальных пробелов расчёта: `EstimateGap` в документе
 * сметы (вид `NO_VOLUME_SOURCE`). Он доезжает до выгрузок и до отчёта вместе с
 * документом; экран показывает его заметной плашкой, а не строкой в свёрнутом
 * списке — пустую смету нельзя оставлять без объяснения на самом виду.
 */

export const NO_VOLUME_SOURCE_KIND = "NO_VOLUME_SOURCE" as const;

/** Что известно о просмотренных документах. Поля, которых экран не знает, можно не передавать. */
export interface NoVolumesInput {
  /** Сколько документов дошло до расчёта; нет — предложение о числе опускается. */
  readonly documentCount?: number | null;
  /** Документы, которые читала модель и ведомости в них не нашла. */
  readonly documentsWithoutBill: readonly string[];
  /** Документы и файлы архивов, которые модель не читала как не содержащие объёмов. */
  readonly skippedNoVolumes?: readonly { readonly name: string }[];
  /**
   * Сколько фрагментов модель не смогла прочитать (сбой, а не отсутствие объёмов).
   * Не ноль — «объёмов нет» утверждать нельзя: они могли быть в непрочитанном.
   */
  readonly unreadChunks?: number;
}

export interface NoVolumesNotice {
  /** Заголовок плашки. */
  readonly title: string;
  /** Что найдено (и чего нет) в документах. */
  readonly found: string;
  /** Что сделать. */
  readonly action: string;
}

const MAX_NAMES = 4;

function quotedNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES).map((name) => `«${name}»`).join(", ");
  return names.length > MAX_NAMES ? `${shown} и ещё ${String(names.length - MAX_NAMES)}` : shown;
}

function documentsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "документ";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "документа";
  return "документов";
}

/** Что делать: одинаково для любой причины пустой сметы. */
const ACTION =
  "Загрузите ВОР, дефектную ведомость или смету заказчика (Excel/PDF из Гранд-Сметы или Smeta.RU) на странице «Смета». " +
  "Родные файлы сметных программ (.gsfx, .xml) мы не читаем — выгрузите их в Excel или PDF.";

export function noVolumesNotice(input: NoVolumesInput): NoVolumesNotice {
  const unread = input.unreadChunks ?? 0;

  if (unread > 0) {
    // Часть текста не прочитана: утверждать, что в документах объёмов нет, нельзя.
    return {
      title: "Объёмов работ для расчёта не нашлось",
      found:
        `Модель не смогла прочитать ${String(unread)} ${unread === 1 ? "фрагмент" : "фрагментов"} документации ` +
        "(сбой разбора), поэтому объёмы могли потеряться. Расчёт можно повторить.",
      action: `Если повтор не поможет. ${ACTION}`,
    };
  }

  const parts: string[] = [
    "В документах закупки нет ведомости объёмов, сметы заказчика и таблиц с количествами работ; " +
      "чертежи без спецификаций и ТЗ без объёмов объёмов не дают.",
  ];
  const count = input.documentCount ?? null;
  if (count !== null && count > 0) parts.push(`Просмотрено ${String(count)} ${documentsWord(count)}.`);
  if (input.documentsWithoutBill.length > 0) {
    parts.push(`Ведомости не нашлось в: ${quotedNames(input.documentsWithoutBill)}.`);
  }
  const skipped = (input.skippedNoVolumes ?? []).map((item) => item.name);
  if (skipped.length > 0) {
    parts.push(`Как не содержащие объёмов не читались: ${quotedNames(skipped)}.`);
  }

  return {
    title: "Объёмов работ для расчёта не нашлось",
    found: parts.join(" "),
    action: ACTION,
  };
}

/** Одной строкой: текст пробела документа и подпись в отчёте. */
export function noVolumesMessage(input: NoVolumesInput): string {
  const notice = noVolumesNotice(input);
  return `${notice.title}. ${notice.found} ${notice.action}`;
}

/** Пробел «объёмов нет» для документа сметы. */
export function noVolumesGap(input: NoVolumesInput): EstimateGap {
  return { kind: NO_VOLUME_SOURCE_KIND, message: noVolumesMessage(input), code: null, baseType: null };
}

/** Что экрану нужно от результата расчёта, чтобы решить, показывать ли плашку. */
export interface NoVolumesResultView {
  readonly document: { readonly gaps: readonly EstimateGap[] };
  readonly billItems: number;
  readonly volumeSource?: unknown;
  readonly documentsWithoutBill: readonly string[];
  readonly skippedNoVolumes?: readonly { readonly name: string }[];
}

/**
 * Плашка для экрана; null — объёмы у расчёта есть.
 *
 * Пустой расчёт — это ноль позиций и ни одного источника объёмов. Текст берётся
 * из пробела документа, когда он есть (там известно и число документов, и сбои
 * чтения); у смет, посчитанных до появления пробела, — собирается по тому, что
 * есть в результате.
 */
export function noVolumesNoticeFor(result: NoVolumesResultView): NoVolumesNotice | null {
  if (result.billItems > 0 || result.volumeSource != null) return null;

  const unreadChunks = result.document.gaps.filter((gap) => gap.kind === "BILL_CHUNK_UNREAD").length;
  const notice = noVolumesNotice({
    documentsWithoutBill: result.documentsWithoutBill,
    ...(result.skippedNoVolumes === undefined ? {} : { skippedNoVolumes: result.skippedNoVolumes }),
    unreadChunks,
  });

  const gap = result.document.gaps.find((item) => item.kind === NO_VOLUME_SOURCE_KIND);
  if (gap === undefined) return notice;
  // Пробел несёт полный текст одной строкой; плашка делит его на «что найдено» и «что делать».
  const body = gap.message.replace(`${notice.title}. `, "");
  const at = body.lastIndexOf(notice.action);
  return at < 0 ? { ...notice, found: body, action: "" } : { ...notice, found: body.slice(0, at).trim(), action: notice.action };
}
