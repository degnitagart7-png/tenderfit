import { z } from "zod";

import { scrubPii } from "@/domain/companyFacts/scrubPii";
import { factsHaveContent, type CompanyFacts, type FactContract, type FactSroKind } from "@/domain/companyFacts/types";
import type { CompanyProfile, ExperienceRecord, License, SroMembership, Tender } from "@/domain/entities";
import { isPriceKnown } from "@/domain/entities";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import { SRO_KIND_LABELS } from "@/domain/enums";
import { SRO_FREE_LIMIT_RUB } from "@/domain/analysisConsolidation";
import { matchFindingsWithProfile, type ProfileCheck } from "@/domain/profileMatch";
import { checkSroAdmission, detectSroKinds, effectiveSroLimit, resolveExperienceTotals, sroKindOf } from "@/domain/scoring/admission";
import { buildSubjectText } from "@/domain/scoring/tenderText";
import {
  MAX_SHOWN_REQUIREMENTS,
  evaluatePersonnel,
  evaluateSecurity,
  inScope,
  requirementKey,
  securityAmount,
  securityKind,
  sortAndCap,
} from "@/domain/companyFacts/fitRules";
import { extractLlmJson } from "@/lib/llmJson";
import { pluralRu } from "@/utils/format";
import type { AnalysisFinding, FindingRequirementKind } from "@/types/database";

/**
 * «Соответствие вашей компании»: сверка требований закупки с тем, что известно о компании.
 *
 * Общий разбор закупки один на всех (`analysisConsolidation`), а ответ «подходим ли МЫ» у каждого свой. Здесь он строится
 * в два слоя:
 *  1. Правила кода. Те же проверки допуска, что и в карточке закупки (`profileMatch` → `admission`: СРО по виду и лимиту,
 *     опыт по порогам и «% НМЦК», кадры, лицензии), но поверх объединённой анкеты — структурированные поля профиля плюс
 *     факты из документов компании. Плюс две проверки, которых у карточки не было: допуск СРО по цене закупки, когда в
 *     документации о нём ни слова, и регион работ. Правило, у которого есть цифры, решает само: «не подходит» и «подходит»
 *     от модели его не отменяют.
 *  2. Одна малая модельная сверка (`company_fit`) для того, что правилами не решить: сопоставимость опыта по предмету,
 *     оборудование и кадры по перечню, нестандартные условия. Модель получает требования закупки (данные публичные) и
 *     факты компании без персональных данных — и ничего больше.
 *
 * Модель может: решить «нужно уточнить» (check) в «подходит» или «не подходит»; понизить «подходит» по опыту до «нужно
 * уточнить», если по сумме опыт есть, а схожих по предмету работ в документах нет. Не может: поменять вердикт правила с
 * цифрами, назвать контракт, которого нет в фактах (id проверяются), или добавить требование.
 *
 * Модель не ответила — остаётся слой правил, а контракты «по теме» подбираются по словам предмета.
 */

export type FitVerdict = "ok" | "fail" | "check";
export type FitKind = FindingRequirementKind | "REGION" | "SRO_PRICE";
export type FitOverall = "fit" | "partial" | "no_fit" | "unknown";

export const FIT_VERSION = 2;

export interface FitRequirement {
  id: string;
  kind: FitKind;
  title: string;
  /** Что требует закупка («опыт не менее 20 % НМЦК»). */
  required: string | null;
  verdict: FitVerdict;
  /** Почему такой вердикт, по-человечески, с цифрами компании. */
  basis: string;
  /** Кто решил: правило кода, модель или оба. */
  source: "rule" | "model" | "rule+model";
  /** Контракты из фактов, подтверждающие требование. */
  contractIds: string[];
  /** Цитата документации. */
  quote: string | null;
  /** Требование допуска (блокер документации): по нему «нет схожих работ» — «не подходит», а не «нужно уточнить». */
  admission?: boolean;
}

export interface FitExperienceItem {
  contractId: string;
  subject: string;
  customer: string | null;
  year: number | null;
  sumRub: number | null;
  why: string;
}

export interface CompanyFitResult {
  version: number;
  tenderId: string;
  computedAt: string;
  overall: FitOverall;
  headline: string;
  summary: string;
  requirements: FitRequirement[];
  experience: FitExperienceItem[];
  gaps: string[];
  risks: string[];
  /** Сколько и что учтено: подпись под итогом («по 14 контрактам, 2 допускам СРО…»). */
  basisNote: string;
  /** Модельная сверка состоялась; нет — только правила и подбор по словам. */
  llmUsed: boolean;
  /** Когда нет ни фактов, ни полей профиля: сверять не с чем. */
  hasCompanyData: boolean;
}

/* ------------------------------- Объединённый профиль ------------------------------- */

const SRO_KIND_TEXT: Record<FactSroKind, string> = {
  CONSTRUCTION: SRO_KIND_LABELS.CONSTRUCTION,
  DESIGN: SRO_KIND_LABELS.DESIGN,
  SURVEY: SRO_KIND_LABELS.SURVEY,
  OTHER: SRO_KIND_LABELS.OTHER,
};

