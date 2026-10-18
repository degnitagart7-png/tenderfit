import { describe, expect, it } from "vitest";
import type {
  CompanyProfile,
  Tender,
  TenderAnalysis,
} from "@/domain/entities";
import { buildRequirementGroups, statusFromScore } from "@/domain/requirementsReview";

const NOW = new Date("2026-05-15T12:00:00.000Z");

const baseProfile: CompanyProfile = {
  organizationId: "org-1",
  legalName: "ООО Тест",
  inn: "7701234567",
  legalForm: "OOO",
  taxSystem: "OSNO",
  worksWithVat: true,
  activityDescription: "Поставка техники",
  capabilities: {
    products: ["компьютеры"],
    works: [],
    services: [],
    brandsAndModels: [],
    keywords: [],
    synonyms: [],
    stopWords: [],
    okpd2Codes: ["26.20"],
  },
  restrictions: {
    minPrice: 50_000,
    maxPrice: 5_000_000,
    maxDistanceKm: null,
    maxPaymentTermDays: 30,
    minDeliveryTermDays: 14,
    minMarginPercent: 10,
    maxBidSecurity: 100_000,
    maxContractSecurity: 500_000,
    allowNoAdvance: true,
    workRegions: ["Москва"],
    customerWhitelist: [],
    customerBlacklist: [],
    custom: [],
  },
  preferences: {
    priorityRegions: [],
    preferredMinPrice: null,
    preferredMaxPrice: null,
    preferAdvance: false,
    preferShortPaymentTerm: false,
    priorityBrands: [],
    avoidTreasurySupport: false,
    notes: [],
  },
  licenses: [
    {
      id: "lic-1",
      kind: "медицинск",
      number: "Л0-1",
      issuer: "Росздравнадзор",
      validUntil: null,
      confirmed: true,
    },
  ],
  sroMemberships: [],
  hasPersonnel: true,
  hasEquipment: true,
  hasSpecialAccount: false,
  staff: { total: null, nrsCount: 0, noprizCount: 0 },
  experience: [],
  experienceTotals: { lastYearAmount: null, last3YearsAmount: null },
  documents: [],
};

function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    id: "t-1",
    regNumber: "01r1",
    externalId: null,
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка компьютеров",
    customerName: "ГБУ",
    customerInn: null,
    region: "Москва",
    deliveryAddress: "Москва",
    financial: {
      price: 1_000_000,
      currency: "RUB",
      advancePercent: 30,
      advanceAmount: 300_000,
      paymentTermDays: 20,
      postpaymentDays: null,
      bidSecurityAmount: 10_000,
      bidSecurityPercent: 1,
      contractSecurityAmount: 50_000,
      contractSecurityPercent: 5,
      treasurySupport: false,
      expectedMarginPercent: 20,
    },
    deadlines: {
      submissionEnd: "2026-05-25T10:00:00.000Z",
      publicationDate: "2026-05-01T10:00:00.000Z",
      lastUpdateDate: "2026-05-01T10:00:00.000Z",
      deliveryTermDays: 30,
      warrantyMonths: 12,
    },
    okpd2Codes: ["26.20.11"],
    lots: [],
    requirements: [],
    documents: [],
    nationalRegime: false,
    onlyForSmp: false,
    eisUrl: "https://zakupki.gov.ru",
    dataSource: "MOCK",
    changeLog: [],
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<TenderAnalysis> = {}): TenderAnalysis {
  return {
    id: "a-1",
    tenderId: "t-1",
    verdict: "RECOMMENDED",
    fitScore: 88,
    confidence: 0.8,
    summary: "",
    scores: {
      subjectFit: 90,
      legalEligibility: 90,
      operationalFit: 90,
      financialFit: 90,
      contractRisk: 0,
    },
    positiveFactors: [],
    negativeFactors: [],
    hardBlockers: [],
    uncertainties: [],
    requirements: [],
    requiredDocuments: [],
    deadlines: makeTender().deadlines,
    financialTerms: makeTender().financial,
    contractRisks: [],
    nextActions: [],
    evidence: [],
    analyzedAt: NOW.toISOString(),
    ...overrides,
  };
}

function group(groups: ReturnType<typeof buildRequirementGroups>, key: string) {
  const g = groups.find((x) => x.key === key);
  if (!g) throw new Error(`no group ${key}`);
  return g;
}

describe("statusFromScore", () => {
  it("пороги 75/50", () => {
    expect(statusFromScore(75)).toBe("MATCH");
    expect(statusFromScore(74)).toBe("REVIEW");
    expect(statusFromScore(50)).toBe("REVIEW");
    expect(statusFromScore(49)).toBe("MISMATCH");
  });
});

