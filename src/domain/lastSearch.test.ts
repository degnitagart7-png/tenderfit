import { describe, expect, it } from "vitest";
import type { Tender } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import {
  FRESH_WINDOW_DAYS,
  NEW_IN_BATCH_SLACK_MS,
  freshnessLayer,
  groupByFreshness,
  isNewInBatch,
  layerRank,
  selectLastKonturBatch,
} from "@/domain/lastSearch";
import { demoTenders } from "@/mocks/tenders";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";

/** «Сейчас» фиксировано: от него считаются окно свежести и истёкший срок. */
const NOW = new Date("2026-09-25T15:00:00.000Z");
/** Метка партии последнего прогона Контур.Закупок. */
const STAMP = "2026-09-25T14:52:03.000Z";
/** Подача ещё открыта. */
const OPEN_END = "2026-10-05T10:00:00.000Z";
/** Подача закрылась до NOW. */
const EXPIRED_END = "2026-09-20T10:00:00.000Z";

/** Строка с нужными метками: остальное берём из демо-данных. */
function row(
  patch: Partial<Tender> = {},
  analysisPatch: Partial<TenderRow["analysis"]> = {},
): TenderRow {
  const base = demoTenders[0]!;
  const tender: Tender = {
    ...base,
    deadlines: { ...base.deadlines, submissionEnd: OPEN_END },
    ...patch,
  };
  return {
    tender,
    analysis: { ...analyzeTender(tender, demoCompanyProfile), ...analysisPatch },
    pipelineStatus: "NEW",
  };
}

describe("selectLastKonturBatch", () => {
  it("партия — строки Контур с максимальной меткой синхронизации", () => {
    const older = row({
      regNumber: "K-OLD",
      dataSource: "KONTUR",
      syncedAt: "2026-09-20T10:00:00.000Z",
    });
    const first = row({ regNumber: "K-A", dataSource: "KONTUR", syncedAt: STAMP });
    const second = row({ regNumber: "K-B", dataSource: "KONTUR", syncedAt: STAMP });

    const batch = selectLastKonturBatch([older, first, second]);

    expect(batch?.stamp).toBe(STAMP);
    expect(batch?.rows.map((r) => r.tender.regNumber)).toEqual(["K-A", "K-B"]);
  });

  it("прогон ЕИС свежее, но партию Контур не перебивает", () => {
    const kontur = row({ regNumber: "K-A", dataSource: "KONTUR", syncedAt: STAMP });
    const eis = row({
      regNumber: "EIS-1",
      dataSource: "EIS",
      syncedAt: "2026-09-25T14:59:00.000Z",
    });

    const batch = selectLastKonturBatch([eis, kontur]);

    expect(batch?.stamp).toBe(STAMP);
    expect(batch?.rows.map((r) => r.tender.regNumber)).toEqual(["K-A"]);
  });

  it("без строк Контур партии нет", () => {
    const eis = row({ dataSource: "EIS", syncedAt: STAMP });

    expect(selectLastKonturBatch([eis])).toBeNull();
  });

  it("метки синхронизации нет — партии нет, а не «все строки Контур подряд»", () => {
    const withoutStamp = [
      row({ regNumber: "K-1", dataSource: "KONTUR", syncedAt: null }),
      row({ regNumber: "K-2", dataSource: "KONTUR" }),
    ];

    expect(selectLastKonturBatch(withoutStamp)).toBeNull();
  });

  it("пустая лента — партии нет", () => {
    expect(selectLastKonturBatch([])).toBeNull();
  });
});

describe("isNewInBatch", () => {
  it("закупка создана этим прогоном", () => {
    const created = row({ firstSeenAt: "2026-09-25T14:52:41.000Z" });

    expect(isNewInBatch(created, STAMP)).toBe(true);
  });

  it("лежала в базе до прогона", () => {
    const old = row({ firstSeenAt: "2026-09-01T09:00:00.000Z" });

    expect(isNewInBatch(old, STAMP)).toBe(false);
  });

  it("часы приложения и БД расходятся — запас в минуту это покрывает", () => {
    const skew = row({ firstSeenAt: "2026-09-25T14:51:30.000Z" });

    expect(NEW_IN_BATCH_SLACK_MS).toBe(60_000);
    expect(isNewInBatch(skew, STAMP)).toBe(true);
  });

  it("без даты первого появления закупка не называется новой", () => {
    expect(isNewInBatch(row({ firstSeenAt: null }), STAMP)).toBe(false);
    expect(isNewInBatch(row({}), STAMP)).toBe(false);
  });
});