/** Договор из документов без месяца: середина года — не выпячивает и не занижает попадание в окно «за год» и «за 3 года». */
function completedAt(year: number): string {
  return `${String(year)}-06-30`;
}

/**
 * Анкета + факты из документов → профиль, с которым умеют работать проверки допуска.
 * Записи фактов дополняют анкету, а не заменяют: контракт с той же суммой, что уже внесена в анкету вручную, второй раз не
 * считается (иначе одно исполнение удваивало бы опыт).
 */
export function mergeProfileWithFacts(profile: CompanyProfile | null, facts: CompanyFacts | null): CompanyProfile {
  const base = profile ?? emptyCompanyProfile;
  if (!factsHaveContent(facts)) return { ...base, legalName: base.legalName.trim() !== "" || base.inn.trim() !== "" ? base.legalName : "Компания" };

  const knownAmounts = new Set(base.experience.map((item) => Math.round(item.amount)));
  const factExperience: ExperienceRecord[] = facts.contracts
    .filter((item) => item.sumRub !== null && item.sumRub > 0 && item.year !== null && !knownAmounts.has(Math.round(item.sumRub)))
    .map((item) => ({
      id: `fact-${item.id}`,
      subject: item.subject,
      customer: item.customer ?? "",
      contractNumber: "",
      amount: item.sumRub ?? 0,
      completedAt: completedAt(item.year ?? 0),
      okpd2Code: null,
    }));

  const sroKnown = new Set(base.sroMemberships.map((item) => `${item.kind}|${String(item.responsibilityLevel)}`));
  const factSro: SroMembership[] = facts.sro
    .filter((item) => !sroKnown.has(`${item.kind}|${String(item.level)}`))
    .map((item) => ({
      id: `fact-${item.id}`,
      kind: item.kind,
      type: SRO_KIND_TEXT[item.kind],
      number: item.number ?? "",
      responsibilityLevel: item.level,
      maxContractAmount: item.maxContractRub,
      validUntil: item.validUntil,
      confirmed: true,
    }));

  const licenseKnown = new Set(base.licenses.map((item) => item.kind.toLowerCase()));
  const factLicenses: License[] = facts.licenses
    .filter((item) => !licenseKnown.has(item.kind.toLowerCase()))
    .map((item) => ({
      id: `fact-${item.id}`,
      kind: item.kind,
      number: item.number ?? "",
      issuer: item.issuer ?? "",
      validUntil: item.validUntil,
      confirmed: true,
    }));

  const rolesTotal = facts.staff.reduce((sum, item) => sum + item.count, 0);
  const countBy = (pattern: RegExp): number =>
    facts.staff.filter((item) => pattern.test(`${item.role} ${item.qualification ?? ""}`)).reduce((sum, item) => sum + item.count, 0);
  const documentedTotal = facts.staffTotal ?? null;
  const documentedNrs = countBy(/нрс|ностро/iu);
  const documentedNopriz = countBy(/ноприз/iu);

  return {
    ...base,
    legalName: base.legalName.trim() !== "" || base.inn.trim() !== "" ? base.legalName : "Компания",
    experience: [...base.experience, ...factExperience],
    sroMemberships: [...base.sroMemberships, ...factSro],
    licenses: [...base.licenses, ...factLicenses],
    hasEquipment: base.hasEquipment || facts.equipment.length > 0,
    hasPersonnel: base.hasPersonnel || rolesTotal > 0 || documentedTotal !== null,
    // Анкета и документы расходятся — берётся документ: он свежее и точнее («в анкете 12, в документах 32»). Пустое или нулевое поле
    // анкеты заменяется документом; сумма по ролям — запасной вариант, когда штат целиком нигде не назван.
    staff: {
      total: documentedTotal ?? base.staff.total ?? (rolesTotal > 0 ? rolesTotal : null),
      nrsCount: documentedNrs > 0 ? documentedNrs : base.staff.nrsCount,
      noprizCount: documentedNopriz > 0 ? documentedNopriz : base.staff.noprizCount,
    },
  };
}

/**
 * Есть ли о компании хоть что-то, с чем сверять: факты из документов или заполненные допуски, лицензии, опыт, кадры.
 * Пустая анкета без документов — «сверять не с чем», а не «компания не подходит ни под одно требование».
 */
export function hasCompanyData(profile: CompanyProfile | null, facts: CompanyFacts | null): boolean {
  if (factsHaveContent(facts)) return true;
  if (profile === null) return false;
  return (
    profile.sroMemberships.length > 0 ||
    profile.licenses.length > 0 ||
    profile.experience.length > 0 ||
    profile.experienceTotals.lastYearAmount !== null ||
    profile.experienceTotals.last3YearsAmount !== null ||
    profile.hasEquipment ||
    profile.hasPersonnel ||
    profile.staff.total !== null
  );
}

