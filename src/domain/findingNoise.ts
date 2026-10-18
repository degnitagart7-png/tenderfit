import type { AnalysisFinding, TenderLaw } from "@/types/database";

/**
 * Шум в выводах анализа: норма закона и обычай делового оборота — не находка.
 *
 * Зачем. Модель перечисляла в рисках и блокерах то, что знает любой поставщик по
 * 44-ФЗ: «казначейское сопровождение аванса» как риск, «отсутствие в РНП» как
 * блокер, «НДС 22 %», «пени за просрочку» без единой цифры сверх закона. Показ
 * такого выглядит как незнание рынка и топит настоящие отклонения. Владелец
 * (14.10.2026): показывать только то, что отличается от нормы или реально влияет
 * на решение и деньги.
 *
 * Три класса:
 *  - `drop` — типовое, не находка ни в одной категории: единые требования
 *    ст. 31 44-ФЗ и их аналоги (РНП, ликвидация, недоимки, иноагент…), согласие с
 *    условиями, крупная сделка, общая ответственность, НДС, «все расходы в цене»,
 *    валюта, контакты, площадка, способ закупки;
 *  - `standard` — только для 44-ФЗ: условие в пределах закона (односторонний отказ
 *    по ч. 9 ст. 95, пени и штрафы по ПП № 1042, удержание неустойки, казначейское
 *    сопровождение, обеспечения в законных пределах, оплата не дольше 7/10 рабочих
 *    дней). В списках не показывается, схлопывается в одну строку
 *    «Типовые условия 44-ФЗ без отклонений: …» — так видно, что проверили;
 *  - `keep` — всё остальное, включая отклонения от нормы (оплата 30 рабочих дней по
 *    44-ФЗ — нарушение и повод для жалобы в ФАС; пени 0,5 % в день; гарантия 5 лет).
 *    Отклонение получает пояснение `legal_note`, категорию «риск» и высокую важность.
 *
 * Правило детерминированное: оно проверяется тестом и не зависит от того, как
 * модель назвала находку. Применяется при чтении (старые разборы чистятся тоже),
 * перед подсчётом вердикта, в отчёте Word и при сведении выводов.
 */

export type NoiseClass = "drop" | "standard" | "keep";

/** Тема типового условия — из них собирается строка «Типовые условия…». */
export type StandardTopic =
  | "TERMINATION"
  | "PENALTY"
  | "SET_OFF"
  | "TREASURY"
  | "SECURITY"
  | "PAYMENT"
  | "FIXED_PRICE"
  | "ANTIDUMPING"
  | "DEFECTS"
  | "WARRANTY"
  | "E_ACCEPTANCE"
  | "RISK_OF_LOSS"
  | "SUBCONTRACT";

export interface NoiseVerdict {
  class: NoiseClass;
  topic: StandardTopic | null;
  /** Отклонение от нормы: пояснение по закону (для keep). */
  deviation: string | null;
  /** Находку надо поднять до риска высокой важности (оплата, пени). */
  promote: boolean;
}

type LawArg = TenderLaw | null | undefined;

const KEEP: NoiseVerdict = { class: "keep", topic: null, deviation: null, promote: false };
const DROP: NoiseVerdict = { class: "drop", topic: null, deviation: null, promote: false };

