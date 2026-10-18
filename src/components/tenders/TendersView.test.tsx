import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { TenderRow } from "@/domain/filtering";
import { demoTenders } from "@/mocks/tenders";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { hideClosedLabel, searchControlLabels } from "@/lib/labels";
import { useTenderData } from "@/hooks/useTenderData";
import { useRouter } from "next/navigation";
import { STORAGE_KEYS } from "@/lib/storage";
import { TendersView } from "@/components/tenders/TendersView";

vi.mock("@/hooks/useTenderData", () => ({
  useTenderData: vi.fn(),
}));

// Панель «Найти новые закупки» читает состояние сервера при раскрытии.
vi.mock("@/services/syncJobApiService", () => ({
  syncJobApiService: {
    getStatus: vi.fn().mockResolvedValue({
      view: { state: "online", label: "Сервер на связи", hint: "Принимает задания." },
    }),
    enqueueFullSync: vi.fn(),
  },
}));

/*
  Адрес ленты — часть поведения, а не деталь роутера: по ссылке на выдачу её
  обязаны уметь открыть заново. Поэтому next/navigation подменяется заглушкой,
  и проверяем мы именно то, куда она вызвана.
*/
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(() => "/tenders"),
}));

const replace = vi.fn();

function buildRows(): TenderRow[] {
  return demoTenders.slice(0, 10).map((tender) => ({
    tender,
    analysis: analyzeTender(tender, demoCompanyProfile),
    pipelineStatus: "NEW" as const,
  }));
}

/** Открыть ленту по адресу — как это делает пользователь по ссылке. */
function openAt(search: string): void {
  window.history.replaceState({}, "", `/tenders${search}`);
}

/** Ожидаемый адрес для набора параметров: кодируем так же, как приложение. */
function address(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query === "" ? "/tenders" : `/tenders?${query}`;
}

/** Раскрыть «Расширенный поиск», если он свёрнут. */
function openAdvancedSearch(): void {
  const toggle = screen.getByRole("button", { name: "Расширенный поиск" });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
}

