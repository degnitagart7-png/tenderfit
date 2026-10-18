import { describe, expect, it } from "vitest";
import {
  buildSyncRunNote,
  eisBlockedDocumentsNote,
  eisBlockedNote,
  syncNoteWarnings,
  type SyncRunNoteInput,
} from "@/domain/syncRunNote";

/** 11.10.2026 12:42 UTC = 15:42 МСК. */
const RETRY_AT = Date.UTC(2026, 9, 11, 12, 42, 0);

const BASE: SyncRunNoteInput = {
  saved: 129,
  documents: 4,
  duplicates: 7,
  errors: 0,
  elapsedSec: "280.4",
  eisBlockedRetryAt: null,
  failedSources: [],
};

describe("итоговая строка прогона", () => {
  it("без проблем — прежняя строка из одних счётчиков", () => {
    expect(buildSyncRunNote(BASE)).toBe(
      "Готово: 129 сохранено, 4 документов, 7 уже было от другого источника, 0 ошибок, 280.4 с",
    );
  });

  it("ЕИС ограничила доступ — об этом сказано прямо, со временем повтора по Москве", () => {
    expect(buildSyncRunNote({ ...BASE, eisBlockedRetryAt: RETRY_AT })).toBe(
      "Готово: 129 сохранено, 4 документов, 7 уже было от другого источника, 0 ошибок, 280.4 с" +
        " · ЕИС временно ограничила доступ — закупки с неё не обновились, повторим после 15:42 МСК",
    );
  });

  it("источник, не ответивший ни разу, называется кратко", () => {
    expect(buildSyncRunNote({ ...BASE, failedSources: ["Росэлторг", "Фабрикант"] })).toMatch(
      / · не ответили: Росэлторг, Фабрикант$/,
    );
  });

  it("блокировка и сбои источников — два отдельных сегмента", () => {
    const note = buildSyncRunNote({ ...BASE, eisBlockedRetryAt: RETRY_AT, failedSources: ["ТЭК-Торг"] });
    expect(note.split(" · ")).toHaveLength(3);
    expect(syncNoteWarnings(note)).toEqual([eisBlockedNote(RETRY_AT), "не ответили: ТЭК-Торг"]);
  });

  it("ноль сохранённых при блокировке не выглядит успехом: предупреждение есть", () => {
    const note = buildSyncRunNote({ ...BASE, saved: 0, documents: 0, duplicates: 0, eisBlockedRetryAt: RETRY_AT });
    expect(note.startsWith("Готово: 0 сохранено")).toBe(true);
    expect(syncNoteWarnings(note)).toHaveLength(1);
  });
});

describe("предупреждения в строке отчёта", () => {
  it("чистая строка и пустые значения — без предупреждений", () => {
    expect(syncNoteWarnings(buildSyncRunNote(BASE))).toEqual([]);
    expect(syncNoteWarnings(null)).toEqual([]);
    expect(syncNoteWarnings(undefined)).toEqual([]);
    expect(syncNoteWarnings("")).toEqual([]);
    expect(syncNoteWarnings("Поиск не уложился в 7 минут и остановлен")).toEqual([]);
  });

  it("задание на документацию: сколько закупок осталось в очереди", () => {
    const note = `закупок 12, загружено 3 · ${eisBlockedDocumentsNote(9, RETRY_AT)}`;
    expect(eisBlockedDocumentsNote(9, RETRY_AT)).toBe(
      "ЕИС временно ограничила доступ — документы 9 закупок не загружены, остались в очереди, повторим после 15:42 МСК",
    );
    expect(syncNoteWarnings(note)).toHaveLength(1);
    expect(eisBlockedDocumentsNote(2, null)).toMatch(/повторим при следующем прогоне$/);
  });
});
