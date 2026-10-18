import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/llmUsage", () => ({
  recordLlmCall: vi.fn(async () => undefined),
  usageIncludeFields: () => ({}),
}));
vi.mock("@/services/llmGateway", () => ({
  resolveLlmEndpoint: () => ({ baseUrl: "https://gw.example", apiKey: "k", model: "m" }),
  endpointHost: () => "gw.example",
}));

const { extractBillOfWork, fetchBillRows, parseBillResponse, remoteBillRows } = await import("@/services/billOfWorkExtraction");
type BillRowsFetcher = import("@/services/billOfWorkExtraction").BillRowsFetcher;

const CONTEXT = { regNumber: "32616409061", subject: "Ремонт здания" };

const ROW = {
  work_name: "Кладка стен",
  quantity: "84,75",
  unit: "м3",
  evidence_quote: "Кладка стен | м3 | 84,75",
};

describe("parseBillResponse: терпимость к форме ответа (32616409061)", () => {
  it("массив верхнего уровня вместо объекта", () => {
    const parsed = parseBillResponse(JSON.stringify([ROW, ROW]));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.hasBill).toBe(true);
    expect(parsed.malformed).toBe(0);
  });

  it("rows: null — строк нет, без ошибки", () => {
    const parsed = parseBillResponse(JSON.stringify({ has_bill: false, rows: null }));
    expect(parsed).toEqual({ rows: [], hasBill: false, malformed: 0, truncated: false });
  });

  it("rows отсутствует", () => {
    expect(parseBillResponse(JSON.stringify({ has_bill: false })).rows).toEqual([]);
  });

  it("rows одним объектом — список из одной строки", () => {
    const parsed = parseBillResponse(JSON.stringify({ has_bill: true, rows: ROW }));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.workName).toBe("Кладка стен");
  });

  it("rows словарём «номер → строка» — значения словаря", () => {
    const parsed = parseBillResponse(JSON.stringify({ has_bill: true, rows: { "1": ROW, "2": ROW } }));
    expect(parsed.rows).toHaveLength(2);
  });

  it("rows строкой или числом — одна непрошедшая строка, не падение", () => {
    expect(parseBillResponse(JSON.stringify({ has_bill: true, rows: "нет строк" })).malformed).toBe(1);
    expect(parseBillResponse(JSON.stringify({ has_bill: true, rows: 5 })).malformed).toBe(1);
  });

  it("has_bill не булев или пропущен — выводится из строк", () => {
    expect(parseBillResponse(JSON.stringify({ rows: [ROW] })).hasBill).toBe(true);
    expect(parseBillResponse(JSON.stringify({ rows: [] })).hasBill).toBe(false);
    expect(parseBillResponse(JSON.stringify({ has_bill: "true", rows: [] })).hasBill).toBe(true);
  });

  it("кривые строки отбрасываются поодиночке и считаются: null, строка, объект без полей", () => {
    const parsed = parseBillResponse(JSON.stringify({ has_bill: true, rows: [ROW, null, "строка", { work_name: "Без объёма" }, ROW] }));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.malformed).toBe(3);
  });

  it("ответ — число или null, а не объект: понятная ошибка, а не ошибка схемы", () => {
    expect(() => parseBillResponse("42")).toThrow(/не объект и не массив/);
    expect(() => parseBillResponse("null")).toThrow(/не объект и не массив/);
  });

  it("оборванный массив верхнего уровня дочитывается по последней закрытой строке", () => {
    const text = `[${JSON.stringify(ROW)},${JSON.stringify(ROW)},{"work_name":"Недопис`;
    const parsed = parseBillResponse(text);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });

  it("оборванный объект по-прежнему дочитывается", () => {
    const text = `{"has_bill":true,"rows":[${JSON.stringify(ROW)},{"work_name":"Недопис`;
    const parsed = parseBillResponse(text);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.truncated).toBe(true);
  });
});

