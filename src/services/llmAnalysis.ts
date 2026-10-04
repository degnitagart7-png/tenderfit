import { z } from "zod";
import type { AnalysisFinding } from "@/types/database";
import { isPriceKnown } from "@/domain/entities";
import { pluralRu } from "@/utils/format";
import { endpointHost, resolveLlmEndpoint } from "@/services/llmGateway";

const findingSchema = z.object({
  category: z.enum(["blocker", "risk", "requirement", "neutral"]),
  title: z.string().min(1),
  detail: z.string().min(1),
  evidence_quote: z.string().min(1),
  evidence_section: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
});

const analysisResponseSchema = z.object({
  findings: z.array(findingSchema).min(0),
  summary: z.string().min(1),
});

interface TenderContext {
  regNumber: string;
  subject: string;
  customerName: string;
  price: number;
}

interface CompanyProfileSummary {
  capabilities: string;
  restrictions: string;
}

interface AnalyzeDocumentInput {
  documentText: string;
  tenderContext: TenderContext;
  companyProfile: CompanyProfileSummary;
}

interface AnalyzeDocumentResult {
  findings: AnalysisFinding[];
  summary: string;
  tokensUsed: number;
  processingTimeMs: number;
}

/**
 * Сколько факторов модель вправе вернуть на один фрагмент документа.
 * Фрагмент — до 100 000 знаков, и без предела модель перечисляет всё подряд,
 * включая номер извещения: ответ упирается в лимит выходных токенов и обрывается.
 */
export const MAX_FINDINGS_PER_CHUNK = 15;

/** Предел длины цитаты в знаках: именно длинные цитаты съедали весь ответ. */
export const MAX_QUOTE_CHARS = 300;

/**
 * Лимит выходных токенов на один вызов.
 * 4096 не хватало: на реальном извещении 44-ФЗ (фрагмент 100 000 знаков) модель
 * обрывала JSON на середине (finish_reason=length), и разбор заканчивался ошибкой.
 * 8192 даёт запас при соблюдении ограничений ответа и не уводит вызов за бюджет времени.
 */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Промпт разбора документа закупки.
 */
export function buildAnalysisPrompt(input: AnalyzeDocumentInput): string {
  const capabilities = input.companyProfile.capabilities.trim();
  const restrictions = input.companyProfile.restrictions.trim();

  return `Ты — эксперт по анализу государственных закупок (44-ФЗ, 223-ФЗ).
Проанализируй документ закупки и найди значимые факторы.

## Контекст закупки
- Номер: ${input.tenderContext.regNumber}
- Предмет: ${input.tenderContext.subject}
- Заказчик: ${input.tenderContext.customerName}
- НМЦК: ${
    isPriceKnown(input.tenderContext.price)
      ? `${input.tenderContext.price.toLocaleString("ru-RU")} ₽`
      : "не опубликована"
  }

## Профиль компании
- Возможности: ${capabilities || "не заданы"}
- Ограничения: ${restrictions || "не заданы"}
${
  capabilities || restrictions
    ? ""
    : `
Профиль компании не передан. Не додумывай, что у неё есть или чего у неё нет:
описывай требования документа как факты, а категорию выбирай по самому требованию.
`
}
## Текст документа
${input.documentText}

## Инструкция
Найди в документе:
1. **blocker** — только то, **чем участник должен ОБЛАДАТЬ заранее** и чего у него может не быть: лицензия (ФСБ, ФСТЭК, Минобр, МЧС), членство в СРО, допуск к гостайне, требование к организационно-правовой форме. Признак блокера: если этого нет, заявку не примут, и быстро получить это нельзя.

   **НЕ блокеры** — типовые условия допуска, которые выполняет любая действующая компания и которые подтверждаются декларацией. Их ставь в категорию requirement, даже если в документе написано «участник не допускается»: отсутствие в РНП, непроведение ликвидации, отсутствие банкротства, неприостановление деятельности, отсутствие недоимки по налогам, отсутствие судимости и дисквалификации руководителя, ст. 19.28 КоАП, отсутствие в санкционных перечнях, статус иностранного агента, конфликт интересов, обеспечение заявки и обеспечение договора, аккредитация на площадке или у заказчика.

   Блокером не является и то, что относится не к допуску участника:
   - требования к третьим лицам (лицензия и рейтинг банка-гаранта, требования к
     изготовителю, к субподрядчику) — обладать этим должны не мы;
   - обязанности на этапе исполнения договора («поставщик обязан согласовать
     конструкторскую документацию с заказчиком», соответствие изделия проектной
     документации) — это работа после подписания, а не условие допуска;
   - ссылка на пункт вместо самого требования («участники должны соответствовать
     специальным требованиям, если они установлены в подразделе 8.3») — содержания
     здесь нет, проверить нечего; такой фактор не извлекай вовсе.

   Формулировка «все необходимые допуски, разрешения и лицензии» блокером не
   является: конкретная лицензия не названа. Блокер — только названная лицензия.
2. **risk** — риски контракта для исполнителя (штрафы, неустойки, односторонний отказ заказчика, казначейское сопровождение, длительная оплата, ограничения по субподряду)
3. **requirement** — обязательные требования к участникам и заявкам, которые НЕ являются блокерами (опыт работы, наличие оборудования, квалификация персонала, финансовые гарантии, типовые условия допуска из пункта 1)
4. **neutral** — нейтральная информация (контактные данные, сроки подачи, порядок рассмотрения заявок)

Для каждого фактора укажи:
- category: blocker | risk | requirement | neutral
- title: краткое название (до 10 слов)
- detail: подробное описание (1-2 предложения, не пересказ цитаты)
- evidence_quote: точная цитата из документа, не длиннее ${MAX_QUOTE_CHARS} знаков
- evidence_section: раздел документа, где найдено
- severity: high | medium | low

## Ограничения ответа
Их нарушение обрывает JSON на середине, и разбор пропадает впустую:
- Факторов не больше ${MAX_FINDINGS_PER_CHUNK} — только те, что влияют на решение об участии.
- Порядок: сначала blocker и risk, затем requirement, neutral — в последнюю очередь.
- Служебная информация фактором не считается: номер извещения, реквизиты и контакты,
  адреса площадок, перечень приложений, названия разделов. Такую в neutral не пиши.
- **Пустой бланк — не требование.** Если документ является формой или образцом для
  заполнения (незаполненные поля, прочерки, «_____», «(наименование организации)»,
  заголовки вроде «ФОРМА», «ОБРАЗЕЦ»), он описывает, что участник впишет сам, а не
  то, что от него требуют. Факторов из таких документов не извлекай вовсе.
- Цитаты не склеивай и не пересказывай: одна строка — одна цитата из текста.

Ответь СТРОГО в формате JSON:
{
  "findings": [...],
  "summary": "Общее резюме по документу (2-3 предложения)"
}`;
}

