import { describe, expect, it } from "vitest";
import type { SearchProfile } from "@/domain/entities";
import {
  MAX_SEARCHES_PER_PRESS,
  konturPressPlan,
} from "./konturPressPlan";

function profile(patch: Partial<SearchProfile>): SearchProfile {
  return {
    id: "sp-test",
    name: "Тестовый профиль",
    laws: ["FZ_44", "FZ_223"],
    keywords: [],
    stopWords: [],
    okpd2Codes: [],
    regions: [],
    customerInns: [],
    minPrice: null,
    maxPrice: null,
    onlyOpenForSubmission: false,
    enabled: true,
    ...patch,
  };
}

describe("konturPressPlan", () => {
  it("по умолчанию расходует не больше трёх платных поисков", () => {
    expect(MAX_SEARCHES_PER_PRESS).toBe(3);

    const plan = konturPressPlan(
      [
        profile({
          id: "sp-1",
          keywords: ["автомобиль", "легковой автомобиль", "грузовой автомобиль", "транспортное средство", "автотранспорт"],
        }),
      ],
      null,
    );

    expect(plan.keywords).toEqual(["автомобиль", "легковой автомобиль", "грузовой автомобиль"]);
    expect(plan.spend).toBe(3);
    // Слова сверх потолка видны партнёру: панель скажет, что они не участвуют.
    expect(plan.omitted).toEqual(["транспортное средство", "автотранспорт"]);
  });

  it("профиль ровно под потолок расходует все свои слова", () => {
    const plan = konturPressPlan(
      [profile({ keywords: ["капитальный ремонт", "строительство", "реконструкция"] })],
      null,
    );

    expect(plan.spend).toBe(3);
    expect(plan.omitted).toEqual([]);
  });

  it("одно слово — один платный поиск", () => {
    const plan = konturPressPlan([profile({ keywords: ["ноутбук"] })], null);

    expect(plan.keywords).toEqual(["ноутбук"]);
    expect(plan.spend).toBe(1);
  });

  it("профиль без слов всё равно стоит одного поиска: роут отправляет один запрос", () => {
    const plan = konturPressPlan([profile({ keywords: [] })], null);

    expect(plan.keywords).toEqual([]);
    expect(plan.spend).toBe(1);
    expect(plan.omitted).toEqual([]);
  });

  it("выбранный профиль важнее первого в списке", () => {
    const plan = konturPressPlan(
      [
        profile({ id: "sp-1", name: "Автомобили", keywords: ["автомобиль"] }),
        profile({ id: "sp-2", name: "Строительство", keywords: ["строительство"] }),
      ],
      "sp-2",
    );

    expect(plan.profile?.name).toBe("Строительство");
    expect(plan.keywords).toEqual(["строительство"]);
  });

  it("отключённые профили не участвуют, даже если выбраны явно", () => {
    const plan = konturPressPlan(
      [
        profile({ id: "sp-1", name: "Автомобили", keywords: ["автомобиль"] }),
        profile({ id: "sp-2", name: "Скрытый", keywords: ["секрет"], enabled: false }),
      ],
      "sp-2",
    );

    expect(plan.profile?.id).toBe("sp-1");
    expect(plan.keywords).toEqual(["автомобиль"]);
  });

  it("без включённых профилей тратить нечего: план пустой, а не на один поиск", () => {
    const empty = konturPressPlan([], null);
    expect(empty.profile).toBeNull();
    expect(empty.spend).toBe(0);
    expect(empty.keywords).toEqual([]);

    const allDisabled = konturPressPlan(
      [profile({ id: "sp-1", enabled: false }), profile({ id: "sp-2", enabled: false })],
      null,
    );
    expect(allDisabled.profile).toBeNull();
    expect(allDisabled.spend).toBe(0);
  });

  it("пробелы и пустые слова не становятся отдельным поиском", () => {
    const plan = konturPressPlan(
      [profile({ keywords: ["  ", "ремонт ", "", "стройка"] })],
      null,
    );

    expect(plan.keywords).toEqual(["ремонт", "стройка"]);
    expect(plan.spend).toBe(2);
    expect(plan.omitted).toEqual([]);
  });

  it("повтор слова не оплачивается дважды", () => {
    const plan = konturPressPlan(
      [profile({ keywords: ["ремонт", "Ремонт", "РЕМОНТ ", "стройка", "проект", "надзор"] })],
      null,
    );

    expect(plan.keywords).toEqual(["ремонт", "стройка", "проект"]);
    expect(plan.spend).toBe(3);
    expect(plan.omitted).toEqual(["надзор"]);
  });

  it("потолок задаётся параметром: правило не зашито в функцию", () => {
    const plan = konturPressPlan(
      [profile({ keywords: ["ремонт", "стройка", "проект", "надзор"] })],
      null,
      1,
    );

    expect(plan.keywords).toEqual(["ремонт"]);
    expect(plan.spend).toBe(1);
    expect(plan.omitted).toEqual(["стройка", "проект", "надзор"]);
  });

  it("нулевой потолок не даёт нулевого расхода там, где профиль есть", () => {
    // Профиль выбран, но потолок нулевой: искать нечего, тратить тоже.
    const plan = konturPressPlan([profile({ keywords: ["ремонт"] })], null, 0);

    expect(plan.keywords).toEqual([]);
    expect(plan.spend).toBe(0);
    expect(plan.omitted).toEqual(["ремонт"]);
  });
});
