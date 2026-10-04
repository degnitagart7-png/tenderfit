import type {
  CompanyProfile,
  ExperienceRecord,
  ExperienceTotals,
  HardBlocker,
  SroMembership,
  Tender,
  TenderRequirement,
  Uncertainty,
} from "@/domain/entities";
import { isPriceKnown } from "@/domain/entities";
import { SRO_KIND_LABELS, sroLevelLimit, type SroKind } from "@/domain/enums";
import { buildSubjectText } from "@/domain/scoring/tenderText";

/**
 * Проверки допуска участника: СРО (вид работ, уровень ответственности, лимит
 * суммы договора), кадры (численность, специалисты в НРС и НОПРИЗ) и опыт
 * (число контрактов и суммы за период).
 *
 * Все функции чистые: время передаётся параметром `now`, Date.now() внутри
 * не используется. Модуль не импортирует scoring/index.ts — наоборот,
 * скоринг и разбор требований пользуются этими проверками.
 *
 * Принцип: блокер ставится только там, где вывод однозначен. Эвристика по
 * наименованию закупки может ошибаться, поэтому спорные случаи уходят
 * в неопределённости (ручная проверка), а не в «не рекомендовано».
 */

/* ============================== 1. Вид работ по предмету закупки ============================== */

/**
 * Маркеры, после которых в наименовании идёт не предмет договора, а объект,
 * проект или назначение поставки. Природу договора определяет голова
 * наименования: «Поставка материалов | для капитального ремонта котла № 3»,
 * «Поставка снаряжения | в рамках реализации проекта „Реконструкция ТЭЦ“».
 * Хвост за первым маркером в поиске признаков работ не участвует — иначе
 * любая поставка на стройку читалась бы как строительный подряд.
 */
/**
 * Граница слова `\b` в JS определяется через [A-Za-z0-9_], поэтому на
 * кириллице она не срабатывает: маркеры перечислены без `\b`, начало
 * отделяется пробелом, а продолжение слова отсекает список форм.
 */
const HEAD_CUT_MARKERS: readonly RegExp[] = [
  /\sрамках/giu,
  /\sпо\s+проекту/giu,
  /\s(?:на|по)\s+объект/giu,
  /\sдля\s+(?:объекта|реализации|нужд|ремонта|капитального\s+ремонта|строительства)/giu,
  /\sпри\s+строительстве/giu,
  /\sв\s+целях/giu,
];

/**
 * Словосочетания, где «строительный» — прилагательное при товаре, а не вид
 * работ: «поставка стальных строительных конструкций». Убираются до поиска
 * признаков, иначе поставка материалов читается как строительный подряд.
 */
const MATERIAL_COLLOCATIONS =
  /\sстроительн[а-яё]*\s+(?:конструкц|материал|издели|детал|товар|смес|инструмент|оборудован)[а-яё]*/giu;

/** Обрезает текст до первого маркера объекта/проекта/назначения. */
function cutToHead(text: string): string {
  let cut = text.length;
  for (const marker of HEAD_CUT_MARKERS) {
    // Глобальный флаг хранит lastIndex между вызовами — сбрасываем явно.
    marker.lastIndex = 0;
    const match = marker.exec(text);
    if (match !== null && match.index < cut) cut = match.index;
  }
  return text.slice(0, cut);
}

/**
 * Названия проектов в кавычках упоминают строительство, но предметом договора
 * оно не является: «Поставка железобетонных изделий в рамках реализации
 * проекта „Строительство 2-й очереди ГРЭС“» — это поставка, допуск СРО не нужен.
 * Кавычки убираются первыми, затем отбрасывается хвост про объект и проект.
 */
function normalizeSubject(subject: string): string {
  const withoutQuotes = subject
    .replace(/«[^»]*»/gu, " ")
    .replace(/"[^"]*"/gu, " ")
    .toLowerCase();
  return cutToHead(withoutQuotes).replace(MATERIAL_COLLOCATIONS, " ");
}

/** Признаки строительных работ. */
const CONSTRUCTION_HINTS = [
  "строительно-монтаж",
  "строител",
  "реконструкц",
  "капитальн",
  "капремонт",
  "пусконалад",
  "смр",
  "устройств",
  "подряд",
  "монтаж",
  "ремонт",
] as const;

/**
 * Объекты, работы на которых требуют допуска СРО. Используются, чтобы отличить
 * капитальный ремонт здания от капитального ремонта автомобиля.
 */
const CONSTRUCTION_OBJECTS = [
  "здан",
  "сооружен",
  "помещен",
  "дорог",
  "дорож",
  "теплов",
  "котельн",
  "канализ",
  "водоснаб",
  "водоотведен",
  "кровл",
  "фасад",
  "жилищн",
  "мост",
  "путепровод",
  "трубопровод",
  "подстанц",
  "лэп",
  "электросет",
  "инженерн",
  "объекте строительства",
] as const;

/**
 * Предметы, работы с которыми не являются строительными: техника и транспорт,
 * расходники, рекламные конструкции. Их ремонт и монтаж допуска СРО не требуют.
 */
const EQUIPMENT_VETO = [
  "транспорт",
  "автомобил",
  "суд",
  "картридж",
  "оргтехник",
  "томограф",
  "кондиционер",
  "оборудовани",
  "принтер",
  "мфу",
  "сервер",
  "компьютер",
  "вычислительной техники",
  "баннер",
  "вывеск",
  "реклам",
] as const;

