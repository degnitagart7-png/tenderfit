import { terAsFerNote } from "@/domain/estimate/bimMethod";
import { CSV_BOM } from "@/domain/estimate/export";
import { formatDecimal, WORK_CONDITIONS, workCondition } from "@/domain/estimate/normatives";
import type { WorkCondition } from "@/domain/estimate/normativeTypes";
import type {
  EstimateDocument,
  EstimateLine,
  EstimateResourceLine,
} from "@/domain/estimate/types";

/**
 * Локальный сметный расчёт по форме Приложения 3 к Методике 421/пр.
 *
 * Зачем отдельно от `export.ts`. Тот CSV — рабочая таблица нашего покроя: он
 * удобен, чтобы глазами проверить расчёт, и не притворяется документом. Форма
 * из приказа — другое: у неё двенадцать колонок в заданном порядке, ресурсные
 * строки под каждой расценкой, начисления НР и СП отдельными строками и шапка
 * с реквизитами редакции базы, письма об индексах и акта об оплате труда.
 * Сметчик и заказчик ждут именно её; таблицу с другими колонками они не примут,
 * даже если числа в ней те же.
 *
 * Как выглядит позиция. Эталон — выгрузка ГРАНД-Сметы, которую сметчик видит
 * каждый день: строка расценки с объёмом, условия работ, затем элементы затрат
 * ОТ(ЗТ), ЭМ, ОТм(ЗТм), М с суммами, «Итого прямые затраты», ФОТ, НР, СП и
 * «Всего по позиции». Под каждым элементом мы оставляем ресурсную расшифровку
 * (у ГРАНД это вариант «с расшифровкой ресурсов»): по ней проверяют, из чего
 * сложилась сумма элемента. Суммы элементов берутся из тех же строк ресурсов,
 * которые напечатаны под ними, поэтому ОТ + ЭМ + ОТм + М равна прямым затратам
 * позиции — расхождение было бы видно глазами и поймано тестом.
 *
 * Метод — ресурсно-индексный, поэтому берётся Приложение 3, а не 2 (базисно-
 * индексный) и не 4 (ресурсный). Смета по базисно-индексному методу (ФЕР-2020 × индексы Минстроя, `document.method ===
 * "BASE_INDEX"`) печатается в той же двенадцатиколоночной форме, но колонки 8–10 у неё заполнены: цена ФЕР в базисном уровне
 * 2001 года, индекс и цена в текущем уровне — они лежат в самих ресурсных строках (`baseUnitPrice`, `index`).
 *
 * Про пустые колонки. Колонки 8 и 9 — цена в базисном уровне и индекс — у
 * большинства строк остаются пустыми, и это не недоделка выгрузки, а состояние
 * данных: индексов пересчёта у проекта нет, они публикуются письмами Минстроя в
 * PDF. Там, где цена взята прямо из ФСЦСР, базисной цены и индекса не
 * существует вовсе, и печатать в этих колонках что-нибудь значило бы выдумать
 * обоснование. Вместо этого в конце формы стоит блок «Не заполнено в форме» с
 * перечнем реквизитов, которых у расчёта нет: пустая клетка, о которой сказано,
 * честнее заполненной наугад.
 *
 * Разделение строительных и монтажных работ идёт по книге нормы: ГЭСНм и ГЭСНмр
 * — монтажные, остальные — строительные. Это не догадка, а то, для чего книги
 * существуют, и в шапке формы такая разбивка обязательна.
 *
 * Типизированные строки. Форма одна, а потребителей три: CSV, книга Excel и
 * таблица на экране. Каждая строка поэтому несёт свой вид (`kind`) и объединения
 * ячеек (`spans`): оформление — жирный шрифт позиции, серый мелкий шрифт ресурсов,
 * объединённые подписи шапки — выбирает потребитель по виду строки, а состав и
 * порядок строк остаются в одном месте и не могут разойтись между файлом и экраном.
 */

const SEPARATOR = ";";
const NEWLINE = "\r\n";

/** Двенадцать колонок формы. Порядок и состав заданы приказом. */
export const COLUMN_COUNT = 12;

/** Книги монтажных работ: по ним идёт разбивка сметной стоимости в шапке. */
const ASSEMBLY_BOOKS = new Set(["ГЭСНм", "ГЭСНмр", "ФЕРм", "ФЕРмр"]);

export interface LocalEstimateFormInput {
  readonly document: EstimateDocument;
  /** Номер сметы в документации: печатается в заголовке формы. */
  readonly number: string;
  readonly constructionName: string;
  readonly objectName: string;
  /** Основание: чем задан состав работ — ведомость, задание, проект. */
  readonly basis: string;
  /** Наименование программного продукта — первая строка шапки формы. */
  readonly softwareName?: string;
  /**
   * Реквизиты письма Минстроя об индексах — из шапки сплит-формы ФГИС ЦС.
   *
   * Поле обязательное по приказу, но выдумывать его нельзя: без сплит-формы
   * расчёт индексов не применял, и там печатается прямая оговорка об этом.
   */
  readonly indexLetter?: string;
  /** Реквизиты акта субъекта об утверждении оплаты труда — оттуда же. */
  readonly wageAct?: string;
}

/** Строка формы: двенадцать ячеек, часть из них пустые. */
export type Row = readonly string[];

/**
 * Вид строки формы. По нему Excel и экран выбирают шрифт, выравнивание и рамки;
 * на состав ячеек вид не влияет.
 */
export type FormRowKind =
  | "appendix"
  | "field"
  | "name"
  | "caption"
  | "title"
  | "workTitle"
  | "costBlock"
  | "tableHead"
  | "columnNumbers"
  | "section"
  | "position"
  | "condition"
  | "element"
  | "resource"
  | "subtotal"
  | "accrual"
  | "positionTotal"
  | "sectionTotal"
  | "summaryHeading"
  | "summaryLine"
  | "summaryTotal"
  | "signature"
  | "note"
  | "blank";

/**
 * Объединение ячеек строки: колонки `from`…`to` включительно (с нуля), `rows` — сколько строк
 * вниз занимает объединение (по умолчанию одна). Текст лежит в первой ячейке объединения.
 */
export interface FormSpan {
  readonly from: number;
  readonly to: number;
  readonly rows?: number;
}

export interface FormRow {
  readonly kind: FormRowKind;
  readonly cells: Row;
  readonly spans?: readonly FormSpan[];
}

export function toLocalEstimateFormCsv(input: LocalEstimateFormInput): string {
  return (
    CSV_BOM +
    buildLocalEstimateFormRows(input).map(render).join(NEWLINE) +
    NEWLINE
  );
}

