import { z } from "zod";

/**
 * Zod-схемы для валидации внешних и рассчитанных данных.
 * Схема результата AI-анализа соответствует разделу 14 ТЗ.
 */

export const tenderVerdictSchema = z.enum([
  "RECOMMENDED",
  "MANUAL_REVIEW",
  "NOT_RECOMMENDED",
]);

export const evidenceSourceSchema = z.enum([
  "TENDER_DOCUMENT",
  "COMPANY_PROFILE",
  "AI_CONCLUSION",
  "SYSTEM_RULE",
]);

export const confidenceLevelSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);

export const riskSeveritySchema = z.enum([
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
]);

const scoreSchema = z.number().min(0).max(100);

export const analysisScoreSchema = z.object({
  subjectFit: scoreSchema,
  legalEligibility: scoreSchema,
  operationalFit: scoreSchema,
  financialFit: scoreSchema,
  contractRisk: scoreSchema,
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  source: evidenceSourceSchema,
  documentId: z.string().nullable(),
  documentTitle: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  section: z.string().nullable(),
  quote: z.string().min(1),
  confidence: confidenceLevelSchema,
});

export const findingSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  evidenceId: z.string().nullable(),
});

export const hardBlockerSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  detail: z.string().min(1),
  evidenceId: z.string().nullable(),
  critical: z.boolean(),
});

export const uncertaintySchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  detail: z.string().min(1),
  evidenceId: z.string().nullable(),
  material: z.boolean(),
});

export const contractRiskCategorySchema = z.enum([
  "PENALTY",
  "ACCEPTANCE",
  "UNILATERAL_REFUSAL",
  "WARRANTY",
  "TREASURY",
  "PAYMENT_TERMS",
  "CASH_GAP",
]);

export const contractRiskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().min(1),
  severity: riskSeveritySchema,
  evidenceId: z.string().nullable(),
  category: contractRiskCategorySchema.optional(),
});

export const requiredDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  confirmedInProfile: z.boolean(),
});

export const requirementKindSchema = z.enum([
  "LICENSE",
  "SRO",
  "EXPERIENCE",
  "QUALIFIED_PERSONNEL",
  "EQUIPMENT",
  "FINANCIAL_STABILITY",
  "NATIONAL_REGIME",
  "RESTRICTION",
  "PRODUCT_CHARACTERISTIC",
  "OTHER",
]);

export const tenderRequirementSchema = z.object({
  id: z.string().min(1),
  kind: requirementKindSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  mandatory: z.boolean(),
  requiredValue: z.string().nullable(),
  evidenceId: z.string().nullable(),
});

export const tenderDeadlineSchema = z.object({
  submissionEnd: z.string().min(1),
  /*
    Даты публикации и обновления могут быть пустой строкой: так домен записывает
    «неизвестно». Росэлторг не печатает дату публикации вовсе, Фабрикант — дату
    обновления, и схема, требовавшая непустые строки, роняла весь анализ: лента
    вместо списка показывала «String must contain at least 1 character(s)».
    Срок подачи остаётся обязательным — без него закупку не оценить.
  */
  publicationDate: z.string(),
  lastUpdateDate: z.string(),
  deliveryTermDays: z.number().int().nullable(),
  warrantyMonths: z.number().int().nullable(),
});

export const tenderFinancialTermsSchema = z.object({
  price: z.number().nonnegative(),
  currency: z.string().min(1),
  advancePercent: z.number().nullable(),
  advanceAmount: z.number().nullable(),
  paymentTermDays: z.number().int().nonnegative(),
  postpaymentDays: z.number().int().nullable(),
  bidSecurityAmount: z.number().nullable(),
  bidSecurityPercent: z.number().nullable(),
  contractSecurityAmount: z.number().nullable(),
  contractSecurityPercent: z.number().nullable(),
  treasurySupport: z.boolean(),
  expectedMarginPercent: z.number().nullable(),
});

export const fz223SpecificSchema = z.object({
  regulationSummary: z.string().min(1),
  customerRequirements: z.array(z.string()),
  nonStandardCriteria: z.array(z.string()),
  differencesFrom44: z.array(z.string()),
  evidenceId: z.string().nullable(),
});

export const operationalFitDetailsSchema = z.object({
  deliveryTerm: z.object({ ok: z.boolean(), detail: z.string(), evidenceId: z.string().nullable() }),
  geography: z.object({ ok: z.boolean(), detail: z.string(), evidenceId: z.string().nullable() }),
  personnel: z.object({ ok: z.boolean(), detail: z.string(), evidenceId: z.string().nullable() }),
  equipment: z.object({ ok: z.boolean(), detail: z.string(), evidenceId: z.string().nullable() }),
  logistics: z.object({ ok: z.boolean(), detail: z.string(), evidenceId: z.string().nullable() }),
  resources: z.object({ ok: z.boolean(), detail: z.string(), evidenceId: z.string().nullable() }),
});

/** Полная типизированная схема результата анализа (раздел 14 ТЗ). */
export const tenderAnalysisSchema = z.object({
  id: z.string().min(1),
  tenderId: z.string().min(1),
  verdict: tenderVerdictSchema,
  fitScore: scoreSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  scores: analysisScoreSchema,
  positiveFactors: z.array(findingSchema),
  negativeFactors: z.array(findingSchema),
  hardBlockers: z.array(hardBlockerSchema),
  uncertainties: z.array(uncertaintySchema),
  requirements: z.array(tenderRequirementSchema),
  requiredDocuments: z.array(requiredDocumentSchema),
  deadlines: tenderDeadlineSchema,
  financialTerms: tenderFinancialTermsSchema,
  contractRisks: z.array(contractRiskSchema),
  nextActions: z.array(z.string().min(1)),
  evidence: z.array(evidenceSchema),
  analyzedAt: z.string().min(1),
  fz223Specific: fz223SpecificSchema.optional(),
  operationalFitDetails: operationalFitDetailsSchema.optional(),
});

export type TenderAnalysisSchemaType = z.infer<typeof tenderAnalysisSchema>;

/** Валидация ИНН (10 или 12 цифр с контрольными числами). */
export function isValidInn(inn: string): boolean {
  const digits = inn.replace(/\D/g, "");
  if (digits.length === 10) {
    const coef = [2, 4, 10, 3, 5, 9, 4, 6, 8];
    let sum = 0;
    for (let i = 0; i < 9; i += 1) {
      sum += Number(digits[i]) * (coef[i] as number);
    }
    const check = (sum % 11) % 10;
    return check === Number(digits[9]);
  }
  if (digits.length === 12) {
    const c1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    const c2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < 10; i += 1) {
      s1 += Number(digits[i]) * (c1[i] as number);
    }
    // Второе контрольное число считается по первым 11 цифрам (включая n1).
    for (let i = 0; i < 11; i += 1) {
      s2 += Number(digits[i]) * (c2[i] as number);
    }
    const k1 = (s1 % 11) % 10;
    const k2 = (s2 % 11) % 10;
    return k1 === Number(digits[10]) && k2 === Number(digits[11]);
  }
  return false;
}

export const innSchema = z
  .string()
  .refine((v) => isValidInn(v), { message: "Некорректный ИНН" });
