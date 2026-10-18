import type { CompanyProfile, Tender } from "@/domain/entities";

/**
 * Природа закупки: что именно заказчик покупает.
 *
 * Зачем: лента строится по словам профиля («Строительство», «Капитальное
 * строительство»), а слова встречаются не только в подрядных закупках. Замер на
 * ленте владельца 14.10.2026: из 115 показанных закупок 76 (66 %) — «Приобретение
 * в муниципальную собственность … жилого помещения … у Застройщика путём участия
 * в долевом строительстве». Подрядчик в них участвовать не может: продавать
 * квартиры может только застройщик. Совпали они по слову «строительстве», а
 * Fit Score у них 83 — выше настоящих работ (82), поэтому три первые страницы
 * занимали квартиры. Рядом — «мониторинг цен» (коммерческие запросы цен: это не
 * закупка, выиграть её нельзя).
 *
 * Модуль чистый: только текст закупки. Ни сети, ни времени, ни хранилища.
 *
 * Классификатор намеренно консервативен: он обязан отличать «Приобретение …
 * жилого помещения» (недвижимость) от «Выполнение работ по приобретению и
 * установке водогрейных котлов» (работы). Поэтому недвижимость определяется не
 * по слову «приобретение» где-то в тексте, а по глаголу покупки в начале названия
 * и существительному-недвижимости сразу за ним.
 */
export type ProcurementNature =
  | "WORKS"
  | "GOODS"
  | "SERVICES"
  | "REAL_ESTATE"
  | "PRICE_MONITORING"
  | "UNKNOWN";

/** Что скрываем из ленты подрядчика: то, в чём подряд невозможен. */
export type NonContractNature = "REAL_ESTATE" | "PRICE_MONITORING" | "GOODS";

/** Подписи для ленты («не подряд: покупка квартир и помещений, мониторинг цен»). */
export const NON_CONTRACT_LABELS: Record<NonContractNature, string> = {
  REAL_ESTATE: "покупка квартир и помещений",
  PRICE_MONITORING: "мониторинг цен",
  GOODS: "поставка товаров",
};

/** Что классификатору известно о закупке. */
export interface NatureInput {
  subject: string;
  /** Предметы лотов: подключаются, только если по названию природа не ясна. */
  lotSubjects?: readonly string[];
  /** Коды ОКПД2 закупки и лотов: последняя подсказка, когда название ничего не говорит. */
  okpd2Codes?: readonly string[];
}

/* ============================== Нормализация ============================== */

/** Нижний регистр, «ё» → «е», сжатые пробелы, без ведущих кавычек и «Лот № 1». */
function normalize(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[«"'“”„(\s]+/, "")
    .replace(/^лот\s*(?:№|n|n°)?\s*\d+\s*[.:)\-–—]*\s*/, "");
}

/**
 * Начало названия до первой кавычки: «Поставка песка в рамках проекта
 * «Строительство путепровода»» — предмет поставка, а не строительство. Кавычки
 * несут название объекта, а не вид закупки.
 */
