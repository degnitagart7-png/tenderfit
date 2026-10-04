import type { BillOfWorkItem } from "@/domain/estimate/types";

/**
 * Превращение строк, найденных моделью в документации, в ведомость объёмов.
 *
 * Зачем домен, а не только промпт. Ведомость — единственное место расчёта, где
 * данные приходят от языковой модели, и от неё зависит каждая цифра сметы:
 * объём умножается на расценку. Модель, которая ошиблась в объёме на порядок,
 * даёт правдоподобную смету с неверным числом, и заметить это в готовом
 * документе нельзя. Поэтому здесь не разбор ответа, а проверка: строка входит в
 * ведомость, только если её удалось подтвердить исходным текстом.
 *
 * Две проверки делают основную работу.
 *
 * Первая: цитата должна дословно найтись в документе. Модель обязана вернуть
 * фрагмент строки ведомости, и если этого фрагмента в тексте нет, значит строки
 * не было — она придумана или собрана из двух разных мест.
 *
 * Вторая: объём должен стоять внутри собственной цитаты модели. Цитату модель
 * способна взять настоящую, а число рядом написать своё — например, повторить
 * объём предыдущей строки. Требование «число видно в цитате» ловит ровно это и
 * стоит одно сравнение.
 *
 * Что здесь НЕ делается: подбор расценки, перевод единиц под норму, счёт денег.
 * Модуль отвечает на один вопрос — что и в каком количестве написано в
 * документации, — и оставляет позицию без кода нормы: её подберёт поиск.
 */

/** Строка, как её вернула модель. Числа приходят и текстом, и числом. */
export interface BillExtractionRow {
  readonly workName: string;
  readonly quantity: string | number;
  readonly unit: string;
  readonly evidenceQuote: string;
  /**
   * Фрагмент, в котором виден объём.
   *
   * Отдельно от цитаты наименования, потому что в разобранном PDF таблица
   * расплющена в строку и колонка объёма отстоит от колонки наименования на
   * сотни знаков: единой цитаты, где видно и то и другое, в тексте просто нет.
   * Требовать её — значит заставлять модель склеивать два куска в один, то
   * есть врать. Пусто — берётся цитата наименования.
   */
  readonly quantityQuote?: string;
  /** Раздел ведомости, если модель его увидела. */
  readonly section?: string;
  /**
   * Обоснование строки, как оно напечатано в документе: «ГЭСН09-03-002-01»,
   * «ФСБЦ-07.2.07.12-0068», «Прайс-лист поставщика».
   *
   * Нужно не ради кода расценки — его подберёт поиск, — а ради вида позиции:
   * это единственное место, где документ говорит, работа перед нами или
   * поставляемый материал. Разбирается в `resourceCodeFromJustification`.
   */
  readonly justification?: string;
}

/**
 * Код ресурса ФСНБ, если обоснование строки называет ресурс, а не расценку.
 *
 * Зачем это различие. Ведомость заказчика перечисляет вперемешку работы и
 * поставляемые материалы, и колонка обоснования — единственное место, где
 * документ говорит, что именно перед нами. Материал, принятый за работу,
 * уходит в подбор расценки и приносит оттуда чужие труд и машины: на смете
 * 02-01-02-КМ1 пять таких строк дали 1 000,72 чел.-ч вместо 601,21, а сами
 * материалы выпали из сметы почти целиком — 98 139,39 ₽ вместо 7 232 736,85 ₽.
 *
 * Почему по форме кода, а не по префиксу. Префикс пишут по-разному — «ФСБЦ-»,
 * «ФССЦ-», иногда его нет вовсе, — а форма кода в ФСНБ-2022 устойчива и
 * непересекаема: ресурс записан точками и заканчивается группой из трёх или
 * четырёх цифр («07.2.07.12-0068» — материал, «91.05.01-017» — машина),
 * расценка записана одними дефисами («09-03-002-01»). Опознание по форме
 * переживает смену префикса и не требует списка книг.
 */
const RESOURCE_CODE_PATTERN =
  /(?<![\d.])(\d{2}\.\d\.\d{2}\.\d{2}-\d{4}|\d{2}\.\d{2}\.\d{2}-\d{3})(?![\d-])/;

export function resourceCodeFromJustification(
  justification: string | undefined,
): string | null {
  if (justification === undefined) return null;
  const match = RESOURCE_CODE_PATTERN.exec(justification);
  return match?.[1] ?? null;
}

