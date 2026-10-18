import { UNKNOWN_REGION } from "@/domain/entities";
import { regionFromAddress } from "@/domain/regions";

/**
 * Регион закупки по тексту документов.
 *
 * Зачем. У закупок 223-ФЗ в карточке нередко нет ни региона, ни адреса поставки, и без сметы
 * заказчика ценовую зону выбрать не по чему: расчёт падает с «Регион закупки не определён». Но
 * извещение и карточка закупки, которые лежат среди документов, место поставки называют:
 * «Место поставки товара, выполнения работы, оказания услуги: Республика Бурятия, г. Улан-Удэ…».
 *
 * Принцип прежний: не угадывать. Берётся значение только за подписью поля («Место поставки…»,
 * «Регион», «Субъект РФ», «Адрес объекта», шапка ЛСР/ВОР «Наименование субъекта Российской Федерации»,
 * «… расположенного по адресу:») и только если `regionFromAddress` узнал в нём субъект.
 * Адрес и название заказчика не используются: он вполне может сидеть в другом регионе, чем объект.
 * Юридический и почтовый адрес заказчика, адрес электронной площадки и «по адресу» в предложении про заказчика
 * (`CUSTOMER_CONTEXT`) тоже не берутся.
 * Модуль чистый: ни сети, ни базы.
 */

export interface DocumentRegion {
  /** Каноническое наименование субъекта РФ. */
  readonly region: string;
  /** Текст, из которого он узнан: уходит в выбор зоны как адрес (по нему ищется муниципалитет). */
  readonly address: string;
  /** Откуда взято: документ и подпись поля — для журнала и отчёта. */
  readonly source: string;
}

/** Подписи полей, по приоритету: сначала место поставки или работ, затем регион как таковой. */
const FIELD_LABELS: readonly { readonly label: string; readonly pattern: RegExp; readonly contextual?: boolean }[] = [
  {
    label: "Место поставки",
    pattern:
      /(?<![\p{L}])(?:адрес\s+(?:\(место\)\s+)?(?:места\s+)?(?:поставки|выполнения\s+работ|оказания\s+услуг)|место\s+(?:\(?адрес\)?\s+)?(?:поставки|выполнения\s+работ\w*|оказания\s+услуг\w*|производства\s+работ)(?:\s+товара)?(?:\s*,\s*(?:выполнения\s+работ\w*|оказания\s+услуг\w*))*(?:\s*(?:,|или)\s*(?:выполнения\s+работ\w*|оказания\s+услуг\w*))*)(?![\p{L}])/giu,
  },
  {
    label: "Адрес объекта",
    pattern:
      /(?<![\p{L}])(?:адрес|местонахождение|местоположение)(?:\s*\([^)\n]{0,40}\))?\s+объекта(?:\s+(?:капитального\s+)?(?:строительства|ремонта|закупки|выполнения\s+работ))?(?![\p{L}])/giu,
  },
  // Шапка ЛСР и ВОР: «Наименование субъекта Российской Федерации ,,,,,,50. Московская область».
  { label: "Субъект РФ", pattern: /(?<![\p{L}])(?:наименование\s+)?субъект\p{L}*\s+(?:рф|российской\s+федерации)(?![\p{L}])/giu },
  { label: "Регион", pattern: /(?<![\p{L}])регион(?:\s+поставки)?(?![\p{L}])/giu },
  // «здания, расположенного по адресу: …», «по адресу: …»: берётся, только если в предложении речь об объекте, а не о заказчике (`CUSTOMER_CONTEXT`).
  { label: "по адресу", pattern: /(?<![\p{L}])(?:расположенн\p{L}*\s+)?по\s+адресу(?![\p{L}])/giu, contextual: true },
];

/** Документ — извещение или карточка закупки: там место поставки названо чаще всего и надёжнее всего. */
const NOTICE_NAME = /извещени|карточк\p{L}*\s+закупк|информационн\p{L}*\s+карт/iu;

/** Сколько знаков после подписи поля читается как значение. */
const VALUE_CHARS = 300;

/**
 * Слова, по которым «по адресу» относится к заказчику, подрядчику или площадке, а не к объекту: юридический и почтовый адрес, адрес электронной площадки.
 * Объект в таком предложении не назван, и регион заказчика объекту не приписывается.
 */
const CUSTOMER_CONTEXT = /заказчик|юридическ|почтов|электронн|площадк|организатор|исполнител|подрядчик|поставщик|оператор|покупател|продавец|контрагент|банк|реквизит|телефон/iu;

/** Слова, по которым «по адресу» относится к объекту работ. */
const OBJECT_CONTEXT = /объект|работ|выполн|расположен|здани|помещени|сооружени|ремонт|строительств|реконструкц|территори|участок/iu;

/** Сколько знаков перед подписью читается как её окружение. */
const CONTEXT_CHARS = 200;

