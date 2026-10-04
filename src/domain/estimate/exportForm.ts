import { CSV_BOM } from "@/domain/estimate/export";
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
 * Метод — ресурсно-индексный, поэтому берётся Приложение 3, а не 2 (базисно-
 * индексный) и не 4 (ресурсный).
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
 */

const SEPARATOR = ";";
const NEWLINE = "\r\n";

/** Двенадцать колонок формы. Порядок и состав заданы приказом. */
export const COLUMN_COUNT = 12;

/** Книги монтажных работ: по ним идёт разбивка сметной стоимости в шапке. */
const ASSEMBLY_BOOKS = new Set(["ГЭСНм", "ГЭСНмр"]);

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
  const { document } = input;
  const rows: Row[] = [];
  const totals = document.totals;
  const sums = sumUp(document);

  const field = (label: string, value: string): void => {
    rows.push([label, "", value]);
  };

  // ---- шапка: реквизиты, без которых форма недействительна ----
  field(
    "Наименование программного продукта",
    input.softwareName ?? "TenderFit AI",
  );
  field("Наименование редакции сметных нормативов", document.baseEdition);
  field(
    "Реквизиты приказа Минстроя России об утверждении дополнений и изменений к сметным нормативам",
    NOT_FILLED.amendments,
  );
  field(
    "Реквизиты письма Минстроя России об индексах изменения сметной стоимости строительства",
    input.indexLetter ?? NOT_FILLED.indices,
  );
  field(
    "Реквизиты нормативного правового акта об утверждении оплаты труда",
    input.wageAct ??
      `Оплата труда по мониторингу цен, период ${document.wageScale.period}. Ставка 1 разряда ${money(document.wageScale.baseSalary)} ₽/чел.-ч`,
  );
  /*
    Обоснование цен зависит от того, откуда они взялись. Со сплит-формой это
    сметные цены зоны и индексы к группам однородных ресурсов, без неё — выгрузка
    ФСЦСР и часть ресурсов в базисном уровне. Одна формулировка на оба случая
    была бы неверна в одном из них.
  */
  field(
    "Обоснование принятых текущих цен на строительные ресурсы",
    input.indexLetter === undefined
      ? `ФСЦСР, зона ${document.priceZone}, период ${document.period}. Ресурсы без текущей цены — в базисном уровне 01.01.2022`
      : `Сплит-форма индексов и сметных цен ФГИС ЦС, зона ${document.priceZone}, период ${document.period}: сметные цены зоны и индексы к группам однородных строительных ресурсов`,
  );
  field("Наименование субъекта Российской Федерации", document.region);
  field("Наименование зоны субъекта Российской Федерации", document.priceZone);
  rows.push([]);
  field("Наименование стройки", input.constructionName);
  field("Наименование объекта капитального строительства", input.objectName);
  rows.push([]);
  rows.push([`ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) N ${input.number}`]);
  rows.push([document.title]);
  field("Основание", input.basis);
  rows.push([]);

  // ---- сметная стоимость и трудозатраты: обязательный блок шапки ----
  field("Сметная стоимость, тыс. руб.", thousands(totals.workCost));
  field("в том числе строительных работ, тыс. руб.", thousands(sums.buildCost));
  field("в том числе монтажных работ, тыс. руб.", thousands(sums.assemblyCost));
  field("в том числе оборудования, тыс. руб.", thousands(0));
  field("в том числе прочих затрат, тыс. руб.", thousands(0));
  field(
    "Средства на оплату труда рабочих, тыс. руб.",
    thousands(sums.labourCost),
  );
  field(
    "Средства на оплату труда машинистов, тыс. руб.",
    thousands(sums.machinistCost),
  );
  field(
    "Нормативные затраты труда рабочих, чел.-ч",
    quantity(sums.labourHours),
  );
  field(
    "Нормативные затраты труда машинистов, чел.-ч",
    quantity(sums.machinistHours),
  );
  rows.push([]);

  // ---- заголовок таблицы: две строки шапки и строка нумерации колонок ----
  rows.push([
    "N п/п",
    "Обоснование",
    "Наименование работ и затрат",
    "Единица измерения",
    "Количество",
    "",
    "",
    "Сметная стоимость, руб.",
    "",
    "",
    "",
    "",
  ]);
  rows.push([
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
  ]);
  rows.push(
    Array.from({ length: COLUMN_COUNT }, (_, index) => String(index + 1)),
  );

  // ---- разделы, позиции, ресурсы, начисления ----
  let number = 0;
  for (const [order, section] of document.sections.entries()) {
    const title = `Раздел ${String(order + 1)}. ${section.title}`;
    rows.push([title]);

    for (const line of section.lines) {
      number += 1;
      rows.push(...positionRows(line, number));
    }

    rows.push(total(`Итого прямые затраты по разделу`, section.directCost));
    rows.push(total(`Итого по разделу ${title}`, section.workCost));
    rows.push([]);
  }

  // ---- итоги сметы ----
  rows.push(total("Итого прямые затраты", totals.directCost));
  rows.push(total("Итого ФОТ", totals.wageFund));
  rows.push(total("Итого накладные расходы", totals.overheadCost));
  rows.push(total("Итого сметная прибыль", totals.profitCost));
  rows.push(total("Итого оборудование", 0));
  rows.push(total("Итого прочие затраты", 0));
  rows.push(total("Всего прямые затраты", totals.directCost));
  rows.push(total("Всего накладные расходы", totals.overheadCost));
  rows.push(total("Всего сметная прибыль", totals.profitCost));
  rows.push(total("Всего по смете", totals.workCost));
  rows.push([]);

  /*
    Лимитированные затраты и НДС — за пределами формы ЛСР.

    По Методике зимнее удорожание и временные здания учитываются в главе 9
    сводного сметного расчёта, а не в локальной смете, и налог начисляется там
    же. Дописывать их строками в форму значило бы выдать за ЛСР то, чем он не
    является, а выбросить — потерять числа, которые считались. Поэтому они идут
    отдельным блоком со своим заголовком.
  */
  rows.push(["Справочно, за пределами формы локальной сметы"]);
  rows.push(
    total(
      `Зимнее удорожание, ${percent(document.parameters.limited.winterSurchargePercent)}`,
      totals.winterSurcharge,
    ),
  );
  rows.push(
    total(
      `Временные здания и сооружения, ${percent(document.parameters.limited.temporaryStructuresPercent)}`,
      totals.temporaryStructures,
    ),
  );
  rows.push(total("Итого до НДС", totals.beforeVat));
  rows.push(
    total(`НДС ${percent(document.parameters.vatPercent)}`, totals.vat),
  );
  rows.push(total("Всего с НДС", totals.total));
  rows.push([]);

  // ---- что в форме осталось незаполненным ----
  rows.push(["Не заполнено в форме"]);
  for (const note of unfilled(document)) rows.push([note]);
  rows.push([]);
  rows.push([document.disclaimer]);

  return rows;
}

