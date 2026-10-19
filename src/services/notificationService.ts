import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { hasAccess, isAdminEmail, parseAdminEmails, resolveAccess } from "@/domain/access";
import { readConsolidated } from "@/domain/analysisConsolidation";
import {
  DIGEST_CLOSING_HOURS,
  appBaseUrl,
  buildDigest,
  digestDue,
  normalizeSearchProfiles,
  readPipeline,
  WORKING_STATUSES,
  type DigestPipeline,
  type DigestResult,
} from "@/domain/digest";
import { resolveDigestSettings, type ResolvedDigestSettings } from "@/domain/digestSettings";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import type { Tender } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import { buildAnalysisReadyEmail, buildDigestEmail, buildEstimateReadyEmail, buildFailureAlertEmail } from "@/domain/notificationEmails";
import type { EmailMessage } from "@/domain/emailTemplates";
import { withSearchRegions } from "@/domain/scoringGeography";
import { describeError } from "@/lib/errors";
import { normalizeSavedProfile } from "@/repositories/companyProfileRepository";
import type { DigestUserRecord, FailedJob, ReadyJob, UserDigestData } from "@/repositories/notificationRepository";
import { dbRowToTender } from "@/services/tenderApiService";
import type { TenderRow as TenderRowDB } from "@/types/database";

/**
 * Письма-уведомления: утренняя сводка и «готов анализ / смета».
 *
 * Запускается воркером (`startNotificationWatch`): письма о готовности — раз в минуту, сводки —
 * раз в десять минут. Как и письма о пробном периоде, ничего не бросает наружу: воркер крутит это
 * рядом с очередью заданий, и сбой почты или базы не должен её ронять. Почта не настроена —
 * проверка пропускается молча.
 *
 * Кому писать, решает шлюз `NOTIFY_RECIPIENTS`: `admins` (по умолчанию — только адреса из
 * ADMIN_EMAILS), `all` или `off`. Остальным письмо не уходит и задача не отмечается: когда шлюз
 * откроют (`all`), их сводки и письма сработают как обычно.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Письмо о готовности шлют только по свежим задачам: при первом запуске вчерашнее не рассылается. */
export const READY_WINDOW_MS = 30 * MINUTE_MS;
/** Короче этого человек дождался результата на экране: письмо ему ни к чему. */
export const READY_MIN_DURATION_MS = 2 * MINUTE_MS;
/** За сколько часов «новое», если сводку не слали раньше. */
export const FIRST_DIGEST_LOOKBACK_MS = 24 * HOUR_MS;
/** Глубже трёх суток «новое» не ищем: после долгого перерыва сводка не должна стать выгрузкой всей базы. */
export const MAX_DIGEST_LOOKBACK_MS = 72 * HOUR_MS;

/* --------------------------------- Шлюз получателей --------------------------------- */

export type NotifyRecipientsMode = "admins" | "all" | "off";

/** `NOTIFY_RECIPIENTS`: пусто и непонятное значение — `admins`: лучше не написать, чем написать всем. */
export function notifyRecipientsMode(env: Record<string, string | undefined>): NotifyRecipientsMode {
  const raw = (env["NOTIFY_RECIPIENTS"] ?? "").trim().toLowerCase();
  return raw === "all" || raw === "off" ? raw : "admins";
}

/** Можно ли писать этому адресу при текущем шлюзе. */
export function mayNotify(mode: NotifyRecipientsMode, email: string, env: Record<string, string | undefined>): boolean {
  if (mode === "off") return false;
  if (mode === "all") return true;
  return isAdminEmail(email, env);
}

/* ------------------------------------ Зависимости ------------------------------------ */

export interface NotificationDeps {
  env: Record<string, string | undefined>;
  now: () => number;
  smtpConfigured: () => boolean;
  sendMail: (to: string, subject: string, text: string, html: string) => Promise<void>;
  log: (message: string) => void;

  /* Готовность расчётов. */
  listReadyJobs: (sinceMs: number) => Promise<ReadyJob[]>;
  claimJob: (job: Pick<ReadyJob, "kind" | "id">, nowMs: number) => Promise<boolean>;
  releaseJob: (job: Pick<ReadyJob, "kind" | "id">) => Promise<void>;
  /** Сырые настройки уведомлений человека по почте; нет — undefined. */
  readSettingsByEmail: (email: string) => Promise<unknown>;
  readTenderSubject: (regNumber: string) => Promise<string | null>;
  /** Упавшие задачи клиентов для письма администраторам; нет — проверка сбоев выключена. */
  listFailedJobs?: (sinceMs: number) => Promise<FailedJob[]>;
  readAnalysisRows: (regNumber: string) => Promise<unknown[]>;