function headOf(text: string): string {
  const cut = text.search(/[«"“„]/);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

/* ============================== Правила ============================== */

/**
 * Мониторинг цен, запрос ценовой информации: заказчик собирает цены для своей
 * НМЦ, договор по итогам не заключается. «Запрос цен» без оговорок сюда НЕ
 * входит: в 223-ФЗ и у коммерческих заказчиков это обычная закупочная
 * процедура с победителем, и прятать её нельзя.
 */
const PRICE_MONITORING_RE = new RegExp(
  [
    "(?<![а-я])мониторинг\\s+цен(?![а-я])",
    "(?<![а-я])ценов[а-я0-9]+\\s+мониторинг",
    "запрос\\s+(?:информации\\s+)?о\\s+(?:ценах|стоимости)",
    "запрос\\s+ценов[а-я0-9]+\\s+информаци",
    "запрос\\s+(?:цен|коммерческ[а-я0-9]+\\s+предложени[а-я0-9]+)\\s+(?:с\\s+целью|для)\\s+(?:определени|изучени|формирован|обоснован|анализа)",
    "изучени[а-я0-9]+\\s+(?:рыночн[а-я0-9]+\\s+)?(?:цен|рынка)\\s+(?:с\\s+целью|для)",
  ].join("|"),
);

/** «Выполнение (комплексных …) работ», «Завершение работ»: подрядный заголовок. */
const WORK_HEAD_RE =
  /^(?:выполнение|проведение|осуществление|производство|завершение|ведение)\s+(?:\(?[а-я0-9-]+\)?\s+){0,6}?работ(?![а-я])/;

/** Название начинается со слова «работы» («Работы по монтажу септических систем»). */
const WORKS_NOUN_HEAD_RE = /^работ[ыа]?(?![а-я])/;

/** Глаголы покупки в начале названия. */
const ACQUIRE_HEAD_RE =
  /^(?:приобретение|покупка|закупка|выкуп|купля-продажа|покупка-продажа)(?![а-я])\s*/;

/** Глаголы аренды в начале названия (в том числе «Оказание услуг по аренде»). */
const RENT_HEAD_RE =
  /^(?:(?:оказание\s+услуг\s+по\s+|услуги\s+по\s+)?(?:аренд[аеуы]|найм[а]?|субаренд[аеуы])|предоставление\s+(?:в\s+(?:аренду|пользование)|права\s+аренды)|право\s+аренды)(?![а-я])\s*/;

/**
 * Слова между глаголом покупки и существительным-недвижимостью: «в муниципальную
 * собственность благоустроенного жилого помещения». Список закрытый: любое
 * другое слово («дверей», «оборудования») обрывает разбор — «Приобретение дверей
 * в помещения» недвижимостью не является.
 */
const ESTATE_FILLER_RE =
  /^(?:в|во|на|для|у|из|не|менее|более|общей|площадью|кв\.?м\.?|кв\.?|м2|м²|муниципальн[а-я0-9]*|государственн[а-я0-9]*|федеральн[а-я0-9]*|республиканск[а-я0-9]*|собственност[а-я0-9]*|благоустроенн[а-я0-9]*|жил[а-я0-9]*|нежил[а-я0-9]*|свободн[а-я0-9]*|готов[а-я0-9]*|новостро[а-я0-9]*|вторичн[а-я0-9]*|отдельн[а-я0-9]*|изолированн[а-я0-9]*|многоквартирн[а-я0-9]*|офисн[а-я0-9]*|складск[а-я0-9]*|торгов[а-я0-9]*|производственн[а-я0-9]*|административн[а-я0-9]*|земельн[а-я0-9]*|\d+-?[а-я0-9]*комнатн[а-я0-9]*|[а-я0-9]*комнатн[а-я0-9]*|[\d.,]+)$/;

/** Существительное, делающее закупку покупкой или арендой недвижимости. */
const ESTATE_NOUN_RE =
  /^(?:помещени[а-я0-9]*|квартир[а-я0-9]*|комнат[а-я0-9]*|жиль[яеёю]|недвижим[а-я0-9]*|здани[а-я0-9]*|дом|дома|домов|домах|доме|участок|участк[а-я0-9]*|апартамент[а-я0-9]*|коттедж[а-я0-9]*|офис[а-я0-9]*|склад[а-я0-9]*|имуществ[а-я0-9]*)$/;

/**
 * Идёт ли за глаголом (первые ≤ 8 слов) недвижимость: допустимые слова-связки,
 * затем существительное.
 */
function acquiresEstate(rest: string): boolean {
  const tokens = rest.split(/[\s,;()]+/).filter((t) => t !== "");
  for (const token of tokens.slice(0, 8)) {
    if (ESTATE_NOUN_RE.test(token)) return true;
    if (!ESTATE_FILLER_RE.test(token)) return false;
  }
  return false;
}

/** Покупка или аренда недвижимости. */
function isRealEstate(text: string): boolean {
  // «Участие в долевом строительстве» — всегда покупка квартиры у застройщика.
  if (/долев[а-я0-9]+\s+строительств/.test(text)) return true;
  if (/(?:договор[а-я0-9]*\s+)?купли-продажи\s+(?:[а-я0-9]+\s+){0,3}(?:помещени|квартир|недвижим|здани|жил)/.test(text)) {
    return true;
  }
  const acquire = ACQUIRE_HEAD_RE.exec(text);
  if (acquire !== null) return acquiresEstate(text.slice(acquire[0].length));
  const rent = RENT_HEAD_RE.exec(text);
  if (rent !== null) return acquiresEstate(text.slice(rent[0].length));
  return false;
}

/** Строительные слова: если они в названии, это подряд, а не поставка и не услуга. */
const STRONG_WORKS_RE =
  /строительств|строительн|реконструкц|ремонт|монтаж|демонтаж|благоустройств|устройств|обустройств|прокладк|укладк|восстановител|(?<![а-я])снос|кровл|газификац|пусконаладк|установк|изыскан|проектирован|проектно|модернизац|озеленен|асфальт|окраск|покраск|штукатур|утеплен|остеклен|гидроизоляц|отделочн|земляные/;

/** Услуги по обслуживанию, не по строительству: уборка, вывоз, охрана, оборудование. */
const SERVICE_GUARD_RE =
  /лифт|медицинск|оборудовани|автомобил|транспорт|техник|обслуживани|эксплуатац|охран|уборк|вывоз|отход|аренд|страхов|связи|питани|обучени|программ|сервер|компьютер|принтер|картридж|кондиционер/;

/** Объекты, к которым применимы строительные работы (отличает «ремонт кровли» от «ремонта лифта»). */
const BUILT_OBJECT_RE =
  /здани|помещени|кровл|фасад|дорог|покрыти|ограждени|сооружени|объект|территори|сет[ьиейях]|трубопровод|газопровод|водопровод|канализац|отоплени|мост|площадк|тротуар|колодц|скважин|школ|больниц|котельн/;

const SERVICES_HEAD_RE = /^(?:оказание|предоставление)\s+(?:\(?[а-я0-9-]+\)?\s+){0,3}?услуг|^услуг[аи](?![а-я])/;

const GOODS_HEAD_RE =
  /^(?:поставк[аиу]|приобретение|закупка|покупка|продажа|реализация|изготовление|лизинг)(?![а-я])/;

/** «Поставка и монтаж …»: поставщик с монтажом — работы, подрядчик может участвовать. */
const INSTALL_RE = /монтаж|установк|пусконаладк|строительно-монтаж/;

/*
  …кроме монтажа мебели, медицинского, спортивного, учебного и офисного оборудования: это
  поставщик с установкой, а не строительный подряд. «Поставка и монтаж медицинской мебели на
  объект капитального строительства» стояла первой в сводке подрядчика (16.10.2026).
  Инженерные системы (котельная, отопление, вентиляция, сети) — по-прежнему работы.
*/
const MOVABLE_GOODS_RE =
  /мебел|медицинск|спортивн|игров|учебн|лабораторн|офисн|оргтехник|компьютер|мониторов|видеонаблюден|интерактивн|бытов|кухонн|торгов|стеллаж|инвентар|тренажер/;
const ENGINEERING_SYSTEMS_RE = /котельн|котл|отоплен|вентиляц|кондиционир|водоснабж|канализац|газ|электроснабж|тепл|лифт|подъемник|наружн|сет[ьиейях]/;

const GOODS_FALLBACK_RE = /поставк|приобретен|закупк|товар|оборудовани|материал|продукци/;
const SERVICES_FALLBACK_RE = /услуг|обслуживани|охран|уборк|аренд|страхован/;

/**
 * Природа по названию. Порядок проверок важен и зафиксирован тестами:
 * мониторинг цен → «Выполнение работ» → недвижимость → «Оказание услуг» →
 * «Поставка / Приобретение» → строительные слова → прочее.
 */
function classifySubject(raw: string): ProcurementNature {
  const text = normalize(raw);
  if (text === "") return "UNKNOWN";
  const head = headOf(text) || text;

  if (PRICE_MONITORING_RE.test(text)) return "PRICE_MONITORING";

  // «Выполнение работ по приобретению и установке котлов» — работы, а не покупка.
  if (WORK_HEAD_RE.test(head) || WORKS_NOUN_HEAD_RE.test(head)) {
    // Уборка, вывоз, охрана названы «работами» заказчиком, но подряда не требуют.
    if (SERVICE_GUARD_RE.test(head) && !STRONG_WORKS_RE.test(head)) return "SERVICES";
    return "WORKS";
  }

  if (isRealEstate(head)) return "REAL_ESTATE";

  if (SERVICES_HEAD_RE.test(head)) {
    // «Оказание услуг по капитальному ремонту здания» — подряд, хотя назван услугами;
    // «услуги по ремонту лифтов» и «по транспортировке отходов» — нет.
    return STRONG_WORKS_RE.test(head) && BUILT_OBJECT_RE.test(head) && !SERVICE_GUARD_RE.test(head)
      ? "WORKS"
      : "SERVICES";
  }

  if (GOODS_HEAD_RE.test(head)) {
    if (!INSTALL_RE.test(head)) return "GOODS";
    return MOVABLE_GOODS_RE.test(head) && !ENGINEERING_SYSTEMS_RE.test(head) ? "GOODS" : "WORKS";
  }

  if (STRONG_WORKS_RE.test(head)) return "WORKS";
  if (GOODS_FALLBACK_RE.test(head)) return "GOODS";
  if (SERVICES_FALLBACK_RE.test(head)) return "SERVICES";
  // Название начиналось с кавычки или не сказало ничего — читаем целиком.
  if (head !== text) {
    if (STRONG_WORKS_RE.test(text)) return "WORKS";
  }
  return "UNKNOWN";
}

/** Подсказка по ОКПД2, когда название ничего не сказало. */
function natureFromOkpd2(codes: readonly string[]): ProcurementNature {
  for (const code of codes) {
    const c = code.trim();
    if (/^(?:41|42|43)\./.test(c) || /^71\.1/.test(c)) return "WORKS";
    if (/^68\.[12]/.test(c)) return "REAL_ESTATE";
  }
  return "UNKNOWN";
}

/** Природа закупки по названию, лотам и ОКПД2. */
export function classifyProcurementNature(input: NatureInput): ProcurementNature {
  const bySubject = classifySubject(input.subject);
  if (bySubject !== "UNKNOWN") return bySubject;
  for (const lot of input.lotSubjects ?? []) {
    const byLot = classifySubject(lot);
    if (byLot !== "UNKNOWN") return byLot;
  }
  return natureFromOkpd2(input.okpd2Codes ?? []);
}

const natureCache = new WeakMap<Tender, ProcurementNature>();

/** Природа закупки из ленты; считается один раз на объект закупки. */
export function tenderNature(tender: Tender): ProcurementNature {
  const cached = natureCache.get(tender);
  if (cached !== undefined) return cached;
  const nature = classifyProcurementNature({
    subject: tender.subject,
    lotSubjects: tender.lots.map((lot) => lot.subject),
    okpd2Codes: [...tender.okpd2Codes, ...tender.lots.flatMap((lot) => lot.okpd2Codes)],
  });
  natureCache.set(tender, nature);
  return nature;
}

/* ============================== Намерение человека ============================== */

/** Слова запроса о строительстве и ремонте: человек ищет подряд. */
const WORKS_QUERY_RE =
  /строит|строй|ремонт|реконструкц|монтаж|демонтаж|благоустро|подряд|проектир|изыскан|отделочн|кровл|дорожн|капитальн|(?<![а-я])работ/;

/**
 * Ищет ли человек подряд: в его словах (строка поиска и ключевые слова профиля)
 * есть строительные и ремонтные слова.
 */
export function queryIsAboutWorks(words: readonly string[]): boolean {
  return words.some((word) => WORKS_QUERY_RE.test(word.toLowerCase().replace(/ё/g, "е")));
}

/** Лента про подряд: слова запроса строительные или компания — подрядчик. */
export function worksIntent(words: readonly string[], contractor: boolean): boolean {
  return contractor || queryIsAboutWorks(words);
}

/** Строительные слова в описании деятельности компании. */
const CONTRACTOR_TEXT_RE =
  /строител|строительн|капитальн[а-я0-9]*\s+ремонт|ремонт[а-я0-9]*\s+(?:здани|помещени|кровл|дорог)|реконструкц|благоустро|подряд|(?<![а-я])смр(?![а-я])|дорожн/;

/**
 * Подрядчик ли компания. Признак — ОКПД2 41–43, членство в СРО или строительные
 * слова в описании деятельности и перечне работ. Слово «монтаж» само по себе не
 * считается: монтаж локальных сетей делает и поставщик оргтехники.
 */
export function profileIsContractor(profile: CompanyProfile): boolean {
  if (profile.sroMemberships.length > 0) return true;
  if (profile.capabilities.okpd2Codes.some((code) => /^(?:41|42|43)(?:\.|$)/.test(code.trim()))) {
    return true;
  }
  const text = [profile.activityDescription, ...profile.capabilities.works]
    .join(" ")
    .toLowerCase()
    .replace(/ё/g, "е");
  return CONTRACTOR_TEXT_RE.test(text);
}

/** Человек сам просит квартиры и недвижимость: тогда они не прячутся. */
const ASKS_REAL_ESTATE_RE =
  /квартир|жил[а-я]*\s+помещени|жиль[яеёю]|недвижим|долев|застройщик|приобретени|покупк|куплю|аренд|выкуп/;

/** Человек сам ищет поставки: тогда товары в ленте подрядчика не прячутся. */
const ASKS_GOODS_RE = /поставк|оборудовани|мебел|материал|товар|продукци|приобретени|закупк/;

/** Человек сам просит мониторинг цен и запросы ценовой информации. */
const ASKS_PRICE_MONITORING_RE = /мониторинг|запрос\s+(?:цен|информации|коммерческ)|коммерческ[а-я0-9]+\s+предложени/;

/**
 * Почему закупку прячем из ленты подрядчика, или null, если не прячем.
 *
 * Прячем, только когда лента про подряд (слова запроса строительные или
 * компания — подрядчик) и человек сам не просил именно это: слова «квартиры»,
 * «мониторинг цен» в его запросе возвращают такие закупки в выдачу.
 */
export function nonContractReason(
  tender: Tender,
  query: { words: readonly string[]; contractor: boolean },
): NonContractNature | null {
  const nature = tenderNature(tender);
  if (nature !== "REAL_ESTATE" && nature !== "PRICE_MONITORING" && nature !== "GOODS") return null;
  if (!worksIntent(query.words, query.contractor)) return null;
  // Поставки прячутся только у подрядчика: строительные слова в запросе без профиля подрядчика
  // («ремонт» у поставщика стройматериалов) ещё не значат, что товары ему не нужны.
  if (nature === "GOODS" && !query.contractor) return null;
  const asked = query.words.join(" ").toLowerCase().replace(/ё/g, "е");
  const askedFor =
    nature === "REAL_ESTATE" ? ASKS_REAL_ESTATE_RE : nature === "GOODS" ? ASKS_GOODS_RE : ASKS_PRICE_MONITORING_RE;
  return askedFor.test(asked) ? null : nature;
}

/**
 * Подпись причины для ленты: «не подряд: покупка квартир и помещений, мониторинг цен».
 * Перечисляет только то, что действительно скрыто.
 */
export function nonContractLabel(counts: Partial<Record<NonContractNature, number>>): string {
  const parts = (Object.keys(NON_CONTRACT_LABELS) as NonContractNature[])
    .filter((nature) => (counts[nature] ?? 0) > 0)
    .map((nature) => NON_CONTRACT_LABELS[nature]);
  return `не подряд: ${parts.join(", ")}`;
}

/** Сколько закупок спрятано по каждой причине. */
export interface HiddenCounts {
  /** Вне условий профиля поиска (заказчики, цена). */
  limits: number;
  /** Оценка «Не подходит» по профилю компании. */
  fit: number;
  /** Не подряд: покупка квартир, мониторинг цен. */
  nature: Partial<Record<NonContractNature, number>>;
}

/**
 * Скобка после «Скрыто как неподходящее: N»: причины и числа.
 *
 * Одна причина называется без числа (оно уже в начале строки), несколько —
 * каждая со своим числом. Пустая причина не упоминается вовсе.
 */
export function hiddenReasonsText(counts: HiddenCounts): string {
  const natureTotal = Object.values(counts.nature).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  const reasons: { text: string; count: number }[] = [];
  if (counts.limits > 0) reasons.push({ text: "вне профиля поиска", count: counts.limits });
  if (counts.fit > 0) reasons.push({ text: "не подходят компании", count: counts.fit });
  if (natureTotal > 0) reasons.push({ text: nonContractLabel(counts.nature), count: natureTotal });
  if (reasons.length === 0) return "";
  if (reasons.length === 1) return ` (${reasons[0]!.text})`;
  return ` (${reasons.map((r) => `${r.text} — ${String(r.count)}`).join(", ")})`;
}
