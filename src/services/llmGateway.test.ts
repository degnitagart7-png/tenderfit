import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, endpointHost, resolveLlmEndpoint, resolveLlmModel } from "./llmGateway";

describe("resolveLlmEndpoint", () => {
  it("без явных настроек берёт OpenRouter и модель по умолчанию", () => {
    const endpoint = resolveLlmEndpoint({ LLM_API_KEY: "ключ" });

    expect(endpoint).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "ключ",
      model: DEFAULT_MODEL,
    });
  });

  it("принимает прежние имена OPENROUTER_*, чтобы прод не сломался при переходе", () => {
    const endpoint = resolveLlmEndpoint({
      OPENROUTER_API_KEY: "старый-ключ",
      OPENROUTER_MODEL: "google/gemini-2.5-pro",
    });

    expect(endpoint.apiKey).toBe("старый-ключ");
    expect(endpoint.model).toBe("google/gemini-2.5-pro");
  });

  it("новые имена важнее прежних", () => {
    const endpoint = resolveLlmEndpoint({
      LLM_API_KEY: "новый",
      OPENROUTER_API_KEY: "старый",
      LLM_MODEL: "yandex/gpt-lite-5",
      OPENROUTER_MODEL: "google/gemini-2.5-flash",
    });

    expect(endpoint.apiKey).toBe("новый");
    expect(endpoint.model).toBe("yandex/gpt-lite-5");
  });

  it("переключает шлюз на российский без правки кода", () => {
    const endpoint = resolveLlmEndpoint({
      LLM_API_KEY: "ключ",
      LLM_BASE_URL: "https://routerai.ru/api/v1",
    });

    expect(endpoint.baseUrl).toBe("https://routerai.ru/api/v1");
  });

  it("срезает завершающие слэши адреса: иначе путь даёт двойной слэш и 404", () => {
    const endpoint = resolveLlmEndpoint({
      LLM_API_KEY: "ключ",
      LLM_BASE_URL: "https://routerai.ru/api/v1///",
    });

    expect(endpoint.baseUrl).toBe("https://routerai.ru/api/v1");
    expect(`${endpoint.baseUrl}/chat/completions`).toBe(
      "https://routerai.ru/api/v1/chat/completions",
    );
  });

  it("пробелы в значении не считаются настройкой", () => {
    const endpoint = resolveLlmEndpoint({
      LLM_API_KEY: "  ключ  ",
      LLM_MODEL: "   ",
      OPENROUTER_MODEL: undefined,
    });

    expect(endpoint.apiKey).toBe("ключ");
    expect(endpoint.model).toBe(DEFAULT_MODEL);
  });

  it("без ключа называет переменную, которую нужно задать", () => {
    expect(() => resolveLlmEndpoint({})).toThrow(/LLM_API_KEY/);
    expect(() => resolveLlmEndpoint({ LLM_API_KEY: "   " })).toThrow(/LLM_API_KEY/);
  });

  it("отклоняет http: ключ уходит в заголовке и не должен идти открытым", () => {
    expect(() =>
      resolveLlmEndpoint({ LLM_API_KEY: "ключ", LLM_BASE_URL: "http://routerai.ru/api/v1" }),
    ).toThrow(/https/);
  });

  it("пустой адрес означает «не задан», а не ошибку: на Vercel переменную обнуляют вместо удаления", () => {
    const endpoint = resolveLlmEndpoint({ LLM_API_KEY: "ключ", LLM_BASE_URL: "   " });

    expect(endpoint.baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});

describe("resolveLlmModel", () => {
  it("не требует ключа: имя модели пишется в разбор до первого вызова", () => {
    expect(resolveLlmModel({})).toBe(DEFAULT_MODEL);
    expect(resolveLlmModel({ LLM_MODEL: "yandex/gpt-pro-5" })).toBe("yandex/gpt-pro-5");
  });
});

describe("endpointHost", () => {
  it("возвращает хост для сообщения об ошибке", () => {
    expect(endpointHost("https://routerai.ru/api/v1")).toBe("routerai.ru");
    expect(endpointHost("не адрес")).toBe("не адрес");
  });
});
