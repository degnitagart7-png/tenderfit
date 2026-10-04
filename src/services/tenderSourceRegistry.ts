import type { TenderDataSource } from "@/types/database";
import type { TenderSourceAdapter } from "@/adapters/types";
import { EisTenderSourceAdapter } from "@/adapters/tender-source/eisTenderSourceAdapter";
import { FabrikantTenderSourceAdapter } from "@/adapters/tender-source/fabrikantTenderSourceAdapter";
import { RoseltorgTenderSourceAdapter } from "@/adapters/tender-source/roseltorgTenderSourceAdapter";
import { SberAstTenderSourceAdapter } from "@/adapters/tender-source/sberAstTenderSourceAdapter";
import { TektorgTenderSourceAdapter } from "@/adapters/tender-source/tektorgTenderSourceAdapter";
import { createKonturAdapter } from "@/services/konturSyncService";

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
  });
}

export const SOURCE_BINDINGS: readonly SourceBinding[] = [
  {
    source: "EIS",
    label: "ЕИС",
    probeUrl: "https://zakupki.gov.ru/",
    cadenceHours: null,
    // Регионального фильтра в GET-выдаче нет (docs/ACCESS_EIS.md, раздел
    // «Регион»). Отсеять выдачу по полю region после загрузки тоже нельзя: в
    // карточке выдачи региона нет, и guessRegion для большинства закупок
    // возвращает «Не указан» — фильтр выбросил бы и нужные закупки.
    honoursRegions: false,
    async create() {
      return new EisTenderSourceAdapter({
        rateLimitPerSec: RATE_LIMIT_PER_SEC,
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