/* ------------------------------- Регион ------------------------------- */

/** Основа названия региона: «Омская область», «Омская обл.», «г. Омск» → «омск»/«омск»: пять знаков первого значимого слова. */
function regionStem(region: string): string {
  const words = region
    .toLowerCase()
    .replace(/[^а-яёa-z0-9\s-]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word !== "" && !/^(?:г|город|обл|область|край|респ|республика|ао|автономный|округ|р-н|район)$/u.test(word));
  return (words[0] ?? "").slice(0, 5);
}

export function regionsOfCompany(profile: CompanyProfile, facts: CompanyFacts | null): string[] {
  return [
    ...profile.restrictions.workRegions,
    ...profile.preferences.priorityRegions,
    ...(facts?.regions ?? []),
    ...(facts?.contracts.map((item) => item.region ?? "") ?? []),
  ].filter((region) => region.trim() !== "");
}

function regionRequirement(tender: Tender | FitTender, companyRegions: readonly string[]): FitRequirement | null {
  const region = tender.region;
  if (region.trim() === "" || region === "Не указан") return null;
  if (companyRegions.length === 0) return null;
  const stem = regionStem(region);
  const worked = stem !== "" && companyRegions.some((item) => regionStem(item) === stem);
  const sample = [...new Set(companyRegions.map((item) => item.trim()))].slice(0, 4).join(", ");
  return {
    id: "region",
    kind: "REGION",
    title: `Регион работ: ${region}`,
    required: null,
    verdict: worked ? "ok" : "check",
    basis: worked
      ? "Компания уже работала в этом регионе."
      : `В документах компании этого региона нет (работали: ${sample}). Не запрет, но проверьте логистику и стоимость.`,
    source: "rule",
    contractIds: [],
    quote: null,
  };
}

/* ------------------------------- Слой правил ------------------------------- */

export interface FitTender {
  regNumber: string;
  subject: string;
  region: string;
  price: number | null;
}

const STATUS_TO_VERDICT: Record<ProfileCheck["status"], FitVerdict> = { MET: "ok", NOT_MET: "fail", CHECK: "check" };

/** Виды требований, которые к сверке компании не относятся: типовые декларации и статус МСП (его в фактах нет). */
const SKIPPED_KINDS: readonly FindingRequirementKind[] = ["DECLARATION", "SMP"];

export interface RuleLayer {
  requirements: FitRequirement[];
  profile: CompanyProfile;
}

