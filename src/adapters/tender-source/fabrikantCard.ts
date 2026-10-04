/**
 * Карточка процедуры Фабриканта: адрес, словари разметки и разбор страницы.
 *
 * Карточка живёт на `fabrikant.ru/v2/trades/procedure/view/{id}` и отдаётся
 * легаси-серверным рендером на jQuery: ключа не просит, весит 74–155 КБ,
 * отвечает за 0,8–1,05 с. `robots.txt` хоста запрещает всё, что связано с
 * действиями участника (`?actions=proposal*`, `?actions=view_participants*` и
 * десятки подобных), но путь карточки без параметра `actions` не запрещает ни
 * одна из 164 строк (проверено 02.10.2026, см. `docs/REFERENCE_PLATFORM_PROBES.md`).
 *
 * Шесть особенностей разметки, из-за которых модуль устроен именно так:
 *
 * 1. **Каждое поле — панель с машинным ключом.** Значение лежит в
 *    `div.panel-group.panel-group-element-{ключ}`, подпись — в `.col-md-4`,
 *    значение — в `.col-md-8`. Разбор идёт по ключу, а не по подписи: живой
 *    замер на трёх процедурах дал 30, 29 и 23 панели из 30 ожидаемых, то есть
 *    обязательных полей у карточки нет вовсе.
 *
 * 2. **Каждый лот — свой контейнер `div.panel.lot_head_{id}`**, внутри которого
 *    и заголовок «Лот №N», и все панели лота. На процедуре с 18 лотами страница
 *    держит 5 контейнеров и 78 панелей: 13 процедурных и 13 на каждый лот.
 *    Идентификатор в классе — свой, внутренний: у процедуры 5581328 лоты в
 *    выдаче шли как `679661088…`, а контейнеры назывались `lot_head_803606`,
 *    `lot_head_803642` и так далее. Сопоставлять их с выдачей нельзя.
 *
 * 3. **Карточка печатает по 5 лотов на страницу**, а сколько их всего — видно
 *    только по счётчику вкладки «Список лотов». Счётчики есть и у других
 *    вкладок («0/0» у приёма заявок, «0» у запросов разъяснений), поэтому
 *    искать нужно по названию вкладки, а не по классу `active` и не по позиции.
 *
 * 4. **Часть ключей панелей нестабильна.** Рядом с постоянными
 *    (`lot_price`, `lot_currency`, `proposal_date_stop`) живут ключи с хешем
 *    шаблона — `1_lot_textarea5d2ec93b852b8` («Срок исполнения договора»),
 *    `1_lot_textarea6076c6e7473a3` (таблица позиций с ОКПД2). Хеш меняется от
 *    шаблона к шаблону, поэтому ОКПД2 ищется по тексту всех панелей лота, а не
 *    по ключу.
 *
 * 5. **Внутри значений бывает исполняемый код.** Панель цены несёт перед суммой
 *    `$(document).ready(…changeCurrency(…)…)`, а дата публикации — кнопки
 *    «Действия История изменений Закрыть Продолжить». Скрипты вырезаются до
 *    чтения текста, иначе «119 994 640,40» превратилось бы в набор цифр из тела
 *    функции.
 *
 * 6. **Живых шаблонов карточки два, и срок приёма заявок они печатают на разных
 *    уровнях.** Зонд 03.10.2026 прошёл 12 процедур: у девяти срок лежал в
 *    панелях лота вместе с `proposal_date_start`, `determination_date` и
 *    `summing_up_date`; у трёх в лоте не было ни одной панели с датой, а
 *    `proposal_date_stop` стоял на уровне процедуры. Процедур без срока вовсе не
 *    оказалось ни одной. Лот, у которого своего срока нет, наследует срок
 *    процедуры — иначе закупка уходила в базу с пустой строкой в
 *    `submission_end TIMESTAMPTZ NOT NULL`, и прогон 03.10.2026 отклонил так 44
 *    закупки Фабриканта (ошибка 22007). Наследство не подменяет срок лота своим:
 *    у многолотовой процедуры первого шаблона даты лотов различаются, и точное
 *    значение важнее общего.
 *
 * Отдельно и жёстко: **личные данные парсер не читает вовсе.** Живая карточка
 * печатает панель `procedure_personal_contact` и внутри составной панели
 * организатора — «Контактное лицо» и «Телефон». Они вырезаются из дерева до
 * разбора, поэтому не могут попасть ни в одно поле результата, ни в журнал
 * прогона, ни в базу. Именно так, а не «не записывать прочитанное»: значение
 * панели организатора составное, и фильтр по ключу панели его не поймал бы —
 * зонд 02.10.2026 на этом один раз и попался.
 */