/** Нормализация для проверок: регистр, «ё», пробелы. */
function lower(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/* ------------------------------ DROP: типовое ------------------------------ */

/**
 * Лицензия, СРО, гостайна перевешивают типовые условия: «лицензия ФСБ и отсутствие
 * в РНП» несёт настоящий стоп-фактор (так же устроено `demoteUniversalBlockers`).
 */
const PROFILE_CHECKABLE: readonly RegExp[] = [
  /лицензи/,
  /(?:^|[^а-яa-z])сро(?:[^а-яa-z]|$)|саморегулируем/,
  /гостайн|государственн\S* тайн/,
  /допуск\S* к сведениям/,
];

/** Типовые условия допуска и общие положения, которые знает любой участник. */
const DROP_TITLE: readonly RegExp[] = [
  // Единые требования ч. 1 и ч. 1.1 ст. 31 44-ФЗ.
  /единые требовани/,
  /(?:^|[^а-я])ч(?:\.|асти|асть)?\s*1(?:\.1)?\s*ст(?:\.|атьи)?\s*31/,
  /(?:^|[^а-я])п(?:\.|ункт\S*)?\s*[\d,\- ]+\s*ч(?:\.|асти)?\s*1(?:\.1)?\s*ст(?:\.|атьи)?\s*31/,
  /(?:^|[^а-я])1\.1\s*ст(?:\.|атьи)?\s*31/,
  // Реестр недобросовестных поставщиков и состояние юридического лица.
  /(?:^|[^а-я])рнп(?:[^а-я]|$)|недобросовестн/,
  // «Ликвидация аварии/последствий» — работа, а не состояние участника.
  /^(?![\s\S]*(?:последстви|авари|отход|мусор|демонтаж))[\s\S]*ликвидац/,
  /банкротств|конкурсн\S* производств/,
  /приостановлен\S* деятельност/,
  /недоимк|задолженност\S* по налог|налогов\S* задолженност/,
  /судимост/,
  /дисквалифи/,
  /19\.28|незаконн\S* вознагражден|коррупц/,
  /иностранн\S* агент/,
  /офшор/,
  /конфликт\S* интересов/,
  /санкцион\S* (?:перечн|списк)|под санкци|специальн\S* экономическ\S* мер/,
  // Согласие с условиями, крупная сделка.
  /согласи\S* (?:участника )?(?:с|на) (?:услови|поставк|выполнен|исполнен)|согласие участника/,
  /крупн\S* сделк/,
  // Общая ответственность без конкретики.
  /антимонопольн/,
  /административн\S*(?: и уголовн\S*)? ответственност|уголовн\S* ответственност/,
  // Деньги в цене: ставка НДС, «все расходы включены», валюта, реквизиты.
  /(?:^|[^а-я])ндс(?:[^а-я]|$)/,
  /(?:все|всех)\s+(?:расход|налог|затрат|сбор|обязательн)\S*[^.]{0,60}(?:цен|нмцк)|включен\S* (?:всех|в цену|в нмцк)|расход\S* (?:включен|учтен)\S* в (?:цену|нмцк)/,
  /валют\S* (?:расчет|платеж|контракт|договор)|^валюта/,
  /^реквизит|банковск\S* реквизит/,
  // Порядок участия, который одинаков для всех (замер 14.10.2026 по 1 768 сохранённым находкам).
  /аккредитац\S* (?:на|в) (?:электронн|площадк|еис)|регистрац\S* в еис/,
  /правомочн/,
  /соответстви\S* требованиям законодательств/,
  /уклонени\S* от заключени/,
  /недостоверн\S* сведени/,
];

/** Служебные сведения закупки: показаны в карточке, находкой не являются. Только neutral. */
const DROP_NEUTRAL_TITLE: readonly RegExp[] = [
  /^предмет (?:закупки|контракта|договора)/,
  /^место (?:выполнения|оказания|поставки|исполнения)/,
  /^заказчик(?:$|[^а-я])|^наименование заказчика/,
  /^нмцк|^начальн\S* \(?максимальн|^цена (?:контракта|договора)/,
  /электронн\S* площадк|торгов\S* площадк|оператор\S* (?:электронн|площадк)/,
  /подведени\S* итог/,
  /источник\S* финансирован/,
  /способ\S* определения поставщик|способ\S* (?:закупки|проведения)/,
  /(?:срок|дата|окончани\S*)\s+(?:окончания\s+)?подачи\s+заявок|подача\s+заявок/,
  /идентификацион\S* код закупки|^икз(?:[^а-я]|$)/,
  /^валюта/,
  /^контакт|контактн\S* (?:лиц|данн|информац)|^телефон|^электронн\S* почт/,
  /победител\S* (?:аукцион|закупк|определени)|снижени\S* цены победител/,
  /метод\S* (?:определения|расчета|обоснования) нмцк/,
  /^срок действия (?:контракта|договора)/,
];

/**
 * Служебное neutral, которое нигде не нужно (контакты, площадка, валюта, даты
 * процедуры). Место работ и сметные сведения (НДС, индекс) сюда не входят: у отчёта
 * есть блоки фактов, куда они идут, хотя в списке находок их нет.
 */
export function isPureNoiseNeutral(finding: AnalysisFinding): boolean {
  if (finding.category !== "neutral") return false;
  const title = lower(finding.title);
  if (/^место (?:выполнения|оказания|поставки|исполнения)/.test(title)) return false;
  if (/(?:^|[^а-я])ндс(?:[^а-я]|$)/.test(title)) return false;
  return DROP_NEUTRAL_TITLE.some((p) => p.test(title)) || DROP_TITLE.some((p) => p.test(title));
}

function isUniversalBoilerplate(finding: AnalysisFinding): boolean {
  const head = lower(`${finding.title} ${finding.required_value ?? ""}`);
  if (PROFILE_CHECKABLE.some((p) => p.test(head))) return false;
  if (DROP_TITLE.some((p) => p.test(head))) return true;
  // Модель сама отметила «типовое условие допуска, подтверждается декларацией».
  if (finding.requirement_kind === "DECLARATION" && finding.category !== "neutral") {
    return !PROFILE_CHECKABLE.some((p) => p.test(lower(`${finding.detail} ${finding.evidence_quote}`)));
  }
  return false;
}

/* ------------------------- STANDARD: типовое для 44-ФЗ ------------------------- */

const TREASURY = /казначейск/;
const TERMINATION = /односторонн\S*\s+(?:\S+\s+){0,3}?(?:отказ|расторж|прекращ)|(?:отказ|расторж)\S*\s+(?:\S+\s+){0,4}?односторонн/;
const SET_OFF = /удержани\S*\s+(?:\S+\s+){0,3}?(?:неусто(?:йк|ек)|штраф|пен)|(?:неусто(?:йк|ек)|штраф|пен)\S*\s+(?:\S+\s+){0,4}?(?:удерж|из оплат)|зачет\S*\s+(?:\S+\s+){0,3}?(?:неусто(?:йк|ек)|штраф)/;
const PENALTY = /(?:^|[^а-я])пен[яиюе](?:[^а-я]|$)|неусто(?:йк|ек)|штраф|финансов\S*\s+санкци|штрафн\S*\s+санкци/;
const SECURITY_TITLE = /обеспечени\S*\s+(?:заявк|исполнени|контракт|договор|гарантийн)|способ\S*\s+обеспечени/;
const PAYMENT_TITLE = /оплат|расчет(?:ы|ов)\s+с\s+(?:подрядчик|поставщик|исполнител)|платеж/;

/** Сигналы того, что заказчик вышел за пределы закона в праве на отказ. */
const TERMINATION_BEYOND =
  /в\s+любое\s+время|без\s+объяснени|без\s+указани\S*\s+причин|без\s+(?:каких-либо\s+)?(?:причин|оснований)|по\s+усмотрени\S*\s+заказчик|по\s+любому\s+основани|независимо\s+от\s+(?:причин|нарушени)/;

/** Сигналы повышенных санкций словами. */
const PENALTY_BEYOND = /двойн|удвоенн|в\s+\d+\s+раз\S*\s+(?:больше|выше)|сверх\s+(?:предусмотренн|установленн)|независимо\s+от\s+вины/;

/** Ссылка на норму: размер пеней и штрафов определён самим законом. */
const PENALTY_STATUTORY = /1\s*\/\s*300|трех?сотой|трехсотой|(?:постановлен\S*\s+правительства[^.]{0,40})?\b1042\b|пп\s*(?:рф\s*)?№?\s*1042|ключев\S*\s+ставк/;

function toNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

/** Пени в процентах за день: «0,5 % за каждый день просрочки». */
function dailyPenaltyPercent(text: string): number | null {
  const a = /(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:%|процент\S*)[^.;]{0,80}?(?:за\s+каждый\s+(?:календарный\s+)?день|в\s+день|ежедневно)/.exec(text);
  if (a) return toNumber(a[1]!);
  const b = /(?:за\s+каждый\s+(?:календарный\s+)?день|в\s+день|ежедневно)[^.;]{0,80}?(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:%|процент)/.exec(text);
  return b ? toNumber(b[1]!) : null;
}

/** Все проценты текста: «5 %», «0,5%», «2,5 процента». */
function percents(text: string): number[] {
  return [...text.matchAll(/(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:%|процент)/g)].map((m) => toNumber(m[1]!));
}

/** Самый большой процент в первом источнике, где проценты есть. */
function maxPercent(...sources: string[]): number | null {
  for (const source of sources) {
    const found = percents(source);
    if (found.length > 0) return Math.max(...found);
  }
  return null;
}

/**
 * Дневная ставка пеней выше потолка закона. 1/300 ключевой ставки при ставке до
 * 21 % даёт до 0,07 % в день; 0,08 % — граница с запасом.
 */
const MAX_STATUTORY_DAILY_PENALTY_PERCENT = 0.08;
/** Потолок штрафа ПП № 1042 для поставщика — 10 % цены контракта (малые контракты). */
const MAX_STATUTORY_FINE_PERCENT = 10;
/** Пределы обеспечения по 44-ФЗ, % НМЦК (ст. 44 и 96). */
const MAX_BID_SECURITY_PERCENT = 5;
const MAX_CONTRACT_SECURITY_PERCENT = 30;
const MAX_WARRANTY_SECURITY_PERCENT = 10;

function deviation(note: string, promote = true): NoiseVerdict {
  return { class: "keep", topic: null, deviation: note, promote };
}

function standard(topic: StandardTopic): NoiseVerdict {
  return { class: "standard", topic, deviation: null, promote: false };
}

function assessPenalty(text: string, quote: string): NoiseVerdict {
  const daily = dailyPenaltyPercent(text);
  if (daily !== null && daily > MAX_STATUTORY_DAILY_PENALTY_PERCENT) {
    return deviation(
      `Пени ${formatPercent(daily)} за каждый день просрочки — выше нормы 44-ФЗ: по ПП № 1042 пени считаются как 1/300 ключевой ставки Банка России (около 0,05–0,07 % в день). Заложите такой штраф в цену либо задайте заказчику вопрос и обжалуйте условие в ФАС.`,
      true,
    );
  }
  if (PENALTY_BEYOND.test(text)) {
    return deviation(
      "Размер санкций выходит за рамки ПП № 1042 (пени 1/300 ключевой ставки, штрафы по шкале от цены контракта): прочитайте пункт и оцените, во что это обойдётся.",
      true,
    );
  }
  // Штраф в процентах от цены: ПП № 1042 — не выше 10 % (контракты до 3 млн ₽).
  if (/штраф/.test(text) && !PENALTY_STATUTORY.test(quote)) {
    const fine = maxPercent(quote, text);
    if (fine !== null && fine > MAX_STATUTORY_FINE_PERCENT) {
      return deviation(
        `Штраф ${formatPercent(fine)} цены контракта — выше предела ПП № 1042 (до 10 % цены). Такое условие можно оспорить, а при участии нужен резерв в цене.`,
        true,
      );
    }
  }
  return standard("PENALTY");
}

function assessSecurity(title: string, text: string, quote: string): NoiseVerdict {
  const percent = maxPercent(title, quote, text);
  const advance = /аванс/.test(text);
  if (/заявк/.test(title) && percent !== null && percent > MAX_BID_SECURITY_PERCENT) {
    return deviation(
      `Обеспечение заявки ${formatPercent(percent)} НМЦК — выше предела 44-ФЗ (от 0,5 до 5 % НМЦК, ч. 14 ст. 44). Условие нарушает закон: основание для жалобы в ФАС.`,
      true,
    );
  }
  if (
    /(?:исполнени|контракт|договор)/.test(title) &&
    !/гарантийн/.test(title) &&
    percent !== null &&
    percent > MAX_CONTRACT_SECURITY_PERCENT &&
    // Больше 30 % допустимо при авансе выше 30 % и при снижении цены на 25 % и более (×1,5).
    !advance &&
    !/полтор|1[.,]5|25\s*(?:%|процент)|демпинг|сниж/.test(text)
  ) {
    return deviation(
      `Обеспечение исполнения ${formatPercent(percent)} НМЦК — выше предела 44-ФЗ (до 30 % НМЦК, ч. 6 ст. 96). Условие нарушает закон: основание для жалобы в ФАС.`,
      true,
    );
  }
  if (/гарантийн/.test(title) && percent !== null && percent > MAX_WARRANTY_SECURITY_PERCENT) {
    return deviation(
      `Обеспечение гарантийных обязательств ${formatPercent(percent)} НМЦК — выше обычного предела 10 %: деньги будут заморожены на весь срок гарантии.`,
      true,
    );
  }
  return standard("SECURITY");
}

/**
 * Срок оплаты из текста. Рабочие дни, календарные или «дней» без уточнения.
 * Возвращает null, если срока нет.
 */
export function paymentTermDays(text: string): { days: number; unit: "working" | "calendar" | "unknown" } | null {
  const pattern =
    /(?:в\s+течение|не\s+(?:позднее|более)(?:\s+чем)?(?:\s+через)?|в\s+срок(?:\s+(?:до|не\s+более))?|через|срок\S*\s+оплат\S*)\s*[:—-]?\s*(\d{1,3})\s*(?:\([^)]*\)\s*)?(?:(рабоч\S*|календарн\S*)\s+)?дн/g;
  const found = [...text.matchAll(pattern)].map((m) => ({
    index: m.index ?? 0,
    days: Number(m[1]),
    unit: (m[2] ? (m[2].startsWith("рабоч") ? "working" : "calendar") : "unknown") as "working" | "calendar" | "unknown",
  }));
  if (found.length === 0) return null;
  // В цитате бывают сроки приёмки и оплаты вперемешку: берём тот, перед которым стоит «оплат».
  const afterPayment = found.filter((f) => /оплат|платеж|расч[её]т/.test(text.slice(Math.max(0, f.index - 160), f.index + 20)));
  const pool = afterPayment.length > 0 ? afterPayment : found;
  const worst = pool.reduce((a, b) => (b.days > a.days ? b : a));
  return { days: worst.days, unit: worst.unit };
}

/** Срок оплаты, который 44-ФЗ допускает: 10 рабочих дней (7 — для СМП/СОНКО). */
function paymentWithinStatute(term: { days: number; unit: "working" | "calendar" | "unknown" }): boolean {
  if (term.unit === "calendar") return term.days <= 14;
  return term.days <= 10;
}

function assessPayment(title: string, detail: string, quote: string): NoiseVerdict {
  const term = paymentTermDays(quote) ?? paymentTermDays(detail) ?? paymentTermDays(title);
  if (term === null) return KEEP;
  if (paymentWithinStatute(term)) return standard("PAYMENT");
  const unit = term.unit === "calendar" ? "календарных" : term.unit === "working" ? "рабочих" : "";
  return deviation(
    `Срок оплаты ${String(term.days)} ${unit ? `${unit} ` : ""}дн. длиннее, чем разрешает 44-ФЗ: оплата — не позднее 7 рабочих дней для СМП и СОНКО и 10 рабочих дней в остальных случаях (ч. 13.1 ст. 34). ` +
      "Это нарушение закона в документации: на него можно подать жалобу в ФАС (ст. 105 44-ФЗ) до окончания срока подачи заявок или запросить разъяснения у заказчика. " +
      "Если подавать заявку на таких условиях — заложите оборотные деньги на весь срок.",
    true,
  );
}

function formatPercent(value: number): string {
  return `${String(Number(value.toFixed(2))).replace(".", ",")} %`;
}

function assess44(finding: AnalysisFinding): NoiseVerdict {
  const title = lower(finding.title);
  const required = lower(finding.required_value ?? "");
  const head = `${title} ${required}`.trim();
  const detail = lower(finding.detail);
  const quote = lower(finding.evidence_quote);
  const full = `${head} ${detail} ${quote}`;

  if (TREASURY.test(title)) return standard("TREASURY");

  if (SECURITY_TITLE.test(title)) return assessSecurity(title, full, quote);

  if (TERMINATION.test(title) && !PENALTY.test(title)) {
    if (TERMINATION_BEYOND.test(full)) {
      return deviation(
        "Право заказчика на односторонний отказ шире, чем в 44-ФЗ (ч. 9 ст. 95: только по основаниям, названным в законе, с решением и уведомлением). Уточните условие у заказчика: это риск потери затрат.",
        true,
      );
    }
    return standard("TERMINATION");
  }

  if (SET_OFF.test(title)) {
    return PENALTY_BEYOND.test(full) ? KEEP : standard("SET_OFF");
  }

  if (PENALTY.test(title) && !/обеспечени/.test(title)) {
    return assessPenalty(full, quote);
  }

  if (PAYMENT_TITLE.test(title) && !/штраф|пен[яи]|неусто(?:йк|ек)|аванс|обеспечени|гаранти|реквизит|налог/.test(title)) {
    return assessPayment(title, detail, quote);
  }

  // Нормы ГК и 44-ФЗ, которые одинаковы в любом контракте (замер 14.10.2026).
  if (/тверд\S* цен/.test(title) && !/инфляц|индексац/.test(title)) return standard("FIXED_PRICE");
  if (/демпинг/.test(title)) return standard("ANTIDUMPING");
  if (/электронн\S* (?:приемк|документ\S* о приемке)|приемк\S* (?:в|через) (?:еис|аис|электронн)/.test(title)) return standard("E_ACCEPTANCE");
  if (/риск\S* (?:случайн\S* )?(?:гибел|повреждени)/.test(title)) return standard("RISK_OF_LOSS");
  if (/ответственност\S* за (?:действия |работу )?субподрядчик/.test(title)) return standard("SUBCONTRACT");
  if (/устранени\S* (?:недостатк|дефект)|(?:ремонт|недостатк|дефект)\S* за св(?:ой|ои) сч/.test(title)) {
    return assessDefects(full);
  }
  if (/гаранти/.test(title) && !/обеспечени|банковск/.test(title)) return assessWarranty(full);

  return KEEP;
}

/**
 * Срок устранения дефектов: «за свой счёт» — норма ГК (ст. 723, 755); короткий срок
 * (меньше 5 дней) или устранение третьими лицами за счёт подрядчика с наценкой — уже
 * условие, о котором стоит знать.
 */
function assessDefects(text: string): NoiseVerdict {
  const days = [...text.matchAll(/(\d{1,3})\s*(?:\([^)]*\)\s*)?(?:рабоч\S*\s+|календарн\S*\s+)?(?:дн|сут)/g)].map((m) => Number(m[1]));
  if (days.length > 0 && Math.min(...days) < 5) return KEEP;
  if (/наценк|повышающ|в двойном|штраф\S* за каждый случай/.test(text)) return KEEP;
  return standard("DEFECTS");
}

