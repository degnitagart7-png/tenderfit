import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SearchProfile } from "@/domain/entities";
import type { KonturPressPlan } from "@/domain/konturPressPlan";
import type { WorkerStatusView } from "@/domain/workerStatus";
import type { KonturSyncReport, TenderSyncState } from "@/hooks/useTenderData";
import {
  konturApiService,
  type KonturDocumentsQueue,
  type KonturUsageResponse,
} from "@/services/konturApiService";
import {
  syncJobApiService,
  type EnqueueSyncJobResponse,
  type SyncJobsStatusResponse,
} from "@/services/syncJobApiService";
import { STORAGE_KEYS } from "@/lib/storage";
import { TenderSearchPanel } from "@/components/dashboard/TenderSearchPanel";

/*
  Панель проверяется на заглушках сервисов: смысл тестов в том, что партнёр
  видит состав бесплатного прогона и цену платного до запуска, что в запрос
  уходит ровно показанный план и что обещание совпадает с тем, что ответил
  сервер. Форма ответа `/api/kontur/usage` повторена настоящая (группа
  `search`, 24 из 30 — прогон 24.09.2026), потому что остаток берётся именно
  из неё.
*/
/*
  Контур отключён выключателем KONTUR_ENABLED (src/domain/features.ts). Этот файл
  проверяет его спящий интерфейс, поэтому на время тестов выключатель включён;
  поведение при выключенном Контуре проверяют отдельные тесты.
*/
vi.mock("@/domain/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/features")>()),
  KONTUR_ENABLED: true,
}));

vi.mock("@/services/konturApiService", () => ({
  konturApiService: { getUsage: vi.fn(), sync: vi.fn() },
}));

vi.mock("@/services/syncJobApiService", () => ({
  syncJobApiService: { getStatus: vi.fn(), enqueueFullSync: vi.fn() },
}));

const PANEL_TITLE = "Поиск новых закупок";

