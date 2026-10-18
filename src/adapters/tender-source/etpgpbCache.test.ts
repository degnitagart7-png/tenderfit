import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tender } from "@/domain/entities";
import {
  ETPGPB_CARD_CACHE_FILE,
  ETPGPB_SITEMAP_CACHE_FILE,
  createEtpgpbCardCache,
  createEtpgpbSitemapCache,
  type CardRecord,
  type SitemapChunkRecord,
} from "@/adapters/tender-source/etpgpbCache";
import { etpgpbCardUrl } from "@/adapters/tender-source/etpgpbUrl";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-19T09:00:00.000Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "etpgpb-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const chunk = (overrides: Partial<SitemapChunkRecord> = {}): SitemapChunkRecord => ({
  lastmod: "2026-10-18T03:45:13.415+03:00",
  cutoffMs: NOW - 21 * DAY,
  savedAt: NOW,
  entries: [
    {
      url: etpgpbCardUrl("etp", "1298399", "postavka-rashodnogo-material"),
      kind: "etp",
      id: "1298399",
      slug: "postavka-rashodnogo-material",
      lastmodMs: Date.parse("2026-10-17T18:32:03+03:00"),
    },
  ],
  ...overrides,
});

const tender = (regNumber: string): Tender =>
  ({ id: `etpgpb-${regNumber}`, regNumber, externalId: null, subject: "Тест" }) as unknown as Tender;

const card = (overrides: Partial<CardRecord> = {}): CardRecord => ({
  lastmodMs: 1,
  fetchedAt: NOW,
  accepting: true,
  tender: tender("ETPGPB-1"),
  ...overrides,
});

describe("кэш кусков карты сайта", () => {
  const URL_60 = "https://etpgpb.ru/sitemap/procedures/procedures60.xml";

  it("записанное читается другим экземпляром: адрес карточки собирается из вида, номера и slug", () => {
    const writer = createEtpgpbSitemapCache(dir);
    writer.set(URL_60, chunk());
    expect(writer.flush(NOW)).toBe(true);

    const reader = createEtpgpbSitemapCache(dir);
    const record = reader.get(URL_60);
    expect(record?.lastmod).toBe("2026-10-18T03:45:13.415+03:00");
    expect(record?.entries[0]?.url).toBe(
      "https://etpgpb.ru/procedures/etp/1298399-postavka-rashodnogo-material/",
    );
    expect(record?.entries[0]?.lastmodMs).toBe(Date.parse("2026-10-17T18:32:03+03:00"));
  });

  it("без каталога кэш живёт только в памяти и на диск не пишет", () => {
    const cache = createEtpgpbSitemapCache(null);
    cache.set(URL_60, chunk());
    expect(cache.get(URL_60)).toBeDefined();
    expect(cache.flush(NOW)).toBe(true);
  });

  it.each([
    ["нет файла", undefined],
    ["пустой файл", ""],
    ["мусор вместо JSON", "{oops"],
    ["массив вместо объекта", "[]"],
    ["чужая версия формата", JSON.stringify({ schema: 999, chunks: {} })],
    ["записи не того вида", JSON.stringify({ schema: 1, chunks: { [URL_60]: { lastmod: "x", cutoffMs: 1, savedAt: 1, entries: [[1, 2, 3]] } } })],
    ["кусок не объект", JSON.stringify({ schema: 1, chunks: { [URL_60]: 5 } })],
  ])("битый кэш — это отсутствие кэша, а не исключение: %s", (_name, body) => {
    if (body !== undefined) writeFileSync(join(dir, ETPGPB_SITEMAP_CACHE_FILE), body);
    const cache = createEtpgpbSitemapCache(dir);
    expect(cache.get(URL_60)).toBeUndefined();
    // И дальше работает: поверх мусора пишется нормальный файл.
    cache.set(URL_60, chunk());
    expect(cache.flush(NOW)).toBe(true);
    expect(createEtpgpbSitemapCache(dir).get(URL_60)).toBeDefined();
  });

  it("запись сливается с чужой: параллельный прогон не затирает чужие куски", () => {
    const first = createEtpgpbSitemapCache(dir);
    const second = createEtpgpbSitemapCache(dir);
    first.get(URL_60);
    second.get(URL_60);
    first.set("https://etpgpb.ru/sitemap/procedures/procedures59.xml", chunk());
    second.set(URL_60, chunk());
    first.flush(NOW);
    second.flush(NOW);
    const merged = createEtpgpbSitemapCache(dir);
    expect(merged.get("https://etpgpb.ru/sitemap/procedures/procedures59.xml")).toBeDefined();
    expect(merged.get(URL_60)).toBeDefined();
  });

  it("куски старше месяца выбрасываются из файла", () => {
    const cache = createEtpgpbSitemapCache(dir);
    cache.set(URL_60, chunk({ savedAt: NOW - 40 * DAY }));
    cache.set("https://etpgpb.ru/sitemap/procedures/procedures59.xml", chunk());
    cache.flush(NOW);
    const after = createEtpgpbSitemapCache(dir);
    expect(after.get(URL_60)).toBeUndefined();
    expect(after.get("https://etpgpb.ru/sitemap/procedures/procedures59.xml")).toBeDefined();
  });

  it("некуда писать — flush возвращает false и не бросает", () => {
    const blocker = join(dir, "file-not-dir");
    writeFileSync(blocker, "x");
    const cache = createEtpgpbSitemapCache(join(blocker, "nested"));
    cache.set(URL_60, chunk());
    expect(cache.flush(NOW)).toBe(false);
    expect(cache.get(URL_60)).toBeDefined();
  });
});

