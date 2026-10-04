import type {
  ChangeLogEntry,
  Tender,
  TenderDocument,
  TenderFinancialTerms,
  TenderRequirement,
} from "@/domain/entities";
import type { PlacingWay, TenderLaw } from "@/domain/enums";
import { buildEisUrl } from "@/domain/enums";

/**
 * Демонстрационная база закупок. Все сведения вымышленные и предназначены
 * только для демонстрации работы сервиса. Не являются реальными данными ЕИС.
 */

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (offsetDays: number, hour = 10): string =>
  new Date(now + offsetDays * DAY).toISOString().slice(0, 11) +
  String(hour).padStart(2, "0") +
  ":00:00.000Z";

interface TenderSeed {
  id: string;
  regNumber: string;
  law: TenderLaw;
  placingWay: PlacingWay;
  subject: string;
  customerName: string;
  customerInn?: string | null;
  region: string;
  deliveryAddress?: string;
  price: number;
  advancePercent?: number | null;
  paymentTermDays?: number;
  postpaymentDays?: number | null;
  bidSecurityAmount?: number | null;
  contractSecurityAmount?: number | null;
  contractSecurityPercent?: number | null;
  treasurySupport?: boolean;
  expectedMarginPercent?: number | null;
  submissionEndOffsetDays?: number;
  submissionEndHour?: number;
  deliveryTermDays?: number | null;
  warrantyMonths?: number | null;
  okpd2Codes: string[];
  nationalRegime?: boolean;
  onlyForSmp?: boolean;
  requirements?: TenderRequirement[];
  /** Дополнительный текст документации (влияет на subject fit и риски). */
  docText?: string;
  changeLog?: ChangeLogEntry[];
  lots?: Tender["lots"];
}

function financialOf(seed: TenderSeed): TenderFinancialTerms {
  const price = seed.price;
  const advancePercent =
    seed.advancePercent === undefined ? 30 : seed.advancePercent;
  const contractSecurityPercent =
    seed.contractSecurityPercent === undefined
      ? seed.contractSecurityAmount !== undefined && seed.contractSecurityAmount !== null
        ? Math.round((seed.contractSecurityAmount / price) * 100)
        : 5
      : seed.contractSecurityPercent;
  const contractSecurityAmount =
    seed.contractSecurityAmount === undefined
      ? Math.round((price * (contractSecurityPercent ?? 5)) / 100)
      : seed.contractSecurityAmount;
  return {
    price,
    currency: "RUB",
    advancePercent,
    advanceAmount:
      advancePercent && advancePercent > 0
        ? Math.round((price * advancePercent) / 100)
        : null,
    paymentTermDays: seed.paymentTermDays ?? 15,
    postpaymentDays: seed.postpaymentDays ?? null,
    bidSecurityAmount:
      seed.bidSecurityAmount === undefined
        ? Math.round(price * 0.01)
        : seed.bidSecurityAmount,
    bidSecurityPercent: 1,
    contractSecurityAmount,
    contractSecurityPercent,
    treasurySupport: seed.treasurySupport ?? false,
    expectedMarginPercent:
      seed.expectedMarginPercent === undefined ? 20 : seed.expectedMarginPercent,
  };
}

function documentsOf(seed: TenderSeed): TenderDocument[] {
  const docs: TenderDocument[] = [];
  docs.push({
    id: `${seed.id}-doc-notice`,
    type: "NOTICE",
    title: "Извещение о закупке",
    fileName: "izveshchenie.pdf",
    url: `https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=${seed.regNumber}`,
    text: `${seed.subject}. Заказчик: ${seed.customerName}.`,
    pageCount: 4,
    lastModified: iso(-(seed.submissionEndOffsetDays ?? 10) * -1),
  });
  const tzText =
    seed.docText ??
    `Техническое задание: ${seed.subject}. Требуется поставка товара, соответствующего ОКПД2 ${seed.okpd2Codes.join(", ")}.`;
  docs.push({
    id: `${seed.id}-doc-tz`,
    type: "TECHNICAL_SPEC",
    title: "Техническое задание",
    fileName: "texzadanie.pdf",
    url: `https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=${seed.regNumber}`,
    text: tzText,
    pageCount: 12,
    lastModified: iso(-(seed.submissionEndOffsetDays ?? 10) * -1),
  });
  return docs;
}