function profile(patch: Partial<SearchProfile>): SearchProfile {
  return {
    id: "sp-test",
    name: "Строительство и ремонт",
    laws: ["FZ_44", "FZ_223"],
    keywords: ["капитальный ремонт", "строительство", "реконструкция"],
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

function usage(patch: Partial<KonturUsageResponse> = {}): KonturUsageResponse {
  const search = {
    limitGroup: "search",
    modifiers: [],
    availableRequests: 24,
    totalLimit: 30,
    isPeriodic: true,
    subscriptionStart: "2026-09-01T00:00:00Z",
    subscriptionEnd: "2026-09-30T18:59:00Z",
  };
  return {
    configured: true,
    baseUrl: "https://api.zakupki.kontur.ru",
    paths: {
      search: "/external/v1/search",
      tender: "/external/v1/purchases",
      testTender: "/external/v1/testpurchases",
      limitGroups: "/external/v1/limitGroups",
    },
    dailyRequestLimit: 30,
    spentToday: 6,
    spentTodayByMethod: { search: 6, card: 0 },
    remainingToday: 24,
    remainingTodayByMethod: { search: 24, card: 30 },
    summary: { apiCalls: 6, cacheHits: 2, errors: 0, firstCallAt: null, lastCallAt: null },
    recent: [],
    storedResponses: 12,
    tariff: {
      groups: [search],
      available: 24,
      tightest: search,
      subscriptionEnd: search.subscriptionEnd,
    },
    tariffError: null,
    ...patch,
  };
}

function report(patch: Partial<KonturSyncReport> = {}): KonturSyncReport {
  return {
    profileName: "Строительство и ремонт",
    synced: 12,
    created: 5,
    updated: 4,
    duplicates: 3,
    documents: 0,
    skipped: [],
    filteredOut: 2,
    apiCalls: 3,
    cacheHits: 0,
    requestsToday: 9,
    usage: { apiCalls: 9, cacheHits: 0, errors: 0, firstCallAt: null, lastCallAt: null },
    documentsError: null,
    blurredFields: [],
    blurredDocuments: 0,
    availableRequests: 21,
    searches: 3,
    errors: [],
    // Девять = created 5 + updated 4: столько строк прогон записал от имени
    // Контур.Закупок, и все они ушли в очередь на документацию.
    documentsQueue: queue(),
    ...patch,
  };
}

/** Исход постановки документации в очередь. */
function queue(patch: Partial<KonturDocumentsQueue> = {}): KonturDocumentsQueue {
  return { queued: 9, jobId: "sync-job-1", deduped: false, error: null, ...patch };
}

/** Ответ GET /api/sync-jobs: панели нужна готовая подпись состояния. */
function workerStatus(patch: Partial<WorkerStatusView> = {}): SyncJobsStatusResponse {
  return {
    configured: true,
    workerId: "ru-vps",
    now: "2026-09-25T03:00:00.000Z",
    status: { heartbeat: null, lastJob: null, pending: 0 },
    view: {
      state: "online",
      label: "Сервер в России на связи 2 мин назад",
      hint:
        "Выход из России (95.167.245.92). Документация и плановый прогон выполняются на этом сервере.",
      minutesSinceSeen: 2,
      pending: 0,
      exitIp: "95.167.245.92",
      lastError: null,
      ...patch,
    },
    recent: [],
  };
}

/**
 * Ответ POST /api/sync-jobs на постановку бесплатного прогона.
 *
 * Задание возвращается целиком, но панель читает из него только `deduped` и
 * `status`: остальные поля нужны журналу, а не подписи под кнопкой.
 */
function enqueued(patch: Partial<EnqueueSyncJobResponse> = {}): EnqueueSyncJobResponse {
  return {
    job: {
      id: "job-full-1",
      kind: "full_sync",
      status: "pending",
      payload: { regNumbers: [], reason: "press" },
      requested_by: null,
      attempts: 0,
      worker_id: null,
      claimed_at: null,
      finished_at: null,
      report: null,
      error: null,
      created_at: "2026-10-03T21:30:00.000Z",
      updated_at: "2026-10-03T21:30:00.000Z",
    },
    deduped: false,
    view: workerStatus().view,
    ...patch,
  };
}

const IDLE: TenderSyncState = {
  syncing: false,
  error: null,
  lastSynced: 0,
  progress: null,
  report: null,
};

/** Панель управляемая: состояние раскрытия живёт у родителя, как на дашборде. */
function Harness({
  syncKontur,
  syncState = IDLE,
  initialOpen = true,
}: {
  syncKontur?: (plan: KonturPressPlan) => Promise<KonturSyncReport | null>;
  syncState?: TenderSyncState;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <TenderSearchPanel
      open={open}
      onOpenChange={setOpen}
      syncKontur={syncKontur ?? (async () => null)}
      syncState={syncState}
    />
  );
}

function seedProfiles(profiles: SearchProfile[]) {
  localStorage.setItem(STORAGE_KEYS.searchProfiles, JSON.stringify(profiles));
}

/** Карточка панели: `Card` рисует `<section>` с `<h2>` в шапке. */
function panelCard(): HTMLElement {
  const heading = screen.getByRole("heading", { name: PANEL_TITLE });
  const card = heading.closest("section");
  if (!card) throw new Error("Не найдена карточка панели");
  return card;
}

/**
 * Панель при открытии читает остаток по тарифу и состояние сервера в России.
 * Ждём, пока оба ответа осядут: `setUsage` и `setWorker` выполняются в
 * микротасках после обещаний, и без этой паузы обновление состояния прилетает за
 * пределами теста — React предупреждает об act(). Пустой `act` долистывает
 * очередь микротасков.
 */
async function settle(): Promise<void> {
  await waitFor(() => expect(vi.mocked(konturApiService.getUsage)).toHaveBeenCalled());
  await waitFor(() => expect(vi.mocked(syncJobApiService.getStatus)).toHaveBeenCalled());
  await act(async () => {});
}

/** Ждём, пока панель отрисуется, и возвращаем её текст одной строкой. */
async function panelText(): Promise<string> {
  await screen.findByRole("heading", { name: PANEL_TITLE });
  await settle();
  return (panelCard().textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("TenderSearchPanel — подтверждение платного прогона", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    seedProfiles([
      profile({ keywords: ["ремонт", "стройка", "проект", "надзор", "обследование"] }),
    ]);
    vi.mocked(konturApiService.getUsage).mockResolvedValue(usage());
    vi.mocked(syncJobApiService.getStatus).mockResolvedValue(workerStatus());
    vi.mocked(syncJobApiService.enqueueFullSync).mockResolvedValue(enqueued());
  });

  it("нажатие открывает подтверждение, а не тратит бюджет", async () => {
    const syncKontur = vi.fn().mockResolvedValue(null);
    render(<Harness syncKontur={syncKontur} initialOpen={false} />);

    expect(screen.queryByRole("heading", { name: PANEL_TITLE })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Найти новые закупки/i }));

    expect(screen.getByRole("heading", { name: PANEL_TITLE })).toBeTruthy();
    expect(syncKontur).not.toHaveBeenCalled();
    await settle();
  });

  it("показывает расход, остаток по тарифу и слова сверх потолка", async () => {
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);

    // Строка расхода — один узел: findByText дожидается ответа про остаток.
    await screen.findByText("Потратит до 3 платных поисков · остаток 24 из 30");

    const text = await panelText();
    expect(text).toContain("ремонт, стройка, проект");
    expect(text).toContain("Ещё 2 слова не участвуют");
    expect(text).toContain("потолок 3 поиска на нажатие");
    expect(text).toContain("надзор, обследование");
    expect(text).toContain("Прогон платный");
  });

  it("запускает прогон ровно по показанному плану", async () => {
    const syncKontur = vi.fn().mockResolvedValue(null);
    render(<Harness syncKontur={syncKontur} />);
    await panelText();

    fireEvent.click(screen.getByRole("button", { name: /платный поиск/i }));

    expect(syncKontur).toHaveBeenCalledTimes(1);
    const plan = syncKontur.mock.calls[0]![0] as KonturPressPlan;
    expect(plan.keywords).toEqual(["ремонт", "стройка", "проект"]);
    expect(plan.spend).toBe(3);
    expect(plan.omitted).toEqual(["надзор", "обследование"]);
    expect(plan.profile?.name).toBe("Строительство и ремонт");
    // План проверяется синхронно — до того, как ответ прогона что-то изменит.
    // А вот перечитывание состояния сервера идёт следом, и его обновление надо
    // долистать внутри теста, иначе React пожалуется на act().
    await act(async () => {});
  });

  it("второй включённый профиль можно выбрать, и план пересчитывается", async () => {
    seedProfiles([
      profile({ id: "sp-1", name: "Строительство", keywords: ["ремонт", "стройка"] }),
      profile({ id: "sp-2", name: "Автомобили", keywords: ["автомобиль"] }),
    ]);
    const syncKontur = vi.fn().mockResolvedValue(null);
    render(<Harness syncKontur={syncKontur} />);
    await panelText();

    fireEvent.change(screen.getByLabelText("Профиль поиска для прогона"), {
      target: { value: "sp-2" },
    });

    fireEvent.click(screen.getByRole("button", { name: /платный поиск/i }));
    const plan = syncKontur.mock.calls[0]![0] as KonturPressPlan;
    expect(plan.profile?.id).toBe("sp-2");
    expect(plan.keywords).toEqual(["автомобиль"]);
    expect(plan.spend).toBe(1);
    await screen.findByText("Потратит 1 платный поиск · остаток 24 из 30");
    await act(async () => {});
  });

  it("«Отмена» закрывает панель без запроса", async () => {
    const syncKontur = vi.fn().mockResolvedValue(null);
    render(<Harness syncKontur={syncKontur} />);
    await panelText();

    fireEvent.click(screen.getByRole("button", { name: /Отмена/i }));

    expect(screen.queryByRole("heading", { name: PANEL_TITLE })).toBeNull();
    expect(syncKontur).not.toHaveBeenCalled();
  });

  it("отчёт показывает счётчики прогона и куда ушла документация", async () => {
    render(
      <Harness
        syncKontur={vi.fn().mockResolvedValue(null)}
        syncState={{ ...IDLE, lastSynced: Date.parse("2026-09-24T18:05:00Z"), report: report() }}
      />,
    );

    const text = await panelText();
    expect(text).toContain("найдено 12 · новых 5 · обновлено 4");
    expect(text).toContain("уже было от другого источника 3");
    expect(text).toContain("платных поисков 3");
    expect(text).toContain("остаток по тарифу 21");
    expect(text).toContain("Отсеяно фильтром региона или ОКПД2: 2");
    /*
      Обещание документации обязано совпадать с ответом сервера: файлы качает
      машина с российским адресом, и партнёр не должен ждать глубокий разбор по
      закупкам, добавленным кнопкой.
    */
    expect(text).toContain("Документация 9 закупок поставлена в очередь");
    expect(text).toContain("её скачает сервер в России");
    expect(text).toContain("Глубокий разбор кнопка не запускает");
  });

  it("без ключа источника платный поиск не предлагается, и это сказано прямо", async () => {
    vi.mocked(konturApiService.getUsage).mockResolvedValue(
      usage({ configured: false, tariff: null }),
    );
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);

    const text = await panelText();
    expect(text).toContain("ключ источника не задан");
    // Бесплатный прогон от платного ключа не зависит: лишить партнёра ленты
    // из-за кончившейся подписки значило бы оставить его без закупок вовсе.
    expect(screen.queryByRole("button", { name: /платный поиск/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Запустить поиск" })).toBeTruthy();
  });

  it("без включённого профиля в браузере платный поиск нечего искать, а прогон доступен", async () => {
    seedProfiles([]);
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);

    const text = await panelText();
    expect(text).toContain("Нет включённого профиля поиска");
    expect(screen.queryByRole("button", { name: /платный поиск/i })).toBeNull();
    const link = screen.getByRole("link", { name: /Указать, что ищем/i });
    expect(link.getAttribute("href")).toBe("/settings/search");
    /*
      Прогон идёт по профилям, заведённым на сервере, а не по списку в этом
      браузере: заблокировать его значило бы сказать, что искать нечего, когда
      сервер вполне может опросить площадки.
    */
    expect(screen.getByRole("button", { name: "Запустить поиск" })).toBeTruthy();
  });

  it("непроочитанный остаток не блокирует прогон: бюджет всё равно проверит сервер", async () => {
    vi.mocked(konturApiService.getUsage).mockRejectedValue(new Error("HTTP 500"));
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);

    const text = await panelText();
    expect(text).toContain("остаток не прочитан");
    expect(text).toContain("Остаток не прочитан: HTTP 500");

    const run = screen.getByRole("button", { name: /платный поиск/i });
    expect(run.hasAttribute("disabled")).toBe(false);
    // Чтение остатка одноразовое: сбой не должен дёргать роут на каждый рендер.
    await waitFor(() => expect(vi.mocked(konturApiService.getUsage)).toHaveBeenCalledTimes(1));
  });

  it("пока платный прогон идёт, кнопки заблокированы и видно, что именно идёт", async () => {
    render(
      <Harness
        syncKontur={vi.fn().mockResolvedValue(null)}
        syncState={{
          ...IDLE,
          syncing: true,
          progress: "Контур.Закупки · профиль «Строительство и ремонт»…",
        }}
      />,
    );
    await panelText();

    const run = screen.getByRole("button", { name: "Ищем…" });
    expect(run.hasAttribute("disabled")).toBe(true);
    const trigger = screen.getByRole("button", { name: /Контур\.Закупки · профиль/ });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    /*
      Бесплатный прогон в это время тоже заблокирован: оба прогона опрашивают
      одни и те же источники, и второй, запущенный поверх первого, записал бы те
      же закупки заново и потратил десятки минут сервера впустую.
    */
    const free = screen.getByRole("button", { name: "Запустить поиск" });
    expect(free.hasAttribute("disabled")).toBe(true);
  });

  it("ошибки отдельных поисков видны в отчёте", async () => {
    render(
      <Harness
        syncKontur={vi.fn().mockResolvedValue(null)}
        syncState={{
          ...IDLE,
          report: report({
            created: 0,
            documentsQueue: queue({ queued: 0, jobId: null }),
            errors: ["надзор: Исчерпан суточный лимит"],
          }),
        }}
      />,
    );

    const text = await panelText();
    expect(text).toContain("надзор: Исчерпан суточный лимит");
    // Ставить в очередь нечего — обещание документации не показывается.
    expect(text).not.toContain("Документация 9");
  });

  it("повторное нажатие не плодит задания: панель говорит, что оно уже в очереди", async () => {
    render(
      <Harness
        syncKontur={vi.fn().mockResolvedValue(null)}
        syncState={{ ...IDLE, report: report({ documentsQueue: queue({ deduped: true }) }) }}
      />,
    );

    const text = await panelText();
    expect(text).toContain("Документация 9 закупок уже в очереди — повторно не ставили");
    expect(text).toContain("Глубокий разбор кнопка не запускает");
  });

  it("отказ очереди показан как отказ: причина и что будет вместо неё", async () => {
    const reason = "Очередь заданий не настроена: примените миграцию";
    render(
      <Harness
        syncKontur={vi.fn().mockResolvedValue(null)}
        syncState={{
          ...IDLE,
          report: report({
            documentsQueue: queue({ queued: 0, jobId: null, error: reason }),
          }),
        }}
      />,
    );

    const text = await panelText();
    expect(text).toContain(`Документация не поставлена в очередь: ${reason}`);
    expect(text).toContain("файлы к ним добавит плановый прогон");
  });

  it("ответ прежнего сервера без поля очереди не обещает документацию", async () => {
    render(
      <Harness
        syncKontur={vi.fn().mockResolvedValue(null)}
        syncState={{ ...IDLE, report: report({ documentsQueue: null }) }}
      />,
    );

    const text = await panelText();
    expect(text).toContain("Документации у новых закупок нет");
    expect(text).not.toContain("поставлена в очередь");
  });

  it("состояние сервера в России видно до запуска прогона", async () => {
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);

    const text = await panelText();
    expect(text).toContain("Сервер в России на связи 2 мин назад");
    // Пока сервер на связи, пояснение лежит в подсказке, а не печатается.
    expect(screen.getByTitle(/Выход из России \(95\.167\.245\.92\)/)).toBeTruthy();
  });

  it("сервер не запущен — партнёр это видит, но прогон не заблокирован", async () => {
    vi.mocked(syncJobApiService.getStatus).mockResolvedValue(
      workerStatus({
        state: "unknown",
        label: "Сервер в России ещё не выходил на связь",
        hint:
          "Он не настроен или не запущен. Закупки в ленте есть, но документация к ним " +
          "не загружается и глубокий разбор не выполняется.",
        minutesSinceSeen: null,
        exitIp: null,
      }),
    );
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);

    const text = await panelText();
    expect(text).toContain("Сервер в России ещё не выходил на связь");
    expect(text).toContain("документация к ним не загружается");
    /*
      Платный поиск от сервера в России не зависит: Контур.Закупки отвечают
      Vercel. Блокировать его значило бы лишить партнёра ленты из-за поломки,
      которая к поиску отношения не имеет.
    */
    const run = screen.getByRole("button", { name: /платный поиск/i });
    expect(run.hasAttribute("disabled")).toBe(false);
    /*
      Бесплатный прогон выполняет именно этот сервер, поэтому молчащая машина
      обязана быть названа до нажатия, а не после. Задание при этом всё равно
      ставится: очередь переживёт перезапуск, а блокировка не починит сервер и
      только спрячет от партнёра способ пополнить ленту.
    */
    expect(text).toContain("Сервер в России сейчас не на связи");
    const free = screen.getByRole("button", { name: "Запустить поиск" });
    expect(free.hasAttribute("disabled")).toBe(false);
  });

  it("сбой чтения состояния не прячется и читается повторно", async () => {
    vi.mocked(syncJobApiService.getStatus).mockRejectedValueOnce(
      new Error("Очередь заданий не настроена: примените миграцию"),
    );
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);

    const text = await panelText();
    expect(text).toContain("Сервер не проверен: Очередь заданий не настроена");

    fireEvent.click(screen.getByRole("button", { name: /Повторить/i }));
    await waitFor(() => expect(vi.mocked(syncJobApiService.getStatus)).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect((panelCard().textContent ?? "").replace(/\s+/g, " ")).toContain(
      "Сервер в России на связи 2 мин назад",
    );
  });

  it("после прогона состояние перечитывается: очередь изменилась", async () => {
    const syncKontur = vi.fn().mockResolvedValue(null);
    render(<Harness syncKontur={syncKontur} />);
    await panelText();

    // Прогон поставил задание, поэтому подпись обязана перечитаться: показать
    // прежнюю длину очереди — значит показать неправду про созданное задание.
    vi.mocked(syncJobApiService.getStatus).mockResolvedValue(
      workerStatus({
        pending: 1,
        hint: "Выход из России (95.167.245.92). В очереди заданий: 1.",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /платный поиск/i }));

    await waitFor(() => expect(vi.mocked(syncJobApiService.getStatus)).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(syncKontur).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle(/В очереди заданий: 1\./)).toBeTruthy();
  });
});

