/**
 * Текст из OpenDocument (odt, odp, fodt, fodp): разбор content.xml без
 * зависимостей.
 *
 * Модуль чистый: ни одного импорта, ни Node-API, ни jszip. Поэтому его читают и
 * серверный разбор вложений (attachmentParser.ts), и браузерный разбор
 * загружаемых файлов (documentParser.ts). Контейнер zip открывает вызывающий
 * код, сюда приходит готовая строка XML.
 *
 * Зачем свой разбор, а не библиотека. Нужна не «разметка документа», а
 * плоский текст в том виде, в каком его читает модель: абзацы строками, таблица
 * ведомости объёмов строками с ячейками через табуляцию. Ведомость в ЕИС
 * выкладывают именно в odt («Приложение № 3 к МК и №1 к ТЗ Ведомость объемов
 * работ.odt»), и это главный вход для расчёта сметы: терять в ней таблицу
 * нельзя.
 *
 * Разбор потоковый и линейный: один проход по строке, стек имён открытых
 * элементов и несколько счётчиков. DOM не строится — content.xml большой
 * ведомости занимает десятки мегабайт.
 */

/** Повтор пустых ячеек в строке сверх этого числа не рисуется: в ods-стиле их бывают тысячи. */
const MAX_EMPTY_CELL_REPEAT = 4;
/** Повтор непустой ячейки (например, «—» поверх объединённых колонок). */
const MAX_FILLED_CELL_REPEAT = 10;
/** Повтор непустой строки таблицы. Пустые строки не выводятся вовсе. */
const MAX_ROW_REPEAT = 5;
/** `text:s text:c="…"` — число пробелов; живые значения — единицы, предел от мусора. */
const MAX_SPACES = 200;

/**
 * Поддеревья, которые текстом документа не являются.
 *
 * Стили и описания шрифтов — оформление. `master-styles` — это колонтитулы и
 * номера страниц: в ведомости на 40 листов один и тот же «Лист N из 40» заполнил
 * бы страницу шумом. Правки (`tracked-changes`) хранят удалённый текст, примечания
 * — комментарии рецензента; ни то ни другое в итоговом документе не видно.
 * Описания таблиц содержания и счётчиков (`*-decls`, `*-source`) — служебные.
 */
const SKIPPED_ELEMENTS = new Set([
  "office:automatic-styles",
  "office:styles",
  "office:master-styles",
  "office:font-face-decls",
  "office:scripts",
  "office:settings",
  "office:meta",
  "office:annotation",
  "office:annotation-end",
  "text:tracked-changes",
  "text:sequence-decls",
  "text:variable-decls",
  "text:user-field-decls",
  "text:dde-connection-decls",
  "text:alphabetical-index-auto-mark-file",
  "text:table-of-content-source",
  "text:illustration-index-source",
  "text:table-index-source",
  "text:object-index-source",
  "text:user-index-source",
  "text:alphabetical-index-source",
  "text:bibliography-source",
  "presentation:notes",
  "presentation:settings",
  "svg:title",
  "svg:desc",
  "draw:image",
  "table:table-column",
  "table:table-columns",
  "table:table-header-columns",
  "table:tracked-changes",
  "table:named-expressions",
  "table:database-ranges",
  "table:calculation-settings",
  "table:content-validations",
  "table:shapes",
]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Сущности XML и числовые ссылки. Неизвестное имя остаётся как есть. */
export function decodeXmlEntities(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{0,15});/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = parseInt(
          hex ? body.slice(2) : body.slice(1),
          hex ? 16 : 10,
        );
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        // Управляющие символы XML 1.0 недопустимы; в текст их не берём.
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
          return "";
        return String.fromCodePoint(code);
      }
      return ENTITIES[body] ?? match;
    },
  );
}

const attributePatterns = new Map<string, RegExp>();

/** Значение атрибута; null — атрибута нет. Имена с префиксом сравниваются целиком. */
function attribute(attrs: string, name: string): string | null {
  let pattern = attributePatterns.get(name);
  if (!pattern) {
    // Граница слева обязательна: иначе `text:c` нашёлся бы внутри `xtext:c`.
    pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
    attributePatterns.set(name, pattern);
  }
  const match = pattern.exec(attrs);
  if (!match) return null;
  return decodeXmlEntities(match[2] ?? match[3] ?? "");
}

