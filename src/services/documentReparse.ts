import type { ArchiveReport } from "@/types/database";
import { describeError } from "@/lib/errors";
import { isEisBlockedError } from "@/lib/eisGate";
import { computeContentHash } from "@/services/documentParser";
import { attachmentPriority, attachmentRank } from "@/services/eisAttachments";
import {
  detectFileType,
  isVolumeName,
  volumeSetName,
} from "@/services/fileFormats";
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_CHARS_PER_TENDER,
  MAX_VOLUME_SET_BYTES,
  NO_ARCHIVE_CLI_FRAGMENT,
  overBudgetReason,
  readAttachmentFile,
  readVolumeSet,
  type AttachmentFetchDeps,
  type AttachmentRef,
  type FetchedAttachment,
} from "@/services/tenderAttachmentsFetcher";
import {
  occupiedChars,
  type PreparedDocument,
  type TenderDocumentStore,
} from "@/services/tenderDocumentSync";
import type { StoredDocumentType } from "@/services/tenderDocumentsFetcher";
import type {
  DocumentSourceType,
  ParsedStatus,
  SkippedCode,
} from "@/types/database";

/**
 * Повторный разбор документов, которые раньше не прочитались, а теперь могут.
 *
 * Зачем. В tender_documents лежат сотни строк с причиной «Формат rar не
 * разбирается», «Текстового слоя нет» и им подобными. Часть из них записана до
 * того, как появились распаковщик rar и 7z, чтение OpenDocument и rtf, тома
 * `.zip.001` и распознавание сканов. Обычная плановая загрузка их не трогает:
 * имя файла уже занято, а повтор разрешён только архивам (isRetryableSkip).
 *
 * Что делает. Находит такие строки, скачивает файл по сохранённой ссылке и
 * разбирает новым кодом тем же путём, что и обычная загрузка — через
 * readAttachmentFile и readVolumeSet, — а результат пишет теми же методами
 * репозитория (порт `save`). Бюджет знаков закупки считает с учётом уже
 * прочитанного, поэтому добавленное не превысит бюджет знаков, если он включён
 * (по умолчанию бюджета нет — MAX_TOTAL_CHARS_PER_TENDER).
 *
 * Сети, базы и парсеров здесь нет — всё приходит портами, и логика проверяется
 * без них. Скрипт-обёртка с настоящими портами — scripts/reparse-unreadable.ts;
 * запускать его можно только на сервере в России, потому что ЕИС не отвечает
 * зарубежным адресам.
 */

/** Группа причин, по которым документ стоит перечитать. */
export type ReparseCategory =
  /** «Формат … не разбирается»: формат теперь поддержан (или том комплекта). */
  | "format"
  /** «Текстового слоя нет»: скан, теперь его можно распознать. */
  | "scan"
  /** «Cannot find package»: в старом прогоне не хватало библиотеки. */
  | "module"
  /** «Invalid PDF structure»: чаще всего расширение не соответствует содержимому. */
  | "pdf_structure"
  /** «Не влез в бюджет … знаков»: бюджет снят (2026-10-08), файл можно прочитать. */
  | "budget"
  /** «Файл/комплект больше предела … и не читается»: предел поднят до 300 МБ и 2 ГБ. */
  | "limit"
  /**
   * Архив с parsed_status = 'parsed', но прочитанный частично (raw_json.archive.parsed
   * < total), причём без списка пропусков: так записывал прежний разбор. На проде
   * 2026-10-19 таких строк 57 (49 закупок), 1 327 входов не прочитано; нынешний
   * парсер читает те же файлы целиком. Строки нового разбора несут
   * archive.skipped, поэтому честно непрочитываемый архив (чертежи dwg, родные
   * файлы смет) повторно не выбирается.
   */
  | "archive_partial";

/** Все группы по именам: для проверки параметра --only. */
export const REPARSE_CATEGORIES: readonly ReparseCategory[] = [
  "format",
  "scan",
  "module",
  "pdf_structure",
  "budget",
  "limit",
  "archive_partial",
];

