import { describe, expect, it } from "vitest";
import type {
  AnalysisScore,
  CompanyProfile,
  ContractRisk,
  Tender,
} from "@/domain/entities";
import { UNKNOWN_REGION } from "@/domain/entities";
import {
  computeContractRiskFromList,
  computeFinancialFit,
  computeFitScore,
  computeOperationalFit,
  deriveVerdict,
  detectHardBlockers,
  detectUncertainties,
  isClosingWithinDays,
  isCriticalDeadline,
  isSubmissionExpired,
  SCORE_WEIGHTS,
  URGENT_DEADLINE_DAYS,
} from "@/domain/scoring";
import { isValidInn } from "@/domain/schemas";

const baseProfile: CompanyProfile = {
  organizationId: "org-1",
  legalName: "ИП Иванов",
  inn: "500100732259",
  legalForm: "IP",
  taxSystem: "USN_INCOME",
  worksWithVat: false,
  activityDescription: "Поставка компьютерной техники",
  capabilities: {
    products: ["компьютеры", "ноутбуки"],
    works: [],
    services: ["техподдержка"],
    brandsAndModels: [],
    keywords: ["компьютер", "ноутбук"],
    synonyms: [],
    stopWords: ["аренда"],
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
  licenses: [],
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
  const price = overrides.financial?.price ?? 1_000_000;
  return {
    id: "t-1",
    regNumber: "00000000001",
    externalId: null,
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка компьютеров",
    customerName: "ГБУ Тест",
    customerInn: null,
    region: "Москва",
    deliveryAddress: "Москва",
    financial: {
      price,
      currency: "RUB",
      advancePercent: 30,
      advanceAmount: price * 0.3,
      paymentTermDays: 15,
      postpaymentDays: null,
      bidSecurityAmount: 10_000,
      bidSecurityPercent: 1,
      contractSecurityAmount: 50_000,
      contractSecurityPercent: 5,
      treasurySupport: false,
      expectedMarginPercent: 20,
    },
    deadlines: {
      submissionEnd: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(),
      publicationDate: new Date().toISOString(),
      lastUpdateDate: new Date().toISOString(),
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

describe("computeFitScore — веса и инверсия Contract Risk", () => {
  it("сумма весов равна 1", () => {
    const total =
      SCORE_WEIGHTS.subjectFit +
      SCORE_WEIGHTS.legalEligibility +
      SCORE_WEIGHTS.operationalFit +
      SCORE_WEIGHTS.financialFit +
      SCORE_WEIGHTS.contractRisk;
    expect(total).toBeCloseTo(1, 5);
  });

  it("чем выше contractRisk, тем ниже итоговый score", () => {
    const base: AnalysisScore = {
      subjectFit: 90,
      legalEligibility: 90,
      operationalFit: 90,
      financialFit: 90,
      contractRisk: 0,
    };
    const risky: AnalysisScore = { ...base, contractRisk: 80 };
    expect(computeFitScore(risky)).toBeLessThan(computeFitScore(base));
  });

  it("нулевой риск добавляет полный вклад 10%", () => {
    const all100: AnalysisScore = {
      subjectFit: 100,
      legalEligibility: 100,
      operationalFit: 100,
      financialFit: 100,
      contractRisk: 0,
    };
    expect(computeFitScore(all100)).toBe(100);
  });
});

describe("computeContractRiskFromList", () => {
  it("CRITICAL риск даёт высокий показатель", () => {
    const risks: ContractRisk[] = [
      {
        id: "r1",
        title: "x",
        detail: "y",
        severity: "CRITICAL",
        evidenceId: null,
      },
    ];
    expect(computeContractRiskFromList(risks)).toBeGreaterThanOrEqual(45);
  });

  it("пустой список рисков = 0", () => {
    expect(computeContractRiskFromList([])).toBe(0);
  });
});

describe("detectHardBlockers", () => {
  it("НМЦК выше лимита — критический блокер", () => {
    const t = makeTender();
    t.financial.price = 9_000_000;
    const blockers = detectHardBlockers(t, baseProfile);
    expect(blockers.some((b) => b.reason.includes("Цена") && b.critical)).toBe(
      true,
    );
  });

  it("регион вне географии — критический блокер", () => {
    const t = makeTender({
      region: "Владивосток",
      deliveryAddress: "Владивосток",
    });
    const blockers = detectHardBlockers(t, baseProfile);
    expect(blockers.some((b) => b.reason.includes("Регион"))).toBe(true);
  });

  it("нет блокеров при полном соответствии", () => {
    const t = makeTender();
    expect(detectHardBlockers(t, baseProfile)).toHaveLength(0);
  });

  it("истёкший срок подачи — критический блокер и первый в списке", () => {
    const t = makeTender();
    t.deadlines.submissionEnd = new Date(
      Date.now() - 3600 * 1000,
    ).toISOString();
    const blockers = detectHardBlockers(t, baseProfile);
    expect(blockers[0]?.reason).toBe("Срок подачи истёк");
    expect(blockers[0]?.critical).toBe(true);
  });

  it("истёкший срок перевешивает идеальное соответствие", () => {
    const t = makeTender();
    t.deadlines.submissionEnd = new Date(
      Date.now() - 24 * 3600 * 1000,
    ).toISOString();
    // Цена в диапазоне, регион совпадает, требований нет — кроме срока.
    expect(detectHardBlockers(t, baseProfile)).toHaveLength(1);
  });

  it("пустой срок подачи блокер не даёт", () => {
    const t = makeTender();
    t.deadlines.submissionEnd = "";
    expect(detectHardBlockers(t, baseProfile)).toHaveLength(0);
  });

  it("требуется лицензия, которой нет — критический блокер", () => {
    const t = makeTender();
    t.requirements = [
      {
        id: "req-lic",
        kind: "LICENSE",
        title: "Лицензия",
        description: "Требуется лицензия на меддеятельность",
        mandatory: true,
        requiredValue: "медицинск",
        evidenceId: null,
      },
    ];
    const blockers = detectHardBlockers(t, baseProfile);
    expect(blockers.some((b) => b.reason.includes("лицензия"))).toBe(true);
  });
});

describe("неопределённый регион в скоринге", () => {
  // У ЕИС в поисковой выдаче нет ни региона, ни адреса поставки: в живой базе
  // 109 из 151 закупки идут с регионом «Не указан». Критический блокер на таком
  // значении молча выкидывает 72% базы, поэтому «не определён» — это вопрос
  // на ручную проверку, а не несовпадение.
  const hasRegionBlocker = (t: Tender, profile: CompanyProfile = baseProfile) =>
    detectHardBlockers(t, profile).some((b) => b.reason.includes("Регион"));
  const regionQuestion = (t: Tender, profile: CompanyProfile = baseProfile) =>
    detectUncertainties(t, profile).find((u) => u.id === `${t.id}-unc-region`);

  it("регион «Не указан» не даёт критического блокера", () => {
    const t = makeTender({ region: UNKNOWN_REGION, deliveryAddress: "" });
    expect(hasRegionBlocker(t)).toBe(false);
  });

  it("регион «Не указан» уходит в существенные неопределённости", () => {
    const t = makeTender({ region: UNKNOWN_REGION, deliveryAddress: "" });
    expect(regionQuestion(t)?.material).toBe(true);
  });

  it("пустой регион тоже считается неопределённым", () => {
    const t = makeTender({ region: "   ", deliveryAddress: "" });
    expect(hasRegionBlocker(t)).toBe(false);
    expect(regionQuestion(t)).toBeDefined();
  });

  it("определённый чужой регион остаётся критическим блокером без дубля в вопросах", () => {
    const t = makeTender({
      region: "Владивосток",
      deliveryAddress: "Владивосток",
    });
    expect(hasRegionBlocker(t)).toBe(true);
    expect(regionQuestion(t)).toBeUndefined();
  });

  it("без географии в профиле неопределённый регион не мешает", () => {
    const t = makeTender({ region: UNKNOWN_REGION, deliveryAddress: "" });
    const profile: CompanyProfile = {
      ...baseProfile,
      restrictions: { ...baseProfile.restrictions, workRegions: [] },
    };
    expect(hasRegionBlocker(t, profile)).toBe(false);
    expect(regionQuestion(t, profile)).toBeUndefined();
  });

  it("вопрос о регионе перечисляет географию профиля", () => {
    const t = makeTender({ region: UNKNOWN_REGION, deliveryAddress: "" });
    expect(regionQuestion(t)?.detail).toContain("Москва");
  });
});

describe("deriveVerdict — правила вердикта", () => {
  it("RECOMMENDED при score>=75 и без блокеров/неопределённостей", () => {
    expect(
      deriveVerdict({
        fitScore: 88,
        hardBlockers: [],
        uncertainties: [],
        requiredDocumentsUnconfirmed: false,
        criticalDeadline: false,
      }),
    ).toBe("RECOMMENDED");
  });

  it("NOT_RECOMMENDED при критическом блокере даже с высоким score", () => {
    expect(
      deriveVerdict({
        fitScore: 90,
        hardBlockers: [
          {
            id: "b",
            reason: "Цена",
            detail: "d",
            evidenceId: null,
            critical: true,
          },
        ],
        uncertainties: [],
        requiredDocumentsUnconfirmed: false,
        criticalDeadline: false,
      }),
    ).toBe("NOT_RECOMMENDED");
  });

  it("NOT_RECOMMENDED при score<50", () => {
    expect(
      deriveVerdict({
        fitScore: 40,
        hardBlockers: [],
        uncertainties: [],
        requiredDocumentsUnconfirmed: false,
        criticalDeadline: false,
      }),
    ).toBe("NOT_RECOMMENDED");
  });

  it("MANUAL_REVIEW при score 50..74", () => {
    expect(
      deriveVerdict({
        fitScore: 60,
        hardBlockers: [],
        uncertainties: [],
        requiredDocumentsUnconfirmed: false,
        criticalDeadline: false,
      }),
    ).toBe("MANUAL_REVIEW");
  });

  it("MANUAL_REVIEW при существенной неопределённости и высоком score", () => {
    expect(
      deriveVerdict({
        fitScore: 90,
        hardBlockers: [],
        uncertainties: [
          {
            id: "u",
            question: "?",
            detail: "d",
            evidenceId: null,
            material: true,
          },
        ],
        requiredDocumentsUnconfirmed: false,
        criticalDeadline: false,
      }),
    ).toBe("MANUAL_REVIEW");
  });

  it("MANUAL_REVIEW при критическом сроке", () => {
    expect(
      deriveVerdict({
        fitScore: 90,
        hardBlockers: [],
        uncertainties: [],
        requiredDocumentsUnconfirmed: false,
        criticalDeadline: true,
      }),
    ).toBe("MANUAL_REVIEW");
  });
});

describe("isCriticalDeadline", () => {
  it("менее 24 часов — критично", () => {
    const soon = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
    expect(isCriticalDeadline(soon)).toBe(true);
  });
  it("10 дней — не критично", () => {
    const far = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
    expect(isCriticalDeadline(far)).toBe(false);
  });
  it("истёкший срок не критичен — он уже не требует решения", () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    expect(isCriticalDeadline(past)).toBe(false);
  });
});

describe("срок подачи: истёк или закрывается", () => {
  const NOW = new Date("2026-09-23T12:00:00.000Z");
  const iso = (hoursFromNow: number) =>
    new Date(NOW.getTime() + hoursFromNow * 3600 * 1000).toISOString();

  it("истёк час назад", () => {
    expect(isSubmissionExpired(iso(-1), NOW)).toBe(true);
  });

  it("закрывается через час — ещё не истёк", () => {
    expect(isSubmissionExpired(iso(1), NOW)).toBe(false);
  });

  it("ровно сейчас — уже истёк", () => {
    expect(isSubmissionExpired(iso(0), NOW)).toBe(true);
  });

  it("пустая и неразобранная дата истёкшей не считается", () => {
    expect(isSubmissionExpired("", NOW)).toBe(false);
    expect(isSubmissionExpired("не дата", NOW)).toBe(false);
  });

  it("в окно «срочно» попадают три дня", () => {
    expect(isClosingWithinDays(iso(24 * 2), 3, NOW)).toBe(true);
    expect(isClosingWithinDays(iso(24 * 3), 3, NOW)).toBe(true);
  });

  it("за пределами окна — не срочно", () => {
    expect(isClosingWithinDays(iso(24 * 3 + 1), 3, NOW)).toBe(false);
    expect(isClosingWithinDays(iso(24 * 10), 3, NOW)).toBe(false);
  });

  it("истёкшая закупка в «срочно» не попадает", () => {
    expect(isClosingWithinDays(iso(-5), 3, NOW)).toBe(false);
  });

  it("по умолчанию окно — URGENT_DEADLINE_DAYS", () => {
    expect(URGENT_DEADLINE_DAYS).toBe(3);
    expect(
      isClosingWithinDays(
        iso(24 * URGENT_DEADLINE_DAYS),
        URGENT_DEADLINE_DAYS,
        NOW,
      ),
    ).toBe(true);
  });
});

describe("computeOperationalFit / computeFinancialFit", () => {
  it("короткий срок поставки снижает operational fit", () => {
    const t = makeTender();
    t.deadlines.deliveryTermDays = 3;
    expect(computeOperationalFit(t, baseProfile)).toBeLessThan(100);
  });
  /*
    «Регион не определён» — не «другой регион». У трети закупок площадки
    региона не печатают (разбор 05.10.2026: 40 из 139 закупок по стройке), и
    штраф в 60 баллов за «вне рабочих регионов» опускал их в «Не подходит»,
    хотя ответ на вопрос о регионе просто неизвестен. Неизвестность уже
    отражена отдельной неопределённостью («Регион поставки не указан»),
    которая отправляет закупку на ручную проверку.
  */
  it("неизвестный регион штрафуется меньше чужого, но ниже подтверждённого своего", () => {
    const profile = {
      ...baseProfile,
      restrictions: { ...baseProfile.restrictions, workRegions: ["Республика Бурятия"] },
    };
    const unknown = makeTender({ region: UNKNOWN_REGION });
    const foreign = makeTender({ region: "Москва" });
    unknown.deadlines.deliveryTermDays = null;
    foreign.deadlines.deliveryTermDays = null;

    const own = makeTender({ region: "Республика Бурятия" });
    own.deadlines.deliveryTermDays = null;

    // Замечание 05.10.2026: закупки без региона стояли в выдаче выше закупок
    // из региона компании — регион в оценке их не различал.
    expect(computeOperationalFit(own, profile)).toBe(100);
    expect(computeOperationalFit(unknown, profile)).toBeLessThan(100);
    expect(computeOperationalFit(unknown, profile)).toBeGreaterThan(computeOperationalFit(foreign, profile));
  });

  /*
    «Приоритетный регион» в профиле компании нигде не использовался: Бурятия
    стояла в настройках, а выдача шла по всей России без всякого предпочтения
    (разбор 05.10.2026). Приоритет не исключает остальные регионы, но поднимает
    свой: закупка из приоритетного региона получает больше баллов, чем такая
    же из другого известного региона, а неизвестный регион не наказывается.
  */
  describe("приоритетный регион", () => {
    // Рабочие регионы сняты: проверяется именно приоритет, а не ограничение географии.
    const withPriority = (regions: string[]) => ({
      ...baseProfile,
      restrictions: { ...baseProfile.restrictions, workRegions: [] },
      preferences: { ...baseProfile.preferences, priorityRegions: regions },
    });
    const at = (region: string) => {
      const t = makeTender({ region });
      t.deadlines.deliveryTermDays = null;
      return t;
    };

    it("закупка из приоритетного региона оценивается выше такой же из другого", () => {
      const profile = withPriority(["Республика Бурятия"]);

      expect(computeOperationalFit(at("Республика Бурятия"), profile)).toBeGreaterThan(
        computeOperationalFit(at("Москва"), profile),
      );
    });

    it("другой регион не исключается: оценка снижается умеренно, а не до нуля", () => {
      const profile = withPriority(["Республика Бурятия"]);

      expect(computeOperationalFit(at("Москва"), profile)).toBeGreaterThanOrEqual(80);
    });

    it("неизвестный регион ниже приоритетного, но выше чужого", () => {
      const profile = withPriority(["Республика Бурятия"]);
      const unknown = computeOperationalFit(at(UNKNOWN_REGION), profile);

      expect(unknown).toBeLessThan(computeOperationalFit(at("Республика Бурятия"), profile));
      expect(unknown).toBeGreaterThan(computeOperationalFit(at("Москва"), profile));
    });

    it("название сравнивается по тому, как его вводят: «Бурятия» и «Республика Бурятия» — одно", () => {
      const profile = withPriority(["Бурятия"]);

      expect(computeOperationalFit(at("Республика Бурятия"), profile)).toBe(100);
    });

    it("без приоритетных регионов оценка прежняя", () => {
      expect(computeOperationalFit(at("Москва"), withPriority([]))).toBe(100);
    });
  });

  it("отсутствие аванса при запрете снижает financial fit", () => {
    const profile = {
      ...baseProfile,
      restrictions: { ...baseProfile.restrictions, allowNoAdvance: false },
    };
    const t = makeTender();
    t.financial.advancePercent = 0;
    t.financial.advanceAmount = 0;
    expect(computeFinancialFit(t, profile)).toBeLessThan(100);
  });
});

describe("неопубликованная цена (0)", () => {
  const PRICE_BLOCKER = "Цена вне диапазона профиля";

  it("не снижает financial fit", () => {
    const t = makeTender();
    t.financial.price = 0;
    expect(computeFinancialFit(t, baseProfile)).toBe(
      computeFinancialFit(makeTender(), baseProfile),
    );
  });

  it("не создаёт hard blocker", () => {
    const t = makeTender();
    t.financial.price = 0;
    expect(
      detectHardBlockers(t, baseProfile).some(
        (b) => b.reason === PRICE_BLOCKER,
      ),
    ).toBe(false);
  });

  it("цена выше лимита по-прежнему блокирует", () => {
    const t = makeTender();
    t.financial.price = baseProfile.restrictions.maxPrice + 1;
    expect(
      detectHardBlockers(t, baseProfile).some(
        (b) => b.reason === PRICE_BLOCKER,
      ),
    ).toBe(true);
  });
});

describe("isValidInn", () => {
  it("валидный ИНН ИП (12 цифр)", () => {
    // Литерал проверен по эталонному алгоритму контрольных чисел (n1 и n2).
    expect(isValidInn("500100732259")).toBe(true);
  });
  it("невалидный ИНН", () => {
    expect(isValidInn("123456789012")).toBe(false);
  });
});

import { applyDocumentFindings } from "./index";

describe("applyDocumentFindings", () => {
  it("returns NOT_RECOMMENDED when blocker with high severity found", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      currentScore: 85,
      findings: [
        {
          category: "blocker",
          title: "Требуется лицензия ФСБ",
          detail: "Нет лицензии",
          evidence_quote: "Участник должен иметь лицензию",
          evidence_section: "Раздел 3",
          severity: "high",
        },
      ],
    });

    expect(result.verdict).toBe("NOT_RECOMMENDED");
    expect(result.worsened).toBe(true);
  });

  it("returns MANUAL_REVIEW when high-severity risk found", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      currentScore: 85,
      findings: [
        {
          category: "risk",
          title: "Высокие штрафы",
          detail: "Неустойка 0.5%",
          evidence_quote: "Неустойка 0,5% за каждый день",
          evidence_section: "Раздел 5",
          severity: "high",
        },
      ],
    });

    expect(result.verdict).toBe("MANUAL_REVIEW");
    expect(result.worsened).toBe(true);
  });

  it("returns MANUAL_REVIEW when multiple medium risks found", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      currentScore: 85,
      findings: [
        {
          category: "risk",
          title: "Риск 1",
          detail: "Деталь 1",
          evidence_quote: "Цитата 1",
          evidence_section: "Раздел 1",
          severity: "medium",
        },
        {
          category: "risk",
          title: "Риск 2",
          detail: "Деталь 2",
          evidence_quote: "Цитата 2",
          evidence_section: "Раздел 2",
          severity: "medium",
        },
      ],
    });

    expect(result.verdict).toBe("MANUAL_REVIEW");
    expect(result.worsened).toBe(true);
  });

  it("does not improve verdict (AI can only worsen)", () => {
    const result = applyDocumentFindings({
      currentVerdict: "NOT_RECOMMENDED",
      currentScore: 30,
      findings: [
        {
          category: "neutral",
          title: "Контактные данные",
          detail: "Адрес заказчика",
          evidence_quote: "г. Москва",
          evidence_section: "Раздел 1",
          severity: "low",
        },
      ],
    });

    expect(result.verdict).toBe("NOT_RECOMMENDED");
    expect(result.worsened).toBe(false);
  });

  it("keeps current verdict when no blockers or risks", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      currentScore: 85,
      findings: [
        {
          category: "requirement",
          title: "Нужна заявка",
          detail: "Подать до даты",
          evidence_quote: "Заявки подаются через ЕИС",
          evidence_section: "Раздел 2",
          severity: "low",
        },
      ],
    });

    expect(result.verdict).toBe("RECOMMENDED");
    expect(result.worsened).toBe(false);
  });

  it("без известного вердикта блокер всё равно даёт NOT_RECOMMENDED", () => {
    const result = applyDocumentFindings({
      currentVerdict: null,
      findings: [
        {
          category: "blocker",
          title: "Требуется лицензия ФСБ",
          detail: "Нет лицензии",
          evidence_quote: "Участник должен иметь лицензию",
          evidence_section: "Раздел 3",
          severity: "high",
        },
      ],
    });

    expect(result.verdict).toBe("NOT_RECOMMENDED");
    expect(result.worsened).toBe(true);
  });

  it("без известного вердикта и без значимых факторов вердикт остаётся неизвестным", () => {
    const result = applyDocumentFindings({
      currentVerdict: null,
      findings: [
        {
          category: "neutral",
          title: "Сроки подачи",
          detail: "До 07.10.2026",
          evidence_quote: "Окончание подачи заявок 07.10.2026",
          evidence_section: "Раздел 1",
          severity: "low",
        },
      ],
    });

    expect(result.verdict).toBeNull();
    expect(result.worsened).toBe(false);
  });
});

