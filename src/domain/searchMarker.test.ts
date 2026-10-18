import { describe, expect, it } from "vitest";
import type { TenderRow } from "@/domain/filtering";
import {
  SEARCH_MARKER_TTL_MS,
  loadSearchMarker,
  parseSearchMarker,
  rowsFromSearch,
  saveSearchMarker,
  clearSearchMarker,
  SEARCH_MARKER_KEY,
  FEED_SEEN_KEY,
  resetFeedSeenForTests,
  rowsNewSince,
  searchFreshSince,
  takeFeedSeen,
  type SearchMarker,
} from "@/domain/searchMarker";

function row(id: string, patch: { firstSeenAt?: string | null; liveQuery?: string | null }): TenderRow {
  return {
    tender: { id, firstSeenAt: patch.firstSeenAt ?? null, liveQuery: patch.liveQuery ?? null },
  } as unknown as TenderRow;
}

const marker: SearchMarker = { kind: "live", startedAt: "2026-10-12T10:00:00.000Z", queries: ["Ремонт кровли"] };

describe("rowsFromSearch", () => {
  it("новые — те, что появились в базе не раньше начала поиска", () => {
    const rows = [
      row("new", { firstSeenAt: "2026-10-12T10:05:00.000Z" }),
      row("old", { firstSeenAt: "2026-10-10T10:05:00.000Z" }),
    ];
    const { fresh, known } = rowsFromSearch(rows, marker);
    expect(fresh.map((r) => r.tender.id)).toEqual(["new"]);
    expect(known).toEqual([]);
  });

  it("допуск на часы: строка, записанная чуть раньше нажатия по часам браузера, тоже новая", () => {
    const rows = [row("skew", { firstSeenAt: "2026-10-12T09:59:10.000Z" })];
    expect(rowsFromSearch(rows, marker).fresh).toHaveLength(1);
  });

  it("лежавшая строка с тем же живым запросом — известная, регистр и пробелы не важны", () => {
    const rows = [row("known", { firstSeenAt: "2026-10-01T00:00:00Z", liveQuery: "  ремонт  КРОВЛИ " })];
    const { fresh, known } = rowsFromSearch(rows, marker);
    expect(fresh).toEqual([]);
    expect(known.map((r) => r.tender.id)).toEqual(["known"]);
  });

  it("чужой живой запрос в результат не попадает", () => {
    const rows = [row("other", { firstSeenAt: "2026-10-01T00:00:00Z", liveQuery: "вентиляция" })];
    const { fresh, known } = rowsFromSearch(rows, marker);
    expect(fresh.length + known.length).toBe(0);
  });

  it("строка без метки времени не считается новой", () => {
    expect(rowsFromSearch([row("x", {})], marker).fresh).toEqual([]);
  });

  it("у «Найти новые закупки» запроса нет — только новые по времени", () => {
    const full: SearchMarker = { kind: "full", startedAt: marker.startedAt, queries: [] };
    const rows = [row("a", { firstSeenAt: "2026-10-12T10:30:00Z" }), row("b", { liveQuery: "ремонт кровли" })];
    const { fresh, known } = rowsFromSearch(rows, full);
    expect(fresh.map((r) => r.tender.id)).toEqual(["a"]);
    expect(known).toEqual([]);
  });
});

