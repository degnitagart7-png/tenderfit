import type {
  Digest,
  DigestSettings,
  Notification,
  Tender,
  TenderAnalysis,
} from "@/domain/entities";
import { isClosingWithinDays } from "@/domain/scoring";
import type { NotificationProvider } from "@/adapters/types";

/**
 * Mock-реализация провайдера уведомлений. Формирует ежедневный отчёт
 * из четырёх разделов (раздел 15 ТЗ). Реальная отправка email/Telegram
 * в MVP не выполняется — методы send* лишь логируют намерение.
 */
export class MockNotificationProvider implements NotificationProvider {
  async buildDailyDigest(
    analyses: TenderAnalysis[],
    tenders: Tender[],
    settings: DigestSettings,
  ): Promise<Digest> {
    const tenderById = new Map(tenders.map((t) => [t.id, t]));
    const filtered = analyses.filter((a) => a.fitScore >= settings.minFitScore);

    const recommended = filtered
      .filter((a) => a.verdict === "RECOMMENDED")
      .map((a) => a.tenderId);
    const manualReview = filtered
      .filter((a) => a.verdict === "MANUAL_REVIEW")
      .map((a) => a.tenderId);
    /*
      «Скоро заканчивается подача» — то же окно, что в блоке «Срочно» на экране
      «Сегодня» и в фильтре закупок (`URGENT_DEADLINE_DAYS`). Раньше отчёт брал
      24 часа и раздел почти всегда оказывался пустым: за сутки заявку на
      строительную закупку не собрать, а три экрана называли «срочным» разные списки.
      Истёкшие сюда не попадают — их отсекает блокер «Срок подачи истёк».
    */
    const closingSoon = filtered
      .filter((a) => {
        const t = tenderById.get(a.tenderId);
        return t ? isClosingWithinDays(t.deadlines.submissionEnd) : false;
      })
      .map((a) => a.tenderId);

    const excluded = analyses
      .filter((a) => a.verdict === "NOT_RECOMMENDED")
      .map((a) => ({
        tenderId: a.tenderId,
        reason:
          a.hardBlockers[0]?.reason ??
          (a.fitScore < 50
            ? "Низкое соответствие профилю"
            : "Критический риск договора"),
      }));

    const documentChanges = tenders
      .filter((t) => t.changeLog.length > 0)
      .map((t) => t.id);

    return {
      id: `digest-${new Date().toISOString().slice(0, 10)}`,
      date: new Date().toISOString(),
      totalNew: analyses.length,
      recommended,
      manualReview,
      closingSoon,
      excluded,
      documentChanges,
    };
  }

  async sendUrgent(notification: Notification): Promise<void> {
    // Mock: реальная отправка не выполняется.
    console.info(`[mock] Срочное уведомление: ${notification.title}`);
  }

  async notifyDocumentChanged(tenderId: string): Promise<void> {
    console.info(`[mock] Изменение документации по закупке ${tenderId}`);
  }

  async notifyDeadlineApproaching(tenderId: string): Promise<void> {
    console.info(`[mock] Приближается срок подачи по закупке ${tenderId}`);
  }
}

export const mockNotificationProvider = new MockNotificationProvider();