/** Предложение до подписи: от начала строки или последней точки после слова (не после «г.», «д.»), не длиннее `CONTEXT_CHARS`. */
function sentenceBefore(text: string, at: number): string {
  const from = Math.max(0, at - CONTEXT_CHARS);
  const window = text.slice(from, at);
  const line = window.slice(window.lastIndexOf("\n") + 1);
  const cuts = [...line.matchAll(/(?<![\p{L}])\p{L}{3,}[.;]\s+(?=\p{Lu})|[;]\s+/gu)];
  const last = cuts.at(-1);
  return last === undefined ? line : line.slice((last.index ?? 0) + last[0].length);
}

/** Строка из подписей-пояснений и разделителей таблицы: «(наименование)», «|---|», «_____». Значением не бывает. */
const DECORATION = /^(?:\([^)]*\)|[|+\-–—_=:;,.\s]+)$/u;

/**
 * Значение поля: текст после подписи до конца строки, а если он пуст — первая следующая содержательная строка.
 *
 * Пустым значение считается и тогда, когда в строке одни разделители ячеек: после подписи в csv-листе xlsx идут запятые («…Федерации ,,,,,,50. Московская область»,
 * «Адрес объекта,,,\nМосковская область») — они, как табуляция и «|», в значение не входят. Печатная форма раскладывает таблицу так, что значение — в следующей строке
 * под подписью, иногда через строку-пояснение «(наименование)».
 */
function valueAfter(text: string, labelEnd: number): string {
  const rest = text.slice(labelEnd, labelEnd + VALUE_CHARS * 2);
  const stripped = rest.replace(/^[ \t\u00a0:;|,\-–—.]+/u, "");
  const lines = stripped.split("\n");
  const first = (lines[0] ?? "").trim();
  if (first !== "" && !DECORATION.test(first)) return first.slice(0, VALUE_CHARS);
  const next = lines.slice(1).map((line) => line.trim().replace(/^[ \t|,;:\-–—.]+/u, "")).find((line) => line !== "" && !DECORATION.test(line));
  return (next ?? "").slice(0, VALUE_CHARS);
}

function searchDocument(name: string, text: string): DocumentRegion | null {
  for (const field of FIELD_LABELS) {
    for (const match of text.matchAll(field.pattern)) {
      const at = match.index ?? 0;
      if (field.contextual === true) {
        const before = sentenceBefore(text, at);
        if (CUSTOMER_CONTEXT.test(before) || !OBJECT_CONTEXT.test(`${before}${match[0]}`)) continue;
      }
      const value = valueAfter(text, at + match[0].length);
      if (value === "") continue;
      const region = regionFromAddress(value);
      if (region !== UNKNOWN_REGION) {
        return { region, address: value, source: `${name}: «${match[0].replace(/\s+/g, " ")}»` };
      }
    }
  }
  return null;
}

/**
 * Регион по документам. Сначала извещения и карточки закупки, затем остальные документы;
 * внутри документа — по приоритету подписей. Нигде не нашёлся — null.
 */
export function regionFromDocuments(documents: readonly { readonly name: string; readonly text: string }[]): DocumentRegion | null {
  const ordered = [
    ...documents.filter((document) => NOTICE_NAME.test(document.name)),
    ...documents.filter((document) => !NOTICE_NAME.test(document.name)),
  ];
  for (const document of ordered) {
    const found = searchDocument(document.name, document.text);
    if (found !== null) return found;
  }
  return null;
}

export interface ZoneTender {
  readonly region: string | null;
  readonly address: string | null;
  readonly customerName: string | null;
}

/** Регион или адрес закупки опознаются: тогда подсказка из документов не нужна. */
function isLocated(tender: ZoneTender): boolean {
  const region = (tender.region ?? "").trim();
  if (region !== "" && region !== UNKNOWN_REGION && regionFromAddress(region) !== UNKNOWN_REGION) return true;
  return regionFromAddress(tender.address ?? "") !== UNKNOWN_REGION;
}

/**
 * Закупка для выбора ценовой зоны. Регион известен — закупка возвращается как есть. Неизвестен
 * (нет закупки в базе или в карточке нет региона и адреса) — берётся из документов; `note` говорит
 * об этом словами, чтобы выбор зоны по региону из документов не прошёл незаметно.
 */
export function resolveZoneTender(
  tender: ZoneTender | null,
  documents: readonly { readonly name: string; readonly text: string }[],
): { readonly tender: ZoneTender | null; readonly note: string | null } {
  if (tender !== null && isLocated(tender)) return { tender, note: null };
  const found = regionFromDocuments(documents);
  if (found === null) return { tender, note: null };
  return {
    tender: { region: found.region, address: found.address, customerName: tender?.customerName ?? null },
    note: `регион закупки в карточке не указан; взят из документов — ${found.region} (${found.source})`,
  };
}
