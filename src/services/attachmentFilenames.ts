/**
 * Имена файлов для записи в `tender_documents`.
 *
 * В базе строка документа ключуется парой `(tender_id, filename)`, и у ЕИС
 * уникальность имён обеспечивает обход вкладки документов. У площадки и у
 * агрегатора имя приходит от источника и может повториться: части одного архива
 * заказчики называют одинаково, а ТЭК-Торг транслитерирует имя файла из
 * `content-disposition`, где пробелы уже заменены подчёркиваниями. Повтор
 * перезаписал бы чужую строку, поэтому дубликаты получают номер по порядку.
 *
 * Модуль общий для всех источников, которые перечисляют файлы сами
 * (`konturDocumentFetch`, `tektorgDocumentFetch`): правило «номер перед
 * расширением» слишком легко нарушить, чтобы держать его в двух местах.
 */
import { fileExtension } from "@/services/fileFormats";

/**
 * Имена без повторов: тот же порядок, дубликаты пронумерованы.
 *
 * Повтором считается совпадение приведённого имени — без крайних пробелов и в
 * нижнем регистре: «Описание.DOCX» и «описание.docx» — это один и тот же файл
 * в глазах заказчика, а база хранит имя буквально, поэтому одна из двух строк
 * перезаписала бы другую и документ исчез бы из карточки.
 */
export function uniqueFilenames(names: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return names.map((name, index) => {
    const key = name.trim().toLowerCase();
    return (counts.get(key) ?? 0) > 1 ? numbered(name, index + 1) : name;
  });
}

/**
 * Имя с номером в конце, перед расширением: «Описание (2).docx».
 *
 * Номер обязан стоять до точки: и `detectFileType`, и парсер выбирают способ
 * чтения по расширению, поэтому «Описание.docx (2)» определилось бы как формат,
 * который проект не читает, и файл ушёл в пропуск вместо разбора.
 */
function numbered(fileName: string, ordinal: number): string {
  const extension = fileExtension(fileName);
  if (extension === "") return `${fileName} (${ordinal})`;
  const base = fileName.slice(0, fileName.length - extension.length - 1);
  return `${base} (${ordinal}).${extension}`;
}
