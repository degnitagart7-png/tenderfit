import { describe, expect, it, vi } from "vitest";

import { CONSOLIDATED_KIND } from "@/domain/analysisConsolidation";
import type { CompanyFitRow, CompanyFitStore } from "@/repositories/companyFitRepository";
import {
  FIT_DAILY_LIMIT,
  analysisFingerprint,
  companyFingerprint,
  computeCompanyFit,
  type FitDeps,
} from "@/services/companyFitService";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import type { ChatFn } from "@/services/searchAssistService";
import type { AnalysisFinding, AnalysisJobRow, DocumentAnalysisRow, TenderRow } from "@/types/database";

const NOW = new Date("2026-10-21T12:00:00Z");
const TENDER_ID = "0373100012826000123";
const USER = "user-1";

const FINDING_EXPERIENCE: AnalysisFinding = {
  category: "blocker",
  title: "Опыт выполнения работ",
  detail: "Требуется опыт.",
  evidence_quote: "опыт за последние 3 года не менее 20% НМЦК",
  evidence_section: "п. 5",
  severity: "high",
  requirement_kind: "EXPERIENCE",
  required_value: "опыт исполнения контрактов за последние 3 года на сумму не менее 20% НМЦК",
};

function tenderRow(): TenderRow {
  return {
    id: "t1",
    reg_number: TENDER_ID,
    external_id: null,
    law: "FZ_44",
    placing_way: "ELECTRONIC_AUCTION",
    subject: "Капитальный ремонт кровли здания школы",
    customer_name: "Администрация города",
    customer_inn: null,
    region: "Омская область",
    delivery_address: null,
    price: 50_000_000,
    currency: "RUB",
    advance_payment: null,
    security_bid: null,
    security_contract: null,
    submission_end: "2026-11-05T10:00:00.000Z",
    publication_date: "2026-10-20",
    last_update_date: null,
    delivery_term_days: null,
    delivery_date_end: null,
    okpd2_codes: null,
    lots: null,
    requirements: null,
    national_regime: false,
    only_for_smp: false,
    eis_url: null,
    data_source: "EIS",
    change_log: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

const completedJob: AnalysisJobRow = {
  id: "job-1",
  tender_id: TENDER_ID,
  job_type: "full_analysis",
  status: "completed",
  priority: 0,
  documents_total: 1,
  documents_processed: 1,
  error_message: null,
  started_at: NOW.toISOString(),
  finished_at: NOW.toISOString(),
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const consolidated: DocumentAnalysisRow = {
  id: "a1",
  tender_id: TENDER_ID,
  document_id: null as unknown as string,
  model_used: "m",
  analysis: {
    kind: CONSOLIDATED_KIND,
    summary: "Итог",
    findings: [{ ...FINDING_EXPERIENCE, sources: ["ТЗ.docx"] }],
    conflicts: [],
    questions: [],
    facts: {},
  } as unknown as DocumentAnalysisRow["analysis"],
  verdict_before: null,
  verdict_after: null,
  old_score: null,
  new_score: null,
  confidence_score: null,
  tokens_used: 0,
  processing_time_ms: 0,
  created_at: NOW.toISOString(),
};

const goodFacts = {
  version: 1,
  extractedAt: "2026-10-20T00:00:00.000Z",
  sourceDocuments: ["Резюме Иванов Иван Иванович.pdf"],
  scrubStats: { fio: 4, phone: 1 },
  contracts: [
    { id: "c1", subject: "Капитальный ремонт кровли школы", workType: "ремонт кровли", customerType: "municipal", customer: "Администрация города Омска", year: 2025, sumRub: 8_000_000, law: "44-FZ", region: "Омская область" },
    { id: "c2", subject: "Ремонт кровли детского сада", workType: "ремонт кровли", customerType: "municipal", customer: null, year: 2024, sumRub: 4_000_000, law: "44-FZ", region: "Омская область" },
  ],
  sro: [{ id: "s1", kind: "CONSTRUCTION", level: 2, maxContractRub: null, number: null, validUntil: null }],
  regions: ["Омская область"],
};

const MODEL_ANSWER = JSON.stringify({
  requirements: [{ id: "r1", verdict: "ok", basis: "Контракты c1 и c2 по кровле на 12 млн ₽.", contract_ids: ["c1", "c2"] }],
  matching_contracts: [{ id: "c1", why: "Та же кровля школы" }],
  gaps: [],
  risks: ["Срок выполнения короткий"],
  summary: "Участвовать можно.",
});

function memoryStore(initial: CompanyFitRow | null = null, usedToday = 0) {
  let row = initial;
  const store: CompanyFitStore & { rows: () => CompanyFitRow | null } = {
    get: vi.fn(async () => row),
    put: vi.fn(async (input) => {
      row = { userId: input.userId, tenderId: input.tenderId, analysisHash: input.analysisHash, factsHash: input.factsHash, result: input.result, llmUsed: input.llmUsed, updatedAt: NOW.toISOString() };
    }),
    countLlmSince: vi.fn(async () => usedToday),
    rows: () => row,
  };
  return store;
}

type MockedChat = ChatFn & { mock: { calls: unknown[][] } };

function deps(patch: Partial<FitDeps> & { profile?: unknown } = {}): FitDeps & { chat: MockedChat } {
  const chat = vi.fn(async () => ({ content: MODEL_ANSWER, tokens: 1500 }));
  const base: FitDeps = {
    chat,
    store: memoryStore(),
    loadTender: async () => tenderRow(),
    loadAnalysis: async () => ({ jobs: [completedJob], documents: [], documentAnalyses: [consolidated] }),
    loadCompanyProfile: async () => (patch.profile === undefined ? { ...emptyCompanyProfile, inn: "5503123456", legalName: "ООО «СтройОмск»", companyFacts: goodFacts } : patch.profile),
    now: () => NOW,
  };
  const { profile: _profile, ...rest } = patch;
  void _profile;
  return { ...base, ...rest, chat: (rest.chat ?? chat) as unknown as MockedChat };
}

describe("computeCompanyFit", () => {
  it("закупки нет — no_tender; разбор не готов — no_analysis; модель не зовётся", async () => {
    const d = deps({ loadTender: async () => null });
    expect((await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, d)).status).toBe("no_tender");
    const pending = deps({ loadAnalysis: async () => ({ jobs: [{ ...completedJob, status: "processing" }], documents: [], documentAnalyses: [] }) });
    expect((await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, pending)).status).toBe("no_analysis");
    expect(d.chat).not.toHaveBeenCalled();
    expect(pending.chat).not.toHaveBeenCalled();
  });

  it("о компании ничего нет — no_data, модель не зовётся, ничего не пишется", async () => {
    const store = memoryStore();
    const d = deps({ profile: null, store });
    const outcome = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, d);
    expect(outcome.status).toBe("no_data");
    if (outcome.status === "no_data") expect(outcome.result.hasCompanyData).toBe(false);
    expect(d.chat).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("считает правилами и одним вызовом модели, запоминает результат", async () => {
    const store = memoryStore();
    const d = deps({ store });
    const outcome = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, d);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.cached).toBe(false);
    expect(d.chat).toHaveBeenCalledTimes(1);
    const call = d.chat.mock.calls[0] ?? [];
    expect(call[2]).toMatchObject({ purpose: "company_fit", tenderId: TENDER_ID, userId: USER });
    expect(call[3]).toMatchObject({ reasoning: false });
    expect(outcome.result.llmUsed).toBe(true);
    expect(outcome.result.summary).toBe("Участвовать можно.");
    expect(outcome.result.requirements.find((item) => item.kind === "EXPERIENCE")).toMatchObject({ verdict: "ok", contractIds: ["c1", "c2"] });
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it("то же состояние — из кэша: модель не вызывается; force пересчитывает", async () => {
    const store = memoryStore();
    const first = deps({ store });
    await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, first);

    const second = deps({ store });
    const cached = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, second);
    expect(cached.status === "ok" && cached.cached).toBe(true);
    expect(second.chat).not.toHaveBeenCalled();

    const forced = deps({ store });
    const again = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID, force: true }, forced);
    expect(again.status === "ok" && again.cached).toBe(false);
    expect(forced.chat).toHaveBeenCalledTimes(1);
  });

  it("правка фактов или другой разбор закупки — другой отпечаток, кэш не годится", async () => {
    const store = memoryStore();
    await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, deps({ store }));

    const edited = deps({
      store,
      profile: { ...emptyCompanyProfile, inn: "5503123456", legalName: "ООО «СтройОмск»", companyFacts: { ...goodFacts, contracts: goodFacts.contracts.slice(0, 1) } },
    });
    const outcome = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, edited);
    expect(outcome.status === "ok" && outcome.cached).toBe(false);
    expect(edited.chat).toHaveBeenCalledTimes(1);

    const reanalysed = deps({
      store,
      loadAnalysis: async () => ({ jobs: [completedJob], documents: [], documentAnalyses: [{ ...consolidated, analysis: { ...(consolidated.analysis as object), findings: [{ ...FINDING_EXPERIENCE, required_value: "опыт не менее 50% НМЦК" }] } as DocumentAnalysisRow["analysis"] }] }),
    });
    const outcome2 = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, reanalysed);
    expect(outcome2.status === "ok" && outcome2.cached).toBe(false);
  });

  it("модель не ответила: правила и подбор по словам, результат не запоминается", async () => {
    const store = memoryStore();
    const d = deps({ store, chat: vi.fn(async () => { throw new Error("шлюз 502"); }) as unknown as FitDeps["chat"] });
    const outcome = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, d);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.degraded).toBe(true);
    expect(outcome.result.llmUsed).toBe(false);
    expect(outcome.result.requirements.find((item) => item.kind === "EXPERIENCE")?.verdict).toBe("ok");
    expect(outcome.result.experience.length).toBeGreaterThan(0);
    expect(store.put).not.toHaveBeenCalled();
  });

  it("ответ модели не по формату — тоже без падения", async () => {
    const d = deps({ chat: vi.fn(async () => ({ content: "не JSON", tokens: 10 })) as unknown as FitDeps["chat"] });
    const outcome = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, d);
    expect(outcome.status === "ok" && outcome.degraded).toBe(true);
  });

  it("суточный предел модельных сверок", async () => {
    const d = deps({ store: memoryStore(null, FIT_DAILY_LIMIT) });
    const outcome = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, d);
    expect(outcome).toEqual({ status: "limit", limit: FIT_DAILY_LIMIT });
    expect(d.chat).not.toHaveBeenCalled();
  });

  it("сбой хранилища (таблицы нет) сверку не роняет", async () => {
    const broken: CompanyFitStore = {
      get: vi.fn(async () => { throw new Error('relation "company_fit" does not exist'); }),
      put: vi.fn(async () => { throw new Error("нет таблицы"); }),
      countLlmSince: vi.fn(async () => { throw new Error("нет таблицы"); }),
    };
    const d = deps({ store: broken });
    const outcome = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, d);
    expect(outcome.status).toBe("ok");
    expect(d.chat).toHaveBeenCalledTimes(1);
  });

  it("анкета читается по идентификатору вошедшего", async () => {
    const loadCompanyProfile = vi.fn(async () => ({ ...emptyCompanyProfile, companyFacts: goodFacts }));
    await computeCompanyFit({ userId: "user-42", tenderId: TENDER_ID }, deps({ loadCompanyProfile }));
    expect(loadCompanyProfile).toHaveBeenCalledWith("user-42");
  });

  it("в модель не уходят личные данные из фактов анкеты, названия файлов и ФИО", async () => {
    const dirtyFacts = {
      ...goodFacts,
      contracts: [
        ...goodFacts.contracts,
        { id: "c3", subject: "Ремонт у Сидорова С. С., тел. +7 913 000-11-22", year: 2023, sumRub: 100_000 },
      ],
      notes: ["Связь: boss@firma.ru", "Работаем по всей Сибири"],
    };
    const d = deps({ profile: { ...emptyCompanyProfile, inn: "5503123456", legalName: "ООО «СтройОмск»", companyFacts: dirtyFacts } });
    await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, d);
    const prompt = String((d.chat.mock.calls[0] ?? [])[0]);
    expect(prompt).not.toMatch(/Сидоров|913|boss@|Резюме|Иванов Иван/u);
    expect(prompt).toContain("Работаем по всей Сибири");
    expect(prompt).toContain("Капитальный ремонт кровли школы");
  });

  it("анкета без фактов, но с допусками — сверка правилами без модели", async () => {
    const d = deps({
      profile: {
        ...emptyCompanyProfile,
        inn: "5503123456",
        legalName: "ООО «СтройОмск»",
        sroMemberships: [{ id: "s", kind: "CONSTRUCTION", type: "Строительство", number: "СРО-1", responsibilityLevel: 2, maxContractAmount: null, validUntil: null, confirmed: true }],
        experienceTotals: { lastYearAmount: null, last3YearsAmount: 30_000_000 },
      },
    });
    const outcome = await computeCompanyFit({ userId: USER, tenderId: TENDER_ID }, d);
    // Сумма опыта подходит, но перечня контрактов нет, а «подходит» по опыту — только с подтверждающим контрактом.
    expect(outcome.status === "ok" && outcome.result.requirements.find((item) => item.kind === "EXPERIENCE")?.verdict).toBe("check");
    // Опыт сопоставляется по предмету, но у анкеты без фактов контрактов нет — модели отдавать нечего.
    expect(d.chat).not.toHaveBeenCalled();
  });
});

