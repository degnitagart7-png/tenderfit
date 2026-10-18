import { getSupabaseServerClient } from "@/lib/supabase";
import { ENDED_NOTICE_MAX_AGE_MS, ENDING_NOTICE_WINDOW_MS, type TrialNoticeCandidate, type TrialNoticeKind } from "@/domain/trialNotices";

/**
 * Пользователи для писем о пробном периоде и отметки «письмо отправлено».
 *
 * Читает и пишет только воркер с ключом service role. Колонки создаёт миграция
 * 20261011000019_add_access_trial.sql.
 */

const COLUMN: Record<TrialNoticeKind, "trial_notice_sent_at" | "trial_end_notice_sent_at"> = {
  ending: "trial_notice_sent_at",
  ended: "trial_end_notice_sent_at",
};

const iso = (ms: number): string => new Date(ms).toISOString();

function fail(error: { message?: string } | null): void {
  if (error) throw new Error(error.message ?? "Ошибка базы данных");
}

const ms = (value: string | null): number | null => (value === null ? null : Date.parse(value));

interface Row {
  id: string;
  email: string;
  trial_ends_at: string | null;
  paid_until: string | null;
  trial_notice_sent_at: string | null;
  trial_end_notice_sent_at: string | null;
}

export const trialNoticeRepository = {
  /** Те, у кого срок пробного периода близко или вышел недавно: окно шире, решение — в домене. */
  async listCandidates(nowMs: number): Promise<TrialNoticeCandidate[]> {
    const { data, error } = await getSupabaseServerClient()
      .from("app_users")
      .select("id, email, trial_ends_at, paid_until, trial_notice_sent_at, trial_end_notice_sent_at")
      .gte("trial_ends_at", iso(nowMs - ENDED_NOTICE_MAX_AGE_MS))
      .lte("trial_ends_at", iso(nowMs + ENDING_NOTICE_WINDOW_MS))
      .is("paid_until", null)
      .limit(1000);
    fail(error);
    return ((data as Row[] | null) ?? []).map((row) => ({
      id: row.id,
      email: row.email,
      trialEndsAt: ms(row.trial_ends_at),
      paidUntil: ms(row.paid_until),
      noticeSentAt: ms(row.trial_notice_sent_at),
      endNoticeSentAt: ms(row.trial_end_notice_sent_at),
    }));
  },

  /**
   * Занять письмо: отметка ставится условно (`is null`), поэтому из двух
   * одновременных проверок письмо займёт одна. false — уже занято или отправлено.
   */
  async claim(userId: string, kind: TrialNoticeKind, nowMs: number): Promise<boolean> {
    const column = COLUMN[kind];
    const { data, error } = await getSupabaseServerClient()
      .from("app_users")
      .update({ [column]: iso(nowMs) })
      .eq("id", userId)
      .is(column, null)
      .select("id");
    fail(error);
    return (data ?? []).length === 1;
  },

  /** Письмо не ушло: снять отметку, чтобы следующая проверка повторила попытку. */
  async release(userId: string, kind: TrialNoticeKind): Promise<void> {
    const { error } = await getSupabaseServerClient()
      .from("app_users")
      .update({ [COLUMN[kind]]: null })
      .eq("id", userId);
    fail(error);
  },
};