const DESIGN_HINTS = [
  "проектиров",
  "проектн",
  "проектно",
  "сметн",
  "рабочей документации",
  "рабочая документация",
  "рабочую документацию",
] as const;

const SURVEY_HINTS = [
  "изыскан",
  "геолог",
  "геодез",
  "топограф",
  "обследован",
] as const;

const hasAny = (text: string, needles: readonly string[]): boolean =>
  needles.some((n) => text.includes(n));

/**
 * Определяет виды работ, на которые нужен допуск СРО, по предмету закупки.
 * Возвращает пустой массив, если закупка не про строительные, проектные
 * или изыскательские работы (поставка, услуги, ремонт техники).
 */
export function detectSroKinds(subjectText: string): SroKind[] {
  const text = normalizeSubject(subjectText);
  const kinds: SroKind[] = [];

  if (hasAny(text, DESIGN_HINTS)) kinds.push("DESIGN");
  if (hasAny(text, SURVEY_HINTS)) kinds.push("SURVEY");

  const constructionHint = hasAny(text, CONSTRUCTION_HINTS);
  const vetoed = hasAny(text, EQUIPMENT_VETO);
  const onObject = hasAny(text, CONSTRUCTION_OBJECTS);
  if (constructionHint && (onObject || !vetoed)) kinds.push("CONSTRUCTION");

  return kinds;
}

/* ============================== 2. Допуски профиля ============================== */

/** Определяет вид допуска по тексту наименования («Строительство», «Проектирование»). */
export function inferSroKind(type: string): SroKind {
  const text = type.toLowerCase();
  if (hasAny(text, DESIGN_HINTS)) return "DESIGN";
  if (hasAny(text, SURVEY_HINTS)) return "SURVEY";
  if (hasAny(text, ["строитель", "реконструк", "капитальн", "ремонт"])) {
    return "CONSTRUCTION";
  }
  return "OTHER";
}

/** Определяет вид допуска: сначала явное поле, затем текст наименования. */
export function sroKindOf(membership: SroMembership): SroKind {
  if (membership.kind && membership.kind !== "OTHER") return membership.kind;
  return inferSroKind(membership.type);
}

/** Действует ли членство: подтверждено и не просрочено. */
export function isSroActive(membership: SroMembership, now: Date): boolean {
  if (!membership.confirmed) return false;
  if (!membership.validUntil) return true;
  const until = new Date(membership.validUntil).getTime();
  if (Number.isNaN(until)) return true;
  return until >= now.getTime();
}

/**
 * Предельная стоимость договора по допуску: явный лимит из профиля,
 * иначе — лимит уровня ответственности по ст. 55.16 ГрК РФ.
 */
export function effectiveSroLimit(membership: SroMembership): number | null {
  if (membership.maxContractAmount !== null) return membership.maxContractAmount;
  return sroLevelLimit(sroKindOf(membership), membership.responsibilityLevel);
}

/** Действующий допуск профиля нужного вида (первый подходящий). */
export function findSroByKind(
  profile: CompanyProfile,
  kind: SroKind,
  now: Date,
): SroMembership | undefined {
  return profile.sroMemberships.find(
    (m) => isSroActive(m, now) && sroKindOf(m) === kind,
  );
}

/** Просроченные членства в СРО — их надо показать пользователю отдельно. */
export function expiredSroMemberships(
  profile: CompanyProfile,
  now: Date,
): SroMembership[] {
  return profile.sroMemberships.filter(
    (m) => m.confirmed && !isSroActive(m, now),
  );
}

/**
 * Есть ли в профиле действующий допуск, которым можно подтвердить заявку.
 * Мягче, чем `checkSroAdmission`: достаточно одного подходящего вида работ,
 * спорные сочетания остаются на ручной проверке. Используется для признака
 * «выписка из реестра членов СРО подтверждена в профиле».
 */
export function hasAdmissibleSro(
  tender: Tender,
  profile: CompanyProfile,
  now: Date,
): boolean {
  const active = profile.sroMemberships.filter((m) => isSroActive(m, now));
  if (active.length === 0) return false;
  const kinds = detectSroKinds(buildSubjectText(tender));
  if (kinds.length === 0) return true;
  const price = tender.financial.price;
  return kinds.some((kind) => {
    const membership = active.find((m) => sroKindOf(m) === kind);
    if (!membership) return false;
    const limit = effectiveSroLimit(membership);
    return limit === null || !isPriceKnown(price) || price <= limit;
  });
}

/* ============================== 3. Проверка допуска СРО ============================== */

export interface SroLimitShortfall {
  kind: SroKind;
  membership: SroMembership;
  limit: number;
}

export interface SroAdmissionCheck {
  /** Виды работ, найденные в предмете закупки. */
  kinds: SroKind[];
  /** Виды, покрытые действующим допуском профиля. */
  covered: SroKind[];
  /** Покрытые виды, чей лимит меньше цены закупки. */
  shortfalls: SroLimitShortfall[];
  /** Однозначное нарушение — основание для критического блокера. */
  blocker: HardBlocker | null;
  /** Спорные случаи — основание для ручной проверки. */
  uncertainties: Uncertainty[];
}

/**
 * Проверяет закупку на соответствие допускам СРО профиля.
 *
 * Блокер ставится в двух однозначных случаях:
 * 1. все найденные виды работ покрыты допусками, но цена закупки выше лимита
 *    каждого из них — уровень ответственности не позволяет взять договор;
 * 2. в профиле есть допуски СРО, но ни один не подходит под вид работ закупки.
 * Если допусков в профиле нет вовсе, проверка по предмету не выполняется:
 * утверждать, что компания обязана состоять в СРО, система не может.
 */
