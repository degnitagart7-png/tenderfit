/**
 * Разбор CSV из открытых данных ФГИС ЦС.
 *
 * Зачем свой, а не библиотека. Файлы выгрузки — не «просто CSV»: разделитель
 * «;», кодировка cp1251, и хотя бы одно поле заключено в кавычки с переводом
 * строки внутри. Наивный `text.split("\n")` рвёт такую запись пополам, и разрыв
 * не выглядит ошибкой: часть полей просто съезжает. В `price-zones.csv` так
 * устроена строка Архангельской области, где наименование зоны — «Архангельская
 * область районы островов Северного Ледовитого океана и его морей».
 *
 * Декодирование cp1251 остаётся за вызывающим кодом: сюда приходит уже текст.
 * Модуль чистый — ни файлов, ни сети.
 *
 * Значения возвращаются как есть, включая переводы строк внутри кавычек и
 * пробелы. Приводить наименование к одной строке — задача потребителя, потому
 * что для другого поля тот же перенос может быть частью данных.
 */

/**
 * Разбирает текст на записи.
 *
 * Пустые записи (все поля пустые) пропускаются: выгрузки заканчиваются переводом
 * строки, а иногда содержат разделительные строки из одних разделителей.
 */
export function parseCsvRecords(text: string, delimiter = ";"): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  // BOM в начале файла иначе попала бы в первое поле первой записи.
  if (text.charCodeAt(0) === 0xfeff) index = 1;

  for (; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inQuotes) {
      if (char !== '"') {
        field += char;
        continue;
      }
      // «""» внутри кавычек — экранированная кавычка, одиночная — конец поля.
      if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = false;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      // CRLF: второй символ пары пропускаем, иначе получится пустая запись.
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      field = "";
      if (!isBlank(record)) records.push(record);
      record = [];
      continue;
    }
    field += char;
  }

  // Хвост без перевода строки в конце файла.
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    if (!isBlank(record)) records.push(record);
  }

  return records;
}

function isBlank(record: readonly string[]): boolean {
  return record.every((field) => field.trim().length === 0);
}

/**
 * Заголовок и данные.
 *
 * Возвращает null, если записей меньше двух: файл без строк данных нельзя
 * молча считать пустым результатом — вызывающий код обязан сообщить об этом.
 */
export function splitCsvHeader(
  records: readonly (readonly string[])[],
): { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] } | null {
  const header = records[0];
  if (header === undefined || records.length < 2) return null;
  return { header, rows: records.slice(1) };
}