import * as cheerio from "cheerio";

/**
 * Выборка cheerio.
 *
 * Тип узла пакет из своего пространства имён не отдаёт: и `cheerio.Element`, и
 * `cheerio.AnyNode` дают TS2694. Импортировать `domhandler` напрямую тоже нельзя —
 * это транзитивная зависимость, которую npm может переложить, и сломается это
 * только на чистой установке. Поэтому тип выводится из самой загрузки: она у нас
 * одна, и её сигнатуру пакет обязан держать.
 */
type Selection = ReturnType<cheerio.CheerioAPI>;

/** Путь карточки процедуры на публичном хосте. */
const CARD_PATH = "/v2/trades/procedure/view/";

/** Название вкладки, у которой счётчик означает число лотов в процедуре. */
const LOTS_TAB_TITLE = "Список лотов";

/** Префикс класса панели с машинным ключом. */
const PANEL_CLASS_PREFIX = "panel-group-element-";

/** Префикс класса контейнера одного лота. */
const LOT_CLASS_PREFIX = "lot_head_";

/**
 * Сколько лотов карточка печатает на одну страницу.
 *
 * Живой замер 02.10.2026: процедура с 18 лотами отдала на первой странице 5,
 * а `?page=2` — лоты 6–10. Параметры `lot_page` и `page_lot` площадкой
 * игнорируются, работает только `page`.
 */
export const FABRIKANT_LOTS_PER_PAGE = 5;

/**
 * Панели, которые не читаются вовсе: в них площадка печатает контактные данные
 * сотрудников заказчика.
 */
const PERSONAL_PANEL_KEYS: readonly string[] = ["procedure_personal_contact"];

/**
 * Подписи вложенных блоков, которые вырезаются вместе со значением.
 *
 * Сравнение идёт по началу подписи, а не по точному совпадению: «Контактное
 * лицо организатора» и «Телефон для справок» — те же самые данные, и оставлять
 * их значило бы оставить лазейку. Обратная ошибка здесь дешевле прямой:
 * «Почтовый адрес» под префикс «почта» не попадает («почтовый» ≠ «почта»),
 * а потерять подпись, которой мы всё равно не пользуемся, не страшно.
 */
const PERSONAL_LABEL_PREFIXES: readonly string[] = [
  "контактное лицо",
  "контактный телефон",
  "телефон",
  "мобильный",
  "факс",
  "e-mail",
  "email",
  "электронная почта",
  "адрес электронной почты",
  "почта",
  "фио",
  "ф.и.о.",
  "подписант",
];

/** Панель организатора: составная, разбирается по вложенным блокам. */
const ORGANIZER_PANEL_KEY = "procedure_organizer";

/** Панель места поставки лота: тоже составная. */
const DELIVERY_PANEL_KEY = "lot_delivery_place";

/**
 * Панель окончания приёма заявок.
 *
 * Ключ один, а уровень разный: см. особенность 6 в шапке модуля.
 */
const DEADLINE_PANEL_KEY = "proposal_date_stop";

/** Организатор закупки. */
export interface FabrikantOrganizer {
  /** Наименование организации из первого блока без подписи. */
  readonly name: string;
  /** Почтовый адрес строкой площадки; из него домен берёт регион как запасной. */
  readonly postalAddress: string;
  /** ИНН; null — блок не напечатан или в нём не 10 и не 12 цифр. */
  readonly inn: string | null;
}

