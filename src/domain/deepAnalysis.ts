import { applyLegalRules, readConsolidated, type ConsolidatedAnalysis } from "@/domain/analysisConsolidation";
import type {
  AnalysisFinding,
  AnalysisJobRow,
  DocumentAnalysisRow,
  DocumentMeta,
  DocumentSkipMark,
  DocumentTruncation,
  SkippedCode,
  TenderDataSource,
  TenderLaw,
  Verdict,
  VerdictHistoryRow,
} from "@/types/database";
import { demoteUniversalBlockers } from "@/domain/scoring/documentFindings";
import { filterFindingNoise, mergeStandardTopics } from "@/domain/findingNoise";
import { documentationSources, sourceFacts } from "@/domain/sources";

/**
 * Состояние глубокого анализа документации — чистая функция от строк БД.
 *
 * Разбор физически разделён: документацию загружает локальный скрипт (ЕИС не
 * отвечает зарубежным IP), текст разбирает серверный воркер — он дёргает шлюз
 * модели, ключ от которого живёт только в окружении сервера. Между ними —
 * очередь analysis_jobs. Поэтому
 * «задача в очереди, документов ещё нет» — нормальное промежуточное состояние,
 * и интерфейс обязан говорить об этом прямо, а не показывать вечную загрузку.
 *
 * Документов у закупки теперь много: извещение плюс все вложения вкладки
 * документов. Часть из них заведомо не читается — том rar на 300 МБ, скан без
 * текстового слоя, файл сверх бюджета знаков. Такие строки лежат в базе с
 * причиной пропуска, и это не сбой: обход принял решение не качать файл.
 */

/**
 * Допустимые значения raw_json.skipped.code.
 *
 * Список обязан совпадать с SkippedCode из @/types/database — это проверяет
 * `satisfies`. Обратное (новый код в типе, но не здесь) компилятор не поймает:
 * строка с неизвестным кодом просто не будет признана пропуском.
 */
const SKIPPED_CODES = [
  "over_char_budget",
  "file_too_large",
  "unsupported_format",
  "empty_text",
  "download_failed",
  "parse_failed",
  "volume_of_set",
] as const satisfies readonly SkippedCode[];

/**
 * Признак пропуска из raw_json строки документа; null — документ не пропущен.
 *
 * Колонка JSONB схемой не проверяется, а строки описывают её по-разному:
 * у DocumentMeta это DocumentRawJson, у TenderDocumentRow — Record<string, unknown>.
 * Поэтому аргумент — unknown, а поля проверяются на месте. Разбор нужен двум
 * читателям: воркер по нему не качает файл, который заведомо не прочитается
 * (и не затирает внятную причину сетевой ошибкой от ЕИС), а карточка закупки
 * показывает «Пропущен» вместо «Текст получить не удалось».
 */
export function documentSkipMark(row: {
  raw_json: unknown;
}): DocumentSkipMark | null {
  const raw = row.raw_json;
  if (!raw || typeof raw !== "object") return null;

  const skipped = (raw as { skipped?: unknown }).skipped;
  if (!skipped || typeof skipped !== "object") return null;

  const { code, reason } = skipped as { code?: unknown; reason?: unknown };
  if (typeof reason !== "string") return null;
  const known = SKIPPED_CODES.find((value) => value === code);
  if (!known) return null;

  return { code: known, reason };
}

/**
 * Дошёл ли текст документа до разбора целиком; null — целиком.
 *
 * Бюджет знаков на закупку конечный, и последнему файлу может не хватить
 * остатка. На живой закупке 32616393585 архив документации о закупке из 15
 * вложений отдал 2, а сумма знаков сошлась ровно в миллион. Без этой отметки
 * карточка показывала бы «Разбор завершён» над документацией, которую модель
 * не видела даже наполовину.
 *
 * Числа в raw_json не проверяются схемой, поэтому битый архивный счётчик
 * не подменяется нулём, а отбрасывается: «прочитано 0 из 0» хуже, чем просто
 * «обрезано».
 */
