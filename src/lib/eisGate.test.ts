// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EIS_BACKOFF_BASE_MS,
  EIS_BACKOFF_MAX_MS,
  EIS_BLOCK_STATUSES,
  EIS_STREAK_FORGET_MS,
  EisBlockedError,
  EisGate,
  eisBackoffMs,
  formatMoscowTime,
  gatedEisFetch,
  isEisBlockStatus,
  isEisBlockedError,
  isEisUrl,
} from "@/lib/eisGate";

/**
 * Затвор запросов к ЕИС: карантин после блокировки, удвоение паузы, сброс по
 * успеху и общее состояние нескольких «процессов» через файл. Часы поддельные,
 * файл — во временном каталоге.
 */

const MIN = 60_000;
/** 11.10.2026 12:42 UTC = 15:42 по Москве. */
const T0 = Date.UTC(2026, 9, 11, 12, 42, 0);

let dir: string;
let file: string;
let clock: number;
const now = (): number => clock;

function gate(options: { file?: string } = {}): EisGate {
  return new EisGate({ file: options.file ?? file, now });
}

function readState(): { blockedUntil: number; streak: number; status: number | null } {
  return JSON.parse(readFileSync(file, "utf-8")) as { blockedUntil: number; streak: number; status: number | null };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tenderfit-eisgate-"));
  file = join(dir, "eis-gate.json");
  clock = T0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("константы и помощники", () => {
  it("сигналы блокировки — 434, 403 и 429, одним набором", () => {
    expect([...EIS_BLOCK_STATUSES].sort()).toEqual([403, 429, 434]);
    expect(isEisBlockStatus(434)).toBe(true);
    expect(isEisBlockStatus(403)).toBe(true);
    expect(isEisBlockStatus(429)).toBe(true);
    expect(isEisBlockStatus(404)).toBe(false);
    expect(isEisBlockStatus(500)).toBe(false);
    expect(isEisBlockStatus(200)).toBe(false);
  });

  it("пауза: 2, 4, 8, 16 минут и потолок 30", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => eisBackoffMs(n) / MIN)).toEqual([2, 4, 8, 16, 30, 30, 30]);
    expect(eisBackoffMs(1)).toBe(EIS_BACKOFF_BASE_MS);
    expect(eisBackoffMs(99)).toBe(EIS_BACKOFF_MAX_MS);
  });

  it("время в Москве: UTC+3", () => {
    expect(formatMoscowTime(T0)).toBe("15:42");
    expect(formatMoscowTime(Date.UTC(2026, 9, 11, 21, 5))).toBe("00:05");
  });

  it("адрес ЕИС: сама площадка и её поддомены, чужие — нет", () => {
    expect(isEisUrl("https://zakupki.gov.ru/epz/order/search")).toBe(true);
    expect(isEisUrl("https://www.zakupki.gov.ru/x")).toBe(true);
    expect(isEisUrl("https://zakupki.kontur.ru/")).toBe(false);
    expect(isEisUrl("https://evil-zakupki.gov.ru.example.com/")).toBe(false);
    expect(isEisUrl("не адрес")).toBe(false);
  });

  it("текст ошибки: код, время и МСК", () => {
    const error = new EisBlockedError(T0, 434);
    expect(error.message).toBe(
      "ЕИС временно ограничила доступ к серверу (HTTP 434), повторим после 15:42 МСК",
    );
    expect(error.retryAt).toBe(T0);
    expect(error.status).toBe(434);
    expect(new EisBlockedError(T0, null).message).toBe(
      "ЕИС временно ограничила доступ к серверу, повторим после 15:42 МСК",
    );
    expect(isEisBlockedError(error)).toBe(true);
    expect(isEisBlockedError(new Error("x"))).toBe(false);
  });
});

