import { describe, expect, it } from "vitest";

import { runPool } from "@/lib/runPool";

/**
 * Пул параллельных задач.
 *
 * Запись найденных закупок в базу шла по одной: 141 строка — 22 секунды, а
 * человек ждёт конца прогона. Строки независимы (ключ — реестровый номер, дубли
 * убраны раньше), поэтому их можно писать пачкой одновременных запросов.
 */

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runPool", () => {
  it("обрабатывает все элементы", async () => {
    const seen: number[] = [];

    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("одновременно идёт не больше заданного числа задач", async () => {
    let running = 0;
    let peak = 0;

    await runPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick(5);
      running -= 1;
    });

    expect(peak).toBe(4);
  });

  it("параллельность действительно ускоряет: десять задач по 20 мс при четырёх потоках — меньше ста", async () => {
    const started = Date.now();

    await runPool(Array.from({ length: 10 }, (_, i) => i), 4, () => tick(20));

    expect(Date.now() - started).toBeLessThan(100);
  });

  it("сбой одной задачи не останавливает остальные, а первая ошибка пробрасывается в конце", async () => {
    const done: number[] = [];

    await expect(
      runPool([1, 2, 3, 4], 2, async (n) => {
        if (n === 2) throw new Error("сбой 2");
        await tick(2);
        done.push(n);
      }),
    ).rejects.toThrow("сбой 2");

    expect(done.sort()).toEqual([1, 3, 4]);
  });

  it("пустой список и параллельность меньше единицы не ломают пул", async () => {
    await expect(runPool([], 4, async () => undefined)).resolves.toBeUndefined();
    const seen: number[] = [];
    await runPool([1, 2], 0, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([1, 2]);
  });
});
