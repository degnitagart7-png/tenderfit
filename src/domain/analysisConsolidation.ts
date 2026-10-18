import { z } from "zod";

import { assessFinding, buildNotAFindingGuide, dropBoilerplate } from "@/domain/findingNoise";
import { extractLlmJson } from "@/lib/llmJson";
import type { AnalysisFinding, TenderLaw } from "@/types/database";

/**
 * Сведение выводов глубокого анализа по всем документам закупки.
 *
 * Зачем. Модель разбирает каждый документ (и каждый фрагмент) отдельно, и выводы
 * складывались подряд: «членство в СРО обязательно» из ТЗ стояло блокером рядом с
 * «блокирующих требований о СРО нет» из проекта контракта, срок выполнения был
 * сразу 20.11, 30.11 и 23.12, а НМЦК — и 9,83, и 6 млн (разбор закупки
 * 0302300083426000012, 13.10.2026). Разбираться, где правда, приходилось человеку,
 * и доверие к остальным выводам пропадало. Здесь после разбора всех документов:
 *  - модель одним вызовом объединяет повторы, разрешает противоречия (какой
 *    документ главнее и почему), формулирует вопросы заказчику и выписывает
 *    денежные условия договора (сроки, гарантия, обеспечения, оплата);
 *  - поверх неё работают правила закона, которые проверяет код, а не модель
 *    (`applyLegalRules`): их ответ не должен зависеть от того, как модель
 *    прочитала документ.
 *
 * Сводка хранится строкой `document_analyses` без `document_id` и с
 * `analysis.kind = "consolidated"`; построчные разборы документов остаются как были.
 */

export const CONSOLIDATED_KIND = "consolidated";

export interface ConsolidatedFinding extends AnalysisFinding {
  /** Документы, где это сказано: человек открывает именно их. */
  sources: string[];
  /** Пояснение по закону (`applyLegalRules`): почему категория изменена и что делать. */
  legal_note?: string | null;
}

export interface DocumentConflict {
  topic: string;
  values: { value: string; source: string }[];
  /** Что считать верным и почему — или «уточнить у заказчика». */
  resolution: string;
  /** Решить по документам нельзя: нужен вопрос заказчику. */
  needs_question: boolean;
}

/** Денежные и сроковые условия договора — для блока «Деньги» (`moneyOutlook.ts`). */
export interface ContractFacts {
  work_start: string | null;
  work_end: string | null;
  warranty_months: number | null;
  bid_security_percent: number | null;
  contract_security_percent: number | null;
  warranty_security_percent: number | null;
  advance_percent: number | null;
  /** Срок оплаты после приёмки, дней. */
  payment_days: number | null;
}

export interface ConsolidatedAnalysis {
  kind: typeof CONSOLIDATED_KIND;
  /** Два-три предложения: участвовать ли и что главное. */
  summary: string;
  findings: ConsolidatedFinding[];
  conflicts: DocumentConflict[];
  questions: string[];
  facts: ContractFacts;
}

/** Факт закупки, против которого сверяется документация. */
export interface ConsolidationTender {
  regNumber: string;
  subject: string;
  price: number | null;
  law: TenderLaw | null;
  submissionEnd: string | null;
  region: string | null;
  /**
   * Сметы заказчика, разобранные кодом (`parseCustomerLsr`): сколько файлов и сумма позиций без НДС.
   * Модель видит сметы сокращёнными (`deepAnalysisText.ts`) и по отдельности, складывать их она не
   * умеет: на закупке 32616445639 тринадцать смет на 91 млн без НДС она назвала «несопоставимыми
   * с НМЦК 127 млн», сравнив каждую отдельно (16.10.2026). Сумма — факт для сравнения с НМЦК.
   */
  estimates?: { files: number; positionsTotal: number } | null;
}

/** Вывод разбора с именем документа, откуда он. */
export interface SourcedFinding {
  document: string;
  finding: AnalysisFinding;
}

const EMPTY_FACTS: ContractFacts = {
  work_start: null,
  work_end: null,
  warranty_months: null,
  bid_security_percent: null,
  contract_security_percent: null,
  warranty_security_percent: null,
  advance_percent: null,
  payment_days: null,
};