/**
 * Подстроки причин для грубого отбора в базе. Точный отбор делает
 * `classifyReparseReason`: база ищет по подстроке, а форматы перечислены там.
 */
export const REPARSE_REASON_FRAGMENTS: readonly string[] = [
  "не разбирается",
  "Текстового слоя нет",
  "Cannot find package",
  "Invalid PDF structure",
  "Распознавание на этом сервере недоступно",
  "Это том многотомного архива",
  "чтения комплектом здесь нет",
  // Ложный отказ до 08.10.2026: загрузка обрывала том больше 50 МБ, и комплект
  // считался «0.0 МБ больше предела».
  "Комплект томов объёмом 0.0 МБ",
  // Бюджет знаков на закупку снят 08.10.2026: файлы, которые в него не влезли,
  // читаются теперь целиком.
  "Не влез в бюджет",
  // Предел файла поднят с 50 до 300 МБ, предел комплекта томов — с 300 МБ до
  // 2 ГБ. Подстрока общая для файла и комплекта; точный отбор — в
  // classifyReparseReason (по числу в причине).
  "больше предела",
];

/** Форматы, чей отказ «не разбирается» теперь устарел. */
const REPARSED_FORMATS =
  "rar|7z|odt|ods|odp|ott|ots|otp|fodt|fods|fodp|rtf|\\d{3}|png|jpe?g|tiff?";

const FORMAT_REASON = new RegExp(
  `^Формат (?:${REPARSED_FORMATS}) не разбирается`,
  "i",
);

/**
 * Предел в причине устарел: меньше действующего. «Файл … больше предела 50 МБ»
 * при пределе 300 МБ перечитывается; «больше предела 300 МБ» — нет, новый код
 * дал бы тот же отказ, а скачивание стоило бы запросов к ЕИС.
 */
function staleLimit(reason: string): boolean {
  const match = /больше предела (\d+(?:[.,]\d+)?) МБ/.exec(reason);
  if (!match) return true;
  const shown = Number((match[1] ?? "").replace(",", "."));
  const current = (reason.startsWith("Комплект") ? MAX_VOLUME_SET_BYTES : MAX_FILE_BYTES) / 1_000_000;
  return Number.isFinite(shown) && shown < current;
}

/**
 * К какой группе относится причина; null — перечитывать не нужно.
 *
 * Причина — точный текст из error_message строки. «Схема или чертёж» и остальное
 * здесь не перечислено намеренно: новый код дал бы тот же результат, а
 * скачивание стоило бы запросов к ЕИС. Бюджет знаков и предел объёма перечислены:
 * они сняты (08.10.2026).
 */
export function classifyReparseReason(
  reason: string | null,
): ReparseCategory | null {
  if (!reason) return null;
  if (reason.includes("Не влез в бюджет")) return "budget";
  if (reason.includes("Cannot find package")) return "module";
  if (reason.includes("Invalid PDF structure")) return "pdf_structure";
  if (
    reason.includes("Текстового слоя нет") ||
    reason.includes("Распознавание на этом сервере недоступно")
  )
    return "scan";
  if (
    FORMAT_REASON.test(reason) ||
    reason.includes("Это том многотомного архива") ||
    reason.includes("чтения комплектом здесь нет") ||
    reason.includes("Комплект томов объёмом 0.0 МБ")
  )
    return "format";
  if (
    reason.includes("больше предела") &&
    reason.includes("не читается") &&
    staleLimit(reason)
  )
    return "limit";
  return null;
}

