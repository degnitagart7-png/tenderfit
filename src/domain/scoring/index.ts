import type {
  AnalysisScore,
  CompanyProfile,
  ContractRisk,
  HardBlocker,
  Tender,
  TenderVerdict,
  Uncertainty,
} from "@/domain/entities";
import { profileDescribesSubject } from "@/domain/emptyCompanyProfile";
import { isPriceKnown, isRegionKnown } from "@/domain/entities";
import { regionCodeOf } from "@/domain/regionCodes";
import { matchCapabilities } from "@/domain/scoring/matching";
import {
  admissionBlockers,
  admissionUncertainties,
  isRequirementSatisfied,
  resolveExperienceTotals,
} from "@/domain/scoring/admission";
import { buildTenderText } from "@/domain/scoring/tenderText";

/**
 * Детерминированный движок скоринга соответствия закупки профилю компании.
 * Не зависит от React и от источников данных. Все функции чистые.
 */

/**
 * Веса показателей соответствия.
 *
 * Предмет закупки решает: это единственный показатель, отвечающий на вопрос
 * «делаем ли мы такую работу». Остальные четыре устроены иначе — они
 * начинаются со 100 и падают только при явном препятствии, то есть отвечают
 * «нет ли запрета», а не «умеем ли мы». Суммировать их как положительное
 * свидетельство нельзя: при прежних весах 70% балла не зависели от профиля
 * деятельности, и поставщик компьютеров получал 64 из 100 на реконструкции
 * подстанции 220 кВ.
 */
export const SCORE_WEIGHTS = {
  subjectFit: 0.5,
  legalEligibility: 0.2,
  operationalFit: 0.1,
  financialFit: 0.15,
  contractRisk: 0.05,
} as const;

/**
 * Сколько разных терминов профиля должно встретиться в закупке, чтобы
 * совпадение по словам считалось полным.
 *
 * Три — компромисс: одно случайное слово («поставка», «услуги») встречается
 * почти в любом извещении и сильным сигналом быть не должно, а требовать
 * больше трёх значит не засчитать короткие названия, где их просто негде взять.
 */
const HITS_FOR_FULL_MATCH = 3;

/**
 * Ниже этого соответствия предмета закупка считается не нашей.
 *
 * Порог нужен, потому что одних весов мало: закупка без единого препятствия
 * набирает около 40 баллов на остальных показателях, даже когда компания
 * такую работу не выполняет вовсе. Значение подобрано по живой выдаче —
 * см. комментарий к блокеру в `detectHardBlockers`.
 */
export const SUBJECT_FIT_FLOOR = 30;

/** Порог критического срока подачи, часов. */
export const CRITICAL_DEADLINE_HOURS = 24;

/**
 * Окно «срочных» закупок на экране «Сегодня», дней.
 *
 * Три дня, а не 24 часа: заявку на строительную закупку за сутки не собрать,
 * а показывать её как возможность — значит подставлять пользователя.
 */
export const URGENT_DEADLINE_DAYS = 3;

const clamp = (n: number, min = 0, max = 100): number =>
  Math.max(min, Math.min(max, n));

const round = (n: number): number => Math.round(n);

/**
 * Собирает весь текст закупки (предмет + документация) для сопоставления.
 * Реализация вынесена в scoring/tenderText.ts — оттуда же её берут
 * проверки допуска; здесь реэкспорт, чтобы не ломать существующие импорты.
 */
export { buildTenderText };

/* ============================== Subject Fit ============================== */

