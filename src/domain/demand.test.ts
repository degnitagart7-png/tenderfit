import { describe, expect, it } from "vitest";

import {
  DEMAND_TTL_DAYS,
  MAX_DEMAND_KEYWORDS,
  buildDemandProfiles,
  parseDemandReport,
  type DemandRow,
} from "@/domain/demand";

/**
 * Спрос посетителей на темы закупок.
 *
 * Сервер собирает закупки не по набору владельца, а по объединению тем всех
 * активных посетителей: сто человек с запросом «юрист» дают один запрос к
 * площадкам, а тема, которую никто не открывал две недели, перестаёт собираться.
 */

const VISITOR = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const NOW = Date.parse("2026-10-05T12:00:00Z");

function report(profiles: unknown, visitorId: unknown = VISITOR) {
  return parseDemandReport({ visitorId, profiles });
}

describe("parseDemandReport", () => {
  it("берёт слова включённых профилей, чистит их и приводит к нижнему регистру", () => {
    const result = report([
      { keywords: ["  Юридические   услуги ", "Юрист"], laws: ["FZ_44"], enabled: true },
      { keywords: ["Ремонт"], laws: ["FZ_44"], enabled: false },
    ]);

    expect(result).toEqual({
      ok: true,
      visitorId: VISITOR,
      entries: [
        { keyword: "юридические услуги", laws: ["FZ_44"], regions: [] },
        { keyword: "юрист", laws: ["FZ_44"], regions: [] },
      ],
    });
  });

  it("одно слово из двух профилей — одна запись с объединением законов", () => {
    const result = report([
      { keywords: ["юрист"], laws: ["FZ_44"], enabled: true },
      { keywords: ["Юрист"], laws: ["FZ_223"], enabled: true },
    ]);

    expect(result.ok && result.entries).toEqual([{ keyword: "юрист", laws: ["FZ_44", "FZ_223"], regions: [] }]);
  });

  /*
    Регион в спросе. Посетитель из Бурятии ждёт закупки Бурятии, и плановый
    сбор обязан искать их там, а не по всей России, где его регион тонет.
  */
  it("регионы профиля попадают в запись слова", () => {
    const result = report([{ keywords: ["строительство"], laws: ["FZ_44"], regions: ["республика  Бурятия"], enabled: true }]);

    expect(result.ok && result.entries).toEqual([
      { keyword: "строительство", laws: ["FZ_44"], regions: ["республика Бурятия"] },
    ]);
  });

  it("слово из двух профилей: регионы объединяются, а если у одного региона нет — вся Россия", () => {
    const both = report([
      { keywords: ["ремонт"], laws: ["FZ_44"], regions: ["Бурятия"], enabled: true },
      { keywords: ["ремонт"], laws: ["FZ_44"], regions: ["Москва"], enabled: true },
    ]);
    const nationwide = report([
      { keywords: ["ремонт"], laws: ["FZ_44"], regions: ["Бурятия"], enabled: true },
      { keywords: ["ремонт"], laws: ["FZ_44"], regions: [], enabled: true },
    ]);

    expect(both.ok && both.entries[0]?.regions).toEqual(["Бурятия", "Москва"]);
    expect(nationwide.ok && nationwide.entries[0]?.regions).toEqual([]);
  });

  it("слова больше предела обрезаются: хвост не принимается", () => {
    const words = Array.from({ length: MAX_DEMAND_KEYWORDS + 5 }, (_, i) => `слово${String.fromCharCode(1072 + i)}`);

    const result = report([{ keywords: words, laws: ["FZ_44"], enabled: true }]);

    expect(result.ok && result.entries).toHaveLength(MAX_DEMAND_KEYWORDS);
  });

  it("мусорные слова (один знак, только символы) пропускаются, а не роняют отчёт", () => {
    const result = report([{ keywords: ["а", "<>", "юрист"], laws: ["FZ_44"], enabled: true }]);

    expect(result.ok && result.entries.map((e) => e.keyword)).toEqual(["юрист"]);
  });

  it("нет включённых профилей — пустой спрос: так посетитель снимает свои темы", () => {
    const result = report([{ keywords: ["юрист"], laws: ["FZ_44"], enabled: false }]);

    expect(result).toEqual({ ok: true, visitorId: VISITOR, entries: [] });
  });

  it("идентификатор посетителя непригоден — отказ", () => {
    expect(report([], "x").ok).toBe(false);
    expect(report([], "../../etc/passwd-aaaaaaaaaa").ok).toBe(false);
    expect(report([], 42).ok).toBe(false);
  });

  it("профилей больше предела — отказ", () => {
    const many = Array.from({ length: 6 }, () => ({ keywords: ["юрист"], laws: ["FZ_44"], enabled: true }));

    expect(report(many).ok).toBe(false);
  });

  it("закон вне списка — отказ", () => {
    expect(report([{ keywords: ["юрист"], laws: ["XX"], enabled: true }]).ok).toBe(false);
  });

  it("не список профилей — отказ", () => {
    expect(report({ a: 1 }).ok).toBe(false);
  });
});

