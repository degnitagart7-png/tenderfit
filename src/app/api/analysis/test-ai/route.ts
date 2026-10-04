import { NextResponse } from "next/server";
import { endpointHost, resolveLlmEndpoint, resolveLlmModel } from "@/services/llmGateway";

/**
 * GET /api/analysis/test-ai
 *
 * Диагностика доступности шлюза модели с сервера: минимальный запрос и ответ.
 * Шлюз берётся из настроек, поэтому проверка отвечает на вопрос «работает ли
 * тот провайдер, который задан сейчас», а не «работает ли OpenRouter».
 */
export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  let endpoint;
  try {
    endpoint = resolveLlmEndpoint();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: "user", content: "Ответь одним словом: OK" }],
        max_tokens: 5,
      }),
      // Диагностика обязана мерить настоящий вызов: без no-store Next.js
      // отдаёт закэшированный ответ и elapsedMs не меняется от вызова к вызову.
      cache: "no-store",
    });

    const elapsed = Date.now() - started;
    const text = await res.text();

    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          // Хост и модель в ответе обязательны: 402 (кончились деньги), 403
          // (не пускает из этой сети) и 404 (нет такой модели) лечатся по-разному.
          gateway: endpointHost(endpoint.baseUrl),
          model: resolveLlmModel(),
          status: res.status,
          error: text.slice(0, 300),
          elapsedMs: elapsed,
        },
        { status: 502 },
      );
    }

    const data = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return NextResponse.json({
      ok: true,
      gateway: endpointHost(endpoint.baseUrl),
      model: endpoint.model,
      reply: data.choices?.[0]?.message?.content ?? null,
      elapsedMs: elapsed,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        gateway: endpointHost(endpoint.baseUrl),
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - started,
      },
      { status: 502 },
    );
  }
}