/** Гарантийный срок до 5 лет — обычный для работ; 5 лет и больше — отклонение, о нём говорим. */
function assessWarranty(text: string): NoiseVerdict {
  const months = [...text.matchAll(/(\d{1,3})\s*(?:\([^)]*\)\s*)?(месяц|мес\.|год|лет)/g)].map((m) =>
    /год|лет/.test(m[2]!) ? Number(m[1]) * 12 : Number(m[1]),
  );
  if (months.length === 0) return KEEP;
  return Math.max(...months) >= 60 ? KEEP : standard("WARRANTY");
}

/* -------------------------------- Классификатор -------------------------------- */

/** Подробный разбор находки: класс, тема и отклонение (если есть). */
export function assessFinding(finding: AnalysisFinding, law: LawArg): NoiseVerdict {
  if (finding.category === "neutral") {
    const title = lower(finding.title);
    if (DROP_NEUTRAL_TITLE.some((p) => p.test(title))) return DROP;
  }
  if (isUniversalBoilerplate(finding)) return DROP;
  if (law === "FZ_44") return assess44(finding);
  return KEEP;
}

/**
 * Показывать ли находку: `drop` — нет, `standard` — только строкой «типовые
 * условия», `keep` — да.
 */
export function classifyFinding(finding: AnalysisFinding, law: LawArg): NoiseClass {
  return assessFinding(finding, law).class;
}

