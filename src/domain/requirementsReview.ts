import type {
  CompanyProfile,
  RequirementGroup,
  RequirementGroupKey,
  RequirementGroupStatus,
  RequirementItem,
  Tender,
  TenderAnalysis,
  TenderRequirement,
} from "@/domain/entities";
import { isPriceKnown } from "@/domain/entities";
import { isCriticalDeadline } from "@/domain/scoring";
import {
  checkExperienceAdmission,
  checkPersonnelAdmission,
  checkSroAdmission,
  describeSroPosition,
  isRequirementSatisfied,
  largestContractAmount,
  resolveExperienceTotals,
  sroKindsLabel,
} from "@/domain/scoring/admission";

/**
 * Полноценный разбор требований: распределяет условия закупки по группам
 * (предмет, допуск, документы заявки, сроки, экономика, договорные условия)
 * и для каждой группы/пункта выдаёт статус соответствия профилю компании.
 * Чистая детерминированная функция: анализ и профиль — на входе, статусы — на выходе.
 */

const GROUP_TITLES: Record<RequirementGroupKey, string> = {
  SUBJECT: "Предмет закупки",
  ADMISSION: "Допуск участников",
  APPLICATION_DOCS: "Документы заявки",
  DEADLINES: "Сроки",
  ECONOMICS: "Экономика",
  CONTRACT_TERMS: "Договорные условия",
};

/** Статус по числовому показателю соответствия 0..100. */
export function statusFromScore(score: number): RequirementGroupStatus {
  if (score >= 75) return "MATCH";
  if (score >= 50) return "REVIEW";
  return "MISMATCH";
}

