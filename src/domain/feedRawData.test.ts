import { describe, expect, it } from "vitest";
import { FEED_RAW_DATA_KEYS, trimFeedRawData, trimFeedRow } from "@/domain/feedRawData";

describe("trimFeedRawData", () => {
  it("оставляет только то, что читает лента", () => {
    const raw = {
      origin: "live",
      query: "ремонт кровли",
      keywords: ["кровля"],
      html: "<div>".repeat(1000),
      lots: [{ big: true }],
    };

    expect(trimFeedRawData(raw)).toEqual({ origin: "live", query: "ремонт кровли", keywords: ["кровля"] });
  });

  it("список ключей — ровно origin, query, keywords", () => {
    // Напоминание: читаете в клиенте новый ключ raw_data — добавьте его сюда.
    expect([...FEED_RAW_DATA_KEYS]).toEqual(["origin", "query", "keywords"]);
  });

  it("сырой ответ без нужных ключей превращается в null", () => {
    expect(trimFeedRawData({ source: "kontur", payload: { a: 1 } })).toBeNull();
  });

  it("null и undefined остаются как есть", () => {
    expect(trimFeedRawData(null)).toBeNull();
    expect(trimFeedRawData(undefined)).toBeUndefined();
  });

  it("не меняет исходный объект", () => {
    const raw = { origin: "sense", keywords: ["a"], extra: 1 };
    trimFeedRawData(raw);
    expect(raw).toEqual({ origin: "sense", keywords: ["a"], extra: 1 });
  });
});

describe("trimFeedRow", () => {
  it("урезает raw_data, остальные поля не трогает", () => {
    const row = { reg_number: "1", raw_data: { origin: "live", query: "q", junk: "x" } };
    expect(trimFeedRow(row)).toEqual({ reg_number: "1", raw_data: { origin: "live", query: "q" } });
  });

  it("строка без raw_data возвращается как есть", () => {
    const row: { reg_number: string; raw_data?: Record<string, unknown> | null } = { reg_number: "1" };
    expect(trimFeedRow(row)).toBe(row);
  });
});
