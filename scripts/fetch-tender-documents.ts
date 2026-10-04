import { config } from "dotenv";
import { resolve } from "node:path";
import { sourceFacts } from "../src/domain/sources";
import { analysisJobRepository } from "../src/repositories/analysisJobRepository";
import { documentRepository } from "../src/repositories/documentRepository";
import { tenderRepository } from "../src/repositories/tenderRepository";
import {
  parseArchiveVolumes,
  parseAttachment,
} from "../src/services/attachmentParser";
import { computeContentHash } from "../src/services/documentParser";
import { createKonturAdapter } from "../src/services/konturSyncService";
import {
  fetchKonturCardDocuments,
  type KonturDocumentDeps,
  type KonturDocumentOutcome,
} from "../src/services/konturDocumentFetch";
import {
  fetchTektorgPlatformDocuments,
  type TektorgDocumentDeps,
  type TektorgDocumentOutcome,
} from "../src/services/tektorgDocumentFetch";
import { createTektorgAdapter } from "../src/services/tenderSourceRegistry";
import {
  MAX_FILE_BYTES,
  type FetchedFile,
} from "../src/services/tenderAttachmentsFetcher";
import {
  ensureTenderDocuments,
  type DocumentSyncOutcome,
  type TenderDocumentStore,
  type TenderDocumentSyncDeps,
  type TenderSourceLookup,
} from "../src/services/tenderDocumentSync";
import type { PreparedDocument } from "../src/services/tenderDocumentSync";

config({ path: resolve(__dirname, "../.env.local") });

/**
 * Загрузка документации закупок из ЕИС для глубокого анализа.
 *
 * Зачем отдельный скрипт, а не воркер на Vercel: ЕИС не пускает зарубежные IP,
 * поэтому скачать извещение и вложения может только российская машина. Шлюз
 * модели с 2026-09-22 российский (routerai.ru) и отвечает с обоих концов, но
 * воркер живёт на проде — там очередь analysis_jobs и планировщик. Отсюда
 * разделение:
 *   1. этот скрипт кладёт в tender_documents готовый текст извещения и всех
 *      вложений в пределах миллиона знаков на закупку, а для файлов, которые
 *      не попали в разбор, — причину пропуска;
 *   2. воркер на проде видит готовый текст, не качает ничего и запускает
 *      AI-разбор, а скрипт вызывает его в цикле, пока очередь не опустеет.
 *
 * Задачи берёт из очереди analysis_jobs: их создаёт интерфейс, когда закупку
 * переводят в «Интересное». Скрипт вызывается из хвоста scripts/sync-eis.ts,
 * то есть раз в два часа вместе с плановой синхронизацией.
 *
 * Документация закупки Контур.Закупок читается здесь же и тем же обходом:
 * агрегатор отдаёт номер извещения ЕИС, а его `Docs[].Url` ведут на filestore
 * zakupki.gov.ru, поэтому печатную форму и вкладку документов отдаёт ЕИС —
 * бесплатно и без ключа. Карточка самого Контура нужна только для закупок,
 * которых в ЕИС нет; она платная (боевой тариф — 30 карточек в сутки) и
 * включается отдельным флагом --kontur-cards. Боевой ключ отдаёт в `Docs[].Url`
 * настоящие ссылки на тот же filestore, поэтому скачивание карточки, как и
 * обход ЕИС, работает только с российского адреса. Карточка кэшируется на семь
 * суток: повторный прогон по той же закупке платного запроса не делает.
 *
 * Закупка площадки ТЭК-Торг читается своим источником: номер процедуры
 * («ЗП610102») в ЕИС не публикуется, поэтому ни печатной формы, ни вкладки
 * документов у такой строки нет вовсе. Адреса байт приходят в том же бесплатном
 * SOAP-экспорте, что и сами закупки, — ключа не нужно, платный бюджет дня не
 * расходуется, и отдельного флага поэтому нет. Обход остаётся российским:
 * api.tektorg.ru, как и filestore, не пускает зарубежные IP.
 *
 * Оба запасных пути выбирает `data_source` строки закупки: сначала бесплатный
 * обход ЕИС, и только если он не дал текста — источник, который перечисляет
 * файлы сам.
 *
 * Запуск:
 *   npx tsx scripts/fetch-tender-documents.ts                 — вся очередь
 *   npx tsx scripts/fetch-tender-documents.ts --tender 0573100026626000009
 *   npx tsx scripts/fetch-tender-documents.ts --dry-run       — ничего не писать
 *   npx tsx scripts/fetch-tender-documents.ts --force         — перечитать страницы
 *   npx tsx scripts/fetch-tender-documents.ts --kontur-cards  — дочитать карточку Контура
 */

const DEFAULT_BASE_URL = "https://tenderfit-ai-sage.vercel.app";

/** Страница печатной формы весит около мегабайта, запас по времени нужен большой. */
const PAGE_TIMEOUT_MS = 60_000;

