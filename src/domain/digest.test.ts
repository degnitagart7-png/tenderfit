import { describe, expect, it } from "vitest";

import {
  DIGEST_CLOSING_LIMIT,
  DIGEST_FRESH_LIMIT,
  DIGEST_IN_WORK_LIMIT,
  appBaseUrl,
  buildDigest,
  digestDue,
  formatDeadline,
  nextDigestDay,
  normalizeSearchProfiles,
  readPipeline,
  selectForProfile,
  tenderUrl,
  type DigestPipeline,
} from "@/domain/digest";
import { resolveDigestSettings } from "@/domain/digestSettings";
import { defaultFilters, searchRows, sortSearched, type TenderRow } from "@/domain/filtering";
import { nonContractReason, profileIsContractor, worksIntent } from "@/domain/procurementNature";
import { searchWordsFromProfile } from "@/domain/searchProfileFilters";
import { DAY, H, NOW, contractor, dbRow, stroyka, toRow } from "@/test/digestFixtures";
import type { TenderRow as TenderRowDB } from "@/types/database";
import fixture from "@/domain/__fixtures__/feed/stroyka-buryatia-mo-2026-10-14.json";

const iso = (ms: number): string => new Date(ms).toISOString();
const SINCE = NOW - DAY;

function digest(
  dbRows: TenderRowDB[],
  over: Partial<Parameters<typeof buildDigest>[0]> = {},
  statuses: Record<string, TenderRow["pipelineStatus"]> = {},
) {
  const pipeline: DigestPipeline = Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status }]));
  return buildDigest({
    rows: dbRows.map((db) => toRow(db, contractor, statuses[db.reg_number] ?? "NEW")),
    searchProfiles: [stroyka],
    companyProfile: contractor,
    pipeline,
    since: SINCE,
    now: NOW,
    minFitScore: 0,
    baseUrl: "https://tender-fit.ru",
    ...over,
  });
}

