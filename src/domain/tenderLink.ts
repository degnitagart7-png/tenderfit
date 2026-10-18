/**
 * Ссылка или номер закупки, вставленные человеком, → реестровый номер ЕИС.
 *
 * Зачем. Добавлять закупку руками (реестровый номер, предмет, НМЦК, сроки) или
 * CSV-файлом никто не хочет (замечание владельца 13.10.2026): у человека есть
 * ссылка на закупку в ЕИС, и по ней сервис сам находит закупку, скачивает
 * документацию и запускает разбор. Номер ищется так:
 *  - в ссылке ЕИС — параметр `regNumber` (карточки 44-ФЗ и 223-ФЗ, печатная форма,
 *    вкладка документов);
 *  - в любом тексте — реестровый номер: 19 цифр у 44-ФЗ, 11 цифр у 223-ФЗ. Так
 *    срабатывает и просто номер, и ссылка площадки, в которой номер ЕИС напечатан.
 *
 * Ссылки ЕИС вида `…?noticeInfoId=…` номера не содержат: по внутреннему
 * идентификатору ЕИС закупку не найти, и об этом честно говорится.
 */

export type TenderLinkResult =
  | { ok: true; regNumber: string }
  | { ok: false; error: string };

/** Реестровый номер ЕИС: 19 цифр (44-ФЗ) или 11 цифр (223-ФЗ). */
const REG_NUMBER = /(?<!\d)(\d{19}|\d{11})(?!\d)/;

export function parseTenderLink(input: string): TenderLinkResult {
  const text = input.trim();
  if (text === "") return { ok: false, error: "Вставьте ссылку на закупку из ЕИС или её номер." };

  let url: URL | null = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }

  if (url !== null) {
    const fromParam = url.searchParams.get("regNumber")?.trim() ?? "";
    if (/^(\d{19}|\d{11})$/.test(fromParam)) {
      return { ok: true, regNumber: fromParam };
    }
  }

  const found = REG_NUMBER.exec(text);
  if (found !== null) return { ok: true, regNumber: found[1]! };

  if (url !== null && /(^|\.)zakupki\.gov\.ru$/i.test(url.hostname) && url.searchParams.has("noticeInfoId")) {
    return {
      ok: false,
      error:
        "В этой ссылке ЕИС нет реестрового номера. Откройте карточку закупки и скопируйте номер (19 или 11 цифр) или ссылку из адресной строки вкладки «Общая информация».",
    };
  }
  return {
    ok: false,
    error:
      "Не нашёл номер закупки. Вставьте ссылку на карточку в ЕИС (zakupki.gov.ru) или реестровый номер: 19 цифр для 44-ФЗ, 11 цифр для 223-ФЗ.",
  };
}
