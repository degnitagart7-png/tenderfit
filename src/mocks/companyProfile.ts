import type { CompanyProfile } from "@/domain/entities";

/**
 * Демонстрационный профиль компании.
 * Компания занимается поставкой и обслуживанием компьютерной и оргтехники.
 * Все данные вымышленные и предназначены только для демонстрации.
 */
export const demoCompanyProfile: CompanyProfile = {
  organizationId: "org-demo",
  legalName: 'ИП Иванов Иван Иванович «ТехноПоставка»',
  // Контрольная сумма сходится: прежний 500100732252 её не проходил, и
  // демо-профиль нельзя было сохранить — форма отвечала «Некорректный ИНН».
  inn: "500100732259",
  legalForm: "IP",
  taxSystem: "USN_INCOME",
  worksWithVat: false,
  activityDescription:
    "Поставка компьютерной техники, оргтехники и серверного оборудования; техническое обслуживание и ремонт офисной техники.",
  capabilities: {
    products: [
      "компьютер",
      "системный блок",
      "ноутбук",
      "принтер",
      "МФУ",
      "сервер",
      "оргтехника",
      "монитор",
    ],
    works: ["монтаж локальных вычислительных сетей"],
    services: [
      "техническое обслуживание оргтехники",
      "ремонт офисной техники",
      "техподдержка",
    ],
    brandsAndModels: ["Katusha", "Aquarius", "Yadro", "HP", "Kyocera"],
    keywords: [
      "компьютер",
      "ноутбук",
      "принтер",
      "МФУ",
      "сервер",
      "оргтехника",
      "системный блок",
      "монитор",
    ],
    synonyms: ["ПК", "ЭВМ", "персональный компьютер", "печатающее устройство"],
    stopWords: ["аренда", "ремонт помещений", "строительство", "медицинск"],
    okpd2Codes: ["26.20", "26.20.11", "28.23", "26.20.15"],
  },
  restrictions: {
    minPrice: 30_000,
    maxPrice: 5_000_000,
    maxDistanceKm: null,
    maxPaymentTermDays: 30,
    minDeliveryTermDays: 14,
    minMarginPercent: 10,
    maxBidSecurity: 100_000,
    maxContractSecurity: 500_000,
    allowNoAdvance: true,
    workRegions: ["Москва", "Московская область", "Санкт-Петербург"],
    customerWhitelist: [],
    customerBlacklist: ["ООО «Конфликтный заказчик»"],
    custom: ["Не участвуем в закупках с казначейским сопровождением"],
  },
  licenses: [
    {
      id: "lic-mchs",
      kind: "Лицензия МЧС на монтаж средств пожарной безопасности",
      number: "77-Б/00000",
      issuer: "МЧС России",
      validUntil: "2028-12-31",
      confirmed: true,
    },
  ],
  sroMemberships: [],
  hasPersonnel: true,
  hasEquipment: true,
  hasSpecialAccount: true,
  staff: {
    total: 12,
    nrsCount: 0,
    noprizCount: 0,
  },
  preferences: {
    priorityRegions: ["Москва", "Московская область"],
    preferredMinPrice: 100_000,
    preferredMaxPrice: 3_000_000,
    preferAdvance: true,
    preferShortPaymentTerm: true,
    priorityBrands: ["Katusha", "Aquarius", "Yadro"],
    avoidTreasurySupport: true,
    notes: ["Предпочтительны контракты на техподдержку с продлением"],
  },
  experience: [
    {
      id: "exp-01",
      subject: "Поставка персональных компьютеров для нужд учреждения",
      customer: "ГБУ «Центр информатизации»",
      contractNumber: "01-2025/ПК",
      amount: 850_000,
      completedAt: "2025-03-14",
      okpd2Code: "26.20.11",
    },
    {
      id: "exp-02",
      subject: "Техническое обслуживание оргтехники (12 мес.)",
      customer: "ФГБУ «Управление эксплуатации зданий»",
      contractNumber: "07-2024/ТО",
      amount: 1_200_000,
      completedAt: "2024-12-02",
      okpd2Code: "28.23",
    },
  ],
  // Суммы не заявлены отдельно: движок считает их по записям выше.
  experienceTotals: {
    lastYearAmount: null,
    last3YearsAmount: null,
  },
  documents: [],
};