describe("buildDigest — новое по профилю", () => {
  it("берёт закупки профиля, появившиеся с момента since, и отсекает остальное", () => {
    const result = digest([
      dbRow("100", { created_at: iso(NOW - 3 * H) }),
      dbRow("101", { created_at: iso(SINCE - H) }), // появилась до since — не новая
      dbRow("102", { region: "Москва", created_at: iso(NOW - H) }), // регион вне профиля
      dbRow("103", { subject: "Поставка канцелярских товаров", created_at: iso(NOW - H) }), // слов профиля нет
      dbRow("104", { submission_end: iso(NOW - 2 * H), created_at: iso(NOW - 5 * H) }), // приём заявок закончен
    ]);

    expect(result.fresh.map((i) => i.regNumber)).toEqual(["100"]);
    expect(result.totalFresh).toBe(1);
    expect(result.isEmpty).toBe(false);
  });

  it("не показывает покупку квартир у застройщика подрядчику: «не подряд», как в ленте", () => {
    const result = digest([
      dbRow("200"),
      dbRow("201", {
        subject:
          "Приобретение в муниципальную собственность жилого помещения у Застройщика путём участия в долевом строительстве",
      }),
    ]);

    expect(result.fresh.map((i) => i.regNumber)).toEqual(["200"]);
  });

  it("минимальная оценка: закупка с оценкой ниже порога в сводку не попадает", () => {
    const fit = toRow(dbRow("300")).analysis.fitScore;

    expect(digest([dbRow("300")], { minFitScore: fit }).fresh).toHaveLength(1);
    expect(digest([dbRow("300")], { minFitScore: fit + 1 }).fresh).toHaveLength(0);
  });

  it("порядок как в ленте: что ещё можно успеть подготовить — выше закрывающейся через сутки", () => {
    const result = digest([
      dbRow("400", { submission_end: iso(NOW + 20 * H) }), // меньше двух суток
      dbRow("401", { submission_end: iso(NOW + 9 * DAY) }),
    ]);

    expect(result.fresh.map((i) => i.regNumber)).toEqual(["401", "400"]);
  });

  it("не больше десяти новых, а сколько всего — в totalFresh", () => {
    const many = Array.from({ length: 13 }, (_, i) => dbRow(`5${String(i).padStart(2, "0")}`));

    const result = digest(many);

    expect(result.fresh).toHaveLength(DIGEST_FRESH_LIMIT);
    expect(result.totalFresh).toBe(13);
  });

  it("строка сводки несёт всё для письма: предмет, заказчика, регион, цену, срок, оценку и ссылку", () => {
    const [item] = digest([dbRow("600", { price: 12_000_000 })]).fresh;

    expect(item).toMatchObject({
      id: "600",
      regNumber: "600",
      subject: "Строительство объекта 600",
      customer: "Администрация района",
      region: "Республика Бурятия",
      price: 12_000_000,
      url: "https://tender-fit.ru/tenders/600",
    });
    expect(item?.fitScore).toBeGreaterThan(0);
    expect(item?.submissionEnd).toBe(iso(NOW + 10 * DAY));
  });

  it("цена не опубликована — null, а не ноль", () => {
    expect(digest([dbRow("601", { price: null })]).fresh[0]?.price).toBeNull();
  });

  it("без профиля поиска со словами «новых по профилю» нет, а воронка работает", () => {
    const rows = [dbRow("700"), dbRow("701", { subject: "Иное", submission_end: iso(NOW + 5 * DAY) })];

    const result = digest(rows, { searchProfiles: [{ ...stroyka, keywords: [] }] }, { "701": "INTERESTING" });

    expect(result.fresh).toEqual([]);
    expect(result.inWork.map((i) => i.regNumber)).toEqual(["701"]);
  });

  it("выключенный профиль не применяется", () => {
    expect(digest([dbRow("702")], { searchProfiles: [{ ...stroyka, enabled: false }] }).fresh).toEqual([]);
  });

  it("лимиты профиля (цена) отсекают закупки вне диапазона", () => {
    const result = digest(
      [dbRow("710", { price: 1_000_000 }), dbRow("711", { price: 90_000_000 })],
      { searchProfiles: [{ ...stroyka, minPrice: 2_000_000, maxPrice: 50_000_000 }] },
    );

    expect(result.fresh.map((i) => i.regNumber)).toEqual([]);
    const within = digest(
      [dbRow("712", { price: 5_000_000 }), dbRow("711", { price: 90_000_000 })],
      { searchProfiles: [{ ...stroyka, minPrice: 2_000_000, maxPrice: 50_000_000 }] },
    );
    expect(within.fresh.map((i) => i.regNumber)).toEqual(["712"]);
  });

  it("закупка без даты первого появления не считается новой", () => {
    const row = toRow(dbRow("720"));
    const noSeen: TenderRow = { ...row, tender: { ...row.tender, firstSeenAt: null } };

    const result = buildDigest({
      rows: [noSeen],
      searchProfiles: [stroyka],
      companyProfile: contractor,
      pipeline: {},
      since: SINCE,
      now: NOW,
      minFitScore: 0,
    });

    expect(result.fresh).toEqual([]);
  });
});