export function computeSubjectFit(
  tender: Tender,
  profile: CompanyProfile,
): number {
  const text = buildTenderText(tender);
  const cap = profile.capabilities;
  const allKeywords = [
    ...cap.keywords,
    ...cap.products,
    ...cap.works,
    ...cap.services,
    ...cap.brandsAndModels,
    ...cap.synonyms,
  ];
  const match = matchCapabilities(
    text,
    allKeywords,
    cap.stopWords,
    tender.okpd2Codes,
    cap.okpd2Codes,
  );

  let score = 0;
  // Совпадение по ОКПД2 — сильный сигнал.
  if (match.okpd2Matched) score += 45;
  /*
    Сила совпадения считается от ЧИСЛА совпавших терминов, а не от их доли
    в профиле.

    Доля (`match.ratio`) наказывала за полноту: знаменателем были все слова
    профиля, и компания, перечислившая свою номенклатуру целиком, не могла
    набрать высокий балл ни на одной закупке — одна закупка физически не
    совпадает с половиной списка. Замер на живых данных: та же компания и та
    же закупка давали 33 балла при двух словах в профиле, 24 при шести и 15
    при двадцати, хотя совпадали всё время одни и те же два слова.
  */
  const hits = match.matchedKeywords.length;
  score += Math.min(hits / HITS_FOR_FULL_MATCH, 1) * 55;
  // Штраф за стоп-слова (нерелевантная закупка).
  score -= match.matchedStopWords.length * 25;

  /*
    Закупку отобрала модель по смыслу под слова, которые совпадают с видами
    работ компании («Благоустройство территории» под «строительство, ремонт»),
    или её нашёл живой поиск по такому запросу. Слов компании в названии нет,
    но предмет совпал — модель это уже проверила. Без этого правила такие
    закупки получали «Не подходит» и уходили в «Скрыто» (05.10.2026).
  */
  if (foundForCompanyTerms(tender, allKeywords)) score = Math.max(score, SENSE_SUBJECT_SCORE);

  return round(clamp(score));
}

/** Балл предмета для закупки, отобранной по смыслу под слова компании. */
const SENSE_SUBJECT_SCORE = 70;

function foundForCompanyTerms(tender: Tender, companyTerms: readonly string[]): boolean {
  const found = [...(tender.senseKeywords ?? []), ...(tender.liveQuery ? [tender.liveQuery] : [])]
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w !== "");
  if (found.length === 0) return false;
  const terms = companyTerms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3);
  return found.some((w) => terms.some((t) => w.includes(t) || t.includes(w)));
}

/* ============================== Legal Eligibility ============================== */

export function computeLegalEligibility(
  tender: Tender,
  profile: CompanyProfile,
  now: Date = new Date(),
): number {
  const legalReqs = tender.requirements.filter(
    (r) =>
      r.mandatory &&
      (r.kind === "LICENSE" ||
        r.kind === "SRO" ||
        r.kind === "EXPERIENCE" ||
        r.kind === "QUALIFIED_PERSONNEL" ||
        r.kind === "EQUIPMENT"),
  );

  if (legalReqs.length === 0) {
    // Нет юридических требований — полная допустимость, но снижаем уверенность.
    return 90;
  }

  let satisfied = 0;
  for (const req of legalReqs) {
    if (isRequirementSatisfied(req, tender, profile, now)) {
      satisfied += 1;
    }
  }
  return round(clamp((satisfied / legalReqs.length) * 100));
}

/* ============================== Operational Fit ============================== */

/** Сколько баллов теряет известный регион вне приоритетных. */
const PRIORITY_REGION_PENALTY = 15;
/** Сколько теряет закупка с неизвестным регионом, когда регионы компании заданы. */
const UNKNOWN_REGION_PENALTY = 8;

/** Один и тот же регион: по коду, если оба названия опознаны, иначе по подстроке. */
function sameRegion(a: string, b: string): boolean {
  const ra = regionCodeOf(a);
  const rb = regionCodeOf(b);
  if (ra !== null && rb !== null) return ra.code === rb.code;
  return b.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(b.toLowerCase());
}

