import { describe, expect, it } from "vitest";

import { calendarDaysLeft, effectiveDeadlineMs, isDateOnlyDeadline } from "@/domain/deadline";
import { isSubmissionExpired } from "@/domain/scoring";
import { deadlineCountdown } from "@/domain/tenderFacts";
import { formatTimeLeft } from "@/utils/format";

/** Срок ЕИС без времени (полночь UTC) — весь последний день по Москве, подписи днями. */

describe("срок без времени", () => {
  const dateOnly = "2026-10-22T00:00:00+00:00";

  it("узнаётся только полночь UTC; срок со временем — как есть", () => {
    expect(isDateOnlyDeadline(dateOnly)).toBe(true);
    expect(isDateOnlyDeadline("2026-10-22T06:00:00Z")).toBe(false);
    expect(effectiveDeadlineMs("2026-10-22T06:00:00Z")).toBe(Date.parse("2026-10-22T06:00:00Z"));
    // Конец 22.10 по Москве — 20:59:59 UTC.
    expect(effectiveDeadlineMs(dateOnly)).toBe(Date.parse("2026-10-22T20:59:59Z"));
  });

  it("в последний день утром закупка ещё открыта; на следующий день — закрыта", () => {
    expect(isSubmissionExpired(dateOnly, new Date("2026-10-22T05:00:00Z"))).toBe(false);
    expect(isSubmissionExpired(dateOnly, new Date("2026-10-22T21:30:00Z"))).toBe(true);
  });

  it("подписи днями: сегодня/завтра последний день, ещё N дней; без выдуманных часов", () => {
    expect(calendarDaysLeft(dateOnly, new Date("2026-10-22T05:00:00Z"))).toBe(0);
    expect(deadlineCountdown(dateOnly, new Date("2026-10-22T05:00:00Z"))?.text).toBe("сегодня последний день");
    // Вечер 21.10 по Москве (накануне): раньше было «ещё 2 часа».
    expect(deadlineCountdown(dateOnly, new Date("2026-10-21T19:00:00Z"))?.text).toBe("завтра последний день");
    expect(deadlineCountdown(dateOnly, new Date("2026-10-16T09:00:00Z"))?.text).toBe("ещё 6 дней");
    expect(deadlineCountdown(dateOnly, new Date("2026-10-23T09:00:00Z"))?.tone).toBe("closed");
    expect(formatTimeLeft(dateOnly, new Date("2026-10-18T09:00:00Z"))).toBe("осталось 4 дн.");
    expect(formatTimeLeft("2026-10-22T06:00:00Z", new Date("2026-10-18T04:00:00Z"))).toBe("осталось 4 дн. 2 ч");
  });
});
