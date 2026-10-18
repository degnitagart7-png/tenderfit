/**
 * Синхронизация закупок в Supabase ПО ПРОФИЛЯМ ПОИСКА.
 *
 * Запуск:  npx tsx scripts/sync-eis.ts            (обычный прогон)
 *          npx tsx scripts/sync-eis.ts --dry-run  (только сбор, без записи в БД)
 *          npx tsx scripts/sync-eis.ts --dry-run --paid-api
 *                 (то же, но с запросами к платному API Контур.Закупок;
 *                  без --paid-api в --dry-run этот источник не опрашивается)
 *          npx tsx scripts/sync-eis.ts --sources=KONTUR
 *                 (только перечисленные источники — так платный прогон не ждёт
 *                  ЕИС и не расходует её выдачу; доступный набор печатает сам
 *                  скрипт, если передать неизвестное имя)
 *
 * Источники:
 *   EIS      — zakupki.gov.ru (44-ФЗ, 223-ФЗ, ПП РФ 615), парсинг HTML-выдачи;
 *   TEK_TORG — ТЭК-Торг, публичный SOAP-экспорт процедур без ключа: секция
 *              `zakupki` (223-ФЗ и коммерческие закупки), окно публикации за
 *              сутки. Ключевых слов экспорт не принимает, поэтому адаптер
 *              скачивает окно целиком и отбирает по словам профиля на своей
 *              стороне: один запрос на профиль, а не по запросу на слово;
 *   ROSELTORG — Росэлторг, публичный серверный поиск без ключа: корпоративные и
 *              коммерческие секции (223-ФЗ и коммерческие закупки). Строка выдачи
 *              — это ЛОТ, а не закупка, поэтому поиск по слову даёт номера
 *              процедур, а полный набор лотов добирается отдельным запросом по
 *              номеру: сумма найденных лотов показала бы закупку за миллионы
 *              закупкой за 500 ₽. Если набор собрать не удалось, цена не
 *              публикуется вовсе. Документацию площадка не отдаёт: файлы лежат на
 *              `com.roseltorg.ru`, а `robots.txt` того хоста запрещает всё;
 *   FABRIKANT — Фабрикант, публичный поиск и карточки `/v2` без ключа: секции
 *              223-ФЗ, коммерческих и корпоративных закупок. Как и у Росэлторга,
 *              строка выдачи — это ЛОТ, но полный набор добирается не запросом по
 *              номеру, а страницами карточки: площадка печатает по пять лотов на
 *              страницу, а их число знает только счётчик вкладки «Список лотов».
 *              Если собрать все страницы не удалось, цена не публикуется вовсе —
 *              сумма пяти лотов из восемнадцати прошла бы лимит профиля и
 *              показала закупку втрое дешевле настоящей. Документацию площадка
 *              отдаёт байтами без авторизации, но 302 уводит на
 *              `storage.fabrikant.ru`, а `robots.txt` того хоста запрещает всё;
 *   SBER_AST — Сбербанк-АСТ, секция «Торги коммерческих заказчиков»
 *              (коммерческие закупки, закон COMMERCIAL);
 *   KONTUR   — Контур.Закупки (440+ площадок), ПЛАТНЫЙ API: включается только
 *              при заданном KONTUR_API_KEY и только для профилей, где источник
 *              указан явно. Окно поиска выравнивается по часу, поэтому
 *              повторный прогон с теми же фильтрами в пределах часа берётся из
 *              кэша сырых ответов и платные запросы не расходует; на границе
 *              часа ключ кэша новый — чаще часа бегать невыгодно.
 *              Остаток считается по тарифу (`/external/v1/limitGroups`, запрос
 *              бесплатный); боевой тариф с 24.09.2026 — 30 запросов в сутки на
 *              каждый метод (группы `search` и `purchase` независимы).
 *              KONTUR_DAILY_REQUEST_LIMIT (по умолчанию 30 на метод) —
 *              страховка на случай, когда тариф прочитать не удалось.
 *              Опрашивается источник НЕ каждый прогон, а раз в
 *              KONTUR_MIN_INTERVAL_HOURS (по умолчанию 6): три ключевых слова
 *              профиля стоят три поиска, плановое задание работает каждые два
 *              часа, и без интервала расход составил бы 36 поисков в сутки при
 *              30 доступных. Закупки от этого не теряются — окно поиска семь
 *              суток, каждый прогон перечитывает всю неделю публикаций.
 *              Явный --sources=KONTUR интервал игнорирует: это команда
 *              «опросить сейчас». Если суточный бюджет всё же исчерпан,
 *              Контур.Закупки пропускаются до следующих суток с ясным
 *              сообщением, а бесплатные площадки продолжают работать.
 *
 * Профили читаются из scripts/sync-profiles.json — отредактируйте под свои
 * профили поиска. Для каждого включённого профиля скрипт опрашивает каждый
 * источник его набора: одни принимают ключевые слова и спрашиваются по каждому
 * из них, другие поиска по словам не имеют и отдают окно публикаций целиком —
 * один запрос на профиль. Кто есть кто, описано в разделе «Источники» выше, а
 * сам набор собирает каталог src/domain/sources.ts. Результаты объединяются и
 * сохраняются в таблицу tenders.
 *
 * Одна закупка — одна строка. Ключ уникальности — reg_number, и Контур.Закупки
 * отдают те же извещения, что публикует ЕИС (номер закупки в его выдаче совпадает
 * с номером извещения), поэтому пересечение источников — норма. Кто из них
 * главнее, решает поле priority в каталоге src/domain/sources.ts; порядка
 * площадок здесь намеренно нет — он менялся трижды за две недели, и записанный
 * от руки отставал бы к следующему подключению. В этом скрипте чисел нет вовсе:
 * он читает каталог через TENDER_SOURCE_PRIORITY. Строку более авторитетного
 * источника агрегатор не перезаписывает — иначе менее полные данные агрегатора
 * затёрли бы заказчика, регион и ссылку на карточку ЕИС. Такие случаи скрипт
 * печатает в итоговой строке как «уже было от другого источника».
 *
 * Переменные окружения (.env.local загружается автоматически):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — подключение к БД
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 — обход корпоративного прокси
 *   KONTUR_API_KEY, KONTUR_API_BASE_URL, KONTUR_DAILY_REQUEST_LIMIT,
 *   KONTUR_MIN_INTERVAL_HOURS —
 *     платный источник Контур.Закупки (см. docs/REFERENCE_KONTUR_API.md)
 *   SYNC_SLOW_INTERVAL_HOURS (по умолчанию 6; 0 — выключить) —
 *     как часто плановый прогон опрашивает медленный трек: Росэлторг и
 *     Фабрикант, которые тратят отдельный запрос карточки на каждую процедуру.
 *     Остальные источники идут каждый прогон. Подробности — src/domain/sourceCadence.ts
 *   SYNC_TRACKS=all или флаг --all-tracks —
 *     опросить оба трека, не проверяя интервал. Воркер ставит это для кнопки
 *     «Запустить прогон» и ручного --full-sync; плановый тик не ставит.
 *
 * Реестр ЕИС, его хранилище файлов и часть площадок блокируют зарубежные IP,
 * поэтому скрипт должен работать с российской машины/сервера. Перед сбором он
 * проверяет связь с каждым нужным источником и печатает текущий публичный IP.
 * Не ответил ни один — прогон прерывается с кодом 2, не трогая данные в БД; не
 * ответила часть — работают остальные, а старые записи недоступного источника
 * остаются в ленте нетронутыми.
 *
 * Расписание с 25.09.2026 живёт на сервере в России: воркер scripts/worker.ts
 * запускает этот скрипт раз в два часа (установка и обслуживание —
 * docs/REFERENCE_RU_WORKER.md). Задача Windows «TenderFit EIS Sync» отключена,
 * обёртка scripts/sync-eis.bat оставлена для ручного запуска.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { TenderSourceAdapter } from "../src/adapters/types";
import type { KonturTenderSourceAdapter } from "../src/adapters/tender-source/konturTenderSourceAdapter";
import type { TektorgTenderSourceAdapter } from "../src/adapters/tender-source/tektorgTenderSourceAdapter";
import type { RoseltorgTenderSourceAdapter } from "../src/adapters/tender-source/roseltorgTenderSourceAdapter";
import type { FabrikantTenderSourceAdapter } from "../src/adapters/tender-source/fabrikantTenderSourceAdapter";
import type { EisTenderSourceAdapter } from "../src/adapters/tender-source/eisTenderSourceAdapter";
import { DEFAULT_OKPD2_BUDGET, planOkpd2Enrichment } from "../src/domain/okpd2Enrichment";
import {
  decideKonturSync,
  konturLastPaidSearchAt,
  konturSourceStop,
  konturSyncIntervalHours,
  saveKonturTenderDocuments,
  type KonturSourceStop,
} from "../src/services/konturSyncService";
import { SOURCE_BINDINGS } from "../src/services/tenderSourceRegistry";
import { cardCacheFile, createDiskCardCache, type DiskCardCache } from "../src/lib/cardCache";
import { cardReuseMaxAgeMs } from "../src/domain/cardReuse";
import { tenderBaseRow } from "../src/domain/tenderRow";
import { defaultSources, slowTrackSources, syncableSources } from "../src/domain/sources";
import { decideTrack, slowTrackIntervalHours } from "../src/domain/sourceCadence";
import {
  KEEP_LIVE_ROWS_FILTER,
  staleRowIds,
  LIVE_ORIGIN,
  buildLiveProfile,
  isLiveExpired,
  liveExpiryCutoff,
  liveRawData,
  normalizeLiveQuery,
  normalizeLiveRegions,
  normalizeLiveSynonyms,
} from "../src/domain/liveSearch";
import { DEMAND_TTL_DAYS, buildDemandProfiles, type DemandRow } from "../src/domain/demand";
import { isRelevantToKeywords } from "../src/domain/relevance";
import { isClosedLongAgo } from "../src/domain/staleTender";
import { runPool } from "../src/lib/runPool";
import { resolveLlmEndpoint } from "../src/services/llmGateway";
import { createSearchAssist, llmChat } from "../src/services/searchAssistService";
import { createFitCache, judgeBySense, type Judge } from "../src/services/semanticGate";

/** Сколько закупок пишется в базу одновременно. */
const SAVE_CONCURRENCY = 8;
/** Очистка старых строк: читаем строки источника страницами, удаляем пачками по id. */
const CLEANUP_PAGE = 1000;
const CLEANUP_DELETE_BATCH = 200;

/** Сколько закупок берёт у ЕИС живой поиск: три страницы по сто. */
const LIVE_EIS_LIMIT = 300;
/**
 * Граница даты размещения для ЕИС. Давние извещения с вечным статусом «Подача
 * заявок» без неё занимали почти всю выдачу: в Бурятии по «ремонту» из 300
 * строк открытых было 15.
 */
const EIS_PUBLISHED_WITHIN_DAYS = 60;
/**
 * Обход всего региона: все открытые закупки, размещённые за этот срок. Во всей
 * ЕИС с заказчиком из Бурятии их за месяц 291 (05.10.2026) — три-четыре
 * страницы. Поиск по слову находил из них единицы (15 по «ремонту», 7 по
 * «строительству»): заказчик пишет «устройство», «благоустройство», «монтаж».
 * Поэтому регион берётся целиком, а отбор по смыслу делается у нас.
 */
const REGION_SWEEP_DAYS = 45;
const REGION_SWEEP_PAGES = 6;
/** Сколько новых закупок за прогон модель оценивает по смыслу (остальное — в следующий). */
const SENSE_MAX_PER_RUN = 600;
/** Минимум закупок на слово у ЕИС в плановом сборе. */
const PLANNED_EIS_MIN_LIMIT = 50;
/** Страниц по сто строк. */
const LIVE_EIS_PAGES = 3;
/**
 * Окно публикации ТЭК-Торга, дни. Суточное окно приносило единицы (05.10.2026:
 * 45 процедур, отобрано 0), а коммерческая закупка принимает заявки неделями.
 * Окно скачивается один раз за прогон и отбирается у нас; закрытые отсеиваются.
 */
const TEK_TORG_WINDOW_DAYS = positiveIntFromEnv("SYNC_TEKTORG_WINDOW_DAYS", 30);
/** Живой поиск ждёт человек: неделя — несколько секунд вместо минуты. */
const LIVE_TEK_TORG_WINDOW_DAYS = 7;
/** Сколько закупок ТЭК-Торга на профиль: отбор локальный, запросов не прибавляет. */
const TEK_TORG_MIN_LIMIT = 200;
/**
 * Сколько свежих закупок ТЭК-Торга за прогон получают документацию заранее.
 * Байты площадка отдаёт бесплатно и без ключа, поэтому глубокий разбор и смета
 * по коммерческой закупке стартуют сразу, без ожидания скачивания. AI-разбор при
 * этом не запускается: он платный и начинается только по решению человека.
 */