describe("freshnessLayer", () => {
  it("строка последней партии — первый слой", () => {
    const fresh = row({ dataSource: "KONTUR", syncedAt: STAMP });

    expect(freshnessLayer(fresh, { batchStamp: STAMP, now: NOW })).toBe("LAST_RUN");
  });

  it("истёкший срок уводит в последний слой, даже из последней партии", () => {
    const expired = row({
      dataSource: "KONTUR",
      syncedAt: STAMP,
      deadlines: { ...demoTenders[0]!.deadlines, submissionEnd: EXPIRED_END },
    });

    expect(freshnessLayer(expired, { batchStamp: STAMP, now: NOW })).toBe("EXPIRED");
  });

  it("добавленная три дня назад — «на этой неделе»", () => {
    const weekOld = row({ firstSeenAt: "2026-09-22T15:00:00.000Z" });

    expect(freshnessLayer(weekOld, { batchStamp: STAMP, now: NOW })).toBe("WEEK");
  });

  it("добавленная десять дней назад — «раньше»", () => {
    const old = row({ firstSeenAt: "2026-09-15T15:00:00.000Z" });

    expect(freshnessLayer(old, { batchStamp: STAMP, now: NOW })).toBe("EARLIER");
  });

  it("граница окна считается от FRESH_WINDOW_DAYS", () => {
    const inside = row({ firstSeenAt: "2026-09-18T15:00:00.000Z" });
    const outside = row({ firstSeenAt: "2026-09-18T14:59:59.000Z" });

    expect(FRESH_WINDOW_DAYS).toBe(7);
    expect(freshnessLayer(inside, { batchStamp: STAMP, now: NOW })).toBe("WEEK");
    expect(freshnessLayer(outside, { batchStamp: STAMP, now: NOW })).toBe("EARLIER");
  });

  it("меток времени нет — «раньше», а не «на этой неделе»", () => {
    expect(
      freshnessLayer(row({ firstSeenAt: null, syncedAt: null }), {
        batchStamp: STAMP,
        now: NOW,
      }),
    ).toBe("EARLIER");
  });

  it("нет метки синхронизации, но есть дата первого появления — слой по ней", () => {
    const imported = row({ dataSource: "IMPORT", firstSeenAt: "2026-09-24T15:00:00.000Z" });

    expect(freshnessLayer(imported, { batchStamp: STAMP, now: NOW })).toBe("WEEK");
  });

  it("без партии ничего не выдумываем: свежая строка ЕИС попадает в «на этой неделе»", () => {
    const eis = row({ dataSource: "EIS", syncedAt: STAMP, firstSeenAt: STAMP });

    expect(freshnessLayer(eis, { batchStamp: null, now: NOW })).toBe("WEEK");
  });
});

describe("layerRank", () => {
  it("порядок слоёв: последний прогон, неделя, раньше, истёкшие", () => {
    expect(layerRank("LAST_RUN")).toBeLessThan(layerRank("WEEK"));
    expect(layerRank("WEEK")).toBeLessThan(layerRank("EARLIER"));
    expect(layerRank("EARLIER")).toBeLessThan(layerRank("EXPIRED"));
  });
});

describe("groupByFreshness", () => {
  const week = row({ regNumber: "W-1", firstSeenAt: "2026-09-22T15:00:00.000Z" });
  const batch = row({ regNumber: "B-1", dataSource: "KONTUR", syncedAt: STAMP });
  const earlier = row({ regNumber: "E-1", firstSeenAt: "2026-09-01T15:00:00.000Z" });
  const expired = row({
    regNumber: "X-1",
    deadlines: { ...demoTenders[0]!.deadlines, submissionEnd: EXPIRED_END },
  });

  it("раскладывает строки по слоям сверху вниз", () => {
    const groups = groupByFreshness([earlier, expired, week, batch], {
      batchStamp: STAMP,
      now: NOW,
    });

    expect(groups.map((g) => g.layer)).toEqual([
      "LAST_RUN",
      "WEEK",
      "EARLIER",
      "EXPIRED",
    ]);
  });

  it("пустых слоёв нет, а порядок строк внутри группы сохраняется", () => {
    const second = row({ regNumber: "B-2", dataSource: "KONTUR", syncedAt: STAMP });
    const groups = groupByFreshness([second, batch], { batchStamp: STAMP, now: NOW });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((r) => r.tender.regNumber)).toEqual(["B-2", "B-1"]);
  });

  it("метку партии несёт только слой последнего прогона", () => {
    const groups = groupByFreshness([batch, week], { batchStamp: STAMP, now: NOW });

    expect(groups[0]!.stamp).toBe(STAMP);
    expect(groups[1]!.stamp).toBeNull();
  });

  it("пустая лента — пустой список групп, а не группа без строк", () => {
    expect(groupByFreshness([], { batchStamp: null, now: NOW })).toEqual([]);
  });
});
