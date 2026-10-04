import type { Tender, TenderDocument } from "@/domain/entities";
import type {
  TenderSourceAdapter,
  TenderSourceQuery,
} from "@/adapters/types";
import { demoTenders } from "@/mocks/tenders";

/**
 * Mock-реализация источника закупок. Возвращает демонстрационную базу
 * и поддерживает базовую фильтрацию по параметрам запроса.
 * Заменяется на EisTenderSourceAdapter без изменения интерфейса.
 */
export class MockTenderSourceAdapter implements TenderSourceAdapter {
  async fetchTenders(query: TenderSourceQuery): Promise<Tender[]> {
    let result = [...demoTenders];
    if (query.laws && query.laws.length > 0) {
      result = result.filter((t) => query.laws.includes(t.law));
    }
    if (query.minPrice != null) {
      result = result.filter((t) => t.financial.price >= (query.minPrice ?? 0));
    }
    if (query.maxPrice != null) {
      result = result.filter((t) => t.financial.price <= (query.maxPrice ?? 0));
    }
    if (query.regions && query.regions.length > 0) {
      result = result.filter((t) =>
        query.regions!.some((r) => t.region.toLowerCase().includes(r.toLowerCase())),
      );
    }
    if (query.customerInns && query.customerInns.length > 0) {
      result = result.filter(
        (t) => t.customerInn != null && query.customerInns!.includes(t.customerInn),
      );
    }
    if (query.keywords && query.keywords.length > 0) {
      const kw = query.keywords.map((k) => k.toLowerCase());
      result = result.filter((t) =>
        kw.some((k) => t.subject.toLowerCase().includes(k)),
      );
    }
    if (query.limit != null) result = result.slice(0, query.limit);
    return result;
  }

  async fetchTenderById(id: string): Promise<Tender | null> {
    return demoTenders.find((t) => t.id === id || t.regNumber === id) ?? null;
  }

  async fetchDocuments(tenderId: string): Promise<TenderDocument[]> {
    const t = await this.fetchTenderById(tenderId);
    return t?.documents ?? [];
  }

  async checkChanges(tenderId: string): Promise<boolean> {
    const t = await this.fetchTenderById(tenderId);
    return (t?.changeLog.length ?? 0) > 0;
  }
}

export const mockTenderSourceAdapter = new MockTenderSourceAdapter();
