/**
 * Конструктор текста локальной сметы формы 421/пр для тестов.
 *
 * Реальные образцы (`customerLsr.fixtures.ts`) покрывают две программы и один набор
 * ресурсов. Чтобы проверить сдвиг колонок, испорченную арифметику, НДС за итогом и
 * т. п., нужны тексты с известными числами — их собирает этот модуль, повторяя
 * раскладку реальных строк: расположение граф по ячейкам задаёт `layout`, а итоги
 * позиции (прямые затраты, ФОТ, НР, СП) считаются так же, как их считает программа
 * заказчика. Что-то испортить можно через `override`.
 */

export type Layout = Readonly<Record<number, number>>;

/** Гранд-Смета: графы 1, 2, 3 — ячейки 0, 1, 2; 4–12 — 7…15 (как в образцах A и B). */
export const GRAND_LAYOUT: Layout = { 1: 0, 2: 1, 3: 2, 4: 7, 5: 8, 6: 9, 7: 10, 8: 11, 9: 12, 10: 13, 11: 14, 12: 15 };
/** «Строительный эксперт»: те же графы, но в ячейках 0, 2, 9, 17, 18, 21, 23, 25, 27, 28, 31, 32. */
export const EXPERT_LAYOUT: Layout = { 1: 0, 2: 2, 3: 9, 4: 17, 5: 18, 6: 21, 7: 23, 8: 25, 9: 27, 10: 28, 11: 31, 12: 32 };

