import { describe, expect, it } from "vitest";

import { decideTrialNotice, type TrialNoticeCandidate } from "@/domain/trialNotices";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const H = 3_600_000;
const D = 24 * H;
const none = new Set<string>();

const user = (over: Partial<TrialNoticeCandidate>): TrialNoticeCandidate => ({
  id: "u1",
  email: "ivan@firma.ru",
  trialEndsAt: NOW + 10 * D,
  paidUntil: null,
  noticeSentAt: null,
  endNoticeSentAt: null,
  ...over,
});

describe("decideTrialNotice", () => {
  it("за 24 часа и меньше — письмо «закончится завтра»", () => {
    expect(decideTrialNotice(user({ trialEndsAt: NOW + 24 * H }), NOW, none)).toBe("ending");
    expect(decideTrialNotice(user({ trialEndsAt: NOW + H }), NOW, none)).toBe("ending");
  });

  it("раньше чем за сутки — рано", () => {
    expect(decideTrialNotice(user({ trialEndsAt: NOW + 24 * H + 1 }), NOW, none)).toBeNull();
    expect(decideTrialNotice(user({ trialEndsAt: NOW + 2 * D }), NOW, none)).toBeNull();
  });

  it("письмо за сутки уже уходило — второго нет", () => {
    expect(decideTrialNotice(user({ trialEndsAt: NOW + H, noticeSentAt: NOW - H }), NOW, none)).toBeNull();
  });

  it("период кончился — письмо «закончился»", () => {
    expect(decideTrialNotice(user({ trialEndsAt: NOW - 1 }), NOW, none)).toBe("ended");
    expect(decideTrialNotice(user({ trialEndsAt: NOW }), NOW, none)).toBe("ended");
  });

  it("письмо «закончился» уходило — второго нет", () => {
    expect(decideTrialNotice(user({ trialEndsAt: NOW - H, endNoticeSentAt: NOW }), NOW, none)).toBeNull();
  });

  it("кончился давно (больше недели) — устаревшее напоминание не шлём", () => {
    expect(decideTrialNotice(user({ trialEndsAt: NOW - 8 * D }), NOW, none)).toBeNull();
    expect(decideTrialNotice(user({ trialEndsAt: NOW - 6 * D }), NOW, none)).toBe("ended");
  });

  it("платившим писем нет, как и администраторам и тем, у кого срока нет", () => {
    expect(decideTrialNotice(user({ trialEndsAt: NOW + H, paidUntil: NOW + 30 * D }), NOW, none)).toBeNull();
    expect(decideTrialNotice(user({ trialEndsAt: NOW - H, paidUntil: NOW - D }), NOW, none)).toBeNull();
    expect(decideTrialNotice(user({ trialEndsAt: NOW + H, email: "Owner@Firma.ru" }), NOW, new Set(["owner@firma.ru"]))).toBeNull();
    expect(decideTrialNotice(user({ trialEndsAt: null }), NOW, none)).toBeNull();
  });
});