function positiveInt(
  value: string | null,
  fallback: number,
  max: number,
): number {
  if (value === null) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** Куда попадает текст абзаца: в основной текст или в ячейку таблицы. */
interface CellFrame {
  parts: string[];
  /** Сколько раз ячейка повторяется по горизонтали (до ограничения). */
  repeat: number;
}

interface RowFrame {
  cells: string[];
  /** Повтор строки по вертикали (до ограничения). */
  repeat: number;
}

interface TableFrame {
  rows: string[];
}

/** Один открытый элемент: имя и признак, что внутри него пропуск. */
interface OpenElement {
  name: string;
}

/**
 * Содержимое content.xml (или целого flat-XML документа fodt/fodp) как текст.
 *
 * Пустая строка — текста в документе нет. Функция не бросает на кривой XML:
 * закрывающий тег без пары игнорируется, незакрытые элементы закрываются в
 * конце, потому что документы приходят с государственной площадки и
 * генерируются разными программами.
 */
export function odfContentToText(xml: string): string {
  const out: string[] = [];

  const stack: OpenElement[] = [];
  /** Глубина стека, на которой начался пропускаемый элемент; 0 — пропуска нет. */
  let skipFrom = 0;

  /** Стек буферов открытых абзацев; пуст — мы вне абзаца, и пробельный текст игнорируется. */
  const paragraphs: string[][] = [];

  const tables: TableFrame[] = [];
  let row: RowFrame | null = null;
  const cells: CellFrame[] = [];
  /** Сколько вложенных таблиц сверх поддерживаемой глубины мы сейчас проходим. */
  let flatDepth = 0;

  let slide = 0;

  /** Строка в основной вывод либо в ячейку, если она открыта. */
  const emitLine = (line: string): void => {
    const cell = cells[cells.length - 1];
    if (cell) {
      if (line.length > 0) cell.parts.push(line);
      return;
    }
    out.push(line);
  };

  const closeParagraph = (): void => {
    const buffer = paragraphs.pop();
    if (!buffer) return;
    let text = buffer.join("");
    if (cells.length > 0 || flatDepth > 0) {
      // Внутри ячейки перевод строки и табуляция ломали бы построчную таблицу.
      text = text.replace(/[\n\t]+/g, " ");
    }
    text = text.replace(/[  ]+$/g, "");
    emitLine(text);
  };

  const pushText = (text: string): void => {
    const buffer = paragraphs[paragraphs.length - 1];
    if (!buffer) return;
    buffer.push(text);
  };

  /** Текст между тегами: пробелы схлопываются, ведущие в абзаце отбрасываются. */
  const characterData = (raw: string): void => {
    const buffer = paragraphs[paragraphs.length - 1];
    if (!buffer) return;
    let text = decodeXmlEntities(raw).replace(/[ \t\r\n]+/g, " ");
    if (text === " " && buffer.length === 0) return;
    if (text.startsWith(" ") && buffer.length === 0) text = text.slice(1);
    // Два пробела подряд на стыке узлов — один.
    const last = buffer[buffer.length - 1];
    if (text.startsWith(" ") && last !== undefined && last.endsWith(" "))
      text = text.slice(1);
    if (text.length > 0) buffer.push(text);
  };

  const openCell = (attrs: string): void => {
    const repeatRaw = attribute(attrs, "table:number-columns-repeated");
    cells.push({
      parts: [],
      repeat: positiveInt(repeatRaw, 1, 1_000_000),
    });
  };

  const closeCell = (): void => {
    const cell = cells.pop();
    if (!cell || !row) return;
    const text = cell.parts.join(" ").replace(/ {2,}/g, " ").trim();
    const times =
      text.length === 0
        ? Math.min(cell.repeat, MAX_EMPTY_CELL_REPEAT)
        : Math.min(cell.repeat, MAX_FILLED_CELL_REPEAT);
    for (let n = 0; n < times; n += 1) row.cells.push(text);
  };

  const closeRow = (): void => {
    const current = row;
    row = null;
    const table = tables[tables.length - 1];
    if (!current || !table) return;
    // Хвостовые пустые ячейки — след повтора колонок до края листа, не данные.
    while (
      current.cells.length > 0 &&
      current.cells[current.cells.length - 1] === ""
    )
      current.cells.pop();
    if (current.cells.length === 0) return;
    const line = current.cells.join("\t");
    for (let n = 0; n < current.repeat; n += 1) table.rows.push(line);
  };

  const closeTable = (): void => {
    const table = tables.pop();
    if (!table) return;
    // Вложенная таблица сюда пустой: её ячейки схлопнуты в текст внешней (flatDepth).
    for (const line of table.rows) out.push(line);
  };

  const length = xml.length;
  let at = 0;

  while (at < length) {
    const lt = xml.indexOf("<", at);
    if (lt === -1) {
      if (skipFrom === 0) characterData(xml.slice(at));
      break;
    }
    if (lt > at && skipFrom === 0) characterData(xml.slice(at, lt));

    // Комментарий, CDATA, инструкция и объявление.
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      at = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const body = xml.slice(lt + 9, end === -1 ? length : end);
      if (skipFrom === 0) {
        const buffer = paragraphs[paragraphs.length - 1];
        if (buffer && body.length > 0)
          buffer.push(body.replace(/[ \t\r\n]+/g, " "));
      }
      at = end === -1 ? length : end + 3;
      continue;
    }
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const end = xml.indexOf(">", lt + 2);
      at = end === -1 ? length : end + 1;
      continue;
    }

    // Обычный тег: конец ищется с учётом кавычек — `>` внутри атрибута бывает.
    let end = -1;
    let quote = "";
    for (let i = lt + 1; i < length; i += 1) {
      const ch = xml[i];
      if (quote !== "") {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        end = i;
        break;
      }
    }
    if (end === -1) break;

    const raw = xml.slice(lt + 1, end);
    at = end + 1;

    const closing = raw.startsWith("/");
    const selfClosing = !closing && raw.endsWith("/");
    const body = closing ? raw.slice(1) : selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = body.search(/[\s]/);
    const name = (nameEnd === -1 ? body : body.slice(0, nameEnd)).trim();
    const attrs = nameEnd === -1 ? "" : body.slice(nameEnd);
    if (name.length === 0) continue;

    if (closing) {
      // Парный закрывающий тег: снимаем элементы до совпавшего имени.
      let index = stack.length - 1;
      while (index >= 0 && stack[index]?.name !== name) index -= 1;
      if (index < 0) continue;
      while (stack.length > index) {
        const popped = stack.pop();
        if (!popped) break;
        handleClose(popped.name, stack.length + 1);
      }
      continue;
    }

    const depthAfterOpen = stack.length + 1;

    if (skipFrom !== 0) {
      // Внутри пропускаемого поддерева следим только за глубиной.
      if (!selfClosing) stack.push({ name });
      continue;
    }

    if (SKIPPED_ELEMENTS.has(name)) {
      if (!selfClosing) {
        stack.push({ name });
        skipFrom = depthAfterOpen;
      }
      continue;
    }

    handleOpen(name, attrs, selfClosing);
    if (!selfClosing) stack.push({ name });
  }

  // Незакрытые элементы закрываются по порядку, как будто файл дописан.
  while (stack.length > 0) {
    const popped = stack.pop();
    if (!popped) break;
    handleClose(popped.name, stack.length + 1);
  }

  function handleOpen(name: string, attrs: string, selfClosing: boolean): void {
    switch (name) {
      case "text:p":
      case "text:h":
        paragraphs.push([]);
        if (selfClosing) closeParagraph();
        return;
      case "text:s": {
        const count = positiveInt(attribute(attrs, "text:c"), 1, MAX_SPACES);
        pushText(" ".repeat(count));
        return;
      }
      case "text:tab":
        pushText("\t");
        return;
      case "text:line-break":
        pushText("\n");
        return;
      case "table:table":
        // Таблица внутри ячейки не строит свои строки: её текст уходит в ячейку.
        if (cells.length > 0) flatDepth += 1;
        tables.push({ rows: [] });
        return;
      case "table:table-row": {
        if (flatDepth > 0) return;
        const repeat = positiveInt(
          attribute(attrs, "table:number-rows-repeated"),
          1,
          1_000_000,
        );
        row = { cells: [], repeat: Math.min(repeat, MAX_ROW_REPEAT) };
        if (selfClosing) closeRow();
        return;
      }
      case "table:table-cell":
        if (flatDepth > 0) return;
        openCell(attrs);
        if (selfClosing) closeCell();
        return;
      case "table:covered-table-cell":
        if (flatDepth > 0) return;
        openCell(attrs);
        if (selfClosing) closeCell();
        return;
      case "draw:page":
        slide += 1;
        out.push(`=== Слайд ${slide} ===`);
        return;
      default:
        return;
    }
  }

  function handleClose(name: string, depth: number): void {
    if (skipFrom !== 0) {
      if (depth <= skipFrom) skipFrom = 0;
      return;
    }
    switch (name) {
      case "text:p":
      case "text:h":
        closeParagraph();
        return;
      case "table:table-row":
        if (flatDepth === 0) closeRow();
        return;
      case "table:table-cell":
      case "table:covered-table-cell":
        if (flatDepth === 0) closeCell();
        return;
      case "table:table":
        closeTable();
        if (flatDepth > 0) flatDepth -= 1;
        return;
      default:
        return;
    }
  }

  return out
    .join("\n")
    .replace(/ /g, " ")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Тип документа OpenDocument по MIME из entry «mimetype». */
export type OdfKind = "text" | "spreadsheet" | "presentation" | "graphics";

/**
 * Тип OpenDocument по строке mimetype; null — это не OpenDocument.
 *
 * Подстрока «opendocument» достаточна: так начинаются все MIME стандарта
 * (`application/vnd.oasis.opendocument.text`, `….spreadsheet`, `….presentation`),
 * а шаблоны (`…text-template`) читаются так же, как документы.
 */
export function odfKindFromMime(mime: string): OdfKind | null {
  const value = mime.trim().toLowerCase();
  if (!value.includes("opendocument")) return null;
  if (value.includes("spreadsheet")) return "spreadsheet";
  if (value.includes("presentation")) return "presentation";
  if (value.includes("graphics")) return "graphics";
  if (value.includes("text")) return "text";
  return "text";
}

/** Тип по содержимому content.xml, когда entry «mimetype» нет или он пуст. */
export function odfKindFromContent(xml: string): OdfKind | null {
  const head = xml.slice(0, 20_000);
  if (head.includes("<office:spreadsheet")) return "spreadsheet";
  if (head.includes("<office:presentation")) return "presentation";
  if (head.includes("<office:drawing")) return "graphics";
  if (head.includes("<office:text")) return "text";
  return null;
}
