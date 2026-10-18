/**
 * Фикстуры ЭТП ГПБ для тестов: карта сайта в настоящем формате, оболочка страницы Nuxt и
 * заглушка fetch.
 *
 * Карточки — в `etpgpbCardFixtures.ts` (компактные, очищенные от контактов). Карта сайта
 * здесь собрана руками по настоящему формату (снят 19.10.2026): адреса и slug взяты из
 * живого куска карты (`price_request/1010438-naushniki-i-kolonki-dlya-kompyuterov`,
 * `sale/1172045-zapros-predlozheniy-na-nelikvidy-spisok-2-s-ao-imz` и другие), а даты
 * подобраны так, чтобы при «сейчас» = `ETPGPB_NOW` в окно просмотра в 21 день попадали
 * одни записи и не попадали другие.
 */
import { vi } from "vitest";
import {
  ETPGPB_CARD_COMMERCE,
  ETPGPB_CARD_ETP_CLICK,
  ETPGPB_CARD_ETP_EIS11,
  ETPGPB_CARD_ETP_PRICE_UNKNOWN,
  ETPGPB_CARD_GAZ_EIS_URL,
  ETPGPB_CARD_SALE,
} from "@/adapters/tender-source/etpgpbCardFixtures";

/** «Сейчас» для детерминированных тестов: 19.10.2026 12:00 по Москве. */
export const ETPGPB_NOW = Date.parse("2026-10-19T09:00:00.000Z");

/** Страница карточки в оболочке, похожей на живую: данные Nuxt в `<script id="__NUXT_DATA__">`. */
export function nuxtPage(table: readonly unknown[]): string {
  return (
    '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Закупка</title></head><body>' +
    '<div id="__nuxt"><main>Карточка процедуры</main></div>' +
    '<script>window.__NUXT__={};window.__NUXT__.config={public:{}}</script>' +
    '<script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">' +
    JSON.stringify(table) +
    "</script></body></html>"
  );
}

/* ============================== карта сайта ============================== */

export const SITEMAP_INDEX_URL = "https://etpgpb.ru/sitemap.xml";
export const PROCEDURES_SITEMAP_URL = "https://etpgpb.ru/sitemap/procedures.xml";
export const chunkUrl = (n: number): string => `https://etpgpb.ru/sitemap/procedures/procedures${String(n)}.xml`;

/** Индекс карт сайта: настоящий `<sitemapindex>`, урезанный до пяти карт. */
export const SITEMAP_INDEX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
    xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
    http://www.sitemaps.org/schemas/sitemap/0.9/siteindex.xsd">
  <sitemap>
    <loc>https://etpgpb.ru/sitemap/pages.xml</loc>
    <lastmod>2026-10-18</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://etpgpb.ru/sitemap/procedures.xml</loc>
    <lastmod>2026-10-18T03:45:13.415+03:00</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://etpgpb.ru/sitemap/lots.xml</loc>
    <lastmod>2026-10-17T08:00:00.851+03:00</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://etpgpb.ru/sitemap/customers.xml</loc>
    <lastmod>2026-10-18T03:45:14.146+03:00</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://etpgpb.ru/sitemap/products.xml</loc>
    <lastmod>2026-10-18T02:09:52.885+03:00</lastmod>
  </sitemap>
</sitemapindex>
`;

/** Одна запись в формате карты сайта. */
export interface SitemapRow {
  readonly url: string;
  readonly lastmod: string;
}

/** `<urlset>` из записей — формат `sitemap/procedures.xml` и кусков карты. */
export function urlset(rows: readonly SitemapRow[]): string {
  const body = rows
    .map((row) => `<url>\n    <loc>${row.url}</loc>\n    <lastmod>${row.lastmod}</lastmod>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/**
 * Список кусков карты процедур. Куски 1–3 — старые (даты 2023–2024, как у живого),
 * 58 — вне окна просмотра (дата подставлена: у живого она свежая), 59 и 60 — свежие.
 */
