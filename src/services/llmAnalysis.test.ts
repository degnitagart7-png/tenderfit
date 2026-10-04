import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_FINDINGS_PER_CHUNK,
  MAX_QUOTE_CHARS,
  buildAnalysisPrompt,
  parseAnalysisResponse,
} from "./llmAnalysis";

describe("buildAnalysisPrompt", () => {
  it("includes document text in the prompt", () => {
    const prompt = buildAnalysisPrompt({
      documentText: "Участник должен иметь лицензию ФСБ",
      tenderContext: {
        regNumber: "0123456789",
        subject: "Поставка серверного оборудования",
        customerName: "ФГУ «Заказчик»",
        price: 5000000,
      },
      companyProfile: {
        capabilities: "Поставка IT-оборудования",
        restrictions: "Цена до 10 млн ₽",
      },
    });

    expect(prompt).toContain("Участник должен иметь лицензию ФСБ");
    expect(prompt).toContain("0123456789");
    expect(prompt).toContain("Поставка серверного оборудования");
  });

  it("includes company profile context", () => {
    const prompt = buildAnalysisPrompt({
      documentText: "Some text",
      tenderContext: {
        regNumber: "123",
        subject: "Test",
        customerName: "Customer",
        price: 1000000,
      },
      companyProfile: {
        capabilities: "Строительство",
        restrictions: "Без лицензий",
      },
    });

    expect(prompt).toContain("Строительство");
    expect(prompt).toContain("Без лицензий");
  });

  it("не сообщает модели «0 ₽», когда цена не опубликована", () => {
    const prompt = buildAnalysisPrompt({
      documentText: "Some text",
      tenderContext: {
        regNumber: "SBR028-2609080053",
        subject: "Услуги по ведению ЭПЛ",
        customerName: "ООО «НТС»",
        price: 0,
      },
      companyProfile: {
        capabilities: "Услуги",
        restrictions: "Без лицензий",
      },
    });

    expect(prompt).toContain("НМЦК: не опубликована");
    expect(prompt).not.toContain("0 ₽");
  });

  it("без профиля компании не оставляет пустые поля и запрещает додумывать", () => {
    const prompt = buildAnalysisPrompt({
      documentText: "Some text",
      tenderContext: {
        regNumber: "0573100026626000009",
        subject: "Поставка оборудования",
        customerName: "ФГУ «Заказчик»",
        price: 1000000,
      },
      companyProfile: { capabilities: "", restrictions: "" },
    });

    expect(prompt).toContain("Возможности: не заданы");
    expect(prompt).toContain("Ограничения: не заданы");
    expect(prompt).toContain("Профиль компании не передан");
    expect(prompt).not.toContain("Возможности: \n");
  });

  it("ограничивает объём ответа, чтобы модель не оборвала JSON", () => {
    const prompt = buildAnalysisPrompt({
      documentText: "Some text",
      tenderContext: {
        regNumber: "0573100026626000009",
        subject: "Поставка оборудования",
        customerName: "ФГУ «Заказчик»",
        price: 1000000,
      },
      companyProfile: { capabilities: "", restrictions: "" },
    });

    expect(prompt).toContain(`не больше ${MAX_FINDINGS_PER_CHUNK}`);
    expect(prompt).toContain(`не длиннее ${MAX_QUOTE_CHARS} знаков`);
    // Служебная информация — не фактор: на реальном извещении модель начала ответ
    // с «Номер извещения» и потратила на перечисление весь лимит выходных токенов.
    expect(prompt).toMatch(/номер извещения, реквизиты и контакты/i);
    expect(prompt).toContain("сначала blocker и risk");
  });
});

