import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TenderRow } from "@/domain/filtering";
import { defaultFilters, filterRows } from "@/domain/filtering";
import type { FreshnessLayer } from "@/domain/lastSearch";
import {
  TenderTable,
  type FreshnessCell,
  type RowSearchInfo,
} from "@/components/tenders/TenderTable";
import { documentOnlyMatchLabel } from "@/lib/labels";
import { demoTenders } from "@/mocks/tenders";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { formatDateTime } from "@/utils/format";

function buildRows(): TenderRow[] {
  return demoTenders.slice(0, 10).map((tender) => ({
    tender,
    analysis: analyzeTender(tender, demoCompanyProfile),
    pipelineStatus: "NEW" as const,
  }));
}

function searchInfo(patch: Partial<RowSearchInfo> = {}): RowSearchInfo {
  return { snippet: null, priority: 0, relevanceScore: 0, reasons: [], documentOnly: false, ...patch };
}

function infoMap(rows: TenderRow[], patch: Partial<RowSearchInfo> = {}): Map<string, RowSearchInfo> {
  return new Map(rows.map((row) => [row.tender.id, searchInfo(patch)]));
}

describe("TenderTable", () => {
  const rows = buildRows();

  it("рендерит строки закупок", () => {
    render(
      <TenderTable rows={rows} sortField="fitScore" sortDir="desc" onSort={() => {}} />,
    );
    expect(screen.getByText(rows[0]!.tender.subject)).toBeTruthy();
    expect(screen.getAllByRole("row").length).toBe(rows.length + 1); // + шапка
  });

  it("таблица меняется после фильтрации: остаются только строки 44-ФЗ", () => {
    const filtered = filterRows(rows, { ...defaultFilters, laws: ["FZ_44"] });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(rows.length);

    const { rerender } = render(
      <TenderTable rows={rows} sortField="fitScore" sortDir="desc" onSort={() => {}} />,
    );
    expect(screen.getAllByRole("row").length).toBe(rows.length + 1);

    rerender(
      <TenderTable rows={filtered} sortField="fitScore" sortDir="desc" onSort={() => {}} />,
    );
    expect(screen.getAllByRole("row").length).toBe(filtered.length + 1);

    const excluded = rows.filter((r) => !filtered.includes(r));
    for (const r of excluded) {
      expect(screen.queryByText(r.tender.subject)).toBeNull();
    }
  });

  it("показывает пустое тело таблицы без строк", () => {
    render(<TenderTable rows={[]} sortField="fitScore" sortDir="desc" onSort={() => {}} />);
    expect(screen.getAllByRole("row").length).toBe(1); // только шапка
  });
});