/**
 * Строки формы до превращения в файл.
 *
 * Вынесено отдельно, потому что форма одна, а файлов два: CSV открывается
 * где угодно и читается глазами, XLSX идёт в сметные программы. Собирать их
 * по отдельности значило бы держать две формы, которые расходятся при первой
 * же правке приказа.
 */
export function buildLocalEstimateFormRows(
  input: LocalEstimateFormInput,
): Row[] {
  return buildLocalEstimateForm(input).map((row) => row.cells);
}

const FULL_WIDTH: readonly FormSpan[] = [{ from: 0, to: COLUMN_COUNT - 1 }];
/** Реквизит шапки: подпись слева на полтаблицы, значение справа. */
const FIELD_SPANS: readonly FormSpan[] = [
  { from: 0, to: 5 },
  { from: 6, to: 11 },
];
/** Строки «Составлен», «Основание», «Составлен(а) в текущем уровне цен»: короткая подпись и значение во всю остальную ширину. */
const WIDE_FIELD_SPANS: readonly FormSpan[] = [
  { from: 0, to: 2 },
  { from: 3, to: 11 },
];

function row(kind: FormRowKind, cells: Row, spans?: readonly FormSpan[]): FormRow {
  return spans === undefined ? { kind, cells } : { kind, cells, spans };
}

const blank = (): FormRow => row("blank", []);

/** Форма целиком, строками с видом и объединениями. */
export function buildLocalEstimateForm(input: LocalEstimateFormInput): FormRow[] {
  const { document } = input;
  const rows: FormRow[] = [];
  const totals = document.totals;
  const sums = sumUp(document);
  const bim = document.method === "BASE_INDEX" ? document.bim : undefined;
  const baseIndex = document.method === "BASE_INDEX";

  const field = (label: string, value: string): void => {
    rows.push(row("field", [label, "", "", "", "", "", value], FIELD_SPANS));
  };
  const appendix = (text: string): void => {
    rows.push(row("appendix", ["", "", "", "", "", "", text], [{ from: 6, to: 11 }]));
  };

  // ---- в правом верхнем углу: к какому приложению Методики относится форма ----
  if (baseIndex) {
    appendix("Приложение № 2");
    appendix("Форма № 2");
  } else {
    appendix("Приложение № 3");
  }
  appendix("Утверждено приказом Минстроя РФ № 421/пр от 4 августа 2020 г.");

  // ---- шапка: реквизиты, без которых форма недействительна ----
  field(
    "Наименование программного продукта",
    input.softwareName ?? "TenderFit AI",
  );
  field("Наименование редакции сметных нормативов", editionText(document));
  field(
    "Реквизиты приказа Минстроя России об утверждении дополнений и изменений к сметным нормативам",
    NOT_FILLED.amendments,
  );
  field(
    "Реквизиты письма Минстроя России об индексах изменения сметной стоимости строительства",
    input.indexLetter ?? (bim === undefined ? NOT_FILLED.indices : bim.letter),
  );
  field(
    "Реквизиты нормативного правового акта об утверждении оплаты труда",
    input.wageAct ??
      (bim === undefined
        ? `Оплата труда по мониторингу цен, период ${document.wageScale.period.replace(/\.$/, "")}. Ставка 1 разряда ${money(document.wageScale.baseSalary)} ₽/чел.-ч`
        : "Не применялся: оплата труда принята по расценкам ФЕР-2020 в уровне цен 01.01.2000 с индексом Минстроя к оплате труда"),
  );
  /*
    Обоснование цен зависит от того, откуда они взялись. Со сплит-формой это
    сметные цены зоны и индексы к группам однородных ресурсов, без неё — выгрузка
    ФСЦСР и часть ресурсов в базисном уровне. Одна формулировка на оба случая
    была бы неверна в одном из них.
  */
  field(
    "Обоснование принятых текущих цен на строительные ресурсы",
    bim !== undefined
      ? `Базисно-индексный метод: расценки ФЕР-2020 в уровне цен 01.01.2000 × индексы к элементам прямых затрат на ${bim.quarter} (${bim.letter})`
      : input.indexLetter === undefined
      ? `ФСЦСР, зона ${document.priceZone}, период ${document.period}` +
        // Оговорка — только когда такие ресурсы в смете действительно остались: иначе форма утверждала бы то, чего нет.
        (hasBaseLevelResources(document) ? ". Ресурсы без текущей цены — в базисном уровне 01.01.2022" : "")
      : `Сплит-форма индексов и сметных цен ФГИС ЦС, зона ${document.priceZone}, период ${document.period}: сметные цены зоны и индексы к группам однородных строительных ресурсов`,
  );
  field("Наименование субъекта Российской Федерации", document.region);
  field("Наименование зоны субъекта Российской Федерации", document.priceZone);

  // ---- наименования и заголовок: по центру, каждое с пояснением мелким шрифтом ----
  rows.push(row("name", [input.constructionName], FULL_WIDTH));
  rows.push(row("caption", ["(наименование стройки)"], FULL_WIDTH));
  rows.push(row("name", [input.objectName], FULL_WIDTH));
  rows.push(row("caption", ["(наименование объекта капитального строительства)"], FULL_WIDTH));
  rows.push(row("title", [`ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № ${input.number}`], FULL_WIDTH));
  rows.push(row("workTitle", [document.title], FULL_WIDTH));
  rows.push(row("caption", ["(наименование работ и затрат)"], FULL_WIDTH));
  rows.push(
    row("field", ["Составлен", "", "", baseIndex ? "базисно-индексным методом" : "ресурсно-индексным методом"], WIDE_FIELD_SPANS),
  );
  rows.push(row("field", ["Основание", "", "", input.basis], WIDE_FIELD_SPANS));
  rows.push(row("caption", ["", "", "", "(проектная и (или) иная техническая документация)"], [{ from: 3, to: 11 }]));
  rows.push(
    row("field", ["Составлен(а) в текущем уровне цен", "", "", priceLevelLabel(document.period)], WIDE_FIELD_SPANS),
  );

  // ---- сметная стоимость и трудозатраты: обязательный блок шапки, в две колонки как у ГРАНД ----
  rows.push(costRow({ label: "Сметная стоимость", value: thousands(totals.workCost), unit: "тыс.руб." }));
  rows.push(costRow({ label: "в том числе:", indent: true }));
  rows.push(
    costRow(
      { label: "строительных работ", value: thousands(sums.buildCost), unit: "тыс.руб.", indent: true },
      { label: "Средства на оплату труда рабочих", value: thousands(sums.labourCost), unit: "тыс.руб." },
    ),
  );
  rows.push(
    costRow(
      { label: "монтажных работ", value: thousands(sums.assemblyCost), unit: "тыс.руб.", indent: true },
      { label: "Средства на оплату труда машинистов", value: thousands(sums.machinistCost), unit: "тыс.руб." },
    ),
  );
  rows.push(
    costRow(
      { label: "оборудования", value: thousands(0), unit: "тыс.руб.", indent: true },
      { label: "Нормативные затраты труда рабочих", value: quantity(sums.labourHours), unit: "чел.-ч." },
    ),
  );
  rows.push(
    costRow(
      { label: "прочих затрат", value: thousands(0), unit: "тыс.руб.", indent: true },
      { label: "Нормативные затраты труда машинистов", value: quantity(sums.machinistHours), unit: "чел.-ч." },
    ),
  );

  // ---- заголовок таблицы: две строки шапки и строка нумерации колонок ----
  rows.push(
    row(
      "tableHead",
      ["№ п/п", "Обоснование", "Наименование работ и затрат", "Единица измерения", "Количество", "", "", "Сметная стоимость, руб.", "", "", "", ""],
      [
        { from: 0, to: 0, rows: 2 },
        { from: 1, to: 1, rows: 2 },
        { from: 2, to: 2, rows: 2 },
        { from: 3, to: 3, rows: 2 },
        { from: 4, to: 6 },
        { from: 7, to: 11 },
      ],
    ),
  );
  rows.push(
    row("tableHead", [
      "",
      "",
      "",
      "",
      "на единицу измерения",
      "коэффициенты",
      "всего с учетом коэффициентов",
      "на единицу измерения в базисном уровне цен",
      "индекс",
      "на единицу измерения в текущем уровне цен",
      "коэффициенты",
      "всего в текущем уровне цен",
    ]),
  );
  rows.push(
    row(
      "columnNumbers",
      Array.from({ length: COLUMN_COUNT }, (_, index) => String(index + 1)),
    ),
  );

  // ---- разделы, позиции, ресурсы, начисления ----
  let number = 0;
  for (const [order, section] of document.sections.entries()) {
    const title = `${String(order + 1)}. ${section.title}`;
    rows.push(row("section", [`Раздел ${title}`], FULL_WIDTH));

    for (const line of section.lines) {
      number += 1;
      rows.push(...positionRows(line, number));
    }

    // «Итого прямые затраты по разделу» в ГРАНД не печатается — прямые затраты есть в итогах сметы.
    rows.push(sumRow("sectionTotal", `Итого по разделу ${title}`, section.workCost));
  }

  // ---- итоги сметы ----
  rows.push(...summaryRows(document, sums));

  // ---- подписи ----
  rows.push(blank());
  rows.push(row("signature", ["Составил ______________________ [должность, подпись (инициалы, фамилия)]"], FULL_WIDTH));
  rows.push(blank());
  rows.push(row("signature", ["Проверил ______________________ [должность, подпись (инициалы, фамилия)]"], FULL_WIDTH));

  // ---- что в форме осталось незаполненным: в CSV идёт за подписями, в Excel — отдельным листом ----
  rows.push(row("note", []));
  rows.push(row("note", ["Не заполнено в форме"]));
  for (const note of unfilled(document)) rows.push(row("note", [note]));
  rows.push(row("note", []));
  rows.push(row("note", [document.disclaimer]));

  return rows;
}

