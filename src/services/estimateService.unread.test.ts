import { describe, expect, it } from "vitest";

import { unreadChunkGaps } from "@/services/estimateService";

describe("unreadChunkGaps", () => {
  it("каждый пропущенный фрагмент — пробел BILL_CHUNK_UNREAD с его описанием", () => {
    const gaps = unreadChunkGaps([
      { message: "фрагмент 2 документа ВОР.docx не прочитан моделью: HTTP 502" },
      { message: "фрагмент 1 документа ТЗ.pdf не прочитан моделью: таймаут" },
    ]);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ kind: "BILL_CHUNK_UNREAD", code: null, baseType: null });
    expect(gaps[0]?.message).toContain("фрагмент 2 документа ВОР.docx не прочитан моделью: HTTP 502");
  });

  it("нет пропусков — нет пробелов", () => {
    expect(unreadChunkGaps([])).toEqual([]);
  });
});
