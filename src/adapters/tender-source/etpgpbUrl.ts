/**
 * Что адаптеру ЭТП ГПБ разрешено запрашивать.
 *
 * Проект уважает `robots.txt` и не обходит защиту площадок. Живой `robots.txt`
 * хоста `etpgpb.ru` (снят 19.10.2026) для `User-agent: *` запрещает:
 *   - `Disallow: /*?` — ЛЮБОЙ адрес с query-строкой;
 *   - `Disallow: /procedures/page` — постраничные списки процедур;
 *   - `Disallow: /uploads/`, `/etpgpb/`, `/partners`, файлы pdf/doc/docx/xls/xlsx/csv;
 * и указывает `Sitemap: https://etpgpb.ru/sitemap.xml`. Хосты `etp.gpb.ru` и
 * `com.etpgpb.ru` закрыты целиком (`Disallow: /`).
 *
 * Отсюда набор адресов, которые адаптер вправе запросить, ровно четыре вида:
 *   1. `https://etpgpb.ru/sitemap.xml` — индекс карт сайта;
 *   2. `https://etpgpb.ru/sitemap/procedures.xml` — список кусков карты процедур;
 *   3. `https://etpgpb.ru/sitemap/procedures/procedures<N>.xml` — сами куски;
 *   4. `https://etpgpb.ru/procedures/<вид>/<id>-<slug>/` — карточка процедуры.
 * Внутренний JSON API (`/api/v2/procedures/?…`) не используется: он требует
 * query-строки, а это запрещено первой же строкой `robots.txt`.
 *
 * Проверка вынесена в отдельный модуль и не зависит от остального адаптера: любой
 * запрос проходит через `assertEtpgpbUrlAllowed`, поэтому ошибка в другом месте
 * (склейка адреса из чужого ответа, редирект, опечатка в пути) упирается в
 * исключение, а не в чужой сервер.
 */

/** Единственный хост, на который адаптер ходит. */
export const ETPGPB_HOST = "etpgpb.ru";
/** Корень адресов площадки. */
export const ETPGPB_ORIGIN = `https://${ETPGPB_HOST}`;
/** Индекс карт сайта (указан в `robots.txt` строкой `Sitemap:`). */
export const ETPGPB_SITEMAP_INDEX_URL = `${ETPGPB_ORIGIN}/sitemap.xml`;

const SITEMAP_INDEX_PATH = /^\/sitemap\.xml$/;
const SITEMAP_PROCEDURES_PATH = /^\/sitemap\/procedures\.xml$/;
const SITEMAP_CHUNK_PATH = /^\/sitemap\/procedures\/procedures(\d+)\.xml$/;
/**
 * Путь карточки: `/procedures/<вид>/<id>-<slug>/`.
 *
 * Вид — латиница и подчёркивание (`price_request`, `etp_click`), id — цифры,
 * slug — транслит названия. Слеш в конце обязателен: так пишет карта сайта.
 */
const CARD_PATH = /^\/procedures\/([a-z][a-z0-9_]*)\/(\d+)-([a-z0-9-]+)\/$/;

/** Вид адреса, который разрешён. */
export type EtpgpbUrlKind = "sitemap-index" | "sitemap-procedures" | "sitemap-chunk" | "card";

/** Разобранный адрес карточки процедуры. */
export interface EtpgpbCardUrl {
  readonly url: string;
  /** Вид процедуры в пути: `price_request`, `etp`, `gaz`, `etp_click`, `commerce`, `sale`. */
  readonly kind: string;
  /** Номер процедуры на площадке (цифры из пути; не `registry_number` из карточки). */
  readonly id: string;
  readonly slug: string;
  /** Путь вида `/procedures/etp/123-slug/`. */
  readonly path: string;
}

/**
 * Что это за адрес, если он разрешён; иначе null.
 *
 * Адрес должен быть точно таким: схема `https`, хост ровно `etpgpb.ru` (ни поддомена,
 * ни порта, ни логина), БЕЗ query-строки и фрагмента, а путь — одним из четырёх видов
 * выше. Всё остальное, включая `/procedures/page…` (запрещено `robots.txt`) и
 * `/api/…`, — null.
 */
export function etpgpbUrlKind(url: string): EtpgpbUrlKind | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 2000) return null;
  // Query-строку и фрагмент ищем в сыром тексте, а не в разобранном адресе: пустое
  // `?` в конце разбор молча отбрасывает, а `robots.txt` запрещает и его.
  if (url.includes("?") || url.includes("#")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== ETPGPB_HOST) return null;
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;

  const path = parsed.pathname;
  // Закрытый префикс `robots.txt`: правило `Disallow: /procedures/page` действует по
  // началу пути, поэтому отсекается всё, что с него начинается, включая «pageXYZ».
  if (path.startsWith("/procedures/page")) return null;
  // Адрес обязан быть записан так, как его разобрал URL: без процентного кодирования
  // и `..` — иначе проверенный путь мог бы отличаться от отправленного.
  if (url !== `${ETPGPB_ORIGIN}${path}`) return null;

  if (SITEMAP_INDEX_PATH.test(path)) return "sitemap-index";
  if (SITEMAP_PROCEDURES_PATH.test(path)) return "sitemap-procedures";
  if (SITEMAP_CHUNK_PATH.test(path)) return "sitemap-chunk";
  if (CARD_PATH.test(path)) return "card";
  return null;
}

/** Можно ли запрашивать этот адрес. Только проверка: исключений не бросает. */
export function isEtpgpbUrlAllowed(url: string): boolean {
  return etpgpbUrlKind(url) !== null;
}

/** Адрес запрещён правилами адаптера. */
export class EtpgpbUrlNotAllowedError extends Error {
  constructor(readonly url: string) {
    super(
      `ЭТП ГПБ: адрес не разрешён политикой robots.txt, запрос не выполнен: ${url.slice(0, 200)}`,
    );
    this.name = "EtpgpbUrlNotAllowedError";
  }
}

/** Бросает `EtpgpbUrlNotAllowedError`, если адрес не из разрешённого набора; иначе возвращает вид адреса. */
export function assertEtpgpbUrlAllowed(url: string): EtpgpbUrlKind {
  const kind = etpgpbUrlKind(url);
  if (kind === null) throw new EtpgpbUrlNotAllowedError(url);
  return kind;
}

/** Разбор адреса карточки; null, если это не разрешённый адрес карточки. */
export function parseEtpgpbCardUrl(url: string): EtpgpbCardUrl | null {
  if (etpgpbUrlKind(url) !== "card") return null;
  const path = new URL(url).pathname;
  const match = CARD_PATH.exec(path);
  if (match === null) return null;
  return {
    url,
    kind: match[1] ?? "",
    id: match[2] ?? "",
    slug: match[3] ?? "",
    path,
  };
}

/** Адрес карточки из частей. Не проверяет сам себя: проверяет `parseEtpgpbCardUrl`. */
export function etpgpbCardUrl(kind: string, id: string, slug: string): string {
  return `${ETPGPB_ORIGIN}/procedures/${kind}/${id}-${slug}/`;
}

/** Номер куска карты процедур из адреса; null, если адрес не такой. */
export function etpgpbChunkNumber(url: string): number | null {
  if (etpgpbUrlKind(url) !== "sitemap-chunk") return null;
  const match = SITEMAP_CHUNK_PATH.exec(new URL(url).pathname);
  return match === null ? null : Number(match[1]);
}
