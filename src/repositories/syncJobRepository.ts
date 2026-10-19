import { getSupabaseServerClient } from "@/lib/supabase";
import { HISTORY_ERROR_CHARS, type EstimateHistoryItem, type EstimateHistoryStatus } from "@/domain/estimate/estimateHistory";
import type {
  SyncJobKind,
  SyncJobPayload,
  SyncJobReport,
  SyncJobRow,
  SyncJobStatus,
  WorkerHeartbeatRow,
  WorkerStatus,
} from "@/types/database";

/** Что считает задание `estimate`: смету по ведомости или аудит сметы заказчика. */
export type EstimateMode = "estimate" | "audit";

interface ModeFilterable {
  eq(column: string, value: string): unknown;
  or(filters: string): unknown;
}

/**
 * Отбор заданий `estimate` по режиму. Аудит не должен подменять результат сметы и
 * наоборот: оба режима хранятся одним видом задания (миграции ради нового вида не
 * хотим), и различает их только `payload.mode`. Задания без поля — это расчёт
 * сметы: так их ставили до появления аудита.
 */
function withMode<Q extends ModeFilterable>(query: Q, mode: EstimateMode): Q {
  return (
    mode === "audit"
      ? query.eq("payload->>mode", "audit")
      : query.or("payload->>mode.is.null,payload->>mode.eq.estimate")
  ) as Q;
}

interface OwnerFilterable {
  eq(column: string, value: string): unknown;
}

/** Отбор заданий одного владельца (`requested_by`). `null` — без отбора: служебный код, не от имени человека. */
function withOwner<Q extends OwnerFilterable>(query: Q, requestedBy: string | null): Q {
  return (requestedBy === null ? query : query.eq("requested_by", requestedBy)) as Q;
}

/**
 * Колонки и JSON-пути списка «Мои расчёты». Только лёгкое: `payload` и `report` целиком не
 * читаются (тексты файлов и смета на мегабайты), а берутся отдельные поля через `->>` и `->`.
 * Итог — тот же путь, что у письма «смета готова» (`notificationRepository.listReadyJobs`).
 *
 * Оговорка по нагрузке: проекция JSON-поля экономит трафик, но не работу базы — Postgres
 * вынимает `payload` и `report` строки целиком, чтобы достать из них поле. Поэтому страница
 * небольшая (20 строк), а выборка идёт по индексу (`requested_by`, `created_at`).
 */
const HISTORY_SELECT = [
  "id",
  "status",
  "created_at",
  "finished_at",
  "error",
  "subject:payload->>subject",
  "tender_id:payload->>tenderId",
  "mode:payload->>mode",
  "reason:payload->>reason",
  "document_names:payload->documentNames",
  // Имя первого файла — для заданий до 20.10.2026, когда documentNames ещё не писали: иначе
  // старые расчёты по файлам в списке неотличимы («Расчёт по документации»). Путь по индексу
  // PostgREST принимает (проверено на проде 20.10.2026), текст документа не выбирается.
  "first_document:payload->documents->0->>name",
  "total:report->estimate->document->totals->>total",
].join(", ");

interface HistoryDbRow {
  id: string;
  status: EstimateHistoryStatus;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  subject: string | null;
  tender_id: string | null;
  mode: string | null;
  reason: string | null;
  document_names: unknown;
  first_document?: string | null;
  total: unknown;
}

