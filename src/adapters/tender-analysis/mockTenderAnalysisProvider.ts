import type {
  CompanyProfile,
  ContractRisk,
  ContractRiskCategory,
  Evidence,
  Fz223Specific,
  HardBlocker,
  OperationalFitDetails,
  RequiredDocument,
  Tender,
  TenderAnalysis,
  TenderRequirement,
  Uncertainty,
} from "@/domain/entities";
import {
  analyzeContractRisks,
  buildTenderText,
  computeFitScore,
  computeScores,
  deriveVerdict,
  detectHardBlockers,
  detectUncertainties,
  isCriticalDeadline,
  isSubmissionExpired,
} from "@/domain/scoring";
import { matchCapabilities } from "@/domain/scoring/matching";
import {
  hasAdmissibleSro,
  resolveExperienceTotals,
} from "@/domain/scoring/admission";
import { tenderAnalysisSchema } from "@/domain/schemas";
import { profileDescribesSubject } from "@/domain/emptyCompanyProfile";
import type { TenderAnalysisProvider } from "@/adapters/types";
import { isRegionKnown } from "@/domain/entities";

/**
 * Mock-реализация AI-анализа: детерминированно рассчитывает вердикт,
 * пять показателей, доказательства, блокеры, риски и следующие действия
 * на основе движка скоринга. Результат валидируется через Zod.
 *
 * Каждое заключение (фактор, блокер, риск, неопределённость, вердикт)
 * трассируется до доказательства: документ, страница, раздел, цитата,
 * тип источника (факт из документа / данные профиля / вывод AI / правило).
 */

let evidenceCounter = 0;
const nextEvidenceId = (): string => `ev-${++evidenceCounter}`;

/** Ищет предложение в тексте, содержащее подстроку (для цитаты-доказательства). */
function sentenceWith(text: string, needle: string): string | null {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(
    text.lastIndexOf(".", idx),
    text.lastIndexOf("!", idx),
    text.lastIndexOf("?", idx),
  );
  let end = text.indexOf(".", idx + needle.length);
  if (end < 0) end = text.length;
  const sentence = text.slice(start + 1, end).trim();
  if (!sentence) return null;
  return sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence;
}

/** Ключ риска из его id: `${tenderId}-risk-${key}`. */
function riskKey(risk: ContractRisk): string {
  const idx = risk.id.lastIndexOf("-risk-");
  return idx < 0 ? "" : risk.id.slice(idx + 6);
}

/** Подстроки-маркеры для поиска цитаты в документации по типу риска. */
const RISK_NEEDLES: Record<string, string[]> = {
  unilateral: ["односторононн"],
  treasury: ["казначейск"],
  expertise: ["эксперт"],
  acceptance: ["удерж"],
  penalty: ["неустойк"],
  "high-security": [],
  cashgap: [],
};

/** Маппинг ключа риска на категорию для группировки в UI. */
const RISK_CATEGORY: Record<string, ContractRiskCategory> = {
  unilateral: "UNILATERAL_REFUSAL",
  treasury: "TREASURY",
  acceptance: "ACCEPTANCE",
  penalty: "PENALTY",
  "high-security": "WARRANTY",
  cashgap: "CASH_GAP",
};