/** Почему строка не вошла в ведомость. Перечень закрытый. */
export type BillRejectionReason =
  /** Пустое наименование работы. */
  | "EMPTY_NAME"
  /** Объём не число, не конечен или не положителен. */
  | "BAD_QUANTITY"
  /** Единица не распознана: считать по ней нельзя. */
  | "UNKNOWN_UNIT"
  /** Единица денежная: это сумма — штраф, цена, лимит, — а не объём работ. */
  | "MONEY_NOT_WORK"
  /** Цитаты наименования нет в тексте документа: строка не подтверждается. */
  | "QUOTE_NOT_FOUND"
  /** Цитата наименования короче порога: доказательством не является. */
  | "QUOTE_TOO_SHORT"
  /** Фрагмента с объёмом нет в тексте документа. */
  | "QUANTITY_QUOTE_NOT_FOUND"
  /** Фрагмент с объёмом короче порога: по нему не отличить строку от соседней. */
  | "QUANTITY_QUOTE_TOO_SHORT"
  /** Наименование и объём стоят в разных местах документа: это разные строки. */
  | "ANCHORS_TOO_FAR"
  /** Объём не встречается в цитате, которую привела сама модель. */
  | "QUANTITY_NOT_IN_QUOTE"
  /** Та же работа с тем же объёмом уже есть. */
  | "DUPLICATE";

export interface RejectedBillRow {
  readonly reason: BillRejectionReason;
  readonly row: BillExtractionRow;
  /** Человеческое объяснение — печатается в отчёте о разборе. */
  readonly message: string;
}

export interface BillExtractionResult {
  readonly items: readonly BillOfWorkItem[];
  readonly rejected: readonly RejectedBillRow[];
}

export interface BillExtractionInput {
  readonly rows: readonly BillExtractionRow[];
  /** Текст документа, из которого модель извлекала строки. */
  readonly sourceText: string;
  /** Имя документа: попадает в позицию и в выгрузку. */
  readonly documentName: string;
  /** Префикс идентификаторов позиций, чтобы они не сталкивались между файлами. */
  readonly idPrefix: string;
}

/**
 * Единица измерения после приведения к виду, в котором её знает ФСНБ.
 *
 * Множитель вынесен отдельно, потому что «100 м3» — это не единица, а сотня
 * единиц: в ведомости объём чаще записан в «м3», а норма измеряется в «100 м3»,
 * и без множителя эти два числа отличаются в сто раз.
 */
export interface ParsedUnit {
  readonly unit: string;
  readonly multiplier: number;
}

/*
  Написания единиц, которые встречаются в ведомостях.

  Список закрытый и ведётся руками. Угадывать единицу по похожести нельзя: «т»
  и «тыс.» отличаются одной буквой и тысячей раз, а цена ошибки — смета,
  завышенная на три порядка. Чего здесь нет, то отправляется в отказ с
  причиной UNKNOWN_UNIT и видно человеку.
*/
const UNIT_ALIASES: ReadonlyMap<string, string> = new Map([
  ["м3", "м3"],
  ["м³", "м3"],
  ["куб.м", "м3"],
  ["куб м", "м3"],
  ["кубм", "м3"],
  ["м.куб.", "м3"],
  ["м куб", "м3"],
  ["м2", "м2"],
  ["м²", "м2"],
  ["кв.м", "м2"],
  ["кв м", "м2"],
  ["квм", "м2"],
  ["м.кв.", "м2"],
  ["м", "м"],
  ["пм", "м"],
  ["п.м.", "м"],
  ["пог.м", "м"],
  ["пог м", "м"],
  ["погм", "м"],
  ["м.п.", "м"],
  ["мп", "м"],
  ["км", "км"],
  ["шт", "шт"],
  ["шт.", "шт"],
  ["штук", "шт"],
  ["штука", "шт"],
  ["т", "т"],
  ["тн", "т"],
  ["тонн", "т"],
  ["тонна", "т"],
  ["кг", "кг"],
  ["компл", "компл"],
  ["компл.", "компл"],
  ["комплект", "компл"],
  ["м2поверхности", "м2"],
  ["место", "шт"],
  ["ед", "шт"],
  ["ед.", "шт"],
]);

