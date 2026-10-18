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
  // Аудит сметы заказчика: смет и непроверенных, токенов нет вовсе.
  if (report.audit) {
    const audit = report.audit;
    const parts = [`смет ${audit.reports.length}`, "токенов 0"];
    if (audit.notRecognized.length > 0) parts.push(`не по форме 421/пр ${audit.notRecognized.length}`);
    return `аудит сметы заказчика: ${parts.join(", ")}`;
  }

  if (report.estimate) {
    const estimate = report.estimate;
    const parts = [
      `позиций ${estimate.billItems}`,
      `токенов ${estimate.tokensUsed}`,
    ];
    if (estimate.volumeSource) {
      const label = { BILL: "ведомость", CUSTOMER_ESTIMATE: "смета заказчика", CONTRACT_ESTIMATE: "смета контракта", SPEC: "ТЗ и проект" }[estimate.volumeSource.level];
      parts.push(`объёмы: ${label}`);
    }
    if (estimate.normPick !== undefined && (estimate.normPick.materialRows ?? 0) > 0) {
      const pick = estimate.normPick;
      parts.push(
        `материалов ${pick.materialRows ?? 0}: ресурс от ИИ ${pick.materialPicked ?? 0}` +
          ((pick.materialFallback ?? 0) > 0 ? `, по наименованию ${pick.materialFallback}` : "") +
          ((pick.materialUnpriced ?? 0) > 0 ? `, без цены ${pick.materialUnpriced}` : ""),
      );
    }
    if (estimate.normPick !== undefined && (estimate.normPick.normMaterialRequested ?? 0) + (estimate.normPick.normMaterialFallback ?? 0) > 0) {
      const pick = estimate.normPick;
      parts.push(
        `материалов нормы «по проекту» от ИИ ${pick.normMaterialPicked ?? 0} из ${pick.normMaterialRequested ?? 0}` +
          ((pick.normMaterialRejected ?? 0) > 0 ? `, отклонено проверкой ${pick.normMaterialRejected}` : "") +
          ((pick.normMaterialFallback ?? 0) > 0 ? `, по наименованию ${pick.normMaterialFallback}` : ""),
      );
    }
    if (estimate.normPick !== undefined && estimate.normPick.requested > 0) {
      const pick = estimate.normPick;
      parts.push(
        `норм от ИИ ${pick.picked} из ${pick.requested}` +
          (pick.rejected > 0 ? `, отклонено проверкой ${pick.rejected}` : "") +
          (pick.fallback > 0 ? `, без ответа ${pick.fallback}` : "") +
          `, токенов ${pick.tokens}`,
      );
    }
    const generated = estimate.generated;
    if (generated !== undefined && generated.debris.rows > 0) {
      parts.push(`мусор ${generated.debris.tons} т: строк ${generated.debris.rows}` + (generated.debris.unpriced > 0 ? `, без цены ${generated.debris.unpriced}` : ""));
    }
    if (generated !== undefined && generated.implied.proposed > 0) {
      parts.push(
        `работ по технологии от ИИ ${generated.implied.accepted} из ${generated.implied.proposed}` +
          (generated.implied.rejected > 0 ? `, отклонено проверкой ${generated.implied.rejected}` : ""),
      );
    }
    if (generated !== undefined && generated.implied.failed > 0) parts.push("работы по технологии: ответа модели нет");
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