/**
 * Отпечаток состояния разбора: изменилось ли что-нибудь с прошлой проверки.
 *
 * Нужен кнопке «Обновить статус». Без него нажатие, когда ничего не изменилось,
 * выглядит поломкой: запрос уходит, ответ приходит тот же, на экране не
 * двигается ничего — и партнёр жмёт снова и снова.
 *
 * В отпечаток входит то, что партнёр увидел бы глазами: статусы заданий,
 * состояние каждого документа и число разобранных фрагментов. Время обновления
 * строк намеренно не входит — воркер трогает `updated_at` и тогда, когда по
 * сути ничего не произошло, а «изменилось» об этом говорить не должно.
 */
export function deepAnalysisFingerprint(status: {
  jobs: readonly AnalysisJobRow[];
  documents: readonly DocumentMeta[];
  documentAnalyses: readonly DocumentAnalysisRow[];
}): string {
  const jobs = status.jobs
    .map(
      (job) =>
        `${job.id}:${job.status}:${job.documents_processed}/${job.documents_total}`,
    )
    .sort()
    .join("|");

  const documents = status.documents
    .map(
      (document) =>
        `${document.id}:${document.parsed_status}:${document.download_status}`,
    )
    .sort()
    .join("|");

  return `${jobs}#${documents}#${status.documentAnalyses.length}`;
}

/**
 * Состав архива: сколько входов стало текстом из скольких.
 *
 * Отдельно от `documentTruncation`, потому что это разные вопросы. Обрезка —
 * «текст не влез в бюджет». Состав — «сколько файлов внутри архива удалось
 * прочитать», и он важен даже когда бюджет не при чём: архив из сорока сканов
 * укладывается в любой лимит и не даёт ни одной буквы. Пока отчёт писался
 * только при обрезке, такой архив выглядел прочитанным целиком.
 */
export function documentArchive(row: {
  raw_json: unknown;
}): { parsed: number; total: number } | null {
  const raw = row.raw_json;
  if (!raw || typeof raw !== "object") return null;

  const archive = (raw as { archive?: unknown }).archive;
  if (!archive || typeof archive !== "object") return null;

  const { parsed, total } = archive as { parsed?: unknown; total?: unknown };
  if (typeof parsed !== "number" || typeof total !== "number") return null;
  if (!Number.isFinite(parsed) || !Number.isFinite(total)) return null;

  return { parsed, total };
}

export function documentTruncation(row: {
  raw_json: unknown;
}): DocumentTruncation | null {
  const raw = row.raw_json;
  if (!raw || typeof raw !== "object") return null;
  if ((raw as { truncated?: unknown }).truncated !== true) return null;

  const archive = (raw as { archive?: unknown }).archive;
  if (!archive || typeof archive !== "object") return { archive: null };

  const { parsed, total } = archive as { parsed?: unknown; total?: unknown };
  if (typeof parsed !== "number" || typeof total !== "number")
    return { archive: null };
  if (!Number.isFinite(parsed) || !Number.isFinite(total))
    return { archive: null };

  return { archive: { parsed, total } };
}

/**
 * Источники, документацию по которым умеет доставать scripts/fetch-tender-documents.ts.
 *
 * Контур.Закупки здесь не поблажка, а факт: это агрегатор, его
 * `NotificationNumber` — тот же номер извещения ЕИС, а ссылки `Docs[].Url`
 * ведут на filestore zakupki.gov.ru. Значит печатную форму и вкладку документов
 * для строки `data_source = KONTUR` читает ЕИС — бесплатно и без ключа Контура.
 * Проверено 23.09.2026 на живых номерах из прод-базы: 0336300038526000037
 * (44-ФЗ, печатная форма 5 257 знаков) и 32616403207 (223-ФЗ, карточка
 * 4 460 знаков после отсечения сквозной навигации).
 *
 * Список общий с загрузчиком документации: `publishedInEis` в
 * tenderDocumentsFetcher.ts берёт его отсюда, чтобы «анализ доступен» и
 * «документация действительно читается» не разъехались. Сам список выводится из
 * каталога `src/domain/sources.ts`: факт «отдаёт ли источник документацию»
 * записан один раз, и тексты отказа больше не могут с ним разойтись.
 */
