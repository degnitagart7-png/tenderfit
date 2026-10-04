import * as cheerio from "cheerio";
import type { Tender, TenderDocument } from "@/domain/entities";
import { UNKNOWN_REGION } from "@/domain/entities";
import type {
  TenderSourceAdapter,
  TenderSourceQuery,
} from "@/adapters/types";
import {
  buildEisSearchUrl,
  parseCustomerRefsFromOrgSearch,
  parseInnFromHref,
  parseLaw,
  parsePlacingWay,
  parsePrice,
  parseRuDate,
} from "@/adapters/tender-source/eisParser";
import type { EisCustomerRef } from "@/adapters/tender-source/eisParser";
import { buildEisUrl } from "@/domain/enums";

/**
 * Реальный адаптер источника данных ЕИС (zakupki.gov.ru).
 *
 * Работает ТОЛЬКО на сервере (Node). Использует обычную выдачу HTML,
 * которая рендерится серверно и доступна без ЭЦП и авторизации.
 *
 * Важные ограничения (задокументированы в ACCESS_EIS.md):
 *  - соблюдайте rate-limit ~3 запроса/сек;
 *  - возможны пустые ответы из-за кэша Varnish — нужен retry с backoff;
 *  - вёрстка ЕИС меняется без предупреждения (в футере видна версия сборки);
 *  - юридически парсинг — «серая зона», для продакшена рассмотрите
 *    официальный SOAP-API (int44.zakupki.gov.ru, требует ЭЦП) или
 *    коммерческий API-провайдер.
 */

