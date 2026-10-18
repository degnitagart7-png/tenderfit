import { describe, expect, it } from "vitest";

import {
  EVENT_THROTTLE_MS,
  MAX_EVENT_DETAIL_CHARS,
  createEventThrottle,
  normalizeEventDetail,
  normalizeEventEmail,
  throttleKey,
  userEventLabel,
} from "@/domain/userEvents";

describe("ограничитель частоты событий", () => {
  it("пропускает первое событие и глушит повтор в пределах окна", () => {
    let now = 1_000;
    const throttle = createEventThrottle(() => now);

    expect(throttle.allow("feed_open|a@b.ru", 600_000)).toBe(true);
    now += 599_000;
    expect(throttle.allow("feed_open|a@b.ru", 600_000)).toBe(false);
    now += 2_000;
    expect(throttle.allow("feed_open|a@b.ru", 600_000)).toBe(true);
  });

  it("ключи независимы: другой человек и другая закупка не глушатся чужим событием", () => {
    const throttle = createEventThrottle(() => 5);
    expect(throttle.allow(throttleKey("tender_open", "a@b.ru", "T1"), 3_600_000)).toBe(true);
    expect(throttle.allow(throttleKey("tender_open", "a@b.ru", "T2"), 3_600_000)).toBe(true);
    expect(throttle.allow(throttleKey("tender_open", "c@d.ru", "T1"), 3_600_000)).toBe(true);
    expect(throttle.allow(throttleKey("tender_open", "a@b.ru", "T1"), 3_600_000)).toBe(false);
  });

  it("глушённое событие окно не продлевает: через час после первого снова пишется", () => {
    let now = 0;
    const throttle = createEventThrottle(() => now);
    expect(throttle.allow("k", 3_600_000)).toBe(true);
    now = 3_000_000;
    expect(throttle.allow("k", 3_600_000)).toBe(false);
    now = 3_600_001;
    expect(throttle.allow("k", 3_600_000)).toBe(true);
  });

  it("память ограничена: ключей не больше предела", () => {
    const throttle = createEventThrottle(() => 1, 10);
    for (let i = 0; i < 100; i += 1) throttle.allow(`k${String(i)}`, 1_000);
    expect(throttle.size()).toBeLessThanOrEqual(10);
  });

  it("окна заданы для шумных видов: лента — 10 минут, карточка — час", () => {
    expect(EVENT_THROTTLE_MS.feed_open).toBe(600_000);
    expect(EVENT_THROTTLE_MS.tender_open).toBe(3_600_000);
    expect(EVENT_THROTTLE_MS.deep_analysis).toBeUndefined();
  });

  it("ошибки одной ручки у одного человека схлопываются, разных ручек — нет", () => {
    expect(throttleKey("error", "a@b.ru", null, "GET /api/tenders: x")).not.toBe(
      throttleKey("error", "a@b.ru", null, "GET /api/estimate: x"),
    );
  });
});

describe("нормализация записи", () => {
  it("почта — в нижний регистр без пробелов; пустая — null", () => {
    expect(normalizeEventEmail("  Ivan@Firma.RU ")).toBe("ivan@firma.ru");
    expect(normalizeEventEmail("  ")).toBeNull();
    expect(normalizeEventEmail(null)).toBeNull();
  });

  it("подробность режется до 300 знаков, лишние пробелы и нулевые символы убираются", () => {
    const long = normalizeEventDetail("x".repeat(500));
    expect(long?.length).toBe(MAX_EVENT_DETAIL_CHARS);
    expect(normalizeEventDetail("a\u0000b \n  c")).toBe("ab c");
    expect(normalizeEventDetail("   ")).toBeNull();
  });

  it("подписи по-русски, неизвестный вид — как есть", () => {
    expect(userEventLabel("deep_analysis")).toBe("Глубокий анализ");
    expect(userEventLabel("что-то-новое")).toBe("что-то-новое");
  });
});
