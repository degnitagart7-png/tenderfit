import { parseAdminEmails } from "@/domain/access";
import { buildTrialEndedEmail, buildTrialEndingEmail } from "@/domain/emailTemplates";
import { decideTrialNotice, type TrialNoticeCandidate, type TrialNoticeKind } from "@/domain/trialNotices";
import { describeError } from "@/lib/errors";

/**
 * Письма о пробном периоде: «закончится завтра» и «закончился».
 *
 * Запускается воркером раз в час (см. startTrialNoticeWatch в scripts/worker.ts).
 * Каждое письмо уходит один раз: отметка занимается до отправки, а при сбое
 * почты снимается — следующий час повторит. Ничего не бросает наружу: воркер
 * крутит это рядом с очередью заданий, и сбой почты или базы не должен её ронять.
 * Почта не настроена — проверка пропускается молча.
 */

export interface TrialNoticeDeps {
  env: Record<string, string | undefined>;
  now: () => number;
  smtpConfigured: () => boolean;
  listCandidates: (nowMs: number) => Promise<TrialNoticeCandidate[]>;
  claim: (userId: string, kind: TrialNoticeKind, nowMs: number) => Promise<boolean>;
  release: (userId: string, kind: TrialNoticeKind) => Promise<void>;
  sendMail: (to: string, subject: string, text: string, html: string) => Promise<void>;
  log: (message: string) => void;
}

export interface TrialNoticeResult {
  skipped: boolean;
  sent: { ending: number; ended: number };
  failed: number;
}

export async function runTrialNotices(deps: TrialNoticeDeps): Promise<TrialNoticeResult> {
  const result: TrialNoticeResult = { skipped: false, sent: { ending: 0, ended: 0 }, failed: 0 };
  if (!deps.smtpConfigured()) return { ...result, skipped: true };

  try {
    const nowMs = deps.now();
    const admins = parseAdminEmails(deps.env["ADMIN_EMAILS"]);
    const candidates = await deps.listCandidates(nowMs);

    for (const user of candidates) {
      const kind = decideTrialNotice(user, nowMs, admins);
      if (kind === null) continue;
      if (!(await deps.claim(user.id, kind, nowMs))) continue;

      const mail =
        kind === "ending"
          ? buildTrialEndingEmail({ endsAtMs: user.trialEndsAt ?? nowMs })
          : buildTrialEndedEmail();
      try {
        await deps.sendMail(user.email, mail.subject, mail.text, mail.html);
        result.sent[kind] += 1;
      } catch (err) {
        result.failed += 1;
        deps.log(`письмо «${mail.subject}» не отправлено: ${describeError(err)}`);
        await deps.release(user.id, kind).catch((releaseErr: unknown) => {
          deps.log(`отметка письма не снята: ${describeError(releaseErr)}`);
        });
      }
    }
    if (result.sent.ending + result.sent.ended + result.failed > 0) {
      deps.log(`отправлено: за сутки ${String(result.sent.ending)}, «закончился» ${String(result.sent.ended)}, сбоев ${String(result.failed)}`);
    }
  } catch (err) {
    deps.log(`проверка не выполнена: ${describeError(err)}`);
  }
  return result;
}

/** Боевые зависимости: база, SMTP, окружение процесса. Импорты ленивые — nodemailer нужен только тому, кто шлёт. */
export function defaultTrialNoticeDeps(): TrialNoticeDeps {
  return {
    env: process.env,
    now: () => Date.now(),
    smtpConfigured: () => {
      const e = process.env;
      return Boolean(e["SMTP_HOST"] && e["SMTP_USER"] && e["SMTP_PASSWORD"]);
    },
    listCandidates: async (nowMs) => {
      const { trialNoticeRepository } = await import("@/repositories/trialNoticeRepository");
      return trialNoticeRepository.listCandidates(nowMs);
    },
    claim: async (userId, kind, nowMs) => {
      const { trialNoticeRepository } = await import("@/repositories/trialNoticeRepository");
      return trialNoticeRepository.claim(userId, kind, nowMs);
    },
    release: async (userId, kind) => {
      const { trialNoticeRepository } = await import("@/repositories/trialNoticeRepository");
      return trialNoticeRepository.release(userId, kind);
    },
    sendMail: async (to, subject, text, html) => {
      const { sendSmtpMail } = await import("@/services/smtpMailer");
      await sendSmtpMail(to, subject, text, { html, logLabel: "Пробный период" });
    },
    log: (message) => console.log(`[trial-notice] ${message}`),
  };
}
