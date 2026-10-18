import type { TenderDataSource } from "@/types/database";
import type { TenderSourceAdapter } from "@/adapters/types";
import { EisTenderSourceAdapter } from "@/adapters/tender-source/eisTenderSourceAdapter";
import { EtpgpbTenderSourceAdapter, etpgpbCardTtlMs } from "@/adapters/tender-source/etpgpbTenderSourceAdapter";
import { FabrikantTenderSourceAdapter } from "@/adapters/tender-source/fabrikantTenderSourceAdapter";
import { RoseltorgTenderSourceAdapter } from "@/adapters/tender-source/roseltorgTenderSourceAdapter";
import { SberAstTenderSourceAdapter } from "@/adapters/tender-source/sberAstTenderSourceAdapter";
import { TektorgTenderSourceAdapter } from "@/adapters/tender-source/tektorgTenderSourceAdapter";
import { createKonturAdapter } from "@/services/konturSyncService";
import { cardCacheDir } from "@/lib/cardCache";
import { tektorgWindowCacheTtlMs } from "@/adapters/tender-source/tektorgWindowCache";

/**
 * Привязка источника к его реализации.
 *
 * Каталог `src/domain/sources.ts` знает про источник только факты и не импортирует
 * ничего сверху, поэтому конструкторы живут здесь: домен остаётся чистым, а
 * скрипт синхронизации перестаёт перечислять адаптеры вручную.
 *
 * Файл лежит в `services/`, а не в `adapters/`: привязка Контура создаёт адаптер
 * через `createKonturAdapter`, который читает бюджет из журнала расхода в базе.
 * По правилам слоёв (`adapters/` ниже `services/`) адаптер не может импортировать
 * сервис, поэтому реестр стоит на том слое, которому оба импорта разрешены.
 */
export interface SourceBinding {
  readonly source: TenderDataSource;
  /** Как источник назван в логе проверки связи. */
  readonly label: string;
  /**
   * Точка проверки доступности. Публичная страница, а не API: прогон не должен
   * тратить платный запрос на то, чтобы узнать, жив ли хост.
   */
  readonly probeUrl: string;
  /**
   * Создать адаптер. null — источник не настроен (нет ключа) или ещё не
   * подключён; прогон продолжает работать остальными.
   */
  create(): Promise<TenderSourceAdapter | null>;
  /**
   * Как часто опрашивать: null — каждый прогон. У платного источника интервал
   * читается из env, поэтому здесь число, а не константа.
   */
  readonly cadenceHours: number | null;
  /**
   * Применяет ли источник фильтр по региону из профиля поиска.
   *
   * Это факт про источник, а не про скрипт, поэтому он записан здесь: прогон
   * обязан честно сказать в логе, какие регионы будут учтены, а какие нет.
   * Умолчание стоило бы пользователю выдачи по всей России под видом
   * отобранной по его региону — про такое правило UX говорит прямо: фильтр не
   * должен молча переставать работать.
   */
  readonly honoursRegions: boolean;
}

const RATE_LIMIT_PER_SEC = 2;
const MAX_RETRIES = 3;

/**
 * Скорость запросов к ЕИС из прогона: `EIS_RATE_PER_SEC` или прежние 2 в секунду.
 *
 * Зачем переменная. Все запросы к ЕИС идут с одного адреса, а лимит считается на
 * процесс. Воркер (scripts/worker.ts) с 14.10.2026 может вести плановый обход и
 * живой поиск одновременно, двумя дочерними процессами: при 2 + 2 запросов в
 * секунду ЕИС увидела бы вдвое больше обращений, чем всегда, а за этим идёт
 * блокировка 434. Поэтому воркер запускает обход с `EIS_RATE_PER_SEC=1.5`. Нечисло,
 * ноль и отрицательное значение возвращают умолчание: опечатка не должна ни
 * остановить прогон (интервал бесконечность), ни снять ограничение. Потолок 5
 * держит «3» из ACCESS_EIS.md как эмпирически безопасное с запасом.
 */
export function resolveEisRatePerSec(raw: string | undefined, fallback = RATE_LIMIT_PER_SEC): number {
  const value = Number.parseFloat((raw ?? "").trim());
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, 5);
}