describe("кэш карточек", () => {
  const URL_A = "https://etpgpb.ru/procedures/etp/1-a/";
  const URL_B = "https://etpgpb.ru/procedures/etp/2-b/";

  it("запись читается другим экземпляром вместе с признаком «идёт ли приём» и отрицательным результатом", () => {
    const writer = createEtpgpbCardCache({ dir });
    writer.set(URL_A, card({ lastmodMs: 111, accepting: false }));
    writer.set(URL_B, card({ tender: null }));
    expect(writer.flush(NOW)).toBe(true);

    const reader = createEtpgpbCardCache({ dir });
    expect(reader.get(URL_A)).toMatchObject({ lastmodMs: 111, accepting: false, tender: { regNumber: "ETPGPB-1" } });
    expect(reader.get(URL_B)?.tender).toBeNull();
  });

  it.each([
    ["мусор", "{oops"],
    ["чужая версия", JSON.stringify({ schema: 999, cards: {} })],
    ["запись без признака приёма", JSON.stringify({ schema: 1, cards: { [URL_A]: { lastmodMs: 1, fetchedAt: 1, tender: null } } })],
    ["закупка без номера", JSON.stringify({ schema: 1, cards: { [URL_A]: { lastmodMs: 1, fetchedAt: 1, accepting: true, tender: {} } } })],
  ])("битый кэш карточек — отсутствие кэша: %s", (_name, body) => {
    writeFileSync(join(dir, ETPGPB_CARD_CACHE_FILE), body);
    expect(createEtpgpbCardCache({ dir }).get(URL_A)).toBeUndefined();
  });

  it("при слиянии побеждает более свежее чтение карточки", () => {
    const old = createEtpgpbCardCache({ dir });
    old.set(URL_A, card({ fetchedAt: NOW - 1000, lastmodMs: 1 }));
    const fresh = createEtpgpbCardCache({ dir });
    fresh.set(URL_A, card({ fetchedAt: NOW, lastmodMs: 2 }));
    fresh.flush(NOW);
    old.flush(NOW);
    expect(createEtpgpbCardCache({ dir }).get(URL_A)?.lastmodMs).toBe(2);
  });

  it("записи старше срока хранения и сверх потолка выбрасываются, самые свежие остаются", () => {
    const cache = createEtpgpbCardCache({ dir, retainMs: 2 * DAY, maxEntries: 2 });
    cache.set("https://etpgpb.ru/procedures/etp/10-a/", card({ fetchedAt: NOW - 3 * DAY }));
    cache.set("https://etpgpb.ru/procedures/etp/11-a/", card({ fetchedAt: NOW - 3000 }));
    cache.set("https://etpgpb.ru/procedures/etp/12-a/", card({ fetchedAt: NOW - 2000 }));
    cache.set("https://etpgpb.ru/procedures/etp/13-a/", card({ fetchedAt: NOW - 1000 }));
    cache.flush(NOW);
    const after = createEtpgpbCardCache({ dir });
    expect([...after.values()].map(([url]) => url).sort()).toEqual([
      "https://etpgpb.ru/procedures/etp/12-a/",
      "https://etpgpb.ru/procedures/etp/13-a/",
    ]);
  });

  it("в файл попадает только очищенная закупка: никаких сырых полей карточки", () => {
    const cache = createEtpgpbCardCache({ dir });
    cache.set(URL_A, card());
    cache.flush(NOW);
    const text = readFileSync(join(dir, ETPGPB_CARD_CACHE_FILE), "utf-8");
    expect(text).not.toMatch(/contact|email|phone|body_email/i);
  });

  it("без записей flush ничего не пишет", () => {
    const cache = createEtpgpbCardCache({ dir });
    expect(cache.flush(NOW)).toBe(true);
    expect(() => readFileSync(join(dir, ETPGPB_CARD_CACHE_FILE))).toThrow();
  });
});
