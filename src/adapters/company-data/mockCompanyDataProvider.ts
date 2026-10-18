import type { CompanyProfile } from "@/domain/entities";
import type { CompanyDataProvider } from "@/adapters/types";
import { demoCompanyProfile } from "@/mocks/companyProfile";

/**
 * Mock-реализация источника данных о компании.
 * В реальной интеграции — Supabase/PostgreSQL и внешние реестры (ФНС, ЕРУЛ).
 */
export class MockCompanyDataProvider implements CompanyDataProvider {
  async getProfile(): Promise<CompanyProfile> {
    return demoCompanyProfile;
  }
  async getLicenses() {
    return demoCompanyProfile.licenses;
  }
  async getSro() {
    return demoCompanyProfile.sroMemberships;
  }
  async getExperience() {
    return demoCompanyProfile.experience;
  }
  async getProductCatalog() {
    return demoCompanyProfile.capabilities.products;
  }
}

export const mockCompanyDataProvider = new MockCompanyDataProvider();
