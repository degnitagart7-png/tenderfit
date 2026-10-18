import { describe, expect, it } from "vitest";

import {
  buildAlertEmail,
  classifyBalance,
  decideAlert,
  DEFAULT_LOW_BALANCE_RUB,
  estimateDaysLeft,
  FRESH_ALERT_MEMORY,
  parseAlertMemory,
  parseCreditsResponse,
  REMINDER_INTERVAL_MS,
  resolveAlertConfig,
  summarizeSpend,
  type AlertMemory,
} from "./llmBalanceAlert";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

describe("classifyBalance", () => {
  it("≤ 0 — empty, ниже порога — low, иначе ok", () => {
    expect(classifyBalance(-0.0135, 150)).toBe("empty");
    expect(classifyBalance(0, 150)).toBe("empty");
    expect(classifyBalance(87, 150)).toBe("low");
    expect(classifyBalance(150, 150)).toBe("ok");
    expect(classifyBalance(512, 150)).toBe("ok");
  });
});

describe("resolveAlertConfig", () => {
  it("без ALERT_EMAIL оповещения выключены, порог по умолчанию 150", () => {
    expect(resolveAlertConfig({})).toEqual({ email: null, lowRub: DEFAULT_LOW_BALANCE_RUB });
    expect(DEFAULT_LOW_BALANCE_RUB).toBe(150);
    expect(resolveAlertConfig({ ALERT_EMAIL: "   " }).email).toBeNull();
  });

  it("читает адрес и порог, кривой порог заменяет значением по умолчанию", () => {
    expect(resolveAlertConfig({ ALERT_EMAIL: " a@b.ru ", LLM_BALANCE_ALERT_RUB: "300" })).toEqual({
      email: "a@b.ru",
      lowRub: 300,
    });
    expect(resolveAlertConfig({ ALERT_EMAIL: "a@b.ru", LLM_BALANCE_ALERT_RUB: "много" }).lowRub).toBe(150);
    expect(resolveAlertConfig({ ALERT_EMAIL: "a@b.ru", LLM_BALANCE_ALERT_RUB: "-5" }).lowRub).toBe(150);
  });
});

describe("parseCreditsResponse", () => {
  it("отрицательный баланс — число, а не отсутствие", () => {
    expect(parseCreditsResponse(200, { data: { credits: -0.0135 } })).toBe(-0.0135);
  });

  it("строковое число принимается", () => {
    expect(parseCreditsResponse(200, { data: { credits: "512.5" } })).toBe(512.5);
  });

  it("нет поля credits, чужой формат или нечисло — null", () => {
    expect(parseCreditsResponse(200, { data: {} })).toBeNull();
    expect(parseCreditsResponse(200, {})).toBeNull();
    expect(parseCreditsResponse(200, null)).toBeNull();
    expect(parseCreditsResponse(200, "ok")).toBeNull();
    expect(parseCreditsResponse(200, { data: { credits: "abc" } })).toBeNull();
    expect(parseCreditsResponse(200, { data: { credits: null } })).toBeNull();
    expect(parseCreditsResponse(200, { data: { credits: Number.NaN } })).toBeNull();
  });

  it("не-200 — null, даже если в теле есть число", () => {
    expect(parseCreditsResponse(401, { data: { credits: 100 } })).toBeNull();
    expect(parseCreditsResponse(500, null)).toBeNull();
  });
});

describe("parseAlertMemory", () => {
  it("нет файла, битый JSON и чужой формат — чистое состояние", () => {
    expect(parseAlertMemory(null)).toEqual(FRESH_ALERT_MEMORY);
    expect(parseAlertMemory("{не json")).toEqual(FRESH_ALERT_MEMORY);
    expect(parseAlertMemory("")).toEqual(FRESH_ALERT_MEMORY);
    expect(parseAlertMemory("null")).toEqual(FRESH_ALERT_MEMORY);
    expect(parseAlertMemory('"low"')).toEqual(FRESH_ALERT_MEMORY);
    expect(parseAlertMemory('{"state":"weird","lastSentAt":1}')).toEqual(FRESH_ALERT_MEMORY);
  });

  it("читает корректное состояние; кривую отметку времени отбрасывает", () => {
    expect(parseAlertMemory('{"state":"low","lastSentAt":123}')).toEqual({ state: "low", lastSentAt: 123 });
    expect(parseAlertMemory('{"state":"empty","lastSentAt":"вчера"}')).toEqual({ state: "empty", lastSentAt: null });
  });
});