/** Лимит выводов, которые уходят в один вызов: больше — ответ длинный, а пользы не прибавляется. */
const MAX_INPUT_FINDINGS = 160;

/** Доля НМЦК, которую покрывают все сметы заказчика с НДС 22 %; null — не посчитать. */
export function estimatesCoverage(tender: Pick<ConsolidationTender, "price" | "estimates">): number | null {
  const est = tender.estimates;
  if (!est || est.positionsTotal <= 0 || tender.price === null || tender.price <= 0) return null;
  return (est.positionsTotal * 1.22) / tender.price;
}

/** Ниже этой доли НМЦК сумма смет «заметно меньше»: выводы о непокрытии оставляются. */
const COVERAGE_COMPARABLE = 0.7;
const COVERAGE_CLAIM =
  /не\s+покрыва|несопоставим|лишь\s+(?:малую\s+)?(?:часть|долю)|только\s+част|покрыва\p{L}*\s+(?:только|лишь|один)|малую\s+долю|расхожд|не\s+соответств|меньше\s+нмцк|ниже\s+нмцк|один\s+(?:адрес|объект)/iu;
const NMCK_TEXT = /НМЦК|начальн\p{L}*\s+(?:\(максимальн\p{L}*\)\s+)?цен/iu;
const ESTIMATE_FILE = /смет|лср|ресурсн/iu;

/*
  Вывод «смета не покрывает НМЦК» делает разбор каждой сметы отдельно: он видит один файл
  на 14 млн и НМЦК на 127 млн. Если все сметы вместе сопоставимы с НМЦК, такой вывод ложен,
  и модель его не отбрасывает, даже получив сумму (44 таких входа против одной строки факта,
  32616445639, 16.10.2026), — поэтому он отсеивается кодом до запроса и после ответа.
*/
export function isFalseCoverageClaim(
  finding: AnalysisFinding & { sources?: readonly string[] },
  tender: Pick<ConsolidationTender, "price" | "estimates">,
  /** Документ, из разбора которого вывод (вход сводки). */
  document?: string,
): boolean {
  const coverage = estimatesCoverage(tender);
  if (coverage === null || coverage < COVERAGE_COMPARABLE) return false;
  const text = `${finding.title} ${finding.detail}`;
  if (!NMCK_TEXT.test(text)) return false;
  // Вывод из разбора одной сметы о НМЦК — сравнение одного файла с ценой всей закупки.
  const sources = [...(finding.sources ?? []), ...(document === undefined ? [] : [document])];
  if (sources.length > 0 && sources.every((name) => ESTIMATE_FILE.test(name))) return true;
  return /смет/iu.test(text) && COVERAGE_CLAIM.test(text);
}

/**
 * Строки о сметах заказчика для запроса сводки. Доля от НМЦК считается здесь: модель видит
 * выводы по каждой смете отдельно («смета на 14 млн против НМЦК 127 млн») и без явного
 * запрета переносит их в итог, даже получив сумму (16.10.2026, 32616445639: 13 смет
 * дают ≈ 87 % НМЦК с НДС, а итог писал «смета покрывает 1–14 млн»).
 */
function estimatesLines(tender: ConsolidationTender): string[] {
  const est = tender.estimates;
  if (!est || est.files <= 0 || est.positionsTotal <= 0) return [];
  const lines = [
    `- сметы заказчика (посчитано кодом по всем файлам): файлов ${String(est.files)}, сумма позиций ${est.positionsTotal.toFixed(2)} ₽ без НДС и без лимитированных затрат.`,
  ];
  if (tender.price !== null && tender.price > 0) {
    const share = Math.round(((est.positionsTotal * 1.22) / tender.price) * 100);
    lines.push(
      `- с НДС 22 % это ≈ ${String(share)} % НМЦК (лимитированные затраты — временные здания, зимнее удорожание, непредвиденные — обычно добавляют ещё 5–15 %).`,
      share >= 70
        ? "- Правило о сметах: сумма смет сопоставима с НМЦК. Выводы вида «отдельная смета не покрывает НМЦК / несопоставима с НМЦК» из входных НЕ включай ни в findings, ни в summary: каждая смета — свой адрес или раздел."
        : `- Правило о сметах: сумма всех смет заметно меньше НМЦК (≈ ${String(share)} %). Об этом можно писать, но называй сумму всех смет, а не отдельный файл.`,
    );
  }
  return lines;
}

