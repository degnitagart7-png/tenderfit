import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EstimateResult } from "@/components/estimate/EstimateResult";
import { SsrAuditCard } from "@/components/estimate/SsrAuditCard";
import { SsrBlock } from "@/components/estimate/SsrBlock";
import { WorkConditionsBlock } from "@/components/estimate/WorkConditionsBlock";
import { buildEstimate } from "@/domain/estimate/calculate";
import { SSR_377_CSV, SSR_BAD } from "@/domain/estimate/customerSsr.fixtures";
import { NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { computeSsrLayer } from "@/domain/estimate/ssrLayer";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_DRAGLINE,
  BILL_GRADING,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";
import { ssrEstimate } from "@/test/ssrFixtures";

afterEach(cleanup);

const flat = (text: string | null | undefined): string => (text ?? "").replace(/[\s  ]/gu, " ");

const NMC = 2_032_153.32;
const DOCS = [{ name: "НМЦК_Возрождения 46 - ССРСС.xlsx", text: SSR_377_CSV }];
const OPTIONS: EstimateOptions = { ...NO_ESTIMATE_OPTIONS, workKind: "CR_FACADE", workPeriod: { start: "2026-10-01", end: "2026-11-30" } };

function layerFor(documents = DOCS, nmc: number | null = NMC) {
  return computeSsrLayer({
    estimate: ssrEstimate({ sections: [{ title: "Фасад", workCost: 1_623_390 }], temporaryPercent: 2, winterPercent: 3 }),
    options: OPTIONS,
    nmc,
    nmcIncludesVat: true,
    priceDate: "2026-10-01",
    today: "2026-10-09",
    documents,
  });
}

describe("карточка «Сводный расчёт и цена контракта»", () => {
  const layer = layerFor();

  it("заголовок: наша оценка НМЦК против НМЦК закупки с разницей в процентах", () => {
    render(<SsrBlock result={layer.ssr!} comparison={layer.comparison} audits={layer.audits} />);
    expect(screen.getByRole("heading", { name: "Сводный расчёт и цена контракта" })).toBeInTheDocument();
    const headline = flat(screen.getByTestId("ssr-headline").textContent);
    expect(headline).toMatch(/^Наша оценка НМЦК: [\d ]+ ₽ против НМЦК закупки 2 032 153 ₽ \(с НДС; разница [+−]?\d+,\d %\)$/u);
    expect(screen.getByTestId("ssr-diff").textContent).toContain("%");
  });

  it("расшифровка по строкам: локальные сметы, временные, зимнее, непредвиденные, инфляция, НДС; рядом — строки заказчика", () => {
    render(<SsrBlock result={layer.ssr!} comparison={layer.comparison} audits={layer.audits} />);
    for (const id of ["LOCAL", "TEMPORARY", "WINTER", "RESERVE", "INFLATION", "VAT"]) {
      expect(screen.getByTestId(`ssr-row-${id}`)).toBeInTheDocument();
    }
    const local = within(screen.getByTestId("ssr-row-LOCAL"));
    expect(flat(local.getByText("Локальные сметы").closest("tr")?.textContent)).toContain("1 623 390,00");
    expect(screen.getByText("У заказчика, ₽")).toBeInTheDocument();
    // У заказчика нет строк временных и зимнего — тире, а не ноль.
    expect(within(screen.getByTestId("ssr-row-TEMPORARY")).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(flat(screen.getByTestId("ssr-row-RESERVE").textContent)).toContain("32 514,40");
    expect(flat(screen.getByTestId("ssr-row-RESERVE").textContent)).toContain("п. 179");
    expect(flat(screen.getByTestId("ssr-row-INFLATION").textContent)).toContain("841/пр, п. 22-23");
  });

  it("без ССР заказчика колонок заказчика нет", () => {
    const own = layerFor([]);
    render(<SsrBlock result={own.ssr!} comparison={own.comparison} audits={own.audits} />);
    expect(screen.queryByText("У заказчика, ₽")).toBeNull();
  });

  it("главы и итоги — свёрнутый блок: двенадцать глав, итоги по группам, главы заказчика помечены", () => {
    render(<SsrBlock result={layer.ssr!} comparison={layer.comparison} />);
    const chapters = screen.getByTestId("ssr-chapters");
    expect(within(chapters).getByText("Итого по главам 1-7")).toBeInTheDocument();
    expect(within(chapters).getByText("Итого по главам 1-12")).toBeInTheDocument();
    expect(within(chapters).getByText("Глава 10. Служба заказчика, строительный контроль")).toBeInTheDocument();
    expect(within(chapters).getAllByText("не оценивалась").length).toBeGreaterThanOrEqual(4);
    expect(chapters.textContent).toContain("Главы 10-12 — затраты заказчика");
  });

  it("строка индекса: формула и период", () => {
    render(<SsrBlock result={layer.ssr!} comparison={layer.comparison} />);
    expect(flat(screen.getByTestId("ssr-inflation").textContent)).toContain("Индекс прогнозной инфляции 1,0047 за период октябрь 2026 — ноябрь 2026: (1,0000 + 1,0095) / 2 = 1,0047");
  });

  it("допущения, двигающие цену, видны сверху: без сроков — инфляция не применена", () => {
    const noTerm = computeSsrLayer({
      estimate: ssrEstimate({ sections: [{ title: "Фасад", workCost: 1_000_000 }] }),
      options: NO_ESTIMATE_OPTIONS,
      nmc: 1_300_000,
      nmcIncludesVat: true,
      priceDate: "2026-10-01",
      today: "2026-10-09",
      documents: [],
    });
    render(<SsrBlock result={noTerm.ssr!} comparison={noTerm.comparison} />);
    const list = screen.getByTestId("ssr-assumptions");
    expect(list.textContent).toContain("Прогнозная инфляция не применена");
    expect(list.textContent).toContain("назначение объекта не указано");
  });

  it("пустая смета: честное сообщение", () => {
    const empty = computeSsrLayer({
      estimate: ssrEstimate({ sections: [] }),
      options: NO_ESTIMATE_OPTIONS,
      nmc: null,
      nmcIncludesVat: true,
      priceDate: null,
      today: "2026-10-09",
      documents: [],
    });
    render(<SsrBlock result={empty.ssr!} comparison={null} />);
    expect(screen.getByTestId("ssr-block").textContent).toContain("Смета пуста");
  });
});

describe("аудит ССР заказчика на экране", () => {
  it("нет ССР в документах — карточки нет", () => {
    const { container } = render(<SsrAuditCard reports={layerFor([]).audits} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("ssr-audit")).toBeNull();
  });

  it("чистый расчёт: вывод «сходится», цифры заказчика, справка об индексе", () => {
    render(<SsrAuditCard reports={layerFor().audits} />);
    expect(screen.getByTestId("ssr-audit-conclusion").textContent).toContain("сходится");
    const figures = flat(screen.getByTestId("ssr-audit-figures").textContent);
    expect(figures).toContain("Непредвиденные: 2 %");
    expect(figures).toContain("Индекс инфляции: 1,0045 (октябрь-ноябрь 2026)");
    expect(figures).toContain("НДС: 22 %");
    expect(flat(screen.getByTestId("ssr-audit-findings").textContent)).toContain("Индекс прогнозной инфляции");
  });

  it("ошибочный расчёт: находки по типам, пункт приказа и деньги влияния", () => {
    const layer = layerFor([{ name: "ССРСС.xlsx", text: SSR_BAD }], 1_813_280.4);
    render(<SsrAuditCard reports={layer.audits} />);
    const findings = flat(screen.getByTestId("ssr-audit-findings").textContent);
    expect(screen.getByTestId("ssr-audit-conclusion").textContent).toContain("Замечаний:");
    for (const title of ["Итог главы против строк", "База резерва", "Индекс прогнозной инфляции", "Ставка НДС", "Затраты заказчика в цене контракта"]) {
      expect(findings).toContain(title);
    }
    expect(findings).toContain("НДС 20 % вместо 22 %");
    expect(findings).toMatch(/→ [+−][\d ]+ ₽/u);
    expect(findings).toContain("[841/пр, п. 21; 421/пр, п. 162, 170, 171]");
  });
});

/* ------------------------------ Блок «Условия работ» ------------------------------ */

let current: EstimateOptions = NO_ESTIMATE_OPTIONS;
function Harness({ text = "" }: { text?: string }) {
  const [options, setOptions] = useState<EstimateOptions>(NO_ESTIMATE_OPTIONS);
  current = options;
  return <WorkConditionsBlock options={options} onChange={setOptions} text={text} subject="Ремонт фасада" />;
}

describe("«Условия работ»: назначение объекта и сроки для сводного расчёта", () => {
  it("по умолчанию назначение — по виду работ, сроков нет: инфляция не применяется", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Назначение объекта")).toHaveValue("");
    expect(screen.getByLabelText("Как заданы сроки работ")).toHaveValue("");
    expect(screen.getByTestId("ssr-no-period").textContent).toContain("прогнозная инфляция не применяется");
    expect(current.ssr).toBeUndefined();
  });

  it("выбор назначения кладёт его в условия ССР", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Назначение объекта"), { target: { value: "PRODUCTION" } });
    expect(current.ssr?.purpose).toBe("PRODUCTION");
  });

  it("«работы с … по …» — даты попадают в общий срок работ", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Как заданы сроки работ"), { target: { value: "DATES" } });
    fireEvent.change(screen.getByLabelText("Работы с"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Работы по"), { target: { value: "2026-11-30" } });
    expect(current.workPeriod).toEqual({ start: "2026-10-01", end: "2026-11-30" });
    expect(screen.queryByTestId("ssr-no-period")).toBeNull();
  });

  it("«в течение N месяцев с даты контракта»", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Как заданы сроки работ"), { target: { value: "MONTHS" } });
    fireEvent.change(screen.getByLabelText("Срок работ, месяцев"), { target: { value: "2" } });
    expect(current.ssr).toMatchObject({ periodMode: "MONTHS", months: 2 });
    expect(screen.queryByTestId("ssr-no-period")).toBeNull();
  });

  it("подсказка по тексту ТЗ: «с момента заключения Контракта по 30 ноября 2026» — сама не применяется, кнопка применяет", () => {
    render(<Harness text="1.5. Срок выполнения работы: с момента заключения Контракта по 30 ноября 2026 г. (включительно)." />);
    const hint = screen.getByTestId("term-hint");
    expect(hint.textContent).toContain("В ТЗ сказано");
    expect(hint.textContent).toContain("работы с даты контракта по 2026-11-30");
    expect(current.ssr).toBeUndefined();
    fireEvent.click(within(hint).getByRole("button", { name: "Применить" }));
    expect(current.ssr).toMatchObject({ periodMode: "UNTIL", until: "2026-11-30" });
    expect(screen.queryByTestId("term-hint")).toBeNull();
  });

  it("«Сбросить всё» снимает и условия ССР", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Назначение объекта"), { target: { value: "UNIQUE" } });
    fireEvent.click(screen.getByRole("button", { name: "Сбросить всё" }));
    expect(current.ssr).toBeUndefined();
  });
});

