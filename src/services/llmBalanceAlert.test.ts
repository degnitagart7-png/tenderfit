import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  alertStateFile,
  fetchLlmBalance,
  resetLlmBalanceAlertForTests,
  runLlmBalanceCheck,
  sendTestBalanceEmail,
  type BalanceAlertDeps,
} from "./llmBalanceAlert";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const FILE = "/virtual/llm-balance-alert.json";

const ENV = {
  LLM_BASE_URL: "https://routerai.ru/api/v1",
  LLM_API_KEY: "test-key",
  ALERT_EMAIL: "owner@example.test",
  LLM_BALANCE_ALERT_FILE: FILE,
};

function creditsResponse(credits: unknown, status = 200): Response {
  return { status, ok: status === 200, json: async () => ({ data: { credits } }) } as unknown as Response;
}

interface Harness {
  deps: BalanceAlertDeps;
  files: Map<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMail: Mock<any[], any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchFn: Mock<any[], any>;
  logs: string[];
  clock: { now: number };
}

function harness(options: { env?: Record<string, string | undefined>; credits?: unknown; status?: number } = {}): Harness {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const clock = { now: NOW };
  const sendMail = vi.fn(async () => undefined);
  const fetchFn = vi.fn(async () => creditsResponse(options.credits ?? 500, options.status ?? 200));
  const deps: BalanceAlertDeps = {
    env: options.env ?? ENV,
    now: () => clock.now,
    fetchFn: fetchFn as unknown as typeof fetch,
    readFile: (path) => files.get(path) ?? null,
    writeFileAtomic: (path, content) => void files.set(path, content),
    sendMail,
    loadSpendRows: async () => [{ created_at: new Date(NOW - 3600_000).toISOString(), cost_rub: 40 }],
    log: (m) => void logs.push(m),
  };
  return { deps, files, sendMail, fetchFn, logs, clock };
}

beforeEach(() => {
  resetLlmBalanceAlertForTests();
});