export function checkSroAdmission(
  tender: Tender,
  profile: CompanyProfile,
  now: Date,
): SroAdmissionCheck {
  const kinds = detectSroKinds(buildSubjectText(tender));
  const price = tender.financial.price;
  const uncertainties: Uncertainty[] = [];

  const empty: SroAdmissionCheck = {
    kinds,
    covered: [],
    shortfalls: [],
    blocker: null,
    uncertainties,
  };
  if (kinds.length === 0) return empty;

  const activeMemberships = profile.sroMemberships.filter((m) => isSroActive(m, now));
  const covered: SroKind[] = [];
  const shortfalls: SroLimitShortfall[] = [];

  for (const kind of kinds) {
    const membership = activeMemberships.find((m) => sroKindOf(m) === kind);
    if (!membership) continue;
    covered.push(kind);
    const limit = effectiveSroLimit(membership);
    if (limit !== null && isPriceKnown(price) && price > limit) {
      shortfalls.push({ kind, membership, limit });
    }
  }

  // Просроченный допуск — это всегда неопределённость, даже если вид работ не наш.
  const expired = expiredSroMemberships(profile, now);
  // Допуск нужного вида есть в профиле, но не действует: срок истёк или
  // членство не подтверждено выпиской.
  const lapsed = profile.sroMemberships.filter(
    (m) => !isSroActive(m, now) && kinds.includes(sroKindOf(m)),
  );
  for (const item of expired) {
    // Про допуск нужного вида сообщается отдельно и конкретнее.
    if (lapsed.some((m) => m.id === item.id)) continue;
    uncertainties.push({
      id: `${tender.id}-unc-sro-expired-${item.id}`,
      question: "Действует ли членство в СРО?",
      detail: `Срок членства «${item.type || item.number}» истёк ${item.validUntil ?? ""}. Нужна действующая выписка из реестра членов СРО.`,
      evidenceId: null,
      material: true,
    });
  }

  // Ни один вид работ не покрыт, хотя допуски в профиле есть.
  if (covered.length === 0) {
    if (activeMemberships.length === 0) {
      return { ...empty, covered, shortfalls, uncertainties };
    }
    if (lapsed.length > 0) {
      // Отказывать по недействующей выписке нельзя: документ мог быть продлён.
      uncertainties.push({
        id: `${tender.id}-unc-sro-lapsed`,
        question: "Действует ли допуск СРО нужного вида?",
        detail: `Закупка относится к работам: ${sroKindsLabel(kinds)}. В профиле указан допуск «${lapsed
          .map((m) => m.type || m.number)
          .join(", ")}», но он не действует — истёк срок или не подтверждён выпиской. Нужна актуальная выписка из реестра членов СРО.`,
        evidenceId: null,
        material: true,
      });
      return { kinds, covered, shortfalls, blocker: null, uncertainties };
    }
    return {
      kinds,
      covered,
      shortfalls,
      blocker: {
        id: `${tender.id}-block-sro-kind`,
        reason: "Нет допуска СРО требуемого вида",
        detail: `Закупка относится к работам: ${sroKindsLabel(kinds)}. В профиле подтверждены допуски других видов: ${activeMemberships
          .map((m) => m.type || m.number)
          .join(", ")}.`,
        evidenceId: null,
        critical: true,
      },
      uncertainties,
    };
  }

  // Цена выше лимита по всем найденным видам — участвовать нельзя.
  if (covered.length === kinds.length && shortfalls.length === covered.length) {
    const worst = shortfalls.reduce((a, b) => (b.limit > a.limit ? b : a));
    const level = worst.membership.responsibilityLevel
      ? ` (${worst.membership.responsibilityLevel}-й уровень ответственности)`
      : "";
    return {
      kinds,
      covered,
      shortfalls,
      blocker: {
        id: `${tender.id}-block-sro-limit`,
        reason: "Недостаточный уровень ответственности СРО",
        detail: `Цена ${price.toLocaleString("ru-RU")} ₽ выше предела ${worst.limit.toLocaleString("ru-RU")} ₽ по допуску «${worst.membership.type || worst.membership.number}»${level}. Нужен более высокий уровень ответственности.`,
        evidenceId: null,
        critical: true,
      },
      uncertainties,
    };
  }

  // Часть видов не покрыта или лимит спорный — оставляем на ручную проверку.
  if (covered.length < kinds.length || shortfalls.length > 0) {
    const first = shortfalls[0];
    const shortfallNote = first
      ? `. По допуску «${first.membership.type || first.membership.number}» цена превышает лимит ${(first.limit ?? 0).toLocaleString("ru-RU")} ₽`
      : "";
    uncertainties.push({
      id: `${tender.id}-unc-sro-mixed`,
      question: "Какой допуск СРО требует закупка?",
      detail: `В предмете закупки сочетаются работы: ${sroKindsLabel(kinds)}; допуском профиля покрыты: ${sroKindsLabel(covered)}${shortfallNote}. Проверьте требование в документации.`,
      evidenceId: null,
      material: true,
    });
  }

  return { kinds, covered, shortfalls, blocker: null, uncertainties };
}

/** Человекочитаемое название вида работ СРО. */
export function sroKindLabel(kind: SroKind): string {
  return SRO_KIND_LABELS[kind].toLowerCase();
}