/* ------------------------------ Карточка расчёта ------------------------------ */

const SECTION = makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE]);
const DOCUMENT = buildEstimate({
  title: "Реконструкция запорных колодцев",
  sections: [SECTION],
  priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE)),
  parameters: makeParameters(),
  resolveNorm: makeResolver([NORM_MANUAL_GRADING, NORM_DRAGLINE_15]),
  sources: [],
  generatedAt: "2026-09-28T00:00:00.000Z",
  disclaimer: "Информационно-аналитическая справка",
});
const DATA = { document: DOCUMENT, rejected: [], documentsWithoutBill: [], billItems: 2 };
const BID = { nmc: 1_000_000, taxSystem: "OSNO" as const, minMarginPercent: 10 };

describe("карточка расчёта со сводным расчётом", () => {
  const layer = computeSsrLayer({
    estimate: DOCUMENT,
    options: OPTIONS,
    nmc: BID.nmc,
    nmcIncludesVat: true,
    priceDate: "2026-10-01",
    today: "2026-10-09",
    documents: [],
  });

  it("блок «Сводный расчёт и цена контракта» стоит над ценой участия, цена участия сравнивает с нашей оценкой НМЦК", () => {
    render(<EstimateResult data={DATA} regNumber="1" bid={BID} ssr={{ result: layer.ssr!, comparison: layer.comparison, audits: layer.audits }} />);
    const block = screen.getByTestId("ssr-block");
    const price = screen.getByLabelText("Цена участия");
    expect(block.compareDocumentPosition(price) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(flat(price.textContent)).toContain("от нашей оценки НМЦК");
    expect(flat(price.textContent)).toContain("деньги заказчика на риск");
  });

  it("без ССР карточка прежняя: блока нет, сравнение «от расчёта»", () => {
    render(<EstimateResult data={DATA} regNumber="1" bid={BID} />);
    expect(screen.queryByTestId("ssr-block")).toBeNull();
    expect(flat(screen.getByLabelText("Цена участия").textContent)).toContain("от расчёта");
  });

  it("итог СМР в шапке не меняется от ССР", () => {
    const view = render(<EstimateResult data={DATA} regNumber="1" bid={BID} />);
    const without = view.container.textContent;
    view.unmount();
    const withSsr = render(<EstimateResult data={DATA} regNumber="1" bid={BID} ssr={{ result: layer.ssr!, comparison: layer.comparison }} />);
    expect(withSsr.container.textContent).toContain(DOCUMENT.totals.workCost.toLocaleString("ru-RU"));
    expect(without).toContain(DOCUMENT.totals.workCost.toLocaleString("ru-RU"));
  });
});
