import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchProfile } from "@/domain/entities";
import { konturPressPlan } from "@/domain/konturPressPlan";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { konturApiService, type KonturSyncResponse } from "@/services/konturApiService";
import { tenderApiService } from "@/services/tenderApiService";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { useTenderData, type KonturSyncReport } from "./useTenderData";

/*
  Хук проверяется без сети: оба сервиса — заглушки, профили поиска собираются
  вручную. Смысл тестов в том, что уходит в запрос и что видит экран, а не в
  разборе ответа Контур.Закупок (это покрыто тестами адаптера и парсера).
*/
vi.mock("@/services/konturApiService", () => ({
  konturApiService: { sync: vi.fn(), getUsage: vi.fn() },
}));

vi.mock("@/services/tenderApiService", () => ({
  tenderApiService: { getRows: vi.fn() },
}));

vi.mock("@/repositories/companyProfileRepository", () => ({
  companyProfileRepository: { get: vi.fn() },
}));

function profile(patch: Partial<SearchProfile>): SearchProfile {
  return {
    id: "sp-test",
    name: "Строительство и ремонт",
    laws: ["FZ_44", "FZ_223"],
    keywords: ["капитальный ремонт", "строительство", "реконструкция"],
    stopWords: ["аренда"],
    okpd2Codes: ["41.20"],
    regions: ["Москва"],
    customerInns: [],
    minPrice: 1_000_000,
    maxPrice: 200_000_000,
    onlyOpenForSubmission: true,
    enabled: true,
    ...patch,
  };
}

/** Ответ роута целиком: хук обязан пробросить его в отчёт без потерь. */
function syncResponse(patch: Partial<KonturSyncResponse> = {}): KonturSyncResponse {
  return {
    synced: 12,
    created: 5,
    updated: 4,
    duplicates: 3,
    documents: 0,
    skipped: [],
    filteredOut: 2,
    apiCalls: 3,
    cacheHits: 0,
    requestsToday: 7,
    usage: { apiCalls: 7, cacheHits: 0, errors: 0, firstCallAt: null, lastCallAt: null },
    documentsError: null,
    blurredFields: [],
    blurredDocuments: 0,
    availableRequests: 23,
    searches: 3,
    errors: [],
    // Девять = created 5 + updated 4: столько строк прогон записал от имени
    // Контур.Закупок, и все они ушли в очередь на документацию.
    documentsQueue: { queued: 9, jobId: "sync-job-1", deduped: false, error: null },
    ...patch,
  };
}