/* --------------------------------- Строка «типовое» --------------------------------- */

const STANDARD_PHRASE: Record<StandardTopic, string> = {
  TERMINATION: "односторонний отказ заказчика (ч. 9 ст. 95)",
  PENALTY: "пени и штрафы по ПП № 1042",
  SET_OFF: "удержание неустойки из оплаты",
  TREASURY: "казначейское сопровождение аванса",
  SECURITY: "обеспечение в пределах закона",
  PAYMENT: "оплата в законный срок",
  FIXED_PRICE: "твёрдая цена (ч. 2 ст. 34)",
  ANTIDUMPING: "антидемпинговые меры (ст. 37)",
  DEFECTS: "устранение недостатков за свой счёт",
  WARRANTY: "гарантийный срок до 5 лет",
  E_ACCEPTANCE: "электронная приёмка в ЕИС",
  RISK_OF_LOSS: "риск гибели результата до приёмки",
  SUBCONTRACT: "ответственность за субподрядчиков",
};

const STANDARD_ORDER: readonly StandardTopic[] = [
  "TERMINATION",
  "PENALTY",
  "SET_OFF",
  "TREASURY",
  "SECURITY",
  "PAYMENT",
  "FIXED_PRICE",
  "ANTIDUMPING",
  "WARRANTY",
  "DEFECTS",
  "E_ACCEPTANCE",
  "RISK_OF_LOSS",
  "SUBCONTRACT",
];