export function ruleLayer(input: {
  tender: Tender;
  findings: readonly AnalysisFinding[];
  profile: CompanyProfile | null;
  facts: CompanyFacts | null;
  now: Date;
}): RuleLayer {
  const merged = mergeProfileWithFacts(input.profile, input.facts);
  const match = matchFindingsWithProfile([...input.findings], input.tender, merged, input.now);
  const price = isPriceKnown(input.tender.financial.price) ? input.tender.financial.price : null;

  const rows: FitRequirement[] = [];
  const seen = new Set<string>();
  for (const check of match.checks) {
    if (SKIPPED_KINDS.includes(check.kind)) continue;
    const finding = check.finding;
    const text = `${finding.title} ${finding.required_value ?? ""} ${finding.detail}`;
    if (!inScope(check.kind, text, finding.category === "blocker")) continue;

    let row: FitRequirement = {
      id: "",
      kind: check.kind,
      title: finding.title,
      required: finding.required_value ?? null,
      verdict: STATUS_TO_VERDICT[check.status],
      basis: check.reason,
      source: "rule",
      contractIds: [],
      quote: finding.evidence_quote || null,
      ...(finding.category === "blocker" ? { admission: true } : {}),
    };
    let key = requirementKey(row);

    if (check.kind === "EQUIPMENT") {
      // Техника: анкета знает только «есть ли», факты — перечень без технических характеристик. «Не подходит» отсюда не
      // выводится никогда: отсутствие перечня — это отсутствие данных, а не отсутствие техники. Решает сверка по перечню.
      const listed = input.facts?.equipment.length ?? 0;
      row = {
        ...row,
        verdict: "check",
        basis:
          listed > 0
            ? `В документах компании указана техника (${String(listed)} поз.) — сверьте с перечнем из документации.`
            : "Данных о технике в документах нет — загрузите перечень техники, чтобы сверить его с требованием.",
      };
    } else if (check.kind === "SECURITY") {
      // Обеспечение — не допуск и никогда не «не подходит»: см. evaluateSecurity.
      const verdict = evaluateSecurity({
        title: finding.title,
        detail: `${finding.detail} ${finding.evidence_quote}`,
        required: finding.required_value ?? "",
        law: input.tender.law,
        price,
        hasSpecialAccount: merged.hasSpecialAccount,
      });
      row = { ...row, ...verdict };
      const { percent, amount } = securityAmount(`${finding.title} ${finding.required_value ?? ""}`, price);
      key = requirementKey(row, { kind: securityKind(finding.title, `${finding.required_value ?? ""} ${finding.detail}`), percent, amount });
    } else if (check.kind === "QUALIFIED_PERSONNEL") {
      row = {
        ...row,
        ...evaluatePersonnel({
          text: `${finding.title} ${finding.required_value ?? ""} ${finding.detail}`,
          facts: input.facts,
          profileStaffTotal: (input.profile ?? emptyCompanyProfile).staff.total,
          nrsCount: merged.staff.nrsCount,
          noprizCount: merged.staff.noprizCount,
        }),
      };
    } else if (check.kind === "EXPERIENCE" && check.status === "MET") {
      row = { ...row, basis: "По сумме и числу контрактов требование выполнено." };
    }

    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  // Допуск СРО по цене — когда документация о нём молчит, а закон требует (строительство дороже 10 млн ₽, проектирование, изыскания).
  if (!rows.some((item) => item.kind === "SRO")) {
    const sro = sroRequirement(input.tender, merged, input.now);
    if (sro !== null) rows.push(sro);
  }

  const region = regionRequirement(input.tender, regionsOfCompany(merged, input.facts));
  if (region !== null) rows.push(region);

  // Не подходит → нужно уточнить → подходит, не больше восьми; номера — после отбора, по порядку показа.
  const requirements = sortAndCap(rows, MAX_SHOWN_REQUIREMENTS).map((row, index) => (row.id === "" ? { ...row, id: `r${String(index + 1)}` } : row));
  return { requirements, profile: merged };
}

function sroRequirement(tender: Tender, profile: CompanyProfile, now: Date): FitRequirement | null {
  const kinds = detectSroKinds(buildSubjectText(tender));
  if (kinds.length === 0) return null;
  const price = tender.financial.price;
  // Строительство до порога без допуска СРО — по закону можно (ч. 2.1 ст. 52 ГрК РФ); проектирование и изыскания порога не имеют.
  if (kinds.length === 1 && kinds[0] === "CONSTRUCTION" && isPriceKnown(price) && price <= SRO_FREE_LIMIT_RUB) return null;

  const title = `Допуск СРО: ${kinds.map((kind) => SRO_KIND_LABELS[kind].toLowerCase()).join(", ")}`;
  const required = isPriceKnown(price) ? `по цене закупки ${price.toLocaleString("ru-RU")} ₽` : null;
  const base = { id: "sro-price", kind: "SRO_PRICE" as const, title, required, source: "rule" as const, contractIds: [] as string[], quote: null };

  const active = profile.sroMemberships.filter((item) => sroKindOf(item) !== "OTHER" || item.confirmed);
  if (active.length === 0) {
    return {
      ...base,
      verdict: "check",
      basis: "В анкете и документах нет данных о членстве в СРО, а для таких работ допуск обязателен. Загрузите выписку из реестра членов СРО.",
    };
  }
  const check = checkSroAdmission(tender, profile, now);
  if (check.blocker !== null) return { ...base, verdict: "fail", basis: check.blocker.detail };
  if (check.uncertainties.length > 0) {
    return { ...base, verdict: "check", basis: check.uncertainties[0]?.detail ?? "Допуск СРО нужно проверить по документации." };
  }
  const covering = profile.sroMemberships.find((item) => kinds.includes(sroKindOf(item)));
  const limit = covering === undefined ? null : effectiveSroLimit(covering);
  return {
    ...base,
    verdict: "ok",
    basis:
      limit === null
        ? "Допуск СРО нужного вида есть, ограничения по сумме договора нет."
        : `Допуск СРО нужного вида есть, предел ${limit.toLocaleString("ru-RU")} ₽ покрывает цену закупки.`,
  };
}

/* ------------------------------- Какие требования отдаются модели ------------------------------- */

/** Требование, которое правила не решили («проверить») или в котором нужно сопоставить опыт по предмету. */
export function needsModel(requirement: FitRequirement): boolean {
  if (requirement.kind === "REGION") return false;
  return requirement.verdict === "check" || requirement.kind === "EXPERIENCE";
}

/** Контракты в запросе к модели: свежие и крупные первыми, не больше `MAX_CONTRACTS_IN_PROMPT`. */
export const MAX_CONTRACTS_IN_PROMPT = 60;

export function contractsForPrompt(facts: CompanyFacts): FactContract[] {
  return [...facts.contracts]
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.sumRub ?? 0) - (a.sumRub ?? 0))
    .slice(0, MAX_CONTRACTS_IN_PROMPT);
}

/**
 * Факты компании в том виде, в каком они уходят в модель сверки: без названий документов-источников, без счётчиков скрытого
 * и без цен (цены к допуску не относятся). Больше в модель о компании не уходит ничего.
 */
