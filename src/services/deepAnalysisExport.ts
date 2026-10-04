import type { DeepAnalysisSummary } from "@/domain/deepAnalysis";
import { documentArchive, documentSkipMark } from "@/domain/deepAnalysis";
import {
  deepAnalysisStateLabels,
  findingCategoryLabels,
  findingSeverityLabels,
} from "@/lib/labels";
import type { AnalysisFinding } from "@/types/database";

/**
 * Выгрузка результата глубокого анализа в файл Word.
 *
 * Зачем настоящий .docx, а не HTML с расширением .doc: файл уходит партнёру,
 * юристу или сметчику, а Word на HTML под чужим расширением показывает
 * предупреждение о несовпадении формата. Документ, который при открытии просит
 * подтвердить, что он не вредоносный, — плохой способ передать выводы.
 *
 * Собирается на стороне браузера по нажатию кнопки: все данные для документа
 * панель уже держит, и ходить за ними второй раз на сервер незачем. Библиотека
 * `docx` весит около мегабайта, поэтому импорт динамический — в основную сборку
 * она не попадает.
 *
 * Что попадает в документ: состояние разбора, находки с цитатами и ссылкой на
 * раздел документа, список прочитанных и пропущенных файлов с причинами. Это
 * ровно то, что видно в карточке: выгрузка не пересказывает анализ своими
 * словами и ничего к нему не добавляет.
 */

export interface DeepAnalysisExportInput {
  regNumber: string;
  subject: string;
  summary: DeepAnalysisSummary;
  generatedAt: Date;
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

export async function buildDeepAnalysisDocx(
  input: DeepAnalysisExportInput,
): Promise<Uint8Array> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import(
    "docx"
  );

  const { summary } = input;
  const children: InstanceType<typeof Paragraph>[] = [];

  const heading = (
    text: string,
    level: (typeof HeadingLevel)[keyof typeof HeadingLevel],
  ) =>
    new Paragraph({
      text,
      heading: level,
      spacing: { before: 240, after: 120 },
    });

  const line = (
    text: string,
    options: { bold?: boolean; italics?: boolean } = {},
  ) =>
    new Paragraph({
      children: [
        new TextRun({ text, bold: options.bold, italics: options.italics }),
      ],
      spacing: { after: 80 },
    });

  children.push(
    heading(`Глубокий анализ документации`, HeadingLevel.HEADING_1),
  );
  children.push(line(`Закупка № ${input.regNumber}`, { bold: true }));
  children.push(line(input.subject));
  children.push(
    line(
      `Состояние: ${deepAnalysisStateLabels[summary.state]}. ${summary.title}.`,
    ),
  );
  children.push(line(summary.detail));
  if (summary.modelUsed !== null) {
    children.push(
      line(`Выводы сделаны моделью ${summary.modelUsed}.`, { italics: true }),
    );
  }
  children.push(
    line(
      `Выгружено ${input.generatedAt.toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" })}.`,
      { italics: true },
    ),
  );

  children.push(heading("Что нашлось в документации", HeadingLevel.HEADING_2));
  if (summary.findings.length === 0) {
    children.push(line("Существенного в прочитанной документации не найдено."));
  } else {
    for (const group of summary.findingGroups) {
      children.push(
        heading(findingCategoryLabels[group.category], HeadingLevel.HEADING_3),
      );
      for (const item of group.findings)
        children.push(...findingParagraphs(item, Paragraph, TextRun));
    }
  }

  children.push(heading("Документы закупки", HeadingLevel.HEADING_2));
  if (summary.documents.length === 0) {
    children.push(line("Документов в базе нет."));
  } else {
    for (const document of summary.documents) {
      const skipped = documentSkipMark(document);
      const archive = documentArchive(document);
      const title =
        (document.raw_json as { title?: string } | null)?.title ??
        document.filename;

      children.push(line(title, { bold: true }));
      if (skipped) children.push(line(`Пропущен. ${skipped.reason}`));
      else children.push(line("Текст получен."));
      if (archive) {
        children.push(
          line(
            `Внутри архива прочитано ${archive.parsed} из ${archive.total}.`,
          ),
        );
      }
    }
  }

  /*
    Дисклеймер в самом документе, а не только на экране.

    Файл уходит из интерфейса и живёт дальше сам: его перешлют, приложат к
    письму, распечатают. Оговорка, оставшаяся на странице, до читателя такого
    файла не доедет, а решение по ней принимают.
  */
  children.push(heading("Важно", HeadingLevel.HEADING_2));
  children.push(
    line(
      "Выводы сделаны по тексту, который удалось прочитать: часть файлов может быть " +
        "пропущена, о каждом сказано выше. Документ носит информационно-аналитический " +
        "характер, не заменяет чтение документации и не гарантирует допуск к закупке. " +
        "Цитаты проверяйте по первоисточнику.",
    ),
  );

  const doc = new Document({ sections: [{ children }] });

  /*
    `toArrayBuffer`, а не `toBlob`: Blob есть в браузере, но его `arrayBuffer()`
    появляется не во всех средах, и тест на этом спотыкался. ArrayBuffer один и
    тот же везде, а превратить его в файл для скачивания — дело вызывающего кода.
  */
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

/** Одна находка: заголовок с важностью, объяснение, цитата и её место. */
function findingParagraphs(
  item: AnalysisFinding,
  Paragraph: typeof import("docx").Paragraph,
  TextRun: typeof import("docx").TextRun,
): InstanceType<typeof Paragraph>[] {
  const out: InstanceType<typeof Paragraph>[] = [];

  out.push(
    new Paragraph({
      children: [
        new TextRun({ text: item.title, bold: true }),
        new TextRun({ text: ` — ${findingSeverityLabels[item.severity]}` }),
      ],
      spacing: { before: 120, after: 60 },
    }),
  );
  out.push(new Paragraph({ text: item.detail, spacing: { after: 60 } }));

  if (item.evidence_quote.length > 0) {
    out.push(
      new Paragraph({
        children: [
          new TextRun({ text: `«${item.evidence_quote}»`, italics: true }),
        ],
        indent: { left: 360 },
        spacing: { after: 40 },
      }),
    );
  }
  if (item.evidence_section.length > 0) {
    out.push(
      new Paragraph({
        children: [new TextRun({ text: item.evidence_section, size: 18 })],
        indent: { left: 360 },
        spacing: { after: 120 },
      }),
    );
  }

  return out;
}
