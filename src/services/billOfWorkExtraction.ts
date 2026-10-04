import { z } from "zod";
import { MIN_QUOTE_CHARS } from "@/domain/estimate/billExtraction";

import {
  extractBillItems,
  type BillExtractionRow,
  type RejectedBillRow,
} from "@/domain/estimate/billExtraction";
import type {
  BillOfWorkItem,
  BillOfWorkSection,
} from "@/domain/estimate/types";
import { splitIntoChunks } from "@/services/documentParser";
import { endpointHost, resolveLlmEndpoint } from "@/services/llmGateway";

/**
 * Извлечение ведомости объёмов работ из документации закупки.
 *
 * Зачем модель. Ведомость у каждого заказчика свёрстана по-своему: таблица в
 * docx, лист в xlsx, страница в pdf, иногда просто перечисление в техническом
 * задании. Колонки называются то «Ед. изм.», то «Единица», то никак; объём
 * стоит то третьей колонкой, то последней. Регулярным выражением это не
 * берётся, а модель читает такую таблицу так же, как человек.
 *
 * Где проходит граница. Модель только читает: она возвращает наименование,
 * объём, единицу и дословную цитату — и ни одной цифры не считает. Всё, что
 * модель вернула, проверяется исходным текстом в `billExtraction`: цитата
 * обязана найтись в документе, а объём — в самой цитате. Неподтверждённая
 * строка в ведомость не попадает и видна в списке отказов.
 *
 * Чего модель не делает: не подбирает расценку, не переводит единицы, не
 * складывает объёмы разных строк и не дописывает позиции, которых в документе
 * нет. Расценку подберёт поиск по ФСНБ, деньги посчитает расчёт.
 */

const billRowSchema = z.object({
  work_name: z.string().min(1),
  quantity: z.union([z.string(), z.number()]),
  unit: z.string().min(1),
  evidence_quote: z.string().min(1),
  quantity_quote: z.string().nullish(),
  // Модель присылает сюда null, когда раздела в документе нет; `.optional()`
  // такой ответ отвергал вместе со всем фрагментом.
  section: z.string().nullish(),
  // Обоснование строки: по нему расчёт отличает поставку материала от работы.
  justification: z.string().nullish(),
});

/*
  Строки разбираются поодиночке.

  На живом фрагменте модель вернула 37 строк, и одна из них не подошла под
  схему — при разборе всего ответа целиком терялись и остальные 36. Одна кривая
  строка стоит одной строки, а не документа: непрошедшие считаются и попадают в
  отчёт числом.
*/
const billResponseSchema = z.object({
  rows: z.array(z.unknown()),
  /** Есть ли в этом фрагменте ведомость вообще. */
  has_bill: z.boolean(),
});

/**
 * Сколько строк модель вправе вернуть на один фрагмент.
 *
 * Ведомость длиннее сотни строк встречается, но ответ на неё не помещается в
 * лимит выходных токенов и обрывается на середине — тогда теряется весь
 * фрагмент, а не лишние строки. Предел держит ответ целым; остаток приедет со
 * следующим фрагментом, потому что фрагменты идут подряд.
 */
export const MAX_BILL_ROWS_PER_CHUNK = 30;

/** Предел длины цитаты: длинные цитаты съедают ответ, а подтверждают то же. */
export const MAX_BILL_QUOTE_CHARS = 120;

/** Знаков текста на один вызов модели — как в разборе документов. */
const CHUNK_SIZE = 100_000;

const MAX_OUTPUT_TOKENS = 8192;

export interface BillExtractionContext {
  readonly regNumber: string;
  readonly subject: string;
}

export interface BillDocumentInput {
  readonly name: string;
  readonly text: string;
}

export interface BillExtractionReport {
  readonly sections: readonly BillOfWorkSection[];
  readonly rejected: readonly RejectedBillRow[];
  /** Документы, в которых ведомости не нашлось вовсе. */
  readonly documentsWithoutBill: readonly string[];
  /** Строк ответа, не подошедших под схему: их пропустили, а не потеряли молча. */
  readonly malformed: number;
  /** Сколько ответов модели оборвалось по лимиту токенов. */
  readonly truncatedAnswers: number;
  readonly tokensUsed: number;
  readonly processingTimeMs: number;
}

