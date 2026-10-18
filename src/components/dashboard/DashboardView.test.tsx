import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { CompanyProfile, HardBlocker, Tender, TenderAnalysis } from "@/domain/entities";
import { UNKNOWN_CUSTOMER, UNKNOWN_REGION } from "@/domain/entities";
import type { PipelineStatus, TenderVerdict } from "@/domain/enums";
import type { TenderRow } from "@/domain/filtering";
import { demoTenders } from "@/mocks/tenders";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { useTenderData } from "@/hooks/useTenderData";
import { STORAGE_KEYS } from "@/lib/storage";
import {
  searchProfileExamples,
  searchProfileRepository,
} from "@/repositories/searchProfileRepository";
import { syncJobApiService } from "@/services/syncJobApiService";
import { DashboardView } from "@/components/dashboard/DashboardView";
import { URGENT_DEADLINE_DAYS } from "@/domain/scoring";
import { formatTenderPrice } from "@/utils/format";

/*
  Контур отключён выключателем KONTUR_ENABLED (src/domain/features.ts). Этот файл
  проверяет его спящий интерфейс, поэтому на время тестов выключатель включён;
  поведение при выключенном Контуре проверяют отдельные тесты.
*/
vi.mock("@/domain/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/features")>()),
  KONTUR_ENABLED: true,
}));

vi.mock("@/hooks/useTenderData", () => ({
  useTenderData: vi.fn(),
}));

/*
  Панель поиска читает остаток по тарифу при открытии. Здесь проверяется не он
  (это тесты TenderSearchPanel), а место кнопки на экране, поэтому сервис
  отвечает отказом — и запрос в сеть из теста не уходит.
*/
vi.mock("@/services/konturApiService", () => ({
  konturApiService: {
    getUsage: vi.fn().mockRejectedValue(new Error("Остаток в этом тесте не читается")),
    sync: vi.fn(),
  },
}));

/*
  Панель читает и состояние сервера в России, и очередь заданий: оба сервиса
  отвечают отказом, чтобы тест не уходил в сеть. Подписи сбоя здесь не
  проверяются — их проверяют тесты TenderSearchPanel.
*/
vi.mock("@/services/syncJobApiService", () => ({
  syncJobApiService: {
    getStatus: vi.fn().mockRejectedValue(new Error("Состояние сервера в этом тесте не читается")),
    enqueueFullSync: vi.fn().mockRejectedValue(new Error("Очередь в этом тесте не ставится")),
  },
}));

const HOUR = 3600 * 1000;
const iso = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR).toISOString();

