import { describe, expect, it } from "vitest";

import { checkAdminToken } from "@/lib/adminToken";

/**
 * Проверка ключа владельца для ручек, которые меняют настройки сервера.
 *
 * Входа в приложении нет, поэтому запись профилей сбора закрыта общим секретом
 * из переменной окружения: без него любой посетитель сайта мог бы подменить
 * темы, по которым сервер ходит на чужие площадки.
 */
describe("checkAdminToken", () => {
  it("ключ на сервере не задан — ручка выключена, а не открыта", () => {
    expect(checkAdminToken("что-угодно", undefined)).toBe("disabled");
    expect(checkAdminToken("что-угодно", "")).toBe("disabled");
    expect(checkAdminToken("", "   ")).toBe("disabled");
  });

  it("совпадающий ключ принимается", () => {
    expect(checkAdminToken("секрет-123456", "секрет-123456")).toBe("ok");
  });

  it("чужой, пустой и отсутствующий ключ отклоняется", () => {
    expect(checkAdminToken("другой", "секрет-123456")).toBe("denied");
    expect(checkAdminToken("", "секрет-123456")).toBe("denied");
    expect(checkAdminToken(null, "секрет-123456")).toBe("denied");
  });

  it("ключ, являющийся началом настоящего, не проходит", () => {
    expect(checkAdminToken("секрет", "секрет-123456")).toBe("denied");
  });

  it("слишком короткий ключ на сервере считается незаданным: его подобрали бы за минуты", () => {
    expect(checkAdminToken("abc", "abc")).toBe("disabled");
  });
});
