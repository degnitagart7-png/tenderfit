/**
 * RTF → текст без зависимостей.
 *
 * Модуль чистый: ни одного импорта, кроме встроенного `TextDecoder`. Его
 * читают и серверный разбор вложений, и браузерный разбор загруженных файлов.
 *
 * Зачем свой конвертер. В ЕИС встречаются документы в RTF («Информационная
 * карта.rtf», а также файлы с именем «.pdf» и содержимым RTF — pdfjs отвечал на
 * них «Invalid PDF structure»). Готовых зависимостей в проекте нет, а формат
 * для задачи «достать текст» несложный: поток управляющих слов и групп.
 *
 * Что делает:
 *  - кодовая страница: `\ansicpgNNNN` документа, а у шрифтов с явным набором
 *    знаков (`\fcharset204` — кириллица) — по набору; байты `\'hh` и «сырые»
 *    байты выше 0x7F декодируются через TextDecoder;
 *  - `\uN` — знак юникода, следующие `\ucN` знаков замены пропускаются;
 *  - группы служебных назначений (таблицы шрифтов и цветов, стили, info,
 *    рисунки, объекты, колонтитулы, всё `{\*\…}`) целиком пропускаются;
 *  - `\par`, `\line` — перевод строки, `\tab` — табуляция, `\cell` — табуляция,
 *    `\row` — перевод строки; внутри строки таблицы абзацы склеиваются
 *    пробелом, чтобы строка таблицы осталась строкой текста.
 *
 * Время линейное: один проход по входу, явный стек групп без рекурсии. Глубина
 * вложенности ограничена: группы глубже предела не накапливают состояние, а
 * их содержимое отбрасывается.
 */

/** Глубже этого группы не создают состояния: защита от файла из миллиона `{`. */
const MAX_GROUP_DEPTH = 200;

/** Целевые группы, которые не являются текстом документа. */
const SKIPPED_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "header",
  "headerl",
  "headerr",
  "headerf",
  "footer",
  "footerl",
  "footerr",
  "footerf",
  "themedata",
  "colorschememapping",
  "datastore",
  "latentstyles",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "generator",
  "xmlnstbl",
  "fldinst",
  "private",
  "pgptbl",
  "revtbl",
  "mmathpr",
  "wgrffmtfilter",
  "template",
  "filetbl",
  "operator",
  "title",
  "subject",
  "author",
  "keywords",
  "doccomm",
  "company",
  "category",
  "manager",
  "comment",
  "bkmkstart",
  "bkmkend",
  "shpinst",
  "nonshppict",
  "shppict",
  "blipuid",
  "sp",
  "ftnsep",
  "ftnsepc",
  "aftnsep",
  "aftnsepc",
]);

/** Набор знаков шрифта → кодовая страница. */
const CHARSET_CODEPAGE: Readonly<Record<number, number>> = {
  0: 1252,
  161: 1253,
  162: 1254,
  163: 1258,
  177: 1255,
  178: 1256,
  186: 1257,
  204: 1251,
  222: 874,
  238: 1250,
  128: 932,
  129: 949,
  134: 936,
  136: 950,
  255: 866,
};

/** Кодовая страница → метка TextDecoder. */
function decoderLabel(codepage: number): string {
  if (codepage >= 1250 && codepage <= 1258) return `windows-${codepage}`;
  switch (codepage) {
    case 874:
      return "windows-874";
    case 866:
      return "ibm866";
    case 932:
      return "shift_jis";
    case 936:
      return "gbk";
    case 949:
      return "euc-kr";
    case 950:
      return "big5";
    case 10000:
      return "macintosh";
    case 65001:
      return "utf-8";
    default:
      return "windows-1252";
  }
}

const decoders = new Map<string, TextDecoder>();

function decodeBytes(bytes: number[], codepage: number): string {
  const label = decoderLabel(codepage);
  let decoder = decoders.get(label);
  if (!decoder) {
    try {
      decoder = new TextDecoder(label);
    } catch {
      // Сборка Node без полного ICU: деградируем до latin1.
      decoder = new TextDecoder("windows-1252");
    }
    decoders.set(label, decoder);
  }
  return decoder.decode(Uint8Array.from(bytes));
}

/** Состояние группы: наследуется вложенными и откатывается на закрывающей скобке. */
interface GroupState {
  skip: boolean;
  /** Сколько знаков замены стоит после `\uN`. */
  uc: number;
  /** Номер текущего шрифта (`\fN`); -1 — не задан. */
  font: number;
  /** Группа — таблица шрифтов: по ней собираем кодовые страницы. */
  fontTable: boolean;
}