export function factsForFit(facts: CompanyFacts): Record<string, unknown> {
  return {
    work_types: facts.workTypes.map((item) => ({
      name: item.name,
      contracts: item.contractsCount,
      total_rub: item.totalSumRub,
      years: item.years,
      largest_rub: item.largestContractRub,
    })),
    contracts: contractsForPrompt(facts).map((item) => ({
      id: item.id,
      subject: item.subject,
      work_type: item.workType,
      customer_type: item.customerType,
      year: item.year,
      sum_rub: item.sumRub,
      law: item.law,
      region: item.region,
    })),
    sro: facts.sro.map((item) => ({ kind: item.kind, level: item.level, max_contract_rub: item.maxContractRub, valid_until: item.validUntil })),
    licenses: facts.licenses.map((item) => ({ kind: item.kind, issuer: item.issuer, valid_until: item.validUntil })),
    equipment: facts.equipment.map((item) => ({ name: item.name, count: item.count })),
    staff: facts.staff.map((item) => ({ role: item.role, count: item.count, qualification: item.qualification })),
    staff_total: facts.staffTotal ?? null,
    regions: facts.regions,
    notes: facts.notes,
  };
}

export interface FitPromptInput {
  tender: FitTender;
  requirements: readonly FitRequirement[];
  facts: CompanyFacts;
}

const MAX_REQUIREMENTS_IN_PROMPT = 14;

export function buildFitPrompt(input: FitPromptInput): string {
  const asked = input.requirements.filter(needsModel).slice(0, MAX_REQUIREMENTS_IN_PROMPT);
  const others = input.requirements.filter((item) => !asked.includes(item)).slice(0, 14);
  const line = (item: FitRequirement): string =>
    `[${item.id}] (${item.kind}) ${item.title}${item.required === null ? "" : ` — требуется: ${item.required}`}${
      item.quote === null ? "" : ` — в документации: «${item.quote.slice(0, 220)}»`
    } — проверка кодом: ${item.verdict === "ok" ? "подходит" : item.verdict === "fail" ? "не подходит" : "нужно уточнить"} (${item.basis.slice(0, 200)})`;
  return [
    "Ты помогаешь подрядчику понять, подходит ли ему закупка: сверь факты о его компании с требованиями закупки.",
    "",
    "Закупка (публичные данные):",
    JSON.stringify({ subject: input.tender.subject.slice(0, 400), region: input.tender.region, price_rub: input.tender.price }),
    "",
    "Требования, по которым нужен твой вердикт:",
    asked.length > 0 ? asked.map(line).join("\n") : "(нет — только подбери похожие контракты и оцени итог)",
    ...(others.length > 0 ? ["", "Остальные требования уже решены кодом (для контекста):", others.map((item) => `[${item.id}] ${item.title}: ${item.verdict === "ok" ? "подходит" : item.verdict === "fail" ? "не подходит" : "нужно уточнить"}`).join("\n")] : []),
    "",
    "Факты о компании (JSON, персональных данных нет):",
    JSON.stringify(factsForFit(input.facts)),
    "",
    "Правила:",
    "1. По каждому требованию из первого списка верни verdict: ok — факты компании явно подтверждают; fail — факты явно противоречат (требуется больше или иное, а данные по этой теме у компании есть); check — данных не хватает. Отсутствие упоминания в фактах — это check, а не fail: документы компании могли не охватывать всё.",
    "2. basis — одна фраза с конкретикой из фактов (виды работ, суммы, годы, СРО). contract_ids — id контрактов из фактов, которые подтверждают требование (опыт, сопоставимый по предмету).",
    "3. Опыт «сопоставим», если предмет и характер работ близки предмету закупки (тот же вид работ, сопоставимый объект), а не просто «строительство вообще». Суммы и годы бери только из фактов.",
    "4. matching_contracts — до 5 контрактов из фактов, ближайших по предмету к закупке; why — чем похож. Используй только id из фактов.",
    "5. gaps — чего компании не хватает для этой закупки (до 5 коротких пунктов); risks — до 4 рисков для этой компании в этой закупке. Только то, что следует из требований и фактов.",
    "6. summary — одно-два предложения: стоит ли компании участвовать и что главное.",
    "7. Ничего не выдумывай и не добавляй требований, которых нет в списках.",
    "8. Показывать нужно только требования к участнику и критерии оценки заявки. Если пункт из первого списка — обязанность исполнителя по договору (сертификаты на материалы, вывоз мусора, СИЗ, согласия, списки лиц и т. п.), верни для него \"skip\": true.",
    "9. Если по сути требования подтверждения в фактах нет, не ставь ok: пиши check (нет данных) или fail (данные есть и противоречат). basis не должен противоречить verdict.",
    "",
    'Верни ТОЛЬКО JSON без пояснений: {"requirements":[{"id":"r1","verdict":"ok|fail|check","basis":"…","contract_ids":["c1"],"skip":false}],"matching_contracts":[{"id":"c1","why":"…"}],"gaps":["…"],"risks":["…"],"summary":"…"}',
  ].join("\n");
}

/* ------------------------------- Ответ модели ------------------------------- */