/** Список видов работ одной строкой. */
export function sroKindsLabel(kinds: SroKind[]): string {
  if (kinds.length === 0) return "не определены";
  return kinds.map((k) => sroKindLabel(k)).join(", ");
}

/**
 * Краткое описание позиции компании по допуску СРО для данной закупки:
 * какие виды работ требуются и что за допуск подтверждён в профиле
 * (уровень ответственности, предел стоимости договора, хватает ли его).
 * null — закупка не относится к работам, требующим членства в СРО.
 */
export function describeSroPosition(
  tender: Tender,
  profile: CompanyProfile,
  now: Date,
): string | null {
  const kinds = detectSroKinds(buildSubjectText(tender));
  if (kinds.length === 0) return null;

  const active = profile.sroMemberships.filter((m) => isSroActive(m, now));
  const price = tender.financial.price;
  const parts = kinds.map((kind) => {
    const membership = active.find((m) => sroKindOf(m) === kind);
    if (!membership) {
      return `${sroKindLabel(kind)} — допуска в профиле нет`;
    }
    const limit = effectiveSroLimit(membership);
    const level = membership.responsibilityLevel
      ? `${membership.responsibilityLevel}-й уровень ответственности, `
      : "";
    const limitText =
      limit === null
        ? "предел стоимости не указан"
        : `предел ${limit.toLocaleString("ru-RU")} ₽`;
    const enough = limit === null || !isPriceKnown(price) || price <= limit;
    const name = membership.type || membership.number || "членство в СРО";
    return `${sroKindLabel(kind)} — «${name}» (${level}${limitText})${enough ? "" : ": цена закупки выше предела"}`;
  });

  return `Виды работ по предмету закупки: ${sroKindsLabel(kinds)}. ${parts.join("; ")}.`;
}

/* ============================== 4. Опыт: суммы и число контрактов ============================== */

const MS_PER_DAY = 86_400_000;

/**
 * Суммы исполненных контрактов за год и за 3 года по записям опыта.
 * Если записей нет вовсе — null: отличаем «нет данных» от «ноль».
 */
export function computeExperienceTotals(
  records: ExperienceRecord[],
  now: Date,
): ExperienceTotals {
  if (records.length === 0) {
    return { lastYearAmount: null, last3YearsAmount: null };
  }
  const from = (years: number): number =>
    now.getTime() - years * 365 * MS_PER_DAY;
  let lastYear = 0;
  let last3Years = 0;
  for (const record of records) {
    const completed = new Date(record.completedAt).getTime();
    if (Number.isNaN(completed)) continue;
    if (completed >= from(1) && completed <= now.getTime()) {
      lastYear += record.amount;
    }
    if (completed >= from(3) && completed <= now.getTime()) {
      last3Years += record.amount;
    }
  }
  return { lastYearAmount: lastYear, last3YearsAmount: last3Years };
}

/**
 * Совокупный опыт профиля: заявленные суммы (их указывает анкета контрагента)
 * приоритетнее рассчитанных по отдельным контрактам.
 */
export function resolveExperienceTotals(
  profile: CompanyProfile,
  now: Date,
): ExperienceTotals {
  const computed = computeExperienceTotals(profile.experience, now);
  // Профили, сохранённые до появления слоя experienceTotals (и демо-профиль),
  // приходят без него: declared-значений нет, работаем по вычисленным.
  const declared = profile.experienceTotals ?? computed;
  return {
    lastYearAmount: declared.lastYearAmount ?? computed.lastYearAmount,
    last3YearsAmount: declared.last3YearsAmount ?? computed.last3YearsAmount,
  };
}

export interface ExperienceThreshold {
  /** Минимальное число исполненных контрактов. */
  minContracts: number | null;
  /** Минимальная совокупная сумма исполненных контрактов, ₽. */
  minAmount: number | null;
  /** Минимальная сумма одного контракта, ₽ («по контрактам от 3 млн ₽»). */
  minSingleContractAmount: number | null;
  /** Период, за который считается опыт, в годах. */
  periodYears: number | null;
  /** Фрагмент требования, из которого извлечён порог. */
  source: string;
}

const MONEY_UNITS: Record<string, number> = {
  тыс: 1_000,
  тысяч: 1_000,
  млн: 1_000_000,
  миллион: 1_000_000,
  млрд: 1_000_000_000,
  миллиард: 1_000_000_000,
  руб: 1,
  рублей: 1,
  // Ключ-символ в кавычках: ₽ не является допустимым началом идентификатора.
  "₽": 1,
};

/** Слова, рядом с которыми число читается как сумма, а не как счёт или срок. */
const MONEY_CONTEXT = [
  "руб",
  "₽",
  "млн",
  "млрд",
  "тыс",
  "миллион",
  "миллиард",
  "тысяч",
  "сумм",
  "стоимост",
  "цен",
];

/**
 * Разбирает сумму в русском формате: «300 млн ₽», «1,5 млрд рублей»,
 * «90 000 000 руб». Возвращает наибольшую из найденных сумм.
 * Числа без денежного контекста («за последние 3 года») суммой не считаются.
 */
