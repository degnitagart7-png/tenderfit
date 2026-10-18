/**
 * Карточка процедуры ЭТП ГПБ: данные Nuxt → очищенная от контактов запись.
 *
 * Карточка `https://etpgpb.ru/procedures/<вид>/<id>-<slug>/` — серверно собранная
 * страница Nuxt 3. Всё, что нужно, лежит не в разметке, а в
 * `<script type="application/json" id="__NUXT_DATA__">[…]</script>` — формате
 * «devalue»: плоский массив, где значения объектов и массивов — ЦЕЛЫЕ ИНДЕКСЫ в тот же
 * массив, а литералы (строки, числа, true/null) — сами элементы массива. Обёртки
 * реактивности пишутся парами `["Reactive", i]`, `["ShallowReactive", i]`,
 * `["Ref", i]`, `["EmptyRef", i]` (иногда друг в друге: `Ref → Reactive → объект`),
 * а `["Set", …]`, `["Map", …]`, `["Date", "ISO"]` — коллекции и даты.
 *
 * Три решения, которые модуль принимает осознанно.
 *
 * 1. **Главная процедура берётся по месту, а не по виду.** На странице несколько
 *    объектов с теми же ключами (`registry_number`, `title`, `stage`, …): блок
 *    «Похожие процедуры» повторяет облегчённые копии, и среди них бывает копия самой
 *    же процедуры с тем же `id` (проверено 19.10.2026: у карточки 1299773 `id 2081478`
 *    встречается дважды, во втором случае без `platform_id` и без заказчика). Поиск
 *    «первого объекта с `registry_number`» вернул бы чужую закупку. Поэтому главная
 *    процедура — это `pinia.PROCEDURES_ID_STORE.procedure`, и она сверяется с адресом
 *    запроса: `platform_id` обязан совпасть с числом из пути (а не `id` ресурса — у
 *    разных видов они различаются). Запасной обход по всему дереву тоже требует этого
 *    совпадения и не берёт ничего «похожего»: нет совпадения — нет процедуры.
 *
 * 2. **Заказчик — не всегда в `relationships.company`.** У `commerce` и `etp_click`
 *    там `{data: null}`, у `etp` и `gaz` лежит ОРГАНИЗАТОР (ГСП ЦЕНТР проводит
 *    процедуру, а покупает ГСП Ремонт; «Газпром комплектация» — «Газпром питание»).
 *    Настоящий заказчик — в `PROCEDURES_ID_STORE.lotCustomers`: по списку на лот,
 *    у каждого элемента `relationships.company`. Модуль отдаёт и организатора, и
 *    заказчиков лотов; кого выбрать, решает маппер.
 *
 * 3. **Контактов здесь нет и появиться не может.** Карточка несёт ФИО, телефоны и
 *    почту четырьмя путями: `contact_person`, `contact_email`, `contact_phone`,
 *    `customer_contact`, `customer_email`, `customer_phone`, `body_email` в атрибутах,
 *    `relationships.contacts` у процедуры и у каждого заказчика лота. Вместо
 *    «вырезать известное» модуль строит результат ИЗ БЕЛОГО СПИСКА полей: любое поле,
 *    которого нет в списке ниже, до результата не доходит — в том числе контакт под
 *    именем, которого мы пока не знаем. Ссылки на документы (`etp.gpb.ru/file/get/…`,
 *    `com.etpgpb.ru/…`) тоже не сохраняются: хост закрыт `robots.txt`, а название и дата
 *    файла достаточны, чтобы показать, что документация есть.
 *
 * Модуль чистый: HTML на входе — очищенная запись на выходе, без сети и диска.
 */
import { parseEtpgpbCardUrl } from "@/adapters/tender-source/etpgpbUrl";

/* ============================== devalue ============================== */

const MAX_DEPTH = 64;
const WRAPPERS: ReadonlySet<string> = new Set([
  "Reactive",
  "ShallowReactive",
  "Ref",
  "ShallowRef",
  "EmptyRef",
  "EmptyShallowRef",
  "Readonly",
  "ShallowReadonly",
]);

/** Объект без прототипа: ключ `__proto__` из чужих данных становится обычным полем. */
type Bag = Record<string, unknown>;

