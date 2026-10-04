import { describe, it, expect } from "vitest";
import {
  DEFAULT_WORKER_ID,
  WORKER_STALE_AFTER_MIN,
  describeWorkerStatus,
  resolveWorkerId,
} from "./workerStatus";
import type { WorkerHeartbeatRow, WorkerStatus } from "@/types/database";

const NOW = "2026-09-25T03:00:00.000Z";

function heartbeat(overrides: Partial<WorkerHeartbeatRow> = {}): WorkerHeartbeatRow {
  return {
    worker_id: "ru-vps",
    last_seen_at: "2026-09-25T02:57:00.000Z",
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

function status(overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    heartbeat: heartbeat(),
    lastJob: null,
    pending: 0,
    ...overrides,
  };
}

/** Отметка пульса за N минут до NOW. */
function seenMinutesAgo(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60000).toISOString();
}

describe("describeWorkerStatus", () => {
  it("нет пульса — сервер не настроен, и это сказано прямо", () => {
    const view = describeWorkerStatus(status({ heartbeat: null }), NOW);

    expect(view.state).toBe("unknown");
    expect(view.minutesSinceSeen).toBeNull();
    expect(view.label).toBe("Сервер в России ещё не выходил на связь");
    expect(view.hint).toContain("документация к ним не загружается");
  });

  it("свежий пульс с российского адреса — сервер на связи", () => {
    const view = describeWorkerStatus(
      status({ heartbeat: heartbeat({ last_seen_at: seenMinutesAgo(3) }) }),
      NOW,
    );

    expect(view.state).toBe("online");
    expect(view.label).toBe("Сервер в России на связи 3 мин назад");
    expect(view.hint).toContain("Выход из России (176.97.134.221)");
    expect(view.minutesSinceSeen).toBe(3);
  });

  it("граница порога: ровно WORKER_STALE_AFTER_MIN минут — уже пропал", () => {
    const atThreshold = describeWorkerStatus(
      status({ heartbeat: heartbeat({ last_seen_at: seenMinutesAgo(WORKER_STALE_AFTER_MIN) }) }),
      NOW,
    );
    const justUnder = describeWorkerStatus(
      status({
        heartbeat: heartbeat({ last_seen_at: seenMinutesAgo(WORKER_STALE_AFTER_MIN - 1) }),
      }),
      NOW,
    );

    expect(atThreshold.state).toBe("stale");
    expect(justUnder.state).toBe("online");
    expect(atThreshold.label).toBe(`Сервер в России не выходил на связь ${WORKER_STALE_AFTER_MIN} мин назад`);
    expect(atThreshold.hint).toContain("задания ждут в очереди");
  });

  it("долгое молчание показывается часами", () => {
    const view = describeWorkerStatus(
      status({ heartbeat: heartbeat({ last_seen_at: seenMinutesAgo(90) }) }),
      NOW,
    );

    expect(view.label).toBe("Сервер в России не выходил на связь 1 ч назад");
  });

  it("выход не из России важнее свежего пульса", () => {
    const view = describeWorkerStatus(
      status({
        heartbeat: heartbeat({
          last_seen_at: seenMinutesAgo(1),
          exit_ip: "2.26.131.126",
          exit_country: "GB",
        }),
      }),
      NOW,
    );

    expect(view.state).toBe("foreign_exit");
    expect(view.label).toContain("не из России");
    expect(view.hint).toContain("пока выход не станет российским");
  });

  it("неизвестная страна не считается зарубежным выходом", () => {
    // «Не определено» не равно «другая страна»: адрес мог не определиться
    // из-за таймаута, и пугать партнёра сменой выхода нельзя.
    const view = describeWorkerStatus(
      status({ heartbeat: heartbeat({ exit_country: null }) }),
      NOW,
    );

    expect(view.state).toBe("online");
    expect(view.label).toBe("Сервер в России на связи 3 мин назад");
  });

  it("очередь и последняя ошибка видны в подписи", () => {
    const view = describeWorkerStatus(
      status({
        pending: 2,
        heartbeat: heartbeat({ last_error: "filestore: таймаут" }),
      }),
      NOW,
    );

    expect(view.hint).toContain("В очереди заданий: 2.");
    expect(view.hint).toContain("Последняя ошибка: filestore: таймаут");
  });

  it("пустая очередь не упоминается", () => {
    const view = describeWorkerStatus(status({ pending: 0 }), NOW);

    expect(view.hint).not.toContain("В очереди заданий");
  });

  it("расхождение часов не даёт «минус три минуты назад»", () => {
    const view = describeWorkerStatus(
      status({ heartbeat: heartbeat({ last_seen_at: seenMinutesAgo(-3) }) }),
      NOW,
    );

    expect(view.minutesSinceSeen).toBe(0);
    expect(view.label).toBe("Сервер в России на связи только что");
  });

  it("нечитаемая отметка трактуется как молчание, а не как «только что»", () => {
    const view = describeWorkerStatus(
      status({ heartbeat: heartbeat({ last_seen_at: "не дата" }) }),
      NOW,
    );

    expect(view.state).toBe("stale");
    expect(view.label).toBe("Отметка времени сервера не читается");
    expect(view.minutesSinceSeen).toBeNull();
  });

  it("момент наблюдения принимается и числом, и строкой", () => {
    const byNumber = describeWorkerStatus(status(), Date.parse(NOW));
    const byString = describeWorkerStatus(status(), NOW);

    expect(byNumber).toEqual(byString);
  });

  it("в подписях нет слова «воркер»: партнёру важен сервер, а не процесс", () => {
    // Подпись показывается человеку, который не знает, как называется служба на
    // сервере. Проверка сразу на всех состояниях: добавить новое и назвать в нём
    // машину «воркером» — самая лёгкая и самая незаметная порча подписи, поэтому
    // она закрыта тестом, а не договорённостью.
    const views = [
      describeWorkerStatus(status({ heartbeat: null }), NOW),
      describeWorkerStatus(status(), NOW),
      describeWorkerStatus(status({ pending: 2 }), NOW),
      describeWorkerStatus(
        status({ heartbeat: heartbeat({ exit_country: "GB", exit_ip: "2.26.131.126" }) }),
        NOW,
      ),
      describeWorkerStatus(status({ heartbeat: heartbeat({ last_seen_at: "не дата" }) }), NOW),
      describeWorkerStatus(status({ heartbeat: heartbeat({ last_seen_at: seenMinutesAgo(60) }) }), NOW),
    ];

    for (const view of views) {
      expect(view.label.toLowerCase()).not.toContain("воркер");
      expect(view.hint.toLowerCase()).not.toContain("воркер");
    }
  });
});

describe("resolveWorkerId", () => {
  it("имя по умолчанию совпадает с тем, что пишет воркер", () => {
    // Прод читает пульс по этому имени, воркер пишет по нему же: расхождение
    // означало бы, что панель всегда показывает «не выходил на связь».
    expect(DEFAULT_WORKER_ID).toBe("ru-vps");
    expect(resolveWorkerId()).toBe(DEFAULT_WORKER_ID);
    expect(resolveWorkerId(null)).toBe(DEFAULT_WORKER_ID);
    expect(resolveWorkerId("   ")).toBe(DEFAULT_WORKER_ID);
  });

  it("значение из окружения сохраняется, пробелы по краям срезаются", () => {
    expect(resolveWorkerId("home-pc")).toBe("home-pc");
    expect(resolveWorkerId("  home-pc\n")).toBe("home-pc");
  });

  it("слишком длинное имя укорачивается до 64 символов", () => {
    expect(resolveWorkerId("v".repeat(200))).toBe("v".repeat(64));
  });
});