/**
 * Вымышленный ИНН заказчика для демо-данных: детерминированно строится из id
 * закупки («t-07» → «0000000007»). Ведущие нули исключают совпадение с реальным
 * реквизитом организации — значение нужно только для демонстрации фильтрации
 * по ИНН; в реальных данных ИНН приходит из ЕИС.
 */
function demoCustomerInn(tenderId: string): string {
  const digits = tenderId.replace(/\D/g, "");
  return String(Number(digits || "0")).padStart(10, "0");
}

function buildTender(seed: TenderSeed): Tender {
  const offset = seed.submissionEndOffsetDays ?? 10;
  return {
    id: seed.id,
    regNumber: seed.regNumber,
    externalId: seed.regNumber,
    law: seed.law,
    placingWay: seed.placingWay,
    subject: seed.subject,
    customerName: seed.customerName,
    customerInn: seed.customerInn ?? demoCustomerInn(seed.id),
    region: seed.region,
    deliveryAddress: seed.deliveryAddress ?? seed.region,
    financial: financialOf(seed),
    deadlines: {
      submissionEnd: iso(offset, seed.submissionEndHour ?? 10),
      publicationDate: iso(-5),
      lastUpdateDate: iso(-1),
      deliveryTermDays:
        seed.deliveryTermDays === undefined ? 30 : seed.deliveryTermDays,
      warrantyMonths: seed.warrantyMonths === undefined ? 12 : seed.warrantyMonths,
    },
    okpd2Codes: seed.okpd2Codes,
    lots: seed.lots ?? [],
    requirements: seed.requirements ?? [],
    documents: documentsOf(seed),
    nationalRegime: seed.nationalRegime ?? false,
    onlyForSmp: seed.onlyForSmp ?? false,
    eisUrl: buildEisUrl(seed.law, seed.regNumber, seed.placingWay),
    dataSource: "MOCK",
    changeLog: seed.changeLog ?? [],
  };
}

const req = (
  id: string,
  kind: TenderRequirement["kind"],
  title: string,
  description: string,
  requiredValue: string | null = null,
): TenderRequirement => ({
  id,
  kind,
  title,
  description,
  mandatory: true,
  requiredValue,
  evidenceId: null,
});

/* ============================== 35 закупок ============================== */

