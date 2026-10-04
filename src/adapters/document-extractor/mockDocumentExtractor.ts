import type { TenderDocument } from "@/domain/entities";
import type { DocumentExtractor, ExtractedFragment } from "@/adapters/types";

/**
 * Mock-реализация извлечения текста из документов.
 * В реальной интеграции здесь будет парсинг PDF/DOCX и OCR.
 */
export class MockDocumentExtractor implements DocumentExtractor {
  async extractText(document: TenderDocument): Promise<string> {
    return document.text;
  }

  async extractTables(document: TenderDocument): Promise<string[][]> {
    if (document.type !== "TECHNICAL_SPEC") return [];
    return [["Наименование", "Характеристика", "Кол-во"], ["Товар", "по ТЗ", "—"]];
  }

  async detectType(document: TenderDocument): Promise<TenderDocument["type"]> {
    return document.type;
  }

  async extractFragments(document: TenderDocument): Promise<ExtractedFragment[]> {
    const sentences = document.text
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 0)
      .slice(0, 5);
    return sentences.map((text, i) => ({
      text,
      page: i + 1,
      section: document.type === "TECHNICAL_SPEC" ? "Техническое задание" : null,
      coordinates: null,
    }));
  }
}

export const mockDocumentExtractor = new MockDocumentExtractor();
