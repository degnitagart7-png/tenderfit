import { extractLlmJson } from "@/lib/llmJson";
import { z } from "zod";
import { workerSecretHeaders } from "@/lib/workerSecret";
import { MIN_QUOTE_CHARS } from "@/domain/estimate/billExtraction";

import {
  countRejections,
  emptyExtractionStats,
  extractBillItems,
  type BillExtractionRow,
  type BillExtractionStats,
  type BillRejectionReason,
  type RejectedBillRow,
} from "@/domain/estimate/billExtraction";
import { dedupeItemsAcrossDocuments } from "@/domain/estimate/billDedupe";
import { readAllDocuments, selectDocumentForModel, type SkippedDocument } from "@/domain/estimate/documentRelevance";
import { billItemKey, readBillTables } from "@/domain/estimate/billTable";
import {
  checkContractAgainstLsr,
  contractBill,
  parseContractEstimates,
  type ContractCheck,
} from "@/domain/estimate/contractEstimate";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { buildLsrSet, lsrSourceInfo, type LsrSourceInfo } from "@/domain/estimate/customerLsrSet";
import type {
  BillOfWorkItem,
  BillOfWorkSection,
  VolumeSource,
  VolumeSourceLevel,
} from "@/domain/estimate/types";
import { sectionAt, sectionHeadings } from "@/domain/estimate/customerEstimate";
import { declaresCurrentPrices } from "@/domain/estimate/customerPrice";
import {
  chooseVolumeSource,
  classifyDocument,
  documentHeadings,
  hasBillSignal,
  headingInfoAt,
  FORM_421_RANK,
  volumeRank,
} from "@/domain/estimate/volumeSource";
import { splitIntoChunks } from "@/services/documentParser";
import { endpointHost, resolveLlmEndpoint } from "@/services/llmGateway";
import { cachedLlmChat, usageTokens, type GatewayChatAnswer } from "@/services/llmResponseCache";
import { noteLlmGatewayResponse } from "@/services/llmBalanceTrigger";
import { recordLlmCall, usageIncludeFields } from "@/services/llmUsage";

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
  Строки разбираются поодиночке, а ответ читается снисходительно.

  На живом фрагменте модель вернула 37 строк, и одна из них не подошла под
  схему — при разборе всего ответа целиком терялись и остальные 36. Одна кривая
  строка стоит одной строки, а не документа: непрошедшие считаются и попадают в
  отчёт числом.

  То же с оболочкой ответа. Закупка 32616409061 целиком не посчиталась: модель
  прислала не массив там, где ждали массив, и разбор схемой отдал прод как HTTP 502.
  Теперь оболочка нормализуется (`normalizeBillAnswer`): массив верхнего уровня,
  `rows: null`, `rows: {…}` вместо массива — всё это читается, а не роняет фрагмент.
*/

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

/**
 * Лимит выходных токенов. 8192 хватало Gemini; Haiku тратит на русский текст больше
 * токенов, и 30 строк с цитатами упирались в лимит — фрагмент делился пополам и
 * читался дважды (двойная плата). 16 000 — с запасом; платим за выданные токены.
 */
const MAX_OUTPUT_TOKENS = 16_000;

export interface BillExtractionContext {
  readonly regNumber: string;
  readonly subject: string;
  /** Задание расчёта (sync_jobs.id): к нему относится расход в llm_usage_log. */
  readonly jobId?: string | null;
}

export interface BillDocumentInput {
  readonly name: string;
  readonly text: string;
}

export interface BillExtractionReport {
  readonly sections: readonly BillOfWorkSection[];
  readonly rejected: readonly RejectedBillRow[];
  /** Сколько строк отказано по каждой причине (по всем документам, включая LOWER_SOURCE); без отказов причина не перечисляется. */
  readonly rejectedByReason: Readonly<Partial<Record<BillRejectionReason, number>>>;
  /**
   * Сколько строк модели принято по послаблению, а не по буквальному совпадению: единица восстановлена из строки,
   * короткий фрагмент объёма подтверждён строкой таблицы, объём совпал после пересчёта единиц или по арифметике строки.
   */
  readonly relaxedAccepted: Readonly<BillExtractionStats>;
  /** Документы, в которых ведомости не нашлось вовсе (их читала модель). */
  readonly documentsWithoutBill: readonly string[];
  /**
   * Документы и файлы архивов, которые модель НЕ читала: объёмов в них не видно (проект контракта, требования к заявке, формы,
   * протоколы — `documentRelevance.ts`). Это не «ведомости нет», а «не смотрели»: так пользователь и бенчмарк видят, что осталось
   * непрочитанным. Пусто — читалось всё (или включён `ESTIMATE_READ_ALL_DOCUMENTS=1`).
   */
  readonly skippedNoVolumes: readonly SkippedDocument[];
  /** Строк ответа, не подошедших под схему: их пропустили, а не потеряли молча. */
  readonly malformed: number;
  /** Сколько ответов модели оборвалось по лимиту токенов (каждый такой ответ перезапрашивался половинами). */
  readonly truncatedAnswers: number;
  /**
   * Сколько раз фрагмент делился пополам из-за неполного ответа: оборванного по токенам или упёршегося в
   * предел строк (`MAX_BILL_ROWS_PER_CHUNK`).
   */
  readonly splitAnswers: number;
  /**
   * Куски, ответ на которые остался неполным и после деления на предельной глубине: строки из них могли
   * потеряться. Ноль — потери нет. Не ноль — об этом обязан сказать отчёт, а не молчать.
   */
  readonly incompleteAnswers: number;
  /**
   * Фрагменты, которые модель не прочитала даже со второй попытки (шлюз, прод, ответ не в формате): строки из них потеряны,
   * но расчёт идёт дальше. Каждый — пробел сметы `BILL_CHUNK_UNREAD`, а не молчаливая потеря и не отказ всего расчёта.
   */
  readonly unreadChunks: readonly UnreadChunk[];
  readonly tokensUsed: number;
  readonly processingTimeMs: number;
  /**
   * Откуда взяты объёмы расчёта. null — ни одной подтверждённой строки нет ни на
   * одном уровне.
   */
  readonly volumeSource: VolumeSource | null;
  /**
   * Строки сметы заказчика, когда объёмы взяты из ведомости: в расчёт они не идут,
   * но подсказывают шифры расценок и дают сверку объёмов.
   */
  readonly customerReference: readonly BillOfWorkItem[];
  /**
   * Строки ведомости, когда объёмы взяты из ЛСР формы 421/пр (она выше ведомости): в расчёт не идут, нужны для
   * обратной сверки «ведомость против сметы заказчика» (`findBillDiscrepancies`). Пусто, если ведомость не читалась
   * или источник — не ЛСР формы 421/пр.
   */
  readonly billReference: readonly BillOfWorkItem[];
  /** Уровень каждого документа и причина, по которой он так определён. */
  readonly documentLevels: readonly {
    readonly name: string;
    readonly level: VolumeSourceLevel;
    readonly reason: string;
  }[];
  /** Документы, попавшие в набор дважды (текст тот же): считались один раз. */
  readonly duplicateDocuments: readonly { readonly name: string; readonly duplicateOf: string }[];
  /**
   * Локальные сметы заказчика (форма 421/пр), прочитанные кодом, — по одной на смету, без повторов
   * между документами. Из них, если они стали источником, построена ведомость; модель по таким документам не звалась.
   */
  readonly customerLsrs: readonly LsrSourceInfo[];
  /** Пометки о сметах: «ЛСР 02-02-07 найдена в 2 документах, взята из …», «номер повторяется». */
  readonly lsrNotes: readonly string[];
  /** Сверка сметы контракта с ЛСР; null — смет контракта или ЛСР в документации нет. */
  readonly contractCheck: ContractCheck | null;
}