describe("decideAlert: переходы", () => {
  it("чистое состояние + ok — тишина", () => {
    const d = decideAlert(FRESH_ALERT_MEMORY, "ok", NOW);
    expect(d.action).toBe("none");
  });

  it("ok → low — письмо low, память хранит время отправки", () => {
    const d = decideAlert({ state: "ok", lastSentAt: null }, "low", NOW);
    expect(d.action).toBe("low");
    expect(d.next).toEqual({ state: "low", lastSentAt: NOW });
  });

  it("первая проверка сразу на low (чистый файл) — письмо", () => {
    expect(decideAlert(FRESH_ALERT_MEMORY, "low", NOW).action).toBe("low");
  });

  it("ok → empty и low → empty — письмо empty", () => {
    expect(decideAlert({ state: "ok", lastSentAt: null }, "empty", NOW).action).toBe("empty");
    expect(decideAlert({ state: "low", lastSentAt: NOW - HOUR }, "empty", NOW).action).toBe("empty");
  });

  it("low/empty → ok — одно письмо «пополнен», дальше тишина", () => {
    const first = decideAlert({ state: "low", lastSentAt: NOW - HOUR }, "ok", NOW);
    expect(first.action).toBe("recovered");
    expect(first.next).toEqual({ state: "ok", lastSentAt: NOW });
    expect(decideAlert(first.next, "ok", NOW + HOUR).action).toBe("none");
    expect(decideAlert({ state: "empty", lastSentAt: NOW - HOUR }, "ok", NOW).action).toBe("recovered");
  });

  it("empty → low (пополнили мало) — молча, отметка о последнем письме сохраняется", () => {
    const memory: AlertMemory = { state: "empty", lastSentAt: NOW - 2 * HOUR };
    const d = decideAlert(memory, "low", NOW);
    expect(d.action).toBe("none");
    expect(d.next).toEqual({ state: "low", lastSentAt: NOW - 2 * HOUR });
  });
});

describe("decideAlert: напоминания и дубли", () => {
  it("тот же low до 24 часов — тишина, ровно через 24 часа — напоминание", () => {
    const memory: AlertMemory = { state: "low", lastSentAt: NOW };
    expect(decideAlert(memory, "low", NOW + 30 * 60_000).action).toBe("none");
    expect(decideAlert(memory, "low", NOW + REMINDER_INTERVAL_MS - 1).action).toBe("none");
    const d = decideAlert(memory, "low", NOW + REMINDER_INTERVAL_MS);
    expect(d.action).toBe("reminder");
    expect(d.next.lastSentAt).toBe(NOW + REMINDER_INTERVAL_MS);
  });

  it("empty напоминает так же, раз в сутки", () => {
    const memory: AlertMemory = { state: "empty", lastSentAt: NOW };
    expect(decideAlert(memory, "empty", NOW + 23 * HOUR).action).toBe("none");
    expect(decideAlert(memory, "empty", NOW + 25 * HOUR).action).toBe("reminder");
  });

  it("серия проверок каждые 30 минут даёт одно письмо на переход и одно на сутки", () => {
    let memory: AlertMemory = { state: "ok", lastSentAt: null };
    const actions: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const now = NOW + i * 30 * 60_000;
      const d = decideAlert(memory, "low", now);
      if (d.action !== "none") actions.push(d.action);
      memory = d.next;
    }
    // 50 проверок = 24,5 часа: первое письмо и одно напоминание.
    expect(actions).toEqual(["low", "reminder"]);
  });

  it("состояние без отметки времени (файл правили руками) напоминает сразу", () => {
    expect(decideAlert({ state: "low", lastSentAt: null }, "low", NOW).action).toBe("reminder");
  });
});