/**
 * Квартал для строки «Составлен(а) в текущем уровне цен».
 *
 * В документе период лежит словами сметчика-программиста: «3 квартал 2026 г.», у базисно-индексной
 * сметы — «III кв. 2026 (индексы Минстроя)». Форма требует «III квартал 2026 года», римской цифрой, как
 * в ГРАНД. Если период не разобрался, печатается как есть: выдумывать квартал нельзя.
 */
export function priceLevelLabel(period: string): string {
  const match = /^\s*(IV|I{1,3}|[1-4])\s*(?:-?й\s*)?(?:квартал|кв)\.?\s*(\d{4})/iu.exec(period);
  if (match === null) return period;
  const roman: Readonly<Record<string, string>> = { "1": "I", "2": "II", "3": "III", "4": "IV" };
  const raw = (match[1] ?? "").toUpperCase();
  return `${roman[raw] ?? raw} квартал ${match[2] ?? ""} года`;
}

/** Часть блока «Сметная стоимость»: подпись, значение и единица. */
interface CostCell {
  readonly label: string;
  readonly value?: string;
  readonly unit?: string;
  /** Подпись «в том числе» сдвинута вправо на одну колонку, как в ГРАНД. */
  readonly indent?: boolean;
}

/**
 * Строка блока «Сметная стоимость»: слева стоимость по видам работ, справа — оплата и затраты труда.
 *
 * Колонки: слева подпись 0–2 (с отступом 1–2), значение 3, единица 4; справа подпись 5–8, значение 9, единица 10.
 * Те же места держат и Excel, и экран — потому что диапазоны объединения идут вместе со строкой.
 */
function costRow(left: CostCell, right?: CostCell): FormRow {
  const cells = Array.from({ length: COLUMN_COUNT }, () => "");
  const spans: FormSpan[] = [];

  const leftFrom = left.indent === true ? 1 : 0;
  cells[leftFrom] = left.label;
  spans.push({ from: leftFrom, to: 2 });
  cells[3] = left.value ?? "";
  cells[4] = left.unit ?? "";

  if (right !== undefined) {
    cells[5] = right.label;
    spans.push({ from: 5, to: 8 });
    cells[9] = right.value ?? "";
    cells[10] = right.unit ?? "";
  }
  return row("costBlock", cells, spans);
}

/** Строка с подписью в наименовании и суммой в последней колонке. */
function sumRow(kind: FormRowKind, label: string, value: number, unitCost?: string): FormRow {
  const cells = Array.from({ length: COLUMN_COUNT }, () => "");
  cells[2] = label;
  if (unitCost !== undefined) cells[9] = unitCost;
  cells[11] = money(value);
  return row(kind, cells);
}

/** Приказы, по которым считаются НР, СП и сама смета: ГРАНД печатает их тем же списком. */
// Через запятую, а не точку с запятой: точка с запятой — разделитель CSV, и ячейка превращалась бы в кавычки.
const METHOD_ORDERS =
  "Приказ Минстроя России от 04.08.2020 № 421/пр, Приказ Минстроя России от 21.12.2020 № 812/пр, Приказ Минстроя России от 11.12.2020 № 774/пр";