/** Вызов модели — подменяется в тестах, чтобы не ходить в сеть. */
/**
 * Что нужно, чтобы получить строки ведомости из одного фрагмента.
 *
 * Передаётся фрагмент и его окружение, а не готовый запрос к модели: запрос
 * собирается там, где живёт ключ. Иначе пришлось бы открыть наружу ручку,
 * пересылающую модели произвольный текст, — то есть бесплатный прокси к
 * платному шлюзу для любого, кто узнает адрес.
 */
export interface BillRowsRequest {
  readonly chunk: string;
  readonly context: BillExtractionContext;
  readonly documentName: string;
}

export type BillRowsFetcher = (request: BillRowsRequest) => Promise<{
  rows: BillExtractionRow[];
  hasBill: boolean;
  tokens: number;
  malformed: number;
  truncated: boolean;
}>;

export function buildBillPrompt(
  chunk: string,
  context: BillExtractionContext,
  documentName: string,
): string {
  return `Ты читаешь документацию закупки № ${context.regNumber} и ищешь в ней ведомость объёмов работ.

Предмет закупки: ${context.subject}
Документ: ${documentName}

## Что искать
Строки вида «наименование работы — объём — единица измерения». Они встречаются в ведомости объёмов работ, в локальной смете заказчика, в техническом задании и в спецификации.

## Что возвращать
Для каждой найденной строки:
- work_name: наименование работы дословно, как в документе
- quantity: объём — только число, без единицы
- unit: единица измерения, как она написана в документе
- evidence_quote: дословный фрагмент документа с наименованием работы, не длиннее ${MAX_BILL_QUOTE_CHARS} знаков
- quantity_quote: дословный фрагмент документа, в котором видно число объёма, не короче ${MIN_QUOTE_CHARS} знаков и не длиннее ${MAX_BILL_QUOTE_CHARS}
- section: раздел ведомости, если он есть в документе
- justification: обоснование строки дословно, если в таблице есть такая колонка («ГЭСН09-03-002-01», «ФСБЦ-07.2.07.12-0068», «Прайс-лист поставщика»); колонки нет — не выдумывай, пропусти поле

## Ограничения, нарушение которых обрывает разбор
- Строк не больше ${MAX_BILL_ROWS_PER_CHUNK}.
- **Обе цитаты обязаны быть дословными.** Их проверяют поиском по тексту документа: цитату, которой в тексте нет, отбрасывают вместе со строкой.
- **Не склеивай куски.** Если наименование и объём стоят в тексте далеко друг от друга (так бывает в таблицах из PDF), дай два отдельных фрагмента — каждый скопируй подряд, как он написан. Склеенный из двух мест фрагмент в тексте не найдётся, и строка пропадёт.
- **Объём обязан быть виден в quantity_quote.** Число, которого в этом фрагменте нет, отбрасывают — даже если оно верное.
- **Фрагменты не короче ${MIN_QUOTE_CHARS} знаков.** Обрывок вроде «т;12,5» встречается в таблице столько раз, сколько в ней строк с таким объёмом: по нему нельзя понять, какую строку ты привёл, и строку отбрасывают. Захвати соседний текст той же строки — кусок наименования или колонку перед числом.
- **Ничего не считай.** Не складывай объёмы, не переводи единицы, не умножай на коэффициенты. Пиши то, что написано.
- **Не достраивай ведомость.** Работы, у которой нет объёма, в ответе быть не должно. Объём «по проекту», «по факту», прочерк — это не объём, такую строку пропусти.
- Итоговые строки («Итого», «Всего по разделу») — не работы, их не возвращай.
- **Суммы — не объёмы.** Таблицы штрафов, неустоек, цен и лимитов устроены так же («наименование — число — рублей»), но работами не являются. Строку, у которой единица денежная или процент, не возвращай.
- Если ведомости в этом фрагменте нет, верни has_bill: false и пустой rows.

Верни JSON:
{"has_bill": true, "rows": [{"work_name": "...", "quantity": "...", "unit": "...", "evidence_quote": "...", "quantity_quote": "...", "section": "...", "justification": "..."}]}

## Текст документа
${chunk}`;
}