/** Один лот карточки. */
export interface FabrikantCardLot {
  /** Номер лота из заголовка; null — заголовок не прочитался. */
  readonly number: number | null;
  /** Предмет договора из панели `name`, без хвоста «- Прием заявок». */
  readonly subject: string;
  /** Цена лота; null — «Без указания цены», то есть цена не опубликована. */
  readonly price: number | null;
  /** Цена с НДС или без; null — панель цены не напечатала признак. */
  readonly vatIncluded: boolean | null;
  /** Код валюты; "" — панель валюты отсутствует или валюта незнакомая. */
  readonly currency: string;
  /** Окончание приёма заявок в ISO с московским смещением; "" — не напечатано. */
  readonly submissionEnd: string;
  /** Субъект РФ из блока «Субъект РФ\Регион»; "" — блока нет. */
  readonly deliveryRegion: string;
  /** Федеральный округ; "" — блока нет. */
  readonly deliveryDistrict: string;
  /** Место поставки строкой площадки; "" — блока нет. */
  readonly deliveryAddress: string;
  /** Коды ОКПД2 из текста панелей лота: ключ таблицы позиций нестабилен. */
  readonly okpd2Codes: readonly string[];
  /** Обеспечение заявки; null — «Не требуется» или панель отсутствует. */
  readonly bidSecurityAmount: number | null;
  /** Обеспечение исполнения договора; null — не требуется или не напечатано. */
  readonly contractSecurityAmount: number | null;
  /** Процент обеспечения от НМЦД; null — площадка его не напечатала. */
  readonly contractSecurityPercent: number | null;
  /** Закупка только для субъектов МСП. */
  readonly onlyForSmp: boolean;
}

/** Разобранная страница карточки. */
export interface FabrikantCard {
  /**
   * Разметка узнана: на странице нашёлся хотя бы контейнер лота или одна панель.
   *
   * `false` значит, что площадка отдала что-то другое — страницу антибота,
   * заглушку или незнакомый шаблон. Адаптер такую процедуру пропускает со
   * счётчиком и причиной, а не записывает закупку без лотов и без цены.
   */
  readonly layoutRecognized: boolean;
  /** Число лотов из счётчика вкладки «Список лотов»; null — счётчика нет. */
  readonly declaredLotCount: number | null;
  /** Сколько контейнеров лотов нашлось на этой странице. */
  readonly lotsOnPage: number;
  /** Панели уровня процедуры: машинный ключ → текст значения. */
  readonly panels: Readonly<Record<string, string>>;
  /** Организатор; null — панели организатора на странице нет. */
  readonly organizer: FabrikantOrganizer | null;
  /** Номер извещения в ЕИС; null — закупка живёт только на площадке. */
  readonly eisNumber: string | null;
  readonly lots: readonly FabrikantCardLot[];
}

/**
 * Адрес страницы карточки с нужной страницей лотов.
 *
 * Первая страница остаётся без параметра: адрес из выдачи тогда совпадает с
 * запрошенным байт в байт, и его можно класть в базу как есть.
 */
export function fabrikantCardPageUrl(cardUrl: string, page: number): string {
  if (!Number.isFinite(page) || page <= 1) return cardUrl;
  const separator = cardUrl.includes("?") ? "&" : "?";
  return `${cardUrl}${separator}page=${Math.trunc(page)}`;
}

/**
 * Куда ведёт строка выдачи Фабриканта.
 *
 * Выдача площадки неоднородна. Живой замер 02.10.2026: из 79 строк без
 * ключевого слова 47 вели на `/v2`, 19 — в ЕИС, 9 — на «Маркет», 4 — в секцию
 * Росатома. Парсер карточки понимает только `/v2`, остальные адаптер пропускает.
 *
 * Различать виды нужно не для красоты: строка, ведущая в ЕИС, — не потеря, то же
 * извещение приносит адаптер реестра и приносит вместе с документами. Считать её
 * в одной куче с «Маркетом» значило бы показывать владельцу пробел там, где
 * никакого пробела нет.
 */
export type FabrikantCardUrlKind =
  | "v2"
  | "eis"
  | "market"
  | "atom"
  | "fz44"
  | "other";

/**
 * Вид адреса из строки выдачи. Не адрес, пустая строка и чужой хост — `other`.
 */
export function fabrikantCardUrlKind(url: string): FabrikantCardUrlKind {
  const trimmed = url.trim();
  if (trimmed === "") return "other";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "other";
  }
  if (parsed.protocol !== "https:") return "other";
  const host = parsed.hostname.toLowerCase();
  if (host === "zakupki.gov.ru" || host === "www.zakupki.gov.ru") return "eis";
  if (host !== "fabrikant.ru" && !host.endsWith(".fabrikant.ru")) return "other";
  if (host === "market.fabrikant.ru") return "market";
  if (host === "44.fabrikant.ru") return "fz44";
  if (parsed.pathname.startsWith("/trades/atom/")) return "atom";
  if (parsed.pathname.startsWith(CARD_PATH)) return "v2";
  return "other";
}