/** Строка tender_documents в том виде, в каком её нужно скрипту. */
export interface ReparseDoc {
  tenderId: string;
  filename: string;
  /** Название файла, каким его показал источник; null — не сохранено. */
  title: string | null;
  documentType: string;
  sourceType: DocumentSourceType;
  fileUrl: string | null;
  mimeType?: string | null;
  parsedStatus: ParsedStatus;
  /** Причина из error_message. */
  reason: string | null;
  skipCode: SkippedCode | null;
  /** Знаков текста из raw_json.chars; null — у строки прежней версии поля нет. */
  chars: number | null;
  fileSize: number | null;
  /**
   * Состав архива из raw_json.archive: прочитано входов из скольких. null — строка
   * не архив или записана до отчёта об архивах. `listed` — записан ли список
   * пропущенных (archive.skipped): он есть только у строк нынешнего разбора.
   */
  archive?: { parsed: number; total: number; listed: boolean } | null;
}

/**
 * Архив прочитан частично прежним разбором: строка «parsed», прочитано меньше,
 * чем входов, и списка пропусков нет (его пишет только нынешний разбор).
 */
export function isPartialArchive(doc: ReparseDoc): boolean {
  return (
    doc.parsedStatus === "parsed" &&
    Boolean(doc.fileUrl) &&
    doc.archive != null &&
    !doc.archive.listed &&
    doc.archive.parsed < doc.archive.total
  );
}

/** Порты базы: чтение строк и запись результата. */
export interface ReparseStore {
  /** Строки с parsed_status не «parsed» и ссылкой, чья причина содержит подстроку. */
  listUnreadable(options: {
    reasonLike: readonly string[];
    tenderId?: string;
  }): Promise<ReparseDoc[]>;
  /**
   * Прочитанные («parsed») архивы со ссылкой на файл, у которых raw_json.archive.parsed
   * меньше total. База отбирает по имени файла и статусу (без parsed_text — на
   * больших текстах прод упирается в таймаут запроса), число сравнивает код:
   * `isPartialArchive` перепроверяет каждую строку.
   */
  listPartialArchives(options: { tenderId?: string }): Promise<ReparseDoc[]>;
  /** Все строки закупки: нужны для бюджета знаков и для состава комплекта томов. */
  listTender(tenderId: string): Promise<ReparseDoc[]>;
  /** Запись результата — тот же метод, что у обычной загрузки. */
  save: TenderDocumentStore["save"];
  /**
   * Только отчёт об архиве (`raw_json.archive` со списком пропущенных файлов) — у строки,
   * чей новый разбор не лучше прежнего. Текст строки не меняется. Без этой отметки такой
   * архив попадал бы в отбор `archive_partial` при каждом запуске (отбор берёт строки без
   * списка пропущенных) и каждый раз заново скачивался бы с ЕИС, а что в нём не читается,
   * так и осталось бы неизвестным. Нет порта — строка не трогается, как раньше.
   */
  markArchive?: (tenderId: string, filename: string, archive: ArchiveReport) => Promise<void>;
}

export interface ReparseDeps {
  store: ReparseStore;
  fetchFile: AttachmentFetchDeps["fetchFile"];
  parse: AttachmentFetchDeps["parse"];
  parseVolumes?: AttachmentFetchDeps["parseVolumes"];
  /** Дисковый путь (7z, unrar): крупные файлы и комплекты. Нет — всё в памяти. */
  disk?: AttachmentFetchDeps["disk"];
  /** Есть ли на машине распознавание. Сканы без него не перечитываются: смысла нет. */
  ocrAvailable: () => Promise<boolean>;
  log: (line: string) => void;
}

export interface ReparseOptions {
  /** Только перечислить и посчитать: ничего не скачивать и не писать. */
  dryRun: boolean;
  /** Обработать не больше стольких закупок. */
  limit?: number;
  /** Одна закупка по реестровому номеру. */
  tenderId?: string;
  /** Предел знаков на закупку; по умолчанию боевой. Параметр нужен тестам. */
  budgetChars?: number;
  /** Только одна группа (`--only archive_partial`); не задано — все. */
  only?: ReparseCategory;
}