export function computeOperationalFit(
  tender: Tender,
  profile: CompanyProfile,
): number {
  const r = profile.restrictions;
  let score = 100;

  // Регион. Неизвестный регион — не чужой: штрафа нет, вопрос задаёт отдельная
  // неопределённость «Регион поставки не указан» (см. detectUncertainties).
  const regionKnown = isRegionKnown(tender.region);
  const regionOk =
    r.workRegions.length === 0 ||
    !regionKnown ||
    r.workRegions
      .filter(Boolean)
      .some((reg) => tender.region.toLowerCase().includes(reg.toLowerCase()));
  if (!regionOk) score -= 60;
  // Регион неизвестен, а компания работает в определённых регионах: это не
  // «чужой» регион, но и не подтверждённый свой. Небольшой штраф ставит такие
  // закупки ниже закупок из региона компании (раньше они шли выше).
  const hasGeography = r.workRegions.filter(Boolean).length > 0;
  const priorityList = (profile.preferences?.priorityRegions ?? []).filter(Boolean);
  if (!regionKnown && (hasGeography || priorityList.length > 0)) score -= UNKNOWN_REGION_PENALTY;

  // Приоритетный регион: не исключает остальные, но поднимает свой. Известный
  // регион вне приоритетных теряет немного баллов; неизвестный — нет (вопрос о
  // нём задаёт неопределённость). Названия сравниваются по коду региона, а не
  // по написанию: «Бурятия» и «Республика Бурятия» — один регион.
  if (priorityList.length > 0 && regionKnown) {
    const inPriority = priorityList.some((name) => sameRegion(name, tender.region));
    if (!inPriority) score -= PRIORITY_REGION_PENALTY;
  }

  // Срок поставки: если меньше минимально допустимого — не успеваем.
  const deliveryDays = tender.deadlines.deliveryTermDays;
  if (deliveryDays !== null && deliveryDays < r.minDeliveryTermDays) {
    const gap = r.minDeliveryTermDays - deliveryDays;
    score -= clamp(gap * 4, 0, 60);
  }

  return round(clamp(score));
}

/* ============================== Financial Fit ============================== */

export function computeFinancialFit(
  tender: Tender,
  profile: CompanyProfile,
): number {
  const r = profile.restrictions;
  const f = tender.financial;
  let score = 100;

  // Цена в диапазоне. Если цена не опубликована, сравнивать не с чем —
  // не штрафуем: иначе каждая вторая коммерческая закупка теряла бы баллы.
  if (isPriceKnown(f.price)) {
    if (f.price > r.maxPrice) score -= 45;
    if (f.price < r.minPrice) score -= 20;
  }

  // Обеспечение заявки и контракта.
  if (f.bidSecurityAmount !== null && f.bidSecurityAmount > r.maxBidSecurity) {
    score -= 20;
  }
  if (
    f.contractSecurityAmount !== null &&
    f.contractSecurityAmount > r.maxContractSecurity
  ) {
    score -= 25;
  }

  // Срок оплаты (постоплата) не длиннее допустимого.
  if (f.paymentTermDays > r.maxPaymentTermDays) score -= 20;

  // Аванс.
  const hasAdvance = (f.advancePercent ?? 0) > 0;
  if (!hasAdvance && !r.allowNoAdvance) score -= 20;

  // Маржинальность.
  if (
    f.expectedMarginPercent !== null &&
    f.expectedMarginPercent < r.minMarginPercent
  ) {
    score -= 20;
  }

  return round(clamp(score));
}

/* ============================== Contract Risk ============================== */

const RISK_SEVERITY_WEIGHT: Record<ContractRisk["severity"], number> = {
  CRITICAL: 45,
  HIGH: 25,
  MEDIUM: 12,
  LOW: 5,
};

/**
 * Выявляет риски проекта контракта по тексту документов и финансовым условиям.
 * Возвращает список рисков; числовой contractRisk считается из их severity.
 */
