import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationDeps } from "@/services/notificationService";
import { DIGEST_CHECK_INTERVAL_MS, READY_CHECK_INTERVAL_MS, startNotificationWatch } from "@/services/notificationWatch";

function deps(over: Partial<NotificationDeps> = {}): NotificationDeps {
  return {
    env: { ADMIN_EMAILS: "boss@firma.ru" },
    now: () => Date.now(),
    smtpConfigured: () => true,
    sendMail: vi.fn(async () => undefined),
    log: vi.fn(),
    listReadyJobs: vi.fn(async () => []),
    claimJob: vi.fn(async () => true),
    releaseJob: vi.fn(async () => undefined),
    readSettingsByEmail: vi.fn(async () => undefined),
    readTenderSubject: vi.fn(async () => null),
    readAnalysisRows: vi.fn(async () => []),
    listUsers: vi.fn(async () => []),
    findUserByEmail: vi.fn(async () => null),
    readSettings: vi.fn(async () => new Map()),
    readDigestData: vi.fn(async () => new Map()),
    loadTenderRows: vi.fn(async () => []),
    markDigestSent: vi.fn(async () => undefined),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startNotificationWatch", () => {
  it("первая проверка — сразу; письма о готовности — раз в минуту, сводки — раз в десять минут", async () => {
    const d = deps();
    const stop = startNotificationWatch(vi.fn(), d);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.listReadyJobs).toHaveBeenCalledTimes(1);
    expect(d.listUsers).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(READY_CHECK_INTERVAL_MS);
    expect(d.listReadyJobs).toHaveBeenCalledTimes(2);
    expect(d.listUsers).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DIGEST_CHECK_INTERVAL_MS - READY_CHECK_INTERVAL_MS);
    expect(d.listUsers).toHaveBeenCalledTimes(2);
    expect(d.listReadyJobs).toHaveBeenCalledTimes(10 + 1);
    stop();
  });

  it("остановка гасит оба таймера", async () => {
    const d = deps();
    const stop = startNotificationWatch(vi.fn(), d);
    await vi.advanceTimersByTimeAsync(0);
    stop();

    await vi.advanceTimersByTimeAsync(DIGEST_CHECK_INTERVAL_MS * 2);

    expect(d.listReadyJobs).toHaveBeenCalledTimes(1);
    expect(d.listUsers).toHaveBeenCalledTimes(1);
  });

  it("медленный прогон не накладывается на следующий тик", async () => {
    let release: () => void = () => undefined;
    const d = deps({
      listReadyJobs: vi.fn(
        () =>
          new Promise<never[]>((resolve) => {
            release = () => resolve([]);
          }),
      ),
    });
    const stop = startNotificationWatch(vi.fn(), d);
    await vi.advanceTimersByTimeAsync(READY_CHECK_INTERVAL_MS * 3);
    expect(d.listReadyJobs).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(READY_CHECK_INTERVAL_MS);
    expect(d.listReadyJobs).toHaveBeenCalledTimes(2);
    stop();
  });

  it("сбой не останавливает наблюдателя: он только пишет в журнал и пробует снова", async () => {
    const log = vi.fn();
    const d = deps({ listReadyJobs: vi.fn(async () => Promise.reject(new Error("база недоступна"))) });
    const stop = startNotificationWatch(log, d);
    await vi.advanceTimersByTimeAsync(READY_CHECK_INTERVAL_MS * 2);

    expect(d.listReadyJobs).toHaveBeenCalledTimes(3);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("база недоступна"));
    stop();
  });
});
