import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isInsufficientBalance,
  noteLlmGatewayResponse,
  resetLlmBalanceTriggerForTests,
  TRIGGER_DEBOUNCE_MS,
} from "./llmBalanceTrigger";

const ENV = { ALERT_EMAIL: "owner@example.test" };

function setup(env: Record<string, string | undefined> = ENV) {
  const clock = { now: 1_000_000 };
  const run = vi.fn(async () => undefined);
  const log = vi.fn();
  const call = (status: number, body?: string) =>
    noteLlmGatewayResponse(status, body, { env, now: () => clock.now, run, log });
  return { clock, run, log, call };
}

beforeEach(() => {
  resetLlmBalanceTriggerForTests();
});

describe("isInsufficientBalance", () => {
  it("402 и текст про баланс — да, остальное — нет", () => {
    expect(isInsufficientBalance(402)).toBe(true);
    expect(isInsufficientBalance(400, "Insufficient balance")).toBe(true);
    expect(isInsufficientBalance(400, "Недостаточно средств на балансе")).toBe(true);
    expect(isInsufficientBalance(500, "internal error")).toBe(false);
    expect(isInsufficientBalance(429)).toBe(false);
  });
});

describe("noteLlmGatewayResponse", () => {
  it("402 запускает проверку один раз", () => {
    const t = setup();
    expect(t.call(402, "Insufficient balance")).toBe(true);
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it("не 402 — проверку не запускает", () => {
    const t = setup();
    expect(t.call(500, "boom")).toBe(false);
    expect(t.call(429)).toBe(false);
    expect(t.run).not.toHaveBeenCalled();
  });

  it("без ALERT_EMAIL ничего не запускает и не тратит окно дребезга", () => {
    const off = setup({});
    expect(off.call(402)).toBe(false);
    expect(off.run).not.toHaveBeenCalled();

    const on = setup();
    expect(on.call(402)).toBe(true);
  });

  it("дребезг: не чаще раза в 5 минут, потом снова можно", () => {
    const t = setup();
    expect(t.call(402)).toBe(true);
    t.clock.now += 60_000;
    expect(t.call(402)).toBe(false);
    t.clock.now += TRIGGER_DEBOUNCE_MS - 60_001;
    expect(t.call(402)).toBe(false);
    t.clock.now += 1;
    expect(t.call(402)).toBe(true);
    expect(t.run).toHaveBeenCalledTimes(2);
  });

  it("падение проверки не бросается наружу и попадает в журнал", async () => {
    const t = setup();
    t.run.mockRejectedValueOnce(new Error("сеть"));
    expect(t.call(402)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.log).toHaveBeenCalledTimes(1);
  });

  it("синхронное исключение в запуске не бросается", () => {
    const t = setup();
    t.run.mockImplementationOnce(() => {
      throw new Error("sync");
    });
    expect(() => t.call(402)).not.toThrow();
  });
});
