import type { Worksheet } from "exceljs";

import { COST_PROFILE_FIELDS } from "@/domain/estimate/companyCostProfile";
import {
  buildPriceLadder,
  type BidEconomics,
  type MyPriceResult,
} from "@/domain/estimate/bidEconomics";
import {
  baseOriginText,
  percentText,
  TAX_TEXT,
  VERDICT_TEXT,
} from "@/domain/estimate/bidEconomicsText";

/**
 * Книга Excel «Расчёт цены участия»: один лист, который можно показать директору или бухгалтеру без интерфейса.
 *
 * Состав листа сверху вниз: вводные (НМЦК, НДС, налоговая система, профиль затрат), структура себестоимости («как по смете» и
 * с поправками компании), границы цены (безубыточная, минимальная, допустимое снижение), таблица цен (НМЦК, −5…−30 % и «моя
 * цена» отдельной строкой), антидемпинговое правило и пометки расчёта. Те же числа и слова, что на экране: их считает
 * `computeBidEconomics`, подписи берутся из `bidEconomicsText`.
 *
 * Деньги записываются числами, а не строками: по колонке можно считать. Сначала строится матрица значений (`buildBidSheetRows`,
 * чистая функция — её проверяет тест), потом она оформляется в книгу. `exceljs` грузится динамически: библиотека тяжёлая и
 * нужна только в момент выгрузки.
 */

export interface BidWorkbookInput {
  readonly economics: BidEconomics;
  /** Цена, которую человек назвал в блоке «Моя цена»; нет — строки «Моя цена» в таблице нет. */
  readonly myPrice?: MyPriceResult | null;
  /** Объект или закупка: печатается в шапке. */
  readonly subject: string;
  readonly generatedAt: Date;
}

export const BID_SHEET_NAME = "Экономика участия";

type Cell = string | number | null;
export type BidRowKind = "title" | "section" | "header" | "row" | "text" | "total" | "blank";

export interface BidSheetRow {
  readonly kind: BidRowKind;
  readonly cells: readonly Cell[];
  /** Формат чисел строки: деньги — по умолчанию, проценты — для строк процентов. */
  readonly formats?: readonly ("money" | "percent" | "text")[];
}

const row = (kind: BidRowKind, cells: readonly Cell[], formats?: BidSheetRow["formats"]): BidSheetRow =>
  formats === undefined ? { kind, cells } : { kind, cells, formats };
const blank = (): BidSheetRow => row("blank", []);

function verdictCell(result: MyPriceResult): string {
  return VERDICT_TEXT[result.verdict];
}

