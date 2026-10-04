import { describe, it, expect } from "vitest";
import {
  DEFAULT_SYNC_BASE_URL,
  DEFAULT_SYNC_INTERVAL_HOURS,
  DEFAULT_TICK_SECONDS,
  FULL_SYNC_OVERDUE_FACTOR,
  MIN_TICK_SECONDS,
  STALE_JOB_AFTER_MIN,
  minutesSinceFullSync,
  planTick,
  resolveWorkerConfig,
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
