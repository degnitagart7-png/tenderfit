import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TenderRow } from "@/domain/filtering";
import { demoTenders } from "@/mocks/tenders";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { searchControlLabels } from "@/lib/labels";
import { useTenderData } from "@/hooks/useTenderData";
import { useRouter } from "next/navigation";
import { STORAGE_KEYS } from "@/lib/storage";
import { TendersView } from "@/components/tenders/TendersView";

vi.mock("@/hooks/useTenderData", () => ({
  useTenderData: vi.fn(),
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

    fireEvent.change(screen.getByLabelText(searchControlLabels.query), {
      target: { value: "вентиль" },
    });

    expect(replace).toHaveBeenCalledWith(address({ q: "вентиль" }), { scroll: false });
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

  it("выбранный порядок виден чипом, а снятие чипа возвращает слои", () => {
    mount(feed());

    fireEvent.click(screen.getByRole("button", { name: "Сортировать по НМЦК" }));
    expect(screen.getByText(/Порядок: по цене/)).toBeTruthy();
    expect(screen.queryByText(/Новые · платный поиск/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Снять фильтр: Порядок: по цене" }));
    expect(screen.getByText(/Новые · платный поиск/)).toBeTruthy();
    expect(screen.queryByText(/Порядок: по цене/)).toBeNull();
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

    expect(screen.getByText(/Найдено 1 из 11/)).toBeTruthy();
    expect(screen.getByText("Свежая находка Контур")).toBeTruthy();
    expect(screen.queryByText(demoTenders[0]!.subject)).toBeNull();
  });

  it("чип партии снимает ограничение и возвращает всю ленту", () => {
    openAt(`?batch=${encodeURIComponent(STAMP)}`);
    mount(feed());

    fireEvent.click(screen.getByRole("button", { name: /Снять фильтр: Партия/ }));

    expect(screen.getByText(/Найдено 11 из 11/)).toBeTruthy();
    expect(screen.getByText(demoTenders[0]!.subject)).toBeTruthy();
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

    expect(screen.getByText(/Показаны закупки по профилю «Только ноутбуки»/)).toBeTruthy();
  });

  it("«Показать все» снимает профиль и возвращает всю ленту", () => {
    laptopProfile();
    openAt("");
    render(<TendersView />);

    fireEvent.click(screen.getByRole("button", { name: "Показать все" }));

    expect(screen.queryByText(/Показаны закупки по профилю/)).toBeNull();
    expect(screen.getByText(/Найдено 10 из 10/)).toBeTruthy();
  });

  it("свой адрес важнее профиля: по ссылке открывается то, чем делились", () => {
    // Иначе ссылка на выдачу показывала бы у получателя его собственный профиль.
    laptopProfile();
    openAt("?q=принтер");
    render(<TendersView />);

    expect(screen.queryByText(/Показаны закупки по профилю/)).toBeNull();
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

    expect(screen.queryByText(/Показаны закупки по профилю/)).toBeNull();
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
      screen.getByText(/По профилю «Ничего не находит» сейчас нет ни одной закупки/),
    ).toBeTruthy();
    expect(screen.getByText(/Найдено 10 из 10/)).toBeTruthy();
  });

  it("пустая выдача по фильтрам человека профилем не подменяется", () => {
    // Свой запрос, давший ноль, — осознанный результат, а не повод всё сбросить.
    openAt("?q=несуществующаяноменклатура");
    render(<TendersView />);

    expect(screen.queryByText(/показана вся лента/)).toBeNull();
    expect(screen.getByText(/Найдено 0 из 10/)).toBeTruthy();
  });
});
