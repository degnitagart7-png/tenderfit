import { buildAuditConclusion } from "@/domain/estimate/auditConclusion";
import {
  auditConclusionFileName,
  buildAuditConclusionReport,
  buildAuditOverallReport,
  OVERALL_TITLE,
  CONCLUSION_TITLE,
  type AuditConclusionMeta,
} from "@/domain/estimate/auditConclusionReport";
import type { AuditReport } from "@/domain/estimate/customerAudit";
import type { NotRecognizedEstimate } from "@/domain/estimate/customerLsr";
import { notRecognizedLine } from "@/domain/estimate/customerAuditText";
import { renderReportDocx } from "@/services/deepAnalysisExport";

/**
 * Выгрузка заключения по смете заказчика в файл Word.
 *
 * Содержание — `buildAuditConclusionReport` (то же значение, что показывает экран), вёрстка — `renderReportDocx`, общая с отчётом
 * глубокого анализа: тот же .docx, те же таблицы, номер страницы в колонтитуле. Собирается на сервере (`/api/estimate/conclusion`)
 * по номеру задания: результат проверки лежит в базе, и браузеру отдаётся готовый файл, а не данные для сборки.
 */

export interface AuditConclusionDocxInput extends AuditConclusionMeta {
  readonly report: AuditReport;
  readonly notRecognized?: readonly NotRecognizedEstimate[];
}

export { auditConclusionFileName };

export async function buildAuditConclusionDocx(input: AuditConclusionDocxInput): Promise<Uint8Array> {
  const conclusion = buildAuditConclusion({ report: input.report, notRecognized: input.notRecognized ?? [] });
  const report = buildAuditConclusionReport(conclusion, input.report, input);
  return renderReportDocx(report, {
    headerLine: input.tenderId === null ? "Проверка локальной сметы заказчика" : `Закупка № ${input.tenderId}`,
    footerLabel: "ТендерФит · заключение по смете заказчика",
    docTitle: `${CONCLUSION_TITLE} — ${conclusion.title}`,
  });
}

export interface AuditOverallDocxInput extends AuditConclusionMeta {
  readonly reports: readonly AuditReport[];
  readonly notRecognized?: readonly NotRecognizedEstimate[];
}

/** Общее заключение по всем сметам закупки: итог, таблица смет, разделы по сметам. */
export async function buildAuditOverallDocx(input: AuditOverallDocxInput): Promise<Uint8Array> {
  const report = buildAuditOverallReport(input.reports, input, (input.notRecognized ?? []).map(notRecognizedLine));
  return renderReportDocx(report, {
    headerLine: input.tenderId === null ? "Проверка локальных смет заказчика" : `Закупка № ${input.tenderId}`,
    footerLabel: "ТендерФит · заключение по всем сметам заказчика",
    docTitle: OVERALL_TITLE,
  });
}
