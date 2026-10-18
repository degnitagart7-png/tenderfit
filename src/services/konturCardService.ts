import { hasKonturApiKey, resolveKonturContract } from "@/adapters/tender-source/konturContract";
import { analysisQuota, moscowDayStart } from "@/domain/analysisQuota";
import {
  konturCardBudgetNote,
  konturCardOffer,
  type KonturCardRefusal,
  type KonturCardStatus,
} from "@/domain/konturCardRequest";
import { describeError } from "@/lib/errors";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { documentRepository } from "@/repositories/documentRepository";
import { konturCacheRepository } from "@/repositories/konturCacheRepository";
import { tenderRepository } from "@/repositories/tenderRepository";
import { enqueueSyncJob } from "@/services/syncJobService";
import { DEFAULT_DAILY_LIMIT as KONTUR_DEFAULT_DAILY_LIMIT } from "@/services/konturSyncService";
import type { AnalysisJobRow, TenderRow } from "@/types/database";

/**
 * Явная покупка карточки Контур.Закупок для одной закупки.
 *
 * Зачем это нужно. Часть закупок Контур.Закупок размещена только на электронной
 * площадке, а не в ЕИС: для закона COMMERCIAL ЕИС не публикует вкладку
 * документов вовсе. Единственный источник документации у них — карточка
 * источника, а это платный запрос группы `purchase` (30 в сутки на боевом
 * тарифе). Плановый прогон карточки не открывает намеренно: он идёт по десяткам
 * закупок и сжёг бы бюджет за один тик. Поэтому покупка возможна только одним
 * способом — нажатием кнопки в карточке конкретной закупки.
 *
 * Живой случай: RH24092600035 (АО «ДГК»). Задача разбора стояла в очереди с
 * 16:59 МСК 25.09.2026, прогон в 17:12 МСК сообщил, что документов в ЕИС нет, и
 * задача осталась «pending» навсегда, а панель обещала догрузку плановой
 * синхронизацией.
 *
 * Что происходит по кнопке:
 *   1. проверка права и двух бюджетов — платных карточек и суточного лимита
 *      разборов (правила в @/domain/konturCardRequest, покрыты тестами);
 *   2. задание на документацию с флагом `konturCards` в очередь воркеру на
 *      сервере в России: скачивать файлы можно только с российского IP;
 *   3. задача глубокого разбора — без неё документация легла бы в базу и ждала
 *      планового прогона до двух часов, то есть плата не дала бы результата.
 *
 * Контур.Закупки отсюда не вызываются: платный запрос делает воркер, а этот
 * модуль читает только свою базу. Поэтому проверка бюджета — страховка, а не
 * контракт: между нажатием и запросом проходит до минуты.
 */

/** Метка платного задания в очереди: по ней журнал отличает покупку от кнопки поиска. */
const CARD_JOB_REASON = "kontur-card";

/**
 * Приоритет задачи разбора.
 *
 * Тот же, что у явного запуска загрузки документации рукой
 * (scripts/fetch-tender-documents.ts): оплаченная закупка важнее фонового
 * накопления очереди, но не важнее повторного ручного запуска.
 */
const ANALYSIS_JOB_PRIORITY = 10;

/**
 * Состояние блока платной карточки — ответ GET /api/analysis/kontur-card.
 * Сама форма объявлена в @/domain/konturCardRequest: её же читает панель в
 * браузере, а два описания одного ответа разошлись бы молча.
 */
export type { KonturCardStatus };

export type KonturCardPurchase =
  | {
      status: "queued";
      regNumber: string;
      /** Идентификатор задания на документацию в очереди воркера. */
      jobId: string;
      /** Задача разбора; null — создать не удалось, её создаст воркер. */
      analysisJobId: string | null;
      /** Равное платное задание уже стояло: новое не создавалось. */
      deduped: boolean;
      budgetNote: string;
      /** Что пошло не так, но покупку не отменило. */
      warning: string | null;
    }
  | {
      status: "refused";
      regNumber: string;
      reason: string;
      refusalKind: KonturCardRefusal;
      budgetNote: string;
    }
  /** Закупки нет в базе: отвечать отказом с выдуманной причиной было бы враньём. */
  | { status: "not_found"; regNumber: string };

/**
 * Предел платных карточек в сутки; null — предел выключен настройкой.
 *
 * Значение по умолчанию — то же, что у синхронизации и панели расхода: боевой
 * тариф даёт 30 запросов группы `purchase` в сутки (зонд 24.09.2026).
 */
function cardDailyLimit(): number | null {
  const raw = process.env["KONTUR_DAILY_REQUEST_LIMIT"]?.trim();
  const parsed = raw === undefined || raw === "" ? KONTUR_DEFAULT_DAILY_LIMIT : Number.parseFloat(raw);
  const limit = Number.isFinite(parsed) ? parsed : KONTUR_DEFAULT_DAILY_LIMIT;
  return limit > 0 ? limit : null;
}

