import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { CustomerAuditCard } from "@/components/estimate/CustomerAuditCard";
import { EstimateMethodSelect } from "@/components/estimate/EstimateMethodSelect";
import { EstimateResult } from "@/components/estimate/EstimateResult";
import { NormPicker } from "@/components/estimate/NormPicker";
import { auditCustomerBim } from "@/domain/estimate/customerBimAudit";
import { hasEstimateOptions, NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { buildBimEstimate } from "@/domain/estimate/calculateBim";
import { bundledBimIndexBook } from "@/domain/estimate/bimIndices";
import { selectBimIndices } from "@/domain/estimate/calculateBim";
import { ferLookupOf } from "@/repositories/bimRepository";
import { auditData } from "@/test/auditReports";
import { BELGOROD, CONTEXT, estimate, position } from "@/test/bimAuditFixtures";
import { EARTH, OVERHEAD_RATES, makeFerBase } from "@/test/bimFixtures";
import { makeBillItem, makeParameters } from "@/test/estimateFixtures";

/*
  Интерфейс БИМ: переключатель метода (по умолчанию «как у заказчика»), карточка аудита сметы БИМ, метка метода в результате расчёта
  и поиск расценки ФЕР при правке ведомости.
*/

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flat = (text: string | null | undefined): string => (text ?? "").replace(/\s/g, " ");

let current: EstimateOptions = NO_ESTIMATE_OPTIONS;
function Harness({ text = "" }: { text?: string }) {
  const [options, setOptions] = useState<EstimateOptions>(NO_ESTIMATE_OPTIONS);
  current = options;
  return <EstimateMethodSelect options={options} onChange={setOptions} text={text} />;
}

describe("переключатель метода расчёта", () => {
  it("по умолчанию «как у заказчика»: ничего не выбрано, воркеру передавать нечего", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Метод расчёта")).toHaveValue("");
    expect(hasEstimateOptions(current)).toBe(false);
    expect(screen.getByTestId("estimate-method-hint")).toHaveTextContent("Документация о методе заказчика не говорит — будет ресурсно-индексный");
  });

  it("подсказка по тексту документации: назван базисно-индексный метод — по умолчанию БИМ", () => {
    render(<Harness text="Стоимость определяется базисно-индексным методом" />);
    const hint = flat(screen.getByTestId("estimate-method-hint").textContent);
    expect(hint).toContain("По документации: базисно-индексный (ФЕР-2001 × индексы)");
    expect(hint).toContain("ТЕР региона в открытых данных нет — считается по ФЕР");
  });

  it("выбор вручную уходит в options.method; «как у заказчика» возвращает null", () => {
    render(<Harness text="ресурсно-индексный метод" />);
    fireEvent.change(screen.getByLabelText("Метод расчёта"), { target: { value: "BASE_INDEX" } });
    expect(current.method).toBe("BASE_INDEX");
    expect(hasEstimateOptions(current)).toBe(true);
    expect(screen.getByTestId("estimate-method-hint")).toHaveTextContent("Метод выбран вручную: базисно-индексный");
    fireEvent.change(screen.getByLabelText("Метод расчёта"), { target: { value: "" } });
    expect(current.method).toBeNull();
    expect(hasEstimateOptions(current)).toBe(false);
  });
});

