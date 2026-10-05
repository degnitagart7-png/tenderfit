import { describe, expect, it } from "vitest";

import {
  KEEP_LIVE_ROWS_FILTER,
  LIVE_LIMIT_PER_KEYWORD,
  LIVE_ORIGIN,
  buildLiveProfile,
  LIVE_PICKUP_MS,
  LIVE_RUN_CAP_MS,
  decideLiveStart,
  liveWaitMinutes,
  isLiveExpired,
  isLiveRawData,
  liveExpiryCutoff,
  liveRawData,
  normalizeLiveQuery,
  normalizeLiveRegions,
  normalizeLiveSynonyms,
  type LiveJobView,
} from "@/domain/liveSearch";
import { freeSyncSources } from "@/domain/sources";

/**
 * Живой поиск: запрос человека уходит прямо на площадки, а найденное остаётся
 * в базе.
 *
 * Главное, что здесь нужно удержать, — судьба найденного. Плановый прогон
 * пересоздаёт строки опрошенного источника целиком: удаляет все и пишет
 * заново только то, что нашли профили сервера. Найденное живым поиском без
 * защиты пропало бы при ближайшем обходе — человек нашёл бы закупки и через
 * два часа потерял их без объяснения.
 */

describe("normalizeLiveQuery", () => {
  it("убирает лишние пробелы", () => {
    expect(normalizeLiveQuery("  юридические   услуги ")).toBe("юридические услуги");
  });

  it("слишком короткий запрос не принимается: он найдёт всё подряд", () => {
    expect(normalizeLiveQuery("а")).toBeNull();
    expect(normalizeLiveQuery("  ")).toBeNull();
  });

  it("слишком длинный не принимается", () => {
    expect(normalizeLiveQuery("а".repeat(200))).toBeNull();
  });

  it("служебные символы поисковых строк площадок вычищаются", () => {
    expect(normalizeLiveQuery('юридические "услуги" <b>')).toBe("юридические услуги b");
  });

  it("управляющие символы и переносы строк не проходят", () => {
    expect(normalizeLiveQuery("юристы\n\u0000аудит")).toBe("юристы аудит");
  });

  it("запрос без единой буквы или цифры отклоняется", () => {
    expect(normalizeLiveQuery("... --- ,,,")).toBeNull();
  });

  it("код ОКПД2 сохраняется: точки в нём значимы", () => {
    expect(normalizeLiveQuery("69.10.10")).toBe("69.10.10");
  });
});

/*
  Регион живого поиска. ЕИС умеет искать по региону заказчика, поэтому запрос
  человека с регионом (в ленте стоит «Республика Бурятия») идёт на площадки уже
  с ним: раньше выдача была по всей России, и по Бурятии находились единицы.
*/
describe("normalizeLiveRegions", () => {
  it("чистит названия и убирает повторы", () => {
    expect(normalizeLiveRegions(["  Республика   Бурятия ", "республика бурятия", "Москва"])).toEqual([
      "Республика Бурятия",
      "Москва",
    ]);
  });

  it("не больше пяти, мусор и слишком длинное отбрасывается", () => {
    const many = ["Москва", "Бурятия", "Крым", "Тыва", "Коми", "Карелия"];

    expect(normalizeLiveRegions(many)).toHaveLength(5);
    expect(normalizeLiveRegions(["<script>", "x".repeat(200), 42, null, "Бурятия"])).toEqual(["script", "Бурятия"]);
  });

  it("не список — пустой список", () => {
    expect(normalizeLiveRegions("Бурятия")).toEqual([]);
    expect(normalizeLiveRegions(undefined)).toEqual([]);
  });
});

/*
  Близкие слова. «Строительство» одним словом даёт единицы: заказчик пишет
  «ремонт», «реконструкция», «строительные работы». Модель предлагает
  формулировки, и живой поиск ищет по запросу и по нескольким из них.
*/
describe("normalizeLiveSynonyms", () => {
  it("чистит, убирает повторы запроса и друг друга, ограничивает число", () => {
    const result = normalizeLiveSynonyms("строительство", [
      " Строительные   работы ",
      "строительство",
      "СТРОИТЕЛЬНЫЕ РАБОТЫ",
      "капитальный ремонт",
      "реконструкция зданий",
      "благоустройство",
    ]);

    expect(result).toEqual(["Строительные работы", "капитальный ремонт", "реконструкция зданий"]);
  });

  it("мусор и не-строки отбрасываются", () => {
    expect(normalizeLiveSynonyms("x", ["<>", 42, null, "ремонт"])).toEqual(["ремонт"]);
    expect(normalizeLiveSynonyms("x", "ремонт")).toEqual([]);
    expect(normalizeLiveSynonyms("x", undefined)).toEqual([]);
  });
});

