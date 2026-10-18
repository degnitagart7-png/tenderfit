import {
  buildImpliedWorksPrompt,
  impliedWorksMaxTokens,
  parseImpliedWorksResponse,
  IMPLIED_CATEGORIES,
  type ImpliedProposer,
  type ImpliedRequest,
  type ImpliedResponse,
  type RawAddition,
} from "@/domain/estimate/impliedWorks";
import { workerSecretHeaders } from "@/lib/workerSecret";
import { resolveNormPickModel } from "@/services/normPickService";
import { llmChat, type ChatFn } from "@/services/searchAssistService";

/**
 * Предложение работ по технологии моделью: серверная часть (прод, где живёт ключ) и клиент воркера.
 *
 * Устроено так же, как подбор норм (`normPickService.ts`): ключ модели — на проде, у воркера ведомость с выбранными нормами. Воркер отправляет на
 * `/api/estimate/implied-works` позиции ведомости и сведения об объекте; прод строит промпт по неизменному шаблону, зовёт модель один раз, пишет расход
 * в `llm_usage_log` с видом работы `estimate_implied` и возвращает дополнения как есть. Проверяет формулы и берёт дополнения в смету воркер
 * (`estimateImplied.ts`): ответ, пришедший по сети, не доверяется.
 */

/** Переменная окружения с моделью этого этапа. Нет — модель подбора норм (`TENDERFIT_NORM_PICK_MODEL`), а нет и её — модель шлюза по умолчанию. */
export const IMPLIED_MODEL_ENV = "TENDERFIT_IMPLIED_MODEL";

const GATEWAY_TIMEOUT_MS = 90_000;
const CLIENT_TIMEOUT_MS = 120_000;

export function resolveImpliedModel(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[IMPLIED_MODEL_ENV]?.trim();
  return value === undefined || value === "" ? resolveNormPickModel(env) : value;
}

/** Обращение к модели с запросом. Чат подменяется тестом; расход пишет сам чат (`llmChat`) по виду работы из контекста. Не JSON в ответе — ошибка. */
export async function fetchImpliedWorks(
  request: ImpliedRequest,
  chat: ChatFn = llmChat,
  env: Record<string, string | undefined> = process.env,
): Promise<ImpliedResponse> {
  const prompt = buildImpliedWorksPrompt(request);
  const model = resolveImpliedModel(env);
  const regNumber = request.context.regNumber;
  const answer = await chat(
    prompt,
    impliedWorksMaxTokens(),
    {
      purpose: "estimate_implied",
      // Расчёт по присланным файлам идёт «без номера» (scripts/worker.ts): закупки у него нет.
      tenderId: regNumber === "без номера" ? null : regNumber,
      jobId: request.context.jobId ?? null,
    },
    { ...(model === undefined ? {} : { model }), timeoutMs: GATEWAY_TIMEOUT_MS },
  );
  const parsed = parseImpliedWorksResponse(answer.content);
  return { additions: parsed.additions, tokens: answer.tokens, malformed: parsed.malformed };
}

function describeBody(body: string): string {
  if (body === "") return "пустой ответ";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error !== "") return parsed.error;
  } catch {
    // Не JSON — значит страница; ниже берём её начало.
  }
  return body.length > 160 ? `${body.slice(0, 160)}…` : body;
}

/** Предложение через прод: воркер отдаёт позиции, прод зовёт модель. Адрес — тот же `SYNC_BASE_URL`, что у `remoteNormPicker`. */
export function remoteImpliedProposer(baseUrl: string): ImpliedProposer {
  return async (request) => {
    const response = await fetch(`${baseUrl}/api/estimate/implied-works`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...workerSecretHeaders() },
      body: JSON.stringify({
        regNumber: request.context.regNumber,
        subject: request.context.subject,
        ...(request.context.jobId ? { jobId: request.context.jobId } : {}),
        facts: request.facts,
        items: request.items,
      }),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text()).replace(/\s+/g, " ").trim();
      throw new Error(`Прод не отдал работы по технологии (HTTP ${String(response.status)}): ${describeBody(body)}`);
    }

    // Ответ пришёл по сети: поля приводятся к ожидаемым типам, чужие и кривые отбрасываются.
    const payload = (await response.json()) as { additions?: unknown; tokens?: unknown; malformed?: unknown };
    const additions: RawAddition[] = [];
    let malformed = typeof payload.malformed === "number" ? payload.malformed : 0;
    for (const entry of Array.isArray(payload.additions) ? (payload.additions as unknown[]) : []) {
      const raw = entry as Partial<Record<keyof RawAddition, unknown>> | null;
      if (
        raw === null ||
        typeof raw !== "object" ||
        typeof raw.workName !== "string" ||
        typeof raw.unit !== "string" ||
        typeof raw.formula !== "string" ||
        typeof raw.category !== "string" ||
        !(IMPLIED_CATEGORIES as readonly string[]).includes(raw.category)
      ) {
        malformed += 1;
        continue;
      }
      additions.push({
        workName: raw.workName,
        category: raw.category as RawAddition["category"],
        unit: raw.unit,
        formula: raw.formula,
        reason: typeof raw.reason === "string" ? raw.reason : "",
      });
    }
    return { additions, tokens: typeof payload.tokens === "number" ? payload.tokens : 0, malformed };
  };
}
