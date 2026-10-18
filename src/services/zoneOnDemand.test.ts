import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuildAll, writeZoneDirectoryFile } from "../../scripts/fsnb/build-all-zones";
import type { BuildZoneOptions } from "../../scripts/fsnb/build-zone";
import type { Downloader, FetchedZone } from "../../scripts/fsnb/fetch-zone";
import { periodsUrl, zonesUrl } from "@/lib/fsnb/fgisZoneApi";
import { clearEstimateBaseCache, listBuiltZones, loadZonePriceBook } from "@/repositories/estimateBaseRepository";
import {
  childProcessZoneBuilder,
  ensureZoneBuilt,
  fetchZoneDirectoryLive,
  loadZoneDirectory,
  readZoneDirectoryFile,
  ZoneBuildError,
  type ZoneBuildRunner,
} from "@/services/zoneOnDemand";

/*
  Сборка зоны по требованию. Скачивание и сборка подменены: настоящие ходят к ФГИС ЦС (только с
  российского адреса) и читают 14 МБ xlsx. Проверяется оболочка: собрали ли зону, не запустили ли две
  сборки, остановили ли по таймауту, внятна ли причина отказа.
*/

let dir = "";
let indexDir = "";
beforeEach(async () => {
  clearEstimateBaseCache();
  dir = await mkdtemp(join(tmpdir(), "zone-on-demand-"));
  indexDir = join(dir, "index");
  mkdirSync(join(indexDir, "zones"), { recursive: true });
});
afterEach(async () => {
  clearEstimateBaseCache();
  await rm(dir, { recursive: true, force: true });
});

/** Зона «собрана»: паспорт, который читает репозиторий (`listBuiltZones`). */
function placeZone(id: number): void {
  const zoneDir = join(indexDir, "zones", String(id));
  mkdirSync(zoneDir, { recursive: true });
  writeFileSync(
    join(zoneDir, "zone.json"),
    JSON.stringify({ priceZoneId: id, zoneName: `Зона ${String(id)}`, subject: "Субъект", periodId: 427, period: "3 квартал 2026 г.", builtAt: "2026-10-08T00:00:00.000Z" }),
  );
}