export function analyzeContractRisks(tender: Tender): ContractRisk[] {
  const risks: ContractRisk[] = [];
  const text = buildTenderText(tender).toLowerCase();
  const f = tender.financial;

  const has = (...needles: string[]): boolean =>
    needles.some((n) => text.includes(n));

  if (has("односторонн") && has("отказ", "расторг")) {
    risks.push({
      id: `${tender.id}-risk-unilateral`,
      title: "Право заказчика на односторонний отказ",
      detail:
        "В проекте контракта предусмотрено право заказчика на односторонний отказ от исполнения — риск потери затрат на подготовку.",
      severity: "HIGH",
      evidenceId: null,
    });
  }

  if (has("казначейск") && has("сопровожд")) {
    risks.push({
      id: `${tender.id}-risk-treasury`,
      title: "Казначейское сопровождение",
      detail:
        "Расчёты проходят через казначейское сопровождение: отдельный счёт и ограничения на вывод средств.",
      severity: "MEDIUM",
      evidenceId: null,
    });
  }

  if (has("независим") && has("эксперт")) {
    risks.push({
      id: `${tender.id}-risk-expertise`,
      title: "Независимая экспертиза при приёмке",
      detail:
        "Приёмка сопровождается независимой экспертизой — дополнительные сроки и риск замечаний.",
      severity: "LOW",
      evidenceId: null,
    });
  }

  if (has("приемк") && has("односторонн") && has("удерж")) {
    risks.push({
      id: `${tender.id}-risk-acceptance`,
      title: "Жёсткие условия приёмки и удержания оплаты",
      detail:
        "Заказчик вправе удерживать оплату при односторонней приёмке — риск кассового разрыва.",
      severity: "CRITICAL",
      evidenceId: null,
    });
  }

  if (
    has("неустойк") &&
    (has("0,5%") || has("0,5 %") || has("высокая неустойк"))
  ) {
    risks.push({
      id: `${tender.id}-risk-penalty`,
      title: "Повышенные штрафные санкции",
      detail:
        "Проект контракта содержит повышенный размер неустойки относительно обычного (0,1%).",
      severity: "HIGH",
      evidenceId: null,
    });
  }

  // Финансовое давление как риск.
  if (f.contractSecurityPercent !== null && f.contractSecurityPercent >= 30) {
    risks.push({
      id: `${tender.id}-risk-high-security`,
      title: "Высокое обеспечение контракта",
      detail: `Обеспечение контракта ${f.contractSecurityPercent}% — значительное замораживание средств.`,
      severity: "HIGH",
      evidenceId: null,
    });
  }

  if ((f.advancePercent ?? 0) === 0 && (f.postpaymentDays ?? 0) > 60) {
    risks.push({
      id: `${tender.id}-risk-cashgap`,
      title: "Длительная постоплата без аванса",
      detail: `Оплата через ${f.postpaymentDays} дн. после поставки без аванса — кассовый разрыв.`,
      severity: "MEDIUM",
      evidenceId: null,
    });
  }

  return risks;
}

/** Числовой показатель риска договора 0..100 из списка рисков. */
export function computeContractRiskFromList(risks: ContractRisk[]): number {
  const total = risks.reduce(
    (sum, r) => sum + (RISK_SEVERITY_WEIGHT[r.severity] ?? 0),
    0,
  );
  return round(clamp(total));
}

/* ============================== Hard blockers ============================== */

