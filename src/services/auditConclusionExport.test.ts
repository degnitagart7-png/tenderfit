import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { buildAuditConclusion } from "@/domain/estimate/auditConclusion";
import {
  auditOverallFileName,
  buildAuditConclusionReport,
  buildAuditOverallReport,
  CONCLUSION_TITLE,
  conclusionDate,
  OVERALL_TITLE,
} from "@/domain/estimate/auditConclusionReport";
import type { AuditReport } from "@/domain/estimate/customerAudit";
import { auditConclusionFileName, buildAuditConclusionDocx, buildAuditOverallDocx } from "@/services/auditConclusionExport";
import { reportLowCoverage, reportMatching, reportWithFindings } from "@/test/auditReports";

/*
  Word-заключение: структура проверяется по `buildAuditConclusionReport` (без распаковки), сам файл — распаковкой document.xml.
*/

const META = { subject: "Ремонт школы", tenderId: "0302300048726001118", fileNames: ["Смета.xlsx"], generatedAt: new Date("2026-10-21T09:00:00Z") };

function underStated(): AuditReport {
  const base = reportWithFindings();
  const customerTotal = 1_000_000;
  const repricedTotal = 1_150_000;
  return { ...base, customerTotal, repricedTotal, diff: 150_000, diffPercent: 15 };
}