async function mount() {
  const hook = renderHook(() => useTenderData());
  // Загрузка ленты на первом рендере: без неё тест ловил бы её запросы как свои.
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe("useTenderData — прогон по кнопке", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(companyProfileRepository.get).mockReturnValue(demoCompanyProfile);
    vi.mocked(tenderApiService.getRows).mockResolvedValue([]);
    vi.mocked(konturApiService.sync).mockResolvedValue(syncResponse());
  });

  it("отправляет ровно те слова, что вошли в план, и одну страницу на слово", async () => {
    const { result } = await mount();
    // Пять слов, потолок три: в запрос обязаны уйти первые три, а не все.
    const plan = konturPressPlan(
      [
        profile({
          keywords: ["ремонт", "стройка", "проект", "надзор", "обследование"],
        }),
      ],
      null,
    );

    await act(async () => {
      await result.current.syncKontur(plan);
    });

    expect(konturApiService.sync).toHaveBeenCalledTimes(1);
    const request = vi.mocked(konturApiService.sync).mock.calls[0]![0];
    expect(request.keywords).toEqual(["ремонт", "стройка", "проект"]);
    expect(request.laws).toEqual(["FZ_44", "FZ_223"]);
    /*
      Одна страница — это и есть гарантия «не больше трёх платных поисков»:
      с фильтром региона адаптер иначе листал бы выдачу до пяти страниц на
      слово, то есть потратил бы до пятнадцати запросов вместо трёх.
    */
    expect(request.maxPages).toBe(1);
    expect(request.limit).toBe(50);
    // Документов в поисковой выдаче Контур нет, поэтому писать их неоткуда.
    expect(request.saveDocuments).toBe(false);
    /*
      Документацию найденных закупок качает сервер с российским адресом:
      хранилище файлов ЕИС зарубежным не отвечает. Без этой просьбы прогон
      вернул бы закупки без файлов и без объяснения, где они.
    */
    expect(request.queueDocuments).toBe(true);
    expect(request.regions).toEqual(["Москва"]);
    expect(request.okpd2Codes).toEqual(["41.20"]);
    expect(request.minPrice).toBe(1_000_000);
  });

  it("после удачного прогона возвращает отчёт с именем профиля и перечитывает ленту", async () => {
    const { result } = await mount();
    const callsBefore = vi.mocked(tenderApiService.getRows).mock.calls.length;

    /*
      Объявлено без инициализатора и с `!`: присваивание происходит внутри
      замыкания `act()`, а его TS в поток не включает. С `= null` переменная
      осталась бы суженной до `null`, и поля отчёта компилятор не увидел бы.
    */
    let report!: KonturSyncReport | null;
    await act(async () => {
      report = await result.current.syncKontur(konturPressPlan([profile({})], null));
    });

    expect(report?.profileName).toBe("Строительство и ремонт");
    expect(report?.synced).toBe(12);
    expect(result.current.syncState.report?.created).toBe(5);
    expect(result.current.syncState.report?.duplicates).toBe(3);
    // Исход постановки документации доходит до экрана без потерь: по нему
    // панель пишет, что файлы скачает сервер в России.
    expect(result.current.syncState.report?.documentsQueue).toEqual({
      queued: 9,
      jobId: "sync-job-1",
      deduped: false,
      error: null,
    });
    expect(result.current.syncState.syncing).toBe(false);
    expect(result.current.syncState.error).toBeNull();
    expect(result.current.syncState.lastSynced).toBeGreaterThan(0);
    // Лента перечитана: иначе новые закупки появились бы только после F5.
    expect(vi.mocked(tenderApiService.getRows).mock.calls.length).toBe(callsBefore + 1);
  });

  it("без включённого профиля не уходит в сеть и говорит, что делать", async () => {
    const { result } = await mount();

    await act(async () => {
      await result.current.syncKontur(konturPressPlan([], null));
    });

    expect(konturApiService.sync).not.toHaveBeenCalled();
    expect(result.current.syncState.error).toContain("Нет включённого профиля поиска");
    expect(result.current.syncState.report).toBeNull();
  });

  it("нулевой расход не становится запросом", async () => {
    const { result } = await mount();

    await act(async () => {
      await result.current.syncKontur(konturPressPlan([profile({})], null, 0));
    });

    expect(konturApiService.sync).not.toHaveBeenCalled();
    expect(result.current.syncState.error).toContain("потолок платных поисков равен нулю");
  });

  it("отказ источника показывается его же текстом, а прошлый удачный прогон не затирается", async () => {
    const { result } = await mount();
    vi.mocked(konturApiService.sync).mockRejectedValueOnce(
      new Error("Исчерпан суточный лимит запросов Контур.Закупок: 30 из 30."),
    );

    await act(async () => {
      await result.current.syncKontur(konturPressPlan([profile({})], null));
    });

    expect(result.current.syncState.syncing).toBe(false);
    expect(result.current.syncState.error).toContain("Исчерпан суточный лимит");
    expect(result.current.syncState.report).toBeNull();
    // Успешного прогона в этом сеансе не было — момент остаётся нулевым,
    // а не «только что», иначе экран солгал бы про свежесть ленты.
    expect(result.current.syncState.lastSynced).toBe(0);

    await act(async () => {
      await result.current.syncKontur(konturPressPlan([profile({})], null));
    });
    const syncedAt = result.current.syncState.lastSynced;
    expect(syncedAt).toBeGreaterThan(0);

    // Второй отказ: время последнего удачного прогона сохраняется.
    vi.mocked(konturApiService.sync).mockRejectedValueOnce(new Error("Ключ отклонён"));
    await act(async () => {
      await result.current.syncKontur(konturPressPlan([profile({})], null));
    });
    expect(result.current.syncState.error).toBe("Ключ отклонён");
    expect(result.current.syncState.lastSynced).toBe(syncedAt);
  });

  it("сетевой сбой показывается по-русски, а не «Failed to fetch»", async () => {
    const { result } = await mount();
    vi.mocked(konturApiService.sync).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await act(async () => {
      await result.current.syncKontur(konturPressPlan([profile({})], null));
    });

    expect(result.current.syncState.error).toContain("Сервер не ответил");
    expect(result.current.syncState.error).not.toContain("Failed to fetch");
  });

  it("пока прогон идёт, экран видит состояние и подпись профиля", async () => {
    const { result } = await mount();
    let release: (value: KonturSyncResponse) => void = () => {};
    vi.mocked(konturApiService.sync).mockReturnValue(
      new Promise<KonturSyncResponse>((resolve) => {
        release = resolve;
      }),
    );

    let running: Promise<unknown> = Promise.resolve();
    act(() => {
      running = result.current.syncKontur(konturPressPlan([profile({})], null));
    });

    expect(result.current.syncState.syncing).toBe(true);
    expect(result.current.syncState.progress).toContain("Строительство и ремонт");

    await act(async () => {
      release(syncResponse());
      await running;
    });
    expect(result.current.syncState.syncing).toBe(false);
  });
});


describe("useTenderData — свежие закупки без перезагрузки страницы", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(companyProfileRepository.get).mockReturnValue(demoCompanyProfile);
    vi.mocked(tenderApiService.getRows).mockResolvedValue([]);
  });

  it("возвращение на вкладку перечитывает ленту, если данные старше пяти минут", async () => {
    const realNow = Date.now;
    let now = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await mount();
      expect(tenderApiService.getRows).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event("focus"));
      expect(tenderApiService.getRows).toHaveBeenCalledTimes(1);

      now += 6 * 60_000;
      window.dispatchEvent(new Event("focus"));
      await waitFor(() => expect(tenderApiService.getRows).toHaveBeenCalledTimes(2));
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("фоновый сбой не заменяет показанную ленту ошибкой", async () => {
    const realNow = Date.now;
    let now = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { result } = await mount();
      vi.mocked(tenderApiService.getRows).mockRejectedValueOnce(new Error("сеть"));

      now += 6 * 60_000;
      window.dispatchEvent(new Event("focus"));
      await waitFor(() => expect(tenderApiService.getRows).toHaveBeenCalledTimes(2));

      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });
});
