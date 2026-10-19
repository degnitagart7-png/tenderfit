import { describe, expect, it } from "vitest";

import {
  historyFilesLine,
  historyTitle,
  isHistoryItemActive,
  mergeHistory,
  type EstimateHistoryItem,
} from "@/domain/estimate/estimateHistory";

function item(patch: Partial<EstimateHistoryItem> = {}): EstimateHistoryItem {
  return {
    id: "job-1",
    status: "completed",
    createdAt: "2026-10-20T10:00:00.000000+00:00",
    finishedAt: null,
    mode: "estimate",
    reason: "upload",
    tenderId: null,
    subject: "Ремонт кровли",
    documentNames: ["ТЗ.docx"],
    totalRub: null,
    error: null,
    ...patch,
  };
}

describe("historyTitle", () => {
  it("объект, а без него — имена файлов, закупка или общая подпись", () => {
    expect(historyTitle(item())).toBe("Ремонт кровли");
    expect(historyTitle(item({ subject: "  ", documentNames: ["А.docx", "Б.pdf"] }))).toBe("А.docx, Б.pdf");
    expect(historyTitle(item({ subject: null, documentNames: null, tenderId: "0373" }))).toBe("Закупка 0373");
    expect(historyTitle(item({ subject: null, documentNames: null }))).toBe("Расчёт по документации");
    expect(historyTitle(item({ subject: null, documentNames: null, mode: "audit" }))).toBe("Проверка сметы");
  });
});

describe("historyFilesLine", () => {
  it("до трёх имён — все, дальше «и ещё N»", () => {
    expect(historyFilesLine(item({ documentNames: ["А", "Б"] }))).toBe("А, Б");
    expect(historyFilesLine(item({ documentNames: ["А", "Б", "В", "Г", "Д"] }))).toBe("А, Б, В и ещё 2");
  });

  it("у старых расчётов имён нет — честная общая подпись; у расчётов по закупке строки нет", () => {
    expect(historyFilesLine(item({ documentNames: null }))).toBe("загруженные файлы");
    expect(historyFilesLine(item({ reason: "tender", documentNames: null }))).toBeNull();
    expect(historyFilesLine(item({ documentNames: [] }))).toBeNull();
  });
});

describe("isHistoryItemActive", () => {
  it("в очереди и считается — идут, готово и ошибка — нет", () => {
    expect(isHistoryItemActive({ status: "pending" })).toBe(true);
    expect(isHistoryItemActive({ status: "processing" })).toBe(true);
    expect(isHistoryItemActive({ status: "completed" })).toBe(false);
    expect(isHistoryItemActive({ status: "failed" })).toBe(false);
  });
});

describe("mergeHistory", () => {
  it("свежая строка перекрывает прежнюю: у идущего расчёта поменялся статус", () => {
    const merged = mergeHistory([item({ status: "completed", totalRub: 5 })], [item({ status: "processing" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ status: "completed", totalRub: 5 });
  });

  it("новая строка встаёт наверх, прежнее и дальше загруженное сохраняется; порядок — от нового к старому", () => {
    const old = item({ id: "old", createdAt: "2026-10-18T09:00:00.000000+00:00" });
    const mid = item({ id: "mid", createdAt: "2026-10-19T09:00:00.000000+00:00" });
    const fresh = item({ id: "fresh", createdAt: "2026-10-20T09:00:00.000000+00:00" });

    expect(mergeHistory([fresh, mid], [mid, old]).map((entry) => entry.id)).toEqual(["fresh", "mid", "old"]);
  });
});
