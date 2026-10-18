import { extractLlmJson } from "@/lib/llmJson";
import { z } from "zod";
import { FINDING_REQUIREMENT_KINDS, type AnalysisFinding, type TenderLaw } from "@/types/database";
import { isPriceKnown } from "@/domain/entities";
import { buildNotAFindingGuide } from "@/domain/findingNoise";
import { pluralRu } from "@/utils/format";
import { endpointHost, resolveLlmEndpoint } from "@/services/llmGateway";
import { noteLlmGatewayResponse } from "@/services/llmBalanceTrigger";
import { recordLlmCall, usageIncludeFields } from "@/services/llmUsage";

/*
  Схема снисходительна к мелочам, но не к сути. Живой сбой: модель пропустила
  severity у одного фактора из пятнадцати, и строгая схема выбросила весь
  фрагмент вместе с остальными четырнадцатью — разбор упал целиком. Теперь
  недостающая важность становится «medium», а фактор без категории или
  названия отбрасывается один, не утягивая соседей.
*/
const findingSchema = z.object({
  category: z.enum(["blocker", "risk", "requirement", "neutral"]),
  title: z.string().min(1),
  detail: z.string().catch(""),
  evidence_quote: z.string().catch(""),
  evidence_section: z.string().catch(""),
  severity: z.enum(["high", "medium", "low"]).catch("medium"),
  requirement_kind: z.enum(FINDING_REQUIREMENT_KINDS).nullable().optional().catch(null),
  required_value: z.string().nullable().optional().catch(null),
});

const analysisResponseSchema = z.object({
  findings: z.array(z.unknown()),
  summary: z.string().catch(""),
});

interface TenderContext {
  regNumber: string;
  subject: string;
  customerName: string;
  price: number;
  /** Закон закупки: по нему модель отличает норму закона от отклонения. */
  law?: TenderLaw | null;
}

interface CompanyProfileSummary {
  capabilities: string;
  restrictions: string;
}

interface AnalyzeDocumentInput {
  documentText: string;
  tenderContext: TenderContext;
  companyProfile: CompanyProfileSummary;
  /**
   * К чему отнести расход на вызов: закупка и задание анализа. Без него строка
   * журнала llm_usage_log пишется без привязки.
   */
  usageContext?: { tenderId?: string | null; jobId?: string | null };
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
 * 8192 давал запас для Gemini, но не для Haiku: она тратит на русский текст заметно
 * больше токенов, и 12.10.2026 ответ оборвался на 9 693 знаках — «Разбор не выполнен»
 * у пользователя. 24 000 — с тройным запасом; обычный ответ (до 15 факторов) втрое короче,
 * а лишнего лимит не стоит: платим за фактически выданные токены.
 */
const MAX_OUTPUT_TOKENS = 24_000;

/** Пометка к выводу, собранному из оборванного ответа. */
export const TRUNCATED_ANALYSIS_NOTE =
  "Ответ модели оборвался по лимиту длины — показаны факторы, разобранные до обрыва.";

/**
 * Факторы из оборванного ответа: целые объекты массива `findings` до места обрыва.
 *
 * Обрыв по лимиту выходных токенов раньше превращал весь разбор в ошибку, хотя
 * десяток факторов к тому моменту был выдан полностью. Здесь массив проходится
 * посимвольно (с учётом строк и экранирования), и берутся только объекты,
 * закрытые своей скобкой; недописанный последний отбрасывается.
 */
export function salvageTruncatedFindings(text: string): unknown[] {
  const key = text.search(/"findings"\s*:\s*\[/);
  if (key < 0) return [];
  let i = text.indexOf("[", key) + 1;
  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          items.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // Объект не разобрался — пропускаем только его.
        }
        start = -1;
      }
    } else if (ch === "]" && depth === 0) break;
  }
  return items;
}

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
- Закон: ${input.tenderContext.law ?? "не указан"}
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

${buildNotAFindingGuide(input.tenderContext.law)}

## Инструкция
Найди в документе:
1. **blocker** — только то, **чем участник должен ОБЛАДАТЬ заранее** и чего у него может не быть: лицензия (ФСБ, ФСТЭК, Минобр, МЧС), членство в СРО, допуск к гостайне, требование к организационно-правовой форме. Признак блокера: если этого нет, заявку не примут, и быстро получить это нельзя.

   **НЕ блокеры** — типовые условия допуска, которые выполняет любая действующая компания и которые подтверждаются декларацией: отсутствие в РНП, непроведение ликвидации, отсутствие банкротства, неприостановление деятельности, отсутствие недоимки по налогам, отсутствие судимости и дисквалификации руководителя, ст. 19.28 КоАП, отсутствие в санкционных перечнях, статус иностранного агента, конфликт интересов. Их не извлекай вовсе (раздел «Что НЕ является находкой»). Обеспечение заявки и договора, аккредитация на площадке или у заказчика — тоже не блокеры: ставь их в requirement.

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
2. **risk** — риски контракта для исполнителя: условия договора, которые отклоняются от нормы закона и обычая и могут стоить подрядчику денег или контракта (повышенные штрафы и неустойки, оплата дольше обычного, отсутствие аванса при длинных работах, ограничения по субподряду, тяжёлые гарантийные условия). Типовое для закона закупки риском не является — см. раздел «Что НЕ является находкой» ниже.
   Риск — это условие договора, которое может стоить подрядчику денег или контракта. Сведения из сметы и обоснования НМЦК (НДС, индекс инфляции, непредвиденные затраты, коэффициенты, метод и уровень цен) — не риски: пиши их в neutral. «Длительной» оплату называй только когда она дольше 15 рабочих дней (по 44-ФЗ — дольше 10: это уже нарушение закона, пиши так); оплата за 7 рабочих дней — это быстро, не риск. Одно и то же условие из разных пунктов давай одним фактором.