function buildBaseEvidence(tender: Tender, profile: CompanyProfile): Evidence[] {
  const evidence: Evidence[] = [];
  const text = buildTenderText(tender);

  const cap = profile.capabilities;
  const match = matchCapabilities(
    text,
    [...cap.keywords, ...cap.products, ...cap.services],
    cap.stopWords,
    tender.okpd2Codes,
    cap.okpd2Codes,
  );
  const tz = tender.documents.find((d) => d.type === "TECHNICAL_SPEC");
  if (match.matchedKeywords.length > 0 && tz) {
    const quoteSentence =
      sentenceWith(tz.text, match.matchedKeywords[0] as string) ??
      `В документации найдены соответствия: ${match.matchedKeywords.slice(0, 5).join(", ")}.`;
    evidence.push({
      id: nextEvidenceId(),
      source: "TENDER_DOCUMENT",
      documentId: tz.id,
      documentTitle: tz.title,
      page: 1,
      section: "Предмет закупки",
      quote: quoteSentence,
      confidence: "HIGH",
    });
  }
  if (match.okpd2Matched) {
    evidence.push({
      id: nextEvidenceId(),
      source: "SYSTEM_RULE",
      documentId: null,
      documentTitle: null,
      page: null,
      section: "ОКПД2",
      quote: `Код ОКПД2 закупки ${tender.okpd2Codes.join(", ")} совпадает с профилем компании.`,
      confidence: "HIGH",
    });
  }
  if (match.matchedStopWords.length > 0) {
    evidence.push({
      id: nextEvidenceId(),
      source: "SYSTEM_RULE",
      documentId: null,
      documentTitle: null,
      page: null,
      section: "Стоп-слова",
      quote: `Обнаружены стоп-слова: ${match.matchedStopWords.join(", ")}. Возможное несоответствие профилю.`,
      confidence: "MEDIUM",
    });
  }

  evidence.push({
    id: nextEvidenceId(),
    source: "COMPANY_PROFILE",
    documentId: null,
    documentTitle: "Профиль компании",
    page: null,
    section: "Финансовые ограничения",
    quote: `Допустимый диапазон НМЦК: ${profile.restrictions.minPrice.toLocaleString("ru-RU")}–${profile.restrictions.maxPrice.toLocaleString("ru-RU")} ₽.`,
    confidence: "HIGH",
  });

  return evidence;
}

/** Доказательства по требованиям из документации (трассировка группы «Требования»). */
function buildRequirementEvidence(
  tender: Tender,
): { requirement: TenderRequirement; evidence: Evidence }[] {
  const tz = tender.documents.find((d) => d.type === "TECHNICAL_SPEC");
  const notice = tender.documents.find((d) => d.type === "NOTICE");
  return tender.requirements.map((r) => {
    const doc = tz ?? notice;
    const ev: Evidence = {
      id: nextEvidenceId(),
      source: "TENDER_DOCUMENT",
      documentId: doc?.id ?? null,
      documentTitle: doc?.title ?? null,
      page: 2,
      section: "Требования к участникам",
      quote: r.description,
      confidence: "HIGH",
    };
    return { requirement: { ...r, evidenceId: ev.id }, evidence: ev };
  });
}

/** Доказательства-цитаты для рисков проекта контракта. */
function linkRiskEvidence(tender: Tender, risks: ContractRisk[]): { risk: ContractRisk; evidence: Evidence | null }[] {
  const contractDoc =
    tender.documents.find((d) => d.type === "DRAFT_CONTRACT") ??
    tender.documents.find((d) => d.type === "TECHNICAL_SPEC") ??
    tender.documents[0];
  const fullText = buildTenderText(tender);
  return risks.map((risk) => {
    const key = riskKey(risk);
    const needles = RISK_NEEDLES[key] ?? [];
    const f = tender.financial;
    let quote: string | null = null;
    let source: Evidence["source"] = "TENDER_DOCUMENT";
    let section: string | null = "Условия договора";
    for (const needle of needles) {
      quote = sentenceWith(fullText, needle);
      if (quote) break;
    }
    if (quote === null) {
      // Финансовые условия вычисляются из реквизитов извещения.
      source = "SYSTEM_RULE";
      section = "Финансовые условия";
      quote =
        key === "high-security"
          ? `Обеспечение контракта ${f.contractSecurityPercent}% (${(f.contractSecurityAmount ?? 0).toLocaleString("ru-RU")} ₽) из реквизитов закупки.`
          : `Аванс ${f.advancePercent ?? 0}%, постоплата ${f.postpaymentDays ?? 0} дн. из реквизитов закупки.`;
    }
    const ev: Evidence = {
      id: nextEvidenceId(),
      source,
      documentId: source === "TENDER_DOCUMENT" ? (contractDoc?.id ?? null) : null,
      documentTitle: source === "TENDER_DOCUMENT" ? (contractDoc?.title ?? null) : null,
      page: source === "TENDER_DOCUMENT" ? 3 : null,
      section,
      quote,
      confidence: "MEDIUM",
    };
    return { risk: { ...risk, evidenceId: ev.id, category: RISK_CATEGORY[riskKey(risk)] }, evidence: ev };
  });
}