  /* Сводки. */
  listUsers: () => Promise<DigestUserRecord[]>;
  findUserByEmail: (email: string) => Promise<DigestUserRecord | null>;
  readSettings: (userIds: readonly string[]) => Promise<Map<string, unknown>>;
  readDigestData: (userIds: readonly string[]) => Promise<Map<string, UserDigestData>>;
  loadTenderRows: (query: {
    sinceMs: number;
    nowMs: number;
    closingHours: number;
    regNumbers: readonly string[];
  }) => Promise<TenderRowDB[]>;
  markDigestSent: (userId: string, nowMs: number) => Promise<void>;
}

/* ------------------------------------ Сводка ------------------------------------ */

/**
 * Сводка человека из строк базы: строки приводятся к виду ленты (закупка и оценка по его анкете),
 * дальше работает тот же `buildDigest`, что у страницы «Отчёт».
 */
export function buildUserDigest(input: {
  dbRows: readonly TenderRowDB[];
  data: UserDigestData | undefined;
  settings: ResolvedDigestSettings;
  since: number;
  now: number;
  baseUrl: string;
  /** Разобранные закупки по номеру: общий на прогон, чтобы не разбирать одну строку для каждого человека. */
  tenderCache?: Map<string, Tender>;
}): DigestResult {
  const searchProfiles = normalizeSearchProfiles(input.data?.searchProfiles);
  const saved = input.data?.companyProfile ?? null;
  const company = saved === null ? emptyCompanyProfile : normalizeSavedProfile(saved);
  // Оценка считается по анкете с регионами из «Что ищем» — как в ленте (`useTenderData`).
  const scoringProfile = withSearchRegions(company, searchProfiles);
  const pipeline = readPipeline(input.data?.pipeline);
  const cache = input.tenderCache ?? new Map<string, Tender>();

  const rows: TenderRow[] = [];
  for (const row of input.dbRows) {
    try {
      let tender = cache.get(row.reg_number);
      if (tender === undefined) {
        tender = dbRowToTender(row);
        cache.set(row.reg_number, tender);
      }
      rows.push({
        tender,
        analysis: analyzeTender(tender, scoringProfile, new Date(input.now)),
        pipelineStatus: pipeline[tender.id]?.status ?? "NEW",
      });
    } catch (error) {
      // Одна закупка с изъяном не должна ронять сводку: как и лента, пропускаем её.
      console.error(`Сводка: закупка ${row.reg_number} пропущена: ${describeError(error)}`);
    }
  }

  return buildDigest({
    rows,
    searchProfiles,
    companyProfile: company,
    pipeline,
    since: input.since,
    now: input.now,
    minFitScore: input.settings.minFitScore,
    baseUrl: input.baseUrl,
  });
}

/** Начало «нового» для человека: прошлая сводка, но не глубже трёх суток; сводки не было — сутки назад. */
export function digestSince(lastSentAt: number | null, now: number): number {
  const floor = now - MAX_DIGEST_LOOKBACK_MS;
  return Math.max(lastSentAt ?? now - FIRST_DIGEST_LOOKBACK_MS, floor);
}

/** Номера закупок из воронки человека в рабочих статусах: их строки читаются даже если закупка старая. */
function workingRegNumbers(data: UserDigestData | undefined): string[] {
  const pipeline: DigestPipeline = readPipeline(data?.pipeline);
  return Object.entries(pipeline)
    .filter(([, item]) => WORKING_STATUSES.includes(item.status))
    .map(([id]) => id);
}

export interface DigestRunResult {
  skipped: boolean;
  /** Отправлено писем. */
  sent: number;
  /** Сводка была пустой: письма нет, отметка обновлена. */
  empty: number;
  failed: number;
}

