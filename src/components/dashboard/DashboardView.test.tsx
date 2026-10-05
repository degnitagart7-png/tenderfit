import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { HardBlocker, Tender, TenderAnalysis } from "@/domain/entities";
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

  it("счётчики в заголовке повторяют вердикты", () => {
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

    const text = textOf(container);
    expect(text).toContain("Подходит: 1");
    expect(text).toContain("Нужно посмотреть: 2");
    expect(text).toContain("Не подходит: 1");
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

  it("блок «Не подошло» свёрнут: частая причина видна, детали — по клику", () => {
    mount([
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
        blocker: "Срок подачи истёк",
      }),
    ]);

    // Свёрнуто: причина видна одной строкой, сами закупки — нет.
    expect(screen.queryByText("Отклонённая первая")).toBeNull();
    const toggle = screen.getByRole("button", { name: /закупки отклонено/i });
    expect(textOf(toggle)).toContain("чаще всего: Нет допуска СРО (2)");

    fireEvent.click(toggle);

    expect(screen.getByText("Отклонённая первая")).toBeTruthy();
    expect(screen.getByText("Отклонённая третья")).toBeTruthy();
    const all = screen.getByRole("link", { name: "Показать все отклонённые" });
    expect(all.getAttribute("href")).toBe("/tenders?verdict=NOT_RECOMMENDED");
  });

  it("кнопка открывает панель прогона, а не запускает поиск сразу", async () => {
    const syncKontur = vi.fn().mockResolvedValue(null);
    mount([row({ id: "a", subject: "Первая", hoursLeft: 200, verdict: "RECOMMENDED" })], {
      syncKontur,
    });

    fireEvent.click(screen.getAllByRole("button", { name: /Найти новые закупки/i })[0]!);

    expect(screen.getByRole("heading", { name: "Поиск новых закупок" })).toBeTruthy();
    // Основное действие панели — бесплатный прогон, платный поиск требует подтверждения.
    expect(screen.getByRole("button", { name: "Запустить прогон" })).toBeTruthy();
    expect(syncKontur).not.toHaveBeenCalled();
    /*
      Открытая панель читает остаток по тарифу. Дожидаемся отказа: иначе её
      setState прилетает после конца теста и React предупреждает об обновлении
      вне act(). Ждём именно подпись сбоя — «остаток не прочитан» в строке
      расхода есть и до ответа сервера.
    */
    await screen.findByText(/Остаток не прочитан:/);
  });

  it("кнопка в пустом блоке «Откройте сегодня» открывает ту же панель", async () => {
    const syncKontur = vi.fn().mockResolvedValue(null);
    mount(
      [
        row({
          id: "r1",
          subject: "Отклонённая закупка",
          hoursLeft: 200,
          verdict: "NOT_RECOMMENDED",
          blocker: "Нет допуска СРО",
        }),
      ],
      { syncKontur },
    );

    const buttons = screen.getAllByRole("button", { name: /Найти новые закупки/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);

    expect(screen.getByRole("heading", { name: "Поиск новых закупок" })).toBeTruthy();
    expect(syncKontur).not.toHaveBeenCalled();
    await screen.findByText(/Остаток не прочитан:/);
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
      агрегатор: кнопка ставит в очередь бесплатный прогон, который выполняет
      сервер в России, и лента наполняется за несколько минут, а не сразу.
      Прежняя подпись («ищет в Контур.Закупках сразу») расходилась и с действием
      кнопки, и с тем, что на платный источник приложение больше не опирается.
    */
    const description = screen.getByText(/Нажмите «Найти новые закупки»/);
    expect(description.textContent).not.toContain("Контур");
    expect(description.textContent).not.toContain("сразу");
    expect(description.textContent).toMatch(/сервер в России/);
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

  it("сбой поиска показывается честно, а не молча", () => {
    mount([row({ id: "a", subject: "Первая", hoursLeft: 200, verdict: "RECOMMENDED" })], {
      syncState: {
        syncing: false,
        error: "Контур.Закупки не ответили",
        lastSynced: 0,
        progress: null,
        report: null,
      },
    });

    expect(screen.getByText("Новые закупки не загрузились")).toBeTruthy();
    expect(screen.getByText("Контур.Закупки не ответили")).toBeTruthy();
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
    expect(textOf(container)).toContain("Не подходит: 1");
    const card = cardOf(container, "Не подошло — почему");
    expect(textOf(card)).toContain("Нет лицензии");
    expect(textOf(card)).not.toContain("Срок подачи истёк");
  });
});