export function parseMoneyRu(text: string): number | null {
  const lower = text.toLowerCase();
  if (!hasAny(lower, MONEY_CONTEXT)) return null;

  const pattern =
    /(\d[\d\s\u00a0]*(?:[.,]\d+)?)\s*(млрд|миллиард|млн|миллион|тыс|тысяч|рублей|руб|₽)?/giu;
  let best: number | null = null;
  for (const match of lower.matchAll(pattern)) {
    const digits = (match[1] ?? "").replace(/[\s\u00a0]/g, "").replace(",", ".");
    const value = Number.parseFloat(digits);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unitKey = (match[2] ?? "").toLowerCase();
    // «3 года» или «2 контракта» без единицы измерения деньгами не считаем.
    if (unitKey === "" && digits.replace(/\D/gu, "").length < 4) continue;
    const multiplier = unitKey === "" ? 1 : (MONEY_UNITS[unitKey] ?? 1);
    const amount = value * multiplier;
    if (best === null || amount > best) best = amount;
  }
  return best;
}

/** Признаки совокупной суммы («с общей стоимостью не менее 300 млн ₽»). */
const TOTAL_AMOUNT_MARKERS = [
  "общей стоимостью",
  "общая стоимость",
  "общую стоимость",
  "общую сумму",
  "на общую сумму",
  "на сумму не менее",
  "совокупн",
  "суммарн",
  "в сумме",
  "общий объем",
  "общий объём",
];

/** Признаки суммы одного контракта («по контрактам от 3 млн ₽»). */
const SINGLE_CONTRACT_MARKERS = [
  "контракт",
  "договор",
  "госконтракт",
];

/** Слова, однозначно относящие сумму к каждому договору, а не к периоду. */
const EACH_CONTRACT_MARKERS = [
  "каждый",
  "каждого",
  "каждому",
  "единичн",
  "одного договора",
  "одного контракта",
  "по одному",
];

/**
 * Порог суммы рядом с числом: «стоимостью от 3 млн ₽», «ценой свыше 3 млн ₽».
 * Граница слова `\b` на кириллице не работает, поэтому перед коротким «от»
 * стоит проверка «не буква» — иначе оно находится внутри слова «работ».
 */
const PER_CONTRACT_CUE =
  /(?<![а-яё])(?:стоимостью|ценой|от|свыше|дороже)(?:\s+(?:не\s+менее|более|свыше|стоимостью|ценой))*\s*\d/u;

/**
 * Относится ли сумма к одному договору, а не ко всем за период.
 * Проверяется по предложениям: заголовок «Опыт исполнения договоров» не должен
 * превращать требование к совокупному объёму («…на общую сумму не менее
 * 300 млн ₽») в требование к одному контракту.
 */
function isPerContractAmount(lower: string): boolean {
  return lower.split(/[.;\n]/u).some((sentence) => {
    if (!hasAny(sentence, SINGLE_CONTRACT_MARKERS)) return false;
    if (hasAny(sentence, EACH_CONTRACT_MARKERS)) return true;
    if (hasAny(sentence, TOTAL_AMOUNT_MARKERS)) return false;
    return PER_CONTRACT_CUE.test(sentence) && parseMoneyRu(sentence) !== null;
  });
}

/**
 * Число контрактов из оборота «не менее N», когда слово о контрактах стоит
 * в другой форме («не менее 3 исполненных»). Суммы и доли отсекаются:
 * «не менее 300 млн ₽» и «не менее 20%» числом контрактов не являются.
 */
function fallbackContractCount(lower: string): number | null {
  for (const match of lower.matchAll(
    /не\s+(?:менее|меньше)\s+(\d[\d\s\u00a0]*(?:[.,]\d+)?)/giu,
  )) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const digits = (match[1] ?? "").replace(/[\s\u00a0]/gu, "").replace(",", ".");
    const value = Number.parseFloat(digits);
    if (!Number.isFinite(value)) continue;
    const tail = lower.slice(end, end + 12);
    if (/^\s*(?:%|процент)/u.test(tail)) continue;
    if (/^\s*(?:млн|млрд|тыс|миллион|миллиард|тысяч|руб|₽)/u.test(tail)) continue;
    // Число контрактов — небольшое целое; суммы и доли отброшены выше.
    if (!Number.isInteger(value) || value <= 0 || value > 1_000) continue;
    return value;
  }
  return null;
}

/**
 * Извлекает порог опыта из текста требования: число контрактов, сумму
 * (в том числе «20% НМЦК») и период. Сумма относится либо ко всем контрактам
 * периода, либо к одному контракту — различение важно: «опыт по контрактам
 * от 3 млн ₽» не означает совокупный объём 3 млн ₽.
 */
export function parseExperienceThreshold(
  text: string,
  tenderPrice: number,
): ExperienceThreshold | null {
  const lower = text.toLowerCase();
  const contracts = /(\d+)\s*(?:исполненн|контракт|договор|госконтракт)/iu.exec(lower);
  const minContracts = contracts?.[1]
    ? Number.parseInt(contracts[1], 10)
    : fallbackContractCount(lower);

  const period =
    /за\s+(?:последние|прошлые|предыдущие)?\s*(\d+)\s*(?:год|года|лет)/iu.exec(lower);
  const previousYear = /за\s+(?:предыдущий|прошлый|отчетный)\s+год/iu.test(lower);
  const periodYears = previousYear
    ? 1
    : period?.[1]
      ? Number.parseInt(period[1], 10)
      : null;

  let amount = parseMoneyRu(text);
  const percent = /(\d{1,3}(?:[.,]\d+)?)\s*%/u.exec(lower);
  if (percent?.[1] && /нмцк|начальн|цены контракта|цены договора/u.test(lower)) {
    const pct = Number.parseFloat(percent[1].replace(",", "."));
    if (Number.isFinite(pct) && isPriceKnown(tenderPrice)) {
      const fromPrice = (tenderPrice * pct) / 100;
      amount = amount === null ? fromPrice : Math.max(amount, fromPrice);
    }
  }

  const isTotal = hasAny(lower, TOTAL_AMOUNT_MARKERS);
  const perContract = amount !== null && !isTotal && isPerContractAmount(lower);

  const minAmount = amount !== null && !perContract ? amount : null;
  const minSingleContractAmount = perContract ? amount : null;

  if (minContracts === null && minAmount === null && minSingleContractAmount === null) {
    return null;
  }
  return {
    minContracts,
    minAmount,
    minSingleContractAmount,
    periodYears,
    source: text.slice(0, 160),
  };
}