/** Текст экрана целиком со схлопнутыми пробелами: подписи собраны из нескольких узлов. */
function textOf(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Карточка блока по его заголовку: `Card` рисует `<section>` с `<h2>`. */
function cardOf(container: HTMLElement, title: string): HTMLElement {
  const heading = within(container).getByRole("heading", { name: title });
  const card = heading.closest("section");
  if (!card) throw new Error(`Не найдена карточка «${title}»`);
  return card;
}

interface RowSpec {
  id: string;
  subject: string;
  /** Через сколько часов закрывается подача; отрицательное — срок уже истёк. */
  hoursLeft: number;
  verdict: TenderVerdict;
  /** Причина отказа: попадает в блок «Не подошло — почему». */
  blocker?: string;
  fitScore?: number;
  customerName?: string;
  region?: string;
  /** Статус воронки: им проверяется блок «В работе у вас». */
  pipelineStatus?: PipelineStatus;
  /** НМЦК; 0 — цена не опубликована. Нужна для суммы в подборке. */
  price?: number;
  currency?: string;
  /** Площадка-источник: метка «новое» ставится только закупкам Контур. */
  dataSource?: Tender["dataSource"];
  /** Метка записи строки источником — по ней определяется партия прогона. */
  syncedAt?: string | null;
  /** Когда закупка впервые появилась в базе. */
  firstSeenAt?: string | null;
  /** Плюсы и минусы заключения: из них строится пояснение в «Лучшем из нового». */
  positive?: string[];
  negative?: string[];
}

/*
  Строки собираются вокруг настоящего разбора, но вердикт и стоп-факторы
  задаются явно: проверяется отбор и порядок на экране, а не скоринг.
  Просроченной закупке намеренно ставим «подходит» — экран обязан отсечь её
  сам, даже если разбор лежит устаревший.
*/
function row(spec: RowSpec): TenderRow {
  const base = demoTenders[0] as Tender;
  const tender: Tender = {
    ...base,
    id: spec.id,
    subject: spec.subject,
    customerName: spec.customerName ?? base.customerName,
    region: spec.region ?? base.region,
    deadlines: { ...base.deadlines, submissionEnd: iso(spec.hoursLeft) },
    financial: {
      ...base.financial,
      price: spec.price ?? base.financial.price,
      currency: spec.currency ?? base.financial.currency,
    },
    ...(spec.dataSource === undefined ? {} : { dataSource: spec.dataSource }),
    ...(spec.syncedAt === undefined ? {} : { syncedAt: spec.syncedAt }),
    ...(spec.firstSeenAt === undefined ? {} : { firstSeenAt: spec.firstSeenAt }),
  };
  const analysis: TenderAnalysis = analyzeTender(tender, demoCompanyProfile);
  const hardBlockers: HardBlocker[] = spec.blocker
    ? [
        {
          id: `${spec.id}-blocker`,
          reason: spec.blocker,
          detail: spec.blocker,
          evidenceId: null,
          critical: true,
        },
      ]
    : [];
  return {
    tender,
    analysis: {
      ...analysis,
      verdict: spec.verdict,
      fitScore: spec.fitScore ?? analysis.fitScore,
      hardBlockers,
      ...(spec.positive === undefined
        ? {}
        : { positiveFactors: spec.positive.map((text, i) => ({ id: `${spec.id}-p${i}`, text, evidenceId: null })) }),
      ...(spec.negative === undefined
        ? {}
        : { negativeFactors: spec.negative.map((text, i) => ({ id: `${spec.id}-n${i}`, text, evidenceId: null })) }),
    },
    pipelineStatus: spec.pipelineStatus ?? ("NEW" as const),
  };
}

function mount(rows: TenderRow[], extra?: Record<string, unknown>) {
  vi.mocked(useTenderData).mockReturnValue({
    profile: demoCompanyProfile,
    rows,
    loading: false,
    error: null,
    reload: vi.fn(),
    syncKontur: vi.fn().mockResolvedValue(null),
    syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    ...extra,
  } as never);
  return render(<DashboardView />);
}

describe("DashboardView — экран «Сегодня»", () => {
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

  it("просроченная закупка не попадает ни в «Откройте сегодня», ни в «Срочно»", () => {
    const { container } = mount([
      row({
        id: "t-expired",
        subject: "Просроченная закупка",
        hoursLeft: -6,
        verdict: "RECOMMENDED",
        fitScore: 95,
      }),
      row({
        id: "t-open",
        subject: "Открытая закупка",
        hoursLeft: 240,
        verdict: "RECOMMENDED",
        fitScore: 80,
      }),
    ]);

    expect(screen.getByText("Открытая закупка")).toBeTruthy();
    expect(screen.queryByText("Просроченная закупка")).toBeNull();
    // В блоке «Срочно» её тоже нет: «горящий срок» и «уже поздно» — разные вещи.
    expect(textOf(container)).not.toMatch(/Просроченная/);
  });

  it("легенда вердиктов повторяет счётчики открытых закупок", () => {
    const { container } = mount([
      row({ id: "a", subject: "Первая", hoursLeft: 200, verdict: "RECOMMENDED" }),
      row({ id: "b", subject: "Вторая", hoursLeft: 200, verdict: "MANUAL_REVIEW" }),
      row({ id: "c", subject: "Третья", hoursLeft: 200, verdict: "MANUAL_REVIEW" }),
      row({
        id: "d",
        subject: "Четвёртая",
        hoursLeft: 200,
        verdict: "NOT_RECOMMENDED",
        blocker: "Нет допуска СРО",
      }),
    ]);

    const legend = within(within(container).getByTestId("verdict-bar")).getByRole("list", {
      name: "Вердикты открытых закупок",
    });
    const text = textOf(legend);
    expect(text).toContain("Подходит 1");
    expect(text).toContain("Нужно посмотреть 2");
    expect(text).toContain("Не подходит 1");
  });

  it("неизвестные заказчик и регион не печатаются заглушками", () => {
    const unknown = row({
      id: "meta-unknown",
      subject: "Закупка без заказчика и региона",
      hoursLeft: 200,
      verdict: "RECOMMENDED",
      customerName: UNKNOWN_CUSTOMER,
      region: UNKNOWN_REGION,
    });
    const known = row({
      id: "meta-known",
      subject: "Закупка с заказчиком и регионом",
      hoursLeft: 200,
      verdict: "RECOMMENDED",
    });
    const { container } = mount([unknown, known]);

    const card = cardOf(container, "Лучшее из нового");
    const text = textOf(card);
    /*
      Две заглушки подряд («Заказчик не указан · Не указан») читаются как
      поломка экрана, поэтому неизвестные части строки не выводятся вовсе.
    */
    expect(text).not.toContain(UNKNOWN_CUSTOMER);
    expect(text).not.toContain(UNKNOWN_REGION);
    // Цена остаётся всегда: её отсутствие — самостоятельный факт, а не заглушка.
    // textOf схлопывает неразрывные пробелы цены, поэтому нормализуем и ожидание.
    expect(text).toContain(
      formatTenderPrice(known.tender.financial.price, known.tender.financial.currency).replace(
        /\s+/g,
        " ",
      ),
    );
    // Известная строка по-прежнему показывает и заказчика, и регион.
    expect(text).toContain(known.tender.customerName);
    expect(text).toContain(known.tender.region);
  });

  it("в «Горит» только те, у кого подача закрывается в пределах окна", () => {
    const { container } = mount([
      row({ id: "u1", subject: "Закрывается завтра", hoursLeft: 20, verdict: "MANUAL_REVIEW" }),
      row({ id: "u2", subject: "Закрывается через три дня", hoursLeft: 70, verdict: "RECOMMENDED" }),
      row({ id: "u3", subject: "Ещё есть время", hoursLeft: 24 * (URGENT_DEADLINE_DAYS + 5), verdict: "RECOMMENDED" }),
    ]);

    /*
      Та же закупка законно попадает и в «Лучшее из нового», и в «Горит»,
      поэтому смотрим внутрь карточки «Горит», а не на весь экран.
    */
    const urgentCard = cardOf(container, "Горит");
    expect(within(urgentCard).getByText("Закрывается завтра")).toBeTruthy();
    expect(within(urgentCard).getByText("Закрывается через три дня")).toBeTruthy();
    expect(within(urgentCard).queryByText("Ещё есть время")).toBeNull();
  });

  it("ссылка «показать все» ведёт в ленту с тем же фильтром срочных", () => {
    /*
      Экран показывает пять срочных закупок, остальные уходят в ленту. Берём
      семь, чтобы ссылка появилась, и проверяем именно адрес: «срочно» на
      дашборде и в фильтре ленты обязано означать одно и то же.
    */
    const total = 7;
    const rows = Array.from({ length: total }, (_, i) =>
      row({
        id: `s${i}`,
        subject: `Срочная закупка ${i + 1}`,
        hoursLeft: 10 + i,
        verdict: "RECOMMENDED",
      }),
    );
    mount(rows);

    const link = screen.getByRole("link", { name: /показать все/i });
    expect(link.getAttribute("href")).toBe("/tenders?soon=1");
    expect(textOf(link)).toBe(`Ещё ${total - 5} — показать все`);
  });

  it("блок «Не подошло» показывает причины столбиками, а примеры закупок — по клику", () => {
    const { container } = mount([
      row({ id: "ok", subject: "Подходящая закупка", hoursLeft: 200, verdict: "RECOMMENDED" }),
      row({
        id: "r1",
        subject: "Отклонённая первая",
        hoursLeft: 200,
        verdict: "NOT_RECOMMENDED",
        blocker: "Нет допуска СРО",
      }),
      row({
        id: "r2",
        subject: "Отклонённая вторая",
        hoursLeft: 200,
        verdict: "NOT_RECOMMENDED",
        blocker: "Нет допуска СРО",
      }),
      row({
        id: "r3",
        subject: "Отклонённая третья",
        hoursLeft: 200,
        verdict: "NOT_RECOMMENDED",
        blocker: "Регион вне географии",
      }),
    ]);

    const card = cardOf(container, "Не подошло — почему");
    // Свёрнуты только сами закупки: причины видны сразу, и их больше одной.
    expect(screen.queryByText("Отклонённая первая")).toBeNull();
    const bars = within(card).getByTestId("rejection-bars");
    const items = within(bars).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(textOf(items[0]!)).toContain("Нет допуска СРО");
    expect(textOf(items[0]!)).toContain("2");
    expect(textOf(items[1]!)).toContain("Регион вне географии");
    // Доля считается от всех отклонённых: 2 из 3.
    expect(
      within(items[0]!).getByRole("img").getAttribute("aria-label"),
    ).toContain("2 из 3 отклонённых (67%)");

    fireEvent.click(within(card).getByRole("button", { name: /Показать примеры закупок/ }));

    expect(screen.getByText("Отклонённая первая")).toBeTruthy();
    expect(screen.getByText("Отклонённая третья")).toBeTruthy();
  });

  it("под причинами отказа — ссылки на отклонённые и на условия поиска", () => {
    const { container } = mount([
      row({
        id: "r1",
        subject: "Отклонённая",
        hoursLeft: 200,
        verdict: "NOT_RECOMMENDED",
        blocker: "Нет допуска СРО",
      }),
    ]);

    const card = cardOf(container, "Не подошло — почему");
    const all = within(card).getByRole("link", { name: "Показать все отклонённые" });
    // `closed=hide`: число в блоке считается по открытым, и лента должна показать столько же.
    expect(all.getAttribute("href")).toBe("/tenders?verdict=NOT_RECOMMENDED&closed=hide");
    expect(
      within(card).getByRole("link", { name: "Изменить условия поиска" }).getAttribute("href"),
    ).toBe("/settings/search");
  });

  it("«Найти новые закупки» — одна кнопка: нажатие сразу запускает поиск, панели и второго «Запустить» нет", async () => {
    vi.mocked(syncJobApiService.getStatus).mockResolvedValue({ recent: [] } as never);
    vi.mocked(syncJobApiService.enqueueFullSync).mockResolvedValue({ job: { status: "pending" }, deduped: false } as never);
    mount([row({ id: "a", subject: "Первая", hoursLeft: 200, verdict: "RECOMMENDED" })]);

    fireEvent.click(screen.getAllByRole("button", { name: /Найти новые закупки/i })[0]!);

    expect(syncJobApiService.enqueueFullSync).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Поиск новых закупок" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Запустить поиск" })).toBeNull();
    await screen.findByTestId("work-progress");
  });

  it("в пустом блоке «Откройте сегодня» второй кнопки поиска нет — только ссылка на условия", () => {
    mount([
      row({
        id: "r1",
        subject: "Отклонённая закупка",
        hoursLeft: 200,
        verdict: "NOT_RECOMMENDED",
        blocker: "Нет допуска СРО",
      }),
    ]);

    expect(screen.getAllByRole("button", { name: /Найти новые закупки/i })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Изменить условия поиска" }).length).toBeGreaterThan(0);
  });

  it("при пустой базе говорит, что делать, и ведёт в условия поиска", () => {
    // Пустой список сохранён явно: без записи репозиторий отдаёт профили-примеры.
    localStorage.setItem(STORAGE_KEYS.searchProfiles, "[]");
    mount([]);

    expect(screen.getByText("Закупок пока нет")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Указать, что ищем/i });
    expect(link.getAttribute("href")).toBe("/settings/search");

    /*
      Подпись пустой ленты не обещает мгновенного поиска и не называет платный
      агрегатор и не рассказывает про устройство прогона: лента наполняется за
      несколько минут, а не сразу.
      Прежняя подпись («ищет в Контур.Закупках сразу») расходилась и с действием
      кнопки, и с тем, что на платный источник приложение больше не опирается.
    */
    const description = screen.getByText(/Нажмите «Найти новые закупки»/);
    expect(description.textContent).not.toContain("Контур");
    expect(description.textContent).not.toContain("сразу");
    expect(description.textContent).not.toMatch(/прогон|сервер/i);
  });

  it("без подходящих закупок объясняет, чем отклонена выдача", () => {
    const { container } = mount([
      row({
        id: "r1",
        subject: "Отклонённая закупка",
        hoursLeft: 200,
        verdict: "NOT_RECOMMENDED",
        blocker: "Нет допуска СРО",
      }),
    ]);

    expect(textOf(container)).toContain("Подходящих закупок сейчас нет.");
    expect(textOf(container)).toContain("Почему так: чем отклонены");
  });

  it("ошибка загрузки даёт повтор", () => {
    const reload = vi.fn();
    mount([], { error: "База недоступна", reload });

    expect(screen.getByText(/База недоступна/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

/* ================== Партия платного поиска в «Лучшем из нового» ================== */


describe("DashboardView — «В работе у вас»", () => {
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

  it("показывает взятые в работу закупки и ближайший срок подачи", () => {
    const { container } = mount([
      row({
        id: "w-1",
        subject: "Готовим заявку",
        hoursLeft: 30,
        verdict: "MANUAL_REVIEW",
        pipelineStatus: "PREPARING_APPLICATION",
      }),
      row({
        id: "n-1",
        subject: "Просто из ленты",
        hoursLeft: 200,
        verdict: "MANUAL_REVIEW",
      }),
    ]);

    const card = cardOf(container, "В работе у вас");
    expect(textOf(card)).toContain("Готовим заявку");
    // «Новые» приносит лента, а не человек: работой они не считаются.
    expect(textOf(card)).not.toContain("Просто из ленты");
    expect(textOf(card)).toContain("1 закупка в работе");
    expect(textOf(card)).toContain("ближайшая подача");
  });

  it("завершённые закупки в работе не числятся", () => {
    const { container } = mount([
      row({ id: "w-won", subject: "Уже выиграна", hoursLeft: 30, verdict: "MANUAL_REVIEW", pipelineStatus: "WON" }),
      row({ id: "w-skip", subject: "Пропущена", hoursLeft: 30, verdict: "MANUAL_REVIEW", pipelineStatus: "SKIPPED" }),
    ]);

    const card = cardOf(container, "В работе у вас");
    expect(textOf(card)).toContain("Вы пока ничего не взяли в работу");
  });

  it("пустой блок объясняет, как закупка туда попадает", () => {
    const { container } = mount([
      row({ id: "n-1", subject: "Закупка из ленты", hoursLeft: 200, verdict: "MANUAL_REVIEW" }),
    ]);

    expect(textOf(cardOf(container, "В работе у вас"))).toContain("«Интересные»");
  });

  it("закупка в работе не повторяется в подборке нового", () => {
    const { container } = mount([
      row({
        id: "w-1",
        subject: "Уже в работе",
        hoursLeft: 30,
        verdict: "MANUAL_REVIEW",
        fitScore: 99,
        pipelineStatus: "INTERESTING",
      }),
      row({ id: "n-1", subject: "Новая находка", hoursLeft: 200, verdict: "MANUAL_REVIEW", fitScore: 40 }),
    ]);

    const best = cardOf(container, "Лучшее из нового");
    expect(textOf(best)).toContain("Новая находка");
    // Показывать в «новом» то, что человек уже взял, — повтор без смысла.
    expect(textOf(best)).not.toContain("Уже в работе");
  });
});

describe("DashboardView — «Лучшее из нового»", () => {
  /** Метка партии: прогон был несколько минут назад. */
  const STAMP = new Date(Date.now() - 8 * 60 * 1000).toISOString();

  function batchRow(spec: Omit<RowSpec, "dataSource" | "syncedAt">) {
    return row({ dataSource: "KONTUR", syncedAt: STAMP, firstSeenAt: STAMP, ...spec });
  }

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

  it("закупки последнего прогона помечены «новое» в общем списке", () => {
    const { container } = mount([
      batchRow({ id: "k-1", subject: "Свежая находка", hoursLeft: 200, verdict: "MANUAL_REVIEW", fitScore: 80 }),
      row({
        id: "e-1",
        subject: "Давняя закупка",
        hoursLeft: 200,
        verdict: "MANUAL_REVIEW",
        fitScore: 70,
        dataSource: "EIS",
      }),
    ]);

    /*
      Раньше прогон занимал отдельный блок, и один и тот же список читался
      дважды. Теперь список один, а принадлежность прогону — свойство строки.
    */
    const items = within(cardOf(container, "Лучшее из нового")).getAllByRole("listitem");
    expect(textOf(items[0]!)).toContain("Свежая находка");
    expect(textOf(items[0]!)).toContain("новое");
    expect(textOf(items[1]!)).toContain("Давняя закупка");
    expect(textOf(items[1]!)).not.toContain("новое");
  });

  it("ссылка ведёт точно на партию прогона, а не на весь источник", () => {
    const { container } = mount([
      batchRow({ id: "k-1", subject: "Свежая находка", hoursLeft: 200, verdict: "MANUAL_REVIEW" }),
    ]);

    const href = within(cardOf(container, "Лучшее из нового"))
      .getByRole("link", { name: /весь платный поиск/ })
      .getAttribute("href");

    expect(href).toBe(`/tenders?batch=${encodeURIComponent(STAMP)}`);
  });

  it("без закупок Контур ссылки на прогон нет", () => {
    const { container } = mount([
      row({ id: "e-1", subject: "Только ЕИС", hoursLeft: 200, verdict: "MANUAL_REVIEW", dataSource: "EIS" }),
    ]);

    expect(
      within(cardOf(container, "Лучшее из нового")).queryByRole("link", {
        name: /весь платный поиск/,
      }),
    ).toBeNull();
  });

  it("называет сумму НМЦК подборки", () => {
    const { container } = mount([
      row({ id: "p1", subject: "Первая", hoursLeft: 200, verdict: "MANUAL_REVIEW", price: 10_000_000 }),
      row({ id: "p2", subject: "Вторая", hoursLeft: 200, verdict: "MANUAL_REVIEW", price: 2_400_000 }),
    ]);

    expect(textOf(cardOf(container, "Лучшее из нового"))).toContain("на 12,4 млн ₽");
  });

  it("закупки без цены и в валюте в сумму не идут, но названы отдельно", () => {
    const { container } = mount([
      row({ id: "p1", subject: "Рублёвая", hoursLeft: 200, verdict: "MANUAL_REVIEW", price: 1_000_000 }),
      row({ id: "p2", subject: "Валютная", hoursLeft: 200, verdict: "MANUAL_REVIEW", price: 4_000_000, currency: "USD" }),
      row({ id: "p3", subject: "Без цены", hoursLeft: 200, verdict: "MANUAL_REVIEW", price: 0 }),
    ]);

    const text = textOf(cardOf(container, "Лучшее из нового"));
    // Пересчёт валюты по выдуманному курсу дал бы число, которого нет в извещении.
    expect(text).toContain("на 1 млн ₽");
    expect(text).toContain("цена не указана или в валюте");
  });

  it("сортирует по связке срока и соответствия, а не по одному фиту", () => {
    const { container } = mount([
      row({ id: "far", subject: "Сильная, но не скоро", hoursLeft: 24 * 25, verdict: "MANUAL_REVIEW", fitScore: 70 }),
      row({ id: "soon", subject: "Чуть слабее, но горит", hoursLeft: 24 * 2, verdict: "MANUAL_REVIEW", fitScore: 65 }),
    ]);

    const items = within(cardOf(container, "Лучшее из нового")).getAllByRole("listitem");
    expect(textOf(items[0]!)).toContain("Чуть слабее, но горит");
  });
});

describe("DashboardView — просроченные не искажают картину", () => {
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

  it("истёкший срок не попадает ни в счётчики, ни в «Не подошло»", () => {
    const { container } = mount([
      row({
        id: "exp",
        subject: "Срок уже прошёл",
        hoursLeft: -6,
        verdict: "NOT_RECOMMENDED",
        blocker: "Срок подачи истёк",
      }),
      row({
        id: "live",
        subject: "Не подходит по профилю",
        hoursLeft: 200,
        verdict: "NOT_RECOMMENDED",
        blocker: "Нет лицензии",
      }),
    ]);

    /*
      Просроченную закупку отклонил календарь, а не профиль компании. В
      счётчике «Не подходит» такие строки создавали впечатление, что условия
      поиска надо менять, хотя менять нечего.
    */
    const legend = within(container).getByRole("list", { name: "Вердикты открытых закупок" });
    expect(textOf(legend)).toContain("Не подходит 1");
    const card = cardOf(container, "Не подошло — почему");
    expect(textOf(card)).toContain("Нет лицензии");
    expect(textOf(card)).not.toContain("Срок подачи истёк");
  });
});


/* ======================= Доработка экрана: графика и сводка ======================= */

describe("DashboardView — заголовок и сводка", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    searchProfileRepository.save(searchProfileExamples);
  });

  const withName = (legalName: string): CompanyProfile => ({ ...demoCompanyProfile, legalName });

  it("с названием компании здоровается по имени", () => {
    mount([row({ id: "a", subject: "Первая", hoursLeft: 200, verdict: "RECOMMENDED" })]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      `Здравствуйте, ${demoCompanyProfile.legalName}`,
    );
  });

  it("пустое или пробельное название не оставляет «Здравствуйте,» без имени", () => {
    for (const legalName of ["", "   "]) {
      const { unmount } = mount(
        [row({ id: "a", subject: "Первая", hoursLeft: 200, verdict: "RECOMMENDED" })],
        { profile: withName(legalName) },
      );
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Сегодня");
      unmount();
    }
  });

  it("без профиля заголовок тоже «Сегодня»", () => {
    mount([row({ id: "a", subject: "Первая", hoursLeft: 200, verdict: "RECOMMENDED" })], {
      profile: null,
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Сегодня");
  });

  it("под заголовком — сегодняшняя дата и время среза данных", () => {
    const { container } = mount([
      row({ id: "a", subject: "Первая", hoursLeft: 200, verdict: "RECOMMENDED" }),
    ]);
    const today = new Date().toLocaleDateString("ru-RU", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    const subtitle = textOf(container.querySelector("h1")!.parentElement!);
    expect(subtitle).toContain(today);
    expect(subtitle).toMatch(/данные на \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/);
  });

  it("четыре плитки сводки считают открытые, горящие, работу и бюджет подборки", () => {
    const { container } = mount([
      row({ id: "a", subject: "Горящая", hoursLeft: 10, verdict: "RECOMMENDED", price: 1_000_000 }),
      row({ id: "b", subject: "Далёкая", hoursLeft: 300, verdict: "MANUAL_REVIEW", price: 2_000_000 }),
      row({
        id: "c",
        subject: "В работе",
        hoursLeft: 100,
        verdict: "MANUAL_REVIEW",
        pipelineStatus: "INTERESTING",
        price: 9_000_000,
      }),
      row({ id: "d", subject: "Просрочена", hoursLeft: -5, verdict: "NOT_RECOMMENDED", blocker: "Срок подачи истёк" }),
    ]);

    const strip = container.querySelector(".stat-strip-dense") as HTMLElement;
    const cells = Array.from(strip.querySelectorAll(".stat-cell")).map((c) => textOf(c as HTMLElement));
    expect(cells).toHaveLength(4);
    // Открытых 3 из 4 в базе: просроченная не в счёт.
    expect(cells[0]).toMatch(/^Открытых закупок\s*3\s*из 4 в базе/);
    expect(cells[1]).toMatch(new RegExp(`Закрывается за ${URGENT_DEADLINE_DAYS} дня\\s*1`));
    expect(cells[2]).toMatch(/^В работе\s*1/);
    // Бюджет подборки: «В работе» в подборку не входит, 1 + 2 млн.
    expect(cells[3]).toMatch(/Бюджет подборки\s*3 млн ₽/);
  });
});

describe("DashboardView — полоса вердиктов", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    searchProfileRepository.save(searchProfileExamples);
  });

  it("сегменты и легенда ведут в ленту с фильтром по вердикту; у нуля сегмента нет, а в легенде он есть", () => {
    const { container } = mount([
      ...Array.from({ length: 3 }, (_, i) =>
        row({ id: `m${i}`, subject: `Проверить ${i}`, hoursLeft: 200, verdict: "MANUAL_REVIEW" }),
      ),
      row({
        id: "n1",
        subject: "Отклонённая",
        hoursLeft: 200,
        verdict: "NOT_RECOMMENDED",
        blocker: "Нет допуска СРО",
      }),
    ]);

    const bar = within(container).getByTestId("verdict-bar");
    const segments = Array.from(bar.querySelectorAll("[data-segment]"));
    expect(segments.map((el) => el.getAttribute("data-segment"))).toEqual([
      "MANUAL_REVIEW",
      "NOT_RECOMMENDED",
    ]);
    expect(segments[0]!.getAttribute("href")).toBe("/tenders?verdict=MANUAL_REVIEW&closed=hide");
    expect(segments[0]!.getAttribute("title")).toContain("3 из 4");

    const legend = within(bar).getByRole("list", { name: "Вердикты открытых закупок" });
    const hrefs = within(legend)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/tenders?verdict=RECOMMENDED&closed=hide",
      "/tenders?verdict=MANUAL_REVIEW&closed=hide",
      "/tenders?verdict=NOT_RECOMMENDED&closed=hide",
    ]);
    // Нулевой «Подходит» назван в легенде, хотя сегмента у него нет.
    expect(textOf(legend)).toContain("Подходит 0");
    // Диаграмма озвучивается целиком, а не набором пустых цветных блоков.
    expect(bar.querySelector('[role="img"]')!.getAttribute("aria-label")).toContain(
      "подходит — 0, нужно посмотреть — 3, не подходит — 1",
    );
  });
});