function standardPhrases(topics: readonly StandardTopic[]): string[] {
  return STANDARD_ORDER.filter((t) => topics.includes(t)).map((t) => STANDARD_PHRASE[t]);
}

/** Строка под списком рисков: «Типовые условия 44-ФЗ без отклонений: …». */
export function standardLineText(topics: readonly StandardTopic[]): string | null {
  const phrases = standardPhrases(topics);
  return phrases.length === 0 ? null : `Типовые условия 44-ФЗ без отклонений: ${phrases.join(", ")}.`;
}

/** Одно предложение для отчёта Word. */
export function standardReportSentence(topics: readonly StandardTopic[]): string | null {
  const phrases = standardPhrases(topics);
  return phrases.length === 0
    ? null
    : `Типовые условия 44-ФЗ проверены, отклонений от закона нет: ${phrases.join(", ")}.`;
}

/** Строка интерфейса → предложение отчёта: «проверили, отклонений нет». */
export function standardLineToReportSentence(line: string | null | undefined): string | null {
  if (!line) return null;
  return line.replace("без отклонений:", "проверены, отклонений от закона нет:");
}

/* ---------------------------------- Фильтр ---------------------------------- */

export type NoiseFinding<T extends AnalysisFinding> = T & { legal_note?: string | null };

export interface FilteredFindings<T extends AnalysisFinding> {
  /** Что показывать: отклонения от нормы и всё, что классификатор не опознал. */
  kept: NoiseFinding<T>[];
  /** Типовое по 44-ФЗ: в списках не показывается, идёт строкой «типовые условия». */
  standard: T[];
  /** Выброшено как неинформативное. */
  dropped: T[];
  /** Темы типовых условий без отклонений (тема с отклонением из строки исключена). */
  standardTopics: StandardTopic[];
  /** Строка «Типовые условия 44-ФЗ без отклонений: …»; null — нечего сказать. */
  standardLine: string | null;
}