const TEK_TORG_DOC_PREFETCH = positiveIntFromEnv("SYNC_TEKTORG_DOC_PREFETCH", 30, true);

/** Целое из переменной окружения; не число или меньше нуля — значение по умолчанию. */
function positiveIntFromEnv(name: string, fallback: number, allowZero = false): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  if (value < 0 || (!allowZero && value === 0)) return fallback;
  return value;
}
import {
  parseServerProfiles,
  pickSyncProfiles,
  type CollectorProfile,
  type ServerProfile,
} from "../src/domain/syncProfiles";
import { runDocumentFetch } from "./fetch-tender-documents";
// Расшифровка ошибок общая с воркером: те же коды и та же подпись «источник не
// пускает наш адрес» в обоих логах, иначе причину сбоя пришлось бы узнавать
// заново на каждом сервере.
import { describeError } from "../src/lib/errors";
// Общий затвор запросов к ЕИС: блокировка (HTTP 434/403/429) ставит карантин для
// всех процессов машины, и этот прогон перестаёт спрашивать ЕИС после первого отказа.
import {
  eisGate,
  isEisBlockStatus,
  isEisBlockedError,
  type EisBlockedError,
} from "../src/lib/eisGate";
import { formatMoscowTime } from "../src/lib/moscowTime";
import { buildSyncRunNote } from "../src/domain/syncRunNote";
import {
  TENDER_SOURCE_PRIORITY,
  tenderRepository,
} from "../src/repositories/tenderRepository";
import {
  konturBlurredFieldLabels,
  konturExpectedSkipReasons,
  konturSkipReasonLabels,
} from "../src/lib/labels";
import type { TenderDataSource, TenderLaw } from "../src/types/database";
import type { Tender } from "../src/domain/entities";
import { formatTenderPrice } from "../src/utils/format";

config({ path: resolve(__dirname, "../.env.local") });

/**
 * Источники, из которых скрипт умеет собирать закупки.
 *
 * Список не записан здесь: он выводится из каталога `src/domain/sources.ts`,
 * где про каждый источник известны стоимость, приоритет и умение отдавать
 * документацию. Новая площадка добавляется записью в каталог и привязкой в
 * `src/services/tenderSourceRegistry.ts` — правка этого скрипта не нужна.
 */
const SYNC_SOURCES: TenderDataSource[] = syncableSources();

/**
 * Что опрашивается, если профиль не указал sources. Набор собирает каталог
 * (`defaultSources()` — записи с `byDefault: true`), и он заведомо уже списка
 * подключённых площадок. Платных источников в нём нет намеренно: включать их
 * нужно осознанно, профиль за профилем. Новая бесплатная площадка тоже
 * попадает туда только решением владельца — «опрашивать везде» означало бы
 * молча добавить каждому профилю загрузку её суточного окна выдачи.
 */
const DEFAULT_SOURCES: TenderDataSource[] = defaultSources();

/**
 * Законы, которые отдаёт секция `zakupki` экспорта ТЭК-Торга.
 *
 * 44-ФЗ здесь нет намеренно: площадка держит его отдельной секцией `44fz`, а те же
 * извещения 44-ФЗ публикуются в ЕИС и приходят оттуда полнее — с требованиями,
 * национальным режимом и ссылкой на карточку. Прирост ТЭК-Торга ровно в том, чего в
 * ЕИС нет: 26 коммерческих процедур в сутки из 75 опубликованных 01.10.2026.
 */
const TEK_TORG_LAWS: TenderLaw[] = ["FZ_223", "COMMERCIAL"];

/**
 * Законы, которые отдаёт набор секций Росэлторга по умолчанию.
 *
 * Совпадает с ТЭК-Торгом по той же причине: секции 44-ФЗ и ППРФ №615 из набора
 * исключены — это зеркало ЕИС, откуда извещение приходит полнее. Прирост
 * Росэлторга ровно в том, чего в реестре нет: корпоративные и коммерческие
 * процедуры секций «Росэлторг.Бизнес», ГК «Росатом», «Россети», «РусГидро» и других.
 */
const ROSELTORG_LAWS: TenderLaw[] = ["FZ_223", "COMMERCIAL"];

/**
 * Законы, которые отдаёт набор секций Фабриканта по умолчанию.
 *
 * Тот же набор и по той же причине: секция 12 (44-ФЗ) исключена как зеркало ЕИС —
 * замер 02.10.2026 дал 40 из 40 открытых закупок с номером извещения, и наш
 * адаптер реестра их уже видит полнее. Исключены и секция 14 («Капитальный
 * ремонт», ПП РФ №615) — её идентификатор на `/purchases` площадка молча
 * игнорирует и отдаёт выдачу всего сайта, — и «Маркет» (16), чьи карточки живут
 * на `market.fabrikant.ru` и страницы `/v2` не имеют вовсе. Прирост Фабриканта —
 * коммерческие и корпоративные процедуры, которых в реестре нет.
 */
const FABRIKANT_LAWS: TenderLaw[] = ["FZ_223", "COMMERCIAL"];

interface SyncProfile {
  name: string;
  enabled: boolean;
  laws: TenderLaw[];
  keywords: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
  okpd2Codes?: string[];
  limitPerKeyword?: number;
  /**
   * Регионы, ограничивающие выдачу. Пусто или не задано — вся Россия.
   *
   * Источники понимают регионы по-разному: одни принимают фильтр в запросе,
   * другие отсеивают выдачу сами, третьи не умеют ни того ни другого. Кто есть
   * кто, записано один раз — в поле `honoursRegions` привязки источника
   * (`src/services/tenderSourceRegistry.ts`), и прогон печатает это в логе:
   * источник без регионального фильтра назван явно, чтобы выдача по всей России
   * не выглядела отобранной по региону профиля.
   */
  regions?: string[];
  /**
   * Какие источники опрашивать. По умолчанию — бесплатные из каталога
   * (`defaultSources()`), их перечень задаёт `src/domain/sources.ts`. Платный
   * источник включается только явным упоминанием здесь.
   */
  sources?: TenderDataSource[];
}

interface SyncConfig {
  profiles: SyncProfile[];
}

const PROBE_TIMEOUT_MS = 12_000;

/** Итог проверки связи: недоступные источники и ограничение ЕИС (оно считается отдельно). */
interface ProbeResult {
  unreachable: TenderDataSource[];
  /** ЕИС ограничила доступ: статус (null — из общего карантина без статуса) и момент новой попытки. */
  eisBlock: { retryAt: number; status: number | null; fromGate: boolean } | null;
}

/** Публичный IP машины — нужен, чтобы сразу увидеть выход через зарубежный VPN. */
async function currentPublicIp(): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { ip?: string };
    return body.ip ?? null;
  } catch {
    return null;
  }
}

/**
 * Проверяет, что источники в принципе отвечают. Все недоступны — выходить сразу,
 * иначе прогон пять минут перебирает ключевые слова и собирает нули.
 * Возвращает список недоступных источников.
 *
 * Адреса проверки связи здесь не записаны: они лежат в привязке источника
 * (`SOURCE_BINDINGS`) рядом с его конструктором. Новая площадка приносит свою
 * точку проверки вместе с собой, и этот скрипт про неё узнаёт без правки.
 */