describe("EisGate: карантин", () => {
  it("без блокировок затвор открыт и файл не создаётся", () => {
    const g = gate();
    expect(() => g.assertOpen()).not.toThrow();
    g.recordSuccess();
    expect(existsSync(file)).toBe(false);
  });

  it("первая блокировка — карантин на 2 минуты, дальше запросы отказывают без сети", () => {
    const g = gate();
    const error = g.recordBlock(434);

    expect(error).toBeInstanceOf(EisBlockedError);
    expect(error.retryAt).toBe(T0 + 2 * MIN);
    expect(readState()).toMatchObject({ blockedUntil: T0 + 2 * MIN, streak: 1, status: 434 });

    clock = T0 + MIN;
    expect(() => g.assertOpen()).toThrow(/ЕИС временно ограничила доступ к серверу \(HTTP 434\), повторим после 15:44 МСК/);
  });

  it("карантин кончился — затвор открывается сам, ручного сброса нет", () => {
    const g = gate();
    g.recordBlock(434);
    clock = T0 + 2 * MIN;
    expect(() => g.assertOpen()).not.toThrow();
    expect(g.blockedUntil()).toBeNull();
  });

  it("пауза удваивается на подряд идущих блокировках и упирается в 30 минут", () => {
    const g = gate();
    const pauses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const error = g.recordBlock(434);
      pauses.push((error.retryAt - clock) / MIN);
      clock = error.retryAt; // карантин кончился: следующий запрос — проба, и она снова заблокирована
    }
    expect(pauses).toEqual([2, 4, 8, 16, 30, 30, 30]);
    expect(readState().streak).toBe(7);
  });

  it("ответ, пришедший во время карантина, серию не удлиняет", () => {
    const g = gate();
    const first = g.recordBlock(434);
    clock = T0 + 10_000;
    const second = g.recordBlock(434);
    const third = g.recordBlock(403);

    expect(second.retryAt).toBe(first.retryAt);
    expect(third.retryAt).toBe(first.retryAt);
    expect(readState().streak).toBe(1);
  });

  it("успешный ответ сбрасывает серию и карантин", () => {
    const g = gate();
    g.recordBlock(434);
    clock = T0 + 2 * MIN;
    g.recordBlock(434); // проба заблокирована: 4 минуты
    expect(readState().streak).toBe(2);

    g.recordSuccess();
    expect(readState()).toMatchObject({ blockedUntil: 0, streak: 0 });
    expect(() => g.assertOpen()).not.toThrow();

    const next = g.recordBlock(429);
    expect(next.retryAt - clock).toBe(2 * MIN);
  });

  it("серия забывается, если с конца карантина прошло больше двух часов", () => {
    const g = gate();
    g.recordBlock(434);
    clock = T0 + 2 * MIN;
    g.recordBlock(434);
    expect(readState().streak).toBe(2);

    clock = readState().blockedUntil + EIS_STREAK_FORGET_MS + 1;
    const fresh = g.recordBlock(434);
    expect(fresh.retryAt - clock).toBe(2 * MIN);
    expect(readState().streak).toBe(1);
  });
});