export function detectHardBlockers(
  tender: Tender,
  profile: CompanyProfile,
  now: Date = new Date(),
): HardBlocker[] {
  const blockers: HardBlocker[] = [];
  const r = profile.restrictions;
  const f = tender.financial;

  /*
    Предмет закупки не совпадает с профилем деятельности.

    Без этого блокера закупка, которую компания не умеет выполнять, всё равно
    набирала проходной балл: четыре остальных показателя начинаются со 100 и
    падают только при явном препятствии, поэтому «нет запретов» складывалось
    в «подходит». Замер на живой выдаче: поставщик компьютеров получал 64 из
    100 на реконструкции подстанции 220 кВ и стоял первым в списке.

    Блокер некритический: совпадение считается по словам профиля, а они
    заполнены человеком и бывают неполными. Вердикт он опускает до
    «не подходит», но не объявляет закупку недопустимой, как истёкший срок.
  */
  /*
    Пустой профиль блокера не даёт.

    Совпадение считается по словам профиля, и когда слов нет вовсе,
    совпадений не будет ни у одной закупки. Раньше это давало «Не подходит»
    всей ленте разом — 198 закупок из 198, — и человек, только что открывший
    сервис, читал, что ему не подходит ничего. Утверждение ложное: «не
    совпало» и «сравнивать не с чем» — разные вещи.
  */
  const subjectFit = computeSubjectFit(tender, profile);
  if (profileDescribesSubject(profile) && subjectFit < SUBJECT_FIT_FLOOR) {
    blockers.push({
      id: `${tender.id}-block-subject`,
      reason: "Предмет закупки не совпадает с профилем компании",
      detail:
        `Соответствие предмета — ${subjectFit} из 100 при пороге ${SUBJECT_FIT_FLOOR}. ` +
        "Ни один код ОКПД2 и почти ни одно слово из профиля в закупке не встретились. " +
        "Если работу вы выполняете, добавьте её в «Профиль компании» — раздел «Что мы поставляем и делаем».",
      evidenceId: null,
      critical: false,
    });
  }

  // Срок подачи истёк — заявку уже не примут, остальные условия не важны.
  // Идёт первым, чтобы причина отказа была первой в списке.
  if (isSubmissionExpired(tender.deadlines.submissionEnd, now)) {
    blockers.push({
      id: `${tender.id}-block-expired`,
      reason: "Срок подачи истёк",
      detail: `Заявки перестали принимать ${new Date(
        tender.deadlines.submissionEnd,
      ).toLocaleString("ru-RU", {
        dateStyle: "long",
        timeStyle: "short",
      })}. Участвовать в этой закупке уже нельзя.`,
      evidenceId: null,
      critical: true,
    });
  }

  // Цена вне диапазона — нарушение обязательного ограничения.
  // Нулевая цена означает «не опубликована», а не «бесплатно»: блокер не ставим.
  if (isPriceKnown(f.price) && (f.price > r.maxPrice || f.price < r.minPrice)) {
    blockers.push({
      id: `${tender.id}-block-price`,
      reason: "Цена вне диапазона профиля",
      detail: `НМЦК ${f.price.toLocaleString("ru-RU")} ₽ вне допустимого диапазона ${r.minPrice.toLocaleString("ru-RU")}–${r.maxPrice.toLocaleString("ru-RU")} ₽.`,
      evidenceId: null,
      critical: true,
    });
  }

  // Регион не входит в географию.
  // Неопределённый регион — не несовпадение, а неизвестность: у ЕИС в поисковой
  // выдаче нет ни региона, ни адреса поставки (в живой базе 109 из 151 закупки
  // идут с «Не указан»), и критический блокер на таком значении молча выкидывает
  // 72% базы. Случай уходит в неопределённости — см. `detectUncertainties`.
  const geography = r.workRegions.filter(Boolean);
  if (geography.length > 0 && isRegionKnown(tender.region)) {
    const regionOk = geography.some((reg) =>
      tender.region.toLowerCase().includes(reg.toLowerCase()),
    );
    if (!regionOk) {
      blockers.push({
        id: `${tender.id}-block-region`,
        reason: "Регион вне географии работы",
        detail: `Регион поставки «${tender.region}» не входит в список регионов компании.`,
        evidenceId: null,
        critical: true,
      });
    }
  }

  // Чёрный список заказчиков.
  if (
    (r.customerBlacklist ?? [])
      .filter(Boolean)
      .some((c) => tender.customerName.toLowerCase().includes(c.toLowerCase()))
  ) {
    blockers.push({
      id: `${tender.id}-block-blacklist`,
      reason: "Заказчик в чёрном списке",
      detail: `Заказчик «${tender.customerName}» находится в чёрном списке компании.`,
      evidenceId: null,
      critical: true,
    });
  }

  // Обязательные лицензии/СРО, которых нет.
  for (const req of tender.requirements) {
    if (!req.mandatory) continue;
    if (req.kind === "LICENSE" || req.kind === "SRO") {
      if (!isRequirementSatisfied(req, tender, profile, now)) {
        blockers.push({
          id: `${tender.id}-block-${req.kind.toLowerCase()}-${req.id}`,
          reason:
            req.kind === "LICENSE"
              ? "Требуется лицензия, которой нет"
              : "Требуется членство в СРО, которого нет",
          detail: req.description,
          evidenceId: req.evidenceId,
          critical: true,
        });
      }
    }
  }

  // Невозможность уложиться в срок поставки — не критический блокер.
  const deliveryDays = tender.deadlines.deliveryTermDays;
  if (deliveryDays !== null && deliveryDays < r.minDeliveryTermDays) {
    blockers.push({
      id: `${tender.id}-block-delivery`,
      reason: "Слишком короткий срок поставки",
      detail: `Требуется поставка за ${deliveryDays} дн., минимально допустимый срок компании — ${r.minDeliveryTermDays} дн.`,
      evidenceId: null,
      critical: false,
    });
  }

  // Обеспечение выше лимита.
  if (
    f.contractSecurityAmount !== null &&
    f.contractSecurityAmount > r.maxContractSecurity
  ) {
    blockers.push({
      id: `${tender.id}-block-security`,
      reason: "Обеспечение контракта выше лимита",
      detail: `Обеспечение контракта ${f.contractSecurityAmount.toLocaleString("ru-RU")} ₽ превышает лимит ${r.maxContractSecurity.toLocaleString("ru-RU")} ₽.`,
      evidenceId: null,
      critical: false,
    });
  }

  // Допуск СРО: вид работ и уровень ответственности против цены закупки.
  blockers.push(...admissionBlockers(tender, profile, now));

  return blockers;
}