function row(over: Partial<DemandRow> = {}): DemandRow {
  return {
    visitor_id: "v1",
    keyword: "юрист",
    laws: ["FZ_44", "FZ_223"],
    regions: [],
    last_seen_at: "2026-10-05T10:00:00Z",
    ...over,
  };
}

const keywordsOf = (profiles: ReturnType<typeof buildDemandProfiles>) => profiles.flatMap((p) => p.keywords);

describe("buildDemandProfiles", () => {
  const opts = { nowMs: NOW, maxKeywords: 30, exclude: new Map<string, string[]>() };

  it("нет спроса — нет профилей", () => {
    expect(buildDemandProfiles([], opts)).toEqual([]);
  });

  it("тема, которую два посетителя ждут, собирается один раз", () => {
    const profiles = buildDemandProfiles([row({ visitor_id: "v1" }), row({ visitor_id: "v2" })], opts);

    expect(keywordsOf(profiles)).toEqual(["юрист"]);
  });

  it("тема, которую никто не открывал дольше срока, не собирается", () => {
    const stale = new Date(NOW - (DEMAND_TTL_DAYS + 1) * 86_400_000).toISOString();

    expect(buildDemandProfiles([row({ last_seen_at: stale })], opts)).toEqual([]);
  });

  it("при нехватке места первыми идут темы с большим числом посетителей", () => {
    const rows = [
      row({ visitor_id: "v1", keyword: "редкое" }),
      row({ visitor_id: "v1", keyword: "популярное" }),
      row({ visitor_id: "v2", keyword: "популярное" }),
    ];

    const profiles = buildDemandProfiles(rows, { ...opts, maxKeywords: 1 });

    expect(keywordsOf(profiles)).toEqual(["популярное"]);
  });

  it("при равенстве побеждает более свежая тема", () => {
    const rows = [
      row({ keyword: "старая", last_seen_at: "2026-10-04T10:00:00Z" }),
      row({ keyword: "свежая", last_seen_at: "2026-10-05T11:00:00Z" }),
    ];

    expect(keywordsOf(buildDemandProfiles(rows, { ...opts, maxKeywords: 1 }))).toEqual(["свежая"]);
  });

  it("слова, уже собираемые по профилям владельца, не повторяются", () => {
    const profiles = buildDemandProfiles([row(), row({ keyword: "ремонт" })], {
      ...opts,
      exclude: new Map([["юрист", []]]),
    });

    expect(keywordsOf(profiles)).toEqual(["ремонт"]);
  });

  it("законы объединяются по всем, кто ждёт тему, а цены и коды не берутся: ими лента отбирает уже у человека", () => {
    const profiles = buildDemandProfiles(
      [row({ visitor_id: "v1", laws: ["FZ_44"] }), row({ visitor_id: "v2", laws: ["COMMERCIAL"] })],
      opts,
    );

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ laws: ["FZ_44", "COMMERCIAL"], minPrice: null, maxPrice: null, enabled: true });
  });

  it("темы с разным набором законов идут разными профилями: чужой закон не расширяет запрос", () => {
    const profiles = buildDemandProfiles(
      [row({ keyword: "юрист", laws: ["FZ_44"] }), row({ keyword: "ремонт", laws: ["COMMERCIAL"] })],
      opts,
    );

    expect(profiles).toHaveLength(2);
  });

  it("длинный список режется на профили по восемь слов", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ keyword: `тема ${String.fromCharCode(1072 + i)}` }));

    const profiles = buildDemandProfiles(rows, opts);

    expect(profiles.length).toBe(3);
    expect(Math.max(...profiles.map((p) => p.keywords.length))).toBe(8);
  });

  describe("регионы в сборе", () => {
    it("тему ждут только в регионе — она собирается в нём", () => {
      const [profile] = buildDemandProfiles([row({ keyword: "строительство", regions: ["Республика Бурятия"] })], opts);

      expect(profile?.regions).toEqual(["Республика Бурятия"]);
    });

    it("разные посетители ждут тему в разных регионах — регионы объединяются", () => {
      const [profile] = buildDemandProfiles(
        [
          row({ visitor_id: "v1", keyword: "строительство", regions: ["Республика Бурятия"] }),
          row({ visitor_id: "v2", keyword: "строительство", regions: ["Москва"] }),
        ],
        opts,
      );

      expect(profile?.regions).toEqual(["Москва", "Республика Бурятия"]);
    });

    it("кто-то ждёт тему по всей России — собирается по всей России", () => {
      const [profile] = buildDemandProfiles(
        [
          row({ visitor_id: "v1", keyword: "строительство", regions: ["Республика Бурятия"] }),
          row({ visitor_id: "v2", keyword: "строительство", regions: [] }),
        ],
        opts,
      );

      expect(profile?.regions).toEqual([]);
    });

    it("слова с разными регионами идут разными профилями: чужой регион не расширяет запрос", () => {
      const profiles = buildDemandProfiles(
        [
          row({ keyword: "строительство", regions: ["Республика Бурятия"] }),
          row({ keyword: "юрист", regions: [] }),
        ],
        opts,
      );

      expect(profiles).toHaveLength(2);
    });

    it("старая строка без поля регионов читается как вся Россия", () => {
      const { regions: _omit, ...legacy } = row();

      const [profile] = buildDemandProfiles([legacy as DemandRow], opts);

      expect(profile?.regions).toEqual([]);
    });
  });

  /*
    Замечание 05.10.2026: профиль владельца «строительство, ремонт» стоял на
    Бурятии, и тема «ремонт» посетителя из Забайкальского края выбрасывалась
    как «уже собирается» — Забайкалье не собиралось вовсе. Тема занята, только
    если владелец собирает её во всех регионах посетителя.
  */
  describe("тема, которую уже собирает владелец", () => {
    it("владелец собирает слово в другом регионе — тема посетителя собирается", () => {
      const profiles = buildDemandProfiles([row({ keyword: "ремонт", regions: ["Забайкальский край"] })], {
        ...opts,
        exclude: new Map([["ремонт", ["Республика Бурятия"]]]),
      });

      expect(profiles.flatMap((p) => p.keywords)).toEqual(["ремонт"]);
      expect(profiles[0]?.regions).toEqual(["Забайкальский край"]);
    });

    it("посетитель ждёт два региона, владелец собирает один — собирается недостающий", () => {
      const profiles = buildDemandProfiles(
        [row({ keyword: "ремонт", regions: ["Республика Бурятия", "Забайкальский край"] })],
        { ...opts, exclude: new Map([["ремонт", ["Республика Бурятия"]]]) },
      );

      expect(profiles[0]?.regions).toEqual(["Забайкальский край"]);
    });

    it("владелец собирает слово в том же регионе — повтора нет", () => {
      const profiles = buildDemandProfiles([row({ keyword: "ремонт", regions: ["Республика Бурятия"] })], {
        ...opts,
        exclude: new Map([["ремонт", ["республика бурятия"]]]),
      });

      expect(profiles).toEqual([]);
    });

    it("владелец собирает слово по всей России — повтора нет", () => {
      const profiles = buildDemandProfiles([row({ keyword: "ремонт", regions: ["Забайкальский край"] })], {
        ...opts,
        exclude: new Map([["ремонт", []]]),
      });

      expect(profiles).toEqual([]);
    });

    it("посетитель ждёт по всей России, владелец только в регионе — собирается по всей России", () => {
      const profiles = buildDemandProfiles([row({ keyword: "ремонт", regions: [] })], {
        ...opts,
        exclude: new Map([["ремонт", ["Республика Бурятия"]]]),
      });

      expect(profiles[0]?.regions).toEqual([]);
    });
  });

  it("порядок не зависит от порядка строк: прогон воспроизводим", () => {
    const rows = [row({ keyword: "б" }), row({ keyword: "а" }), row({ keyword: "в" })];

    const a = buildDemandProfiles(rows, opts);
    const b = buildDemandProfiles([...rows].reverse(), opts);

    expect(a).toEqual(b);
  });
});