describe("buildLiveProfile с близкими словами", () => {
  it("запрос идёт первым, близкие слова следом", () => {
    expect(buildLiveProfile("строительство", [], ["ремонт", "реконструкция"]).keywords).toEqual([
      "строительство",
      "ремонт",
      "реконструкция",
    ]);
  });

  it("без близких слов только запрос", () => {
    expect(buildLiveProfile("строительство").keywords).toEqual(["строительство"]);
  });
});

describe("buildLiveProfile с регионами", () => {
  it("регионы запроса попадают в профиль прогона", () => {
    expect(buildLiveProfile("строительство", ["Республика Бурятия"]).regions).toEqual(["Республика Бурятия"]);
  });

  it("без регионов профиль, как раньше, без ограничения", () => {
    expect(buildLiveProfile("строительство").regions).toEqual([]);
  });
});

describe("buildLiveProfile", () => {
  const profile = buildLiveProfile("юридические услуги");

  it("площадкам уходит запрос человека целиком: у ЕИС несколько слов сужают выдачу, а «юридические» одно тянет всё про юридических лиц", () => {
    expect(profile.keywords).toEqual(["юридические услуги"]);
  });

  it("опрашивает все бесплатные источники и ни одного платного", () => {
    const free = freeSyncSources().map((source) => source.source);

    expect(profile.sources).toEqual(free);
    expect(profile.sources).not.toContain("KONTUR");
  });

  it("не ограничивает цену и регион: человек не просил", () => {
    expect(profile.minPrice ?? null).toBeNull();
    expect(profile.maxPrice ?? null).toBeNull();
    expect(profile.regions ?? []).toEqual([]);
  });

  it("берёт больше закупок на слово, чем плановый профиль", () => {
    expect(profile.limitPerKeyword).toBe(LIVE_LIMIT_PER_KEYWORD);
    expect(LIVE_LIMIT_PER_KEYWORD).toBeGreaterThan(10);
  });

  it("включён и охватывает 44-ФЗ и 223-ФЗ", () => {
    expect(profile.enabled).toBe(true);
    expect(profile.laws).toEqual(["FZ_44", "FZ_223"]);
  });
});

describe("пометка «живая» и её защита от очистки", () => {
  it("пометка несёт происхождение, запрос и время", () => {
    expect(liveRawData("юристы", "2026-10-04T18:00:00.000Z")).toEqual({
      origin: LIVE_ORIGIN,
      query: "юристы",
      at: "2026-10-04T18:00:00.000Z",
    });
  });

  it("распознаётся и там, где raw_data — сырой ответ Контура", () => {
    expect(isLiveRawData(liveRawData("x", "2026-10-04T18:00:00.000Z"))).toBe(true);
    expect(isLiveRawData({ Id: "abc", OrderName: "что-то" })).toBe(false);
    expect(isLiveRawData(null)).toBe(false);
    expect(isLiveRawData("текст")).toBe(false);
  });

  /*
    Фильтр для плановой очистки: удаляем строку, у которой origin не «live».
    Условие «origin is null» нужно отдельно: у строк без пометки, включая
    сырые ответы Контура, `raw_data->>origin` равно NULL, а `NULL <> 'live'` в
    SQL даёт NULL, то есть «не удалять» — без второго условия очистка Контура
    и всех источников без пометки молча перестала бы работать.
  */
  it("фильтр очистки удаляет строки без пометки и с чужой пометкой", () => {
    expect(KEEP_LIVE_ROWS_FILTER).toContain("raw_data->>origin.is.null");
    expect(KEEP_LIVE_ROWS_FILTER).toContain(`raw_data->>origin.neq.${LIVE_ORIGIN}`);
  });

  it("фильтр — это «или» из двух условий", () => {
    expect(KEEP_LIVE_ROWS_FILTER.split(",")).toHaveLength(2);
  });
});