describe("parseSearchMarker и память браузера", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");

  it("корректная отметка разбирается", () => {
    expect(parseSearchMarker(marker, now)).toEqual(marker);
  });

  it("старше суток — просрочена", () => {
    const old = { ...marker, startedAt: new Date(now - SEARCH_MARKER_TTL_MS - 1000).toISOString() };
    expect(parseSearchMarker(old, now)).toBeNull();
  });

  it("мусор отбрасывается", () => {
    expect(parseSearchMarker(null, now)).toBeNull();
    expect(parseSearchMarker({ kind: "x", startedAt: marker.startedAt }, now)).toBeNull();
    expect(parseSearchMarker({ kind: "live", startedAt: "не дата" }, now)).toBeNull();
  });

  it("сохраняется и читается, стирается", () => {
    localStorage.clear();
    const fresh: SearchMarker = { ...marker, startedAt: new Date().toISOString() };
    saveSearchMarker(fresh);
    expect(loadSearchMarker()).toEqual(fresh);
    clearSearchMarker();
    expect(loadSearchMarker()).toBeNull();
  });

  it("просроченная отметка стирается при чтении", () => {
    localStorage.setItem(SEARCH_MARKER_KEY, JSON.stringify({ ...marker, startedAt: "2020-01-01T00:00:00Z" }));
    expect(loadSearchMarker()).toBeNull();
    expect(localStorage.getItem(SEARCH_MARKER_KEY)).toBeNull();
  });

  it("битый JSON — отметки нет, а не исключение", () => {
    localStorage.setItem(SEARCH_MARKER_KEY, "{не json");
    expect(loadSearchMarker()).toBeNull();
  });
});

describe("новое для человека: с прошлого визита", () => {
  const startedAt = "2026-10-15T10:00:00.000Z";

  it("закупка, собранная плановым прогоном после прошлого визита, — тоже результат поиска", () => {
    const marker: SearchMarker = { kind: "full", startedAt, queries: [], seenBefore: "2026-10-15T06:00:00.000Z" };
    const rows = [
      row("since-visit", { firstSeenAt: "2026-10-15T08:00:00.000Z" }),
      row("before-visit", { firstSeenAt: "2026-10-14T20:00:00.000Z" }),
    ];
    expect(rowsFromSearch(rows, marker).fresh.map((r) => r.tender.id)).toEqual(["since-visit"]);
  });

  it("прошлый визит глубже недели не учитывается, позже начала поиска — тоже", () => {
    const old: SearchMarker = { kind: "full", startedAt, queries: [], seenBefore: "2026-09-01T00:00:00.000Z" };
    expect(searchFreshSince(old)).toBe(Date.parse(startedAt) - 7 * 24 * 60 * 60_000);
    const later: SearchMarker = { kind: "full", startedAt, queries: [], seenBefore: "2026-10-15T11:00:00.000Z" };
    expect(searchFreshSince(later)).toBe(Date.parse(startedAt) - 2 * 60_000);
  });

  it("seenBefore переживает сохранение отметки", () => {
    const now = Date.parse(startedAt) + 60_000;
    expect(parseSearchMarker({ kind: "live", startedAt, queries: ["кровля"], seenBefore: "2026-10-15T06:00:00.000Z" }, now))
      .toEqual({ kind: "live", startedAt, queries: ["кровля"], seenBefore: "2026-10-15T06:00:00.000Z" });
  });

  it("rowsNewSince: строки после момента; без момента — пусто", () => {
    const rows = [row("a", { firstSeenAt: "2026-10-15T08:00:00.000Z" }), row("b", { firstSeenAt: null })];
    expect([...rowsNewSince(rows, Date.parse("2026-10-15T07:00:00.000Z"))]).toEqual(["a"]);
    expect(rowsNewSince(rows, null).size).toBe(0);
  });

  it("takeFeedSeen: отдаёт прошлый визит, отмечает нынешний и не сдвигается в той же загрузке", () => {
    resetFeedSeenForTests();
    const now = Date.parse(startedAt);
    localStorage.setItem(FEED_SEEN_KEY, "2026-10-14T10:00:00.000Z");
    expect(takeFeedSeen(now)).toBe("2026-10-14T10:00:00.000Z");
    expect(localStorage.getItem(FEED_SEEN_KEY)).toBe(startedAt);
    expect(takeFeedSeen(now + 1000)).toBe("2026-10-14T10:00:00.000Z");
    resetFeedSeenForTests();
    localStorage.removeItem(FEED_SEEN_KEY);
    expect(takeFeedSeen(now)).toBeNull();
    resetFeedSeenForTests();
  });
});
