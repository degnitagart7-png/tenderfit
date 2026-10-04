import type { KonturCardStatus } from "@/domain/konturCardRequest";
import type {
  AnalysisJobRow,
  DocumentAnalysisRow,
  DocumentMeta,
  VerdictHistoryRow,
} from "@/types/database";

/**
 * Клиентская часть глубокого анализа документации.
 *
 * Разбор идёт в два этапа и на разных машинах: документацию скачивает воркер на
 * сервере в России (ЕИС не отвечает зарубежным IP), а сам разбор выполняет воркер
 * на Vercel — только он держит ключ шлюза модели. Браузер здесь ставит задачи
 * в очередь и показывает результат: ключей и прямых обращений к ЕИС тут нет.
 */

/** Ответ GET /api/analysis/status: строки БД, поля не переименованы. */
export interface DeepAnalysisStatus {
  jobs: AnalysisJobRow[];
  verdictHistory: VerdictHistoryRow[];
  documents: DocumentMeta[];
  documentAnalyses: DocumentAnalysisRow[];
  /**
   * Сколько разборов поставлено сегодня по Москве и сколько ещё можно.
   * Считается тем же счётчиком, что и отказ 429 в POST /api/analysis/trigger,
   * но без создания задачи: чтение состояния лимит не расходует.
   */
  quota?: { usedToday: number; remaining: number; limit: number };
}

/** Закупка с законченным разбором: что отдаёт GET /api/analysis/completed. */
export interface CompletedAnalysis {
  tenderId: string;
  /** Когда разбор закончился; null — задание завершилось без отметки времени. */
  finishedAt: string | null;
}

export interface TriggerResponse {
  job: AnalysisJobRow;
  /** true — задача уже была в очереди или в работе, новая не создавалась. */
  deduped: boolean;
  /** Остаток суточного лимита после этого вызова; при отказе — до него. */
  quota?: { usedToday: number; remaining: number };
}

export interface TriggerOptions {
  priority?: number;
  jobType?: "full_analysis" | "reanalyze" | "parse_only";
}

/**
 * Состояние блока платной карточки Контур.Закупок.
 *
 * Форма объявлена в домене и переэкспортируется здесь, чтобы панель и роут
 * читали одно описание ответа, а не два независимых.
 */
export type { KonturCardStatus };

/**
 * Успешная покупка карточки — единственный исход, который приходит значением.
 *
 * Отказы (исчерпан бюджет карточек, кончился суточный лимит разборов, ключ не
 * задан) роут отдаёт кодами 409/429/503 с готовой фразой, поэтому здесь они
 * становятся исключением: панель показывает текст сервера как есть и не
 * выдумывает причину. Поле `regNumber` из ответа не повторяем — номер известен
 * вызывающей стороне.
 */
export interface KonturCardQueued {
  status: "queued";
  /** Задание на документацию в очереди воркера на сервере в России. */
  jobId: string;
  /** Задача разбора; null — записать не удалось, её создаст воркер. */
  analysisJobId: string | null;
  /** Равное платное задание уже стояло: второе не создавалось и не тратилось. */
  deduped: boolean;
  /** Подпись расхода карточек после покупки. */
  budgetNote: string;
  /** Что пошло не так, но покупку не отменило. */
  warning: string | null;
}

/**
 * Источники, документацию по которым умеет доставать scripts/fetch-tender-documents.ts,
 * и причины недоступности описаны в @/domain/deepAnalysis — там же чистая функция
 * deepAnalysisBlocker, которую использует и панель на карточке закупки.
 */

async function parseError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error || `${fallback}: ${res.status}`);
}

export const deepAnalysisService = {
  /** Ставит закупку в очередь глубокого анализа. */
  async trigger(tenderId: string, options: TriggerOptions = {}): Promise<TriggerResponse> {
    const res = await fetch("/api/analysis/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenderId,
        priority: options.priority,
        jobType: options.jobType,
      }),
    });

    if (!res.ok) await parseError(res, "Не удалось поставить закупку в очередь анализа");
    return (await res.json()) as TriggerResponse;
  },

  /**
   * Закупки, по которым разбор закончен: один запрос на весь экран.
   *
   * Нужен «Сегодня» и списку закупок. Карточки по ним не запрашиваются — эти
   * экраны уже показывают ту же выдачу и знают про закупку всё остальное.
   */
  async getCompleted(): Promise<CompletedAnalysis[]> {
    const res = await fetch("/api/analysis/completed");
    if (!res.ok) await parseError(res, "Не удалось прочитать список готовых разборов");
    const body = (await res.json()) as { completed: CompletedAnalysis[] };
    return body.completed;
  },

  /** Состояние анализа: задачи, документы, найденные факторы, история вердиктов. */
  async getStatus(tenderId: string): Promise<DeepAnalysisStatus> {
    const res = await fetch(
      `/api/analysis/status?tenderId=${encodeURIComponent(tenderId)}`,
    );

    if (!res.ok) await parseError(res, "Не удалось получить состояние анализа");
    return (await res.json()) as DeepAnalysisStatus;
  },

  /**
   * Нужна ли закупке платная карточка Контур.Закупок и можно ли её купить сейчас.
   *
   * Чтение бесплатное: сервер смотрит только свои таблицы, ни одного запроса к
   * источнику. null — закупки с таким номером в базе нет, и блоку нечего
   * объяснять; превращать это в ошибку значило бы пугать партнёра там, где
   * платить просто не за что.
   */
  async getKonturCard(regNumber: string): Promise<KonturCardStatus | null> {
    const res = await fetch(
      `/api/analysis/kontur-card?regNumber=${encodeURIComponent(regNumber)}`,
    );

    if (res.status === 404) return null;
    if (!res.ok) await parseError(res, "Не удалось прочитать состояние платной карточки");
    return (await res.json()) as KonturCardStatus;
  },

  /**
   * Покупает карточку: один платный запрос источника и очередь на разбор.
   *
   * Вызов расходует деньги, поэтому панель зовёт его только после явного
   * подтверждения, а не по первому нажатию.
   */
  async buyKonturCard(regNumber: string): Promise<KonturCardQueued> {
    const res = await fetch("/api/analysis/kontur-card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regNumber }),
    });

    if (!res.ok) await parseError(res, "Не удалось купить карточку Контур.Закупок");
    return (await res.json()) as KonturCardQueued;
  },
};
