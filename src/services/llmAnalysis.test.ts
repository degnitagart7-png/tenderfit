import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Учёт расхода пишет в базу; в этих тестах база не нужна, а сам факт записи проверяется ниже.
vi.mock("@/repositories/llmUsageRepository", () => ({
  llmUsageRepository: { record: vi.fn(async () => true) },
}));

import {
  TRUNCATED_ANALYSIS_NOTE,
  MAX_FINDINGS_PER_CHUNK,
  MAX_QUOTE_CHARS,
  buildAnalysisPrompt,
  parseAnalysisResponse,
} from "./llmAnalysis";

describe("buildAnalysisPrompt", () => {
  it("просит писать detail простым языком: чем грозит в деньгах или сроках, без канцелярита", () => {
    const prompt = buildAnalysisPrompt({
      documentText: "Текст",
      tenderContext: { regNumber: "1", subject: "Ремонт", customerName: "Заказчик", price: 1_000_000 },
      companyProfile: { capabilities: "", restrictions: "" },
    });

    expect(prompt).toContain("простым языком для директора небольшой строительной фирмы");
    expect(prompt).toContain("чем это грозит в деньгах или сроках, без канцелярита");
    // Схема ответа не тронута: те же поля, что разбирает findingSchema.
    for (const field of ["category", "title", "detail", "evidence_quote", "evidence_section", "severity"]) {
      expect(prompt).toContain(`- ${field}:`);
    }
  });

  it("сметные сведения — не риски, быстрая оплата — не длительная", () => {
    const prompt = buildAnalysisPrompt({
      documentText: "Текст",
      tenderContext: { regNumber: "1", subject: "Ремонт", customerName: "Заказчик", price: 1_000_000 },
      companyProfile: { capabilities: "", restrictions: "" },
    });

    expect(prompt).toMatch(/НДС, индекс инфляции, непредвиденные затраты.*не риски: пиши их в neutral/);
    expect(prompt).toMatch(/оплата за 7 рабочих дней — это быстро/);
  });

  describe("норма закона и обычай не находка", () => {
    const base = {
      documentText: "Текст",
      companyProfile: { capabilities: "", restrictions: "" },
    };
    const ctx = { regNumber: "1", subject: "Ремонт", customerName: "Заказчик", price: 1_000_000 };

    it("в примерах рисков больше нет казначейского сопровождения и одностороннего отказа", () => {
      const prompt = buildAnalysisPrompt({ ...base, tenderContext: ctx });
      const riskItem = prompt.slice(prompt.indexOf("2. **risk**"), prompt.indexOf("3. **requirement**"));
      expect(riskItem).not.toMatch(/казначейск/i);
      expect(riskItem).not.toMatch(/односторонний отказ заказчика/i);
    });

    it("есть раздел «Что НЕ является находкой» и правило про норму и отклонение", () => {
      const prompt = buildAnalysisPrompt({ ...base, tenderContext: { ...ctx, law: "FZ_44" } });
      expect(prompt).toContain("## Что НЕ является находкой");
      expect(prompt).toContain("Норма закона и обычай делового оборота — не находка. Отклонение от нормы — находка.");
      expect(prompt).toMatch(/ч\. 1 и ч\. 1\.1 ст\. 31/);
      expect(prompt).toMatch(/НДС/);
    });

    it("для 44-ФЗ казначейство и отказ названы типовыми, для 223-ФЗ — выбором заказчика", () => {
      const p44 = buildAnalysisPrompt({ ...base, tenderContext: { ...ctx, law: "FZ_44" } });
      expect(p44).toContain("- Закон: FZ_44");
      expect(p44).toMatch(/казначейское сопровождение \(любое упоминание\)/);
      expect(p44).toMatch(/ч\. 9 ст\. 95/);
      expect(p44).toMatch(/нарушение, повод для жалобы в ФАС/);

      const p223 = buildAnalysisPrompt({ ...base, tenderContext: { ...ctx, law: "FZ_223" } });
      expect(p223).toContain("- Закон: FZ_223");
      expect(p223).not.toMatch(/казначейское сопровождение \(любое упоминание\)/);
      expect(p223).toMatch(/условия, которые выбрал заказчик/);
    });

    it("закон не передан — промпт говорит «не указан» и не объявляет 44-ФЗ", () => {
      const prompt = buildAnalysisPrompt({ ...base, tenderContext: ctx });
      expect(prompt).toContain("- Закон: не указан");
      expect(prompt).not.toMatch(/казначейское сопровождение \(любое упоминание\)/);
    });
  });

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

  it("оборванный ответ с целыми факторами не превращается в ошибку: факторы до обрыва сохраняются", () => {
    const whole = (title: string) =>
      JSON.stringify({ category: "risk", title, detail: "Подробности {со скобками} и \\\"кавычками\\\"", quote: "цитата", severity: "medium" });
    const raw = `\`\`\`json\n{"findings": [${whole("Первый")}, ${whole("Второй")}, {"category": "risk", "title": "Недописан`;

    const strict = parseAnalysisResponse(`{"findings": [${whole("Первый")}], "summary": "ok"}`);
    const result = parseAnalysisResponse(raw, { finishReason: "length" });

    expect(result.findings.length).toBe(2 * strict.findings.length);
    expect(result.summary).toBe(TRUNCATED_ANALYSIS_NOTE);
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

  it("отбрасывает фактор с неизвестной категорией, не теряя соседей", () => {
    const raw = JSON.stringify({
      findings: [
        { category: "invalid", title: "t", detail: "d", evidence_quote: "q", evidence_section: "s", severity: "high" },
        { category: "risk", title: "Неустойка", detail: "d", evidence_quote: "q", evidence_section: "s", severity: "high" },
      ],
      summary: "ok",
    });
    expect(parseAnalysisResponse(raw).findings.map((f) => f.title)).toEqual(["Неустойка"]);
  });

  it("пропущенная важность не роняет фрагмент: живой сбой разбора", () => {
    const raw = JSON.stringify({
      findings: [{ category: "blocker", title: "Лицензия МЧС", detail: "d", evidence_quote: "q", evidence_section: "s" }],
      summary: "ok",
    });
    expect(parseAnalysisResponse(raw).findings[0]?.severity).toBe("medium");
  });

  it("читает вид требования и требуемое значение; неизвестный вид — null", () => {
    const raw = JSON.stringify({
      findings: [
        {
          category: "blocker",
          title: "Лицензия МЧС",
          detail: "d",
          evidence_quote: "q",
          evidence_section: "s",
          severity: "high",
          requirement_kind: "LICENSE",
          required_value: "лицензия МЧС на монтаж средств пожарной безопасности",
        },
        {
          category: "requirement",
          title: "Что-то",
          detail: "d",
          evidence_quote: "q",
          evidence_section: "s",
          severity: "low",
          requirement_kind: "UNKNOWN_KIND",
        },
      ],
      summary: "ok",
    });
    const [license, other] = parseAnalysisResponse(raw).findings;
    expect(license?.requirement_kind).toBe("LICENSE");
    expect(license?.required_value).toMatch(/МЧС/);
    expect(other?.requirement_kind).toBeNull();
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

describe("analyzeDocumentWithLlm: учёт расхода на модель", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("LLM_API_KEY", "ключ-routerai");
    vi.stubEnv("LLM_BASE_URL", "https://routerai.ru/api/v1");
    vi.stubEnv("LLM_MODEL", "google/gemini-2.5-flash");
    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    vi.mocked(llmUsageRepository.record).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const input = {
    documentText: "Документ",
    tenderContext: { regNumber: "0573100026626000009", subject: "Test", customerName: "C", price: 0 },
    companyProfile: { capabilities: "", restrictions: "" },
    usageContext: { tenderId: "0573100026626000009", jobId: "job-77" },
  };

  it("пишет вызов как deep_analysis с закупкой и заданием, стоимость берёт у шлюза", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ findings: [], summary: "ок" }) } }],
        usage: { prompt_tokens: 30_000, completion_tokens: 500, total_tokens: 30_500, cost: 1.1275 },
      }),
    } as Response);

    const { analyzeDocumentWithLlm } = await import("./llmAnalysis");
    await analyzeDocumentWithLlm(input);

    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    expect(llmUsageRepository.record).toHaveBeenCalledTimes(1);
    expect(llmUsageRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "deep_analysis",
        tender_id: "0573100026626000009",
        job_id: "job-77",
        model: "google/gemini-2.5-flash",
        prompt_tokens: 30_000,
        completion_tokens: 500,
        cost_rub: 1.1275,
        cost_source: "provider",
        ok: true,
        error: null,
      }),
    );
  });

  it("без стоимости в ответе считает по таблице цен", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ findings: [], summary: "ок" }) } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, total_tokens: 1_100_000 },
      }),
    } as Response);

    const { analyzeDocumentWithLlm } = await import("./llmAnalysis");
    await analyzeDocumentWithLlm(input);

    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    // 1 млн входа по 11 ₽ + 0,1 млн выхода по 55 ₽ = 16,5 ₽.
    expect(llmUsageRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({ cost_source: "price_table", cost_rub: expect.closeTo(16.5, 6) }),
    );
  });

  it("сбойный вызов тоже пишется, с ok=false и причиной", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    } as Response);

    const { analyzeDocumentWithLlm } = await import("./llmAnalysis");
    await expect(analyzeDocumentWithLlm(input)).rejects.toThrow(/502/);

    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    expect(llmUsageRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "deep_analysis",
        ok: false,
        error: expect.stringContaining("502"),
        prompt_tokens: 0,
      }),
    );
  });

  it("ответ пришёл, но не разобрался: токены списаны, поэтому строка с токенами и ok=false", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "это не JSON" }, finish_reason: "length" }],
        usage: { prompt_tokens: 20_000, completion_tokens: 8192, total_tokens: 28_192 },
      }),
    } as Response);

    const { analyzeDocumentWithLlm } = await import("./llmAnalysis");
    await expect(analyzeDocumentWithLlm(input)).rejects.toThrow();

    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    expect(llmUsageRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, prompt_tokens: 20_000, completion_tokens: 8192 }),
    );
  });

  it("сбой записи учёта не роняет анализ", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ findings: [], summary: "ок" }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    } as Response);
    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    vi.mocked(llmUsageRepository.record).mockRejectedValueOnce(new Error("база недоступна"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { analyzeDocumentWithLlm } = await import("./llmAnalysis");
    const result = await analyzeDocumentWithLlm(input);

    expect(result.summary).toBe("ок");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