describe("liveExpiryCutoff", () => {
  it("закрытые живые закупки живут ещё сутки: человеку нужно успеть увидеть", () => {
    const now = Date.parse("2026-10-04T18:00:00.000Z");

    expect(liveExpiryCutoff(now)).toBe("2026-10-03T18:00:00.000Z");
  });
});

/**
 * Ставить ли задание живого поиска.
 *
 * Прогон идёт минуты и ходит по чужим площадкам, поэтому повторное нажатие не
 * должно плодить задания: тот же запрос в работе — возвращаем его, недавно
 * выполненный — не повторяем (данные уже в базе), чужой запрос в работе —
 * отказ с объяснением, а не очередь из прогонов, каждый из которых занимает
 * воркер на несколько минут.
 */
describe("liveWaitMinutes", () => {
  const T = Date.parse("2026-10-04T18:00:00.000Z");

  it("срок — минута на подхват плюс предел прогона, минус прошедшее", () => {
    expect(liveWaitMinutes(T, T)).toBe(8);
    expect(liveWaitMinutes(T - 2 * 60_000, T)).toBe(6);
  });

  it("задание просрочено — null", () => {
    expect(liveWaitMinutes(T - 9 * 60_000, T)).toBeNull();
  });

  it("часы клиента впереди сервера (создано «в будущем») — не больше полного срока", () => {
    expect(liveWaitMinutes(T + 5 * 60_000, T)).toBe(8);
  });

  it("предел прогона и подхвата заданы в одном месте", () => {
    expect(LIVE_RUN_CAP_MS).toBe(7 * 60_000);
    expect(LIVE_PICKUP_MS).toBe(60_000);
  });
});