/**
 * Разворачивает devalue-таблицу в обычные объекты начиная с `rootIndex`.
 *
 * Общие узлы остаются общими объектами, циклы не зацикливают разворот (контейнер
 * регистрируется до заполнения), глубина ограничена `MAX_DEPTH`: таблица приходит из
 * чужого ответа. Неизвестная обёртка и недостижимый индекс дают `undefined`.
 */
export function resolveDevalue(table: readonly unknown[], rootIndex = 0): unknown {
  const memo = new Map<number, unknown>();

  const hydrate = (index: number, depth: number): unknown => {
    // Служебные значения devalue: -1 undefined, -2 дыра в массиве, -3 NaN, ±Infinity, -0.
    if (index === -1 || index === -2) return undefined;
    if (index === -3) return Number.NaN;
    if (index === -4) return Number.POSITIVE_INFINITY;
    if (index === -5) return Number.NEGATIVE_INFINITY;
    if (index === -6) return -0;
    if (!Number.isInteger(index) || index < 0 || index >= table.length) return undefined;
    if (memo.has(index)) return memo.get(index);
    if (depth > MAX_DEPTH) return undefined;

    const raw = table[index];
    if (raw === null || typeof raw !== "object") {
      memo.set(index, raw);
      return raw;
    }

    if (Array.isArray(raw)) {
      const tag: unknown = raw[0];
      if (typeof tag === "string") {
        let result: unknown;
        if (WRAPPERS.has(tag)) {
          const target: unknown = raw[1];
          result = typeof target === "number" ? hydrate(target, depth + 1) : undefined;
        } else if (tag === "Date") {
          result = typeof raw[1] === "string" ? raw[1] : null;
        } else if (tag === "Set") {
          result = raw.slice(1).map((item) => (typeof item === "number" ? hydrate(item, depth + 1) : undefined));
        } else if (tag === "Map") {
          const entries: unknown[] = [];
          for (let i = 1; i + 1 < raw.length; i += 2) {
            const key: unknown = raw[i];
            const value: unknown = raw[i + 1];
            entries.push([
              typeof key === "number" ? hydrate(key, depth + 1) : undefined,
              typeof value === "number" ? hydrate(value, depth + 1) : undefined,
            ]);
          }
          result = entries;
        } else if (tag === "BigInt") {
          result = String(raw[1]);
        } else if (tag === "null") {
          // Объект без прототипа: ключи — литеральные строки, значения — индексы.
          const bag: Bag = Object.create(null) as Bag;
          memo.set(index, bag);
          for (let i = 1; i + 1 < raw.length; i += 2) {
            const key: unknown = raw[i];
            const value: unknown = raw[i + 1];
            if (typeof key === "string") bag[key] = typeof value === "number" ? hydrate(value, depth + 1) : undefined;
          }
          return bag;
        } else {
          result = undefined;
        }
        memo.set(index, result);
        return result;
      }
      const list: unknown[] = [];
      memo.set(index, list);
      for (const item of raw) list.push(typeof item === "number" ? hydrate(item, depth + 1) : undefined);
      return list;
    }

    const bag: Bag = Object.create(null) as Bag;
    memo.set(index, bag);
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      bag[key] = typeof value === "number" ? hydrate(value, depth + 1) : undefined;
    }
    return bag;
  };

  return hydrate(rootIndex, 0);
}

