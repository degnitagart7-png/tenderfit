import type {
  CompanyProfile,
  Tender,
  TenderDocument,
  TenderFinancialTerms,
  TenderRequirement,
} from "@/domain/entities";
import type { PlacingWay, TenderLaw } from "@/domain/enums";
import { buildEisUrl } from "@/domain/enums";

/**
 * Динамическая генерация демонстрационных закупок на основе профиля компании.
 *
 * При смене профиля (отрасль, цены, регионы) генерируются новые закупки,
 * релевантные именно этому профилю. Это позволяет пользователю увидеть
 * работу сервиса в любой сфере, а не только в «компьютерной» демо-базе.
 *
 * Все данные вымышленные и предназначены только для демонстрации.
 */

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (offsetDays: number, hour = 10): string =>
  new Date(now + offsetDays * DAY).toISOString().slice(0, 11) +
  String(hour).padStart(2, "0") +
  ":00:00.000Z";

/* ========================= Отраслевые шаблоны ========================= */

interface IndustryTemplate {
  /** Ключевые слова для определения отрасли. */
  markers: string[];
  /** ОКПД2-коды отрасли. */
  okpd2: string[];
  /** Шаблоны предметов закупок. {keyword} подставляется из профиля. */
  subjects: string[];
  /** Шаблоны текстов документации. */
  docTexts: string[];
  /** Типичные требования к участникам. */
  requirementTemplates: Array<{
    kind: TenderRequirement["kind"];
    title: string;
    description: string;
    requiredValue: string | null;
  }>;
}