export const DOCUMENTATION_SOURCES: readonly TenderDataSource[] =
  documentationSources();

/**
 * Почему глубокий анализ недоступен для этого источника; null — доступен.
 *
 * Задачу для недоступного источника не создаём осознанно: она висела бы в очереди
 * вечно, а карточка показывала бы ожидание, которого на самом деле нет.
 */
export function deepAnalysisBlocker(
  dataSource: TenderDataSource,
): string | null {
  const facts = sourceFacts(dataSource);
  if (facts.documents === "bytes") return null;
  return facts.documentsReason ?? `Источник ${dataSource} не поддерживается.`;
}

export type DeepAnalysisState =
  /** Источник не даёт документацию. */
  | "unsupported"
  /** Задачу ещё не ставили. */
  | "not_started"
  /** Задача в очереди: ждём документацию или воркер. */
  | "queued"
  /** Воркер работает прямо сейчас. */
  | "analyzing"
  /** Часть фрагментов разобрана, задача снова в очереди (большой документ). */
  | "resuming"
  /** Разбор завершён. */
  | "completed"
  /** Разбор упал. */
  | "failed";

export type FindingCategory = AnalysisFinding["category"];

/** Порядок показа: сначала то, что меняет решение по закупке. */
export const FINDING_CATEGORY_ORDER: readonly FindingCategory[] = [
  "blocker",
  "risk",
  "requirement",
  "neutral",
];

const SEVERITY_WEIGHT: Record<AnalysisFinding["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface FindingGroup {
  category: FindingCategory;
  findings: AnalysisFinding[];
}

export interface VerdictChangeInfo {
  from: Verdict | null;
  to: Verdict;
  reason: string;
  at: string;
}

export interface DeepAnalysisSummary {
  state: DeepAnalysisState;
  /** Короткий заголовок состояния. */
  title: string;
  /** Что происходит на самом деле: сроки, числа, причина сбоя. */
  detail: string;
  /** Задача, по которой принято решение о состоянии: та, что менялась последней. */
  job: AnalysisJobRow | null;
  documents: DocumentMeta[];
  /** Документов с готовым текстом — по ним работает разбор. */
  documentsWithText: number;
  /** Документов, которые обход не стал читать: причина в raw_json.skipped. */
  documentsSkipped: number;
  /** Документов, чей текст обрезан по остатку бюджета знаков. */
  documentsTruncated: number;
  /** Сколько фрагментов документа разобрано. */
  chunksAnalyzed: number;
  /**
   * Что показывать: без типового (единые требования ст. 31, НДС, контакты…) и без
   * условий 44-ФЗ в пределах закона (`findingNoise.ts`). Отклонения от нормы здесь с `legal_note`.
   */
  findings: AnalysisFinding[];
  findingGroups: FindingGroup[];
  /**
   * Все находки до чистки от шума: из них блоки «Деньги» и «Сроки» берут обеспечения и срок
   * оплаты — типовое условие остаётся источником чисел, хотя в списке рисков его нет.
   */
  allFindings?: AnalysisFinding[];
  /** «Типовые условия 44-ФЗ без отклонений: …» — строка под рисками; null — нечего сказать. */
  standardLine?: string | null;
  /** Какая модель делала выводы: «факты» и «выводы AI» в продукте разделены. */
  modelUsed: string | null;
  /** Последнее изменение вердикта, вызванное разбором документации. */
  verdictChange: VerdictChangeInfo | null;
  /**
   * Сводка по всем документам (`analysisConsolidation.ts`): противоречия с решением,
   * вопросы заказчику, денежные условия. null — разбор сделан до сводки или она не удалась.
   */
  consolidation: ConsolidatedAnalysis | null;
}