/*
  Денежные единицы.

  В договоре есть таблицы «нарушение — штраф — рублей», и модель принимает их за
  ведомость: по форме это то же «наименование, число, единица». Отдельная
  причина отказа нужна, чтобы человек в отчёте видел «это сумма, а не работа», а
  не думал, что разбор не знает единицу «рублей».
*/
const MONEY_UNITS: ReadonlySet<string> = new Set([
  "руб",
  "руб.",
  "рубль",
  "рублей",
  "рубля",
  "₽",
  "тыс.руб",
  "тыс.руб.",
  "тысруб",
  "млнруб",
  "%",
  "процент",
  "процентов",
]);

/** Денежная ли единица: такую строку считать объёмом нельзя. */
export function isMoneyUnit(raw: string): boolean {
  // `\s` в JS покрывает и неразрывный пробел, отдельной замены не нужно.
  return MONEY_UNITS.has(raw.replace(/\s+/g, "").toLowerCase());
}

/** Приводит единицу к виду ФСНБ и отделяет множитель «100», «1000». */
export function parseUnit(raw: string): ParsedUnit | null {
  const cleaned = raw
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (cleaned === "") return null;

  const withMultiplier = /^(\d[\d\s]*)\s*(.+)$/.exec(cleaned);
  const multiplierRaw = withMultiplier?.[1]?.replace(/\s/g, "");
  const rest = withMultiplier?.[2] ?? cleaned;
  const multiplier =
    multiplierRaw === undefined ? 1 : Number.parseInt(multiplierRaw, 10);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;

  const key = rest.replace(/\s+/g, "");
  const unit = UNIT_ALIASES.get(key) ?? UNIT_ALIASES.get(rest);
  if (unit === undefined) return null;

  return { unit, multiplier };
}

/**
 * Делитель перевода объёма ведомости в единицу нормы.
 *
 * «м3» в ведомости и «100 м3» в норме дают 100: объём делится на сто. Разные
 * базовые единицы дают null — перевод между «м2» и «т» существует только через
 * плотность и толщину, которых в ведомости нет, и догадываться о них нельзя.
 */
export function deriveUnitDivisor(
  billUnit: string,
  normUnit: string,
): number | null {
  const bill = parseUnit(billUnit);
  const norm = parseUnit(normUnit);
  if (bill === null || norm === null) return null;
  if (bill.unit !== norm.unit) return null;
  return norm.multiplier / bill.multiplier;
}