function withDeviation<T extends AnalysisFinding>(finding: T, verdict: NoiseVerdict): NoiseFinding<T> {
  const note = verdict.deviation;
  if (note === null) return finding;
  const previous = (finding as NoiseFinding<T>).legal_note ?? null;
  const legal_note = previous === null || previous === "" ? note : previous.includes(note) ? previous : `${previous} ${note}`;
  const next: NoiseFinding<T> = { ...finding, legal_note };
  if (verdict.promote) {
    // Отклонение от закона — риск и важное: категорию «нейтрально» и «требование» поднимаем.
    if (next.category === "neutral" || next.category === "requirement") next.category = "risk";
    next.severity = "high";
  } else if (next.severity === "low") {
    next.severity = "medium";
  }
  return next;
}

/**
 * Отфильтровать находки по закону закупки. Порядок и объекты `kept` сохраняются;
 * у отклонений появляется `legal_note`, а у нарушений закона — категория «риск»
 * и высокая важность.
 */
export function filterFindingNoise<T extends AnalysisFinding>(
  findings: readonly T[],
  law: LawArg,
): FilteredFindings<T> {
  const kept: NoiseFinding<T>[] = [];
  const standardFindings: T[] = [];
  const dropped: T[] = [];
  const topics = new Set<StandardTopic>();
  const deviated = new Set<StandardTopic>();

  for (const finding of findings) {
    const verdict = assessFinding(finding, law);
    if (verdict.class === "drop") dropped.push(finding);
    else if (verdict.class === "standard") {
      standardFindings.push(finding);
      if (verdict.topic !== null) topics.add(verdict.topic);
    } else {
      kept.push(withDeviation(finding, verdict));
      if (verdict.deviation !== null) {
        // Тема с отклонением не может одновременно значиться «без отклонений».
        const topic = deviationTopic(finding);
        if (topic !== null) deviated.add(topic);
      }
    }
  }

  const standardTopics = STANDARD_ORDER.filter((t) => topics.has(t) && !deviated.has(t));
  return {
    kept,
    standard: standardFindings,
    dropped,
    standardTopics,
    standardLine: law === "FZ_44" ? standardLineText(standardTopics) : null,
  };
}