/** Реквизиты, которых у расчёта нет. Формулировки печатаются в самой форме. */
const NOT_FILLED = {
  amendments: "не применялись",
  indices:
    "индексы не применялись — расчёт в текущих ценах ФСЦСР, часть ресурсов в базисном уровне 01.01.2022",
} as const;

/** Одна позиция: расценка, её ресурсы, начисления и итог. */
function positionRows(line: EstimateLine, number: number): Row[] {
  const rows: Row[] = [];

  rows.push([
    String(number),
    `${line.normBaseType} ${line.normCode}`,
    line.normName,
    line.normUnit,
    "",
    "",
    quantity(line.quantity),
    "",
    "",
    "",
    "",
    money(line.directCost),
  ]);

  rows.push(
    ...resourceGroup("ОТ (ЗТ)", line, ["LABOUR", "WORKER_HOURS_TOTAL"]),
  );
  rows.push(...resourceGroup("ОТм", line, ["MACHINIST_HOURS"]));
  rows.push(...resourceGroup("ЭМ", line, ["MACHINE"]));
  rows.push(...resourceGroup("МАТ", line, ["MATERIAL", "UNKNOWN"]));

  rows.push(
    accrual("НР", line.overheadRef, line.overheadPercent, line.overheadCost),
  );
  rows.push(accrual("СП", line.profitRef, line.profitPercent, line.profitCost));
  rows.push(total("Всего по позиции", lineTotal(line)));

  return rows;
}

