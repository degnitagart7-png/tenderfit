/**
 * Тесты синхронизации Контур.Закупок.
 *
 * Закупки собираются из тех же реальных ответов API, что и в тестах парсера,
 * поэтому сопоставление типов документов и состав полей проверены на данных,
 * которые источник отдаёт на самом деле. Отдельно проверена экономия платных
 * запросов: остаток по тарифу читается до поиска и перечитывается после.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("@/repositories/tenderRepository", () => ({
  tenderRepository: { upsertByRegNumber: vi.fn() },
}));

vi.mock("@/repositories/documentRepository", () => ({
  documentRepository: { findByTenderId: vi.fn(), create: vi.fn() },
}));

// Supabase в тестах недоступен: репозиторий кэша превращается в заглушку,
// иначе каждый тест тянул бы реальное подключение.
vi.mock("@/repositories/konturCacheRepository", () => ({
  konturCacheRepository: {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    record: vi.fn().mockResolvedValue(undefined),
    billableCallsToday: vi.fn().mockResolvedValue({ search: 0, card: 0 }),
    lastBillableCallAt: vi.fn().mockResolvedValue(null),
    summaryToday: vi.fn().mockResolvedValue({
      apiCalls: 3,
      cacheHits: 1,
      errors: 0,
      firstCallAt: null,
      lastCallAt: null,
    }),
    recent: vi.fn().mockResolvedValue([]),
    storedResponses: vi.fn().mockResolvedValue(0),
  },
}));

import { tenderRepository } from "@/repositories/tenderRepository";
import { documentRepository } from "@/repositories/documentRepository";
import { konturCacheRepository } from "@/repositories/konturCacheRepository";
import {
  DEFAULT_KONTUR_SYNC_INTERVAL_HOURS,
  decideKonturSync,
  konturLastPaidSearchAt,
  konturSourceStop,
  konturSyncIntervalHours,
  syncKonturTenders,
  saveKonturTenderDocuments,
  toTariffInfo,
  type KonturAdapterLike,
} from "@/services/konturSyncService";
import { KonturDailyLimitError } from "@/adapters/tender-source/konturTenderSourceAdapter";
import { freeSourceTitles } from "@/domain/sources";
import {
  KonturAuthError,
  KonturRateLimitError,
  KonturResponseParseError,
} from "@/adapters/tender-source/konturContract";
import {
  normalizeKonturLimitGroups,
  normalizeKonturSearchResults,
  normalizeKonturTender,
  type KonturLimitGroupInfo,
  type RawRecord,
} from "@/adapters/tender-source/konturParser";
import {
  KONTUR_NOW,
  buildKonturSearchPage,
  konturCard44,
  konturCard615,
  konturLimitGroupsResponse,
  konturSearchItem223,
  konturSearchItemCancelled,
  konturSearchItemNoPrice,
} from "@/adapters/tender-source/konturTestFixtures";
import type { Tender } from "@/domain/entities";

const upsert = vi.mocked(tenderRepository.upsertByRegNumber);
const findDocuments = vi.mocked(documentRepository.findByTenderId);
const createDocument = vi.mocked(documentRepository.create);

/** Реальный остаток тарифа: 199 из 200 в группах `search` и `purchase`. */
const TARIFF_GROUPS: KonturLimitGroupInfo[] = normalizeKonturLimitGroups(konturLimitGroupsResponse);

/** Закупки из поисковой выдачи — те же, что видит нормализатор в бою. */
function fromSearchPage(...raw: Record<string, unknown>[]): {
  tenders: Tender[];
  rawByRegNumber: Record<string, RawRecord>;
} {
  return normalizeKonturSearchResults(
    JSON.parse(buildKonturSearchPage(raw, { total: raw.length })) as unknown,
    KONTUR_NOW,
  );
}

/** Закупки из карточек: в них есть документы, которых нет в поисковой выдаче. */
function fromCards(...raw: Record<string, unknown>[]): {
  tenders: Tender[];
  rawByRegNumber: Record<string, RawRecord>;
} {
  const tenders: Tender[] = [];
  const rawByRegNumber: Record<string, RawRecord> = {};
  for (const item of raw) {
    const { tender } = normalizeKonturTender(item, KONTUR_NOW);
    if (!tender) throw new Error("ожидалась закупка из карточки");
    tenders.push(tender);
    rawByRegNumber[tender.regNumber] = item;
  }
  return { tenders, rawByRegNumber };
}

