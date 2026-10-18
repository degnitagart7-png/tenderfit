import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireZoneBuildLock, inspectZoneBuildLock, withZoneBuildLock, type LockOptions } from "@/lib/fsnb/zoneBuildLock";

/*
  Замок сборки зон: одна сборка за раз. Время, жизнь процесса и ожидание подменены, чтобы проверять
  брошенный замок и ожидание без настоящих пауз.
*/

let dir = "";
let path = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zone-lock-"));
  path = join(dir, "data", "zones-build.lock");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function options(patch: Partial<LockOptions> = {}): LockOptions {
  return { path, waitMs: 0, staleMs: 60_000, zoneId: 246, by: "тест", host: "srv", pid: 100, isAlive: () => true, ...patch };
}

describe("замок сборки зон", () => {
  it("берётся, пишет владельца, снимается; повторное снятие безопасно", async () => {
    const handle = await acquireZoneBuildLock(options());

    expect(handle).not.toBeNull();
    expect(inspectZoneBuildLock(path)).toMatchObject({ pid: 100, host: "srv", zoneId: 246, by: "тест" });
    handle?.release();
    handle?.release();
    expect(existsSync(path)).toBe(false);
  });

  it("занятый живым владельцем замок не берётся: без ожидания — null, и чужой файл цел", async () => {
    const first = await acquireZoneBuildLock(options());

    expect(await acquireZoneBuildLock(options({ pid: 200 }))).toBeNull();
    expect(inspectZoneBuildLock(path)?.pid).toBe(100);
    first?.release();
    const second = await acquireZoneBuildLock(options({ pid: 200 }));
    expect(second?.owner.pid).toBe(200);
    second?.release();
  });

  it("замок мёртвого процесса на этой машине снимается и берётся заново", async () => {
    await acquireZoneBuildLock(options({ pid: 100 }));

    const taken = await acquireZoneBuildLock(options({ pid: 200, isAlive: (pid) => pid !== 100 }));

    expect(taken?.owner.pid).toBe(200);
    expect(inspectZoneBuildLock(path)?.pid).toBe(200);
    taken?.release();
  });

  it("замок другой машины по pid не проверяется — только по возрасту", async () => {
    await acquireZoneBuildLock(options({ pid: 100, host: "other" }));

    expect(await acquireZoneBuildLock(options({ pid: 200, isAlive: () => false }))).toBeNull();
  });

  it("замок старше staleMs считается брошенным, даже если процесс «жив»", async () => {
    let now = Date.parse("2026-10-08T00:00:00Z");
    await acquireZoneBuildLock(options({ pid: 100, now: () => now }));
    now += 61 * 60_000;

    const taken = await acquireZoneBuildLock(options({ pid: 200, now: () => now, staleMs: 60 * 60_000 }));

    expect(taken?.owner.pid).toBe(200);
    taken?.release();
  });

  it("ждёт, пока владелец отпустит: за время ожидания замок освободился — берётся; не освободился — null после waitMs", async () => {
    const holder = await acquireZoneBuildLock(options({ pid: 100 }));
    let now = 0;
    const slept: number[] = [];

    const waiting = await acquireZoneBuildLock(
      options({
        pid: 200,
        waitMs: 10_000,
        pollMs: 2_000,
        now: () => now,
        sleep: async (ms) => {
          slept.push(ms);
          now += ms;
          if (slept.length === 2) holder?.release();
        },
      }),
    );
    expect(waiting?.owner.pid).toBe(200);
    expect(slept).toEqual([2_000, 2_000]);
    waiting?.release();

    const busy = await acquireZoneBuildLock(options({ pid: 100 }));
    now = 0;
    const timedOut = await acquireZoneBuildLock(
      options({ pid: 300, waitMs: 5_000, pollMs: 2_000, now: () => now, sleep: async (ms) => void (now += ms) }),
    );
    expect(timedOut).toBeNull();
    expect(now).toBeGreaterThanOrEqual(5_000);
    busy?.release();
  });

  it("не снимает чужой замок: если наш признали брошенным и взяли заново, release оставляет его", async () => {
    const mine = await acquireZoneBuildLock(options({ pid: 100 }));
    writeFileSync(path, `${JSON.stringify({ pid: 999, host: "srv", startedAt: "2026-10-08T01:00:00.000Z", zoneId: 1, by: "другой" })}\n`);

    mine?.release();

    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(999);
  });

  it("нечитаемый файл замка моложе 10 с — ждём, а не снимаем", async () => {
    await acquireZoneBuildLock(options({ pid: 100 }));
    writeFileSync(path, "{оборвано");

    expect(await acquireZoneBuildLock(options({ pid: 200 }))).toBeNull();
  });

  it("withZoneBuildLock: работа под замком, замок снят и при ошибке; занято — понятная ошибка с владельцем", async () => {
    await expect(
      withZoneBuildLock(options(), async () => {
        expect(existsSync(path)).toBe(true);
        throw new Error("сбой работы");
      }),
    ).rejects.toThrow("сбой работы");
    expect(existsSync(path)).toBe(false);

    const holder = await acquireZoneBuildLock(options({ pid: 100 }));
    await expect(withZoneBuildLock(options({ pid: 200 }), async () => 1)).rejects.toThrow(/Сборка зон занята.*pid 100/);
    expect(await withZoneBuildLock(options({ pid: 200 }), async () => 1, () => -1)).toBe(-1);
    holder?.release();
  });
});