describe("DashboardView — «Подача по дням»", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    searchProfileRepository.save(searchProfileExamples);
    // Полдень вторника 6 октября: смещения часов от него дают предсказуемые календарные дни.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 6, 12, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("рисует 14 столбиков с правильными числами и тонами", () => {
    const { container } = mount([
      row({ id: "t1", subject: "Сегодня вечером", hoursLeft: 5, verdict: "RECOMMENDED" }),
      row({ id: "t2", subject: "Тоже сегодня", hoursLeft: 8, verdict: "MANUAL_REVIEW" }),
      row({ id: "t3", subject: "Завтра утром", hoursLeft: 20, verdict: "MANUAL_REVIEW" }),
      row({ id: "t4", subject: "Через неделю", hoursLeft: 24 * 7, verdict: "RECOMMENDED" }),
      // Отклонённая и просроченная в столбики не входят.
      row({ id: "t5", subject: "Отклонена", hoursLeft: 5, verdict: "NOT_RECOMMENDED", blocker: "Нет допуска СРО" }),
      row({ id: "t6", subject: "Просрочена", hoursLeft: -2, verdict: "MANUAL_REVIEW" }),
      // Дальше 14 дней — в подпись «ещё позже».
      row({ id: "t7", subject: "Через месяц", hoursLeft: 24 * 30, verdict: "RECOMMENDED" }),
    ]);

    const chart = within(cardOf(container, "Подача по дням")).getByTestId("deadline-chart");
    const cols = Array.from(chart.querySelectorAll("[data-day-offset]"));
    expect(cols).toHaveLength(14);
    const count = (offset: number) =>
      Number(chart.querySelector(`[data-day-offset="${offset}"]`)!.getAttribute("data-count"));
    expect(count(0)).toBe(2);
    expect(count(1)).toBe(1);
    expect(count(2)).toBe(0);
    // 12:00 + 7 суток — тот же день недели.
    expect(count(7)).toBe(1);

    const label = chart.querySelector('[role="img"]')!.getAttribute("aria-label")!;
    expect(label).toContain("Всего 4");
    expect(label).toContain("сегодня — 2");

    // Подпись столбика сегодня: день недели и число.
    expect(chart.querySelector('[data-day-offset="0"]')!.getAttribute("title")).toBe(
      "вторник, 6 октября: 2 закупки закрывают подачу",
    );
    expect(textOf(chart.querySelector('[data-day-offset="0"]') as HTMLElement)).toContain("вт 6");
    expect(textOf(chart)).toContain("ещё 1 позже");
  });

  it("без подач в окне вместо пустых столбиков — одна фраза", () => {
    const { container } = mount([
      row({ id: "far", subject: "Очень далёкая", hoursLeft: 24 * 40, verdict: "RECOMMENDED" }),
    ]);
    const card = cardOf(container, "Подача по дням");
    expect(within(card).queryByTestId("deadline-chart")).toBeNull();
    expect(textOf(card)).toContain("подача не закрывается ни по одной закупке");
  });
});

