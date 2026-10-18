import { describe, expect, it, vi } from "vitest";

import { createFitCache, judgeBySense, type Judge } from "@/services/semanticGate";

/**
 * Отбор закупок региона по смыслу.
 *
 * Слова профиля плохо описывают сферу: из 291 открытой закупки Бурятии по словам
 * «строительство, ремонт» остались «ремонт автобусов» и «ремонт офисной техники»,
 * а «Благоустройство территории», «Устройство тротуара», «Сети водоснабжения»
 * были выброшены (05.10.2026). Модель решает по смыслу; решения кэшируются,
 * чтобы каждый прогон платил только за новые закупки.
 */

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${String(i)}`, subject: `Закупка ${String(i)}` }));

function judgeAll(fit: "yes" | "maybe" | "no"): Judge & { calls: number[] } {
  const calls: number[] = [];
  const judge = vi.fn(async (_topic: string, batch: ReadonlyArray<{ id: string }>) => {
    calls.push(batch.length);
    return Object.fromEntries(batch.map((b) => [b.id, fit]));
  }) as unknown as Judge & { calls: number[] };
  (judge as { calls: number[] }).calls = calls;
  return judge;
}

describe("judgeBySense", () => {
  it("спрашивает модель пачками по тридцать и возвращает решение по каждой закупке", async () => {
    const judge = judgeAll("yes");

    const result = await judgeBySense({ topic: "стройка", items: items(65), judge, cache: createFitCache() });

    expect(judge.calls).toEqual([30, 30, 5]);
    expect(result.size).toBe(65);
    expect(result.get("r0")).toBe("yes");
  });

  it("уже решённое берётся из кэша: модель не спрашивается повторно", async () => {
    const cache = createFitCache();
    await judgeBySense({ topic: "стройка", items: items(10), judge: judgeAll("no"), cache });
    const second = judgeAll("yes");

    const result = await judgeBySense({ topic: "стройка", items: items(12), judge: second, cache });

    expect(second.calls).toEqual([2]);
    expect(result.get("r0")).toBe("no");
    expect(result.get("r11")).toBe("yes");
  });

  it("кэш различает темы: решение для «стройки» не подходит «юристам»", async () => {
    const cache = createFitCache();
    await judgeBySense({ topic: "стройка", items: items(3), judge: judgeAll("yes"), cache });
    const lawyers = judgeAll("no");

    await judgeBySense({ topic: "юристы", items: items(3), judge: lawyers, cache });

    expect(lawyers.calls).toEqual([3]);
  });

  it("сбой модели на пачке — по ней решения нет, остальные пачки решены", async () => {
    let call = 0;
    const judge: Judge = async (_topic, batch) => {
      call += 1;
      if (call === 1) throw new Error("шлюз недоступен");
      return Object.fromEntries(batch.map((b) => [b.id, "yes" as const]));
    };

    const result = await judgeBySense({ topic: "стройка", items: items(40), judge, cache: createFitCache() });

    expect(result.size).toBe(10);
  });

  it("предел числа закупок за прогон: остальное решится в следующий раз", async () => {
    const judge = judgeAll("yes");

    const result = await judgeBySense({ topic: "стройка", items: items(100), judge, cache: createFitCache(), limit: 45 });

    expect(judge.calls.reduce((a, b) => a + b, 0)).toBe(45);
    expect(result.size).toBe(45);
  });
});

describe("createFitCache", () => {
  it("переживает сохранение и загрузку, старые записи выбрасываются", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    const cache = createFitCache();
    cache.set("стройка", "r1", "yes", now - 40 * 86_400_000);
    cache.set("стройка", "r2", "no", now);

    const restored = createFitCache(cache.serialize(now));

    expect(restored.get("стройка", "r1")).toBeUndefined();
    expect(restored.get("стройка", "r2")).toBe("no");
  });

  it("испорченный файл кэша — пустой кэш, а не падение прогона", () => {
    expect(createFitCache("{не json").get("x", "y")).toBeUndefined();
    expect(createFitCache('{"entries": 5}').get("x", "y")).toBeUndefined();
  });
});