const DEFAULT_BASE_URL = "https://zakupki.gov.ru";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export interface EisAdapterOptions {
  baseUrl?: string;
  /** Ограничение запросов в секунду (эмпирически безопасно ~3). */
  rateLimitPerSec?: number;
  /** Максимум повторов при пустом ответе. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class EisTenderSourceAdapter implements TenderSourceAdapter {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;

  constructor(options: EisAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.minIntervalMs = 1000 / (options.rateLimitPerSec ?? 3);
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Простейший rate-limit: не чаще N запросов в секунду. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.lastRequestAt + this.minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /**
   * Запрос HTML с ретраями. `marker` — признак полноценного ответа:
   * пустой/усечённый ответ из кэша Varnish не содержит его, и запрос
   * повторяется с backoff. Для страниц без маркеров выдачи передайте null.
   */
  private async getHtml(
    url: string,
    marker: string | null = "search-registry-entry-block",
  ): Promise<string> {
    let attempt = 0;
    for (;;) {
      await this.throttle();
      const res = await this.fetchImpl(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "ru-RU,ru;q=0.9",
        },
      });
      const html = await res.text();
      // Пустой/усечённый ответ из кэша Varnish — повторяем с backoff.
      const truncated = marker !== null && !html.includes(marker);
      if (res.ok && !truncated) {
        return html;
      }
      attempt += 1;
      if (attempt > this.maxRetries) {
        if (!res.ok) {
          throw new Error(`ЕИС ответила HTTP ${res.status} для ${url}`);
        }
        return html;
      }
      await sleep(300 * 2 ** attempt);
    }
  }

  /** Кэш «ИНН → составной идентификатор заказчика» на время жизни адаптера. */
  private readonly customerCache = new Map<string, EisCustomerRef | null>();

  /**
   * Поиск карточки заказчика в ЕИС по ИНН и извлечение готового значения
   * параметра customerIdOrg — единственного способа сузить выдачу до одного
   * заказчика (фильтры площадок и наименования в GET-выдаче игнорируются).
   */
  async resolveCustomer(inn: string): Promise<EisCustomerRef | null> {
    const key = inn.trim();
    if (!key) return null;
    if (this.customerCache.has(key)) return this.customerCache.get(key) ?? null;
    const url = `${this.baseUrl}/epz/organization/search/results.html?searchString=${encodeURIComponent(key)}`;
    let refs: EisCustomerRef[] = [];
    try {
      const html = await this.getHtml(url, null);
      refs = parseCustomerRefsFromOrgSearch(html);
    } catch {
      // Заказчик не найден или ЕИС недоступна — поиск без сужения по нему.
      refs = [];
    }
    const ref = refs.find((r) => r.inn === key) ?? null;
    this.customerCache.set(key, ref);
    return ref;
  }

  async fetchTenders(query: TenderSourceQuery): Promise<Tender[]> {
    const searchString = (query.keywords ?? []).join(" ");
    const limit = query.limit ?? Number.POSITIVE_INFINITY;
    const customerInns = (query.customerInns ?? [])
      .map((inn) => inn.trim())
      .filter(Boolean);

    // Режим «по заказчику»: отдельный запрос на каждый ИНН, результаты
    // объединяются с дедупликацией по номеру извещения.
    if (customerInns.length > 0) {
      const merged: Tender[] = [];
      const seen = new Set<string>();
      for (const inn of customerInns) {
        const ref = await this.resolveCustomer(inn);
        if (!ref) continue;
        const url = buildEisSearchUrl({
          baseUrl: this.baseUrl,
          searchString: searchString || undefined,
          laws: query.laws,
          minPrice: query.minPrice,
          maxPrice: query.maxPrice,
          okpd2: query.okpd2Codes,
          customerIdOrg: ref.customerIdOrg,
          offset: 0,
        });
        const html = await this.getHtml(url);
        for (const tender of this.parseResults(html)) {
          if (seen.has(tender.regNumber)) continue;
          seen.add(tender.regNumber);
          merged.push({ ...tender, customerInn: tender.customerInn ?? inn });
        }
        if (merged.length >= limit) break;
      }
      return merged.slice(0, limit);
    }

    const url = buildEisSearchUrl({
      baseUrl: this.baseUrl,
      searchString: searchString || undefined,
      laws: query.laws,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      okpd2: query.okpd2Codes,
      offset: 0,
    });
    const html = await this.getHtml(url);
    const tenders = this.parseResults(html);
    return tenders.slice(0, limit);
  }

  async fetchTenderById(regNumber: string): Promise<Tender | null> {
    const url = `${this.baseUrl}/epz/order/extendedsearch/results.html?searchString=${encodeURIComponent(regNumber)}`;
    const html = await this.getHtml(url);
    const found = this.parseResults(html).find((t) => t.regNumber === regNumber);
    return found ?? null;
  }

  async fetchDocuments(tenderId: string): Promise<TenderDocument[]> {
    // В реальной интеграции здесь — загрузка печатной формы и вложений.
    // Для прототипа возвращаем ссылку на печатную форму извещения.
    return [
      {
        id: `${tenderId}-notice`,
        type: "NOTICE",
        title: "Извещение о закупке (печатная форма)",
        fileName: "printForm.html",
        url: `${this.baseUrl}/epz/order/notice/printForm/view.html?regNumber=${tenderId}`,
        text: "",
        pageCount: null,
        lastModified: null,
      },
    ];
  }

  async checkChanges(tenderId: string, since: string): Promise<boolean> {
    const tender = await this.fetchTenderById(tenderId);
    if (!tender) return false;
    return new Date(tender.deadlines.lastUpdateDate) > new Date(since);
  }

  /** Разбор HTML-выдачи в массив Tender. */
  parseResults(html: string): Tender[] {
    const $ = cheerio.load(html);
    const tenders: Tender[] = [];

    $(".search-registry-entry-block").each((_, el) => {
      const card = $(el);

      const headerTop = card
        .find(".registry-entry__header-top__title")
        .first()
        .text()
        .trim();
      const law = parseLaw(headerTop);
      const placingWay = parsePlacingWay(headerTop);

      const numberLink = card.find(".registry-entry__header-mid__number a").first();
      const regNumber = numberLink.text().replace(/[^\d]/g, "");
      const cardHref = numberLink.attr("href") ?? "";

      // Этап/статус закупки — в заголовке карточки.
      const stage = card
        .find(".registry-entry__header-mid__title")
        .first()
        .text()
        .trim();

      // Предмет и заказчик — в body-блоках с соответствующими заголовками.
      // Текст значения может быть разбит span-подсветкой совпадений,
      // поэтому берём .text() всего значения.
      let subject = "";
      let customerName = "";
      let customerHref = "";
      card.find(".registry-entry__body-block").each((__, blk) => {
        const block = $(blk);
        const title = block.find(".registry-entry__body-title").first().text().trim().toLowerCase();
        if (title.includes("объект")) {
          const value = block.find(".registry-entry__body-value").first();
          subject = value.text().replace(/\s+/g, " ").trim();
        } else if (title.includes("заказчик") || title.includes("организация")) {
          // Заказчик может быть в .registry-entry__body-value (старая вёрстка)
          // или в .registry-entry__body-href > a (новая вёрстка).
          const hrefBlock = block.find(".registry-entry__body-href").first();
          if (hrefBlock.length) {
            const link = hrefBlock.find("a").first();
            customerName = link.text().replace(/\s+/g, " ").trim();
            customerHref = link.attr("href") ?? "";
          } else {
            const value = block.find(".registry-entry__body-value").first();
            customerName = value.text().replace(/\s+/g, " ").trim();
            customerHref = value.find("a").first().attr("href") ?? "";
          }
        }
      });
      const customerInn = parseInnFromHref(customerHref);

      const price = parsePrice(card.find(".price-block__value").first().text());

      // Даты из data-блоков (Размещено / Обновлено / Окончание подачи заявок).
      // В текущей вёрстке внутри одного .data-block может быть несколько
      // пар .data-block__title / .data-block__value (в .col-6).
      const dates: Record<string, string> = {};
      card.find(".data-block").each((__, blk) => {
        $(blk).find(".data-block__title").each((___, titleEl) => {
          const title = $(titleEl).text().trim().toLowerCase();
          const value = $(titleEl).next(".data-block__value").text().trim();
          if (title && value) dates[title] = value;
        });
      });
      const published = parseRuDate(dates["размещено"] ?? "") ?? new Date().toISOString();
      const updated = parseRuDate(dates["обновлено"] ?? "") ?? published;
      const submissionEnd =
        parseRuDate(dates["окончание подачи заявок"] ?? "") ?? updated;

      // Регион определяем грубо из адреса/заказчика; точный — в карточке закупки.
      if (!subject) subject = stage;
      const region = this.guessRegion(`${customerName} ${subject}`);

      if (!regNumber || !subject) return;

      const eisUrl = cardHref.startsWith("/")
        ? `${this.baseUrl}${cardHref}`
        : buildEisUrl(law, regNumber, placingWay);

      tenders.push({
        id: `eis-${regNumber}`,
        regNumber,
        externalId: regNumber,
        law,
        placingWay,
        subject,
        customerName,
        customerInn,
        region,
        deliveryAddress: region,
        financial: {
          price: price ?? 0,
          currency: "RUB",
          advancePercent: null,
          advanceAmount: null,
          paymentTermDays: 0,
          postpaymentDays: null,
          bidSecurityAmount: null,
          bidSecurityPercent: null,
          contractSecurityAmount: null,
          contractSecurityPercent: null,
          treasurySupport: false,
          expectedMarginPercent: null,
        },
        deadlines: {
          submissionEnd,
          publicationDate: published,
          lastUpdateDate: updated,
          deliveryTermDays: null,
          warrantyMonths: null,
        },
        okpd2Codes: [],
        lots: [],
        requirements: [],
        documents: [],
        nationalRegime: false,
        onlyForSmp: headerTop.toLowerCase().includes("мал") ,
        eisUrl,
        dataSource: "EIS",
        changeLog: [],
      });
    });

    return tenders;
  }

  /** Эвристика определения региона по тексту (для ленты; точно — в карточке). */
  private guessRegion(text: string): string {
    const regions = [
      "Москва",
      "Московская область",
      "Санкт-Петербург",
      "Приморский край",
      "Свердловская область",
      "Новосибирская область",
      "Хабаровский край",
      "Красноярский край",
      "Сахалинская область",
      "Камчатский край",
    ];
    const lower = text.toLowerCase();
    for (const r of regions) {
      if (lower.includes(r.toLowerCase())) return r;
    }
    return UNKNOWN_REGION;
  }
}
