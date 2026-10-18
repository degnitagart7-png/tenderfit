import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insert = vi.fn();
const from = vi.fn(() => ({ insert }));
vi.mock("@/lib/supabase", () => ({ getSupabaseServerClient: () => ({ from }) }));

import { recordUserEvent, resetUserEventLogForTests } from "@/services/userEventLog";

/**
 * Журнал действий: запись не бросает и не мешает ручке ни при каких сбоях.
 * Выключатель USER_EVENTS_DISABLED в тестах включён глобально (vitest.config) —
 * здесь он снят, чтобы проверить саму запись.
 */

const warn = vi.spyOn(console, "warn");

beforeEach(() => {
  vi.stubEnv("USER_EVENTS_DISABLED", "");
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
  from.mockClear();
  resetUserEventLogForTests();
  warn.mockReset();
  warn.mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recordUserEvent", () => {
  it("пишет строку: почта в нижнем регистре, подробность до 300 знаков", async () => {
    await recordUserEvent({ email: " Ivan@Firma.RU ", kind: "deep_analysis", tenderId: "T1", detail: "я".repeat(400) });

    expect(from).toHaveBeenCalledWith("user_events");
    const row = insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row["email"]).toBe("ivan@firma.ru");
    expect(row["kind"]).toBe("deep_analysis");
    expect(row["ok"]).toBe(true);
    expect(row["tender_id"]).toBe("T1");
    expect((row["detail"] as string).length).toBe(300);
  });

  it("ok = false и подробность отказа доходят до базы", async () => {
    await recordUserEvent({ email: "a@b.ru", kind: "deep_analysis", ok: false, detail: "отказ: лимит" });
    expect(insert.mock.calls[0]?.[0]).toMatchObject({ ok: false, detail: "отказ: лимит" });
  });

  it("без почты (служебный ключ, разработка) — ничего не пишет", async () => {
    await recordUserEvent({ email: null, kind: "feed_open" });
    await recordUserEvent({ email: undefined, kind: "feed_open" });
    await recordUserEvent({ email: "  ", kind: "feed_open" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("выключатель USER_EVENTS_DISABLED=1 отключает запись", async () => {
    vi.stubEnv("USER_EVENTS_DISABLED", "1");
    await recordUserEvent({ email: "a@b.ru", kind: "login" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("открытие ленты — не чаще раза в 10 минут на человека", async () => {
    await recordUserEvent({ email: "a@b.ru", kind: "feed_open" });
    await recordUserEvent({ email: "a@b.ru", kind: "feed_open" });
    await recordUserEvent({ email: "c@d.ru", kind: "feed_open" });
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("карточка — раз в час на человека и закупку; другая закупка пишется", async () => {
    await recordUserEvent({ email: "a@b.ru", kind: "tender_open", tenderId: "T1" });
    await recordUserEvent({ email: "a@b.ru", kind: "tender_open", tenderId: "T1" });
    await recordUserEvent({ email: "a@b.ru", kind: "tender_open", tenderId: "T2" });
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("значимые действия (анализ, смета, вход) не глушатся", async () => {
    await recordUserEvent({ email: "a@b.ru", kind: "deep_analysis" });
    await recordUserEvent({ email: "a@b.ru", kind: "deep_analysis" });
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("ответ базы с ошибкой не бросается; таблицы нет — одно предупреждение, а не по одному на событие", async () => {
    insert.mockResolvedValue({ error: { code: "42P01", message: "relation does not exist" } });

    await expect(recordUserEvent({ email: "a@b.ru", kind: "login" })).resolves.toBeUndefined();
    await expect(recordUserEvent({ email: "a@b.ru", kind: "login" })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("20261014000022_user_events.sql");
  });

  it("insert отклонён или бросил исключение — не бросается", async () => {
    insert.mockRejectedValueOnce(new Error("сеть"));
    await expect(recordUserEvent({ email: "a@b.ru", kind: "login" })).resolves.toBeUndefined();

    insert.mockImplementationOnce(() => {
      throw new Error("синхронный сбой");
    });
    await expect(recordUserEvent({ email: "a@b.ru", kind: "login" })).resolves.toBeUndefined();
  });

  it("клиент базы не создаётся (нет SUPABASE_URL) — тоже не бросается", async () => {
    from.mockImplementationOnce(() => {
      throw new Error("SUPABASE_URL is not set");
    });
    await expect(recordUserEvent({ email: "a@b.ru", kind: "login" })).resolves.toBeUndefined();
  });
});