/**
 * Строка «Наименование редакции сметных нормативов».
 *
 * Расчёт хранит редакцию как дату базы («01.01.2022»), как подпись базы или, у базисно-индексного метода,
 * как адрес файла ФГИС ЦС. Голая дата и адрес сметчику ничего не говорят: в ГРАНД-Смете и Smeta.RU здесь
 * стоит перечень приказов — об утверждении сметных нормативов и методик НР и СП. Подпись базы, если она
 * есть, остаётся первой, приказы методик дописываются за ней.
 */
export function editionText(document: EstimateDocument): string {
  if (document.method === "BASE_INDEX") {
    return `ФСНБ-2020 (Приказ Минстроя России от 26.12.2019 № 876/пр), расценки ФЕР-2020 в уровне цен 01.01.2000, ${METHOD_ORDERS}`;
  }
  const edition = document.baseEdition.trim();
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(edition)) {
    return `ФСНБ-2022 (Приказ Минстроя России от 30.12.2021 № 1046/пр), редакция на ${edition}, ${METHOD_ORDERS}`;
  }
  if (edition === "" || /^https?:/i.test(edition)) return `ФСНБ-2022 (Приказ Минстроя России от 30.12.2021 № 1046/пр), ${METHOD_ORDERS}`;
  return `${edition}, ${METHOD_ORDERS}`;
}

/** В смете остались ресурсы, у которых нет текущей цены и взята цена базы 01.01.2022 без пересчёта. */
export function hasBaseLevelResources(document: EstimateDocument): boolean {
  return document.sections.some((section) =>
    section.lines.some((line) => line.resources.some((resource) => resource.source === "BASE_2022")),
  );
}

/** Реквизиты, которых у расчёта нет. Формулировки печатаются в самой форме. */
const NOT_FILLED = {
  amendments: "не применялись",
  indices:
    "индексы не применялись — расчёт в текущих ценах ФСЦСР, часть ресурсов в базисном уровне 01.01.2022",
} as const;

/**
 * Обоснование позиции без пробела между книгой и кодом, как в ГРАНД: «ГЭСНр65-01-005-09».
 *
 * Исключение — позиции не из сборников норм («Цена заказчика —», «ФГИС ЦС перевозка 47-1»): там «книга» — это
 * словосочетание, и склеенная строка читалась бы как одно слово.
 */
function normReference(line: EstimateLine): string {
  const book = line.normBaseType;
  if (book.includes(" ") || line.normCode === "—") return `${book} ${line.normCode}`;
  return book === "ФСБЦ" ? `ФСБЦ-${line.normCode}` : `${book}${line.normCode}`;
}

/**
 * Позиция из одного материала: ГРАНД печатает её одной строкой, без элементов затрат и без ресурсов.
 *
 * Условия строгие, чтобы не спрятать расчёт: ни труда, ни машин, ни начислений, цена не из заказчика и не своя, а
 * сумма единственного ресурса совпадает с прямыми затратами — иначе одной строкой пришлось бы потерять разницу.
 */
function isMaterialOnly(line: EstimateLine): boolean {
  if (line.priceSource !== undefined) return false;
  const [only] = line.resources;
  if (line.resources.length !== 1 || only === undefined || only.kind !== "MATERIAL") return false;
  if (line.labourCost !== 0 || line.machineCost !== 0 || line.wageFund !== 0) return false;
  if (line.overheadCost !== 0 || line.profitCost !== 0) return false;
  return Math.abs(only.total - line.directCost) < 0.01;
}

/** Одна позиция: расценка, условия работ, элементы затрат с ресурсами, начисления и итог. */
function positionRows(line: EstimateLine, number: number): FormRow[] {
  const rows: FormRow[] = [];
  const amount = quantity(line.quantity);
  // Стоимость единицы измерения расценки: «Всего по позиции» ÷ объём, как в колонке 10 у ГРАНД.
  const unitCost = (value: number): string | undefined =>
    line.quantity === 0 ? undefined : money(value / line.quantity);

  if (isMaterialOnly(line)) {
    const [only] = line.resources;
    if (only !== undefined) {
      rows.push(
        row("position", [
          String(number),
          normReference(line),
          line.normName,
          line.normUnit,
          amount,
          "1",
          amount,
          // Цена в базисном уровне и индекс (колонки 8 и 9) — те же, что в ресурсной строке материала.
          only.baseUnitPrice === undefined ? "" : money(only.baseUnitPrice),
          only.index === undefined ? "" : indexText(only.index),
          money(only.unitPrice),
          "",
          money(only.total),
        ]),
      );
      rows.push(sumRow("positionTotal", "Всего по позиции", lineTotal(line)));
      return rows;
    }
  }

  rows.push(
    row("position", [
      String(number),
      normReference(line),
      line.normName,
      line.normUnit,
      amount,
      "1",
      amount,
      "",
      "",
      "",
      "",
      "",
    ]),
  );

  rows.push(...conditionRows(line));
  rows.push(...elementRows(line));

  // Цена заказчика уже включает его НР и СП: строки «НР 0 %, резерв документа»
  // читались бы как наш пропуск норматива, а это не он.
  if (line.priceSource === "CUSTOMER_PRICE") {
    rows.push(sumRow("positionTotal", "Всего по позиции (по цене заказчика, с его НР и СП)", lineTotal(line), unitCost(lineTotal(line))));
    return rows;
  }
  // Своя цена, названная человеком при правке ведомости: готовая цена за единицу, НР и СП не начисляются.
  if (line.priceSource === "OWN_PRICE") {
    rows.push(
      sumRow("positionTotal", `Всего по позиции (${line.priceNote ?? "своя цена, указана вручную"}; НР и СП не начисляются)`, lineTotal(line), unitCost(lineTotal(line))),
    );
    return rows;
  }
  // Сметная цена услуги (перевозка, погрузка) НР и СП не несёт — как и в смете заказчика по 421/пр.
  if (line.priceSource === "FGIS_SERVICE") {
    rows.push(
      sumRow("positionTotal", `Всего по позиции (${line.priceNote ?? "сметная цена услуги ФГИС ЦС"}; НР и СП не начисляются)`, lineTotal(line), unitCost(lineTotal(line))),
    );
    return rows;
  }

  rows.push(sumRow("subtotal", "Итого прямые затраты", line.directCost));
  rows.push(sumRow("subtotal", "ФОТ", line.wageFund));
  const multipliers = line.rateMultipliers;
  rows.push(
    accrual("НР", line.overheadRef, line.overheadPercent, line.overheadCost, multipliers === undefined ? undefined : { base: multipliers.baseOverheadPercent, factor: multipliers.overhead }),
  );
  rows.push(
    accrual("СП", line.profitRef, line.profitPercent, line.profitCost, multipliers === undefined ? undefined : { base: multipliers.baseProfitPercent, factor: multipliers.profit }),
  );
  rows.push(sumRow("positionTotal", "Всего по позиции", lineTotal(line), unitCost(lineTotal(line))));

  return rows;
}