/** Специфика 223-ФЗ: положение о закупке, спецтребования, отличия от 44-ФЗ. */
function buildFz223Specific(tender: Tender): Fz223Specific | undefined {
  if (tender.law !== "FZ_223") return undefined;
  const text = buildTenderText(tender);
  const evidenceId = nextEvidenceId();

  // Детерминированная генерация на основе текста и параметров закупки.
  const customerRequirements: string[] = [];
  if (text.includes("квалификац")) customerRequirements.push("Требование к квалификации участников");
  if (text.includes("опыт")) customerRequirements.push("Подтверждение опыта аналогичных поставок");
  if (tender.financial.price > 1_000_000) customerRequirements.push("Финансовое обеспечение заявки не менее 5%");

  const nonStandardCriteria: string[] = [];
  if (text.includes("качеств")) nonStandardCriteria.push("Качество товара (40% веса)");
  if (text.includes("срок")) nonStandardCriteria.push("Срок поставки (30% веса)");
  nonStandardCriteria.push("Цена контракта (30% веса)");

  const differencesFrom44: string[] = [
    "Закупка проводится по положению о закупке заказчика, а не по 44-ФЗ",
    "Заказчик вправе самостоятельно определять требования к участникам",
    "Возможен прямой договор без конкурентных процедур при НМЦК до 600 тыс. ₽",
  ];
  if (tender.financial.treasurySupport) {
    differencesFrom44.push("Казначейское сопровождение обязательно по решению заказчика");
  }

  return {
    regulationSummary: `Закупка проводится в соответствии с положением о закупке ${tender.customerName}. Заказчик вправе устанавливать дополнительные требования к участникам и критерии оценки заявок.`,
    customerRequirements,
    nonStandardCriteria,
    differencesFrom44,
    evidenceId,
  };
}

/** Детализация операционной оценки по пунктам. */
function buildOperationalFitDetails(
  tender: Tender,
  profile: CompanyProfile,
): OperationalFitDetails {
  const r = profile.restrictions;
  const deliveryDays = tender.deadlines.deliveryTermDays;
  const deliveryOk = deliveryDays === null || deliveryDays >= r.minDeliveryTermDays;
  const regionKnown = isRegionKnown(tender.region);
  const regionOk = r.workRegions.length === 0 || !regionKnown || r.workRegions.includes(tender.region);
  const personnelOk = profile.hasPersonnel;
  const equipmentOk = profile.hasEquipment;
  const logisticsOk = r.maxDistanceKm === null || true; // Упрощённо: логистика доступна.
  const resourcesOk = profile.experience.length > 0 || profile.capabilities.products.length > 0;

  return {
    deliveryTerm: {
      ok: deliveryOk,
      detail: deliveryDays === null
        ? "Срок поставки не указан в документации"
        : deliveryOk
          ? `Срок поставки ${deliveryDays} дн. — в пределах допустимого (${r.minDeliveryTermDays}+ дн.)`
          : `Срок поставки ${deliveryDays} дн. — короче минимально допустимого (${r.minDeliveryTermDays} дн.)`,
      evidenceId: null,
    },
    geography: {
      ok: regionOk,
      detail: !regionKnown
        ? "Регион поставки в извещении не указан — проверьте вручную"
        : regionOk
        ? `Регион поставки ${tender.region} — в списке рабочих регионов профиля`
        : `Регион поставки ${tender.region} — вне рабочих регионов профиля (${r.workRegions.join(", ") || "не указаны"})`,
      evidenceId: null,
    },
    personnel: {
      ok: personnelOk,
      detail: personnelOk
        ? "Наличие квалифицированного персонала подтверждено в профиле"
        : "Наличие персонала не подтверждено в профиле",
      evidenceId: null,
    },
    equipment: {
      ok: equipmentOk,
      detail: equipmentOk
        ? "Наличие техники и оборудования подтверждено в профиле"
        : "Наличие техники не подтверждено в профиле",
      evidenceId: null,
    },
    logistics: {
      ok: logisticsOk,
      detail: logisticsOk
        ? "Логистика и складские мощности доступны"
        : "Логистика требует уточнения",
      evidenceId: null,
    },
    resources: {
      ok: resourcesOk,
      detail: resourcesOk
        ? `Опыт компании (${profile.experience.length} контрактов) и номенклатура позволяют выполнить заказ`
        : "Ресурсы на выполнение требуют уточнения",
      evidenceId: null,
    },
  };
}