/** Утренние сводки: всем, кому по их часам пора. */
export async function runDigests(deps: NotificationDeps): Promise<DigestRunResult> {
  const result: DigestRunResult = { skipped: false, sent: 0, empty: 0, failed: 0 };
  if (!deps.smtpConfigured()) return { ...result, skipped: true };
  const mode = notifyRecipientsMode(deps.env);
  if (mode === "off") return { ...result, skipped: true };

  try {
    const now = deps.now();
    const users = await deps.listUsers();
    // Доступ действующий: у истёкшего пробного периода приложение закрыто, и сводка ему ни к чему.
    const eligible = users.filter(
      (user) =>
        mayNotify(mode, user.email, deps.env) &&
        hasAccess(
          resolveAccess({ trialEndsAt: user.trialEndsAt, paidUntil: user.paidUntil, plan: user.plan }, user.email, now, deps.env),
        ),
    );
    if (eligible.length === 0) return result;

    const settingsById = await deps.readSettings(eligible.map((user) => user.id));
    const due = eligible
      .map((user) => ({ user, settings: resolveDigestSettings(settingsById.get(user.id)) }))
      .filter(({ user, settings }) => digestDue(settings, user.digestSentAt, now));
    if (due.length === 0) return result;

    // Строки читаются один раз на прогон и раздаются всем, кому пора.
    const dataById = await deps.readDigestData(due.map(({ user }) => user.id));
    const sinceMin = Math.min(...due.map(({ user }) => digestSince(user.digestSentAt, now)));
    const regNumbers = [...new Set(due.flatMap(({ user }) => workingRegNumbers(dataById.get(user.id))))];
    const dbRows = await deps.loadTenderRows({ sinceMs: sinceMin, nowMs: now, closingHours: DIGEST_CLOSING_HOURS, regNumbers });
    const tenderCache = new Map<string, Tender>();
    const baseUrl = appBaseUrl(deps.env);

    for (const { user, settings } of due) {
      try {
        const digest = buildUserDigest({
          dbRows,
          data: dataById.get(user.id),
          settings,
          since: digestSince(user.digestSentAt, now),
          now,
          baseUrl,
          tenderCache,
        });
        if (digest.isEmpty) {
          // Сообщить нечего — не пишем, но «сегодня разобрались»: иначе проверка шла бы весь день.
          await deps.markDigestSent(user.id, now);
          result.empty += 1;
          continue;
        }
        const mail = buildDigestEmail({ digest, timeZone: settings.timeZone, baseUrl });
        await deps.sendMail(user.email, mail.subject, mail.text, mail.html);
        await deps.markDigestSent(user.id, now);
        result.sent += 1;
      } catch (error) {
        // Не отмечаем: следующая проверка (через десять минут) повторит.
        result.failed += 1;
        deps.log(`сводка ${user.email} не отправлена: ${describeError(error)}`);
      }
    }
    if (result.sent + result.empty + result.failed > 0) {
      deps.log(`сводки: отправлено ${String(result.sent)}, пустых ${String(result.empty)}, сбоев ${String(result.failed)}`);
    }
  } catch (error) {
    deps.log(`сводки не выполнены: ${describeError(error)}`);
  }
  return result;
}

export interface SendDigestNowResult {
  sent: boolean;
  /** Сколько строк ушло в письме. */
  items: number;
  /** Почему письма нет. */
  reason?: string;
}

/**
 * Пробная сводка по просьбе человека: собрать и отправить прямо сейчас (новое за сутки).
 * Отметку `digest_sent_at` не трогает: утренняя сводка завтра придёт как обычно. Работает при любом
 * шлюзе, кроме `off`: это письмо на собственную почту человека.
 */
export async function sendDigestNow(email: string, deps: NotificationDeps): Promise<SendDigestNowResult> {
  if (!deps.smtpConfigured()) return { sent: false, items: 0, reason: "Почта на сервере не настроена" };
  if (notifyRecipientsMode(deps.env) === "off") return { sent: false, items: 0, reason: "Отправка писем выключена на сервере" };

  try {
    const now = deps.now();
    const user = await deps.findUserByEmail(email);
    if (user === null) return { sent: false, items: 0, reason: "Аккаунт не найден" };

    const settings = resolveDigestSettings((await deps.readSettings([user.id])).get(user.id));
    const data = (await deps.readDigestData([user.id])).get(user.id);
    const since = now - FIRST_DIGEST_LOOKBACK_MS;
    const dbRows = await deps.loadTenderRows({
      sinceMs: since,
      nowMs: now,
      closingHours: DIGEST_CLOSING_HOURS,
      regNumbers: workingRegNumbers(data),
    });
    const baseUrl = appBaseUrl(deps.env);
    const digest = buildUserDigest({ dbRows, data, settings, since, now, baseUrl });
    if (digest.isEmpty) {
      return {
        sent: false,
        items: 0,
        reason: "Сейчас сообщить нечего: новых закупок по профилю нет, сроков и закупок в работе тоже. Письмо не отправлено.",
      };
    }
    const mail = buildDigestEmail({ digest, timeZone: settings.timeZone, baseUrl });
    await deps.sendMail(user.email, mail.subject, mail.text, mail.html);
    return { sent: true, items: digest.fresh.length + digest.closing.length + digest.inWork.length };
  } catch (error) {
    deps.log(`пробная сводка ${email} не отправлена: ${describeError(error)}`);
    return { sent: false, items: 0, reason: "Не удалось отправить письмо. Попробуйте позже." };
  }
}