const seeds: TenderSeed[] = [
  // 1. Полное совпадение с профилем → RECOMMENDED
  {
    id: "t-01",
    regNumber: "0322200005226000001",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка компьютеров (системных блоков) для нужд учреждения",
    customerName: "ГБУ «Московский центр информационных технологий»",
    region: "Москва",
    price: 2_800_000,
    okpd2Codes: ["26.20.11"],
    nationalRegime: false,
    docText:
      "Техническое задание: поставка компьютеров, системных блоков, мониторов. Требуются персональные компьютеры (ПК, ЭВМ) в количестве 40 штук.",
  },
  // 2. Требуется лицензия, которой нет → NOT_RECOMMENDED
  {
    id: "t-02",
    regNumber: "0322200005226000002",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка компьютеров для медицинского учреждения",
    customerName: "ГБУЗ «Городская клиническая больница»",
    region: "Москва",
    price: 1_500_000,
    okpd2Codes: ["26.20.11"],
    requirements: [
      req(
        "t02-lic",
        "LICENSE",
        "Лицензия на медицинскую деятельность",
        "Требуется лицензия на медицинскую деятельность для поставки оборудования в медучреждение.",
        "медицинск",
      ),
    ],
    docText: "Поставка компьютеров. Наличие лицензии на медицинскую деятельность обязательно.",
  },
  // 3. Нужная лицензия имеется → RECOMMENDED
  {
    id: "t-03",
    regNumber: "0322200005226000003",
    law: "FZ_44",
    placingWay: "OPEN_CONTEST",
    subject:
      "Техническое обслуживание оргтехники на объекте с системой пожарной безопасности",
    customerName: "ФГБУ «Управление эксплуатации зданий»",
    region: "Москва",
    price: 1_200_000,
    okpd2Codes: ["26.20", "28.23"],
    requirements: [
      req(
        "t03-lic",
        "LICENSE",
        "Лицензия МЧС",
        "Требуется лицензия МЧС на монтаж и обслуживание средств пожарной безопасности.",
        "мчс",
      ),
    ],
    docText:
      "Техническое задание: техническое обслуживание оргтехники, принтеров и МФУ. Требуется лицензия МЧС на обслуживание средств пожарной безопасности.",
  },
  // 4. Требуется СРО (у компании нет) → NOT_RECOMMENDED
  {
    id: "t-04",
    regNumber: "0322200005226000004",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Монтаж локальных вычислительных сетей и поставка серверного оборудования",
    customerName: "ГБУ «Московский информационный центр»",
    region: "Москва",
    price: 3_500_000,
    okpd2Codes: ["26.20.15"],
    requirements: [
      req(
        "t04-sro",
        "SRO",
        "Членство в СРО",
        "Требуется членство в СРО в области строительства и монтажных работ.",
        "строитель",
      ),
    ],
    docText: "Монтаж ЛВС, поставка серверов. Требуется членство в СРО.",
  },
  // 5. Не подтвержден необходимый опыт → MANUAL_REVIEW
  {
    id: "t-05",
    regNumber: "0322200005226000005",
    law: "FZ_223",
    placingWay: "OPEN_CONTEST",
    subject: "Поставка серверов и систем хранения данных",
    customerName: "АО «Государственная транспортная компания»",
    region: "Москва",
    price: 4_500_000,
    okpd2Codes: ["26.20.15"],
    requirements: [
      req(
        "t05-exp",
        "EXPERIENCE",
        "Опыт исполнения аналогичных контрактов",
        "Требуется подтверждённый опыт поставки серверного оборудования по контрактам от 3 млн ₽ за последние 3 года.",
        null,
      ),
    ],
    docText: "Поставка серверов, систем хранения данных. Требуется опыт исполнения аналогичных контрактов.",
  },
  // 6. НМЦК выше лимита компании → NOT_RECOMMENDED
  {
    id: "t-06",
    regNumber: "0322200005226000006",
    law: "FZ_223",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка вычислительного оборудования для дата-центра",
    customerName: "АО «Национальный оператор связи»",
    region: "Москва",
    price: 42_000_000,
    okpd2Codes: ["26.20.15"],
    docText: "Поставка серверов и компьютерного оборудования для крупного дата-центра.",
  },
  // 7. Регион не входит в географию → NOT_RECOMMENDED
  {
    id: "t-07",
    regNumber: "0322200005226000007",
    law: "FZ_44",
    placingWay: "REQUEST_FOR_QUOTATION",
    subject: "Поставка ноутбуков для администрации",
    customerName: "КГБУ «Администрация Приморского края»",
    region: "Приморский край",
    deliveryAddress: "г. Владивосток",
    price: 900_000,
    okpd2Codes: ["26.20.11"],
    docText: "Поставка ноутбуков, мобильных компьютеров.",
  },
  // 8. Слишком короткий срок поставки → MANUAL_REVIEW
  {
    id: "t-08",
    regNumber: "0322200005226000008",
    law: "FZ_44",
    placingWay: "REQUEST_FOR_QUOTATION",
    subject: "Срочная поставка принтеров и МФУ",
    customerName: "ГКУ «Московский административный центр»",
    region: "Москва",
    price: 650_000,
    deliveryTermDays: 5,
    okpd2Codes: ["28.23"],
    docText: "Поставка принтеров и МФУ в срок 5 рабочих дней.",
  },
  // 9. Высокое обеспечение контракта → MANUAL_REVIEW
  {
    id: "t-09",
    regNumber: "0322200005226000009",
    law: "FZ_223",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка компьютерной техники и мониторов",
    customerName: "АО «Единый расчётный центр»",
    region: "Москва",
    price: 3_000_000,
    contractSecurityAmount: 900_000,
    contractSecurityPercent: 30,
    okpd2Codes: ["26.20.11"],
    docText: "Поставка компьютеров и мониторов. Обеспечение исполнения контракта 30%.",
  },
  // 10. Отсутствует аванс + длительная постоплата → MANUAL_REVIEW
  {
    id: "t-10",
    regNumber: "0322200005226000010",
    law: "FZ_223",
    placingWay: "OPEN_CONTEST",
    subject: "Поставка оргтехники с оплатой по факту приёмки",
    customerName: "АО «Региональный торговый дом»",
    region: "Московская область",
    price: 1_800_000,
    advancePercent: 0,
    postpaymentDays: 75,
    paymentTermDays: 75,
    okpd2Codes: ["28.23"],
    docText: "Поставка оргтехники. Аванс не предусмотрен, оплата через 75 дней после приёмки.",
  },
  // 11. Длительная постоплата → MANUAL_REVIEW
  {
    id: "t-11",
    regNumber: "0322200005226000011",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка системных блоков с отсрочкой платежа",
    customerName: "ГБУ «Московский образовательный центр»",
    region: "Москва",
    price: 2_200_000,
    paymentTermDays: 90,
    postpaymentDays: 90,
    okpd2Codes: ["26.20.11"],
    docText: "Поставка системных блоков (ПК). Оплата с отсрочкой 90 дней.",
  },
  // 12. Опасные условия приёмки → MANUAL_REVIEW / риск
  {
    id: "t-12",
    regNumber: "0322200005226000012",
    law: "FZ_223",
    placingWay: "OPEN_CONTEST",
    subject: "Поставка серверов с особым порядком приёмки",
    customerName: "АО «Промышленный холдинг»",
    region: "Москва",
    price: 4_000_000,
    okpd2Codes: ["26.20.15"],
    docText:
      "Проект договора: приёмка осуществляется в одностороннем порядке, заказчик вправе удерживать оплату при выявлении замечаний. Предусмотрена независимая экспертиза.",
  },
  // 13. Высокие штрафные риски → MANUAL_REVIEW
  {
    id: "t-13",
    regNumber: "0322200005226000013",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка ноутбуков с повышенными штрафными санкциями",
    customerName: "ГБУ «Московский культурный центр»",
    region: "Москва",
    price: 1_600_000,
    okpd2Codes: ["26.20.11"],
    docText:
      "Проект контракта: неустойка за просрочку поставки установлена в размере 0,5% от цены контракта за каждый день (повышенная неустойка). Право заказчика на односторонний отказ от исполнения контракта.",
  },
  // 14. Изменение документации → MANUAL_REVIEW
  {
    id: "t-14",
    regNumber: "0322200005226000014",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка МФУ (изменение технического задания)",
    customerName: "ГКУ «Московский центр госуслуг»",
    region: "Москва",
    price: 1_400_000,
    okpd2Codes: ["28.23"],
    changeLog: [
      {
        date: iso(-1).slice(0, 10),
        description:
          "Заказчик изменил техническое задание: добавлены требования к скорости печати и объёму картриджа.",
        documentId: "doc-t-14-tz",
        affectedVerdict: true,
        requiresRecheck: true,
        critical: true,
      },
    ],
    docText: "Поставка МФУ и принтеров. Техническое задание изменено.",
  },
  // 15. Срок подачи заканчивается менее чем через 24 часа → MANUAL_REVIEW
  {
    id: "t-15",
    regNumber: "0322200005226000015",
    law: "FZ_44",
    placingWay: "REQUEST_FOR_QUOTATION",
    subject: "Поставка мониторов (срочно)",
    customerName: "ГБУ «Московский аналитический центр»",
    region: "Москва",
    price: 480_000,
    submissionEndOffsetDays: 0,
    submissionEndHour: 12,
    okpd2Codes: ["26.20.11"],
    docText: "Поставка мониторов для компьютеров. Срок подачи заявок истекает в течение суток.",
  },
  // 16. Название нерелевантно, но предмет найден в документации → RECOMMENDED
  {
    id: "t-16",
    regNumber: "0322200005226000016",
    law: "FZ_223",
    placingWay: "REQUEST_FOR_PROPOSALS",
    subject: "Оказание услуг по комплексному оснащению рабочих мест",
    customerName: "АО «Московский деловой центр»",
    region: "Москва",
    price: 2_600_000,
    okpd2Codes: ["26.20"],
    docText:
      "Техническое задание: оснащение рабочих мест включает поставку компьютеров, системных блоков, ноутбуков, принтеров и мониторов, а также техническое обслуживание оргтехники.",
  },
  // 17. Ключевое слово совпадает, но реальный предмет не подходит → NOT_RECOMMENDED
  {
    id: "t-17",
    regNumber: "0322200005226000017",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Ремонт компьютерного класса (строительно-монтажные работы)",
    customerName: "ГБУ «Московский колледж»",
    region: "Москва",
    price: 2_000_000,
    okpd2Codes: ["43.99"],
    docText:
      "Ремонт помещений компьютерного класса: строительно-монтажные работы, отделка, замена напольного покрытия. Аренда строительных лесов.",
  },
  // 18. 223-ФЗ с нестандартными требованиями → MANUAL_REVIEW
  {
    id: "t-18",
    regNumber: "32616376540",
    law: "FZ_223",
    placingWay: "OTHER",
    subject: "Поставка оргтехники с требованием обязательного персонала",
    customerName: 'ООО «Интеллектуальные коммунальные системы»',
    region: "Москва",
    price: 1_100_000,
    okpd2Codes: ["28.23"],
    requirements: [
      req(
        "t18-staff",
        "QUALIFIED_PERSONNEL",
        "Квалифицированный персонал",
        "Требуется наличие в штате не менее 3 сертифицированных инженеров по обслуживанию оргтехники.",
        null,
      ),
      req(
        "t18-char",
        "PRODUCT_CHARACTERISTIC",
        "Обязательные характеристики товара",
        "Печатающее устройство: скорость печати не менее 40 стр/мин, двусторонняя печать, ресурс картриджа не менее 10000 страниц.",
        null,
      ),
    ],
    docText:
      "Поставка принтеров и МФУ. Требуются конкретные характеристики товара и квалифицированный персонал в штате.",
  },
  // 19. Требуются конкретные характеристики товара → MANUAL_REVIEW
  {
    id: "t-19",
    regNumber: "0322200005226000019",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка ноутбуков с определёнными характеристиками",
    customerName: "ГБУ «Московский научный центр»",
    region: "Москва",
    price: 2_400_000,
    nationalRegime: true,
    okpd2Codes: ["26.20.11"],
    requirements: [
      req(
        "t19-char",
        "PRODUCT_CHARACTERISTIC",
        "Характеристики ноутбука",
        "Процессор не менее 8 ядер, ОЗУ не менее 32 ГБ, SSD не менее 1 ТБ, дискретная видеокарта.",
        null,
      ),
    ],
    docText:
      "Поставка ноутбуков (мобильных компьютеров) с конкретными техническими характеристиками. Национальный режим: требуется подтверждение страны происхождения.",
  },
  // 20. Несколько лотов с разным соответствием → RECOMMENDED
  {
    id: "t-20",
    regNumber: "0322200005226000020",
    law: "FZ_44",
    placingWay: "OPEN_CONTEST",
    subject: "Поставка компьютерной техники (2 лота)",
    customerName: "ГБУ «Московский центр образования»",
    region: "Москва",
    price: 3_200_000,
    okpd2Codes: ["26.20.11", "28.23"],
    lots: [
      {
        id: "t20-lot1",
        number: 1,
        subject: "Поставка системных блоков и мониторов",
        price: 2_200_000,
        okpd2Codes: ["26.20.11"],
        deliveryRegion: "Москва",
        deliveryAddress: "Москва",
        deliveryTermDays: 30,
      },
      {
        id: "t20-lot2",
        number: 2,
        subject: "Поставка принтеров и МФУ",
        price: 1_000_000,
        okpd2Codes: ["28.23"],
        deliveryRegion: "Москва",
        deliveryAddress: "Москва",
        deliveryTermDays: 30,
      },
    ],
    docText:
      "Поставка компьютеров, системных блоков, мониторов, принтеров и МФУ двумя лотами.",
  },
  // 21. Ещё одно чистое совпадение → RECOMMENDED
  {
    id: "t-21",
    regNumber: "0322200005226000021",
    law: "FZ_44",
    placingWay: "REQUEST_FOR_QUOTATION",
    subject: "Поставка принтеров для учреждения",
    customerName: "ГКУ «Московский архив»",
    region: "Москва",
    price: 350_000,
    okpd2Codes: ["28.23"],
    docText: "Поставка принтеров и печатающих устройств.",
  },
  // 22. Совпадение по 223-ФЗ → RECOMMENDED
  {
    id: "t-22",
    regNumber: "32616373878",
    law: "FZ_223",
    placingWay: "REQUEST_FOR_QUOTATION",
    subject: "Поставка МФУ и расходных материалов",
    customerName: "АО «Московская городская служба»",
    region: "Москва",
    price: 720_000,
    onlyForSmp: true,
    okpd2Codes: ["28.23"],
    docText: "Поставка МФУ, принтеров и расходных материалов для оргтехники.",
  },
  // 23. Заказчик в чёрном списке → NOT_RECOMMENDED
  {
    id: "t-23",
    regNumber: "0322200005226000023",
    law: "FZ_223",
    placingWay: "OPEN_CONTEST",
    subject: "Поставка серверного оборудования",
    customerName: "ООО «Конфликтный заказчик»",
    region: "Москва",
    price: 2_900_000,
    okpd2Codes: ["26.20.15"],
    docText: "Поставка серверов и компьютерного оборудования.",
  },
  // 24. Казначейское сопровождение + регион вне географии → NOT_RECOMMENDED
  {
    id: "t-24",
    regNumber: "0322200005226000024",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка компьютеров с казначейским сопровождением",
    customerName: "ФГБУ «Сибирское управление»",
    region: "Новосибирская область",
    deliveryAddress: "г. Новосибирск",
    price: 3_100_000,
    treasurySupport: true,
    okpd2Codes: ["26.20.11"],
    docText:
      "Поставка компьютеров. Расчёты с казначейским сопровождением на отдельном счёте.",
  },
  // 25. Требуется лицензия ФСБ, которой нет → NOT_RECOMMENDED
  {
    id: "t-25",
    regNumber: "32616380001",
    law: "FZ_223",
    placingWay: "OPEN_CONTEST",
    subject: "Поставка серверов со средствами криптографической защиты",
    customerName: "АО «Защищённые информационные системы»",
    region: "Москва",
    price: 3_800_000,
    okpd2Codes: ["26.20.15"],
    requirements: [
      req(
        "t25-lic",
        "LICENSE",
        "Лицензия ФСБ на работу с криптографией",
        "Требуется лицензия ФСБ России на деятельность по разработке и производству средств защиты конфиденциальной информации.",
        "фсб",
      ),
    ],
    docText:
      "Поставка серверов с СКЗИ. Обязательна лицензия ФСБ на криптографическую деятельность.",
  },
  // 26. Регион вне географии (Екатеринбург) → NOT_RECOMMENDED
  {
    id: "t-26",
    regNumber: "32616380002",
    law: "FZ_223",
    placingWay: "REQUEST_FOR_QUOTATION",
    subject: "Поставка ноутбуков для филиала",
    customerName: "АО «Уральский производственный холдинг»",
    region: "Свердловская область",
    deliveryAddress: "г. Екатеринбург",
    price: 1_300_000,
    okpd2Codes: ["26.20.11"],
    docText: "Поставка ноутбуков (мобильных компьютеров) в филиал в Екатеринбурге.",
  },
  // 27. НМЦК выше лимита компании → NOT_RECOMMENDED
  {
    id: "t-27",
    regNumber: "0322200005226000027",
    law: "FZ_44",
    placingWay: "OPEN_CONTEST",
    subject: "Поставка крупной партии компьютерной техники",
    customerName: "ГБУ «Московский департамент информатизации»",
    region: "Москва",
    price: 8_500_000,
    okpd2Codes: ["26.20.11"],
    docText: "Поставка компьютеров, системных блоков и мониторов крупным объёмом.",
  },

  // ========================= Строительные закупки =========================
  // Закупки для профиля «Строительство / ООО» с диапазоном НМЦК ~50–150 млн ₽.
  // Все сведения вымышленные и предназначены только для демонстрации.

  // 28. Строительство школы — полное совпадение со строительным профилем
  {
    id: "t-28",
    regNumber: "0322200005226000028",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Строительство здания средней школы на 550 мест",
    customerName: "ГКУ «Дирекция капитального строительства»",
    region: "Москва",
    price: 120_000_000,
    okpd2Codes: ["41.20.10"],
    deliveryTermDays: 365,
    warrantyMonths: 60,
    contractSecurityPercent: 3,
    requirements: [
      req(
        "t28-sro",
        "SRO",
        "Членство в СРО строителей",
        "Требуется действующая выписка из реестра членов саморегулируемой организации в области строительства.",
        "строительство",
      ),
      req(
        "t28-exp",
        "EXPERIENCE",
        "Опыт строительства социальных объектов",
        "Не менее 2 исполненных контрактов на строительство объектов социально-культурного назначения за последние 3 года.",
        null,
      ),
    ],
    docText:
      "Строительство здания средней школы. Генеральный подряд. Требуется членство в СРО, опыт исполнения аналогичных контрактов. Гарантийный срок 60 месяцев.",
  },
  // 29. Капитальный ремонт — RECOMMENDED при строительном профиле
  {
    id: "t-29",
    regNumber: "0322200005226000029",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Капитальный ремонт административного здания",
    customerName: "ФГБУ «Управление хозяйственного обслуживания»",
    region: "Москва",
    price: 85_000_000,
    okpd2Codes: ["43.11", "43.99"],
    deliveryTermDays: 270,
    warrantyMonths: 36,
    requirements: [
      req(
        "t29-sro",
        "SRO",
        "Членство в СРО",
        "Требуется членство в СРО в области строительства, реконструкции, капитального ремонта.",
        "капитальный ремонт",
      ),
    ],
    docText:
      "Капитальный ремонт административного здания площадью 4 200 кв. м. Включает демонтажные, общестроительные, отделочные работы и замену инженерных систем.",
  },
  // 30. Строительство дороги — высокая НМЦК, СРО + опыт
  {
    id: "t-30",
    regNumber: "0322200005226000030",
    law: "FZ_44",
    placingWay: "OPEN_CONTEST",
    subject: "Строительство автомобильной дороги регионального значения",
    customerName: "ГКУ «Дирекция дорожного хозяйства»",
    region: "Московская область",
    price: 150_000_000,
    okpd2Codes: ["42.11.20"],
    deliveryTermDays: 540,
    warrantyMonths: 48,
    contractSecurityPercent: 5,
    requirements: [
      req(
        "t30-sro",
        "SRO",
        "Членство в СРО дорожных строителей",
        "Требуется членство в СРО в области строительства автомобильных дорог.",
        "дорог",
      ),
      req(
        "t30-exp",
        "EXPERIENCE",
        "Опыт дорожного строительства",
        "Не менее 3 исполненных контрактов на строительство автомобильных дорог за последние 5 лет с общей стоимостью не менее 300 млн ₽.",
        null,
      ),
    ],
    docText:
      "Строительство участка автомобильной дороги протяжённостью 12 км. Земляные работы, устройство основания, асфальтобетонного покрытия, водоотведение, дорожные знаки и разметка.",
  },
  // 31. Монтаж инженерных систем — 223-ФЗ, средний размер
  {
    id: "t-31",
    regNumber: "32616380003",
    law: "FZ_223",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Монтаж систем отопления, вентиляции и кондиционирования",
    customerName: "АО «Крупный девелопер»",
    region: "Москва",
    price: 95_000_000,
    okpd2Codes: ["43.21", "43.22"],
    deliveryTermDays: 180,
    warrantyMonths: 24,
    requirements: [
      req(
        "t31-sro",
        "SRO",
        "Членство в СРО",
        "Требуется членство в СРО в области монтажа инженерных систем.",
        "вентиляц",
      ),
    ],
    docText:
      "Монтаж систем отопления, вентиляции и кондиционирования воздуха в бизнес-центре класса А. Площадь объекта 28 000 кв. м.",
  },
  // 32. Реконструкция здания — казначейское сопровождение (риск)
  {
    id: "t-32",
    regNumber: "0322200005226000032",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Реконструкция здания под офис государственных услуг",
    customerName: "ФГБУ «Федеральный центр госуслуг»",
    region: "Санкт-Петербург",
    price: 110_000_000,
    okpd2Codes: ["41.20.10", "43.11"],
    deliveryTermDays: 300,
    warrantyMonths: 36,
    treasurySupport: true,
    contractSecurityPercent: 5,
    requirements: [
      req(
        "t32-sro",
        "SRO",
        "Членство в СРО строителей",
        "Требуется действующая выписка из реестра членов СРО.",
        "реконструкция",
      ),
    ],
    docText:
      "Реконструкция трёхэтажного здания под многофункциональный центр. Казначейское сопровождение расчётов. Гарантийный срок 36 месяцев.",
  },
  // 33. Строительство водопровода — 223-ФЗ, регионы
  {
    id: "t-33",
    regNumber: "32616380004",
    law: "FZ_223",
    placingWay: "OPEN_CONTEST",
    subject: "Строительство водопроводных сетей и насосной станции",
    customerName: "АО «Водоканал»",
    region: "Новосибирская область",
    price: 75_000_000,
    okpd2Codes: ["42.21", "42.21.10"],
    deliveryTermDays: 240,
    warrantyMonths: 36,
    requirements: [
      req(
        "t33-sro",
        "SRO",
        "Членство в СРО",
        "Требуется членство в СРО в области строительства гидротехнических сооружений.",
        "водопровод",
      ),
      req(
        "t33-equip",
        "EQUIPMENT",
        "Наличие буровой техники",
        "Необходимо наличие или аренда буровой установки для прокладки трубопроводов бестраншейным методом.",
        null,
      ),
    ],
    docText:
      "Строительство водопроводных сетей протяжённостью 8 км и блочной насосной станции. Бестраншейная прокладка методом ГНБ.",
  },
  // 34. Отделочные работы — 223-ФЗ, нет СРО (риск)
  {
    id: "t-34",
    regNumber: "32616380005",
    law: "FZ_223",
    placingWay: "REQUEST_FOR_PROPOSALS",
    subject: "Отделочные работы в новостройке (жилые помещения)",
    customerName: "АО «Девелопер-Групп»",
    region: "Москва",
    price: 55_000_000,
    okpd2Codes: ["43.30", "43.33"],
    deliveryTermDays: 150,
    warrantyMonths: 24,
    advancePercent: 20,
    postpaymentDays: 45,
    requirements: [
      req(
        "t34-exp",
        "EXPERIENCE",
        "Опыт отделочных работ",
        "Не менее 5 исполненных контрактов на внутренние отделочные работы в многоквартирных домах.",
        null,
      ),
    ],
    docText:
      "Чистовая и черновая отделка 120 квартир в новостройке. Штукатурные, малярные работы, укладка напольных покрытий, установка дверей.",
  },
  // 35. Строительство детского сада — высокая цена, СРО + лицензия
  {
    id: "t-35",
    regNumber: "0322200005226000035",
    law: "FZ_44",
    placingWay: "OPEN_CONTEST",
    subject: "Строительство здания детского сада на 220 мест",
    customerName: "КУ «Управление капитального строительства»",
    region: "Московская область",
    price: 130_000_000,
    okpd2Codes: ["41.20.10"],
    deliveryTermDays: 400,
    warrantyMonths: 60,
    contractSecurityPercent: 5,
    requirements: [
      req(
        "t35-sro",
        "SRO",
        "Членство в СРО строителей",
        "Требуется выписка из реестра членов СРО.",
        "строительство",
      ),
      req(
        "t35-lic",
        "LICENSE",
        "Лицензия МЧС на монтаж пожарной сигнализации",
        "Требуется лицензия МЧС на монтаж, техническое обслуживание и ремонт средств обеспечения пожарной безопасности.",
        "пожарн",
      ),
    ],
    docText:
      "Строительство детского сада. Генеральный подряд. Включает монтаж пожарной сигнализации (требуется лицензия МЧС). Гарантийный срок 60 месяцев.",
  },
];

export const demoTenders: Tender[] = seeds.map(buildTender);
