import { NextRequest, NextResponse } from "next/server";
import { checkAdminToken } from "@/lib/adminToken";
import { endpointHost, resolveLlmEndpoint, resolveLlmModel } from "@/services/llmGateway";
import { recordLlmCall, usageIncludeFields } from "@/services/llmUsage";

/**
 * GET /api/analysis/test-ai
 *
 * Диагностика доступности шлюза модели с сервера: минимальный запрос и ответ.
 * Шлюз берётся из настроек, поэтому проверка отвечает на вопрос «работает ли
 * тот провайдер, который задан сейчас», а не «работает ли OpenRouter».
 *
 * Закрыт ключом владельца (заголовок x-admin-token): каждый вызов платный, и
 * открытый адрес позволял любому тратить деньги на модель.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const verdict = checkAdminToken(request.headers.get("x-admin-token"), process.env["ADMIN_TOKEN"]);
  if (verdict === "disabled") {
    return NextResponse.json(
      { ok: false, error: "Проверка выключена: на сервере не задан ADMIN_TOKEN." },
      { status: 503 },
    );
  }
  if (verdict === "denied") {
    return NextResponse.json({ ok: false, error: "Неверный ключ владельца." }, { status: 401 });
  }

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
        ...usageIncludeFields(),
      }),
      // Диагностика обязана мерить настоящий вызов: без no-store Next.js
      // отдаёт закэшированный ответ и elapsedMs не меняется от вызова к вызову.
      cache: "no-store",
    });

    const elapsed = Date.now() - started;
    const text = await res.text();

    // Диагностика тоже стоит токенов (пусть и пяти): пишем как «other».
    let usage: unknown;
    try {
      usage = (JSON.parse(text) as { usage?: unknown }).usage;
    } catch {
      usage = undefined;
    }
    await recordLlmCall(
      { purpose: "other" },
      {
        model: endpoint.model,
        usage,
        inputChars: "Ответь одним словом: OK".length,
        ok: res.ok,
        error: res.ok ? null : text.slice(0, 300),
      },
    );

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