function csvCell(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Строка таблицы: `graf` — номер графы → текст. */
export function lsrRow(graf: Readonly<Record<number, string>>, layout: Layout = GRAND_LAYOUT): string {
  const width = Math.max(...Object.values(layout)) + 1;
  const cells: string[] = Array.from({ length: width }, () => "");
  for (const [key, text] of Object.entries(graf)) {
    const column = layout[Number(key)];
    if (column !== undefined) cells[column] = text;
  }
  return cells.map(csvCell).join(",");
}

/** Сумма в виде «3,286.84», как её печатает выгрузка. */
export function money(value: number): string {
  const [whole, fraction] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "-" : ""}${(whole as string).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction as string}`;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Шапка: имя листа, дата уровня цен, заголовки граф («индекс», «в текущем уровне цен») и нумерация 1…12. */
export function lsrHead(options: { layout?: Layout; date?: string; name?: string } = {}): string[] {
  const layout = options.layout ?? GRAND_LAYOUT;
  const numbering: Record<number, string> = {};
  for (let graph = 1; graph <= 12; graph += 1) numbering[graph] = String(graph);
  return [
    `=== ${options.name ?? "Тестовая ЛСР"} ===`,
    `Составлен(а) в текущем уровне цен ,,${options.date ?? "01.04.2026"}`,
    lsrRow({ 1: "№ п/п", 2: "Обоснование", 3: "Наименование работ и затрат", 4: "Единица измерения", 5: "Количество", 12: "Сметная стоимость, руб." }, layout),
    lsrRow(
      {
        5: "на единицу измерения",
        6: "коэффициенты",
        7: "всего с учетом коэффициентов",
        8: "на единицу измерения в базисном уровне цен",
        9: "индекс",
        10: "на единицу измерения в текущем уровне цен",
        11: "коэффициенты",
        12: "всего в текущем уровне цен",
      },
      layout,
    ),
    lsrRow(numbering, layout),
  ];
}

export interface ResourceSpec {
  readonly code: string;
  readonly name?: string;
  readonly unit: string;
  /** Количество на единицу измерения позиции (графа 5). */
  readonly perUnit?: number;
  /** Количество всего (графа 7). */
  readonly qty: number;
  readonly base?: number;
  readonly index?: number;
  /** Цена за единицу в текущем уровне (графа 10); у «Н»-строки её нет. */
  readonly price?: number;
  /** Стоимость (графа 12); по умолчанию qty × price. Здесь её можно испортить. */
  readonly sum?: number;
  /** «Н» в графе 1. */
  readonly unaccounted?: boolean;
  /** Номер вида «22.1»: дополнение за итогом прямых затрат. */
  readonly extra?: string;
}

export interface RateSpec {
  readonly ref: string;
  readonly base: number;
  /** Применённый процент; по умолчанию равен нормативу. */
  readonly percent?: number;
}

export interface PositionSpec {
  readonly n: number;
  readonly justification: string;
  readonly name: string;
  readonly unit: string;
  readonly qty: number;
  readonly resources: readonly ResourceSpec[];
  readonly overhead?: RateSpec;
  readonly profit?: RateSpec;
  /** Испорченные заказчиком цифры. */
  readonly override?: {
    readonly direct?: number;
    readonly fot?: number;
    readonly overheadAmount?: number;
    readonly profitAmount?: number;
    readonly total?: number;
  };
  /** Позиция оборвана: строки «Всего по позиции» нет. */
  readonly noTotal?: boolean;
}

const isLabour = (code: string): boolean => /^[1-4]-\d{3}-\d{2,3}$/.test(code);
const isMachine = (code: string): boolean => /^91\.\d{2}\.\d{2}-\d{3}$/.test(code);
const sumOf = (spec: ResourceSpec): number => spec.sum ?? round2(spec.qty * (spec.price ?? 0));

/** Итоги позиции так, как их печатает программа заказчика. */
export function positionTotals(spec: PositionSpec): { direct: number; fot: number; overhead: number; profit: number; total: number } {
  const priced = spec.resources.filter((resource) => resource.unaccounted !== true);
  const regular = priced.filter((resource) => resource.extra === undefined);
  const extras = priced.filter((resource) => resource.extra !== undefined);
  const direct = round2(regular.reduce((sum, resource) => sum + sumOf(resource), 0));
  const fot = round2(priced.filter((resource) => isLabour(resource.code)).reduce((sum, resource) => sum + sumOf(resource), 0));
  const overhead = spec.overhead === undefined ? 0 : round2((fot * (spec.overhead.percent ?? spec.overhead.base)) / 100);
  const profit = spec.profit === undefined ? 0 : round2((fot * (spec.profit.percent ?? spec.profit.base)) / 100);
  const total = round2(direct + extras.reduce((sum, resource) => sum + sumOf(resource), 0) + overhead + profit);
  return { direct, fot, overhead, profit, total };
}

/** Строки позиции: сама позиция, группы, ресурсы, «Итого прямые затраты», ФОТ, НР, СП, «Всего по позиции». */
export function lsrPosition(spec: PositionSpec, layout: Layout = GRAND_LAYOUT): string[] {
  const computed = positionTotals(spec);
  const direct = spec.override?.direct ?? computed.direct;
  const fot = spec.override?.fot ?? computed.fot;
  const total = spec.override?.total ?? computed.total;
  const rows: string[] = [
    lsrRow({ 1: String(spec.n), 2: spec.justification, 3: spec.name, 4: spec.unit, 5: String(spec.qty), 6: "1", 7: String(spec.qty) }, layout),
  ];

  const priced = spec.resources.filter((resource) => resource.unaccounted !== true && resource.extra === undefined);
  const groupSum = (test: (code: string) => boolean): number =>
    round2(priced.filter((resource) => test(resource.code)).reduce((sum, resource) => sum + sumOf(resource), 0));
  const labour = groupSum((code) => /^[1-3]-\d{3}-\d{2,3}$/.test(code));
  const machinist = groupSum((code) => /^4-\d{3}-\d{2,3}$/.test(code));
  const machines = groupSum(isMachine);
  const materials = groupSum((code) => /^\d{2}\.\d\./.test(code));
  if (labour > 0) rows.push(lsrRow({ 2: "1", 3: "ОТ(ЗТ)", 4: "чел.-ч", 12: money(labour) }, layout));
  if (machines > 0 || machinist > 0) rows.push(lsrRow({ 2: "2", 3: "ЭМ", 12: money(machines + machinist) }, layout));
  if (machinist > 0) rows.push(lsrRow({ 2: "3", 3: "ОТм(ЗТм)", 12: money(machinist) }, layout));
  if (materials > 0) rows.push(lsrRow({ 2: "4", 3: "М", 12: money(materials) }, layout));

  for (const resource of spec.resources) {
    const graf: Record<number, string> = {
      2: resource.code,
      3: resource.name ?? `Ресурс ${resource.code}`,
      4: resource.unit,
      5: String(resource.perUnit ?? ""),
      7: String(resource.qty),
    };
    if (resource.unaccounted === true) {
      graf[1] = "Н";
    } else {
      if (resource.extra !== undefined) graf[1] = resource.extra;
      if (resource.base !== undefined) graf[8] = String(resource.base);
      if (resource.index !== undefined) graf[9] = String(resource.index);
      graf[10] = String(resource.price ?? "");
      graf[12] = money(sumOf(resource));
    }
    rows.push(lsrRow(graf, layout));
  }

  rows.push(lsrRow({ 3: "Итого прямые затраты", 12: money(direct) }, layout));
  rows.push(lsrRow({ 3: "ФОТ", 12: money(fot) }, layout));
  for (const [rate, label, amount] of [
    [spec.overhead, "НР", spec.override?.overheadAmount ?? computed.overhead],
    [spec.profit, "СП", spec.override?.profitAmount ?? computed.profit],
  ] as const) {
    if (rate === undefined) continue;
    rows.push(
      lsrRow(
        { 2: rate.ref, 3: `${label} Тестовые работы`, 4: "%", 5: String(rate.base), 7: String(rate.percent ?? rate.base), 12: money(amount) },
        layout,
      ),
    );
  }
  if (spec.noTotal !== true) {
    rows.push(lsrRow({ 3: "Всего по позиции", 10: money(spec.qty === 0 ? total : round2(total / spec.qty)), 12: money(total) }, layout));
  }
  return rows;
}

export interface TotalsSpec {
  readonly sectionTitle?: string;
  /** Итог раздела; по умолчанию — сумма «Всего по позиции». */
  readonly sectionTotal: number;
  readonly vat?: { readonly percent: number; readonly amount: number };
  /** Строка «ВСЕГО по смете». */
  readonly total: number;
  /**
   * `after` — НДС стоит ниже «ВСЕГО по смете» (итог без НДС, затем «НДС 22 %» и «Всего с НДС»).
   * По умолчанию НДС идёт перед итогом, а «ВСЕГО по смете» уже с НДС.
   */
  readonly vatAfterTotal?: { readonly percent: number; readonly amount: number };
}

export function lsrTotals(spec: TotalsSpec, layout: Layout = GRAND_LAYOUT): string[] {
  const rows = [lsrRow({ 3: `Итого по разделу 1 ${spec.sectionTitle ?? "Тестовые работы"}`, 12: money(spec.sectionTotal) }, layout)];
  if (spec.vat !== undefined) rows.push(lsrRow({ 3: `НДС ${String(spec.vat.percent)}%`, 12: money(spec.vat.amount) }, layout));
  rows.push(lsrRow({ 3: "ВСЕГО по смете", 12: money(spec.total) }, layout));
  if (spec.vatAfterTotal !== undefined) {
    rows.push(lsrRow({ 3: `НДС ${String(spec.vatAfterTotal.percent)}%`, 12: money(spec.vatAfterTotal.amount) }, layout));
    rows.push(lsrRow({ 3: "Всего с учетом НДС", 12: money(round2(spec.total + spec.vatAfterTotal.amount)) }, layout));
  }
  return rows;
}

/** Смета целиком: шапка, раздел, позиции, итоги. */
export function lsrDocument(options: {
  positions: readonly PositionSpec[];
  totals?: Partial<TotalsSpec> | null;
  layout?: Layout;
  date?: string;
  name?: string;
}): string {
  const layout = options.layout ?? GRAND_LAYOUT;
  const rows = [...lsrHead({ layout, date: options.date, name: options.name }), "Раздел 1. Тестовые работы"];
  for (const position of options.positions) rows.push(...lsrPosition(position, layout));
  if (options.totals !== null) {
    const sum = round2(options.positions.reduce((total, position) => total + (position.override?.total ?? positionTotals(position).total), 0));
    const totals = options.totals ?? {};
    rows.push(...lsrTotals({ sectionTotal: sum, total: sum, ...totals }, layout));
  }
  return rows.join("\n");
}