describe("parseAnalysisResponse", () => {
  it("parses valid JSON response with findings", () => {
    const raw = JSON.stringify({
      findings: [
        {
          category: "blocker",
          title: "Требуется лицензия ФСБ",
          detail: "В документации указано требование лицензии",
          evidence_quote: "Участник должен иметь лицензию ФСБ",
          evidence_section: "Раздел 3",
          severity: "high",
        },
      ],
      summary: "Документация содержит блокирующие требования",
    });

    const result = parseAnalysisResponse(raw);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.category).toBe("blocker");
    expect(result.findings[0]!.severity).toBe("high");
    expect(result.summary).toContain("блокирующие требования");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAnalysisResponse("not json")).toThrow();
  });

  it("обрезанный ответ называет обрезкой, а не мусором", () => {
    const raw = '{"findings": [{"category": "risk", "title": "Неустойка 0,5';

    expect(() => parseAnalysisResponse(raw, { finishReason: "length" })).toThrow(
      /обрезан по лимиту выходных токенов/,
    );
  });

  it("в причину отказа попадают finish_reason, длина и край ответа", () => {
    const raw = "Проанализировав документ, сообщаю следующее";

    const parse = () => parseAnalysisResponse(raw, { finishReason: "stop" });
    expect(parse).toThrow(/finish_reason=stop/);
    expect(parse).toThrow(/длина ответа 43 знака/);
    expect(parse).toThrow(/начало: Проанализировав документ/);
  });

  it("throws on missing findings array", () => {
    const raw = JSON.stringify({ summary: "ok" });
    expect(() => parseAnalysisResponse(raw)).toThrow();
  });

  it("throws on invalid finding category", () => {
    const raw = JSON.stringify({
      findings: [{ category: "invalid", title: "t", detail: "d", evidence_quote: "q", evidence_section: "s", severity: "high" }],
      summary: "ok",
    });
    expect(() => parseAnalysisResponse(raw)).toThrow();
  });

  it("strips markdown json code fences", () => {
    const json = JSON.stringify({
      findings: [
        {
          category: "risk",
          title: "Длительная оплата",
          detail: "Оплата в течение 90 дней",
          evidence_quote: "Оплата производится в течение 90 календарных дней",
          evidence_section: "Раздел 5",
          severity: "medium",
        },
      ],
      summary: "Риск длительной оплаты",
    });
    const wrapped = "```json\n" + json + "\n```";

    const result = parseAnalysisResponse(wrapped);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.category).toBe("risk");
  });

  it("strips plain code fences without language tag", () => {
    const json = JSON.stringify({
      findings: [],
      summary: "Чисто",
    });
    const wrapped = "```\n" + json + "\n```";

    const result = parseAnalysisResponse(wrapped);
    expect(result.summary).toBe("Чисто");
  });
});

describe("analyzeDocumentWithLlm (integration shape)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("без новых настроек идёт на OpenRouter с прежними именами переменных", async () => {
    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            findings: [],
            summary: "Документ не содержит значимых требований",
          }),
        },
      }],
      usage: { total_tokens: 100 },
    };

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_MODEL = "google/gemini-2.5-flash";

    const { analyzeDocumentWithLlm } = await import("./llmAnalysis");
    const result = await analyzeDocumentWithLlm({
      documentText: "Тестовый документ",
      tenderContext: {
        regNumber: "123",
        subject: "Test",
        customerName: "Customer",
        price: 1000000,
      },
      companyProfile: {
        capabilities: "IT",
        restrictions: "None",
      },
    });

    expect(result.findings).toHaveLength(0);
    expect(result.tokensUsed).toBe(100);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("запрещает кэш Next.js: иначе вторая закупка получает разбор первой", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ findings: [], summary: "Пусто" }) } }],
        usage: { total_tokens: 10 },
      }),
    } as Response);
    process.env.OPENROUTER_API_KEY = "test-key";

    const { analyzeDocumentWithLlm } = await import("./llmAnalysis");
    await analyzeDocumentWithLlm({
      documentText: "Другой документ",
      tenderContext: { regNumber: "456", subject: "Test", customerName: "Customer", price: 0 },
      companyProfile: { capabilities: "", restrictions: "" },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("идёт на тот шлюз, что задан в настройках, а не на зашитый в код", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ findings: [], summary: "Пусто" }) } }],
        usage: { total_tokens: 10 },
      }),
    } as Response);
    vi.stubEnv("LLM_API_KEY", "ключ-routerai");
    // Завершающий слэш намеренно лишний: адрес в настройках набирают руками.
    vi.stubEnv("LLM_BASE_URL", "https://routerai.ru/api/v1/");

    const { analyzeDocumentWithLlm } = await import("./llmAnalysis");
    await analyzeDocumentWithLlm({
      documentText: "Документ",
      tenderContext: { regNumber: "789", subject: "Test", customerName: "Customer", price: 0 },
      companyProfile: { capabilities: "", restrictions: "" },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://routerai.ru/api/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ключ-routerai" }),
      }),
    );
  });

  it("в причине отказа называет шлюз и статус: 402 — это кончились деньги, а не сеть", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => "Недостаточно средств на балансе: 0,00 руб.",
    } as Response);
    vi.stubEnv("LLM_API_KEY", "ключ-routerai");
    vi.stubEnv("LLM_BASE_URL", "https://routerai.ru/api/v1");

    const { analyzeDocumentWithLlm } = await import("./llmAnalysis");
    await expect(
      analyzeDocumentWithLlm({
        documentText: "Документ",
        tenderContext: { regNumber: "789", subject: "Test", customerName: "Customer", price: 0 },
        companyProfile: { capabilities: "", restrictions: "" },
      }),
    ).rejects.toThrow(/routerai\.ru.*402.*Недостаточно средств/s);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
});
