import { describe, expect, it } from "vitest";

import { redactSyncJob } from "@/domain/syncJobRedaction";
import type { SyncJobRow } from "@/types/database";

function job(payload: SyncJobRow["payload"]): SyncJobRow {
  return {
    id: "75d560fc",
    kind: "estimate",
    status: "completed",
    payload,
    report: null,
    requested_by: null,
    error: null,
    created_at: "2026-09-28T22:03:31.000Z",
    claimed_at: "2026-09-28T22:03:34.000Z",
    finished_at: "2026-09-28T22:03:53.000Z",
  } as SyncJobRow;
}

/**
 * Журнал очереди показывает, что делал воркер, — а не что было в присланных
 * файлах.
 *
 * Тексты документов попадают в задание, потому что хранить их больше негде:
 * файл разбирается в браузере, на сервер уходит текст. Но `GET /api/sync-jobs`
 * отдаёт журнал целиком, и вместе с ним наружу уходила бы документация
 * закупки — часто под NDA. `POST /api/estimate` те же тексты намеренно не
 * возвращает; значит решение уже принято, и журнал обязан его соблюдать.
 *
 * Имя и размер остаются: по ним видно, что воркер получил, и без них журнал
 * перестаёт отвечать на вопрос «почему расчёт вышел таким».
 */
describe("redactSyncJob", () => {
  it("текст документа наружу не уходит", () => {
    const redacted = redactSyncJob(
      job({ documents: [{ name: "Смета.csv", text: "1 Разработка грунта | м3 | 850" }] }),
    );

    expect(JSON.stringify(redacted)).not.toContain("Разработка грунта");
  });

  it("имя документа и размер текста остаются", () => {
    const redacted = redactSyncJob(
      job({ documents: [{ name: "Смета.csv", text: "тридцать знаков ровно, честно" }] }),
    );

    expect(redacted.payload?.documents?.[0]?.name).toBe("Смета.csv");
    expect(redacted.payload?.documents?.[0]?.chars).toBe(29);
  });

  it("несколько документов остаются все", () => {
    const redacted = redactSyncJob(
      job({
        documents: [
          { name: "Смета.csv", text: "первый" },
          { name: "Ведомость.xlsx", text: "второй" },
        ],
      }),
    );

    expect(redacted.payload?.documents).toHaveLength(2);
  });

  it("остальные поля задания не трогаются", () => {
    const redacted = redactSyncJob(
      job({ tenderId: "t-1", subject: "Строительство АБК", regNumbers: ["32616404800"] }),
    );

    expect(redacted.payload?.tenderId).toBe("t-1");
    expect(redacted.payload?.subject).toBe("Строительство АБК");
    expect(redacted.payload?.regNumbers).toEqual(["32616404800"]);
  });

  it("задание без документов проходит как есть", () => {
    const redacted = redactSyncJob(job({ regNumbers: ["32616404800"] }));

    expect(redacted.payload?.documents).toBeUndefined();
  });

  it("пустой payload не ломает вырезание", () => {
    expect(() => redactSyncJob(job({}))).not.toThrow();
  });
});