export interface ExperienceAdmissionCheck {
  satisfied: boolean;
  threshold: ExperienceThreshold | null;
  totals: ExperienceTotals;
  /** Почему требование не подтверждается — для показа в карточке. */
  reason: string | null;
  /** Порог не удалось проверить по данным профиля. */
  inconclusive: string | null;
}

/** Проверяет требование к опыту: число контрактов и суммы за период. */
export function checkExperienceAdmission(
  requirement: TenderRequirement,
  tender: Tender,
  profile: CompanyProfile,
  now: Date,
): ExperienceAdmissionCheck {
  const text = [
    requirement.title,
    requirement.description,
    requirement.requiredValue ?? "",
  ].join(" ");
  const threshold = parseExperienceThreshold(text, tender.financial.price);
  const totals = resolveExperienceTotals(profile, now);

  if (threshold === null) {
    // Порог в тексте не распознан: подтверждаем опытом как таковым —
    // отдельными контрактами или заявленной суммой исполненных работ.
    const hasAny =
      profile.experience.length > 0 ||
      totals.lastYearAmount !== null ||
      totals.last3YearsAmount !== null;
    return {
      satisfied: hasAny,
      threshold: null,
      totals,
      reason: hasAny
        ? null
        : "В профиле нет записей об исполненных контрактах и не указана сумма выполненных работ.",
      inconclusive: null,
    };
  }

  const problems: string[] = [];
  const unknown: string[] = [];

  if (threshold.minContracts !== null && profile.experience.length < threshold.minContracts) {
    const declaredAmountOnly =
      profile.experience.length === 0 &&
      (totals.lastYearAmount !== null || totals.last3YearsAmount !== null);
    const message = `в профиле ${profile.experience.length} исполненных контрактов, требуется не менее ${threshold.minContracts}`;
    if (declaredAmountOnly) {
      // Заявлена только сумма работ: число контрактов неизвестно, спорить не с чем.
      unknown.push(`${message}; перечня контрактов в профиле нет`);
    } else {
      problems.push(message);
    }
  }

  if (threshold.minAmount !== null) {
    const useYear = threshold.periodYears === 1;
    const known = useYear ? totals.lastYearAmount : totals.last3YearsAmount;
    const periodLabel = useYear ? "за предыдущий год" : "за последние 3 года";
    if (known === null) {
      unknown.push(
        `не указана сумма исполненных работ ${periodLabel} (требуется не менее ${threshold.minAmount.toLocaleString("ru-RU")} ₽)`,
      );
    } else if (known < threshold.minAmount) {
      // Период длиннее трёх лет: знаем только трёхлетнюю сумму, она может быть занижена.
      const beyondKnownPeriod =
        threshold.periodYears !== null && threshold.periodYears > 3 && !useYear;
      const message = `сумма работ ${periodLabel} — ${known.toLocaleString("ru-RU")} ₽, требуется не менее ${threshold.minAmount.toLocaleString("ru-RU")} ₽`;
      if (beyondKnownPeriod) unknown.push(message);
      else problems.push(message);
    }
  }

  if (threshold.minSingleContractAmount !== null) {
    const largest = largestContractAmount(profile, threshold.periodYears, now);
    const required = threshold.minSingleContractAmount.toLocaleString("ru-RU");
    if (largest === null) {
      unknown.push(
        `в профиле нет перечня исполненных контрактов: требуется договор на сумму не менее ${required} ₽`,
      );
    } else if (largest < threshold.minSingleContractAmount) {
      problems.push(
        `наибольший исполненный контракт — ${largest.toLocaleString("ru-RU")} ₽, требуется не менее ${required} ₽`,
      );
    }
  }

  return {
    satisfied: problems.length === 0,
    threshold,
    totals,
    reason: problems.length > 0 ? problems.join("; ") : null,
    inconclusive: unknown.length > 0 ? unknown.join("; ") : null,
  };
}

/**
 * Наибольшая сумма одного исполненного контракта за период.
 * null — контрактов в профиле нет или их даты не распознаны.
 */
export function largestContractAmount(
  profile: CompanyProfile,
  periodYears: number | null,
  now: Date,
): number | null {
  const from =
    periodYears === null ? null : now.getTime() - periodYears * 365 * MS_PER_DAY;
  let best: number | null = null;
  for (const record of profile.experience) {
    if (from !== null) {
      const completed = new Date(record.completedAt).getTime();
      // Дату не прочитали — контракт лучше показать, чем потерять.
      if (!Number.isNaN(completed) && (completed < from || completed > now.getTime())) {
        continue;
      }
    }
    if (best === null || record.amount > best) best = record.amount;
  }
  return best;
}

/* ============================== 5. Кадры: численность, НРС, НОПРИЗ ============================== */

