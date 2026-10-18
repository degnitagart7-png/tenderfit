/**
 * Адреса и проверки ответов ФГИС ЦС для скачивания зональных данных.
 *
 * Чистые функции: сеть и диск — дело `scripts/fsnb/fetch-zone.ts`. Отделено ради
 * проверяемости: разбор зон субъекта, выбор периода и опознание «ответ — не
 * файл, а страница ошибки» проверяются без сети (с российского IP открывается
 * только сервер, с обычной машины — таймаут).
 */

export const FGIS_BASE = "https://fgiscs.minstroyrf.ru";

export interface ApiZone {
  readonly value: number;
  readonly text: string;
}

export interface ApiPeriod {
  readonly id: number;
  readonly name: string;
}

export function zonesUrl(): string {
  return `${FGIS_BASE}/api/PriceZone`;
}

export function periodsUrl(priceZoneId: number): string {
  return `${FGIS_BASE}/api/EstimatedPrice/Periods?priceZoneId=${String(priceZoneId)}`;
}

/**
 * Страница реестра ставок оплаты труда. Реестр листается параметром `page`
 * (с 1, по 25 записей); `skip`, `offset` и `pageSize` сервер игнорирует.
 */
export function wagesPageUrl(priceZoneId: number, periodId: number, page: number): string {
  return `${zoneFileUrls(priceZoneId, periodId).wages}&page=${String(page)}`;
}

/** Предохранитель листания: 186 записей — это 8 страниц, 50 — с большим запасом. */
export const MAX_REGISTRY_PAGES = 50;

interface RegistryPage {
  readonly total?: unknown;
  readonly items?: unknown;
}

/**
 * Собирает реестр ставок по страницам: листает, пока не наберётся `total`.
 *
 * Дубли по `id` отбрасываются; пустая страница или страница без новых записей —
 * стоп; больше `MAX_REGISTRY_PAGES` страниц не читаем. Собрано меньше `total` —
 * ошибка: неполный реестр молча дал бы шкалу без части разрядов и специалистов.
 * Результат — тот же формат, что у одной страницы: `{ total, items }`.
 */
export async function collectRegistryPages(
  fetchPage: (page: number) => Promise<unknown>,
): Promise<{ total: number; items: Record<string, unknown>[]; pages: number }> {
  const seen = new Set<string>();
  const items: Record<string, unknown>[] = [];
  let total = 0;
  let pages = 0;

  for (let page = 1; page <= MAX_REGISTRY_PAGES; page += 1) {
    const payload = (await fetchPage(page)) as RegistryPage | null;
    pages = page;
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.items)) {
      throw new Error(`Страница ${String(page)} реестра ставок пришла без списка items.`);
    }
    if (typeof payload.total === "number" && payload.total > total) total = payload.total;

    let fresh = 0;
    for (const item of payload.items as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const key = String(record.id ?? `${String(record.code)}|${String(record.salary)}`);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(record);
      fresh += 1;
    }
    if (fresh === 0) break;
    if (total > 0 && items.length >= total) break;
  }

  if (items.length === 0) throw new Error("Реестр ставок оплаты труда пуст.");
  if (total > 0 && items.length < total) {
    throw new Error(
      `Реестр ставок собран не целиком: ${String(items.length)} записей из ${String(total)} за ${String(pages)} стр. (предохранитель ${String(MAX_REGISTRY_PAGES)}).`,
    );
  }
  return { total: total > 0 ? total : items.length, items, pages };
}

/** Три файла зоны за период: ФСЦСР, реестр ставок, сплит-форма. */
export function zoneFileUrls(priceZoneId: number, periodId: number): {
  readonly fscsr: string;
  readonly wages: string;
  readonly split: string;
} {
  const query = `periodId=${String(periodId)}&priceZoneId=${String(priceZoneId)}`;
  return {
    fscsr: `${FGIS_BASE}/api/EstimatedPrice/BuildingResources/Export?${query}&authorityId=null`,
    wages: `${FGIS_BASE}/api/EstimatedPrice/RimWorkerSalaryRegistry?${query}`,
    split: `${FGIS_BASE}/api/EstimatedPrice/BuildingResources/ExportSplitForm?${query}`,
  };
}

/**
 * Выгрузки сметных цен услуг автомобильного транспорта: перевозка грузов и
 * погрузочно-разгрузочные работы. Открыты без авторизации, xlsx; нужны только они
 * (железнодорожные, водные и воздушные цены расчёту не нужны).
 */
export function serviceFileUrls(priceZoneId: number, periodId: number): {
  readonly transport: string;
  readonly load: string;
} {
  const query = `periodId=${String(periodId)}&priceZoneId=${String(priceZoneId)}`;
  return {
    transport: `${FGIS_BASE}/api/EstimatedPrice/Services/Export/TransportationByAutoPortal?${query}`,
    load: `${FGIS_BASE}/api/EstimatedPrice/Services/Export/LoadWorksByAutoPortal?${query}`,
  };
}