/** Фрагмент документа, не прочитанный моделью: номер с единицы, как его видит человек в отчёте. */
export interface UnreadChunk {
  readonly document: string;
  /** Номер фрагмента документа (с 1); у делёного фрагмента — «3.2»: третий, вторая половина и т. д. */
  readonly chunk: string;
  /** Почему не прочитан: текст последней ошибки. */
  readonly reason: string;
  /** Готовая фраза для отчёта: «фрагмент 2 документа X не прочитан моделью: …». */
  readonly message: string;
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
- section: заголовок раздела или таблицы, под которым стоит строка, дословно («Раздел 2. Прочие работы», «Таблица 4 — Ведомость потребности машин…»); заголовка нет — пропусти поле
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
- **Таблицы потребности** в машинах, механизмах, кадрах, средствах защиты и инструменте, графики и календарные планы — не работы: строки из них не возвращай.
- **Единицу и объём пиши как напечатано**, даже если распознавание их исказило («100 m3», «мз», «1т груза»). Парное значение («103,65/82,92» при «м3/т») верни как есть, одной строкой. Не переводи «2,2 кг» в «0,0022 т»: объём 2,2, единица кг.
- **Множитель — часть единицы.** Единицу копируй целиком, как напечатана, вместе с множителем: «100 м2», «1000 м3», «10 м3», «100 м», «100 шт», «1000 шт», «10 компл». Строка «Оклейка стен обоями … 100 м2 0,899» — это unit = «100 м2» и quantity = 0,899; никогда не отбрасывай «100» и не пересчитывай объём в 89,9 м2.
- **Подписи колонок — не единица и не объём.** Никогда не возвращай заголовок колонки («ед. изм.», «единица измерения», «Ед.», «Кол-во») в unit или quantity: единица — это значение из строки («кг», «м2», «шт»); не нашёл её в строке — пропусти строку.
- **Цитируй строку так, как она напечатана**, от наименования до объёма и единицы: не переставляй ячейки, не добавляй разделители и не правь числа. В таблице с короткими ячейками («2», «12,5») бери в quantity_quote ячейку вместе с соседней ячейкой той же строки (единица или кусок наименования).
- **Суммы — не объёмы.** Таблицы штрафов, неустоек, цен и лимитов устроены так же («наименование — число — рублей»), но работами не являются. Строку, у которой единица денежная или процент, не возвращай.
- Если ведомости в этом фрагменте нет, верни has_bill: false и пустой rows.

Верни JSON:
{"has_bill": true, "rows": [{"work_name": "...", "quantity": "...", "unit": "...", "evidence_quote": "...", "quantity_quote": "...", "section": "...", "justification": "..."}]}

## Текст документа
${chunk}`;
}

/** Обычный объект, а не массив и не null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Похоже на строку ведомости: есть хоть одно из полей, которые просили у модели. */
function looksLikeRow(value: Record<string, unknown>): boolean {
  return "work_name" in value || "evidence_quote" in value || "quantity" in value;
}

/**
 * Список строк из того, что модель прислала в поле `rows` (или вместо всего ответа).
 *
 * Массив — как есть. null и отсутствие поля — строк нет. Одна строка объектом — список из неё. Словарь строк
 * («{"1": {…}, "2": {…}}») — его значения. Скаляр — одна непрошедшая строка. Что не строка, разбирается дальше
 * поодиночке и считается как `malformed`.
 */
function rowsFrom(value: unknown): { candidates: unknown[]; bad: number } {
  if (Array.isArray(value)) return { candidates: value, bad: 0 };
  if (value === null || value === undefined) return { candidates: [], bad: 0 };
  if (isRecord(value)) {
    if (looksLikeRow(value)) return { candidates: [value], bad: 0 };
    const values = Object.values(value);
    if (values.length > 0 && values.every(isRecord)) return { candidates: values, bad: 0 };
    return { candidates: [], bad: values.length === 0 ? 0 : 1 };
  }
  return { candidates: [], bad: value === "" ? 0 : 1 };
}

/**
 * Приводит разобранный JSON ответа к виду «строки + признак ведомости». Не бросает на форме ответа: падает
 * только то, что вообще не объект и не массив.
 */
function normalizeBillAnswer(parsed: unknown): { candidates: unknown[]; bad: number; hasBill: boolean } {
  if (Array.isArray(parsed)) {
    const { candidates, bad } = rowsFrom(parsed);
    return { candidates, bad, hasBill: candidates.length > 0 };
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `Модель вернула не объект и не массив при разборе ведомости (${parsed === null ? "null" : typeof parsed}): ожидался {"has_bill": …, "rows": […]}`,
    );
  }
  const { candidates, bad } = rowsFrom(parsed.rows);
  const flag = parsed.has_bill;
  // Признак не булев («true», 1, пропущен): строки в ответе говорят сами за себя.
  const hasBill =
    typeof flag === "boolean" ? flag : flag === "true" || flag === 1 || candidates.length > 0;
  return { candidates, bad, hasBill };
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
  const cleaned = extractLlmJson(raw);

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

  const answer = normalizeBillAnswer(parsed);
  const rows: BillExtractionRow[] = [];
  let malformed = answer.bad;

  for (const candidate of answer.candidates) {
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

  return { hasBill: answer.hasBill, rows, malformed, truncated };
}

/** Дочитывает оборванный ответ по последней закрытой строке ведомости. */
function salvageTruncated(cleaned: string): unknown {
  const lastClose = cleaned.lastIndexOf("}");
  if (lastClose < 0) return null;
  const head = cleaned.slice(0, lastClose + 1);
  // Ответ-массив закрывается одной скобкой, ответ-объект — двумя; неизвестно, какой, поэтому пробуются оба замыкания.
  const closers = cleaned.trimStart().startsWith("[") ? ["]", "]}"] : ["]}", "}", "]"];
  for (const closer of closers) {
    try {
      return JSON.parse(`${head}${closer}`);
    } catch {
      // Следующее замыкание.
    }
  }
  return null;
}

/**
 * Один вызов шлюза за ведомостью: запрос, учёт расхода, ответ как есть. Разбор ответа здесь тоже идёт — но ради учёта: ответ,
 * который не прочитался, пишется в журнал расхода с ok = false, как и раньше. Кэш (`llmResponseCache.ts`) вызывает это только на промахе.
 */
async function callBillGateway(prompt: string, request: BillRowsRequest): Promise<GatewayChatAnswer> {
  const endpoint = resolveLlmEndpoint();

  // Расход пишется на любом исходе: токены неудачного вызова тоже могли списаться.
  let usage: unknown;
  let failure: string | null = null;

  try {
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
        ...usageIncludeFields(),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 402 «кончились деньги»: письмо владельцу уходит сразу, не дожидаясь проверки воркера.
      noteLlmGatewayResponse(response.status, errorText);
      throw new Error(
        `Шлюз модели ${endpointHost(endpoint.baseUrl)} ответил ${String(response.status)}: ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      choices: { message: { content: string }; finish_reason?: string | null }[];
      usage?: { total_tokens?: number };
    };
    usage = data.usage;

    const content = data.choices[0]?.message.content;
    if (!content) {
      throw new Error(
        `Шлюз модели ${endpointHost(endpoint.baseUrl)} вернул пустой ответ`,
      );
    }

    // Только проверка: не читается — ошибка и ok = false в журнале, а в кэш такой ответ не попадёт.
    parseBillResponse(content);
    return {
      content,
      tokens: data.usage?.total_tokens ?? 0,
      ...usageTokens(data.usage),
      finishReason: data.choices[0]?.finish_reason ?? null,
    };
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await recordLlmCall(
      {
        purpose: "estimate_bill",
        // Расчёт по присланным файлам идёт «без номера» (scripts/worker.ts): закупки у него нет.
        tenderId: request.context.regNumber === "без номера" ? null : request.context.regNumber,
        jobId: request.context.jobId ?? null,
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

/**
 * Обращение к шлюзу модели. Вынесено, чтобы тест подменял его целиком.
 *
 * Идёт через кэш ответов (`llmResponseCache.ts`): тот же фрагмент того же документа с тем же промптом и моделью не оплачивается
 * второй раз — ни в следующем круге бенчмарка, ни при пересчёте. Кэшируется только полный ответ: оборванный по токенам
 * (`finish_reason: length` или починенный разбором `truncated`) читается заново.
 */
export const fetchBillRows: BillRowsFetcher = async (request) => {
  const prompt = buildBillPrompt(
    request.chunk,
    request.context,
    request.documentName,
  );

  const answer = await cachedLlmChat({
    purpose: "estimate_bill",
    // Ключ нужен и на попадании: без него расчёт упал бы так же, как раньше, а не «работал бы, пока кэш полон».
    model: resolveLlmEndpoint().model,
    messages: [{ role: "user", content: prompt }],
    call: () => callBillGateway(prompt, request),
    validate: (content) => !parseBillResponse(content).truncated,
  });

  const parsed = parseBillResponse(answer.content);
  return { ...parsed, tokens: answer.tokens };
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
      headers: { "Content-Type": "application/json", ...workerSecretHeaders() },
      body: JSON.stringify({
        chunk: request.chunk,
        regNumber: request.context.regNumber,
        subject: request.context.subject,
        documentName: request.documentName,
        ...(request.context.jobId ? { jobId: request.context.jobId } : {}),
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
      rows?: unknown;
      hasBill?: boolean;
      tokens?: number;
      malformed?: number;
      truncated?: boolean;
    };

    return {
      // Старый или кривой ответ прода: `rows` не массив — строк нет, а не «rows is not iterable» посреди расчёта.
      rows: Array.isArray(payload.rows) ? (payload.rows as BillExtractionRow[]) : [],
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

/** Текст для сравнения на дубль: пробелы и регистр не различают копии одного файла. */
function textKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Имя файла без пути и регистра: «архив/7. Смета.pdf» и «7. смета.pdf» — один файл. */
function fileKey(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.trim().toLowerCase();
}

/** Метка файла внутри архива в тексте документа: «=== имя ===» отдельной строкой. */
const ENTRY_MARK = /^=== (.+) ===[ \t]*$/gm;

/**
 * Убирает из набора документов повторы одного и того же файла.
 *
 * Бывает две картины. Файл приложен дважды (два документа с тем же именем и тем
 * же текстом). Или файл лежит и сам по себе, и внутри архива: текст архива —
 * это его файлы подряд под метками «=== имя ===», и один из них совпадает со
 * стоящим рядом документом. Объёмы такого файла дважды удвоили бы смету, а
 * модель за второй прогон взяла бы деньги ещё раз.
 *
 * Файл признаётся тем же, когда совпали и имя (без пути), и текст. Разные имена
 * при одинаковом тексте — разные документы: это могут быть два заказчика с
 * одинаковым типовым приложением.
 *
 * Остаётся первое вхождение. Повтор внутри архива вырезается из его текста.
 */
export function dedupeDocuments(documents: readonly BillDocumentInput[]): {
  documents: BillDocumentInput[];
  duplicates: { name: string; duplicateOf: string }[];
} {
  const seen = new Map<string, string>();
  const kept: BillDocumentInput[] = [];
  const duplicates: { name: string; duplicateOf: string }[] = [];

  for (const document of documents) {
    const wholeKey = `${fileKey(document.name)}|${textKey(document.text)}`;
    const first = textKey(document.text) === "" ? undefined : seen.get(wholeKey);
    if (first !== undefined) {
      duplicates.push({ name: document.name, duplicateOf: first });
      continue;
    }
    seen.set(wholeKey, document.name);

    const marks = [...document.text.matchAll(ENTRY_MARK)];
    if (marks.length === 0) {
      kept.push(document);
      continue;
    }

    // Текст архива режется по меткам; повтор уже виденного файла из него убирается.
    let text = document.text.slice(0, marks[0]?.index ?? 0);
    for (const [index, mark] of marks.entries()) {
      const start = mark.index;
      const end = marks[index + 1]?.index ?? document.text.length;
      const entryName = mark[1] as string;
      const body = document.text.slice(start + mark[0].length, end);
      const key = `${fileKey(entryName)}|${textKey(body)}`;
      const earlier = textKey(body) === "" ? undefined : seen.get(key);
      if (earlier !== undefined && earlier !== document.name) {
        duplicates.push({ name: `${entryName} (в ${document.name})`, duplicateOf: earlier });
        continue;
      }
      seen.set(key, `${entryName} (в ${document.name})`);
      text += document.text.slice(start, end);
    }
    kept.push({ ...document, text });
  }

  return { documents: kept, duplicates };
}

/**
 * Строка для отчёта о пропущенных без объёмов документах: сколько и какие, с причиной первого. Подробности по каждому —
 * в `skippedNoVolumes`; в заметку не кладётся весь список, чтобы она не превращалась в простыню на архиве из полусотни файлов.
 */
export function skippedNoVolumeNotes(skipped: readonly SkippedDocument[]): string[] {
  if (skipped.length === 0) return [];
  const MAX_NAMES = 5;
  const names = skipped.slice(0, MAX_NAMES).map((item) => `«${item.name}»`).join(", ");
  const rest = skipped.length > MAX_NAMES ? ` и ещё ${String(skipped.length - MAX_NAMES)}` : "";
  return [
    `Модель не читала ${String(skipped.length)} док. без объёмов (проект контракта, требования к заявке, формы и т. п.): ${names}${rest}. ` +
      `Причина первого: ${skipped[0]?.reason ?? ""}`,
  ];
}

const LEVEL_OF_SOURCE_LABEL: Readonly<Record<VolumeSourceLevel, string>> = {
  BILL: "ведомости объёмов работ",
  CUSTOMER_ESTIMATE: "сметы заказчика",
  CONTRACT_ESTIMATE: "сметы контракта",
  SPEC: "ТЗ, спецификации или таблицы проекта",
};

/** Предельная глубина деления фрагмента с неполным ответом: 1 → 2 → 4 → 8 кусков. */
export const MAX_SPLIT_DEPTH = 3;
/** Короче этого фрагмент не делится: половина уже меньше любой таблицы. */
const MIN_SPLIT_CHARS = 1_500;

type BillAnswer = Awaited<ReturnType<BillRowsFetcher>>;

/**
 * Ответ неполный: оборван по лимиту выходных токенов или упёрся в предел строк.
 *
 * Второй случай — не оборванный JSON, а послушная модель: ей сказано вернуть не больше
 * `MAX_BILL_ROWS_PER_CHUNK` строк, и ведомость из 53 строк в одном фрагменте отдаёт 30.
 * Остальные «приедут со следующим фрагментом» только у документа длиннее ста тысяч знаков;
 * у короткого следующего нет, и строки пропадают тихо.
 */
function isIncomplete(answer: BillAnswer): boolean {
  return answer.truncated || answer.rows.length + answer.malformed >= MAX_BILL_ROWS_PER_CHUNK;
}

/** Где резать фрагмент: ближайший перенос строки после середины, иначе сама середина. */
function splitPoint(chunk: string): number {
  const middle = Math.floor(chunk.length / 2);
  const newline = chunk.indexOf("\n", middle);
  return newline > 0 && newline < chunk.length - 1 ? newline + 1 : middle;
}

/** Кусок текста документа и ответ модели по нему; `offset` — где кусок начинается в документе. */
interface Piece {
  readonly chunk: string;
  readonly offset: number;
  readonly answer: BillAnswer;
  /** Ответ неполон и после деления: глубина кончилась. */
  readonly incomplete: boolean;
  /** Модель не ответила и со второй попытки: причина. Ответ пуст, строк из этого куска нет. */
  readonly failure?: string;
}

interface ReadCounters {
  tokens: number;
  truncated: number;
  splits: number;
}

/** Пауза перед второй попыткой: шлюз или прод, упавшие на секунду, к ней обычно приходят в себя. */
export const BILL_RETRY_DELAY_MS = 1_500;

export interface BillExtractionOptions {
  /** Пауза перед повтором упавшего вызова модели, мс; в тестах — 0. */
  readonly retryDelayMs?: number;
  /**
   * Читать моделью все документы, не пропуская безобъёмные (`documentRelevance.ts`). Не задан — по переменной окружения
   * `ESTIMATE_READ_ALL_DOCUMENTS=1`. Нужен для диагностики и для сравнения расхода «до/после» в `estimate-doc-filter-eval`.
   */
  readonly readAllDocuments?: boolean;
}

const EMPTY_ANSWER: BillAnswer = { rows: [], hasBill: false, tokens: 0, malformed: 0, truncated: false };

function failureMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 300) || "неизвестная ошибка";
}

/**
 * Один вызов модели с одним повтором. Бросает последнюю ошибку, если не вышло и со второго раза.
 *
 * Сбой одного фрагмента (502 прода, ответ не в формате, обрыв сети) не должен ронять расчёт целиком: до этого закупка
 * 32616409061 не посчиталась из-за одного ответа модели. Повтор ловит случайные сбои; постоянный сбой превращается
 * в пропущенный фрагмент с пометкой (`readChunk`), а не в исключение расчёта.
 */
async function fetchWithRetry(fetcher: BillRowsFetcher, request: BillRowsRequest, retryDelayMs: number): Promise<BillAnswer> {
  try {
    return await fetcher(request);
  } catch {
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return fetcher(request);
  }
}

/**
 * Читает фрагмент, пока ответы на него не станут полными.
 *
 * Оборванный или упёршийся в предел ответ не берётся: фрагмент делится пополам по границе строки и
 * запрашивается заново — каждая половина вдвое короче и даёт вдвое меньше строк. Глубина ограничена
 * (`MAX_SPLIT_DEPTH`), чтобы один плохой фрагмент не стал сотней вызовов; на предельной глубине
 * остаётся то, что успело приехать, и кусок помечается неполным — потеря видна в отчёте, а не тиха.
 * Токены неполных ответов считаются: они потрачены.
 */
async function readChunk(
  fetcher: BillRowsFetcher,
  chunk: string,
  offset: number,
  request: { readonly context: BillExtractionContext; readonly documentName: string },
  counters: ReadCounters,
  retryDelayMs: number,
  depth = 0,
): Promise<Piece[]> {
  let answer: BillAnswer;
  try {
    answer = await fetchWithRetry(
      fetcher,
      { chunk, context: request.context, documentName: request.documentName },
      retryDelayMs,
    );
  } catch (error) {
    return [{ chunk, offset, answer: EMPTY_ANSWER, incomplete: false, failure: failureMessage(error) }];
  }
  counters.tokens += answer.tokens;
  if (answer.truncated) counters.truncated += 1;

  if (!isIncomplete(answer)) return [{ chunk, offset, answer, incomplete: false }];
  if (depth >= MAX_SPLIT_DEPTH || chunk.length < MIN_SPLIT_CHARS) {
    return [{ chunk, offset, answer, incomplete: true }];
  }

  counters.splits += 1;
  const at = splitPoint(chunk);
  const left = await readChunk(fetcher, chunk.slice(0, at), offset, request, counters, retryDelayMs, depth + 1);
  const right = await readChunk(fetcher, chunk.slice(at), offset + at, request, counters, retryDelayMs, depth + 1);
  return [...left, ...right];
}

/** Часть ведомости до выбора уровня: раздел нашей сметы, документ-источник и позиции. */
interface Extracted {
  readonly title: string;
  readonly document: string;
  readonly items: BillOfWorkItem[];
  /** Строки смет контракта, прочитанные кодом: ниже выбранного уровня они сверка, а не отказ. */
  readonly contractRows?: boolean;
  /** Смета заказчика, прочитанная кодом по форме 421/пр: выше ведомости (`volumeRank`). */
  readonly form421?: boolean;
}

/**
 * Читает ведомость из набора документов закупки.
 *
 * Документы идут подряд. Если в документе есть локальная смета формы 421/пр, которую разбирает
 * `parseCustomerLsr`, ведомость берётся из неё кодом, без модели (`customerLsrBill`): шифры, единицы,
 * объёмы и цены уже напечатаны, и модель только теряла бы строки на обрезанных ответах. Модель читает
 * остальное: каждый документ без разборной ЛСР режется на фрагменты того же размера, что и в разборе
 * документов, а фрагмент с неполным ответом делится пополам (`readChunk`). Позиции одного документа
 * собираются в один раздел с его именем: раздел по документу, потому что проверять результат человек
 * будет, открыв тот самый файл. У ЛСР раздел — сама смета заказчика, с её номером и названием.
 * Раздел заказчика («Раздел 2. Ремонтные работы») позиция несёт отдельным полем `billSection`: он
 * определяется по положению цитаты в тексте документа, а не по ответу модели, и нужен для сравнения со
 * сметой заказчика по разделам.
 *
 * Одна смета заказчика в двух документах (в «Описании объекта закупки» и в «Обосновании НМЦК») берётся
 * один раз (`customerLsrSet`); две разные сметы с одним номером — обе, с пометкой.
 *
 * Приоритет источников. В расчёт идут объёмы только одного уровня: смета заказчика формы 421/пр, прочитанная
 * кодом (по решению владельца: у неё все нормы, а у ведомости нет технологических работ), затем ведомость, затем смета
 * заказчика, прочитанная моделью, затем смета контракта, затем ТЗ и таблицы проекта (`volumeSource.ts`). При ЛСР формы 421/пр
 * ведомость остаётся сверкой (`billReference`) и моделью ради неё не читается: прочитанная кодом таблица — бесплатна и
 * сверяется, а без доверенной таблицы документ пропускается. Строки уровня
 * ниже не пропадают молча: они в отчёте с причиной LOWER_SOURCE. Строки сметы заказчика при выбранной
 * ведомости остаются подсказкой шифров и основой сверки объёмов. Смета контракта при наличии ЛСР — только
 * сверка (`contractCheck`): её строки укрупнены и в расчёт не идут. Документ, попавший в набор дважды,
 * считается один раз — и модель по нему тоже зовётся один раз.
 */
export async function extractBillOfWork(
  documents: readonly BillDocumentInput[],
  context: BillExtractionContext,
  fetcher: BillRowsFetcher = fetchBillRows,
  options: BillExtractionOptions = {},
): Promise<BillExtractionReport> {
  const started = Date.now();
  const retryDelayMs = options.retryDelayMs ?? BILL_RETRY_DELAY_MS;
  const unreadChunks: UnreadChunk[] = [];
  const rejected: RejectedBillRow[] = [];
  const relaxedAccepted = emptyExtractionStats();
  const documentsWithoutBill: string[] = [];
  const documentLevels: { name: string; level: VolumeSourceLevel; reason: string }[] = [];
  const skippedNoVolumes: SkippedDocument[] = [];
  const readAll = options.readAllDocuments ?? readAllDocuments();
  const extracted: Extracted[] = [];
  const counters: ReadCounters = { tokens: 0, truncated: 0, splits: 0 };
  let malformed = 0;
  let incompleteAnswers = 0;

  const { documents: unique, duplicates } = dedupeDocuments(documents);
  const duplicateDocuments = [...duplicates];
  // Таблицы, прочитанные кодом: по ним копии одной ведомости в разных файлах (pdf и xlsx) считаются один раз.
  const tableKeys: { document: string; keys: Set<string> }[] = [];
  const tableNotes = new Map<string, string>();
  // Ведомости без доверенной таблицы при ЛСР формы 421/пр: моделью не читались.
  const unreadBills: string[] = [];

  /*
    Сначала то, что код читает сам: локальные сметы и сметы контракта. Одна и та же смета из двух
    документов берётся один раз, поэтому набор строится по всем документам сразу.
  */
  /*
    Смета читается по исходным документам, а не по очищенным `dedupeDocuments`: тот вырезает из текста
    второго архива лист, повторяющий лист первого, и «Описание объекта закупки» осталось бы без ЛСР, а
    «найдена в 2 документах» — без второго документа. Копии сводит `buildLsrSet`, по номеру и итогу.
  */
  const lsrParse = parseCustomerLsr(documents);
  const lsrSet = buildLsrSet(lsrParse.estimates);
  const lsrDocuments = new Set(lsrParse.estimates.map((estimate) => estimate.documentName));
  const contractParse = parseContractEstimates(documents);
  const contractDocuments = new Set(contractParse.rows.map((row) => row.document));

  const lsrItems: Extracted[] = [];
  for (const [index, entry] of lsrSet.entries.entries()) {
    const bill = lsrBillSection(entry, index + 1);
    if (bill.section.items.length > 0) {
      lsrItems.push({ title: bill.section.title, document: entry.documentName, items: [...bill.section.items], form421: true });
    }
    for (const skipped of bill.skipped) {
      rejected.push({
        reason: skipped.reason,
        row: { workName: skipped.name, quantity: "", unit: "", evidenceQuote: skipped.label },
        message: skipped.message,
        documentName: entry.documentName,
      });
    }
  }

  // Смета контракта становится источником только без ЛСР; при ЛСР она нужна для сверки.
  const contract = lsrItems.length === 0 ? contractBill(contractParse.rows) : null;
  if (contract !== null) {
    for (const row of contract.rejected) rejected.push(row);
  }
  const contractItems: Extracted[] =
    contract === null ? [] : contract.sections.map((section) => ({ ...section, items: [...section.items], contractRows: true }));

  for (const [documentIndex, document] of unique.entries()) {
    const documentClass = classifyDocument(document.name, document.text);
    // Проект контракта целиком — не ТЗ: в нём приложены сметы контракта, и код их прочитал.
    const holdsContractEstimate = documentClass.level === "SPEC" && contractDocuments.has(document.name);
    documentLevels.push({
      name: document.name,
      ...(holdsContractEstimate
        ? { level: "CONTRACT_ESTIMATE" as const, reason: "в документе есть смета контракта: строки «ЛС … Поз.:»" }
        : documentClass),
    });

    // Смета разобрана кодом — модель по документу не зовётся: меньше расход и нет обрезки ответа.
    if (lsrDocuments.has(document.name) && lsrItems.length > 0) continue;
    // Документ — смета контракта: код прочитал её строки; модель нужна, только если в нём есть и ведомость.
    if (contractDocuments.has(document.name) && !hasBillSignal(document.name, document.text)) continue;

    /*
      Таблицу объёмов с уверенной шапкой («Ведомость объёмов работ», дефектная ведомость, таблица в ТЗ) код читает
      сам (`billTable`): строка документа и есть цитата, модель не зовётся, токены не тратятся. Нет доверенной
      таблицы — документ идёт в модель, как раньше.
    */
    const tableRead = readBillTables({
      documentName: document.name,
      text: document.text,
      documentLevel: documentClass.level,
      idPrefix: `d${String(documentIndex + 1)}`,
    });
    if (tableRead !== null) {
      const keys = new Set(tableRead.items.map(billItemKey));
      const twin = tableKeys.find(
        (other) => [...keys].filter((key) => other.keys.has(key)).length >= 0.8 * Math.min(keys.size, other.keys.size),
      );
      if (twin !== undefined) {
        duplicateDocuments.push({ name: document.name, duplicateOf: twin.document });
        continue;
      }
      tableKeys.push({ document: document.name, keys });
      for (const row of tableRead.skipped) {
        rejected.push({
          reason: row.reason,
          row: { workName: row.name, quantity: row.quantity, unit: row.unit, evidenceQuote: row.quote },
          message: row.message,
          documentName: document.name,
        });
      }
      tableNotes.set(
        document.name,
        `«${document.name}» прочитана таблицей, без модели: строк ${String(tableRead.items.length)}` +
          (tableRead.skipped.length > 0 ? `, пропущено ${String(tableRead.skipped.length)} (причины в отказах)` : ""),
      );
      extracted.push({ title: document.name, document: document.name, items: tableRead.items });
      continue;
    }

    /*
      ЛСР формы 421/пр прочитана кодом и выше ведомости: ведомость нужна только для сверки. Нет доверенной таблицы —
      модель ради сверки не зовётся: токены на то, что не меняет ни объёмов, ни суммы, не тратятся.
    */
    if (lsrItems.length > 0 && (documentClass.level === "BILL" || hasBillSignal(document.name, document.text))) {
      unreadBills.push(document.name);
      continue;
    }

    /*
      Дальше документ идёт в модель — если в нём вообще видны объёмы. Проект контракта, требования к заявке, формы, протоколы без
      строк с количеством модель читала впустую (60–70 % расхода на смету): решение и его пороги — `documentRelevance.ts`.
      Текст архива урезается до нужных файлов; заголовки, смещения и цитаты ниже считаются по урезанному тексту, поэтому
      остаются согласованными. Пропущенное названо в отчёте (`skippedNoVolumes`), а не молчит.
    */
    const selection = selectDocumentForModel(document.name, document.text, { readAll });
    skippedNoVolumes.push(...selection.skipped);
    if (!selection.read) continue;
    const modelText = selection.text;

    const items: BillOfWorkItem[] = [];
    let sawBill = false;
    let unreadInDocument = 0;
    // Заголовки разделов ищутся один раз на документ, а не на фрагмент: заголовок
    // раздела нередко остаётся в предыдущем фрагменте, а позиции — в следующем.
    const headings = sectionHeadings(modelText);
    const docHeadings = documentHeadings(modelText);
    // Цена заказчика читается только из сметы в текущем уровне цен: базисные суммы с нашими несопоставимы.
    const pricesCurrent = declaresCurrentPrices(modelText);
    // Фрагменты идут подряд без пропусков и перекрытий (`splitIntoChunks` режет
    // текст на срезы), поэтому смещение фрагмента — сумма длин предыдущих.
    let chunkOffset = 0;

    for (const [chunkIndex, chunk] of splitIntoChunks(modelText, CHUNK_SIZE).entries()) {
      const startOfChunk = chunkOffset;
      chunkOffset += chunk.length;
      const pieces = await readChunk(fetcher, chunk, 0, { context, documentName: document.name }, counters, retryDelayMs);

      for (const [pieceIndex, piece] of pieces.entries()) {
        if (piece.failure !== undefined) {
          // Фрагмент не прочитан даже со второй попытки: расчёт идёт без него, а потеря названа в отчёте.
          const number = pieces.length > 1 ? `${String(chunkIndex + 1)}.${String(pieceIndex + 1)}` : String(chunkIndex + 1);
          unreadInDocument += 1;
          unreadChunks.push({
            document: document.name,
            chunk: number,
            reason: piece.failure,
            message: `фрагмент ${number} документа ${document.name} не прочитан моделью: ${piece.failure}`,
          });
          continue;
        }
        malformed += piece.answer.malformed;
        if (piece.incomplete) incompleteAnswers += 1;
        if (piece.answer.hasBill) sawBill = true;
        const base = startOfChunk + piece.offset;

        const result = extractBillItems({
          stats: relaxedAccepted,
          rows: piece.answer.rows,
          sourceText: piece.chunk,
          documentName: document.name,
          /*
            Префикс несёт номер документа и фрагмента: идентификаторы позиций из
            разных файлов иначе столкнулись бы, а по столкнувшимся нельзя понять,
            из какого файла пришёл объём. Кусок делённого фрагмента — своя буква.
          */
          idPrefix: `d${String(documentIndex + 1)}c${String(chunkIndex + 1)}${pieces.length > 1 ? `p${String(pieceIndex + 1)}` : ""}`,
          sectionOf: (offset) => sectionAt(headings, base + offset)?.title ?? null,
          documentLevel: documentClass.level,
          pricesCurrent,
          headingInfoOf: (offset) => headingInfoAt(docHeadings, base + offset),
        });

        items.push(...result.items);
        rejected.push(...result.rejected.map((row) => ({ ...row, documentName: document.name })));
      }
    }

    if (items.length > 0) extracted.push({ title: document.name, document: document.name, items });
    // Нечитанный фрагмент мог быть ведомостью: «без ведомости» про такой документ сказать нельзя.
    else if (!sawBill && unreadInDocument === 0) documentsWithoutBill.push(document.name);
  }

  /*
    Повторы между документами независимо от способа чтения. Копия ведомости (xls и doc) читается по-разному: одну
    прочитала таблица, другую модель, и сравнение таблиц (`tableKeys`) их не сводит — каждая строка считалась дважды.
    Позиции сравниваются по наименованию, единице и объёму; внутри одного документа повторы не трогаются.
  */
  const deduped = dedupeItemsAcrossDocuments(extracted.map(({ document, items }) => ({ document, items })));
  for (const [index, group] of deduped.groups.entries()) {
    const original = extracted[index] as Extracted;
    extracted[index] = { ...original, items: [...group.items] };
  }
  const itemDuplicateNotes: string[] = [];
  for (const entry of deduped.duplicateDocuments) {
    duplicateDocuments.push(entry);
    itemDuplicateNotes.push(`«${entry.name}» повторяет «${entry.duplicateOf}» (позиции совпали по наименованию, единице и объёму): считается один раз`);
  }
  for (const entry of deduped.partial) {
    itemDuplicateNotes.push(
      `В «${entry.name}» ${String(entry.dropped)} поз. повторяют «${entry.duplicateOf}» (то же наименование, единица и объём): считаются один раз`,
    );
  }

  // Уровень каждой группы: у строк модели он свой, у ЛСР и сметы контракта задан источником.
  const all: Extracted[] = [...extracted, ...lsrItems, ...contractItems];
  const volumeSource = chooseVolumeSource({
    accepted: all.flatMap(({ document, items, form421 }) =>
      items.map((item) => ({ level: item.sourceLevel ?? "SPEC", document, form421: form421 === true })),
    ),
    documentLevels,
  });

  const sections: BillOfWorkSection[] = [];
  const customerReference: BillOfWorkItem[] = [];
  const billReference: BillOfWorkItem[] = [];
  // Группа ЛСР формы 421/пр с позициями всегда выигрывает выбор (её вес выше всех): тогда строки ведомости — сверка.
  const form421Chosen = all.some((group) => group.form421 === true && group.items.length > 0);
  const chosenRank = volumeSource === null ? 0 : volumeRank(volumeSource.level, form421Chosen);

  for (const { title, document, items, contractRows, form421 } of all) {
    const kept: BillOfWorkItem[] = [];
    for (const item of items) {
      const level = item.sourceLevel ?? "SPEC";
      if (volumeSource !== null && volumeRank(level, form421 === true) === chosenRank) {
        // Цена заказчика — запасной вариант только строк самой сметы; у ведомости и ТЗ её нет.
        const hasOwnPrice = level === "CUSTOMER_ESTIMATE" || level === "CONTRACT_ESTIMATE";
        kept.push(hasOwnPrice || item.customerPrice == null ? item : { ...item, customerPrice: null });
        continue;
      }
      if (volumeSource?.level === "BILL" && level === "CUSTOMER_ESTIMATE") {
        // Не объём расчёта, а подсказка шифров и повод сверить цифры.
        customerReference.push(item);
        continue;
      }
      if (chosenRank === FORM_421_RANK && level === "BILL") {
        // Объёмы взяты из ЛСР формы 421/пр: ведомость не объём расчёта, а повод сверить цифры и найти забытые заказчиком работы.
        billReference.push(item);
        continue;
      }
      // Строки сметы контракта и ЛСР, лежащие ниже или рядом с ведомостью, названы в сверке, а не в отказах.
      if (contractRows === true) continue;
      rejected.push({
        reason: "LOWER_SOURCE",
        row: {
          workName: item.workName,
          quantity: item.quantity,
          unit: item.quantityUnit,
          evidenceQuote: item.sourceQuote ?? item.workName,
        },
        message:
          `«${item.workName}»: объёмы расчёта взяты из ${LEVEL_OF_SOURCE_LABEL[volumeSource?.level ?? "SPEC"]}, ` +
          `строка из ${LEVEL_OF_SOURCE_LABEL[level]} «${document}» не используется ` +
          "(приоритет: смета заказчика формы 421/пр, затем ведомость объёмов, затем смета заказчика, прочитанная моделью, затем смета контракта, затем ТЗ и таблицы проекта)",
        documentName: document,
      });
    }
    if (kept.length > 0) sections.push({ title, items: kept });
  }

  // Сверка сметы контракта с ЛСР: только когда есть и то и другое.
  const contractCheck =
    lsrSet.entries.length > 0 && contractParse.rows.length > 0 ? checkContractAgainstLsr(contractParse.rows, lsrSet.entries) : null;

  const lsrUsed = volumeSource !== null && (volumeSource.level === "CUSTOMER_ESTIMATE" || volumeSource.level === "BILL");
  const details = [
    ...(lsrUsed && lsrItems.length > 0 ? lsrSet.notes : []),
    ...(chosenRank === FORM_421_RANK
      ? unreadBills.map(
          (name) =>
            `Ведомость «${name}» не сверялась: доверенной таблицы в ней нет, а читать её моделью ради сверки не стали (объёмы и сумма от этого не зависят)`,
        )
      : []),
    ...(lsrUsed && contractCheck !== null ? contractCheck.messages : []),
    ...[...tableNotes].filter(([name]) => volumeSource?.documents.includes(name) === true).map(([, note]) => note),
    ...itemDuplicateNotes,
    ...skippedNoVolumeNotes(skippedNoVolumes),
    ...unreadChunks.map((chunk) => `Пропущено: ${chunk.message}`),
    ...(counters.splits > 0
      ? [
          `Ответ модели был неполным ${String(counters.splits)} раз(а): фрагмент делился пополам и читался заново` +
            (incompleteAnswers > 0 ? `; ${String(incompleteAnswers)} кусков остались неполными — часть строк могла не прочитаться` : ""),
        ]
      : incompleteAnswers > 0
        ? [`${String(incompleteAnswers)} ответов модели остались неполными — часть строк могла не прочитаться`]
        : []),
  ];

  return {
    sections,
    rejected,
    rejectedByReason: countRejections(rejected),
    relaxedAccepted,
    documentsWithoutBill,
    skippedNoVolumes,
    malformed,
    truncatedAnswers: counters.truncated,
    splitAnswers: counters.splits,
    incompleteAnswers,
    unreadChunks,
    tokensUsed: counters.tokens,
    processingTimeMs: Date.now() - started,
    volumeSource: volumeSource === null ? null : details.length === 0 ? volumeSource : { ...volumeSource, details },
    customerReference,
    billReference,
    documentLevels,
    duplicateDocuments,
    customerLsrs: lsrSet.entries.map(lsrSourceInfo),
    lsrNotes: lsrSet.notes,
    contractCheck,
  };
}
