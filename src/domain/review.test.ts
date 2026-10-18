import { describe, expect, it } from "vitest";
import type { ManualReviewDecision } from "@/domain/entities";
import {
  canConfirm,
  canDecideWithoutConfirm,
  checklistProgress,
  latestDecision,
  MANUAL_REVIEW_CHECKLIST,
} from "@/domain/review";

function fullChecklist(): Record<string, boolean> {
  return Object.fromEntries(MANUAL_REVIEW_CHECKLIST.map((c) => [c.id, true]));
}

function makeDecision(overrides: Partial<ManualReviewDecision> = {}): ManualReviewDecision {
  return {
    id: "d-1",
    tenderId: "t-1",
    outcome: "CONFIRMED",
    checklist: {},
    comment: "ok",
    systemVerdict: "MANUAL_REVIEW",
    decidedAt: "2026-05-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("checklistProgress", () => {
  it("пустой чек-лист — 0%", () => {
    expect(checklistProgress({})).toEqual({
      done: 0,
      total: MANUAL_REVIEW_CHECKLIST.length,
      percent: 0,
    });
  });

  it("полный чек-лист — 100%", () => {
    expect(checklistProgress(fullChecklist()).percent).toBe(100);
  });

  it("неизвестные ключи не считаются", () => {
    expect(checklistProgress({ bogus: true }).done).toBe(0);
  });
});

describe("canConfirm", () => {
  it("полный чек-лист + комментарий от 5 символов — можно", () => {
    expect(canConfirm(fullChecklist(), "Проверил документы, всё сходится")).toBe(true);
  });

  it("не хватает одного пункта — нельзя", () => {
    const partial = fullChecklist();
    delete partial["spec"];
    expect(canConfirm(partial, "Комментарий длинный")).toBe(false);
  });

  it("короткий/пробельный комментарий — нельзя", () => {
    expect(canConfirm(fullChecklist(), "ок")).toBe(false);
    expect(canConfirm(fullChecklist(), "     ")).toBe(false);
  });
});

describe("canDecideWithoutConfirm", () => {
  it("отклонение требует только комментарий", () => {
    expect(canDecideWithoutConfirm("Требуется разъяснение по п.3")).toBe(true);
    expect(canDecideWithoutConfirm("нет")).toBe(false);
  });
});

describe("latestDecision", () => {
  it("пустая история — null", () => {
    expect(latestDecision([])).toBeNull();
  });

  it("возвращает самое позднее решение", () => {
    const latest = latestDecision([
      makeDecision({ id: "old", decidedAt: "2026-05-01T00:00:00.000Z" }),
      makeDecision({ id: "new", decidedAt: "2026-05-10T00:00:00.000Z" }),
      makeDecision({ id: "mid", decidedAt: "2026-05-05T00:00:00.000Z" }),
    ]);
    expect(latest?.id).toBe("new");
  });
});
