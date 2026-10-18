import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { lsrDocument, type PositionSpec } from "@/domain/estimate/customerLsr.builders";
import { REAL_A_WITH_TOTALS, REAL_SUPPLY_CABLES } from "@/domain/estimate/customerLsr.fixtures";
import { bundledBimIndexBook } from "@/domain/estimate/bimIndices";
import { FerBaseUnavailableError } from "@/repositories/bimRepository";
import { CustomerAuditUnavailableError, runCustomerAudit, type AuditZone } from "@/services/customerAuditService";
import { makeBook } from "@/test/auditPriceBook";

/*
  Аудит — это код, а не модель: разбор сметы и переоценка по ценам зоны. Тесты
  проверяют, что сервис не обращается к сети (за ответом модели ходят через fetch к
  проду) и что воркер выходит из ветки аудита до вызова сметного конвейера.
*/

const ZONE: AuditZone = {
  priceZoneId: 236,
  zoneName: "Республика Бурятия (5 зона)",
  basis: "USER",
  matched: null,
  northZone: "TERRITORY",
};

/** Смета без строки нумерации граф: по форме 421/пр построчно её не прочитать. */
const FOREIGN = [
  "=== Чужая форма ===",
  "Составлен(а) в текущем уровне цен ,,01.04.2026",
  "№ п/п,Обоснование,Наименование,Ед. изм.,Количество,Цена,Стоимость",
  "1,ГЭСН01-01-001-01,Разработка грунта,100 м3,1,1000,1000",
  "ВСЕГО по смете,,,,,,1000",
].join("\n");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runCustomerAudit", () => {
  it("разбирает смету, переоценивает по книге зоны и ничего не просит у сети", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("аудит не должен ходить в сеть");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const loadPriceBook = vi.fn(async () => makeBook());
    const loadAuditPrices = vi.fn(async () => null);

    const result = await runCustomerAudit([{ name: "ЛСР.xlsx", text: REAL_A_WITH_TOTALS }], ZONE, { loadPriceBook, loadAuditPrices });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadPriceBook).toHaveBeenCalledWith(236, "TERRITORY");
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]!.customerTotal).toBe(17055.47);
    expect(result.period).toBe("2 квартал 2026 г.");
    expect(result.zone).toBe(ZONE);
    expect(result.notRecognized).toEqual([]);
  });

  it("все цены сплит-формы зоны передаются в аудит: кабель, которого нет в основной книге, переоценивается", async () => {
    const loadAuditPrices = vi.fn(async () => new Map([["21.1.07.05-0116", { price: 5580023.18, unit: "1000 м", indexed: true }]]));
    const result = await runCustomerAudit([{ name: "ЛСР.xlsx", text: REAL_SUPPLY_CABLES }], ZONE, {
      loadPriceBook: async () => makeBook({ current: [] }),
      loadAuditPrices,
    });

    expect(loadAuditPrices).toHaveBeenCalledWith(236);
    expect(result.reports[0]!.findings.find((finding) => finding.type === "RESOURCE_PRICE")).toMatchObject({ subject: "21.1.07.05-0116", ourSource: "INDEXED" });
  });

  it("файла «все цены» нет (старая сборка зоны) — аудит идёт по основной книге, без ошибки", async () => {
    const result = await runCustomerAudit([{ name: "ЛСР.xlsx", text: REAL_SUPPLY_CABLES }], ZONE, {
      loadPriceBook: async () => makeBook({ current: [] }),
      loadAuditPrices: async () => null,
    });
    expect(result.reports[0]!.unchecked.some((item) => item.kind === "OUR_PRICE_MISSING")).toBe(true);
  });

  it("несколько смет в документах — отчёт на каждую, нераспознанные названы отдельно", async () => {
    const second = lsrDocument({ positions: [baseSpec()], name: "Вторая смета" });
    const foreign = FOREIGN;
    const result = await runCustomerAudit(
      [
        { name: "ЛСР.xlsx", text: `${REAL_A_WITH_TOTALS}\n${second}` },
        { name: "чужая.xlsx", text: foreign },
      ],
      ZONE,
      { loadPriceBook: async () => makeBook(), loadAuditPrices: async () => null },
    );
    expect(result.reports).toHaveLength(2);
    expect(result.notRecognized.map((item) => item.documentName)).toEqual(["чужая.xlsx"]);
  });

  it("сметы в документах нет — понятная ошибка, а книга цен не грузится", async () => {
    const loadPriceBook = vi.fn(async () => makeBook());
    const loadAuditPrices = vi.fn(async () => null);
    await expect(runCustomerAudit([{ name: "положение.docx", text: "Текст без таблиц" }], ZONE, { loadPriceBook, loadAuditPrices })).rejects.toThrow(
      CustomerAuditUnavailableError,
    );
    await expect(runCustomerAudit([{ name: "положение.docx", text: "Текст без таблиц" }], ZONE, { loadPriceBook, loadAuditPrices })).rejects.toThrow(
      "локальная смета заказчика",
    );
    expect(loadPriceBook).not.toHaveBeenCalled();
  });

  it("смета не по форме 421/пр — ошибка называет причину, по которой она не подошла", async () => {
    const foreign = FOREIGN;
    await expect(runCustomerAudit([{ name: "чужая.xlsx", text: foreign }], ZONE, { loadPriceBook: async () => makeBook(), loadAuditPrices: async () => null })).rejects.toThrow(
      /нет строки нумерации граф 1–12/,
    );
  });
});

