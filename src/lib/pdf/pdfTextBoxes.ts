/**
 * Извлечение слов с координатами из текстового слоя PDF.
 *
 * Отличие от `readPdf` в attachmentParser.ts: тот склеивает элементы страницы
 * в одну строку и годится для связного текста, здесь же нужны рамки. Таблица
 * в PDF не размечена ничем, кроме расположения слов, поэтому без координат
 * колонки восстановить невозможно в принципе — см. tableGrid.ts.
 *
 * Сборка pdfjs — legacy, по той же причине, что и в attachmentParser.ts:
 * обычная вызывает `Uint8Array.prototype.toHex`, которого нет в Node вплоть до
 * 25-й версии.
 */

import type { TextBox } from "@/lib/pdf/tableGrid";

/** Матрица PDF: [a, b, c, d, e, f]. */
export type Matrix = readonly [number, number, number, number, number, number];

/** Что удалось прочитать с одной страницы. */
export interface PdfPageBoxes {
  /** Номер страницы, с единицы. */
  readonly page: number;
  readonly boxes: readonly TextBox[];
  /**
   * Сколько элементов пропущено из-за поворота.
   *
   * Повёрнутый текст — обычно вертикальная подпись колонки. Его рамка не
   * выровнена по осям, и вписать её в сетку из прямоугольников нельзя без
   * вранья. Поэтому такие элементы не попадают в разбор, но и не исчезают
   * молча: число видно вызывающему коду, и по нему решают, доверять ли
   * странице.
   */
  readonly rotatedSkipped: number;
}

/** Результат чтения документа. */
export interface PdfBoxesResult {
  readonly pages: readonly PdfPageBoxes[];
  /**
   * Есть ли в документе текстовый слой вообще.
   *
   * Если слов нет ни на одной странице, это скан, и дальше нужен не разбор
   * таблицы, а распознавание. Отличать эти два случая обязательно: пустая
   * сетка из скана и пустая сетка из сломанного разбора чинятся по-разному.
   */
  readonly hasTextLayer: boolean;
}

/** Перемножение матриц PDF — то же, что `pdfjs.Util.transform`. */
export function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

/**
 * Приводит массив чисел к матрице.
 *
 * pdfjs объявляет `viewport.transform` как `number[]`, то есть по типу он может
 * оказаться любой длины. Приведение через `as` здесь было бы обещанием, которое
 * компилятор проверить не может, поэтому длина проверяется, а короткий массив
 * даёт null — страница просто не разбирается.
 */
export function toMatrix(values: readonly number[]): Matrix | null {
  if (values.length < 6) return null;
  return [
    values[0] ?? 0,
    values[1] ?? 0,
    values[2] ?? 0,
    values[3] ?? 0,
    values[4] ?? 0,
    values[5] ?? 0,
  ];
}

/** Элемент текстового слоя в том виде, в каком его отдаёт pdfjs. */
export interface PdfTextItem {
  readonly str: string;
  readonly width: number;
  readonly height: number;
  readonly transform: readonly number[];
}

/**
 * Переводит элемент pdfjs в рамку в координатах чтения.
 *
 * PDF считает y снизу вверх, а `transform[5]` указывает на базовую линию
 * текста, а не на верх строки. Матрица области просмотра переворачивает ось,
 * после чего верхний край получается вычитанием высоты шрифта из базовой
 * линии. Без обоих преобразований строки страницы выстроятся снизу вверх, и
 * таблица окажется перевёрнутой — причём выглядеть это будет как правильная
 * таблица с неправильным порядком строк.
 *
 * Функция чистая: матрица приходит снаружи, pdfjs здесь не нужен. Это и даёт
 * возможность проверить преобразование тестом, не заводя настоящий PDF.
 */
export function textItemToBox(item: PdfTextItem, viewport: Matrix): TextBox | null {
  const raw = item.transform;
  if (raw.length < 6) return null;

  const matrix = multiplyMatrix(viewport, [
    raw[0] ?? 0,
    raw[1] ?? 0,
    raw[2] ?? 0,
    raw[3] ?? 0,
    raw[4] ?? 0,
    raw[5] ?? 0,
  ]);

  // Наклон по обеим осям означает поворот: рамка перестаёт быть
  // прямоугольником, выровненным по осям, и в сетку не ложится.
  if (Math.abs(matrix[1]) > 0.01 && Math.abs(matrix[2]) > 0.01) return null;

  const height = Math.hypot(matrix[2], matrix[3]) || item.height;

  /*
    Ширина берётся как есть, без домножения на масштаб матрицы.

    Это проверено сквозным прогоном, а не выведено из документации: pdfjs уже
    возвращает `width` с учётом кегля, и повторное умножение на масштаб (для
    кегля 10 — десятикратное) раздувает рамки так, что они смыкаются. Пустых
    полос между колонками не остаётся, вся страница схлопывается в одну колонку,
    а слова склеиваются без пробелов. Выглядит это как «таблица не распозналась»,
    и искать причину пришлось бы в поиске границ, где её нет.

    Отсюда требование к области просмотра: масштаб строго 1. При другом
    масштабе x и y поедут, а ширина — нет, и рамки разъедутся с координатами.
  */
  return {
    text: item.str,
    x: matrix[4],
    y: matrix[5] - height,
    width: item.width,
    height,
  };
}

/**
 * Читает все страницы документа.
 *
 * `verbosity: 0` — уровень ошибок: без него pdfjs печатает сотни строк про
 * стандартные шрифты, которые нужны для отрисовки, а не для текста.
 */
export async function readPdfTextBoxes(bytes: Uint8Array): Promise<PdfBoxesResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  /*
    Копия, а не сам массив: pdfjs забирает буфер себе и отсоединяет его от
    вызывающего кода. Массив, отданный сюда, после вызова становится пустым, и
    второе обращение к тем же байтам падает с «Cannot transfer object of
    unsupported type» — ошибкой, по тексту которой причину не угадать.

    Байты сюда приходят из скачанного файла, и вызывающий код вправе
    рассчитывать, что они переживут разбор: то же вложение может понадобиться и
    для извлечения текста, и для подсчёта контрольной суммы. Разрушать чужой
    массив ради экономии одной копии — плохой размен.
  */
  const document_ = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;

  const pages: PdfPageBoxes[] = [];

  for (let number = 1; number <= document_.numPages; number += 1) {
    const page = await document_.getPage(number);
    // Масштаб 1: единицы страницы, а не пикселей. Пороги в tableGrid.ts
    // выводятся из высоты слов, поэтому масштаб на разбор не влияет, а
    // единицы страницы проще сверять с самим документом.
    const viewport = page.getViewport({ scale: 1 });
    const matrix = toMatrix(viewport.transform);
    if (matrix === null) {
      pages.push({ page: number, boxes: [], rotatedSkipped: 0 });
      continue;
    }
    const content = await page.getTextContent();

    const boxes: TextBox[] = [];
    let rotatedSkipped = 0;

    for (const item of content.items) {
      if (!("str" in item)) continue;
      const box = textItemToBox(item as PdfTextItem, matrix);
      if (box === null) {
        rotatedSkipped += 1;
        continue;
      }
      if (box.text.trim().length === 0) continue;
      boxes.push(box);
    }

    pages.push({ page: number, boxes, rotatedSkipped });
  }

  return {
    pages,
    hasTextLayer: pages.some((page) => page.boxes.length > 0),
  };
}