/** Разбор ответа модели. Формат тот же, что у разбора документов. */
export function parseBillResponse(raw: string): {
  rows: BillExtractionRow[];
  hasBill: boolean;
  /** Сколько строк ответа не подошли под схему и были пропущены. */
  malformed: number;
  /** Ответ оборвался по лимиту токенов, и разбор спас то, что успело приехать. */
  truncated: boolean;
} {
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  let truncated = false;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    /*
      Длинная ведомость упирается в лимит выходных токенов, и ответ обрывается
      посреди строки. Выбрасывать из-за этого весь фрагмент значит потерять три
      десятка уже приехавших позиций вместе с одной недописанной. Поэтому ответ
      обрезается по последней закрытой строке и дочитывается как есть.
    */
    const salvaged = salvageTruncated(cleaned);
    if (salvaged === null) {
      throw new Error(
        `Модель вернула не JSON при разборе ведомости; длина ответа ${String(raw.length)}, начало: ${raw.slice(0, 160).replace(/\s+/g, " ")}`,
      );
    }
    parsed = salvaged;
    truncated = true;
  }

  const result = billResponseSchema.parse(parsed);
  const rows: BillExtractionRow[] = [];
  let malformed = 0;

  for (const candidate of result.rows) {
    const row = billRowSchema.safeParse(candidate);
    if (!row.success) {
      malformed += 1;
      continue;
    }
    rows.push({
      workName: row.data.work_name,
      quantity: row.data.quantity,
      unit: row.data.unit,
      evidenceQuote: row.data.evidence_quote,
      quantityQuote: row.data.quantity_quote ?? undefined,
      section: row.data.section ?? undefined,
      justification: row.data.justification ?? undefined,
    });
  }

  return { hasBill: result.has_bill, rows, malformed, truncated };
}

/** Дочитывает оборванный ответ по последней закрытой строке ведомости. */
function salvageTruncated(cleaned: string): unknown {
  const lastClose = cleaned.lastIndexOf("}");
  if (lastClose < 0) return null;
  try {
    return JSON.parse(`${cleaned.slice(0, lastClose + 1)}]}`);
  } catch {
    return null;
  }
}

/** Обращение к шлюзу модели. Вынесено, чтобы тест подменял его целиком. */
export const fetchBillRows: BillRowsFetcher = async (request) => {
  const endpoint = resolveLlmEndpoint();
  const prompt = buildBillPrompt(
    request.chunk,
    request.context,
    request.documentName,
  );

  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    cache: "no-store",
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: "user", content: prompt }],
      // Ноль, а не 0,1: ведомость — это перепись написанного, и разброс между
      // двумя прогонами здесь означал бы разные сметы по одному документу.
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Шлюз модели ${endpointHost(endpoint.baseUrl)} ответил ${String(response.status)}: ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
    usage?: { total_tokens?: number };
  };

  const content = data.choices[0]?.message.content;
  if (!content) {
    throw new Error(
      `Шлюз модели ${endpointHost(endpoint.baseUrl)} вернул пустой ответ`,
    );
  }

  const parsed = parseBillResponse(content);
  return { ...parsed, tokens: data.usage?.total_tokens ?? 0 };
};

/**
 * Вызов модели через прод, а не напрямую.
 *
 * Так устроен и глубокий разбор: ключ языковой модели живёт только на Vercel,
 * а сервер воркера его не знает и знать не должен — это арендованная коробка,
 * и лишний платный ключ на ней ничего не улучшает. Воркер отдаёт фрагмент,
 * прод зовёт модель, строки возвращаются.
 *
 * Таймаут больше обычного: один фрагмент — сто тысяч знаков, и модель отвечает
 * на него десятками секунд.
 */