describe("DashboardView — плашка замечаний к профилю", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    searchProfileRepository.save(searchProfileExamples);
  });

  const rows = () => [row({ id: "a", subject: "Первая", hoursLeft: 200, verdict: "RECOMMENDED" })];

  /** Профиль с двумя замечаниями: пустая география и стоп-слово против деятельности. */
  const brokenProfile = (): CompanyProfile => ({
    ...demoCompanyProfile,
    restrictions: { ...demoCompanyProfile.restrictions, workRegions: [] },
    capabilities: {
      ...demoCompanyProfile.capabilities,
      stopWords: [demoCompanyProfile.capabilities.keywords[0]!],
    },
  });

  it("свёрнута в одну строку с числом пунктов и ссылкой в профиль", () => {
    mount(rows(), { profile: brokenProfile() });

    const summary = screen.getByTestId("profile-audit-summary");
    expect(textOf(summary)).toContain("Профиль заполнен не полностью — 2 пункта");
    // Подробности спрятаны: два развёрнутых предупреждения на первом экране не нужны.
    expect(screen.queryByTestId("profile-audit")).toBeNull();
    expect(within(summary).getByRole("link", { name: /профиле/ }).getAttribute("href")).toBe(
      "/settings/profile",
    );
  });

  it("раскрывается в тот же ProfileAuditNotice", () => {
    mount(rows(), { profile: brokenProfile() });

    const toggle = screen.getByRole("button", { name: /Профиль заполнен не полностью/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(screen.getByTestId("profile-audit")).getAllByText(/\S/).length).toBeGreaterThan(0);
    expect(textOf(screen.getByTestId("profile-audit"))).toContain("География работы не задана");
  });

  it("у согласованного профиля плашки нет вовсе", () => {
    mount(rows());
    expect(screen.queryByTestId("profile-audit-summary")).toBeNull();
    expect(screen.queryByText(/Профиль заполнен не полностью/)).toBeNull();
  });
});