/** Разбор числа из ведомости: «1 234,56», «1234.56», «1&nbsp;234». */
export function parseQuantity(raw: string | number): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }

  const cleaned = raw.replace(/ /g, "").replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;

  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/*
  Сравнение текста для поиска цитаты.

  Пробелы схлопываются, регистр снимается, «ё» приводится к «е»: разбор PDF
  расставляет пробелы по координатам, и цитата, верная по словам, почти никогда
  не совпадает с текстом побайтово. Всё остальное — знаки препинания, скобки,
  единицы — остаётся как есть: именно по ним видно, что цитата настоящая.
*/
function forMatch(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/ё/gi, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Где цитата стоит в тексте документа. `-1` — её там нет.
 *
 * Возвращает место, а не «да/нет», потому что проверять надо ещё и близость
 * двух привязок: наименование из одной строки таблицы и объём из другой дают
 * правдоподобную позицию, которой в ведомости не было.
 */
export function quoteIndexIn(quote: string, sourceText: string): number {
  const needle = forMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return -1;
  return forMatch(sourceText).indexOf(needle);
}

/**
 * Короче этого фрагмент доказательством строки не считается.
 *
 * «т;12,5» встречается в таблице столько раз, сколько в ней строк с таким
 * объёмом: по нему нельзя сказать, какую именно строку привела модель.
 * Порог отсекает такие обрывки — но отсекает, а не объявляет отсутствующими,
 * и это разные утверждения (см. `quoteTooShort`).
 */
export const MIN_QUOTE_CHARS = 8;

/**
 * Фрагмент слишком короток, чтобы быть доказательством.
 *
 * Отдельно от «цитаты нет в тексте», потому что чинят их по-разному: первое —
 * промпт, второе — доверие к модели. Пока обе причины назывались одинаково, на
 * живом прогоне две строки из трёх выбыли с сообщением «фрагмента с объёмом
 * нет в тексте документа», хотя фрагмент в документе был, и искать поломку
 * пошли бы в разбор файла.
 */
export function quoteTooShort(quote: string): boolean {
  return forMatch(quote).length < MIN_QUOTE_CHARS;
}

/** Есть ли цитата в тексте документа. */
export function quoteFoundIn(quote: string, sourceText: string): boolean {
  return quoteIndexIn(quote, sourceText) >= 0;
}

/**
 * Насколько далеко друг от друга могут стоять наименование и объём.
 *
 * Строка расплющенной таблицы вместе с её описанием занимает несколько сотен
 * знаков; тысяча — это уже соседние позиции ведомости, и брать из одной
 * наименование, а из другой объём нельзя.
 */
export const MAX_ANCHOR_DISTANCE = 1000;

/**
 * Стоят ли наименование и объём рядом хоть где-нибудь в документе.
 *
 * Сравнивать первые вхождения нельзя: в спецификации одно и то же наименование
 * повторяется десятки раз, и объём пятой строки всегда оказывается «далеко» от
 * первого упоминания названия. Поэтому перебираются вхождения фрагмента с
 * объёмом — он обычно уникален, — и для каждого проверяется окно вокруг.
 */
export function anchorsNear(
  nameQuote: string,
  quantityQuote: string,
  sourceText: string,
  maxDistance: number = MAX_ANCHOR_DISTANCE,
): boolean {
  const text = forMatch(sourceText);
  const name = forMatch(nameQuote);
  const quantity = forMatch(quantityQuote);
  if (name === "" || quantity === "") return false;

  let at = text.indexOf(quantity);
  // Предел перебора: документ, где фрагмент встречается тысячи раз, не должен
  // превращать проверку в перебор всего текста на каждую строку ведомости.
  for (let guard = 0; at >= 0 && guard < 500; guard += 1) {
    const from = Math.max(0, at - maxDistance);
    const to = at + quantity.length + maxDistance;
    if (text.slice(from, to).includes(name)) return true;
    at = text.indexOf(quantity, at + 1);
  }
  return false;
}

/**
 * Видно ли число в цитате.
 *
 * Число ищется в обоих написаниях — с запятой и с точкой — и с пробелами внутри
 * разрядов, потому что в документе оно может стоять как «1 234,5», а модель
 * вернёт 1234.5. Целое число сверяется и без дробной части: «12» в цитате
 * подтверждает объём 12.
 */
export function quantityVisibleIn(quantity: number, quote: string): boolean {
  /*
    Пробел убирается только там, где он разделяет разряды: между цифрой и
    ровно тремя следующими цифрами. Убирать любой пробел перед цифрой нельзя —
    «м3 1 240,5» превращалось в «м31240,5», единица прилипала к числу, и
    проверка границы по цифре отвергала верный объём.
  */
  const text = forMatch(quote).replace(/(\d)\s+(?=\d{3}(?!\d))/g, "$1");
  const plain = String(quantity);
  const variants = new Set([plain, plain.replace(".", ",")]);

  if (Number.isInteger(quantity)) {
    variants.add(`${plain},0`);
    variants.add(`${plain}.0`);
    variants.add(`${plain},00`);
    variants.add(`${plain}.00`);
  }

  for (const variant of variants) {
    // Границы по цифрам: «12» не должно подтверждаться числом «7124».
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\d.,])${escaped}(?![\\d])`).test(text)) return true;
  }
  return false;
}

/**
 * Собирает ведомость из строк модели, отбрасывая всё неподтверждённое.
 *
 * Порядок проверок — от дешёвых к дорогим и от общих к частным, чтобы причина
 * отказа была самой точной из применимых: сначала наименование и число, потом
 * единица, потом подтверждение текстом.
 */
export function extractBillItems(
  input: BillExtractionInput,
): BillExtractionResult {
  const items: BillOfWorkItem[] = [];
  const rejected: RejectedBillRow[] = [];
  const seen = new Set<string>();

  const reject = (
    row: BillExtractionRow,
    reason: BillRejectionReason,
    message: string,
  ): void => {
    rejected.push({ reason, row, message });
  };

  for (const row of input.rows) {
    const workName = row.workName.replace(/\s+/g, " ").trim();
    if (workName === "") {
      reject(row, "EMPTY_NAME", "Строка без наименования работы");
      continue;
    }

    const quantity = parseQuantity(row.quantity);
    if (quantity === null) {
      reject(
        row,
        "BAD_QUANTITY",
        `«${workName}»: объём «${String(row.quantity)}» не положительное число`,
      );
      continue;
    }

    if (isMoneyUnit(row.unit)) {
      reject(
        row,
        "MONEY_NOT_WORK",
        `«${workName}»: «${row.unit}» — это сумма, а не объём работ`,
      );
      continue;
    }

    const unit = parseUnit(row.unit);
    if (unit === null) {
      reject(
        row,
        "UNKNOWN_UNIT",
        `«${workName}»: единица «${row.unit}» не распознана`,
      );
      continue;
    }

    const quote = row.evidenceQuote.replace(/\s+/g, " ").trim();
    if (quoteTooShort(quote)) {
      reject(
        row,
        "QUOTE_TOO_SHORT",
        `«${workName}»: цитата короче ${String(MIN_QUOTE_CHARS)} знаков — по ней нельзя отличить строку от соседней`,
      );
      continue;
    }
    if (!quoteFoundIn(quote, input.sourceText)) {
      reject(
        row,
        "QUOTE_NOT_FOUND",
        `«${workName}»: цитаты нет в тексте документа`,
      );
      continue;
    }

    const suppliedQuantityQuote = (row.quantityQuote ?? quote)
      .replace(/\s+/g, " ")
      .trim();

    /*
      Короткий фрагмент объёма прощается, если число видно в самой цитате
      наименования. Смысл отдельного quantity_quote — доказать, что число
      принадлежит этой строке, а не соседней; когда цитата длинна, найдена в
      документе дословно и число стоит внутри неё, это уже доказано.

      Без послабления теряются выгрузки ГРАНД-Сметы: там наименование и объём
      стоят в одной строке через точку с запятой, и минимальный фрагмент с
      числом физически короток — «т;12,5». На живом прогоне так выбыли две
      позиции из трёх.

      Подменяется только слишком короткий фрагмент. Длинный, но не найденный в
      тексте, остаётся отказом: это уже не теснота формата, а выдумка.
    */
    const quantityQuote =
      quoteTooShort(suppliedQuantityQuote) && quantityVisibleIn(quantity, quote)
        ? quote
        : suppliedQuantityQuote;

    if (quoteTooShort(quantityQuote)) {
      reject(
        row,
        "QUANTITY_QUOTE_TOO_SHORT",
        `«${workName}»: фрагмент с объёмом короче ${String(MIN_QUOTE_CHARS)} знаков — по нему нельзя отличить строку от соседней`,
      );
      continue;
    }
    if (!quoteFoundIn(quantityQuote, input.sourceText)) {
      reject(
        row,
        "QUANTITY_QUOTE_NOT_FOUND",
        `«${workName}»: фрагмента с объёмом нет в тексте документа`,
      );
      continue;
    }

    if (!quantityVisibleIn(quantity, quantityQuote)) {
      reject(
        row,
        "QUANTITY_NOT_IN_QUOTE",
        `«${workName}»: объём ${String(quantity)} не встречается в цитате`,
      );
      continue;
    }

    if (!anchorsNear(quote, quantityQuote, input.sourceText)) {
      reject(
        row,
        "ANCHORS_TOO_FAR",
        `«${workName}»: наименование и объём стоят в разных местах документа`,
      );
      continue;
    }

    const key = `${workName.toLowerCase()}|${unit.unit}|${String(quantity)}`;
    if (seen.has(key)) {
      reject(row, "DUPLICATE", `«${workName}»: та же работа с тем же объёмом`);
      continue;
    }
    seen.add(key);

    items.push({
      id: `${input.idPrefix}-${String(items.length + 1)}`,
      workName,
      quantity: quantity * unit.multiplier,
      quantityUnit: unit.unit,
      /*
        Делитель равен единице: множитель уже учтён в объёме, а перевод под
        единицу нормы считается позже, когда норма подобрана и её единица
        известна. Ставить сюда догадку значило бы спрятать расхождение единиц,
        которое расчёт обязан показать.
      */
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      resourceCode: resourceCodeFromJustification(row.justification),
      sourceQuote:
        quantityQuote === quote ? quote : `${quote} … ${quantityQuote}`,
      sourceDocument: input.documentName,
    });
  }

  return { items, rejected };
}
