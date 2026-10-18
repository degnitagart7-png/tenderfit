import { describe, expect, it } from "vitest";

import { BACKUP_TABLES, expiredBackups, readAllRows, type BackupTable } from "./backup-db.lib";

/** Резервная копия: постраничное чтение с дроблением тяжёлых страниц и хранение 14 дней. */

const table: BackupTable = { name: "tender_documents", orderBy: ["id"], pageSize: 4 };

describe("readAllRows", () => {
  it("читает все строки страницами до неполной последней", async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const got: unknown[] = [];
    const total = await readAllRows(table, async (_t, offset, limit) => ({ rows: data.slice(offset, offset + limit), error: null }), (rows) => {
      got.push(...rows);
    });
    expect(total).toBe(10);
    expect(got).toEqual(data);
  });

  it("тяжёлая страница упала по таймауту — дробится вдвое, строки не теряются", async () => {
    const data = Array.from({ length: 6 }, (_, i) => ({ id: i }));
    const got: unknown[] = [];
    const total = await readAllRows(
      table,
      async (_t, offset, limit) =>
        // Строка 2 «весит» много: страница, включающая её и ещё что-то, падает.
        offset <= 2 && offset + limit > 2 && limit > 1 ? { rows: [], error: "statement timeout (57014)" } : { rows: data.slice(offset, offset + limit), error: null },
      (rows) => {
        got.push(...rows);
      },
    );
    expect(total).toBe(6);
    expect(got).toEqual(data);
  });

  it("не читается и одна строка — ошибка с номером строки", async () => {
    await expect(readAllRows(table, async () => ({ rows: [], error: "boom" }), () => undefined)).rejects.toThrow(/строка 0 не читается: boom/);
  });
});

describe("expiredBackups", () => {
  it("удаляются копии старше 14 дней; чужие папки не трогаются", () => {
    expect(expiredBackups(["2026-10-01", "2026-10-04", "2026-10-05", "2026-10-18", "lost+found"], "2026-10-18")).toEqual(["2026-10-01", "2026-10-04"]);
  });
});

describe("BACKUP_TABLES", () => {
  it("коды и сессии входа и кэш модели не копируются; у каждой таблицы есть ключ порядка", () => {
    const names = BACKUP_TABLES.map((t) => t.name);
    expect(names).not.toContain("auth_codes");
    expect(names).not.toContain("auth_sessions");
    expect(names).not.toContain("llm_response_cache");
    expect(BACKUP_TABLES.every((t) => t.orderBy.length > 0 && t.pageSize > 0)).toBe(true);
  });
});
