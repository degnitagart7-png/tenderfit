import { describe, it, expect, vi } from "vitest";
import { LaneRunner } from "./laneRunner";

type Lane = "sync" | "live" | "estimate";

/** Дело, которое заканчивается, когда тест скажет. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Даёт отработать всем уже готовым микрозадачам, не считая их вручную. */
const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("LaneRunner", () => {
  it("дорожка занята с момента запуска и свободна после окончания дела", async () => {
    const runner = new LaneRunner<Lane>(() => undefined);
    const job = deferred();

    expect(runner.start("sync", () => job.promise)).toBe(true);
    expect(runner.isBusy("sync")).toBe(true);
    expect(runner.isBusy("live")).toBe(false);

    job.resolve();
    await runner.whenIdle();
    expect(runner.isBusy("sync")).toBe(false);
    expect(runner.size).toBe(0);
  });

  it("на занятой дорожке второе дело не запускается", async () => {
    const runner = new LaneRunner<Lane>(() => undefined);
    const first = deferred();
    const second = vi.fn(async () => undefined);

    runner.start("estimate", () => first.promise);
    expect(runner.start("estimate", second)).toBe(false);
    first.resolve();
    await runner.whenIdle();
    expect(second).not.toHaveBeenCalled();
  });

  it("разные дорожки работают одновременно", async () => {
    const runner = new LaneRunner<Lane>(() => undefined);
    const a = deferred();
    const b = deferred();
    runner.start("sync", () => a.promise);
    runner.start("live", () => b.promise);

    expect(runner.busyLanes().sort()).toEqual(["live", "sync"]);
    a.resolve();
    await flush();
    expect(runner.isBusy("sync")).toBe(false);
    expect(runner.isBusy("live")).toBe(true);
    b.resolve();
    await runner.whenIdle();
  });

  it("отказ дела уходит в обработчик и освобождает дорожку", async () => {
    const onError = vi.fn();
    const runner = new LaneRunner<Lane>(onError);
    const boom = new Error("ЕИС не отвечает");

    runner.start("sync", async () => {
      throw boom;
    });
    await runner.whenIdle();

    expect(onError).toHaveBeenCalledWith("sync", boom);
    expect(runner.isBusy("sync")).toBe(false);
    // Дорожка после сбоя снова принимает работу.
    expect(runner.start("sync", async () => undefined)).toBe(true);
    await runner.whenIdle();
  });

  it("синхронное исключение в деле не оставляет дорожку занятой навсегда", async () => {
    const onError = vi.fn();
    const runner = new LaneRunner<Lane>(onError);

    runner.start("live", () => {
      throw new Error("упало до первого await");
    });
    await runner.whenIdle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(runner.isBusy("live")).toBe(false);
  });

  it("сбой самого обработчика ошибок не оставляет дорожку занятой", async () => {
    const runner = new LaneRunner<Lane>(() => {
      throw new Error("журнал недоступен");
    });
    runner.start("estimate", async () => {
      throw new Error("дело упало");
    });
    await runner.whenIdle();
    expect(runner.isBusy("estimate")).toBe(false);
  });

  it("сбой одной дорожки не трогает другую", async () => {
    const runner = new LaneRunner<Lane>(() => undefined);
    const long = deferred();
    runner.start("sync", () => long.promise);
    runner.start("estimate", async () => {
      throw new Error("смета упала");
    });
    await flush();

    expect(runner.isBusy("estimate")).toBe(false);
    expect(runner.isBusy("sync")).toBe(true);
    long.resolve();
    await runner.whenIdle();
  });

  it("whenIdle с пределом сообщает, что дорожки не освободились", async () => {
    vi.useFakeTimers();
    try {
      const runner = new LaneRunner<Lane>(() => undefined);
      const never = deferred();
      runner.start("sync", () => never.promise);

      const waiting = runner.whenIdle(1000);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(waiting).resolves.toBe(false);

      never.resolve();
      await expect(runner.whenIdle(1000)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("дело, запущенное во время ожидания, тоже дожидается", async () => {
    const runner = new LaneRunner<Lane>(() => undefined);
    const first = deferred();
    const second = deferred();
    runner.start("sync", () => first.promise);

    let idle = false;
    const waiting = runner.whenIdle().then(() => {
      idle = true;
    });
    runner.start("live", () => second.promise);
    first.resolve();
    await flush();
    expect(idle).toBe(false);
    second.resolve();
    await waiting;
    expect(idle).toBe(true);
  });
});
