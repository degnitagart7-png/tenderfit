import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEstimateAuditJob, useEstimateJob } from "./useEstimateJob";

/*
  Оба хука ходят в один адрес и один вид задания; различает их только режим. Тесты
  проверяют, что уходит в запросы и что результат одного режима не попадает в другой.
*/

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const AUDIT = { reports: [], zone: { priceZoneId: 236, zoneName: "Бурятия", basis: "USER", matched: null, northZone: "TERRITORY" }, period: "3 квартал 2026 г.", notRecognized: [] };
const ESTIMATE = { document: null, rejected: [], documentsWithoutBill: [], billItems: 3, tokensUsed: 10 };

describe("useEstimateAuditJob", () => {
  it("ставит задание с mode: audit и отдаёт отчёт аудита", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ job: { id: "j1", status: "completed", error: null, mode: "audit", estimate: null, audit: AUDIT }, reused: false }),
    );
    const { result } = renderHook(() => useEstimateAuditJob());

    await act(async () => {
      await result.current.start({ tenderId: "t1", priceZoneId: 236 });
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/estimate");
    expect(JSON.parse(init.body as string)).toEqual({ tenderId: "t1", priceZoneId: 236, mode: "audit" });
    expect(result.current.status).toBe("done");
    expect(result.current.result).toEqual(AUDIT);
  });

  it("при открытии подгружает последний аудит закупки (?mode=audit), а не последнюю смету", async () => {
    fetchMock.mockResolvedValueOnce(respond({ job: { id: "j1", status: "completed", error: null, mode: "audit", estimate: null, audit: AUDIT } }));
    const { result } = renderHook(() => useEstimateAuditJob("t1"));

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/estimate?tenderId=t1&mode=audit");
  });

  it("задание другого режима не подменяет результат: смета, пришедшая в ответ, аудит не трогает", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ job: { id: "j9", status: "completed", error: null, estimate: ESTIMATE, audit: null } }),
    );
    const { result } = renderHook(() => useEstimateAuditJob("t1"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Ответ разобран, но статус остался «ничего не считали»: чужой режим игнорируется.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.status).toBe("idle");
    expect(result.current.result).toBeNull();
  });

  it("отказ воркера показывается ошибкой задания", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ job: { id: "j2", status: "failed", error: "Ни одна смета не подошла под форму 421/пр", mode: "audit", estimate: null }, reused: false }),
    );
    const { result } = renderHook(() => useEstimateAuditJob());
    await act(async () => {
      await result.current.start({ tenderId: "t1" });
    });
    expect(result.current.status).toBe("failed");
    expect(result.current.error).toContain("форму 421/пр");
  });
});

describe("useEstimateJob: режим сметы прежний", () => {
  it("ставит задание без mode и читает последнюю смету без ?mode", async () => {
    fetchMock.mockResolvedValueOnce(respond({ job: null }));
    const { result } = renderHook(() => useEstimateJob("t1"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/estimate?tenderId=t1");

    fetchMock.mockResolvedValueOnce(
      respond({ job: { id: "j3", status: "completed", error: null, estimate: ESTIMATE }, reused: false }),
    );
    await act(async () => {
      await result.current.start({ tenderId: "t1" });
    });
    const init = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ tenderId: "t1" });
    expect(result.current.status).toBe("done");
    expect(result.current.result).toEqual(ESTIMATE);
  });

  it("аудит, пришедший вместо сметы, смету не подменяет", async () => {
    fetchMock.mockResolvedValueOnce(respond({ job: { id: "j4", status: "completed", error: null, mode: "audit", estimate: null, audit: AUDIT } }));
    const { result } = renderHook(() => useEstimateJob("t1"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.status).toBe("idle");
    expect(result.current.result).toBeNull();
  });
});

describe("show и reset: показать расчёт, открытый из списка «Мои расчёты»", () => {
  const done = (id: string, mode: "estimate" | "audit" = "estimate") => ({
    id,
    status: "completed" as const,
    error: null,
    mode,
    estimate: mode === "estimate" ? (ESTIMATE as never) : null,
    audit: mode === "audit" ? (AUDIT as never) : null,
  });

  it("готовое задание показывается сразу, без запросов; номер доступен для правок ведомости", () => {
    const { result } = renderHook(() => useEstimateJob());

    act(() => result.current.show(done("j10")));

    expect(result.current.status).toBe("done");
    expect(result.current.jobId).toBe("j10");
    expect(result.current.result).toEqual(ESTIMATE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("задание другого режима хук молча пропускает: им займётся хук второго режима", () => {
    const { result } = renderHook(() => useEstimateJob());

    act(() => result.current.show(done("j11", "audit")));

    expect(result.current.status).toBe("idle");
    expect(result.current.result).toBeNull();
  });

  it("идущее задание опрашивается по номеру до конца", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(respond({ job: done("j12") }));
      const { result } = renderHook(() => useEstimateJob());

      act(() => result.current.show({ id: "j12", status: "processing", error: null, mode: "estimate", estimate: null }));
      expect(result.current.status).toBe("running");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(fetchMock.mock.calls[0]![0]).toBe("/api/estimate?jobId=j12");
      expect(result.current.status).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("открыли другой расчёт, пока прежний считался: опрос прежнего обрывается и не затирает показанное", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useEstimateJob());
      act(() => result.current.show({ id: "slow", status: "pending", error: null, mode: "estimate", estimate: null }));
      act(() => result.current.show(done("fast")));

      // Если бы цепочка опроса «slow» жила, она запросила бы его через пять секунд.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.jobId).toBe("fast");
      expect(result.current.status).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset забывает показанное и обрывает опрос", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useEstimateJob());
      act(() => result.current.show({ id: "j13", status: "pending", error: null, mode: "estimate", estimate: null }));

      act(() => result.current.reset());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });

      expect(result.current.status).toBe("idle");
      expect(result.current.result).toBeNull();
      expect(result.current.jobId).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("start возвращает номер поставленного задания — по нему экран пишет адрес ?job=", async () => {
    fetchMock.mockResolvedValueOnce(respond({ job: { id: "j14", status: "pending", error: null, estimate: null }, reused: false }));
    const { result } = renderHook(() => useEstimateJob());

    let id: string | null = null;
    await act(async () => {
      id = await result.current.start({ subject: "Объект", documents: [{ name: "a.txt", text: "x" }] });
    });
    expect(id).toBe("j14");
  });

  it("start, не поставивший задание, возвращает null", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Нет места" }), { status: 503 }));
    const { result } = renderHook(() => useEstimateJob());

    let id: string | null = "x";
    await act(async () => {
      id = await result.current.start({ tenderId: "t1" });
    });
    expect(id).toBeNull();
    expect(result.current.error).toBe("Нет места");
  });
});
