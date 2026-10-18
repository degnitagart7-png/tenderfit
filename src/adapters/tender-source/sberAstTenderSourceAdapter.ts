/**
 * Адаптер источника данных «Сбербанк-АСТ» (коммерческие торги).
 *
 * Работает ТОЛЬКО на сервере (Node). Использует открытый поисковый эндпоинт
 * площадки POST https://www.sberbank-ast.ru/api/Processing/main, который
 * отдаёт JSON без авторизации и КЭП: реестр закупок и карточки публичны,
 * электронная подпись нужна только для подачи заявки.
 *
 * Ограничения и правила использования:
 *  - соблюдайте rate-limit (по умолчанию 2 запроса/сек);
 *  - площадка, как и ЕИС, блокирует зарубежные IP — запросы должны идти
 *    с российского сервера (сейчас — локальный скрипт синхронизации);
 *  - в выдаче смешаны завершённые, отменённые процедуры и «обоснование НМЦ»,
 *    поэтому по умолчанию остаются только закупки с идущим приёмом заявок;
 *  - формат ответа и названия полей могут измениться без предупреждения.
 */
import type { Tender, TenderDocument } from "@/domain/entities";
import { isPriceKnown } from "@/domain/entities";
import type { TenderSourceAdapter, TenderSourceQuery } from "@/adapters/types";
import {
  SBER_COMMERCIAL_SOURCE_TERM,
  buildSberFilterBody,
  buildSberRequestBody,
  mergeSberPurchases,
  mergeSberTenders,
  parseSberSearchPayload,
  sberBidKey,
} from "@/adapters/tender-source/sberAstParser";

