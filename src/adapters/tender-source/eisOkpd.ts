import { isEisBlockedError } from "@/lib/eisGate";
import type { TenderLaw } from "@/types/database";

/**
 * ОКПД2 из карточки ЕИС.
 *
 * Ни у одной закупки в базе не было кода классификатора: у Контура в выдаче его
 * нет, у Сбербанк-АСТ он только в карточке, а ЕИС отдаёт его на вкладке
 * карточки, куда адаптер выдачу читал, но не заходил. Код нужен поиску: запрос
 * «69.10» находит закупки по коду, а не по слову, и омонимы («юридическое
 * лицо») на коде не возникают.
 *
 * Разбор построен по настоящей разметке, снятой 04.10.2026 с живого сайта:
 *  - 44-ФЗ — печатная форма `printForm/view.html?regNumber=`, код стоит в
 *    ячейке таблицы «Объект закупки»;
 *  - 223-ФЗ — вкладка лотов, ссылку на которую даёт общая карточка; в колонке
 *    «Классификация по ОКПД2» код стоит перед названием, а рядом колонка ОКВЭД2
 *    с короткими кодами.
 *
 * Модуль без сети: загрузчик страниц передаётся параметром, чтобы тест
 * подставлял готовую разметку, а адаптер — свой, с ограничением частоты.
 */

/**
 * Код ОКПД2: четыре группы цифр («26.20.14.120»).
 *
 * Именно четыре, а не «две-три»: у ОКВЭД2 коды короче («26.20»), а даты в
 * двузначном виде («12.09.26») и номера («3.14.15») выглядели бы как коды.
 * Границы — не цифра и не точка по обе стороны: кусок более длинного числа
 * («126.20.14.1200») кодом не считается. Суффикс КТРУ («-00000001») стоит после
 * границы и в код не входит.
 */
const OKPD2_CODE = /(?<![\d.])\d{2}\.\d{2}\.\d{2}\.\d{1,3}(?![\d.])/g;

/** Коды ОКПД2 со страницы, без повторов, в порядке первого вхождения. */
export function extractOkpd2Codes(html: string): string[] {
  const seen = new Set<string>();
  for (const match of html.matchAll(OKPD2_CODE)) {
    seen.add(match[0]);
  }
  return [...seen];
}

/**
 * Ссылка на вкладку лотов 223-ФЗ из общей карточки.
 *
 * Берётся сырой текст атрибута, а меняется только «&amp;»: в ссылке стоит
 * «&noticeGuid=», а «&not» — устаревшая HTML-сущность без точки с запятой.
 * Разворачивающая сущности библиотека превратила бы её в «¬iceGuid», и запрос
 * ушёл бы по ссылке, которой нет.
 */
export function findLotListHref(html: string): string | null {
  const match = /href="([^"]*lot-list\.html[^"]*)"/.exec(html);
  const raw = match?.[1];
  return raw === undefined ? null : raw.replace(/&amp;/g, "&");
}

export type HtmlGetter = (url: string) => Promise<string>;

export interface EisCardRef {
  regNumber: string;
  law: TenderLaw;
  /** Адрес общей карточки (нужен 223-ФЗ); для 44-ФЗ путь строится по номеру. */
  cardUrl: string;
}

/**
 * Достаёт коды ОКПД2 закупки из её карточки.
 *
 * Сбой возвращает пустой список, а не исключение: код — улучшение выдачи, и
 * падение прогона из-за одной недоступной карточки стоило бы больше, чем
 * потерянный код. Следующий прогон попробует снова: закупка без кода остаётся
 * кандидатом.
 *
 * Исключение — блокировка ЕИС (`EisBlockedError`): она пробрасывается. Это не
 * «карточка не ответила», а сигнал остановить обход карточек: следующие запросы
 * затвор всё равно отклонит, и прогон должен честно сказать, что ЕИС не пускает.
 */
export async function fetchEisOkpd2(
  ref: EisCardRef,
  get: HtmlGetter,
  baseUrl = "https://zakupki.gov.ru",
): Promise<string[]> {
  try {
    if (ref.law === "FZ_44") {
      const html = await get(
        `${baseUrl}/epz/order/notice/printForm/view.html?regNumber=${encodeURIComponent(ref.regNumber)}`,
      );
      return extractOkpd2Codes(html);
    }

    if (ref.law === "FZ_223") {
      if (ref.cardUrl === "") return [];
      const card = await get(ref.cardUrl);
      const href = findLotListHref(card);
      if (href === null) return [];
      const lots = await get(href.startsWith("http") ? href : `${baseUrl}${href}`);
      return extractOkpd2Codes(lots);
    }

    return [];
  } catch (err) {
    if (isEisBlockedError(err)) throw err;
    return [];
  }
}