/** Доказательства «данные профиля» для блокеров, порождённых ограничениями. */
function linkBlockerEvidence(
  profile: CompanyProfile,
  blockers: HardBlocker[],
): { blocker: HardBlocker; evidence: Evidence | null }[] {
  const r = profile.restrictions;
  return blockers.map((b) => {
    let quote: string;
    let section: string;
    if (b.id.endsWith("price")) {
      quote = `Диапазон цен профиля: ${r.minPrice.toLocaleString("ru-RU")}–${r.maxPrice.toLocaleString("ru-RU")} ₽.`;
      section = "Жёсткие ограничения: цена";
    } else if (b.id.endsWith("region")) {
      quote = `Регионы работы профиля: ${r.workRegions.join(", ") || "не ограничены"}.`;
      section = "Жёсткие ограничения: география";
    } else if (b.id.endsWith("blacklist")) {
      quote = `Чёрный список заказчиков профиля: ${r.customerBlacklist.join(", ")}.`;
      section = "Жёсткие ограничения: заказчики";
    } else if (b.id.endsWith("delivery")) {
      quote = `Минимально допустимый срок поставки профиля: ${r.minDeliveryTermDays} дн.`;
      section = "Жёсткие ограничения: поставка";
    } else if (b.id.endsWith("security")) {
      quote = `Лимит обеспечения контракта профиля: ${r.maxContractSecurity.toLocaleString("ru-RU")} ₽.`;
      section = "Жёсткие ограничения: обеспечение";
    } else {
      // Лицензии/СРО: требование уже трассировано через доказательство требования.
      return { blocker: b, evidence: null };
    }
    const ev: Evidence = {
      id: nextEvidenceId(),
      source: "COMPANY_PROFILE",
      documentId: null,
      documentTitle: "Профиль компании",
      page: null,
      section,
      quote,
      confidence: "HIGH",
    };
    return { blocker: { ...b, evidenceId: b.evidenceId ?? ev.id }, evidence: ev };
  });
}

function buildRequiredDocuments(
  tender: Tender,
  profile: CompanyProfile,
  now: Date = new Date(),
): RequiredDocument[] {
  const docs: RequiredDocument[] = [
    {
      id: `${tender.id}-rd-declaration`,
      title: "Декларация соответствия единым требованиям",
      confirmedInProfile: true,
    },
    {
      id: `${tender.id}-rd-country`,
      title: "Подтверждение страны происхождения товара",
      confirmedInProfile: !tender.nationalRegime,
    },
  ];
  const experienceTotals = resolveExperienceTotals(profile, now);
  const hasDeclaredExperience =
    profile.experience.length > 0 ||
    experienceTotals.lastYearAmount !== null ||
    experienceTotals.last3YearsAmount !== null;
  for (const r of tender.requirements) {
    const needle = (r.requiredValue ?? "").toLowerCase();
    if (r.kind === "LICENSE") {
      docs.push({
        id: `${tender.id}-rd-${r.id}`,
        title: `Копия лицензии: ${r.requiredValue ?? r.title}`,
        confirmedInProfile: profile.licenses.some(
          (l) => l.confirmed && l.kind.toLowerCase().includes(needle),
        ),
      });
    }
    if (r.kind === "SRO") {
      docs.push({
        id: `${tender.id}-rd-${r.id}`,
        title: "Выписка из реестра членов СРО",
        // Выписка подтверждена, только если допуск действует и покрывает
        // работы закупки: просроченное или чужое членство заявку не спасёт.
        confirmedInProfile: hasAdmissibleSro(tender, profile, now),
      });
    }
    if (r.kind === "EXPERIENCE") {
      docs.push({
        id: `${tender.id}-rd-${r.id}`,
        title: "Копии исполненных контрактов (подтверждение опыта)",
        confirmedInProfile: hasDeclaredExperience,
      });
    }
  }
  return docs;
}