const verdictSchema = z.enum(["ok", "fail", "check"]);

const responseSchema = z.object({
  requirements: z
    .array(
      z.object({
        id: z.string(),
        verdict: verdictSchema.catch("check"),
        basis: z.string().catch(""),
        contract_ids: z.array(z.string()).catch([]),
        skip: z.boolean().optional().catch(undefined),
      }),
    )
    .catch([]),
  matching_contracts: z.array(z.object({ id: z.string(), why: z.string().catch("") })).catch([]),
  gaps: z.array(z.string()).catch([]),
  risks: z.array(z.string()).catch([]),
  summary: z.string().catch(""),
});

export type FitModelAnswer = z.infer<typeof responseSchema>;

export function parseFitResponse(content: string): FitModelAnswer {
  const parsed: unknown = JSON.parse(extractLlmJson(content));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Ответ модели — не объект JSON");
  return responseSchema.parse(parsed);
}

/** Текст из ответа модели: без личного (на случай, если модель вернула то, чего в фактах не было) и не длиннее предела. */
function safeText(text: string, max: number): string {
  return scrubPii(text.replace(/\s+/gu, " ").trim().slice(0, max)).text;
}

/* ------------------------------- Подбор по словам (без модели) ------------------------------- */

const STOP_STEMS = new Set(["работ", "выпол", "объек", "стоим", "услуг", "поста", "строи", "здани", "помещ"]);

export function textStems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^а-яёa-z0-9]+/u)
      .filter((word) => word.length >= 5)
      .map((word) => word.slice(0, 5))
      .filter((stem) => !STOP_STEMS.has(stem)),
  );
}

/** Контракты, близкие к предмету закупки по общим словам: запасной путь, когда модель не ответила. */
export function keywordMatches(subject: string, facts: CompanyFacts, limit = 5): FitExperienceItem[] {
  const wanted = textStems(subject);
  if (wanted.size === 0) return [];
  return facts.contracts
    .map((contract) => {
      const own = textStems(`${contract.subject} ${contract.workType ?? ""}`);
      let score = 0;
      for (const stem of own) if (wanted.has(stem)) score += 1;
      return { contract, score };
    })
    .filter((item) => item.score >= 1)
    .sort((a, b) => b.score - a.score || (b.contract.year ?? 0) - (a.contract.year ?? 0) || (b.contract.sumRub ?? 0) - (a.contract.sumRub ?? 0))
    .slice(0, limit)
    .map(({ contract }) => ({
      contractId: contract.id,
      subject: contract.subject,
      customer: contract.customer,
      year: contract.year,
      sumRub: contract.sumRub,
      why: "Совпадают слова предмета (подбор по словам, без оценки модели).",
    }));
}

/* ------------------------------- Сборка результата ------------------------------- */

const MAX_LIST = 8;

/** Название в заголовке итога: коротко, без точки на конце. */
function shortTitle(title: string): string {
  const clean = title.replace(/\s+/gu, " ").replace(/[.\s]+$/u, "");
  return clean.length > 70 ? `${clean.slice(0, 67).trimEnd()}…` : clean;
}

/**
 * Итог по требованиям, которые человек видит. «Не подходит» — только по настоящим препятствиям и поимённо
 * («Не подходит: допуск СРО, опыт»); «подходит» с числом пунктов, которые надо уточнить, — без мнимой строгости.
 */
function overallOf(requirements: readonly FitRequirement[]): { overall: FitOverall; headline: string } {
  const real = requirements.filter((item) => item.kind !== "REGION");
  const fails = real.filter((item) => item.verdict === "fail");
  const checks = real.filter((item) => item.verdict === "check").length;
  const oks = real.filter((item) => item.verdict === "ok").length;
  if (real.length === 0) {
    return { overall: "unknown", headline: "Особых требований к участнику в документации не найдено — сверять не с чем" };
  }
  if (fails.length > 0) {
    const named = fails.slice(0, 2).map((item) => shortTitle(item.title)).join("; ");
    const more = fails.length > 2 ? ` и ещё ${String(fails.length - 2)}` : "";
    return { overall: "no_fit", headline: `Не подходит: ${named}${more}` };
  }
  if (checks > 0) {
    return { overall: "partial", headline: `Подходит, ${String(checks)} ${pluralRu(checks, ["пункт", "пункта", "пунктов"])} ${pluralRu(checks, ["нужно", "нужно", "нужно"])} уточнить` };
  }
  return { overall: "fit", headline: `Компания отвечает всем требованиям (${String(oks)})` };
}