/*
  Основное действие панели — бесплатный прогон: он не тратит тариф, опрашивает
  все площадки, которые отвечают серверу в России, и не зависит от подписки на
  агрегатор. Тесты держатся за две вещи: состав прогона берётся из каталога
  источников, а не напечатан строкой (иначе он разойдётся с реальностью при
  первом же подключённом источнике), и исход постановки показывается как есть —
  включая повтор и отказ очереди.
*/
describe("TenderSearchPanel — бесплатный прогон площадок", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    seedProfiles([profile({})]);
    vi.mocked(konturApiService.getUsage).mockResolvedValue(usage());
    vi.mocked(syncJobApiService.getStatus).mockResolvedValue(workerStatus());
    vi.mocked(syncJobApiService.enqueueFullSync).mockResolvedValue(enqueued());
  });

  /** Нажатие и ожидание, пока ответ постановки осядет в состоянии панели. */
  async function pressFreeRun(): Promise<string> {
    fireEvent.click(screen.getByRole("button", { name: "Запустить поиск" }));
    await waitFor(() => expect(vi.mocked(syncJobApiService.enqueueFullSync)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(syncJobApiService.getStatus)).toHaveBeenCalledTimes(2));
    await act(async () => {});
    return (panelCard().textContent ?? "").replace(/\s+/g, " ").trim();
  }

  it("называет площадки списком из каталога источников", async () => {
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);

    const text = await panelText();
    expect(text).toContain("ЕИС, ТЭК-Торг, Сбербанк-АСТ, Фабрикант и Росэлторг");
    // Платный агрегатор в бесплатном прогоне не участвует: обещать его — значит
    // обещать расход тарифа, которого партнёр не заказывал.
    expect(text).not.toContain("Контур.Закупки, ");
    // Условие «платный источник не тратится» теперь в подсказке заголовка.
    expect(screen.getByText("Поиск на площадках").getAttribute("title")).toContain(
      "Платный источник не тратится",
    );
  });

  it("честно говорит, что прогон идёт по условиям на сервере и страница его не ждёт", async () => {
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);

    const text = await panelText();
    expect(screen.getByText("Поиск на площадках").getAttribute("title")).toContain(
      "по условиям, заведённым на сервере",
    );
    expect(text).toContain("лента обновится сама");
  });

  it("нажатие ставит прогон в очередь и перечитывает состояние сервера", async () => {
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);
    await panelText();

    const text = await pressFreeRun();
    expect(text).toContain("Поиск поставлен в очередь");
    expect(text).toContain("начнётся в течение минуты");
    // Платный поиск при этом не запускается: нажатие не имеет права потратить
    // тариф, который партнёр не подтверждал.
    expect(vi.mocked(konturApiService.sync)).not.toHaveBeenCalled();
  });

  it("повторное нажатие не плодит прогон: панель говорит, что он уже в очереди", async () => {
    vi.mocked(syncJobApiService.enqueueFullSync).mockResolvedValue(enqueued({ deduped: true }));
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);
    await panelText();

    const text = await pressFreeRun();
    expect(text).toContain("Поиск уже в очереди — повторно не ставили");
    expect(text).not.toContain("Поиск поставлен в очередь");
  });

  it("отказ очереди показан причиной и тем, что лента всё равно пополняется", async () => {
    vi.mocked(syncJobApiService.enqueueFullSync).mockRejectedValue(
      new Error("Очередь заданий не настроена: примените миграцию"),
    );
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);
    await panelText();

    const text = await pressFreeRun();
    expect(text).toContain(
      "Поиск не запущен: Очередь заданий не настроена: примените миграцию",
    );
    // Без этой строки отказ выглядит как «лента больше не пополняется», хотя
    // расписание на сервере продолжает работать.
    expect(text).toContain("Лента пополняется и по расписанию — каждые 2 часа");
  });

  it("без ключа платного источника бесплатный прогон остаётся основным действием", async () => {
    vi.mocked(konturApiService.getUsage).mockResolvedValue(
      usage({ configured: false, tariff: null }),
    );
    render(<Harness syncKontur={vi.fn().mockResolvedValue(null)} />);
    await panelText();

    const text = await pressFreeRun();
    expect(text).toContain("Поиск поставлен в очередь");
    expect(text).toContain("Контур.Закупки не подключены");
  });
});
