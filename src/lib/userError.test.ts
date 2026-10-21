import { afterEach, describe, expect, it, vi } from "vitest";

import { FRIENDLY_LOAD_ERROR, isTechnicalError, userFacingError } from "@/lib/userError";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("userFacingError: технические ошибки не доходят до человека", () => {
  it("сбой соединения с внутренним сервисом — спокойная фраза, подробности в консоли", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = new TypeError("fetch failed — connect ECONNREFUSED 127.0.0.1:18088");

    expect(userFacingError(raw)).toBe(FRIENDLY_LOAD_ERROR);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    "TypeError: fetch failed",
    "HTTP 502: <html>Bad gateway</html>",
    "Unexpected token < in JSON at position 0",
    "HTTP 200: ответ не является JSON — пусто",
    "Cannot read properties of undefined",
    "at run (/app/server.js:10:5)",
  ])("«%s» — техническая", (message) => {
    expect(isTechnicalError(message)).toBe(true);
  });

  it("человеческие причины из наших ручек проходят как есть", () => {
    expect(userFacingError(new Error("Проверка не найдена: такого номера нет"))).toBe("Проверка не найдена: такого номера нет");
    expect(userFacingError("Ни одна смета не подошла под форму 421/пр")).toBe("Ни одна смета не подошла под форму 421/пр");
  });

  it("пусто — запасная фраза; запасную можно задать", () => {
    expect(userFacingError(new Error(""))).toBe(FRIENDLY_LOAD_ERROR);
    expect(userFacingError(undefined, "Не получилось")).toBe("Не получилось");
  });
});
