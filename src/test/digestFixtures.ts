import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import type { CompanyProfile, SearchProfile } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { dbRowToTender } from "@/services/tenderApiService";
import type { TenderRow as TenderRowDB } from "@/types/database";

/** Общие данные для тестов сводки и рассылки: «сейчас», подрядчик из Бурятии, его профиль поиска, строки закупок. */

export const NOW = Date.parse("2026-10-16T01:00:00Z");
export const H = 3_600_000;
export const DAY = 24 * H;

const iso = (ms: number): string => new Date(ms).toISOString();

/** Подрядчик: строительство и ремонт в Бурятии. */
export const contractor: CompanyProfile = {
  ...demoCompanyProfile,
  legalName: "ООО «Тестовый подрядчик»",
  activityDescription: "Строительство и капитальный ремонт зданий и сооружений, благоустройство территорий.",
  capabilities: {
    ...demoCompanyProfile.capabilities,
    products: [],
    works: ["строительно-монтажные работы", "капитальный ремонт", "благоустройство"],
    services: [],
    keywords: ["строительство", "ремонт", "капитальный ремонт"],
    synonyms: [],
    stopWords: [],
    okpd2Codes: ["41.20", "43.99"],
  },
  restrictions: {
    ...demoCompanyProfile.restrictions,
    minPrice: 10_000,
    maxPrice: 50_000_000_000,
    workRegions: ["Республика Бурятия"],
    customerBlacklist: [],
    custom: [],
  },
  preferences: {
    ...demoCompanyProfile.preferences,
    priorityRegions: ["Республика Бурятия"],
    preferredMinPrice: 10_000,
    preferredMaxPrice: 50_000_000_000,
    notes: [],
  },
  licenses: [],
};

export const stroyka: SearchProfile = {
  id: "sp-1",
  name: "Строительство",
  laws: [],
  keywords: ["Строительство", "Капитальный ремонт"],
  stopWords: [],
  okpd2Codes: [],
  regions: ["Республика Бурятия"],
  customerInns: [],
  minPrice: null,
  maxPrice: null,
  onlyOpenForSubmission: false,
  enabled: true,
};

/** Строка таблицы закупок, как её отдаёт база; по умолчанию — подходящая подрядчику закупка в Бурятии. */
export function dbRow(regNumber: string, over: Partial<TenderRowDB> = {}): TenderRowDB {
  return {
    id: `id-${regNumber}`,
    reg_number: regNumber,
    external_id: null,
    law: "FZ_44",
    placing_way: "ELECTRONIC_AUCTION",
    subject: `Строительство объекта ${regNumber}`,
    customer_name: "Администрация района",
    customer_inn: "0300000000",
    region: "Республика Бурятия",
    delivery_address: null,
    price: 5_000_000,
    currency: "RUB",
    advance_payment: null,
    security_bid: null,
    security_contract: null,
    submission_end: iso(NOW + 10 * DAY),
    publication_date: iso(NOW - 2 * H),
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
    raw_data: null,
    synced_at: null,
    created_at: iso(NOW - 2 * H),
    updated_at: iso(NOW - 2 * H),
    ...over,
  };
}

/** Строка ленты из строки базы: закупка, оценка по анкете и статус воронки. */
export function toRow(db: TenderRowDB, profile: CompanyProfile = contractor, status: TenderRow["pipelineStatus"] = "NEW"): TenderRow {
  const tender = dbRowToTender(db);
  return { tender, analysis: analyzeTender(tender, profile, new Date(NOW)), pipelineStatus: status };
}