async function probeSources(wanted: Set<TenderDataSource>): Promise<ProbeResult> {
  const probes = SOURCE_BINDINGS.filter((b) => wanted.has(b.source)).map((b) => ({
    source: b.source,
    label: b.label,
    url: b.probeUrl,
  }));
  if (probes.length === 0) return { unreachable: [], eisBlock: null };

  const results = await Promise.all(
    probes.map(async (probe) => {
      // ЕИС уже в карантине (прогон другого процесса получил блокировку): не
      // спрашиваем её даже проверкой связи — это лишний запрос к сайту, который
      // нас просил подождать.
      if (probe.source === "EIS") {
        const block = eisGate.blockedUntil();
        if (block !== null) {
          return {
            probe,
            ok: true,
            status: 0,
            block: { retryAt: block.retryAt, status: block.status, fromGate: true },
          };
        }
      }
      try {
        const res = await fetch(probe.url, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        await res.body?.cancel();
        if (probe.source === "EIS") {
          // Статус блокировки — не «доступен»: раньше HTTP 434 печатался как
          // «ЕИС: доступен (HTTP 434)», и прогон шёл долбить закрытый сайт.
          if (isEisBlockStatus(res.status)) {
            const error = eisGate.recordBlock(res.status);
            return {
              probe,
              ok: true,
              status: res.status,
              block: { retryAt: error.retryAt, status: res.status, fromGate: false },
            };
          }
          if (res.status < 500) eisGate.recordSuccess();
        }
        return { probe, ok: res.status < 500, status: res.status };
      } catch (err) {
        return { probe, ok: false, status: 0, error: describeError(err) };
      }
    }),
  );

  const unreachable: TenderDataSource[] = [];
  let eisBlock: ProbeResult["eisBlock"] = null;
  for (const r of results) {
    if ("block" in r && r.block !== undefined) {
      const { block } = r;
      eisBlock = block;
      const code = block.status === null ? "" : ` (HTTP ${String(block.status)})`;
      console.error(
        `Проверка связи · ${r.probe.label}: ОГРАНИЧИЛА ДОСТУП${code} — запросы к ЕИС в этом прогоне пропускаются` +
          (block.fromGate
            ? `; ранее зафиксированный карантин, повторим после ${formatMoscowTime(block.retryAt)} МСК`
            : `; повторим после ${formatMoscowTime(block.retryAt)} МСК`),
      );
      continue;
    }
    if (r.ok) {
      console.log(`Проверка связи · ${r.probe.label}: доступен (HTTP ${r.status})`);
      continue;
    }
    unreachable.push(r.probe.source);
    const reason = "status" in r && r.status >= 500 ? `HTTP ${r.status}` : r.error ?? "нет ответа";
    console.error(`Проверка связи · ${r.probe.label}: НЕДОСТУПЕН — ${reason}`);
  }

  if (unreachable.length === 0) return { unreachable, eisBlock };

  const ip = await currentPublicIp();
  console.error(
    `\nВыход в интернет с IP ${ip ?? "не определён"}. Часть площадок блокирует` +
      "\nзарубежные адреса: если IP не российский, отключите VPN или добавьте" +
      "\nв его split-tunnel исключения адреса площадок — они лежат в привязках" +
      "\nисточников (SOURCE_BINDINGS) рядом с конструкторами." +
      "\nНедоступность при российском IP обычно означает защиту самой площадки" +
      "\nили её регламентные работы, а не нашу настройку.\n",
  );

  // Ограничение ЕИС — не «источник не отвечает»: прогон продолжается остальными
  // площадками, а итоговая строка скажет, что ЕИС пропущена. Все ОСТАЛЬНЫЕ мертвы —
  // выходим, как и раньше (блокировка ЕИС здесь не засчитывается ни за живой, ни за мёртвый).
  const judged = probes.filter((p) => !(p.source === "EIS" && eisBlock !== null));
  if (unreachable.length === judged.length) {
    console.error("Ни один источник не отвечает — синхронизация прервана, данные в БД не тронуты.");
    process.exit(2);
  }
  console.error(
    `Продолжаем без ${unreachable.join(", ")}: его старые записи в ленте останутся нетронутыми.`,
  );
  return { unreachable, eisBlock };
}

/**
 * Какие источники нужны профилю.
 *
 * Набор по умолчанию даёт каталог источников (`defaultSources`), и платных в нём
 * нет намеренно: профиль перечисляет их в `sources` явно, иначе каждое ключевое
 * слово каждого профиля молча тратило бы суточный тариф платного источника.
 *
 * `only` сужает набор до источников из флага --sources: так платный прогон можно
 * выполнить отдельно, не опрашивая бесплатные площадки.
 *
 * Законы профиля идут всем источникам, кроме ЕИС: коммерческих торгов в ней нет,
 * поэтому COMMERCIAL из её запроса исключается, а коммерческие процедуры
 * приносят площадки — каждая своей веткой прогона ниже.
 */
function profileSources(
  profile: SyncProfile,
  only?: TenderDataSource[] | null,
): { eisLaws: TenderLaw[]; sources: TenderDataSource[] } {
  const requested = (profile.sources ?? DEFAULT_SOURCES).filter((s) =>
    SYNC_SOURCES.includes(s),
  );
  const allowed = requested.filter((s) => platformServesLaws(s, profile.laws));
  const sources = only ? allowed.filter((s) => only.includes(s)) : allowed;
  const eisLaws = profile.laws.filter((l) => l !== "COMMERCIAL");
  return { eisLaws, sources };
}

/**
 * Какие законы отдаёт площадка. Профиль, которому они не нужны, площадку не
 * опрашивает: коммерческие площадки теперь в наборе по умолчанию, и профиль про
 * одни 44-ФЗ иначе тратил бы на них минуты прогона и приносил чужие закупки.
 */
const PLATFORM_LAWS: Partial<Record<TenderDataSource, readonly TenderLaw[]>> = {
  SBER_AST: ["COMMERCIAL"],
  TEK_TORG: TEK_TORG_LAWS,
  ROSELTORG: ROSELTORG_LAWS,
  FABRIKANT: ["FZ_223", "COMMERCIAL"],
};

function platformServesLaws(source: TenderDataSource, laws: readonly TenderLaw[]): boolean {
  const served = PLATFORM_LAWS[source];
  // Законы не заданы — профиль их не ограничивает; ЕИС и агрегаторы решают сами.
  if (served === undefined || laws.length === 0) return true;
  return served.some((law) => laws.includes(law));
}

/**
 * Опросит ли профиль ЕИС. Источник перечислен в наборе — половина правила;
 * вторая половина: у профиля должны быть законы кроме COMMERCIAL, либо законы
 * не заданы вовсе. Профиль про одни коммерческие торги ЕИС не трогает: там их
 * нет, и запрос вернул бы чужую выдачу.
 *
 * Правило вынесено в функцию, потому что оно нужно дважды — при сборе списка
 * источников для проверки связи и в цикле по профилям. Две копии условия
 * разошлись бы молча: прогон начал бы печатать «ЕИС: доступен» и не опрашивать её.
 */
function eisApplies(profile: SyncProfile, eisLaws: TenderLaw[]): boolean {
  return eisLaws.length > 0 || profile.laws.length === 0;
}


/**
 * Когда источник в последний раз записывали в таблицу закупок; null — неизвестно.
 *
 * Очистка в конце прогона удаляет все строки источника и пишет заново, поэтому
 * самая свежая `created_at` — это момент последнего опроса, который что-то
 * вернул. Ошибка чтения и пустая таблица дают null: решение «неизвестно —
 * опрашивать» безопаснее остановленного источника.
 */
async function lastStoredAt(
  client: SupabaseClient,
  source: TenderDataSource,
): Promise<string | null> {
  const { data, error } = await client
    .from("tenders")
    .select("created_at")
    .eq("data_source", source)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const row = data[0] as { created_at?: string | null } | undefined;
  return typeof row?.created_at === "string" ? row.created_at : null;
}

/**
 * Флаг `--sources=EIS,KONTUR`: опрашивать только перечисленные источники.
 *
 * Нужен для платного источника: прогон только по Контур.Закупкам тратит
 * считаные запросы тарифа и не ждёт ответа ЕИС, которая доступна не из каждой
 * сети. Без флага возвращаем null — работают источники профилей.
 */
function parseSourcesArg(): TenderDataSource[] | null {
  const prefix = "--sources=";
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return null;
  const requested = arg
    .slice(prefix.length)
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const known = requested.filter((value): value is TenderDataSource =>
    SYNC_SOURCES.includes(value as TenderDataSource),
  );
  const unknown = requested.filter((value) => !known.includes(value as TenderDataSource));
  if (unknown.length > 0) {
    console.error(
      `Неизвестный источник в --sources: ${unknown.join(", ")}. ` +
        `Доступны: ${SYNC_SOURCES.join(", ")}.`,
    );
  }
  if (known.length === 0) {
    console.error("В --sources не осталось ни одного доступного источника — прогон отменён.");
    process.exit(1);
  }
  return known;
}

/** Регионы профиля, очищенные от пустых значений. Пустой массив — вся Россия. */
function profileRegions(profile: SyncProfile): string[] {
  return (profile.regions ?? []).map((r) => r.trim()).filter(Boolean);
}

/**
 * Итог одного запроса источника.
 *
 * `ok` отделяет «источник ответил, закупки учтены» от «запрос не прошёл». Без
 * этого вызывающий код не может решить, печатать ли статистику адаптера: она
 * живёт в адаптере, а одним адаптером прогон обходит несколько профилей, и после
 * сбоя числа в ней принадлежат предыдущему профилю.
 */
/**
 * Сколько запросов к источнику удалось и сколько упало, по названию в журнале.
 * Нужен итоговой строке: источник, не ответивший ни на один запрос, называется
 * в ней явно, а не прячется за «0 ошибок».
 */
const sourceTally = new Map<string, { ok: number; failed: number }>();

interface CollectOutcome {
  /** Сколько закупок вернул источник. При сбое — 0. */
  found: number;
  /** Состоялся ли запрос: `false` значит, что источник ответил ошибкой. */
  ok: boolean;
}

/**
 * Запрашивает один источник по одному ключевому слову и складывает в общий набор.
 *
 * Одна закупка — одна запись в наборе. Если её уже принёс более авторитетный
 * источник (см. TENDER_SOURCE_PRIORITY), запись не заменяется: Контур.Закупки
 * отдают те же извещения, что публикует ЕИС, и часть их полей закрашена.
 */
async function collectFrom(
  sourceLabel: string,
  keyword: string,
  fetcher: () => Promise<Tender[]>,
  unique: Map<string, Tender>,
): Promise<CollectOutcome> {
  const tally = sourceTally.get(sourceLabel) ?? { ok: 0, failed: 0 };
  sourceTally.set(sourceLabel, tally);
  try {
    const tenders = await fetcher();
    tally.ok += 1;
    let newCount = 0;
    for (const t of tenders) {
      const known = unique.get(t.regNumber);
      if (known && TENDER_SOURCE_PRIORITY[known.dataSource] >= TENDER_SOURCE_PRIORITY[t.dataSource]) {
        continue;
      }
      unique.set(t.regNumber, t);
      if (!known) newCount++;
    }
    console.log(
      `  ${sourceLabel} «${keyword}»: найдено ${tenders.length}, новых ${newCount}`,
    );
    return { found: tenders.length, ok: true };
  } catch (err) {
    // Исчерпанный суточный бюджет и отклонённый ключ — не сбой одного
    // ключевого слова, а предел или конец всего источника. Пробрасываем
    // наверх: вызывающий код обязан прекратить опрос платного источника,
    // а не повторять обречённый запрос слово за словом.
    if (konturSourceStop(err) !== null) throw err;
    // Блокировка ЕИС — тоже не сбой слова: вызывающий код прекращает опрос ЕИС
    // до конца прогона. В счётчик «источник не ответил» она не идёт — про неё
    // итоговая строка говорит отдельно.
    if (isEisBlockedError(err)) throw err;
    tally.failed += 1;
    console.error(
      `  ${sourceLabel} «${keyword}»: ОШИБКА — ${describeError(err)}`,
    );
    return { found: 0, ok: false };
  }
}

/**
 * Счётчики причин одной строкой: «срок приёма заявок истёк (2), цена не
 * опубликована (1)». Пустой набор даёт пустую строку — разделитель перед ней
 * вызывающий код не печатает.
 *
 * Нулевые счётчики отсеиваются намеренно: «причина (0)» выглядела бы в журнале
 * как состоявшийся отсев, которого не было.
 */
function describeCountedReasons(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(", ");
}

/** Причины отброшенных записей со счётчиками: «отменена (3), несостоявшаяся (1)». */
function describeSkipReasons(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => `${konturSkipReasonLabels[reason] ?? reason} (${count})`)
    .join(", ");
}

/**
 * Итог работы платного источника: сколько запросов оплачено, что отброшено,
 * что источник скрыл и что мы отсекли сами.
 *
 * Отброшенные записи делятся на штатные (отменена, несостоявшаяся) и ошибочные:
 * только вторые значат, что реальная схема ответа не совпала с ожидаемой.
 * Молчать ни о том ни о другом нельзя — прогон с нулём закупок иначе
 * неотличим от прогона, где всё отфильтровалось.
 */