/** Колонка таблицы приложения 10 по книге нормы. Сборник 46 стоит в колонке ГЭСНр, но кода сборника в строке сметы нет — берётся значение по книге. */
const COEFFICIENT_COLUMN: Readonly<Record<string, "gesn" | "gesnm" | "gesnr" | "gesnp">> = {
  "ГЭСН": "gesn",
  "ГЭСНм": "gesnm",
  "ГЭСНр": "gesnr",
  "ГЭСНп": "gesnp",
};

/** Показатели коэффициентов в подписи: «ОЗП=1,2; ЭМ=1,2 к расх.; …», как в ГРАНД. */
function coefficientText(condition: WorkCondition, baseType: string): string {
  const column = COEFFICIENT_COLUMN[baseType];
  const own = column === undefined ? undefined : condition.coefficients[column];
  const value =
    typeof own === "number"
      ? own
      : Object.values(condition.coefficients).find((candidate): candidate is number => typeof candidate === "number");
  if (value === undefined) return "";
  const k = formatDecimal(value);
  // Снижение производительности меняет и часы, и, через них, оплату; повышенная оплата — только деньги.
  if (condition.kind === "PRODUCTIVITY") return `ОЗП=${k}; ЭМ=${k} к расх.; ЗПМ=${k}; ТЗ=${k}; ТЗМ=${k}`;
  const parts: string[] = [];
  if (condition.appliesTo.includes("LABOUR_PAY")) parts.push(`ОЗП=${k}`);
  if (condition.appliesTo.includes("MACHINIST_PAY")) parts.push(`ЗПМ=${k}`);
  return parts.join("; ");
}

/**
 * Строки условий работ: по одной на применённое условие приложения 10 и на коэффициент п. 58.
 *
 * Идентификатор, которого нет в справочнике, печатается как есть: скрыть применённый коэффициент
 * хуже, чем показать его невнятно.
 */
function conditionRows(line: EstimateLine): FormRow[] {
  const coefficients = line.coefficients;
  if (coefficients === undefined) return [];
  const rows: FormRow[] = [];

  for (const id of coefficients.conditionIds) {
    const condition = workCondition(id);
    if (condition === null) {
      rows.push(conditionRow(id, id));
      continue;
    }
    const suffix = coefficientText(condition, line.normBaseType);
    rows.push(
      conditionRow(
        `421/пр_2020_прил.10_т.${String(condition.table)}_п.${condition.item}`,
        suffix === "" ? condition.text : `${condition.text} ${suffix}`,
      ),
    );
  }

  for (const id of coefficients.adjustmentIds) {
    const adjustment = WORK_CONDITIONS.adjustments.find((item) => item.id === id);
    if (adjustment === undefined) {
      rows.push(conditionRow(id, id));
      continue;
    }
    const labour = formatDecimal(adjustment.labour);
    const machines = formatDecimal(adjustment.machines);
    rows.push(
      conditionRow(
        "421/пр_2020_п.58",
        `${adjustment.label} ОЗП=${labour}; ТЗ=${labour}; ЭМ=${machines} к расх.; ЗПМ=${machines}; ТЗМ=${machines}`,
      ),
    );
  }
  return rows;
}

function conditionRow(reference: string, text: string): FormRow {
  return row("condition", ["", reference, text]);
}

/** Суммы элементов затрат одной позиции. */
export interface LineElements {
  readonly labour: number;
  readonly machines: number;
  readonly machinist: number;
  readonly materials: number;
  readonly labourHours: number;
  readonly machinistHours: number;
}

const LABOUR_KINDS: readonly EstimateResourceLine["kind"][] = ["LABOUR", "WORKER_HOURS_TOTAL"];
const MACHINE_KINDS: readonly EstimateResourceLine["kind"][] = ["MACHINE"];
const MATERIAL_KINDS: readonly EstimateResourceLine["kind"][] = ["MATERIAL", "UNKNOWN"];

const cents = (value: number): number => Math.round(value * 100) / 100;

/** Оплата труда машинистов позиции, ₽: сумма по машинам, у которых оплата звена известна. */
function machinistPay(line: EstimateLine): number {
  const machines = line.resources.filter((item) => item.kind === "MACHINE" && item.machinistPayTotal !== undefined);
  return cents(machines.reduce((sum, item) => sum + (item.machinistPayTotal as number), 0));
}

/**
 * Элементы затрат позиции — ровно по тем строкам, что печатаются под ними (`rateColumns`).
 *
 * Поэтому ЭМ без оплаты машинистов, а ОТм — отдельно, и ОТ + ЭМ + ОТм + М равна прямым затратам позиции. Часы
 * труда рабочих включают специалистов (3-*): у ГРАНД в ОТ(ЗТ) они тоже стоят, а оплачены они в той же статье.
 */
export function lineElements(line: EstimateLine): LineElements {
  const sumOf = (kinds: readonly EstimateResourceLine["kind"][]): number =>
    cents(
      line.resources
        .filter((item) => kinds.includes(item.kind))
        .reduce((sum, item) => sum + rateColumns(line, item).total, 0),
    );
  return {
    labour: sumOf(LABOUR_KINDS),
    machines: sumOf(MACHINE_KINDS),
    machinist: machinistPay(line),
    materials: sumOf(MATERIAL_KINDS),
    labourHours: line.labourHours + line.specialistHours,
    machinistHours: line.machinistHours,
  };
}

/**
 * Элементы затрат позиции: ОТ(ЗТ), ЭМ, ОТм(ЗТм), М и под каждым — ресурсная расшифровка.
 *
 * Элемент без ресурсов не печатается: пустая строка «ЭМ» в смете означала бы,
 * что машины есть, а стоимость нулевая, — а её просто нет в норме.
 */
function elementRows(line: EstimateLine): FormRow[] {
  const elements = lineElements(line);
  const rows: FormRow[] = [];

  const labour = resourceRows(line, LABOUR_KINDS);
  if (labour.length > 0) {
    rows.push(elementRow("1", "ОТ(ЗТ)", "чел.-ч", elements.labourHours, elements.labour), ...labour);
  }
  const machines = resourceRows(line, MACHINE_KINDS);
  if (machines.length > 0) {
    rows.push(elementRow("2", "ЭМ", "", null, elements.machines), ...machines);
  }
  rows.push(...machinistRows(line, elements));
  const materials = resourceRows(line, MATERIAL_KINDS);
  if (materials.length > 0) {
    rows.push(elementRow("4", "М", "", null, elements.materials), ...materials);
  }
  return rows;
}

