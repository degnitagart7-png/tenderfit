import { describe, expect, it, vi } from "vitest";
import { fetchPaged } from "@/domain/pagedFetch";

/** База из `total` строк; `fetchPage` отдаёт срез и помнит порядок обращений. */
function fakeDb(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ n: i }));
  const calls: Array<{ offset: number; limit: number }> = [];
  const inFlight = { now: 0, max: 0 };
  const fetchPage = vi.fn(async (offset: number, limit: number) => {
    calls.push({ offset, limit });
    inFlight.now += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.now);
    // Поздние страницы отвечают быстрее ранних: порядок прихода не должен влиять на результат.
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, 30 - Math.floor(offset / 100))));
    inFlight.now -= 1;
    return rows.slice(offset, offset + Math.min(limit, 1000));
  });
  const countTotal = vi.fn(async () => total);
  return { rows, calls, inFlight, fetchPage, countTotal };
}

describe("fetchPaged", () => {
  it("короткая выдача — один запрос и без подсчёта", async () => {
    const db = fakeDb(5000);

    const result = await fetchPaged({ limit: 20, offset: 0 }, db);

    expect(result).toHaveLength(20);
    expect(db.fetchPage).toHaveBeenCalledTimes(1);
    expect(db.countTotal).not.toHaveBeenCalled();
  });

  it("больше тысячи строк: все страницы, порядок сохранён", async () => {
    const db = fakeDb(2500);

    const result = await fetchPaged({ limit: 5000, offset: 0 }, db);

    expect(result).toEqual(db.rows);
  });

  it("страницы после первой уходят в базу параллельно", async () => {
    const db = fakeDb(4300);

    await fetchPaged({ limit: 5000, offset: 0 }, db);

    // Первая страница + подсчёт идут вместе, остальные четыре — одновременно.
    expect(db.calls.map((c) => c.offset).sort((a, b) => a - b)).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(db.inFlight.max).toBeGreaterThanOrEqual(4);
  });

  it("последняя страница просит ровно остаток", async () => {
    const db = fakeDb(2300);

    await fetchPaged({ limit: 5000, offset: 0 }, db);

    const last = db.calls.find((c) => c.offset === 2000);
    expect(last?.limit).toBe(300);
  });

  it("неполная первая страница — конец: лишних запросов нет", async () => {
    const db = fakeDb(300);

    const result = await fetchPaged({ limit: 5000, offset: 0 }, db);

    expect(result).toHaveLength(300);
    expect(db.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("ровно тысяча строк: второй страницы нет", async () => {
    const db = fakeDb(1000);

    const result = await fetchPaged({ limit: 5000, offset: 0 }, db);

    expect(result).toHaveLength(1000);
    expect(db.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("limit режет выдачу, даже если строк в базе больше", async () => {
    const db = fakeDb(5000);

    const result = await fetchPaged({ limit: 2500, offset: 0 }, db);

    expect(result).toEqual(db.rows.slice(0, 2500));
  });

  it("смещение учитывается и в подсчёте остатка", async () => {
    const db = fakeDb(3200);

    const result = await fetchPaged({ limit: 5000, offset: 500 }, db);

    expect(result).toEqual(db.rows.slice(500));
  });

  it("ошибка любой страницы — ошибка всей выборки", async () => {
    const db = fakeDb(3000);
    db.fetchPage.mockImplementationOnce(async () => Array.from({ length: 1000 }, (_, i) => ({ n: i })));
    db.fetchPage.mockRejectedValueOnce(new Error("страница 2"));

    await expect(fetchPaged({ limit: 5000, offset: 0 }, db)).rejects.toThrow("страница 2");
  });
});
