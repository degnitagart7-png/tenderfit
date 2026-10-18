import { describe, expect, it } from "vitest";

import { emailDomain, isBlockedEmailDomain, isGoogleHostedMx, normalizeEmail } from "@/domain/emailPolicy";

/**
 * Какие адреса почты принимает сервис.
 *
 * Регистрация с почтой Google (gmail.com) закрыта по требованию владельца, и
 * правило не должно обходиться регистром букв, точкой в конце домена или
 * псевдонимом «+метка». Домены компаний на Google Workspace определяются по
 * почтовым серверам (MX): адрес вида ivan@firma.ru, письма которого принимает
 * Google, — тоже почта Google.
 */

describe("normalizeEmail", () => {
  it("убирает пробелы и приводит к нижнему регистру", () => {
    expect(normalizeEmail("  Ivan.Petrov@Firma.RU ")).toBe("ivan.petrov@firma.ru");
  });

  it("принимает домены на кириллице", () => {
    expect(normalizeEmail("ivan@почта.рф")).toBe("ivan@почта.рф");
  });

  it("убирает точку в конце домена: «gmail.com.» — это тот же gmail.com", () => {
    expect(normalizeEmail("a@gmail.com.")).toBe("a@gmail.com");
  });

  it.each(["", "ivan", "ivan@", "@firma.ru", "iv an@firma.ru", "a@b", "a@@b.ru", "a@b..ru", "a@-b.ru"])(
    "отклоняет непригодный адрес %j",
    (value) => {
      expect(normalizeEmail(value)).toBeNull();
    },
  );

  it("отклоняет слишком длинный адрес", () => {
    expect(normalizeEmail(`${"a".repeat(250)}@firma.ru`)).toBeNull();
  });
});

describe("emailDomain", () => {
  it("берёт домен после последней собаки", () => {
    expect(emailDomain("ivan@firma.ru")).toBe("firma.ru");
  });
});

describe("isBlockedEmailDomain", () => {
  it.each(["gmail.com", "googlemail.com", "GMAIL.COM", "gmail.com."])("блокирует %s", (domain) => {
    expect(isBlockedEmailDomain(domain)).toBe(true);
  });

  it("блокирует поддомены Google: mail.gmail.com не должен проходить", () => {
    expect(isBlockedEmailDomain("mail.gmail.com")).toBe(true);
  });

  it.each(["yandex.ru", "mail.ru", "firma.ru", "notgmail.com", "gmail.com.evil.ru", "mygooglemail.com"])(
    "пропускает %s: совпадение по подстроке недопустимо",
    (domain) => {
      expect(isBlockedEmailDomain(domain)).toBe(false);
    },
  );
});

describe("isGoogleHostedMx", () => {
  it("почтовые серверы Google — почта Google", () => {
    expect(isGoogleHostedMx(["aspmx.l.google.com", "alt1.aspmx.l.google.com"])).toBe(true);
    expect(isGoogleHostedMx(["smtp.google.com"])).toBe(true);
    expect(isGoogleHostedMx(["ASPMX.L.GOOGLE.COM."])).toBe(true);
    expect(isGoogleHostedMx(["aspmx.googlemail.com"])).toBe(true);
  });

  it("серверы Яндекса и своя почта — не Google", () => {
    expect(isGoogleHostedMx(["mx.yandex.net"])).toBe(false);
    expect(isGoogleHostedMx(["mail.firma.ru"])).toBe(false);
  });

  it("имя, лишь похожее на Google, не считается", () => {
    expect(isGoogleHostedMx(["mx.notgoogle.com", "google.com.evil.ru"])).toBe(false);
  });

  it("пустой список — не Google", () => {
    expect(isGoogleHostedMx([])).toBe(false);
  });
});