describe("decideLiveStart", () => {
  const NOW = Date.parse("2026-10-04T18:00:00.000Z");
  const job = (over: Partial<LiveJobView> = {}): LiveJobView => ({
    id: "j1",
    query: "юридические услуги",
    status: "processing",
    createdAt: "2026-10-04T18:00:00.000Z",
    finishedAt: null,
    ...over,
  });

  it("ничего не идёт и не было — ставим задание", () => {
    expect(decideLiveStart({ query: "юристы", active: null, recent: null, nowMs: NOW })).toEqual({
      kind: "create",
    });
  });

  it("тот же запрос уже выполняется — возвращаем его", () => {
    expect(
      decideLiveStart({ query: "Юридические  услуги", active: job(), recent: null, nowMs: NOW }),
    ).toEqual({ kind: "reuse", jobId: "j1" });
  });

  it("выполняется чужой запрос — отказ: воркер занят", () => {
    const decision = decideLiveStart({
      query: "охрана объектов",
      active: job(),
      recent: null,
      nowMs: NOW,
    });

    expect(decision.kind).toBe("busy");
  });

  describe("сколько ждать, когда сервер занят чужим запросом", () => {
    const busyReason = (createdAt: string): string => {
      const decision = decideLiveStart({
        query: "охрана объектов",
        active: job({ createdAt }),
        recent: null,
        nowMs: NOW,
      });
      if (decision.kind !== "busy") throw new Error("ожидался отказ busy");
      return decision.reason;
    };

    it("только что начат — называет полный срок: минута на подхват и семь на прогон", () => {
      expect(busyReason("2026-10-04T18:00:00.000Z")).toMatch(/примерно через 8 минут/);
    });

    it("идёт две минуты — остаётся шесть", () => {
      expect(busyReason("2026-10-04T17:58:00.000Z")).toMatch(/примерно через 6 минут/);
    });

    it("остаток округляется вверх и склоняется: 1 минуту, 2 минуты", () => {
      expect(busyReason("2026-10-04T17:52:30.000Z")).toMatch(/примерно через 1 минуту/);
      expect(busyReason("2026-10-04T17:55:30.000Z")).toMatch(/примерно через 4 минуты/);
    });

    it("названный срок никогда не больше десяти минут", () => {
      for (const ageSec of [0, 5, 30, 90, 200, 400, 470]) {
        const created = new Date(NOW - ageSec * 1000).toISOString();
        const minutes = Number(/через (\d+)/.exec(busyReason(created))?.[1]);
        expect(minutes).toBeGreaterThanOrEqual(1);
        expect(minutes).toBeLessThanOrEqual(10);
      }
    });

    it("задание идёт дольше положенного — числа нет: обещать срок, которого не знаем, нельзя", () => {
      const reason = busyReason("2026-10-04T17:30:00.000Z");

      expect(reason).not.toMatch(/\d/);
      expect(reason).toMatch(/дольше обычного/i);
    });

    it("в тексте нет слова «очередь»: человеку она ни к чему", () => {
      expect(busyReason("2026-10-04T17:58:00.000Z")).not.toMatch(/очеред/i);
    });
  });

  describe("регион меняет запрос", () => {
    const done = job({ status: "completed", finishedAt: "2026-10-04T17:55:00.000Z", regions: ["Республика Бурятия"] });

    it("тот же запрос с тем же регионом — кэш", () => {
      expect(
        decideLiveStart({ query: "юридические услуги", regions: ["республика бурятия"], active: null, recent: done, nowMs: NOW }),
      ).toEqual({ kind: "cached", jobId: "j1" });
    });

    it("тот же запрос по другому региону — ставим заново: прежний прогон искал не там", () => {
      expect(
        decideLiveStart({ query: "юридические услуги", regions: ["Москва"], active: null, recent: done, nowMs: NOW }).kind,
      ).toBe("create");
    });

    it("тот же запрос без региона после запроса с регионом — тоже заново", () => {
      expect(decideLiveStart({ query: "юридические услуги", active: null, recent: done, nowMs: NOW }).kind).toBe(
        "create",
      );
    });

    it("идущий прогон по другому региону не подхватывается: это другой поиск", () => {
      const running = job({ regions: ["Москва"] });

      expect(
        decideLiveStart({ query: "юридические услуги", regions: ["Республика Бурятия"], active: running, recent: null, nowMs: NOW }).kind,
      ).toBe("busy");
    });

    it("порядок регионов не важен", () => {
      const two = job({ regions: ["Москва", "Республика Бурятия"] });

      expect(
        decideLiveStart({ query: "юридические услуги", regions: ["Республика Бурятия", "Москва"], active: two, recent: null, nowMs: NOW }),
      ).toEqual({ kind: "reuse", jobId: "j1" });
    });
  });

  it("тот же запрос выполнен меньше получаса назад — не повторяем", () => {
    const recent = job({ status: "completed", finishedAt: "2026-10-04T17:45:00.000Z" });

    expect(
      decideLiveStart({ query: "юридические услуги", active: null, recent, nowMs: NOW }),
    ).toEqual({ kind: "cached", jobId: "j1" });
  });

  it("выполнен давно — ставим заново: на площадках могло появиться новое", () => {
    const recent = job({ status: "completed", finishedAt: "2026-10-04T16:00:00.000Z" });

    expect(
      decideLiveStart({ query: "юридические услуги", active: null, recent, nowMs: NOW }).kind,
    ).toBe("create");
  });

  it("неудавшееся задание не считается выполненным", () => {
    const recent = job({ status: "failed", finishedAt: "2026-10-04T17:55:00.000Z" });

    expect(
      decideLiveStart({ query: "юридические услуги", active: null, recent, nowMs: NOW }).kind,
    ).toBe("create");
  });
});

/**
 * Живой поиск не сохраняет давно закрытые закупки.
 *
 * ЕИС отдаёт в выдаче и закупки, приём заявок по которым закончился давно: в
 * первом реальном прогоне 14 из 35 найденных оказались закрытыми больше суток
 * назад. Плановый прогон удаляет «живые» строки через сутки после срока, так
 * что их сохранение значило бы принести закупки только затем, чтобы стереть при
 * ближайшем обходе, — а до тех пор лента показывала бы закрытое как найденное.
 */
describe("isLiveExpired", () => {
  const NOW = Date.parse("2026-10-04T18:00:00.000Z");

  it("закрытая больше суток назад — просрочена", () => {
    expect(isLiveExpired("2026-10-02T08:00:00.000Z", NOW)).toBe(true);
  });

  it("закрытая вчера, меньше суток назад, ещё живёт: человеку нужно успеть увидеть", () => {
    expect(isLiveExpired("2026-10-04T08:00:00.000Z", NOW)).toBe(false);
  });

  it("открытая — не просрочена", () => {
    expect(isLiveExpired("2026-10-20T08:00:00.000Z", NOW)).toBe(false);
  });

  it("неразобранная дата не считается просроченной: срок неизвестен, а не прошёл", () => {
    expect(isLiveExpired("не дата", NOW)).toBe(false);
    expect(isLiveExpired("", NOW)).toBe(false);
  });
});