export const PROCEDURES_SITEMAP_XML = urlset([
  { url: chunkUrl(1), lastmod: "2023-12-25T14:44:05.778+03:00" },
  { url: chunkUrl(2), lastmod: "2023-12-25T14:44:06.015+03:00" },
  { url: chunkUrl(3), lastmod: "2024-09-19T17:45:42.576+03:00" },
  { url: chunkUrl(58), lastmod: "2026-09-01T09:31:47.797+03:00" },
  { url: chunkUrl(59), lastmod: "2026-10-17T13:30:02.212+03:00" },
  { url: chunkUrl(60), lastmod: "2026-10-18T03:45:13.415+03:00" },
]);

const card = (fixture: { url: string }, lastmod: string): SitemapRow => ({ url: fixture.url, lastmod });

/** Записи, которых нет среди карточек-фикстур: на них адаптер не должен тратить запрос. */
export const FILLER_NAUSHNIKI: SitemapRow = {
  url: "https://etpgpb.ru/procedures/price_request/1010438-naushniki-i-kolonki-dlya-kompyuterov/",
  lastmod: "2026-10-15T09:00:35.971+03:00",
};
export const FILLER_STROITELSTVO: SitemapRow = {
  url: "https://etpgpb.ru/procedures/etp/1288977-vypolnenie-rabot-po-razrabotke-pd-i-stroitelstvu-navesa-na-territorii-vip-terminala/",
  lastmod: "2026-10-16T08:00:00.000+03:00",
};
/** Вне окна просмотра: 22.09.2026 при «сейчас» 19.10.2026 старше 21 дня. */
export const FILLER_OLD: SitemapRow = {
  url: "https://etpgpb.ru/procedures/etp/1288952-postavka-goryuche-smazochnyh-materialov-v-4-kvartale-2026-goda/",
  lastmod: "2026-09-22T07:00:02.916+03:00",
};
export const FILLER_SALE: SitemapRow = {
  url: "https://etpgpb.ru/procedures/sale/1172045-zapros-predlozheniy-na-nelikvidy-spisok-2-s-ao-imz/",
  lastmod: "2026-10-12T15:00:03.670+03:00",
};

/** Даты процедур в карте: определяют порядок «самые свежие первыми». */
export const LASTMOD = {
  /** 17.10 19:23 МСК — самая свежая. */
  etpClick: "2026-10-17T19:23:18.000+03:00",
  /** 17.10 18:32 МСК. */
  etpEis11: "2026-10-17T18:32:03.000+03:00",
  /** 17.10 15:28 МСК. */
  etpPriceUnknown: "2026-10-17T15:28:00.000+03:00",
  /** 16.10 17:12 МСК. */
  gaz: "2026-10-16T17:12:03.000+03:00",
  /** 07.10 — ещё в окне (12 дней). */
  commerce: "2026-10-07T13:41:19.000+03:00",
  sale: "2026-10-12T14:29:00.000+03:00",
} as const;

export const CHUNK_59_XML = urlset([
  card(ETPGPB_CARD_COMMERCE, LASTMOD.commerce),
  card(ETPGPB_CARD_GAZ_EIS_URL, LASTMOD.gaz),
  card(ETPGPB_CARD_SALE, LASTMOD.sale),
  FILLER_OLD,
]);

export const CHUNK_60_XML = urlset([
  card(ETPGPB_CARD_ETP_EIS11, LASTMOD.etpEis11),
  card(ETPGPB_CARD_ETP_PRICE_UNKNOWN, LASTMOD.etpPriceUnknown),
  card(ETPGPB_CARD_ETP_CLICK, LASTMOD.etpClick),
  FILLER_NAUSHNIKI,
  FILLER_STROITELSTVO,
  FILLER_SALE,
]);

/* ============================== заглушка fetch ============================== */

/** Ответ заглушки: тело страницы (200), HTTP-код, редирект или ошибка сети. */
export type StubReply =
  | string
  | number
  | Error
  | { status: number; headers?: Record<string, string>; body?: string };

export interface StubCall {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Заглушка `fetch` по таблице «адрес → ответ». Неизвестный адрес — HTTP 404. Каждый
 * вызов записывается: тесты проверяют, ЧТО запрашивалось, а не только что вернулось.
 */
export function stubFetch(routes: Readonly<Record<string, StubReply | (() => StubReply)>>) {
  const calls: StubCall[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const route = routes[url];
    const reply: StubReply = typeof route === "function" ? route() : (route ?? 404);
    if (reply instanceof Error) throw reply;
    if (typeof reply === "number") return new Response("", { status: reply });
    if (typeof reply === "string") return new Response(reply, { status: 200 });
    return new Response(reply.body ?? "", { status: reply.status, headers: reply.headers });
  });
  return {
    impl: impl as unknown as typeof fetch,
    calls,
    /** Адреса запросов по порядку. */
    urls: (): string[] => calls.map((call) => call.url),
  };
}