describe("TendersView — фильтры в адресной строке", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Профилей поиска нет: иначе лента применит их сама и проверка адреса
    // увидит не тот набор параметров, который задаёт сам тест.
    localStorage.setItem(STORAGE_KEYS.searchProfiles, "[]");
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    vi.mocked(useTenderData).mockReturnValue({
      profile: null,
      rows: buildRows(),
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    });
    openAt("");
  });

  it("ссылка с запросом открывается как есть: адрес не переписывается", () => {
    openAt("?q=ноутбук&x=поставка");

    render(<TendersView />);

    /*
      Раньше эффект записи успевал отработать до применения параметров и
      заменял адрес на «/tenders», а вернуть параметры обратно уже не успевал:
      выдача показывала отфильтрованные строки при пустом адресе.
    */
    expect(replace).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText(searchControlLabels.query) as HTMLInputElement,
    ).toHaveProperty("value", "ноутбук");
    expect(
      screen.getByLabelText(searchControlLabels.exclude) as HTMLInputElement,
    ).toHaveProperty("value", "поставка");
  });

  it("новый запрос записывается в адрес", () => {
    render(<TendersView />);
    expect(replace).not.toHaveBeenCalled();
    openAdvancedSearch();

    fireEvent.change(screen.getByLabelText(searchControlLabels.query), {
      target: { value: "вентиль" },
    });

    expect(replace).toHaveBeenCalledWith(address({ q: "вентиль" }), { scroll: false });
  });

  it("переключатель «Скрыть закрытые» попадает в адрес и в чипы", () => {
    render(<TendersView />);

    // Блок фильтров раскрыт по умолчанию только при уже заданных ограничениях.
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    fireEvent.click(screen.getByLabelText(hideClosedLabel));

    expect(replace).toHaveBeenCalledWith(address({ closed: "hide" }), { scroll: false });
    openAdvancedSearch();
    expect(screen.getByText("Без закрытых")).toBeTruthy();
  });

  it("ссылка с closed=hide открывается уже с включённым переключателем", () => {
    openAt("?closed=hide");
    render(<TendersView />);

    // Блок раскрыт состоянием, прочитанным при монтировании, то есть до разбора
    // адреса, поэтому открываем его рукой: проверяется само значение флажка.
    const toggle = screen.getByRole("button", { name: /Фильтры/ });
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);

    expect((screen.getByLabelText(hideClosedLabel) as HTMLInputElement).checked).toBe(true);
  });

  it("панель помощника поиска видна только при запросе", () => {
    openAt("");
    const { unmount } = render(<TendersView />);
    expect(screen.queryByTestId("search-assist")).toBeNull();
    unmount();

    openAt("?q=ноутбук");
    render(<TendersView />);
    expect(screen.getByTestId("search-assist")).toBeTruthy();
  });

  it("добавленная моделью формулировка попадает в ключевые слова и в адрес", async () => {
    openAt("?q=ноутбук");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ synonyms: ["переносной компьютер"], cached: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    render(<TendersView />);

    fireEvent.click(screen.getByRole("button", { name: /формулировки/i }));
    fireEvent.click(await screen.findByRole("button", { name: "переносной компьютер" }));

    const lastCall = replace.mock.calls.at(-1)?.[0] as string;
    expect(decodeURIComponent(lastCall.replace(/\+/g, " "))).toContain("q2=переносной компьютер");
    vi.unstubAllGlobals();
  });

  it("оценки модели видны в строках, а неподходящие можно скрыть", async () => {
    openAt("?q=ноутбук");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const sent = JSON.parse(String(init.body)) as { candidates: { id: string }[] };
        const verdicts: Record<string, { fit: string; reason: string }> = {};
        sent.candidates.forEach((candidate, index) => {
          verdicts[candidate.id] =
            index === 0
              ? { fit: "no", reason: "другое по смыслу" }
              : { fit: "yes", reason: "то самое" };
        });
        return new Response(JSON.stringify({ verdicts, cached: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(<TendersView />);
    const before = screen.getByText(/^Найдено \d+$/).textContent ?? "";

    fireEvent.click(screen.getByRole("button", { name: /по смыслу/i }));
    await screen.findAllByTestId("model-note");
    expect(screen.getAllByTestId("model-note").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText(/скрыть неподходящие/i));

    const after = screen.getByText(/^Найдено \d+$/).textContent ?? "";
    const num = (text: string) => Number(/Найдено (\d+)/.exec(text)?.[1]);
    expect(num(after)).toBe(num(before) - 1);
    vi.unstubAllGlobals();
  });

  it("снятый фильтр убирает параметр из адреса", () => {
    openAt("?q=ноутбук");
    render(<TendersView />);
    replace.mockClear();

    fireEvent.change(screen.getByLabelText(searchControlLabels.query), {
      target: { value: "" },
    });

    expect(replace).toHaveBeenCalledWith("/tenders", { scroll: false });
  });
});

describe("TendersView — порядок выдачи по свежести", () => {
  /** Метка партии: прогон Контур.Закупок был несколько минут назад. */
  const STAMP = new Date(Date.now() - 8 * 60 * 1000).toISOString();

  /** Закупка, записанная последним прогоном, и старая закупка из ЕИС. */
  function feed(): TenderRow[] {
    const base = buildRows();
    const template = base[0]!;
    const fresh: TenderRow = {
      ...template,
      tender: {
        ...template.tender,
        id: "kontur-fresh",
        subject: "Свежая находка Контур",
        dataSource: "KONTUR",
        syncedAt: STAMP,
        firstSeenAt: STAMP,
      },
    };
    return [...base, fresh];
  }

  function mount(rows: TenderRow[]) {
    vi.mocked(useTenderData).mockReturnValue({
      profile: null,
      rows,
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    } as never);
    return render(<TendersView />);
  }

  /** Позиция строки с таким текстом среди всех строк таблицы. */
  function rowIndex(text: string): number {
    return screen
      .getAllByRole("row")
      .findIndex((row) => (row.textContent ?? "").includes(text));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Профилей поиска нет: иначе лента применит их сама и проверка адреса
    // увидит не тот набор параметров, который задаёт сам тест.
    localStorage.setItem(STORAGE_KEYS.searchProfiles, "[]");
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    openAt("");
  });

  it("результат последнего поиска стоит первым и отделён от остальной ленты", () => {
    // Свежесть выбирается явно: по умолчанию выдачу ведёт Fit Score.
    openAt("?sort=freshness");
    mount(feed());

    expect(screen.getByText(/Новые · платный поиск/)).toBeTruthy();
    expect(screen.getByText(/Раньше/)).toBeTruthy();
    expect(rowIndex("Свежая находка Контур")).toBeLessThan(
      rowIndex(demoTenders[0]!.subject),
    );
  });

  it("порядок по умолчанию не добавляет параметр sort в адрес", () => {
    mount(feed());

    expect(replace).not.toHaveBeenCalled();
  });

  it("по умолчанию выдача идёт по соответствию компании, без слоёв по свежести, и кнопка порядка это показывает", () => {
    mount(feed());

    expect(screen.queryByText(/Новые · платный поиск/)).toBeNull();
    const group = screen.getByRole("group", { name: "Порядок выдачи" });
    expect(within(group).getByRole("button", { name: "Самые подходящие" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("кнопка «Сначала новые» включает слои по свежести, «Самые подходящие» возвращает Fit Score", () => {
    mount(feed());
    const group = screen.getByRole("group", { name: "Порядок выдачи" });

    fireEvent.click(within(group).getByRole("button", { name: "Сначала новые" }));
    expect(screen.getByText(/Новые · платный поиск/)).toBeTruthy();

    fireEvent.click(within(group).getByRole("button", { name: "Самые подходящие" }));
    expect(screen.queryByText(/Новые · платный поиск/)).toBeNull();
    expect(within(group).getByRole("button", { name: "Самые подходящие" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("выбранный порядок виден чипом, а снятие чипа возвращает порядок по Fit Score", () => {
    openAt("?sort=freshness");
    mount(feed());
    openAdvancedSearch();
    expect(screen.getByText(/Новые · платный поиск/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Сортировать по НМЦК" }));
    expect(screen.getByText(/Порядок: по цене/)).toBeTruthy();
    expect(screen.queryByText(/Новые · платный поиск/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Снять фильтр: Порядок: по цене" }));
    expect(screen.queryByText(/Порядок: по цене/)).toBeNull();
    const group = screen.getByRole("group", { name: "Порядок выдачи" });
    expect(within(group).getByRole("button", { name: "Самые подходящие" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("при запросе выдача идёт по приоритету, а не по слоям", () => {
    // Слои объясняют порядок ленты без запроса. С запросом порядок определяет
    // совпадение слов: иначе закупка без единого совпадения встала бы выше.
    openAt("?q=компьютеров");
    mount(feed());

    expect(screen.queryByText(/Новые · платный поиск/)).toBeNull();
    expect(screen.getByRole("columnheader", { name: /Приоритет/ })).toBeTruthy();
  });

  it("ссылка на партию открывает только строки этого прогона", () => {
    /*
      Блок платного поиска обещает показать все N закупок прогона.
      Открыть вместо них всю ленту источника значило бы солгать числом на кнопке.
    */
    openAt(`?batch=${encodeURIComponent(STAMP)}`);
    mount(feed());

    expect(screen.getByText(/^Найдено 1$/)).toBeTruthy();
    expect(screen.getByText("Свежая находка Контур")).toBeTruthy();
    expect(screen.queryByText(demoTenders[0]!.subject)).toBeNull();
  });

  it("чип партии снимает ограничение и возвращает всю ленту", () => {
    sessionStorage.setItem("tenderfit.feedShowAll", "1");
    openAt(`?batch=${encodeURIComponent(STAMP)}`);
    mount(feed());
    openAdvancedSearch();

    fireEvent.click(screen.getByRole("button", { name: /Снять фильтр: Партия/ }));

    expect(screen.getByText(/^Найдено 11$/)).toBeTruthy();
    expect(screen.getByText(demoTenders[0]!.subject)).toBeTruthy();
    sessionStorage.clear();
  });
});

/*
  База закупок общая, а лента — личная. Без своего профиля человек видел
  закупки, собранные под чужие профили (замечание 05.10.2026: «почему он
  должен видеть мои закупки»). Теперь лента сначала спрашивает, что он ищет.
*/
describe("TendersView — своя лента вместо общей базы", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    vi.mocked(useTenderData).mockReturnValue({
      profile: null,
      rows: buildRows(),
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    } as never);
    openAt("");
  });

  it("без профиля поиска вместо чужих закупок вопрос «Что вы ищете?»", () => {
    render(<TendersView />);

    expect(screen.getByText("Что вы ищете?")).toBeTruthy();
    expect(screen.queryByText(demoTenders[0]!.subject)).toBeNull();
  });

  it("«Показать всю базу» — по явной просьбе, и выбор помнится во вкладке", () => {
    render(<TendersView />);

    fireEvent.click(screen.getByRole("button", { name: /всю базу/i }));

    expect(screen.getByText(/^Найдено 10$/)).toBeTruthy();
    expect(sessionStorage.getItem("tenderfit.feedShowAll")).toBe("1");
  });

  it("свой запрос в строке поиска работает и без профиля", () => {
    openAt("?q=компьютеров");
    render(<TendersView />);

    expect(screen.queryByText("Что вы ищете?")).toBeNull();
  });

  it("ответ на вопрос сохраняет профиль и сразу показывает ленту по нему", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ jobId: "j1", status: "pending" }), { status: 200 })),
    );
    render(<TendersView />);
    fireEvent.change(screen.getByLabelText("Что ищете"), { target: { value: "ноутбук" } });

    fireEvent.click(screen.getByRole("button", { name: /сохранить и искать/i }));

    expect(await screen.findByText(/Ищу ваши закупки на площадках/)).toBeTruthy();
    openAdvancedSearch();
    expect(screen.getByText(/^Профиль «ноутбук»/)).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("TendersView — профиль поиска применяется к ленте", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    vi.mocked(useTenderData).mockReturnValue({
      profile: null,
      rows: buildRows(),
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    } as never);
  });

  /** Профиль, который ищет только ноутбуки. */
  function laptopProfile(): void {
    localStorage.setItem(
      STORAGE_KEYS.searchProfiles,
      JSON.stringify([
        {
          id: "sp-laptop",
          name: "Только ноутбуки",
          laws: [],
          keywords: ["ноутбук"],
          stopWords: [],
          okpd2Codes: [],
          regions: [],
          customerInns: [],
          minPrice: null,
          maxPrice: null,
          onlyOpenForSubmission: true,
          enabled: true,
        },
      ]),
    );
  }

  it("лента открывается уже суженной профилем и называет его", () => {
    /*
      Дефект: профиль «Что ищем» не влиял на ленту вовсе — человек настраивал,
      что ищет, и получал всю выдачу подряд. Замер 28.09.2026: профиль
      «Только вентиляция» не изменил ни одной строки из 173.
    */
    laptopProfile();
    openAt("");
    render(<TendersView />);
    openAdvancedSearch();

    expect(screen.getByText(/^Профиль «Только ноутбуки»/)).toBeTruthy();
  });

  /** Профиль со словом «поставка» и регионом: из девяти демонстрационных закупок со словом «поставка» регион подходит одной. */
  function regionProfile(region: string): void {
    localStorage.setItem(
      STORAGE_KEYS.searchProfiles,
      JSON.stringify([
        {
          id: "sp-region",
          name: "Поставки в регионе",
          laws: [],
          keywords: ["поставка"],
          stopWords: [],
          okpd2Codes: [],
          regions: [region],
          customerInns: [],
          minPrice: null,
          maxPrice: null,
          onlyOpenForSubmission: true,
          enabled: true,
        },
      ]),
    );
  }

  /*
    Регион профиля — выбор человека, и лента его соблюдает: показывает только
    закупки выбранного региона, регион виден чипом и в подписи. Раньше регион
    уходил в оценку «подходит / не подходит», и по Калмыкии лента выдавала всю
    Россию, где закупок региона не было видно (замечание 05.10.2026).
  */
  it("регион профиля поиска оставляет в выдаче только этот регион", () => {
    regionProfile("Приморский край");
    openAt("");
    render(<TendersView />);
    openAdvancedSearch();

    expect(screen.getByText(/^Найдено 1$/)).toBeTruthy();
    expect(screen.getByText(/^Профиль «Поставки в регионе»: Приморский край\./)).toBeTruthy();
    expect(screen.getByText("Регион: Приморский край")).toBeTruthy();
  });

  /*
    Замечание 05.10.2026: человек выбрал «Порядок: свежие сверху», в адресе
    появился параметр порядка, и лента перестала применять профиль поиска —
    показывала всю базу вместо закупок его региона.
  */
  /*
    Замечание владельца 12.10.2026: после поиска на площадках результат был
    спрятан — увидеть его можно было только через «Расширенный поиск» →
    «Показать скрытые». Теперь последний поиск виден сразу и первым.
  */
  it("результат последнего поиска виден сразу, первым и с пометкой, даже вне региона профиля", () => {
    regionProfile("Приморский край");
    const rows = buildRows();
    const outside = rows.find((row) => row.tender.region === "Москва")!;
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const withNew = rows.map((row) =>
      row === outside ? { ...row, tender: { ...row.tender, firstSeenAt: new Date().toISOString() } } : {
        ...row,
        tender: { ...row.tender, firstSeenAt: "2026-01-01T00:00:00.000Z" },
      },
    );
    vi.mocked(useTenderData).mockReturnValue({
      profile: null,
      rows: withNew,
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    } as never);
    localStorage.setItem(
      "tenderfit.lastSearch",
      JSON.stringify({ kind: "live", startedAt, queries: ["поставка"] }),
    );
    openAt("");
    render(<TendersView />);

    const banner = screen.getByTestId("last-search-banner");
    expect(banner.textContent).toMatch(/Новых для вас по запросу «поставка»: 1/);
    // Закупка из Москвы при профиле «Приморский край» стоит первой и подписана.
    const notes = screen.getAllByTestId("row-note");
    expect(notes[0]!.textContent).toMatch(/Из последнего поиска/);
    expect(screen.getAllByText(outside.tender.subject).length).toBeGreaterThan(0);

    // «Показать только их» — только результат поиска; «Закрыть» — отметка забыта.
    fireEvent.click(within(banner).getByRole("button", { name: "Показать только их" }));
    expect(screen.getByText(/^Найдено 1$/)).toBeTruthy();
    fireEvent.click(within(banner).getByRole("button", { name: /Закрыть/ }));
    expect(screen.queryByTestId("last-search-banner")).toBeNull();
    expect(localStorage.getItem("tenderfit.lastSearch")).toBeNull();
  });

  it("порядок в адресе не отключает профиль поиска", () => {
    regionProfile("Приморский край");
    openAt("?sort=freshness");
    render(<TendersView />);
    openAdvancedSearch();

    expect(screen.getByText(/^Профиль «Поставки в регионе»/)).toBeTruthy();
    expect(screen.getByText(/^Найдено 1$/)).toBeTruthy();
  });

  it("адрес со словами профиля узнаётся как профиль: его регион действует", () => {
    regionProfile("Приморский край");
    openAt(`?q2=${encodeURIComponent("поставка")}`);
    render(<TendersView />);
    openAdvancedSearch();

    expect(screen.getByText(/^Найдено 1$/)).toBeTruthy();
    expect(screen.getByText(/^Профиль «Поставки в регионе»: Приморский край\./)).toBeTruthy();
  });

  it("пустой регион не подменяется всей Россией: лента так и говорит", () => {
    regionProfile("Республика Калмыкия");
    openAt("");
    render(<TendersView />);

    expect(screen.getByText(/^Найдено 0$/)).toBeTruthy();
    expect(screen.getByText(/В регионе Республика Калмыкия пока ничего не найдено/)).toBeTruthy();
  });

  it("пустой профиль первым в списке не отключает профиль со словами", () => {
    localStorage.setItem(
      STORAGE_KEYS.searchProfiles,
      JSON.stringify([
        {
          id: "sp-empty", name: "Пустой", laws: [], keywords: [], stopWords: [], okpd2Codes: [], regions: [],
          customerInns: [], minPrice: null, maxPrice: null, onlyOpenForSubmission: true, enabled: true,
        },
        {
          id: "sp-region", name: "Поставки в регионе", laws: [], keywords: ["поставка"], stopWords: [], okpd2Codes: [],
          regions: ["Приморский край"], customerInns: [], minPrice: null, maxPrice: null,
          onlyOpenForSubmission: true, enabled: true,
        },
      ]),
    );
    openAt("");
    render(<TendersView />);
    openAdvancedSearch();

    expect(screen.getByText(/^Профиль «Поставки в регионе»/)).toBeTruthy();
    expect(screen.getByText(/^Найдено 1$/)).toBeTruthy();
  });

  it("старый адрес с другими словами и законом не отключает профиль: показывается профиль", () => {
    regionProfile("Приморский край");
    openAt(`?q2=${encodeURIComponent("старое слово")}&law=FZ_44&sort=freshness`);
    render(<TendersView />);
    openAdvancedSearch();

    expect(screen.getByText(/^Профиль «Поставки в регионе»/)).toBeTruthy();
    expect(screen.getByText(/^Найдено 1$/)).toBeTruthy();
  });

  it("снятый чип региона возвращает всю Россию и не прячет её как «вне профиля»", () => {
    regionProfile("Приморский край");
    openAt("");
    render(<TendersView />);
    openAdvancedSearch();
    expect(screen.getByText(/^Найдено 1$/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Снять фильтр: Регион: Приморский край" }));
    expect(screen.getByText(/^Найдено 9$/)).toBeTruthy();
    expect(screen.queryByText(/Скрыто как неподходящее/)).toBeNull();
  });

  it("профиль без региона и цены ничего не скрывает по условиям поиска", () => {
    laptopProfile();
    openAt("");
    render(<TendersView />);

    expect(screen.queryByText(/Скрыто как неподходящее/)).toBeNull();
  });

  it("статистики и счётчиков оценки над списком нет: список виден сразу", () => {
    openAt("");
    render(<TendersView />);

    expect(screen.queryByText("Рекомендовано")).toBeNull();
    expect(screen.queryByText(/Нужна проверка/)).toBeNull();
    expect(screen.queryByText(/Закрывается < 24 ч/)).toBeNull();
    expect(screen.queryByRole("group", { name: "Оценка по профилю компании" })).toBeNull();
    // Фильтр по оценке остался в «Фильтрах».
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    expect(screen.getByLabelText("Оценка")).toBeTruthy();
  });

  /*
    Замечание 07.10.2026: подпись профиля, «Скрыто как неподходящее» и чипы
    занимали полэкрана над таблицей. Теперь они внутри «Расширенного поиска»,
    а у ссылки — число действующих ограничений.
  */
  it("профиль и чипы спрятаны в «Расширенный поиск», у ссылки — их число", () => {
    regionProfile("Приморский край");
    openAt("");
    render(<TendersView />);

    const toggle = screen.getByRole("button", { name: "Расширенный поиск" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/\d+$/);
    expect(screen.queryByText(/^Профиль «/)).toBeNull();
    expect(screen.queryByRole("list", { name: "Применённые фильтры" })).toBeNull();

    fireEvent.click(toggle);

    expect(screen.getByText(/^Профиль «Поставки в регионе»/)).toBeTruthy();
    expect(screen.getByText("Регион: Приморский край")).toBeTruthy();
  });

  it("«Показать все» снимает профиль и возвращает всю ленту", () => {
    laptopProfile();
    openAt("");
    render(<TendersView />);
    openAdvancedSearch();

    fireEvent.click(screen.getByRole("button", { name: "Показать все" }));

    expect(screen.queryByText(/^Профиль «/)).toBeNull();
    expect(screen.getByText(/^Найдено 10$/)).toBeTruthy();
  });

  it("свой адрес важнее профиля: по ссылке открывается то, чем делились", () => {
    // Иначе ссылка на выдачу показывала бы у получателя его собственный профиль.
    laptopProfile();
    openAt("?q=принтер");
    render(<TendersView />);

    expect(screen.queryByText(/^Профиль «/)).toBeNull();
  });

  /*
    Свой запрос заменяет слова профиля, а не добавляется к ним.

    Строка поиска и ключевые слова профиля — альтернативы («или»), поэтому
    профиль, оставшийся под ногами, разбавлял бы любой запрос: человек с
    профилем «ноутбуки» печатал «принтер» и получал принтеры ВМЕСТЕ с
    ноутбуками. Именно так выглядело «ищу юриспруденцию, а выходят чужие
    услуги».
  */
  it("свой запрос снимает слова профиля, и в выдаче остаётся только он", () => {
    laptopProfile();
    openAt("");
    render(<TendersView />);
    openAdvancedSearch();
    expect(screen.getByText(/Ключевые слова: ноутбук/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/Например: вентиль/), {
      target: { value: "принтер" },
    });

    // Подпись чипа меняется с «Ключевые слова» на «+ ещё» при непустой
    // строке, поэтому проверяется любая из двух: иначе тест прошёл бы зря.
    expect(screen.queryByText(/Ключевые слова:|ещё ключев/)).toBeNull();
    expect(screen.getByText(/Поиск: принтер/)).toBeTruthy();
  });

  it("очистка строки не возвращает слова профиля сама", () => {
    laptopProfile();
    openAt("");
    render(<TendersView />);

    openAdvancedSearch();
    const box = screen.getByPlaceholderText(/Например: вентиль/);
    fireEvent.change(box, { target: { value: "принтер" } });
    fireEvent.change(box, { target: { value: "" } });

    expect(screen.queryByText(/Ключевые слова:|ещё ключев/)).toBeNull();
  });

  it("выключенный профиль ленту не сужает", () => {
    localStorage.setItem(
      STORAGE_KEYS.searchProfiles,
      JSON.stringify([
        {
          id: "sp-off", name: "Выключенный", laws: [], keywords: ["ноутбук"],
          stopWords: [], okpd2Codes: [], regions: [], customerInns: [],
          minPrice: null, maxPrice: null, onlyOpenForSubmission: true, enabled: false,
        },
      ]),
    );
    openAt("");
    render(<TendersView />);

    expect(screen.queryByText(/^Профиль «/)).toBeNull();
  });
});

describe("TendersView — профиль не сужает ленту до пустоты", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    vi.mocked(useTenderData).mockReturnValue({
      profile: null,
      rows: buildRows(),
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    } as never);
  });

  it("профиль без совпадений откатывается к полной ленте и объясняет это", () => {
    /*
      Пустой экран при первом открытии неотличим от поломки. Замер на живых
      данных: демонстрационный профиль «Компьютеры и оргтехника (Москва)»
      давал 0 из 173 — человек увидел бы пустоту вместо ленты.
    */
    localStorage.setItem(
      STORAGE_KEYS.searchProfiles,
      JSON.stringify([
        {
          id: "sp-nothing", name: "Ничего не находит", laws: [],
          keywords: ["несуществующаяноменклатура"], stopWords: [], okpd2Codes: [],
          regions: [], customerInns: [], minPrice: null, maxPrice: null,
          onlyOpenForSubmission: true, enabled: true,
        },
      ]),
    );
    openAt("");
    render(<TendersView />);

    expect(
      screen.getByText(/По профилю «Ничего не находит» ничего нет — показана вся лента/),
    ).toBeTruthy();
    expect(screen.getByText(/^Найдено 10$/)).toBeTruthy();
  });

  it("пустая выдача по фильтрам человека профилем не подменяется", () => {
    // Свой запрос, давший ноль, — осознанный результат, а не повод всё сбросить.
    openAt("?q=несуществующаяноменклатура");
    render(<TendersView />);

    expect(screen.queryByText(/показана вся лента/)).toBeNull();
    expect(screen.getByText(/^Найдено 0$/)).toBeTruthy();
  });
});

describe("TendersView — упрощённая шапка и поиск", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem(STORAGE_KEYS.searchProfiles, "[]");
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    vi.mocked(useTenderData).mockReturnValue({
      profile: null,
      rows: buildRows(),
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    } as never);
    openAt("");
  });

  it("вместо «Добавить свою» — «Найти новые закупки», а ссылка на ручной ввод стоит под ней", () => {
    render(<TendersView />);

    expect(screen.queryByText("Добавить свою")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Найти новые закупки" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Добавить по ссылке" }).getAttribute("href")).toBe("/tenders/import");
  });

  it("карточек статистики нет, а подзаголовок — только «Найдено N»", () => {
    render(<TendersView />);

    expect(screen.queryByText("Рекомендовано")).toBeNull();
    expect(screen.queryByText("Нужна проверка")).toBeNull();
    expect(screen.queryByText("Не подходит")).toBeNull();
    expect(screen.queryByText(/Закрывается < 24 ч/)).toBeNull();
    expect(screen.getByText(/^Найдено 10$/)).toBeTruthy();
  });

  it("порядок выдачи остался компактной строкой", () => {
    render(<TendersView />);

    const group = screen.getByRole("group", { name: "Порядок выдачи" });
    expect(within(group).getByRole("button", { name: "Самые подходящие" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Сначала новые" })).toBeTruthy();
  });

  it("поиск свёрнут по умолчанию и раскрывается по клику на «Расширенный поиск»", () => {
    render(<TendersView />);
    const toggle = screen.getByRole("button", { name: "Расширенный поиск" });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText(searchControlLabels.query)).toBeNull();
    expect(screen.queryByLabelText(searchControlLabels.exclude)).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText(searchControlLabels.query)).toBeTruthy();
    expect(screen.getByLabelText(searchControlLabels.exclude)).toBeTruthy();
    expect(screen.getByLabelText(searchControlLabels.exact)).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByLabelText(searchControlLabels.query)).toBeNull();
  });

  it("с запросом в адресе поиск открыт сразу и не прячет действующий запрос", () => {
    openAt("?q=ноутбук");
    render(<TendersView />);

    expect(screen.getByRole("button", { name: "Расширенный поиск" }).getAttribute("aria-expanded")).toBe("true");
    expect((screen.getByLabelText(searchControlLabels.query) as HTMLInputElement).value).toBe("ноутбук");
  });

  it("исключения в адресе тоже открывают поиск", () => {
    openAt("?x=поставка");
    render(<TendersView />);

    expect(screen.getByRole("button", { name: "Расширенный поиск" }).getAttribute("aria-expanded")).toBe("true");
    expect((screen.getByLabelText(searchControlLabels.exclude) as HTMLInputElement).value).toBe("поставка");
  });

  it("поиск из расширенного блока работает как раньше", () => {
    render(<TendersView />);
    fireEvent.click(screen.getByRole("button", { name: "Расширенный поиск" }));

    fireEvent.change(screen.getByLabelText(searchControlLabels.query), { target: { value: "вентиль" } });

    expect(replace).toHaveBeenCalledWith(address({ q: "вентиль" }), { scroll: false });
  });

  it("«Расширенный поиск» и «Фильтры» стоят в одной строке", () => {
    render(<TendersView />);
    const filters = screen.getByRole("button", { name: /^Фильтры/ });
    const search = screen.getByRole("button", { name: "Расширенный поиск" });

    expect(filters.parentElement).toBe(search.parentElement);
  });
});

/*
  Замер 14.10.2026 на ленте владельца («Строительство и ремонт»): из 115 показанных
  закупок 76 — покупка квартир у застройщика (совпали по «долевом строительстве»).
  Подрядчику они не подходят, но прятать их молча нельзя: число и причина — над
  таблицей, «Показать скрытые» возвращает их в выдачу.
*/
describe("TendersView — покупка квартир не подряд", () => {
  const flat =
    "Приобретение в муниципальную собственность благоустроенного жилого помещения на территории г. Улан-Удэ у Застройщика путем участия в долевом строительстве многоквартирного дома";

  function constructionRows(): TenderRow[] {
    const base = demoTenders[0]!;
    return [
      { id: "works-1", subject: "Капитальный ремонт кровли школы" },
      { id: "flat-1", subject: flat },
      { id: "flat-2", subject: flat },
      { id: "monitor-1", subject: "мониторинг цен в электронной форме на строительство ограждения" },
    ].map(({ id, subject }) => {
      const tender = { ...base, id, regNumber: id, subject, region: "", okpd2Codes: [], lots: [] };
      return { tender, analysis: analyzeTender(tender, demoCompanyProfile), pipelineStatus: "NEW" as const };
    });
  }

  function constructionProfile(): void {
    localStorage.setItem(
      STORAGE_KEYS.searchProfiles,
      JSON.stringify([
        {
          id: "sp-build",
          name: "Строительство и ремонт",
          laws: [],
          keywords: ["Строительство", "Капитальный ремонт"],
          stopWords: [],
          okpd2Codes: [],
          regions: [],
          customerInns: [],
          minPrice: null,
          maxPrice: null,
          onlyOpenForSubmission: false,
          enabled: true,
        },
      ]),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    vi.mocked(useTenderData).mockReturnValue({
      profile: null,
      rows: constructionRows(),
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    });
    openAt("");
  });

  it("квартиры и мониторинг цен скрыты с причиной и числом, работы остались", () => {
    constructionProfile();
    render(<TendersView />);
    openAdvancedSearch();

    expect(screen.getByText(/^Найдено 1$/)).toBeTruthy();
    expect(
      screen.getByText(/Скрыто как неподходящее: 3 \(не подряд: покупка квартир и помещений, мониторинг цен\)/),
    ).toBeTruthy();
  });

  it("«Показать скрытые» возвращает их в выдачу", () => {
    constructionProfile();
    render(<TendersView />);
    openAdvancedSearch();

    fireEvent.click(screen.getByRole("button", { name: "Показать скрытые" }));

    expect(screen.getByText(/^Найдено 4$/)).toBeTruthy();
    expect(screen.getByText(/Показаны и скрытые: 3/)).toBeTruthy();
  });

  it("человек сам ищет квартиры — они не прячутся", () => {
    openAt("?q=" + encodeURIComponent("долевое строительство"));
    render(<TendersView />);
    openAdvancedSearch();

    expect(screen.getByText(/^Найдено 2$/)).toBeTruthy();
    expect(screen.queryByText(/Скрыто как неподходящее/)).toBeNull();
  });
});

describe("TendersView — после быстрого старта: тур и первый поиск", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(STORAGE_KEYS.searchProfiles, "[]");
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
    vi.mocked(useTenderData).mockReturnValue({
      profile: null,
      rows: buildRows(),
      loading: false,
      error: null,
      reload: vi.fn(),
      syncKontur: vi.fn().mockResolvedValue(null),
      syncState: { syncing: false, error: null, lastSynced: 0, progress: null, report: null },
    } as never);
  });

  afterEach(() => openAt(""));

  it("?tour=1 открывает тур; «Пропустить» отмечает его пройденным и убирает параметр из адреса", () => {
    openAt("?tour=1");
    render(<TendersView />);

    expect(screen.getByTestId("product-tour")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    expect(screen.queryByTestId("product-tour")).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.tourDone) ?? "false")).toBe(true);
    expect(replace).toHaveBeenLastCalledWith("/tenders", { scroll: false });
  });

  it("пройденный тур сам не открывается, а по «Как пользоваться» (force) — открывается", () => {
    localStorage.setItem(STORAGE_KEYS.tourDone, "true");
    openAt("?tour=1");
    render(<TendersView />);
    expect(screen.queryByTestId("product-tour")).toBeNull();
    cleanup();

    openAt("?tour=1&force=1");
    render(<TendersView />);
    expect(screen.getByTestId("product-tour")).toBeTruthy();
  });

  it("поиск, запущенный быстрым стартом, лента досматривает: плашка «Ищу ваши закупки…»", () => {
    sessionStorage.setItem(
      "tenderfit.pendingFirstSearch",
      JSON.stringify({ jobId: "j1", startedAt: new Date().toISOString(), queries: ["кровля"], problem: null }),
    );
    openAt("");
    render(<TendersView />);

    expect(screen.getByText(/Ищу ваши закупки на площадках/)).toBeTruthy();
    expect(sessionStorage.getItem("tenderfit.pendingFirstSearch")).toBeNull();
  });
});