const INDUSTRY_TEMPLATES: Record<string, IndustryTemplate> = {
  construction: {
    markers: [
      "строительств",
      "ремонт",
      "монтаж",
      "реконструкц",
      "отделк",
      "СМР",
      "капитальный ремонт",
      "дорог",
      "водопровод",
      "инженерных систем",
    ],
    okpd2: ["41.20", "41.20.10", "42.11", "42.11.20", "42.21", "43.11", "43.21", "43.22", "43.30", "43.99"],
    subjects: [
      "Строительство {item}",
      "Капитальный ремонт {item}",
      "Реконструкция {item}",
      "Монтаж инженерных систем в {item}",
      "Отделочные работы в {item}",
      "Строительство {item} (генеральный подряд)",
      "Благоустройство территории {item}",
      "Проектирование и строительство {item}",
    ],
    docTexts: [
      "Строительно-монтажные работы. Генеральный подряд. Требуется членство в СРО.",
      "Капитальный ремонт здания. Демонтажные, общестроительные, отделочные работы.",
      "Реконструкция объекта капитального строительства. Гарантийный срок 36 месяцев.",
      "Монтаж инженерных систем: отопление, вентиляция, электрика, водоснабжение.",
    ],
    requirementTemplates: [
      { kind: "SRO", title: "Членство в СРО строителей", description: "Требуется действующая выписка из реестра членов СРО в области строительства.", requiredValue: "строительство" },
      { kind: "EXPERIENCE", title: "Опыт исполнения аналогичных контрактов", description: "Не менее 2 исполненных контрактов за последние 3 года.", requiredValue: null },
      { kind: "EQUIPMENT", title: "Наличие строительной техники", description: "Необходимо наличие или аренда строительной техники.", requiredValue: null },
    ],
  },
  it: {
    markers: [
      "компьютер",
      "ноутбук",
      "сервер",
      "принтер",
      "МФУ",
      "оргтехника",
      "программ",
      "IT",
      "информацион",
      "монитор",
    ],
    okpd2: ["26.20", "26.20.11", "26.20.15", "28.23", "58.29", "62.01", "63.11"],
    subjects: [
      "Поставка {item}",
      "Поставка {item} для бюджетных учреждений",
      "Техническое обслуживание {item}",
      "Поставка серверного оборудования",
      "Комплексное оснащение рабочих мест ({item})",
      "Поставка {item} (централизованная закупка)",
      "Модернизация вычислительной инфраструктуры",
      "Поставка лицензий на программное обеспечение",
    ],
    docTexts: [
      "Поставка компьютерной техники. Соответствие ОКПД2. Гарантийное обслуживание 12 месяцев.",
      "Техническое обслуживание и ремонт офисной техники. Срок реакции — 4 часа.",
      "Поставка серверного оборудования для дата-центра. Требования к совместимости.",
      "Комплексное оснащение рабочих мест: системные блоки, мониторы, оргтехника.",
    ],
    requirementTemplates: [
      { kind: "LICENSE", title: "Лицензия на деятельность", description: "Требуется лицензия на техническое обслуживание средств вычислительной техники.", requiredValue: null },
      { kind: "EXPERIENCE", title: "Опыт поставки аналогичной техники", description: "Не менее 3 исполненных контрактов на поставку компьютерной техники.", requiredValue: null },
      { kind: "PRODUCT_CHARACTERISTIC", title: "Соответствие характеристикам", description: "Товар должен соответствовать техническим характеристикам из ТЗ.", requiredValue: null },
    ],
  },
  medical: {
    markers: ["медицин", "лекарств", "фармацевт", "больниц", "клиник", "диагност", "лаборатор"],
    okpd2: ["21.20", "32.50", "86.10", "86.90"],
    subjects: [
      "Поставка {item} для медицинских учреждений",
      "Поставка медицинского оборудования",
      "Поставка лекарственных препаратов",
      "Техническое обслуживание {item}",
      "Поставка расходных материалов для {item}",
      "Комплексное оснащение {item}",
    ],
    docTexts: [
      "Поставка медицинского оборудования. Требуется регистрационное удостоверение.",
      "Поставка лекарственных препаратов для нужд лечебных учреждений.",
      "Техническое обслуживание медицинского оборудования. Наличие сервисной службы.",
    ],
    requirementTemplates: [
      { kind: "LICENSE", title: "Лицензия на медицинскую деятельность", description: "Требуется лицензия на осуществление медицинской деятельности.", requiredValue: "медицинск" },
      { kind: "EXPERIENCE", title: "Опыт поставки медтехники", description: "Не менее 2 контрактов на поставку медицинского оборудования.", requiredValue: null },
    ],
  },
  food: {
    markers: ["питани", "продукт", "еда", "пищев", " catering", " столов", "буфет"],
    okpd2: ["10", "11", "56.29"],
    subjects: [
      "Организация питания в {item}",
      "Поставка продуктов питания для {item}",
      "Оказание услуг по питанию в {item}",
      "Поставка продовольственных товаров",
      "Организация буфета в {item}",
    ],
    docTexts: [
      "Организация питания в учреждении. Полный цикл: закупка, приготовление, подача.",
      "Поставка продуктов питания: мясо, молочная продукция, овощи, крупы.",
    ],
    requirementTemplates: [
      { kind: "LICENSE", title: "Декларация соответствия пищевой продукции", description: "Требуется предоставление декларации о соответствии требованиям пищевой безопасности.", requiredValue: null },
      { kind: "EXPERIENCE", title: "Опыт организации питания", description: "Не менее 2 контрактов на организацию питания.", requiredValue: null },
    ],
  },
  transport: {
    markers: ["транспорт", "перевозк", "автобус", "автомобил", "логистик", "грузов"],
    okpd2: ["49.41", "49.39", "52.29", "77.11"],
    subjects: [
      "Пассажирские перевозки по маршрутам",
      "Поставка {item}",
      "Транспортное обслуживание {item}",
      "Грузоперевозки для нужд заказчика",
      "Лизинг {item}",
    ],
    docTexts: [
      "Транспортное обслуживание учреждения. Маршрутные перевозки.",
      "Поставка транспортных средств. Соответствие экологическим классам.",
    ],
    requirementTemplates: [
      { kind: "EXPERIENCE", title: "Опыт транспортных услуг", description: "Не менее 2 исполненных контрактов на транспортное обслуживание.", requiredValue: null },
      { kind: "EQUIPMENT", title: "Наличие подвижного состава", description: "Необходимо наличие или аренда транспортных средств.", requiredValue: null },
    ],
  },
  cleaning: {
    markers: ["уборк", "клининг", "чистк", "мытьё", "хозяйствен"],
    okpd2: ["81.21", "81.22", "81.29"],
    subjects: [
      "Клининговые услуги для {item}",
      "Уборка территорий и помещений",
      "Комплексное обслуживание {item}",
      "Содержание и уборка {item}",
    ],
    docTexts: [
      "Клининговые услуги: ежедневная уборка, генеральная уборка, мойка окон.",
      "Содержание и техническое обслуживание здания.",
    ],
    requirementTemplates: [
      { kind: "EXPERIENCE", title: "Опыт клининговых услуг", description: "Не менее 2 исполненных контрактов на уборку помещений.", requiredValue: null },
      { kind: "EQUIPMENT", title: "Наличие уборочной техники", description: "Необходима профессиональная уборочная техника.", requiredValue: null },
    ],
  },
  education: {
    markers: ["образован", "обучен", "курс", "учеб", "педагог", "квалификац"],
    okpd2: ["85.41", "85.59", "85.60"],
    subjects: [
      "Оказание услуг по повышению квалификации",
      "Организация обучения {item}",
      "Проведение курсов профессиональной переподготовки",
      "Оказание образовательных услуг",
    ],
    docTexts: [
      "Оказание услуг по дополнительному профессиональному образованию.",
      "Проведение курсов повышения квалификации. 72 часа.",
    ],
    requirementTemplates: [
      { kind: "QUALIFIED_PERSONNEL", title: "Квалифицированный персонал", description: "Преподаватели с учёной степенью или стажем не менее 5 лет.", requiredValue: null },
      { kind: "EXPERIENCE", title: "Опыт образовательной деятельности", description: "Не менее 3 контрактов на оказание образовательных услуг.", requiredValue: null },
    ],
  },
  legal: {
    markers: ["юридич", "правов", "консульт", "суд", "адвокат", "нотари"],
    okpd2: ["69.10"],
    subjects: [
      "Оказание юридических услуг",
      "Правовое сопровождение {item}",
      "Представительство в суде",
      "Юридический аудит и консалтинг",
    ],
    docTexts: [
      "Оказание юридической помощи: консультации, составление документов, представительство.",
      "Правовое сопровождение деятельности учреждения.",
    ],
    requirementTemplates: [
      { kind: "QUALIFIED_PERSONNEL", title: "Квалифицированные юристы", description: "Специалисты с высшим юридическим образованием и стажем не менее 5 лет.", requiredValue: null },
      { kind: "EXPERIENCE", title: "Опыт юридических услуг", description: "Не менее 5 исполненных контрактов на оказание юридических услуг.", requiredValue: null },
    ],
  },
};