/**
 * Вложение может весить до MAX_FILE_BYTES (50 МБ) — на медленной линии это
 * минуты. Таймаут поднят вместе с пределом объёма: иначе файл на 30 МБ
 * обрывался бы на середине и попадал в базу сетевой ошибкой вместо текста,
 * хотя предел объёма он проходит.
 */
const FILE_TIMEOUT_MS = 240_000;

/** AI-разбор одного документа на Vercel занимает десятки секунд. */
const WORKER_TIMEOUT_MS = 120_000;

/**
 * Сколько времени отведено на скачивание.
 *
 * Закупка с полусотней вложений читается минуты три, а в очереди их до
 * двадцати. Ограничитель нужен, чтобы прогон не залез на следующий запуск
 * планировщика: недочитанные закупки останутся в очереди и дождутся своего часа.
 */
const FETCH_BUDGET_MS = 25 * 60_000;

/**
 * Ограничители дренажа очереди анализа.
 *
 * Одна задача больше не разбирается за один вызов: вложений много, воркер
 * укладывается в 40 секунд и возвращает недоделанную задачу в очередь. Миллион
 * знаков — это десять фрагментов минимум, то есть десяток вызовов на закупку.
 * Худший случай прогона: 25 минут скачивания плюс 20 минут дренажа — около
 * 45 минут при интервале планировщика 2 часа.
 */
const WORKER_MAX_CALLS = 40;
const WORKER_BUDGET_MS = 20 * 60_000;

/** Три сбоя подряд — прод недоступен или воркер падает, долбить дальше нечего. */
const MAX_CONSECUTIVE_WORKER_ERRORS = 3;

/** Без User-Agent zakupki.gov.ru отдаёт 403. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 TenderFit/1.0";

interface Options {
  tenders: string[];
  baseUrl: string;
  dryRun: boolean;
  force: boolean;
  limit: number;
  runWorker: boolean;
  /**
   * Читать карточку Контур.Закупок, когда ЕИС документацию не отдала.
   *
   * Флаг по умолчанию выключен: карточка — платная группа `purchase`, и тратить
   * её на закупку, которую пользователь не отложил в «Интересное», нельзя.
   * ЕИС при этом остаётся первым источником — она отдаёт те же файлы бесплатно.
   */
  konturCards: boolean;
}

/** Значения по умолчанию — их же использует scripts/sync-eis.ts. */
const DEFAULT_OPTIONS: Options = {
  tenders: [],
  baseUrl: DEFAULT_BASE_URL,
  dryRun: false,
  force: false,
  limit: 20,
  runWorker: true,
  konturCards: false,
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
    tenders: [],
    baseUrl: DEFAULT_BASE_URL,
    dryRun: false,
    force: false,
    limit: 20,
    runWorker: true,
    konturCards: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--tender":
      case "--reg-number": {
        const value = argv[i + 1];
        if (!value) throw new Error(`${arg} требует реестровый номер закупки`);
        options.tenders.push(value);
        i += 1;
        break;
      }
      case "--base-url": {
        const value = argv[i + 1];
        if (!value) throw new Error(`${arg} требует адрес приложения`);
        options.baseUrl = value.replace(/\/+$/, "");
        i += 1;
        break;
      }
      case "--limit": {
        const value = Number(argv[i + 1]);
        if (!Number.isFinite(value) || value <= 0)
          throw new Error(`${arg} требует число больше нуля`);
        options.limit = Math.floor(value);
        i += 1;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--no-worker":
        options.runWorker = false;
        break;
      case "--kontur-cards":
        options.konturCards = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }

  return options;
}

function printUsage(): void {
  console.log(
    [
      "Загрузка документации закупок из ЕИС для глубокого анализа.",
      "",
      "  --tender <номер>   закупка для обработки (можно несколько раз)",
      "  --limit <N>        сколько задач из очереди брать (по умолчанию 20)",
      "  --base-url <url>   адрес приложения с воркером (по умолчанию прод)",
      "  --force            перечитать страницы, даже если текст уже в базе",
      "  --dry-run          показать, что было бы сделано, ничего не записывая",
      "  --no-worker        не запускать AI-разбор на проде",
      "  --kontur-cards     дочитывать карточку Контур.Закупок, когда ЕИС ничего не",
      "                     отдала; платный запрос группы purchase на каждую закупку",
      "                     (боевой тариф — 30 карточек в сутки)",
      "",
      "Документация закупки ТЭК-Торга дочитывается всегда и без флага: её отдаёт",
      "бесплатный SOAP-экспорт площадки, а в ЕИС номера процедуры нет вовсе.",
    ].join("\n"),
  );
}

/** Загрузка страницы ЕИС. Ошибку бросаем наружу — её перехватит ensureTenderDocuments. */
async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.text();
}