describe("buildDigest — закрываются в ближайшие 48 часов", () => {
  it("берёт закупки из воронки в рабочих статусах (даже не по профилю) и подходящие по профилю, сроки по возрастанию", () => {
    const result = digest(
      [
        dbRow("800", { subject: "Поставка канцелярии", region: "Москва", submission_end: iso(NOW + 30 * H), created_at: iso(SINCE - DAY) }),
        dbRow("801", { submission_end: iso(NOW + 10 * H), created_at: iso(SINCE - DAY) }), // подходящая, но старая
        dbRow("802", { subject: "Поставка бумаги", submission_end: iso(NOW + 5 * H), created_at: iso(SINCE - DAY) }), // не из воронки и не по профилю
        dbRow("803", { subject: "Услуги связи", region: "Москва", submission_end: iso(NOW + 60 * H), created_at: iso(SINCE - DAY) }), // дальше 48 ч
        dbRow("804", { subject: "Отказались", region: "Москва", submission_end: iso(NOW + 12 * H), created_at: iso(SINCE - DAY) }),
      ],
      {},
      { "800": "PREPARING_APPLICATION", "803": "INTERESTING", "804": "SKIPPED" },
    );

    expect(result.closing.map((i) => i.regNumber)).toEqual(["801", "800"]);
  });

  it("новое, уже показанное в разделе «Новые», в «Закрываются» не повторяется", () => {
    const result = digest([dbRow("810", { submission_end: iso(NOW + 30 * H) })]);

    expect(result.fresh.map((i) => i.regNumber)).toEqual(["810"]);
    expect(result.closing).toEqual([]);
  });

  it("подача закончилась — в «Закрываются» не попадает, даже если закупка в воронке", () => {
    const result = digest([dbRow("820", { submission_end: iso(NOW - 2 * H), created_at: iso(SINCE - DAY) })], {}, { "820": "ANALYZING" });

    expect(result.closing).toEqual([]);
    expect(result.inWork).toEqual([]);
  });

  it("не больше пяти", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      dbRow(`83${String(i)}`, { submission_end: iso(NOW + (i + 1) * H), created_at: iso(SINCE - DAY) }),
    );

    const result = digest(rows);

    expect(result.closing).toHaveLength(DIGEST_CLOSING_LIMIT);
    expect(result.closing[0]?.regNumber).toBe("830");
  });
});

describe("buildDigest — в работе", () => {
  it("рабочие статусы воронки с ближайшими сроками; не в работе и без срока впереди — нет; показанное выше не дублируется", () => {
    const old = { created_at: iso(SINCE - DAY) };
    const result = digest(
      [
        dbRow("900", { subject: "А", region: "Москва", submission_end: iso(NOW + 5 * DAY), ...old }),
        dbRow("901", { subject: "Б", region: "Москва", submission_end: iso(NOW + 3 * DAY), ...old }),
        dbRow("902", { subject: "В", region: "Москва", submission_end: iso(NOW + 4 * DAY), ...old }),
        dbRow("903", { subject: "Г", region: "Москва", submission_end: iso(NOW + 6 * DAY), ...old }), // подана — не в работе
        dbRow("904", { subject: "Д", region: "Москва", submission_end: iso(NOW + 20 * H), ...old }), // закрывается — в своём разделе
      ],
      {},
      { "900": "INTERESTING", "901": "ANALYZING", "902": "PREPARING_APPLICATION", "903": "SUBMITTED", "904": "INTERESTING" },
    );

    expect(result.inWork.map((i) => i.regNumber)).toEqual(["901", "902", "900"]);
    expect(result.closing.map((i) => i.regNumber)).toEqual(["904"]);
  });

  it("статус берётся из воронки человека, а не из строки; не больше пяти", () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      dbRow(`91${String(i)}`, { subject: "Прочее", region: "Москва", submission_end: iso(NOW + (3 + i) * DAY), created_at: iso(SINCE - DAY) }),
    );
    const statuses = Object.fromEntries(rows.map((r) => [r.reg_number, "INTERESTING" as const]));

    const result = buildDigest({
      // Строки пришли со статусом NEW (так их строит воркер); воронка приходит отдельно.
      rows: rows.map((r) => toRow(r)),
      searchProfiles: [stroyka],
      companyProfile: contractor,
      pipeline: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status }])),
      since: SINCE,
      now: NOW,
      minFitScore: 0,
      baseUrl: "https://tender-fit.ru",
    });

    expect(result.inWork).toHaveLength(DIGEST_IN_WORK_LIMIT);
    expect(result.inWork[0]?.regNumber).toBe("910");
  });

  it("нечего сообщить — isEmpty", () => {
    const result = digest([dbRow("920", { created_at: iso(SINCE - H) })]);

    expect(result).toMatchObject({ fresh: [], closing: [], inWork: [], isEmpty: true, totalFresh: 0 });
  });
});

