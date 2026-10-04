import type { SyncJobReport } from "@/types/database";

/**
 * Подпись отчёта о выполненном задании.
 *
 * Одна строка для двух мест: лога воркера на сервере в России и панели
 * «Журнал заданий» на проде. Формулировки живут в домене и проверяются тестами,
 * чтобы расхождение «загружено 8» в логе и «8 документов» в интерфейсе не
 * заставляло гадать, о чём речь.
 *
 * Слова нарочно не склоняются по числам («закупок 12», «недоступно 1»): домен
 * не тянет утилиты форматирования, а ошибка в согласовании была бы видна
 * каждому, кто откроет журнал.
 */

function hasMeasure(report: SyncJobReport): boolean {
  return (
    report.tenders !== undefined ||
    report.documents !== undefined ||
    report.already !== undefined ||
    report.unavailable !== undefined ||
    report.notFound !== undefined ||
    report.failed !== undefined ||
    report.analysisJobs !== undefined ||
    report.stoppedEarly !== undefined
  );
}

/**
 * Превращает отчёт в строку.
 *
 * `null` и пустой объект дают «отчёт не заполнен», а не нули: ноль и «не
 * измеряли» — разные утверждения, и в журнале платного прогона их путать нельзя.
 */
export function describeSyncJobReport(report: SyncJobReport | null): string {
  if (!report) return "отчёт не заполнен";
  if (report.note) return report.note;

  /*
    Смета мерится другим: у неё нет ни закупок, ни загруженных документов —
    есть позиции ведомости и потраченные токены. Прежняя подпись знала только
    поля прогона источников и объявляла готовую смету незаполненным отчётом:
    задание 75d560fc выдало книгу на 13 позиций и попало в журнал как «отчёт
    не заполнен». Отчёт, который называет успех пустотой, отправляет искать
    поломку там, где её нет.
  */
  if (report.estimate) {
    const estimate = report.estimate;
    const parts = [
      `позиций ${estimate.billItems}`,
      `токенов ${estimate.tokensUsed}`,
    ];
    if (estimate.rejected.length > 0) parts.push(`отклонено строк ${estimate.rejected.length}`);
    if (estimate.documentsWithoutBill.length > 0) {
      parts.push(`без ведомости ${estimate.documentsWithoutBill.length}`);
    }
    return `смета: ${parts.join(", ")}`;
  }

  if (!hasMeasure(report)) return "отчёт не заполнен";

  const parts = [
    `закупок ${report.tenders ?? 0}`,
    `загружено ${report.documents ?? 0}`,
    `уже было ${report.already ?? 0}`,
    `недоступно ${report.unavailable ?? 0}`,
  ];
  if ((report.notFound ?? 0) > 0) parts.push(`не найдено ${report.notFound}`);
  if ((report.failed ?? 0) > 0) parts.push(`сбоев ${report.failed}`);
  if ((report.analysisJobs ?? 0) > 0) parts.push(`задач разбора закрыто ${report.analysisJobs}`);
  if (report.stoppedEarly) parts.push("прервано по времени");

  return parts.join(", ");
}
