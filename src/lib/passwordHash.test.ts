import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/passwordHash";

/**
 * Хэш пароля: scrypt с солью. В базе лежит только хэш, по украденной таблице
 * пароль не восстановить, а одинаковые пароли дают разные строки.
 */
describe("passwordHash", () => {
  it("верный пароль проходит, неверный — нет", async () => {
    const stored = await hashPassword("надёжный-пароль-1");

    expect(await verifyPassword("надёжный-пароль-1", stored)).toBe(true);
    expect(await verifyPassword("надёжный-пароль-2", stored)).toBe(false);
  });

  it("пароль в хэше не виден, а соль делает хэши одного пароля разными", async () => {
    const a = await hashPassword("надёжный-пароль-1");
    const b = await hashPassword("надёжный-пароль-1");

    expect(a).not.toContain("надёжный");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
  });

  it("испорченная строка хэша — не совпадение, а не исключение", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc")).toBe(false);
    expect(await verifyPassword("x", "md5$deadbeef")).toBe(false);
  });
});