describe("адреса", () => {
  it("базовый адрес из APP_BASE_URL, по умолчанию tender-fit.ru; без слэша на конце, мусор игнорируется", () => {
    expect(appBaseUrl({})).toBe("https://tender-fit.ru");
    expect(appBaseUrl({ APP_BASE_URL: "https://staging.tender-fit.ru/" })).toBe("https://staging.tender-fit.ru");
    expect(appBaseUrl({ APP_BASE_URL: "tender-fit" })).toBe("https://tender-fit.ru");
  });

  it("ссылка на закупку кодирует номер", () => {
    expect(tenderUrl("0373/100", "https://x.ru")).toBe("https://x.ru/tenders/0373%2F100");
  });

  it("сроки печатаются по поясу клиента", () => {
    expect(formatDeadline("2026-10-16T06:00:00Z", "Asia/Irkutsk")).toBe("16.10 14:00");
    expect(formatDeadline("2026-10-16T06:00:00Z", "Europe/Moscow")).toBe("16.10 09:00");
    expect(formatDeadline("2026-10-15T20:30:00Z", "Asia/Irkutsk")).toBe("16.10 04:30");
    // Срок ЕИС без времени (полночь UTC) — только дата, без выдуманного «08:00» по Иркутску.
    expect(formatDeadline("2026-10-22T00:00:00+00:00", "Asia/Irkutsk")).toBe("22.10");
    expect(formatDeadline("2026-10-22T00:00:00Z", "Europe/Kaliningrad")).toBe("22.10");
    expect(formatDeadline("", "Europe/Moscow")).toBe("—");
    expect(formatDeadline("не дата", "Europe/Moscow")).toBe("—");
  });
});

describe("читаются данные аккаунта", () => {
  it("воронка: неизвестные статусы и мусор отбрасываются", () => {
    expect(readPipeline({ a: { status: "ANALYZING" }, b: { status: "ЧТО-ТО" }, c: 5, d: null })).toEqual({
      a: { status: "ANALYZING" },
    });
    expect(readPipeline(null)).toEqual({});
    expect(readPipeline([1, 2])).toEqual({});
  });

  it("профили поиска: записи без слов отбрасываются, недостающее — пустое", () => {
    const [profile, ...rest] = normalizeSearchProfiles([
      { id: "x", name: "Мой", keywords: ["ремонт"], enabled: true },
      { name: "без слов" },
      "строка",
    ]);

    expect(rest).toEqual([]);
    expect(profile).toMatchObject({ keywords: ["ремонт"], regions: [], customerInns: [], minPrice: null, enabled: true });
  });
});

describe("тот же отбор, что у ленты", () => {
  it("на реальных 173 строках сводка выбирает ровно то, что показала бы лента по профилю владельца", () => {
    const profile = {
      ...stroyka,
      keywords: ["Строительные работы", "Капитальное строительство", "Строительство"],
      regions: ["Республика Бурятия", "Московская область"],
    };
    const company = {
      ...contractor,
      restrictions: { ...contractor.restrictions, workRegions: ["Республика Бурятия", "Московская область"] },
    };
    const rows = (fixture as unknown as TenderRowDB[]).map((db) => toRow(db, company));

    const selected = selectForProfile({ rows, searchProfiles: [profile], companyProfile: company, now: NOW });

    // Шаги ленты (TendersView): слова профиля → searchRows → «не подряд» → «Не подходит» → порядок «по Fit Score».
    const filters = { ...defaultFilters, ...searchWordsFromProfile(profile) };
    const found = searchRows(rows, filters);
    const words = filters.searchKeywords;
    const isContractor = profileIsContractor(company);
    const shown = found.filter(
      (hit) =>
        nonContractReason(hit.row.tender, { words, contractor: isContractor }) === null &&
        // выбран регион: отказ одним регионом не прячет закупку — как в ленте
        (hit.row.analysis.verdict !== "NOT_RECOMMENDED" ||
          hit.row.analysis.hardBlockers.every((b) => b.id.endsWith("-block-region"))),
    );
    const expected = sortSearched(shown, "fitScore", "desc", undefined, {
      now: new Date(NOW),
      preferWorks: worksIntent(words, isContractor),
    });

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.map((hit) => hit.row.tender.id)).toEqual(expected.map((hit) => hit.row.tender.id));
  });
});