describe("TenderTable: результаты поиска", () => {
  const rows = buildRows();
  const first = rows.slice(0, 1);

  it("без результатов поиска колонки релевантности нет", () => {
    render(
      <TenderTable rows={rows} sortField="fitScore" sortDir="desc" onSort={() => {}} />,
    );
    expect(screen.queryByRole("columnheader", { name: /Приоритет/ })).toBeNull();
  });

  it("сплошные нули совпадения колонку не добавляют", () => {
    // Колонка нулей не объясняет порядок выдачи, а путает: если совпадений
    // нет, запроса не было, и сравнивать строки нечем.
    render(
      <TenderTable
        rows={rows}
        sortField="fitScore"
        sortDir="desc"
        onSort={() => {}}
        searchInfo={infoMap(rows)}
      />,
    );
    expect(screen.queryByRole("columnheader", { name: /Приоритет/ })).toBeNull();
  });

  it("показывает приоритет, главную причину и сниппет", () => {
    const info = infoMap(first, {
      priority: 69,
      relevanceScore: 58,
      reasons: ["Совпадение в названии: вентиль", "Совпадение в документации"],
      snippet: "…поставка вентилей 15Б1БК в комплекте…",
    });
    render(
      <TenderTable
        rows={first}
        sortField="relevance"
        sortDir="desc"
        onSort={() => {}}
        searchInfo={info}
      />,
    );
    expect(screen.getByRole("columnheader", { name: /Приоритет/ })).toBeTruthy();
    expect(screen.getByText("69")).toBeTruthy();
    // Главная причина видна без наведения: она отвечает на вопрос
    // «почему эта закупка в выдаче».
    expect(screen.getByText("Совпадение в названии: вентиль")).toBeTruthy();
    expect(screen.getByText("…поставка вентилей 15Б1БК в комплекте…")).toBeTruthy();
  });

  it("совпадение только в документации помечено отдельно", () => {
    render(
      <TenderTable
        rows={first}
        sortField="relevance"
        sortDir="desc"
        onSort={() => {}}
        searchInfo={infoMap(first, { relevanceScore: 22, documentOnly: true })}
      />,
    );
    expect(screen.getByText(documentOnlyMatchLabel)).toBeTruthy();
  });

  it("цена в валюте не выдаётся за рубли", () => {
    const base = first[0]!;
    const tender = {
      ...base.tender,
      financial: { ...base.tender.financial, price: 1_000, currency: "CNY" },
    };
    render(
      <TenderTable
        rows={[{ ...base, tender }]}
        sortField="fitScore"
        sortDir="desc"
        onSort={() => {}}
      />,
    );
    const cell = screen.getByText(/1\s000/);
    expect(cell.textContent).toContain("¥");
    expect(cell.textContent).not.toContain("₽");
  });

  it("неопубликованная цена показана с пояснением, а не нулём", () => {
    const base = first[0]!;
    const tender = {
      ...base.tender,
      financial: { ...base.tender.financial, price: 0 },
    };
    render(
      <TenderTable
        rows={[{ ...base, tender }]}
        sortField="fitScore"
        sortDir="desc"
        onSort={() => {}}
      />,
    );
    const cell = screen.getByTitle(
      "Площадка не опубликовала цену: запросы цен и запросы предложений публикуются без НМЦ",
    );
    expect(cell.textContent).toBe("Не указана");
  });
});

describe("TenderTable: слои свежести", () => {
  const rows = buildRows();
  const STAMP = "2026-09-25T14:52:03.000Z";

  /** Подписи слоёв для первых строк выдачи: слой и число закупок в нём. */
  function cells(spec: [FreshnessLayer, number][]): Map<string, FreshnessCell> {
    return new Map(
      spec.map(([layer, total], i) => [
        rows[i]!.tender.id,
        {
          layer,
          total,
          stamp: layer === "LAST_RUN" ? STAMP : null,
        },
      ]),
    );
  }

  function renderTable(count: number, info?: Map<string, FreshnessCell>) {
    return render(
      <TenderTable
        rows={rows.slice(0, count)}
        sortField={info === undefined ? "fitScore" : "freshness"}
        sortDir="desc"
        onSort={() => {}}
        freshnessInfo={info}
      />,
    );
  }

  it("разделитель стоит над первой строкой слоя и только над ней", () => {
    renderTable(3, cells([["LAST_RUN", 1], ["WEEK", 2], ["WEEK", 2]]));

    expect(screen.getByText(/Новые · платный поиск/)).toBeTruthy();
    expect(screen.getByText(/На этой неделе/)).toBeTruthy();
    expect(screen.queryByText(/Раньше/)).toBeNull();
    // 3 строки + шапка + 2 разделителя.
    expect(screen.getAllByRole("row")).toHaveLength(6);
  });

  it("у слоя последнего поиска видны время прогона и число закупок", () => {
    renderTable(1, cells([["LAST_RUN", 1]]));

    const text = (screen.getByText(/Новые · платный поиск/).textContent ?? "").replace(
      /\s+/g,
      " ",
    );
    expect(text).toContain(formatDateTime(STAMP));
    expect(text).toContain("1 закупка");
  });

  it("истёкший срок назван своим слоем", () => {
    renderTable(1, cells([["EXPIRED", 1]]));

    expect(screen.getByText(/Срок подачи истёк/)).toBeTruthy();
  });

  it("без порядка по свежести разделителей нет", () => {
    renderTable(rows.length);

    expect(screen.queryByText(/Новые · платный поиск/)).toBeNull();
    expect(screen.queryByText(/На этой неделе/)).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(rows.length + 1);
  });
});