describe("buildRequirementGroups — состав групп", () => {
  it("всегда шесть групп в фиксированном порядке", () => {
    const g = buildRequirementGroups(makeTender(), makeAnalysis(), baseProfile, NOW);
    expect(g.map((x) => x.key)).toEqual([
      "SUBJECT",
      "ADMISSION",
      "APPLICATION_DOCS",
      "DEADLINES",
      "ECONOMICS",
      "CONTRACT_TERMS",
    ]);
  });
});

describe("buildRequirementGroups — лоты", () => {
  /** toLocaleString вставляет неразрывные пробелы — для проверки приводим к обычным. */
  const plain = (s: string): string => s.split("\u00A0").join(" ");

  const lots: Tender["lots"] = [
    {
      id: "01r1.1",
      number: 1,
      subject: "Поставка ноутбуков",
      price: 2_025_093,
      okpd2Codes: ["26.20.11"],
      deliveryRegion: "Москва",
      deliveryAddress: "Москва",
      deliveryTermDays: null,
    },
    {
      id: "01r1.2",
      number: 2,
      subject: "Услуги по ведению ЭПЛ",
      price: 0,
      okpd2Codes: [],
      deliveryRegion: "Москва",
      deliveryAddress: "Москва",
      deliveryTermDays: null,
    },
  ];

  it("лот с опубликованной ценой показывает сумму", () => {
    const t = makeTender({ lots });
    const g = group(buildRequirementGroups(t, makeAnalysis(), baseProfile, NOW), "SUBJECT");
    const value = plain(g.items.find((i) => i.id === "sg-lot-01r1.1")?.value ?? "");
    expect(value).toContain("2 025 093 ₽");
  });

  it("лот без цены не показывается как «0 ₽»", () => {
    const t = makeTender({ lots });
    const g = group(buildRequirementGroups(t, makeAnalysis(), baseProfile, NOW), "SUBJECT");
    const value = plain(g.items.find((i) => i.id === "sg-lot-01r1.2")?.value ?? "");
    expect(value).toContain("цена не опубликована");
    expect(value).not.toContain("0 ₽");
  });
});

describe("buildRequirementGroups — допуск", () => {
  it("обязательная лицензия подтверждена — MATCH", () => {
    const a = makeAnalysis({
      requirements: [
        {
          id: "req-1",
          kind: "LICENSE",
          title: "Лицензия",
          description: "Лицензия на меддеятельность",
          mandatory: true,
          requiredValue: "медицинск",
          evidenceId: null,
        },
      ],
    });
    const g = group(buildRequirementGroups(makeTender(), a, baseProfile, NOW), "ADMISSION");
    expect(g.items.find((i) => i.id === "ad-req-1")?.status).toBe("MATCH");
  });

  it("обязательная лицензия отсутствует — MISMATCH, группа не лучше", () => {
    const a = makeAnalysis({
      requirements: [
        {
          id: "req-2",
          kind: "SRO",
          title: "Членство в СРО",
          description: "СРО проектировщиков",
          mandatory: true,
          requiredValue: "проект",
          evidenceId: null,
        },
      ],
    });
    const g = group(buildRequirementGroups(makeTender(), a, baseProfile, NOW), "ADMISSION");
    expect(g.items.find((i) => i.id === "ad-req-2")?.status).toBe("MISMATCH");
    expect(g.status).toBe("MISMATCH");
  });

  it("автоматически непроверяемое обязательное требование — REVIEW", () => {
    const a = makeAnalysis({
      requirements: [
        {
          id: "req-3",
          kind: "FINANCIAL_STABILITY",
          title: "Финансовая устойчивость",
          description: "Требования к деловой репутации",
          mandatory: true,
          requiredValue: null,
          evidenceId: null,
        },
      ],
    });
    const g = group(buildRequirementGroups(makeTender(), a, baseProfile, NOW), "ADMISSION");
    expect(g.items.find((i) => i.id === "ad-req-3")?.status).toBe("REVIEW");
  });
});

describe("buildRequirementGroups — документы заявки", () => {
  it("подтверждённый документ — MATCH, неподтверждённый — REVIEW", () => {
    const a = makeAnalysis({
      requiredDocuments: [
        { id: "d1", title: "Выписка ЕГРЮЛ", confirmedInProfile: true },
        { id: "d2", title: "Справка о финансах", confirmedInProfile: false },
      ],
    });
    const g = group(buildRequirementGroups(makeTender(), a, baseProfile, NOW), "APPLICATION_DOCS");
    expect(g.items.find((i) => i.id === "doc-d1")?.status).toBe("MATCH");
    expect(g.items.find((i) => i.id === "doc-d2")?.status).toBe("REVIEW");
    expect(g.status).toBe("REVIEW");
  });
});