describe("digestDue — когда слать по часам клиента", () => {
  const irkutsk = resolveDigestSettings({ enabled: true, sendTime: "08:00", timeZone: "Asia/Irkutsk" });
  const moscow = resolveDigestSettings({ enabled: true, sendTime: "08:00", timeZone: "Europe/Moscow" });

  it("Иркутск (+8): в 08:00 по Иркутску пора, в 07:59 — рано", () => {
    expect(digestDue(irkutsk, null, Date.parse("2026-10-16T00:00:00Z"))).toBe(true);
    expect(digestDue(irkutsk, null, Date.parse("2026-10-15T23:59:00Z"))).toBe(false);
  });

  it("один и тот же момент: в Иркутске утро, в Москве ещё ночь", () => {
    const at = Date.parse("2026-10-16T00:30:00Z"); // 08:30 Иркутск, 03:30 Москва
    expect(digestDue(irkutsk, null, at)).toBe(true);
    expect(digestDue(moscow, null, at)).toBe(false);
  });

  it("Москва: 08:00 по Москве — это 05:00 UTC", () => {
    expect(digestDue(moscow, null, Date.parse("2026-10-16T05:00:00Z"))).toBe(true);
    expect(digestDue(moscow, null, Date.parse("2026-10-16T04:59:00Z"))).toBe(false);
  });

  it("сегодня уже отправляли — нет; вчера отправляли — да", () => {
    const at = Date.parse("2026-10-16T00:30:00Z");
    expect(digestDue(irkutsk, Date.parse("2026-10-16T00:05:00Z"), at)).toBe(false);
    expect(digestDue(irkutsk, Date.parse("2026-10-15T00:05:00Z"), at)).toBe(true);
  });

  it("«сегодня» считается по поясу клиента, а не по UTC", () => {
    // 17:00 UTC 15-го — это 01:00 16-го в Иркутске: по часам клиента сегодня уже 16-е.
    const lastSent = Date.parse("2026-10-15T17:00:00Z");
    expect(digestDue(irkutsk, lastSent, Date.parse("2026-10-16T00:30:00Z"))).toBe(false);
    // а в Москве та же отметка — вечер 15-го, поэтому утром 16-го пора.
    expect(digestDue(moscow, lastSent, Date.parse("2026-10-16T05:30:00Z"))).toBe(true);
  });

  it("сводка выключена — никогда", () => {
    expect(digestDue({ ...irkutsk, enabled: false }, null, Date.parse("2026-10-16T05:00:00Z"))).toBe(false);
  });

  it("другое время отправки учитывается", () => {
    const nine = resolveDigestSettings({ sendTime: "09:30", timeZone: "Asia/Irkutsk" });
    expect(digestDue(nine, null, Date.parse("2026-10-16T01:00:00Z"))).toBe(false); // 09:00 Иркутск
    expect(digestDue(nine, null, Date.parse("2026-10-16T01:30:00Z"))).toBe(true);
  });
});

describe("nextDigestDay — для строки на странице «Отчёт»", () => {
  const settings = resolveDigestSettings({ sendTime: "08:00", timeZone: "Asia/Irkutsk" });

  it("утро ещё впереди — сегодня; прошло — завтра; выключено — null", () => {
    expect(nextDigestDay(settings, null, Date.parse("2026-10-15T22:00:00Z"))).toBe("today"); // 06:00 Иркутск
    expect(nextDigestDay(settings, null, Date.parse("2026-10-16T05:00:00Z"))).toBe("tomorrow"); // 13:00 Иркутск
    expect(nextDigestDay({ ...settings, enabled: false }, null, NOW)).toBeNull();
  });
});

describe("digestDue: окно отправки", () => {
  it("через шесть часов после выбранного времени сводка уже не уходит", () => {
    const settings = resolveDigestSettings({ sendTime: "08:00", timeZone: "Asia/Irkutsk" });
    // 08:30 и 14:30 по Иркутску (UTC+8) — 00:30 и 06:30 UTC.
    expect(digestDue(settings, null, Date.parse("2026-10-16T00:30:00Z"))).toBe(true);
    expect(digestDue(settings, null, Date.parse("2026-10-16T06:30:00Z"))).toBe(false);
  });
});
