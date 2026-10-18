import { describe, it, expect } from "vitest";
import {
  DEFAULT_SYNC_BASE_URL,
  DEFAULT_SYNC_INTERVAL_HOURS,
  ANALYSIS_RETRY_MIN,
  DEFAULT_TICK_SECONDS,
  shouldDrainAnalysisQueue,
  FULL_SYNC_OVERDUE_FACTOR,
  MIN_TICK_SECONDS,
  STALE_JOB_AFTER_MIN,
  minutesSinceFullSync,
  planTick,
  planLanes,
  planScheduledSync,
  workerEisRate,
  PARALLEL_EIS_RATE,
  resolveWorkerConfig,
  type LaneId,
  type LanePending,
  type LaneStart,
  type LaneState,
  type TickState,
} from "./workerSchedule";
import type { WorkerHeartbeatRow } from "@/types/database";

const NOW = "2026-09-25T04:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function heartbeat(overrides: Partial<WorkerHeartbeatRow> = {}): WorkerHeartbeatRow {
  return {
    worker_id: "ru-vps",
    last_seen_at: "2026-09-25T03:59:00.000Z",
    last_full_sync_at: "2026-09-25T02:00:00.000Z",
    exit_ip: "176.97.134.221",
    exit_country: "RU",
    host: "vps-1",
    version: "2026-09-25",
    last_job_id: null,
    last_error: null,
    created_at: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

/** Пульс, у которого полный прогон был N минут назад. */
function stateFullSyncMinutesAgo(minutes: number, pending = 0): TickState {
  return {
    heartbeat: heartbeat({
      last_full_sync_at: new Date(NOW_MS - minutes * 60000).toISOString(),
    }),
    pending,
  };
}

const CONFIG = { intervalHours: DEFAULT_SYNC_INTERVAL_HOURS, fullSyncEnabled: true };

describe("resolveWorkerConfig", () => {
  it("значения по умолчанию совпадают с прежним расписанием Windows", () => {
    const config = resolveWorkerConfig({});

    expect(config.workerId).toBe("ru-vps");
    expect(config.intervalHours).toBe(2);
    expect(config.tickMs).toBe(DEFAULT_TICK_SECONDS * 1000);
    expect(config.fullSyncEnabled).toBe(true);
    expect(config.baseUrl).toBe(DEFAULT_SYNC_BASE_URL);
    expect(config.staleJobAfterMin).toBe(STALE_JOB_AFTER_MIN);
    // Дорожки включены по умолчанию.
    expect(config.parallel).toBe(true);
  });

  it("WORKER_PARALLEL=0 (и другие «нет») возвращает последовательный воркер, мусор — нет", () => {
    for (const raw of ["0", "false", "off", "no", " OFF "]) {
      expect(resolveWorkerConfig({ WORKER_PARALLEL: raw }).parallel, raw).toBe(false);
    }
    for (const raw of ["1", "true", "", "abc"]) {
      expect(resolveWorkerConfig({ WORKER_PARALLEL: raw }).parallel, raw).toBe(true);
    }
  });

  it("порог потерянного задания выше внутреннего бюджета скачивания", () => {
    // FETCH_BUDGET_MS в scripts/fetch-tender-documents.ts равен 25 минутам.
    // Порог ниже означал бы, что живой прогон перехватывает второй воркер
    // и те же вложения качаются дважды.
    expect(STALE_JOB_AFTER_MIN).toBeGreaterThan(25);
  });

  it("переменные окружения переопределяют значения по умолчанию", () => {
    const config = resolveWorkerConfig({
      SYNC_WORKER_ID: "home-pc",
      SYNC_INTERVAL_HOURS: "6",
      SYNC_TICK_SECONDS: "30",
      SYNC_BASE_URL: "https://example.com",
      SYNC_STALE_JOB_MINUTES: "90",
    });

    expect(config.workerId).toBe("home-pc");
    expect(config.intervalHours).toBe(6);
    expect(config.tickMs).toBe(30_000);
    expect(config.baseUrl).toBe("https://example.com");
    expect(config.staleJobAfterMin).toBe(90);
  });

  it("слишком частый тик поднимается до безопасного порога", () => {
    // Опечатка в переменной не должна превращаться в нагрузку на Supabase и ЕИС.
    expect(resolveWorkerConfig({ SYNC_TICK_SECONDS: "0" }).tickMs).toBe(MIN_TICK_SECONDS * 1000);
    expect(resolveWorkerConfig({ SYNC_TICK_SECONDS: "1" }).tickMs).toBe(MIN_TICK_SECONDS * 1000);
    expect(resolveWorkerConfig({ SYNC_TICK_SECONDS: "много" }).tickMs).toBe(
      DEFAULT_TICK_SECONDS * 1000,
    );
  });

  it("нечитаемый интервал не становится нулём: ноль — это прогон каждый тик", () => {
    expect(resolveWorkerConfig({ SYNC_INTERVAL_HOURS: "0" }).intervalHours).toBe(2);
    expect(resolveWorkerConfig({ SYNC_INTERVAL_HOURS: "-3" }).intervalHours).toBe(2);
    expect(resolveWorkerConfig({ SYNC_INTERVAL_HOURS: "abc" }).intervalHours).toBe(2);
  });

  it("плановый прогон отключается явным значением", () => {
    for (const off of ["0", "false", "OFF", " no "]) {
      expect(resolveWorkerConfig({ SYNC_FULL_SYNC: off }).fullSyncEnabled).toBe(false);
    }
    expect(resolveWorkerConfig({ SYNC_FULL_SYNC: "1" }).fullSyncEnabled).toBe(true);
    expect(resolveWorkerConfig({ SYNC_FULL_SYNC: "" }).fullSyncEnabled).toBe(true);
  });

  it("пустой адрес прода заменяется известным", () => {
    expect(resolveWorkerConfig({ SYNC_BASE_URL: "   " }).baseUrl).toBe(DEFAULT_SYNC_BASE_URL);
  });
});

describe("minutesSinceFullSync", () => {
  it("нет пульса или нет отметки — прогона не было", () => {
    expect(minutesSinceFullSync(null, NOW_MS)).toBeNull();
    expect(minutesSinceFullSync(heartbeat({ last_full_sync_at: null }), NOW_MS)).toBeNull();
  });

  it("нечитаемая отметка трактуется как отсутствие прогона", () => {
    expect(minutesSinceFullSync(heartbeat({ last_full_sync_at: "вчера" }), NOW_MS)).toBeNull();
  });

  it("расхождение часов не даёт отрицательного числа", () => {
    const future = new Date(NOW_MS + 10 * 60000).toISOString();

    expect(minutesSinceFullSync(heartbeat({ last_full_sync_at: future }), NOW_MS)).toBe(0);
  });
});

describe("planTick", () => {
  it("первый запуск на новом сервере начинает с планового прогона", () => {
    const action = planTick({ heartbeat: null, pending: 0 }, NOW, CONFIG);

    expect(action.kind).toBe("full_sync");
    expect(action.reason).toContain("ещё не выполнялся");
  });

  it("свежий прогон и пустая очередь — ничего не делать", () => {
    const action = planTick(stateFullSyncMinutesAgo(10), NOW, CONFIG);

    expect(action.kind).toBe("idle");
    expect(action.reason).toContain("до планового прогона 110 мин");
  });

  it("граница интервала: 119 минут — рано, 120 — пора", () => {
    const early = planTick(stateFullSyncMinutesAgo(119), NOW, CONFIG);
    const due = planTick(stateFullSyncMinutesAgo(120), NOW, CONFIG);

    expect(early.kind).toBe("idle");
    expect(due.kind).toBe("full_sync");
    expect(due.reason).toContain("подошёл срок планового прогона");
  });

  it("задание из очереди важнее подошедшего расписания", () => {
    const action = planTick(stateFullSyncMinutesAgo(130, 3), NOW, CONFIG);

    expect(action.kind).toBe("job");
    expect(action.reason).toContain("в очереди заданий: 3");
  });

  it("просроченное вдвое расписание важнее очереди", () => {
    const overdueMin = DEFAULT_SYNC_INTERVAL_HOURS * 60 * FULL_SYNC_OVERDUE_FACTOR;
    const atThreshold = planTick(stateFullSyncMinutesAgo(overdueMin, 5), NOW, CONFIG);
    const justUnder = planTick(stateFullSyncMinutesAgo(overdueMin - 1, 5), NOW, CONFIG);

    expect(atThreshold.kind).toBe("full_sync");
    expect(atThreshold.reason).toContain("просрочен");
    expect(justUnder.kind).toBe("job");
  });

  it("длинная очередь не оставляет ленту без обновлений навсегда", () => {
    // Смысл порога просрочки: сколько бы заданий ни накопилось, через два
    // интервала лента обновляется.
    const action = planTick(stateFullSyncMinutesAgo(600, 40), NOW, CONFIG);

    expect(action.kind).toBe("full_sync");
  });

  it("отключённый плановый прогон не запускается даже при пустой очереди", () => {
    const config = { ...CONFIG, fullSyncEnabled: false };

    expect(planTick({ heartbeat: null, pending: 0 }, NOW, config).kind).toBe("idle");
    expect(
      planTick(stateFullSyncMinutesAgo(600), NOW, config).reason,
    ).toContain("отключён");
  });

  it("отключённый плановый прогон не мешает заданиям из очереди", () => {
    const action = planTick(stateFullSyncMinutesAgo(10, 2), NOW, {
      ...CONFIG,
      fullSyncEnabled: false,
    });

    expect(action.kind).toBe("job");
  });

  it("нечитаемая отметка прогона — как его отсутствие", () => {
    const action = planTick(
      { heartbeat: heartbeat({ last_full_sync_at: "не дата" }), pending: 0 },
      NOW,
      CONFIG,
    );

    expect(action.kind).toBe("full_sync");
  });

  it("момент наблюдения принимается и числом, и строкой", () => {
    const state = stateFullSyncMinutesAgo(10, 1);

    expect(planTick(state, NOW_MS, CONFIG)).toEqual(planTick(state, NOW, CONFIG));
  });

  it("отрицательная длина очереди не рождает задание", () => {
    const action = planTick(stateFullSyncMinutesAgo(10, -5), NOW, CONFIG);

    expect(action.kind).toBe("idle");
  });
});

describe("shouldDrainAnalysisQueue", () => {
  const now = Date.parse("2026-10-05T18:00:00Z");

  it("пустая очередь — не заходим", () => {
    expect(shouldDrainAnalysisQueue([], { jobIds: [], at: null }, now)).toBe(false);
  });

  it("первый заход и новая задача — сразу", () => {
    expect(shouldDrainAnalysisQueue(["a"], { jobIds: [], at: null }, now)).toBe(true);
    expect(shouldDrainAnalysisQueue(["a", "b"], { jobIds: ["a"], at: now - 1000 }, now)).toBe(
      true,
    );
  });

  it("те же задачи без движения — повтор не чаще ANALYSIS_RETRY_MIN", () => {
    const memory = { jobIds: ["a"], at: now - 60_000 };
    expect(shouldDrainAnalysisQueue(["a"], memory, now)).toBe(false);
    expect(
      shouldDrainAnalysisQueue(["a"], { jobIds: ["a"], at: now - ANALYSIS_RETRY_MIN * 60_000 }, now),
    ).toBe(true);
  });
});

describe("planLanes: дорожки воркера", () => {
  const LANE_CONFIG = { ...CONFIG, parallel: true };
  const NO_PENDING: LanePending = { documents: 0, estimate: 0, sync: 0, live: 0 };
  const ALL_FREE: Record<LaneId, boolean> = { sync: false, live: false, documents: false, estimate: false };

  /** Свежий обход (30 минут назад): плановый ещё не нужен. */
  function laneState(overrides: { busy?: Partial<Record<LaneId, boolean>>; pending?: Partial<LanePending>; syncAgoMin?: number | null } = {}): LaneState {
    const ago = overrides.syncAgoMin === undefined ? 30 : overrides.syncAgoMin;
    return {
      heartbeat: ago === null ? null : stateFullSyncMinutesAgo(ago).heartbeat,
      busy: { ...ALL_FREE, ...overrides.busy },
      pending: { ...NO_PENDING, ...overrides.pending },
    };
  }

  function starts(state: LaneState, config = LANE_CONFIG): LaneStart[] {
    const plan = planLanes(state, NOW_MS, config);
    if (plan.mode !== "parallel") throw new Error("ожидался параллельный план");
    return plan.starts;
  }

  const lanesOf = (list: LaneStart[]): string[] => list.map((start) => `${start.lane}:${start.kind}`);

  it("ничего не ждёт и обход свежий — на свободной дорожке документации только просмотр задач разбора", () => {
    expect(lanesOf(starts(laneState()))).toEqual(["documents:drain"]);
  });

  it("задание каждого вида получает свою дорожку одновременно", () => {
    const list = starts(laneState({ pending: { documents: 2, estimate: 1, sync: 1, live: 3 } }));
    expect(lanesOf(list)).toEqual(["sync:job", "live:job", "documents:job", "estimate:job"]);
  });

  it("занятые дорожки не получают ничего, свободные работают", () => {
    const list = starts(
      laneState({
        busy: { sync: true, documents: true },
        pending: { documents: 5, estimate: 1, sync: 2, live: 1 },
      }),
    );
    expect(lanesOf(list)).toEqual(["live:job", "estimate:job"]);
  });

  it("все дорожки заняты — решение пустое", () => {
    const busy = { sync: true, live: true, documents: true, estimate: true };
    expect(starts(laneState({ busy, pending: { documents: 1, estimate: 1, sync: 1, live: 1 }, syncAgoMin: 500 }))).toEqual([]);
  });

  it("расчёт сметы никогда не стартует дважды: пока дорожка занята, очередь ждёт", () => {
    const list = starts(laneState({ busy: { estimate: true }, pending: { estimate: 4 } }));
    expect(list.some((start) => start.lane === "estimate")).toBe(false);
  });

  it("документация идёт не мимо дорожки: задания есть — берётся задание, а не просмотр разбора", () => {
    const list = starts(laneState({ pending: { documents: 1 } }));
    expect(lanesOf(list)).toEqual(["documents:job"]);
    expect(lanesOf(list)).not.toContain("documents:drain");
  });

  it("просмотр задач разбора — только когда дорожка документации свободна и заданий на документацию нет", () => {
    expect(lanesOf(starts(laneState({ busy: { documents: true } })))).toEqual([]);
    expect(lanesOf(starts(laneState({ busy: { documents: true }, pending: { documents: 3 } })))).toEqual([]);
    expect(lanesOf(starts(laneState({ pending: { estimate: 1 } })))).toEqual(["documents:drain", "estimate:job"]);
  });

  it("плановый обход идёт рядом с заданиями других видов: очередь его больше не удерживает", () => {
    const list = starts(laneState({ syncAgoMin: 130, pending: { documents: 2, estimate: 1, live: 1 } }));
    expect(lanesOf(list)).toEqual(["sync:scheduled", "live:job", "documents:job", "estimate:job"]);
  });

  it("плановый обход не стартует, пока в очереди ждёт «Найти новые закупки»: вместо него берётся оно", () => {
    const list = starts(laneState({ syncAgoMin: 130, pending: { sync: 1 } }));
    const syncStarts = list.filter((start) => start.lane === "sync");
    expect(syncStarts).toHaveLength(1);
    expect(syncStarts[0]).toMatchObject({ lane: "sync", kind: "job" });
  });

  it("первый запуск на новом сервере тоже уступает заданию человека", () => {
    const withJob = starts(laneState({ syncAgoMin: null, pending: { sync: 2 } }));
    expect(withJob.filter((start) => start.lane === "sync")).toEqual([
      expect.objectContaining({ kind: "job" }),
    ]);
    const alone = starts(laneState({ syncAgoMin: null }));
    expect(alone.filter((start) => start.lane === "sync")).toEqual([
      expect.objectContaining({ kind: "scheduled" }),
    ]);
  });

  it("обход занят — второй обход не стартует ни по расписанию, ни из очереди, а живой поиск идёт параллельно", () => {
    const list = starts(laneState({ busy: { sync: true }, syncAgoMin: 500, pending: { sync: 2, live: 1 } }));
    expect(lanesOf(list)).toEqual(["live:job", "documents:drain"]);
  });

  it("обход и живой поиск стартуют в одном тике", () => {
    const list = starts(laneState({ syncAgoMin: 125, pending: { live: 1 } }));
    expect(lanesOf(list)).toEqual(["sync:scheduled", "live:job", "documents:drain"]);
  });

  it("отключённый плановый обход не стартует, но «Найти новые закупки» выполняется", () => {
    const off = { ...LANE_CONFIG, fullSyncEnabled: false };
    expect(lanesOf(starts(laneState({ syncAgoMin: 900 }), off))).toEqual(["documents:drain"]);
    expect(lanesOf(starts(laneState({ syncAgoMin: 900, pending: { sync: 1 } }), off))).toEqual(["sync:job", "documents:drain"]);
  });

  it("причина запуска пишется по-русски и называет число минут", () => {
    const scheduled = starts(laneState({ syncAgoMin: 130 })).find((start) => start.lane === "sync");
    expect(scheduled?.reason).toContain("130");
    const overdue = starts(laneState({ syncAgoMin: 300 })).find((start) => start.lane === "sync");
    expect(overdue?.reason).toContain("просрочен");
  });

  it("WORKER_PARALLEL=0: решение прежнее, это результат planTick с суммой очередей", () => {
    const serial = { ...CONFIG, parallel: false };
    for (const ago of [null, 30, 119, 120, 239, 240, 500]) {
      for (const pending of [
        NO_PENDING,
        { ...NO_PENDING, documents: 2 },
        { ...NO_PENDING, estimate: 1, live: 1, sync: 1 },
      ]) {
        const state = laneState({ syncAgoMin: ago, pending, busy: { sync: true, estimate: true } });
        const total = pending.documents + pending.estimate + pending.sync + pending.live;
        expect(planLanes(state, NOW_MS, serial), `${String(ago)} / ${String(total)}`).toEqual({
          mode: "serial",
          action: planTick({ heartbeat: state.heartbeat, pending: total }, NOW_MS, serial),
        });
      }
    }
  });
});

describe("planScheduledSync", () => {
  it("совпадает с planTick при пустой очереди: сроки обхода не менялись", () => {
    for (const ago of [null, 0, 60, 119, 120, 121, 239, 240, 241, 1000]) {
      const { heartbeat: beat } = stateFullSyncMinutesAgo(ago ?? 0);
      const hb = ago === null ? null : beat;
      const action = planTick({ heartbeat: hb, pending: 0 }, NOW_MS, CONFIG);
      const due = planScheduledSync(hb, NOW_MS, CONFIG);
      expect(due !== null, String(ago)).toBe(action.kind === "full_sync");
    }
  });

  it("отключённый обход — всегда null", () => {
    expect(planScheduledSync(null, NOW_MS, { ...CONFIG, fullSyncEnabled: false })).toBeNull();
  });
});

describe("workerEisRate: нагрузка на ЕИС при параллельных прогонах", () => {
  it("обход в параллельном режиме идёт со сниженной скоростью, живой поиск один — с умолчанием", () => {
    expect(workerEisRate("sync", { parallel: true, syncBusy: false })).toBe(PARALLEL_EIS_RATE);
    expect(workerEisRate("live", { parallel: true, syncBusy: false })).toBeNull();
  });

  it("живой поиск рядом с обходом снижает скорость", () => {
    expect(workerEisRate("live", { parallel: true, syncBusy: true })).toBe("1.5");
  });

  it("без параллелизма переменная не задаётся вовсе: поведение прежнее", () => {
    expect(workerEisRate("sync", { parallel: false, syncBusy: false })).toBeNull();
    expect(workerEisRate("live", { parallel: false, syncBusy: true })).toBeNull();
  });
});