describe("runCustomerAudit: базисно-индексный метод", () => {
  const fixture = (name: string): string => readFileSync(join(process.cwd(), "src", "domain", "estimate", "__fixtures__", "bim", name), "utf8");
  // ФЕР-2020 подставлены пустыми: расценок «нет в базе», но маршрутизация, отчёт и итоги от этого не зависят.
  const bimDeps = {
    loadFer: async () => ({ rate: () => null, material: () => null, transport: () => null }),
    loadBimIndices: bundledBimIndexBook,
    loadOverheadRates: async () => new Map(),
  };

  it("смета БИМ (таблица Гранд-Сметы) читается как БИМ: отчёт есть, «не форма 421/пр» про неё не говорится, книга цен зоны не грузится", async () => {
    const loadPriceBook = vi.fn(async () => makeBook());
    const result = await runCustomerAudit([{ name: "ЛС.xlsx", text: fixture("grid-nnk-dop.txt") }], ZONE, { ...bimDeps, loadPriceBook });
    expect(loadPriceBook).not.toHaveBeenCalled();
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ method: "BASE_INDEX", customerTotal: 3252 });
    expect(result.notRecognized).toEqual([]);
    expect(result.period).toBe("базисные цены 01.01.2000");
  });

  it("субъект и зона берутся из названия ценовой зоны закупки, когда смета их не называет", async () => {
    const result = await runCustomerAudit([{ name: "ЛС.xlsx", text: fixture("grid-nnk-dop.txt") }], ZONE, bimDeps);
    expect(result.reports[0]?.bim).toMatchObject({ subject: "Республика Бурятия", zone: 5, subjectSource: "ZONE" });
  });

  it("поток PDF: две сметы БИМ — два отчёта", async () => {
    const result = await runCustomerAudit([{ name: "СД.txt", text: fixture("stream-tyumen.txt") }], ZONE, bimDeps);
    expect(result.reports.map((report) => report.method)).toEqual(["BASE_INDEX", "BASE_INDEX"]);
    expect(result.reports[0]?.bim?.subject).toBe("Тюменская область");
  });

  it("смета ресурсного метода и смета БИМ в одной закупке: отчёты обоих, у каждого свой метод", async () => {
    const result = await runCustomerAudit(
      [
        { name: "ЛСР.xlsx", text: REAL_A_WITH_TOTALS },
        { name: "ЛС.xlsx", text: fixture("grid-nnk-dop.txt") },
      ],
      ZONE,
      { ...bimDeps, loadPriceBook: async () => makeBook(), loadAuditPrices: async () => null },
    );
    expect(result.reports.map((report) => report.method ?? "RESOURCE_INDEX")).toEqual(["RESOURCE_INDEX", "BASE_INDEX"]);
    expect(result.period).toBe("2 квартал 2026 г.");
    expect(result.notRecognized).toEqual([]);
  });

  it("ФЕР-2020 на сервере не собраны: смета БИМ — в нераспознанных с командой сборки, остальные сметы проверяются", async () => {
    const loadFer = async (): Promise<never> => {
      throw new FerBaseUnavailableError("ФЕР-2020 не собраны: соберите командой npx tsx scripts/fsnb/build-fer2020.ts", "/data");
    };
    const result = await runCustomerAudit(
      [
        { name: "ЛСР.xlsx", text: REAL_A_WITH_TOTALS },
        { name: "ЛС.xlsx", text: fixture("grid-nnk-dop.txt") },
      ],
      ZONE,
      { ...bimDeps, loadFer, loadPriceBook: async () => makeBook(), loadAuditPrices: async () => null },
    );
    expect(result.reports).toHaveLength(1);
    expect(result.notRecognized).toHaveLength(1);
    expect(result.notRecognized[0]?.reason).toMatch(/базисно-индексному методу.*build-fer2020\.ts/);
  });

  it("только смета БИМ и нет ФЕР-2020: ошибка с причиной и командой сборки", async () => {
    const loadFer = async (): Promise<never> => {
      throw new FerBaseUnavailableError("ФЕР-2020 не собраны: соберите командой npx tsx scripts/fsnb/build-fer2020.ts", "/data");
    };
    await expect(runCustomerAudit([{ name: "ЛС.xlsx", text: fixture("grid-nnk-dop.txt") }], ZONE, { ...bimDeps, loadFer })).rejects.toThrow(/build-fer2020\.ts/);
  });
});

