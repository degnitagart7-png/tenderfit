/**
 * Потоковый токенайзер XML для выгрузок ФГИС ЦС (ФСНБ-2022).
 *
 * Зачем свой, а не библиотека: файл «ГЭСН.xml» весит 84 МБ и содержит 30 030
 * норм, «ГЭСНм.xml» — ещё 48 МБ. DOM-парсеры (cheerio, fast-xml-parser)
 * держат всё дерево в памяти и на таком объёме падают по heap. Сторонний
 * потоковый парсер — это новая зависимость в прод-сборке Vercel, а задача
 * узкая: читать элементы и атрибуты из корректного файла, который генерирует
 * государственная ИАС ЦС.
 *
 * Поддерживается ровно то, что встречается в выгрузке: элементы, атрибуты в
 * двойных и одинарных кавычках, символьные сущности, XML-декларация,
 * комментарии и CDATA. Пространства имён не разбираются — префиксы в именах
 * элементов отсутствуют, `xmlns:*` попадают в атрибуты и дальше игнорируются.
 *
 * Модуль чистый: не читает файлы и не ходит в сеть. Данные подаются кусками
 * через push(), поэтому вызывающий код сам решает, откуда берётся поток.
 */

/** Атрибуты элемента. Значения уже расшифрованы из сущностей. */
export type XmlAttributes = Readonly<Record<string, string>>;

/** Одно событие разбора. */
export type XmlToken =
  | { readonly kind: "open"; readonly tag: string; readonly attrs: XmlAttributes }
  | { readonly kind: "close"; readonly tag: string }
  | { readonly kind: "selfClose"; readonly tag: string; readonly attrs: XmlAttributes }
  | { readonly kind: "text"; readonly text: string };

/** Именованные сущности XML. Всё остальное в выгрузке не встречается. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Раскрывает символьные сущности: именованные и числовые в десятичной и
 * шестнадцатеричной форме. Незнакомую сущность оставляет как есть — лучше
 * видимый артефакт в наименовании, чем молча потерянный текст.
 */
export function decodeXmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Регулярка пары «имя атрибута = значение в кавычках». */
const ATTRIBUTE_PATTERN = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Разбирает строку атрибутов элемента. Атрибуты без значения пропускает. */
export function parseXmlAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of input.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1];
    if (name === undefined) continue;
    const quoted = match[2] ?? match[3] ?? "";
    result[name] = decodeXmlEntities(quoted);
  }
  return result;
}

/**
 * Токенайзер с внутренним буфером.
 *
 * Кусок, в котором тег не закрылся, остаётся в буфере до следующего push().
 * Так граница между кусками файла не может разорвать атрибут или имя элемента.
 */
export class XmlTokenizer {
  private buffer = "";
  private offset = 0;

  /** Подаёт следующий кусок текста и возвращает готовые токены. */
  push(chunk: string): XmlToken[] {
    this.buffer = this.buffer.slice(this.offset) + chunk;
    this.offset = 0;
    return this.drain(false);
  }

  /**
   * Закрывает поток. Бросает ошибку, если файл оборван на середине тега:
   * молча отдать половину нормы хуже, чем упасть.
   */
  flush(): XmlToken[] {
    return this.drain(true);
  }

  /** Сколько символов осталось неразобранными — полезно для диагностики. */
  get pending(): number {
    return this.buffer.length - this.offset;
  }

  private drain(isFinal: boolean): XmlToken[] {
    const tokens: XmlToken[] = [];

    for (;;) {
      const lt = this.buffer.indexOf("<", this.offset);

      if (lt === -1) {
        if (isFinal) {
          this.pushText(tokens, this.buffer.slice(this.offset));
          this.offset = this.buffer.length;
        }
        // Иначе хвост оставляем в буфере: текст может прийти следующим куском.
        break;
      }

      if (lt > this.offset) {
        this.pushText(tokens, this.buffer.slice(this.offset, lt));
        this.offset = lt;
      }

      const end = this.findMarkupEnd(this.offset);
      if (end === -1) {
        if (isFinal) {
          throw new Error(
            `Обрыв XML-потока: конструкция с позиции ${this.offset} не закрыта`,
          );
        }
        break;
      }

      const token = parseMarkup(this.buffer.slice(this.offset, end));
      this.offset = end;
      if (token !== null) tokens.push(token);
    }

    return tokens;
  }

  /** Добавляет текстовый токен, если после раскрытия сущностей текст не пуст. */
  private pushText(tokens: XmlToken[], raw: string): void {
    const text = decodeXmlEntities(raw).trim();
    if (text.length > 0) tokens.push({ kind: "text", text });
  }

  /**
   * Ищет конец разметки, начиная с «<». Возвращает -1, если данных пока не
   * хватает — вызывающий код подождёт следующий кусок.
   */
  private findMarkupEnd(start: number): number {
    const buffer = this.buffer;

    if (buffer.startsWith("<!--", start)) {
      const end = buffer.indexOf("-->", start + 4);
      return end === -1 ? -1 : end + 3;
    }
    if (buffer.startsWith("<![CDATA[", start)) {
      const end = buffer.indexOf("]]>", start + 9);
      return end === -1 ? -1 : end + 3;
    }
    if (buffer.startsWith("<?", start)) {
      const end = buffer.indexOf("?>", start + 2);
      return end === -1 ? -1 : end + 2;
    }
    // Начало служебной конструкции могло прийти не целиком: ждём продолжения.
    if (buffer.length - start < 9 && (buffer.startsWith("<!", start) || buffer.startsWith("<?", start))) {
      return -1;
    }

    let index = start + 1;
    let quote: '"' | "'" | null = null;
    while (index < buffer.length) {
      const char = buffer[index];
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        return index + 1;
      }
      index += 1;
    }
    return -1;
  }
}

/**
 * Превращает один фрагмент разметки в токен. Комментарии и декларация
 * возвращают null — они не несут данных.
 */
function parseMarkup(raw: string): XmlToken | null {
  if (raw.startsWith("<!--") || raw.startsWith("<?")) return null;

  if (raw.startsWith("<![CDATA[")) {
    const text = raw.slice(9, raw.length - 3);
    return text.length > 0 ? { kind: "text", text } : null;
  }

  if (raw.startsWith("</")) {
    const tag = raw.slice(2, raw.length - 1).trim();
    return tag.length > 0 ? { kind: "close", tag } : null;
  }

  const selfClosing = raw.endsWith("/>");
  const inner = raw.slice(1, selfClosing ? raw.length - 2 : raw.length - 1);
  const nameMatch = /^[^\s/>]+/.exec(inner);
  if (nameMatch === null) return null;

  const tag = nameMatch[0];
  const attrs = parseXmlAttributes(inner.slice(tag.length));
  return selfClosing ? { kind: "selfClose", tag, attrs } : { kind: "open", tag, attrs };
}