function fakeAdapter(
  tenders: Tender[],
  rawByRegNumber: Record<string, RawRecord>,
  overrides: Partial<KonturAdapterLike> = {},
): KonturAdapterLike {
  return {
    fetchTenders: vi.fn().mockResolvedValue(tenders),
    fetchLimitGroups: vi.fn().mockResolvedValue(TARIFF_GROUPS),
    getRaw: (regNumber: string) => rawByRegNumber[regNumber] ?? null,
    counters: { apiCalls: 2, cacheHits: 1, requestsToday: 9 },
    lastSkipped: [],
    lastBlurred: { fields: [], documents: 0 },
    lastFilteredOut: 0,
    ...overrides,
  };
}

describe("syncKonturTenders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findDocuments.mockResolvedValue([]);
    createDocument.mockResolvedValue({} as never);
    upsert.mockResolvedValue({
      row: { id: "tender-1" } as never,
      created: true,
    });
  });

  it("сохраняет закупку с источником KONTUR, сырым ответом и отметкой времени", async () => {
    const { tenders, rawByRegNumber } = fromSearchPage(konturSearchItem223);
    const adapter = fakeAdapter(tenders, rawByRegNumber);

    await syncKonturTenders({ laws: ["FZ_223"] }, { adapter });

    expect(upsert).toHaveBeenCalledTimes(1);
    const input = upsert.mock.calls[0]?.[0];
    expect(input?.data_source).toBe("KONTUR");
    // Номер извещения закрашен тестовым ключом, поэтому reg_number — это Id.
    expect(input?.reg_number).toBe("32616401973");
    // Сырая запись нужна, чтобы пересобрать закупку без нового платного запроса.
    expect(input?.raw_data).toMatchObject({ Id: "32616401973", NotificationNumber: "3261░░░░░░░" });
    expect(typeof input?.synced_at).toBe("string");
    expect(input?.price).toBe(2_511_590.84);
    // Скрытый заказчик сохранён как отсутствие данных, а не как выдуманное имя.
    expect(input?.customer_inn).toBeNull();
    expect(input?.region).toBe("Не указан");
  });

  it("сохраняет карточку с регионом, восстановленным из адреса поставки", async () => {
    const { tenders, rawByRegNumber } = fromCards(konturCard44);

    await syncKonturTenders({ laws: ["FZ_44"] }, { adapter: fakeAdapter(tenders, rawByRegNumber) });

    const input = upsert.mock.calls[0]?.[0];
    expect(input?.region).toBe("Республика Башкортостан");
    expect(input?.customer_inn).toBe("0218000351");
    expect(input?.price).toBe(365_426.6);
    expect(input?.security_bid).toBe(3654.27);
    expect(input?.only_for_smp).toBe(true);
    expect(input?.okpd2_codes).toEqual(["10.20.13.122"]);
    expect(input?.lots).toHaveLength(1);
  });

  it("считает созданные и обновлённые записи отдельно", async () => {
    const { tenders, rawByRegNumber } = fromSearchPage(konturSearchItem223, konturSearchItemNoPrice);
    upsert
      .mockResolvedValueOnce({ row: { id: "tender-1" } as never, created: true })
      .mockResolvedValueOnce({ row: { id: "tender-2" } as never, created: false });

    const result = await syncKonturTenders(
      { laws: ["FZ_44", "FZ_223"] },
      { adapter: fakeAdapter(tenders, rawByRegNumber) },
    );

    expect(result.synced).toBe(2);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
  });

  it("закупку первоисточника не перезаписывает и считает дублем", async () => {
    const { tenders, rawByRegNumber } = fromCards(konturCard44);
    upsert.mockResolvedValue({
      row: { id: "tender-1" } as never,
      created: false,
      duplicateOf: "EIS",
    });

    const result = await syncKonturTenders(
      { laws: ["FZ_44"] },
      { adapter: fakeAdapter(tenders, rawByRegNumber) },
    );

    expect(result.synced).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    // Документы строки ЕИС не трогаем: у первоисточника они уже свои.
    expect(findDocuments).not.toHaveBeenCalled();
    expect(result.documents).toBe(0);
  });

  it("сохраняет документы закупки и сопоставляет типы со значениями БД", async () => {
    const { tenders, rawByRegNumber } = fromCards(konturCard44);

    const result = await syncKonturTenders(
      { laws: ["FZ_44"] },
      { adapter: fakeAdapter(tenders, rawByRegNumber) },
    );

    expect(result.documents).toBe(7);
    const types = createDocument.mock.calls.map((call) => call[0]?.document_type);
    // «Типовой проект ГПД» — проект контракта, прочие приложения — other.
    expect(types).toEqual(["other", "other", "other", "contract", "other", "contract", "other"]);
    expect(createDocument.mock.calls[0]?.[0]).toMatchObject({
      // Ключ строки документа — реестровый номер закупки: по нему документы
      // читает воркер разбора и панель на карточке. UUID строки tenders не
      // подходит — плановая синхронизация пересоздаёт строки каждый прогон.
      tender_id: "0301300335621000492",
      source_type: "kontur_api",
      filename: "Декларация_ст.31.doc",
      file_url:
        "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=D458E2605929E670E05334548D0AFC89",
      raw_json: { konturDocumentId: "kontur-0301300335621000492-doc-1" },
    });
    // Уже сохранённые файлы ищутся там же, по номеру закупки.
    expect(findDocuments).toHaveBeenCalledWith("0301300335621000492");
  });

  it("проектная документация попадает в БД как вложение", async () => {
    const { tenders, rawByRegNumber } = fromCards(konturCard615);

    await syncKonturTenders({ laws: ["PP_RF_615"] }, { adapter: fakeAdapter(tenders, rawByRegNumber) });

    expect(createDocument.mock.calls[0]?.[0]?.document_type).toBe("attachment");
  });

  it("не дублирует документы, которые уже лежат в базе", async () => {
    const { tenders, rawByRegNumber } = fromCards(konturCard44);
    findDocuments.mockResolvedValue([
      { id: "doc-1", filename: "Декларация_ст.31.doc" } as never,
      { id: "doc-2", filename: "Раздел 1,2.docx" } as never,
    ]);

    const result = await syncKonturTenders(
      { laws: ["FZ_44"] },
      { adapter: fakeAdapter(tenders, rawByRegNumber) },
    );

    expect(result.documents).toBe(5);
    expect(createDocument).toHaveBeenCalledTimes(5);
  });

  it("не пишет документы, если синхронизация запрошена без них", async () => {
    const { tenders, rawByRegNumber } = fromCards(konturCard44);

    const result = await syncKonturTenders(
      { laws: ["FZ_44"] },
      { adapter: fakeAdapter(tenders, rawByRegNumber), saveDocuments: false },
    );

    expect(result.documents).toBe(0);
    expect(createDocument).not.toHaveBeenCalled();
    expect(result.synced).toBe(1);
  });

  it("ошибка документов не отменяет сохранённую закупку", async () => {
    const { tenders, rawByRegNumber } = fromCards(konturCard44);
    createDocument.mockRejectedValue(new Error("check constraint tender_documents_source_type"));

    const result = await syncKonturTenders(
      { laws: ["FZ_44"] },
      { adapter: fakeAdapter(tenders, rawByRegNumber) },
    );

    // Миграция ещё не применена — закупка всё равно в базе, ошибка видна в ответе.
    expect(result.synced).toBe(1);
    expect(result.documents).toBe(0);
    expect(result.documentsError).toContain("tender_documents_source_type");
  });

  it("пробрасывает счётчики, причины отброшенных записей и закрашенные поля", async () => {
    const { tenders, rawByRegNumber } = fromSearchPage(
      konturSearchItem223,
      konturSearchItemNoPrice,
      konturSearchItemCancelled,
    );
    const adapter = fakeAdapter(tenders, rawByRegNumber, {
      counters: { apiCalls: 4, cacheHits: 6, requestsToday: 40 },
      lastSkipped: ["cancelled"],
      lastBlurred: {
        fields: ["customerInn", "customerName", "etpLink", "regNumber"],
        documents: 0,
      },
      lastFilteredOut: 3,
    });

    const result = await syncKonturTenders({ laws: ["FZ_44"] }, { adapter });

    expect(result.apiCalls).toBe(4);
    expect(result.cacheHits).toBe(6);
    expect(result.requestsToday).toBe(40);
    expect(result.skipped).toEqual(["cancelled"]);
    expect(result.usage.apiCalls).toBe(3);
    // Без этого «регион не указан» выглядит как ошибка разбора, а не как тестовый ключ.
    expect(result.blurredFields).toEqual(["customerInn", "customerName", "etpLink", "regNumber"]);
    expect(result.blurredDocuments).toBe(0);
    // Поиск оплачен, а часть выдачи отсекли фильтры региона и ОКПД2 — это видно.
    expect(result.filteredOut).toBe(3);
  });

  it("ничего не сохраняет при пустой выдаче — это нормальный исход", async () => {
    const adapter = fakeAdapter([], {});

    const result = await syncKonturTenders({ laws: ["FZ_44"] }, { adapter });

    expect(result.synced).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    expect(result.documentsError).toBeNull();
  });
});