describe("отпечатки", () => {
  it("анализ: другая цена или требование — другой отпечаток", () => {
    const tender = { regNumber: TENDER_ID, subject: "s", region: "r", price: 1, law: "FZ_44" };
    const a = analysisFingerprint(tender, [FINDING_EXPERIENCE]);
    expect(analysisFingerprint({ ...tender, price: 2 }, [FINDING_EXPERIENCE])).not.toBe(a);
    expect(analysisFingerprint(tender, [{ ...FINDING_EXPERIENCE, title: "Другое" }])).not.toBe(a);
    expect(analysisFingerprint(tender, [FINDING_EXPERIENCE])).toBe(a);
  });

  it("компания: названия документов и счётчики скрытого на отпечаток не влияют, содержимое — влияет", () => {
    const facts = {
      version: 1,
      extractedAt: "x",
      sourceDocuments: ["a.pdf"],
      scrubStats: { fio: 1, phone: 0, email: 0, passport: 0, snils: 0, personalInn: 0, birthDate: 0, address: 0 },
      workTypes: [],
      contracts: [],
      sro: [],
      licenses: [],
      equipment: [],
      staff: [],
      prices: [],
      regions: ["Омская область"],
      notes: [],
    };
    const base = companyFingerprint(emptyCompanyProfile, facts);
    expect(companyFingerprint(emptyCompanyProfile, { ...facts, sourceDocuments: ["b.pdf"], extractedAt: "y", scrubStats: { ...facts.scrubStats, fio: 9 } })).toBe(base);
    expect(companyFingerprint(emptyCompanyProfile, { ...facts, regions: ["Томская область"] })).not.toBe(base);
    expect(companyFingerprint({ ...emptyCompanyProfile, hasEquipment: true }, facts)).not.toBe(base);
  });
});
