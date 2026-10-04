import { beforeEach, describe, expect, it, vi } from "vitest";
import { deepAnalysisService } from "@/services/deepAnalysisService";

const REG_NUMBER = "0573100026626000009";

/**
 * Ответ API в том виде, в каком его отдаёт роут: строки БД без переименования.
 * Собираем объект вручную, а не через new Response: в jsdom его может не быть,
 * а сервису нужны только ok, status и json().
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Ответ, у которого тело не читается (например, HTML от шлюза вместо JSON). */
function brokenResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error("Unexpected token < in JSON");
    },
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.restoreAllMocks();
});

describe("deepAnalysisService.trigger", () => {
  it("ставит закупку в очередь", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ job: { id: "job-1" }, deduped: false }, 201));

    const result = await deepAnalysisService.trigger(REG_NUMBER);

    expect(result.deduped).toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/analysis/trigger");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ tenderId: REG_NUMBER });
  });

  it("передаёт приоритет и тип задачи", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ job: { id: "job-2" }, deduped: true }));

    await deepAnalysisService.trigger(REG_NUMBER, { priority: 10, jobType: "reanalyze" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      tenderId: REG_NUMBER,
      priority: 10,
      jobType: "reanalyze",
    });
  });

  it("повторный вызов не создаёт вторую задачу", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ job: { id: "job-1", status: "pending" }, deduped: true }),
    );

    const result = await deepAnalysisService.trigger(REG_NUMBER);

    expect(result.deduped).toBe(true);
  });

  it("ошибку сервера отдаёт текстом из ответа", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "tenderId is required" }, 400));

    await expect(deepAnalysisService.trigger(REG_NUMBER)).rejects.toThrow("tenderId is required");
  });

  it("без тела в ответе сообщает хотя бы код", async () => {
    fetchMock.mockResolvedValueOnce(brokenResponse(504));

    await expect(deepAnalysisService.trigger(REG_NUMBER)).rejects.toThrow(/504/);
  });
});

describe("deepAnalysisService.getStatus", () => {
  it("запрашивает состояние по реестровому номеру", async () => {
    const payload = { jobs: [], verdictHistory: [], documents: [], documentAnalyses: [] };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));

    const result = await deepAnalysisService.getStatus(REG_NUMBER);

    expect(result).toEqual(payload);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/analysis/status?tenderId=${REG_NUMBER}`);
  });

  it("экранирует номер, если в нём попадётся спецсимвол", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: [] }));

    await deepAnalysisService.getStatus("1&x=2");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/analysis/status?tenderId=1%26x%3D2");
  });
});

/** Номер живой коммерческой закупки: для таких карточка источника — единственный путь. */
const COMMERCIAL_REG_NUMBER = "RH24092600035";

describe("deepAnalysisService.getKonturCard", () => {
  it("запрашивает состояние платной карточки по номеру закупки", async () => {
    const payload = {
      regNumber: COMMERCIAL_REG_NUMBER,
      show: true,
      allowed: true,
      reason: null,
      refusalKind: null,
      budgetNote: "Карточек Контур.Закупок сегодня: 2 из 30, осталось 28",
      cardSpentToday: 2,
      cardLimit: 30,
      analysisRemaining: 15,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));

    const result = await deepAnalysisService.getKonturCard(COMMERCIAL_REG_NUMBER);

    expect(result).toEqual(payload);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/analysis/kontur-card?regNumber=${COMMERCIAL_REG_NUMBER}`);
    // Чтение бесплатное, поэтому запрос всегда GET: платит только явный POST.
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
  });

  it("закупки нет в базе — null, а не ошибка на весь экран", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: `Закупка ${COMMERCIAL_REG_NUMBER} не найдена в базе` }, 404),
    );

    await expect(deepAnalysisService.getKonturCard(COMMERCIAL_REG_NUMBER)).resolves.toBeNull();
  });

  it("недоступную очередь отдаёт текстом сервера", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "Состояние платной карточки не прочитано" }, 503),
    );

    await expect(deepAnalysisService.getKonturCard(COMMERCIAL_REG_NUMBER)).rejects.toThrow(
      "Состояние платной карточки не прочитано",
    );
  });
});

describe("deepAnalysisService.buyKonturCard", () => {
  it("ставит платное задание и возвращает состав работы", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          status: "queued",
          regNumber: COMMERCIAL_REG_NUMBER,
          jobId: "job-docs-1",
          analysisJobId: "job-analysis-1",
          deduped: false,
          budgetNote: "Карточек Контур.Закупок сегодня: 3 из 30, осталось 27",
          warning: null,
        },
        201,
      ),
    );

    const result = await deepAnalysisService.buyKonturCard(COMMERCIAL_REG_NUMBER);

    expect(result.jobId).toBe("job-docs-1");
    expect(result.analysisJobId).toBe("job-analysis-1");
    expect(result.warning).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/analysis/kontur-card");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ regNumber: COMMERCIAL_REG_NUMBER });
  });

  it("переиспользованное задание помечает как deduped", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "queued", jobId: "job-docs-old", deduped: true, warning: null }),
    );

    const result = await deepAnalysisService.buyKonturCard(COMMERCIAL_REG_NUMBER);

    expect(result.deduped).toBe(true);
  });

  it("отказ по бюджету приходит причиной, а не кодом ответа", async () => {
    // Роут отвечает 429 с готовой фразой: партнёру нужно знать, что ждать
    // полуночи, а не что нажатие сломалось.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          status: "refused",
          refusalKind: "budget",
          error:
            "Суточный бюджет карточек Контур.Закупок исчерпан. Следующая попытка — после 00:00 по Москве.",
        },
        429,
      ),
    );

    await expect(deepAnalysisService.buyKonturCard(COMMERCIAL_REG_NUMBER)).rejects.toThrow(
      /Суточный бюджет карточек/,
    );
  });

  it("без читаемого тела сообщает хотя бы код", async () => {
    fetchMock.mockResolvedValueOnce(brokenResponse(504));

    await expect(deepAnalysisService.buyKonturCard(COMMERCIAL_REG_NUMBER)).rejects.toThrow(/504/);
  });
});
