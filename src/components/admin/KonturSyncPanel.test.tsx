/**
 * Тесты панели платного источника Контур.Закупки.
 *
 * Панель — единственное место, где видно, сколько запросов потрачено, поэтому
 * её главное свойство: числа берутся из тарифа источника, а не из нашего
 * журнала. Тариф здесь собран из реального ответа `/limitGroups`
 * (konturTestFixtures) тем же кодом, что и на сервере, — иначе тест проверял
 * бы собственную выдумку, а не то, что придёт по сети.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KonturSyncPanel } from "@/components/admin/KonturSyncPanel";
import type {
  KonturSyncResponse,
  KonturTariffPayload,
  KonturUsageResponse,
} from "@/services/konturApiService";
import {
  konturAvailableBudget,
  konturSubscriptionEnd,
  konturTightestLimitGroup,
  normalizeKonturLimitGroups,
} from "@/adapters/tender-source/konturParser";
import { konturLimitGroupsResponse } from "@/adapters/tender-source/konturTestFixtures";
import {
  searchProfileExamples,
  searchProfileRepository,
} from "@/repositories/searchProfileRepository";
import { freeSourceTitles } from "@/domain/sources";
import { joinRuList } from "@/utils/format";

/** Подтверждённые пути: их видно в журнале, и расхождение должно бросаться в глаза. */
const PATHS = {
  search: "/external/v1/search",
  tender: "/external/v1/purchases/{id}",
  testTender: "/external/v1/testpurchases/{id}",
  limitGroups: "/external/v1/limitGroups",
};

const GROUPS = normalizeKonturLimitGroups(konturLimitGroupsResponse);

/**
 * Тариф из настоящего ответа источника, снятого 23.09.2026: search 199/200,
 * purchase 199/200, results 200/200. Числа намеренно не совпадают с боевым
 * бюджетом (30 на метод в `usage()`): панель обязана показывать остаток по
 * тарифу, а не наш страховочный лимит, и на разных значениях подмена была бы
 * видна в тесте.
 */
const TARIFF: KonturTariffPayload = {
  groups: GROUPS,
  available: konturAvailableBudget(GROUPS),
  tightest: konturTightestLimitGroup(GROUPS),
  subscriptionEnd: konturSubscriptionEnd(GROUPS),
};

/** Тот же тариф с другим остатком в первой группе — для проверки предупреждений. */
function tariffWith(available: number): KonturTariffPayload {
  const groups = GROUPS.map((group, index) =>
    index === 0 ? { ...group, availableRequests: available } : group,
  );
  return {
    groups,
    available: konturAvailableBudget(groups),
    tightest: konturTightestLimitGroup(groups),
    subscriptionEnd: konturSubscriptionEnd(groups),
  };
}

function usage(overrides: Partial<KonturUsageResponse> = {}): KonturUsageResponse {
  return {
    configured: true,
    baseUrl: "https://api-zakupki.kontur.ru",
    paths: PATHS,
    // Боевой тариф: 30 запросов в сутки на каждый метод, счётчики независимы.
    dailyRequestLimit: 30,
    spentToday: 12,
    spentTodayByMethod: { search: 12, card: 0 },
    remainingToday: 18,
    remainingTodayByMethod: { search: 18, card: 30 },
    summary: { apiCalls: 12, cacheHits: 5, errors: 0, firstCallAt: null, lastCallAt: null },
    recent: [],
    storedResponses: 17,
    tariff: TARIFF,
    tariffError: null,
    ...overrides,
  };
}

const syncResponse: KonturSyncResponse = {
  synced: 4,
  created: 3,
  updated: 1,
  duplicates: 0,
  documents: 6,
  skipped: ["cancelled"],
  filteredOut: 2,
  apiCalls: 2,
  cacheHits: 1,
  requestsToday: 14,
  usage: usage().summary,
  documentsError: null,
  blurredFields: ["customerInn", "deliveryPlaces"],
  blurredDocuments: 1,
  availableRequests: 197,
  searches: 2,
  errors: [],
  // Панель администратора очередь документации не просит: это проверка ключа и
  // парсера, а не пополнение ленты, и фоновая работа на десятки минут здесь
  // появилась бы как побочный эффект отладочного запуска.
  documentsQueue: null,
};

/** Заглушка fetch: GET отдаёт сводку расхода, POST — результат синхронизации. */
function stubFetch(usagePayload: KonturUsageResponse, sync = syncResponse) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const payload = String(input).includes("/api/kontur/sync") ? sync : usagePayload;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Тело POST-запроса к синхронизации, если он был отправлен. */
function syncBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> | null {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/kontur/sync"));
  const init = call?.[1] as RequestInit | undefined;
  return typeof init?.body === "string"
    ? (JSON.parse(init.body) as Record<string, unknown>)
    : null;
}