export function buildConsolidationPrompt(tender: ConsolidationTender, items: readonly SourcedFinding[]): string {
  /*
    Типовое (единые требования ст. 31, НДС, контакты…) в сводку не уходит вовсе: оно
    съедало лимит выводов и возвращалось в заключение. Условия 44-ФЗ в пределах закона
    остаются во входе с пометкой — из них нужны числа для facts, а в findings они не идут.
  */
  const relevant = items.filter(
    (item) =>
      assessFinding(item.finding, tender.law).class !== "drop" && !isFalseCoverageClaim(item.finding, tender, item.document),
  );
  const ordered = [...relevant]
    .sort((a, b) => categoryRank(a.finding.category) - categoryRank(b.finding.category))
    .slice(0, MAX_INPUT_FINDINGS);
  const lines = ordered.map((item, index) => {
    const f = item.finding;
    const typical = assessFinding(f, tender.law).class === "standard" ? " (типовое по закону — только для facts)" : "";
    const parts = [
      `${String(index + 1)}. [${f.category}/${f.severity}] ${f.title}${typical}`,
      `   документ: ${item.document}`,
      f.detail ? `   суть: ${f.detail}` : "",
      f.required_value ? `   требуется: ${f.required_value}` : "",
      f.requirement_kind ? `   вид требования: ${f.requirement_kind}` : "",
      f.evidence_quote ? `   цитата: «${f.evidence_quote.slice(0, 300)}»` : "",
    ];
    return parts.filter((p) => p !== "").join("\n");
  });

  return [
    "Ты — юрист и тендерный специалист строительного подрядчика. Ниже выводы, которые модель сделала по КАЖДОМУ документу закупки отдельно.",
    "Сведи их в одно заключение для подрядчика: объедини повторы, разреши противоречия, сформулируй вопросы заказчику и выпиши денежные условия.",
    "",
    "Закупка:",
    `- номер: ${tender.regNumber}`,
    `- предмет: ${tender.subject}`,
    `- НМЦК: ${tender.price === null ? "не опубликована" : `${tender.price.toFixed(2)} ₽`}`,
    `- закон: ${tender.law ?? "не указан"}`,
    `- окончание подачи заявок: ${tender.submissionEnd ?? "не указано"}`,
    `- регион: ${tender.region ?? "не указан"}`,
    ...estimatesLines(tender),
    "",
    buildNotAFindingGuide(tender.law, "consolidation"),
    "",
    "Правила:",
    "1. Ничего не выдумывай: только то, что есть во входных выводах. Цитату бери из входной, дословно.",
    "2. Повторы (одно и то же из разных документов или фрагментов) — один вывод, в sources перечисли все документы.",
    "3. Противоречия (разные сроки, суммы, НМЦК, проценты обеспечения, есть/нет требования) вынеси в conflicts. Приоритет документов: извещение и его реквизиты > проект контракта > описание объекта/ТЗ > обоснование НМЦК и сметы. Если одно требование есть в ТЗ, но его нет в требованиях к участникам извещения, это противоречие.",
    "4. Выводы вида «в документе нет требований/рисков» не включай — это не факторы. Норма закона и обычай делового оборота — не находка, отклонение от нормы — находка: см. раздел «Что НЕ является находкой».",
    "5. Вопросы заказчику — только по противоречиям и неясностям, которые влияют на участие или цену; конкретные, со ссылкой на пункт/документ.",
    "6. facts: условия договора как числа; неизвестное — null. Даты — ГГГГ-ММ-ДД.",
    "7. Коротко: не больше 20 выводов (сначала blocker, затем risk, requirement, neutral), detail — до 250 знаков, evidence_quote — до 200 знаков, не больше 8 противоречий и 8 вопросов.",
    ...(tender.price !== null && tender.price > 0 && tender.price <= SRO_FREE_LIMIT_RUB
      ? [
          "8. Закон: НМЦК не больше 10 млн ₽ — по ч. 2.1 ст. 52 ГрК РФ членство в СРО в области строительства (строительство, реконструкция, капремонт, снос) для такого договора не требуется. Не называй строительную СРО условием допуска ни в summary, ни в выводах; её требование в ТЗ — риск и вопрос заказчику. На СРО по проектированию и изысканиям это правило не распространяется.",
        ]
      : []),
    "",
    "Ответ — только JSON:",
    '{"summary":"1–2 коротких предложения для подрядчика, до 250 знаков: идти или нет и главная причина; не повторяй название, НМЦК и срок подачи — они уже на экране","findings":[{"category":"blocker|risk|requirement|neutral","severity":"high|medium|low","title":"...","detail":"...","evidence_quote":"...","evidence_section":"...","requirement_kind":"LICENSE|SRO|EXPERIENCE|QUALIFIED_PERSONNEL|EQUIPMENT|SMP|SECURITY|DECLARATION|OTHER|null","required_value":"...|null","sources":["документ"]}],"conflicts":[{"topic":"...","values":[{"value":"...","source":"документ"}],"resolution":"...","needs_question":true}],"questions":["..."],"facts":{"work_start":null,"work_end":null,"warranty_months":null,"bid_security_percent":null,"contract_security_percent":null,"warranty_security_percent":null,"advance_percent":null,"payment_days":null}}',
    "",
    "Выводы по документам:",
    ...lines,
  ].join("\n");
}