describe("воркер: ветка аудита", () => {
  // scripts/worker.ts запускает main() при загрузке и как модуль не импортируется, поэтому
  // ветка проверяется по тексту: между проверкой режима и возвратом нет ни сметного конвейера, ни шлюза модели.
  const source = readFileSync(join(process.cwd(), "scripts", "worker.ts"), "utf8");
  const start = source.indexOf('if (job.payload?.mode === "audit")');
  const branch = source.slice(start, source.indexOf("return {", start + 40) + 400);

  it("аудит возвращается до вызова модели и не требует адреса прода", () => {
    expect(start).toBeGreaterThan(0);
    expect(branch).toContain("runCustomerAudit(documents, zone)");
    expect(branch).not.toContain("buildEstimateFromDocuments");
    expect(branch).not.toContain("workerBillFetcher");
    expect(branch).not.toContain("config.baseUrl");
    expect(branch).not.toContain("fetch(");
    // Отчёт задания — только audit: токенов нет, сметного документа нет.
    expect(branch).toContain("audit: {");
    expect(branch).not.toContain("tokensUsed");
  });

  it("ветка стоит перед вызовом конвейера сметы", () => {
    expect(start).toBeLessThan(source.indexOf("await buildEstimateFromDocuments("));
  });
});

function baseSpec(): PositionSpec {
  return {
    n: 1,
    justification: "ГЭСН01-01-001-01",
    name: "Работа",
    unit: "100 м3",
    qty: 1,
    resources: [{ code: "1-100-20", name: "Рабочий", unit: "чел.-ч", qty: 10, price: 594.68 }],
    overhead: { ref: "Пр/812-090.0", base: 90 },
    profit: { ref: "Пр/774-090.0", base: 47 },
  };
}