/* ------------------------------ Готов анализ или смета ------------------------------ */

/** Итог глубокого анализа для письма: сводка, а если её нет — число выводов по документам. */
export function summarizeAnalysis(analyses: readonly unknown[]): {
  summary: string | null;
  findings: number;
  conflicts: number | null;
  questions: number | null;
} {
  const consolidated = analyses.map(readConsolidated).filter((c) => c !== null);
  const last = consolidated.at(-1);
  if (last !== undefined) {
    return {
      summary: last.summary.trim() === "" ? null : last.summary,
      findings: last.findings.length,
      conflicts: last.conflicts.length,
      questions: last.questions.length,
    };
  }
  let findings = 0;
  for (const analysis of analyses) {
    const list = (analysis as { findings?: unknown } | null)?.findings;
    if (Array.isArray(list)) findings += list.length;
  }
  return { summary: null, findings, conflicts: null, questions: null };
}

export interface ReadyRunResult {
  skipped: boolean;
  sent: number;
  /** Задача закрыта без письма: расчёт был коротким, письма выключены, аудит сметы. */
  skippedJobs: number;
  failed: number;
}

/** Письма «анализ готов» и «смета готова» тем, кто запускал расчёт. */
export async function runReadyNotifications(deps: NotificationDeps): Promise<ReadyRunResult> {
  const result: ReadyRunResult = { skipped: false, sent: 0, skippedJobs: 0, failed: 0 };
  if (!deps.smtpConfigured()) return { ...result, skipped: true };
  const mode = notifyRecipientsMode(deps.env);
  if (mode === "off") return { ...result, skipped: true };

  try {
    const now = deps.now();
    const since = now - READY_WINDOW_MS;
    const baseUrl = appBaseUrl(deps.env);
    const jobs = await deps.listReadyJobs(since);

    for (const job of jobs) {
      const email = job.requestedBy.trim().toLowerCase();
      if (!email.includes("@") || job.finishedAt < since) continue;
      // Чужим при закрытом шлюзе — ничего и без отметки: откроют шлюз — письмо уйдёт (в пределах окна).
      if (!mayNotify(mode, email, deps.env)) continue;
      if (!(await deps.claimJob(job, now))) continue;

      try {
        const mail = await composeReadyMail(job, email, deps, baseUrl);
        if (mail === null) {
          result.skippedJobs += 1;
          continue;
        }
        await deps.sendMail(email, mail.subject, mail.text, mail.html);
        result.sent += 1;
      } catch (error) {
        result.failed += 1;
        deps.log(`письмо о готовности (${job.kind} ${job.id}) не отправлено: ${describeError(error)}`);
        await deps.releaseJob(job).catch((releaseErr: unknown) => {
          deps.log(`отметка задачи не снята: ${describeError(releaseErr)}`);
        });
      }
    }
    if (result.sent + result.failed > 0) {
      deps.log(`о готовности: отправлено ${String(result.sent)}, сбоев ${String(result.failed)}`);
    }
  } catch (error) {
    deps.log(`письма о готовности не выполнены: ${describeError(error)}`);
  }
  return result;
}

/** Письмо по задаче или null, если писать не нужно (задача при этом уже отмечена). */
async function composeReadyMail(job: ReadyJob, email: string, deps: NotificationDeps, baseUrl: string): Promise<EmailMessage | null> {
  // Аудит сметы заказчика — не «смета готова».
  if (job.kind === "estimate" && job.mode === "audit") return null;
  // Короткий расчёт человек и так дождался на экране.
  if (job.finishedAt - job.createdAt < READY_MIN_DURATION_MS) return null;
  if (!resolveDigestSettings(await deps.readSettingsByEmail(email)).readyEnabled) return null;

  if (job.kind === "analysis") {
    const tenderId = job.tenderId ?? "";
    const subject = (await deps.readTenderSubject(tenderId)) ?? tenderId;
    const summary = summarizeAnalysis(await deps.readAnalysisRows(tenderId));
    return buildAnalysisReadyEmail({ regNumber: tenderId, subject, ...summary, baseUrl });
  }
  const subject =
    job.subject ?? (job.tenderId === null ? null : await deps.readTenderSubject(job.tenderId)) ?? job.tenderId ?? "Смета";
  return buildEstimateReadyEmail({ subject, totalRub: job.totalRub, tenderId: job.tenderId, jobId: job.id, baseUrl });
}