/** Лист как матрица: порядок строк и значения. Без оформления. */
export function buildBidSheetRows(input: BidWorkbookInput): BidSheetRow[] {
  const { economics, myPrice } = input;
  const rows: BidSheetRow[] = [];
  const date = input.generatedAt.toISOString().slice(0, 10);

  rows.push(row("title", ["Расчёт цены участия"]));
  rows.push(row("text", [input.subject]));
  rows.push(row("text", [`Дата расчёта: ${date}. Основа: ${baseOriginText(economics.baseOrigin)}.`]));
  rows.push(blank());

  if (economics.status !== "COMPUTED") {
    rows.push(row("text", [economics.flags[0]?.message ?? "Расчёта нет: цену определить нельзя."]));
    return rows;
  }

  // ---- Вводные ----
  const { assumptions } = economics;
  rows.push(row("section", ["Вводные данные"]));
  rows.push(row("row", ["НМЦК, ₽", economics.nmc]));
  rows.push(row("row", ["НМЦК указана с НДС", assumptions.nmcIncludesVat ? "да" : "нет"]));
  rows.push(row("row", ["Ставка НДС, %", assumptions.vatPercent], ["text", "percent"]));
  rows.push(row("row", ["Налоги", TAX_TEXT[economics.taxKind]]));
  rows.push(row("row", ["Минимальная маржа, % от выручки без НДС", economics.minMarginPercent], ["text", "percent"]));
  rows.push(
    row("row", [
      "Закон закупки",
      economics.law === "FZ_44" ? "44-ФЗ" : economics.law === "FZ_223" ? "223-ФЗ" : "не указан",
    ]),
  );
  for (const spec of COST_PROFILE_FIELDS) {
    const value = assumptions.costProfile[spec.key];
    rows.push(row("row", [`Профиль затрат: ${spec.label}, %`, value], ["text", "percent"]));
  }
  rows.push(blank());

  // ---- Структура себестоимости ----
  rows.push(row("section", ["Структура себестоимости, ₽ без НДС"]));
  rows.push(row("header", ["Статья", "Как по смете", "С вашими поправками"]));
  const by = economics.basis.costStructureByEstimate;
  const own = economics.basis.costStructure;
  const lines: ReadonlyArray<readonly [string, keyof typeof own]> = [
    ["Оплата труда рабочих", "labour"],
    ["Машины и механизмы", "machines"],
    ["Материалы", "materials"],
    ["Субподряд", "subcontract"],
    ["Прочие прямые затраты (цены заказчика, услуги, свои цены)", "other"],
    ["Накладные расходы (с долей, которая тратится)", "overhead"],
    ["Лимитированные затраты (зимнее удорожание, временные здания)", "limited"],
    ["НДС на материалы, не принимаемый к вычету", "nonDeductibleVat"],
  ];
  for (const [label, key] of lines) {
    if (by[key] === 0 && own[key] === 0) continue;
    rows.push(row("row", [label, by[key], own[key]]));
  }
  rows.push(row("total", ["Себестоимость", economics.basis.costByEstimate, economics.basis.cost]));
  rows.push(row("row", ["Сметная прибыль (норматив, в себестоимость не входит)", economics.basis.estimatedProfit, null]));
  rows.push(row("row", ["Итог сметы без НДС", economics.basis.estimateBeforeVat, null]));
  rows.push(blank());

  // ---- Границы цены ----
  rows.push(row("section", ["Границы цены"]));
  rows.push(row("row", ["Безубыточная цена (прибыль после налогов = 0), ₽", economics.breakEvenPrice]));
  rows.push(row("row", [`Минимальная цена с маржой ${percentText(economics.minMarginPercent, 0)}, ₽`, economics.minAcceptablePrice]));
  rows.push(
    row(
      "row",
      ["Допустимое снижение от НМЦК, %", economics.maxReductionPercent],
      ["text", "percent"],
    ),
  );
  rows.push(row("row", ["Запас прочности при НМЦК (рост затрат до нулевой прибыли), %", economics.safetyMarginPercent], ["text", "percent"]));
  rows.push(blank());

  // ---- Таблица цен ----
  const ladder = buildPriceLadder(economics);
  const antiDumpingNotes: string[] = [];
  if (ladder.length > 0 || myPrice !== null && myPrice !== undefined) {
    rows.push(row("section", ["Таблица цен"]));
    rows.push(
      row("header", ["Цена", "Снижение от НМЦК, %", "Цена, ₽", "Выручка, ₽", "Себестоимость, ₽", "Налог, ₽", "Прибыль, ₽", "Маржа, %", "Вывод", "Антидемпинг"]),
    );
    const fmt: BidSheetRow["formats"] = ["text", "percent", "money", "money", "money", "money", "money", "percent", "text", "text"];
    for (const step of ladder) {
      const r = step.result;
      const label = step.reductionPercent === 0 ? "НМЦК" : `НМЦК −${String(step.reductionPercent)} %`;
      rows.push(
        row(
          "row",
          [label, step.reductionPercent, r.price, r.revenue, r.cost, r.tax, r.profit, r.marginPercent, verdictCell(r), r.antiDumping === null ? "" : "да"],
          fmt,
        ),
      );
      if (r.antiDumping !== null && antiDumpingNotes.length === 0) antiDumpingNotes.push(r.antiDumping.text);
    }
    if (myPrice !== null && myPrice !== undefined) {
      rows.push(
        row(
          "total",
          [
            "Моя цена",
            myPrice.reductionPercent,
            myPrice.price,
            myPrice.revenue,
            myPrice.cost,
            myPrice.tax,
            myPrice.profit,
            myPrice.marginPercent,
            verdictCell(myPrice),
            myPrice.antiDumping === null ? "" : "да",
          ],
          fmt,
        ),
      );
      if (myPrice.antiDumping !== null) antiDumpingNotes.splice(0, antiDumpingNotes.length, myPrice.antiDumping.text);
      if (myPrice.aboveNmc) {
        rows.push(row("text", ["Моя цена выше НМЦК: по 44-ФЗ такая заявка не принимается."]));
      }
    }
    rows.push(blank());
  }

  // ---- Антидемпинг ----
  rows.push(row("section", ["Антидемпинговая мера"]));
  rows.push(
    row("text", [
      antiDumpingNotes[0] ??
        (economics.law === "FZ_223"
          ? "223-ФЗ: мер ст. 37 44-ФЗ закон не устанавливает; антидемпинговые требования, если они есть, — в положении о закупке заказчика."
          : "44-ФЗ, ст. 37: при снижении цены на 25 % и более от НМЦК обеспечение исполнения контракта увеличивается в 1,5 раза (не меньше аванса); при НМЦК до 15 млн ₽ вместо этого можно подтвердить добросовестность исполненными контрактами. Для закупок по 223-ФЗ — смотрите положение о закупке. Сверьте с актуальной редакцией закона."),
    ]),
  );
  rows.push(blank());

  // ---- Пометки ----
  rows.push(row("section", ["Допущения и пометки"]));
  rows.push(row("text", [`Надёжность расчёта: ${String(economics.confidence.score)} из 100. ${economics.confidence.reasons.join("; ")}.`]));
  for (const flag of economics.flags) rows.push(row("text", [flag.message]));
  rows.push(
    row("text", [
      "Расчёт информационный: смета и текущие цены Минстроя показывают порядок затрат, а не ваши реальные цены поставщиков и субподрядчиков. Страховые взносы и налоговые вычеты не учтены. Для решения о цене проверьте крупные статьи.",
    ]),
  );
  return rows;
}

