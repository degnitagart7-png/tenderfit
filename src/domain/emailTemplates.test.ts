import { describe, expect, it } from "vitest";

import { BILLING_URL, buildCodeEmail, buildTrialEndedEmail, buildTrialEndingEmail } from "@/domain/emailTemplates";

/** Письма: у каждого есть тема, текст и HTML; код виден крупно и в тексте. */

describe("письмо с кодом", () => {
  it.each([
    ["register", /регистрации/, /не регистрировались/],
    ["login", /входа/, /не запрашивали код/],
    ["reset", /парол/, /не просили сменить пароль/],
  ] as const)("%s: тема, срок действия и «если это не вы»", (kind, subject, ignore) => {
    const mail = buildCodeEmail({ kind, code: "493021", ttlMinutes: 10 });

    expect(mail.subject).toMatch(subject);
    expect(mail.text).toContain("493021");
    expect(mail.text).toMatch(/10 минут/);
    expect(mail.text).toMatch(ignore);
    expect(mail.html).toContain(">493021<");
    expect(mail.html).toMatch(/10 минут/);
    expect(mail.html).toMatch(ignore);
  });

  it("HTML — полноценный документ с логотипом, а в тексте нет разметки", () => {
    const mail = buildCodeEmail({ kind: "register", code: "000111", ttlMinutes: 10 });

    expect(mail.html).toMatch(/^<!doctype html>/);
    expect(mail.html).toContain("ТендерФит");
    expect(mail.text).not.toMatch(/<[a-z]/i);
  });

  it("код экранируется: в HTML не попадает разметка", () => {
    const mail = buildCodeEmail({ kind: "login", code: "<b>1</b>", ttlMinutes: 10 });

    expect(mail.html).not.toContain("<b>1</b>");
    expect(mail.html).toContain("&lt;b&gt;1&lt;/b&gt;");
  });
});

describe("письма о пробном периоде", () => {
  it("за сутки: тема, срок по Москве и ссылка на оплату", () => {
    const mail = buildTrialEndingEmail({ endsAtMs: Date.parse("2026-10-12T12:30:00Z") });

    expect(mail.subject).toBe("Пробный период закончится завтра");
    expect(mail.text).toContain("12 октября, 15:30 (МСК)");
    expect(mail.text).toContain(BILLING_URL);
    expect(mail.html).toContain(`href="${BILLING_URL}"`);
    expect(BILLING_URL).toBe("https://tender-fit.ru/billing");
  });

  it("после окончания: данные сохранены, ссылка на оплату", () => {
    const mail = buildTrialEndedEmail();

    expect(mail.subject).toBe("Пробный период закончился");
    expect(mail.text).toMatch(/сохранены/);
    expect(mail.text).toContain(BILLING_URL);
    expect(mail.html).toContain(`href="${BILLING_URL}"`);
  });
});