/**
 * Загрузка байтов вложения.
 *
 * Тело читается потоком и обрывается на пределе: многотомная проектная
 * документация весит сотни мегабайт, а держать её в памяти процесса незачем —
 * обход всё равно запишет причину пропуска. `content-length` ЕИС отдаёт не
 * всегда, поэтому проверяется и фактически прочитанный объём.
 *
 * `content-type` у filestore всегда `application/download`, то есть о формате не
 * говорит ничего: определитель берёт его из имени файла, а MIME остаётся для
 * записи в базу.
 */
async function fetchFile(url: string): Promise<FetchedFile> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Accept-Language": "ru-RU,ru;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type");
  const declared = Number(response.headers.get("content-length") ?? "");
  const contentLength = Number.isFinite(declared) ? declared : 0;

  const reader = response.body?.getReader();
  if (!reader) {
    return { bytes: new Uint8Array(0), contentType, contentLength };
  }
  if (contentLength > MAX_FILE_BYTES) {
    await reader.cancel();
    return {
      bytes: new Uint8Array(0),
      contentType,
      contentLength,
      tooLarge: true,
    };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) {
        tooLarge = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    // Прерванное чтение надо закрыть, иначе соединение останется висеть.
    await reader.cancel().catch(() => undefined);
  }

  if (tooLarge) {
    return {
      bytes: new Uint8Array(0),
      contentType,
      contentLength,
      tooLarge: true,
    };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, contentType, contentLength };
}

/** Реальное хранилище: читает служебные поля и пишет документ вместе с текстом. */
const supabaseStore: TenderDocumentStore = {
  async list(regNumber) {
    const meta = await documentRepository.listMetaByTenderId(regNumber);
    return meta.map((document) => ({
      filename: document.filename,
      parsedStatus: document.parsed_status,
      chars: document.raw_json?.chars ?? null,
      fileSize: document.file_size,
    }));
  },
  async save(regNumber, document: PreparedDocument) {
    // Выбор метода по полю skipped: у документа с текстом пишется parsed_text
    // и content_hash, у пропущенного — причина в raw_json и error_message.
    if (document.skipped !== null) {
      await documentRepository.saveSkipped({
        tender_id: regNumber,
        filename: document.filename,
        title: document.title,
        document_type: document.documentType,
        source_type: document.sourceType,
        file_url: document.fileUrl,
        mime_type: document.mimeType,
        file_size: document.fileSize,
        skipped: document.skipped,
      });
      return;
    }

    await documentRepository.saveParsed({
      tender_id: regNumber,
      filename: document.filename,
      title: document.title,
      document_type: document.documentType,
      source_type: document.sourceType,
      file_url: document.fileUrl,
      mime_type: document.mimeType,
      parsed_text: document.text,
      content_hash: document.contentHash ?? computeContentHash(document.text),
      file_size: document.fileSize,
      chars: document.chars,
      // Обрезку пишем обязательно: на живой закупке 32616393585 архив из 15
      // вложений отдал 2, и без этой отметки карточка показала бы «Разбор
      // завершён» над документацией, которую модель не видела целиком.
      truncated: document.truncated,
      archive: document.archive,
    });
  },
};

/** В --dry-run документы не пишутся, но всё остальное работает по-настоящему. */
const dryRunStore: TenderDocumentStore = {
  list: (regNumber) => supabaseStore.list(regNumber),
  async save(regNumber, document) {
    const what =
      document.skipped === null
        ? `${document.chars.toLocaleString("ru-RU")} знаков${truncationNote(document)}`
        : `пропуск — ${document.skipped.reason}`;
    console.log(
      `  · [dry-run] записали бы ${document.filename} (${what}) в ${regNumber}`,
    );
  },
};

/**
 * Чем кончился разбор файла, одной строкой для журнала.
 *
 * Обрезка — не мелочь: на закупке 32616393585 архив документации о закупке из
 * 15 вложений отдал 2, потому что остаток бюджета знаков кончился на нём.
 * Без числа входов в журнале это выглядело бы как успешная загрузка.
 */
function truncationNote(document: PreparedDocument): string {
  if (document.skipped !== null || !document.truncated) return "";
  if (document.archive) {
    return `, обрезан: прочитано ${document.archive.parsed} из ${document.archive.total} файлов архива`;
  }
  return ", обрезан по бюджету знаков";
}

const lookup: TenderSourceLookup = {
  async findByRegNumber(regNumber) {
    const row = await tenderRepository.findByRegNumber(regNumber);
    if (!row) return null;
    return {
      regNumber: row.reg_number,
      law: row.law,
      dataSource: row.data_source,
      // Способ размещения определяет код процедуры в адресе вкладки документов.
      // Неверный код не страшен: ЕИС ответит 302 на правильный.
      placingWay: row.placing_way ?? null,
    };
  },
};

function requireSupabaseEnv(): void {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    throw new Error(`В .env.local нет ${missing.join(", ")}`);
  }
}

