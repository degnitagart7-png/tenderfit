import { describe, expect, it } from "vitest";
import type {
  CompanyProfile,
  ExperienceRecord,
  SroMembership,
  Tender,
  TenderRequirement,
} from "@/domain/entities";
import {
  admissionBlockers,
  admissionUncertainties,
  checkExperienceAdmission,
  checkPersonnelAdmission,
  checkSroAdmission,
  computeExperienceTotals,
  describeSroPosition,
  detectSroKinds,
  effectiveSroLimit,
  hasAdmissibleSro,
  inferSroKind,
  isRequirementSatisfied,
  isSroActive,
  largestContractAmount,
  parseExperienceThreshold,
  parseMoneyRu,
  parsePersonnelRequirement,
  resolveExperienceTotals,
  sroKindsLabel,
} from "@/domain/scoring/admission";

/**
 * Наименования закупок взяты из выгрузки ЕИС и Сбербанк-АСТ (148 закупок,
 * сентябрь 2026) — на них детектор видов работ калибровался. Менять формулировки
 * на «удобные» нельзя: тест фиксирует поведение на реальных предметах.
 */
const LIVE_CONSTRUCTION_SUBJECTS = [
  "Капитальный ремонт здания спортивного зала по адресу: г.Красноярск, ул.Академика Павлова, 21, стр., пом.3",
  "Ремонт участка автомобильной дороги ул. Садовая с. Солтон Солтонского района Алтайского края (ремонт покрытия) (от д. №1 ул. Ленина до д. № 39 Молодежная)",
  "Выполнение строительно-монтажных работ в рамках осуществления мероприятий по строительству электросетей для технологического присоединения с запрашиваемой мощностью потребителей.",
  "Выполнение работ по реконструкции участка тепловой сети тепломагистрали №6 (инв. №1200010) от тепловой камеры ТК-5-17-6-2А до тепловой камеры УТ-1",
  "Осуществление строительного контроля при выполнении работ по строительству объекта: «Реализация проекта по обустройству туристической инфраструктуры экологической тропы \"Поющие скалы\" (Синские столбы)»",
] as const;

/**
 * Поставки и услуги, в которых строительство упомянуто только как проект,
 * объект или назначение. Допуск СРО по ним не требуется, и ложное
 * срабатывание здесь дало бы компании неверный блокер.
 */
const LIVE_NON_CONSTRUCTION_SUBJECTS = [
  "Право заключения договора на ОКПД 2 31.09.11.190 Поставка пожарных шкафов и комплектующих к ним в рамках реализации проекта «Реконструкция энергетического производственно-технологического комплекса Владивостокской ТЭЦ-2 с заменой турбоагрегатов ст. №№1, 2, 3»",
  "Поставка материалов для капитального ремонта котла № 3",
  "ОКПД2 32.30.15.210 Поставка альпинистского снаряжения в г. Владивосток рамках реализации проекта «Реконструкция энергетического производственно-технологического комплекса Владивостокской ТЭЦ-2», Этап Реконструкции №3 (Лот № 0560-КС ДОХ-2026-УСГС)",
  "Запрос котировок в электронной форме по выбору исполнителя (поставщика) на изготовление и поставку стальных строительных конструкций (металлоконструкций) для Объекта капитального строительства: «Гостиница 5.2»",
  "Изготовление и монтаж сетчатого баннера на окна",
  "Поставка железобетонных изделий, в рамках реализации проекта «Строительство 2-й очереди Нерюнгринской ГРЭС»",
  "Поставка ноутбуков для реализации проекта \"#ГТО_НАШ_ОРИЕНТИР\"",
  "Оказание услуг по проведению капитального ремонта 2 единиц транспортных средств CHEVROLET NIVA, 212300-55",
  "Оказание услуг по заправке и ремонту картриджей лазерных принтеров и МФУ",
  "Оказание услуг по техническому обслуживанию и ремонту автомобиля",
] as const;

const NOW = new Date("2026-09-22T12:00:00.000Z");

/**
 * Форматирование чисел в текстах идёт через toLocaleString("ru-RU"),
 * который ставит неразрывные пробелы. Для сравнения приводим к обычным.
 */
function plain(text: string | null | undefined): string {
  return (text ?? "").replace(/[\u00a0\u202f]/gu, " ");
}