describe("KonturSyncPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    /*
      Профили сеются явно. Репозиторий больше не отдаёт готовый набор сам:
      лента фильтровалась профилем, которого человек не создавал, и новый
      пользователь видел 1 закупку из 198. Тест, опиравшийся на тот посев,
      проверял бы заодно и его.
    */
    searchProfileRepository.save(searchProfileExamples);
  });

  it("предупреждает и блокирует запуск, если ключ API не задан", async () => {
    stubFetch(usage({ configured: false, tariff: null }));
    render(<KonturSyncPanel />);

    const note = (await screen.findByText(/KONTUR_API_KEY не задан/)).textContent ?? "";
    /*
      Отключение платного источника не должно читаться как «закупки больше не
      собираются»: перечень бесплатных площадок берётся из каталога источников,
      поэтому подпись не отстаёт от подключённых площадок.
    */
    expect(note).toContain(joinRuList(freeSourceTitles()));
    const button = screen.getByRole("button", { name: /Синхронизировать сейчас/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("показывает остаток по тарифу, а не наш дневной бюджет", async () => {
    // 18 — остаток от KONTUR_DAILY_REQUEST_LIMIT. Он страховка: если ключ
    // расходует кто-то ещё, журнал врёт, а `/limitGroups` — нет.
    stubFetch(usage());
    render(<KonturSyncPanel />);

    // Расход показан по методам: поиск и карточки — независимые группы тарифа,
    // и одна общая сумма скрыла бы, что карточки ещё не потрачены вовсе.
    expect(await screen.findByText("12 / 30")).toBeTruthy();
    expect(screen.getByText("0 / 30")).toBeTruthy();
    expect(screen.getByText("Остаток по тарифу")).toBeTruthy();
    expect(screen.getAllByText("199").length).toBeGreaterThan(0);
    expect(screen.queryByText("18")).toBeNull();
  });

  it("раскладывает остаток по группам тарифа и показывает срок действия", async () => {
    stubFetch(usage());
    render(<KonturSyncPanel />);

    expect(await screen.findByText("Поиск закупок")).toBeTruthy();
    expect(screen.getByText("Получение закупки")).toBeTruthy();
    expect(screen.getByText("Результаты закупок")).toBeTruthy();
    expect(screen.getAllByText("199 / 200")).toHaveLength(2);
    expect(screen.getByText("200 / 200")).toBeTruthy();
    // Модификаторы тарифа видны: они объясняют, за что именно списывается лимит.
    expect(screen.getByText(/SearchParticipants, Snippets/)).toBeTruthy();
    expect(screen.getByText(/Тариф действует до/)).toBeTruthy();
    expect(screen.getByText(/смена ключа сохранённые закупки не двоит/)).toBeTruthy();
  });

  it("показывает наш бюджет и причину, когда тариф не прочитан", async () => {
    stubFetch(usage({ tariff: null, tariffError: "HTTP 401: ключ не принят" }));
    render(<KonturSyncPanel />);

    expect(await screen.findByText(/Остаток по тарифу не прочитан/)).toBeTruthy();
    expect(screen.getByText(/HTTP 401: ключ не принят/)).toBeTruthy();
    // Журнал при этом остаётся достоверным — страховочный остаток показан.
    expect(screen.getByText("18")).toBeTruthy();
    expect(screen.getByText("12 / 30")).toBeTruthy();
  });

  it("предупреждает, когда остаток почти исчерпан", async () => {
    stubFetch(usage({ tariff: tariffWith(5) }));
    render(<KonturSyncPanel />);

    expect(await screen.findByText(/бюджет почти исчерпан/)).toBeTruthy();
  });

  it("отправляет фильтры выбранного профиля и показывает итог синхронизации", async () => {
    const fetchMock = stubFetch(usage());
    render(<KonturSyncPanel />);
    await screen.findByText("12 / 30");

    fireEvent.click(screen.getByRole("button", { name: /Синхронизировать сейчас/ }));

    await waitFor(() => expect(syncBody(fetchMock)).not.toBeNull());
    const profile = searchProfileRepository.getAll().filter((p) => p.enabled)[0]!;
    const body = syncBody(fetchMock)!;
    expect(body["keywords"]).toEqual(profile.keywords);
    expect(body["laws"]).toEqual(profile.laws);
    expect(body["saveDocuments"]).toBe(true);
    // По одному поиску на ключевое слово — столько запросов и обещаем пользователю.
    expect(await screen.findByText(/Поисков: 2/)).toBeTruthy();
    expect(screen.getByText(/Платных запросов: 2/)).toBeTruthy();
    expect(screen.getByText(/остаток по тарифу: 197/)).toBeTruthy();
  });

  it("объясняет, что часть выдачи отсекли фильтры, а часть значений скрыл тариф", async () => {
    stubFetch(usage());
    render(<KonturSyncPanel />);
    await screen.findByText("12 / 30");

    fireEvent.click(screen.getByRole("button", { name: /Синхронизировать сейчас/ }));

    expect(await screen.findByText(/Отсеяно фильтром региона или ОКПД2: 2/)).toBeTruthy();
    expect(screen.getByText(/Тариф ключа скрывает значения/)).toBeTruthy();
    expect(screen.getByText(/ИНН заказчика, места поставки \(регион\)/)).toBeTruthy();
    expect(screen.getByText(/ссылки в документах \(1 шт\.\)/)).toBeTruthy();
  });

  it("делит отброшенные записи на штатные и ошибочные", async () => {
    stubFetch(usage(), {
      ...syncResponse,
      skipped: ["cancelled", "cancelled", "no-deadline"],
      blurredFields: [],
      blurredDocuments: 0,
      filteredOut: 0,
    });
    render(<KonturSyncPanel />);
    await screen.findByText("12 / 30");

    fireEvent.click(screen.getByRole("button", { name: /Синхронизировать сейчас/ }));

    // Отменённая закупка — не потеря данных, предупреждать о ней нельзя.
    expect(await screen.findByText(/Отброшено штатно: отменена \(2\)/)).toBeTruthy();
    expect(screen.getByText(/Ответ не прочитан: нет срока подачи заявок \(1\)/)).toBeTruthy();
    expect(screen.queryByText(/Отсеяно фильтром/)).toBeNull();
  });

  it("показывает закупки, которые уже лежат в базе от ЕИС или Сбербанк-АСТ", async () => {
    stubFetch(usage(), {
      ...syncResponse,
      duplicates: 2,
      blurredFields: [],
      blurredDocuments: 0,
    });
    render(<KonturSyncPanel />);
    await screen.findByText("12 / 30");

    fireEvent.click(screen.getByRole("button", { name: /Синхронизировать сейчас/ }));

    expect(await screen.findByText(/Уже в базе от другого источника: 2/)).toBeTruthy();
    expect(screen.getByText(/дубль не создаём/)).toBeTruthy();
  });

  it("показывает журнал обращений с признаком ответа из кэша", async () => {
    stubFetch(
      usage({
        recent: [
          {
            id: "log-1",
            provider: "kontur",
            kind: "search",
            url: "https://api-zakupki.kontur.ru/external/v1/search",
            status: 200,
            from_cache: false,
            duration_ms: 840,
            error: null,
            requested_at: "2026-09-23T09:15:00.000Z",
          },
          {
            id: "log-2",
            provider: "kontur",
            kind: "limits",
            url: "https://api-zakupki.kontur.ru/external/v1/limitGroups",
            status: null,
            from_cache: true,
            duration_ms: 0,
            error: "UND_ERR_CONNECT_TIMEOUT",
            requested_at: "2026-09-23T09:16:00.000Z",
          },
        ],
      }),
    );
    render(<KonturSyncPanel />);

    expect(await screen.findByText("Поиск")).toBeTruthy();
    // Бесплатный запрос обязан быть подписан как бесплатный: иначе в журнале
    // кажется, что чтение тарифа тоже расходует trial.
    expect(screen.getByText("Остаток лимита (бесплатно)")).toBeTruthy();
    expect(screen.getByText("платный запрос")).toBeTruthy();
    expect(screen.getByText("кэш")).toBeTruthy();
    expect(screen.getByText("нет ответа")).toBeTruthy();
    expect(screen.getByText("UND_ERR_CONNECT_TIMEOUT")).toBeTruthy();
  });

  it("показывает ошибку синхронизации, не теряя сводку расхода", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/kontur/sync")) {
        return {
          ok: false,
          status: 429,
          json: async () => ({
            error: "Исчерпан суточный лимит запросов Контур.Закупок (поиск): 30 из 30.",
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => usage(),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<KonturSyncPanel />);
    await screen.findByText("12 / 30");
    fireEvent.click(screen.getByRole("button", { name: /Синхронизировать сейчас/ }));

    expect(await screen.findByText(/Исчерпан суточный лимит запросов/)).toBeTruthy();
    // Счётчики расхода остались на месте: ошибка синхронизации не должна
    // прятать то, сколько запросов уже потрачено.
    expect(screen.getByText("12 / 30")).toBeTruthy();
  });
});