/** Одна строка журнала на закупку — по ней видно, что произошло и почему. */
function reportOutcome(outcome: DocumentSyncOutcome): void {
  switch (outcome.status) {
    case "saved": {
      const skipped =
        outcome.skipped > 0 ? `, пропущено ${outcome.skipped}` : "";
      const truncated =
        outcome.truncated > 0 ? `, обрезано ${outcome.truncated}` : "";
      const note = outcome.note ? ` — ${outcome.note}` : "";
      console.log(
        `  ✓ ${outcome.regNumber}: сохранено ${outcome.filenames.length} ` +
          `(${outcome.characters.toLocaleString("ru-RU")} знаков${skipped}${truncated})${note}`,
      );
      return;
    }
    case "already":
      console.log(
        `  = ${outcome.regNumber}: документация уже в базе (${outcome.filenames.length})` +
          (outcome.note ? ` — ${outcome.note}` : ""),
      );
      return;
    case "unavailable":
      console.log(`  ! ${outcome.regNumber}: ${outcome.reason}`);
      return;
    case "not_found":
      console.log(`  ? ${outcome.regNumber}: ${outcome.reason}`);
      return;
    case "failed":
      console.error(`  ✗ ${outcome.regNumber}: ${outcome.reason}`);
      return;
  }
}

/**
 * Зависимости для чтения карточки Контур.Закупок; null — путь закрыт.
 *
 * Ключа в окружении может не быть (на проде его нет намеренно: ролей в
 * приложении нет, а карточка стоит денег), а флаг при этом задан. Молча
 * пропустить нельзя — журнал обязан сказать, почему документы не дочитаны.
 */
async function createKonturDeps(
  store: TenderDocumentStore,
): Promise<KonturDocumentDeps | null> {
  const apiKey = process.env.KONTUR_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    console.log(
      "  ! --kontur-cards задан, но KONTUR_API_KEY не настроен — карточки Контур.Закупок не читаются.",
    );
    return null;
  }

  // Один адаптер на прогон: кэш карточки и счётчик расхода общие, поэтому
  // повторное обращение к той же закупке в пределах TTL бесплатно.
  const adapter = await createKonturAdapter();
  return {
    card: {
      readDocuments: (externalId) => adapter.fetchCardDocumentList(externalId),
    },
    store,
    fetchHtml,
    fetchFile,
    parse: parseAttachment,
    parseVolumes: parseArchiveVolumes,
  };
}

/** Одна строка журнала на карточку Контур.Закупок — по ней видно, что получено. */
function reportKonturOutcome(outcome: KonturDocumentOutcome): void {
  switch (outcome.status) {
    case "saved":
      console.log(
        `  ✓ карточка Контур.Закупок ${outcome.regNumber}: сохранено ` +
          `${outcome.filenames.length} (${outcome.characters.toLocaleString("ru-RU")} знаков` +
          (outcome.skipped > 0 ? `, пропущено ${outcome.skipped}` : "") +
          ")",
      );
      return;
    case "already":
      console.log(
        `  = карточка Контур.Закупок ${outcome.regNumber}: документы уже в базе ` +
          `(${outcome.filenames.length})`,
      );
      return;
    case "names_only":
      console.log(
        `  ! карточка Контур.Закупок ${outcome.regNumber}: записаны имена ` +
          `${outcome.filenames.length} файлов без текста — ${outcome.reason}`,
      );
      return;
    case "empty":
      console.log(
        `  ! карточка Контур.Закупок ${outcome.regNumber}: ${outcome.reason}`,
      );
      return;
    case "failed":
      console.error(
        `  ✗ карточка Контур.Закупок ${outcome.regNumber}: ${outcome.reason}`,
      );
      return;
  }
}

/**
 * Зависимости для чтения документов ТЭК-Торга.
 *
 * В отличие от карточки Контур.Закупок путь открыт всегда: SOAP-экспорт
 * процедур публичный, ключа не требует и платного бюджета не расходует.
 * Отдельный флаг означал бы, что оператор должен помнить, для какого источника
 * его включать, — а забыть его значит молча остаться без документации по
 * закупке, которой нет в ЕИС.
 */
function createTektorgDeps(store: TenderDocumentStore): TektorgDocumentDeps {
  const adapter = createTektorgAdapter();
  return {
    reader: {
      readDocuments: (tenderId) => adapter.readDocumentList(tenderId),
    },
    store,
    fetchHtml,
    fetchFile,
    parse: parseAttachment,
    parseVolumes: parseArchiveVolumes,
  };
}