describe("суточный бюджет по тарифу", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findDocuments.mockResolvedValue([]);
    createDocument.mockResolvedValue({} as never);
    upsert.mockResolvedValue({ row: { id: "tender-1" } as never, created: true });
  });

  it("читает остаток до платного поиска и перечитывает после него", async () => {
    const { tenders, rawByRegNumber } = fromSearchPage(konturSearchItem223);
    const fetchLimitGroups = vi
      .fn()
      // До поиска — 199, после — 198: запрос ушёл в сеть.
      .mockResolvedValueOnce(TARIFF_GROUPS)
      .mockResolvedValueOnce([
        ...TARIFF_GROUPS.slice(0, 1).map((group) => ({ ...group, availableRequests: 198 })),
        ...TARIFF_GROUPS.slice(1),
      ]);
    const adapter = fakeAdapter(tenders, rawByRegNumber, { fetchLimitGroups });

    const result = await syncKonturTenders({ laws: ["FZ_44"] }, { adapter });

    expect(fetchLimitGroups.mock.calls).toEqual([[false], [true]]);
    expect(result.availableRequests).toBe(198);
  });

  it("исчерпанный лимит останавливает синхронизацию до обращения к API", async () => {
    const { tenders, rawByRegNumber } = fromSearchPage(konturSearchItem223);
    const exhausted = TARIFF_GROUPS.map((group) => ({ ...group, availableRequests: 0 }));
    const fetchTenders = vi.fn().mockResolvedValue(tenders);
    const adapter = fakeAdapter(tenders, rawByRegNumber, {
      fetchTenders,
      fetchLimitGroups: vi.fn().mockResolvedValue(exhausted),
    });

    await expect(syncKonturTenders({ laws: ["FZ_44"] }, { adapter })).rejects.toBeInstanceOf(
      KonturDailyLimitError,
    );
    // Платный поиск не выполнялся: 429 пришёл бы уже после списания запроса.
    expect(fetchTenders).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("нулевой остаток группы карточек не блокирует поиск", async () => {
    // Группы тарифа независимы: `purchase` обнуляется карточками закупок,
    // которые синхронизация не открывает. Блокировать из-за них поиск значило бы
    // оставить ленту без новых закупок при живом бюджете группы `search`.
    const { tenders, rawByRegNumber } = fromSearchPage(konturSearchItem223);
    const groups = TARIFF_GROUPS.map((group) =>
      group.limitGroup === "purchase" ? { ...group, availableRequests: 0 } : group,
    );
    const adapter = fakeAdapter(tenders, rawByRegNumber, {
      fetchLimitGroups: vi.fn().mockResolvedValue(groups),
    });

    const result = await syncKonturTenders({ laws: ["FZ_44"] }, { adapter });

    expect(result.synced).toBe(1);
    // Итог честно показывает самый узкий остаток, а не только поисковый.
    expect(result.availableRequests).toBe(0);
  });

  it("непрочитанный тариф не блокирует синхронизацию", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tenders, rawByRegNumber } = fromSearchPage(konturSearchItem223);
    const adapter = fakeAdapter(tenders, rawByRegNumber, {
      fetchLimitGroups: vi.fn().mockRejectedValue(new Error("сеть недоступна")),
    });

    const result = await syncKonturTenders({ laws: ["FZ_44"] }, { adapter });

    expect(result.synced).toBe(1);
    expect(result.availableRequests).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("остаток по тарифу не прочитан"));
    warn.mockRestore();
  });

  it("собирает сводку по тарифу для панели", () => {
    const tariff = toTariffInfo(TARIFF_GROUPS);
    expect(tariff.available).toBe(199);
    expect(tariff.tightest?.limitGroup).toBe("search");
    expect(tariff.subscriptionEnd).toBe("2026-09-30T18:59:00.000Z");
    expect(tariff.groups).toHaveLength(3);
  });

  it("пустой набор групп — не бесконечный лимит", () => {
    expect(toTariffInfo([])).toEqual({
      groups: [],
      available: null,
      tightest: null,
      subscriptionEnd: null,
    });
  });
});