describe("аудит сметы БИМ в карточке", () => {
  const report = auditCustomerBim(estimate({ positions: [position({ index: { ...BELGOROD, labour: 45 } })] }), CONTEXT);

  it("шапка называет метод, ФЕР-2020 и квартал; вывод и «откуда разница» — те же слова, что у ресурсной сметы", () => {
    render(<CustomerAuditCard audit={auditData([report])} />);
    const zone = flat(screen.getByTestId("audit-zone").textContent);
    expect(zone).toContain("базисно-индексному методу");
    expect(zone).toContain("по ФЕР-2020 и индексам Минстроя (Белгородская область, III кв. 2026)");
    expect(flat(screen.getByTestId("audit-verdict-headline").textContent)).toContain("Смета заказчика занижена на 13 674 ₽");
    expect(screen.getByTestId("audit-zone").textContent).not.toContain("Республика Бурятия");
    const lines = within(screen.getByTestId("audit-breakdown")).getAllByRole("listitem").map((item) => flat(item.textContent));
    expect(lines.some((line) => line.startsWith("Труд (с НР и СП на него): +"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Из них индексы (письмо Минстроя): +"))).toBe(true);
  });

  it("находка по индексу — текстом задания, плюс что проверено: объект, базисные цены, НР и СП", () => {
    render(<CustomerAuditCard audit={auditData([report])} />);
    const details = flat(screen.getByTestId("audit-bim-details").textContent);
    expect(details).toContain("Заказчик применил индекс к ОЗП 45,00");
    expect(details).toContain("для Белгородская область, Многоквартирные жилые дома: Кирпичные — 47,58: занижено на");
    expect(details).toContain("Объект строительства по наименованию стройки: Многоквартирные жилые дома: Кирпичные");
    expect(details).toContain("сверено с ФЕР-2020 1 (совпало 1, расходится 0)");
  });

  it("все находки — в раскрывающемся списке, находка по индексу под заголовком «Индексы пересчёта»", () => {
    render(<CustomerAuditCard audit={auditData([report])} />);
    expect(screen.getByText(/Индексы пересчёта \(письмо Минстроя\): 1/)).toBeTruthy();
  });

  it("смета БИМ без ФЕР-2020 на сервере: нераспознанная строка не говорит «не форма 421/пр»", () => {
    render(
      <CustomerAuditCard
        audit={auditData([report], {
          notRecognized: [{ documentName: "ЛС.xlsx", estimateName: "ЛС-2", reason: "смета по базисно-индексному методу, но ФЕР-2020 не собраны" }],
        })}
      />,
    );
    expect(screen.getByText("Смета «ЛС-2» — построчно не проверена (смета по базисно-индексному методу, но ФЕР-2020 не собраны)")).toBeTruthy();
  });
});

describe("результат расчёта БИМ", () => {
  const selection = selectBimIndices(bundledBimIndexBook(), { subject: "Белгородская область", text: "Капитальный ремонт кирпичного многоквартирного дома" });
  if (!selection.ok) throw new Error(selection.reason);
  const earth = makeBillItem({ id: "a", workName: "Разработка грунта", quantity: 2, quantityUnit: "1000 м3", unitDivisor: 1, normCode: EARTH.code, normBaseType: "ФЕР" });
  const document = (customerBase: "FER" | "TER") =>
    buildBimEstimate({
      title: "Капитальный ремонт",
      sections: [{ title: "Раздел", items: [earth] }],
      resolveRate: () => ({ rate: EARTH, reasons: [] }),
      fer: ferLookupOf(makeFerBase()),
      selection: selection.selection,
      overheadRates: OVERHEAD_RATES,
      parameters: makeParameters(),
      sources: [],
      generatedAt: "2026-10-09T00:00:00.000Z",
      disclaimer: "оговорка",
      region: "Белгородская область",
      priceZone: "Белгородская область",
      baseEdition: "ФСНБ-2020",
      method: { basis: "CUSTOMER", note: "смета заказчика на ФЕР", customerBase },
    });

  it("метка метода, индексы письма и объект — рядом с ценами; ресурсная смета подписана своим методом", () => {
    render(<EstimateResult regNumber="1" data={{ document: document("FER"), rejected: [], documentsWithoutBill: [], billItems: 1 }} />);
    const note = flat(screen.getByTestId("estimate-method-note").textContent);
    expect(note).toContain("Метод: базисно-индексный (ФЕР-2001 × индексы) — как у заказчика (смета заказчика на ФЕР)");
    expect(note).toContain("ОЗП 47,58, ЭМ 15,15, материалы 9,58");
    expect(note).toContain("Многоквартирные жилые дома: Кирпичные");
    expect(note).not.toContain("недоступны в открытых данных");
    expect(screen.getByTestId("price-level").textContent).toContain("III кв. 2026 (индексы Минстроя)");
  });

  it("заказчик на ТЕР региона: оговорка про ФЕР написана дословно", () => {
    render(<EstimateResult regNumber="1" data={{ document: document("TER"), rejected: [], documentsWithoutBill: [], billItems: 1 }} />);
    expect(flat(screen.getByTestId("estimate-method-note").textContent)).toContain(
      "ТЕР Белгородская область недоступны в открытых данных — посчитано по ФЕР с индексами к ФЕР; возможна разница",
    );
  });
});

describe("поиск расценки при правке ведомости", () => {
  it("в БИМ-режиме запрос идёт в поиск ФЕР-2020 (method=BASE_INDEX), в ресурсном — без параметра", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], note: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const bim = render(<NormPicker method="BASE_INDEX" onPick={() => undefined} />);
      expect(screen.getByLabelText("Найти расценку ФЕР по шифру или словам")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Найти расценку ФЕР по шифру или словам"), { target: { value: "ФЕР 01-01-001-01" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("method=BASE_INDEX");
      bim.unmount();

      render(<NormPicker onPick={() => undefined} />);
      fireEvent.change(screen.getByLabelText("Найти норму по шифру или словам"), { target: { value: "ГЭСН 01-01-001-01" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(String((fetchMock.mock.calls[1] as unknown[])[0])).not.toContain("method=");
    } finally {
      vi.useRealTimers();
    }
  });
});