/**
 * Убрать только типовое (`drop`), оставив условия 44-ФЗ в пределах закона на месте: сводка
 * хранится в базе, а блок «Деньги» берёт из неё числа обеспечений и срок оплаты. Показ
 * чистится при чтении (`filterFindingNoise`). Отклонения получают пояснение и подъём.
 */
export function dropBoilerplate<T extends AnalysisFinding>(findings: readonly T[], law: LawArg): NoiseFinding<T>[] {
  const out: NoiseFinding<T>[] = [];
  for (const finding of findings) {
    const verdict = assessFinding(finding, law);
    if (verdict.class === "drop") continue;
    out.push(verdict.class === "keep" ? withDeviation(finding, verdict) : finding);
  }
  return out;
}

/** Тема отклонения — по названию находки. */
function deviationTopic(finding: AnalysisFinding): StandardTopic | null {
  const title = lower(finding.title);
  if (SECURITY_TITLE.test(title)) return "SECURITY";
  if (TERMINATION.test(title)) return "TERMINATION";
  if (SET_OFF.test(title)) return "SET_OFF";
  if (PENALTY.test(title)) return "PENALTY";
  if (PAYMENT_TITLE.test(title)) return "PAYMENT";
  return null;
}

/**
 * Темы типовых условий и отклонения по нескольким спискам сразу (сводка и
 * построчные разборы документов): строка «без отклонений» не должна терять тему,
 * найденную только в разборе документа, и не должна врать, если отклонение есть
 * в любом из списков.
 */
export function mergeStandardTopics(parts: readonly FilteredFindings<AnalysisFinding>[], law: LawArg): {
  topics: StandardTopic[];
  line: string | null;
} {
  const all = new Set<StandardTopic>();
  const deviated = new Set<StandardTopic>();
  for (const part of parts) {
    for (const topic of part.standardTopics) all.add(topic);
    for (const finding of part.kept) {
      if (finding.legal_note) {
        const topic = deviationTopic(finding);
        if (topic !== null) deviated.add(topic);
      }
    }
  }
  const topics = STANDARD_ORDER.filter((t) => all.has(t) && !deviated.has(t));
  return { topics, line: law === "FZ_44" ? standardLineText(topics) : null };
}