export interface DeepAnalysisInput {
  dataSource: TenderDataSource;
  /** Задачи закупки, самые свежие первыми (так отдаёт репозиторий). */
  jobs: AnalysisJobRow[];
  documents: DocumentMeta[];
  documentAnalyses: DocumentAnalysisRow[];
  /** История вердиктов, самая свежая первой. */
  verdictHistory: VerdictHistoryRow[];
  /**
   * Закупке предлагается платная карточка Контур.Закупок: документов в базе нет
   * и плановая синхронизация их не принесёт, потому что ЕИС для коммерческих
   * закупок не публикует вкладку документов. Без флага подпись очереди обещала
   * бы скорую загрузку — обещание, которое не выполнится никогда.
   */
  paidCardOffered?: boolean;
  /** НМЦК: по ней работают правила закона (порог СРО) и у разборов без сводки. */
  price?: number | null;
  /**
   * Закон закупки: от него зависит, что считать нормой. Типовые условия 44-ФЗ
   * (казначейство, односторонний отказ, пени по ПП № 1042) не находка; для 223-ФЗ они обычные риски.
   */
  law?: TenderLaw | null;
}

/**
 * Какую задачу считать текущим состоянием разбора.
 *
 * Не ту, что создана последней: воркер берёт из очереди одну задачу за вызов,
 * поэтому задача, поставленная между двумя попытками, может остаться висеть
 * в очереди, пока более ранняя уже завершилась. Ориентир — время последнего
 * изменения (updated_at в БД поддерживает триггер). Иначе лишняя строка
 * «pending» закрыла бы готовый разбор: три разобранных фрагмента из трёх
 * показывались бы как «разбор продолжится».
 *
 * При равном времени побеждает задача, стоящая раньше в списке, — репозиторий
 * отдаёт их по убыванию created_at.
 */
export function pickRepresentativeJob(
  jobs: AnalysisJobRow[],
): AnalysisJobRow | null {
  return jobs.reduce<AnalysisJobRow | null>(
    (latest, job) =>
      latest === null || updatedAtMs(job) > updatedAtMs(latest) ? job : latest,
    null,
  );
}

