import type { ScrubStats } from "@/domain/companyFacts/scrubPii";

/**
 * Деловые факты о компании, извлечённые из её документов (прайс, реестр контрактов, выписки СРО, лицензии, кадры, техника).
 *
 * Это не копия документов, а выжимка: ни ФИО, ни контактов, ни реквизитов людей здесь нет и быть не может (скруббер
 * чистит текст до модели, схема отбрасывает личное после неё — `schema.ts`). Хранятся в анкете компании
 * (`CompanyProfile.companyFacts`) и едут тем же путём синхронизации, что и остальная анкета.
 *
 * Свои цены (`prices`) лежат в форме «название, единица, цена, необязательный шифр»: так их можно будет сопоставить со строками
 * сметы (этап 2, «Экономика участия») без повторного разбора документов.
 */

export const FACTS_VERSION = 1;

/** Закон, по которому исполнен контракт. */
export type FactLaw = "44-FZ" | "223-FZ" | "commercial" | "unknown";

/** Тип заказчика контракта: по нему видно, госопыт это или коммерческий. */
export type FactCustomerType = "government" | "municipal" | "state_company" | "commercial" | "unknown";

/** Вид допуска СРО — те же значения, что у `SroKind`, но без зависимости от доменных перечислений. */
export type FactSroKind = "CONSTRUCTION" | "DESIGN" | "SURVEY" | "OTHER";

export interface FactWorkType {
  /** Вид работ («капитальный ремонт кровли», «устройство наружных сетей водоснабжения»). */
  name: string;
  contractsCount: number | null;
  /** Совокупная сумма исполненных работ этого вида, ₽. */
  totalSumRub: number | null;
  /** Годы исполнения, по возрастанию. */
  years: number[];
  /** Самый крупный контракт этого вида, ₽. */
  largestContractRub: number | null;
}

export interface FactContract {
  /** Стабильный номер внутри набора фактов («c1»): по нему модель ссылается на контракт в сверке с закупкой. */
  id: string;
  subject: string;
  /** Вид работ, к которому относится контракт. */
  workType: string | null;
  customerType: FactCustomerType;
  /** Название организации-заказчика; для человека (ИП, гражданин) не хранится. */
  customer: string | null;
  year: number | null;
  sumRub: number | null;
  law: FactLaw;
  region: string | null;
}

export interface FactSro {
  id: string;
  kind: FactSroKind;
  /** Уровень ответственности по компенсационному фонду возмещения вреда; null — не указан. */
  level: number | null;
  /** Предельная стоимость одного договора, ₽; null — не указана или без ограничения. */
  maxContractRub: number | null;
  /** Номер в реестре членов СРО — публичный реестр. */
  number: string | null;
  /** ISO-дата окончания членства; null — не указана. */
  validUntil: string | null;
}

export interface FactLicense {
  id: string;
  kind: string;
  issuer: string | null;
  number: string | null;
  validUntil: string | null;
}

export interface FactEquipment {
  name: string;
  count: number | null;
}

/** Состав кадров по ролям и квалификации — без имён. */
export interface FactStaff {
  role: string;
  count: number;
  qualification: string | null;
}

export type FactPriceKind = "work" | "material" | "other";

export interface FactPrice {
  id: string;
  name: string;
  unit: string;
  priceRub: number;
  /** Шифр позиции (норма, артикул), если есть: для сопоставления со сметой. */
  code: string | null;
  kind: FactPriceKind;
  /** Цена с НДС, без НДС или не сказано. */
  vat: "with" | "without" | "unknown";
}

export interface CompanyFacts {
  version: number;
  /** Когда факты собраны из документов (ISO). */
  extractedAt: string;
  /** Названия документов, из которых собраны факты (для показа человеку). */
  sourceDocuments: string[];
  /** Сколько личного скрыто перед отправкой в модель — по категориям. */
  scrubStats: ScrubStats;
  workTypes: FactWorkType[];
  contracts: FactContract[];
  sro: FactSro[];
  licenses: FactLicense[];
  equipment: FactEquipment[];
  staff: FactStaff[];
  /**
   * Штат целиком, как он назван в документах («Штат: 32 человека»); null — документы общего числа не называют.
   * Это не сумма по ролям: роли перечисляют не всех (у `staff` — только те, что названы), и сумма занижает штат.
   * Поле необязательное: факты, собранные до его появления, читаются как «не названо».
   */
  staffTotal?: number | null;
  prices: FactPrice[];
  /** Регионы, где компания работала. */
  regions: string[];
  notes: string[];
}

/** Категории документов компании. Первые пять были в анкете раньше, остальные — для «документов для анализа». */
export type CompanyDocumentCategory =
  | "license"
  | "sro"
  | "experience"
  | "financial"
  | "other"
  | "price"
  | "staff"
  | "equipment";

export const COMPANY_DOCUMENT_CATEGORY_LABELS: Record<CompanyDocumentCategory, string> = {
  price: "Прайс-лист",
  experience: "Опыт и контракты",
  sro: "СРО",
  license: "Лицензии",
  staff: "Кадры",
  equipment: "Техника",
  financial: "Финансовый документ",
  other: "Прочее",
};

export function emptyFacts(now: Date = new Date()): CompanyFacts {
  return {
    version: FACTS_VERSION,
    extractedAt: now.toISOString(),
    sourceDocuments: [],
    scrubStats: { fio: 0, phone: 0, email: 0, passport: 0, snils: 0, personalInn: 0, birthDate: 0, address: 0 },
    workTypes: [],
    contracts: [],
    sro: [],
    licenses: [],
    equipment: [],
    staff: [],
    staffTotal: null,
    prices: [],
    regions: [],
    notes: [],
  };
}

/** Есть ли в фактах хоть что-то, кроме служебных полей. */
export function factsHaveContent(facts: CompanyFacts | null | undefined): facts is CompanyFacts {
  if (facts === null || facts === undefined) return false;
  return (
    facts.workTypes.length +
      facts.contracts.length +
      facts.sro.length +
      facts.licenses.length +
      facts.equipment.length +
      facts.staff.length +
      (facts.staffTotal ? 1 : 0) +
      facts.prices.length +
      facts.regions.length +
      facts.notes.length >
    0
  );
}