/* ------------------------------ Подсказка для модели ------------------------------ */

const LAW_NAME: Record<TenderLaw, string> = {
  FZ_44: "44-ФЗ",
  FZ_223: "223-ФЗ",
  PP_RF_615: "ПП РФ № 615 (капитальный ремонт)",
  COMMERCIAL: "коммерческая закупка",
};

/**
 * Раздел промптов «Что НЕ является находкой»: общий для разбора документа и сведения.
 * Модель не слушается до конца, поэтому те же правила дублирует код (`filterFindingNoise`);
 * промпт нужен, чтобы модель не тратила на типовое лимит факторов, а настоящие
 * отклонения не тонули среди «РНП» и «НДС».
 */
export function buildNotAFindingGuide(law: LawArg, stage: "document" | "consolidation" = "document"): string {
  const lawName = law ? LAW_NAME[law] : "закон не указан";
  const lines = [
    `## Что НЕ является находкой (закон закупки: ${lawName})`,
    "Норма закона и обычай делового оборота — не находка. Отклонение от нормы — находка. Опытный подрядчик знает типовое наизусть, и пересказ типового выглядит как незнание рынка.",
    "Не извлекай вовсе, ни в какой категории, включая neutral:",
    "- единые требования к участникам (ч. 1 и ч. 1.1 ст. 31 44-ФЗ и аналоги в положении о закупке по 223-ФЗ): отсутствие в РНП, ликвидации, банкротства, приостановления деятельности, недоимок, судимости и дисквалификации, нарушений ст. 19.28 КоАП, статуса иностранного агента, офшорной регистрации, конфликта интересов, санкционных перечней;",
    "- согласие с условиями закупки и контракта, решение о крупной сделке;",
    "- общие слова об антимонопольной, административной и уголовной ответственности;",
    "- ставку НДС, «все расходы включены в цену», валюту расчётов, реквизиты счёта;",
    "- служебные сведения, которые уже есть в карточке: предмет, заказчик, НМЦК, площадка, способ определения поставщика, источник финансирования, даты и сроки подачи, контактное лицо.",
  ];
  if (law === "FZ_44") {
    lines.push(
      "Для 44-ФЗ типовым, а значит НЕ находкой, является всё это, пока нет отклонения:",
      "- односторонний отказ заказчика от контракта по ч. 9 ст. 95;",
      "- пени 1/300 ключевой ставки и штрафы по шкале ПП № 1042, удержание неустойки из оплаты;",
      "- казначейское сопровождение (любое упоминание): его знает каждый исполнитель по 44-ФЗ;",
      "- обеспечение заявки 0,5–5 % НМЦК, обеспечение исполнения до 30 %, гарантийное обеспечение до 10 %;",
      "- оплата в течение 7 рабочих дней (СМП, СОНКО) или 10 рабочих дней.",
      stage === "consolidation"
        ? "Числа обеспечений и срок оплаты в пределах закона записывай только в facts, в findings их не включай."
        : "Исключение — деньги: размер обеспечения заявки, исполнения и гарантии и срок оплаты запиши одним коротким фактором requirement на каждое (в required_value — процент или сумма, без рассуждений о риске): по ним строится блок «Деньги». Остальное типовое не извлекай.",
      "Находка — отклонение: срок оплаты длиннее 10 рабочих дней (для 44-ФЗ это нарушение, повод для жалобы в ФАС — так и напиши), пени выше 1/300 ключевой ставки или штраф выше шкалы ПП № 1042, обеспечение выше предела закона, гарантия от 5 лет или необычные гарантийные условия, отказ заказчика «в любое время» или без оснований.",
    );
  } else {
    lines.push(
      "Для этой закупки закон не задаёт условий договора: казначейское сопровождение, односторонний отказ заказчика, пени и штрафы, обеспечения, сроки оплаты — условия, которые выбрал заказчик, поэтому они находки, если стоят на деньгах или сроках.",
    );
  }
  lines.push(
    "Всегда находки: отклонения от нормы и то, что влияет на деньги и решение — срок оплаты дольше обычного, повышенные пени и штрафы, нет аванса при длинных работах, зимние работы, жёсткие сроки, материалы заказчика, дополнительные требования к опыту (ПП № 2571), СРО и лицензии, противоречия между документами, тяжёлые обязательства.",
  );
  return lines.join("\n");
}