function updatedAtMs(job: AnalysisJobRow): number {
  const time = Date.parse(job.updated_at);
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Складывает строки БД в одно состояние для карточки закупки.
 * Ничего не додумывает: если документов нет, так и пишет.
 */
/** Падеж для счётного слова: 1 файл, 2 файла, 5 файлов. */
function filesWord(count: number): string {
  const rest = Math.abs(count) % 100;
  const last = rest % 10;
  if (rest > 10 && rest < 20) return "файлов";
  if (last > 1 && last < 5) return "файла";
  if (last === 1) return "файл";
  return "файлов";
}

/**
 * «Прочитан 1 файл из 3» вместо «Документов в базе: 1, пропущено 2».
 *
 * Партнёр считает файлы, которые выложил заказчик, а не строки в нашей таблице.
 * Дробь важнее обоих чисел по отдельности: она сразу говорит, на какой части
 * документации будут построены выводы.
 */
function readFilesPhrase(withText: number, total: number): string {
  const verb = withText === 1 ? "Прочитан" : "Прочитано";
  return `${verb} ${withText} ${filesWord(withText)} из ${total}`;
}

export function summarizeDeepAnalysis(
  input: DeepAnalysisInput,
): DeepAnalysisSummary {
  const blocker = deepAnalysisBlocker(input.dataSource);
  const job = pickRepresentativeJob(input.jobs);

  /*
    Категории понижаются тем же правилом, которым их понижает движок вердикта.

    В базе лежат категории так, как их назвала модель, а `applyDocumentFindings`
    перед подсчётом вердикта пропускает находки через `demoteUniversalBlockers`.
    Без того же шага на пути чтения карточка показывала «Блокеры: 1» рядом с
    вердиктом RECOMMENDED: факты и выводы расходились, а объяснить вердикт было
    нельзя. Править сохранённые категории нельзя — тогда правило оказалось бы
    записано в данные, и его следующая правка не дотянулась бы до старых
    разборов. Поэтому правило применяется при каждом чтении, и источник правды
    один: `documentFindings.ts`.

    Импорт из модуля правила, а не из бочки `@/domain/scoring`: сводке не нужны
    веса скоринга, и тянуть их сюда значило бы связать два домена без причины.
  */
  /*
    Сводка — отдельная строка разбора без документа. Есть она — выводы берутся из
    неё (повторы объединены, противоречия разрешены, закон применён); нет —
    построчные выводы документов с теми же правилами закона.
  */
  let consolidation: ConsolidatedAnalysis | null = null;
  const perDocument = input.documentAnalyses.filter((a) => {
    const consolidated = readConsolidated(a.analysis);
    if (consolidated !== null) consolidation = consolidated;
    return consolidated === null;
  });
  const perDocumentFindings = perDocument.flatMap((a) => a.analysis?.findings ?? []);
  const allFindings = demoteUniversalBlockers(
    consolidation !== null
      ? (consolidation as ConsolidatedAnalysis).findings
      : applyLegalRules(perDocumentFindings, { price: input.price ?? null }).findings,
  );
  /*
    Норма закона и обычай делового оборота — не находка (`findingNoise.ts`).
    Чистка при чтении, а не при записи: старые разборы очищаются тоже, а правило
    можно править, не трогая данные. Строка «типовые условия без отклонений» собирается
    и из построчных разборов документов: сводка модели могла не включить типовое, а
    проверка всё равно была.
  */
  const filtered = filterFindingNoise(allFindings, input.law);
  const findings: AnalysisFinding[] = filtered.kept;
  const standardLine =
    consolidation !== null
      ? mergeStandardTopics(
          [
            filtered,
            filterFindingNoise(
              demoteUniversalBlockers(applyLegalRules(perDocumentFindings, { price: input.price ?? null }).findings),
              input.law,
            ),
          ],
          input.law,
        ).line
      : filtered.standardLine;
  const documentsSkipped = input.documents.filter(
    (document) => documentSkipMark(document) !== null,
  ).length;
  const documentsTruncated = input.documents.filter(
    (document) => documentTruncation(document) !== null,
  ).length;

  const base = {
    job,
    documents: input.documents,
    documentsWithText: input.documents.length - documentsSkipped,
    documentsSkipped,
    documentsTruncated,
    chunksAnalyzed: perDocument.length,
    findings,
    allFindings,
    standardLine,
    findingGroups: groupFindings(findings),
    modelUsed: input.documentAnalyses.at(-1)?.model_used ?? null,
    verdictChange: documentVerdictChange(input.verdictHistory),
    consolidation,
  };

  /**
   * Пропущенные файлы не участвуют в разборе, и молчать об этом нельзя:
   * «Разбор завершён» рядом с 46 непрочитанными томами выглядел бы как полный
   * анализ закупки.
   */
  const skippedNote =
    base.documentsSkipped > 0 ? `, пропущено ${base.documentsSkipped}` : "";

  /**
   * Что именно не дошло до модели. Пропуск и обрезка — разные вещи (файл не
   * читали вовсе против прочитали частично), но вывод для партнёра один:
   * документация разобрана не целиком, и это надо сказать в итоговой строке.
   */
  const gaps: string[] = [];
  if (base.documentsSkipped > 0)
    gaps.push(`пропущено ${base.documentsSkipped}`);
  if (base.documentsTruncated > 0)
    gaps.push(`обрезано ${base.documentsTruncated}`);
  const gapsNote =
    gaps.length > 0
      ? ` Документация прочитана не вся: ${gaps.join(", ")} — детали в списке ниже.`
      : "";

  if (blocker) {
    return {
      ...base,
      state: "unsupported",
      title: "Недоступно для этого источника",
      detail: blocker,
    };
  }

  if (!job) {
    return {
      ...base,
      state: "not_started",
      title: "Глубокий анализ не запускался",
      detail:
        "Нажмите «Запустить глубокий анализ»: сначала загрузится документация из " +
        "ЕИС, затем её разберёт модель. Стадия воронки разбор не запускает — " +
        "решение потратить его принимается здесь.",
    };
  }

  if (job.status === "failed") {
    return {
      ...base,
      state: "failed",
      title: "Разбор не выполнен",
      detail: job.error_message ?? "Причина не сохранена.",
    };
  }

  if (job.status === "processing") {
    return {
      ...base,
      state: "analyzing",
      title: "Идёт разбор документации",
      detail:
        input.documents.length > 0
          ? `Документов в работе: ${base.documentsWithText}${skippedNote}.`
          : "Документация ещё загружается.",
    };
  }

  if (job.status === "completed") {
    if (input.documentAnalyses.length === 0) {
      return {
        ...base,
        state: "completed",
        title: "Разбор завершён, но анализировать было нечего",
        detail:
          base.documentsWithText === 0 && base.documentsSkipped > 0
            ? `Текста нет ни в одном из ${base.documentsSkipped} файлов — причина по каждому в списке документов.`
            : "Текст документации по этой закупке получить не удалось — печатная форма ЕИС " +
              "не ответила или закупка снята. Выводов нет.",
      };
    }
    /*
      «Разобрано фрагментов: 7. Найдено факторов: 12» — счёт нашей внутренней
      работы. Партнёру нужно другое: на чём построены выводы и сколько важного
      нашлось. Фрагменты — это способ уложиться в лимит запроса, знать о них ему
      незачем.
    */
    return {
      ...base,
      state: "completed",
      title: "Разбор завершён",
      detail:
        `${readFilesPhrase(base.documentsWithText, input.documents.length)}. ` +
        (findings.length === 0
          ? "Существенного в документации не найдено."
          : `Нашлось важного: ${findings.length}. Каждое — с цитатой из документа.`) +
        gapsNote,
    };
  }

  // job.status === "pending"
  if (input.documentAnalyses.length > 0) {
    return {
      ...base,
      state: "resuming",
      title: "Разбор продолжится",
      detail:
        `Разобрано фрагментов: ${input.documentAnalyses.length}. Документ большой, ` +
        // «Воркер» и «лимит времени Vercel» — внутренние слова. Партнёру важно
        // другое: разбор не прервался и продолжится сам, поэтому говорим про
        // отведённое время без названий процессов и площадок.
        "он разбирается частями: на один запрос отведено ограниченное время, " +
        "и разбор продолжится со следующего фрагмента.",
    };
  }

  if (input.documents.length === 0) {
    return {
      ...base,
      state: "queued",
      title: "Загружаем документацию",
      detail: input.paidCardOffered
        ? "Плановая синхронизация сюда не дойдёт: для коммерческой закупки ЕИС не публикует " +
          "документы. Документация появится, только если купить карточку источника — " +
          "предложение ниже."
        : // Загрузка начинается сразу по кнопке. Обещать «каждые 2 часа» больше
          // нельзя — это было правдой, пока документацию приносил плановый прогон.
          "Скачиваем и распаковываем файлы закупки с площадки — обычно это 1–3 минуты. " +
          "Разбор начнётся сразу после загрузки, страницу обновлять не нужно.",
    };
  }

  /*
    Заголовок обязан отличать «прочитали всё» от «прочитали меньшую часть».

    Живой случай: три файла, прочитана карточка закупки на 7 КБ, два тома .rar с
    настоящей документацией пропущены. «Документация загружена» здесь — неправда
    в глазах партнёра: он поймёт, что документы у нас есть, и будет верить
    выводам как полным. Дробь и прямая фраза про непрочитанное стоят до кнопки,
    а не в сноске под списком файлов.
  */
  const allRead = base.documentsSkipped === 0;
  const partial = base.documentsWithText * 2 < input.documents.length;

  return {
    ...base,
    state: "queued",
    title: allRead
      ? "Документация прочитана, ждём разбор"
      : partial
        ? "Прочитана меньшая часть документации"
        : "Документация прочитана не вся, ждём разбор",
    detail:
      `${readFilesPhrase(base.documentsWithText, input.documents.length)}.` +
      (allRead
        ? " Осталось дождаться разбора: его делает модель после загрузки."
        : ` Остальные не читаются — причина по каждому в списке ниже. Выводы будут` +
          ` построены только на прочитанном.`),
  };
}

/** Строка документа в показе: сама строка и сколько таких же схлопнуто под ней. */
export interface DocumentGroup {
  document: DocumentMeta;
  /** Признак пропуска; null — документ с текстом. */
  skipped: DocumentSkipMark | null;
  /** Текст дошёл до разбора не целиком; null — файл прочитан весь. */
  truncated: DocumentTruncation | null;
  /**
   * Состав архива: сколько входов стало текстом из скольких. null — файл не
   * архив. Показывается всегда, а не только при обрезке: архив, уложившийся в
   * бюджет, тоже может отдать один файл из сорока.
   */
  archive: { parsed: number; total: number } | null;
  /** Сколько строк с той же причиной скрыто; 0 — группа из одной строки. */
  hidden: number;
}

/**
 * Документы для показа в карточке закупки.
 *
 * Строки с одинаковой причиной пропуска схлопываются в одну. На живой закупке
 * 0373100096726000028 из 54 вложений 46 — части одного многотомного архива
 * «Йошкар Ола ПСД.partNN.rar», и список из 46 одинаковых строк не читается.
 * В базе остаётся честная строка на каждый файл: по ней видно, что заказчик
 * действительно выложил 46 томов. Схлопывается только показ.
 *
 * Порядок: сначала документы с текстом в порядке загрузки, затем группы
 * пропусков — что прочитано, важнее того, что прочитано не будет.
 */
export function groupDocuments(documents: DocumentMeta[]): DocumentGroup[] {
  const withText: DocumentGroup[] = [];
  const skippedGroups: DocumentGroup[] = [];
  const byReason = new Map<string, DocumentGroup>();

  for (const document of documents) {
    const skipped = documentSkipMark(document);
    if (skipped === null) {
      withText.push({
        document,
        skipped: null,
        truncated: documentTruncation(document),
        archive: documentArchive(document),
        hidden: 0,
      });
      continue;
    }

    const existing = byReason.get(skipped.reason);
    if (existing) {
      existing.hidden += 1;
      continue;
    }

    const group: DocumentGroup = {
      document,
      skipped,
      truncated: null,
      archive: null,
      hidden: 0,
    };
    byReason.set(skipped.reason, group);
    skippedGroups.push(group);
  }

  return [...withText, ...skippedGroups];
}

/** Раскладывает факторы по категориям; внутри категории — по убыванию важности. */
export function groupFindings(findings: AnalysisFinding[]): FindingGroup[] {
  return FINDING_CATEGORY_ORDER.map((category) => ({
    category,
    findings: findings
      .filter((f) => f.category === category)
      .sort(
        (a, b) => SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity],
      ),
  })).filter((group) => group.findings.length > 0);
}

/**
 * Менялся ли вердикт из-за разбора документации.
 * Разбор умеет только ухудшать вердикт, поэтому запись здесь — всегда сигнал.
 */
export function documentVerdictChange(
  verdictHistory: VerdictHistoryRow[],
): VerdictChangeInfo | null {
  const entry = verdictHistory.find(
    (h) => h.triggered_by === "document_analysis",
  );
  if (!entry) return null;
  return {
    from: entry.old_verdict,
    to: entry.new_verdict,
    reason: entry.reason,
    at: entry.created_at,
  };
}
