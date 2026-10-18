"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  buildLocalEstimateForm,
  COLUMN_COUNT,
  type FormRow,
  type FormRowKind,
  type FormSpan,
  type LocalEstimateFormInput,
} from "@/domain/estimate/exportForm";
import { asNumber } from "@/domain/estimate/exportXlsx";
import { cn } from "@/lib/cn";

/**
 * Смета по форме 421/пр на экране — те же строки, что в файле Excel.
 *
 * Зачем. Сметчик, привыкший к ГРАНД-Смете, ждёт увидеть именно её: позицию с элементами
 * ОТ, ЭМ, ОТм, М, НР, СП и «Всего по позиции». Таблица «Ведомость и нормы» этого не показывает —
 * она для проверки объёмов и цен. Поэтому форма строится тем же `buildLocalEstimateForm`, что и
 * файл: состав и порядок строк не могут разойтись между экраном и выгрузкой, а оформление
 * (жирная позиция, серый мелкий шрифт ресурсов, объединённые подписи шапки) выбирается по виду строки.
 *
 * Тяжёлая часть — таблица на тысячи строк — строится только после первого раскрытия блока, в котором
 * она лежит: до этого карточка результата не платит за таблицу, которую никто не открыл.
 */

/** Ширины колонок в долях таблицы — те же, что в книге Excel. */
// На экране шире, чем в книге, колонки шифра и чисел: шрифт браузера крупнее, и «ГЭСНр65-01-005-05» или «121 121,88»
// иначе рвались посреди шифра и числа.
const COLUMN_WIDTHS = [5, 20, 43, 9, 10, 8, 10, 11, 8, 12, 8, 13] as const;
const WIDTH_TOTAL = COLUMN_WIDTHS.reduce((sum, width) => sum + width, 0);

/** Строка для вывода: сама строка формы и колонки, закрытые объединением сверху. */
interface PlacedRow {
  readonly row: FormRow;
  readonly covered: ReadonlySet<number>;
  readonly bordered: boolean;
}

/**
 * Раскладка строк: какие колонки заняты вертикальным объединением из строк выше (шапка таблицы)
 * и лежит ли строка внутри таблицы с рамками — от шапки до блока «Итоги по смете».
 */
function place(rows: readonly FormRow[]): PlacedRow[] {
  const firstTable = rows.findIndex((row) => row.kind === "tableHead");
  const afterTable = rows.findIndex((row) => row.kind === "summaryHeading");
  const pending = new Map<number, number>();
  return rows.map((row, index) => {
    const covered = new Set<number>();
    for (const [column, left] of pending) {
      covered.add(column);
      if (left <= 1) pending.delete(column);
      else pending.set(column, left - 1);
    }
    for (const span of row.spans ?? []) {
      const down = span.rows ?? 1;
      if (down > 1) for (let column = span.from; column <= span.to; column += 1) pending.set(column, down - 1);
    }
    return {
      row,
      covered,
      bordered: firstTable >= 0 && index >= firstTable && (afterTable < 0 || index < afterTable),
    };
  });
}