/** Простые управляющие слова, дающие готовый знак. */
const SYMBOLS: Readonly<Record<string, string>> = {
  emdash: "—",
  endash: "–",
  emspace: " ",
  enspace: " ",
  qmspace: " ",
  bullet: "•",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
  tab: "\t",
  cell: "\t",
  // Вложенная таблица лежит внутри ячейки внешней: её ячейки и строки — пробелы.
  nestcell: " ",
  nestrow: " ",
};

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

/**
 * Текст из байтов RTF. Пустая строка — текста нет.
 *
 * Вход — байты, а не строка: в RTF 8-битные знаки означают кодовую страницу
 * документа, и только на байтах их можно декодировать правильно.
 */
export function rtfToText(input: Uint8Array): string {
  const length = input.length;
  /** Готовый текст кусками: знак за знаком в массив было бы десятки миллионов строк. */
  const out: string[] = [];
  let chunk = "";

  let docCodepage = 1252;
  const fontCodepage = new Map<number, number>();

  const stack: GroupState[] = [];
  let state: GroupState = { skip: false, uc: 1, font: -1, fontTable: false };
  /** Групп глубже предела: их скобки считаются, состояния у них нет. */
  let overflow = 0;
  /** Первый токен группы определяет, служебная ли она. */
  let groupStart = false;
  /** Сколько знаков замены после \u ещё предстоит пропустить. */
  let pendingSkip = 0;
  /** Между \trowd и \row абзацы склеиваются в одну строку таблицы. */
  let inRow = false;

  /** Накопленные 8-битные знаки в кодовой странице `pendingPage`. */
  let pending: number[] = [];
  let pendingPage = 1252;

  const append = (text: string): void => {
    chunk += text;
    if (chunk.length > 8192) {
      out.push(chunk);
      chunk = "";
    }
  };

  const flushBytes = (): void => {
    if (pending.length === 0) return;
    append(decodeBytes(pending, pendingPage));
    pending = [];
  };

  const emit = (text: string): void => {
    flushBytes();
    append(text);
  };

  const currentCodepage = (): number => {
    if (state.font >= 0) {
      const own = fontCodepage.get(state.font);
      if (own !== undefined) return own;
    }
    return docCodepage;
  };

  const emitByte = (byte: number): void => {
    const page = currentCodepage();
    if (pending.length > 0 && pendingPage !== page) flushBytes();
    pendingPage = page;
    pending.push(byte);
  };

  const pushGroup = (): void => {
    if (stack.length >= MAX_GROUP_DEPTH) {
      overflow += 1;
      return;
    }
    stack.push(state);
    state = { ...state };
    groupStart = true;
    pendingSkip = 0;
  };

  const popGroup = (): void => {
    flushBytes();
    pendingSkip = 0;
    groupStart = false;
    if (overflow > 0) {
      overflow -= 1;
      return;
    }
    const previous = stack.pop();
    if (previous) state = previous;
  };

  let at = 0;
  // Заголовок «{\rtf» не обязан стоять в нуле: сдвиг по BOM и пробелам.
  while (at < length && input[at] !== 0x7b) at += 1;

  while (at < length) {
    const code = input[at] as number;

    if (overflow > 0) {
      // Слишком глубокая вложенность: следим только за скобками.
      at += 1;
      if (code === 0x5c) at += 1;
      else if (code === 0x7b) overflow += 1;
      else if (code === 0x7d) overflow -= 1;
      continue;
    }

    if (code === 0x7b) {
      pushGroup();
      at += 1;
      continue;
    }
    if (code === 0x7d) {
      popGroup();
      at += 1;
      continue;
    }

    if (code === 0x0d || code === 0x0a) {
      at += 1;
      continue;
    }

    if (code !== 0x5c) {
      // Обычный знак.
      if (state.skip) {
        at += 1;
        continue;
      }
      groupStart = false;
      if (pendingSkip > 0) {
        pendingSkip -= 1;
        at += 1;
        continue;
      }
      if (code < 0x80) {
        emit(String.fromCharCode(code));
      } else {
        emitByte(code);
      }
      at += 1;
      continue;
    }

    // Управляющая последовательность.
    const next = input[at + 1];
    if (next === undefined) break;

    if (!isLetter(next)) {
      at += 2;
      switch (next) {
        case 0x5c: // \\
        case 0x7b: // \{
        case 0x7d: // \}
          groupStart = false;
          if (state.skip) break;
          if (pendingSkip > 0) {
            pendingSkip -= 1;
            break;
          }
          emit(String.fromCharCode(next));
          break;
        case 0x27: {
          // \'hh
          const high = hexValue(input[at] ?? -1);
          const low = hexValue(input[at + 1] ?? -1);
          groupStart = false;
          if (high >= 0 && low >= 0) {
            at += 2;
            if (state.skip) break;
            if (pendingSkip > 0) {
              pendingSkip -= 1;
              break;
            }
            emitByte(high * 16 + low);
          }
          break;
        }
        case 0x2a: // \* — необязательное назначение: пропускаем всю группу
          if (groupStart) state.skip = true;
          break;
        case 0x7e: // \~ — неразрывный пробел
          groupStart = false;
          if (!state.skip) emit(" ");
          break;
        case 0x2d: // \- — мягкий перенос
          groupStart = false;
          break;
        case 0x5f: // \_ — неразрывный дефис
          groupStart = false;
          if (!state.skip) emit("-");
          break;
        case 0x0a:
        case 0x0d: // «\» и перевод строки — это \par
          groupStart = false;
          if (!state.skip) emit(inRow ? " " : "\n");
          break;
        default:
          groupStart = false;
          break;
      }
      continue;
    }

    // Управляющее слово: буквы, необязательное число, необязательный пробел.
    let end = at + 1;
    // Слово длиннее 32 букв — не управляющее слово; хвост пойдёт как текст.
    while (end < length && end - at <= 32 && isLetter(input[end] as number))
      end += 1;
    const word = String.fromCharCode(
      ...input.subarray(at + 1, end),
    ).toLowerCase();

    let hasParam = false;
    let param = 0;
    let negative = false;
    if (input[end] === 0x2d) {
      negative = true;
      end += 1;
    }
    const paramStart = end;
    while (end < length && isDigit(input[end] as number)) end += 1;
    if (end > paramStart) {
      hasParam = true;
      // Число длиннее девяти цифр — мусор; значение не нужно, но и не переполняем.
      param = parseInt(
        String.fromCharCode(
          ...input.subarray(paramStart, Math.min(end, paramStart + 9)),
        ),
        10,
      );
      if (negative) param = -param;
    } else if (negative) {
      // «\word-» без цифр: минус — обычный знак текста.
      end -= 1;
    }
    // Один пробел после слова — разделитель и в текст не попадает.
    if (input[end] === 0x20) end += 1;
    at = end;

    const wasGroupStart = groupStart;
    groupStart = false;

    if (state.fontTable) {
      if (word === "f" && hasParam) state.font = param;
      else if (word === "fcharset" && hasParam && state.font >= 0) {
        const page = CHARSET_CODEPAGE[param];
        if (page !== undefined && param !== 0 && param !== 1)
          fontCodepage.set(state.font, page);
      } else if (word === "cpg" && hasParam && state.font >= 0) {
        fontCodepage.set(state.font, param);
      }
    }

    if (wasGroupStart && SKIPPED_DESTINATIONS.has(word)) {
      state.skip = true;
      if (word === "fonttbl") state.fontTable = true;
      continue;
    }

    if (word === "bin" && hasParam && param > 0) {
      // Двоичные данные после \binN длиной N байт: пропускаем без разбора.
      at = Math.min(length, at + param);
      continue;
    }

    if (state.skip) continue;

    switch (word) {
      case "ansicpg":
        if (hasParam) docCodepage = param;
        break;
      case "ansi":
        docCodepage = 1252;
        break;
      case "mac":
        docCodepage = 10000;
        break;
      case "pc":
        docCodepage = 437;
        break;
      case "pca":
        docCodepage = 850;
        break;
      case "uc":
        if (hasParam) state.uc = Math.max(0, param);
        break;
      case "u": {
        if (!hasParam) break;
        if (pendingSkip > 0) {
          // Знак замены не может быть \u, но защита от рассинхронизации.
          pendingSkip = 0;
        }
        const unit = param < 0 ? param + 65536 : param;
        emit(String.fromCharCode(unit & 0xffff));
        pendingSkip = state.uc;
        break;
      }
      case "f":
        if (hasParam) state.font = param;
        break;
      case "par":
      case "line":
        if (pendingSkip > 0) pendingSkip = 0;
        emit(inRow ? " " : "\n");
        break;
      case "sect":
      case "page":
      case "column":
        emit("\n");
        break;
      case "trowd":
      case "intbl":
        inRow = true;
        break;
      case "row":
        inRow = false;
        emit("\n");
        break;
      default: {
        const symbol = SYMBOLS[word];
        if (symbol !== undefined) emit(symbol);
        break;
      }
    }
  }

  flushBytes();
  out.push(chunk);

  return out
    .join("")
    .replace(/ /g, " ")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ +\t/g, "\t")
    .replace(/\t+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
