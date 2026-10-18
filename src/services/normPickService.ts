import {
  buildNormPickPrompt,
  normPickMaxTokens,
  parseNormPickResponse,
  type NormPickBatch,
  type NormPickResponse,
  type NormPicker,
  type RawNormPick,
} from "@/domain/estimate/normPick";
import { workerSecretHeaders } from "@/lib/workerSecret";
import { llmChat, type ChatFn } from "@/services/searchAssistService";

/**
 * Подбор норм моделью: серверная часть (прод, где живёт ключ) и клиент воркера.
 *
 * Устроено так же, как извлечение ведомости (`billOfWorkExtraction.ts`): ключ модели — на проде, у воркера база норм. Воркер
 * собирает кандидатов (`normCandidates.ts`) и отправляет пачку до десяти позиций с их кандидатами на `/api/estimate/norm-pick`;
 * прод строит промпт по неизменному шаблону, зовёт модель, пишет расход в `llm_usage_log` с видом работы `estimate_norm_pick`
 * и возвращает выбор. Проверяет выбор и пишет его в смету воркер (`estimateNormPick.ts`): ответ, пришедший по сети, не доверяется.
 */

/** Переменная окружения с моделью подбора норм. Нет — та же модель, что у извлечения ведомости (`LLM_MODEL`). */
export const NORM_PICK_MODEL_ENV = "TENDERFIT_NORM_PICK_MODEL";

/** Пачка из десяти позиций с кандидатами — это десятки тысяч знаков промпта; шлюз отвечает десятками секунд. */
const GATEWAY_TIMEOUT_MS = 90_000;
const CLIENT_TIMEOUT_MS = 120_000;

/** Модель подбора: из окружения, пустое значение — «не задано». */
export function resolveNormPickModel(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[NORM_PICK_MODEL_ENV]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Обращение к модели с пачкой позиций. Чат подменяется тестом; расход пишет сам чат (`llmChat`) по виду работы из контекста.
 * Не JSON в ответе — ошибка: воркер откатит пачку на подбор по наименованию.
 */
export async function fetchNormPicks(
  batch: NormPickBatch,
  chat: ChatFn = llmChat,
  env: Record<string, string | undefined> = process.env,
): Promise<NormPickResponse> {
  const prompt = buildNormPickPrompt(batch);
  const model = resolveNormPickModel(env);
  const regNumber = batch.context.regNumber;
  const answer = await chat(
    prompt,
    normPickMaxTokens(batch.items.length),
    {
      purpose: "estimate_norm_pick",
      // Расчёт по присланным файлам идёт «без номера» (scripts/worker.ts): закупки у него нет.
      tenderId: regNumber === "без номера" ? null : regNumber,
      jobId: batch.context.jobId ?? null,
    },
    { ...(model === undefined ? {} : { model }), timeoutMs: GATEWAY_TIMEOUT_MS },
  );
  const parsed = parseNormPickResponse(answer.content);
  return { picks: parsed.picks, tokens: answer.tokens, malformed: parsed.malformed };
}

/** Сообщение об отказе: из JSON берётся поле error, из страницы — начало текста. */
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

/**
 * Подбор норм через прод: воркер отдаёт пачку, прод зовёт модель. Адрес — тот же `SYNC_BASE_URL`, что у `workerBillFetcher`.
 * Код ответа проверяется до разбора тела: страница 404 или ошибка шлюза — не JSON, и разбор упал бы раньше, чем назвал причину.
 */
export function remoteNormPicker(baseUrl: string): NormPicker {
  return async (batch) => {
    const response = await fetch(`${baseUrl}/api/estimate/norm-pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...workerSecretHeaders() },
      body: JSON.stringify({
        regNumber: batch.context.regNumber,
        subject: batch.context.subject,
        ...(batch.context.jobId ? { jobId: batch.context.jobId } : {}),
        items: batch.items.map((item) => ({
          id: item.id,
          workName: item.workName,
          quantity: item.quantity,
          unit: item.unit,
          ...(item.extraVolumes === undefined || item.extraVolumes.length === 0 ? {} : { extraVolumes: item.extraVolumes }),
          remark: item.remark,
          section: item.section,
          ...(item.kind === undefined ? {} : { kind: item.kind }),
          candidates: item.candidates,
          ...(item.resources === undefined || item.resources.length === 0 ? {} : { resources: item.resources }),
          ...(item.normResource === undefined ? {} : { normResource: item.normResource }),
        })),
      }),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = (await response.text()).replace(/\s+/g, " ").trim();
      throw new Error(`Прод не отдал подбор норм (HTTP ${String(response.status)}): ${describeBody(body)}`);
    }

    // Ответ пришёл по сети: поля приводятся к ожидаемым типам, чужие и кривые отбрасываются.
    const payload = (await response.json()) as { picks?: unknown; tokens?: unknown; malformed?: unknown };
    const picks: RawNormPick[] = [];
    let malformed = typeof payload.malformed === "number" ? payload.malformed : 0;
    for (const entry of Array.isArray(payload.picks) ? (payload.picks as unknown[]) : []) {
      const raw = entry as Partial<Record<keyof RawNormPick, unknown>> | null;
      if (raw === null || typeof raw !== "object" || (typeof raw.id !== "string" && typeof raw.id !== "number")) {
        malformed += 1;
        continue;
      }
      picks.push({
        id: String(raw.id),
        pick: typeof raw.pick === "string" && raw.pick !== "" ? raw.pick : null,
        demolition: raw.demolition === true,
        confidence: raw.confidence === "high" || raw.confidence === "low" ? raw.confidence : null,
        reason: typeof raw.reason === "string" ? raw.reason : "",
      });
    }
    return { picks, tokens: typeof payload.tokens === "number" ? payload.tokens : 0, malformed };
  };
}