/** Одна строка журнала на документы ТЭК-Торга — по ней видно, что получено. */
function reportTektorgOutcome(outcome: TektorgDocumentOutcome): void {
  switch (outcome.status) {
    case "saved":
      console.log(
        `  ✓ площадка ТЭК-Торг ${outcome.regNumber}: сохранено ` +
          `${outcome.filenames.length} (${outcome.characters.toLocaleString("ru-RU")} знаков` +
          (outcome.skipped > 0 ? `, пропущено ${outcome.skipped}` : "") +
          (outcome.withdrawn > 0 ? `, из них отозвано ${outcome.withdrawn}` : "") +
          ")",
      );
      return;
    case "already":
      console.log(
        `  = площадка ТЭК-Торг ${outcome.regNumber}: документы уже в базе ` +
          `(${outcome.filenames.length})`,
      );
      return;
    case "no_text":
      console.log(
        `  ! площадка ТЭК-Торг ${outcome.regNumber}: записаны имена ` +
          `${outcome.filenames.length} файлов без текста — ${outcome.reason}`,
      );
      return;
    case "empty":
      console.log(`  ! площадка ТЭК-Торг ${outcome.regNumber}: ${outcome.reason}`);
      return;
    case "failed":
      console.error(`  ✗ площадка ТЭК-Торг ${outcome.regNumber}: ${outcome.reason}`);
      return;
  }
}

/** Оба запасных пути: какой из них нужен, решает источник строки закупки. */
interface SourceDocumentDeps {
  tektorg: TektorgDocumentDeps;
  /** null — платный путь закрыт: флаг не задан или ключ не настроен. */
  kontur: KonturDocumentDeps | null;
}

/**
 * Запасной путь: документация от источника, который перечисляет файлы сам.
 *
 * Вызывается, когда ЕИС ничего не отдала (`unavailable`). Дальше всё решает
 * `data_source` строки: у Контур.Закупок это платная карточка, у ТЭК-Торга —
 * бесплатный SOAP-экспорт, у остальных источников своих файлов нет, и причину
 * этого печатает каталог (`documentsReason`), а не общая фраза.
 *
 * Строка читается один раз на все ветки. Раньше у каждого источника была своя
 * проверка с собственным сообщением, и прогон по закупке ТЭК-Торга с включённым
 * флагом --kontur-cards печатал бы два отказа подряд: оператор не понял бы,
 * какой из них настоящий.
 *
 * Возвращает статус для счётчиков прогона. `already` считается успехом наравне
 * с `saved`: текст в базе есть, значит закупку можно отдавать на разбор.
 */
async function trySourceDocuments(
  regNumber: string,
  deps: SourceDocumentDeps,
  force: boolean,
): Promise<DocumentSyncOutcome["status"]> {
  const row = await tenderRepository.findByRegNumber(regNumber);
  if (!row) {
    console.log(
      `  · ${regNumber}: строки закупки нет — документацию источника не прочитать.`,
    );
    return "unavailable";
  }

  if (row.data_source === "TEK_TORG") {
    if (!row.external_id) {
      console.log(
        `  · ${regNumber}: у строки нет external_id — номер площадки неизвестен, ` +
          "экспорт по нему не спросить.",
      );
      return "unavailable";
    }
    const outcome = await fetchTektorgPlatformDocuments(
      row.reg_number,
      row.external_id,
      deps.tektorg,
      { force },
    );
    reportTektorgOutcome(outcome);
    return outcome.status === "saved" || outcome.status === "already"
      ? outcome.status
      : "unavailable";
  }

  if (row.data_source === "KONTUR") {
    if (!deps.kontur) {
      console.log(
        `  · ${regNumber}: закупка из Контур.Закупок, а карточка не включена — ` +
          "нужен флаг --kontur-cards и KONTUR_API_KEY.",
      );
      return "unavailable";
    }
    if (!row.external_id) {
      console.log(
        `  · ${regNumber}: у строки нет external_id — карточку Контур.Закупок не открыть.`,
      );
      return "unavailable";
    }
    const outcome = await fetchKonturCardDocuments(
      row.reg_number,
      row.external_id,
      deps.kontur,
      { force },
    );
    reportKonturOutcome(outcome);
    return outcome.status === "saved" || outcome.status === "already"
      ? outcome.status
      : "unavailable";
  }

  // Остальные источники: причину «документации нет» уже записал каталог, и
  // печатать вместо неё одну фразу на всех нельзя — она неверна. Сбербанк-АСТ и
  // демонстрационные данные действительно не перечисляют файлы, а Росэлторг
  // перечисляет, но хост `com.roseltorg.ru` запрещает доступ роботам целиком.
  // Оператор, прочитав «источник файлы сам не перечисляет» про Росэлторг, пошёл
  // бы искать баг в парсере выдачи, которого нет.
  const facts = sourceFacts(row.data_source);
  console.log(
    `  · ${regNumber}: ${
      facts.documentsReason ?? `источник ${row.data_source} файлы сам не перечисляет`
    } — документации у закупки нет.`,
  );
  return "unavailable";
}

/** Что воркер возвращает про одну обработанную задачу. */
interface WorkerProcessed {
  jobId: string;
  tenderId: string;
  documentsProcessed: number;
  findingsTotal: number;
  verdictChanged: boolean;
  /** true — лимит функции кончился, задача вернулась в очередь на дозапуск. */
  deferred: boolean;
}