function categoryRank(category: AnalysisFinding["category"]): number {
  return { blocker: 0, risk: 1, requirement: 2, neutral: 3 }[category] ?? 4;
}

const nullableNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  });
const nullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null));

const findingSchema = z.object({
  category: z.enum(["blocker", "risk", "requirement", "neutral"]),
  severity: z.enum(["high", "medium", "low"]).catch("medium"),
  title: z.string().min(1),
  detail: z.string().catch(""),
  evidence_quote: z.string().catch(""),
  evidence_section: z.string().catch(""),
  requirement_kind: z
    .enum(["LICENSE", "SRO", "EXPERIENCE", "QUALIFIED_PERSONNEL", "EQUIPMENT", "SMP", "SECURITY", "DECLARATION", "OTHER"])
    .nullable()
    .catch(null),
  required_value: nullableString,
  sources: z.array(z.string()).catch([]),
});

const responseSchema = z.object({
  summary: z.string().catch(""),
  findings: z.array(z.unknown()).catch([]),
  conflicts: z
    .array(
      z.object({
        topic: z.string(),
        values: z.array(z.object({ value: z.string(), source: z.string().catch("") })).catch([]),
        resolution: z.string().catch(""),
        needs_question: z.boolean().catch(false),
      }),
    )
    .catch([]),
  questions: z.array(z.string()).catch([]),
  facts: z
    .object({
      work_start: nullableString,
      work_end: nullableString,
      warranty_months: nullableNumber,
      bid_security_percent: nullableNumber,
      contract_security_percent: nullableNumber,
      warranty_security_percent: nullableNumber,
      advance_percent: nullableNumber,
      payment_days: nullableNumber,
    })
    .catch(EMPTY_FACTS),
});

/** Ответ модели → сводка. Битые выводы отбрасываются поштучно, а не весь ответ. */
export function parseConsolidationResponse(raw: string): ConsolidatedAnalysis {
  const parsed = responseSchema.parse(JSON.parse(extractLlmJson(raw)));
  const findings: ConsolidatedFinding[] = [];
  for (const item of parsed.findings) {
    const finding = findingSchema.safeParse(item);
    if (finding.success) findings.push({ ...finding.data, legal_note: null });
  }
  return {
    kind: CONSOLIDATED_KIND,
    summary: parsed.summary.trim(),
    findings,
    conflicts: parsed.conflicts.filter((c) => c.topic.trim() !== ""),
    questions: parsed.questions.map((q) => q.trim()).filter((q) => q !== ""),
    facts: { ...EMPTY_FACTS, ...parsed.facts },
  };
}

