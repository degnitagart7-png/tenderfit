/**
 * Тесты `tenderRepository` — в первую очередь правила, по которому одна закупка
 * остаётся одной строкой, даже если её принесли разные источники.
 *
 * Контур.Закупки — агрегатор тех же извещений, что публикует ЕИС, и номер
 * закупки у него совпадает с номером в ЕИС (в выдаче поиска это поле `Id`).
 * Без приоритета источника синхронизация Контур перезаписала бы строку ЕИС:
 * `update` пишет null на место отсутствующих значений, поэтому вместе с
 * менее полными данными агрегатора пропали бы заказчик, регион, ссылка на
 * ЕИС и требования. Закрашенные значения в фикстурах ниже — страховка на
 * случай пониженного тарифа: боевой ключ отдаёт их целиком, а правило
 * приоритета должно работать в любом случае.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenderDataSource } from "@/types/database";

const mockFrom = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: mockFrom,
  }),
}));

interface ChainCall {
  table: string;
  method: string;
  args: unknown[];
}

const calls: ChainCall[] = [];
const EMPTY: { data: unknown; error: unknown } = { data: null, error: null };
let responses: Array<{ data: unknown; error: unknown }> = [EMPTY];

const CHAIN_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "order",
  "limit",
  "range",
] as const;

function currentResponse(): { data: unknown; error: unknown } {
  if (responses.length > 1) return responses.shift() ?? EMPTY;
  return responses[0] ?? EMPTY;
}

function chainFor(table: string) {
  const node: Record<string, unknown> = {
    then: (resolve: (value: unknown) => void) => resolve(currentResponse()),
    single: async () => currentResponse(),
    maybeSingle: async () => currentResponse(),
  };
  for (const method of CHAIN_METHODS) {
    node[method] = (...args: unknown[]) => {
      calls.push({ table, method, args });
      return node;
    };
  }
  return node;
}

mockFrom.mockImplementation((table: string) => chainFor(table));

function mockSequence(...items: Array<{ data: unknown; error: unknown }>) {
  responses = items;
}

/** Аргументы первого вызова указанного метода. */
function argsOf(method: string): unknown[] {
  return calls.find((call) => call.method === method)?.args ?? [];
}

const NOT_FOUND = { code: "PGRST116", message: "The result contains 0 rows" };

/** Строка таблицы `tenders` в том виде, в каком её отдаёт PostgREST. */
function row(dataSource: TenderDataSource, overrides: Record<string, unknown> = {}) {
  return {
    id: "tender-1",
    reg_number: "0187300008126000484",
    law: "FZ_44",
    subject: "Капитальный ремонт крановых узлов",
    customer_name: "МКУ «Стройзаказчик»",
    customer_inn: "8610000000",
    region: "Ханты-Мансийский автономный округ — Югра",
    price: 1333152.84,
    currency: "RUB",
    submission_end: "2026-09-30T04:00:00.000Z",
    eis_url: "https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0187300008126000484",
    data_source: dataSource,
    ...overrides,
  };
}

/** Вход синхронизации: минимум обязательных полей. */
function input(dataSource: TenderDataSource, overrides: Record<string, unknown> = {}) {
  return {
    reg_number: "0187300008126000484",
    law: "FZ_44" as const,
    placing_way: "ELECTRONIC_AUCTION" as const,
    subject: "Капитальный ремонт крановых узлов",
    customer_name: "МКУ Стро░░░░",
    region: "Не указан",
    submission_end: "2026-09-30T04:00:00.000Z",
    data_source: dataSource,
    ...overrides,
  };
}