async function documentXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  // Пробелы (в том числе неразрывные в суммах) сводятся к обычному: сравнивается текст, а не вёрстка.
  return (await zip.file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("buildAuditConclusionReport: структура", () => {
  const report = underStated();
  const conclusion = buildAuditConclusion({ report });
  const doc = buildAuditConclusionReport(conclusion, report, META);

  it("шапка: объект, закупка, файл, смета, дата, цены, метод", () => {
    const labels = doc.facts.map(([label]) => label);
    expect(labels).toEqual(["Объект", "Закупка", "Проверенный файл", "Смета", "Дата заключения", "Цены сравнения", "Метод сметы"]);
    const facts = Object.fromEntries(doc.facts);
    expect(facts["Объект"]).toBe("Ремонт школы");
    expect(facts["Закупка"]).toBe("№ 0302300048726001118");
    expect(facts["Проверенный файл"]).toBe("Смета.xlsx");
    expect(facts["Дата заключения"]).toBe("21.10.2026");
    expect(facts["Цены сравнения"]).toBe("Республика Бурятия, 1 зона, 2 кв. 2026");
    expect(facts["Метод сметы"]).toContain("ресурсно-индексный");
    expect(doc.title).toBe(CONCLUSION_TITLE);
  });

  it("смета, загруженная файлом: вместо номера закупки — пояснение; объект не указан — так и сказано", () => {
    const loaded = buildAuditConclusionReport(conclusion, report, { ...META, tenderId: null, subject: null });
    const facts = Object.fromEntries(loaded.facts);
    expect(facts["Закупка"]).toBe("смета загружена файлом");
    expect(facts["Объект"]).toBe("не указан");
  });

  it("разделы идут по порядку вопросов читателя", () => {
    expect(doc.sections.map((section) => section.title)).toEqual([
      "Вывод",
      "Разница по составляющим",
      "Позиции с наибольшей разницей",
      "Что не удалось переоценить",
      "Методика",
      "Оговорки",
    ]);
  });

  it("вывод: крупная жирная строка тем же текстом, что на экране; три числа в одной строке таблицы сразу под ней; причины списком", () => {
    const [headline, table, ...rest] = doc.sections[0]!.blocks;
    expect(headline).toMatchObject({ kind: "paragraph", text: conclusion.headline, tone: "bad", bold: true, large: true });
    if (table === undefined || table.kind !== "table") throw new Error("после вывода должна идти таблица");
    expect(table.columns.map((column) => column.title)).toEqual(["Смета заказчика", "Наш пересчёт", "Разница"]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.map((item) => item.text.replace(/\s/g, " "))).toEqual(["1 000 000 ₽", "1 150 000 ₽", "+150 000 ₽ (+15,0 %)"]);
    const bullets = rest.find((block) => block.kind === "bullets");
    expect(bullets && bullets.kind === "bullets" ? bullets.items : []).toEqual(conclusion.reasons.map((line) => line.text));
  });

  it("разница, округлившаяся до нуля, печатается «0,0 %» без знака минус", () => {
    const tiny: AuditReport = { ...underStated(), customerTotal: 1_000_000, repricedTotal: 999_999.5, diff: -0.5, diffPercent: -0.00005 };
    const tinyDoc = buildAuditConclusionReport(buildAuditConclusion({ report: tiny }), tiny, META);
    const table = tinyDoc.sections[0]!.blocks[1]!;
    const cells = table.kind === "table" ? table.rows[0]!.map((item) => item.text.replace(/\s/g, " ")) : [];
    expect(cells[2]).toBe("0 ₽ (0,0 %)");
  });

  it("таблица разницы: составляющие со знаком, подпись о знаке", () => {
    const blocks = doc.sections[1]!.blocks;
    const table = blocks.find((block) => block.kind === "table");
    expect(table && table.kind === "table" ? table.rows.length : 0).toBeGreaterThan(0);
    expect(blocks.some((block) => block.kind === "paragraph" && block.text.includes("Плюс — у нас дороже"))).toBe(true);
  });

  it("позиции: колонки шифр, наименование, объём, заказчик, наш пересчёт, разница, причина; не больше двадцати", () => {
    const table = doc.sections[2]!.blocks.find((block) => block.kind === "table");
    if (table === undefined || table.kind !== "table") throw new Error("нет таблицы позиций");
    expect(table.columns.map((column) => column.title)).toEqual(["№", "Шифр", "Наименование", "Объём", "Заказчик, ₽", "Наш пересчёт, ₽", "Разница, ₽", "Причина"]);
    expect(table.columns.reduce((sum, column) => sum + column.width, 0)).toBe(100);
    expect(table.rows.length).toBeLessThanOrEqual(20);
    expect(table.rows[0]!.every((item) => item.text !== "")).toBe(true);
  });

  it("методика — три-четыре строки; оговорка об информационном характере в конце", () => {
    const method = doc.sections[4]!.blocks[0]!;
    expect(method.kind === "bullets" ? method.items.length : 0).toBeGreaterThanOrEqual(3);
    expect(method.kind === "bullets" ? method.items.length : 99).toBeLessThanOrEqual(4);
    const last = doc.sections[5]!.blocks.at(-1)!;
    expect(last.kind === "paragraph" ? last.text : "").toContain("информационный характер");
  });

  it("непереоценённые позиции: сколько, на сколько рублей и почему", () => {
    const low = reportLowCoverage();
    const lowDoc = buildAuditConclusionReport(buildAuditConclusion({ report: low }), low, META);
    const blocks = lowDoc.sections[3]!.blocks;
    const summary = blocks[0]!;
    expect(summary.kind === "paragraph" ? summary.text : "").toContain("Не удалось переоценить");
    expect(blocks.some((block) => block.kind === "bullets" && block.items.some((item) => item.includes("нашей цены нет")))).toBe(true);
  });

  it("всё переоценено — сказано словами; позиций с разницей нет — тоже", () => {
    const ok = reportMatching();
    const okDoc = buildAuditConclusionReport(buildAuditConclusion({ report: ok }), ok, META);
    expect(okDoc.sections[3]!.blocks[0]).toMatchObject({ text: "Все позиции сметы переоценены нашими ценами и нормативами." });
    const none: AuditReport = { ...ok, positions: [], top: [], unchecked: [] };
    const noneDoc = buildAuditConclusionReport(buildAuditConclusion({ report: none }), none, META);
    expect(noneDoc.sections[2]!.blocks[0]).toMatchObject({ text: "Расхождений по позициям нет." });
  });

  it("только существенные расхождения: нулевые позиции в таблицу не попадают, нет ни одной — одна фраза", () => {
    const ok = reportMatching();
    const zeros: AuditReport = { ...ok, positions: ok.positions.map((item) => ({ ...item, diff: 0.2 })) };
    const zerosDoc = buildAuditConclusionReport(buildAuditConclusion({ report: zeros }), zeros, META);
    expect(zerosDoc.sections[2]!.blocks).toEqual([{ kind: "paragraph", text: "Расхождений по позициям нет." }]);
  });

  it("не падает на отчёте без групп, находок и позиций", () => {
    const empty: AuditReport = { ...reportMatching(), impacts: reportMatching().impacts, findings: [], positions: [], top: [], unchecked: [], ourCosts: undefined };
    expect(() => buildAuditConclusionReport(buildAuditConclusion({ report: empty }), empty, META)).not.toThrow();
  });
});

describe("файл Word", () => {
  it("настоящий docx: подпись PK, в тексте — вывод, шапка, таблица позиций, методика и оговорка", async () => {
    const report = underStated();
    const bytes = await buildAuditConclusionDocx({ ...META, report });
    expect(bytes.byteLength).toBeGreaterThan(3000);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const text = await documentXml(bytes);
    const conclusion = buildAuditConclusion({ report });
    expect(text).toContain(CONCLUSION_TITLE);
    expect(text).toContain(conclusion.headline.replace(/\s+/g, " "));
    expect(text).toContain("Ремонт школы");
    expect(text).toContain("Республика Бурятия, 1 зона, 2 кв. 2026");
    expect(text).toContain("ГЭСНр56-01-009-01");
    expect(text).toContain("Методика");
    expect(text).toContain("информационный характер");
  });

  it("смета БИМ и отчёт без групп тоже собираются", async () => {
    const bytes = await buildAuditConclusionDocx({ ...META, report: { ...reportWithFindings(), method: "BASE_INDEX" }, tenderId: null });
    expect(bytes[0]).toBe(0x50);
  });
});

describe("имя файла и дата", () => {
  it("название сметы и день; символы, запрещённые в Windows, убраны", () => {
    expect(auditConclusionFileName('ЛС 02-01/1: "Кровля"', new Date("2026-10-21T10:00:00Z"))).toBe("Заключение по смете ЛС 02-011 Кровля от 2026-10-21.docx");
    expect(auditConclusionFileName("", new Date("2026-10-21T10:00:00Z"))).toBe("Заключение по смете от 2026-10-21.docx");
  });

  it("дата — по Москве, не по часовому поясу сервера", () => {
    expect(conclusionDate(new Date("2026-10-20T22:30:00Z"))).toBe("21.10.2026");
  });
});

describe("общее заключение по всем сметам", () => {
  const reports = [
    { ...underStated(), estimateNumber: "02-01-01", title: "Ремонт кровли" },
    { ...reportMatching(), estimateNumber: "02-01-02", title: "Электроснабжение", positions: [], top: [] },
    { ...reportLowCoverage(), estimateNumber: "02-01-03", title: "Отопление" },
  ];
  const doc = buildAuditOverallReport(reports, META);

  it("шапка и разделы: итог, затем по каждой смете, методика, оговорки", () => {
    expect(doc.title).toBe(OVERALL_TITLE);
    expect(Object.fromEntries(doc.facts)["Смет в заключении"]).toBe("3");
    expect(doc.sections.map((section) => section.title)).toEqual([
      "Итого по всем сметам (3)",
      "ЛСР 02-01-01 · Ремонт кровли",
      "ЛСР 02-01-02 · Электроснабжение",
      "ЛСР 02-01-03 · Отопление",
      "Методика",
      "Оговорки",
    ]);
  });

  it("итог: крупный вывод, три числа в строке и таблица «каждая смета одной строкой» с выводом и покрытием", () => {
    const [headline, figures, , table] = doc.sections[0]!.blocks;
    expect(headline).toMatchObject({ kind: "paragraph", large: true, bold: true });
    expect(figures !== undefined && figures.kind === "table" ? figures.columns.map((column) => column.title) : []).toEqual(["Сметы заказчика", "Наш пересчёт", "Разница"]);
    if (table === undefined || table.kind !== "table") throw new Error("нет таблицы смет");
    expect(table.columns.map((column) => column.title)).toEqual(["Смета", "Заказчик, ₽", "Пересчёт, ₽", "Разница, ₽ (%)", "Проверено", "Вывод"]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]![0]!.text).toBe("ЛСР 02-01-01 · Ремонт кровли");
    expect(table.rows[0]![5]!.text).toBe("занижена");
    expect(table.rows[2]![5]!.text).toContain("проверена частично");
  });

  it("смета с расхождениями — причины и таблица позиций; без расхождений — одна строка", () => {
    const withDeviation = doc.sections[1]!.blocks;
    expect(withDeviation.some((block) => block.kind === "table")).toBe(true);
    const clean = doc.sections[2]!.blocks;
    expect(clean.some((block) => block.kind === "table")).toBe(false);
    expect(clean.at(-1)).toMatchObject({ kind: "paragraph", text: "Расхождений нет." });
  });

  it("файл Word: подпись PK, в тексте — все названия смет и вывод по итогу", async () => {
    const bytes = await buildAuditOverallDocx({ ...META, reports });
    expect(bytes[0]).toBe(0x50);
    const text = await documentXml(bytes);
    expect(text).toContain(OVERALL_TITLE);
    expect(text).toContain("ЛСР 02-01-03 · Отопление");
    expect(text).toContain("Итого по всем сметам (3)");
    expect(text).toContain("информационный характер");
  });

  it("имя файла общего заключения", () => {
    expect(auditOverallFileName(new Date("2026-10-21T10:00:00Z"))).toBe("Заключение по всем сметам от 2026-10-21.docx");
  });
});