3. **requirement** — обязательные требования к участникам и заявкам, которые НЕ являются блокерами (опыт работы, наличие оборудования, квалификация персонала, финансовые гарантии, типовые условия допуска из пункта 1)
4. **neutral** — нейтральная информация (контактные данные, сроки подачи, порядок рассмотрения заявок)

Для каждого фактора укажи:
- category: blocker | risk | requirement | neutral
- title: краткое название (до 10 слов)
- detail: пояснение простым языком для директора небольшой строительной фирмы —
  1–2 предложения о том, чем это грозит в деньгах или сроках, без канцелярита.
  Не пересказывай цитату, а объясни последствие для подрядчика. Плохо: «Предусмотрена
  ответственность Подрядчика за нарушение сроков в соответствии с условиями Контракта».
  Хорошо: «За каждый день просрочки заказчик начислит пеню от цены контракта, поэтому
  в графике нужен запас времени». Числа (проценты, дни, суммы) бери из документа, свои не придумывай.
- evidence_quote: точная цитата из документа, не длиннее ${MAX_QUOTE_CHARS} знаков
- evidence_section: раздел документа, где найдено
- severity: high | medium | low

Для blocker и requirement дополнительно — по ним требование сверяется с
профилем компании, поэтому значение должно быть конкретным:
- requirement_kind: LICENSE (лицензия) | SRO (членство в СРО) | EXPERIENCE (опыт
  исполненных контрактов) | QUALIFIED_PERSONNEL (специалисты, НРС, НОПРИЗ,
  квалификация) | EQUIPMENT (оборудование, техника, производственная база) |
  SMP (только субъекты малого предпринимательства) | SECURITY (обеспечение заявки
  или договора) | DECLARATION (типовые условия допуска из пункта 1, которые
  подтверждаются декларацией) | OTHER
- required_value: что именно требуется, с числами и названиями из документа:
  «лицензия МЧС на монтаж средств обеспечения пожарной безопасности»,
  «СРО в области строительства, уровень ответственности не ниже 2»,
  «опыт исполнения одного контракта не менее 20% НМЦК за 3 года»,
  «не менее 2 специалистов в НРС». Для risk и neutral оба поля — null.

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
  const cleaned = extractLlmJson(stripMarkdownFences(raw));
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Ответ оборван по длине, но часть факторов выдана целиком — показываем их, а не ошибку.
    const salvaged = meta.finishReason === "length" ? salvageTruncatedFindings(cleaned) : [];
    const findings = salvaged.flatMap((item) => {
      const finding = findingSchema.safeParse(item);
      return finding.success ? [finding.data as AnalysisFinding] : [];
    });
    if (findings.length > 0) return { findings, summary: TRUNCATED_ANALYSIS_NOTE };
    throw new Error(describeParseFailure(raw, meta.finishReason ?? null));
  }

  const result = analysisResponseSchema.parse(parsed);
  const findings: AnalysisFinding[] = [];
  for (const raw of result.findings) {
    const finding = findingSchema.safeParse(raw);
    if (finding.success) findings.push(finding.data as AnalysisFinding);
  }
  return { findings, summary: result.summary };
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

  // Расход пишется на любом исходе: у неудачного вызова токены могли быть
  // списаны (ответ пришёл, но не разобрался), и в сумме они нужны.
  let usage: unknown;
  let failure: string | null = null;

  try {
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
        ...usageIncludeFields(),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 402 «кончились деньги»: письмо владельцу уходит сразу, не дожидаясь проверки воркера.
      noteLlmGatewayResponse(response.status, errorText);
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
    usage = data.usage;

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
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await recordLlmCall(
      {
        purpose: "deep_analysis",
        tenderId: input.usageContext?.tenderId ?? input.tenderContext.regNumber,
        jobId: input.usageContext?.jobId ?? null,
      },
      {
        model: endpoint.model,
        usage,
        inputChars: prompt.length,
        ok: failure === null,
        error: failure,
      },
    );
  }
}
