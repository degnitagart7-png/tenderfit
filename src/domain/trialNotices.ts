/**
 * Кому и какое письмо о пробном периоде отправить.
 *
 * Чистое решение без базы и почты: воркер приносит строки пользователей и время,
 * домен отвечает «за сутки», «закончился» или «ничего». Письма два и каждое уходит
 * один раз: отметки `trial_notice_sent_at` и `trial_end_notice_sent_at` хранятся в
 * базе (миграция 20261011000019_add_access_trial.sql).
 *
 * Не пишем тем, кому письмо не к месту: администраторам, тем, кто уже платил
 * (им срок пробного периода не важен), и тем, у кого срока нет. Письмо «закончился»
 * не уходит спустя больше недели после конца: воркер, который стоял, не должен
 * разослать устаревшие напоминания разом.
 */

const HOUR_MS = 3_600_000;

/** За сколько до конца пробного периода пишем «закончится завтра». */
export const ENDING_NOTICE_WINDOW_MS = 24 * HOUR_MS;
/** Как долго после конца ещё имеет смысл писать «закончился». */
export const ENDED_NOTICE_MAX_AGE_MS = 7 * 24 * HOUR_MS;

export type TrialNoticeKind = "ending" | "ended";

export interface TrialNoticeCandidate {
  id: string;
  email: string;
  trialEndsAt: number | null;
  paidUntil: number | null;
  noticeSentAt: number | null;
  endNoticeSentAt: number | null;
}

export function decideTrialNotice(
  user: TrialNoticeCandidate,
  nowMs: number,
  adminEmails: ReadonlySet<string>,
): TrialNoticeKind | null {
  if (adminEmails.has(user.email.trim().toLowerCase())) return null;
  if (user.trialEndsAt === null) return null;
  // Платил хоть раз или оплачен сейчас — напоминания о бесплатном периоде не нужны.
  if (user.paidUntil !== null) return null;

  const rest = user.trialEndsAt - nowMs;
  if (rest > 0) {
    return rest <= ENDING_NOTICE_WINDOW_MS && user.noticeSentAt === null ? "ending" : null;
  }
  return -rest <= ENDED_NOTICE_MAX_AGE_MS && user.endNoticeSentAt === null ? "ended" : null;
}
