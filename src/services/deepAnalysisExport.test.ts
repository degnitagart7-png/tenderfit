import { describe, expect, it } from "vitest";

import {
  buildDeepAnalysisDocx,
  deepAnalysisFileName,
} from "@/services/deepAnalysisExport";
import type { DeepAnalysisSummary } from "@/domain/deepAnalysis";
import type { AnalysisFinding, DocumentMeta } from "@/types/database";

function finding(over: Partial<AnalysisFinding> = {}): AnalysisFinding {
  return {
    category: "risk",
    title: "Неустойка 0,5 % за день просрочки",
    detail: "Размер пени выше обычного для этого вида работ.",
    evidence_quote:
      "Неустойка составляет 0,5% от цены контракта за каждый день просрочки",
    evidence_section: "Раздел 5. Проект контракта",
    severity: "high",
    ...over,
  };
}

function document(over: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id: "doc-1",
    filename: "Документация о закупке.docx",
    document_type: "attachment",
    source_type: "eis_attachment",
    file_url: "https://zakupki.gov.ru/file",
    parsed_status: "parsed",
    download_status: "downloaded",
    content_hash: "a".repeat(64),
    file_size: 404_174,
    error_message: null,
    created_at: "2026-09-25T11:35:00Z",
    updated_at: "2026-09-25T11:35:00Z",
    raw_json: { title: "Документация о закупке", chars: 163_732 },
    ...over,
  } as DocumentMeta;
}

function summary(over: Partial<DeepAnalysisSummary> = {}): DeepAnalysisSummary {
  const findings = over.findings ?? [finding()];
  return {
    state: "completed",
    title: "Разбор завершён",
    detail: "Прочитано 2 файла из 2. Нашлось важного: 1.",
    job: null,
    documents: [document()],
    documentsWithText: 1,
    documentsSkipped: 0,
    documentsTruncated: 0,
    chunksAnalyzed: 3,
    findings,
    findingGroups: [{ category: "risk", findings }],
    modelUsed: "google/gemini-2.5-flash",
    verdictChange: null,
    ...over,
  } as DeepAnalysisSummary;
}

/** Docx — это zip: непустой архив с подписью PK годится как признак файла Word. */
function looksLikeDocx(bytes: Uint8Array): boolean {
  return bytes.byteLength > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

describe("deepAnalysisFileName", () => {
  it("называет файл номером закупки и датой", () => {
    const name = deepAnalysisFileName(
      "32616404800",
      new Date("2026-09-27T10:00:00Z"),
    );

    expect(name).toBe("Глубокий анализ 32616404800 от 2026-09-27.docx");
  });

  it("выбрасывает из номера то, что нельзя в имени файла", () => {
    const name = deepAnalysisFileName(
      'AA/01:"*?',
      new Date("2026-09-27T10:00:00Z"),
    );

    expect(name).not.toMatch(/[\\/:"*?<>|]/);
  });
});

describe("buildDeepAnalysisDocx", () => {
  it("собирает настоящий файл Word", async () => {
    const bytes = await buildDeepAnalysisDocx({
      regNumber: "32616404800",
      subject: "Реконструкция запорных колодцев",
      summary: summary(),
      generatedAt: new Date("2026-09-27T10:00:00Z"),
    });

    expect(looksLikeDocx(bytes)).toBe(true);
  });

  it("на разборе без находок всё равно отдаёт документ", async () => {
    const bytes = await buildDeepAnalysisDocx({
      regNumber: "32616404800",
      subject: "Реконструкция запорных колодцев",
      summary: summary({ findings: [], findingGroups: [] }),
      generatedAt: new Date("2026-09-27T10:00:00Z"),
    });

    expect(looksLikeDocx(bytes)).toBe(true);
  });

  it("документ с находками весит больше пустого: цитаты и разделы внутри", async () => {
    const base = {
      regNumber: "32616404800",
      subject: "Реконструкция запорных колодцев",
      generatedAt: new Date("2026-09-27T10:00:00Z"),
    };

    const empty = await buildDeepAnalysisDocx({
      ...base,
      summary: summary({ findings: [], findingGroups: [] }),
    });
    const filled = await buildDeepAnalysisDocx({
      ...base,
      summary: summary({
        findings: [
          finding(),
          finding({ title: "Односторонний отказ заказчика" }),
        ],
        findingGroups: [
          {
            category: "risk",
            findings: [
              finding(),
              finding({ title: "Односторонний отказ заказчика" }),
            ],
          },
        ],
      }),
    });

    expect(filled.byteLength).toBeGreaterThan(empty.byteLength);
  });
});