interface WorkerRunResult {
  processed: WorkerProcessed | null;
  staleJobsReset?: number;
  error?: string;
}

/**
 * Запускает воркер на проде: один вызов обрабатывает одну задачу из очереди,
 * а недоделанную возвращает обратно. Сетевой сбой не роняет прогон — документы
 * уже сохранены, анализ догонит следующий вызов (крон или повторный запуск).
 */
async function runWorkerOnce(baseUrl: string): Promise<WorkerRunResult> {
  const url = `${baseUrl}/api/analysis/worker`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
    const body = (await response.json()) as WorkerRunResult;
    if (!response.ok) {
      return {
        processed: null,
        error: `HTTP ${response.status}: ${body.error ?? "без описания"}`,
      };
    }
    return body;
  } catch (err) {
    const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
    return {
      processed: null,
      error: `${err instanceof Error ? err.message : String(err)}${code ? ` (${code})` : ""}`,
    };
  }
}

interface DrainSummary {
  calls: number;
  /** Задач закрыто до конца. */
  completed: number;
  /** Сколько раз задача не уложилась в лимит функции и вернулась в очередь. */
  deferred: number;
  findings: number;
  verdictsChanged: number;
  errors: number;
  /** Почему дренаж остановился раньше пустой очереди; null — очередь опустела. */
  stopReason: string | null;
}

/**
 * Дренаж очереди анализа: вызывает воркер, пока задачи не кончатся.
 *
 * Одна закупка больше не разбирается за один вызов — вложений много, воркер
 * укладывается в 40 секунд и возвращает задачу в очередь. Отсюда цикл до пустой
 * очереди, а не «по вызову на закупку», как было раньше: прежний вариант
 * оставлял недоделанные задачи висеть до следующего прогона.
 *
 * Ограничители — число вызовов и время. Без них прогон на двадцати закупках
 * с миллионом знаков шёл бы часами и залезал на следующий запуск планировщика.
 * Недоделанное остаётся в очереди и догоняется потом: фрагменты разбираются
 * по номеру, дважды один и тот же текст модель не увидит.
 */