export function remoteBillRows(baseUrl: string): BillRowsFetcher {
  return async (request) => {
    const response = await fetch(`${baseUrl}/api/estimate/bill-rows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chunk: request.chunk,
        regNumber: request.context.regNumber,
        subject: request.context.subject,
        documentName: request.documentName,
      }),
      signal: AbortSignal.timeout(180_000),
    });

    /*
      Код ответа проверяется до разбора тела, а не после.

      Неудача приходит не JSON'ом: адрес без этого маршрута отдаёт страницу 404
      целиком, шлюз — свою страницу ошибки. Разбор такого тела падает первым, и
      воркер получает «Unexpected token <» вместо «прод не отдал строки, HTTP
      404» — то есть теряет ровно ту часть, по которой чинят.
    */
    if (!response.ok) {
      const body = (await response.text()).replace(/\s+/g, " ").trim();
      throw new Error(
        `Прод не отдал строки ведомости (HTTP ${String(response.status)}): ${describeBody(body)}`,
      );
    }

    const payload = (await response.json()) as {
      rows?: BillExtractionRow[];
      hasBill?: boolean;
      tokens?: number;
      malformed?: number;
      truncated?: boolean;
    };

    return {
      rows: payload.rows ?? [],
      hasBill: payload.hasBill === true,
      tokens: payload.tokens ?? 0,
      malformed: payload.malformed ?? 0,
      truncated: payload.truncated === true,
    };
  };
}

/**
 * Сообщение об отказе: из JSON берётся поле error, из страницы — начало текста.
 *
 * Страницу целиком в сообщение не тащим: журнал воркера не место для чужой
 * вёрстки, а причина видна по коду ответа и первым словам.
 */
function describeBody(body: string): string {
  if (body === "") return "пустой ответ";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error !== "") {
      return parsed.error;
    }
  } catch {
    // Не JSON — значит страница; ниже берём её начало.
  }
  return body.length > 160 ? `${body.slice(0, 160)}…` : body;
}

/**
 * Читает ведомость из набора документов закупки.
 *
 * Документы идут подряд, каждый режется на фрагменты того же размера, что и в
 * разборе документов. Позиции одного документа собираются в один раздел с его
 * именем: раздел по документу, а не по главе ведомости, потому что проверять
 * результат человек будет, открыв тот самый файл.
 */
export async function extractBillOfWork(
  documents: readonly BillDocumentInput[],
  context: BillExtractionContext,
  fetcher: BillRowsFetcher = fetchBillRows,
): Promise<BillExtractionReport> {
  const started = Date.now();
  const sections: BillOfWorkSection[] = [];
  const rejected: RejectedBillRow[] = [];
  const documentsWithoutBill: string[] = [];
  let tokensUsed = 0;
  let malformed = 0;
  let truncatedAnswers = 0;

  for (const [documentIndex, document] of documents.entries()) {
    const chunks = splitIntoChunks(document.text, CHUNK_SIZE);
    const items: BillOfWorkItem[] = [];
    let sawBill = false;

    for (const [chunkIndex, chunk] of chunks.entries()) {
      const answer = await fetcher({
        chunk,
        context,
        documentName: document.name,
      });
      tokensUsed += answer.tokens;
      malformed += answer.malformed;
      if (answer.truncated) truncatedAnswers += 1;
      if (answer.hasBill) sawBill = true;

      const extracted = extractBillItems({
        rows: answer.rows,
        sourceText: chunk,
        documentName: document.name,
        /*
          Префикс несёт номер документа и фрагмента: идентификаторы позиций из
          разных файлов иначе столкнулись бы, а по столкнувшимся нельзя понять,
          из какого файла пришёл объём.
        */
        idPrefix: `d${String(documentIndex + 1)}c${String(chunkIndex + 1)}`,
      });

      items.push(...extracted.items);
      rejected.push(...extracted.rejected);
    }

    if (items.length > 0) {
      sections.push({ title: document.name, items });
    } else if (!sawBill) {
      documentsWithoutBill.push(document.name);
    }
  }

  return {
    sections,
    rejected,
    documentsWithoutBill,
    malformed,
    truncatedAnswers,
    tokensUsed,
    processingTimeMs: Date.now() - started,
  };
}