describe("ensureZoneBuilt", () => {
  it("зона уже на диске — сборка не запускается", async () => {
    placeZone(246);
    let runs = 0;

    expect(await ensureZoneBuilt(246, { indexDir, run: async () => void (runs += 1) })).toBe("ALREADY");
    expect(runs).toBe(0);
  });

  it("зоны нет — запускается сборка с таймаутом и сигналом остановки; после неё зона на диске — BUILT", async () => {
    const seen: { timeoutMs: number; aborted: boolean }[] = [];
    const run: ZoneBuildRunner = async (id, context) => {
      seen.push({ timeoutMs: context.timeoutMs, aborted: context.signal.aborted });
      placeZone(id);
    };

    expect(await ensureZoneBuilt(246, { indexDir, run, timeoutMs: 5_000 })).toBe("BUILT");
    expect(seen).toEqual([{ timeoutMs: 5_000, aborted: false }]);
    expect((await listBuiltZones({ indexDir })).map((zone) => zone.priceZoneId)).toEqual([246]);
  });

  it("два одновременных расчёта для одной зоны делят одну сборку; для разных зон — каждая своя", async () => {
    const started: number[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => void (release = done));
    const run: ZoneBuildRunner = async (id) => {
      started.push(id);
      await gate;
      placeZone(id);
    };

    const first = ensureZoneBuilt(246, { indexDir, run });
    const second = ensureZoneBuilt(246, { indexDir, run });
    const other = ensureZoneBuilt(282, { indexDir, run });
    release();

    expect(await Promise.all([first, second, other])).toEqual(["BUILT", "BUILT", "BUILT"]);
    expect(started.sort()).toEqual([246, 282]);
  });

  it("сборка упала — ZoneBuildError с причиной; отказ не запоминается: следующий расчёт пробует снова", async () => {
    const failing: ZoneBuildRunner = async () => {
      throw new Error("ФГИС ЦС ответил 502");
    };

    const error = await ensureZoneBuilt(246, { indexDir, run: failing }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ZoneBuildError);
    expect((error as ZoneBuildError).message).toBe("Не удалось собрать цены зоны 246: ФГИС ЦС ответил 502");
    expect((error as ZoneBuildError).priceZoneId).toBe(246);

    expect(await ensureZoneBuilt(246, { indexDir, run: async (id) => placeZone(id) })).toBe("BUILT");
  });

  it("таймаут: сборку останавливают сигналом, расчёт получает понятную причину и команду для ручной сборки", async () => {
    let signalSeen: AbortSignal | null = null;
    const hanging: ZoneBuildRunner = (_id, context) =>
      new Promise<void>((_done, fail) => {
        signalSeen = context.signal;
        context.signal.addEventListener("abort", () => fail(new Error("остановлена")), { once: true });
      });

    const error = await ensureZoneBuilt(246, { indexDir, run: hanging, timeoutMs: 30 }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ZoneBuildError);
    expect((error as Error).message).toContain("не уложилась");
    expect((error as Error).message).toContain("npx tsx scripts/fsnb/build-all-zones.ts --only 246");
    expect((signalSeen as AbortSignal | null)?.aborted).toBe(true);
  });

  it("сборка «успешна», а зоны на диске нет — отказ, а не молчаливый расчёт в чужих ценах", async () => {
    const error = await ensureZoneBuilt(246, { indexDir, run: async () => undefined }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("зоны на диске нет");
  });

  it("на подменённых скачивании и сборке: build-all-zones --only собирает зону под замком, воркер считает дальше по её книге цен", async () => {
    const download = (async (url: string): Promise<Uint8Array> => {
      if (url === zonesUrl()) return new TextEncoder().encode(JSON.stringify([{ value: 246, text: "Иркутская область (1 зона)" }]));
      if (url === periodsUrl(246)) return new TextEncoder().encode(JSON.stringify([{ id: 427, name: "3 квартал 2026 г." }]));
      throw new Error(`неожиданный запрос ${url}`);
    }) as Downloader;
    const events: string[] = [];
    const fetchRaw = async (id: number, zoneName: string): Promise<FetchedZone> => {
      events.push("скачано");
      const rawDir = join(dir, "raw", String(id), "427");
      mkdirSync(rawDir, { recursive: true });
      return { priceZoneId: id, zoneName, periodId: 427, periodName: "3 квартал 2026 г.", dir: rawDir, warnings: [] };
    };
    const build = async (options: BuildZoneOptions) => {
      events.push("собрано");
      const out = options.out as string;
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, "zone.json"),
        JSON.stringify({ priceZoneId: 246, zoneName: "Иркутская область (1 зона)", subject: "Иркутская область", periodId: 427, period: "3 квартал 2026 г.", builtAt: "2026-10-08T02:30:00.000Z", buildVersion: 2 }),
      );
      writeFileSync(
        join(out, "prices-current.jsonl"),
        `${JSON.stringify({ code: "91.01.01-039", name: "Бульдозеры", unit: "маш.-ч", price: 2958.61, machinistSalary: 875.79, machinistHours: 1, source: "CURRENT_ZONE", period: "3 квартал 2026 г.", zone: "Иркутская область (1 зона)" })}\n`,
      );
      writeFileSync(join(out, "wages.jsonl"), `${JSON.stringify({ rank: 1, salary: 500, source: "тест" })}\n`);
      return { zoneDocument: {}, outDir: out, peakRssBytes: 1 };
    };
    // Те же файлы общего индекса, что нужны книге цен зоны.
    writeFileSync(join(indexDir, "build-info.json"), JSON.stringify({ builtAt: "2026-10-01T00:00:00.000Z", baseEdition: "01.01.2022", region: "Иркутская область", zone: "Иркутская область (1 зона)", period: "3 квартал 2026 г.", decree: "приказ", outputs: {}, notes: [] }));
    writeFileSync(join(indexDir, "prices-base.jsonl"), `${JSON.stringify({ code: "91.01.01-039", name: "Бульдозеры", unit: "маш.-ч", price: 1000, machinistSalary: 300, machinistHours: 1, source: "BASE_2022", period: null, zone: null })}\n`);
    writeFileSync(join(indexDir, "zones.jsonl"), `${JSON.stringify({ subjectCode: "38", subjectName: "Иркутская область", zoneName: "Иркутская область (1 зона)", center: "г. Иркутск", municipalities: "" })}\n`);

    const run: ZoneBuildRunner = async (id) => {
      const report = await runBuildAll(
        { only: [id], force: false, dryRun: false, pauseMs: 0, keepRaw: false, maxMinutes: null, lockWaitMinutes: 0, indexDir, rawRoot: join(dir, "raw") },
        { download, log: () => undefined, lockPath: join(dir, "zones-build.lock"), updateDeps: { build, fetchRaw: fetchRaw as never } },
      );
      if (report.failed.length > 0) throw new Error(report.failed.map((item) => item.detail).join("; "));
    };

    expect(await ensureZoneBuilt(246, { indexDir, run })).toBe("BUILT");
    expect(events).toEqual(["скачано", "собрано"]);

    // Расчёт продолжается: книга цен только что собранной зоны читается, цена зоны — её.
    const book = await loadZonePriceBook(246, { indexDir });
    expect(book.priceZone).toBe("Иркутская область (1 зона)");
    expect(book.current.get("91.01.01-039")?.price).toBe(2958.61);
    expect(existsSync(join(dir, "zones-build.lock"))).toBe(false);
    // Вторая просьба — уже готово.
    expect(await ensureZoneBuilt(246, { indexDir, run })).toBe("ALREADY");
    expect(events).toHaveLength(2);
  });
});