export function basisNote(profile: CompanyProfile, facts: CompanyFacts | null, now: Date): string {
  const parts: string[] = [];
  const contracts = facts?.contracts.length ?? 0;
  if (contracts > 0) parts.push(`контрактов из документов: ${String(contracts)}`);
  if (profile.experience.length > 0) parts.push(`записей опыта: ${String(profile.experience.length)}`);
  if (profile.sroMemberships.length > 0) parts.push(`допусков СРО: ${String(profile.sroMemberships.length)}`);
  if (profile.licenses.length > 0) parts.push(`лицензий: ${String(profile.licenses.length)}`);
  const totals = resolveExperienceTotals(profile, now);
  if (totals.last3YearsAmount !== null && totals.last3YearsAmount > 0) {
    parts.push(`выполнено за 3 года: ${totals.last3YearsAmount.toLocaleString("ru-RU")} ₽`);
  }
  return parts.length > 0 ? `Учтено — ${parts.join(", ")}.` : "Данных о компании мало: загрузите документы компании.";
}

export interface FitAssembleInput {
  tender: FitTender;
  rules: RuleLayer;
  facts: CompanyFacts | null;
  /** Ответ модели; null — модель не вызывалась или не ответила. */
  answer: FitModelAnswer | null;
  now: Date;
}

/** Правила + ответ модели → итог. Все ссылки модели на контракты проверяются по фактам. */
/** Ответ модели говорит, что подтверждения нет, хотя вердикт «подходит»: противоречие решается в пользу осторожности. */
const SAYS_MISSING_RE = /опыта?\s+нет|нет\s+(?:опыта|подтвержд|контракт|аналогичн|схож|работ)|не\s+(?:найден|подтвержд|выполнял|имеет|было)|отсутству|не\s+хватает/iu;

export function saysMissing(basis: string): boolean {
  return SAYS_MISSING_RE.test(basis);
}

type FitAnswerRow = FitModelAnswer["requirements"][number];

/** Все требования, кроме опыта: правило с цифрами не отменяется; «нужно уточнить» решает модель. */
function otherRow(rule: FitRequirement, answer: FitAnswerRow | undefined, contractsById: ReadonlyMap<string, FactContract>): FitRequirement {
  if (answer === undefined) return rule;
  const contractIds = answer.contract_ids.filter((id) => contractsById.has(id)).slice(0, 5);
  const basis = safeText(answer.basis, 300);
  if (rule.verdict !== "check") return { ...rule, source: basis !== "" ? "rule+model" : "rule", contractIds };
  const verdict: FitVerdict = answer.verdict === "ok" && saysMissing(basis) ? "check" : answer.verdict;
  return { ...rule, verdict, basis: basis === "" ? rule.basis : basis, source: "rule+model", contractIds };
}

/**
 * Опыт: «подходит» только с хотя бы одним подтверждающим контрактом из фактов. Сумма и число контрактов — условие необходимое,
 * но не достаточное: без схожих по предмету работ пункт «нужно уточнить» (или «не подходит», если это допуск и модель так сказала).
 */
function experienceRow(
  rule: FitRequirement,
  answer: FitAnswerRow | undefined,
  facts: CompanyFacts | null,
  tenderSubject: string,
  contractsById: ReadonlyMap<string, FactContract>,
): FitRequirement {
  const modelIds = (answer?.contract_ids ?? []).filter((id) => contractsById.has(id)).slice(0, 5);
  const basis = answer === undefined ? "" : safeText(answer.basis, 300);
  const modelVerdict: FitVerdict | null = answer === undefined ? null : answer.verdict === "ok" && saysMissing(basis) ? "check" : answer.verdict;
  // Контракты по теме: названные моделью, а без них — по словам предмета закупки.
  const keywordIds = facts === null ? [] : keywordMatches(tenderSubject, facts, 3).map((item) => item.contractId);
  const ids = modelIds.length > 0 ? modelIds : keywordIds;
  const source: FitRequirement["source"] = answer === undefined ? "rule" : "rule+model";
  const detail = basis === "" ? "" : `: ${basis.replace(/[.\s]+$/u, "")}`;

  if (rule.verdict === "fail") return { ...rule, source, contractIds: modelIds };

  if (rule.verdict === "check") {
    if (modelVerdict === null) return rule;
    if (modelVerdict === "ok" && ids.length === 0) return { ...rule, verdict: "check", basis: `Схожих по предмету работ в документах не найдено${detail}.`, source, contractIds: [] };
    return { ...rule, verdict: modelVerdict, basis: basis === "" ? rule.basis : basis, source, contractIds: ids };
  }

  // Правило сказало «подходит» по сумме.
  if (modelVerdict === "fail" && rule.admission === true) {
    return { ...rule, verdict: "fail", basis: `Схожих по предмету работ у компании нет${detail}.`, source, contractIds: [] };
  }
  if (modelVerdict === "ok" || modelVerdict === null) {
    if (ids.length > 0) {
      return { ...rule, basis: modelVerdict === "ok" && basis !== "" ? `По сумме требование выполнено; по предмету: ${basis.replace(/[.\s]+$/u, "")}.` : rule.basis, source, contractIds: ids };
    }
    return { ...rule, verdict: "check", basis: "Схожих по предмету работ в документах не найдено (по сумме требование выполнено) — уточните.", source, contractIds: [] };
  }
  return { ...rule, verdict: "check", basis: `Схожие по предмету работы не подтверждены (по сумме требование выполнено)${detail}.`, source, contractIds: modelIds };
}

