import type { TenderDocumentType } from "@/domain/enums";

/**
 * Тип документа по его названию или имени файла.
 *
 * Один набор правил на все источники: площадка редко отдаёт тип документа
 * отдельным полем, зато имя файла заказчики выбирают осмысленно — «Извещение…»,
 * «ТЗ…», «Проект контракта…». Держать копию правил в каждом адаптере значит
 * получить три разных ответа на один и тот же файл, а тип участвует в выборе,
 * какие документы разбирать первыми.
 *
 * Функция переехала сюда из `konturParser.ts` без изменения правил: Контур
 * подставляет в `documentTypeFromText` ещё и собственное поле типа из карточки,
 * а источники без такого поля (ТЭК-Торг) зовут `documentTypeFromFileName`.
 */

/** «ТЗ» как отдельное слово. \b в JS не работает с кириллицей — границы явные. */
const TZ_WORD = /(^|[^а-яёa-z0-9])тз([^а-яёa-z0-9]|$)/;

/** «ГПД» как отдельное слово: гражданско-правовой договор, т.е. проект контракта. */
const GPD_WORD = /(^|[^а-яёa-z0-9])гпд([^а-яёa-z0-9]|$)/;

/**
 * Разбор произвольного текста: названия документа, имени файла или обоих сразу.
 *
 * Порядок веток значим. «Проект контракта» содержит и «проект», и «контракт»,
 * поэтому проверка контракта стоит до проектной документации; то же с «ГПД» —
 * в 44-ФЗ проект контракта заказчики часто называют именно так, а файл пишут
 * как «Типовой проект ГПД …».
 */
export function documentTypeFromText(raw: string): TenderDocumentType {
  const text = raw.toLowerCase();
  if (!text.trim()) return "OTHER";
  if (text.includes("извещен") || text.includes("notice")) return "NOTICE";
  if (text.includes("техническ") || TZ_WORD.test(text) || text.includes("specification")) {
    return "TECHNICAL_SPEC";
  }
  if (
    text.includes("контракт") ||
    text.includes("договор") ||
    text.includes("contract") ||
    GPD_WORD.test(text)
  ) {
    return "DRAFT_CONTRACT";
  }
  if (text.includes("проектн") || text.includes("project") || text.includes("псд")) {
    return "PROJECT_DOCUMENTATION";
  }
  if (
    text.includes("обоснован") ||
    text.includes("нмцк") ||
    text.includes("нмцд") ||
    text.includes("cost")
  ) {
    return "COST_JUSTIFICATION";
  }
  // Протокол и всё прочее — OTHER. Отдельной ветки у протокола нет: результат
  // тот же, а перечислять «прочее» по одному значению значит копить мертвяк.
  return "OTHER";
}

/** Тип документа по имени файла: для источников без собственного поля типа. */
export function documentTypeFromFileName(fileName: string): TenderDocumentType {
  return documentTypeFromText(fileName);
}