export interface PersonnelThreshold {
  /** Минимальная численность персонала. */
  minTotal: number | null;
  /** Минимум специалистов в НРС (НОСТРОЙ). */
  minNrs: number | null;
  /** Минимум специалистов в НОПРИЗ. */
  minNopriz: number | null;
}

/**
 * Единицы измерения, после которых число означает срок или долю, а не людей:
 * «стажем не менее 5 лет», «не менее 30%». Без этого фильтра требование
 * к стажу читалось бы как требование к численности штата.
 */
const NON_HEADCOUNT_UNITS = [
  "лет",
  "год",
  "мес",
  "дн",
  "сут",
  "час",
  "кварт",
  "%",
  "руб",
  "млн",
  "млрд",
  "тыс",
  "₽",
];

/** Слова, указывающие, что речь о людях. */
const PERSONNEL_NOUNS = [
  "специалист",
  "работник",
  "сотрудник",
  "персонал",
  "штат",
  "инженер",
  "квалифиц",
  "чел",
  "ч.",
];

/** Наименьшее число людей, упомянутое во фрагменте (без сроков и сумм). */
function minCountInClause(clause: string): number | null {
  const pattern = /(\d+)\s*([а-яё.%\/-]*)/giu;
  let best: number | null = null;
  for (const match of clause.matchAll(pattern)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(value) || value <= 0 || value > 100_000) continue;
    const unit = (match[2] ?? "").toLowerCase();
    if (NON_HEADCOUNT_UNITS.some((u) => unit.startsWith(u))) continue;
    if (best === null || value < best) best = value;
  }
  return best;
}

/** Ключ порога по реестру специалистов. */
type RegistryKey = "minNrs" | "minNopriz";

/**
 * Реестр, упомянутый во фрагменте. Если названы оба — фрагмент разбирается
 * по придаточным, поэтому возвращается null.
 * «Национальный реестр специалистов» без аббревиатуры относится к НОПРИЗ
 * у изыскателей и проектировщиков и к НРС у строителей.
 */
function registryOf(part: string): RegistryKey | null {
  const nrs = part.includes("нрс") || part.includes("нацреестр");
  const nopriz = part.includes("ноприз");
  if (nrs && !nopriz) return "minNrs";
  if (nopriz && !nrs) return "minNopriz";
  if (nrs && nopriz) return null;
  if (part.includes("национальн") && part.includes("реестр")) {
    return part.includes("изыскан") || part.includes("проектиров")
      ? "minNopriz"
      : "minNrs";
  }
  return null;
}

/**
 * Разбирает требование к кадрам по фразам: отдельно НРС, НОПРИЗ и общая
 * численность. Фраза «в штате не менее 11 человек, из них 2 в НРС» даёт
 * minTotal 11 и minNrs 2 — поэтому режем текст на предложения и придаточные.
 * Если в предложении одно число, а реестр назван в другом придаточном
 * («не менее 2 специалистов, включённых в национальный реестр»), число
 * относится к реестру, а не к общей численности.
 */
export function parsePersonnelRequirement(text: string): PersonnelThreshold {
  const result: PersonnelThreshold = { minTotal: null, minNrs: null, minNopriz: null };
  const bump = (key: keyof PersonnelThreshold, value: number): void => {
    result[key] = Math.max(result[key] ?? 0, value);
  };

  for (const sentence of text.toLowerCase().split(/[.;\n]/u)) {
    if (sentence.trim().length === 0) continue;
    const sentenceAboutPeople = hasAny(sentence, PERSONNEL_NOUNS);
    const clauses = sentence
      .split(/,|\sи\s/u)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);

    const counted = clauses.filter((clause) => minCountInClause(clause) !== null);
    const sentenceRegistry = registryOf(sentence);
    if (counted.length === 1 && sentenceRegistry !== null) {
      const only = counted[0] ?? "";
      if (registryOf(only) === null) {
        const value = minCountInClause(only);
        if (value !== null) bump(sentenceRegistry, value);
        continue;
      }
    }

    for (const part of clauses) {
      const count = minCountInClause(part);
      if (count === null) continue;
      const registry = registryOf(part);
      if (registry !== null) {
        bump(registry, count);
        continue;
      }
      if (hasAny(part, PERSONNEL_NOUNS) || sentenceAboutPeople) {
        bump("minTotal", count);
      }
    }
  }
  return result;
}

export interface PersonnelAdmissionCheck {
  satisfied: boolean;
  threshold: PersonnelThreshold;
  reason: string | null;
  /** Кадровые данные в профиле не заполнены — проверить автоматически нельзя. */
  inconclusive: string | null;
}