export interface ReparseReport {
  /** Документов-кандидатов (строк), попавших под отбор. */
  candidates: number;
  /** Закупок с кандидатами, взятых в работу (с учётом --limit). */
  tenders: number;
  byCategory: Record<ReparseCategory, number>;
  /** Единиц работы выполнено: одиночный файл или комплект томов. */
  processed: number;
  /** Файлов и комплектов, из которых теперь получен текст. */
  recovered: number;
  /** Остались нечитаемыми, причина обновлена. */
  stillUnreadable: number;
  /** Сканы и картинки, не тронутые, потому что распознавания на машине нет. */
  skippedNoOcr: number;
  /** Не влезли в бюджет знаков закупки: причина обновлена на «бюджет». */
  overBudget: number;
  /** Комплекты, которые пропущены: уже прочитаны или у тома нет ссылки. */
  skippedSets: number;
  /** Отказы по пределу объёма, записанные на машине без 7z и unrar, при том, что их нет и здесь. */
  skippedNoCli: number;
  /** Частично прочитанные архивы, у которых после перечитывания текст стал полнее и строка заменена. */
  improved: number;
  /** Частично прочитанные архивы, у которых новый разбор не лучше прежнего: строка осталась как была. */
  notImproved: number;
  /** Документов, которые не удалось записать в базу: ошибка в журнале, прогон пошёл дальше. */
  saveFailures: number;
  /** Прогон остановлен (слишком много сбоев записи подряд); null — дошёл до конца. */
  aborted: string | null;
}

/**
 * Столько сбоев записи подряд — уже не «плохой документ», а недоступная база
 * или сломанное соединение: продолжать значит получить ту же ошибку ещё сотню раз.
 */
export const MAX_CONSECUTIVE_SAVE_FAILURES = 20;

function emptyReport(): ReparseReport {
  return {
    candidates: 0,
    tenders: 0,
    byCategory: {
      format: 0,
      scan: 0,
      module: 0,
      pdf_structure: 0,
      budget: 0,
      limit: 0,
      archive_partial: 0,
    },
    processed: 0,
    recovered: 0,
    stillUnreadable: 0,
    skippedNoOcr: 0,
    overBudget: 0,
    skippedSets: 0,
    skippedNoCli: 0,
    improved: 0,
    notImproved: 0,
    saveFailures: 0,
    aborted: null,
  };
}

const STORED_TYPES: readonly string[] = [
  "notice",
  "protocol",
  "contract",
  "attachment",
  "other",
];

function storedType(value: string): StoredDocumentType {
  return STORED_TYPES.includes(value)
    ? (value as StoredDocumentType)
    : "attachment";
}

function refOf(doc: ReparseDoc): AttachmentRef {
  return {
    filename: doc.filename,
    name: doc.title ?? doc.filename,
    documentType: storedType(doc.documentType),
    url: doc.fileUrl ?? "",
    sourceType: doc.sourceType,
  };
}

/** Строка пропуска «не влез в бюджет»: так записал бы обычный обход. */
function overBudgetDocument(doc: ReparseDoc, budget: number): PreparedDocument {
  return {
    filename: doc.filename,
    title: doc.title ?? doc.filename,
    documentType: storedType(doc.documentType),
    sourceType: doc.sourceType,
    fileUrl: doc.fileUrl,
    mimeType: doc.mimeType ?? "application/octet-stream",
    text: "",
    chars: 0,
    fileSize: doc.fileSize,
    truncated: false,
    archive: null,
    ocr: null,
    skipped: { code: "over_char_budget", reason: overBudgetReason(budget) },
    contentHash: null,
  };
}

function prepare(attachment: FetchedAttachment): PreparedDocument {
  return {
    ...attachment,
    contentHash:
      attachment.skipped === null ? computeContentHash(attachment.text) : null,
  };
}

/** Единица работы: одиночный файл или комплект томов. */
type Unit =
  | { kind: "file"; doc: ReparseDoc; needsOcr: boolean; partial: boolean }
  | { kind: "set"; name: string; docs: ReparseDoc[]; partial: boolean };