/**
 * Снимает ограждение кода (```json ... ``` или ``` ... ```) с ответа модели.
 */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return fenceMatch ? fenceMatch[1]!.trim() : trimmed;
}

/**
 * Разбирает и проверяет ответ модели.
 *
 * meta.finish_reason нужен для диагностики: повторить вызов модели можно только
 * оттуда, где шлюз отвечает, а отвечает он не отовсюду (OpenRouter локально
 * блокировался прокси), поэтому причина отказа обязана попадать в
 * analysis_jobs.error_message целиком.
 */
export function parseAnalysisResponse(
  raw: string,
  meta: { finishReason?: string | null } = {},
): {
  findings: AnalysisFinding[];
  summary: string;
} {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(describeParseFailure(raw, meta.finishReason ?? null));
  }

  const result = analysisResponseSchema.parse(parsed);
  return {
    findings: result.findings as AnalysisFinding[],
    summary: result.summary,
  };
}

/** Что именно не так с ответом модели: обрезан, не JSON, и как выглядит край текста. */
function describeParseFailure(
  raw: string,
  finishReason: string | null,
): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const parts = [
    finishReason === "length"
      ? "Ответ модели обрезан по лимиту выходных токенов"
      : "Невалидный JSON от AI-модели",
    `finish_reason=${finishReason ?? "не передан"}`,
    `длина ответа ${raw.length} ${pluralRu(raw.length, ["знак", "знака", "знаков"])}`,
    `начало: ${oneLine(raw.slice(0, 160))}`,
    `конец: ${oneLine(raw.slice(-160))}`,
  ];
  return `${parts.join("; ")}.`;
}

/**
 * Разбирает документ через языковую модель.
 *
 * Шлюз, ключ и модель приходят из окружения (`llmGateway`): протокол у OpenRouter
 * и у российского routerai.ru один, поэтому различается только адрес.
 */
export async function analyzeDocumentWithLlm(
  input: AnalyzeDocumentInput,
): Promise<AnalyzeDocumentResult> {
  const endpoint = resolveLlmEndpoint();
  const prompt = buildAnalysisPrompt(input);
  const startTime = Date.now();

  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    // Next.js кэширует fetch по URL без учёта тела запроса: без no-store второй
    // документ получил бы разбор первого, а повторный вызов воркера — те же
    // факторы за 10 мс вместо реального обращения к модели.
    cache: "no-store",
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Хост в сообщении обязателен: 402 «недостаточно средств» и 403 «не пускает
    // из этой сети» лечатся по-разному, а без хоста неясно, кто именно отказал.
    throw new Error(
      `Шлюз модели ${endpointHost(endpoint.baseUrl)} ответил ${response.status}: ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    choices: { message: { content: string }; finish_reason?: string | null }[];
    usage: { total_tokens: number };
  };

  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content)
    throw new Error(
      `Шлюз модели ${endpointHost(endpoint.baseUrl)} вернул пустой ответ`,
    );

  const parsed = parseAnalysisResponse(content, {
    finishReason: choice?.finish_reason ?? null,
  });
  const processingTimeMs = Date.now() - startTime;

  return {
    findings: parsed.findings,
    summary: parsed.summary,
    tokensUsed: data.usage?.total_tokens ?? 0,
    processingTimeMs,
  };
}