/** Имя файла: по нему видно объект и день выгрузки. */
export function bidWorkbookFileName(subject: string, generatedAt: Date): string {
  const safe = subject.replace(/[\\/:"*?<>|]/g, "").trim().slice(0, 80);
  return `Расчёт цены участия ${safe === "" ? "" : `${safe} `}от ${generatedAt.toISOString().slice(0, 10)}.xlsx`;
}

const FONT = "Arial";
const MONEY_FORMAT = "#,##0.00";
const PERCENT_FORMAT = '0.0" %"';
const COLUMN_WIDTHS = [62, 22, 22, 18, 18, 14, 16, 12, 18, 14] as const;
const THIN = { style: "thin" as const, color: { argb: "FFBFBFBF" } };

function writeSheet(sheet: Worksheet, rows: readonly BidSheetRow[]): void {
  sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
  rows.forEach((item, index) => {
    const excelRow = sheet.getRow(index + 1);
    item.cells.forEach((value, column) => {
      if (value === null) return;
      const cell = excelRow.getCell(column + 1);
      const format = item.formats?.[column] ?? (typeof value === "number" ? "money" : "text");
      // Процент, округляющийся до нуля при одном знаке, пишется нулём: «−0,0 %» читается как отрицательная разница.
      cell.value = typeof value === "number" && format === "percent" && Math.abs(value) < 0.05 ? 0 : value;
      const bold = item.kind === "title" || item.kind === "section" || item.kind === "header" || item.kind === "total";
      cell.font = { name: FONT, size: item.kind === "title" ? 14 : 10, bold };
      if (typeof value === "number") {
        cell.numFmt = format === "percent" ? PERCENT_FORMAT : MONEY_FORMAT;
        cell.alignment = { vertical: "top", horizontal: "right" };
      } else {
        // Длинные пояснения идут в одну широкую колонку и переносятся.
        cell.alignment = { vertical: "top", wrapText: true, ...(item.kind === "header" ? { horizontal: "center" as const } : {}) };
      }
      if (item.kind === "header") {
        cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F4F1" } };
      }
      if (item.kind === "total") cell.border = { top: THIN, bottom: THIN };
    });
    // Пояснение занимает всю ширину листа: объединяем ячейки, чтобы текст не обрезался.
    if (item.kind === "text" && item.cells.length === 1) {
      sheet.mergeCells(index + 1, 1, index + 1, COLUMN_WIDTHS.length);
      const text = String(item.cells[0] ?? "");
      excelRow.height = Math.max(15, Math.ceil(text.length / 150) * 13.5);
    }
  });
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
}

/** Собирает книгу: один лист «Экономика участия». */
export async function buildBidWorkbook(input: BidWorkbookInput): Promise<Uint8Array> {
  const module_ = await import("exceljs");
  const ExcelJS = (module_ as unknown as { default?: typeof module_ }).default ?? module_;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TenderFit";
  workbook.created = input.generatedAt;
  writeSheet(workbook.addWorksheet(BID_SHEET_NAME), buildBidSheetRows(input));
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
