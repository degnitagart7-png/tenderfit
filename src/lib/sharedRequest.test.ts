import { describe, expect, it, vi } from "vitest";
import { createSharedRequestCache } from "@/lib/sharedRequest";

/** Общий запрос: одновременные вызовы делят обмен с сервером, свежий ответ живёт недолго. */
describe("createSharedRequestCache", () => {
  it("одновременные вызовы делят один запрос", async () => {
    const cache = createSharedRequestCache<number>(1000);
    const load = vi.fn(async () => 7);

    const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);

    expect([a, b]).toEqual([7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("свежий ответ отдаётся без запроса, а по истечении срока — спрашиваем заново", async () => {
    let time = 0;
    const cache = createSharedRequestCache<number>(1000, () => time);
    const load = vi.fn(async () => 1);

    await cache.get("k", load);
    time = 999;
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);

    time = 1000;
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("разные ключи не мешают друг другу", async () => {
    const cache = createSharedRequestCache<string>(1000);
    const load = vi.fn(async () => "x");

    await Promise.all([cache.get("a", load), cache.get("b", load)]);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ошибка не запоминается", async () => {
    const cache = createSharedRequestCache<number>(1000);
    const load = vi.fn<[], Promise<number>>().mockRejectedValueOnce(new Error("сеть")).mockResolvedValueOnce(5);

    await expect(cache.get("k", load)).rejects.toThrow("сеть");
    await expect(cache.get("k", load)).resolves.toBe(5);
  });

  it("синхронный сбой загрузчика тоже превращается в отказ промиса", async () => {
    const cache = createSharedRequestCache<number>(1000);
    await expect(
      cache.get("k", () => {
        throw new Error("сразу");
      }),
    ).rejects.toThrow("сразу");
  });

  it("invalidate: следующий вызов не примыкает к запросу, начатому до сброса", async () => {
    const cache = createSharedRequestCache<string>(1000);
    let release: (v: string) => void = () => undefined;
    const slow = cache.get("k", () => new Promise<string>((resolve) => (release = resolve)));

    cache.invalidate("k");
    const fresh = await cache.get("k", async () => "новое");
    release("старое");

    expect(fresh).toBe("новое");
    // Кто ждал старый запрос, получает его результат.
    await expect(slow).resolves.toBe("старое");
    // А запоздавший старый ответ не вытеснил новый из памяти.
    const load = vi.fn(async () => "третье");
    await expect(cache.get("k", load)).resolves.toBe("новое");
    expect(load).not.toHaveBeenCalled();
  });

  it("invalidate без ключа забывает всё", async () => {
    const cache = createSharedRequestCache<number>(1000);
    const load = vi.fn(async () => 1);
    await cache.get("a", load);
    await cache.get("b", load);

    cache.invalidate();
    await cache.get("a", load);
    await cache.get("b", load);

    expect(load).toHaveBeenCalledTimes(4);
  });
});