/**
 * Лучше ли новый результат прежнего у частично прочитанного архива.
 *
 * Заменяем только на улучшение: больше прочитанных входов либо при том же числе
 * входов — больше знаков. Пропуск (скачивание не удалось, архив теперь «пуст»)
 * и меньшее число входов прежнюю строку не трогают: текст в ней уже есть, и
 * терять его ради отчёта «не вышло» нельзя.
 */
export function archiveVerdict(
  old: ReparseDoc,
  next: PreparedDocument | undefined,
): { better: boolean; note: string } {
  const was = old.archive ? `${old.archive.parsed} из ${old.archive.total}` : "?";
  if (!next) return { better: false, note: "нового результата нет" };
  if (next.skipped !== null)
    return { better: false, note: `новый разбор не дал текста: ${next.skipped.reason}` };
  const oldParsed = old.archive?.parsed ?? 0;
  const newParsed = next.archive?.parsed ?? 0;
  const now = next.archive ? `${next.archive.parsed} из ${next.archive.total}` : "?";
  const oldChars = old.chars ?? 0;
  const better =
    newParsed > oldParsed || (newParsed === oldParsed && next.chars > oldChars);
  return {
    better,
    note:
      `входов было ${was}, стало ${now}; знаков было ` +
      `${oldChars.toLocaleString("ru-RU")}, стало ${next.chars.toLocaleString("ru-RU")}`,
  };
}

/** Файлу нужно распознавание, чтобы стать текстом. */
function needsOcr(doc: ReparseDoc, category: ReparseCategory): boolean {
  return (
    category === "scan" ||
    detectFileType(null, doc.filename) === "image" ||
    (doc.reason?.includes("Распознавание на этом сервере недоступно") ?? false)
  );
}

/**
 * Единицы работы закупки в порядке чтения: проект контракта, затем техзадание
 * и ведомость, затем прочее — тот же порядок, что у обычного обхода, потому что
 * бюджет знаков общий и последним достанется остаток.
 */
function planUnits(
  candidates: readonly { doc: ReparseDoc; category: ReparseCategory }[],
  all: readonly ReparseDoc[],
): Unit[] {
  const units: { unit: Unit; name: string; index: number }[] = [];
  const seenSets = new Set<string>();

  candidates.forEach(({ doc, category }, index) => {
    const set = isVolumeName(doc.filename) ? volumeSetName(doc.filename) : null;
    const partial = category === "archive_partial";
    if (set !== null) {
      if (seenSets.has(set)) return;
      seenSets.add(set);
      // Комплект собирается из всех строк закупки с тем же именем комплекта, а не
      // только из кандидатов: «Том комплекта: прочитан вместе с …» — не кандидат,
      // но без этого тома архив не распаковать.
      const docs = all
        .filter((row) => volumeSetName(row.filename) === set)
        .sort((left, right) => left.filename.localeCompare(right.filename));
      units.push({
        unit: { kind: "set", name: set, docs, partial },
        name: set,
        index,
      });
      return;
    }
    units.push({
      unit: { kind: "file", doc, needsOcr: needsOcr(doc, category), partial },
      name: doc.title ?? doc.filename,
      index,
    });
  });

  return units
    .sort(
      (a, b) =>
        attachmentPriority(a.name) - attachmentPriority(b.name) ||
        attachmentRank(a.name) - attachmentRank(b.name) ||
        a.index - b.index,
    )
    .map(({ unit }) => unit);
}

