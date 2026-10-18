import type { DeepAnalysisSummary } from "@/domain/deepAnalysis";
import type { Tender } from "@/domain/entities";
import type { ProfileMatch } from "@/domain/profileMatch";
import type { BidEconomics } from "@/domain/estimate/bidEconomics";
import type { VatStatus } from "@/domain/estimate/vatStatus";
import type { CustomerComparison } from "@/domain/estimate/customerComparison";
import {
  buildDeepAnalysisReport,
  type DeepAnalysisReportInput,
  type ReportBlock,
  type ReportCell,
  type ReportTone,
} from "@/domain/deepAnalysisReport";

/**
 * Выгрузка результата глубокого анализа в файл Word.
 *
 * Зачем настоящий .docx, а не HTML с расширением .doc: файл уходит партнёру,
 * юристу или сметчику, а Word на HTML под чужим расширением показывает
 * предупреждение о несовпадении формата. Документ, который при открытии просит
 * подтвердить, что он не вредоносный, — плохой способ передать выводы.
 *
 * Собирается на стороне браузера по нажатию кнопки: все данные для документа
 * панель уже держит. Библиотека `docx` весит около мегабайта, поэтому импорт
 * динамический — в основную сборку она не попадает.
 *
 * Что и в каком порядке печатать, решает `buildDeepAnalysisReport`; здесь —
 * только вёрстка: карточка закупки таблицей, нумерованные разделы, таблицы с
 * шапкой, статусы цветом и словом, номер закупки и страницы в колонтитуле.
 */

export interface DeepAnalysisExportInput {
  regNumber: string;
  subject: string;
  summary: DeepAnalysisSummary;
  generatedAt: Date;
  tender?: Tender | null;
  profileMatch?: ProfileMatch | null;
  bidEconomics?: BidEconomics | null;
  vatStatus?: VatStatus | null;
  customerComparison?: CustomerComparison | null;
  /** Аудит сметы заказчика; нет — подраздела в отчёте нет. */
  customerAudit?: DeepAnalysisReportInput["customerAudit"];
  estimateSource?: DeepAnalysisReportInput["estimateSource"];
  /** Откуда взяты объёмы расчёта; нет — строки в отчёте нет. */
  volumeSource?: DeepAnalysisReportInput["volumeSource"];
  /** Точность расчёта («по смете заказчика» / «примерная оценка»); нет — строки в отчёте нет. */
  estimateConfidence?: DeepAnalysisReportInput["estimateConfidence"];
  /** Расхождения объёмов ведомости со сметой заказчика. */
  volumeFindings?: DeepAnalysisReportInput["volumeFindings"];
  /** Доля стоимости по ценам заказчика; нет — таких позиций нет. */
  customerPriced?: DeepAnalysisReportInput["customerPriced"];
  /** Нормативы сверх норм (условия работ, зимнее, временные здания, Север); нет — их не было. */
  appliedNormatives?: DeepAnalysisReportInput["appliedNormatives"];
  /** Правки ведомости, по которым пересчитана смета; нет — ведомость не правили. */
  billEdits?: DeepAnalysisReportInput["billEdits"];
  /** Сводный расчёт, цена контракта и аудит ССР заказчика; нет — подраздела нет. */
  ssr?: DeepAnalysisReportInput["ssr"];
  /** «Деньги»: запас по цене, пик замороженного, зима; нет — раздел как раньше. */
  moneyOutlook?: DeepAnalysisReportInput["moneyOutlook"];
}