/** Сводка из строки базы: старые и битые строки — null. */
export function readConsolidated(analysis: unknown): ConsolidatedAnalysis | null {
  if (typeof analysis !== "object" || analysis === null) return null;
  if ((analysis as { kind?: unknown }).kind !== CONSOLIDATED_KIND) return null;
  const a = analysis as Partial<ConsolidatedAnalysis>;
  return {
    kind: CONSOLIDATED_KIND,
    summary: typeof a.summary === "string" ? a.summary : "",
    findings: Array.isArray(a.findings) ? (a.findings as ConsolidatedFinding[]) : [],
    conflicts: Array.isArray(a.conflicts) ? a.conflicts : [],
    questions: Array.isArray(a.questions) ? a.questions.filter((q): q is string => typeof q === "string") : [],
    facts: { ...EMPTY_FACTS, ...(a.facts ?? {}) },
  };
}

/* ------------------------------- Правила закона ------------------------------- */

/**
 * Порог ч. 2.1 ст. 52 ГрК РФ: членство в СРО не требуется, если размер обязательств
 * по договору строительного подряда не превышает 10 млн ₽.
 */
export const SRO_FREE_LIMIT_RUB = 10_000_000;

const SRO_TEXT = /саморегулир|(?:^|[^а-яёa-z])сро(?:[^а-яёa-z]|$)/iu;

function isSroFinding(finding: AnalysisFinding): boolean {
  if (finding.requirement_kind === "SRO") return true;
  return SRO_TEXT.test(`${finding.title} ${finding.required_value ?? ""} ${finding.evidence_quote}`);
}

/*
  СРО проектировщиков и изыскателей — не про ч. 2.1 ст. 52: их исключения перечислены в
  ч. 4.1 ст. 48 и ч. 2.1 ст. 47 ГрК РФ закрытым списком, общего порога «до 10 млн» там нет.
  Правило «до 10 млн не нужно» к ним не применяется (16.10.2026: на сносе с проектом ПОС
  требование СРО по проектированию ошибочно понижалось ссылкой на строительную норму).
*/
const DESIGN_SRO_TEXT = /проектир|изыскан/iu;

function isConstructionSroFinding(finding: AnalysisFinding): boolean {
  if (!isSroFinding(finding)) return false;
  return !DESIGN_SRO_TEXT.test(`${finding.title} ${finding.required_value ?? ""}`);
}