/** Целая часть числа с пробелом в разрядах: «1515260,60» → «1 515 260,60». Текст и короткие числа — как есть. */
function grouped(text: string): string {
  const match = /^(-?)(\d{4,})(,\d+)?$/.exec(text);
  if (match === null) return text;
  const integer = (match[2] ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${match[1] ?? ""}${integer}${match[3] ?? ""}`;
}

/** Сверху вниз: что рисовать в ячейке строки вида `kind` в колонке `column`. */
function cellClass(kind: FormRowKind, column: number, numeric: boolean, bordered: boolean): string {
  return cn(
    "px-1.5 py-[3px] align-top break-words",
    bordered && "border border-border",
    // Число не переносится: «121 121,8» и «8» на двух строках читаются как два числа.
    numeric && "whitespace-nowrap text-right",
    // Шифр расценки переносится только по дефису, как в ГРАНД, а не посреди номера.
    column === 1 && bordered && kind !== "tableHead" && "break-normal [overflow-wrap:normal]",
    kind === "tableHead" && "bg-panel-raised text-center align-middle text-[10.5px] font-semibold leading-tight [hyphens:auto] break-normal",
    kind === "columnNumbers" && "bg-panel-raised text-center font-semibold",
    kind === "appendix" && "text-right text-[11px] text-muted-foreground",
    kind === "name" && "border-b border-border text-center text-[13px]",
    kind === "caption" && "text-center text-[10px] italic text-muted-foreground",
    kind === "title" && "pt-3 text-center text-[15px] font-semibold",
    kind === "workTitle" && "text-center text-[13px] font-semibold",
    kind === "section" && "bg-panel-raised/60 font-semibold",
    kind === "position" && "font-semibold",
    kind === "condition" && "italic",
    kind === "resource" && "text-[10.5px] text-muted-foreground",
    (kind === "positionTotal" || kind === "sectionTotal" || kind === "summaryHeading" || kind === "summaryTotal") && "font-semibold",
    kind === "summaryHeading" && "pt-3",
    kind === "summaryTotal" && "border-t border-border",
    // Единица измерения и номер позиции — по центру, как в ГРАНД.
    column === 3 && bordered && "text-center",
    column === 0 && kind === "position" && "text-center",
    // Подписи итогов сохраняют ведущие пробелы: вложенность «в том числе» иначе пропадает.
    (kind === "summaryLine" || kind === "summaryTotal" || kind === "summaryHeading") && "whitespace-pre-wrap",
  );
}

/** Ячейки строки: объединённые диапазоны становятся colSpan/rowSpan, закрытые сверху колонки пропускаются. */
function cellsOf(placed: PlacedRow) {
  const { row, covered, bordered } = placed;
  const spans = row.spans ?? [];
  const cells: ReactElement[] = [];
  let column = 0;
  while (column < COLUMN_COUNT) {
    if (covered.has(column)) {
      column += 1;
      continue;
    }
    const span: FormSpan | undefined = spans.find((candidate) => candidate.from === column);
    const to = span?.to ?? column;
    const text = row.cells[column] ?? "";
    const isNumber = text !== "" && asNumber(text) !== null;
    // Подпись поля и единица («тыс.руб.») числом не считаются; число справа — только в числовых колонках.
    const numeric = isNumber && (column >= 4 || (row.kind === "costBlock" && column === 3)) && row.kind !== "field";
    const shown = numeric && (column >= 7 || row.kind === "costBlock") ? grouped(text) : text;
    cells.push(
      <td
        key={column}
        colSpan={to - column + 1}
        rowSpan={span?.rows}
        className={cellClass(row.kind, column, numeric, bordered)}
      >
        {shown}
      </td>,
    );
    column = to + 1;
  }
  return cells;
}

const FormTableRow = memo(function FormTableRow({ placed }: { placed: PlacedRow }) {
  if (placed.row.kind === "blank") {
    return (
      <tr data-kind="blank">
        <td colSpan={COLUMN_COUNT} className="h-4" />
      </tr>
    );
  }
  return <tr data-kind={placed.row.kind}>{cellsOf(placed)}</tr>;
});

function ColumnGroup() {
  return (
    <colgroup>
      {COLUMN_WIDTHS.map((width, index) => (
        <col key={index} style={{ width: `${((width / WIDTH_TOTAL) * 100).toFixed(2)}%` }} />
      ))}
    </colgroup>
  );
}

export function LocalEstimateFormView({ input }: { input: LocalEstimateFormInput }) {
  // Блок часто лежит в свёрнутом <details>: таблицу строим после первого раскрытия.
  const anchor = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    const details = anchor.current?.closest("details") ?? null;
    if (details === null || details.open) {
      setOpened(true);
      return;
    }
    const onToggle = (): void => {
      if (details.open) setOpened(true);
    };
    details.addEventListener("toggle", onToggle);
    return () => details.removeEventListener("toggle", onToggle);
  }, []);

  return (
    <div ref={anchor} data-testid="lsr-form-view">
      {opened && <FormTables input={input} />}
    </div>
  );
}

/** Таблицы формы без отложенной сборки: для тестов и статической отрисовки. */
export function FormTables({ input }: { input: LocalEstimateFormInput }) {
  const { header, head, body, notes } = useMemo(() => {
    const all = buildLocalEstimateForm(input);
    const placed = place(all.filter((row) => row.kind !== "note"));
    const firstHead = placed.findIndex((item) => item.row.kind === "tableHead");
    const bodyStart = placed.findIndex((item) => item.row.kind === "columnNumbers") + 1;
    return {
      header: firstHead < 0 ? placed : placed.slice(0, firstHead),
      head: firstHead < 0 ? [] : placed.slice(firstHead, bodyStart),
      body: firstHead < 0 ? [] : placed.slice(bodyStart),
      notes: all.filter((row) => row.kind === "note" && (row.cells[0] ?? "") !== "").map((row) => row.cells[0] ?? ""),
    };
  }, [input]);

  return (
    <div className="space-y-3">
      <div className="max-h-[75vh] overflow-auto rounded-md border border-border/60 bg-panel text-[12px] leading-snug">
        <div className="min-w-[1100px] p-2 tabular-nums">
          <table className="w-full table-fixed border-collapse" aria-label="Шапка локального сметного расчёта">
            <ColumnGroup />
            <tbody>
              {header.map((item, index) => (
                <FormTableRow key={index} placed={item} />
              ))}
            </tbody>
          </table>
          <table className="w-full table-fixed border-collapse" data-testid="lsr-form" aria-label="Локальный сметный расчёт по форме 421/пр">
            <ColumnGroup />
            <thead className="sticky top-0 z-10 bg-panel">
              {head.map((item, index) => (
                <FormTableRow key={index} placed={item} />
              ))}
            </thead>
            <tbody>
              {body.map((item, index) => (
                <FormTableRow key={index} placed={item} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {notes.length > 0 && (
        <div className="space-y-1 text-[12.5px] text-muted-foreground" data-testid="lsr-form-notes">
          {notes.map((note, index) => (
            <p key={index} className={index === 0 ? "font-medium text-foreground" : undefined}>
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