function makeSro(overrides: Partial<SroMembership> = {}): SroMembership {
  return {
    id: "sro-1",
    kind: "CONSTRUCTION",
    type: "Строительство, реконструкция, капитальный ремонт",
    number: "СРО-С-000-000001",
    responsibilityLevel: 1,
    maxContractAmount: 90_000_000,
    validUntil: null,
    confirmed: true,
    ...overrides,
  };
}

/** Допуски из анкеты контрагента: строительство до 90 млн, проектирование до 25 млн. */
const DESIGN_SRO = makeSro({
  id: "sro-2",
  kind: "DESIGN",
  type: "Архитектурно-строительное проектирование",
  number: "СРО-П-000-000002",
  responsibilityLevel: 1,
  maxContractAmount: 25_000_000,
});

const baseProfile: CompanyProfile = {
  organizationId: "org-1",
  legalName: "ООО Подрядчик",
  inn: "7701234567",
  legalForm: "OOO",
  taxSystem: "OSNO",
  worksWithVat: true,
  activityDescription: "Строительно-монтажные работы",
  capabilities: {
    products: [],
    works: ["строительно-монтажные работы", "капитальный ремонт"],
    services: [],
    brandsAndModels: [],
    keywords: ["ремонт", "строительство"],
    synonyms: [],
    stopWords: [],
    okpd2Codes: ["41.20", "42.11"],
  },
  restrictions: {
    minPrice: 0,
    maxPrice: 90_000_000,
    maxDistanceKm: null,
    maxPaymentTermDays: 60,
    minDeliveryTermDays: 7,
    minMarginPercent: 5,
    maxBidSecurity: 5_000_000,
    maxContractSecurity: 20_000_000,
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
  sroMemberships: [makeSro(), DESIGN_SRO],
  hasPersonnel: true,
  hasEquipment: true,
  hasSpecialAccount: true,
  staff: { total: 11, nrsCount: 2, noprizCount: 2 },
  experience: [],
  experienceTotals: { lastYearAmount: 100_000_000, last3YearsAmount: 200_000_000 },
  documents: [],
};

function makeTender(overrides: Partial<Tender> = {}, price = 1_000_000): Tender {
  return {
    id: "t-1",
    regNumber: "01000000001",
    externalId: null,
    law: "FZ_223",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка компьютеров",
    customerName: "АО Заказчик",
    customerInn: null,
    region: "Москва",
    deliveryAddress: "Москва",
    financial: {
      price,
      currency: "RUB",
      advancePercent: 30,
      advanceAmount: price * 0.3,
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
      submissionEnd: "2026-10-15T10:00:00.000Z",
      publicationDate: "2026-09-01T10:00:00.000Z",
      lastUpdateDate: "2026-09-01T10:00:00.000Z",
      deliveryTermDays: 60,
      warrantyMonths: 24,
    },
    okpd2Codes: [],
    lots: [],
    requirements: [],
    documents: [],
    nationalRegime: false,
    onlyForSmp: false,
    eisUrl: "https://zakupki.gov.ru",
    dataSource: "EIS",
    changeLog: [],
    ...overrides,
  };
}

function makeRequirement(
  overrides: Partial<TenderRequirement> = {},
): TenderRequirement {
  return {
    id: "req-1",
    kind: "EXPERIENCE",
    title: "Опыт исполнения договоров",
    description: "",
    mandatory: true,
    requiredValue: null,
    evidenceId: null,
    ...overrides,
  };
}

function record(amount: number, completedAt: string): ExperienceRecord {
  return {
    id: `exp-${amount}-${completedAt}`,
    subject: "Работы",
    customer: "Заказчик",
    contractNumber: "Д-1",
    amount,
    completedAt,
    okpd2Code: null,
  };
}

describe("detectSroKinds — виды работ по предмету закупки", () => {
  it.each(LIVE_CONSTRUCTION_SUBJECTS)("строительные работы: %s", (subject) => {
    expect(detectSroKinds(subject)).toContain("CONSTRUCTION");
  });

  it.each(LIVE_NON_CONSTRUCTION_SUBJECTS)("не строительные работы: %s", (subject) => {
    expect(detectSroKinds(subject)).not.toContain("CONSTRUCTION");
  });

  it("проектная документация на реконструкцию — проектирование и строительство", () => {
    const kinds = detectSroKinds(
      "Открытый запрос предложений на разработку проектной документации на выполнение реконструкции и изменение назначения производственного здания на здание складского комплекса",
    );
    expect(kinds).toContain("DESIGN");
    expect(kinds).toContain("CONSTRUCTION");
  });

  it("изыскания и проектная документация — без строительного вида", () => {
    const kinds = detectSroKinds(
      "Выполнение инженерных изысканий, разработку проектной, сметной и рабочей документации, сопровождение государственной экспертизы по объекту: «Проектирование и строительство котельной на дизельном топливе»",
    );
    expect(kinds).toContain("SURVEY");
    expect(kinds).toContain("DESIGN");
    // Строительство упомянуто только в названии объекта после «по объекту:».
    expect(kinds).not.toContain("CONSTRUCTION");
  });

  it("обычная поставка не даёт видов работ", () => {
    expect(detectSroKinds("Поставка канцелярских товаров для нужд учреждения")).toEqual([]);
  });
});

describe("inferSroKind и effectiveSroLimit — допуски профиля", () => {
  it("вид допуска определяется по наименованию из выписки", () => {
    expect(inferSroKind("Строительство, реконструкция, капитальный ремонт")).toBe(
      "CONSTRUCTION",
    );
    expect(inferSroKind("Архитектурно-строительное проектирование")).toBe("DESIGN");
    expect(inferSroKind("Инженерные изыскания")).toBe("SURVEY");
    expect(inferSroKind("Пожарная безопасность")).toBe("OTHER");
  });

  it("явный лимит важнее уровня ответственности", () => {
    expect(effectiveSroLimit(makeSro({ maxContractAmount: 500_000_000 }))).toBe(
      500_000_000,
    );
  });

  it("предел берётся из уровня ответственности по ст. 55.16 ГрК РФ", () => {
    expect(
      effectiveSroLimit(makeSro({ kind: "CONSTRUCTION", maxContractAmount: null })),
    ).toBe(90_000_000);
    expect(effectiveSroLimit(makeSro({ kind: "DESIGN", maxContractAmount: null }))).toBe(
      25_000_000,
    );
    expect(effectiveSroLimit(makeSro({ kind: "SURVEY", maxContractAmount: null }))).toBe(
      25_000_000,
    );
    // Пятый уровень строительства ограничения сверху не имеет.
    expect(
      effectiveSroLimit(
        makeSro({ kind: "CONSTRUCTION", responsibilityLevel: 5, maxContractAmount: null }),
      ),
    ).toBeNull();
    expect(effectiveSroLimit(makeSro({ responsibilityLevel: null, maxContractAmount: null }))).toBeNull();
  });

  it("неподтверждённое и просроченное членство не действует", () => {
    expect(isSroActive(makeSro({ confirmed: false }), NOW)).toBe(false);
    expect(isSroActive(makeSro({ validUntil: "2026-01-10" }), NOW)).toBe(false);
    expect(isSroActive(makeSro({ validUntil: "2027-01-10" }), NOW)).toBe(true);
    // Бессрочное членство: дата не задана.
    expect(isSroActive(makeSro({ validUntil: null }), NOW)).toBe(true);
  });
});

describe("checkSroAdmission — блокер по уровню ответственности", () => {
  const constructionTender = (price: number): Tender =>
    makeTender(
      {
        subject:
          "Выполнение работ по капитальному ремонту здания административного назначения",
      },
      price,
    );

  it("цена в пределах 1-го уровня — допуск подтверждает участие", () => {
    const check = checkSroAdmission(constructionTender(45_000_000), baseProfile, NOW);
    expect(check.kinds).toEqual(["CONSTRUCTION"]);
    expect(check.covered).toEqual(["CONSTRUCTION"]);
    expect(check.shortfalls).toHaveLength(0);
    expect(check.blocker).toBeNull();
    expect(check.uncertainties).toHaveLength(0);
    expect(hasAdmissibleSro(constructionTender(45_000_000), baseProfile, NOW)).toBe(true);
  });

  it("цена выше 90 млн — критический блокер по уровню ответственности", () => {
    const check = checkSroAdmission(constructionTender(120_000_000), baseProfile, NOW);
    expect(check.shortfalls).toHaveLength(1);
    expect(check.blocker?.critical).toBe(true);
    expect(check.blocker?.reason).toBe("Недостаточный уровень ответственности СРО");
    expect(plain(check.blocker?.detail)).toContain("90 000 000");
    expect(hasAdmissibleSro(constructionTender(120_000_000), baseProfile, NOW)).toBe(false);
  });

  it("граница уровня включительно проходит", () => {
    const check = checkSroAdmission(constructionTender(90_000_000), baseProfile, NOW);
    expect(check.blocker).toBeNull();
    expect(check.shortfalls).toHaveLength(0);
  });

  it("цена закупки без опубликованной НМЦК не сравнивается с лимитом", () => {
    const check = checkSroAdmission(constructionTender(0), baseProfile, NOW);
    expect(check.blocker).toBeNull();
    expect(hasAdmissibleSro(constructionTender(0), baseProfile, NOW)).toBe(true);
  });

  it("проектные работы дороже 25 млн — блокер по допуску проектировщиков", () => {
    const tender = makeTender(
      { subject: "Выполнение проектных работ по разработке рабочей документации" },
      30_000_000,
    );
    const check = checkSroAdmission(tender, baseProfile, NOW);
    expect(check.kinds).toEqual(["DESIGN"]);
    expect(check.covered).toContain("DESIGN");
    expect(check.blocker?.reason).toBe("Недостаточный уровень ответственности СРО");
    expect(plain(check.blocker?.detail)).toContain("25 000 000");
  });

  it("смешанный предмет с одним спорным лимитом уходит в ручную проверку", () => {
    const tender = makeTender(
      {
        subject:
          "Выполнение проектно-изыскательских работ и строительно-монтажных работ по реконструкции здания",
      },
      45_000_000,
    );
    const check = checkSroAdmission(tender, baseProfile, NOW);
    // Строительство покрыто, проектирование — нет (45 млн > 25 млн).
    expect(check.blocker).toBeNull();
    expect(check.shortfalls.map((s) => s.kind)).toContain("DESIGN");
    expect(check.uncertainties.some((u) => u.material)).toBe(true);
  });

  it("допуск другого вида — блокер «Нет допуска СРО требуемого вида»", () => {
    const profile: CompanyProfile = {
      ...baseProfile,
      sroMemberships: [DESIGN_SRO],
    };
    const check = checkSroAdmission(constructionTender(10_000_000), profile, NOW);
    expect(check.covered).toEqual([]);
    expect(check.blocker?.reason).toBe("Нет допуска СРО требуемого вида");
    expect(check.blocker?.critical).toBe(true);
  });

  it("без допусков в профиле блокер не ставится", () => {
    const profile: CompanyProfile = { ...baseProfile, sroMemberships: [] };
    const check = checkSroAdmission(constructionTender(120_000_000), profile, NOW);
    expect(check.blocker).toBeNull();
    expect(check.uncertainties).toHaveLength(0);
    expect(hasAdmissibleSro(constructionTender(10_000_000), profile, NOW)).toBe(false);
  });

  it("просроченное членство нужного вида — неопределённость, а не блокер", () => {
    const profile: CompanyProfile = {
      ...baseProfile,
      sroMemberships: [makeSro({ validUntil: "2026-03-01" }), DESIGN_SRO],
    };
    const check = checkSroAdmission(constructionTender(45_000_000), profile, NOW);
    expect(check.blocker).toBeNull();
    const lapsed = check.uncertainties.find((u) =>
      u.question.includes("Действует ли допуск СРО нужного вида"),
    );
    expect(lapsed?.material).toBe(true);
    expect(lapsed?.detail).toContain("истёк срок или не подтверждён выпиской");
  });

  it("просроченное членство другого вида показывается отдельно", () => {
    const profile: CompanyProfile = {
      ...baseProfile,
      sroMemberships: [
        makeSro(),
        makeSro({
          id: "sro-3",
          kind: "SURVEY",
          type: "Инженерные изыскания",
          responsibilityLevel: 1,
          maxContractAmount: 25_000_000,
          validUntil: "2026-03-01",
        }),
      ],
    };
    const check = checkSroAdmission(constructionTender(45_000_000), profile, NOW);
    expect(check.blocker).toBeNull();
    const expired = check.uncertainties.find((u) =>
      u.question.includes("Действует ли членство в СРО"),
    );
    expect(expired?.material).toBe(true);
    expect(expired?.detail).toContain("Инженерные изыскания");
  });

  it("поставка не проверяется на допуск вовсе", () => {
    const check = checkSroAdmission(makeTender({}, 120_000_000), baseProfile, NOW);
    expect(check.kinds).toEqual([]);
    expect(check.blocker).toBeNull();
    expect(describeSroPosition(makeTender({}, 120_000_000), baseProfile, NOW)).toBeNull();
  });

  it("блокеры и неопределённости допуска доступны скорингу", () => {
    const expensive = constructionTender(120_000_000);
    expect(admissionBlockers(expensive, baseProfile, NOW)).toHaveLength(1);
    expect(admissionBlockers(constructionTender(45_000_000), baseProfile, NOW)).toHaveLength(0);
    expect(admissionUncertainties(expensive, baseProfile, NOW)).toHaveLength(0);
  });
});

describe("describeSroPosition — формулировка для карточки", () => {
  it("называет вид работ, допуск, уровень и предел", () => {
    const text = describeSroPosition(
      makeTender({ subject: "Капитальный ремонт здания спортивного зала" }, 45_000_000),
      baseProfile,
      NOW,
    );
    expect(text).toContain("Виды работ по предмету закупки: строительство");
    expect(text).toContain("1-й уровень ответственности");
    expect(plain(text)).toContain("90 000 000 ₽");
    expect(text).not.toContain("выше предела");
  });

  it("отмечает превышение предела ценой закупки", () => {
    const text = describeSroPosition(
      makeTender({ subject: "Капитальный ремонт здания спортивного зала" }, 120_000_000),
      baseProfile,
      NOW,
    );
    expect(text).toContain("цена закупки выше предела");
  });

  it("сообщает об отсутствии допуска нужного вида", () => {
    const text = describeSroPosition(
      makeTender({ subject: "Капитальный ремонт здания спортивного зала" }, 1_000_000),
      { ...baseProfile, sroMemberships: [] },
      NOW,
    );
    expect(text).toContain("допуска в профиле нет");
  });

  it("подписи видов работ берутся из общего справочника", () => {
    expect(sroKindsLabel(["CONSTRUCTION", "DESIGN"])).toBe("строительство, проектирование");
    expect(sroKindsLabel([])).toBe("не определены");
  });
});

describe("isRequirementSatisfied — требование членства в СРО", () => {
  const requirement = makeRequirement({
    kind: "SRO",
    title: "Членство в СРО",
    requiredValue: "Строительство",
  });

  it("подтверждается допуском, лимит которого покрывает цену", () => {
    const tender = makeTender(
      { subject: "Капитальный ремонт здания", requirements: [requirement] },
      45_000_000,
    );
    expect(isRequirementSatisfied(requirement, tender, baseProfile, NOW)).toBe(true);
  });

  it("не подтверждается, если цена выше предела допуска", () => {
    const tender = makeTender(
      { subject: "Капитальный ремонт здания", requirements: [requirement] },
      120_000_000,
    );
    expect(isRequirementSatisfied(requirement, tender, baseProfile, NOW)).toBe(false);
  });

  it("вид работ берётся из предмета закупки, если в требовании он не назван", () => {
    const generic = makeRequirement({
      kind: "SRO",
      title: "Выписка из реестра членов СРО",
      requiredValue: null,
    });
    const tender = makeTender(
      { subject: "Разработка проектной документации на капитальный ремонт здания", requirements: [generic] },
      10_000_000,
    );
    // Цена 10 млн укладывается и в строительный (90 млн), и в проектный (25 млн) допуск.
    expect(isRequirementSatisfied(generic, tender, baseProfile, NOW)).toBe(true);
    const expensive = makeTender(
      { subject: "Разработка проектной документации на капитальный ремонт здания", requirements: [generic] },
      30_000_000,
    );
    expect(isRequirementSatisfied(generic, expensive, baseProfile, NOW)).toBe(true);
  });
});

describe("parseMoneyRu — суммы в русском формате", () => {
  it("читает млн, млрд, тыс и полные суммы", () => {
    expect(parseMoneyRu("не менее 200 млн ₽")).toBe(200_000_000);
    expect(parseMoneyRu("1,5 млрд рублей")).toBe(1_500_000_000);
    expect(parseMoneyRu("свыше 500 тыс. руб.")).toBe(500_000);
    expect(parseMoneyRu("не менее 90 000 000 руб.")).toBe(90_000_000);
  });

  it("не принимает сроки и счёт за сумму", () => {
    expect(parseMoneyRu("опыт за последние 3 года")).toBeNull();
    expect(parseMoneyRu("не менее 2 исполненных контрактов")).toBeNull();
    expect(parseMoneyRu("требуется допуск СРО")).toBeNull();
  });

  it("из нескольких сумм берёт наибольшую", () => {
    expect(parseMoneyRu("от 3 млн ₽ до 10 млн ₽")).toBe(10_000_000);
  });
});

describe("parseExperienceThreshold — порог опыта", () => {
  it("совокупная сумма за период", () => {
    const parsed = parseExperienceThreshold(
      "Наличие опыта исполнения договоров строительного подряда за последние 3 года на общую сумму не менее 200 млн ₽",
      10_000_000,
    );
    expect(parsed?.minAmount).toBe(200_000_000);
    expect(parsed?.minSingleContractAmount).toBeNull();
    expect(parsed?.periodYears).toBe(3);
  });

  it("сумма одного контракта не читается как совокупный объём", () => {
    const parsed = parseExperienceThreshold(
      "Опыт исполнения контрактов стоимостью от 3 млн ₽ за последние 3 года",
      10_000_000,
    );
    expect(parsed?.minAmount).toBeNull();
    expect(parsed?.minSingleContractAmount).toBe(3_000_000);
  });

  it("предыдущий год — период 1 год", () => {
    const parsed = parseExperienceThreshold(
      "Сумма выполненных работ за предыдущий год не менее 100 млн ₽",
      0,
    );
    expect(parsed?.periodYears).toBe(1);
    expect(parsed?.minAmount).toBe(100_000_000);
  });

  it("доля НМЦК пересчитывается в сумму", () => {
    const parsed = parseExperienceThreshold(
      "Опыт исполнения контрактов на сумму не менее 20% НМЦК",
      50_000_000,
    );
    expect(parsed?.minAmount).toBe(10_000_000);
  });

  it("число исполненных контрактов", () => {
    const parsed = parseExperienceThreshold(
      "Наличие не менее 3 исполненных договоров строительного подряда",
      0,
    );
    expect(parsed?.minContracts).toBe(3);
  });

  it("без порога возвращает null", () => {
    expect(parseExperienceThreshold("Наличие опыта выполнения аналогичных работ", 0)).toBeNull();
  });
});

describe("computeExperienceTotals и resolveExperienceTotals", () => {
  const records: ExperienceRecord[] = [
    record(30_000_000, "2026-06-01"),
    // Контракт старше года, но внутри трёх лет: границы периодов различаются.
    record(70_000_000, "2025-03-01"),
    record(15_000_000, "2024-01-15"),
    record(5_000_000, "2020-05-05"),
  ];

  it("считает суммы за год и за три года по записям", () => {
    const totals = computeExperienceTotals(records, NOW);
    expect(totals.lastYearAmount).toBe(30_000_000);
    expect(totals.last3YearsAmount).toBe(115_000_000);
  });

  it("без записей отличает отсутствие данных от нуля", () => {
    expect(computeExperienceTotals([], NOW)).toEqual({
      lastYearAmount: null,
      last3YearsAmount: null,
    });
  });

  it("заявленные суммы анкеты приоритетнее расчётных", () => {
    expect(resolveExperienceTotals(baseProfile, NOW)).toEqual({
      lastYearAmount: 100_000_000,
      last3YearsAmount: 200_000_000,
    });
  });

  it("профиль без заявленных сумм считается по контрактам", () => {
    const profile: CompanyProfile = {
      ...baseProfile,
      experience: records,
      experienceTotals: { lastYearAmount: null, last3YearsAmount: null },
    };
    expect(resolveExperienceTotals(profile, NOW)).toEqual({
      lastYearAmount: 30_000_000,
      last3YearsAmount: 115_000_000,
    });
  });

  it("профиль старой схемы без слоя experienceTotals не падает", () => {
    const legacy = { ...baseProfile, experience: records } as Record<string, unknown>;
    delete legacy.experienceTotals;
    expect(resolveExperienceTotals(legacy as unknown as CompanyProfile, NOW)).toEqual({
      lastYearAmount: 30_000_000,
      last3YearsAmount: 115_000_000,
    });
  });

  it("наибольший контракт учитывает период", () => {
    const profile: CompanyProfile = { ...baseProfile, experience: records };
    expect(largestContractAmount(profile, 1, NOW)).toBe(30_000_000);
    expect(largestContractAmount(profile, 3, NOW)).toBe(70_000_000);
    expect(largestContractAmount(profile, null, NOW)).toBe(70_000_000);
    expect(largestContractAmount(baseProfile, 3, NOW)).toBeNull();
  });
});

describe("checkExperienceAdmission — проверка опыта по профилю", () => {
  it("заявленных 100 млн за год хватает на требование 100 млн", () => {
    const check = checkExperienceAdmission(
      makeRequirement({
        description: "Сумма выполненных работ за предыдущий год не менее 100 млн ₽",
      }),
      makeTender(),
      baseProfile,
      NOW,
    );
    expect(check.satisfied).toBe(true);
    expect(check.reason).toBeNull();
    expect(check.inconclusive).toBeNull();
  });

  it("требование 300 млн за три года не подтверждается и объясняет почему", () => {
    const check = checkExperienceAdmission(
      makeRequirement({
        description: "Опыт исполнения договоров за последние 3 года на общую сумму не менее 300 млн ₽",
      }),
      makeTender(),
      baseProfile,
      NOW,
    );
    expect(check.satisfied).toBe(false);
    expect(plain(check.reason)).toContain("200 000 000");
    expect(plain(check.reason)).toContain("300 000 000");
    expect(check.inconclusive).toBeNull();
  });

  it("период длиннее трёх лет даёт ручную проверку, а не отказ", () => {
    const check = checkExperienceAdmission(
      makeRequirement({
        description: "Опыт за последние 5 лет на общую сумму не менее 300 млн ₽",
      }),
      makeTender(),
      baseProfile,
      NOW,
    );
    // Трёхлетняя сумма известна (200 млн), но за пять лет она могла быть больше —
    // нарушение не доказано, поэтому отказ заменяется ручной проверкой.
    expect(check.satisfied).toBe(true);
    expect(check.reason).toBeNull();
    expect(plain(check.inconclusive)).toContain("300 000 000");
  });

  it("требование к сумме одного договора сверяется с крупнейшим контрактом", () => {
    const profile: CompanyProfile = {
      ...baseProfile,
      experience: [record(2_000_000, "2026-06-01")],
      experienceTotals: { lastYearAmount: null, last3YearsAmount: null },
    };
    const check = checkExperienceAdmission(
      makeRequirement({ description: "Опыт исполнения контрактов стоимостью от 3 млн ₽" }),
      makeTender(),
      profile,
      NOW,
    );
    expect(check.satisfied).toBe(false);
    expect(check.reason).toContain("наибольший исполненный контракт");
  });

  it("число контрактов нельзя проверить, если заявлена только сумма", () => {
    const check = checkExperienceAdmission(
      makeRequirement({ description: "Наличие не менее 3 исполненных контрактов" }),
      makeTender(),
      baseProfile,
      NOW,
    );
    // satisfied означает «нарушение не доказано»: спор уходит в inconclusive,
    // а разбор требований делает из него ручную проверку, а не отказ.
    expect(check.satisfied).toBe(true);
    expect(check.reason).toBeNull();
    expect(check.inconclusive).toContain("перечня контрактов в профиле нет");
  });

  it("сумма и проценты НМЦК не читаются как число контрактов", () => {
    const threshold = parseExperienceThreshold(
      "Опыт исполнения договоров за последние 5 лет на общую сумму не менее 300 млн ₽",
      0,
    );
    expect(threshold?.minContracts).toBeNull();
    expect(threshold?.minAmount).toBe(300_000_000);
    expect(threshold?.periodYears).toBe(5);
  });

  it("недостающие суммы — неопределённость, а не нарушение", () => {
    const profile: CompanyProfile = {
      ...baseProfile,
      experienceTotals: { lastYearAmount: null, last3YearsAmount: null },
    };
    const check = checkExperienceAdmission(
      makeRequirement({
        description: "Сумма выполненных работ за предыдущий год не менее 100 млн ₽",
      }),
      makeTender(),
      profile,
      NOW,
    );
    expect(check.reason).toBeNull();
    expect(check.inconclusive).toContain("не указана сумма исполненных работ");
  });

  it("без распознанного порога опыт подтверждается наличием данных", () => {
    const soft = makeRequirement({ description: "Наличие опыта выполнения аналогичных работ" });
    expect(checkExperienceAdmission(soft, makeTender(), baseProfile, NOW).satisfied).toBe(true);
    const empty: CompanyProfile = {
      ...baseProfile,
      experience: [],
      experienceTotals: { lastYearAmount: null, last3YearsAmount: null },
    };
    const check = checkExperienceAdmission(soft, makeTender(), empty, NOW);
    expect(check.satisfied).toBe(false);
    expect(check.reason).toContain("нет записей об исполненных контрактах");
  });
});

describe("parsePersonnelRequirement — кадры", () => {
  it("разводит численность, НРС и НОПРИЗ", () => {
    expect(
      parsePersonnelRequirement(
        "В штате не менее 11 человек, из них 2 специалиста в НРС и 2 специалиста в НОПРИЗ",
      ),
    ).toEqual({ minTotal: 11, minNrs: 2, minNopriz: 2 });
  });

  it("национальный реестр специалистов читается как НРС", () => {
    expect(
      parsePersonnelRequirement(
        "Наличие не менее 2 специалистов, включённых в национальный реестр специалистов",
      ),
    ).toEqual({ minTotal: null, minNrs: 2, minNopriz: null });
  });

  it("стаж не принимается за численность", () => {
    expect(
      parsePersonnelRequirement(
        "Наличие специалистов со стажем работы не менее 5 лет в строительстве",
      ).minTotal,
    ).toBeNull();
  });

  it("требование к нескольким группам специалистов суммируется по максимуму", () => {
    expect(
      parsePersonnelRequirement(
        "Штат не менее 15 человек. Не менее 3 инженеров в НОПРИЗ.",
      ),
    ).toEqual({ minTotal: 15, minNrs: null, minNopriz: 3 });
  });
});

describe("checkPersonnelAdmission — проверка кадров", () => {
  it("профиль 11/2/2 проходит требование 11/2/2", () => {
    const check = checkPersonnelAdmission(
      makeRequirement({
        kind: "QUALIFIED_PERSONNEL",
        description: "В штате не менее 11 человек, из них 2 в НРС и 2 в НОПРИЗ",
      }),
      baseProfile,
    );
    expect(check.satisfied).toBe(true);
    expect(check.threshold).toEqual({ minTotal: 11, minNrs: 2, minNopriz: 2 });
    expect(check.reason).toBeNull();
  });

  it("нехватка штата и специалистов НРС перечисляется в причине", () => {
    const check = checkPersonnelAdmission(
      makeRequirement({
        kind: "QUALIFIED_PERSONNEL",
        description: "В штате не менее 15 человек, из них 3 в НРС",
      }),
      baseProfile,
    );
    expect(check.satisfied).toBe(false);
    expect(check.reason).toContain("штат 11 чел.");
    expect(check.reason).toContain("в НРС 2 специалист(ов)");
  });

  it("незаполненный кадровый состав — ручная проверка", () => {
    const profile: CompanyProfile = {
      ...baseProfile,
      staff: { total: null, nrsCount: 0, noprizCount: 0 },
    };
    const check = checkPersonnelAdmission(
      makeRequirement({
        kind: "QUALIFIED_PERSONNEL",
        description: "В штате не менее 11 человек",
      }),
      profile,
    );
    expect(check.inconclusive).toContain("Кадровый состав в профиле не заполнен");
    expect(check.satisfied).toBe(profile.hasPersonnel);
  });

  it("без порога требование закрывается признаком наличия персонала", () => {
    const satisfied = checkPersonnelAdmission(
      makeRequirement({ kind: "QUALIFIED_PERSONNEL", description: "Наличие квалифицированного персонала" }),
      baseProfile,
    );
    expect(satisfied.satisfied).toBe(true);
    const noPersonnel = checkPersonnelAdmission(
      makeRequirement({ kind: "QUALIFIED_PERSONNEL", description: "Наличие квалифицированного персонала" }),
      { ...baseProfile, hasPersonnel: false },
    );
    expect(noPersonnel.satisfied).toBe(false);
    expect(noPersonnel.reason).toContain("не отмечено наличие персонала");
  });
});

describe("admissionUncertainties — опыт и кадры в скоринге", () => {
  it("неподтверждаемый опыт даёт существенную неопределённость", () => {
    const requirement = makeRequirement({
      description: "Сумма выполненных работ за предыдущий год не менее 100 млн ₽",
    });
    const tender = makeTender({ requirements: [requirement] });
    const profile: CompanyProfile = {
      ...baseProfile,
      experienceTotals: { lastYearAmount: null, last3YearsAmount: null },
    };
    const uncertainties = admissionUncertainties(tender, profile, NOW);
    const byId = uncertainties.find((u) => u.id.endsWith(`unc-experience-${requirement.id}`));
    expect(byId?.material).toBe(true);
    expect(byId?.detail).toContain("не указана сумма исполненных работ");
  });

  it("необязательное требование неопределённости не добавляет", () => {
    const requirement = makeRequirement({
      mandatory: false,
      description: "Сумма выполненных работ за предыдущий год не менее 100 млн ₽",
    });
    const tender = makeTender({ requirements: [requirement] });
    const profile: CompanyProfile = {
      ...baseProfile,
      experienceTotals: { lastYearAmount: null, last3YearsAmount: null },
    };
    expect(admissionUncertainties(tender, profile, NOW)).toHaveLength(0);
  });
});