describe("fetchBillRows (то, что отвечает прод): не-массив в rows больше не даёт ошибку схемы", () => {
  it("модель прислала rows объектом — 200 со строкой, а не исключение", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify({ has_bill: true, rows: ROW }) } }], usage: { total_tokens: 12 } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const answer = await fetchBillRows({ chunk: "текст", context: CONTEXT, documentName: "ВОР.docx" });
    expect(answer.rows).toHaveLength(1);
    expect(answer.tokens).toBe(12);
    vi.unstubAllGlobals();
  });
});

describe("remoteBillRows: кривое тело прода", () => {
  it("rows не массив — пустой список, а не «not iterable»", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ rows: { a: 1 }, hasBill: true, tokens: 3 }), { status: 200 })),
    );
    const answer = await remoteBillRows("https://prod.example")({ chunk: "т", context: CONTEXT, documentName: "d" });
    expect(answer.rows).toEqual([]);
    vi.unstubAllGlobals();
  });
});

const TEXT = ["ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ", "1 Кладка стен | м3 | 84,75"].join("\n");

function okAnswer(): ReturnType<typeof parseBillResponse> & { tokens: number } {
  return { ...parseBillResponse(JSON.stringify({ has_bill: true, rows: [ROW] })), tokens: 10 };
}

describe("extractBillOfWork: сбой фрагмента не роняет расчёт", () => {
  it("первый вызов упал, второй прошёл — строки есть, пробелов нет", async () => {
    let calls = 0;
    const fetcher: BillRowsFetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Прод не отдал строки ведомости (HTTP 502): zod");
      return okAnswer();
    });
    const report = await extractBillOfWork([{ name: "Ведомость.docx", text: TEXT }], CONTEXT, fetcher, { retryDelayMs: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(report.sections.flatMap((section) => section.items)).toHaveLength(1);
    expect(report.unreadChunks).toEqual([]);
    expect(report.tokensUsed).toBe(10);
  });

  it("оба вызова упали — фрагмент пропущен с названием документа и причиной, исключения нет", async () => {
    const fetcher: BillRowsFetcher = vi.fn(async () => {
      throw new Error("Прод не отдал строки ведомости (HTTP 502): invalid_type");
    });
    const report = await extractBillOfWork([{ name: "Ведомость.docx", text: TEXT }], CONTEXT, fetcher, { retryDelayMs: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(report.sections).toEqual([]);
    expect(report.unreadChunks).toHaveLength(1);
    expect(report.unreadChunks[0]?.message).toBe(
      "фрагмент 1 документа Ведомость.docx не прочитан моделью: Прод не отдал строки ведомости (HTTP 502): invalid_type",
    );
    // Документ не прочитан, а не «без ведомости».
    expect(report.documentsWithoutBill).toEqual([]);
  });

  it("упал один фрагмент из двух — остальные строки в смете, пропуск назван в details источника", async () => {
    const big = `${TEXT}\n\n${"х".repeat(60)}\n\n`.repeat(1);
    const longText = `${big}${"Текст раздела. ".repeat(8000)}\n\n${TEXT.replace("Кладка стен", "Окраска стен")}`;
    let call = 0;
    const fetcher: BillRowsFetcher = vi.fn(async (request) => {
      call += 1;
      if (request.chunk.includes("Окраска стен")) throw new Error("шлюз 500");
      return okAnswer();
    });
    const report = await extractBillOfWork([{ name: "ТЗ.docx", text: longText }], CONTEXT, fetcher, { retryDelayMs: 0 });
    expect(call).toBeGreaterThanOrEqual(3);
    expect(report.sections.flatMap((section) => section.items)).toHaveLength(1);
    expect(report.unreadChunks).toHaveLength(1);
    expect(report.unreadChunks[0]?.chunk).toBe("2");
    expect(report.volumeSource?.details?.join(" ")).toContain("фрагмент 2 документа ТЗ.docx не прочитан моделью: шлюз 500");
  });
});