export function assembleFit(input: FitAssembleInput): CompanyFitResult {
  const facts = input.facts;
  const contractsById = new Map((facts?.contracts ?? []).map((item) => [item.id, item] as const));
  const answers = new Map((input.answer?.requirements ?? []).map((item) => [item.id, item] as const));

  const requirements: FitRequirement[] = [];
  for (const rule of input.rules.requirements) {
    const answer = needsModel(rule) ? answers.get(rule.id) : undefined;
    // Модель сочла пункт обязанностью исполнителя, а не требованием к участнику: он не показывается.
    // Решённое правилами (допуск, цифры) модель убрать не может.
    if (answer?.skip === true && rule.verdict === "check" && rule.kind !== "EXPERIENCE" && rule.kind !== "SRO_PRICE") continue;
    requirements.push(rule.kind === "EXPERIENCE" ? experienceRow(rule, answer, facts, input.tender.subject, contractsById) : otherRow(rule, answer, contractsById));
  }

  const experience: FitExperienceItem[] = [];
  if (input.answer !== null && facts !== null) {
    for (const item of input.answer.matching_contracts) {
      const contract = contractsById.get(item.id);
      if (contract === undefined || experience.some((existing) => existing.contractId === item.id)) continue;
      experience.push({
        contractId: contract.id,
        subject: contract.subject,
        customer: contract.customer,
        year: contract.year,
        sumRub: contract.sumRub,
        why: safeText(item.why, 200),
      });
      if (experience.length >= 5) break;
    }
  }
  if (experience.length === 0 && facts !== null) experience.push(...keywordMatches(input.tender.subject, facts));

  const { overall, headline } = overallOf(requirements);

  const gaps: string[] = [];
  const addUnique = (list: string[], text: string): void => {
    if (text !== "" && !list.some((item) => item.toLowerCase() === text.toLowerCase())) list.push(text);
  };
  for (const item of requirements) {
    if (item.verdict === "ok") continue;
    addUnique(gaps, `${item.title}: ${item.basis}`.slice(0, 300));
  }
  for (const text of input.answer?.gaps ?? []) addUnique(gaps, safeText(text, 240));

  const risks: string[] = [];
  for (const text of input.answer?.risks ?? []) addUnique(risks, safeText(text, 240));

  const summary = safeText(input.answer?.summary ?? "", 400);
  return {
    version: FIT_VERSION,
    tenderId: input.tender.regNumber,
    computedAt: input.now.toISOString(),
    overall,
    headline,
    summary: summary === "" ? headline : summary,
    requirements,
    experience,
    gaps: gaps.slice(0, MAX_LIST),
    risks: risks.slice(0, 4),
    basisNote: basisNote(input.rules.profile, facts, input.now),
    llmUsed: input.answer !== null,
    hasCompanyData: true,
  };
}

/** Результат, когда о компании ничего нет: сверять не с чем. */
export function noCompanyDataFit(tenderId: string, now: Date): CompanyFitResult {
  return {
    version: FIT_VERSION,
    tenderId,
    computedAt: now.toISOString(),
    overall: "unknown",
    headline: "Загрузите документы компании — анализ учтёт ваш опыт",
    summary: "О компании нет данных: ни фактов из документов, ни заполненных допусков и опыта.",
    requirements: [],
    experience: [],
    gaps: [],
    risks: [],
    basisNote: "",
    llmUsed: false,
    hasCompanyData: false,
  };
}

/** Читает сохранённый результат из базы: чужая версия или повреждённая запись — null. */
export function readFit(value: unknown): CompanyFitResult | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<CompanyFitResult>;
  if (raw.version !== FIT_VERSION || typeof raw.tenderId !== "string" || !Array.isArray(raw.requirements)) return null;
  return {
    version: FIT_VERSION,
    tenderId: raw.tenderId,
    computedAt: typeof raw.computedAt === "string" ? raw.computedAt : "",
    overall: (["fit", "partial", "no_fit", "unknown"] as const).includes(raw.overall as FitOverall) ? (raw.overall as FitOverall) : "unknown",
    headline: typeof raw.headline === "string" ? raw.headline : "",
    summary: typeof raw.summary === "string" ? raw.summary : "",
    requirements: raw.requirements as FitRequirement[],
    experience: Array.isArray(raw.experience) ? (raw.experience as FitExperienceItem[]) : [],
    gaps: Array.isArray(raw.gaps) ? raw.gaps.filter((item): item is string => typeof item === "string") : [],
    risks: Array.isArray(raw.risks) ? raw.risks.filter((item): item is string => typeof item === "string") : [],
    basisNote: typeof raw.basisNote === "string" ? raw.basisNote : "",
    llmUsed: raw.llmUsed === true,
    hasCompanyData: raw.hasCompanyData !== false,
  };
}