function toHistoryItem(row: HistoryDbRow): EstimateHistoryItem {
  const listed = Array.isArray(row.document_names)
    ? row.document_names.filter((name): name is string => typeof name === "string")
    : null;
  const first = typeof row.first_document === "string" && row.first_document.trim() !== "" ? row.first_document.trim() : null;
  const names = listed !== null && listed.length > 0 ? listed : first !== null ? [first] : listed;
  // PostgREST отдаёт число по пути `->>` строкой; нет суммы или не число — null.
  const total = typeof row.total === "string" ? Number(row.total) : row.total;
  const error = typeof row.error === "string" && row.error.trim() !== "" ? row.error.trim().slice(0, HISTORY_ERROR_CHARS) : null;
  const tenderId = row.tender_id !== null && row.tender_id !== "" ? row.tender_id : null;
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    mode: row.mode === "audit" ? "audit" : "estimate",
    // Задания без `reason` — поставленные по закупке (так их ставили, пока не было экрана «Смета»).
    reason: row.reason === "upload" ? "upload" : "tender",
    tenderId,
    subject: row.subject,
    documentNames: names,
    totalRub: typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null,
    error,
  };
}

/**
 * Отбор заданий для одной дорожки воркера: вид и, для `full_sync`, живой поиск.
 *
 * `live`: true — только задания с запросом в `payload.liveQuery` (живой поиск),
 * false — только без него (кнопка «Найти новые закупки»), не задан — любые.
 * Живым считается задание, у которого `payload->>liveQuery` не NULL: так же его
 * находит `findActiveLive`. Для видов, кроме `full_sync`, `live` не имеет смысла
 * и не применяется.
 */
export interface PendingFilter {
  kind: SyncJobKind;
  live?: boolean;
}

interface PendingFilterable {
  eq(column: string, value: string): unknown;
  is(column: string, value: null): unknown;
  not(column: string, operator: string, value: unknown): unknown;
}

/** Накладывает отбор дорожки на запрос к sync_jobs. Без отбора запрос не меняется. */
export function withPendingFilter<Q extends PendingFilterable>(query: Q, filter?: PendingFilter): Q {
  if (!filter) return query;
  let result = query.eq("kind", filter.kind) as Q;
  if (filter.kind === "full_sync" && filter.live !== undefined) {
    result = (
      filter.live
        ? result.not("payload->>liveQuery", "is", null)
        : result.is("payload->>liveQuery", null)
    ) as Q;
  }
  return result;
}

/** Сколько заданий ждёт на каждой дорожке воркера (см. `countPendingByLane`). */
export interface PendingByLane {
  /** Загрузка документации. */
  documents: number;
  /** Расчёт и аудит сметы. */
  estimate: number;
  /** `full_sync` без запроса: «Найти новые закупки», идёт в дорожке обхода. */
  sync: number;
  /** `full_sync` с запросом: живой поиск. */
  live: number;
}

/** Сколько раз задание возвращается в очередь после сбоя. */
export const SYNC_JOB_MAX_ATTEMPTS = 3;

/**
 * Очередь заданий воркеру с российским IP и его пульс.
 *
 * Прод на Vercel ставит задания, воркер на сервере в России забирает: файл
 * документации ЕИС зарубежному адресу не отдаётся, поэтому тяжёлая часть
 * конвейера живёт там, где выход из российского сегмента. Таблица общая —
 * Supabase в Стокгольме доступен и оттуда, и оттуда.
 */