/** Маршруты «обычного дня»: карта сайта и все карточки-фикстуры, кроме продажи. */
export function standardRoutes(): Record<string, StubReply> {
  return {
    [SITEMAP_INDEX_URL]: SITEMAP_INDEX_XML,
    [PROCEDURES_SITEMAP_URL]: PROCEDURES_SITEMAP_XML,
    [chunkUrl(59)]: CHUNK_59_XML,
    [chunkUrl(60)]: CHUNK_60_XML,
    [ETPGPB_CARD_ETP_EIS11.url]: nuxtPage(ETPGPB_CARD_ETP_EIS11.table),
    [ETPGPB_CARD_ETP_PRICE_UNKNOWN.url]: nuxtPage(ETPGPB_CARD_ETP_PRICE_UNKNOWN.table),
    [ETPGPB_CARD_COMMERCE.url]: nuxtPage(ETPGPB_CARD_COMMERCE.table),
    [ETPGPB_CARD_ETP_CLICK.url]: nuxtPage(ETPGPB_CARD_ETP_CLICK.table),
    [ETPGPB_CARD_GAZ_EIS_URL.url]: nuxtPage(ETPGPB_CARD_GAZ_EIS_URL.table),
  };
}

/* ============================== вымышленные контакты ============================== */

type Entry = Record<string, number>;

const isEntry = (value: unknown): value is Entry =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Вымышленные контакты для проверки «в запись и в закупку контакты не просачиваются».
 *
 * В закоммиченных фикстурах контактов нет вовсе (см. `etpgpbCardFixtures.ts`), поэтому тест
 * дописывает их в копию таблицы сам. Значения заведомо ненастоящие: `SYNTH-…` и адреса
 * в зоне `.invalid`. Ключ `unknown_future_field` — поле, которого адаптер не знает:
 * белый список не должен его пропустить.
 */
export const SYNTHETIC_CONTACT_ATTRIBUTES = {
  contact_person: "SYNTH-Контактное-Лицо",
  contact_email: "synth.contact@example.invalid",
  contact_phone: "+7 000 000-00-00",
  customer_contact: "SYNTH-Контакт-Заказчика",
  customer_email: "synth.customer@example.invalid",
  customer_phone: "+7 000 111-11-11",
  body_email: "SYNTH-Текст-Письма synth.body@example.invalid",
  title_email: "SYNTH-Тема-Письма",
  unknown_future_field: "SYNTH-Неизвестное-Поле",
} as const;

/** То, что не должно встретиться ни в записи карточки, ни в закупке. */
export const SYNTHETIC_CONTACT_PATTERN = /SYNTH|example\.invalid|\+7 000|70000000000/;

/**
 * Копия таблицы devalue с вымышленными контактами: в атрибутах процедуры и в
 * `relationships.contacts` процедуры и каждого заказчика лота.
 */
export function withSyntheticContacts(source: readonly unknown[]): unknown[] {
  const table = JSON.parse(JSON.stringify(source)) as unknown[];
  const push = (value: unknown): number => {
    table.push(value);
    return table.length - 1;
  };
  const attrs = table.find((e) => isEntry(e) && "registry_number" in e && "platform_id" in e && "stage" in e) as Entry;
  for (const [key, value] of Object.entries(SYNTHETIC_CONTACT_ATTRIBUTES)) attrs[key] = push(value);

  const contacts = (): number =>
    push({
      data: push([
        push({
          id: push("1452289"),
          type: push("contact"),
          attributes: push({
            email: push("synth.rel@example.invalid"),
            phone: push("70000000000"),
            contact: push("SYNTH-Контакт-Из-Связи"),
          }),
        }),
      ]),
    });
  for (const entry of table) {
    if (isEntry(entry) && "contacts" in entry && ("similar_procedures" in entry || "company" in entry)) {
      entry["contacts"] = contacts();
    }
  }
  return table;
}
