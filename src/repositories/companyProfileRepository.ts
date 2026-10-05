import type { CompanyProfile, SroMembership } from "@/domain/entities";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { NO_AMOUNT_LIMIT, NO_DAYS_LIMIT, emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import { inferSroKind } from "@/domain/scoring/admission";

/**
 * Репозиторий профиля компании. Демонстрационный профиль служит значением
 * по умолчанию; правки пользователя сохраняются в localStorage.
 * В будущей интеграции заменяется на Supabase/PostgreSQL.
 */

/** Сохранённый профиль может относиться к любой предыдущей версии схемы. */
type SavedProfile = Record<string, unknown>;

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function toPositiveIntOrNull(value: unknown): number | null {
  const n = toNumberOrNull(value);
  if (n === null || n <= 0) return null;
  return Math.round(n);
}

/** Объект из сохранённых данных: всё, что не объект, заменяется пустым. */
function asObject<T>(value: unknown): Partial<T> {
  return typeof value === "object" && value !== null ? (value as Partial<T>) : {};
}

/** Массив из сохранённых данных: всё, что не массив, заменяется запасным. */
function asArray<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

/**
 * Приводит запись о членстве в СРО к текущей схеме.
 * Профили, сохранённые до появления вида работ и уровня ответственности,
 * содержат только `type` и `number`: вид определяется по наименованию,
 * уровень и лимит остаются незаполненными (их внесёт пользователь).
 */
function normalizeSroMembership(value: unknown, index: number): SroMembership {
  const raw = asObject<Record<string, unknown>>(value);
  const type = toStringOr(raw.type, "");
  const kind = toStringOr(raw.kind, "");
  return {
    id: toStringOr(raw.id, `sro-${index}`),
    kind:
      kind === "CONSTRUCTION" || kind === "DESIGN" || kind === "SURVEY"
        ? kind
        : inferSroKind(type),
    type,
    number: toStringOr(raw.number, ""),
    responsibilityLevel: toPositiveIntOrNull(raw.responsibilityLevel),
    maxContractAmount: toNumberOrNull(raw.maxContractAmount),
    validUntil:
      typeof raw.validUntil === "string" && raw.validUntil.length > 0
        ? raw.validUntil
        : null,
    confirmed: raw.confirmed === true,
  };
}

/**
 * Достраивает сохранённый профиль до текущей схемы.
 *
 * Основа — пустой профиль, а не пример. Это и есть разница между «поле не
 * заполнено» и «поле заполнено чужой компанией»: раньше недостающее бралось у
 * вымышленной «ТехноПоставки», и пользователь, вписавший только название и
 * ИНН, получал закупки на ноутбуки и серверы, а её стоп-слово «строительство»
 * убирало из выдачи его собственные.
 *
 * Пример подставляется, только когда его передали вторым доводом явно.
 */
/**
 * Потолок, равный нулю, — пустое поле, а не запрет. «Не дороже 0 ₽» снимало
 * с рекомендаций каждую закупку с ценой, и они уходили в «Скрыто»
 * (замечание 05.10.2026). Минимумы не трогаем: ноль там и значит «от нуля».
 */
function withoutZeroCeilings(r: CompanyProfile["restrictions"]): CompanyProfile["restrictions"] {
  const amount = (v: number) => (Number.isFinite(v) && v > 0 ? v : NO_AMOUNT_LIMIT);
  return {
    ...r,
    maxPrice: amount(r.maxPrice),
    maxBidSecurity: amount(r.maxBidSecurity),
    maxContractSecurity: amount(r.maxContractSecurity),
    maxPaymentTermDays: Number.isFinite(r.maxPaymentTermDays) && r.maxPaymentTermDays > 0 ? r.maxPaymentTermDays : NO_DAYS_LIMIT,
  };
}

export function normalizeSavedProfile(
  saved: unknown,
  base: CompanyProfile = emptyCompanyProfile,
): CompanyProfile {
  const raw = asObject<SavedProfile>(saved);
  const staffRaw = asObject<Record<string, unknown>>(raw.staff);
  const totalsRaw = asObject<Record<string, unknown>>(raw.experienceTotals);

  return {
    ...base,
    ...asObject<CompanyProfile>(raw),
    capabilities: {
      ...base.capabilities,
      ...asObject<CompanyProfile["capabilities"]>(raw.capabilities),
    },
    restrictions: withoutZeroCeilings({
      ...base.restrictions,
      ...asObject<CompanyProfile["restrictions"]>(raw.restrictions),
    }),
    preferences: {
      ...base.preferences,
      ...asObject<CompanyProfile["preferences"]>(raw.preferences),
    },
    licenses: asArray(raw.licenses, base.licenses),
    experience: asArray(raw.experience, base.experience),
    documents: asArray(raw.documents, base.documents),
    sroMemberships: Array.isArray(raw.sroMemberships)
      ? (raw.sroMemberships as unknown[]).map(normalizeSroMembership)
      : base.sroMemberships,
    staff: {
      total: toNumberOrNull(staffRaw.total),
      nrsCount: toNumberOr(staffRaw.nrsCount, 0),
      noprizCount: toNumberOr(staffRaw.noprizCount, 0),
    },
    experienceTotals: {
      lastYearAmount: toNumberOrNull(totalsRaw.lastYearAmount),
      last3YearsAmount: toNumberOrNull(totalsRaw.last3YearsAmount),
    },
  };
}

export const companyProfileRepository = {
  /**
   * Профиль компании. Пока ничего не сохранено — пустая анкета.
   *
   * Раньше здесь отдавался пример, и форма открывалась заполненной чужой
   * компанией: название и ИНН пустые, а товары, ключевые слова, ОКПД2,
   * регионы и чёрный список — от вымышленной «ТехноПоставки». Человек вписывал
   * своё название, сохранял и был уверен, что заполнил профиль; всё, что
   * управляет подбором, оставалось чужим.
   */
  get(): CompanyProfile {
    const saved = readJSON<SavedProfile | null>(STORAGE_KEYS.profile, null);
    if (!saved) return emptyCompanyProfile;
    return normalizeSavedProfile(saved);
  },
  save(profile: CompanyProfile): void {
    writeJSON(STORAGE_KEYS.profile, profile);
  },
  /** Очищает анкету. Пример сюда не подставляется — см. `fillWithExample`. */
  reset(): CompanyProfile {
    writeJSON(STORAGE_KEYS.profile, emptyCompanyProfile);
    return emptyCompanyProfile;
  },
  /**
   * Заполняет анкету примером — по явному нажатию, чтобы посмотреть, как
   * выглядит собранный профиль и что он делает с выдачей.
   */
  fillWithExample(): CompanyProfile {
    writeJSON(STORAGE_KEYS.profile, demoCompanyProfile);
    return demoCompanyProfile;
  },
};