/**
 * Живой разбор закупки 32616404800 дал 23 блокера, и настоящих среди них не
 * было почти ни одного. Любой блокер с высокой важностью отправляет закупку в
 * NOT_RECOMMENDED, поэтому закупка с чистой документацией отсеивалась
 * автоматически — и тем вернее, чем полнее документация.
 */
describe("applyDocumentFindings — типовые условия допуска не двигают вердикт", () => {
  const blocker = (title: string) => ({
    category: "blocker" as const,
    title,
    detail: "Условие допуска из документации.",
    evidence_quote: "Цитата",
    evidence_section: "Раздел 5",
    severity: "high" as const,
  });

  it("отсутствие в РНП вердикт не меняет", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      findings: [blocker("Отсутствие в реестре недобросовестных поставщиков")],
    });

    expect(result.verdict).toBe("RECOMMENDED");
    expect(result.worsened).toBe(false);
  });

  it("обеспечение заявки вердикт не меняет: это считает финансовая оценка", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      findings: [blocker("Обеспечение заявки 1 197 455,64 ₽")],
    });

    expect(result.verdict).toBe("RECOMMENDED");
  });

  it("аккредитация у заказчика вердикт не меняет: профиль о ней не знает", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      findings: [blocker("Аккредитация в Группе РусГидро")],
    });

    expect(result.verdict).toBe("RECOMMENDED");
  });

  it("настоящий блокер по-прежнему отправляет в NOT_RECOMMENDED", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      findings: [
        blocker("Отсутствие в РНП"),
        blocker("Лицензия ФСБ на работы с гостайной"),
      ],
    });

    expect(result.verdict).toBe("NOT_RECOMMENDED");
    expect(result.reason).toContain("Лицензия ФСБ");
    expect(result.reason).not.toContain("РНП");
  });

  it("повторы одного требования в причине не дублируются", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      findings: [
        blocker("Лицензия ФСБ"),
        blocker("Лицензия ФСБ"),
        blocker("Лицензия ФСБ"),
      ],
    });

    expect(result.reason).toBe("Обнаружены блокирующие факторы: Лицензия ФСБ");
  });
});