/** Ответ `/api/PriceZone` → список зон. Всё, что не похоже на `[{value, text}]`, — ошибка. */
export function parseApiZones(payload: unknown): ApiZone[] {
  if (!Array.isArray(payload)) throw new Error("Список ценовых зон ФГИС ЦС пришёл не массивом.");
  const zones: ApiZone[] = [];
  for (const item of payload) {
    if (typeof item !== "object" || item === null) continue;
    const { value, text } = item as { value?: unknown; text?: unknown };
    if (typeof value === "number" && Number.isInteger(value) && typeof text === "string" && text.trim() !== "") {
      zones.push({ value, text: text.trim() });
    }
  }
  if (zones.length === 0) throw new Error("В списке ценовых зон ФГИС ЦС нет ни одной записи.");
  return zones;
}

/**
 * Зоны субъекта. У субъекта с несколькими зонами в справочнике есть и сама
 * запись субъекта («Республика Бурятия», 193), и зоны («Республика Бурятия
 * (1 зона)»…): цены публикуются по зонам, запись субъекта не нужна. Субъект с
 * одной зоной представлен единственной записью — тогда зона и есть она.
 */
export function selectSubjectZones(zones: readonly ApiZone[], subject: string): ApiZone[] {
  const name = subject.trim().toLowerCase();
  const numbered = zones.filter((zone) => {
    const text = zone.text.toLowerCase();
    return text.startsWith(`${name} (`) && /\(\d+\s*зона\)\s*$/u.test(text);
  });
  if (numbered.length > 0) return numbered.sort((a, b) => a.value - b.value);
  return zones.filter((zone) => zone.text.toLowerCase() === name);
}

/**
 * Зоны, по которым публикуются цены. В справочнике у субъекта с несколькими зонами есть и
 * запись самого субъекта («Республика Бурятия», 193), и зоны («Республика Бурятия (1 зона)»…):
 * цены есть только у зон, запись субъекта пропускается. Субъект с одной зоной представлен
 * единственной записью без номера — она и есть зона.
 */
export function selectPricedZones(zones: readonly ApiZone[]): ApiZone[] {
  const subjectsWithZones = new Set<string>();
  for (const zone of zones) {
    const match = /^(.*?)\s*\(\d+\s*зона\)\s*$/iu.exec(zone.text.trim());
    if (match !== null) subjectsWithZones.add((match[1] as string).trim().toLowerCase());
  }
  return zones.filter((zone) => !subjectsWithZones.has(zone.text.trim().toLowerCase())).sort((a, b) => a.value - b.value);
}

/** Период по запросу: `latest` — первый в ответе (самый свежий), иначе по номеру. */
export function pickPeriod(periods: readonly ApiPeriod[], requested: number | "latest"): ApiPeriod {
  const period = requested === "latest" ? periods[0] : periods.find((item) => item.id === requested);
  if (period === undefined) {
    throw new Error(
      requested === "latest"
        ? "ФГИС ЦС не вернул ни одного периода для зоны."
        : `Периода ${String(requested)} нет у зоны; доступны: ${periods.map((item) => String(item.id)).join(", ")}.`,
    );
  }
  return period;
}

export function parseApiPeriods(payload: unknown): ApiPeriod[] {
  if (!Array.isArray(payload)) throw new Error("Список периодов ФГИС ЦС пришёл не массивом.");
  const periods: ApiPeriod[] = [];
  for (const item of payload) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id === "number" && typeof name === "string") periods.push({ id, name: name.trim() });
  }
  return periods;
}

export type PayloadKind = "xlsx" | "json" | "zip" | "pdf";

/**
 * Проверка ответа до записи на диск. Сервер при сбое отдаёт HTML-страницу с кодом
 * 200 или пустое тело, и такой «файл» разобрался бы с непонятной ошибкой далеко
 * отсюда. Здесь причина называется сразу.
 */
export function assertPayload(
  kind: PayloadKind,
  bytes: Uint8Array,
  contentType: string | null,
  what: string,
): void {
  if (bytes.length === 0) throw new Error(`${what}: пустой ответ ФГИС ЦС.`);
  const head = Buffer.from(bytes.subarray(0, 64)).toString("utf8").trimStart().toLowerCase();
  if ((contentType ?? "").toLowerCase().includes("text/html") || head.startsWith("<!doctype") || head.startsWith("<html")) {
    throw new Error(`${what}: вместо файла пришла HTML-страница (вероятно, ошибка сервера или блокировка по IP).`);
  }
  if (kind === "xlsx" && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new Error(`${what}: ответ не похож на xlsx (нет сигнатуры zip).`);
  }
  if (kind === "zip" && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new Error(`${what}: ответ не похож на zip-архив (нет сигнатуры PK).`);
  }
  if (kind === "pdf" && Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new Error(`${what}: ответ не похож на PDF (нет сигнатуры %PDF-).`);
  }
  if (kind === "json") {
    try {
      JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new Error(`${what}: ответ не разбирается как JSON.`);
    }
  }
}