describe("интервал между платными прогонами Контур.Закупок", () => {
  const NOW = "2026-09-24T18:00:00.000Z";
  const hoursAgo = (hours: number) =>
    new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
  const savedEnv = process.env.KONTUR_MIN_INTERVAL_HOURS;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KONTUR_MIN_INTERVAL_HOURS;
  });

  afterAll(() => {
    if (savedEnv === undefined) delete process.env.KONTUR_MIN_INTERVAL_HOURS;
    else process.env.KONTUR_MIN_INTERVAL_HOURS = savedEnv;
  });

  it("по умолчанию опрос раз в шесть часов", () => {
    expect(DEFAULT_KONTUR_SYNC_INTERVAL_HOURS).toBe(6);
    expect(konturSyncIntervalHours()).toBe(6);
  });

  it("переменная окружения задаёт порог, ноль и отрицательное значение отключают правило", () => {
    process.env.KONTUR_MIN_INTERVAL_HOURS = "12";
    expect(konturSyncIntervalHours()).toBe(12);

    process.env.KONTUR_MIN_INTERVAL_HOURS = "0";
    expect(konturSyncIntervalHours()).toBe(0);

    process.env.KONTUR_MIN_INTERVAL_HOURS = "-3";
    expect(konturSyncIntervalHours()).toBe(0);

    process.env.KONTUR_MIN_INTERVAL_HOURS = "не число";
    expect(konturSyncIntervalHours()).toBe(DEFAULT_KONTUR_SYNC_INTERVAL_HOURS);
  });

  it("свежий поиск откладывает прогон и называет причину", () => {
    const decision = decideKonturSync({
      lastPaidSearchAt: hoursAgo(2),
      now: NOW,
      minIntervalHours: 6,
    });

    expect(decision.query).toBe(false);
    expect(decision.hoursSinceLastSearch).toBeCloseTo(2, 5);
    // Причина уходит в лог планового прогона: без неё пропуск источника
    // неотличим от поломки ключа или сети.
    expect(decision.reason).toMatch(/последний платный поиск был 2,0 ч назад/);
    expect(decision.reason).toMatch(/интервал между прогонами — 6,0 ч/);
  });

  it("прошло больше интервала — источник опрашиваем", () => {
    const decision = decideKonturSync({
      lastPaidSearchAt: hoursAgo(7),
      now: NOW,
      minIntervalHours: 6,
    });

    expect(decision.query).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.hoursSinceLastSearch).toBeCloseTo(7, 5);
  });

  it("ровно интервал — тоже опрашиваем", () => {
    expect(
      decideKonturSync({ lastPaidSearchAt: hoursAgo(6), now: NOW, minIntervalHours: 6 }).query,
    ).toBe(true);
  });

  it("пустой журнал не останавливает источник", () => {
    expect(decideKonturSync({ lastPaidSearchAt: null, now: NOW, minIntervalHours: 6 })).toEqual({
      query: true,
      hoursSinceLastSearch: null,
      reason: null,
    });
  });

  it("нечитаемая метка времени трактуется как «неизвестно»", () => {
    expect(
      decideKonturSync({ lastPaidSearchAt: "вчера", now: NOW, minIntervalHours: 6 }).query,
    ).toBe(true);
  });

  it("отключённый интервал разрешает опрос каждый прогон", () => {
    expect(
      decideKonturSync({ lastPaidSearchAt: hoursAgo(0.1), now: NOW, minIntervalHours: 0 }).query,
    ).toBe(true);
  });

  it("метка из будущего считается нулём, а не «давно»", () => {
    const decision = decideKonturSync({
      lastPaidSearchAt: hoursAgo(-3),
      now: NOW,
      minIntervalHours: 6,
    });

    expect(decision.query).toBe(false);
    expect(decision.hoursSinceLastSearch).toBe(0);
    expect(decision.reason).toMatch(/меньше часа назад/);
  });

  it("время последнего платного поиска берётся из журнала расхода", async () => {
    const lastBillableCallAt = vi
      .mocked(konturCacheRepository.lastBillableCallAt)
      .mockResolvedValue(hoursAgo(5));

    await expect(konturLastPaidSearchAt()).resolves.toBe(hoursAgo(5));
    expect(lastBillableCallAt).toHaveBeenCalledWith("search");
  });
});