describe("справочник зон для выбора не собранной зоны", () => {
  const live = async () => [{ priceZoneId: 50, zoneName: "Республика Калмыкия" }];

  it("файл, записанный build-all-zones, читается: записи субъектов отброшены, остаются зоны", async () => {
    writeZoneDirectoryFile(indexDir, [{ value: 193, text: "Республика Бурятия" }, { value: 232, text: "Республика Бурятия (1 зона)" }, { value: 50, text: "Республика Калмыкия" }], "2026-10-08T00:00:00.000Z");

    expect(await readZoneDirectoryFile(indexDir)).toEqual([
      { priceZoneId: 50, zoneName: "Республика Калмыкия" },
      { priceZoneId: 232, zoneName: "Республика Бурятия (1 зона)" },
    ]);
  });

  it("файл важнее сети; нет файла — справочник берётся из ФГИС ЦС; не получился — null, расчёт идёт как раньше", async () => {
    writeZoneDirectoryFile(indexDir, [{ value: 232, text: "Республика Бурятия (1 зона)" }], "2026-10-08T00:00:00.000Z");
    expect(await loadZoneDirectory({ indexDir, fetchLive: live })).toEqual([{ priceZoneId: 232, zoneName: "Республика Бурятия (1 зона)" }]);

    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(await loadZoneDirectory({ indexDir: empty, fetchLive: live })).toEqual([{ priceZoneId: 50, zoneName: "Республика Калмыкия" }]);
    expect(
      await loadZoneDirectory({
        indexDir: empty,
        fetchLive: async () => {
          throw new Error("таймаут");
        },
      }),
    ).toBeNull();
  });

  it("живой запрос: ответ ФГИС ЦС разбирается, страница ошибки с кодом 200 и код 500 — отказ", async () => {
    const respond = (body: string, init: ResponseInit = {}): typeof fetch => (async () => new Response(body, init)) as unknown as typeof fetch;

    expect(await fetchZoneDirectoryLive(respond(JSON.stringify([{ value: 232, text: "Республика Бурятия (1 зона)" }, { value: 193, text: "Республика Бурятия" }])))).toEqual([
      { priceZoneId: 232, zoneName: "Республика Бурятия (1 зона)" },
    ]);
    await expect(fetchZoneDirectoryLive(respond("<!doctype html><html>ошибка</html>", { headers: { "content-type": "text/html" } }))).rejects.toThrow("HTML-страница");
    await expect(fetchZoneDirectoryLive(respond("x", { status: 500 }))).rejects.toThrow("ответил 500");
  });
});

describe.skipIf(process.platform === "win32")("childProcessZoneBuilder: сборка дочерним процессом", () => {
  /** Корень проекта с поддельным tsx: скрипт пишет аргументы и ведёт себя по переменной окружения. */
  function fakeRoot(shimBody: string): string {
    const root = join(dir, "root");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(root, "scripts", "fsnb"), { recursive: true });
    writeFileSync(join(root, "scripts", "fsnb", "build-all-zones.ts"), "// заглушка");
    const shim = join(root, "node_modules", ".bin", "tsx");
    writeFileSync(shim, `#!/bin/sh\n${shimBody}\n`);
    chmodSync(shim, 0o755);
    return root;
  }
  const context = (signal: AbortSignal, lines: string[] = []) => ({ timeoutMs: 20 * 60_000, signal, log: (message: string) => void lines.push(message) });

  it("запускает build-all-zones.ts --only <зона> с каталогом индекса и ожиданием замка; вывод идёт в журнал", async () => {
    const out = join(dir, "args.txt");
    const root = fakeRoot(`echo "$@" > "${out}"\necho "собрана"`);
    const lines: string[] = [];

    await childProcessZoneBuilder({ indexDir, root })(246, context(new AbortController().signal, lines));

    const args = readFileSync(out, "utf8").trim();
    expect(args).toContain("scripts/fsnb/build-all-zones.ts --only 246 --index " + indexDir);
    expect(args).toContain("--lock-wait-minutes 18");
    expect(lines.join("\n")).toContain("сборка зоны 246: собрана");
  });

  it("ненулевой код выхода — ошибка с хвостом вывода процесса", async () => {
    const root = fakeRoot('echo "зона 246: ОШИБКА — сборка: сплит-форма не разобралась"\nexit 3');

    await expect(childProcessZoneBuilder({ indexDir, root })(246, context(new AbortController().signal))).rejects.toThrow(
      /кодом 3.*сплит-форма не разобралась/,
    );
  });

  it("таймаут: сигнал останавливает дочерний процесс (SIGTERM), а не ждёт его 30 секунд", async () => {
    const root = fakeRoot("exec sleep 30");
    const controller = new AbortController();
    const started = Date.now();

    const running = childProcessZoneBuilder({ indexDir, root })(246, context(controller.signal));
    setTimeout(() => controller.abort(), 100);

    await expect(running).rejects.toThrow(/завершилась с кодом/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