describe("DashboardView — «Горит» по дням", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    searchProfileRepository.save(searchProfileExamples);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 6, 12, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("группирует по Сегодня / Завтра / Послезавтра и ставит чипы с часами", () => {
    const { container } = mount([
      row({ id: "u3", subject: "Послезавтра утром", hoursLeft: 44, verdict: "RECOMMENDED", price: 500_000 }),
      row({ id: "u1", subject: "Сегодня вечером", hoursLeft: 5, verdict: "MANUAL_REVIEW", price: 1_000_000 }),
      row({ id: "u2", subject: "Завтра утром", hoursLeft: 20, verdict: "RECOMMENDED", price: 2_000_000 }),
    ]);

    const card = cardOf(container, "Горит");
    const groups = Array.from(card.querySelectorAll("section")).map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Сегодня", "Завтра", "Послезавтра"]);

    const today = card.querySelector('section[aria-label="Сегодня"]') as HTMLElement;
    expect(textOf(today)).toContain("Сегодня вечером");
    expect(within(today).getByLabelText("Осталось 5 ч").textContent).toBe("5 ч");
    expect(
      within(card.querySelector('section[aria-label="Завтра"]') as HTMLElement).getByLabelText("Осталось 20 ч"),
    ).toBeTruthy();

    // Сумма НМЦК горящих — в шапке блока.
    expect(textOf(card.querySelector("header") as HTMLElement)).toContain("на 3,5 млн ₽");
  });

  it("лимит видимых строк сохраняется: остальное уходит в «показать все»", () => {
    const { container } = mount(
      Array.from({ length: 7 }, (_, i) =>
        row({ id: `s${i}`, subject: `Срочная ${i + 1}`, hoursLeft: 2 + i, verdict: "RECOMMENDED" }),
      ),
    );
    const card = cardOf(container, "Горит");
    expect(card.querySelectorAll("li")).toHaveLength(5);
    expect(textOf(within(card).getByRole("link", { name: /показать все/ }))).toBe("Ещё 2 — показать все");
  });

  it("просроченные в группы не попадают", () => {
    const { container } = mount([
      row({ id: "x", subject: "Уже закрыта", hoursLeft: -1, verdict: "RECOMMENDED" }),
      row({ id: "y", subject: "Ещё открыта", hoursLeft: 3, verdict: "RECOMMENDED" }),
    ]);
    const card = cardOf(container, "Горит");
    expect(textOf(card)).not.toContain("Уже закрыта");
    expect(textOf(card)).toContain("Ещё открыта");
  });
});

