import { describe, expect, it } from "vitest";

import { buildRows, formatTender, formatTotals, parseEvalArgs, savedPercent, totalsOf } from "./estimate-doc-filter-eval.lib";

describe("parseEvalArgs", () => {
  it("несколько --tender, --blind и --json", () => {
    expect(parseEvalArgs(["--tender", "0302100011026000027", "--tender", "32616407955", "--tender", "32616407955", "--blind", "--json", "out.json"])).toEqual({
      tenders: ["0302100011026000027", "32616407955"],
      blind: true,
      json: "out.json",
      help: false,
    });
  });

  it("без закупок и с неизвестным аргументом — ошибка; --help закупок не требует", () => {
    expect(() => parseEvalArgs([])).toThrow(/--tender/);
    expect(() => parseEvalArgs(["--tender"])).toThrow(/--tender/);
    expect(() => parseEvalArgs(["--tender", "1", "--foo"])).toThrow(/Неизвестный/);
    expect(parseEvalArgs(["--help"]).help).toBe(true);
  });
});

const decide = (name: string): { reason: string; parts: never[] } => ({ reason: `причина «${name}»`, parts: [] });

describe("buildRows: решение по фактическим вызовам заглушки", () => {
  const documents = [
    { name: "Проект контракта.docx", text: "x".repeat(200_000) },
    { name: "ТЗ.docx", text: "x".repeat(50_000) },
    { name: "ЛСР.xlsx", text: "x".repeat(10_000) },
    { name: "Копия ТЗ.docx", text: "x".repeat(50_000) },
    { name: "Архив.zip", text: "x".repeat(150_000) },
  ];
  const rows = buildRows({
    documents,
    levels: [
      { name: "Проект контракта.docx", level: "SPEC" },
      { name: "ТЗ.docx", level: "SPEC" },
      { name: "ЛСР.xlsx", level: "CUSTOMER_ESTIMATE" },
      { name: "Архив.zip", level: "SPEC" },
    ],
    duplicates: ["Копия ТЗ.docx"],
    callsBefore: [
      { document: "Проект контракта.docx", chars: 100_000 },
      { document: "Проект контракта.docx", chars: 100_000 },
      { document: "ТЗ.docx", chars: 50_000 },
      { document: "Архив.zip", chars: 100_000 },
      { document: "Архив.zip", chars: 50_000 },
    ],
    callsAfter: [
      { document: "ТЗ.docx", chars: 50_000 },
      { document: "Архив.zip", chars: 40_000 },
    ],
    decide,
  });
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

  it("пропуск, читать, код, дубль, частично", () => {
    expect(byName["Проект контракта.docx"]).toMatchObject({ decision: "пропуск", chunksBefore: 2, chunksAfter: 0, charsBefore: 200_000, charsAfter: 0, reason: "причина «Проект контракта.docx»" });
    expect(byName["ТЗ.docx"]).toMatchObject({ decision: "читать", chunksBefore: 1, chunksAfter: 1 });
    expect(byName["ЛСР.xlsx"]).toMatchObject({ decision: "код", chunksBefore: 0, level: "CUSTOMER_ESTIMATE" });
    expect(byName["Копия ТЗ.docx"]).toMatchObject({ decision: "дубль" });
    expect(byName["Архив.zip"]).toMatchObject({ decision: "частично", chunksBefore: 2, chunksAfter: 1, charsAfter: 40_000 });
  });

  it("итог: фрагменты и знаки до и после, доля экономии", () => {
    const totals = totalsOf(rows);
    expect(totals).toEqual({ documents: 5, skipped: 2, chunksBefore: 5, chunksAfter: 2, charsBefore: 400_000, charsAfter: 90_000 });
    expect(savedPercent(totals)).toBe(78);
    expect(formatTotals(totals)).toContain("фрагментов модели 5 → 2 (−3)");
    expect(formatTotals(totals)).toContain("−78 %");
  });

  it("текст отчёта называет решение, причину и экономию по каждому документу", () => {
    const text = formatTender("0134300025826000377", rows);
    expect(text).toContain("=== Закупка 0134300025826000377 ===");
    expect(text).toContain("[пропуск ] Проект контракта.docx · SPEC · 200 000 зн · фрагментов 2 → 0 (−2)");
    expect(text).toContain("причина «Проект контракта.docx»");
    expect(text).toContain("[код     ] ЛСР.xlsx");
    expect(text).toContain("Итого: документов 5");
  });

  it("savedPercent без входа — 0", () => {
    expect(savedPercent({ charsBefore: 0, charsAfter: 0 })).toBe(0);
  });
});