function buildNextActions(
  tender: Tender,
  risks: ContractRisk[],
  blockersCount: number,
  requiredDocuments: RequiredDocument[],
): string[] {
  // Истёкший срок обнуляет остальные шаги: собирать документы уже некуда.
  if (isSubmissionExpired(tender.deadlines.submissionEnd)) {
    return ["Срок подачи истёк — участвовать уже нельзя."];
  }
  const actions: string[] = [];
  const unconfirmed = requiredDocuments.filter((d) => !d.confirmedInProfile);
  if (unconfirmed.length > 0) {
    actions.push(
      `Подготовить документы: ${unconfirmed.map((d) => d.title).join("; ")}.`,
    );
  }
  if (blockersCount > 0) {
    actions.push("Устранить стоп-факторы или отказаться от участия.");
  }
  if (risks.some((r) => r.severity === "CRITICAL" || r.severity === "HIGH")) {
    actions.push("Согласовать риски проекта контракта с юристом до подачи заявки.");
  }
  if (isCriticalDeadline(tender.deadlines.submissionEnd)) {
    actions.push("Подача закрывается меньше чем через сутки — решать сегодня.");
  }
  if (actions.length === 0) {
    actions.push("Проверить обеспечение заявки и сформировать предложение.");
  }
  return actions;
}

/** Первая буква строчная, если это не аббревиатура («НМЦК …» остаётся как есть). */
function lowerFirst(text: string): string {
  const [first, second] = text;
  if (first === undefined || second === undefined) return text;
  return second === second.toLowerCase() && second !== second.toUpperCase()
    ? first.toLowerCase() + text.slice(1)
    : text;
}

/**
 * Главная причина отказа: первый критический блокер, а если критических нет —
 * первый из остальных. Критический идёт раньше потому, что он один обрывает
 * разговор («срок подачи истёк»), а остальные лишь снижают оценку.
 */
function topBlockerReason(blockers: readonly HardBlocker[]): string | null {
  const top = blockers.find((blocker) => blocker.critical) ?? blockers[0];
  return top?.reason ?? null;
}

function buildSummary(
  verdict: TenderAnalysis["verdict"],
  fitScore: number,
  hardBlockers: readonly HardBlocker[],
): string {
  /*
    Название закупки в эту строку не входит. Она печатается прямо под
    заголовком карточки, и повтор занимал половину пояснения: человек читал
    одно и то же дважды, а собственно причину — в конце длинной фразы.

    «Fit Score» здесь тоже не место. Цифра стоит рядом отдельным числом, а в
    тексте нужен ответ, а не метрика: подходит, надо посмотреть, не подходит.
  */
  const score = String(fitScore);
  switch (verdict) {
    case "RECOMMENDED":
      return `Подходит под ваш профиль: ${score} из 100. Стоп-факторов нет.`;
    case "MANUAL_REVIEW":
      return `Надо посмотреть самому: ${score} из 100. Есть условия, которые нужно уточнить.`;
    default: {
      /*
        Отказ называет причину. Закупка с прошедшим сроком остаётся в ленте до
        следующего опроса источника (ЕИС отдаёт и те, приём заявок по которым
        закончился три недели назад), и раньше пояснение говорило лишь «нашлись
        стоп-факторы» — человек видел отказ и искал причину по странице.

        Балл подписан как соответствие профилю: у закупки с истёкшим сроком он
        может быть 98 из 100, и без подписи «Не подходит: 98 из 100» читалось
        как противоречие.
      */
      const reason = topBlockerReason(hardBlockers);
      return reason === null
        ? `Не подходит: слабое соответствие профилю — ${score} из 100.`
        : `Не подходит: ${lowerFirst(reason)}. Соответствие профилю — ${score} из 100.`;
    }
  }
}