const NUXT_SCRIPT = /<script\b[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

/** Страница содержит данные Nuxt. Ответ антибота или заглушки их не содержит. */
export function isEtpgpbCardPage(html: string): boolean {
  return html.includes('id="__NUXT_DATA__"');
}

/** Таблица devalue со страницы; null, если блока нет или он не разбирается. */
export function extractNuxtTable(html: string): unknown[] | null {
  const match = NUXT_SCRIPT.exec(html);
  if (match === null) return null;
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ============================== чтение полей ============================== */

function isBag(value: unknown): value is Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strOrNull(value: unknown): string | null {
  const text = str(value);
  return text === "" ? null : text;
}

/** Число из числа или строки вида «2113390.4» / «2 113 390,5»; нечитаемое — null. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter((text) => text !== "");
}

/** Ресурс JSON:API из самого ресурса или из `{data: ресурс}`; иначе null. */
function resourceOf(node: unknown): Bag | null {
  if (!isBag(node)) return null;
  if (isBag(node["attributes"])) return node;
  return resourceOf(node["data"]);
}

/** Список ресурсов из `{data: [...]}`; элементы без атрибутов пропущены. */
function resourceList(node: unknown): Bag[] {
  if (!isBag(node) || !Array.isArray(node["data"])) return [];
  return node["data"].filter((item): item is Bag => isBag(item) && isBag(item["attributes"]));
}

/* ============================== очищенная запись ============================== */

/** Юридическое лицо: наименование, ИНН/КПП, адрес. Телефонов, почты и ФИО нет. */
export interface EtpgpbCompany {
  readonly name: string;
  readonly shortName: string;
  readonly fullName: string;
  readonly inn: string | null;
  readonly kpp: string | null;
  readonly address: string;
}

/** Лот. Даты — как в карточке (ISO со смещением). */
export interface EtpgpbLot {
  readonly id: string;
  readonly number: number | null;
  readonly title: string;
  readonly subject: string;
  readonly startPrice: number | null;
  readonly currency: string;
  /** Окончание приёма заявок; у `etp_click` пусто. */
  readonly dateEndRegistration: string | null;
  /** Срок ответа: у `etp_click` именно он — срок приёма предложений. */
  readonly responseDate: string | null;
  readonly deliveryAddress: string;
  readonly region: string;
  readonly nationalMode: boolean;
}

/** Документ процедуры. Ссылка не хранится: хост файлов закрыт `robots.txt`. */
export interface EtpgpbDoc {
  readonly title: string;
  readonly date: string | null;
}

export interface EtpgpbCard {
  /** Вид процедуры из пути (`etp`, `price_request`, …). */
  readonly kind: string;
  /** Номер процедуры на площадке (`platform_id`), он же число в адресе. */
  readonly platformId: string;
  /** Путь карточки, как его печатает площадка: `/procedures/etp/…/`. */
  readonly path: string;
  readonly registryNumber: string;
  readonly title: string;
  /** `accepting` — приём заявок; остальное (`commission`, `completed`, …) — нет. */
  readonly stage: string;
  readonly amount: number | null;
  readonly priceUnknown: boolean;
  readonly currency: string;
  readonly region: string;
  readonly regions: readonly string[];
  readonly lotRegions: readonly string[];
  /** «23.10.2026 03:00» — московское время. */
  readonly applicationEnd: string | null;
  readonly datePublished: string | null;
  readonly dateLastUpdate: string | null;
  readonly eisUrl: string | null;
  readonly procedureNumber: string | null;
  readonly procedureTypeName: string;
  readonly platform: string;
  readonly sectionDescription: string;
  readonly templateType: string;
  readonly customerAddress: string;
  readonly flags: {
    readonly auction: boolean;
    readonly competition: boolean;
    readonly requestOffers: boolean;
    readonly requestQuotes: boolean;
    readonly smsp: boolean;
    readonly nationalMode: boolean;
  };
  /** Организатор (`relationships.company`); null у `commerce` и `etp_click`. */
  readonly organizer: EtpgpbCompany | null;
  /** Заказчики лотов (`lotCustomers`), без повторов. */
  readonly customers: readonly EtpgpbCompany[];
  readonly lots: readonly EtpgpbLot[];
  readonly docs: readonly EtpgpbDoc[];
  /** Названия регионов из `relationships.regions`. */
  readonly regionNames: readonly string[];
  /** Коды ОКПД2, если площадка их напечатала (в замерах 19.10.2026 список был пуст). */
  readonly okpds: readonly string[];
}

function companyOf(node: unknown): EtpgpbCompany | null {
  const resource = resourceOf(node);
  if (resource === null) return null;
  const attributes = resource["attributes"];
  if (!isBag(attributes)) return null;
  const company: EtpgpbCompany = {
    name: str(attributes["name"]),
    shortName: str(attributes["short_name"]),
    fullName: str(attributes["full_name"]),
    inn: strOrNull(attributes["inn"]),
    kpp: strOrNull(attributes["kpp"]),
    address: str(attributes["addr_main"]) || str(attributes["addr_post"]),
  };
  const empty = company.name === "" && company.fullName === "" && company.shortName === "" && company.inn === null;
  return empty ? null : company;
}

/**
 * Заказчики лотов: у `lotCustomers` — список на лот, у каждого элемента
 * `relationships.company`. Обход безразличен к вложенности списков. Ключ
 * `relationships.contacts` не читается нигде.
 */
function lotCustomerCompanies(node: unknown, depth = 0): EtpgpbCompany[] {
  if (depth > 4) return [];
  if (Array.isArray(node)) return node.flatMap((item) => lotCustomerCompanies(item, depth + 1));
  if (!isBag(node)) return [];
  const relationships = node["relationships"];
  if (!isBag(relationships)) return [];
  const company = companyOf(relationships["company"]);
  return company === null ? [] : [company];
}

function uniqueCompanies(companies: readonly EtpgpbCompany[]): EtpgpbCompany[] {
  const seen = new Set<string>();
  const out: EtpgpbCompany[] = [];
  for (const company of companies) {
    const key = company.inn ?? (company.fullName || company.name || company.shortName);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(company);
  }
  return out;
}

function lotOf(resource: Bag): EtpgpbLot | null {
  const a = resource["attributes"];
  if (!isBag(a)) return null;
  return {
    id: str(resource["id"]) || String(resource["id"] ?? ""),
    number: num(a["number"]),
    title: str(a["title"]),
    subject: str(a["subject"]),
    startPrice: num(a["start_price"]),
    currency: str(a["currency_name"]),
    dateEndRegistration: strOrNull(a["date_end_registration"]),
    responseDate: strOrNull(a["response_date"]),
    deliveryAddress: str(a["delivery_place_full_address"]),
    region: str(a["region"]),
    nationalMode: a["national_mode_advantage"] === true,
  };
}

const OKPD_CODE = /^\d{2}(?:\.\d{1,2}){0,4}$/;

/** Код ОКПД2 из атрибутов справочника: первое значение похожее на код. Форма ресурса не замерена. */
function okpdCode(resource: Bag): string | null {
  const a = resource["attributes"];
  if (!isBag(a)) return null;
  for (const key of ["code", "okpd2_code", "okpd_code", "number"]) {
    const value = str(a[key]);
    if (OKPD_CODE.test(value)) return value;
  }
  return null;
}

/* ============================== главная процедура ============================== */

interface ProcedureMatch {
  readonly procedure: Bag;
  /** `PROCEDURES_ID_STORE`, если процедура взята оттуда: в нём лежат заказчики лотов. */
  readonly store: Bag | null;
}

function matchesRequest(procedure: Bag, expected: { id: string; path: string } | null): boolean {
  const a = procedure["attributes"];
  if (!isBag(a)) return false;
  if (expected === null) return true;
  const platformId = a["platform_id"];
  if (platformId !== undefined && platformId !== null && String(platformId) === expected.id) return true;
  return str(a["rebranding_truncated_path"]) === expected.path;
}

function findByWalk(root: unknown, expected: { id: string; path: string }): Bag | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): Bag | null => {
    if (depth > 24 || typeof node !== "object" || node === null || seen.has(node)) return null;
    seen.add(node);
    if (isBag(node) && node["type"] === "procedure" && isBag(node["attributes"])) {
      const a = node["attributes"];
      // Только полная карточка: у копий в «похожих» нет `platform_id`, и совпасть по
      // пути они не должны — копия не несёт ни лотов, ни заказчика.
      if (a["platform_id"] !== undefined && matchesRequest(node, expected)) return node;
    }
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      const found = visit(child, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(root, 0);
}

function findMainProcedure(root: unknown, expected: { id: string; path: string } | null): ProcedureMatch | null {
  const pinia = isBag(root) ? root["pinia"] : undefined;
  const store = isBag(pinia) ? pinia["PROCEDURES_ID_STORE"] : undefined;
  if (isBag(store)) {
    const direct = resourceOf(store["procedure"]);
    if (direct !== null && matchesRequest(direct, expected)) return { procedure: direct, store };
  }
  if (expected === null) return null;
  const walked = findByWalk(root, expected);
  return walked === null ? null : { procedure: walked, store: null };
}

/* ============================== разбор карточки ============================== */

/**
 * Очищенная запись из HTML карточки.
 *
 * `url` — адрес, по которому карточку запросили: по нему сверяется главная
 * процедура и определяется вид. Не адрес карточки (чужой хост, query-строка) —
 * сверки нет, и запись принимается только из `PROCEDURES_ID_STORE`.
 *
 * null — это не карточка: нет данных Nuxt, нет процедуры или процедура другая (в
 * ответе страница-заглушка, редирект на соседнюю). Такой ответ нельзя записать
 * как закупку.
 */
export function parseEtpgpbCard(html: string, url: string): EtpgpbCard | null {
  const table = extractNuxtTable(html);
  if (table === null) return null;
  const root = resolveDevalue(table, 0);

  const requested = parseEtpgpbCardUrl(url);
  const expected = requested === null ? null : { id: requested.id, path: requested.path };
  const match = findMainProcedure(root, expected);
  if (match === null) return null;

  const { procedure, store } = match;
  const a = procedure["attributes"];
  if (!isBag(a)) return null;
  const relationships = isBag(procedure["relationships"]) ? procedure["relationships"] : {};

  const path = str(a["rebranding_truncated_path"]);
  const kindFromPath = /^\/procedures\/([a-z][a-z0-9_]*)\//.exec(path)?.[1];
  const kind = kindFromPath ?? requested?.kind ?? "";
  const platformId = a["platform_id"] === undefined || a["platform_id"] === null ? (requested?.id ?? "") : String(a["platform_id"]);

  // Лоты: сначала ресурсы самой процедуры, потом отдельный список стора.
  let lotResources = resourceList(relationships["lots"]);
  if (lotResources.length === 0 && store !== null && Array.isArray(store["lots"])) {
    lotResources = store["lots"].filter((item): item is Bag => isBag(item) && isBag(item["attributes"]));
  }
  const lots = lotResources.map(lotOf).filter((lot): lot is EtpgpbLot => lot !== null);

  const customers = uniqueCompanies(store === null ? [] : lotCustomerCompanies(store["lotCustomers"]));

  const docs: EtpgpbDoc[] = resourceList(relationships["docs"]).map((doc) => {
    const attributes = doc["attributes"] as Bag;
    return {
      title: str(attributes["file_title"]) || str(attributes["file_name"]),
      date: strOrNull(attributes["date"]),
    };
  });

  const regionNames = resourceList(relationships["regions"])
    .map((region) => str((region["attributes"] as Bag)["name"]))
    .filter((name) => name !== "");
  const okpds = [...new Set(resourceList(relationships["okpds"]).map(okpdCode).filter((c): c is string => c !== null))];

  return {
    kind,
    platformId,
    path,
    registryNumber: str(a["registry_number"]),
    title: str(a["title"]),
    stage: str(a["stage"]),
    amount: num(a["amount"]),
    priceUnknown: a["price_unknown"] === true,
    currency: str(a["currency_name"]),
    region: str(a["region"]),
    regions: strings(a["regions"]),
    lotRegions: strings(a["lot_regions"]),
    applicationEnd: strOrNull(a["application_reception_normal_date"]),
    datePublished: strOrNull(a["date_published"]),
    dateLastUpdate: strOrNull(a["date_last_update"]),
    eisUrl: strOrNull(a["eis_url"]),
    procedureNumber: strOrNull(a["procedure_number"]),
    procedureTypeName: str(a["humanized_procedure_type_name"]) || str(a["procedure_type_name"]),
    platform: str(a["platform"]),
    sectionDescription: str(a["section_description"]),
    templateType: str(a["template_type"]),
    customerAddress: str(a["customer_address_main"]),
    flags: {
      auction: a["type_auction"] === true,
      competition: a["type_competition"] === true,
      requestOffers: a["type_request_offers"] === true,
      requestQuotes: a["type_request_quotes"] === true,
      smsp: a["type_smsp"] === true,
      nationalMode: a["national_mode_advantage"] === true,
    },
    organizer: companyOf(relationships["company"]),
    customers,
    lots,
    docs,
    regionNames,
    okpds,
  };
}