describe("fetchLlmBalance", () => {
  it("ходит на {base}/credits с ключом и отдаёт рубли, в том числе отрицательные", async () => {
    const h = harness({ credits: -0.0135 });
    expect(await fetchLlmBalance(h.deps)).toBe(-0.0135);
    const [url, init] = h.fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://routerai.ru/api/v1/credits");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
  });

  it("не-200 даёт null и строку в журнал", async () => {
    const h = harness({ credits: 100, status: 401 });
    expect(await fetchLlmBalance(h.deps)).toBeNull();
    expect(h.logs).toHaveLength(1);
  });

  it("нет поля credits — null", async () => {
    const h = harness();
    h.fetchFn.mockResolvedValueOnce({ status: 200, json: async () => ({ data: {} }) } as unknown as Response);
    expect(await fetchLlmBalance(h.deps)).toBeNull();
  });

  it("сетевой сбой и таймаут не бросаются", async () => {
    const h = harness();
    h.fetchFn.mockRejectedValueOnce(new Error("fetch failed"));
    expect(await fetchLlmBalance(h.deps)).toBeNull();
    h.fetchFn.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    expect(await fetchLlmBalance(h.deps)).toBeNull();
  });

  it("не JSON в ответе и отсутствие ключа — null", async () => {
    const h = harness();
    h.fetchFn.mockResolvedValueOnce({
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Response);
    expect(await fetchLlmBalance(h.deps)).toBeNull();
    const noKey = harness({ env: { ...ENV, LLM_API_KEY: "" } });
    expect(await fetchLlmBalance(noKey.deps)).toBeNull();
    expect(noKey.fetchFn).not.toHaveBeenCalled();
  });
});

describe("runLlmBalanceCheck", () => {
  it("без ALERT_EMAIL ничего не делает и один раз пишет в журнал", async () => {
    const h = harness({ env: { ...ENV, ALERT_EMAIL: undefined } });
    await runLlmBalanceCheck({}, h.deps);
    await runLlmBalanceCheck({}, h.deps);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.logs.filter((m) => m.includes("ALERT_EMAIL"))).toHaveLength(1);
  });

  it("баланс в норме — тишина и файл не создаётся", async () => {
    const h = harness({ credits: 500 });
    const r = await runLlmBalanceCheck({}, h.deps);
    expect(r).toMatchObject({ state: "ok", action: "none", sent: false });
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.files.size).toBe(0);
  });

  it("ok → low: одно письмо с расходом, повторная проверка не шлёт дубль", async () => {
    const h = harness({ credits: 87 });
    const r = await runLlmBalanceCheck({}, h.deps);
    expect(r).toMatchObject({ state: "low", action: "low", sent: true });
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    const [to, subject, text] = h.sendMail.mock.calls[0] as unknown as [string, string, string];
    expect(to).toBe("owner@example.test");
    expect(subject).toBe("ТендерФит: баланс ИИ почти закончился — 87 ₽");
    expect(text).toContain("Расход за 24 часа: 40,00 ₽");
    expect(JSON.parse(h.files.get(FILE) as string)).toEqual({ state: "low", lastSentAt: NOW });

    h.clock.now += 30 * 60_000;
    await runLlmBalanceCheck({}, h.deps);
    expect(h.sendMail).toHaveBeenCalledTimes(1);
  });

  it("через 24 часа напоминает, а после пополнения шлёт одно «пополнен»", async () => {
    const h = harness({ credits: 87 });
    await runLlmBalanceCheck({}, h.deps);
    h.clock.now += DAY;
    await runLlmBalanceCheck({}, h.deps);
    expect(h.sendMail).toHaveBeenCalledTimes(2);
    expect((h.sendMail.mock.calls[1] as unknown as string[])[1]).toContain("(напоминание)");

    h.fetchFn.mockResolvedValue(creditsResponse(512));
    h.clock.now += 60_000;
    await runLlmBalanceCheck({}, h.deps);
    expect((h.sendMail.mock.calls[2] as unknown as string[])[1]).toBe("ТендерФит: баланс ИИ пополнен — 512 ₽");
    await runLlmBalanceCheck({}, h.deps);
    expect(h.sendMail).toHaveBeenCalledTimes(3);
  });

  it("low → empty шлёт письмо сразу, не дожидаясь суток", async () => {
    const h = harness({ credits: 87 });
    await runLlmBalanceCheck({}, h.deps);
    h.fetchFn.mockResolvedValue(creditsResponse(-0.0135));
    h.clock.now += 60_000;
    await runLlmBalanceCheck({}, h.deps);
    expect((h.sendMail.mock.calls[1] as unknown as string[])[1]).toBe(
      "ТендерФит: баланс ИИ закончился — анализ и смета с ИИ не работают",
    );
  });

  it("битый файл состояния считается чистым", async () => {
    const h = harness({ credits: 87 });
    h.files.set(FILE, "{оборвано");
    const r = await runLlmBalanceCheck({}, h.deps);
    expect(r.action).toBe("low");
    expect(JSON.parse(h.files.get(FILE) as string).state).toBe("low");
  });

  it("баланс не получен и 402 не было — тишина; был 402 — считаем исчерпанным", async () => {
    const h = harness();
    h.fetchFn.mockRejectedValue(new Error("fetch failed"));
    expect(await runLlmBalanceCheck({}, h.deps)).toMatchObject({ balanceRub: null, state: null, sent: false });
    expect(h.sendMail).not.toHaveBeenCalled();

    const r = await runLlmBalanceCheck({ saw402: true }, h.deps);
    expect(r).toMatchObject({ state: "empty", action: "empty", sent: true });
  });

  it("402 при заведомо хватающем балансе письма про деньги не шлёт", async () => {
    const h = harness({ credits: 900 });
    const r = await runLlmBalanceCheck({ saw402: true }, h.deps);
    expect(r).toMatchObject({ state: "ok", action: "none", sent: false });
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it("почта упала — память не меняется, следующая проверка пробует снова", async () => {
    const h = harness({ credits: 87 });
    h.sendMail.mockRejectedValueOnce(new Error("SMTP не настроен"));
    const first = await runLlmBalanceCheck({}, h.deps);
    expect(first).toMatchObject({ action: "low", sent: false });
    expect(h.files.has(FILE)).toBe(false);

    const second = await runLlmBalanceCheck({}, h.deps);
    expect(second).toMatchObject({ action: "low", sent: true });
    expect(h.sendMail).toHaveBeenCalledTimes(2);
  });

  it("журнал расхода недоступен — письмо уходит без строк про расход", async () => {
    const h = harness({ credits: 87 });
    h.deps.loadSpendRows = async () => {
      throw new Error("relation does not exist");
    };
    await runLlmBalanceCheck({}, h.deps);
    const text = (h.sendMail.mock.calls[0] as unknown as string[])[2];
    expect(text).not.toContain("Расход");
  });

  it("параллельные вызовы делят одну проверку", async () => {
    const h = harness({ credits: 87 });
    await Promise.all([runLlmBalanceCheck({}, h.deps), runLlmBalanceCheck({}, h.deps)]);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(h.sendMail).toHaveBeenCalledTimes(1);
  });

  it("ошибка записи файла не роняет проверку", async () => {
    const h = harness({ credits: 87 });
    h.deps.writeFileAtomic = () => {
      throw new Error("EACCES");
    };
    await expect(runLlmBalanceCheck({}, h.deps)).resolves.toMatchObject({ action: "low", sent: true });
  });
});

describe("sendTestBalanceEmail", () => {
  it("шлёт тестовое письмо на ALERT_EMAIL", async () => {
    const h = harness({ credits: 87 });
    expect(await sendTestBalanceEmail(h.deps)).toBe("owner@example.test");
    expect((h.sendMail.mock.calls[0] as unknown as string[])[1]).toBe("ТендерФит: тест оповещения о балансе ИИ");
  });

  it("без ALERT_EMAIL бросает", async () => {
    const h = harness({ env: { ...ENV, ALERT_EMAIL: undefined } });
    await expect(sendTestBalanceEmail(h.deps)).rejects.toThrow(/ALERT_EMAIL/);
  });
});

describe("alertStateFile", () => {
  it("LLM_BALANCE_ALERT_FILE переопределяет путь, иначе data/llm-balance-alert.json", () => {
    expect(alertStateFile({ LLM_BALANCE_ALERT_FILE: "/x/y.json" })).toBe("/x/y.json");
    expect(alertStateFile({})).toMatch(/data[\\/]llm-balance-alert\.json$/);
  });
});