/** Строка элемента затрат: номер элемента в обосновании, часы — в колонку 7, сумма — в колонку 12. */
function elementRow(code: string, label: string, unit: string, hours: number | null, cost: number): FormRow {
  const cells = Array.from({ length: COLUMN_COUNT }, () => "");
  cells[1] = code;
  cells[2] = label;
  cells[3] = unit;
  if (hours !== null && hours > 0) cells[6] = quantity(hours);
  cells[11] = money(cost);
  return row("element", cells);
}

/** Ресурсные строки позиции выбранных видов. */
function resourceRows(
  line: EstimateLine,
  kinds: readonly EstimateResourceLine["kind"][],
): FormRow[] {
  const wanted = new Set(kinds);
  const rows: FormRow[] = [];
  for (const item of line.resources) {
    if (!wanted.has(item.kind)) continue;
    const columns = rateColumns(line, item);
    rows.push(
      row("resource", [
        "",
        item.code,
        item.name,
        item.unit,
        columns.rate,
        columns.factor,
        quantity(item.quantity),
        // Цена в базисном уровне и индекс (колонки 8 и 9): у БИМ — уровень 2001 года и индекс письма, у РИМ — база 01.01.2022 и отношение цен.
        item.baseUnitPrice === undefined ? "" : money(item.baseUnitPrice),
        item.index === undefined ? "" : indexText(item.index),
        columns.price === 0 ? "" : money(columns.price),
        columns.priceFactor,
        columns.total === 0 ? "" : money(columns.total),
      ]),
    );
  }
  return rows;
}

/**
 * Строки «ОТм(ЗТм)» — оплата труда машинистов отдельной строкой, как в форме 421/пр.
 *
 * В расчёте стоимость машины полная: цена маш.-ч вместе с оплатой звена (так устроена база ФСБЦ, а цену ФГИС ЦС, опубликованную без
 * оплаты, расчёт дополняет её отдельной колонкой). Форма печатает иначе: ЭМ — цена без оплаты машинистов, а оплата идёт своими
 * строками, и «Итого прямые затраты» = ОТ + ЭМ + ОТм + М. Строки ЭМ выше уже напечатаны без оплаты звена (`rateColumns`), здесь —
 * сама оплата: одной строкой по звеньям всех машин позиции. Разбить её по разрядам (4-100-040, 4-100-050…) расчёт не умеет: он
 * хранит оплату суммой по машине, а не по разрядам, — поэтому в графе «обоснование» стоит общий шифр группы.
 *
 * Строка в количество кладёт часы машинистов позиции (по нормативным 4-100-* и коду «2»); цена — средняя ставка, как у труда рабочих.
 * Позиция без машин с известной оплатой звена, а также смета, посчитанная до появления поля, строк ОТм не получает: машины в ней
 * напечатаны полной ценой, и сумма строк по-прежнему равна прямым затратам.
 */
function machinistRows(line: EstimateLine, elements: LineElements): FormRow[] {
  const pay = elements.machinist;
  if (pay === 0) return [];
  const hours = line.machinistHours;
  // Колонки 5 и 6 — как у ЭМ: расход на единицу расценки и коэффициент условий работ к времени машин (он же к труду машинистов).
  const factor = line.bim === undefined ? (line.coefficients?.machines ?? 1) : 1;
  const rate = hours > 0 && factor > 0 && line.quantity !== 0 ? hours / (line.quantity * factor) : null;
  return [
    elementRow("", "ОТм(ЗТм)", "чел.-ч", hours, pay),
    row("resource", [
      "",
      "4-100",
      "Оплата труда машинистов (звено машин позиции)",
      "чел.-ч",
      rate === null ? "" : decimal(rate, 6).replace(/,?0+$/, ""),
      factor !== 1 ? decimal(factor, 2) : "",
      hours > 0 ? quantity(hours) : "",
      "",
      "",
      hours > 0 ? money(cents(pay / hours)) : "",
      "",
      money(pay),
    ]),
  ];
}

/**
 * Колонки 5, 6, 10 и 11 ресурсной строки.
 *
 * — 5: расход на единицу измерения расценки = расход на позицию ÷ (объём в единицах нормы × коэффициент к расходу);
 * — 6: коэффициент к расходу (условия работ, коэффициенты заказчика, 571/пр п. 83, 84), если он не единица;
 * — 11: коэффициент к цене — повышенный размер оплаты труда рабочих (421/пр, таблицы 2, 4, 6, 8); цена в колонке 10 тогда без него.
 * Строки без нормы расхода (материалы по сумме заказчика, своя цена) и сметы БИМ — без изменений, колонки пусты.
 */
function rateColumns(
  line: EstimateLine,
  item: EstimateResourceLine,
): { rate: string; factor: string; price: number; priceFactor: string; total: number } {
  /*
    Цена и сумма строки ЭМ — без оплаты труда машинистов, если она известна (`machinistPay`): она печатается отдельными строками ОТм
    (`machinistRows`). Сумма по строкам ЭМ плюс строка ОТм равна стоимости машин в расчёте.
  */
  const withoutPay = item.kind === "MACHINE" && item.machinistPay !== undefined && item.machinistPayTotal !== undefined;
  const price = withoutPay ? cents(item.unitPrice - (item.machinistPay as number)) : item.unitPrice;
  const total = withoutPay ? cents(item.total - (item.machinistPayTotal as number)) : item.total;
  const plain = { rate: "", factor: "", price, priceFactor: "", total };
  if (line.bim !== undefined || item.source === "CUSTOMER_SUM" || item.source === "OWN_PRICE") return plain;

  const coefficients = line.coefficients;
  const factor =
    item.kind === "LABOUR" || item.kind === "WORKER_HOURS_TOTAL"
      ? (coefficients?.labour ?? 1)
      : item.kind === "MACHINE" || item.kind === "MACHINIST_HOURS"
        ? (coefficients?.machines ?? 1)
        : item.kind === "MATERIAL"
          ? (coefficients?.materials ?? 1)
          : 1;
  const rate = factor > 0 && line.quantity !== 0 ? item.quantity / (line.quantity * factor) : null;

  const wage = item.kind === "LABOUR" ? (coefficients?.wage ?? 1) : 1;
  const wageApplied = wage !== 1 && wage > 0;
  return {
    rate: rate === null ? "" : decimal(rate, 6).replace(/,?0+$/, ""),
    factor: factor !== 1 ? decimal(factor, 2) : "",
    price: wageApplied ? cents(item.unitPrice / wage) : price,
    priceFactor: wageApplied ? decimal(wage, 2) : "",
    total,
  };
}