/** Всё, что нужно и для чтения состояния, и для покупки: собирается один раз. */
interface CardContext {
  limit: number | null;
  spentToday: number;
  budgetNote: string;
  offer: ReturnType<typeof konturCardOffer>;
  /** Задача разбора, которая уже стоит в очереди или в работе. */
  activeJob: AnalysisJobRow | null;
  /** Свободных разборов сегодня; null — задача на эту закупку уже есть. */
  analysisRemaining: number | null;
}

async function gather(regNumber: string, tender: TenderRow): Promise<CardContext> {
  const limit = cardDailyLimit();
  const now = new Date().toISOString();

  const [documents, spent, jobs] = await Promise.all([
    documentRepository.findByTenderId(regNumber),
    konturCacheRepository.billableCallsToday(now),
    analysisJobRepository.findByTenderId(regNumber),
  ]);

  const activeJob =
    jobs.find((job) => job.status === "pending" || job.status === "processing") ?? null;

  /*
    Свободный слот лимита разборов нужен только тогда, когда задачи на эту
    закупку ещё нет: стоящая в очереди задача подберёт текст без нового расхода.
    Без этого исключения закупку, переведённую в «Интересное» утром, нельзя было
    бы докупить вечером — после того как дневные 20 разборов уже поставлены.
  */
  let analysisRemaining: number | null = null;
  if (activeJob === null) {
    const usedToday = await analysisJobRepository.countCreatedSince(
      moscowDayStart(new Date()).toISOString(),
    );
    analysisRemaining = analysisQuota(usedToday).remaining;
  }

  return {
    limit,
    spentToday: spent.card,
    budgetNote: konturCardBudgetNote(spent.card, limit),
    activeJob,
    analysisRemaining,
    offer: konturCardOffer({
      configured: hasKonturApiKey(resolveKonturContract()),
      dataSource: tender.data_source,
      law: tender.law,
      externalId: tender.external_id,
      documentsCount: documents.length,
      cardRemaining: limit === null ? null : Math.max(0, limit - spent.card),
      analysisRemaining,
    }),
  };
}

/**
 * Состояние блока платной карточки для панели глубокого анализа.
 *
 * null — закупки с таким номером в базе нет. Чтение бесплатно: ни одного
 * запроса к Контур.Закупкам, только свои таблицы.
 */
export async function readKonturCardStatus(regNumber: string): Promise<KonturCardStatus | null> {
  const tender = await tenderRepository.findByRegNumber(regNumber);
  if (!tender) return null;

  const context = await gather(regNumber, tender);
  return {
    regNumber,
    show: context.offer.show,
    allowed: context.offer.allowed,
    reason: context.offer.reason,
    refusalKind: context.offer.refusalKind,
    budgetNote: context.budgetNote,
    cardSpentToday: context.spentToday,
    cardLimit: context.limit,
    analysisRemaining: context.analysisRemaining,
  };
}

/**
 * Покупает карточку: ставит задание на документацию и задачу разбора.
 *
 * Порядок намеренный. Сначала задание в очередь — именно оно приведёт к платному
 * запросу; если очередь не пишет (миграция не применена, база недоступна),
 * ошибка уходит роуту и тот отвечает 503, а карточка остаётся некупленной и
 * задача разбора не создана. Наоборот — сначала задача разбора — означал бы, что
 * при сбое очереди воркер разобрал бы закупку без документов и закрыл задачу как
 * «анализировать было нечего».
 *
 * Сбой создания задачи разбора покупку не отменяет: задание уже стоит, и воркер
 * создаст задачу сам, когда документация появится. Ответ в этом случае несёт
 * `warning`, чтобы панель не обещала того, что не записано.
 */
export async function buyKonturCard(regNumber: string): Promise<KonturCardPurchase> {
  const tender = await tenderRepository.findByRegNumber(regNumber);
  if (!tender) return { status: "not_found", regNumber };

  const context = await gather(regNumber, tender);
  if (!context.offer.allowed) {
    return {
      status: "refused",
      regNumber,
      reason: context.offer.reason ?? "Карточку Контур.Закупок для этой закупки купить нельзя.",
      refusalKind: context.offer.refusalKind ?? "tender",
      budgetNote: context.budgetNote,
    };
  }

  const { job, deduped } = await enqueueSyncJob({
    kind: "documents",
    regNumbers: [regNumber],
    reason: CARD_JOB_REASON,
    konturCards: true,
  });

  const queued = {
    status: "queued" as const,
    regNumber,
    jobId: job.id,
    deduped,
    budgetNote: context.budgetNote,
  };

  if (context.activeJob) {
    return { ...queued, analysisJobId: context.activeJob.id, warning: null };
  }

  try {
    const created = await analysisJobRepository.create(
      regNumber,
      "full_analysis",
      ANALYSIS_JOB_PRIORITY,
    );
    return { ...queued, analysisJobId: created.id, warning: null };
  } catch (error) {
    return {
      ...queued,
      analysisJobId: null,
      warning:
        "Задание на документацию поставлено, но задачу разбора записать не удалось " +
        `(${describeError(error)}). Воркер создаст её сам, когда документация появится.`,
    };
  }
}