/**
 * Причина остановки обязана назвать площадки, которые продолжают работать.
 *
 * Перечень собирается из каталога источников, а не пишется от руки: он менялся
 * трижды за две недели, и строка «ЕИС и Сбербанк-АСТ продолжают работать» после
 * подключения ТЭК-Торг, Фабриканта и Росэлторга читалась оператором как «остальные
 * источники тоже сломались».
 */
function expectNamesWorkingSources(message: string | undefined): void {
  expect(message).toContain("продолжают работать");
  for (const title of freeSourceTitles()) {
    expect(message).toContain(title);
  }
}

describe("остановка платного источника до конца прогона", () => {
  const url = "https://api-zakupki.kontur.ru/external/v1/search";

  it("исчерпанный суточный бюджет останавливает источник и называет причину", () => {
    const stop = konturSourceStop(new KonturDailyLimitError(30, 30, "search"));

    expect(stop?.kind).toBe("budget");
    expect(stop?.message).toContain("30 из 30");
    expectNamesWorkingSources(stop?.message);
  });

  it("отклонённый ключ (401) останавливает источник и называет конец подписки", () => {
    const stop = konturSourceStop(new KonturAuthError(401, url, "<html>ключ недействителен</html>"));

    expect(stop?.kind).toBe("auth");
    expect(stop?.message).toContain("401");
    expect(stop?.message).toContain("подписк");
    expectNamesWorkingSources(stop?.message);
    // Тело ответа — служебный HTML площадки: оператору нужна причина, а не разметка.
    expect(stop?.message).not.toContain("html");
  });

  it("запрет группы методов (403) останавливает источник так же", () => {
    const stop = konturSourceStop(new KonturAuthError(403, url, ""));

    expect(stop?.kind).toBe("auth");
    expect(stop?.message).toContain("403");
  });

  it("обычные сбои источника не останавливают: их разбирает повтор и лог по ключевому слову", () => {
    expect(konturSourceStop(new KonturRateLimitError(429, url, "", 30))).toBeNull();
    expect(konturSourceStop(new KonturResponseParseError(url, "<html>страница входа</html>"))).toBeNull();
    expect(konturSourceStop(new Error("socket hang up"))).toBeNull();
    expect(konturSourceStop("не ошибка")).toBeNull();
  });
});

describe("saveKonturTenderDocuments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findDocuments.mockResolvedValue([]);
    createDocument.mockResolvedValue({} as never);
  });

  it("не обращается к базе, если документов нет", async () => {
    const { tenders } = fromSearchPage(konturSearchItem223);
    const tender = tenders[0] as Tender;

    const saved = await saveKonturTenderDocuments({ ...tender, documents: [] });

    expect(saved).toBe(0);
    expect(findDocuments).not.toHaveBeenCalled();
  });

  it("сохраняет каждый документ один раз за вызов", async () => {
    const { tenders } = fromCards(konturCard44);
    const tender = tenders[0] as Tender;

    const saved = await saveKonturTenderDocuments(tender);

    expect(saved).toBe(7);
    expect(createDocument).toHaveBeenCalledTimes(7);
    // Номер закупки — единственный ключ: вызывающий код его не передаёт.
    expect(createDocument.mock.calls[0]?.[0]?.tender_id).toBe(tender.regNumber);
  });
});