/**
 * Адаптер ТЭК-Торга конкретным классом.
 *
 * Привязка источника возвращает `TenderSourceAdapter` — интерфейс, в котором нет
 * `readDocumentList`, а загрузчику документации нужен именно он: список файлов
 * вместе с отметкой об отзыве. Фабрика вынесена сюда, чтобы параметры обращения
 * к площадке оставались в одном месте и скрипт не собирал адаптер сам.
 *
 * Ключа не требует: SOAP-экспорт процедур публичный, поэтому адаптер создаётся
 * всегда и платного бюджета не расходует.
 */
export function createTektorgAdapter(): TektorgTenderSourceAdapter {
  return new TektorgTenderSourceAdapter({
    rateLimitPerSec: RATE_LIMIT_PER_SEC,
    maxRetries: MAX_RETRIES,
    // Окно публикации (около 1700 процедур, 45 секунд) переживает пятнадцать минут
    // на диске: ручной запуск сразу после планового не скачивает его заново.
    // `SYNC_TEKTORG_WINDOW_CACHE_SEC=0` выключает.
    windowCache: {
      dir: cardCacheDir(),
      ttlMs: tektorgWindowCacheTtlMs(process.env["SYNC_TEKTORG_WINDOW_CACHE_SEC"]),
    },
  });
}

/**
 * Адаптер ЭТП ГПБ конкретным классом.
 *
 * Темп запросов у него не настраивается: площадка допускает не больше одного запроса в
 * секунду, и значение зашито в адаптере (`minIntervalMs` задают только тесты). Кэш карты
 * сайта и карточек лежит в том же каталоге, что и кэш карточек Росэлторга и Фабриканта
 * (`SYNC_CARD_CACHE_DIR` или `data/`); `SYNC_ETPGPB_CARD_TTL_HOURS=0` выключает повторное
 * использование карточек.
 */
export function createEtpgpbAdapter(): EtpgpbTenderSourceAdapter {
  return new EtpgpbTenderSourceAdapter({
    maxRetries: MAX_RETRIES,
    cacheDir: cardCacheDir(),
    cardTtlMs: etpgpbCardTtlMs(process.env["SYNC_ETPGPB_CARD_TTL_HOURS"]),
  });
}