async function drainWorkerQueue(baseUrl: string): Promise<DrainSummary> {
  const deadline = Date.now() + WORKER_BUDGET_MS;
  const summary: DrainSummary = {
    calls: 0,
    completed: 0,
    deferred: 0,
    findings: 0,
    verdictsChanged: 0,
    errors: 0,
    stopReason: null,
  };
  let consecutiveErrors = 0;
  let queueEmpty = false;

  while (summary.calls < WORKER_MAX_CALLS && Date.now() < deadline) {
    summary.calls += 1;
    const result = await runWorkerOnce(baseUrl);

    if (result.error) {
      summary.errors += 1;
      consecutiveErrors += 1;
      console.error(`  ✗ вызов ${summary.calls}: ${result.error}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_WORKER_ERRORS) {
        summary.stopReason = `воркер ${consecutiveErrors} раза подряд ответил ошибкой`;
        break;
      }
      continue;
    }
    consecutiveErrors = 0;

    if (!result.processed) {
      queueEmpty = true;
      console.log(`  = вызов ${summary.calls}: очередь пуста`);
      break;
    }

    const job = result.processed;
    if (job.deferred) {
      summary.deferred += 1;
      console.log(
        `  … вызов ${summary.calls}: ${job.tenderId} не уложился в лимит функции, ` +
          `документов ${job.documentsProcessed} — продолжит следующий вызов`,
      );
      continue;
    }

    summary.completed += 1;
    summary.findings += job.findingsTotal;
    if (job.verdictChanged) summary.verdictsChanged += 1;
    console.log(
      `  ✓ вызов ${summary.calls}: ${job.tenderId}, документов ${job.documentsProcessed}, ` +
        `факторов ${job.findingsTotal}, вердикт пересмотрен: ${job.verdictChanged ? "да" : "нет"}`,
    );
  }

  if (!queueEmpty && summary.stopReason === null) {
    summary.stopReason = `исчерпан ограничитель дренажа: ${WORKER_MAX_CALLS} вызовов или ${WORKER_BUDGET_MS / 60_000} минут`;
  }

  return summary;
}

/**
 * Итог прогона загрузки документации.
 *
 * Возвращается наружу, потому что прогон запускает не только планировщик: воркер
 * на сервере в России берёт задание из очереди sync_jobs и обязан записать в него
 * честный отчёт. Прежде функция возвращала `void`, и всё, что было известно
 * вызывающему, — «не упало». Числа в отчёте берутся отсюда, а не из подсчёта
 * строк в базе: ноль и «не измеряли» в панели выглядят одинаково, а означают
 * разное.
 */
export interface DocumentFetchSummary {
  /** Закупок было в списке на обработку. */
  requested: number;
  /**
   * Закупок, документация которых сохранена этим прогоном.
   *
   * Считаются закупки, а не файлы: по одной закупке их приходит от одного до
   * десятка, и в строке журнала («✓ 32616408350: сохранено 5») число файлов
   * своё. Дальше по коду это поле попадает в отчёт задания как `documents`,
   * поэтому единица измерения записана здесь, а не подразумевается.
   */
  saved: number;
  /** Закупок, документация которых уже лежала в базе. */
  already: number;
  /** Закупок, чью документацию источник не отдал. */
  unavailable: number;
  /** Закупок, которых не нашлось в ленте. */
  notFound: number;
  /** Закупок, загрузка которых закончилась сбоем. */
  failed: number;
  /** Закупок, у которых текст документации теперь есть в базе. */
  readyForAnalysis: number;
  /** Скачивание прервано по времени: список обработан не весь. */
  stoppedEarly: boolean;
  /** Итог дренажа очереди разбора; null — разбор не запускался. */
  analysis: DrainSummary | null;
  durationMs: number;
}

/**
 * Основной прогон. Экспортируется, чтобы scripts/sync-eis.ts вызывал его
 * в хвосте плановой синхронизации: раз в два часа машина и так в российском
 * сегменте сети, и закупки из «Интересного» получают документацию без отдельной задачи.
 */
export async function runDocumentFetch(
  overrides: Partial<Options> = {},
): Promise<DocumentFetchSummary> {
  const started = Date.now();
  const options: Options = { ...DEFAULT_OPTIONS, ...overrides };

  requireSupabaseEnv();

  console.log(
    `Загрузка документации${options.dryRun ? " (dry-run)" : ""}${options.force ? " (принудительно)" : ""}`,
  );

  const finish = (
    partial: Partial<DocumentFetchSummary> & { requested: number },
  ): DocumentFetchSummary => ({
    saved: 0,
    already: 0,
    unavailable: 0,
    notFound: 0,
    failed: 0,
    readyForAnalysis: 0,
    stoppedEarly: false,
    analysis: null,
    durationMs: Date.now() - started,
    ...partial,
  });

  const deps: TenderDocumentSyncDeps = {
    lookup,
    store: options.dryRun ? dryRunStore : supabaseStore,
    fetchHtml,
    fetchFile,
    parse: parseAttachment,
    parseVolumes: parseArchiveVolumes,
  };

  // Запасной путь Контур.Закупок создаём только по явному флагу: карточка стоит
  // платного запроса, и тратить его на весь список очереди нельзя. ТЭК-Торг
  // открыт всегда — его экспорт бесплатный.
  const sourceDeps: SourceDocumentDeps = {
    tektorg: createTektorgDeps(options.dryRun ? dryRunStore : supabaseStore),
    kontur: options.konturCards
      ? await createKonturDeps(options.dryRun ? dryRunStore : supabaseStore)
      : null,
  };

  // Цели: либо явно перечисленные закупки, либо очередь задач на анализ.
  let regNumbers: string[] = options.tenders;
  if (regNumbers.length === 0) {
    const jobs = await analysisJobRepository.findPending(options.limit);
    regNumbers = [...new Set(jobs.map((job) => job.tender_id))];
    console.log(
      jobs.length === 0
        ? "Очередь анализа пуста: ни одна закупка не переведена в «Интересное»."
        : `В очереди ${jobs.length} задач, закупок к обработке: ${regNumbers.length}.`,
    );
  }

  if (regNumbers.length === 0) {
    console.log(
      `Делать нечего, ${((Date.now() - started) / 1000).toFixed(1)} с`,
    );
    return finish({ requested: 0 });
  }

  const counters = new Map<DocumentSyncOutcome["status"], number>();
  /** Закупки, у которых текст документации теперь точно есть в базе. */
  const readyForAnalysis: string[] = [];
  /** Закупки из очереди, которых нет в tenders: их задачи выполниться не могут. */
  const orphanRegNumbers: string[] = [];
  const fetchDeadline = started + FETCH_BUDGET_MS;
  let fetchStopped = false;

  for (const regNumber of regNumbers) {
    if (Date.now() > fetchDeadline) {
      fetchStopped = true;
      console.log(
        `  … фаза скачивания заняла ${FETCH_BUDGET_MS / 60_000} минут: ` +
          "остальные закупки доберёт следующий прогон, их задачи остались в очереди.",
      );
      break;
    }

    const outcome = await ensureTenderDocuments(regNumber, deps, {
      force: options.force,
    });
    reportOutcome(outcome);

    // ЕИС документацию не отдала: остаётся источник, который перечисляет файлы
    // сам. Какой именно — решает data_source строки закупки (см. trySourceDocuments).
    let status = outcome.status;
    if (status === "unavailable") {
      status = await trySourceDocuments(regNumber, sourceDeps, options.force);
    }
    if (status === "not_found") orphanRegNumbers.push(regNumber);

    counters.set(status, (counters.get(status) ?? 0) + 1);
    if (status === "saved" || status === "already") {
      readyForAnalysis.push(regNumber);
    }
  }

  // Задача на закупку, которой нет в tenders, не выполнится никогда: воркеру
  // нужны и документы, и контекст промпта из строки закупки. Оставить её
  // «pending» — значит показать партнёру вечное «в очереди» (именно так задача
  // 32616403764 висела с 23.09.2026: закупка выпала из выдачи ЕИС, а задача
  // осталась и держала очередь). Закрыть её «completed» с нулём документов —
  // соврать, что разбор состоялся. Пишем честный failed с причиной; кнопка
  // запуска на карточке после failed снова активна.
  for (const regNumber of orphanRegNumbers) {
    const jobs = await analysisJobRepository.findByTenderId(regNumber);
    for (const job of jobs) {
      if (job.status !== "pending" && job.status !== "processing") continue;
      await analysisJobRepository.updateStatus(
        job.id,
        "failed",
        "Закупка исчезла из ленты источника: ни документов, ни карточки для разбора нет. " +
          "Задача закрыта без разбора; верните закупку в «Интересное», когда она снова появится.",
      );
      console.log(
        `  · ${regNumber}: задача анализа закрыта — закупки нет в ленте источника.`,
      );
    }
  }

  console.log();
  console.log(
    `Итог: сохранено ${counters.get("saved") ?? 0}, уже было ${counters.get("already") ?? 0}, ` +
      `недоступно ${counters.get("unavailable") ?? 0}, не найдено ${counters.get("not_found") ?? 0}, ` +
      `ошибок ${counters.get("failed") ?? 0}` +
      (fetchStopped ? " (скачивание прервано по времени)" : ""),
  );

  const counted = {
    requested: regNumbers.length,
    saved: counters.get("saved") ?? 0,
    already: counters.get("already") ?? 0,
    unavailable: counters.get("unavailable") ?? 0,
    notFound: counters.get("not_found") ?? 0,
    failed: counters.get("failed") ?? 0,
    readyForAnalysis: readyForAnalysis.length,
    stoppedEarly: fetchStopped,
  };

  // AI-разбор имеет смысл запускать, только если в базе есть текст.
  // В --dry-run ничего не записано, значит и анализировать нечего.
  if (!options.runWorker || options.dryRun) {
    console.log(
      `Завершено за ${((Date.now() - started) / 1000).toFixed(1)} с, AI-разбор не запускался.`,
    );
    return finish(counted);
  }

  if (readyForAnalysis.length === 0) {
    console.log(
      "Документация не получена ни по одной закупке — AI-разбор не запускается.",
    );
    return finish(counted);
  }

  // Для закупки из --tender задачи в очереди может не быть: создаём её,
  // иначе воркер не знал бы, что анализировать. Приоритет выше обычного —
  // явный запуск рукой важнее фоновой очереди.
  //
  // Ветка доходит до исполнения только при runWorker: true и стоит денег: каждая
  // созданная здесь задача доводится до AI-разбора (≈6 ₽ за закупку при суточном
  // потолке 20). Поэтому загрузка документации по нажатию кнопки «Найти новые
  // закупки» вызывается с runWorker: false — номеров там на десятки, и оплачивать
  // разбор всех без решения партнёра нельзя.
  if (options.tenders.length > 0) {
    for (const regNumber of readyForAnalysis) {
      const jobs = await analysisJobRepository.findByTenderId(regNumber);
      const queued = jobs.some(
        (job) => job.status === "pending" || job.status === "processing",
      );
      if (queued) continue;
      await analysisJobRepository.create(regNumber, "full_analysis", 10);
      console.log(`  + ${regNumber}: создана задача глубокого анализа`);
    }
  }

  console.log(
    `Запуск AI-разбора на ${options.baseUrl} (закупок с документацией: ${readyForAnalysis.length}, ` +
      `вызовов воркера до ${WORKER_MAX_CALLS})...`,
  );

  const drain = await drainWorkerQueue(options.baseUrl);
  if (drain.stopReason) {
    console.log(
      `  ! ${drain.stopReason}: оставшиеся задачи догонит следующий прогон.`,
    );
  }

  console.log(
    `Готово за ${((Date.now() - started) / 1000).toFixed(1)} с: вызовов воркера ${drain.calls}, ` +
      `задач закрыто ${drain.completed}, дозапусков ${drain.deferred}, факторов ${drain.findings}, ` +
      `вердиктов пересмотрено ${drain.verdictsChanged}, ошибок ${drain.errors}.`,
  );

  return finish({ ...counted, analysis: drain });
}

/** Запуск из командной строки. При импорте модуля (из sync-eis.ts) не выполняется. */
if (require.main === module) {
  runDocumentFetch(parseOptions(process.argv.slice(2))).catch(
    (err: unknown) => {
      console.error(
        "Критическая ошибка:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    },
  );
}