/** Имя файла: по нему видно закупку и день выгрузки, без открытия. */
export function deepAnalysisFileName(
  regNumber: string,
  generatedAt: Date,
): string {
  // Символы, запрещённые в именах файлов Windows, иначе браузер сохранит файл
  // под обрезанным именем или не сохранит вовсе.
  const safe = regNumber.replace(/[\\/:"*?<>|]/g, "");
  const date = generatedAt.toISOString().slice(0, 10);
  return `Глубокий анализ ${safe} от ${date}.docx`;
}

/*
  Цвета — тёмные варианты палитры интерфейса (`*-fg`): на белой странице и при
  печати светлые тона пропадают. Статус всегда продублирован словом, цвет —
  только подсказка (печать бывает чёрно-белой).
*/
const TONE_COLOR: Record<ReportTone, string> = {
  good: "04663D",
  warn: "854D0E",
  bad: "B42318",
  neutral: "3C3935",
};
const TONE_FILL: Record<ReportTone, string> = {
  good: "ECFDF3",
  warn: "FFFAE8",
  bad: "FEF3F2",
  neutral: "F5F4F1",
};
const HEADER_FILL = "F5F4F1";
const BORDER_COLOR = "D6D3CD";
const MUTED = "6C6862";

/** Ширина текста на A4 с полями 2 см: 11 906 − 2 × 1134 твипов. */
const CONTENT_WIDTH = 9638;

export async function buildDeepAnalysisDocx(
  input: DeepAnalysisExportInput,
): Promise<Uint8Array> {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    HeadingLevel,
    LevelFormat,
    Packer,
    PageNumber,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableLayoutType,
    TableRow,
    TextRun,
    VerticalAlign,
    WidthType,
  } = await import("docx");

  const report = buildDeepAnalysisReport(input);
  type Child = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const children: Child[] = [];

  const border = { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR };
  const borders = {
    top: border,
    bottom: border,
    left: border,
    right: border,
    insideHorizontal: border,
    insideVertical: border,
  };
  const margins = { top: 80, bottom: 80, left: 100, right: 100 };

  const cellParagraphs = (cell: ReportCell) => {
    // Пустой текст при пояснении не печатаем: иначе в ячейке остаётся пустая строка сверху.
    const out =
      cell.text === "" && (cell.note || cell.detail)
        ? []
        : [
            new Paragraph({
              children: [
                new TextRun({
                  text: cell.text,
                  bold: cell.bold,
                  color: cell.tone ? TONE_COLOR[cell.tone] : undefined,
                }),
              ],
            }),
          ];
    if (cell.detail) {
      out.push(
        new Paragraph({
          children: [new TextRun({ text: cell.detail })],
          spacing: { before: 40 },
        }),
      );
    }
    if (cell.note) {
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text: cell.note,
              italics: true,
              size: 18,
              color: MUTED,
            }),
          ],
          spacing: { before: 40 },
        }),
      );
    }
    return out;
  };

  const table = (block: Extract<ReportBlock, { kind: "table" }>) => {
    const widths = block.columns.map((c) =>
      Math.round((CONTENT_WIDTH * c.width) / 100),
    );
    const header = new TableRow({
      tableHeader: true,
      children: block.columns.map(
        (column, i) =>
          new TableCell({
            width: { size: widths[i]!, type: WidthType.DXA },
            shading: {
              type: ShadingType.CLEAR,
              fill: HEADER_FILL,
              color: "auto",
            },
            margins,
            verticalAlign: VerticalAlign.CENTER,
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: column.title, bold: true, size: 18 }),
                ],
              }),
            ],
          }),
      ),
    });
    const rows = block.rows.map(
      (row) =>
        new TableRow({
          cantSplit: true,
          children: row.map(
            (cell, i) =>
              new TableCell({
                width: { size: widths[i]!, type: WidthType.DXA },
                margins,
                shading:
                  cell.tone && cell.tone !== "neutral"
                    ? {
                        type: ShadingType.CLEAR,
                        fill: TONE_FILL[cell.tone],
                        color: "auto",
                      }
                    : undefined,
                children: cellParagraphs(cell),
              }),
          ),
        }),
    );
    return new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      borders,
      rows: [header, ...rows],
    });
  };

  // Шапка: название, номер и предмет, затем карточка закупки таблицей.
  children.push(
    new Paragraph({
      text: report.title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Закупка № ${report.regNumber}`,
          bold: true,
          size: 24,
        }),
      ],
      spacing: { after: 60 },
    }),
    new Paragraph({
      children: [new TextRun({ text: report.subject, size: 22 })],
      spacing: { after: 200 },
    }),
  );
  const labelWidth = Math.round(CONTENT_WIDTH * 0.32);
  children.push(
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [labelWidth, CONTENT_WIDTH - labelWidth],
      layout: TableLayoutType.FIXED,
      borders,
      rows: report.facts.map(
        ([label, value]) =>
          new TableRow({
            cantSplit: true,
            children: [
              new TableCell({
                width: { size: labelWidth, type: WidthType.DXA },
                shading: {
                  type: ShadingType.CLEAR,
                  fill: HEADER_FILL,
                  color: "auto",
                },
                margins,
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: label, bold: true })],
                  }),
                ],
              }),
              new TableCell({
                width: {
                  size: CONTENT_WIDTH - labelWidth,
                  type: WidthType.DXA,
                },
                margins,
                children: [new Paragraph({ text: value })],
              }),
            ],
          }),
      ),
    }),
  );

  report.sections.forEach((section, index) => {
    children.push(
      new Paragraph({
        text: `${index + 1}. ${section.title}`,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 120 },
        keepNext: true,
      }),
    );
    for (const block of section.blocks) {
      if (block.kind === "paragraph") {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: block.text,
                bold: block.bold,
                // Мелкий абзац — перечень низких рисков, модель, прочитанные файлы: справочно.
                size: block.small ? 18 : undefined,
                color: block.tone
                  ? TONE_COLOR[block.tone]
                  : block.small
                    ? MUTED
                    : undefined,
              }),
            ],
            shading:
              block.tone && block.tone !== "neutral"
                ? {
                    type: ShadingType.CLEAR,
                    fill: TONE_FILL[block.tone],
                    color: "auto",
                  }
                : undefined,
            spacing: { after: 120 },
          }),
        );
      } else if (block.kind === "bullets") {
        for (const item of block.items) {
          children.push(
            new Paragraph({
              text: item,
              numbering: { reference: "bullets", level: 0 },
              spacing: { after: 60 },
            }),
          );
        }
      } else {
        children.push(table(block));
      }
    }
  });

  const doc = new Document({
    creator: "ТендерФит",
    title: `${report.title} — закупка № ${report.regNumber}`,
    styles: {
      default: { document: { run: { font: "Arial", size: 20 } } },
      paragraphStyles: [
        {
          // Обычный стиль задан явно: часть просмотрщиков (Quick Look, Pages)
          // берёт шрифт из Normal и не читает значения по умолчанию документа.
          id: "Normal",
          name: "Normal",
          run: { font: "Arial", size: 20 },
        },
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          run: { font: "Arial", size: 36, bold: true },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: "Arial", size: 26, bold: true, color: "1A1816" },
          paragraph: { outlineLevel: 0 },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 540, hanging: 270 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    children: [
                      `ТендерФит · закупка № ${report.regNumber} · стр. `,
                      PageNumber.CURRENT,
                      " из ",
                      PageNumber.TOTAL_PAGES,
                    ],
                    size: 16,
                    color: MUTED,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  /*
    `toArrayBuffer`, а не `toBlob`: Blob есть в браузере, но его `arrayBuffer()`
    появляется не во всех средах, и тест на этом спотыкался. ArrayBuffer один и
    тот же везде, а превратить его в файл для скачивания — дело вызывающего кода.
  */
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