function logKonturUsage(adapter: {
  counters: {
    apiCalls: number;
    cacheHits: number;
    requestsToday: number;
    requestsTodayByMethod: { search: number; card: number };
  };
  lastSkipped: string[];
  lastBlurred: { fields: string[]; documents: number };
  lastFilteredOut: number;
}): void {
  const counters = adapter.counters;
  const byMethod = counters.requestsTodayByMethod;
  console.log(
    `Контур.Закупки: платных запросов ${counters.apiCalls}, из кэша ${counters.cacheHits}, ` +
      `за сегодня по методам — поиск ${byMethod.search}, карточки ${byMethod.card} ` +
      `(всего ${counters.requestsToday})`,
  );

  const expected = adapter.lastSkipped.filter((reason) => konturExpectedSkipReasons.has(reason));
  const unexpected = adapter.lastSkipped.filter(
    (reason) => !konturExpectedSkipReasons.has(reason),
  );
  if (expected.length > 0) {
    console.log(
      `  Отброшено штатно: ${expected.length} (${describeSkipReasons(expected)}) ` +
        "— участвовать в таких закупках нельзя",
    );
  }
  if (unexpected.length > 0) {
    console.warn(
      `  Ответ не прочитан: ${unexpected.length} (${describeSkipReasons(unexpected)}) ` +
        "— схема ответа отличается от ожидаемой, см. docs/REFERENCE_KONTUR_API.md. " +
        "Сырые ответы лежат в kontur_raw_responses, их можно разобрать повторно.",
    );
  }

  if (adapter.lastFilteredOut > 0) {
    console.log(
      `  Отсеяно фильтром региона или ОКПД2: ${adapter.lastFilteredOut} ` +
        "(API эти параметры не принимает, отбор идёт по готовой выдаче)",
    );
  }

  const blurred = adapter.lastBlurred;
  const hidden: string[] = blurred.fields.map(
    (field) => konturBlurredFieldLabels[field] ?? field,
  );
  if (blurred.documents > 0) hidden.push(`ссылки в документах (${blurred.documents} шт.)`);
  if (hidden.length > 0) {
    console.warn(
      `  Ключ тестовый: источник скрыл ${hidden.join(", ")}. В сохранённых закупках ` +
        "эти поля пусты — отсутствие данных, а не ошибка разбора.",
    );
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  // Проверочный прогон не должен тратить платные запросы: Контур.Закупки
  // в --dry-run опрашивается только с этим явным флагом.
  const allowPaidApi = process.argv.includes("--paid-api");
  // Кнопка «Запустить прогон» и ручной запуск опрашивают оба трека: человек
  // просит свежее, и ждать окна медленного трека ему незачем. Плановый запуск
  // этот флаг не получает. Воркер передаёт его переменной окружения, а не
  // аргументом, потому что запускает скрипт без аргументов.
  const allTracks = process.argv.includes("--all-tracks") || process.env["SYNC_TRACKS"] === "all";
  // --sources=EIS,KONTUR сужает прогон до перечисленных источников (null — все).
  const onlySources = parseSourcesArg();

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("Ошибка: установите SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env.local");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const configPath = resolve(__dirname, "sync-profiles.json");
  let syncConfig: SyncConfig;
  try {
    syncConfig = JSON.parse(readFileSync(configPath, "utf-8")) as SyncConfig;
  } catch {
    console.error(`Ошибка: не удалось прочитать ${configPath}`);
    process.exit(1);
  }

  /*
    Живой поиск: запрос человека с открытой страницы вместо профилей сервера.

    Режим включает воркер, когда берёт задание с `payload.liveQuery`. Запрос
    чистится ещё раз и здесь: переменная окружения — граница доверия, и
    скрипт не должен полагаться на то, что вызывающий уже всё проверил.
    Непригодный запрос — выход с кодом 2, а не тихий откат к плановым профилям:
    иначе задание «найти юристов» молча превратилось бы в полный плановый
    прогон со всеми его побочными эффектами.
  */
  const rawLiveQuery = (process.env["SYNC_LIVE_QUERY"] ?? "").trim();
  const liveQuery = rawLiveQuery === "" ? null : normalizeLiveQuery(rawLiveQuery);
  if (rawLiveQuery !== "" && liveQuery === null) {
    console.error("SYNC_LIVE_QUERY задан, но запрос непригоден: прогон отменён.");
    process.exit(2);
  }
  const liveMode = liveQuery !== null;
  // Регионы живого поиска: переменная окружения — граница доверия, чистим заново.
  let liveSynonyms: string[] = [];
  try {
    liveSynonyms = normalizeLiveSynonyms(liveQuery ?? "", JSON.parse(process.env["SYNC_LIVE_KEYWORDS"] ?? "[]"));
  } catch {
    liveSynonyms = [];
  }
  let liveRegions: string[] = [];
  try {
    liveRegions = normalizeLiveRegions(JSON.parse(process.env["SYNC_LIVE_REGIONS"] ?? "[]"));
  } catch {
    liveRegions = [];
  }

  /*
    Профили сервера: владелец отправляет свои из настроек, и они заменяют
    зашитые в файле. Таблицы нет или она пуста — работает файл. Чтение не
    должно ронять прогон: сбой базы здесь — повод назвать причину и взять файл.
  */
  let serverProfiles: ServerProfile[] = [];
  if (!liveMode) {
    const { data, error } = await supabase.from("sync_profiles").select("*");
    if (error) {
      const missing = error.code === "42P01" || error.code === "PGRST205";
      console.log(
        missing
          ? "Профилей сервера нет (таблица sync_profiles не создана): беру профили из файла."
          : `Профили сервера прочитать не удалось (${error.message}): беру профили из файла.`,
      );
    } else {
      const parsed = parseServerProfiles(
        (data ?? []).map((row: Record<string, unknown>) => ({
          name: row["name"],
          laws: row["laws"],
          keywords: row["keywords"],
          okpd2Codes: row["okpd2_codes"] ?? [],
          minPrice: row["min_price"] === null ? null : Number(row["min_price"]),
          maxPrice: row["max_price"] === null ? null : Number(row["max_price"]),
          regions: row["regions"] ?? [],
          enabled: row["enabled"],
        })),
      );
      if (parsed.ok) serverProfiles = parsed.profiles;
      else console.log(`Профили сервера некорректны (${parsed.error}): беру профили из файла.`);
    }
  }

  /*
    Спрос посетителей: темы, которые ждут пользователи сервиса. Сбор идёт по
    их объединению (одна тема — один запрос к площадкам), а тема, которую
    никто не открывал дольше срока, вычищается. Таблицы нет — спроса нет, это
    не ошибка прогона.
  */
  let demandProfiles: CollectorProfile[] = [];
  if (!liveMode) {
    const { data, error } = await supabase.from("search_demand").select("*").limit(20_000);
    if (error) {
      const missing = error.code === "42P01" || error.code === "PGRST205";
      if (!missing) console.log(`Спрос посетителей прочитать не удалось (${error.message}): пропускаю.`);
    } else {
      const maxKeywords = Number(process.env["SYNC_DEMAND_MAX_KEYWORDS"] ?? "30");
      // Слово → регионы, в которых его уже собирают профили владельца ([] — вся Россия).
      const owned = new Map<string, string[]>();
      for (const p of serverProfiles.filter((x) => x.enabled)) {
        for (const k of p.keywords.map((w) => w.toLowerCase())) {
          const prev = owned.get(k);
          if (prev !== undefined && prev.length === 0) continue;
          owned.set(k, p.regions.length === 0 ? [] : [...(prev ?? []), ...p.regions]);
        }
      }
      demandProfiles = buildDemandProfiles((data ?? []) as DemandRow[], {
        nowMs: Date.now(),
        maxKeywords: Number.isFinite(maxKeywords) && maxKeywords > 0 ? maxKeywords : 30,
        exclude: owned,
      });
      const staleBefore = new Date(Date.now() - DEMAND_TTL_DAYS * 86_400_000).toISOString();
      if (!dryRun) await supabase.from("search_demand").delete().lt("last_seen_at", staleBefore);
      const topics = demandProfiles.reduce((n, p) => n + p.keywords.length, 0);
      console.log(`Спрос посетителей: тем к сбору ${topics} (строк в таблице ${(data ?? []).length}).`);
    }
  }

  const profiles: SyncProfile[] = liveMode
    ? [buildLiveProfile(liveQuery, liveRegions, liveSynonyms) as SyncProfile]
    : (pickSyncProfiles(syncConfig.profiles, serverProfiles, demandProfiles) as SyncProfile[]);
  if (profiles.length === 0) {
    console.log("Нет включённых профилей — нечего синхронизировать.");
    return;
  }
  if (serverProfiles.length > 0 || demandProfiles.length > 0) {
    console.log("Профили из файла не используются: сбор идёт по профилям владельца и спросу посетителей.");
  }

  console.log("Синхронизация закупок → Supabase по профилям поиска");
  console.log(`Профилей: ${profiles.length} | ${profiles.map((p) => p.name).join(", ")}`);
  if (dryRun) console.log("РЕЖИМ --dry-run: данные в Supabase не записываются");
  if (liveMode) {
    console.log(
      `РЕЖИМ живого поиска: «${liveQuery}»${liveRegions.length > 0 ? ` (регионы: ${liveRegions.join(", ")})` : ""}${liveSynonyms.length > 0 ? ` (близкие слова: ${liveSynonyms.join(", ")})` : ""}. Строки ничего не удаляют, найденное помечается и ` +
        "переживает плановую очистку; платные источники и очередь документов не затрагиваются.",
    );
  }
  if (onlySources) console.log(`РЕЖИМ --sources: опрашиваем только ${onlySources.join(", ")}`);
  console.log();

  // Сначала убеждаемся, что источники вообще отвечают: при включённом VPN
  // с зарубежным выходом прогон молча соберёт нули за несколько минут.
  // Набор собирается перебором источников профиля, а не перечислением «ЕИС,
  // Сбербанк-АСТ, Контур»: новая площадка из каталога попадает сюда сама.
  const wanted = new Set<TenderDataSource>();
  for (const profile of profiles) {
    const { eisLaws, sources } = profileSources(profile, onlySources);
    for (const source of sources) {
      if (source === "EIS" && !eisApplies(profile, eisLaws)) continue;
      wanted.add(source);
    }
  }

  /**
   * Почему источник исключён из прогона. Причина записывается там же, где
   * принимается решение, и всплывает в итоговой строке: иначе в конце остаётся
   * «0 новых закупок», а объяснение — в начале лога, который к тому времени
   * прокручен.
   */
  const droppedSources = new Map<TenderDataSource, string>();

  if (onlySources && wanted.size === 0) {
    console.log(
      `Ни один включённый профиль не перечисляет ${onlySources.join(", ")} в sources — ` +
        "нечего синхронизировать. Добавьте источник в scripts/sync-profiles.json.",
    );
    return;
  }

  // Платный источник без ключа не опрашиваем: иначе каждый запрос профиля
  // падал бы с 503, а бесплатные источники при этом отработали бы нормально.
  const konturKey = process.env.KONTUR_API_KEY?.trim() ?? "";
  if (wanted.has("KONTUR") && !konturKey) {
    console.log("Контур.Закупки: KONTUR_API_KEY не задан — платный источник пропущен.");
    wanted.delete("KONTUR");
    droppedSources.set("KONTUR", "KONTUR_API_KEY не задан");
  }
  // --dry-run означает «не писать в базу», но запросы к Контур.Закупкам всё равно
  // платные, поэтому по умолчанию в проверочном прогоне источник отключён.
  if (wanted.has("KONTUR") && dryRun && !allowPaidApi) {
    console.log(
      "Контур.Закупки: в режиме --dry-run платный API не опрашивается. Флаг --paid-api включает.",
    );
    wanted.delete("KONTUR");
    droppedSources.set("KONTUR", "в режиме --dry-run платный API не опрашивается");
  }

  // Платный источник опрашивается не каждый прогон, а раз в
  // KONTUR_MIN_INTERVAL_HOURS (по умолчанию 6): плановое задание работает
  // каждые два часа, три ключевых слова профиля стоят три поиска, а боевой
  // тариф даёт 30 поисков в сутки — без интервала расход составил бы 36.
  // Отсчёт от последнего платного поиска в журнале api_usage_log, а не от часа
  // суток: задание может стоять на нечётных часах, и привязка к «hour % 6» не
  // сработала бы ни разу. Явный --sources=KONTUR интервал игнорирует.
  if (wanted.has("KONTUR") && !onlySources) {
    const intervalHours = konturSyncIntervalHours();
    if (intervalHours > 0) {
      const cadence = decideKonturSync({
        lastPaidSearchAt: await konturLastPaidSearchAt(),
        now: new Date().toISOString(),
        minIntervalHours: intervalHours,
      });
      if (!cadence.query) {
        // По договору `reason` заполнен всегда, когда `query === false`, но тип
        // допускает null. Подстановка нужна не для компилятора: без неё в логе
        // появилось бы слово «null» вместо объяснения.
        const reason = cadence.reason ?? "соблюдается интервал между платными запросами";
        console.log(`Контур.Закупки: ${reason} — источник пропущен.`);
        wanted.delete("KONTUR");
        droppedSources.set("KONTUR", reason);
      }
    }
  }

  // Медленный трек: Росэлторг и Фабрикант тратят отдельный запрос карточки на
  // каждую процедуру (86 секунд из 280 в прогоне 03.10.2026), поэтому плановый
  // запуск опрашивает их не чаще раза в SYNC_SLOW_INTERVAL_HOURS (по умолчанию
  // 6), а остальные источники — каждый раз. Отсчёт от времени последней записи
  // источника: очистка ниже удаляет ВСЕ строки опрошенного источника и пишет
  // заново, поэтому `max(created_at)` и есть момент прошлого опроса. Колонка
  // synced_at для этого не годится: её пишет только Контур, и на ней держится
  // метка «последний поиск» в ленте.
  //
  // Пропущенный источник не затирается: очистка идёт только для тех, кто в этот
  // раз вернул закупки. Явный --sources и ручной запуск трек не проверяют.
  if (!onlySources && !allTracks && !liveMode) {
    const intervalHours = slowTrackIntervalHours(process.env["SYNC_SLOW_INTERVAL_HOURS"]);
    if (intervalHours > 0) {
      for (const source of slowTrackSources()) {
        if (!wanted.has(source)) continue;
        const decision = decideTrack({
          lastStoredAt: await lastStoredAt(supabase, source),
          now: new Date().toISOString(),
          minIntervalHours: intervalHours,
        });
        if (decision.poll) continue;
        // По договору `reason` заполнен, когда `poll === false`, но тип допускает
        // null: без подстановки в лог попало бы слово «null» вместо объяснения.
        const reason = decision.reason ?? "соблюдается интервал медленного трека";
        console.log(`${source}: ${reason} — источник пропущен.`);
        wanted.delete(source);
        droppedSources.set(source, reason);
      }
    }
  }

  const probe = await probeSources(wanted);
  console.log();
  /** Источники, не прошедшие проверку связи; ЕИС в карантине считается здесь же — её не опрашиваем. */
  const unreachable: TenderDataSource[] = [...probe.unreachable];
  if (probe.eisBlock !== null) unreachable.push("EIS");
  /**
   * ЕИС ограничила доступ (HTTP 434/403/429) в проверке связи или посреди
   * прогона: момент, после которого затвор разрешит новую попытку. Пока не
   * null, ЕИС в этом прогоне не опрашивается вовсе (ни слова, ни обход региона,
   * ни карточки ОКПД2, ни документы), остальные площадки работают как обычно.
   * Итоговая строка называет блокировку, а очистка снимка ЕИС пропускается:
   * снимок неполный, и удаление старых строк стёрло бы то, чего мы не увидели.
   */
  let eisBlockedRetryAt: number | null = probe.eisBlock?.retryAt ?? null;
  const markEisBlocked = (err: EisBlockedError, where: string): void => {
    eisBlockedRetryAt = Math.max(eisBlockedRetryAt ?? 0, err.retryAt);
    console.error(
      `  ЕИС ${where}: ${err.message} — остальные запросы к ЕИС в этом прогоне пропускаются`,
    );
  };
  sourceTally.clear();

  // Адаптеры создаются циклом по реестру привязок: конструкторы, ключи и лимиты
  // живут в src/services/tenderSourceRegistry.ts, а не в этом скрипте. По одному
  // адаптеру на весь прогон — счётчики Контур.Закупок общие, иначе дневной бюджет
  // считался бы заново для каждого профиля и ключевое слова.
  // Привязка, вернувшая null, означает «источник не подключён»: прогон говорит об
  // этом один раз и продолжает работу остальными. Так новая площадка появляется в
  // логе раньше, чем у неё будет адаптер, и её отсутствие видно сразу.
  const adapters = new Map<TenderDataSource, TenderSourceAdapter>();
  /** Привязки, вернувшие null: источник описан, но адаптера у него пока нет. */
  const unconfigured = new Set<TenderDataSource>();
  for (const binding of SOURCE_BINDINGS) {
    if (!wanted.has(binding.source)) continue;
    const adapter = await binding.create();
    if (adapter === null) {
      console.log(`${binding.label}: источник не настроен, пропускаем`);
      unconfigured.add(binding.source);
      continue;
    }
    adapters.set(binding.source, adapter);
  }

  const eisAdapter = adapters.get("EIS") ?? null;
  const sberAdapter = adapters.get("SBER_AST") ?? null;
  // ТЭК-Торг: ключа не требует, поэтому адаптер есть всегда, когда источник
  // прошёл проверку связи. Тип нужен ради `filterStats` — счётчика отсевов,
  // которым прогон объясняет, куда делись процедуры из выдачи площадки.
  const tektorgAdapter =
    (adapters.get("TEK_TORG") as TektorgTenderSourceAdapter | undefined) ?? null;
  // Росэлторг: публичный серверный поиск без ключа, поэтому адаптер есть всегда,
  // когда источник прошёл проверку связи. Тип нужен ради `filterStats` — прогон
  // обязан отличать «площадка ничего не нашла» от «мы отбросили» и сказать, если
  // часть процедур осталась неосмотренной из-за предела запросов по номерам.
  const roseltorgAdapter =
    (adapters.get("ROSELTORG") as RoseltorgTenderSourceAdapter | undefined) ?? null;
  // Фабрикант: публичные поиск и карточки без ключа, поэтому адаптер есть всегда,
  // когда источник прошёл проверку связи. Тип нужен ради `filterStats` — прогон
  // обязан отличать «площадка ничего не нашла» от «мы отбросили», сказать, у
  // скольких процедур набор лотов остался неполным, и предупредить, если часть
  // процедур осталась неосмотренной из-за предела запросов карточек.
  const fabrikantAdapter =
    (adapters.get("FABRIKANT") as FabrikantTenderSourceAdapter | undefined) ?? null;
  // Контур.Закупки: кэш сырых ответов в БД и дневной бюджет читаются из env
  // (см. createKonturAdapter). Стартовые значения по методам берутся из журнала
  // api_usage_log, поэтому прогон сразу видит, сколько бюджета уже потратили
  // предыдущие запуски.
  const konturAdapter =
    (adapters.get("KONTUR") as KonturTenderSourceAdapter | undefined) ?? null;

  /*
    Карточки процедур Росэлторга и Фабриканта между прогонами (12.10.2026). Обе
    площадки тратят отдельный запрос на каждую процедуру, и это была большая
    часть пятиминутного «Найти новые закупки»: одни и те же процедуры повторяются
    в каждом профиле и в каждом прогоне. Карточка берётся из кэша, только если ей
    меньше суток и строка выдачи не показала перемен (срок, регион, предмет и
    цена лотов — `reusableCard`); иначе читается заново. Кэш — файл в data/,
    записывается после прогона; сбой записи на результат не влияет.
  */
  const cardCaches: DiskCardCache[] = [];
  const reuseHours = cardReuseMaxAgeMs(process.env["SYNC_CARD_REUSE_HOURS"]);
  for (const [source, adapter] of [
    ["ROSELTORG", roseltorgAdapter],
    ["FABRIKANT", fabrikantAdapter],
  ] as const) {
    if (adapter === null) continue;
    const cache = createDiskCardCache({ file: cardCacheFile(source) });
    adapter.useCardCache(cache, reuseHours);
    cardCaches.push(cache);
  }
  if (konturAdapter) {
    const spent = konturAdapter.counters.requestsTodayByMethod;
    console.log(
      `Контур.Закупки: ${konturAdapter.contractSummary.baseUrl}, ` +
        `израсходовано сегодня — поиск ${spent.search}, карточки ${spent.card}`,
    );
  }

  const started = Date.now();
  /** Отметка времени прогона — пишется в tenders.synced_at для платных источников. */
  const syncStartedAt = new Date(started).toISOString();
  const unique = new Map<string, Tender>();
  /** Сколько закупок вернул каждый источник — нужно для безопасной очистки. */
  const perSource = new Map<TenderDataSource, number>(
    SYNC_SOURCES.map((s) => [s, 0]),
  );
  /**
   * Какие источники прогон действительно опрашивал.
   *
   * Без этого множества итог печатал бы «новых закупок: 0» и про тот источник,
   * которого не спрашивали вовсе. Ноль после запроса и ноль без запроса выглядят
   * одинаково, а означают разное: первый — пустую выдачу, второй — выключенный
   * источник. Подменять одно другим значит прятать от владельца причину.
   */
  const queriedSources = new Set<TenderDataSource>();
  /**
   * Контур.Закупки остановлены до конца прогона: исчерпан суточный бюджет
   * группы `search` или ключ отклонён (кончилась подписка, ключ отозван, не
   * подключена группа методов). Остальные ключевые слова и профили источника
   * не опрашиваем; бесплатные площадки продолжают работать, а сообщение уходит
   * в лог один раз.
   *
   * При интервале KONTUR_MIN_INTERVAL_HOURS = 6 плановый прогон тратит 12
   * поисков в сутки из 30, поэтому в бюджет он попадает только если его
   * выбрали ручные запуски панели или карточки. Отклонённый ключ — тоже
   * штатный случай, а не авария: подписку продлевают короткими шагами, и она
   * кончается без предупреждения в логе.
   */
  let konturStopped: KonturSourceStop | null = null;

  /*
    Площадки опрашиваются одновременно (12.10.2026). Раньше профили шли друг за
    другом, а внутри профиля — площадка за площадкой: «Найти новые закупки»
    занимал пять минут, из них Росэлторг и Фабрикант — по 20–50 секунд на
    профиль, пока остальные площадки простаивали. Теперь у каждой площадки своя
    очередь шагов по профилям: внутри очереди всё по-прежнему по одному (темп и
    пределы запросов каждой площадки не меняются, а `filterStats` адаптера не
    смешивается между профилями), а очереди идут параллельно. Набор закупок
    сводится тем же правилом приоритета источников (`collectFrom`), и от порядка
    прихода ответов итог не зависит.
  */
  type Lane = "ЕИС, Сбербанк-АСТ" | "ТЭК-Торг" | "Росэлторг" | "Фабрикант";
  const lanes = new Map<Lane, Array<() => Promise<void>>>();
  const enqueue = (lane: Lane, step: () => Promise<void>): void => {
    const steps = lanes.get(lane) ?? [];
    steps.push(step);
    lanes.set(lane, steps);
  };

  // Собираем закупки по всем профилям, ключевым словам и источникам
  for (const profile of profiles) {
    const { eisLaws, sources } = profileSources(profile, onlySources);
    // Источники, которые профиль действительно опросит: перечислены им, прошли
    // проверку связи и имеют адаптер. Список собирается по реестру, поэтому
    // названия в строке профиля совпадают с названиями в проверке связи, а новая
    // площадка попадает в обе без правки этого места.
    //
    // Недоступный источник не опрашиваем: его старые записи останутся в ленте,
    // а очистка будет пропущена (perSource[source] === 0).
    const queried = SOURCE_BINDINGS.filter((b) => {
      if (!sources.includes(b.source)) return false;
      if (b.source === "EIS" && !eisApplies(profile, eisLaws)) return false;
      if (unreachable.includes(b.source)) return false;
      return adapters.has(b.source);
    });
    for (const b of queried) queriedSources.add(b.source);
    const wantEis = queried.some((b) => b.source === "EIS");
    const wantSber = queried.some((b) => b.source === "SBER_AST");
    const wantTektorg = queried.some((b) => b.source === "TEK_TORG");
    const wantRoseltorg = queried.some((b) => b.source === "ROSELTORG");
    const wantFabrikant = queried.some((b) => b.source === "FABRIKANT");
    // Контур.Закупки останавливаются до конца прогона по бюджету или по ключу,
    // и остановка может случиться на середине профиля: поэтому условие читается
    // и при печати заголовка, и перед каждым запросом источника.
    const wantKontur =
      queried.some((b) => b.source === "KONTUR") && konturStopped === null;

    const sourceNames = queried
      // Контур может остановиться позже заголовка: тогда перечислять его значит
      // обещать источник, которого прогон уже не опрашивает.
      .filter((b) => b.source !== "KONTUR" || konturStopped === null)
      .map((b) => b.label);
    console.log(
      `Профиль «${profile.name}» [${sourceNames.join(", ") || "источники отключены"}]:`,
    );
    const regionNames = profileRegions(profile);
    if (regionNames.length > 0) {
      const honoured = queried.filter((b) => b.honoursRegions).map((b) => b.label);
      const ignoring = queried.filter((b) => !b.honoursRegions).map((b) => b.label);
      console.log(`  Регионы: ${regionNames.join(", ")}`);
      if (ignoring.length > 0) {
        console.warn(
          `  Внимание: ${ignoring.join(", ")} не фильтрует выдачу по региону — ` +
            "по этому источнику закупки собираются по всей России" +
            (honoured.length > 0
              ? `, фильтр применят только ${honoured.join(", ")}.`
              : "."),
        );
      } else if (honoured.length > 0) {
        console.log(`  Фильтр по регионам применит: ${honoured.join(", ")}.`);
      }
    }

    /*
      Площадки с карточками (ТЭК-Торг, Росэлторг, Фабрикант) тратят запрос на
      каждую найденную процедуру, поэтому в живом поиске им уходит только сам
      запрос, а близкие слова от модели — дешёвым ЕИС и Сбербанк-АСТ.
    */
    const cardKeywords = liveMode ? profile.keywords.slice(0, 1) : profile.keywords;
    enqueue("ЕИС, Сбербанк-АСТ", async () => {
    for (const keyword of profile.keywords) {
      if (wantEis && eisAdapter && eisBlockedRetryAt === null) {
        try {
          const { found } = await collectFrom(
            "ЕИС",
            keyword,
            () =>
              eisAdapter.fetchTenders({
                laws: eisLaws.length > 0 ? eisLaws : ["FZ_44", "FZ_223"],
                keywords: [keyword],
                minPrice: profile.minPrice ?? null,
                maxPrice: profile.maxPrice ?? null,
                okpd2Codes: profile.okpd2Codes,
                // Регион уходит кодом: ЕИС фильтрует по региону заказчика
                // (customerPlace), и найденному проставляется этот регион.
                regions: profileRegions(profile),
                // Живой поиск: только открытые закупки и целая страница ЕИС. Из сотни
                // новейших открытых проверка по смыслу оставляет настоящие, а на
                // 25 строк уходило слишком много мусора.
                // Плановый сбор тоже берёт открытые закупки, новейшие вперёд, и не
                // меньше пятидесяти на слово: десять самых свежо обновлённых
                // (закрытых и случайных) не были выдачей по теме.
                limit: liveMode ? LIVE_EIS_LIMIT : Math.max(profile.limitPerKeyword ?? 10, PLANNED_EIS_MIN_LIMIT),
                onlyOpen: true,
                publishedWithinDays: EIS_PUBLISHED_WITHIN_DAYS,
                maxPages: liveMode ? LIVE_EIS_PAGES : undefined,
              }),
            unique,
          );
          perSource.set("EIS", (perSource.get("EIS") ?? 0) + found);
      
        } catch (err) {
          // Блокировка ЕИС: остальные слова и страницы ЕИС в этом прогоне не
          // спрашиваем, другие площадки идут дальше.
          if (!isEisBlockedError(err)) throw err;
          markEisBlocked(err, `«${keyword}»`);
        }
      }

      if (wantSber && sberAdapter) {
        const { found } = await collectFrom(
          "Сбербанк-АСТ",
          keyword,
          () =>
            sberAdapter.fetchTenders({
              laws: ["COMMERCIAL"],
              keywords: [keyword],
              // Цена и регион фильтруются на стороне адаптера:
              // поисковый запрос площадки их не поддерживает.
              minPrice: profile.minPrice ?? null,
              maxPrice: profile.maxPrice ?? null,
              regions: regionNames.length > 0 ? regionNames : undefined,
              limit: profile.limitPerKeyword ?? 10,
            }),
          unique,
        );
        perSource.set("SBER_AST", (perSource.get("SBER_AST") ?? 0) + found);
      }

      // `konturStopped` читается и здесь, а не только в заголовке профиля:
      // источник может исчерпать бюджет на середине списка ключевых слов, и
      // тогда оставшиеся слова опрашивать его уже нельзя — иначе сообщение об
      // остановке повторилось бы по разу на каждое слово.
      if (wantKontur && konturAdapter && konturStopped === null) {
        // По одному запросу на ключевое слово, а не на профиль: склеивать
        // ключевые слова в одну строку нельзя — Контур трактует её как точное
        // совпадение. Экономию даёт кэш: повторный прогон с теми же фильтрами
        // в пределах KONTUR_CACHE_TTL_SEARCH_SEC (по умолчанию сутки) берётся
        // из kontur_raw_responses и платный запрос не делает.
        try {
          const { found } = await collectFrom(
            "Контур.Закупки",
            keyword,
            () =>
              konturAdapter.fetchTenders({
                // Контур покрывает и коммерческие торги, поэтому COMMERCIAL
                // в отличие от ЕИС не отсекается.
                laws:
                  profile.laws.length > 0
                    ? profile.laws
                    : ["FZ_44", "FZ_223", "COMMERCIAL"],
                keywords: [keyword],
                minPrice: profile.minPrice ?? null,
                maxPrice: profile.maxPrice ?? null,
                okpd2Codes: profile.okpd2Codes,
                // Наименования субъектов и коды ОКПД2 Контур.Закупки в поиске не
                // принимает: регион задаётся только UUID из закрытого каталога
                // (`RegionIds`). Адаптер применяет оба фильтра к полученной
                // выдаче и печатает число отсевов в logKonturUsage.
                regions: regionNames.length > 0 ? regionNames : undefined,
                limit: profile.limitPerKeyword ?? 10,
              }),
            unique,
          );
          perSource.set("KONTUR", (perSource.get("KONTUR") ?? 0) + found);
        } catch (err) {
          // Предел или конец источника, а не сбой одного запроса: объяснение
          // собрано в `konturSourceStop`, здесь остаётся остановить опрос
          // Контур.Закупок до конца прогона и сказать об этом один раз.
          const stop = konturSourceStop(err);
          if (stop === null) throw err;
          konturStopped = stop;
          console.warn(`  Контур.Закупки: ${stop.message}`);
        }
      }
    }
    });

    // ТЭК-Торг: один запрос на профиль, а не на ключевое слово.
    //
    // Экспорт процедур ключевых слов не принимает вовсе: адаптер скачивает окно
    // публикации за сутки и отбирает по словам на своей стороне. Обход по словам
    // скачал бы ту же страницу (около 430 КБ за 10 с) столько раз, сколько в
    // профиле слов, и вернул бы те же закупки. Поэтому слова передаются списком, а
    // лимит считается так, сколько дали бы запросы по словам по отдельности.
    if (wantTektorg && tektorgAdapter) enqueue("ТЭК-Торг", async () => {
      const { found, ok } = await collectFrom(
        "ТЭК-Торг",
        cardKeywords.join(", ") || "вся секция",
        () =>
          tektorgAdapter.fetchTenders({
            laws: TEK_TORG_LAWS,
            keywords: cardKeywords,
            minPrice: profile.minPrice ?? null,
            maxPrice: profile.maxPrice ?? null,
            // Регион уходит в адаптер и применяется к полученной выдаче: в запросе
            // экспорта параметра региона нет (см. honoursRegions привязки).
            regions: regionNames.length > 0 ? regionNames : undefined,
            // ОКПД2 намеренно не передаётся: адаптер по кодам не отбирает, и
            // параметр, уходящий впустую, создавал бы ложное впечатление фильтра.
            limit: Math.max(
              TEK_TORG_MIN_LIMIT,
              (profile.limitPerKeyword ?? 10) * Math.max(1, cardKeywords.length),
            ),
            publishedWithinDays: liveMode ? LIVE_TEK_TORG_WINDOW_DAYS : TEK_TORG_WINDOW_DAYS,
            onlyOpen: true,
          }),
        unique,
      );
      perSource.set("TEK_TORG", (perSource.get("TEK_TORG") ?? 0) + found);

      // Почему из окна публикации в выдачу попало меньше, чем нашла площадка.
      // Без этой строки «найдено 3» из 75 процедур выглядело бы сбоем экспорта,
      // а это нормальная работа фильтра профиля.
      //
      // Печатается только после состоявшегося запроса. `filterStats` живёт в
      // адаптере, а одним адаптером прогон обходит несколько профилей: после сбоя
      // числа в нём принадлежат предыдущему профилю, и напечатать их значило бы
      // выдать чужой итог за свой. Причина уже названа строкой «ОШИБКА — …» выше.
      if (ok) {
        const stats = tektorgAdapter.filterStats;
        const rejected = describeCountedReasons(stats.rejected);
        console.log(
          `  ТЭК-Торг: в окне публикации ${stats.fetched} процедур, отобрано ${stats.kept}` +
            (rejected === "" ? "." : `; отброшено — ${rejected}.`),
        );
      }
    });

    // Росэлторг: тоже один запрос на профиль, но по другой причине.
    //
    // Ключевое слово поиск площадки принимает (`query_field`), и обход по словам
    // технически возможен. Не делаем его потому, что строка выдачи — это лот: одну
    // процедуру находят два разных слова, а полный набор лотов добирается
    // отдельным запросом по номеру. Адаптер, получив слова списком, спрашивает
    // такую процедуру один раз; обход по словам заплатил бы за неё дважды.
    //
    // Пустой список слов означает обход секций целиком: площадка отдаёт список и
    // без `query_field`, а отменять запрос значило бы молча оставить источник
    // пустым там, где он способен работать.
    if (wantRoseltorg && roseltorgAdapter) enqueue("Росэлторг", async () => {
      const { found, ok } = await collectFrom(
        "Росэлторг",
        cardKeywords.join(", ") || "все секции",
        () =>
          roseltorgAdapter.fetchTenders({
            laws: ROSELTORG_LAWS,
            keywords: cardKeywords,
            minPrice: profile.minPrice ?? null,
            maxPrice: profile.maxPrice ?? null,
            // Региона в форме поиска нет, зато он напечатан в строке выдачи:
            // адаптер отсеивает чужие субъекты сам и считает их в `filterStats`.
            regions: regionNames.length > 0 ? regionNames : undefined,
            // ОКПД2 площадка в выдаче не печатает вовсе: передавать код не во что,
            // а параметр, уходящий впустую, создавал бы ложное впечатление фильтра.
            limit: (profile.limitPerKeyword ?? 10) * Math.max(1, cardKeywords.length),
          }),
        unique,
      );
      perSource.set("ROSELTORG", (perSource.get("ROSELTORG") ?? 0) + found);

      // Строка выдачи — это лот, поэтому «строк» и «закупок» здесь два разных
      // числа, а между ними ещё добор лотов по номерам процедур. Без этой строки
      // «найдено 2» из сорока строк выглядело бы сбоем парсера.
      //
      // Печатается только после состоявшегося запроса: `filterStats` живёт в
      // адаптере, а одним адаптером прогон обходит несколько профилей, и после
      // сбоя числа в нём принадлежат предыдущему профилю. Причина уже названа
      // строкой «ОШИБКА — …» выше.
      if (ok) {
        const stats = roseltorgAdapter.filterStats;
        const dropped = describeCountedReasons(stats.droppedRows);
        const rejected = describeCountedReasons(stats.rejected);
        console.log(
          `  Росэлторг: ${stats.rows} строк выдачи, ${stats.discovered} процедур, ` +
            `лоты добраны по ${stats.resolved}, в выдаче ${stats.kept}` +
            (dropped === "" ? "" : `; отброшено строк — ${dropped}`) +
            (rejected === "" ? "" : `; отброшено закупок — ${rejected}`) +
            (stats.incomplete > 0
              ? `; у ${stats.incomplete} процедур набор лотов неполный — цена не опубликована`
              : "") +
            (stats.resolveLimitReached
              ? "; предел запросов по номерам достигнут: часть процедур не осмотрена"
              : "") +
            ".",
        );
      }
    });

    // Фабрикант: один запрос на профиль, и причина та же, что у Росэлторга.
    //
    // Ключевое слово поиск площадки принимает (`query`), но строка выдачи — это
    // лот, а полный набор лотов добирается страницами карточки. Одну процедуру
    // находят два разных слова, поэтому обход по словам заплатил бы за её
    // карточку дважды; адаптер, получив слова списком, спрашивает её один раз.
    //
    // Пустой список слов означает обход секций целиком: площадка отдаёт список и
    // без `query`, а отменять запрос значило бы молча оставить источник пустым.
    if (wantFabrikant && fabrikantAdapter) enqueue("Фабрикант", async () => {
      const { found, ok } = await collectFrom(
        "Фабрикант",
        cardKeywords.join(", ") || "все секции",
        () =>
          fabrikantAdapter.fetchTenders({
            laws: FABRIKANT_LAWS,
            keywords: cardKeywords,
            minPrice: profile.minPrice ?? null,
            maxPrice: profile.maxPrice ?? null,
            // Региона в форме поиска нет, а `customer_region_ids[]` фильтрует по
            // региону заказчика, а не по месту поставки: закупка с поставкой в
            // нужный субъект исчезла бы без следа. Регион печатает карточка,
            // поэтому адаптер отсеивает чужие субъекты сам и считает их в
            // `filterStats` отдельной причиной «регион не определён».
            regions: regionNames.length > 0 ? regionNames : undefined,
            // Границы цены площадке намеренно не передаются, хотя `price_from` и
            // `price_to` она принимает: не замерено, отбрасывает ли серверный
            // фильтр закупки «Без указания цены», а потерять их молча нельзя.
            // ОКПД2 площадка в выдаче не печатает: код передавать не во что.
            limit: (profile.limitPerKeyword ?? 10) * Math.max(1, cardKeywords.length),
          }),
        unique,
      );
      perSource.set("FABRIKANT", (perSource.get("FABRIKANT") ?? 0) + found);

      // Число с номером ЕИС печатается отдельно: такие закупки приносит и адаптер
      // реестра, поэтому «найдено 30» без этой цифры читалось бы как 30 новых
      // закупок вместо трёх десятков дублей и нескольких коммерческих процедур.
      //
      // Печатается только после состоявшегося запроса: `filterStats` живёт в
      // адаптере, а одним адаптером прогон обходит несколько профилей, и после
      // сбоя числа в нём принадлежат предыдущему профилю. Живой прогон
      // 02.10.2026 напечатал именно так — «ОШИБКА …» и следом 99 строк выдачи
      // соседнего профиля. Причина уже названа строкой ошибки выше.
      if (ok) {
        const stats = fabrikantAdapter.filterStats;
        // Отказ площадки по части слов не отменяет выдачу по остальным, но и не
        // прячется: «найдено 30» без этих цифр читалось бы как полный ответ,
        // тогда как часть слов площадка могла не показать вовсе. Формат тот же,
        // что у остальных причин, — название и счётчик в скобках.
        const unanswered = [
          stats.restrictedKeywords > 0
            ? `доступ к просмотру процедуры ограничен (${stats.restrictedKeywords})`
            : null,
          stats.failedKeywords > 0
            ? `запрос не прошёл (${stats.failedKeywords})`
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(", ");
        const dropped = describeCountedReasons(stats.droppedRows);
        const rejected = describeCountedReasons(stats.rejected);
        console.log(
          `  Фабрикант: ${stats.rows} строк выдачи, ${stats.discovered} процедур ` +
            `(${stats.withEisNumber} с номером ЕИС), лоты добраны по ${stats.resolved}, ` +
            `в выдаче ${stats.kept}` +
            (stats.regional > 0 ? `; по региону заказчика найдено ${stats.regional} процедур` : "") +
            (stats.regionFilterFailed
              ? "; справочник регионов площадки не прочитался — регион искался только по общероссийской выдаче"
              : "") +
            (unanswered === "" ? "" : `; не опрошено слов — ${unanswered}`) +
            (dropped === "" ? "" : `; отброшено строк — ${dropped}`) +
            (rejected === "" ? "" : `; отброшено закупок — ${rejected}`) +
            (stats.incomplete > 0
              ? `; у ${stats.incomplete} процедур набор лотов неполный — цена не опубликована`
              : "") +
            (stats.resolveLimitReached
              ? "; предел запросов карточек достигнут: часть процедур не осмотрена"
              : "") +
            ".",
        );
      }
    });
  }

  /*
    Обход региона целиком (ЕИС): сначала все открытые закупки региона, затем
    отбор по смыслу ниже — тем же правилом, каким ищет лента. Так находится то,
    что заказчик назвал другими словами, а поиск по слову пропускал.
  */
  /** Закупки, взятые обходом региона, и тема, по которой их судить. */
  const sweepTopic = new Map<string, string>();
  /** Слова профилей, под которые закупка отобрана моделью: лента покажет её по ним. */
  const senseKeywords = new Map<string, string[]>();
  // Обход регионов — последним шагом очереди ЕИС: он идёт одновременно с площадками
  // с карточками, а не после них (раньше это были лишние 25–35 секунд прогона).
  enqueue("ЕИС, Сбербанк-АСТ", async () => {
  if (eisAdapter && !unreachable.includes("EIS") && (!onlySources || onlySources.includes("EIS"))) {
    const sweptRegions = new Set<string>();
    for (const profile of profiles) {
      // ЕИС ограничила доступ в этом прогоне: обход следующих регионов — те же
      // запросы к закрытому сайту, и их затвор всё равно отклонил бы.
      if (eisBlockedRetryAt !== null) break;
      const regions = profileRegions(profile).filter((r) => !sweptRegions.has(r.toLowerCase()));
      if (regions.length === 0) continue;
      for (const r of regions) sweptRegions.add(r.toLowerCase());
      // Тема — все профили этого региона: что в нём ищут.
      const regionProfiles = profiles.filter((p) =>
        profileRegions(p).some((r) => regions.some((x) => x.toLowerCase() === r.toLowerCase())),
      );
      const topic =
        liveMode && liveQuery !== null
          ? [liveQuery, ...liveSynonyms].join(", ")
          : regionProfiles.map((p) => `${p.name}: ${p.keywords.join(", ")}`).join("; ");
      let swept: Tender[] = [];
      let found = 0;
      try {
        ({ found } = await collectFrom(
          "ЕИС",
          `все открытые закупки: ${regions.join(", ")}`,
          async () => {
            swept = await eisAdapter.fetchTenders({
              laws: ["FZ_44", "FZ_223"],
              keywords: [],
              regions,
              onlyOpen: true,
              publishedWithinDays: REGION_SWEEP_DAYS,
              maxPages: REGION_SWEEP_PAGES,
              limit: REGION_SWEEP_PAGES * 100,
            });
            return swept;
          },
          unique,
        ));
      } catch (err) {
        if (!isEisBlockedError(err)) throw err;
        markEisBlocked(err, `обход региона ${regions.join(", ")}`);
        break;
      }
      for (const t of swept) sweepTopic.set(t.regNumber, topic);
      const topicWords =
        liveMode && liveQuery !== null
          ? [liveQuery, ...liveSynonyms]
          : regionProfiles.flatMap((p) => p.keywords);
      for (const t of swept) senseKeywords.set(t.regNumber, topicWords.map((w) => w.toLowerCase()));
      perSource.set("EIS", (perSource.get("EIS") ?? 0) + found);
      queriedSources.add("EIS");
    }
  }
  });

  // Очереди площадок — параллельно; внутри очереди шаги по профилям — по одному.
  const laneSeconds: string[] = [];
  await Promise.all(
    [...lanes].map(async ([lane, steps]) => {
      const laneStarted = Date.now();
      for (const step of steps) await step();
      laneSeconds.push(`${lane} ${String(Math.round((Date.now() - laneStarted) / 1000))} с`);
    }),
  );
  if (laneSeconds.length > 0) console.log(`Время по площадкам (шли одновременно): ${laneSeconds.join(", ")}.`);

  /*
    Закупки региона судит модель, по смыслу: слова профиля плохо описывают
    сферу (по «строительство, ремонт» проходил ремонт автобусов, а
    благоустройство и сети водоснабжения выпадали). Решения кэшируются на диске,
    поэтому прогон платит только за новые закупки. Модель недоступна — эти
    закупки отбираются словами, как остальные.
  */
  const senseFit = new Map<string, "yes" | "maybe" | "no">();
  if (sweepTopic.size > 0) {
    let llmReady = true;
    try {
      resolveLlmEndpoint();
    } catch {
      llmReady = false;
      console.log("По смыслу: модель не настроена (LLM_*), закупки региона отбираются словами.");
    }
    if (llmReady) {
      // logs/ — единственная папка, куда сборщику разрешена запись (ReadWritePaths
      // в tenderfit-worker.service); выкладка её не трогает, кэш переживает обновления.
      const cacheDir = process.env["SYNC_CACHE_DIR"] ?? resolve(__dirname, "..", "logs");
      const cachePath = resolve(cacheDir, "tenderfit-fit-cache.json");
      let raw: string | undefined;
      try {
        raw = readFileSync(cachePath, "utf-8");
      } catch {
        raw = undefined;
      }
      const cache = createFitCache(raw);
      const assist = createSearchAssist(llmChat);
      const judge: Judge = async (topic, batch) => {
        const { verdicts } = await assist.rerank({ query: topic, candidates: batch });
        return Object.fromEntries(Object.entries(verdicts).map(([id, v]) => [id, v.fit]));
      };
      const byTopic = new Map<string, Tender[]>();
      for (const [regNumber, topic] of sweepTopic) {
        const t = unique.get(regNumber);
        if (t) byTopic.set(topic, [...(byTopic.get(topic) ?? []), t]);
      }
      for (const [topic, tenders] of byTopic) {
        const decided = await judgeBySense({
          topic,
          items: tenders.map((t) => ({ id: t.regNumber, subject: t.subject, customer: t.customerName })),
          judge,
          cache,
          limit: SENSE_MAX_PER_RUN,
        });
        for (const [id, fit] of decided) senseFit.set(id, fit);
      }
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cachePath, cache.serialize(), "utf-8");
      } catch (err) {
        console.log(`По смыслу: кэш решений не сохранён (${describeError(err)}).`);
      }
      const values = [...senseFit.values()];
      console.log(
        `По смыслу (модель): решено ${values.length} из ${sweepTopic.size}; подходит ${values.filter((f) => f === "yes").length}, ` +
          `возможно ${values.filter((f) => f === "maybe").length}, не подходит ${values.filter((f) => f === "no").length}.`,
      );
    }
  }

  /*
    Отбор по смыслу. Площадка отдаёт всё, что показалось ей похожим: по запросу
    «юридические услуги» ЕИС вернула оценку арестованного имущества, вывоз
    отходов и питание участников форума — совпало слово «услуги» (прогон
    05.10.2026). Такие находки в базу не идут: проверка та же, каким правилом
    ищет лента, поэтому найденное не пропадёт из ленты, а мусор в неё не
    попадёт. Живой поиск судит по полному запросу человека, плановый прогон —
    по ключевым словам своих профилей.

    Счётчик источника уменьшается вместе с отсевом: если площадка отдала только
    мусор, очистка её старых записей будет пропущена («источник не вернул
    новых закупок»), а не опустошит ленту.
  */
  {
    const gateKeywords = liveMode && liveQuery !== null ? [liveQuery, ...liveSynonyms] : profiles.flatMap((p) => p.keywords);
    const droppedBySource = new Map<TenderDataSource, number>();
    for (const [regNumber, tender] of [...unique]) {
      if (tender.dataSource === "KONTUR") continue;
      // Закупку региона, по которой есть решение модели, судит модель: проходит
      // только уверенное «подходит». «Возможно» вместе с совпавшими словами
      // пропускало мебель, полигон ТКО и ремонт автобусов (проверено 05.10.2026).
      const fit = senseFit.get(regNumber);
      if (fit === undefined ? isRelevantToKeywords(tender, gateKeywords) : fit === "yes") continue;
      unique.delete(regNumber);
      droppedBySource.set(tender.dataSource, (droppedBySource.get(tender.dataSource) ?? 0) + 1);
      perSource.set(tender.dataSource, Math.max(0, (perSource.get(tender.dataSource) ?? 0) - 1));
    }
    const droppedTotal = [...droppedBySource.values()].reduce((a, b) => a + b, 0);
    if (droppedTotal > 0) {
      const parts = [...droppedBySource].map(([source, count]) => `${source} ${count}`).join(", ");
      console.log(`Отсеяно как не относящееся к запросу: ${droppedTotal} (${parts}).`);
    }
  }

  // Итог по источникам. Опрошенный источник печатает число найденного,
  // неопрошенный — причину: «0 новых закупок» и «источник выключен» выглядят
  // похоже, а означают разное, и подменять одно другим значит прятать причину.
  const notQueriedReason = (source: TenderDataSource): string => {
    if (source === "EIS" && eisBlockedRetryAt !== null) return "ЕИС ограничила доступ (затвор запросов)";
    if (unreachable.includes(source)) return "не прошёл проверку связи";
    if (unconfigured.has(source)) return "адаптер ещё не подключён";
    const dropped = droppedSources.get(source);
    if (dropped) return dropped;
    if (source === "KONTUR" && konturStopped) return konturStopped.message;
    // Флаг --sources сужает прогон до перечисленного: профиль свой источник
    // выбрал, но в этот раз его отменили снаружи. Сказать «не выбран профилем»
    // значило бы обвинить настройки, которые ни при чём.
    if (onlySources && !onlySources.includes(source)) {
      return "отключён флагом --sources";
    }
    return "не выбран ни одним профилем";
  };

  console.log();
  for (const source of SYNC_SOURCES) {
    if (queriedSources.has(source)) {
      console.log(`Новых закупок, ${source}: ${perSource.get(source) ?? 0}`);
      continue;
    }
    console.log(`${source}: не опрашивался — ${notQueriedReason(source)}`);
  }
  console.log(`Уникальных закупок всего: ${unique.size}.`);

  /*
    ОКПД2 из карточек ЕИС. Выдача кода не печатает, и без него поиск по
    классификатору («69.10») не работает ни у одной закупки. Сначала берётся
    известное из базы: плановый прогон пересоздаёт строки источника, и
    добытый в прошлый раз код пропал бы вместе со строкой. Остальное — из
    карточек, не больше бюджета за прогон: сто пятьдесят карточек подряд —
    это минуты и лишняя нагрузка на чужой сайт; что не успели, добирает
    следующий прогон. Сбой карточки код не теряет и прогон не роняет.
  */
  // Тот же адаптер, что искал закупки, но с типом ЕИС: метод карточек есть
  // только у него, а общий тип источника его не знает.
  const eisCards = (eisAdapter as EisTenderSourceAdapter | null) ?? null;
  /*
    Живой поиск код не добирает: человек ждёт результата, а на карточки ЕИС
    (одна-две страницы на закупку, три запроса в секунду) уходило сорок секунд
    из девяноста. Код нужен поиску по классификатору, а живой поиск идёт по
    словам. Плановый прогон добирает коды по своему бюджету.
  */
  if (eisCards && !liveMode && eisBlockedRetryAt === null) {
    const budget = Number.parseInt(process.env["SYNC_OKPD2_BUDGET"] ?? "", 10);
    const existing = new Map<string, string[]>();
    const { data: known, error: knownError } = await supabase
      .from("tenders")
      .select("reg_number, okpd2_codes")
      .not("okpd2_codes", "is", null);
    if (knownError) {
      console.log(`ОКПД2: известные коды не прочитаны (${knownError.message}), берём из карточек.`);
    }
    for (const row of (known ?? []) as { reg_number: string; okpd2_codes: string[] | null }[]) {
      if (row.okpd2_codes && row.okpd2_codes.length > 0) existing.set(row.reg_number, row.okpd2_codes);
    }

    const plan = planOkpd2Enrichment({
      tenders: [...unique.values()],
      existing,
      sources: ["EIS"],
      budget: Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_OKPD2_BUDGET,
    });

    for (const [regNumber, codes] of plan.carry) {
      const tender = unique.get(regNumber);
      if (tender) unique.set(regNumber, { ...tender, okpd2Codes: codes });
    }
    let fetched = 0;
    let empty = 0;
    let blockedLeft = 0;
    for (const [index, regNumber] of plan.fetch.entries()) {
      const tender = unique.get(regNumber);
      if (!tender) continue;
      let codes: string[];
      try {
        codes = await eisCards.fetchOkpd2(tender);
      } catch (err) {
        // Блокировка ЕИС: карточки не спрашиваем дальше, коды доберёт следующий прогон.
        if (!isEisBlockedError(err)) throw err;
        markEisBlocked(err, "карточки ОКПД2");
        blockedLeft = plan.fetch.length - index;
        break;
      }
      if (codes.length > 0) {
        unique.set(regNumber, { ...tender, okpd2Codes: codes });
        fetched += 1;
      } else {
        empty += 1;
      }
    }
    console.log(
      `ОКПД2 (ЕИС): из прошлого прогона ${plan.carry.size}, из карточек ${fetched}, ` +
        `кода нет или карточка не ответила ${empty}, отложено на следующий прогон ${plan.deferred}` +
        (blockedLeft > 0 ? `, не опрошено из-за блокировки ЕИС ${blockedLeft}.` : "."),
    );
  }

  if (dryRun) {
    console.log();
    for (const source of SYNC_SOURCES) {
      const rows = [...unique.values()].filter((t) => t.dataSource === source);
      // Пустой раздел не печатаем: про источник без закупок уже сказала итоговая
      // строка выше, и там же — спросили его или нет.
      if (rows.length === 0) continue;
      console.log(`${source} — ${rows.length} шт., примеры:`);
      for (const t of rows.slice(0, 4)) {
        const lots = t.lots.length > 1 ? `, лотов: ${t.lots.length}` : "";
        // Цена — общим форматтером, а не `${price} ₽`. Нуль в сущности означает
        // «цена не опубликована» (см. TenderFinancialTerms), и «0 ₽» в журнале
        // читается как потерянная цена; знак валюты тоже не всегда рубль —
        // коммерческие торги объявляют и в долларах, и в юанях.
        console.log(
          `  · ${t.regNumber} — ${t.subject.slice(0, 55)} (${formatTenderPrice(t.financial.price, t.financial.currency)}, ${t.region}${lots})`,
        );
      }
    }

    // Номер закупки не должен содержать номер лота: значит, склейка лотов не сработала.
    const lotLike = [...unique.values()].filter((t) => /\.\d+$/.test(t.regNumber));
    if (lotLike.length > 0) {
      console.warn(
        `Внимание: у ${lotLike.length} записей в regNumber остался номер лота (например ${lotLike[0]?.regNumber})`,
      );
    }

    console.log();
    if (konturAdapter) logKonturUsage(konturAdapter);
    console.log(
      `--dry-run завершён за ${((Date.now() - started) / 1000).toFixed(1)} с, в БД ничего не записано`,
    );
    return;
  }

  for (const cache of cardCaches) cache.flush();
  console.log("Сохранение в Supabase...");

  if (liveMode) {
    console.log("Очистка пропущена: живой поиск только добавляет закупки.");
  } else {
    // Закрытые «живые» закупки удаляются через сутки после срока подачи: иначе
    // найденное накапливалось бы вечно, ведь плановая очистка их щадит.
    const { error: expireError, count: expired } = await supabase
      .from("tenders")
      .delete({ count: "exact" })
      .eq("raw_data->>origin", LIVE_ORIGIN)
      .lt("submission_end", liveExpiryCutoff(Date.now()));
    if (expireError) {
      console.error(`Не удалось убрать закрытые живые закупки: ${expireError.message}`);
    } else if ((expired ?? 0) > 0) {
      console.log(`Убрано закрытых закупок живого поиска: ${expired ?? 0}`);
    }
  }

  /*
    Очистка старых закупок источника — ПОСЛЕ записи и только тех, которых в этом снимке
    нет. Раньше строки источника удалялись целиком до записи и вставлялись заново: у
    каждой закупки каждые два часа менялись дата появления и id. «Новые с последнего
    поиска» тогда означали всю базу — сверху ленты после поиска стояли старые закупки
    с пометкой результата (замечание владельца 15.10.2026). Теперь существующая строка
    обновляется на месте (upsertByRegNumber) и сохраняет дату первого появления.
    Очистку делаем ТОЛЬКО если источник в этот раз что-то отдал — иначе сетевой сбой
    опустошил бы ленту.
  */
  const cleanupStaleRows = async (keep: ReadonlySet<string>): Promise<void> => {
    for (const source of SYNC_SOURCES) {
      if (liveMode) {
        // Живой поиск только добавляет: очистка снимка источника стёрла бы
        // всё, что собрали плановые профили.
        continue;
      }
      // ЕИС ограничила доступ в этом прогоне: снимок неполный (часть слов и страниц
      // не опрошена), и очистка стёрла бы старые закупки, которых мы просто не увидели.
      if (source === "EIS" && eisBlockedRetryAt !== null) {
        console.log("Очистка EIS пропущена: ЕИС ограничила доступ, снимок неполный");
        continue;
      }
      if ((perSource.get(source) ?? 0) === 0) {
        // Пропущенный треком источник не «ничего не вернул», а не опрашивался: его
        // строки остаются как есть до следующего опроса.
        console.log(
          droppedSources.has(source)
            ? `Очистка ${source} пропущена: источник не опрашивался в этом прогоне`
            : `Очистка ${source} пропущена: источник не вернул новых закупок`,
        );
        continue;
      }
      // Строки, найденные живым поиском или добавленные по ссылке, переживают очистку:
      // плановые профили их не собирали.
      const stored: { id: string; reg_number: string }[] = [];
      let readError: string | null = null;
      for (let from = 0; ; from += CLEANUP_PAGE) {
        const { data, error } = await supabase
          .from("tenders")
          .select("id, reg_number")
          .eq("data_source", source)
          .or(KEEP_LIVE_ROWS_FILTER)
          .order("id")
          .range(from, from + CLEANUP_PAGE - 1);
        if (error) {
          readError = error.message;
          break;
        }
        stored.push(...((data ?? []) as { id: string; reg_number: string }[]));
        if ((data ?? []).length < CLEANUP_PAGE) break;
      }
      if (readError !== null) {
        console.error(`Не удалось прочитать записи ${source} для очистки: ${readError}`);
        continue;
      }
      const stale = staleRowIds(stored, keep);
      let deleted = 0;
      let deleteError: string | null = null;
      for (let i = 0; i < stale.length; i += CLEANUP_DELETE_BATCH) {
        const batch = stale.slice(i, i + CLEANUP_DELETE_BATCH);
        const { error, count } = await supabase.from("tenders").delete({ count: "exact" }).in("id", batch);
        if (error) {
          deleteError = error.message;
          break;
        }
        deleted += count ?? 0;
      }
      if (deleteError !== null) {
        console.error(`Не удалось очистить старые записи ${source}: ${deleteError}`);
      } else {
        console.log(`Удалено старых записей ${source}: ${deleted}`);
      }
    }
  };

  /** Реестровые номера, которые этот прогон видел и записал (или пытался): их очистка не трогает. */
  const seenRegNumbers = new Set<string>();
  let saved = 0;
  let errors = 0;
  let documents = 0;
  let duplicates = 0;
  /** Номера закупок, которые не записаны из-за ненапечатанного срока подачи. */
  const withoutDeadline: string[] = [];
  /** Живой поиск: закупки, закрытые больше суток назад, в базу не идут. */
  let liveClosedSkipped = 0;

  const saveOne = async (t: Tender): Promise<void> => {
    // ЕИС отдаёт и давно закрытые закупки: в первом живом прогоне 14 из 35 были
    // закрыты больше суток назад. Плановый прогон такие «живые» строки всё равно
    // удалит, поэтому сохранять их — значит показывать закрытое как найденное.
    if (liveMode && isLiveExpired(t.deadlines.submissionEnd, Date.now())) {
      liveClosedSkipped += 1;
      return;
    }
    // Плановый сбор не хранит давно закрытое (давние извещения ЕИС с вечным
    // статусом «Подача заявок»): неделя после срока — предел.
    if (!liveMode && isClosedLongAgo(t.deadlines.submissionEnd, Date.now())) {
      liveClosedSkipped += 1;
      return;
    }

    // `submission_end` объявлен NOT NULL, а пустую строку в этом поле способен
    // отдать не один источник: Фабрикант и Росэлторг берут ближайший срок из
    // лотов, ТЭК-Торг — `dateEndRegistration`, Контур — `ApplicationDeadline`.
    // Прогон 03.10.2026 напечатал на этом 44 ошибки 22007 — по строке на каждую
    // закупку, — и причина в журнале так и не появилась.
    //
    // Подставить «сегодня» или дату публикации нельзя: выдуманная дата прошла бы
    // проверку на просроченный срок и показала партнёру закупку, срок которой
    // неизвестен. Потеря со счётчиком и номерами честнее.
    if (t.deadlines.submissionEnd.trim() === "") {
      withoutDeadline.push(t.regNumber);
      return;
    }

    const row = {
      ...tenderBaseRow(t),
      // Сырой ответ платного источника и время синхронизации: по ним закупку
      // можно пересобрать без нового обращения к API. Колонки добавлены
      // миграцией 20260921000003, поэтому пишем их только для KONTUR —
      // записи остальных источников остаются прежними, даже если миграция
      // ещё не применена.
      ...(t.dataSource === "KONTUR"
        ? { raw_data: konturAdapter?.getRaw(t.regNumber) ?? null, synced_at: syncStartedAt }
        : {}),
      // Найденное живым поиском помечается: плановая очистка такие строки щадит.
      // Колонка raw_data появилась миграцией Контура и есть в базе.
      ...(liveMode && liveQuery !== null && t.dataSource !== "KONTUR"
        ? { raw_data: liveRawData(liveQuery, syncStartedAt) }
        : {}),
      // Отобрано моделью при обходе региона (плановый сбор): лента покажет по словам профиля.
      ...(!liveMode && t.dataSource !== "KONTUR" && senseFit.get(t.regNumber) === "yes"
        ? { raw_data: { origin: "sense", keywords: senseKeywords.get(t.regNumber) ?? [] } }
        : {}),
    };

    // Запись через репозиторий, а не прямым upsert: там же живёт правило
    // приоритета источников. Контур.Закупки — агрегатор извещений ЕИС, и без
    // этого правила его выдача (часть полей закрашена) затирала бы строку ЕИС.
    // Видели в этом снимке — значит, строку не удалять, даже если запись не удалась.
    seenRegNumbers.add(t.regNumber);
    try {
      const { duplicateOf } = await tenderRepository.upsertByRegNumber(row);
      if (duplicateOf) {
        duplicates++;
        return;
      }
      saved++;
    } catch (err) {
      console.error(`  ✗ ${t.regNumber}: ${describeError(err)}`);
      errors++;
      return;
    }

    // Документы закупки (сейчас их отдаёт только Контур) складываем в
    // tender_documents — дальше их подхватывает пайплайн анализа документации.
    // Ключ записи сервис берёт сам из t.regNumber: UUID строки tenders не
    // подходит, плановая синхронизация пересоздаёт строки каждый прогон.
    if (t.documents.length === 0) return;
    try {
      documents += await saveKonturTenderDocuments(t);
    } catch (err) {
      // Закупка уже сохранена: ошибка документов не должна рушить прогон.
      console.error(`  ✗ документы ${t.regNumber}: ${describeError(err)}`);
    }
  };

  /*
    Запись пачкой одновременных запросов: строки независимы (ключ — реестровый
    номер, повторы убраны выше), а по одной 141 строка писалась 22 секунды.
  */
  await runPool([...unique.values()], SAVE_CONCURRENCY, saveOne);
  await cleanupStaleRows(seenRegNumbers);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log();
  if (konturAdapter) logKonturUsage(konturAdapter);
  if (liveClosedSkipped > 0) {
    console.log(
      liveMode
        ? `Не сохранено закупок, закрытых больше суток назад: ${liveClosedSkipped}.`
        : `Не сохранено закупок, закрытых больше недели назад: ${liveClosedSkipped}.`,
    );
  }
  if (withoutDeadline.length > 0) {
    // Номера печатаются, чтобы потерю можно было проверить по карточке площадки.
    // Дальше двадцати — только первые: строка на сотню номеров не читается, а
    // счётчик и так виден.
    const shown = withoutDeadline.slice(0, 20).join(", ");
    console.log(
      `Не записано без срока подачи заявок: ${withoutDeadline.length} (${shown}${
        withoutDeadline.length > 20 ? ", …" : ""
      })`,
    );
  }
  // Затвор мог поймать блокировку и в чужом процессе за время прогона — но
  // говорим только о том, что случилось здесь: карантин, поставленный соседом
  // после нашего последнего запроса к ЕИС, этот прогон не затронул.
  const failedSources = [
    ...new Set([
      ...[...sourceTally]
        .filter(([label, tally]) => tally.failed > 0 && tally.ok === 0 && !(label === "ЕИС" && eisBlockedRetryAt !== null))
        .map(([label]) => label),
      ...probe.unreachable.map(
        (source) => SOURCE_BINDINGS.find((b) => b.source === source)?.label ?? source,
      ),
    ]),
  ];
  console.log(
    buildSyncRunNote({
      saved,
      documents,
      duplicates,
      errors,
      elapsedSec: elapsed,
      eisBlockedRetryAt,
      failedSources,
    }),
  );

  /*
    Документация свежих коммерческих закупок ТЭК-Торга — заранее.

    Коммерческие торги — главное отличие продукта, а из коммерческих площадок
    байты документов отдаёт только ТЭК-Торг, бесплатно и без ключа. Скачанная
    заранее документация значит, что глубокий разбор и смета по такой закупке
    стартуют сразу, а поиск по документам находит её по тексту ТЗ. AI-разбор
    здесь не запускается (runWorker: false): он платный и идёт только по решению
    человека. Берутся самые свежие открытые закупки, не больше предела за прогон;
    уже скачанные отвечают «уже было» без запроса к площадке.
  */
  if (!liveMode && TEK_TORG_DOC_PREFETCH > 0) {
    const nowMs = Date.now();
    const fresh = [...unique.values()]
      .filter((t) => t.dataSource === "TEK_TORG")
      .filter((t) => {
        const end = Date.parse(t.deadlines.submissionEnd);
        return Number.isNaN(end) || end > nowMs;
      })
      .sort((a, b) => (b.deadlines.publicationDate ?? "").localeCompare(a.deadlines.publicationDate ?? ""))
      .slice(0, TEK_TORG_DOC_PREFETCH)
      .map((t) => t.regNumber);
    if (fresh.length > 0) {
      console.log();
      console.log(`ТЭК-Торг: документация заранее для ${fresh.length} свежих закупок...`);
      try {
        await runDocumentFetch({ tenders: fresh, runWorker: false, dryRun });
      } catch (err) {
        // Лента уже сохранена: сбой скачивания документов её не отменяет.
        console.error(`ТЭК-Торг: документация не скачана: ${describeError(err)}`);
      }
    }
  }

  // Закупки, которые партнёр перевёл в «Интересное», ждут глубокого анализа.
  // Документацию для них догружаем этим же прогоном: машина сейчас в российском
  // сегменте сети и ЕИС отвечает, а отдельная задача в планировщике не нужна.
  if (liveMode) {
    // Очередь документов — работа планового прогона: тяжёлая, с обращением к
    // ЕИС за файлами, и человеку, ждущему результат поиска, она только
    // удлиняла бы ожидание.
    console.log("Глубокий анализ: пропущен в живом поиске.");
    return;
  }
  console.log();
  console.log("Глубокий анализ: догрузка документации по очереди...");
  try {
    // dryRun пробрасывается намеренно. Без него --dry-run печатал «данные в
    // Supabase не записываются», а догрузка документации шла с настройками по
    // умолчанию: текст файлов писался в tender_documents, а следом запускался
    // AI-разбор на проде — то есть режим, обещавший ничего не менять, тратил
    // суточный потолок разборов. С dryRun: true файлы читаются, но не
    // сохраняются, и до разбора дело не доходит.
    await runDocumentFetch({ dryRun });
  } catch (err) {
    // Лента уже сохранена: сбой догрузки документов не отменяет синхронизацию.
    console.error(`Документация не догружена: ${describeError(err)}`);
  }
}

main().catch((err: unknown) => {
  console.error("Критическая ошибка:", err);
  process.exit(1);
});