function worst(a: RequirementGroupStatus, b: RequirementGroupStatus): RequirementGroupStatus {
  const rank: Record<RequirementGroupStatus, number> = { MATCH: 0, REVIEW: 1, MISMATCH: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function groupStatus(items: RequirementItem[], fallback: RequirementGroupStatus): RequirementGroupStatus {
  if (items.length === 0) return fallback;
  return items.reduce<RequirementGroupStatus>((acc, i) => worst(acc, i.status), "MATCH");
}

/** Требует ли вид требования автоматической проверки (иначе — ручная). */
const AUTO_CHECKABLE = new Set([
  "LICENSE",
  "SRO",
  "EXPERIENCE",
  "QUALIFIED_PERSONNEL",
  "EQUIPMENT",
]);

export interface RequirementCheckSummary {
  /** Подтверждается ли требование данными профиля. */
  satisfied: boolean;
  /** Пояснение для карточки: что именно сверено и чего не хватает. */
  note: string | null;
  /** Данных профиля не хватило для однозначного вывода — нужна ручная проверка. */
  inconclusive: boolean;
}

/**
 * Результат автоматической проверки требования с пояснением.
 * Правила те же, что в движке скоринга: реализация общая (scoring/admission),
 * здесь добавляется только текст для показа в разборе требований.
 */
export function describeRequirementCheck(
  requirement: TenderRequirement,
  tender: Tender,
  profile: CompanyProfile,
  now: Date = new Date(),
): RequirementCheckSummary {
  const satisfied = isRequirementSatisfied(requirement, tender, profile, now);

  switch (requirement.kind) {
    case "SRO": {
      const position = describeSroPosition(tender, profile, now);
      return { satisfied, note: position, inconclusive: false };
    }
    case "EXPERIENCE": {
      const check = checkExperienceAdmission(requirement, tender, profile, now);
      return {
        satisfied: check.satisfied,
        note: check.reason ?? check.inconclusive,
        inconclusive: check.inconclusive !== null && check.reason === null,
      };
    }
    case "QUALIFIED_PERSONNEL": {
      const check = checkPersonnelAdmission(requirement, profile);
      return {
        satisfied: check.satisfied,
        note: check.reason ?? check.inconclusive,
        inconclusive: check.inconclusive !== null && check.reason === null,
      };
    }
    case "LICENSE": {
      if (satisfied) return { satisfied, note: null, inconclusive: false };
      return {
        satisfied,
        note: `В профиле нет подтверждённой лицензии «${requirement.requiredValue ?? requirement.title}».`,
        inconclusive: false,
      };
    }
    case "EQUIPMENT": {
      if (satisfied) return { satisfied, note: null, inconclusive: false };
      return {
        satisfied,
        note: "В профиле не отмечено наличие необходимой техники.",
        inconclusive: false,
      };
    }
    default:
      return { satisfied: false, note: null, inconclusive: true };
  }
}

/** Цена лота: нуль означает «не опубликована», а не бесплатную закупку. */
function lotPriceLabel(price: number): string {
  return isPriceKnown(price)
    ? `${price.toLocaleString("ru-RU")} ₽`
    : "цена не опубликована";
}

const money = (n: number): string => `${n.toLocaleString("ru-RU")} ₽`;

/** Пункт разбора «Допуск СРО»: что требует закупка и что есть в профиле. */
function buildSroItem(
  tender: Tender,
  profile: CompanyProfile,
  now: Date,
): RequirementItem | null {
  const check = checkSroAdmission(tender, profile, now);
  if (check.kinds.length === 0) return null;
  const position = describeSroPosition(tender, profile, now) ?? "";

  let status: RequirementGroupStatus = "MATCH";
  if (check.blocker) status = "MISMATCH";
  else if (check.covered.length === 0) {
    // Допусков в профиле нет вовсе: утверждать, что они обязательны, нельзя.
    status = profile.sroMemberships.length === 0 ? "REVIEW" : "MISMATCH";
  } else if (check.uncertainties.length > 0 || check.shortfalls.length > 0) {
    status = "REVIEW";
  }

  return {
    id: "ad-sro-subject",
    label: `Допуск СРО: ${sroKindsLabel(check.kinds)}`,
    value: check.blocker
      ? `${check.blocker.reason}: ${check.blocker.detail}`
      : position,
    status,
    evidenceId: null,
  };
}

/** Пункт разбора «Кадровый состав»: численность, НРС, НОПРИЗ. */
function buildStaffItem(
  tender: Tender,
  profile: CompanyProfile,
): RequirementItem | null {
  const staff = profile.staff;
  const declared =
    staff.total !== null || staff.nrsCount > 0 || staff.noprizCount > 0;
  const requirement = tender.requirements.find(
    (r) => r.mandatory && r.kind === "QUALIFIED_PERSONNEL",
  );
  if (!declared && !requirement) return null;

  const check = requirement ? checkPersonnelAdmission(requirement, profile) : null;
  const threshold = check?.threshold ?? {
    minTotal: null,
    minNrs: null,
    minNopriz: null,
  };
  const parts: string[] = [];
  parts.push(staff.total !== null ? `штат ${staff.total} чел.` : "численность не указана");
  if (staff.nrsCount > 0 || threshold.minNrs !== null) {
    parts.push(`в НРС ${staff.nrsCount}`);
  }
  if (staff.noprizCount > 0 || threshold.minNopriz !== null) {
    parts.push(`в НОПРИЗ ${staff.noprizCount}`);
  }
  const required: string[] = [];
  if (threshold.minTotal !== null) {
    required.push(`не менее ${threshold.minTotal} чел.`);
  }
  if (threshold.minNrs !== null) {
    required.push(`в НРС не менее ${threshold.minNrs}`);
  }
  if (threshold.minNopriz !== null) {
    required.push(`в НОПРИЗ не менее ${threshold.minNopriz}`);
  }

  const value = required.length > 0
    ? `${parts.join(", ")}; требование закупки: ${required.join(", ")}${check?.reason ? `. ${check.reason}` : ""}`
    : parts.join(", ");

  return {
    id: "ad-staff",
    label: "Кадровый состав",
    value,
    status: !check
      ? declared
        ? "MATCH"
        : "REVIEW"
      : check.reason
        ? "MISMATCH"
        : check.inconclusive
          ? "REVIEW"
          : "MATCH",
    evidenceId: null,
  };
}

/** Пункт разбора «Опыт»: суммы исполненных работ и крупнейший контракт. */
function buildExperienceItem(
  tender: Tender,
  profile: CompanyProfile,
  now: Date,
): RequirementItem | null {
  const totals = resolveExperienceTotals(profile, now);
  const requirement = tender.requirements.find(
    (r) => r.mandatory && r.kind === "EXPERIENCE",
  );
  const known =
    totals.lastYearAmount !== null ||
    totals.last3YearsAmount !== null ||
    profile.experience.length > 0;
  if (!known && !requirement) return null;

  const check = requirement
    ? checkExperienceAdmission(requirement, tender, profile, now)
    : null;
  const largest = largestContractAmount(profile, null, now);

  const parts: string[] = [];
  parts.push(
    totals.lastYearAmount !== null
      ? `за предыдущий год ${money(totals.lastYearAmount)}`
      : "сумма за предыдущий год не указана",
  );
  parts.push(
    totals.last3YearsAmount !== null
      ? `за 3 года ${money(totals.last3YearsAmount)}`
      : "сумма за 3 года не указана",
  );
  if (profile.experience.length > 0) {
    parts.push(`контрактов в профиле: ${profile.experience.length}`);
  }
  if (largest !== null) {
    parts.push(`наибольший ${money(largest)}`);
  }

  const value = check?.reason
    ? `${parts.join("; ")}. Требование не подтверждается: ${check.reason}`
    : check?.inconclusive
      ? `${parts.join("; ")}. ${check.inconclusive}`
      : parts.join("; ");

  return {
    id: "ad-experience",
    label: "Опыт исполнения контрактов",
    value,
    status: !check
      ? known
        ? "MATCH"
        : "REVIEW"
      : check.reason
        ? "MISMATCH"
        : check.inconclusive
          ? "REVIEW"
          : "MATCH",
    evidenceId: null,
  };
}

export function buildRequirementGroups(
  tender: Tender,
  analysis: TenderAnalysis,
  profile: CompanyProfile,
  now: Date = new Date(),
): RequirementGroup[] {
  const groups: RequirementGroup[] = [];

  /* --- Предмет --- */
  const subjectItems: RequirementItem[] = [];
  for (const lot of tender.lots) {
    subjectItems.push({
      id: `sg-lot-${lot.id}`,
      label: `Лот № ${lot.number}`,
      value: `${lot.subject} — ${lotPriceLabel(lot.price)}, ОКПД2 ${lot.okpd2Codes.join(", ") || "—"}`,
      status: "REVIEW",
      evidenceId: null,
    });
  }
  for (const r of analysis.requirements.filter((x) => x.kind === "PRODUCT_CHARACTERISTIC")) {
    subjectItems.push({
      id: `sg-char-${r.id}`,
      label: r.title,
      value: r.description,
      status: "REVIEW",
      evidenceId: r.evidenceId,
    });
  }
  const subjectOkpd = analysis.evidence.some(
    (e) => e.section === "ОКПД2" && e.source === "SYSTEM_RULE",
  );
  const subjectBase: RequirementItem = {
    id: "sg-subject-fit",
    label: "Сопоставление предмета с профилем",
    value: `Оценка соответствия предмета: ${analysis.scores.subjectFit}/100${subjectOkpd ? " · ОКПД2 совпадает с профилем" : ""}`,
    status: statusFromScore(analysis.scores.subjectFit),
    evidenceId: null,
  };
  groups.push({
    key: "SUBJECT",
    title: GROUP_TITLES.SUBJECT,
    status: groupStatus([subjectBase, ...subjectItems], "MATCH"),
    items: [subjectBase, ...subjectItems],
  });

  /* --- Допуск --- */
  const admissionItems: RequirementItem[] = analysis.requirements
    .filter((r) => r.kind !== "PRODUCT_CHARACTERISTIC")
    .map((r) => {
      const autoCheckable = AUTO_CHECKABLE.has(r.kind);
      const check = describeRequirementCheck(r, tender, profile, now);
      const note = check.note ? ` ${check.note}` : "";
      const status: RequirementGroupStatus = !autoCheckable
        ? "REVIEW"
        : check.inconclusive
          ? "REVIEW"
          : check.satisfied
            ? "MATCH"
            : r.mandatory
              ? "MISMATCH"
              : "REVIEW";
      return {
        id: `ad-${r.id}`,
        label: r.title,
        value: `${r.description}${r.mandatory ? " · обязательно" : " · рекомендуемое"}.${note}`,
        status,
        evidenceId: r.evidenceId,
      };
    });

  // Позиция профиля по допуску: СРО, кадры, опыт. Пункты добавляются только
  // тогда, когда по закупке или по профилю есть что показать.
  const sroItem = buildSroItem(tender, profile, now);
  if (sroItem) admissionItems.push(sroItem);
  const staffItem = buildStaffItem(tender, profile);
  if (staffItem) admissionItems.push(staffItem);
  const experienceItem = buildExperienceItem(tender, profile, now);
  if (experienceItem) admissionItems.push(experienceItem);

  if (tender.onlyForSmp) {
    admissionItems.push({
      id: "ad-smp",
      label: "Закупка только для СМП/СОНО",
      value: "Участие допускается только для субъектов МСП и социально-некоммерческих организаций.",
      status: "REVIEW",
      evidenceId: null,
    });
  }
  if (tender.nationalRegime) {
    admissionItems.push({
      id: "ad-national",
      label: "Национальный режим",
      value: "Требуется подтверждение страны происхождения товара.",
      status: "REVIEW",
      evidenceId: null,
    });
  }
  groups.push({
    key: "ADMISSION",
    title: GROUP_TITLES.ADMISSION,
    status: groupStatus(admissionItems, statusFromScore(analysis.scores.legalEligibility)),
    items: admissionItems,
  });

  /* --- Документы заявки --- */
  const docItems: RequirementItem[] = analysis.requiredDocuments.map((d) => ({
    id: `doc-${d.id}`,
    label: d.title,
    value: d.confirmedInProfile
      ? "Подтверждён в профиле компании"
      : "Наличие в профиле не подтверждено",
    status: d.confirmedInProfile ? ("MATCH" as const) : ("REVIEW" as const),
    evidenceId: null,
  }));
  groups.push({
    key: "APPLICATION_DOCS",
    title: GROUP_TITLES.APPLICATION_DOCS,
    status: groupStatus(docItems, "MATCH"),
    items: docItems,
  });

  /* --- Сроки --- */
  const critical = isCriticalDeadline(tender.deadlines.submissionEnd, now);
  const deliveryTooShort =
    tender.deadlines.deliveryTermDays !== null &&
    tender.deadlines.deliveryTermDays < profile.restrictions.minDeliveryTermDays;
  const deadlineItems: RequirementItem[] = [
    {
      id: "dl-submission",
      label: "Окончание подачи заявок",
      value: critical
        ? "Менее 24 часов до окончания подачи — решение требуется немедленно"
        : "Срок подачи достаточен для подготовки заявки",
      status: critical ? "MISMATCH" : "MATCH",
      evidenceId: null,
    },
    {
      id: "dl-delivery",
      label: "Срок поставки",
      value:
        tender.deadlines.deliveryTermDays !== null
          ? `${tender.deadlines.deliveryTermDays} дн.${deliveryTooShort ? ` — короче минимально допустимого (${profile.restrictions.minDeliveryTermDays} дн.)` : ""}`
          : "Не указан в документации",
      status: deliveryTooShort ? "MISMATCH" : tender.deadlines.deliveryTermDays === null ? "REVIEW" : "MATCH",
      evidenceId: null,
    },
  ];
  if (tender.deadlines.warrantyMonths !== null) {
    deadlineItems.push({
      id: "dl-warranty",
      label: "Гарантия",
      value: `${tender.deadlines.warrantyMonths} мес.`,
      status: "MATCH",
      evidenceId: null,
    });
  }
  groups.push({
    key: "DEADLINES",
    title: GROUP_TITLES.DEADLINES,
    status: groupStatus(deadlineItems, "MATCH"),
    items: deadlineItems,
  });

  /* --- Экономика --- */
  const f = tender.financial;
  const r = profile.restrictions;
  const econItems: RequirementItem[] = [
    {
      id: "ec-price",
      label: "НМЦК в допустимом диапазоне",
      value: isPriceKnown(f.price)
        ? `${f.price.toLocaleString("ru-RU")} ₽ (профиль: ${r.minPrice.toLocaleString("ru-RU")}–${r.maxPrice.toLocaleString("ru-RU")} ₽)`
        : `не опубликована (профиль: ${r.minPrice.toLocaleString("ru-RU")}–${r.maxPrice.toLocaleString("ru-RU")} ₽)`,
      // Цену проверить нечем — пункт уходит на ручную проверку, а не в несоответствие.
      status: !isPriceKnown(f.price)
        ? "REVIEW"
        : f.price > r.maxPrice || f.price < r.minPrice
          ? "MISMATCH"
          : "MATCH",
      evidenceId: null,
    },
    {
      id: "ec-payment",
      label: "Срок оплаты не длиннее допустимого",
      value: `${f.paymentTermDays} дн. (лимит: ${r.maxPaymentTermDays} дн.)`,
      status: f.paymentTermDays > r.maxPaymentTermDays ? "MISMATCH" : "MATCH",
      evidenceId: null,
    },
    {
      id: "ec-bid-security",
      label: "Обеспечение заявки в лимите",
      value:
        f.bidSecurityAmount !== null
          ? `${f.bidSecurityAmount.toLocaleString("ru-RU")} ₽ (лимит: ${r.maxBidSecurity.toLocaleString("ru-RU")} ₽)${f.bidSecurityAmount > r.maxBidSecurity ? "" : ""}`
          : "Не требуется",
      status:
        f.bidSecurityAmount !== null && f.bidSecurityAmount > r.maxBidSecurity
          ? "REVIEW"
          : "MATCH",
      evidenceId: null,
    },
    {
      id: "ec-contract-security",
      label: "Обеспечение контракта в лимите",
      value:
        f.contractSecurityAmount !== null
          ? `${f.contractSecurityAmount.toLocaleString("ru-RU")} ₽ (лимит: ${r.maxContractSecurity.toLocaleString("ru-RU")} ₽)`
          : "Не требуется",
      status:
        f.contractSecurityAmount !== null &&
        f.contractSecurityAmount > r.maxContractSecurity
          ? "MISMATCH"
          : "MATCH",
      evidenceId: null,
    },
    {
      id: "ec-advance",
      label: "Авансирование",
      value:
        (f.advancePercent ?? 0) > 0
          ? `Аванс ${f.advancePercent}%`
          : r.allowNoAdvance
            ? "Без аванса — допустимо по профилю"
            : "Без аванса — против условия профиля",
      status:
        (f.advancePercent ?? 0) > 0 || r.allowNoAdvance ? "MATCH" : "MISMATCH",
      evidenceId: null,
    },
  ];
  if (f.expectedMarginPercent !== null) {
    econItems.push({
      id: "ec-margin",
      label: "Ожидаемая маржинальность",
      value: `${f.expectedMarginPercent}% (минимум профиля: ${r.minMarginPercent}%)`,
      status: f.expectedMarginPercent < r.minMarginPercent ? "MISMATCH" : "MATCH",
      evidenceId: null,
    });
  }
  groups.push({
    key: "ECONOMICS",
    title: GROUP_TITLES.ECONOMICS,
    status: statusFromScore(analysis.scores.financialFit),
    items: econItems,
  });

  /* --- Договорные условия --- */
  const contractItems: RequirementItem[] = analysis.contractRisks.map((risk) => ({
    id: `ct-${risk.id}`,
    label: risk.title,
    value: risk.detail,
    status:
      risk.severity === "CRITICAL" || risk.severity === "HIGH"
        ? "MISMATCH"
        : risk.severity === "MEDIUM"
          ? "REVIEW"
          : "MATCH",
    evidenceId: risk.evidenceId,
  }));
  /*
    По 44-ФЗ казначейское сопровождение — типовое условие, которое знает каждый исполнитель
    (замечание владельца 14.10.2026): в «Договорных условиях» оно появляется, только если
    профиль прямо отмечает, что компания его избегает. Для 223-ФЗ и коммерческих закупок
    это выбор заказчика, и строка остаётся как была.
  */
  if (f.treasurySupport && (tender.law !== "FZ_44" || profile.preferences.avoidTreasurySupport)) {
    contractItems.push({
      id: "ct-treasury",
      label: "Казначейское сопровождение",
      value: profile.preferences.avoidTreasurySupport
        ? "Требуется казначейское сопровождение — в профиле отмечено избегание (проверьте открытие спецсчёта)"
        : "Требуется казначейское сопровождение",
      status: profile.preferences.avoidTreasurySupport ? "REVIEW" : "MATCH",
      evidenceId: null,
    });
  }
  groups.push({
    key: "CONTRACT_TERMS",
    title: GROUP_TITLES.CONTRACT_TERMS,
    status: groupStatus(contractItems, "MATCH"),
    items: contractItems,
  });

  return groups;
}
