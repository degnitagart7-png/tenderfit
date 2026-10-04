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
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { TenderSourceAdapter } from "../src/adapters/types";
import type { KonturTenderSourceAdapter } from "../src/adapters/tender-source/konturTenderSourceAdapter";
import type { TektorgTenderSourceAdapter } from "../src/adapters/tender-source/tektorgTenderSourceAdapter";
import type { RoseltorgTenderSourceAdapter } from "../src/adapters/tender-source/roseltorgTenderSourceAdapter";
import type { FabrikantTenderSourceAdapter } from "../src/adapters/tender-source/fabrikantTenderSourceAdapter";
import {
  decideKonturSync,
  konturLastPaidSearchAt,
  konturSourceStop,
  konturSyncIntervalHours,
  saveKonturTenderDocuments,
  type KonturSourceStop,
} from "../src/services/konturSyncService";
import { SOURCE_BINDINGS } from "../src/services/tenderSourceRegistry";
import { defaultSources, syncableSources } from "../src/domain/sources";
import { runDocumentFetch } from "./fetch-tender-documents";
// Расшифровка ошибок общая с воркером: те же коды и та же подпись «источник не
// пускает наш адрес» в обоих логах, иначе причину сбоя пришлось бы узнавать
// заново на каждом сервере.
import { describeError } from "../src/lib/errors";
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
async function probeSources(wanted: Set<TenderDataSource>): Promise<TenderDataSource[]> {
  const probes = SOURCE_BINDINGS.filter((b) => wanted.has(b.source)).map((b) => ({
    source: b.source,
    label: b.label,
    url: b.probeUrl,
  }));
  if (probes.length === 0) return [];

  const results = await Promise.all(
    probes.map(async (probe) => {
      try {
        const res = await fetch(probe.url, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        await res.body?.cancel();
        return { probe, ok: res.status < 500, status: res.status };
      } catch (err) {
        return { probe, ok: false, status: 0, error: describeError(err) };
      }
    }),
  );

  const unreachable: TenderDataSource[] = [];
  for (const r of results) {
    if (r.ok) {
      console.log(`Проверка связи · ${r.probe.label}: доступен (HTTP ${r.status})`);
      continue;
    }
    unreachable.push(r.probe.source);
    const reason = "status" in r && r.status >= 500 ? `HTTP ${r.status}` : r.error ?? "нет ответа";
    console.error(`Проверка связи · ${r.probe.label}: НЕДОСТУПЕН — ${reason}`);
  }

  if (unreachable.length === 0) return unreachable;

  const ip = await currentPublicIp();
  console.error(
    `\nВыход в интернет с IP ${ip ?? "не определён"}. Часть площадок блокирует` +
      "\nзарубежные адреса: если IP не российский, отключите VPN или добавьте" +
      "\nв его split-tunnel исключения адреса площадок — они лежат в привязках" +
      "\nисточников (SOURCE_BINDINGS) рядом с конструкторами." +
      "\nНедоступность при российском IP обычно означает защиту самой площадки" +
      "\nили её регламентные работы, а не нашу настройку.\n",
  );

  if (unreachable.length === probes.length) {
    console.error("Ни один источник не отвечает — синхронизация прервана, данные в БД не тронуты.");
    process.exit(2);
  }
  console.error(
    `Продолжаем без ${unreachable.join(", ")}: его старые записи в ленте останутся нетронутыми.`,
  );
  return unreachable;
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
  const sources = only ? requested.filter((s) => only.includes(s)) : requested;
  const eisLaws = profile.laws.filter((l) => l !== "COMMERCIAL");
  return { eisLaws, sources };
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
  try {
    const tenders = await fetcher();
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

  const profiles = syncConfig.profiles.filter((p) => p.enabled);
  if (profiles.length === 0) {
    console.log("Нет включённых профилей в sync-profiles.json — нечего синхронизировать.");
    return;
  }

  console.log("Синхронизация закупок → Supabase по профилям поиска");
  console.log(`Профилей: ${profiles.length} | ${profiles.map((p) => p.name).join(", ")}`);
  if (dryRun) console.log("РЕЖИМ --dry-run: данные в Supabase не записываются");
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

  const unreachable = await probeSources(wanted);
  console.log();

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

    for (const keyword of profile.keywords) {
      if (wantEis && eisAdapter) {
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
              // profile.regions сюда намеренно не передаётся: ЕИС его
              // игнорирует, а параметр, уходящий впустую, создавал бы ложное
              // впечатление, что фильтр работает. Предупреждение — в логе выше.
              limit: profile.limitPerKeyword ?? 10,
            }),
          unique,
        );
        perSource.set("EIS", (perSource.get("EIS") ?? 0) + found);
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

    // ТЭК-Торг: один запрос на профиль, а не на ключевое слово.
    //
    // Экспорт процедур ключевых слов не принимает вовсе: адаптер скачивает окно
    // публикации за сутки и отбирает по словам на своей стороне. Обход по словам
    // скачал бы ту же страницу (около 430 КБ за 10 с) столько раз, сколько в
    // профиле слов, и вернул бы те же закупки. Поэтому слова передаются списком, а
    // лимит считается так, сколько дали бы запросы по словам по отдельности.
    if (wantTektorg && tektorgAdapter) {
      const { found, ok } = await collectFrom(
        "ТЭК-Торг",
        profile.keywords.join(", ") || "вся секция",
        () =>
          tektorgAdapter.fetchTenders({
            laws: TEK_TORG_LAWS,
            keywords: profile.keywords,
            minPrice: profile.minPrice ?? null,
            maxPrice: profile.maxPrice ?? null,
            // Регион уходит в адаптер и применяется к полученной выдаче: в запросе
            // экспорта параметра региона нет (см. honoursRegions привязки).
            regions: regionNames.length > 0 ? regionNames : undefined,
            // ОКПД2 намеренно не передаётся: адаптер по кодам не отбирает, и
            // параметр, уходящий впустую, создавал бы ложное впечатление фильтра.
            limit: (profile.limitPerKeyword ?? 10) * Math.max(1, profile.keywords.length),
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
    }

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
    if (wantRoseltorg && roseltorgAdapter) {
      const { found, ok } = await collectFrom(
        "Росэлторг",
        profile.keywords.join(", ") || "все секции",
        () =>
          roseltorgAdapter.fetchTenders({
            laws: ROSELTORG_LAWS,
            keywords: profile.keywords,
            minPrice: profile.minPrice ?? null,
            maxPrice: profile.maxPrice ?? null,
            // Региона в форме поиска нет, зато он напечатан в строке выдачи:
            // адаптер отсеивает чужие субъекты сам и считает их в `filterStats`.
            regions: regionNames.length > 0 ? regionNames : undefined,
            // ОКПД2 площадка в выдаче не печатает вовсе: передавать код не во что,
            // а параметр, уходящий впустую, создавал бы ложное впечатление фильтра.
            limit: (profile.limitPerKeyword ?? 10) * Math.max(1, profile.keywords.length),
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
    }

    // Фабрикант: один запрос на профиль, и причина та же, что у Росэлторга.
    //
    // Ключевое слово поиск площадки принимает (`query`), но строка выдачи — это
    // лот, а полный набор лотов добирается страницами карточки. Одну процедуру
    // находят два разных слова, поэтому обход по словам заплатил бы за её
    // карточку дважды; адаптер, получив слова списком, спрашивает её один раз.
    //
    // Пустой список слов означает обход секций целиком: площадка отдаёт список и
    // без `query`, а отменять запрос значило бы молча оставить источник пустым.
    if (wantFabrikant && fabrikantAdapter) {
      const { found, ok } = await collectFrom(
        "Фабрикант",
        profile.keywords.join(", ") || "все секции",
        () =>
          fabrikantAdapter.fetchTenders({
            laws: FABRIKANT_LAWS,
            keywords: profile.keywords,
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
            limit: (profile.limitPerKeyword ?? 10) * Math.max(1, profile.keywords.length),
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
    }
  }

  // Итог по источникам. Опрошенный источник печатает число найденного,
  // неопрошенный — причину: «0 новых закупок» и «источник выключен» выглядят
  // похоже, а означают разное, и подменять одно другим значит прятать причину.
  const notQueriedReason = (source: TenderDataSource): string => {
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

  console.log("Сохранение в Supabase...");

  // Удаляем старые закупки источника, чтобы не показывать нерелевантные
  // результаты прошлых синхронизаций. Очистку делаем ТОЛЬКО если источник
  // в этот раз что-то отдал — иначе сетевой сбой опустошил бы ленту.
  for (const source of SYNC_SOURCES) {
    if ((perSource.get(source) ?? 0) === 0) {
      console.log(`Очистка ${source} пропущена: источник не вернул новых закупок`);
      continue;
    }
    const { error: cleanError, count: deleted } = await supabase
      .from("tenders")
      .delete({ count: "exact" })
      .eq("data_source", source);
    if (cleanError) {
      console.error(`Не удалось очистить старые записи ${source}: ${cleanError.message}`);
    } else {
      console.log(`Удалено старых записей ${source}: ${deleted ?? 0}`);
    }
  }

  let saved = 0;
  let errors = 0;
  let documents = 0;
  let duplicates = 0;

  for (const t of unique.values()) {
    const row = {
      reg_number: t.regNumber,
      external_id: t.externalId,
      law: t.law,
      placing_way: t.placingWay,
      subject: t.subject,
      customer_name: t.customerName,
      customer_inn: t.customerInn,
      region: t.region,
      delivery_address: t.deliveryAddress || null,
      price: t.financial.price || null,
      currency: t.financial.currency || "RUB",
      advance_payment: t.financial.advancePercent || null,
      security_bid: t.financial.bidSecurityAmount || null,
      security_contract: t.financial.contractSecurityAmount || null,
      submission_end: t.deadlines.submissionEnd,
      publication_date: t.deadlines.publicationDate || null,
      last_update_date: t.deadlines.lastUpdateDate || null,
      delivery_term_days: t.deadlines.deliveryTermDays || null,
      okpd2_codes: t.okpd2Codes.length > 0 ? t.okpd2Codes : null,
      lots: t.lots.length > 0 ? t.lots : null,
      requirements: t.requirements.length > 0 ? t.requirements : null,
      national_regime: t.nationalRegime,
      only_for_smp: t.onlyForSmp,
      // Общая колонка для ссылки на первоисточник: карточка закупки на той
      // площадке, которая её отдала.
      eis_url: t.eisUrl || null,
      data_source: t.dataSource,
      // Сырой ответ платного источника и время синхронизации: по ним закупку
      // можно пересобрать без нового обращения к API. Колонки добавлены
      // миграцией 20260921000003, поэтому пишем их только для KONTUR —
      // записи остальных источников остаются прежними, даже если миграция
      // ещё не применена.
      ...(t.dataSource === "KONTUR"
        ? { raw_data: konturAdapter?.getRaw(t.regNumber) ?? null, synced_at: syncStartedAt }
        : {}),
    };

    // Запись через репозиторий, а не прямым upsert: там же живёт правило
    // приоритета источников. Контур.Закупки — агрегатор извещений ЕИС, и без
    // этого правила его выдача (часть полей закрашена) затирала бы строку ЕИС.
    try {
      const { duplicateOf } = await tenderRepository.upsertByRegNumber(row);
      if (duplicateOf) {
        duplicates++;
        continue;
      }
      saved++;
    } catch (err) {
      console.error(`  ✗ ${t.regNumber}: ${describeError(err)}`);
      errors++;
      continue;
    }

    // Документы закупки (сейчас их отдаёт только Контур) складываем в
    // tender_documents — дальше их подхватывает пайплайн анализа документации.
    // Ключ записи сервис берёт сам из t.regNumber: UUID строки tenders не
    // подходит, плановая синхронизация пересоздаёт строки каждый прогон.
    if (t.documents.length === 0) continue;
    try {
      documents += await saveKonturTenderDocuments(t);
    } catch (err) {
      // Закупка уже сохранена: ошибка документов не должна рушить прогон.
      console.error(`  ✗ документы ${t.regNumber}: ${describeError(err)}`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log();
  if (konturAdapter) logKonturUsage(konturAdapter);
  console.log(
    `Готово: ${saved} сохранено, ${documents} документов, ${duplicates} уже было от другого источника, ${errors} ошибок, ${elapsed} с`,
  );

  // Закупки, которые партнёр перевёл в «Интересное», ждут глубокого анализа.
  // Документацию для них догружаем этим же прогоном: машина сейчас в российском
  // сегменте сети и ЕИС отвечает, а отдельная задача в планировщике не нужна.
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