export function analyzeTender(
  tender: Tender,
  profile: CompanyProfile,
  now: Date = new Date(),
): TenderAnalysis {
  // 1. Требования трассируются к документам первыми — блокеры и неопределённости
  //    наследуют эти ссылки.
  const reqEvidence = buildRequirementEvidence(tender);
  const requirementsWithEvidence = reqEvidence.map((x) => x.requirement);
  const tracedTender: Tender = { ...tender, requirements: requirementsWithEvidence };

  const rawRisks = analyzeContractRisks(tracedTender);
  const scores = computeScores(tracedTender, profile, rawRisks, now);
  const fitScore = computeFitScore(scores);
  const rawBlockers = detectHardBlockers(tracedTender, profile, now);
  const uncertainties: Uncertainty[] = detectUncertainties(tracedTender, profile, now);
  const requiredDocuments = buildRequiredDocuments(tracedTender, profile, now);

  const riskLinks = linkRiskEvidence(tracedTender, rawRisks);
  const contractRisks = riskLinks.map((x) => x.risk);
  const blockerLinks = linkBlockerEvidence(profile, rawBlockers);
  const hardBlockers = blockerLinks.map((x) => x.blocker);

  const evidence: Evidence[] = [
    ...buildBaseEvidence(tender, profile),
    ...reqEvidence.map((x) => x.evidence),
    ...riskLinks.filter((x) => x.evidence).map((x) => x.evidence as Evidence),
    ...blockerLinks.filter((x) => x.evidence).map((x) => x.evidence as Evidence),
  ];

  const requiredDocumentsUnconfirmed = requiredDocuments.some(
    (d) => !d.confirmedInProfile,
  );
  const criticalDeadline = isCriticalDeadline(tender.deadlines.submissionEnd);
  const seriousContractRisk = contractRisks.some(
    (r) => r.severity === "CRITICAL" || r.severity === "HIGH",
  );

  const verdict = deriveVerdict({
    fitScore,
    hardBlockers,
    uncertainties,
    requiredDocumentsUnconfirmed,
    criticalDeadline,
    seriousContractRisk,
    profileDescribesSubject: profileDescribesSubject(profile),
  });

  // Вердикт — вывод AI: он тоже получает своё доказательство с трассировкой.
  const summary = buildSummary(verdict, fitScore, hardBlockers);
  const verdictEvidence: Evidence = {
    id: nextEvidenceId(),
    source: "AI_CONCLUSION",
    documentId: null,
    documentTitle: null,
    page: null,
    section: "Вердикт",
    quote: `${summary} Правила: Fit Score ${fitScore}/100; блокеров — ${hardBlockers.length}; существенных неопределённостей — ${uncertainties.filter((u) => u.material).length}; неподтверждённых документов — ${requiredDocuments.filter((d) => !d.confirmedInProfile).length}.`,
    confidence: uncertainties.length > 0 ? "MEDIUM" : "HIGH",
  };
  evidence.push(verdictEvidence);

  const positiveFactors = evidence
    .filter((e) => e.source === "TENDER_DOCUMENT" || e.source === "SYSTEM_RULE")
    .filter((e) => !e.quote.includes("стоп-слова"))
    .filter((e) => e.section === "Предмет закупки" || e.section === "ОКПД2")
    .map((e) => ({ id: `pf-${e.id}`, text: e.quote, evidenceId: e.id }));

  const negativeFactors = [
    ...hardBlockers.map((b) => ({
      id: `nf-${b.id}`,
      text: `${b.reason}: ${b.detail}`,
      evidenceId: b.evidenceId,
    })),
    ...contractRisks.map((r) => ({
      id: `nf-${r.id}`,
      text: `${r.title}: ${r.detail}`,
      evidenceId: r.evidenceId,
    })),
  ];

  // Уверенность: чем больше неопределённостей, тем ниже.
  const confidence = Math.max(
    0.4,
    Math.min(0.95, 0.95 - uncertainties.length * 0.1),
  );

  const analysis: TenderAnalysis = {
    id: `analysis-${tender.id}`,
    tenderId: tender.id,
    verdict,
    fitScore,
    confidence,
    summary,
    scores,
    positiveFactors,
    negativeFactors,
    hardBlockers,
    uncertainties,
    requirements: requirementsWithEvidence,
    requiredDocuments,
    deadlines: tender.deadlines,
    financialTerms: tender.financial,
    contractRisks,
    nextActions: buildNextActions(
      tender,
      contractRisks,
      hardBlockers.length,
      requiredDocuments,
    ),
    evidence,
    analyzedAt: new Date().toISOString(),
    fz223Specific: buildFz223Specific(tender),
    operationalFitDetails: buildOperationalFitDetails(tender, profile),
  };

  // Валидация результата анализа через Zod (раздел 14 ТЗ).
  return tenderAnalysisSchema.parse(analysis);
}

export const mockTenderAnalysisProvider: TenderAnalysisProvider = {
  analyze: async (tender, profile) => analyzeTender(tender, profile),
  reanalyze: async (tender, profile) => analyzeTender(tender, profile),
};