function rub(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(value))} ₽`;
}

/**
 * Правила закона поверх выводов модели. Возвращает выводы с поправленной
 * категорией и пояснением и вопросы заказчику, которые из этого следуют.
 *
 * СРО: при НМЦК до 10 млн ₽ «членство в СРО обязательно» — не блокер. Закон его не
 * требует (ч. 2.1 ст. 52 ГрК РФ), и если требования нет в извещении, отклонить
 * заявку за его отсутствие заказчик не вправе. Но в ТЗ оно стоит не просто так —
 * поэтому это риск с вопросом заказчику, а не «можно не смотреть».
 */
export function applyLegalRules<T extends AnalysisFinding>(
  findings: readonly T[],
  tender: Pick<ConsolidationTender, "price">,
): { findings: (T & { legal_note?: string | null })[]; questions: string[] } {
  const questions: string[] = [];
  const price = tender.price;
  const sroFree = price !== null && price > 0 && price <= SRO_FREE_LIMIT_RUB;
  let sroAsked = false;
  const out = findings.map((finding) => {
    if (!sroFree || !isConstructionSroFinding(finding) || finding.category === "neutral") return { ...finding };
    if (!sroAsked) {
      questions.push(
        `Просим подтвердить, что членство в СРО в области строительства не требуется: НМЦК ${rub(price)} не превышает 10 млн ₽ (ч. 2.1 ст. 52 ГрК РФ), а в требованиях к участникам извещения СРО не указано.`,
      );
      sroAsked = true;
    }
    return {
      ...finding,
      category: finding.category === "blocker" ? ("risk" as const) : finding.category,
      severity: "medium" as const,
      legal_note:
        `По ч. 2.1 ст. 52 ГрК РФ членство в строительной СРО не требуется, если цена договора подряда не больше 10 млн ₽ (НМЦК ${rub(price)}). ` +
        "Если в требованиях к участникам извещения СРО нет, отклонить заявку за его отсутствие нельзя; " +
        "требование в ТЗ — повод задать вопрос заказчику до окончания срока разъяснений.",
    };
  });
  return { findings: out, questions };
}

/** Применить правила закона к сводке целиком: категории, пояснения, вопросы (без повторов). */
export function finalizeConsolidated(
  consolidated: ConsolidatedAnalysis,
  tender: Pick<ConsolidationTender, "price"> & Partial<Pick<ConsolidationTender, "law" | "estimates">>,
): ConsolidatedAnalysis {
  // Модель могла вернуть типовое вопреки промпту: убираем детерминированно (`findingNoise.ts`).
  // Условия 44-ФЗ в пределах закона остаются: из них блок «Деньги» берёт числа, показ чистится при чтении.
  const cleaned = dropBoilerplate(consolidated.findings, tender.law).filter((f) => !isFalseCoverageClaim(f, tender));
  const legal = applyLegalRules(cleaned, tender);
  const questions = [...consolidated.questions];
  for (const q of legal.questions) {
    if (!questions.some((existing) => SRO_TEXT.test(existing) && SRO_TEXT.test(q))) questions.push(q);
  }
  return {
    ...consolidated,
    findings: legal.findings,
    questions,
    summary: summaryWithCoverageNote(summaryWithSroNote(consolidated.summary, legal.findings), tender),
  };
}

/*
  Итог пишет модель, и запрет называть строительную СРО условием допуска она нарушает
  (16.10.2026: «идти можно только при членстве в двух СРО» при НМЦК 6,5 млн). Переписывать
  её текст нельзя, а оставлять противоречие с выводами ниже — тоже: к итогу дописывается
  одно предложение закона, если строительная СРО понижена правилом, а итог её упоминает.
*/
/*
  Итог, сравнивающий смету с НМЦК, когда все сметы вместе сопоставимы с ней, получает точную
  долю: переписывать текст модели нельзя, а оставить «смета покрывает один объект» без
  поправки — значит ввести в заблуждение (32616445639, 16.10.2026).
*/
function filesWord(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "файлов";
  if (mod10 === 1) return "файл";
  if (mod10 >= 2 && mod10 <= 4) return "файла";
  return "файлов";
}

function summaryWithCoverageNote(summary: string, tender: Pick<ConsolidationTender, "price" | "estimates">): string {
  const coverage = estimatesCoverage(tender);
  if (coverage === null || coverage < COVERAGE_COMPARABLE) return summary;
  if (!/смет/iu.test(summary) || !NMCK_TEXT.test(summary)) return summary;
  const files = tender.estimates?.files ?? 0;
  const note = `Все сметы заказчика вместе (${String(files)} ${filesWord(files)}) — ≈ ${String(Math.round(coverage * 100))} % НМЦК с НДС: каждая смета — свой адрес или раздел.`;
  return summary.includes(note) ? summary : `${summary.trim()} ${note}`;
}

export const SUMMARY_SRO_NOTE =
  "По закону членство в строительной СРО при цене договора до 10 млн ₽ не требуется (ч. 2.1 ст. 52 ГрК РФ) — уточните у заказчика.";

function summaryWithSroNote(summary: string, findings: readonly (AnalysisFinding & { legal_note?: string | null })[]): string {
  const demoted = findings.some((f) => isConstructionSroFinding(f) && (f.legal_note ?? "") !== "");
  if (!demoted || !SRO_TEXT.test(summary) || summary.includes(SUMMARY_SRO_NOTE)) return summary;
  return `${summary.trim()} ${SUMMARY_SRO_NOTE}`;
}