describe("DashboardView — «Лучшее из нового»: оценка и пояснение", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    searchProfileRepository.save(searchProfileExamples);
  });

  it("у строки есть кольцо соответствия 0–100, а вместо резюме — первый плюс и первый минус", () => {
    const { container } = mount([
      row({
        id: "f1",
        subject: "С факторами",
        hoursLeft: 200,
        verdict: "MANUAL_REVIEW",
        fitScore: 48,
        positive: ["Предмет совпадает с видом работ", "Второй плюс"],
        negative: ["Нужен допуск СРО", "Второй минус"],
      }),
    ]);

    const item = within(cardOf(container, "Лучшее из нового")).getAllByRole("listitem")[0]!;
    expect(within(item).getByTestId("fit-ring").getAttribute("aria-label")).toBe(
      "Соответствие профилю: 48 из 100",
    );
    const text = textOf(item);
    expect(text).toContain("Предмет совпадает с видом работ");
    expect(text).toContain("Нужен допуск СРО");
    // Только первые по одному, без «второго».
    expect(text).not.toContain("Второй плюс");
    expect(text).not.toContain("Второй минус");
  });

  it("без факторов остаётся резюме заключения", () => {
    const empty = row({
      id: "f2",
      subject: "Без факторов",
      hoursLeft: 200,
      verdict: "MANUAL_REVIEW",
      positive: [],
      negative: [],
    });
    empty.analysis = { ...empty.analysis, uncertainties: [], summary: "Резюме заключения для проверки" };
    const { container } = mount([empty]);

    const item = within(cardOf(container, "Лучшее из нового")).getAllByRole("listitem")[0]!;
    expect(textOf(item)).toContain("Резюме заключения для проверки");
  });
});
