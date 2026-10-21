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

describe("buildDeepAnalysisDocx: вёрстка отчёта", () => {
  it("внутри — нумерованные разделы, таблицы и колонтитул с номером закупки", async () => {
    const JSZip = (await import("jszip")).default;
    const bytes = await buildDeepAnalysisDocx({
      regNumber: "32616404800",
      subject: "Реконструкция запорных колодцев",
      summary: summary(),
      generatedAt: new Date("2026-09-27T10:00:00Z"),
    });
    const zip = await JSZip.loadAsync(bytes);
    const body = await zip.file("word/document.xml")!.async("string");
    const footers = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => /^word\/footer\d*\.xml$/.test(name))
        .map((name) => zip.file(name)!.async("string")),
    );

    expect(body).toContain("1. Итог");
    expect(body).toContain("6. Риски договора");
    expect(body).toContain("<w:tbl>");
    expect(body).toContain("Неустойка 0,5 % за день просрочки");
    expect(footers.join("")).toContain("закупка № 32616404800");
  });
});

describe("buildDeepAnalysisDocx: таблица из пяти колонок", () => {
  async function bodyOf(input: Parameters<typeof buildDeepAnalysisDocx>[0]) {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await buildDeepAnalysisDocx(input));
    return zip.file("word/document.xml")!.async("string");
  }

  const base = {
    regNumber: "32616404800",
    subject: "Реконструкция запорных колодцев",
    generatedAt: new Date("2026-09-27T10:00:00Z"),
  };

  it("сетка колонок сходится с шириной страницы, «Статус» не уже 14 % — «Не выполнено» не рвётся", async () => {
    const body = await bodyOf({
      ...base,
      summary: summary({
        findings: [
          finding({
            category: "blocker",
            title: "Лицензия ФСБ",
            requirement_kind: "LICENSE",
            required_value: "лицензия ФСБ",
          }),
          finding(),
        ],
      }),
      profileMatch: {
        verdict: "BLOCKED",
        headline: "Не хватает",
        met: 0,
        notMet: 1,
        toCheck: 0,
        checks: [
          {
            finding: finding({ category: "blocker", title: "Лицензия ФСБ", requirement_kind: "LICENSE" }),
            kind: "LICENSE",
            status: "NOT_MET",
            reason: "Нужна лицензия (ФСБ) — в профиле такой нет.",
          },
        ],
      },
    });

    const grids = [...body.matchAll(/<w:tblGrid>(.*?)<\/w:tblGrid>/g)].map((m) =>
      [...m[1]!.matchAll(/w:w="(\d+)"/g)].map((c) => Number(c[1])),
    );
    const fiveColumns = grids.filter((g) => g.length === 5);
    // Допуск и риски — обе таблицы пятиколоночные.
    expect(fiveColumns.length).toBeGreaterThanOrEqual(2);
    for (const grid of fiveColumns) {
      expect(Math.abs(grid.reduce((a, b) => a + b, 0) - 9638)).toBeLessThanOrEqual(5);
      // № узкий, «Статус» (3-я колонка) — не уже 14 % ширины: слово «выполнено» целиком в строке.
      expect(grid[0]! / 9638).toBeLessThan(0.07);
      expect(grid[2]! / 9638).toBeGreaterThanOrEqual(0.14);
    }
    expect(body).toContain("Не выполнено");
    expect(body).toContain("Что делать");
    // Тон статуса — цвет и заливка; цитата и раздел — мелким курсивом.
    expect(body).toContain('w:fill="FEF3F2"');
    expect(body).toMatch(/<w:i\/>.*?w:sz w:val="18"/);
  });

  it("«чем грозит» риска — обычным абзацем под названием, мелкий абзац — серым", async () => {
    const body = await bodyOf({
      ...base,
      summary: summary({
        findings: [
          finding({ severity: "medium" }),
          finding({ title: "Пеня 0,1%", severity: "low", evidence_quote: "пеня 0,1%" }),
        ],
      }),
    });
    expect(body).toContain("Размер пени выше обычного для этого вида работ.");
    expect(body).toContain("Ещё 1 условие низкой важности: Пеня 0,1%.");
    // Мелкий абзац: 9 pt и серый цвет.
    expect(body).toMatch(/<w:color w:val="6C6862"\/><w:sz w:val="18"\/>[^]*?Ещё 1 условие/);
  });

  it("ячейка без текста, но с пояснением, не оставляет пустую строку сверху", async () => {
    const body = await bodyOf({
      ...base,
      summary: summary({
        findings: [
          finding({ category: "requirement", title: "Не банкрот", requirement_kind: "DECLARATION" }),
        ],
      }),
      profileMatch: {
        verdict: "READY",
        headline: "Всё закрыто",
        met: 2,
        notMet: 0,
        toCheck: 0,
        checks: ["Не банкрот", "Нет в РНП"].map((title) => ({
          finding: finding({ category: "requirement", title, requirement_kind: "DECLARATION", evidence_quote: "" }),
          kind: "DECLARATION" as const,
          status: "MET" as const,
          reason: "Типовое условие допуска — подтверждается декларацией в заявке.",
        })),
      },
    });
    expect(body).toContain("Типовые требования (");
    expect(body).toContain("Подтверждается декларацией в заявке.");
    expect(body).not.toContain("<w:t xml:space=\"preserve\"></w:t>");
  });
});

describe("buildDeepAnalysisDocx: соответствие вашей компании", () => {
  it("раздел с таблицей вердиктов собирается в настоящий .docx", async () => {
    const bytes = await buildDeepAnalysisDocx({
      regNumber: "0373100012826000123",
      subject: "Капитальный ремонт кровли",
      summary: summary(),
      generatedAt: new Date("2026-10-21T12:00:00Z"),
      companyFit: {
        version: 1,
        tenderId: "0373100012826000123",
        computedAt: "2026-10-21T12:00:00.000Z",
        overall: "no_fit",
        headline: "Не подходит по 1 из 2 требований",
        summary: "Нет автовышки.",
        requirements: [
          { id: "r1", kind: "EXPERIENCE", title: "Опыт", required: "20% НМЦК", verdict: "ok", basis: "Выполнено.", source: "rule", contractIds: [], quote: "цитата" },
          { id: "r2", kind: "EQUIPMENT", title: "Автовышка", required: null, verdict: "fail", basis: "Нет техники.", source: "rule", contractIds: [], quote: null },
        ],
        experience: [{ contractId: "c1", subject: "Ремонт кровли школы", customer: null, year: 2025, sumRub: 8_000_000, why: "Тот же вид работ" }],
        gaps: ["Автовышка: нет техники."],
        risks: ["Короткий срок"],
        basisNote: "Учтено — контрактов из документов: 1.",
        llmUsed: true,
        hasCompanyData: true,
      },
    });
    expect(looksLikeDocx(bytes)).toBe(true);
  });
});