/**
 * Этот адрес — карточка процедуры на публичном хосте Фабриканта?
 *
 * Проверка нужна, потому что выдача ведёт не только на `/v2`: «Маркет» отдаёт
 * `market.fabrikant.ru/purchase_notice_es/view?id=…`, а секция 44-ФЗ —
 * `44.fabrikant.ru/44/procedure/…`. Ни того, ни другого парсер карточки не
 * понимает, и адаптер пропускает такие строки со счётчиком, а не пытается.
 *
 * Отдельного решения здесь нет намеренно: признать карточку — значит назвать вид
 * адреса `/v2`, и две независимые проверки разошлись бы молча.
 */
export function isFabrikantCardUrl(url: string): boolean {
  return fabrikantCardUrlKind(url) === "v2";
}

/**
 * Сколько страниц карточки нужно запросить.
 *
 * Счётчик вкладки — единственное место, где площадка говорит правду о числе
 * лотов. Без него процедура с 18 лотами выглядела бы пятилотовой, а сумма пяти
 * цен прошла бы фильтр лимита профиля и показала владельцу закупку-миллионник
 * как мелкую.
 */
export function fabrikantCardPageCount(declaredLotCount: number | null): number {
  if (declaredLotCount === null || !Number.isFinite(declaredLotCount)) return 1;
  if (declaredLotCount <= FABRIKANT_LOTS_PER_PAGE) return 1;
  return Math.ceil(declaredLotCount / FABRIKANT_LOTS_PER_PAGE);
}

/** Похож ли ответ на карточку процедуры, а не на антибот или страницу выдачи. */
export function isFabrikantCardPage(html: string): boolean {
  const $ = loadScrubbed(html);
  if ($(`[class*="${PANEL_CLASS_PREFIX}"]`).length > 0) return true;
  if ($(`[class*="${LOT_CLASS_PREFIX}"]`).length > 0) return true;
  return findLotsTab($).length > 0;
}

/** Разбирает страницу карточки. */
export function parseFabrikantCard(html: string): FabrikantCard {
  const $ = loadScrubbed(html);
  const panels: Record<string, string> = {};
  const organizers: FabrikantOrganizer[] = [];
  const drafts: LotDraft[] = [];

  // Обход в порядке документа: контейнер лота встречается раньше своих панелей,
  // поэтому всё, что найдено до первого контейнера, — уровень процедуры.
  $(`[class*="${LOT_CLASS_PREFIX}"], [class*="${PANEL_CLASS_PREFIX}"]`).each((_index, element) => {
    const node = $(element);
    const classes = (node.attr("class") ?? "").split(/\s+/);
    const lotClass = classes.find((one) => one.startsWith(LOT_CLASS_PREFIX));
    if (lotClass !== undefined) {
      drafts.push({ number: lotNumberOf(node), texts: [], fields: emptyLot() });
      return;
    }
    const panelClass = classes.find((one) => one.startsWith(PANEL_CLASS_PREFIX));
    if (panelClass === undefined) return;
    const key = panelClass.slice(PANEL_CLASS_PREFIX.length);
    const valueNode = node.find(".col-md-8").first();
    const valueText = cleanText(valueNode.text());
    const draft = drafts[drafts.length - 1];
    if (draft === undefined) {
      panels[key] = valueText;
      if (key === ORGANIZER_PANEL_KEY) organizers.push(readOrganizer(valueNode));
      return;
    }
    draft.texts.push(valueText);
    applyLotPanel(draft.fields, key, valueText, valueNode);
  });

  // Второй живой шаблон печатает срок приёма заявок панелью процедуры, и в лоте
  // такой панели нет вовсе (особенность 6 в шапке). Наследуем: пустая строка в
  // `deadlines.submissionEnd` не записалась бы в `submission_end NOT NULL`, а
  // `isEveryLotExpired` не узнал бы просроченную процедуру и оставил её в ленте
  // живой. Свой срок лота при этом важнее общего — он точнее.
  //
  // Наследование сделано здесь, а не в маппере и не в адаптере, потому что только
  // разбор знает, какие панели стояли на уровне процедуры, а какие — в лоте.
  // Правка в одном месте чинит и публикацию срока, и отсев просрочки.
  const procedureDeadline = fabrikantDateTime(panels[DEADLINE_PANEL_KEY] ?? "");
  if (procedureDeadline !== "") {
    for (const draft of drafts) {
      if (draft.fields.submissionEnd === "") draft.fields.submissionEnd = procedureDeadline;
    }
  }

  const lots = drafts.map((draft) => finishLot(draft));
  return {
    layoutRecognized: drafts.length > 0 || Object.keys(panels).length > 0,
    declaredLotCount: declaredLotCountOf($),
    lotsOnPage: drafts.length,
    panels,
    organizer: organizers[0] ?? null,
    eisNumber: eisNumberOf(panels["external_oos_number_url"] ?? ""),
    lots,
  };
}