/* ============================== Uncertainties ============================== */

export function detectUncertainties(
  tender: Tender,
  profile: CompanyProfile,
  now: Date = new Date(),
): Uncertainty[] {
  const uncertainties: Uncertainty[] = [];

  // Неподтверждённый опыт: нет ни перечня контрактов, ни заявленных сумм.
  const experienceReq = tender.requirements.find(
    (r) => r.mandatory && r.kind === "EXPERIENCE",
  );
  if (experienceReq && profile.experience.length === 0) {
    const totals = resolveExperienceTotals(profile, now);
    const hasDeclaredAmounts =
      totals.lastYearAmount !== null || totals.last3YearsAmount !== null;
    if (!hasDeclaredAmounts) {
      uncertainties.push({
        id: `${tender.id}-unc-experience`,
        question: "Подтверждается ли требуемый опыт?",
        detail:
          "Закупка требует опыт исполнения аналогичных контрактов, но в профиле компании нет записей об опыте.",
        evidenceId: experienceReq.evidenceId,
        material: true,
      });
    }
  }

  // Требуется документ, наличие которого не подтверждено.
  for (const req of tender.requirements) {
    if (req.mandatory && req.kind === "PRODUCT_CHARACTERISTIC") {
      uncertainties.push({
        id: `${tender.id}-unc-char-${req.id}`,
        question: "Соответствует ли товар обязательным характеристикам?",
        detail: req.description,
        evidenceId: req.evidenceId,
        material: true,
      });
    }
  }

  // Недавнее изменение документации.
  if (tender.changeLog.length > 0) {
    const last = tender.changeLog[tender.changeLog.length - 1];
    uncertainties.push({
      id: `${tender.id}-unc-change`,
      question: "Учтены ли последние изменения документации?",
      detail: `Документация изменена ${last?.date ?? ""}: ${last?.description ?? ""}. Требуется повторная проверка.`,
      evidenceId: null,
      material: true,
    });
  }

  // Национальный режим — нужно подтвердить страну происхождения.
  if (tender.nationalRegime) {
    uncertainties.push({
      id: `${tender.id}-unc-national`,
      question: "Подтверждено ли соответствие национальному режиму?",
      detail:
        "Установлен национальный режим: требуется подтверждение страны происхождения товара.",
      evidenceId: null,
      material: false,
    });
  }

  // География закупки не определена. Источник не отдал ни регион, ни адрес
  // поставки, поэтому подтвердить принадлежность к регионам компании можно
  // только в карточке закупки на площадке. Существенная: пока регион неизвестен,
  // честный вердикт — ручная проверка, а не рекомендация.
  const geography = profile.restrictions.workRegions.filter(Boolean);
  if (geography.length > 0 && !isRegionKnown(tender.region)) {
    uncertainties.push({
      id: `${tender.id}-unc-region`,
      question: "Входит ли регион поставки в географию работы компании?",
      detail: `Регион закупки не определён: источник отдал закупку без региона и без адреса поставки. Профиль компании ограничивает географию (${geography.join(", ")}), поэтому принадлежность закупки нужно подтвердить в её карточке на площадке.`,
      evidenceId: null,
      material: true,
    });
  }

  // Допуск СРО, опыт и кадры: спорные случаи уходят на ручную проверку.
  uncertainties.push(...admissionUncertainties(tender, profile, now));

  return uncertainties;
}

/* ============================== Итоговый score и вердикт ============================== */

export function computeScores(
  tender: Tender,
  profile: CompanyProfile,
  contractRisks: ContractRisk[],
  now: Date = new Date(),
): AnalysisScore {
  return {
    subjectFit: computeSubjectFit(tender, profile),
    legalEligibility: computeLegalEligibility(tender, profile, now),
    operationalFit: computeOperationalFit(tender, profile),
    financialFit: computeFinancialFit(tender, profile),
    contractRisk: computeContractRiskFromList(contractRisks),
  };
}

/** Взвешенный Fit Score с инверсией Contract Risk. */
export function computeFitScore(scores: AnalysisScore): number {
  const raw =
    SCORE_WEIGHTS.subjectFit * scores.subjectFit +
    SCORE_WEIGHTS.legalEligibility * scores.legalEligibility +
    SCORE_WEIGHTS.operationalFit * scores.operationalFit +
    SCORE_WEIGHTS.financialFit * scores.financialFit +
    SCORE_WEIGHTS.contractRisk * (100 - scores.contractRisk);
  return round(clamp(raw));
}

