import type { CompanyProfile, Tender, TenderAnalysis } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import { mockTenderSourceAdapter } from "@/adapters/tender-source/mockTenderSourceAdapter";
import { mockTenderAnalysisProvider } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { pipelineRepository } from "@/repositories/pipelineRepository";
import { importedTendersRepository } from "@/repositories/importedTendersRepository";
import { generateTendersForProfile } from "@/mocks/dynamicTenders";
import type { TenderSourceAdapter, TenderSourceQuery } from "@/adapters/types";

/**
 * Сервис закупок: композиция источника данных и провайдера анализа.
 * Компоненты обращаются к нему, а не к mock-данным напрямую.
 *
 * Источник по умолчанию — mock. К нему добавляются импортированные закупки
 * (CSV/ручной импорт, см. importedTendersRepository). При
 * NEXT_PUBLIC_DATA_SOURCE=eis на сервере можно передать EisTenderSourceAdapter
 * (см. scripts/scrape-eis.ts и ACCESS_EIS.md).
 *
 * Динамическая генерация: getRows() генерирует закупки на основе профиля
 * компании, чтобы пользователь видел релевантные закупки при смене отрасли.
 */

const source: TenderSourceAdapter = mockTenderSourceAdapter;

export const tenderService = {
  async getTenders(query?: Partial<TenderSourceQuery>): Promise<Tender[]> {
    const mockTenders = await source.fetchTenders({
      laws: query?.laws ?? ["FZ_44", "FZ_223", "PP_RF_615"],
      keywords: query?.keywords,
      regions: query?.regions,
      minPrice: query?.minPrice,
      maxPrice: query?.maxPrice,
      okpd2Codes: query?.okpd2Codes,
      limit: query?.limit,
    });
    return [...importedTendersRepository.asTenders(), ...mockTenders];
  },

  async getTenderById(id: string): Promise<Tender | null> {
    const imported = importedTendersRepository
      .asTenders()
      .find((t) => t.id === id);
    if (imported) return imported;
    return source.fetchTenderById(id);
  },

  async analyze(tender: Tender, profile: CompanyProfile): Promise<TenderAnalysis> {
    return mockTenderAnalysisProvider.analyze(tender, profile);
  },

  /** Полные строки (закупка + анализ + статус воронки) для таблиц и дашборда. */
  async getRows(profile: CompanyProfile): Promise<TenderRow[]> {
    // Динамическая генерация закупок под профиль компании
    const dynamicTenders = generateTendersForProfile(profile);
    const importedTenders = importedTendersRepository.asTenders();
    const tenders = [...importedTenders, ...dynamicTenders];
    const rows: TenderRow[] = [];
    for (const tender of tenders) {
      const analysis = await mockTenderAnalysisProvider.analyze(tender, profile);
      rows.push({
        tender,
        analysis,
        pipelineStatus: pipelineRepository.getStatus(tender.id),
      });
    }
    return rows;
  },

  async getRowById(
    id: string,
    profile: CompanyProfile,
  ): Promise<TenderRow | null> {
    // Сначала ищем в импортированных и статичных закупках
    const staticTender = await this.getTenderById(id);
    if (staticTender) {
      const analysis = await mockTenderAnalysisProvider.analyze(staticTender, profile);
      return {
        tender: staticTender,
        analysis,
        pipelineStatus: pipelineRepository.getStatus(staticTender.id),
      };
    }
    // Ищем среди динамически сгенерированных закупок
    const dynamicTenders = generateTendersForProfile(profile);
    const dynamicTender = dynamicTenders.find((t) => t.id === id);
    if (dynamicTender) {
      const analysis = await mockTenderAnalysisProvider.analyze(dynamicTender, profile);
      return {
        tender: dynamicTender,
        analysis,
        pipelineStatus: pipelineRepository.getStatus(dynamicTender.id),
      };
    }
    return null;
  },
};