/** Закупки с кандидатами в порядке появления; у каждой — только кандидаты. */
function groupByTender(
  rows: readonly ReparseDoc[],
  only?: ReparseCategory,
): Map<string, { doc: ReparseDoc; category: ReparseCategory }[]> {
  const grouped = new Map<
    string,
    { doc: ReparseDoc; category: ReparseCategory }[]
  >();
  for (const doc of rows) {
    if (!doc.fileUrl) continue;
    const category: ReparseCategory | null =
      doc.parsedStatus === "parsed"
        ? isPartialArchive(doc)
          ? "archive_partial"
          : null
        : classifyReparseReason(doc.reason);
    if (category === null) continue;
    if (only !== undefined && category !== only) continue;
    const bucket = grouped.get(doc.tenderId);
    if (bucket) bucket.push({ doc, category });
    else grouped.set(doc.tenderId, [{ doc, category }]);
  }
  return grouped;
}

/**
 * Перечитывает нечитаемые документы. Возвращает отчёт; ошибки отдельных файлов
 * не бросаются — каждый файл получает свою причину, как при обычной загрузке.
 * Единственное, что останавливает прогон, — ошибка записи в базу.
 */
export async function reparseUnreadable(
  deps: ReparseDeps,
  options: ReparseOptions,
): Promise<ReparseReport> {
  const report = emptyReport();
  const budget = Math.max(0, options.budgetChars ?? MAX_TOTAL_CHARS_PER_TENDER);

  const scope = options.tenderId ? { tenderId: options.tenderId } : {};
  // Нечитаемые и частично прочитанные архивы — разные запросы к базе: `--only`
  // не должен тянуть ни одного лишнего.
  const rows = [
    ...(options.only === "archive_partial"
      ? []
      : await deps.store.listUnreadable({
          reasonLike: REPARSE_REASON_FRAGMENTS,
          ...scope,
        })),
    ...(options.only === undefined || options.only === "archive_partial"
      ? await deps.store.listPartialArchives(scope)
      : []),
  ];

  const grouped = groupByTender(rows, options.only);
  const tenderIds = [...grouped.keys()].slice(
    0,
    options.limit && options.limit > 0 ? options.limit : undefined,
  );

  for (const tenderId of tenderIds) {
    for (const { category } of grouped.get(tenderId) ?? []) {
      report.candidates += 1;
      report.byCategory[category] += 1;
    }
  }
  report.tenders = tenderIds.length;

  const ocr = await deps.ocrAvailable();

  if (options.dryRun) {
    deps.log(
      `[dry-run] закупок ${report.tenders}, документов ${report.candidates}: ` +
        `форматы ${report.byCategory.format}, сканы ${report.byCategory.scan}, ` +
        `модули ${report.byCategory.module}, pdf ${report.byCategory.pdf_structure}, ` +
        `бюджет ${report.byCategory.budget}, предел объёма ${report.byCategory.limit}, ` +
        `архивы прочитаны частично ${report.byCategory.archive_partial}`,
    );
    deps.log(
      ocr
        ? "[dry-run] распознавание на этой машине есть: сканы будут прочитаны."
        : "[dry-run] распознавания на этой машине нет: сканы и картинки будут пропущены.",
    );
    for (const tenderId of tenderIds) {
      for (const { doc, category } of grouped.get(tenderId) ?? []) {
        deps.log(
          `  ${tenderId}  ${doc.filename}  [${category}]  ` +
            (category === "archive_partial" && doc.archive
              ? `прочитано ${doc.archive.parsed} из ${doc.archive.total} файлов архива`
              : (doc.reason ?? "")),
        );
      }
    }
    return report;
  }

  const fetchDeps: AttachmentFetchDeps = {
    fetchHtml: async () => {
      throw new Error("Повторный разбор не читает страницы ЕИС.");
    },
    fetchFile: deps.fetchFile,
    parse: deps.parse,
    ...(deps.parseVolumes ? { parseVolumes: deps.parseVolumes } : {}),
    ...(deps.disk ? { disk: deps.disk } : {}),
  };
  const diskReady = deps.disk ? await deps.disk.available().catch(() => false) : false;

  let consecutiveSaveFailures = 0;

  for (const tenderId of tenderIds) {
    const candidates = grouped.get(tenderId) ?? [];
    const all = await deps.store.listTender(tenderId);

    // Уже прочитанное занимает бюджет: перечитанное добавляется к нему, а не к нулю.
    let used = all
      .filter((row) => row.parsedStatus === "parsed")
      .reduce(
        (sum, row) =>
          sum +
          occupiedChars({
            filename: row.filename,
            parsedStatus: row.parsedStatus,
            chars: row.chars,
            fileSize: row.fileSize,
            skipCode: row.skipCode,
          }),
        0,
      );

    deps.log(
      `${tenderId}: к перечитыванию ${candidates.length}, занято ${used.toLocaleString("ru-RU")} знаков, ` +
        `бюджет ${Number.isFinite(budget) ? `${budget.toLocaleString("ru-RU")} знаков` : "не ограничен"}`,
    );

    for (const unit of planUnits(candidates, all)) {
      let documents: PreparedDocument[];
      // Частично прочитанный архив уже занимает бюджет своим прежним текстом, но
      // его заменят: старый объём в остаток не вычитается.
      const previous = unit.partial
        ? unit.kind === "file"
          ? unit.doc
          : unit.docs[0]
        : undefined;
      const previousChars = previous
        ? occupiedChars({
            filename: previous.filename,
            parsedStatus: previous.parsedStatus,
            chars: previous.chars,
            fileSize: previous.fileSize,
            skipCode: previous.skipCode,
          })
        : 0;
      const remaining = budget - used + previousChars;

      if (unit.kind === "file") {
        if (unit.needsOcr && !ocr) {
          report.skippedNoOcr += 1;
          deps.log(
            `  = ${unit.doc.filename}: пропущен, распознавания на машине нет`,
          );
          continue;
        }
        if (
          !diskReady &&
          (unit.doc.reason?.includes(NO_ARCHIVE_CLI_FRAGMENT) ?? false)
        ) {
          report.skippedNoCli += 1;
          deps.log(
            `  = ${unit.doc.filename}: пропущен, на машине нет 7z и unrar — предел объёма прежний`,
          );
          continue;
        }
        if (remaining <= 0) {
          documents = [overBudgetDocument(unit.doc, budget)];
          report.overBudget += 1;
        } else {
          try {
            const row = await readAttachmentFile(
              refOf(unit.doc),
              fetchDeps,
              remaining,
            );
            documents = [prepare(row)];
          } catch (err) {
            // Блокировка ЕИС: останавливаемся, не затирая прежнюю причину пропуска
            // строкой «download_failed» — файл перечитает следующий запуск.
            if (!isEisBlockedError(err)) throw err;
            report.aborted = err.message;
            return report;
          }
        }
      } else {
        const set = unit;
        // У частично прочитанного комплекта первый том «parsed» по определению:
        // это и есть причина перечитать, а не признак «уже прочитан».
        if (!set.partial && set.docs.some((doc) => doc.parsedStatus === "parsed")) {
          report.skippedSets += 1;
          deps.log(`  = комплект «${set.name}»: уже прочитан, пропущен`);
          continue;
        }
        if (set.docs.some((doc) => !doc.fileUrl)) {
          report.skippedSets += 1;
          deps.log(
            `  = комплект «${set.name}»: у тома нет ссылки на файл, пропущен`,
          );
          continue;
        }
        if (
          !diskReady &&
          set.docs.some((doc) => doc.reason?.includes(NO_ARCHIVE_CLI_FRAGMENT))
        ) {
          report.skippedNoCli += 1;
          deps.log(
            `  = комплект «${set.name}»: пропущен, на машине нет 7z и unrar — предел объёма прежний`,
          );
          continue;
        }
        if (remaining <= 0) {
          documents = set.docs.map((doc) => overBudgetDocument(doc, budget));
          report.overBudget += 1;
        } else {
          try {
            const rows = await readVolumeSet(
              set.docs.map(refOf),
              fetchDeps,
              remaining,
            );
            documents = rows.map(prepare);
          } catch (err) {
            if (!isEisBlockedError(err)) throw err;
            report.aborted = err.message;
            return report;
          }
        }
      }

      if (previous) {
        const verdict = archiveVerdict(previous, documents[0]);
        if (!verdict.better) {
          report.processed += 1;
          report.notImproved += 1;
          const fresh = documents[0]?.archive;
          let marked = false;
          if (deps.store.markArchive && fresh?.skipped && fresh.skipped.length > 0) {
            try {
              await deps.store.markArchive(tenderId, previous.filename, fresh);
              marked = true;
            } catch (err) {
              deps.log(`  ✗ ${previous.filename}: отчёт об архиве не записан: ${describeError(err)}`);
            }
          }
          deps.log(
            `  = ${previous.filename}: не лучше прежнего, ` +
              `${marked ? `текст не тронут, записан список непрочитанных (${fresh?.skipped?.length ?? 0})` : "строка не тронута"} ` +
              `(${verdict.note})`,
          );
          continue;
        }
        deps.log(`  ↑ ${previous.filename}: ${verdict.note}`);
      }

      report.processed += 1;
      let savedReadable = false;

      for (const document of documents) {
        try {
          await deps.store.save(tenderId, document);
          consecutiveSaveFailures = 0;
        } catch (err) {
          // Сбой записи одного документа (например, знак, который Postgres не
          // принимает) не должен останавливать остальных: пишем причину и идём дальше.
          report.saveFailures += 1;
          consecutiveSaveFailures += 1;
          deps.log(
            `  ✗ ${tenderId}: не удалось сохранить ${document.filename}: ${describeError(err)}`,
          );
          if (consecutiveSaveFailures >= MAX_CONSECUTIVE_SAVE_FAILURES) {
            report.aborted = `${MAX_CONSECUTIVE_SAVE_FAILURES} сбоев записи подряд, последний: ${describeError(err)}`;
            return report;
          }
          continue;
        }
        if (document.skipped === null) {
          used += document.chars;
          savedReadable = true;
        }
        deps.log(
          document.skipped === null
            ? `  ✓ ${document.filename}: ${document.chars.toLocaleString("ru-RU")} знаков` +
                (document.ocr
                  ? `, распознано ${document.ocr.pages} из ${document.ocr.totalPages} стр.`
                  : "")
            : `  · ${document.filename}: ${document.skipped.reason}`,
        );
      }

      // Счёт ведётся по записанному: документ, который не сохранился, прочитанным не считается.
      if (previous) {
        if (savedReadable) {
          report.improved += 1;
          // Прежний текст заменён новым: в бюджете остаётся только новый.
          used -= previousChars;
        }
      } else if (savedReadable) report.recovered += 1;
      else if (!documents.some((d) => d.skipped?.code === "over_char_budget"))
        report.stillUnreadable += 1;
    }
  }

  return report;
}

/** Параметры командной строки скрипта: вынесены сюда, чтобы их проверяли тесты. */
export function parseReparseArgs(argv: readonly string[]): ReparseOptions & {
  help: boolean;
} {
  const options: ReparseOptions & { help: boolean } = {
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--limit": {
        const value = Number(argv[i + 1]);
        if (!Number.isFinite(value) || value <= 0)
          throw new Error("--limit требует число больше нуля");
        options.limit = Math.floor(value);
        i += 1;
        break;
      }
      case "--tender": {
        const value = argv[i + 1];
        if (!value)
          throw new Error("--tender требует реестровый номер закупки");
        options.tenderId = value;
        i += 1;
        break;
      }
      case "--only": {
        const value = argv[i + 1];
        if (!value || !REPARSE_CATEGORIES.includes(value as ReparseCategory))
          throw new Error(
            `--only требует одну из групп: ${REPARSE_CATEGORIES.join(", ")}`,
          );
        options.only = value as ReparseCategory;
        i += 1;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }
  return options;
}