/** `SYNC_ETPGPB_DISABLED=1` (или `true`) выключает источник целиком: привязка вернёт null. */
export function isEtpgpbDisabled(raw: string | undefined = process.env["SYNC_ETPGPB_DISABLED"]): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export const SOURCE_BINDINGS: readonly SourceBinding[] = [
  {
    source: "EIS",
    label: "ЕИС",
    probeUrl: "https://zakupki.gov.ru/",
    cadenceHours: null,
    // Фильтр по региону ЗАКАЗЧИКА есть: параметры customerPlace и
    // customerPlaceCodes с кодом региона по КЛАДР (проверено 05.10.2026: по
    // запросу «строительство» для Бурятии 365 закупок, 42 из 44 показанных —
    // бурятские). Раньше считалось, что фильтра нет, и регион у закупок ЕИС
    // оставался неизвестным (516 из 849 в базе). Адаптер просит регион у ЕИС и
    // проставляет его найденному; название, которое не опознано, ищется по всей
    // России. Регион поставки ЕИС в выдаче не печатает, поэтому это регион
    // заказчика.
    honoursRegions: true,
    async create() {
      return new EisTenderSourceAdapter({
        rateLimitPerSec: resolveEisRatePerSec(process.env["EIS_RATE_PER_SEC"]),
        maxRetries: MAX_RETRIES,
      });
    },
  },
  {
    source: "TEK_TORG",
    label: "ТЭК-Торг",
    // Публичная страница площадки: сам экспорт SOAP платным не является, но
    // тратить запрос на проверку связи незачем.
    probeUrl: "https://www.tektorg.ru/",
    cadenceHours: null,
    // В запросе SOAP-экспорта (`exportRequestType`) нет ни одного параметра
    // региона: только даты, секция, номера, ИНН, тип и постраничная раздача.
    // Регион приходит в ответе — юридическим адресом организатора и местом
    // поставки лота, — поэтому адаптер применяет фильтр из профиля на своей
    // стороне по каноническому наименованию. Закупки, у которых регион так и не
    // определился, отбрасываются и считаются отдельной причиной в `filterStats`:
    // прогон обязан напечатать их число, а не проглотить молча.
    honoursRegions: true,
    async create() {
      return createTektorgAdapter();
    },
  },
  {
    source: "SBER_AST",
    label: "Сбербанк-АСТ",
    probeUrl: "https://www.sberbank-ast.ru/",
    cadenceHours: null,
    // Площадка принимает регион в поисковом запросе и фильтрует выдачу на своей
    // стороне по подстроке в названии субъекта.
    honoursRegions: true,
    async create() {
      return new SberAstTenderSourceAdapter({
        rateLimitPerSec: RATE_LIMIT_PER_SEC,
        maxRetries: MAX_RETRIES,
      });
    },
  },
  {
    source: "ROSELTORG",
    label: "Росэлторг",
    // Публичный серверный поиск площадки не требует ни ключа, ни входа, но
    // тратить запрос на проверку связи незачем: достаточно главной страницы.
    probeUrl: "https://www.roseltorg.ru/",
    cadenceHours: null,
    // Форма поиска принимает только секции, статусы и `query_field`: параметра
    // региона в ней нет (проверено 02.10.2026). Регион заказчика площадка
    // печатает в строке выдачи — «34. Волгоградская область», — поэтому адаптер
    // применяет фильтр профиля на своей стороне по каноническому наименованию.
    // Закупки, у которых регион так и не определился (площадка печатает «99. Не
    // указан»), отбрасываются отдельной причиной в `filterStats`: «не определён»
    // не равно «другой регион», и прогон обязан показать их число.
    honoursRegions: true,
    async create() {
      return new RoseltorgTenderSourceAdapter({
        rateLimitPerSec: RATE_LIMIT_PER_SEC,
        maxRetries: MAX_RETRIES,
      });
    },
  },
  {
    source: "FABRIKANT",
    label: "Фабрикант",
    // Публичный поиск и карточки `/v2` не требуют ни ключа, ни входа, но тратить
    // запрос на проверку связи незачем: достаточно главной страницы.
    probeUrl: "https://www.fabrikant.ru/",
    cadenceHours: null,
    // В форме поиска региона нет: `customer_region_ids[]` фильтрует по региону
    // заказчика, а не по месту поставки, и закупка с поставкой в нужный субъект
    // исчезла бы без следа. Регион и адрес поставки печатает карточка, поэтому
    // адаптер применяет фильтр профиля на своей стороне по каноническому
    // наименованию. Закупки, у которых регион так и не определился, отбрасываются
    // отдельной причиной в `filterStats`: «не определён» не равно «другой регион».
    honoursRegions: true,
    async create() {
      return new FabrikantTenderSourceAdapter({
        rateLimitPerSec: RATE_LIMIT_PER_SEC,
        maxRetries: MAX_RETRIES,
      });
    },
  },
  {
    source: "ETP_GPB",
    label: "ЭТП ГПБ",
    // Единственный адрес площадки, который проверка связи вправе запросить без нарушения
    // `robots.txt`, — карта сайта: главная страница в разрешённый набор не входит (см.
    // `etpgpbUrl.ts`). Индекс карты весит около 3 КБ.
    probeUrl: "https://etpgpb.ru/sitemap.xml",
    cadenceHours: null,
    // Региона в карте сайта нет, а поиск запрещён `robots.txt`. Регион определяется по
    // карточке — адрес поставки лота, регионы лота, название, адрес заказчика — тем же
    // `regionFromAddresses`, что у ТЭК-Торга, поэтому адаптер отсеивает чужие субъекты сам
    // и считает их в `filterStats`. Закупки, у которых регион так и не определился,
    // отбрасываются отдельной причиной: «не определён» не равно «другой регион».
    honoursRegions: true,
    async create() {
      return isEtpgpbDisabled() ? null : createEtpgpbAdapter();
    },
  },
  {
    source: "KONTUR",
    label: "Контур.Закупки",
    probeUrl: "https://zakupki.kontur.ru/",
    // Настоящий интервал читает env (KONTUR_MIN_INTERVAL_HOURS) внутри
    // createKonturAdapter и decideKonturSync; число здесь — значение по
    // умолчанию, по которому тест отличает платный источник от бесплатного.
    cadenceHours: 6,
    // API принимает только UUID регионов из закрытого каталога (`RegionIds`), а
    // наименования субъектов — нет. Адаптер применяет фильтр к полученной выдаче
    // по каноническому наименованию и печатает число отсевов; закупки с
    // неизвестным регионом остаются: «не определён» не равно «другой».
    honoursRegions: true,
    async create() {
      return createKonturAdapter();
    },
  },
];

/** Привязка источника; null, если плановый прогон его не собирает. */
export function sourceBinding(source: TenderDataSource): SourceBinding | null {
  return SOURCE_BINDINGS.find((b) => b.source === source) ?? null;
}