export const syncJobRepository = {
  async create(
    kind: SyncJobKind,
    payload: SyncJobPayload = {},
    requestedBy: string | null = null,
  ): Promise<SyncJobRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .insert({ kind, payload, requested_by: requestedBy })
      .select()
      .single();

    if (error) throw error;
    return data as SyncJobRow;
  },

  async findById(id: string): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /**
   * Смета по закупке, которая уже считается.
   *
   * Нужна, чтобы повторное нажатие кнопки не ставило второе задание: расчёт
   * стоит минут работы модели, и платить за один ответ дважды незачем.
   *
   * `requestedBy` — чьё задание искать (почта или метка «ui»), обязательный: чужой
   * идущий расчёт по той же закупке не должен «склеиваться» с нажатием другого человека
   * — тот получил бы чужой результат и не получил бы своего. `null` — любое (только
   * для служебного кода, который не от имени человека).
   */
  async findActiveEstimate(
    tenderId: string,
    mode: EstimateMode,
    requestedBy: string | null,
  ): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await withOwner(
      withMode(
        supabase.from("sync_jobs").select("*").eq("kind", "estimate").eq("payload->>tenderId", tenderId),
        mode,
      ),
      requestedBy,
    )
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /**
   * Задание живого поиска, которое сейчас выполняется или ждёт.
   *
   * Живой поиск — это `full_sync` с запросом в payload: отдельного вида задания
   * нет, потому что список видов закреплён ограничением в базе.
   */
  async findActiveLive(): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .eq("kind", "full_sync")
      .not("payload->>liveQuery", "is", null)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /** Последнее выполненное задание живого поиска по этому запросу. */
  async findRecentLive(query: string): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .eq("kind", "full_sync")
      .eq("payload->>liveQuery", query)
      .eq("status", "completed")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /**
   * Последняя смета по закупке, в любом состоянии.
   *
   * По ней открытая заново карточка показывает уже посчитанное, а не
   * предлагает считать второй раз. `requestedBy` — чья смета (см. `findActiveEstimate`):
   * у каждого на карточке закупки свой результат, чужой не подставляется.
   */
  async findLatestEstimate(
    tenderId: string,
    mode: EstimateMode,
    requestedBy: string | null,
  ): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await withOwner(
      withMode(
        supabase.from("sync_jobs").select("*").eq("kind", "estimate").eq("payload->>tenderId", tenderId),
        mode,
      ),
      requestedBy,
    )
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /**
   * Расчёты сметы одного человека, от нового к старому (список «Мои расчёты»).
   *
   * Страницы по ключу `created_at`, а не по смещению: пока человек листает, наверх приходят новые
   * расчёты, и смещение показало бы одну и ту же строку дважды. `before` — `created_at` последней
   * строки предыдущей страницы как строка из базы (с микросекундами). Читает `limit` строк;
   * вызывающий просит на одну больше, чтобы узнать, есть ли следующая страница.
   */
  async listEstimateHistory(
    requestedBy: string,
    options: { limit: number; before?: string | null },
  ): Promise<EstimateHistoryItem[]> {
    const supabase = getSupabaseServerClient();
    let query = supabase
      .from("sync_jobs")
      .select(HISTORY_SELECT)
      .eq("kind", "estimate")
      .eq("requested_by", requestedBy);
    if (options.before !== undefined && options.before !== null) query = query.lt("created_at", options.before);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(options.limit);

    if (error) throw error;
    return ((data ?? []) as unknown as HistoryDbRow[]).map(toHistoryItem);
  },

  /** Последние задания — для журнала на панели. */
  async findRecent(limit = 10): Promise<SyncJobRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data ?? []) as SyncJobRow[];
  },

  /**
   * Забирает одно задание и переводит его в processing.
   *
   * Захват условный — обновление проходит, только если строка всё ещё pending,
   * поэтому два воркера не возьмут одно задание. Тот же приём, что в
   * `analysisJobRepository.claimNextPending`: RPC-функция в базе не заведена
   * намеренно, чтобы миграция оставалась таблицами, а не кодом на plpgsql.
   *
   * `null` при пустой очереди — нормальный исход, а не ошибка: воркер
   * сообщает «делать нечего» и уходит до следующего тика.
   */
  async claimNextPending(
    workerId: string,
    now: string,
    filter?: PendingFilter,
  ): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();

    /*
      Отбор по виду нужен параллельному воркеру: у каждой дорожки своя очередь, и
      самое старое задание «вообще» могло бы оказаться чужим — расчёт сметы,
      вытянутый дорожкой документации, держал бы её, пока не закончится. Без
      `filter` запрос прежний: самое старое задание любого вида.
    */
    const { data: candidate, error: fetchError } = await withPendingFilter(
      supabase.from("sync_jobs").select("*").eq("status", "pending"),
      filter,
    )
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!candidate) return null;

    const { id, attempts } = candidate as SyncJobRow;
    const { data: claimed, error: claimError } = await supabase
      .from("sync_jobs")
      .update({
        status: "processing" satisfies SyncJobStatus,
        worker_id: workerId,
        claimed_at: now,
        attempts: (attempts ?? 0) + 1,
      })
      .eq("id", id)
      .eq("status", "pending")
      .select();

    if (claimError) throw claimError;
    return ((claimed ?? []) as SyncJobRow[])[0] ?? null;
  },

  /** Задание выполнено: отчёт пишется целиком, а не прибавляется к прежнему. */
  async complete(id: string, report: SyncJobReport): Promise<void> {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase
      .from("sync_jobs")
      .update({
        status: "completed",
        report,
        // Причина прошлой попытки стирается: задание могло упасть, а со второй
        // пройти, и «completed» с текстом старой ошибки читался бы как провал.
        error: null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  },

  /**
   * Задание не выполнено.
   *
   * Возврат в очередь ограничен `SYNC_JOB_MAX_ATTEMPTS`: ЕИС отвечает не всегда
   * (фильтр адресов, технические окна), и бесконечные повторения одного и того
   * же падающего задания съели бы всё время воркера, а партнёр видел бы
   * «в очереди» без объяснения. После предела задание остаётся failed с текстом
   * причины — его видно на панели и в журнале.
   */
  async fail(
    id: string,
    error: string,
    attempts: number,
  ): Promise<SyncJobStatus> {
    const supabase = getSupabaseServerClient();
    const retry = attempts < SYNC_JOB_MAX_ATTEMPTS;
    const status: SyncJobStatus = retry ? "pending" : "failed";
    const update: Record<string, unknown> = { status, error };
    if (!retry) update["finished_at"] = new Date().toISOString();

    const { error: dbError } = await supabase
      .from("sync_jobs")
      .update(update)
      .eq("id", id);

    if (dbError) throw dbError;
    return status;
  },

  /**
   * Возвращает в очередь задания, зависшие в processing.
   *
   * Сервер перезагружается и systemd обрывает процесс на середине: без этой
   * очистки задание осталось бы «выполняется» навсегда, а панель показывала бы
   * работу, которой нет.
   *
   * Порог по умолчанию здесь мягче рабочего: воркер передаёт
   * `STALE_JOB_AFTER_MIN` из домена, который обязан быть выше внутреннего
   * бюджета скачивания (25 минут). Иначе живой прогон перехватывался бы вторым
   * воркером, и одни и те же вложения качались дважды.
   *
   * `excludeIds` — задания, которые этот воркер выполняет прямо сейчас. Пока воркер
   * делал одно дело за раз, очистка шла между делами и своего задания видеть не
   * могла. Параллельный воркер чистит очередь, пока дорожки заняты: плановый обход
   * или расчёт сметы живут дольше порога (прогон до 22 минут, смета до 11, порог
   * 45, но порог настраивается), и без исключения собственное задание вернулось бы
   * в очередь и выполнилось бы дважды.
   */
  async resetStaleJobs(
    staleMinutes = 30,
    now = Date.now(),
    excludeIds: Iterable<string> = [],
  ): Promise<number> {
    const supabase = getSupabaseServerClient();
    const cutoff = new Date(now - staleMinutes * 60 * 1000).toISOString();
    const own = new Set(excludeIds);

    const { data, error } = await supabase
      .from("sync_jobs")
      .select("id, claimed_at")
      .eq("status", "processing");

    if (error) throw error;

    const stale = (
      (data ?? []) as Pick<SyncJobRow, "id" | "claimed_at">[]
    ).filter((job) => {
      return job.claimed_at !== null && job.claimed_at < cutoff && !own.has(job.id);
    });

    for (const job of stale) {
      // Статус проверяется ещё раз: между выборкой и записью задание могло
      // завершиться, и возврат в очередь выполненного заставил бы его повторить.
      await supabase
        .from("sync_jobs")
        .update({ status: "pending", worker_id: null })
        .eq("id", job.id)
        .eq("status", "processing");
    }

    return stale.length;
  },

  async countPending(): Promise<number> {
    const supabase = getSupabaseServerClient();
    const { count, error } = await supabase
      .from("sync_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");

    if (error) throw error;
    return count ?? 0;
  },

  /**
   * Сколько заданий ждёт на каждой дорожке воркера.
   *
   * Одним лёгким запросом по виду (payload не читается: у сметы там тексты
   * документов), плюс вторым — только когда есть `full_sync`, чтобы отделить
   * живой поиск от «Найти новые закупки».
   */
  async countPendingByLane(): Promise<PendingByLane> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("kind")
      .eq("status", "pending")
      .limit(1000);

    if (error) throw error;

    const kinds = (data ?? []) as Pick<SyncJobRow, "kind">[];
    const count = (kind: SyncJobKind): number => kinds.filter((row) => row.kind === kind).length;
    const fullSync = count("full_sync");

    let live = 0;
    if (fullSync > 0) {
      const { count: liveCount, error: liveError } = await supabase
        .from("sync_jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .eq("kind", "full_sync")
        .not("payload->>liveQuery", "is", null);
      if (liveError) throw liveError;
      live = Math.min(liveCount ?? 0, fullSync);
    }

    return { documents: count("documents"), estimate: count("estimate"), sync: fullSync - live, live };
  },

  /**
   * Отметка «воркер жив» и его выход в сеть.
   *
   * Пишется на каждом тике, даже когда делать нечего: молчание воркера — это
   * сигнал, а не отсутствие новостей. Адрес выхода сохраняется отдельно, потому
   * что ЕИС пускает только российские IP, и смена адреса объясняет все
   * последующие сбои загрузки документации.
   */
  async beat(
    workerId: string,
    fields: {
      lastSeenAt: string;
      host?: string | null;
      version?: string | null;
      exitIp?: string | null;
      exitCountry?: string | null;
      lastFullSyncAt?: string | null;
      lastJobId?: string | null;
      lastError?: string | null;
    },
  ): Promise<void> {
    const supabase = getSupabaseServerClient();
    const row: Record<string, unknown> = {
      worker_id: workerId,
      last_seen_at: fields.lastSeenAt,
    };
    // Неизвестное значение не затирает прежнее: адрес выхода определяется не на
    // каждом тике, и null вместо «95.167.245.92» выглядел бы как потеря выхода.
    if (fields.host !== undefined) row["host"] = fields.host;
    if (fields.version !== undefined) row["version"] = fields.version;
    if (fields.exitIp !== undefined && fields.exitIp !== null)
      row["exit_ip"] = fields.exitIp;
    if (fields.exitCountry !== undefined && fields.exitCountry !== null) {
      row["exit_country"] = fields.exitCountry;
    }
    if (fields.lastFullSyncAt !== undefined)
      row["last_full_sync_at"] = fields.lastFullSyncAt;
    if (fields.lastJobId !== undefined) row["last_job_id"] = fields.lastJobId;
    if (fields.lastError !== undefined) row["last_error"] = fields.lastError;

    const { error } = await supabase.from("worker_heartbeat").upsert(row, {
      onConflict: "worker_id",
    });

    if (error) throw error;
  },

  async readHeartbeat(workerId: string): Promise<WorkerHeartbeatRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("worker_heartbeat")
      .select("*")
      .eq("worker_id", workerId)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as WorkerHeartbeatRow | null) ?? null;
  },

  /** Сводка для панели: пульс, последнее задание и длина очереди. */
  async status(workerId: string): Promise<WorkerStatus> {
    const [heartbeat, recent, pending] = await Promise.all([
      this.readHeartbeat(workerId),
      this.findRecent(1),
      this.countPending(),
    ]);
    return { heartbeat, lastJob: recent[0] ?? null, pending };
  },
};