/** Проверяет требование к кадрам против штата профиля. */
export function checkPersonnelAdmission(
  requirement: TenderRequirement,
  profile: CompanyProfile,
): PersonnelAdmissionCheck {
  const text = [requirement.title, requirement.description, requirement.requiredValue ?? ""].join(" ");
  const threshold = parsePersonnelRequirement(text);
  const hasThreshold =
    threshold.minTotal !== null ||
    threshold.minNrs !== null ||
    threshold.minNopriz !== null;

  if (!hasThreshold) {
    return {
      satisfied: profile.hasPersonnel,
      threshold,
      reason: profile.hasPersonnel ? null : "В профиле не отмечено наличие персонала.",
      inconclusive: null,
    };
  }

  const staff = profile.staff;
  const declared = staff.total !== null || staff.nrsCount > 0 || staff.noprizCount > 0;
  if (!declared) {
    return {
      satisfied: profile.hasPersonnel,
      threshold,
      reason: null,
      inconclusive:
        "Кадровый состав в профиле не заполнен: нельзя сравнить с требованием закупки.",
    };
  }

  const problems: string[] = [];
  if (threshold.minTotal !== null && (staff.total ?? 0) < threshold.minTotal) {
    problems.push(
      `штат ${staff.total ?? 0} чел., требуется не менее ${threshold.minTotal}`,
    );
  }
  if (threshold.minNrs !== null && staff.nrsCount < threshold.minNrs) {
    problems.push(
      `в НРС ${staff.nrsCount} специалист(ов), требуется не менее ${threshold.minNrs}`,
    );
  }
  if (threshold.minNopriz !== null && staff.noprizCount < threshold.minNopriz) {
    problems.push(
      `в НОПРИЗ ${staff.noprizCount} специалист(ов), требуется не менее ${threshold.minNopriz}`,
    );
  }

  return {
    satisfied: problems.length === 0,
    threshold,
    reason: problems.length > 0 ? problems.join("; ") : null,
    inconclusive: null,
  };
}

/* ============================== 6. Единая проверка требования ============================== */

/**
 * Удовлетворено ли требование закупки данными профиля.
 * Общая реализация для скоринга и разбора требований: раньше правила
 * были продублированы в двух местах и расходились.
 */
export function isRequirementSatisfied(
  requirement: TenderRequirement,
  tender: Tender,
  profile: CompanyProfile,
  now: Date = new Date(),
): boolean {
  const needle = (requirement.requiredValue ?? "").toLowerCase();
  switch (requirement.kind) {
    case "LICENSE":
      return profile.licenses.some(
        (l) => l.confirmed && l.kind.toLowerCase().includes(needle),
      );
    case "SRO":
      return isSroRequirementSatisfied(requirement, tender, profile, now);
    case "EXPERIENCE":
      return checkExperienceAdmission(requirement, tender, profile, now).satisfied;
    case "QUALIFIED_PERSONNEL":
      return checkPersonnelAdmission(requirement, profile).satisfied;
    case "EQUIPMENT":
      return profile.hasEquipment;
    default:
      return false;
  }
}

/** Вид допуска, который требует требование (из формулировки или из предмета закупки). */
export function requirementSroKinds(
  requirement: TenderRequirement,
  tender: Tender,
): SroKind[] {
  const text = [
    requirement.requiredValue ?? "",
    requirement.title,
    requirement.description,
  ]
    .join(" ")
    .toLowerCase();
  const kinds = detectSroKinds(text);
  if (kinds.length > 0) return kinds;
  if (hasAny(text, ["срой", "сро", "саморегулируем"])) {
    return detectSroKinds(buildSubjectText(tender));
  }
  return [];
}

function isSroRequirementSatisfied(
  requirement: TenderRequirement,
  tender: Tender,
  profile: CompanyProfile,
  now: Date,
): boolean {
  const needle = (requirement.requiredValue ?? "").toLowerCase();
  const kinds = requirementSroKinds(requirement, tender);
  const price = tender.financial.price;

  const candidates =
    kinds.length > 0
      ? kinds
          .map((kind) => findSroByKind(profile, kind, now))
          .filter((m): m is SroMembership => m !== undefined)
      : profile.sroMemberships.filter(
          (m) => isSroActive(m, now) && (needle === "" || m.type.toLowerCase().includes(needle)),
        );

  if (candidates.length === 0) return false;
  // Достаточно одного допуска, лимит которого покрывает цену закупки.
  return candidates.some((m) => {
    const limit = effectiveSroLimit(m);
    return limit === null || !isPriceKnown(price) || price <= limit;
  });
}

/* ============================== 7. Блокеры и неопределённости допуска ============================== */

/** Блокеры допуска: превышение лимита СРО, отсутствие нужного вида допуска. */
export function admissionBlockers(
  tender: Tender,
  profile: CompanyProfile,
  now: Date = new Date(),
): HardBlocker[] {
  const sro = checkSroAdmission(tender, profile, now);
  return sro.blocker ? [sro.blocker] : [];
}

/** Неопределённости допуска: спорные виды работ, просроченные СРО, неполные данные. */
export function admissionUncertainties(
  tender: Tender,
  profile: CompanyProfile,
  now: Date = new Date(),
): Uncertainty[] {
  const result: Uncertainty[] = [...checkSroAdmission(tender, profile, now).uncertainties];

  for (const requirement of tender.requirements) {
    if (!requirement.mandatory) continue;
    if (requirement.kind === "EXPERIENCE") {
      const check = checkExperienceAdmission(requirement, tender, profile, now);
      if (check.inconclusive) {
        result.push({
          id: `${tender.id}-unc-experience-${requirement.id}`,
          question: "Подтверждается ли требуемый опыт?",
          detail: check.inconclusive,
          evidenceId: requirement.evidenceId,
          material: true,
        });
      }
    }
    if (requirement.kind === "QUALIFIED_PERSONNEL") {
      const check = checkPersonnelAdmission(requirement, profile);
      if (check.inconclusive) {
        result.push({
          id: `${tender.id}-unc-personnel-${requirement.id}`,
          question: "Хватает ли специалистов под требование закупки?",
          detail: check.inconclusive,
          evidenceId: requirement.evidenceId,
          material: false,
        });
      }
    }
  }

  return result;
}
