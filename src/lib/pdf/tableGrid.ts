/**
 * Восстановление таблицы из слов с координатами.
 *
 * Зачем отдельный модуль. Обычное извлечение текста из PDF склеивает слова
 * страницы в одну строку — так устроен `readPdf` в attachmentParser.ts, и для
 * связного текста этого хватает. Для таблицы не хватает принципиально: порядок
 * элементов в PDF не обязан совпадать с порядком чтения, а склейка через
 * пробел превращает строку «91.01.01-035 | бульдозер | 1 339,47» в набор слов,
 * из которого уже не видно, где кончилась одна колонка и началась другая.
 * Колонки в PDF не размечены вовсе: их создаёт только расположение слов.
 *
 * Поэтому здесь работа идёт не с текстом, а с прямоугольниками. Источник может
 * быть любым: текстовый слой PDF отдаёт рамки слов, и распознавание скана
 * отдаёт то же самое. Модуль об этом не знает и знать не должен.
 *
 * Модуль чистый: ни файлов, ни сети, ни pdfjs. Извлечение рамок живёт в
 * pdfTextBoxes.ts, потому что тянет за собой динамический импорт pdfjs, а
 * webpack собирает достижимые динамические импорты в чанки — та же причина,
 * по которой разведены fileFormats.ts и attachmentParser.ts.
 *
 * Система координат: x вправо, y вниз, начало в левом верхнем углу страницы.
 * PDF считает y снизу вверх, и перевод — забота извлекающего модуля: алгоритмам
 * здесь нужен порядок чтения, а не соглашение формата.
 */