/** Строка начисления: указатель приказа в обоснование, процент — в количество. */
function accrual(
  label: string,
  ref: string | null,
  percentValue: number,
  cost: number,
  multiplier?: { readonly base: number; readonly factor: number },
): FormRow {
  // Множитель заказчика к НР или СП (812/пр п. 25, 774/пр п. 16): норматив по указателю — в колонку 5, множитель — в 6, итоговый процент — в 7.
  const withFactor = multiplier !== undefined && multiplier.factor !== 1;
  return row("accrual", [
    "",
    ref ?? "резерв документа",
    label,
    "%",
    plain(withFactor ? multiplier.base : percentValue),
    withFactor ? decimal(multiplier.factor, 2) : "",
    plain(percentValue),
    "",
    "",
    "",
    "",
    money(cost),
  ]);
}

/** Стоимость позиции: прямые затраты вместе с начислениями. */
function lineTotal(line: EstimateLine): number {
  return line.directCost + line.overheadCost + line.profitCost;
}

/** Итоги по группе позиций (строительные или монтажные работы) в разрезе элементов затрат. */
interface GroupSums {
  labour: number;
  machines: number;
  machinist: number;
  materials: number;
  overhead: number;
  profit: number;
  total: number;
}

const emptyGroup = (): GroupSums => ({ labour: 0, machines: 0, machinist: 0, materials: 0, overhead: 0, profit: 0, total: 0 });

function addToGroup(group: GroupSums, line: EstimateLine): void {
  const elements = lineElements(line);
  group.labour += elements.labour;
  group.machines += elements.machines;
  group.machinist += elements.machinist;
  // Материалы — остаток прямых затрат: позиция по цене заказчика без ресурсов (оборудование, ТЦ) целиком идёт сюда,
  // и итоги по элементам всегда складываются в прямые затраты.
  group.materials += line.directCost - elements.labour - elements.machines - elements.machinist;
  group.overhead += line.overheadCost;
  group.profit += line.profitCost;
  group.total += lineTotal(line);
}

interface Sums {
  readonly buildCost: number;
  readonly assemblyCost: number;
  readonly labourCost: number;
  readonly machinistCost: number;
  readonly labourHours: number;
  readonly machinistHours: number;
  readonly build: GroupSums;
  readonly assembly: GroupSums;
}

function sumUp(document: EstimateDocument): Sums {
  let buildCost = 0;
  let assemblyCost = 0;
  let labourCost = 0;
  let machinistCost = 0;
  let labourHours = 0;
  let machinistHours = 0;
  const build = emptyGroup();
  const assembly = emptyGroup();

  for (const section of document.sections) {
    for (const line of section.lines) {
      const cost = lineTotal(line);
      if (ASSEMBLY_BOOKS.has(line.normBaseType)) {
        assemblyCost += cost;
        addToGroup(assembly, line);
      } else {
        buildCost += cost;
        addToGroup(build, line);
      }
      labourCost += line.labourCost;
      machinistCost += line.machinistSalaryCost;
      // Часы специалистов (3-*) стоят в ОТ(ЗТ) позиции и оплачены в «оплате труда рабочих» — как у ГРАНД, так что и в итогах они вместе.
      labourHours += line.labourHours + line.specialistHours;
      machinistHours += line.machinistHours;
    }
  }

  return {
    buildCost,
    assemblyCost,
    labourCost,
    machinistCost,
    labourHours,
    machinistHours,
    build,
    assembly,
  };
}

/**
 * Блок «Итоги по смете» по образцу ГРАНД: прямые затраты по элементам, затем строительные и монтажные
 * работы, «Всего», справочные ФОТ/НР/СП, лимитированные затраты, НДС и «ВСЕГО по смете».
 *
 * Лимитированные затраты и НДС по Методике считаются в сводном сметном расчёте (глава 9), а не в
 * локальной смете. Выбросить их значило бы потерять числа, которые считались и показаны на экране, —
 * поэтому они идут строками ниже «Всего» с оговоркой «справочно», и «ВСЕГО по смете» совпадает с итогом на экране.
 */
function summaryRows(document: EstimateDocument, sums: Sums): FormRow[] {
  const totals = document.totals;
  const rows: FormRow[] = [];
  const pad = (level: number): string => " ".repeat(level * 5);
  const line = (level: number, label: string, value?: number): FormRow => {
    const cells = Array.from({ length: COLUMN_COUNT }, () => "");
    cells[2] = `${pad(level)}${label}`;
    if (value !== undefined) cells[11] = money(value);
    return row("summaryLine", cells);
  };
  const hours = (label: string, value: number): FormRow => {
    const cells = Array.from({ length: COLUMN_COUNT }, () => "");
    cells[2] = `${pad(2)}${label}`;
    cells[6] = quantity(value);
    return row("summaryLine", cells);
  };
  const total = (label: string, value: number): FormRow => {
    const cells = Array.from({ length: COLUMN_COUNT }, () => "");
    cells[2] = label;
    cells[11] = money(value);
    return row("summaryTotal", cells);
  };

  const all = emptyGroup();
  for (const group of [sums.build, sums.assembly]) {
    all.labour += group.labour;
    all.machines += group.machines;
    all.machinist += group.machinist;
    all.materials += group.materials;
  }

  rows.push(row("summaryHeading", ["", "", "Итоги по смете:"]));
  rows.push(line(1, "Всего прямые затраты (справочно)", totals.directCost));
  rows.push(line(2, "в том числе:"));
  rows.push(line(3, "Оплата труда рабочих", all.labour));
  rows.push(line(3, "Эксплуатация машин", all.machines));
  rows.push(line(3, "Оплата труда машинистов (Отм)", all.machinist));
  rows.push(line(3, "Материалы", all.materials));

  for (const [title, group] of [
    ["Строительные работы", sums.build],
    ["Монтажные работы", sums.assembly],
  ] as const) {
    // Пустая группа (в смете нет монтажных работ) не печатается: строка с нулём читалась бы как работы без стоимости.
    if (Math.abs(group.total) < 0.005) continue;
    rows.push(line(1, title, group.total));
    rows.push(line(2, "в том числе:"));
    rows.push(line(3, "оплата труда", group.labour));
    rows.push(line(3, "эксплуатация машин и механизмов", group.machines));
    rows.push(line(3, "оплата труда машинистов (Отм)", group.machinist));
    rows.push(line(3, "материалы", group.materials));
    rows.push(line(3, "накладные расходы", group.overhead));
    rows.push(line(3, "сметная прибыль", group.profit));
  }

  rows.push(total("Всего", totals.workCost));
  rows.push(line(1, "Всего ФОТ (справочно)", totals.wageFund));
  rows.push(line(1, "Всего накладные расходы (справочно)", totals.overheadCost));
  rows.push(line(1, "Всего сметная прибыль (справочно)", totals.profitCost));

  const limited = document.parameters.limited;
  const hasWinter = totals.winterSurcharge !== 0;
  const hasTemporary = totals.temporaryStructures !== 0;
  if (hasWinter) {
    rows.push(
      line(1, `Зимнее удорожание, ${percent(limited.winterSurchargePercent)} (лимитированные затраты главы 9 ССР, справочно)`, totals.winterSurcharge),
    );
  }
  if (hasTemporary) {
    rows.push(
      line(1, `Временные здания и сооружения, ${percent(limited.temporaryStructuresPercent)} (лимитированные затраты главы 9 ССР, справочно)`, totals.temporaryStructures),
    );
  }
  if (hasWinter || hasTemporary) rows.push(total("Итого", totals.beforeVat));
  rows.push(line(1, `НДС ${percent(document.parameters.vatPercent)}`, totals.vat));
  rows.push(total("ВСЕГО по смете", totals.total));

  rows.push(line(1, "справочно:"));
  rows.push(hours("Затраты труда рабочих", sums.labourHours));
  rows.push(hours("Затраты труда машинистов", sums.machinistHours));
  return rows;
}

