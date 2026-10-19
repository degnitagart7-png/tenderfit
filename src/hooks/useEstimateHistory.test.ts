import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EstimateHistoryItem } from "@/domain/estimate/estimateHistory";
import { useEstimateHistory } from "./useEstimateHistory";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const page = (items: EstimateHistoryItem[], nextCursor: string | null) =>
  new Response(JSON.stringify({ items, nextCursor }), { status: 200 });

function entry(n: number, patch: Partial<EstimateHistoryItem> = {}): EstimateHistoryItem {
  return {
    id: `job-${String(n)}`,
    status: "completed",
    createdAt: `2026-10-20T10:${String(n).padStart(2, "0")}:00.000000+00:00`,
    finishedAt: null,
    mode: "estimate",
    reason: "upload",
    tenderId: null,
    subject: `Объект ${String(n)}`,
    documentNames: null,
    totalRub: null,
    error: null,
    ...patch,
  };
}

describe("useEstimateHistory", () => {
  it("refresh грузит первую страницу; loaded меняется только после ответа", async () => {
    fetchMock.mockResolvedValueOnce(page([entry(2), entry(1)], null));
    const { result } = renderHook(() => useEstimateHistory());
    expect(result.current.loaded).toBe(false);

    await act(async () => result.current.refresh());

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/estimate/history");
    expect(result.current.loaded).toBe(true);
    expect(result.current.items.map((item) => item.id)).toEqual(["job-2", "job-1"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("loadMore берёт следующую страницу по курсору, без повторов", async () => {
    fetchMock.mockResolvedValueOnce(page([entry(4), entry(3)], entry(3).createdAt));
    fetchMock.mockResolvedValueOnce(page([entry(3), entry(2)], null));
    const { result } = renderHook(() => useEstimateHistory());
    await act(async () => result.current.refresh());
    expect(result.current.hasMore).toBe(true);

    await act(async () => result.current.loadMore());

    expect(fetchMock.mock.calls[1]![0]).toBe(`/api/estimate/history?before=${encodeURIComponent(entry(3).createdAt)}`);
    expect(result.current.items.map((item) => item.id)).toEqual(["job-4", "job-3", "job-2"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("повторный refresh вливает новое сверху и обновляет статус, но не сбрасывает долистанное и курсор", async () => {
    fetchMock.mockResolvedValueOnce(page([entry(4, { status: "processing" }), entry(3)], entry(3).createdAt));
    fetchMock.mockResolvedValueOnce(page([entry(2), entry(1)], null));
    const { result } = renderHook(() => useEstimateHistory());
    await act(async () => result.current.refresh());
    await act(async () => result.current.loadMore());

    fetchMock.mockResolvedValueOnce(page([entry(5, { status: "pending" }), entry(4, { status: "completed", totalRub: 7 })], entry(4).createdAt));
    await act(async () => result.current.refresh());

    expect(result.current.items.map((item) => item.id)).toEqual(["job-5", "job-4", "job-3", "job-2", "job-1"]);
    expect(result.current.items[1]).toMatchObject({ status: "completed", totalRub: 7 });
    // Дальше — нечего: курсор остался от последней страницы, а не от свежей первой.
    expect(result.current.hasMore).toBe(false);
  });

  it("loadMore без курсора (всё уже загружено) запроса не делает", async () => {
    fetchMock.mockResolvedValueOnce(page([entry(1)], null));
    const { result } = renderHook(() => useEstimateHistory());
    await act(async () => result.current.refresh());

    await act(async () => result.current.loadMore());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("сбой показывается ошибкой, список не теряется", async () => {
    fetchMock.mockResolvedValueOnce(page([entry(1)], null));
    const { result } = renderHook(() => useEstimateHistory());
    await act(async () => result.current.refresh());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "База недоступна" }), { status: 500 }));
    await act(async () => result.current.refresh());

    expect(result.current.error).toBe("База недоступна");
    expect(result.current.items).toHaveLength(1);
  });

  it("ответ без списка — пустая страница, а не падение", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ job: null }), { status: 200 }));
    const { result } = renderHook(() => useEstimateHistory());
    await act(async () => result.current.refresh());
    expect(result.current.items).toEqual([]);
    expect(result.current.loaded).toBe(true);
  });

  it("пока есть идущий расчёт, список сам перечитывается раз в 15 секунд; когда всё готово — нет", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(page([entry(1, { status: "processing" })], null));
    const { result } = renderHook(() => useEstimateHistory());
    await act(async () => result.current.refresh());
    expect(result.current.items[0]?.status).toBe("processing");

    fetchMock.mockResolvedValueOnce(page([entry(1, { status: "completed", totalRub: 5 })], null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.items[0]?.status).toBe("completed");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