describe("TenderTable: ключевые условия в строке", () => {
  const base = buildRows()[0]!;

  function renderOne(tender: TenderRow["tender"]) {
    render(
      <TenderTable
        rows={[{ ...base, tender }]}
        sortField="fitScore"
        sortDir="desc"
        onSort={() => {}}
      />,
    );
  }

  it("печатает обратный отсчёт до окончания подачи", () => {
    const submissionEnd = new Date(Date.now() + 5 * 24 * 3600_000 + 3600_000).toISOString();
    renderOne({ ...base.tender, deadlines: { ...base.tender.deadlines, submissionEnd } });
    expect(screen.getByTestId("deadline-countdown").textContent).toBe("ещё 5 дней");
  });

  it("показывает обеспечение и аванс под ценой, только известные", () => {
    renderOne({
      ...base.tender,
      financial: {
        ...base.tender.financial,
        currency: "RUB",
        bidSecurityPercent: 1,
        contractSecurityPercent: null,
        contractSecurityAmount: null,
        advancePercent: 30,
      },
    });
    const terms = screen.getByTestId("money-terms").textContent;
    expect(terms).toContain("Заявка1%");
    expect(terms).toContain("Аванс30%");
    expect(terms).not.toContain("Контракт");
  });

  it("подсвечивает ограничение «Только СМП»", () => {
    renderOne({ ...base.tender, onlyForSmp: true });
    expect(screen.getByText("Только СМП").getAttribute("title")).toMatch(/малого/);
  });
});

describe("TenderTable: колонки", () => {
  const rows = buildRows();

  function renderTable(onSort: (field: string) => void = () => {}, subset = rows) {
    return render(
      <TenderTable
        rows={subset}
        sortField="fitScore"
        sortDir="desc"
        onSort={onSort as never}
      />,
    );
  }

  it("колонки «Главный риск» нет, как и текста риска в ячейках", () => {
    renderTable();

    expect(screen.queryByRole("columnheader", { name: /Главный риск/i })).toBeNull();
    expect(screen.queryByText(/Главный риск/i)).toBeNull();
  });

  it("вердикт и соответствие — одна колонка «Оценка», последняя в таблице", () => {
    renderTable();
    const headers = screen.getAllByRole("columnheader");

    expect(headers.at(-1)?.textContent).toMatch(/Оценка/);
    expect(screen.queryByRole("columnheader", { name: /^Вердикт/ })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /^Fit/ })).toBeNull();
    // Ни одна другая колонка не называется «Оценка».
    expect(headers.filter((h) => /Оценка/.test(h.textContent ?? ""))).toHaveLength(1);
  });

  it("ячейка оценки — последняя в строке: короткий вердикт, число и полное название в подсказке", () => {
    renderTable(() => {}, rows.slice(0, 1));
    const row = screen.getAllByRole("row")[1]!;
    const cells = within(row).getAllByRole("cell");
    const last = cells.at(-1)!;
    const analysis = rows[0]!.analysis;

    expect(last.textContent).toContain(String(analysis.fitScore));
    expect(last.getAttribute("title")).toContain("соответствие профилю компании");
    // Короткая подпись вместо полной: полное название лишь в подсказке.
    expect(last.textContent).not.toContain("Можно участвовать");
    expect(last.textContent).not.toContain("Нужно посмотреть");
  });

  it("сортировка по оценке вызывает onSort(\"fitScore\")", () => {
    const onSort = vi.fn();
    renderTable(onSort);

    fireEvent.click(screen.getByRole("button", { name: "Сортировать по оценке" }));

    expect(onSort).toHaveBeenCalledWith("fitScore");
  });

  it("колонка статуса — только статус воронки, без даты анализа", () => {
    renderTable(() => {}, rows.slice(0, 1));
    const row = screen.getAllByRole("row")[1]!;
    const cells = within(row).getAllByRole("cell");
    const status = cells.at(-2)!;

    expect(status.textContent).toBe("Новые");
    expect(status.textContent).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it("срочная риска стоит на первой ячейке строки, а не на оценке", () => {
    const base = rows[0]!;
    const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
    const urgent: TenderRow = {
      ...base,
      tender: { ...base.tender, deadlines: { ...base.tender.deadlines, submissionEnd: soon } },
    };
    renderTable(() => {}, [urgent]);
    const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");

    expect(cells[0]!.querySelector("span.bg-accent")).not.toBeNull();
    expect(cells.at(-1)!.querySelector("span.bg-accent")).toBeNull();
  });
});