/**
 * Перечень реквизитов формы, которых у расчёта нет.
 *
 * Список собирается из самого документа, а не пишется вручную: если индексы
 * появятся, строка про них исчезнет сама, и форма перестанет утверждать, что
 * их нет.
 */
export function unfilled(document: EstimateDocument): string[] {
  const notes: string[] = [];

  if (document.method === "BASE_INDEX") {
    notes.push(
      "Базисно-индексный метод: колонки 8–10 заполнены по элементам затрат (ОЗП, ЭМ, МАТ) — цена расценки ФЕР-2020 на 01.01.2000, " +
        "индекс письма Минстроя и цена в текущем уровне; оплата машинистов входит в ЭМ.",
    );
    notes.push(
      "Колонки 6 и 11 (коэффициенты) у ресурсных строк не заполнены: коэффициенты условий производства работ к расценкам ФЕР в расчёте не применялись.",
    );
    notes.push("Колонка 5 ресурсных строк (расход на единицу измерения) не заполнена: колонка 7 заполнена.");
    notes.push("Оборудование и прочие затраты не выделены: расчёт ведётся по ведомости работ.");
    if (document.bim?.customerBase === "TER") notes.push(terAsFerNote(document.bim.subject));
    if (document.bim !== undefined && !document.bim.objectDetected) {
      notes.push(`Объект строительства по наименованию определить однозначно не удалось: индексы взяты по «${document.bim.object}».`);
    }
    const withoutRate = document.gaps.filter((gap) => gap.kind === "NO_OVERHEAD_RATE").length;
    if (withoutRate > 0) notes.push(`Позиций с резервным нормативом НР или СП: ${String(withoutRate)} — норматив по виду работ не найден.`);
    return notes;
  }

  /*
    Колонки 8 и 9 пусты даже когда индексы применены. Причина другая: расчёт
    хранит цену ресурса уже после пересчёта, а базисную составляющую и сам
    индекс по строке — нет. Написать здесь «индексы не применялись» после того,
    как они применились, значило бы соврать в обратную сторону.
  */
  notes.push(
    "Колонки 8 и 9 (базисный уровень цен и индекс) заполнены у машин и материалов: базисная цена — по ФСБЦ-2022 на 01.01.2022, " +
      "индекс — отношение текущей цены ресурса к базисной (письмо Минстроя с индексами по элементам затрат не применялось). " +
      "У оплаты труда (ставка по мониторингу) и у ресурсов без цены в базе колонки не заполнены.",
  );
  notes.push(
    "Колонки 6 и 11 (коэффициенты) у ресурсных строк заполнены только там, где к строке применён коэффициент: условия производства работ " +
      "(приложение 10 к Методике 421/пр), коэффициенты заказчика, повышенная оплата труда. В остальных строках они равны единице и не заполнены.",
  );
  notes.push(
    "Колонка 5 (расход на единицу измерения) у ресурсных строк заполнена как расход ресурса на позицию, делённый на объём в единицах расценки и коэффициент. " +
      "У строк по сумме заказчика и по своей цене не заполнена.",
  );
  notes.push(
    "Оборудование и прочие затраты не выделены: расчёт ведётся по ведомости работ, " +
      "поставка оборудования в нём не разделена с материалами.",
  );

  const withoutCurrentPrice = document.gaps.filter(
    (gap) => gap.kind === "NO_CURRENT_PRICE",
  ).length;
  if (withoutCurrentPrice > 0) {
    notes.push(
      `Ресурсов без текущей цены: ${String(withoutCurrentPrice)} — приняты в базисном уровне 01.01.2022 без индекса.`,
    );
  }

  const withoutRate = document.gaps.filter(
    (gap) => gap.kind === "NO_OVERHEAD_RATE",
  ).length;
  if (withoutRate > 0) {
    notes.push(
      `Позиций с резервным нормативом НР или СП: ${String(withoutRate)} — норматив по виду работ не найден.`,
    );
  }

  return notes;
}

function render(row: Row): string {
  const cells = Array.from(
    { length: Math.max(COLUMN_COUNT, row.length) },
    (_, index) => escape(row[index] ?? ""),
  );
  return cells.join(SEPARATOR);
}

function escape(value: string): string {
  if (!/[";\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Числа — с запятой в дробной части: русский Excel иначе читает их текстом. */
function decimal(value: number, digits: number): string {
  return value.toFixed(digits).replace(".", ",");
}

function money(value: number): string {
  return decimal(value, 2);
}

function thousands(value: number): string {
  return decimal(value / 1000, 2);
}

function quantity(value: number): string {
  return decimal(value, 6).replace(/,?0+$/, "");
}

/** Индекс пересчёта: до пяти знаков без хвоста нулей («1,1», «1,04236», «47,58»). */
function indexText(value: number): string {
  return decimal(value, 5).replace(/,?0+$/, "");
}

/** Число без знака процента: единица «%» стоит в своей колонке, а ячейка остаётся числом. */
function plain(value: number): string {
  return decimal(value, 2).replace(/,?0+$/, "");
}

function percent(value: number): string {
  return `${plain(value)} %`;
}