/** Слово на странице вместе с его рамкой. */
export interface TextBox {
  readonly text: string;
  /** Левый край, в единицах страницы. */
  readonly x: number;
  /** Верхний край. Ось направлена вниз: меньше y — выше на странице. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Вертикальная полоса страницы, занятая одной колонкой. */
export interface ColumnBand {
  readonly left: number;
  readonly right: number;
}

/** Разобранная таблица одной страницы. */
export interface TableGrid {
  /** Ячейки: строки сверху вниз, колонки слева направо. */
  readonly rows: readonly (readonly string[])[];
  /** Границы колонок — нужны, чтобы объяснить разбор, а не только выдать его. */
  readonly columns: readonly ColumnBand[];
  /**
   * Строки, где слово пересекло границу колонок.
   *
   * Обычно это заголовок над несколькими колонками или объединённая ячейка.
   * Молча разрезать такое слово нельзя: в таблице индексов заголовок
   * «Индексы к элементам прямых затрат» стоит над тремя колонками, и разрез по
   * границе превратил бы его в три обрывка, каждый из которых выглядит как
   * подпись отдельной колонки.
   */
  readonly spanningRows: readonly number[];
}

/** Настройки разбора. Значения по умолчанию выводятся из самой страницы. */
export interface TableGridOptions {
  /**
   * Насколько слова могут расходиться по вертикали, оставаясь одной строкой.
   * По умолчанию — половина медианной высоты слова.
   */
  readonly rowTolerance?: number;
  /**
   * Ширина пустой полосы, которая считается границей колонок.
   * По умолчанию — 0,9 медианной высоты слова: примерно пробел с запасом.
   */
  readonly minColumnGap?: number;
}

/** Медиана непустого набора. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Группирует слова в строки по вертикали.
 *
 * Сравниваются середины, а не верхние края: в одной строке таблицы соседствуют
 * кегли разного размера — номер позиции мельче наименования, — и верхние края
 * у них не совпадают, тогда как середины лежат на одной линии.
 *
 * Порог берётся от высоты слова, а не задаётся числом: один и тот же PDF может
 * быть свёрстан в пунктах или в тысячных долях дюйма, и константа, подобранная
 * на одном документе, на другом разрежет строки пополам.
 */
export function groupIntoRows(
  boxes: readonly TextBox[],
  tolerance?: number,
): TextBox[][] {
  const usable = boxes.filter((box) => box.text.trim().length > 0);
  if (usable.length === 0) return [];

  const step = tolerance ?? median(usable.map((box) => box.height)) * 0.5;
  const centre = (box: TextBox): number => box.y + box.height / 2;

  const sorted = [...usable].sort((a, b) => centre(a) - centre(b));
  const rows: TextBox[][] = [];
  let current: TextBox[] = [];
  let anchor = Number.NaN;

  for (const box of sorted) {
    if (current.length === 0 || Math.abs(centre(box) - anchor) <= step) {
      if (current.length === 0) anchor = centre(box);
      current.push(box);
      continue;
    }
    rows.push(current);
    current = [box];
    anchor = centre(box);
  }
  if (current.length > 0) rows.push(current);

  // Внутри строки порядок чтения — слева направо, независимо от того, в каком
  // порядке слова лежали в потоке PDF.
  return rows.map((row) => [...row].sort((a, b) => a.x - b.x));
}

/**
 * Находит границы колонок по пустым вертикальным полосам.
 *
 * Считаются не левые края слов, а занятость оси x: колонка чисел выровнена по
 * правому краю, и её левые края расходятся тем сильнее, чем разряднее числа.
 * Кластеризация по левому краю развалила бы такую колонку на несколько. А вот
 * пустая полоса между колонками держится на всех строках сразу — это и есть
 * устойчивый признак.
 *
 * Полоса ищется по всем словам страницы вместе: на отдельной строке ячейка
 * может быть пустой, и «пустая полоса» там окажется шире настоящей.
 */
export function detectColumns(
  boxes: readonly TextBox[],
  minGap?: number,
  rowTolerance?: number,
): ColumnBand[] {
  const all = boxes.filter((box) => box.text.trim().length > 0 && box.width > 0);
  if (all.length === 0) return [];

  /*
    Границы ищутся только по строкам, где слов больше одного.

    Одинокое слово о колонках не говорит ничего, а заголовок во всю ширину
    таблицы — говорит неправду: он перекрывает все пустые полосы сразу, и
    занятость оси становится одним сплошным отрезком. Тогда вся страница
    оказывается одной колонкой, причём молча — сетка выглядит разобранной.
    Именно так ведёт себя шапка «Индексы к элементам прямых затрат» над тремя
    колонками письма Минстроя.

    Если строк из двух слов нет вовсе, таблица одноколоночная, и тогда берутся
    все слова: отказ вернуть хоть что-то был бы хуже.
  */
  const rows = groupIntoRows(all, rowTolerance);
  const multi = rows.filter((row) => row.length > 1).flat();
  const usable = multi.length > 0 ? multi : all;

  const gap = minGap ?? median(usable.map((box) => box.height)) * 0.9;

  const spans = usable
    .map((box) => ({ left: box.x, right: box.x + box.width }))
    .sort((a, b) => a.left - b.left);

  // Склеиваем перекрывающиеся и соприкасающиеся отрезки: остаётся занятость оси.
  const occupied: { left: number; right: number }[] = [];
  for (const span of spans) {
    const last = occupied[occupied.length - 1];
    if (last !== undefined && span.left <= last.right) {
      if (span.right > last.right) last.right = span.right;
      continue;
    }
    occupied.push({ left: span.left, right: span.right });
  }

  const bands: ColumnBand[] = [];
  let start = occupied[0]?.left ?? 0;
  for (let index = 0; index < occupied.length - 1; index += 1) {
    const here = occupied[index];
    const next = occupied[index + 1];
    if (here === undefined || next === undefined) continue;
    if (next.left - here.right < gap) continue;
    // Граница ставится по середине пустой полосы: так слово, чуть заехавшее
    // за край своей колонки, остаётся в ней, а не перескакивает в соседнюю.
    const border = (here.right + next.left) / 2;
    bands.push({ left: start, right: border });
    start = border;
  }
  const lastOccupied = occupied[occupied.length - 1];
  bands.push({ left: start, right: lastOccupied?.right ?? start });

  return bands;
}

/**
 * Номер колонки, которой принадлежит слово.
 *
 * Решает середина рамки, а не левый край: слово, чуть заехавшее за границу
 * своей колонки, остаётся в ней. Слово, накрывшее несколько колонок сразу
 * (заголовок над группой), тоже попадает в одну — ту, над серединой которой
 * оно стоит. Потерять текст хуже, чем положить его не в ту клетку, а о самом
 * факте пересечения вызывающий код узнаёт из `spanningRows`.
 *
 * null — слово вне всех полос; на практике не встречается, потому что полосы
 * строятся по этим же словам, но проверка дешевле разбирательства.
 */
function columnOf(box: TextBox, columns: readonly ColumnBand[]): number | null {
  const centre = box.x + box.width / 2;

  for (let index = 0; index < columns.length; index += 1) {
    const band = columns[index];
    if (band === undefined) continue;
    const isLast = index === columns.length - 1;
    if (centre >= band.left && (isLast ? centre <= band.right : centre < band.right)) {
      return index;
    }
  }
  return null;
}

/** Пересекает ли слово границу колонок. */
function spansColumns(box: TextBox, columns: readonly ColumnBand[]): boolean {
  const left = box.x;
  const right = box.x + box.width;
  let touched = 0;
  for (const band of columns) {
    // Половина единицы допуска: рамки слов и границы полос считаются в одних
    // и тех же единицах, и касание краями не должно считаться пересечением.
    if (right > band.left + 0.5 && left < band.right - 0.5) touched += 1;
  }
  return touched > 1;
}

/**
 * Склеивает слова одной ячейки.
 *
 * Пробел ставится по расстоянию между рамками, а не между всеми кусками
 * подряд. Внутри ячейки PDF разбивает текст по смене шрифта или кернинга, и
 * «1,09» приезжает как «1,» и «09» вплотную: склейка через пробел дала бы
 * «1, 09» — число, которое не разберёт ни один `parseFloat` и которое при
 * сверке двух разборов выглядит как расхождение, хотя разобрано верно.
 *
 * Порог мягкий — четверть высоты строки: настоящий пробел шире, кернинг уже.
 */
function joinCell(boxes: readonly TextBox[], spaceWidth: number): string {
  let text = "";
  let previousRight: number | null = null;

  for (const box of boxes) {
    const piece = box.text.trim();
    if (piece.length === 0) continue;
    if (previousRight !== null && box.x - previousRight > spaceWidth) text += " ";
    text += piece;
    previousRight = box.x + box.width;
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Собирает таблицу страницы. */
export function buildTableGrid(
  boxes: readonly TextBox[],
  options: TableGridOptions = {},
): TableGrid {
  const columns = detectColumns(boxes, options.minColumnGap, options.rowTolerance);
  if (columns.length === 0) return { rows: [], columns: [], spanningRows: [] };

  const grouped = groupIntoRows(boxes, options.rowTolerance);
  const heights = grouped.flat().map((box) => box.height);
  const spaceWidth = heights.length > 0 ? median(heights) * 0.25 : 0;

  const rows: string[][] = [];
  const spanningRows: number[] = [];

  for (const line of grouped) {
    const cells: TextBox[][] = columns.map(() => []);
    let spanning = false;

    for (const box of line) {
      if (spansColumns(box, columns)) spanning = true;
      const index = columnOf(box, columns);
      if (index === null) continue;
      cells[index]?.push(box);
    }

    if (spanning) spanningRows.push(rows.length);
    rows.push(cells.map((cell) => joinCell(cell, spaceWidth)));
  }

  return { rows, columns, spanningRows };
}

/** Расхождение между двумя разборами одной страницы. */
export interface GridDifference {
  readonly row: number;
  readonly column: number;
  readonly left: string;
  readonly right: string;
}

/** Приводит ячейку к виду, в котором сравнение не зависит от расстановки пробелов. */
function normalizeCell(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Сравнивает два независимых разбора одной страницы.
 *
 * Ради этого всё и затевалось. Ошибка разбора таблицы не выглядит ошибкой:
 * съехавшая на колонку цифра — это правдоподобное число не на своём месте, и ни
 * одна проверка диапазона его не поймает. Зато два разных пути извлечения
 * ошибаются по-разному, и там, где они разошлись, почти наверняка беда хотя бы
 * у одного.
 *
 * Расхождение размеров сетки тоже расхождение: оно возвращается ячейками с
 * пустой стороной, а не отдельным исключением, чтобы вызывающий код показывал
 * человеку один список, а не два.
 */
export function diffGrids(left: TableGrid, right: TableGrid): GridDifference[] {
  const differences: GridDifference[] = [];
  const rowCount = Math.max(left.rows.length, right.rows.length);

  for (let row = 0; row < rowCount; row += 1) {
    const leftRow = left.rows[row] ?? [];
    const rightRow = right.rows[row] ?? [];
    const columnCount = Math.max(leftRow.length, rightRow.length);

    for (let column = 0; column < columnCount; column += 1) {
      const leftCell = normalizeCell(leftRow[column] ?? "");
      const rightCell = normalizeCell(rightRow[column] ?? "");
      if (leftCell === rightCell) continue;
      differences.push({ row, column, left: leftCell, right: rightCell });
    }
  }

  return differences;
}