/* ----------------------------------- Боевые зависимости ----------------------------------- */

/** Боевые зависимости: база, SMTP, окружение процесса. Импорты ленивые — nodemailer нужен только тому, кто шлёт. */
export function defaultNotificationDeps(): NotificationDeps {
  const repo = async () => (await import("@/repositories/notificationRepository")).notificationRepository;
  return {
    env: process.env,
    now: () => Date.now(),
    smtpConfigured: () => {
      const e = process.env;
      return Boolean(e["SMTP_HOST"] && e["SMTP_USER"] && e["SMTP_PASSWORD"]);
    },
    sendMail: async (to, subject, text, html) => {
      const { sendSmtpMail } = await import("@/services/smtpMailer");
      await sendSmtpMail(to, subject, text, { html, logLabel: "Уведомления" });
    },
    log: (message) => console.log(`[notifications] ${message}`),
    listReadyJobs: async (sinceMs) => (await repo()).listReadyJobs(sinceMs),
    listFailedJobs: async (sinceMs) => (await repo()).listFailedJobs(sinceMs),
    claimJob: async (job, nowMs) => (await repo()).claimJob(job, nowMs),
    releaseJob: async (job) => (await repo()).releaseJob(job),
    readSettingsByEmail: async (email) => (await repo()).readSettingsByEmail(email),
    readTenderSubject: async (regNumber) => (await repo()).readTenderSubject(regNumber),
    readAnalysisRows: async (regNumber) => (await repo()).readAnalysisRows(regNumber),
    listUsers: async () => (await repo()).listUsers(),
    findUserByEmail: async (email) => (await repo()).findUserByEmail(email),
    readSettings: async (ids) => (await repo()).readSettings(ids),
    readDigestData: async (ids) => (await repo()).readDigestData(ids),
    loadTenderRows: async (query) => (await repo()).loadTenderRows(query),
    markDigestSent: async (userId, nowMs) => (await repo()).markDigestSent(userId, nowMs),
  };
}

/* ------------------------------- Сбои — администратору ------------------------------- */

export interface FailureAlertResult {
  skipped: boolean;
  sent: number;
  failed: number;
}

/**
 * Письмо администраторам (ADMIN_EMAILS) о каждой упавшей задаче анализа или сметы за последние
 * полчаса. Шлюз `NOTIFY_RECIPIENTS` здесь не ограничивает адресатов — письмо и так только своим;
 * `off` выключает и его. Отметка — `notified_at` задачи: одно письмо на сбой.
 */
export async function runFailureAlerts(deps: NotificationDeps): Promise<FailureAlertResult> {
  const result: FailureAlertResult = { skipped: false, sent: 0, failed: 0 };
  if (!deps.smtpConfigured() || deps.listFailedJobs === undefined) return { ...result, skipped: true };
  if (notifyRecipientsMode(deps.env) === "off") return { ...result, skipped: true };
  const admins = [...parseAdminEmails(deps.env["ADMIN_EMAILS"])];
  if (admins.length === 0) return { ...result, skipped: true };

  try {
    const now = deps.now();
    const jobs = await deps.listFailedJobs(now - READY_WINDOW_MS);
    const baseUrl = appBaseUrl(deps.env);
    for (const job of jobs) {
      if (!(await deps.claimJob(job, now))) continue;
      try {
        const subject = job.tenderId === null ? null : await deps.readTenderSubject(job.tenderId);
        const mail = buildFailureAlertEmail({ ...job, subject, baseUrl });
        for (const admin of admins) await deps.sendMail(admin, mail.subject, mail.text, mail.html);
        result.sent += 1;
      } catch (error) {
        await deps.releaseJob(job);
        result.failed += 1;
        deps.log(`письмо о сбое ${job.kind} ${job.id} не отправлено: ${describeError(error)}`);
      }
    }
    if (result.sent + result.failed > 0) {
      deps.log(`сбои: писем администраторам ${String(result.sent)}, ошибок отправки ${String(result.failed)}`);
    }
  } catch (error) {
    deps.log(`проверка сбоев не выполнена: ${describeError(error)}`);
  }
  return result;
}