describe("EisGate: файл состояния", () => {
  it("два затвора на одном файле видят карантин друг друга (два «процесса»)", () => {
    const a = gate();
    const b = gate();

    a.recordBlock(434);
    expect(() => b.assertOpen()).toThrow(EisBlockedError);

    // Успех во втором процессе снимает карантин и у первого.
    b.recordSuccess();
    expect(() => a.assertOpen()).not.toThrow();
  });

  it("пауза удваивается через границу процессов", () => {
    const a = gate();
    const b = gate();
    const first = a.recordBlock(434);
    clock = first.retryAt;
    const second = b.recordBlock(434);
    expect(second.retryAt - clock).toBe(4 * MIN);
  });

  it("файла нет — карантина нет", () => {
    expect(() => gate({ file: join(dir, "нет", "gate.json") }).assertOpen()).not.toThrow();
  });

  it("битый файл — карантина нет, а следующая блокировка его чинит", () => {
    writeFileSync(file, "{не json", "utf-8");
    const g = gate();
    expect(() => g.assertOpen()).not.toThrow();

    g.recordBlock(434);
    expect(readState().streak).toBe(1);
  });

  it("файл с чужой структурой — карантина нет", () => {
    writeFileSync(file, JSON.stringify({ blockedUntil: "завтра", streak: -3 }), "utf-8");
    expect(() => gate().assertOpen()).not.toThrow();
  });

  it("файл не читается (на месте файла каталог) — карантина нет, затвор не падает", () => {
    mkdirSync(file);
    const g = gate();
    expect(() => g.assertOpen()).not.toThrow();
    expect(() => g.recordSuccess()).not.toThrow();
  });

  it("писать некуда — карантин живёт в памяти процесса, ошибки наружу не идут", () => {
    // Родитель файла — обычный файл: mkdir и запись невозможны.
    const blocker = join(dir, "файл-вместо-каталога");
    writeFileSync(blocker, "x", "utf-8");
    const g = gate({ file: join(blocker, "gate.json") });

    const error = g.recordBlock(434);
    expect(error.retryAt).toBe(T0 + 2 * MIN);
    expect(() => g.assertOpen()).toThrow(EisBlockedError);

    clock = error.retryAt;
    expect(() => g.assertOpen()).not.toThrow();
  });

  it("запись атомарная: временных файлов не остаётся, каталог создаётся", () => {
    const nested = join(dir, "data", "вложенный");
    const g = gate({ file: join(nested, "eis-gate.json") });
    g.recordBlock(434);
    g.recordBlock(434);
    g.recordSuccess();

    expect(readdirSync(nested)).toEqual(["eis-gate.json"]);
  });

  it("удалённый оператором файл работает как сброс", () => {
    const g = gate();
    g.recordBlock(434);
    rmSync(file);
    expect(() => g.assertOpen()).not.toThrow();
  });

  it("путь по умолчанию берётся из EIS_GATE_FILE на момент обращения", () => {
    const custom = join(dir, "custom.json");
    vi.stubEnv("EIS_GATE_FILE", custom);
    try {
      const g = new EisGate({ now });
      g.recordBlock(434);
      expect(existsSync(custom)).toBe(true);
      expect(() => new EisGate({ now }).assertOpen()).toThrow(EisBlockedError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("gatedEisFetch", () => {
  const response = (status: number): Response => new Response("тело", { status });

  it("адрес не ЕИС проходит как есть и затвора не касается", async () => {
    const g = gate();
    g.recordBlock(434);
    const doFetch = vi.fn(async () => response(434));

    const res = await gatedEisFetch("https://zakupki.kontur.ru/api", doFetch, g);

    expect(res.status).toBe(434);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(readState().streak).toBe(1);
  });

  it.each([434, 403, 429])("ответ %i — EisBlockedError и карантин", async (status) => {
    const g = gate();
    const doFetch = vi.fn(async () => response(status));

    await expect(gatedEisFetch("https://zakupki.gov.ru/a", doFetch, g)).rejects.toThrow(
      new RegExp(`\\(HTTP ${String(status)}\\)`),
    );
    expect(g.blockedUntil()?.retryAt).toBe(T0 + 2 * MIN);
  });

  it("в карантине сетевого вызова нет", async () => {
    const g = gate();
    g.recordBlock(434);
    const doFetch = vi.fn(async () => response(200));

    await expect(gatedEisFetch("https://zakupki.gov.ru/a", doFetch, g)).rejects.toBeInstanceOf(EisBlockedError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("проба после карантина проходит, успех сбрасывает серию", async () => {
    const g = gate();
    g.recordBlock(434);
    clock = T0 + 2 * MIN;
    const doFetch = vi.fn(async () => response(200));

    const res = await gatedEisFetch("https://zakupki.gov.ru/a", doFetch, g);

    expect(res.status).toBe(200);
    expect(readState()).toMatchObject({ blockedUntil: 0, streak: 0 });
  });

  it("проба снова заблокирована — пауза удваивается", async () => {
    const g = gate();
    g.recordBlock(434);
    clock = T0 + 2 * MIN;

    await expect(gatedEisFetch("https://zakupki.gov.ru/a", async () => response(434), g)).rejects.toBeInstanceOf(
      EisBlockedError,
    );
    expect(g.blockedUntil()?.retryAt).toBe(clock + 4 * MIN);
  });

  it("сбой сервера 500 серию не сбрасывает и блокировкой не считается", async () => {
    const g = gate();
    g.recordBlock(434);
    clock = T0 + 2 * MIN;

    const res = await gatedEisFetch("https://zakupki.gov.ru/a", async () => response(500), g);
    expect(res.status).toBe(500);
    expect(readState().streak).toBe(1);
  });
});