describe("tenderRepository: одна закупка — одна строка", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    responses = [EMPTY];
    mockFrom.mockImplementation((table: string) => chainFor(table));
  });

  it("создаёт строку, когда закупки с таким номером ещё нет", async () => {
    mockSequence({ data: null, error: NOT_FOUND }, { data: row("KONTUR"), error: null });
    const { tenderRepository } = await import("./tenderRepository");

    const result = await tenderRepository.upsertByRegNumber(input("KONTUR"));

    expect(result.created).toBe(true);
    expect(result.duplicateOf).toBeUndefined();
    expect(calls.some((call) => call.method === "insert")).toBe(true);
    expect(calls.some((call) => call.method === "update")).toBe(false);
  });

  it("не перезаписывает строку ЕИС данными агрегатора", async () => {
    mockSequence({ data: row("EIS"), error: null });
    const { tenderRepository } = await import("./tenderRepository");

    const result = await tenderRepository.upsertByRegNumber(input("KONTUR"));

    expect(result.created).toBe(false);
    expect(result.duplicateOf).toBe("EIS");
    expect(result.row.data_source).toBe("EIS");
    // Ни update, ни insert: строка первоисточника остаётся нетронутой.
    expect(calls.some((call) => call.method === "update")).toBe(false);
    expect(calls.some((call) => call.method === "insert")).toBe(false);
  });

  it("не перезаписывает закупку, загруженную пользователем", async () => {
    mockSequence({ data: row("IMPORT"), error: null });
    const { tenderRepository } = await import("./tenderRepository");

    const result = await tenderRepository.upsertByRegNumber(input("KONTUR"));

    expect(result.duplicateOf).toBe("IMPORT");
    expect(calls.some((call) => call.method === "update")).toBe(false);
  });

  it("данные ЕИС замещают строку агрегатора и переносят источник на ЕИС", async () => {
    mockSequence({ data: row("KONTUR"), error: null }, { data: row("EIS"), error: null });
    const { tenderRepository } = await import("./tenderRepository");

    const result = await tenderRepository.upsertByRegNumber(input("EIS"));

    expect(result.created).toBe(false);
    expect(result.duplicateOf).toBeUndefined();
    expect(calls.some((call) => call.method === "update")).toBe(true);
    // Иначе строка осталась бы подписана «Контур» при данных из ЕИС.
    expect(argsOf("update")[0]).toMatchObject({ data_source: "EIS" });
  });

  it("тот же источник обновляет свою строку, как и раньше", async () => {
    mockSequence({ data: row("KONTUR"), error: null }, { data: row("KONTUR"), error: null });
    const { tenderRepository } = await import("./tenderRepository");

    const result = await tenderRepository.upsertByRegNumber(input("KONTUR"));

    expect(result.created).toBe(false);
    expect(result.duplicateOf).toBeUndefined();
    expect(calls.some((call) => call.method === "update")).toBe(true);
  });

  it("приоритет источников: первоисточник выше агрегатора, демо — ниже всех", async () => {
    const { TENDER_SOURCE_PRIORITY } = await import("./tenderRepository");

    expect(TENDER_SOURCE_PRIORITY.EIS).toBeGreaterThan(TENDER_SOURCE_PRIORITY.SBER_AST);
    expect(TENDER_SOURCE_PRIORITY.SBER_AST).toBeGreaterThan(TENDER_SOURCE_PRIORITY.KONTUR);
    expect(TENDER_SOURCE_PRIORITY.KONTUR).toBeGreaterThan(TENDER_SOURCE_PRIORITY.MOCK);
  });

  it("обновление переносит валюту, внешний номер и дату публикации", async () => {
    mockSequence({ data: row("KONTUR"), error: null }, { data: row("EIS"), error: null });
    const { tenderRepository } = await import("./tenderRepository");

    await tenderRepository.upsertByRegNumber(
      input("EIS", {
        currency: "RUB",
        external_id: "0187300008126000484",
        publication_date: "2026-09-20T08:00:00.000Z",
      }),
    );

    expect(argsOf("update")[0]).toMatchObject({
      currency: "RUB",
      external_id: "0187300008126000484",
      publication_date: "2026-09-20T08:00:00.000Z",
    });
  });

  it("не переданная валюта не затирает сохранённую", async () => {
    mockSequence({ data: row("KONTUR"), error: null }, { data: row("KONTUR"), error: null });
    const { tenderRepository } = await import("./tenderRepository");

    await tenderRepository.upsertByRegNumber(input("KONTUR"));

    // null вместо RUB обнулил бы деньги в уже сохранённой закупке.
    expect(argsOf("update")[0]).not.toHaveProperty("currency");
  });
});