/**
 * Сумма в формате площадки: «7 940 042,87 Российский рубль (RUB)» → 7940042.87.
 *
 * Разряды разделены обычным или неразрывным пробелом, десятичная часть — запятой.
 * Берётся первая сумма в тексте: в «Да Размер 5 999 732,02 (5% от НМЦД)» это
 * именно размер обеспечения, а не процент за ним. Числа нет — null, а не нуль:
 * «Без указания цены» и «0,00 ₽» разные факты.
 */
export function fabrikantAmount(value: string): number | null {
  const match = /(\d[\d\u00a0\s]*(?:[.,]\d{1,2})?)/.exec(value);
  if (!match?.[1]) return null;
  const cleaned = match[1].replace(/[\s\u00a0]/g, "").replace(",", ".");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Дата и время площадки («01.10.2026 16:32») → ISO с явным смещением +03:00.
 *
 * Значение панели даты публикации приходит вместе с кнопками истории изменений,
 * поэтому дата ищется внутри текста, а не берётся из него обрезкой. Смещение
 * ставится явно, а не выводится из локальной зоны: прогон живёт на сервере в
 * России, тесты — где угодно, и срок не должен разъезжаться на час. Нечитаемая
 * дата даёт пустую строку, а не «сегодня»: выдуманная дата прошла бы проверку
 * на просроченный срок и попала бы в выдачу.
 */
export function fabrikantDateTime(value: string): string {
  const match = /(\d{2})\.(\d{2})\.(\d{4})(?:\s*(?:в\s*)?(\d{1,2}):(\d{2}))?/.exec(cleanText(value));
  if (!match) return "";
  const [, day, month, year, hours, minutes] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const probe = new Date(Date.UTC(Number(year), monthNumber - 1, dayNumber));
  // «99.99.9999» Date любезно превратит в следующий год; такая дата — не дата.
  if (probe.getUTCMonth() !== monthNumber - 1 || probe.getUTCDate() !== dayNumber) return "";
  if (hours !== undefined || minutes !== undefined) {
    const hourNumber = Number(hours);
    if (!Number.isFinite(hourNumber) || hourNumber > 23) return "";
    if (Number(minutes) > 59) return "";
  }
  const hh = (hours ?? "00").padStart(2, "0");
  const mm = minutes ?? "00";
  return `${year}-${month}-${day}T${hh}:${mm}:00+03:00`;
}

/**
 * Код валюты из названия: «Российский рубль (RUB)» → «RUB».
 *
 * Незнакомая валюта даёт пустую строку, а не рубль по умолчанию: угадывать
 * нечем, а сумма в юанях, записанная рублями, прошла бы фильтр лимита профиля.
 * Решение о валюте по умолчанию принимает маппер, и он его объясняет.
 */
export function fabrikantCurrency(value: string): string {
  const fromBrackets = /\(([A-Z]{3})\)/.exec(value);
  if (fromBrackets?.[1]) return fromBrackets[1];
  const bare = /\b([A-Z]{3})\b/.exec(value);
  return bare?.[1] ?? "";
}

/** Черновик лота, пока панели ещё не кончились. */
interface LotDraft {
  readonly number: number | null;
  /** Тексты всех панелей лота: по ним ищутся ОКПД2, чей ключ нестабилен. */
  readonly texts: string[];
  readonly fields: MutableLot;
}

/** То же, что `FabrikantCardLot`, но заполняется по мере обхода. */
interface MutableLot {
  subject: string;
  price: number | null;
  vatIncluded: boolean | null;
  currency: string;
  submissionEnd: string;
  deliveryRegion: string;
  deliveryDistrict: string;
  deliveryAddress: string;
  bidSecurityText: string;
  contractSecurityText: string;
  onlyForSmp: boolean;
}

/** Пустые поля лота. */
function emptyLot(): MutableLot {
  return {
    subject: "",
    price: null,
    vatIncluded: null,
    currency: "",
    submissionEnd: "",
    deliveryRegion: "",
    deliveryDistrict: "",
    deliveryAddress: "",
    bidSecurityText: "",
    contractSecurityText: "",
    onlyForSmp: false,
  };
}

/** Кладёт значение одной панели лота в черновик. */
function applyLotPanel(
  lot: MutableLot,
  key: string,
  valueText: string,
  valueNode: Selection,
): void {
  switch (key) {
    case "name":
      if (lot.subject === "") lot.subject = valueText;
      return;
    case "lot_price":
      lot.price = fabrikantAmount(valueText);
      lot.vatIncluded = vatFlag(valueText);
      return;
    case "lot_currency":
      lot.currency = fabrikantCurrency(valueText);
      return;
    case DEADLINE_PANEL_KEY:
      if (lot.submissionEnd === "") lot.submissionEnd = fabrikantDateTime(valueText);
      return;
    case DELIVERY_PANEL_KEY:
      readDeliveryPlace(lot, valueNode);
      return;
    case "provision_type":
    case "provision_type_smsp":
      if (lot.bidSecurityText === "") lot.bidSecurityText = valueText;
      return;
    case "provision_contract":
      if (lot.contractSecurityText === "") lot.contractSecurityText = valueText;
      return;
    case "lot_msp":
      if (normalizeLabel(valueText).startsWith("да")) lot.onlyForSmp = true;
      return;
    default:
      return;
  }
}

/** Черновик в неизменяемый лот: здесь же достаются ОКПД2 и обеспечения. */
function finishLot(draft: LotDraft): FabrikantCardLot {
  const lot = draft.fields;
  return {
    number: draft.number,
    subject: lot.subject,
    price: lot.price,
    vatIncluded: lot.vatIncluded,
    currency: lot.currency,
    submissionEnd: lot.submissionEnd,
    deliveryRegion: lot.deliveryRegion,
    deliveryDistrict: lot.deliveryDistrict,
    deliveryAddress: lot.deliveryAddress,
    okpd2Codes: okpd2CodesOf(draft.texts.join("\n")),
    bidSecurityAmount: fabrikantAmount(lot.bidSecurityText),
    contractSecurityAmount: fabrikantAmount(lot.contractSecurityText),
    contractSecurityPercent: percentOf(lot.contractSecurityText),
    onlyForSmp: lot.onlyForSmp,
  };
}

/** Номер закупки в ЕИС из панели `external_oos_number_url`. */
function eisNumberOf(valueText: string): string | null {
  // Панель печатает номер ссылкой, поэтому рядом бывают и другие цифры.
  // 11 знаков — извещение 223-ФЗ, 19 — 44-ФЗ; короче номера в реестре не бывает.
  const match = /\d{11,19}/.exec(valueText);
  return match?.[0] ?? null;
}

/** Число лотов из счётчика вкладки «Список лотов»; null — счётчика нет. */
function declaredLotCountOf($: cheerio.CheerioAPI): number | null {
  const counter = cleanText(findLotsTab($).find(".tab-counter").first().text());
  // «0/0» у вкладки приёма заявок числом не является — и не должен им стать.
  if (!/^\d+$/.test(counter)) return null;
  const parsed = Number.parseInt(counter, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Вкладка «Список лотов»: ищется по названию, а не по классу `active`. */
function findLotsTab($: cheerio.CheerioAPI): Selection {
  return $("li")
    .filter((_index, element) => {
      const title = cleanText($(element).find(".bottom-lined").first().text());
      return title === LOTS_TAB_TITLE;
    })
    .first();
}

/** Номер лота из заголовка контейнера. */
function lotNumberOf(container: Selection): number | null {
  const heading = container.find(".form_label").first().text();
  const source = cleanText(heading) !== "" ? heading : container.text();
  const match = /Лот\s*№\s*(\d+)/.exec(cleanText(source));
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Панель организатора: наименование, почтовый адрес и ИНН.
 *
 * Личных полей здесь уже нет — их вырезал `loadScrubbed` до разбора. КПП тоже
 * не читается: для сопоставления с профилем хватает ИНН, а лишнее поле в домене
 * означало бы лишнее место, где его можно потерять.
 */
function readOrganizer(
  valueNode: Selection,
): FabrikantOrganizer {
  let name = "";
  let postalAddress = "";
  let inn: string | null = null;
  const blocks = valueNode.children("div");
  // Обход по индексу, а не `.each()`: вложенным блокам нужен тот же объект
  // выборки, а передавать `$` параметром в каждый помощник значило бы привязать
  // их сигнатуры к объекту загрузки, который живёт только внутри разбора.
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks.eq(index);
    const label = normalizeLabel(block.children("strong").first().text());
    const valueText = blockValue(block);
    if (label === "") {
      if (name === "" && valueText !== "") name = valueText;
      continue;
    }
    if (label.startsWith("почтовый адрес") || label.startsWith("адрес")) {
      if (postalAddress === "") postalAddress = valueText;
      continue;
    }
    if (label.startsWith("инн")) {
      const digits = /\d{10,12}/.exec(valueText);
      if (inn === null && digits?.[0]) inn = digits[0];
    }
  }
  if (name === "" && blocks.length === 0) name = cleanText(valueNode.text());
  return { name, postalAddress, inn };
}

/**
 * Панель места поставки лота: округ, субъект и адрес.
 *
 * Порядок проверок важен: блок «Код региона по ОКАТО» тоже содержит слово
 * «регион», и без проверки на ОКАТО одиннадцатиначный код попал бы в регион.
 */
function readDeliveryPlace(
  lot: MutableLot,
  valueNode: Selection,
): void {
  const blocks = valueNode.children("div");
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks.eq(index);
    const label = normalizeLabel(block.children("strong").first().text());
    const valueText = blockValue(block);
    if (label === "" || valueText === "") continue;
    if (label.includes("окато")) continue;
    if (label.includes("федеральн")) {
      if (lot.deliveryDistrict === "") lot.deliveryDistrict = valueText;
      continue;
    }
    if (label.includes("регион")) {
      if (lot.deliveryRegion === "") lot.deliveryRegion = valueText;
      continue;
    }
    if (label.includes("место поставки") || label.startsWith("адрес")) {
      if (lot.deliveryAddress === "") lot.deliveryAddress = valueText;
    }
  }
}

/** Значение вложенного блока: текст без подписи. */
function blockValue(block: Selection): string {
  const withoutLabel = block.clone();
  withoutLabel.children("strong").remove();
  return cleanText(withoutLabel.text());
}

/** Коды ОКПД2 из текста панелей лота, без повторов и в порядке появления. */
function okpd2CodesOf(text: string): readonly string[] {
  const codes: string[] = [];
  const pattern = /ОКПД\s*2?\s*(\d{2}(?:\.\d{1,3}){1,4})/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const code = match[1];
    if (code !== undefined && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** Процент из текста вида «(5% от НМЦД)»; null — процента нет. */
function percentOf(text: string): number | null {
  const match = /(\d+(?:[.,]\d+)?)\s*%/.exec(text);
  if (!match?.[1]) return null;
  const parsed = Number.parseFloat(match[1].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Признак НДС в панели цены: «без НДС» проверяется первым. */
function vatFlag(text: string): boolean | null {
  const value = normalizeLabel(text);
  if (value.includes("без ндс")) return false;
  if (value.includes("с ндс")) return true;
  return null;
}

/**
 * Загружает страницу и вырезает из неё то, что читать нельзя.
 *
 * Порядок принципиален: скрипты и личные поля убираются до извлечения текста,
 * а не фильтруются в результате. Значение панели организатора составное, и
 * фильтр по ключу панели или по её подписи «Контактное лицо» внутри не увидел бы.
 */
function loadScrubbed(html: string): cheerio.CheerioAPI {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  for (const key of PERSONAL_PANEL_KEYS) {
    $(`[class*="${PANEL_CLASS_PREFIX}${key}"]`).remove();
  }
  $("strong").each((_index, element) => {
    const node = $(element);
    const label = normalizeLabel(node.text());
    if (!PERSONAL_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))) return;
    const block = node.parent();
    const classes = (block.attr("class") ?? "").split(/\s+/);
    // Блок вырезается целиком, но только если это не сам контейнер значения:
    // иначе вместо имени и телефона исчезла бы вся панель организатора.
    if (block.is("div") && !classes.some((one) => one.startsWith("col-md-"))) {
      block.remove();
      return;
    }
    node.remove();
  });
  return $;
}

/** Текст с одним пробелом вместо любых переводов строк и неразрывных пробелов. */
function cleanText(value: string): string {
  return value.replace(/[\s\u00a0]+/g, " ").trim();
}

/** Подпись к сравнению: нижний регистр, «ё» → «е», пробелы в один, без точки. */
function normalizeLabel(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/:$/, "");
}
