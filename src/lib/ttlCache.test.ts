import { describe, expect, it } from "vitest";

import { createTtlCache } from "@/lib/ttlCache";

/**
 * Кэш ответов модели.
 *
 * Один и тот же запрос люди повторяют: переоткрыли страницу, нажали кнопку
 * ещё раз. Каждый такой повтор без кэша — платный вызов за тот же ответ.
 * Размер ограничен намеренно: долгоживущий процесс сервера не должен копить
 * ответы бесконечно.
 */
describe("createTtlCache", () => {
  it("отдаёт сохранённое значение", () => {
    const cache = createTtlCache<string>({ ttlMs: 1000, maxEntries: 10 });
    cache.set("a", "1", 0);

    expect(cache.get("a", 500)).toBe("1");
  });

  it("по истечении срока значения нет", () => {
    const cache = createTtlCache<string>({ ttlMs: 1000, maxEntries: 10 });
    cache.set("a", "1", 0);

    expect(cache.get("a", 1000)).toBeUndefined();
  });

  it("при переполнении вытесняется самая старая запись", () => {
    const cache = createTtlCache<string>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set("a", "1", 0);
    cache.set("b", "2", 1);
    cache.set("c", "3", 2);

    expect(cache.get("a", 3)).toBeUndefined();
    expect(cache.get("b", 3)).toBe("2");
    expect(cache.get("c", 3)).toBe("3");
  });

  it("перезапись обновляет срок жизни", () => {
    const cache = createTtlCache<string>({ ttlMs: 1000, maxEntries: 10 });
    cache.set("a", "1", 0);
    cache.set("a", "2", 900);

    expect(cache.get("a", 1500)).toBe("2");
  });

  it("неизвестный ключ — undefined", () => {
    expect(createTtlCache<string>({ ttlMs: 1, maxEntries: 1 }).get("x", 0)).toBeUndefined();
  });
});