describe("buildRequirementGroups — сроки", () => {
  it("менее 24 часов до подачи — пункт MISMATCH", () => {
    const t = makeTender({
      deadlines: { ...makeTender().deadlines, submissionEnd: "2026-05-16T06:00:00.000Z" },
    });
    const g = group(buildRequirementGroups(t, makeAnalysis(), baseProfile, NOW), "DEADLINES");
    expect(g.items.find((i) => i.id === "dl-submission")?.status).toBe("MISMATCH");
  });

  it("срок поставки короче минимального — MISMATCH, равен нулевым — REVIEW", () => {
    const short = makeTender({
      deadlines: { ...makeTender().deadlines, deliveryTermDays: 5 },
    });
    const gShort = group(buildRequirementGroups(short, makeAnalysis(), baseProfile, NOW), "DEADLINES");
    expect(gShort.items.find((i) => i.id === "dl-delivery")?.status).toBe("MISMATCH");

    const unknown = makeTender({
      deadlines: { ...makeTender().deadlines, deliveryTermDays: null },
    });
    const gUnknown = group(
      buildRequirementGroups(unknown, makeAnalysis(), baseProfile, NOW),
      "DEADLINES",
    );
    expect(gUnknown.items.find((i) => i.id === "dl-delivery")?.status).toBe("REVIEW");
  });
});

describe("buildRequirementGroups — экономика и договор", () => {
  it("группа экономики следует за financialFit", () => {
    const a = makeAnalysis({ scores: { ...makeAnalysis().scores, financialFit: 40 } });
    expect(group(buildRequirementGroups(makeTender(), a, baseProfile, NOW), "ECONOMICS").status).toBe(
      "MISMATCH",
    );
  });

  it("цена вне диапазона профиля — пункт MISMATCH", () => {
    const t = makeTender();
    t.financial.price = 9_000_000;
    const g = group(buildRequirementGroups(t, makeAnalysis(), baseProfile, NOW), "ECONOMICS");
    expect(g.items.find((i) => i.id === "ec-price")?.status).toBe("MISMATCH");
  });

  it("цена не опубликована — пункт REVIEW, а не MISMATCH", () => {
    const t = makeTender();
    t.financial.price = 0;
    const g = group(buildRequirementGroups(t, makeAnalysis(), baseProfile, NOW), "ECONOMICS");
    const item = g.items.find((i) => i.id === "ec-price");
    expect(item?.status).toBe("REVIEW");
    expect(item?.value).toContain("не опубликована");
  });

  it("HIGH-риск договора — MISMATCH, MEDIUM — REVIEW", () => {
    const a = makeAnalysis({
      contractRisks: [
        { id: "r1", title: "Штрафы", detail: "Несоразмерные", severity: "HIGH", evidenceId: null },
        { id: "r2", title: "Пени", detail: "Высокие", severity: "MEDIUM", evidenceId: null },
      ],
    });
    const g = group(buildRequirementGroups(makeTender(), a, baseProfile, NOW), "CONTRACT_TERMS");
    expect(g.items.find((i) => i.id === "ct-r1")?.status).toBe("MISMATCH");
    expect(g.items.find((i) => i.id === "ct-r2")?.status).toBe("REVIEW");
    expect(g.status).toBe("MISMATCH");
  });

  it("казначейское сопровождение при избегании — REVIEW", () => {
    const t = makeTender();
    t.financial.treasurySupport = true;
    const p = {
      ...baseProfile,
      preferences: { ...baseProfile.preferences, avoidTreasurySupport: true },
    };
    const g = group(buildRequirementGroups(t, makeAnalysis(), p, NOW), "CONTRACT_TERMS");
    expect(g.items.find((i) => i.id === "ct-treasury")?.status).toBe("REVIEW");
  });

  it("по 44-ФЗ казначейское сопровождение без отметки в профиле не показывается: типовое условие", () => {
    const t = makeTender();
    t.law = "FZ_44";
    t.financial.treasurySupport = true;
    const g = group(buildRequirementGroups(t, makeAnalysis(), baseProfile, NOW), "CONTRACT_TERMS");
    expect(g.items.find((i) => i.id === "ct-treasury")).toBeUndefined();
  });

  it("по 223-ФЗ казначейское сопровождение остаётся строкой: это выбор заказчика", () => {
    const t = makeTender();
    t.law = "FZ_223";
    t.financial.treasurySupport = true;
    const g = group(buildRequirementGroups(t, makeAnalysis(), baseProfile, NOW), "CONTRACT_TERMS");
    expect(g.items.find((i) => i.id === "ct-treasury")?.status).toBe("MATCH");
  });
});