/**
 * Группа ресурсов позиции: заголовок группы и строки под ним.
 *
 * Группа без ресурсов не печатается: пустая строка «ЭМ» в смете означала бы,
 * что машины есть, а стоимость нулевая, — а её просто нет в норме.
 */
function resourceGroup(
  label: string,
  line: EstimateLine,
  kinds: readonly EstimateResourceLine["kind"][],
): Row[] {
  const wanted = new Set(kinds);
  const items = line.resources.filter((item) => wanted.has(item.kind));
  if (items.length === 0) return [];

  const rows: Row[] = [["", "", label]];
  for (const item of items) {
    rows.push([
      "",
      item.code,
      item.name,
      item.unit,
      "",
      "",
      quantity(item.quantity),
      "",
      "",
      item.unitPrice === 0 ? "" : money(item.unitPrice),
      "",
      item.total === 0 ? "" : money(item.total),
    ]);
  }
  return rows;
}

/** Строка начисления: указатель приказа в обоснование, процент — в количество. */
function accrual(
  label: string,
  ref: string | null,
  percentValue: number,
  cost: number,
): Row {
  return [
    "",
    ref ?? "резерв документа",
    label,
    "%",
    percent(percentValue),
    "",
    "",
    "",
    "",
    "",
    "",
    money(cost),
  ];
}

/** Стоимость позиции: прямые затраты вместе с начислениями. */
function lineTotal(line: EstimateLine): number {
  return line.directCost + line.overheadCost + line.profitCost;
}

/** Итоговая строка: подпись в колонке наименования, сумма в последней. */
function total(label: string, value: number): Row {
  return ["", "", label, "", "", "", "", "", "", "", "", money(value)];
}

interface Sums {
  readonly buildCost: number;
  readonly assemblyCost: number;
  readonly labourCost: number;
  readonly machinistCost: number;
  readonly labourHours: number;
  readonly machinistHours: number;
}

function sumUp(document: EstimateDocument): Sums {
  let buildCost = 0;
  let assemblyCost = 0;
  let labourCost = 0;
  let machinistCost = 0;
  let labourHours = 0;
  let machinistHours = 0;

  for (const section of document.sections) {
    for (const line of section.lines) {
      const cost = lineTotal(line);
      if (ASSEMBLY_BOOKS.has(line.normBaseType)) assemblyCost += cost;
      else buildCost += cost;
      labourCost += line.labourCost;
      machinistCost += line.machinistSalaryCost;
      labourHours += line.labourHours;
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
  };
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

  /*
    Колонки 8 и 9 пусты даже когда индексы применены. Причина другая: расчёт
    хранит цену ресурса уже после пересчёта, а базисную составляющую и сам
    индекс по строке — нет. Написать здесь «индексы не применялись» после того,
    как они применились, значило бы соврать в обратную сторону.
  */
  notes.push(
    "Колонки 8 и 9 (базисный уровень цен и индекс) не заполнены построчно: расчёт хранит " +
      "цену ресурса после пересчёта, без разложения на базисную цену и индекс.",
  );
  notes.push(
    "Колонки 6 и 11 (коэффициенты) не заполнены: коэффициенты условий производства " +
      "работ по Приложению 10 к Методике 421/пр в расчёте не применялись.",
  );
  notes.push(
    "Колонка 5 (расход на единицу измерения) не заполнена: расчёт хранит расход ресурса " +
      "на позицию целиком, колонка 7 заполнена.",
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
  return decimal(value, 4).replace(/,?0+$/, "");
}

function percent(value: number): string {
  return `${decimal(value, 2).replace(/,?0+$/, "")} %`;
}
