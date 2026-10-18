import { describe, expect, it } from "vitest";
import type { Tender } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import { demoTenders } from "@/mocks/tenders";
import type { TenderVerdict } from "@/domain/enums";
import {
  calendarDayOffset,
  deadlineDayTone,
  deadlineHistogram,
  groupUrgentByDay,
  hoursUntil,
  isInWork,
  rejectionReason,
  summarizeBudget,
  summarizeVerdicts,
  tallyRejectionReasons,
  todayRank,
  urgencyFactor,
  urgentDayLabel,
} from "@/domain/todayBoard";
import { URGENT_DEADLINE_DAYS } from "@/domain/scoring";

const NOW = new Date("2026-09-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** ISO-срок через `days` суток от NOW; отрицательное — срок уже прошёл. */
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

/** Цена 0 — принятый в домене способ сказать «НМЦ не опубликована». */
function row(spec: {
  days: number;
  fit: number;
  price?: number;
  currency?: string;
}): TenderRow {
  const base = demoTenders[0] as Tender;
  return {
    tender: {
      ...base,
      deadlines: { ...base.deadlines, submissionEnd: inDays(spec.days) },
      financial: {
        ...base.financial,
        price: spec.price === undefined ? 1_000_000 : spec.price,
        currency: spec.currency ?? "RUB",
      },
    },
    /*
      Разбор здесь урезан до одного поля намеренно: проверяемые функции читают
      только `fitScore`, а полный TenderAnalysis в фикстуре создавал бы
      впечатление, что остальные поля на результат влияют.
    */
    analysis: { fitScore: spec.fit } as unknown as TenderRow["analysis"],
    pipelineStatus: "NEW",
  };
}

describe("isInWork", () => {
  it("в работе — взятые человеком статусы, но не «Новые»", () => {
    expect(isInWork("INTERESTING")).toBe(true);
    expect(isInWork("PREPARING_APPLICATION")).toBe(true);
    expect(isInWork("SUBMITTED")).toBe(true);
    // Лента приносит «Новые» сама — это не работа пользователя.
    expect(isInWork("NEW")).toBe(false);
  });

  it("завершённые закупки работой не считаются", () => {
    expect(isInWork("WON")).toBe(false);
    expect(isInWork("LOST")).toBe(false);
    expect(isInWork("SKIPPED")).toBe(false);
  });
});

describe("urgencyFactor", () => {
  it("за горизонтом срочности срок на порядок не влияет", () => {
    expect(urgencyFactor(inDays(60), NOW)).toBe(0);
    expect(urgencyFactor(inDays(30), NOW)).toBe(0);
  });

  it("чем ближе подача, тем выше срочность", () => {
    const soon = urgencyFactor(inDays(2), NOW);
    const later = urgencyFactor(inDays(20), NOW);
    expect(soon).toBeGreaterThan(later);
    expect(soon).toBeLessThanOrEqual(1);
  });

  it("истёкший срок даёт максимум — такие строки отсекаются выше по потоку", () => {
    expect(urgencyFactor(inDays(-1), NOW)).toBe(1);
  });
});

describe("todayRank", () => {
  it("при равном сроке выше тот, кто лучше подходит", () => {
    expect(todayRank(row({ days: 10, fit: 70 }), NOW)).toBeGreaterThan(
      todayRank(row({ days: 10, fit: 40 }), NOW),
    );
  });

  it("близкий срок поднимает закупку при сопоставимом соответствии", () => {
    expect(todayRank(row({ days: 1, fit: 60 }), NOW)).toBeGreaterThan(
      todayRank(row({ days: 25, fit: 60 }), NOW),
    );
  });

  it("горящий срок не поднимает заведомо неподходящую закупку выше подходящей", () => {
    // Ровно та ошибка, ради которой срок взят множителем, а не слагаемым.
    expect(todayRank(row({ days: 0.5, fit: 20 }), NOW)).toBeLessThan(
      todayRank(row({ days: 7, fit: 70 }), NOW),
    );
  });
});

describe("summarizeBudget", () => {
  it("складывает только рублёвые опубликованные цены", () => {
    const res = summarizeBudget([
      row({ days: 5, fit: 60, price: 1_000_000 }),
      row({ days: 5, fit: 60, price: 500_000 }),
    ]);
    expect(res).toEqual({ total: 1_500_000, counted: 2, skipped: 0 });
  });

  it("валюта и отсутствующая цена в сумму не идут, но считаются отдельно", () => {
    const res = summarizeBudget([
      row({ days: 5, fit: 60, price: 1_000_000 }),
      // Пересчёт по выдуманному курсу дал бы на экране число из ниоткуда.
      row({ days: 5, fit: 60, price: 4_000_000, currency: "USD" }),
      row({ days: 5, fit: 60, price: 0 }),
    ]);
    expect(res).toEqual({ total: 1_000_000, counted: 1, skipped: 2 });
  });

  it("пустая подборка даёт нули, а не NaN", () => {
    expect(summarizeBudget([])).toEqual({ total: 0, counted: 0, skipped: 0 });
  });
});

/* ======== Новые функции экрана: даты строятся по локальному времени ======== */

/*
  «Сегодня» считается по локальной дате (как и формат дат на экране), поэтому
  и «сейчас», и сроки здесь собраны локальными конструкторами: тест не зависит
  от часового пояса машины, на которой запущен.
*/
const LOCAL_NOW = new Date(2026, 9, 6, 15, 0); // вторник, 6 октября, 15:00
const at = (dayShift: number, hour: number, minute = 0) =>
  new Date(2026, 9, 6 + dayShift, hour, minute).toISOString();

function verdictRow(spec: {
  end: string;
  verdict?: TenderVerdict;
  blocker?: string;
  negative?: string;
}): TenderRow {
  const base = demoTenders[0] as Tender;
  return {
    tender: { ...base, deadlines: { ...base.deadlines, submissionEnd: spec.end } },
    analysis: {
      verdict: spec.verdict ?? "MANUAL_REVIEW",
      fitScore: 50,
      hardBlockers: spec.blocker ? [{ reason: spec.blocker }] : [],
      negativeFactors: spec.negative ? [{ text: spec.negative }] : [],
    } as unknown as TenderRow["analysis"],
    pipelineStatus: "NEW",
  };
}

describe("summarizeVerdicts", () => {
  it("считает доли и оставляет нулевой вердикт в списке", () => {
    const res = summarizeVerdicts([
      verdictRow({ end: at(5, 10), verdict: "MANUAL_REVIEW" }),
      verdictRow({ end: at(5, 10), verdict: "MANUAL_REVIEW" }),
      verdictRow({ end: at(5, 10), verdict: "MANUAL_REVIEW" }),
      verdictRow({ end: at(5, 10), verdict: "RECOMMENDED" }),
    ]);
    expect(res.total).toBe(4);
    // Порядок фиксирован, нулевая доля нужна легенде.
    expect(res.shares.map((s) => [s.verdict, s.count])).toEqual([
      ["RECOMMENDED", 1],
      ["MANUAL_REVIEW", 3],
      ["NOT_RECOMMENDED", 0],
    ]);
    expect(res.shares[1]!.share).toBeCloseTo(0.75);
    expect(res.shares[2]!.share).toBe(0);
  });

  it("пустой список даёт нули, а не NaN", () => {
    const res = summarizeVerdicts([]);
    expect(res.total).toBe(0);
    expect(res.shares.every((s) => s.count === 0 && s.share === 0)).toBe(true);
  });
});

describe("calendarDayOffset", () => {
  it("срок поздно вечером сегодняшнего дня — это сегодня, а не завтра", () => {
    expect(calendarDayOffset(at(0, 23, 59), LOCAL_NOW)).toBe(0);
    expect(calendarDayOffset(at(1, 0, 1), LOCAL_NOW)).toBe(1);
  });

  it("неразобранная дата даёт null", () => {
    expect(calendarDayOffset("не дата", LOCAL_NOW)).toBeNull();
  });
});

describe("deadlineHistogram", () => {
  it("раскладывает подачу по календарным дням и считает остаток за окном", () => {
    const res = deadlineHistogram(
      [
        verdictRow({ end: at(0, 18) }),
        verdictRow({ end: at(0, 23) }),
        verdictRow({ end: at(1, 9) }),
        verdictRow({ end: at(13, 12) }),
        // Пятнадцатые сутки уже за окном: не теряется, а уходит в «дальше».
        verdictRow({ end: at(14, 12) }),
        verdictRow({ end: at(30, 12) }),
      ],
      LOCAL_NOW,
    );
    expect(res.days).toHaveLength(14);
    expect(res.days[0]!.count).toBe(2);
    expect(res.days[1]!.count).toBe(1);
    expect(res.days[13]!.count).toBe(1);
    expect(res.days[5]!.count).toBe(0);
    expect(res.inWindow).toBe(4);
    expect(res.beyond).toBe(2);
  });

  it("просроченные и отклонённые в столбики не попадают", () => {
    const res = deadlineHistogram(
      [
        // Сегодня, но два часа назад: подать уже нельзя.
        verdictRow({ end: at(0, 13) }),
        verdictRow({ end: at(-3, 12) }),
        verdictRow({ end: at(2, 12), verdict: "NOT_RECOMMENDED" }),
        verdictRow({ end: at(2, 12), verdict: "RECOMMENDED" }),
        verdictRow({ end: "не дата" }),
      ],
      LOCAL_NOW,
    );
    expect(res.inWindow).toBe(1);
    expect(res.days[2]!.count).toBe(1);
    expect(res.beyond).toBe(0);
  });

  it("помечает дни: сегодня, горящие и остальные", () => {
    const { days } = deadlineHistogram([], LOCAL_NOW);
    expect(days[0]!.tone).toBe("today");
    expect(days[1]!.tone).toBe("urgent");
    expect(days[URGENT_DEADLINE_DAYS]!.tone).toBe("urgent");
    expect(days[URGENT_DEADLINE_DAYS + 1]!.tone).toBe("later");
    expect(days[0]!.date.getDate()).toBe(6);
    expect(days[3]!.date.getDate()).toBe(9);
  });

  it("deadlineDayTone: отрицательный сдвиг не падает ниже «сегодня»", () => {
    expect(deadlineDayTone(-1)).toBe("today");
  });
});

describe("tallyRejectionReasons", () => {
  it("берёт первый стоп-фактор, затем негативный фактор, затем заглушку", () => {
    expect(
      rejectionReason(verdictRow({ end: at(5, 10), blocker: "Нет допуска СРО", negative: "Другое" })),
    ).toBe("Нет допуска СРО");
    expect(rejectionReason(verdictRow({ end: at(5, 10), negative: "Цена выше лимита" }))).toBe(
      "Цена выше лимита",
    );
    expect(rejectionReason(verdictRow({ end: at(5, 10) }))).toBe("Не проходит по условиям профиля");
  });

  it("считает причины, сортирует по частоте и даёт долю от всех отклонённых", () => {
    const rejected = [
      ...Array.from({ length: 3 }, () => verdictRow({ end: at(5, 10), blocker: "Нет допуска СРО" })),
      ...Array.from({ length: 2 }, () => verdictRow({ end: at(5, 10), blocker: "Регион вне географии" })),
      verdictRow({ end: at(5, 10), blocker: "Цена вне диапазона" }),
      verdictRow({ end: at(5, 10), blocker: "Нужна лицензия" }),
    ];
    const res = tallyRejectionReasons(rejected, 3);
    expect(res.total).toBe(7);
    expect(res.reasons.map((r) => [r.reason, r.count])).toEqual([
      ["Нет допуска СРО", 3],
      ["Регион вне географии", 2],
      // При равенстве — по первому появлению.
      ["Цена вне диапазона", 1],
    ]);
    expect(res.reasons[0]!.share).toBeCloseTo(3 / 7);
    expect(res.otherCount).toBe(1);
  });

  it("пустой список — без причин и без NaN", () => {
    expect(tallyRejectionReasons([], 5)).toEqual({ total: 0, reasons: [], otherCount: 0 });
  });
});

describe("groupUrgentByDay", () => {
  it("группирует по дням и сортирует по сроку", () => {
    const groups = groupUrgentByDay(
      [
        verdictRow({ end: at(2, 10) }),
        verdictRow({ end: at(0, 20) }),
        verdictRow({ end: at(1, 8) }),
        verdictRow({ end: at(0, 17) }),
      ],
      LOCAL_NOW,
    );
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([
      ["Сегодня", 2],
      ["Завтра", 1],
      ["Послезавтра", 1],
    ]);
    // Внутри группы раньше закрывающаяся идёт первой.
    expect(groups[0]!.rows[0]!.tender.deadlines.submissionEnd).toBe(at(0, 17));
  });

  it("пустые дни групп не создают, а дальние подписываются счётом", () => {
    const groups = groupUrgentByDay([verdictRow({ end: at(3, 9) })], LOCAL_NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Через 3 дн.");
    expect(urgentDayLabel(0)).toBe("Сегодня");
  });
});

describe("hoursUntil", () => {
  it("округляет вверх и не показывает ноль у ещё открытой закупки", () => {
    expect(hoursUntil(at(0, 17, 10), LOCAL_NOW)).toBe(3);
    expect(hoursUntil(at(0, 15, 10), LOCAL_NOW)).toBe(1);
  });

  it("для прошедшего и неразобранного срока — null", () => {
    expect(hoursUntil(at(0, 14), LOCAL_NOW)).toBeNull();
    expect(hoursUntil("не дата", LOCAL_NOW)).toBeNull();
  });
});
