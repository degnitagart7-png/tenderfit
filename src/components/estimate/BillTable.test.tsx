import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EstimateResult, type EstimateResultData } from "@/components/estimate/EstimateResult";
import { billSignature, type BillEditsRecord } from "@/domain/estimate/billEdits";
import type { RejectedBillRow } from "@/domain/estimate/billExtraction";
import { searchNorms } from "@/domain/estimate/normSearch";
import { useBillEdits } from "@/hooks/useBillEdits";
import { recalculateEstimate } from "@/services/estimateRecalc";
import { RIGHT_NORM, WRONG_NORM, buildEditResult, makeEditBase } from "@/test/billEditFixtures";

/*
  Таблица «Ведомость и нормы» целиком: настоящий расчёт, настоящий пересчёт (`recalculateEstimate`
  на тестовой базе) и настоящий поиск норм; подменены только сетевые ответы `/api/estimate/*` —
  роуты проверены в своих тестах. Так видно путь «правка → Пересчитать → новый итог», а не отдельные кусочки.
*/

const WALLS = "d1c1-1";
const GRADING = "d1c1-2";
const FENCE = "d1c1-4";
const WEAK = "d1c1-5";

const REJECTED: RejectedBillRow[] = [
  {
    reason: "UNKNOWN_UNIT",
    row: { workName: "Планировка вручную дна и откосов выемок каналов, дополнительно", quantity: "40", unit: "ящиков", evidenceQuote: "Планировка 40 ящиков" },
    message: "Единица «ящиков» не распознана",
    documentName: "ВОР.docx",
  },
];

interface Server {
  record: BillEditsRecord | null;
  puts: { tenderId: string; record: BillEditsRecord | null }[];
  guest: boolean;
}

let server: Server;
let base = makeEditBase();
let built: Awaited<ReturnType<typeof buildEditResult>>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/estimate/recalc")) {
        const body = JSON.parse(String(init?.body)) as { edits: never[] };
        const result = await recalculateEstimate({ document: built.document, bill: built.bill }, body.edits, { base });
        return json(result);
      }
      if (url.startsWith("/api/estimate/norms")) {
        const params = new URL(url, "http://localhost").searchParams;
        const result = searchNorms(base.searchIndex, { query: params.get("q") ?? "", limit: Number(params.get("limit") ?? 10) });
        return json({ ...result, limit: 8 });
      }
      if (url.startsWith("/api/estimate/edits")) {
        if (server.guest) return json({ error: "Нужно войти." }, 401);
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { tenderId: string; record: BillEditsRecord | null };
          server.puts.push(body);
          server.record = body.record;
          return json({ saved: true });
        }
        return json({ record: server.record });
      }
      return json({ error: `неожиданный запрос ${url}` }, 500);
    }),
  );
}

function data(): EstimateResultData {
  return {
    document: built.document,
    rejected: REJECTED,
    documentsWithoutBill: [],
    billItems: built.billItems,
    bill: built.bill,
  };
}

function Harness({ jobId = "job-1", result }: { jobId?: string; result?: EstimateResultData }) {
  const shownBase = result ?? data();
  const editor = useBillEdits({ tenderId: "0123", jobId, result: shownBase });
  return <EstimateResult data={editor?.effective ?? shownBase} regNumber="0123" editor={editor} />;
}

const flat = (node: HTMLElement): string => (node.textContent ?? "").replace(/\s+/gu, " ");
const row = (id: string): HTMLElement => screen.getByTestId(`bill-row-${id}`);
/** Ячейки строки по порядку: № · работа · объём · норма · источник цены · стоимость · действия. */
const cell = (id: string, index: number): string => flat(within(row(id)).getAllByRole("cell")[index] as HTMLElement);
const volume = (id: string): string => cell(id, 2);
const normOf = (id: string): string => cell(id, 3);
const recalcButton = (): HTMLButtonElement => within(screen.getByTestId("bill-actions")).getByRole("button", { name: "Пересчитать" });

async function renderTable(over: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...over} />);
  await waitFor(() => expect(screen.getByTestId("bill-table")).toBeInTheDocument());
  // Дать отработать подгрузке сохранённых правок.
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
}

function openEditor(id: string): HTMLElement {
  fireEvent.click(within(row(id)).getByRole("button", { name: "Изменить" }));
  return screen.getByTestId(`row-editor-${id}`);
}