/**
 * Критически близкий срок подачи (менее 24 часов).
 *
 * Истёкший срок критическим не считается — он уже не требует решения, он
 * требует отказа: см. `isSubmissionExpired` и блокер «Срок подачи истёк».
 */
export function isCriticalDeadline(
  submissionEnd: string,
  now: Date = new Date(),
): boolean {
  const end = new Date(submissionEnd).getTime();
  if (Number.isNaN(end)) return false;
  const hours = (end - now.getTime()) / (1000 * 60 * 60);
  return hours >= 0 && hours <= CRITICAL_DEADLINE_HOURS;
}

/**
 * Срок подачи истёк: участвовать нельзя.
 *
 * Пустую или неразобранную дату истёкшей не считаем. У ЕИС часть строк приходит
 * без срока, и блокер на пустом значении молча отклонил бы всю базу — лучше
 * неопределённость, чем ложный отказ.
 */
export function isSubmissionExpired(
  submissionEnd: string,
  now: Date = new Date(),
): boolean {
  const end = new Date(submissionEnd).getTime();
  if (Number.isNaN(end)) return false;
  return end <= now.getTime();
}

/**
 * Подача закрывается в ближайшие `days` дней — то, что попадает в блок
 * «Срочно». Истёкшие не в счёт: это не «срочно», а «поздно».
 */
export function isClosingWithinDays(
  submissionEnd: string,
  days: number = URGENT_DEADLINE_DAYS,
  now: Date = new Date(),
): boolean {
  const end = new Date(submissionEnd).getTime();
  if (Number.isNaN(end)) return false;
  const hours = (end - now.getTime()) / (1000 * 60 * 60);
  return hours > 0 && hours <= days * 24;
}

export interface VerdictInput {
  fitScore: number;
  hardBlockers: HardBlocker[];
  uncertainties: Uncertainty[];
  requiredDocumentsUnconfirmed: boolean;
  criticalDeadline: boolean;
  /** Есть ли риск проекта контракта критической или высокой severity. */
  seriousContractRisk?: boolean;
  /**
   * Описывает ли профиль предмет деятельности — есть ли с чем сравнивать.
   *
   * Отсутствует или `true` — прежнее поведение. `false` снимает отрицательный
   * вердикт по низкому баллу: половину балла даёт совпадение предмета, и при
   * пустом профиле он падает ниже 50 у всех закупок подряд.
   */
  profileDescribesSubject?: boolean;
}

/**
 * Правила вердикта (раздел 10 ТЗ):
 * NOT_RECOMMENDED — score < 50 ИЛИ критический блокер ИЛИ нарушение обязательного ограничения.
 * RECOMMENDED — score >= 75 И нет блокеров И нет существенных неопределённостей
 *   И нет неподтверждённых обязательных документов И срок не критический
 *   И нет критического риска договора.
 * MANUAL_REVIEW — иначе (score 50..74, существенная неопределённость,
 *   неподтверждённый документ, критический срок или критический риск договора).
 */
export function deriveVerdict(input: VerdictInput): TenderVerdict {
  const hasCriticalBlocker = input.hardBlockers.some((b) => b.critical);
  const hasAnyBlocker = input.hardBlockers.length > 0;
  const hasMaterialUncertainty = input.uncertainties.some((u) => u.material);

  if (hasCriticalBlocker) {
    return "NOT_RECOMMENDED";
  }

  /*
    Низкий балл объявляет закупку неподходящей, только когда профиль описывает
    предмет деятельности. Иначе сравнивать не с чем: половину балла даёт
    совпадение предмета, при пустом профиле оно равно нулю, и «score < 50»
    срабатывало у всех закупок подряд — на живой ленте 198 из 198 получали
    «Не подходит».

    Отрицательный вердикт — такое же утверждение, как положительный, и ничем
    не обеспечен, пока профиль пуст. Остаётся «решает человек»: оснований
    судить нет, и об этом сказано прямо.
  */
  const subjectKnown = input.profileDescribesSubject ?? true;
  if (subjectKnown && input.fitScore < 50) {
    return "NOT_RECOMMENDED";
  }

  const canRecommend =
    input.fitScore >= 75 &&
    !hasAnyBlocker &&
    !hasMaterialUncertainty &&
    !input.requiredDocumentsUnconfirmed &&
    !input.criticalDeadline &&
    !input.seriousContractRisk;

  if (canRecommend) {
    return "RECOMMENDED";
  }

  return "MANUAL_REVIEW";
}