const DEFAULT_BASE_URL = "https://www.sberbank-ast.ru";
const API_PATH = "/api/Processing/main";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SberAstAdapterOptions {
  baseUrl?: string;
  /** Секция площадки. По умолчанию — торги коммерческих заказчиков. */
  sourceTerm?: string;
  /** Ограничение запросов в секунду. */
  rateLimitPerSec?: number;
  /** Максимум повторов при сетевой ошибке или пустом ответе. */
  maxRetries?: number;
  /** На сколько дней назад смотреть публикации (активные закупки живут недолго). */
  lookbackDays?: number;
  /** Размер страницы выдачи. */
  pageSize?: number;
  /** Максимум страниц на один поисковый запрос. */
  maxPages?: number;
  /** Оставлять только закупки с идущим приёмом заявок. */
  activeOnly?: boolean;
  /** Источник текущего времени (для детерминированных тестов). */
  nowProvider?: () => Date;
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SberAstTenderSourceAdapter implements TenderSourceAdapter {
  private readonly baseUrl: string;
  private readonly sourceTerm: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly lookbackDays: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly activeOnly: boolean;
  private readonly nowProvider: () => Date;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(options: SberAstAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.sourceTerm = options.sourceTerm ?? SBER_COMMERCIAL_SOURCE_TERM;
    this.minIntervalMs = 1000 / (options.rateLimitPerSec ?? 2);
    this.maxRetries = options.maxRetries ?? 3;
    this.lookbackDays = options.lookbackDays ?? 90;
    this.pageSize = options.pageSize ?? 100;
    this.maxPages = options.maxPages ?? 3;
    this.activeOnly = options.activeOnly ?? true;
    this.nowProvider = options.nowProvider ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Простейший rate-limit: не чаще N запросов в секунду. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.lastRequestAt + this.minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /** POST-запрос к поисковому эндпоинту с повторами и экспоненциальной задержкой. */
  private async postSearch(filterBody: string): Promise<string> {
    const url = `${this.baseUrl}${API_PATH}`;
    const body = JSON.stringify(buildSberRequestBody(filterBody));
    let attempt = 0;
    for (;;) {
      await this.throttle();
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "Accept-Language": "ru-RU,ru;q=0.9",
        },
        body,
      });
      const text = await res.text();
      // Пустой ответ или HTML вместо JSON — повод повторить запрос.
      if (res.ok && text.trim().startsWith("{")) return text;
      attempt += 1;
      if (attempt > this.maxRetries) {
        if (!res.ok) {
          throw new Error(`Сбербанк-АСТ ответила HTTP ${res.status} для ${url}`);
        }
        return text;
      }
      await sleep(300 * 2 ** attempt);
    }
  }

  /** Фильтры, которые площадка не поддерживает в запросе, применяем локально. */
  private applyLocalFilters(tenders: Tender[], query: TenderSourceQuery): Tender[] {
    const regions = (query.regions ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean);
    const customerInns = (query.customerInns ?? []).map((i) => i.trim()).filter(Boolean);
    return tenders.filter((t) => {
      // Цена 0 означает «не указана»: коммерческие заказчики часто не публикуют
      // бюджет (запрос предложений/цен), поэтому такие закупки не отсеиваем.
      const priceKnown = isPriceKnown(t.financial.price);
      if (priceKnown && query.minPrice != null && t.financial.price < query.minPrice) {
        return false;
      }
      if (priceKnown && query.maxPrice != null && t.financial.price > query.maxPrice) {
        return false;
      }
      if (regions.length > 0) {
        const region = t.region.toLowerCase();
        if (!regions.some((r) => region.includes(r))) return false;
      }
      if (customerInns.length > 0) {
        if (!t.customerInn || !customerInns.includes(t.customerInn)) return false;
      }
      return true;
    });
  }

  async fetchTenders(query: TenderSourceQuery): Promise<Tender[]> {
    const keyword = (query.keywords ?? []).join(" ").trim();
    const limit = query.limit ?? 50;
    const now = this.nowProvider();
    const dateFrom = new Date(now.getTime() - this.lookbackDays * DAY_MS);

    /** Закупки (лоты склеены) по коду закупки. */
    const merged = new Map<string, Tender>();
    /** Номера лотов, которые уже обработаны, — выдача может их повторять. */
    const seenBids = new Set<string>();

    for (let page = 0; page < this.maxPages; page += 1) {
      const filterBody = buildSberFilterBody({
        keyword: keyword || undefined,
        sourceTerm: this.sourceTerm,
        page,
        pageSize: this.pageSize,
        dateFrom,
        dateTo: now,
      });
      const text = await this.postSearch(filterBody);
      const { tenders, returned, total } = parseSberSearchPayload(text, {
        activeOnly: this.activeOnly,
        now,
      });

      for (const tender of tenders) {
        const bidKey = sberBidKey(tender);
        if (seenBids.has(bidKey)) continue;
        seenBids.add(bidKey);
        const existing = merged.get(tender.regNumber);
        merged.set(
          tender.regNumber,
          existing ? mergeSberTenders(existing, tender) : tender,
        );
      }

      // Лимит считается после локальных фильтров: регион и цену площадка в
      // запросе не принимает, и сто лотов первой страницы — это вся страна.
      // Остановка по `merged.size` отдавала региональному профилю совпадения
      // только из первой страницы, а остальные страницы не запрашивались.
      if (this.applyLocalFilters([...merged.values()], query).length >= limit) break;
      // Страниц больше нет: выдача короче размера страницы или исчерпан Total.
      if (returned < this.pageSize) break;
      if ((page + 1) * this.pageSize >= total) break;
    }

    return this.applyLocalFilters([...merged.values()], query).slice(0, limit);
  }

  async fetchTenderById(regNumber: string): Promise<Tender | null> {
    const withPrefix = regNumber.startsWith("sber-") ? regNumber.slice(5) : regNumber;
    // Искать можно как по коду закупки, так и по номеру лота («…-1.4»).
    const base = withPrefix.replace(/\.\d+$/, "");
    const now = this.nowProvider();
    const filterBody = buildSberFilterBody({
      keyword: base,
      sourceTerm: this.sourceTerm,
      page: 0,
      pageSize: this.pageSize,
      dateFrom: new Date(now.getTime() - 365 * DAY_MS),
      dateTo: now,
    });
    const text = await this.postSearch(filterBody);
    const { tenders } = parseSberSearchPayload(text, { activeOnly: false });
    const purchases = mergeSberPurchases(tenders);
    return purchases.find((t) => t.regNumber === base) ?? null;
  }

  /**
   * Документов нет, и это ответ, а не заглушка.
   *
   * Файлы закупки Сбербанк-АСТ лежат в карточке площадки за входом по КЭП, а
   * поисковый API отдаёт только метаданные лота. Соблазн вернуть ссылку на
   * карточку как документ с `type: "NOTICE"` здесь уже был — и это ложь в самом
   * дорогом месте: разъём обещает документы, потребитель их скачивает и
   * разбирает, и вместо текста закупки в платный разбор уезжает навигация
   * площадки. Находки из такой страницы выглядят правдоподобно и не проверяемы.
   *
   * Причина не возвращается: в разъёме `fetchDocuments` для неё нет канала, а
   * придумывать второй источник правды рядом с `deepAnalysisBlocker`
   * (domain/deepAnalysis.ts) и `documentationUnavailableReason`
   * (services/tenderDocumentsFetcher.ts) значит получить три текста об одном.
   * Показывает причину тот, кто её уже знает — карточка закупки.
   *
   * Запрос к площадке тоже не делается: раньше метод звал `fetchTenderById`,
   * чтобы достать ссылку на карточку, и тратил на это поисковый запрос.
   */
  async fetchDocuments(_tenderId: string): Promise<TenderDocument[]> {
    return [];
  }

  async checkChanges(tenderId: string, since: string): Promise<boolean> {
    const tender = await this.fetchTenderById(tenderId);
    if (!tender) return false;
    const updated = new Date(tender.deadlines.lastUpdateDate).getTime();
    if (Number.isNaN(updated)) return false;
    return updated > new Date(since).getTime();
  }
}