async function recalc(): Promise<void> {
  fireEvent.click(recalcButton());
  await waitFor(() => expect(recalcButton()).toBeDisabled());
  await waitFor(() => expect(screen.queryByTestId("recalc-error")).toBeNull());
}

beforeEach(async () => {
  window.localStorage.clear();
  server = { record: null, puts: [], guest: false };
  base = makeEditBase();
  built = await buildEditResult(base);
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("таблица «Ведомость и нормы»: показ", () => {
  it("каждая позиция с номером, работой, объёмом, нормой (шифр, наименование, единица), источником цены и стоимостью", async () => {
    await renderTable();

    const walls = flat(row(WALLS));
    expect(walls).toContain("Демонтаж наружных стен");
    expect(walls).toContain("120 м2");
    expect(walls).toContain(`ГЭСН ${WRONG_NORM.code}`);
    expect(walls).toContain(WRONG_NORM.fullName);
    expect(walls).toContain(`ед. нормы: ${WRONG_NORM.unit}`);
    expect(walls).toContain("наша норма");
    expect(walls).toMatch(/\d[\d\s]* ₽/u);
    expect(within(row(WALLS)).getByTestId("match-badge")).toHaveTextContent("по наименованию, 100 %");
  });

  it("«проверьте» у слабого подбора и у подбора с чужими словами (опалубка); счётчик и фильтр считают их", async () => {
    await renderTable();

    expect(row(WEAK)).toHaveAttribute("data-review", "true");
    expect(within(row(WEAK)).getByTestId("match-badge")).toHaveTextContent(/по наименованию, \d+ % · проверьте/u);
    // Ловушка владельца: покрытие полное, но «опалубки» в работе нет — причина названа словами.
    expect(row(WALLS)).toHaveAttribute("data-review", "true");
    expect(within(row(WALLS)).getByTestId("match-badge")).toHaveTextContent("по наименованию, 100 % · проверьте");
    expect(within(row(WALLS)).getByTestId("match-note")).toHaveTextContent("в норме есть «опалубки», в работе — нет");
    expect(row(GRADING)).toHaveAttribute("data-review", "false");
    expect(screen.getByTestId("review-count")).toHaveTextContent("Проверить: 2 позиции");

    fireEvent.click(screen.getByLabelText("показать только требующие проверки"));
    expect(screen.queryByTestId(`bill-row-${GRADING}`)).toBeNull();
    expect(row(WEAK)).toBeInTheDocument();
    expect(row(WALLS)).toBeInTheDocument();
  });

  it("выбрана правильная норма — подсветка «проверьте» у позиции снимается", async () => {
    await renderTable();

    const editor = openEditor(WALLS);
    // Нужная норма стоит первой среди вариантов: она из сборника ГЭСН 46.
    const first = within(within(editor).getByTestId("norm-options")).getAllByRole("radio")[1] as HTMLElement;
    fireEvent.click(first);
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await recalc();

    expect(normOf(WALLS)).toContain(`ГЭСН ${RIGHT_NORM.code}`);
    expect(row(WALLS)).toHaveAttribute("data-review", "false");
    expect(screen.getByTestId("review-count")).toHaveTextContent("Проверить: 1 позиция");
  });

  it("цитата свёрнута; по клику — полностью, с именем файла", async () => {
    await renderTable();

    const quote = within(row(WALLS)).getByTestId("quote");
    expect(quote).not.toHaveAttribute("open");
    expect(within(quote).getByTestId("quote-full")).toHaveTextContent("«1 | Демонтаж наружных стен | м2 | 120»");
    expect(within(quote).getByTestId("quote-full")).toHaveTextContent("Файл: ВОР.docx");

    fireEvent.click(within(quote).getByText(/^Цитата:/u));
    // jsdom переключает open у details по клику на summary.
    expect(quote.hasAttribute("open")).toBe(true);
  });

  it("позиция, выпавшая из расчёта, — не в таблице, а в «Не вошло в расчёт» с причиной", async () => {
    await renderTable();

    expect(screen.queryByTestId(`bill-row-${FENCE}`)).toBeNull();
    const dropped = screen.getByTestId(`dropped-${FENCE}`);
    expect(dropped).toHaveTextContent("Монтаж ограждения");
    expect(dropped).toHaveTextContent("норма в ФСНБ-2022 не найдена");
    expect(screen.getByTestId("not-included")).toHaveTextContent("Не вошло в расчёт: 2");
  });
});

describe("правки и пересчёт", () => {
  it("«Пересчитать» неактивна, пока правок нет; правка объёма включает её; после пересчёта — «было → стало»", async () => {
    await renderTable();
    expect(recalcButton()).toBeDisabled();
    const before = built.document.totals.workCost;

    const editor = openEditor(WALLS);
    fireEvent.change(within(editor).getByLabelText("Объём"), { target: { value: "240" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));

    expect(recalcButton()).toBeEnabled();
    expect(screen.getByTestId("edits-count")).toHaveTextContent("1 правка — ждут пересчёта");
    expect(within(row(WALLS)).getByText("правка ждёт пересчёта")).toBeInTheDocument();

    await recalc();

    expect(volume(WALLS)).toContain("240 м2");
    const diff = flat(screen.getByTestId("totals-diff"));
    expect(diff).toContain("было");
    expect(diff).toContain("стало");
    expect(diff).toMatch(/\+\d/u);
    expect(screen.getByText("Стоимость СМР").nextElementSibling?.textContent ?? "").not.toBe(`${before.toLocaleString("ru-RU")} ₽`);
    expect(screen.queryByText("правка ждёт пересчёта")).toBeNull();
    expect(within(row(WALLS)).getByText("изменено")).toBeInTheDocument();
  });

  it("выбор альтернативной нормы из подбора: норма меняется, подпись — «выбрано вами»", async () => {
    await renderTable();

    const editor = openEditor(WALLS);
    const options = within(editor).getByTestId("norm-options");
    expect(options).toHaveTextContent(`Подобрано расчётом: ГЭСН ${WRONG_NORM.code}`);
    fireEvent.click(within(options).getByLabelText(new RegExp(RIGHT_NORM.code, "u")));
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await recalc();

    expect(normOf(WALLS)).toContain(`ГЭСН ${RIGHT_NORM.code}`);
    expect(normOf(WALLS)).not.toContain(WRONG_NORM.code);
    expect(within(row(WALLS)).getByTestId("match-badge")).toHaveTextContent("выбрано вами");
  });

  it("поиск нормы по словам: найденная норма выбирается и идёт в расчёт", async () => {
    await renderTable();

    const editor = openEditor(WALLS);
    fireEvent.change(within(editor).getByLabelText("Найти норму по шифру или словам"), { target: { value: "разборка кирпичных стен" } });
    const results = await within(editor).findByTestId("norm-results", undefined, { timeout: 3000 });
    expect(results).toHaveTextContent(RIGHT_NORM.code);
    fireEvent.click(within(results).getAllByRole("button", { name: "Выбрать" })[0] as HTMLElement);
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await recalc();

    expect(normOf(WALLS)).toContain(`ГЭСН ${RIGHT_NORM.code}`);
    expect(within(row(WALLS)).getByTestId("match-badge")).toHaveTextContent("выбрано вами");
  });

  it("норма с несходящейся единицей помечена предупреждением, и позиция после пересчёта выпадает с причиной", async () => {
    await renderTable();

    const editor = openEditor(WEAK);
    fireEvent.click(within(within(editor).getByTestId("norm-options")).getByLabelText(/01-01-111-01/u));
    expect(within(editor).getByTestId("norm-options")).toHaveTextContent("Единица нормы не совпадает с единицей позиции");
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await recalc();

    expect(screen.queryByTestId(`bill-row-${WEAK}`)).toBeNull();
    expect(screen.getByTestId(`dropped-${WEAK}`)).toHaveTextContent("не совпадает с единицей нормы");
  });

  it("поиск нормы по шифру находит точную норму", async () => {
    await renderTable();

    const editor = openEditor(WALLS);
    fireEvent.change(within(editor).getByLabelText("Найти норму по шифру или словам"), { target: { value: `ГЭСН ${RIGHT_NORM.code}` } });
    const results = await within(editor).findByTestId("norm-results", undefined, { timeout: 3000 });
    expect(within(results).getAllByRole("listitem")).toHaveLength(1);
  });

  it("своя цена: объём × цена, источник «своя цена», итог обновился", async () => {
    await renderTable();

    const editor = openEditor(WALLS);
    fireEvent.click(within(editor).getByLabelText("По своей цене"));
    fireEvent.change(within(editor).getByLabelText("Своя цена за единицу"), { target: { value: "1000" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await recalc();

    const walls = flat(row(WALLS));
    expect(walls).toContain("своя цена");
    expect(walls).toMatch(/120 000 ₽/u);
    expect(screen.getByTestId("own-priced")).toHaveTextContent("по вашим ценам");
  });

  it("нечисловой объём и цена не принимаются, правка не создаётся", async () => {
    await renderTable();

    const editor = openEditor(WALLS);
    fireEvent.change(within(editor).getByLabelText("Объём"), { target: { value: "много" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));

    expect(within(editor).getByRole("alert")).toHaveTextContent("Объём должен быть числом");
    expect(recalcButton()).toBeDisabled();
  });

  it("удалить строку: она уходит в «Не вошло в расчёт»; «Вернуть в расчёт» отменяет удаление", async () => {
    await renderTable();

    const editor = openEditor(GRADING);
    fireEvent.click(within(editor).getByRole("button", { name: "Удалить строку" }));
    expect(screen.queryByTestId(`bill-row-${GRADING}`)).toBeNull();
    expect(screen.getByTestId(`removed-${GRADING}`)).toHaveTextContent("вы удалили эту строку");
    await recalc();
    expect(screen.queryByTestId(`bill-row-${GRADING}`)).toBeNull();
    expect(screen.getByTestId("totals-diff")).toHaveTextContent("-");

    fireEvent.click(within(screen.getByTestId(`removed-${GRADING}`)).getByRole("button", { name: "Вернуть в расчёт" }));
    expect(screen.getByTestId("edits-count")).toHaveTextContent("Правок нет");
    expect(recalcButton()).toBeEnabled();
    await recalc();
    expect(row(GRADING)).toBeInTheDocument();
  });

  it("добавить строку: наименование, объём, единица, своя цена — строка в смете после пересчёта", async () => {
    await renderTable();

    fireEvent.click(screen.getByRole("button", { name: "Добавить строку" }));
    const form = screen.getByTestId("add-row-form");
    fireEvent.change(within(form).getByLabelText("Наименование работы"), { target: { value: "Вывоз мусора" } });
    fireEvent.change(within(form).getByLabelText("Объём новой строки"), { target: { value: "10" } });
    fireEvent.change(within(form).getByLabelText("Единица новой строки"), { target: { value: "т" } });
    fireEvent.click(within(form).getByLabelText("Своя цена"));
    fireEvent.change(within(form).getByLabelText("Своя цена новой строки"), { target: { value: "500" } });
    fireEvent.click(within(form).getByRole("button", { name: "Добавить" }));

    expect(screen.getByTestId("pending-adds")).toHaveTextContent("Добавлена: Вывоз мусора");
    await recalc();

    const added = screen.getByTestId("bill-row-add-1");
    expect(flat(added)).toContain("Вывоз мусора");
    expect(flat(added)).toContain("своя цена");
    expect(flat(added)).toMatch(/5 000 ₽/u);
  });

  it("добавить строку без нормы и без цены нельзя", async () => {
    await renderTable();

    fireEvent.click(screen.getByRole("button", { name: "Добавить строку" }));
    const form = screen.getByTestId("add-row-form");
    fireEvent.change(within(form).getByLabelText("Наименование работы"), { target: { value: "Вывоз мусора" } });
    fireEvent.change(within(form).getByLabelText("Объём новой строки"), { target: { value: "10" } });
    fireEvent.click(within(form).getByRole("button", { name: "Добавить" }));

    expect(within(form).getByRole("alert")).toHaveTextContent("Выберите норму или укажите свою цену");
    expect(recalcButton()).toBeDisabled();
  });

  it("позиция без нормы возвращается в расчёт: «Вернуть в расчёт» открывает правку, своя цена — и она в таблице", async () => {
    await renderTable();

    fireEvent.click(within(screen.getByTestId(`dropped-${FENCE}`)).getByRole("button", { name: "Вернуть в расчёт" }));
    const editor = screen.getByTestId(`row-editor-${FENCE}`);
    fireEvent.click(within(editor).getByLabelText("По своей цене"));
    fireEvent.change(within(editor).getByLabelText("Своя цена за единицу"), { target: { value: "2000" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await recalc();

    expect(flat(row(FENCE))).toMatch(/30 000 ₽/u);
    expect(screen.queryByTestId(`dropped-${FENCE}`)).toBeNull();
  });

  it("отклонённая строка: пока единица не распознана, вернуть нельзя; после исправления — возвращается", async () => {
    await renderTable();

    const rejected = screen.getByTestId("rejected-row");
    const back = within(rejected).getByRole("button", { name: "Вернуть в расчёт" });
    expect(back).toBeDisabled();
    expect(rejected).toHaveTextContent("единица не распознана");

    fireEvent.change(within(rejected).getByLabelText("Единица возвращаемой строки"), { target: { value: "м2" } });
    expect(back).toBeEnabled();
    fireEvent.click(back);

    // Строка ушла из списка отклонённых и ждёт пересчёта.
    expect(screen.queryByTestId("rejected-row")).toBeNull();
    expect(screen.getByTestId("pending-adds")).toHaveTextContent("Возвращена");
    await recalc();

    const returned = Array.from(document.querySelectorAll("[data-testid^='bill-row-rej-']"))[0] as HTMLElement;
    expect(flat(returned)).toContain("Планировка вручную дна и откосов выемок каналов, дополнительно");
    expect(flat(returned)).toContain("40 м2");
  });

  it("сбросить все правки: список пуст, исходный расчёт на месте", async () => {
    await renderTable();

    const editor = openEditor(WALLS);
    fireEvent.change(within(editor).getByLabelText("Объём"), { target: { value: "240" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await recalc();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить все правки" }));

    expect(screen.getByTestId("edits-count")).toHaveTextContent("Правок нет");
    expect(screen.queryByTestId("totals-diff")).toBeNull();
    expect(volume(WALLS)).toContain("120 м2");
  });

  it("ошибка пересчёта показана словами, правки не потеряны", async () => {
    await renderTable();
    const original = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).startsWith("/api/estimate/recalc") ? json({ error: "Цены обновились: рассчитайте смету заново" }, 409) : (original as typeof fetch)(input, init),
    );

    const editor = openEditor(WALLS);
    fireEvent.change(within(editor).getByLabelText("Объём"), { target: { value: "240" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    fireEvent.click(recalcButton());

    expect(await screen.findByTestId("recalc-error")).toHaveTextContent("Цены обновились");
    expect(recalcButton()).toBeEnabled();
    expect(screen.getByTestId("edits-count")).toHaveTextContent("1 правка");
  });
});

describe("сохранение правок", () => {
  async function editWallsAndWaitForSave(): Promise<void> {
    const editor = openEditor(WALLS);
    fireEvent.change(within(editor).getByLabelText("Объём"), { target: { value: "240" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await waitFor(() => expect(server.puts.length).toBeGreaterThan(0), { timeout: 3000 });
  }

  it("правки пишутся за закупкой и восстанавливаются при следующем открытии вместе с пересчётом", async () => {
    await renderTable();
    await editWallsAndWaitForSave();

    expect(server.record?.tenderId).toBe("0123");
    expect(server.record?.baseJobId).toBe("job-1");
    expect(server.record?.edits).toHaveLength(1);
    cleanup();

    // Новое открытие: правки подгружены и уже применены, нажимать «Пересчитать» не нужно.
    render(<Harness />);
    await waitFor(() => expect(volume(WALLS)).toContain("240 м2"), { timeout: 3000 });
    expect(screen.getByTestId("edits-count")).toHaveTextContent("1 правка");
    expect(recalcButton()).toBeDisabled();
    expect(screen.getByTestId("totals-diff")).toBeInTheDocument();
  });

  it("гостю правки остаются на устройстве и восстанавливаются оттуда", async () => {
    server.guest = true;
    await renderTable();
    const editor = openEditor(WALLS);
    fireEvent.change(within(editor).getByLabelText("Объём"), { target: { value: "240" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await waitFor(() => expect(window.localStorage.getItem("tf.billEdits:0123")).not.toBeNull(), { timeout: 3000 });
    expect(screen.getByTestId("edits-count")).toHaveTextContent("сохранены на этом устройстве");
    cleanup();

    render(<Harness />);
    await waitFor(() => expect(volume(WALLS)).toContain("240 м2"), { timeout: 3000 });
  });

  it("сброс правок удаляет запись у закупки", async () => {
    await renderTable();
    await editWallsAndWaitForSave();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить все правки" }));
    await waitFor(() => expect(server.record).toBeNull(), { timeout: 3000 });
  });

  /** Правки, сохранённые к другому заданию расчёта. */
  function savedForOtherJob(signature: string): BillEditsRecord {
    const walls = built.bill.sections.flatMap((section) => section.items).find((item) => item.id === WALLS);
    if (walls === undefined) throw new Error("нет позиции");
    return {
      version: 1,
      tenderId: "0123",
      baseJobId: "job-old",
      billSignature: signature,
      updatedAt: "2026-10-08T10:00:00.000Z",
      edits: [
        {
          kind: "change",
          anchor: {
            itemId: "old-7",
            workName: walls.workName,
            quantity: walls.quantity,
            unit: walls.quantityUnit,
            positionNumber: null,
            normCode: null,
            section: null,
          },
          quantity: 240,
        },
      ],
    };
  }

  it("новая ведомость изменилась: «есть ваши правки к прошлой ведомости» — применить; правка находит строку по наименованию и объёму", async () => {
    server.record = savedForOtherJob("другая-ведомость");
    await renderTable({ jobId: "job-new" });

    const banner = await screen.findByTestId("edits-conflict");
    expect(banner).toHaveTextContent("Есть ваши правки к прошлой ведомости");
    // Пока человек не выбрал, правки не применяются и итог исходный.
    expect(volume(WALLS)).toContain("120 м2");
    expect(screen.getByTestId("edits-count")).toHaveTextContent("Правок нет");

    fireEvent.click(within(banner).getByRole("button", { name: "Применить" }));

    await waitFor(() => expect(volume(WALLS)).toContain("240 м2"), { timeout: 3000 });
    expect(screen.queryByTestId("edits-conflict")).toBeNull();
    // Запись переехала на новое задание.
    await waitFor(() => expect(server.record?.baseJobId).toBe("job-new"), { timeout: 3000 });
  });

  it("новая ведомость изменилась: «отбросить» — запись удалена, расчёт исходный", async () => {
    server.record = savedForOtherJob("другая-ведомость");
    await renderTable({ jobId: "job-new" });

    fireEvent.click(within(await screen.findByTestId("edits-conflict")).getByRole("button", { name: "Отбросить" }));

    await waitFor(() => expect(server.record).toBeNull(), { timeout: 3000 });
    expect(screen.queryByTestId("edits-conflict")).toBeNull();
    expect(volume(WALLS)).toContain("120 м2");
  });

  it("повторное извлечение дало ту же ведомость: правки переезжают молча, вопроса нет", async () => {
    server.record = savedForOtherJob(billSignature(built.bill.sections));
    await renderTable({ jobId: "job-new" });

    await waitFor(() => expect(volume(WALLS)).toContain("240 м2"), { timeout: 3000 });
    expect(screen.queryByTestId("edits-conflict")).toBeNull();
  });

  it("правки, не нашедшие свою строку, не теряются молча: сказано, сколько не применилось", async () => {
    const record = savedForOtherJob("другая-ведомость");
    const lost = {
      ...record.edits[0],
      anchor: { ...(record.edits[0] as { anchor: object }).anchor, itemId: "old-8", workName: "Работа, которой больше нет" },
    };
    server.record = { ...record, edits: [record.edits[0] as never, lost as never] };
    await renderTable({ jobId: "job-new" });

    const banner = await screen.findByTestId("edits-conflict");
    expect(banner).toHaveTextContent("не найдут: 1");
    fireEvent.click(within(banner).getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(screen.getByText(/не нашли свою строку: 1/u)).toBeInTheDocument(), { timeout: 3000 });
  });
});

describe("старые расчёты и раскладка", () => {
  it("смета без записи ведомости: таблицы нет, сказано, что править можно после нового расчёта", async () => {
    const { bill: _bill, ...old } = data();
    render(<Harness result={old} />);

    expect(screen.queryByTestId("bill-table")).toBeNull();
    expect(screen.getByTestId("edit-unavailable")).toHaveTextContent("после нового расчёта");
  });

  it("раскладка: одна разметка для всех ширин — карточки без горизонтального переполнения на 375 px, сетка только с md", async () => {
    await renderTable();

    const table = screen.getByRole("table", { name: "Позиции ведомости" });
    const rows = within(table).getAllByRole("row");
    // Никаких фиксированных ширин и min-width в пикселях: на 375 px нечему вылезти за карточку.
    const classes = [table, ...rows, ...Array.from(table.querySelectorAll("*"))].map((node) => node.getAttribute("class") ?? "").join(" ");
    expect(classes).not.toMatch(/(?:^|\s)(?:min-w-(?!0(?:\s|$))|w-\[\d+px\]|overflow-x-)/u);
    // Сетка из семи колонок включается только с ширины md; без неё строка — обычный блок (карточка).
    for (const item of rows.slice(1)) {
      expect(item.className).toContain("md:grid");
      expect(item.className).not.toMatch(/(?:^|\s)grid(?:\s|$)/u);
    }
    // Шапка таблицы на телефоне скрыта.
    expect(rows[0]?.className).toMatch(/(?:^|\s)hidden(?:\s|$)/u);
    // Длинные наименования переносятся, а не растягивают строку.
    expect(within(row(WALLS)).getByText("Демонтаж наружных стен").className).toContain("break-words");
  });
});

describe("пересчёт не вызывает модель", () => {
  it("за всю сессию правок нет ни одного запроса к извлечению ведомости", async () => {
    await renderTable();
    const editor = openEditor(WALLS);
    fireEvent.change(within(editor).getByLabelText("Объём"), { target: { value: "240" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Применить правку" }));
    await act(async () => {
      await Promise.resolve();
    });
    await recalc();

    const urls = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("bill-rows"))).toBe(false);
    expect(urls.filter((url) => url.startsWith("/api/estimate/recalc"))).toHaveLength(1);
  });
});

describe("строки, добавленные расчётом и ИИ", () => {
  /** Позиции ведомости помечены как добавленные: так их видит таблица (расчёт ничего не меняет, помечается только ведомость). */
  function markGenerated(): void {
    built = {
      ...built,
      bill: {
        ...built.bill,
        sections: built.bill.sections.map((section) => ({
          ...section,
          items: section.items.map((item) => {
            if (item.id === GRADING) return { ...item, generated: "AI_IMPLIED" as const, generatedNote: "добавлено ИИ: леса нужны на фасаде; объём = max(#1, #2) = 800 м2 (#1 — «Демонтаж» 800 м2)" };
            if (item.id === WEAK) return { ...item, generated: "DEBRIS" as const, generatedNote: "мусор по нормам: 1,2 т (ГЭСН 46-02-009-01 × 0,2)" };
            return item;
          }),
        })),
      },
    };
  }

  it("подпись «добавлено ИИ» и «добавлено расчётом (мусор)» с пояснением; у строки из документа подписи нет", async () => {
    markGenerated();
    await renderTable();

    expect(within(row(GRADING)).getByTestId("generated-badge")).toHaveTextContent("добавлено ИИ");
    expect(within(row(GRADING)).getByTestId("generated-note")).toHaveTextContent("добавлено ИИ: леса нужны на фасаде; объём = max(#1, #2) = 800 м2");
    expect(within(row(GRADING)).getByTestId("generated-note")).toHaveTextContent("«Изменить» → «Удалить строку»");
    expect(within(row(WEAK)).getByTestId("generated-badge")).toHaveTextContent("добавлено расчётом (мусор)");
    expect(within(row(WEAK)).getByTestId("generated-note")).toHaveTextContent("мусор по нормам: 1,2 т");
    expect(within(row(WALLS)).queryByTestId("generated-badge")).toBeNull();
  });

  it("добавленную строку удаляют тем же «Удалить строку»: она уходит в «Не вошло в расчёт» с кнопкой «Вернуть в расчёт»", async () => {
    markGenerated();
    await renderTable();

    const editor = openEditor(GRADING);
    fireEvent.click(within(editor).getByRole("button", { name: "Удалить строку" }));

    expect(screen.queryByTestId(`bill-row-${GRADING}`)).toBeNull();
    expect(screen.getByTestId(`removed-${GRADING}`)).toBeInTheDocument();
    expect(within(screen.getByTestId(`removed-${GRADING}`)).getByRole("button", { name: "Вернуть в расчёт" })).toBeInTheDocument();
  });
});