// --- Document analysis verdict engine ---

import type { AnalysisFinding } from "@/types/database";
import { demoteUniversalBlockers } from "@/domain/scoring/documentFindings";

/** Заголовки находок без повторов, в порядке первого появления. */
function uniqueTitles(findings: readonly AnalysisFinding[]): string[] {
  return [...new Set(findings.map((finding) => finding.title.trim()))];
}

export interface ApplyDocumentFindingsInput {
  /**
   * Текущий вердикт закупки. null — вердикт ещё нигде не зафиксирован:
   * разбор документации может запуститься раньше, чем появится история вердиктов.
   */
  currentVerdict: TenderVerdict | null;
  /** Оценка соответствия до разбора документов. Необязательна: функция её не меняет. */
  currentScore?: number | null;
  findings: AnalysisFinding[];
}

export interface ApplyDocumentFindingsResult {
  verdict: TenderVerdict | null;
  worsened: boolean;
  reason: string;
}

/**
 * Recalculate verdict based on AI findings from document analysis.
 * AI analysis can only WORSEN the verdict, never improve it.
 * - High-severity blocker → NOT_RECOMMENDED
 * - High-severity risk OR 2+ medium risks → MANUAL_REVIEW
 * - Otherwise → no change
 *
 * При currentVerdict = null «ухудшением» считается сам значимый фактор:
 * сравнивать не с чем, но промолчать о блокере значит скрыть его от пользователя.
 */
export function applyDocumentFindings(
  input: ApplyDocumentFindingsInput,
): ApplyDocumentFindingsResult {
  const { currentVerdict } = input;

  /*
    Псевдо-блокеры понижаются до вердикта, а не после.

    Модель называет блокером всё, что «делает участие невозможным», и типовые
    условия допуска по 223-ФЗ подходят под это дословно. Один такой блокер с
    высокой важностью отправляет закупку в NOT_RECOMMENDED, поэтому фильтр
    обязан стоять здесь: правило вердикта не должно зависеть от формулировки,
    которую выбрала модель.
  */
  const findings = demoteUniversalBlockers(input.findings);

  const highBlockers = findings.filter(
    (f) => f.category === "blocker" && f.severity === "high",
  );
  const highRisks = findings.filter(
    (f) => f.category === "risk" && f.severity === "high",
  );
  const mediumRisks = findings.filter(
    (f) => f.category === "risk" && f.severity === "medium",
  );

  // High-severity blocker → NOT_RECOMMENDED
  if (highBlockers.length > 0) {
    if (currentVerdict === "NOT_RECOMMENDED") {
      return {
        verdict: currentVerdict,
        worsened: false,
        reason: "Вердикт не изменился",
      };
    }
    // Одно и то же требование модель находит в нескольких фрагментах документа,
    // и причина вердикта превращалась в список с четырьмя дублями подряд.
    const blockerTitles = uniqueTitles(highBlockers).join("; ");
    return {
      verdict: "NOT_RECOMMENDED",
      worsened: true,
      reason: `Обнаружены блокирующие факторы: ${blockerTitles}`,
    };
  }

  // High-severity risk or 2+ medium risks → MANUAL_REVIEW
  if (highRisks.length > 0 || mediumRisks.length >= 2) {
    if (
      currentVerdict === "NOT_RECOMMENDED" ||
      currentVerdict === "MANUAL_REVIEW"
    ) {
      return {
        verdict: currentVerdict,
        worsened: false,
        reason: "Вердикт не изменился",
      };
    }
    const riskTitles = uniqueTitles([...highRisks, ...mediumRisks]).join("; ");
    return {
      verdict: "MANUAL_REVIEW",
      worsened: true,
      reason: `Обнаружены риски: ${riskTitles}`,
    };
  }

  // No significant findings → no change
  return {
    verdict: currentVerdict,
    worsened: false,
    reason: "Значимых факторов не обнаружено",
  };
}