describe("summarizeSpend и estimateDaysLeft", () => {
  it("считает 24 часа и 7 суток, старое и будущее отбрасывает", () => {
    const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
    const spend = summarizeSpend(
      [
        { created_at: iso(HOUR), cost_rub: 10 },
        { created_at: iso(30 * HOUR), cost_rub: 20 },
        { created_at: iso(6 * 24 * HOUR), cost_rub: 30 },
        { created_at: iso(8 * 24 * HOUR), cost_rub: 999 },
        { created_at: new Date(NOW + HOUR).toISOString(), cost_rub: 999 },
        { created_at: "мусор", cost_rub: 999 },
      ],
      NOW,
    );
    expect(spend).toEqual({ last24hRub: 10, last7dRub: 60 });
  });

  it("оценивает запас по среднему за неделю", () => {
    expect(estimateDaysLeft(100, 70)).toBe(10);
    expect(estimateDaysLeft(100, 0)).toBeNull();
    expect(estimateDaysLeft(0, 70)).toBeNull();
    expect(estimateDaysLeft(null, 70)).toBeNull();
    expect(estimateDaysLeft(100, null)).toBeNull();
  });
});

describe("buildAlertEmail", () => {
  const spend = { last24hRub: 41.2, last7dRub: 280 };

  it("low: тема с округлённым балансом, расход, прогноз, функции и ссылка", () => {
    const mail = buildAlertEmail("low", "low", { balanceRub: 87.12, lowRub: 150, spend });
    expect(mail.subject).toBe("ТендерФит: баланс ИИ почти закончился — 87 ₽");
    expect(mail.text).toContain("87,12 ₽");
    expect(mail.text).toContain("Расход за 24 часа: 41,20 ₽");
    expect(mail.text).toContain("Расход за 7 дней: 280,00 ₽ (в среднем 40,00 ₽ в день)");
    expect(mail.text).toContain("хватит примерно на 2 дн.");
    expect(mail.text).toContain("глубокий анализ");
    expect(mail.text).toContain("чтение ведомостей и подбор норм ИИ");
    expect(mail.text).toContain("подсказки поиска");
    expect(mail.text).toContain("https://routerai.ru");
  });

  it("empty: тема без суммы, в письме нет прогноза", () => {
    const mail = buildAlertEmail("empty", "empty", { balanceRub: -0.0135, lowRub: 150, spend });
    expect(mail.subject).toBe("ТендерФит: баланс ИИ закончился — анализ и смета с ИИ не работают");
    expect(mail.text).toContain("-0,01 ₽");
    expect(mail.text).not.toContain("хватит");
  });

  it("recovered: тема с суммой", () => {
    const mail = buildAlertEmail("recovered", "ok", { balanceRub: 512, lowRub: 150, spend: null });
    expect(mail.subject).toBe("ТендерФит: баланс ИИ пополнен — 512 ₽");
  });

  it("reminder помечается в теме", () => {
    const mail = buildAlertEmail("reminder", "low", { balanceRub: 87, lowRub: 150, spend: null });
    expect(mail.subject).toBe("ТендерФит: баланс ИИ почти закончился — 87 ₽ (напоминание)");
  });

  it("журнал недоступен — строки про расход опущены; баланс неизвестен — без суммы в теме", () => {
    const mail = buildAlertEmail("low", "low", { balanceRub: 87, lowRub: 150, spend: null });
    expect(mail.text).not.toContain("Расход");
    const unknown = buildAlertEmail("empty", "empty", { balanceRub: null, lowRub: 150, spend: null });
    expect(unknown.text).toContain("узнать не удалось");
  });

  it("запас меньше суток описывается словами", () => {
    const mail = buildAlertEmail("low", "low", { balanceRub: 10, lowRub: 150, spend: { last24hRub: 90, last7dRub: 630 } });
    expect(mail.text).toContain("хватит меньше суток");
  });
});