/** Отрасль по умолчанию, если не удалось определить. */
const DEFAULT_INDUSTRY = "it";

/* ========================= Определение отрасли ========================= */

function detectIndustry(profile: CompanyProfile): IndustryTemplate {
  const cap = profile.capabilities ?? {};
  const text = [
    profile.activityDescription ?? "",
    ...(cap.products ?? []),
    ...(cap.works ?? []),
    ...(cap.services ?? []),
    ...(cap.keywords ?? []),
    ...(cap.okpd2Codes ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let bestMatch: IndustryTemplate = INDUSTRY_TEMPLATES[DEFAULT_INDUSTRY]!;
  let bestScore = 0;

  for (const tmpl of Object.values(INDUSTRY_TEMPLATES)) {
    let score = 0;
    for (const marker of tmpl.markers) {
      if (text.includes(marker.toLowerCase())) {
        score += 1;
      }
    }
    // Проверяем совпадение по ОКПД2
    for (const code of (cap.okpd2Codes ?? [])) {
      if (code && tmpl.okpd2.some((c) => code.startsWith(c) || c.startsWith(code))) {
        score += 3;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = tmpl;
    }
  }

  return bestMatch;
}

/* ========================= Генерация закупок ========================= */

const PLACING_WAYS: PlacingWay[] = [
  "ELECTRONIC_AUCTION",
  "OPEN_CONTEST",
  "REQUEST_FOR_QUOTATION",
  "REQUEST_FOR_PROPOSALS",
];

const CUSTOMER_PREFIXES = [
  "ГБУ",
  "ФГБУ",
  "ГКУ",
  "МКУ",
  "АО",
  "ОАО",
  "ПАО",
  "КУ",
];

const CUSTOMER_SUFFIXES = [
  "Управление капитального строительства",
  "Дирекция капитального строительства",
  "Центр хозяйственного обслуживания",
  "Управление делами",
  "Административный центр",
  "Информационно-аналитический центр",
  "Департамент развития",
  "Центр закупок",
  "Объединённая дирекция",
  "Хозяйственное управление",
];

const REGIONS_ALL = [
  "Москва",
  "Московская область",
  "Санкт-Петербург",
  "Ленинградская область",
  "Новосибирская область",
  "Свердловская область",
  "Республика Татарстан",
  "Краснодарский край",
  "Нижегородская область",
  "Самарская область",
  "Ростовская область",
  "Воронежская область",
];

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length]!;
}

function randRange(min: number, max: number, seed: number): number {
  const s = ((seed * 9301 + 49297) % 233280) / 233280;
  return Math.round(min + s * (max - min));
}

function financialOf(
  price: number,
  advancePercent: number | null,
  contractSecurityPercent: number,
  treasurySupport: boolean,
): TenderFinancialTerms {
  const adv = advancePercent ?? 30;
  return {
    price,
    currency: "RUB",
    advancePercent: adv,
    advanceAmount: adv > 0 ? Math.round((price * adv) / 100) : null,
    paymentTermDays: 15,
    postpaymentDays: null,
    bidSecurityAmount: Math.round(price * 0.01),
    bidSecurityPercent: 1,
    contractSecurityAmount: Math.round((price * contractSecurityPercent) / 100),
    contractSecurityPercent,
    treasurySupport,
    expectedMarginPercent: 20,
  };
}

function documentsOf(
  id: string,
  regNumber: string,
  subject: string,
  customerName: string,
  docText: string,
  okpd2Codes: string[],
  submissionOffset: number,
): TenderDocument[] {
  return [
    {
      id: `${id}-doc-notice`,
      type: "NOTICE",
      title: "Извещение о закупке",
      fileName: "izveshchenie.pdf",
      url: `https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=${regNumber}`,
      text: `${subject}. Заказчик: ${customerName}.`,
      pageCount: 4,
      lastModified: iso(-submissionOffset),
    },
    {
      id: `${id}-doc-tz`,
      type: "TECHNICAL_SPEC",
      title: "Техническое задание",
      fileName: "texzadanie.pdf",
      url: `https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=${regNumber}`,
      text: docText,
      pageCount: 12,
      lastModified: iso(-submissionOffset),
    },
  ];
}

function req(
  id: string,
  kind: TenderRequirement["kind"],
  title: string,
  description: string,
  requiredValue: string | null = null,
): TenderRequirement {
  return { id, kind, title, description, mandatory: true, requiredValue, evidenceId: null };
}

/**
 * Генерирует набор демонстрационных закупок, релевантных профилю компании.
 *
 * Создаёт ~30 закупок с разнообразными сценариями:
 * - ~10 хорошо совпадающих (RECOMMENDED при подходящем профиле)
 * - ~10 с неопределённостями (MANUAL_REVIEW)
 * - ~10 с блокерами (NOT_RECOMMENDED)
 */
export function generateTendersForProfile(profile: CompanyProfile): Tender[] {
  const industry = detectIndustry(profile);
  const r = profile.restrictions ?? {};
  const cap = profile.capabilities ?? {};
  const minPrice = r.minPrice ?? 100_000;
  const maxPrice = r.maxPrice ?? 10_000_000;
  const workRegions = r.workRegions ?? [];
  const profileRegions = workRegions.length > 0 ? workRegions : REGIONS_ALL.slice(0, 3);
  const allRegions = [...new Set([...profileRegions, ...REGIONS_ALL])];
  const keywords = [
    ...(cap.products ?? []),
    ...(cap.keywords ?? []),
  ].filter(Boolean);
  const mainKeyword = keywords[0] ?? "услуг";

  const tenders: Tender[] = [];
  let counter = 0;

  const nextId = (): string => {
    counter += 1;
    return `dyn-${counter}`;
  };

  const nextRegNumber = (): string => {
    counter += 1;
    return `326${String(10000000 + counter * 7).slice(0, 9)}`;
  };

  // --- Генерация 10 хорошо совпадающих закупок ---
  for (let i = 0; i < 10; i++) {
    const id = nextId();
    const regNumber = nextRegNumber();
    const law: TenderLaw = i % 2 === 0 ? "FZ_44" : "FZ_223";
    const placingWay = pick(PLACING_WAYS, i);
    const subjectTemplate = pick(industry.subjects, i);
    const item = pick(keywords, i + 3) ?? mainKeyword;
    const subject = subjectTemplate.replace("{item}", item);
    const customerPrefix = pick(CUSTOMER_PREFIXES, i + 1);
    const customerSuffix = pick(CUSTOMER_SUFFIXES, i + 2);
    const customerName = `${customerPrefix} «${customerSuffix}»`;
    const region = pick(profileRegions, i);
    const price = randRange(minPrice, Math.min(maxPrice, minPrice * 5), i + 100);
    const okpd2 = pick(industry.okpd2, i);
    const docText = pick(industry.docTexts, i);
    const submissionOffset = 10 + i * 2;
    const advancePercent = 20 + (i % 3) * 10;
    const contractSecurityPercent = 3 + (i % 3);

    const financial = financialOf(price, advancePercent, contractSecurityPercent, false);
    const documents = documentsOf(id, regNumber, subject, customerName, docText, [okpd2], submissionOffset);

    tenders.push({
      id,
      regNumber,
      externalId: regNumber,
      law,
      placingWay,
      subject,
      customerName,
      customerInn: null,
      region,
      deliveryAddress: region,
      financial,
      deadlines: {
        submissionEnd: iso(submissionOffset),
        publicationDate: iso(-5),
        lastUpdateDate: iso(-1),
        deliveryTermDays: 30 + i * 5,
        warrantyMonths: 12 + (i % 3) * 12,
      },
      okpd2Codes: [okpd2],
      lots: [],
      requirements: [],
      documents,
      nationalRegime: false,
      onlyForSmp: i === 7,
      eisUrl: buildEisUrl(law, regNumber, placingWay),
      dataSource: "MOCK",
      changeLog: [],
    });
  }

  // --- Генерация 10 закупок с требованиями (частичное совпадение) ---
  for (let i = 0; i < 10; i++) {
    const id = nextId();
    const regNumber = nextRegNumber();
    const law: TenderLaw = i % 2 === 0 ? "FZ_44" : "FZ_223";
    const placingWay = pick(PLACING_WAYS, i + 2);
    const subjectTemplate = pick(industry.subjects, i + 4);
    const item = pick(keywords, i + 7) ?? mainKeyword;
    const subject = subjectTemplate.replace("{item}", item);
    const customerPrefix = pick(CUSTOMER_PREFIXES, i + 5);
    const customerSuffix = pick(CUSTOMER_SUFFIXES, i + 7);
    const customerName = `${customerPrefix} «${customerSuffix}»`;
    const region = pick(allRegions, i + 3);
    const price = randRange(
      Math.max(minPrice, minPrice * 0.5),
      Math.min(maxPrice * 1.5, maxPrice * 2),
      i + 200,
    );
    const okpd2 = pick(industry.okpd2, i + 2);
    const docText = pick(industry.docTexts, i + 2);
    const submissionOffset = 5 + i;
    const contractSecurityPercent = 3 + (i % 4);
    const treasurySupport = i === 3 || i === 8;

    const financial = financialOf(price, i % 4 === 0 ? 0 : 30, contractSecurityPercent, treasurySupport);
    const documents = documentsOf(id, regNumber, subject, customerName, docText, [okpd2], submissionOffset);

    // Требования: берём 1-2 шаблона отрасли
    const reqTemplates = industry.requirementTemplates;
    const requirements: TenderRequirement[] = [];
    if (reqTemplates.length > 0) {
      const rt = reqTemplates[i % reqTemplates.length]!;
      requirements.push(req(`${id}-req-1`, rt.kind, rt.title, rt.description, rt.requiredValue));
    }
    if (reqTemplates.length > 1 && i % 3 === 0) {
      const rt2 = reqTemplates[(i + 1) % reqTemplates.length]!;
      requirements.push(req(`${id}-req-2`, rt2.kind, rt2.title, rt2.description, rt2.requiredValue));
    }

    // Некоторые — с критическим дедлайном
    const actualOffset = i === 9 ? 0 : submissionOffset;
    const submissionHour = i === 9 ? 12 : 10;

    tenders.push({
      id,
      regNumber,
      externalId: regNumber,
      law,
      placingWay,
      subject,
      customerName,
      customerInn: null,
      region,
      deliveryAddress: region,
      financial,
      deadlines: {
        submissionEnd: iso(actualOffset, submissionHour),
        publicationDate: iso(-5),
        lastUpdateDate: iso(-1),
        deliveryTermDays: 14 + i * 10,
        warrantyMonths: 12,
      },
      okpd2Codes: [okpd2],
      lots: [],
      requirements,
      documents,
      nationalRegime: i === 5,
      onlyForSmp: i === 6,
      eisUrl: buildEisUrl(law, regNumber, placingWay),
      dataSource: "MOCK",
      changeLog: i === 2
        ? [{ date: iso(-1).slice(0, 10), description: "Заказчик внёс изменения в техническое задание.", affectedVerdict: true, requiresRecheck: true, critical: true }]
        : [],
    });
  }

  // --- Генерация 10 закупок с блокерами (не рекомендуются) ---
  for (let i = 0; i < 10; i++) {
    const id = nextId();
    const regNumber = nextRegNumber();
    const law: TenderLaw = i % 2 === 0 ? "FZ_44" : "FZ_223";
    const placingWay = pick(PLACING_WAYS, i + 1);
    const subjectTemplate = pick(industry.subjects, i + 6);
    const item = pick(keywords, i + 11) ?? mainKeyword;
    const subject = subjectTemplate.replace("{item}", item);
    const customerPrefix = pick(CUSTOMER_PREFIXES, i + 3);
    const customerSuffix = pick(CUSTOMER_SUFFIXES, i + 9);
    const customerName = `${customerPrefix} «${customerSuffix}»`;

    // Блокеры: цена вне диапазона, регион не тот, или жёсткие требования
    let region: string;
    let price: number;
    const requirements: TenderRequirement[] = [];

    if (i < 3) {
      // Цена вне диапазона
      region = pick(profileRegions, i);
      price = i === 0
        ? Math.round(maxPrice * 3)
        : Math.round(maxPrice * 5);
    } else if (i < 6) {
      // Регион вне профиля
      const nonProfileRegions = REGIONS_ALL.filter((r) => !profileRegions.includes(r));
      region = pick(nonProfileRegions, i);
      price = randRange(minPrice, maxPrice, i + 300);
    } else {
      // Жёсткие требования (лицензия, которой скорее всего нет)
      region = pick(profileRegions, i % profileRegions.length);
      price = randRange(minPrice, maxPrice, i + 400);
      requirements.push(
        req(`${id}-req-lic`, "LICENSE", "Специальная лицензия", "Требуется специальная лицензия на данный вид деятельности.", "спецлицензия"),
      );
    }

    const okpd2 = pick(industry.okpd2, i);
    const docText = pick(industry.docTexts, i % industry.docTexts.length);
    const submissionOffset = 8 + i;
    const contractSecurityPercent = 5;

    const financial = financialOf(price, 30, contractSecurityPercent, i === 4);
    const documents = documentsOf(id, regNumber, subject, customerName, docText, [okpd2], submissionOffset);

    tenders.push({
      id,
      regNumber,
      externalId: regNumber,
      law,
      placingWay,
      subject,
      customerName,
      customerInn: null,
      region,
      deliveryAddress: region,
      financial,
      deadlines: {
        submissionEnd: iso(submissionOffset),
        publicationDate: iso(-5),
        lastUpdateDate: iso(-1),
        deliveryTermDays: 60 + i * 30,
        warrantyMonths: 24,
      },
      okpd2Codes: [okpd2],
      lots: [],
      requirements,
      documents,
      nationalRegime: false,
      onlyForSmp: false,
      eisUrl: buildEisUrl(law, regNumber, placingWay),
      dataSource: "MOCK",
      changeLog: [],
    });
  }

  return tenders;
}
