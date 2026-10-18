import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  findProceduresSitemapUrl,
  parseChunkEntries,
  parseLastmod,
  parseProcedureChunks,
  parseSitemapLocs,
  selectChunks,
  selectEntries,
} from "@/adapters/tender-source/etpgpbSitemap";
import {
  CHUNK_59_XML,
  CHUNK_60_XML,
  ETPGPB_NOW,
  PROCEDURES_SITEMAP_XML,
  SITEMAP_INDEX_XML,
  chunkUrl,
  urlset,
} from "@/adapters/tender-source/etpgpbTestFixtures";

/** Живой формат куска карты: `<url>` с нулевым отступом и вложенными `<loc>`/`<lastmod>` (19.10.2026). */
const LIVE_CHUNK_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url>
    <loc>https://etpgpb.ru/procedures/etp_click/2048431-ovoschi-solenye-i-kvashenye-kapusta-ogurtsy-tomaty-257-k2/</loc>
    <lastmod>2026-09-14T09:23:02.062+03:00</lastmod>
  </url>
<url>
    <loc>https://etpgpb.ru/procedures/price_request/1010438-naushniki-i-kolonki-dlya-kompyuterov/</loc>
    <lastmod>2026-09-17T09:00:35.971+03:00</lastmod>
  </url>
<url>
    <loc>https://etpgpb.ru/procedures/sale/1172045-zapros-predlozheniy-na-nelikvidy-spisok-2-s-ao-imz/</loc>
    <lastmod>2026-10-12T15:00:03.670+03:00</lastmod>
  </url>
</urlset>
`;

const DAYS = 21;
const LOOKBACK = DAYS * DAY_MS;

describe("индекс карт сайта", () => {
  it("находит sitemap/procedures.xml среди карт индекса", () => {
    expect(findProceduresSitemapUrl(SITEMAP_INDEX_XML)).toBe("https://etpgpb.ru/sitemap/procedures.xml");
  });

  it("площадка убрала карту процедур — null, а не догадка", () => {
    expect(findProceduresSitemapUrl(urlset([{ url: "https://etpgpb.ru/sitemap/pages.xml", lastmod: "2026-10-18" }]))).toBeNull();
  });

  it("не принимает карту процедур с чужого хоста или с query-строкой", () => {
    const evil = urlset([
      { url: "https://evil.example/sitemap/procedures.xml", lastmod: "2026-10-18" },
      { url: "https://etpgpb.ru/sitemap/procedures.xml?x=1", lastmod: "2026-10-18" },
    ]);
    expect(findProceduresSitemapUrl(evil)).toBeNull();
  });

  it("читает и `<sitemapindex>`, и `<urlset>`: площадка отдаёт список кусков как urlset", () => {
    const fromIndex = parseSitemapLocs(SITEMAP_INDEX_XML);
    expect(fromIndex).toHaveLength(5);
    expect(fromIndex[1]).toEqual({
      loc: "https://etpgpb.ru/sitemap/procedures.xml",
      lastmod: "2026-10-18T03:45:13.415+03:00",
    });
    expect(parseSitemapLocs(PROCEDURES_SITEMAP_XML)).toHaveLength(6);
  });

  it("запись без lastmod читается с пустой датой, запись без loc пропускается", () => {
    const xml = "<urlset><url><loc>https://etpgpb.ru/a</loc></url><url><lastmod>2026-10-18</lastmod></url></urlset>";
    expect(parseSitemapLocs(xml)).toEqual([{ loc: "https://etpgpb.ru/a", lastmod: null }]);
  });

  it("раскодирует сущности XML в адресе — и такой адрес потом отвергнет охрана", () => {
    const xml = "<urlset><url><loc>https://etpgpb.ru/procedures/etp/1-a/?x=1&amp;y=2</loc></url></urlset>";
    expect(parseSitemapLocs(xml)[0]?.loc).toBe("https://etpgpb.ru/procedures/etp/1-a/?x=1&y=2");
    expect(parseChunkEntries(xml, { fallbackLastmodMs: 1 })).toEqual([]);
  });
});

describe("куски карты процедур", () => {
  it("список кусков с номерами и датами", () => {
    const chunks = parseProcedureChunks(PROCEDURES_SITEMAP_XML);
    expect(chunks.map((c) => c.number)).toEqual([1, 2, 3, 58, 59, 60]);
    expect(chunks[5]).toMatchObject({
      url: chunkUrl(60),
      lastmod: "2026-10-18T03:45:13.415+03:00",
      lastmodMs: Date.parse("2026-10-18T03:45:13.415+03:00"),
    });
  });

  it("чужие и запрещённые адреса среди кусков отбрасываются", () => {
    const xml = urlset([
      { url: chunkUrl(5), lastmod: "2026-10-18" },
      { url: "https://etpgpb.ru/sitemap/procedures/procedures5.xml?x=1", lastmod: "2026-10-18" },
      { url: "https://etp.gpb.ru/sitemap/procedures/procedures6.xml", lastmod: "2026-10-18" },
      { url: "https://etpgpb.ru/sitemap/lots.xml", lastmod: "2026-10-18" },
    ]);
    expect(parseProcedureChunks(xml).map((c) => c.number)).toEqual([5]);
  });

  it("выбираются куски с датой не старше окна, самые свежие первыми", () => {
    const chunks = parseProcedureChunks(PROCEDURES_SITEMAP_XML);
    const chosen = selectChunks(chunks, { nowMs: ETPGPB_NOW, lookbackMs: LOOKBACK, maxChunks: 14 });
    expect(chosen.map((c) => c.number)).toEqual([60, 59]);
  });

  it("потолок числа кусков режет самые старые из подходящих", () => {
    const chunks = parseProcedureChunks(PROCEDURES_SITEMAP_XML);
    expect(selectChunks(chunks, { nowMs: ETPGPB_NOW, lookbackMs: LOOKBACK, maxChunks: 1 }).map((c) => c.number)).toEqual([60]);
    expect(selectChunks(chunks, { nowMs: ETPGPB_NOW, lookbackMs: LOOKBACK, maxChunks: 0 })).toEqual([]);
  });

  it("кусок без читаемой даты не качается: старых кусков 49 из 60", () => {
    const xml = urlset([
      { url: chunkUrl(7), lastmod: "не дата" },
      { url: chunkUrl(8), lastmod: "2026-10-18" },
    ]);
    const chosen = selectChunks(parseProcedureChunks(xml), { nowMs: ETPGPB_NOW, lookbackMs: LOOKBACK, maxChunks: 14 });
    expect(chosen.map((c) => c.number)).toEqual([8]);
  });
});

describe("записи куска", () => {
  it("разбирает живой формат: вид, номер, slug, дата", () => {
    const entries = parseChunkEntries(LIVE_CHUNK_HEAD, { excludeKinds: [] });
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      url: "https://etpgpb.ru/procedures/etp_click/2048431-ovoschi-solenye-i-kvashenye-kapusta-ogurtsy-tomaty-257-k2/",
      kind: "etp_click",
      id: "2048431",
      slug: "ovoschi-solenye-i-kvashenye-kapusta-ogurtsy-tomaty-257-k2",
      lastmodMs: Date.parse("2026-09-14T09:23:02.062+03:00"),
    });
  });

  it("по умолчанию пропускает продажу имущества (sale)", () => {
    const entries = parseChunkEntries(LIVE_CHUNK_HEAD);
    expect(entries.map((e) => e.kind)).toEqual(["etp_click", "price_request"]);
  });

  it("отбор по возрасту идёт при разборе", () => {
    const minLastmodMs = Date.parse("2026-09-16T00:00:00+03:00");
    const entries = parseChunkEntries(LIVE_CHUNK_HEAD, { excludeKinds: [], minLastmodMs });
    expect(entries.map((e) => e.id)).toEqual(["1010438", "1172045"]);
  });

  it("запись без даты берёт дату куска; нет и её — отбрасывается", () => {
    const xml = "<urlset><url><loc>https://etpgpb.ru/procedures/etp/5-a/</loc></url></urlset>";
    expect(parseChunkEntries(xml, { fallbackLastmodMs: 123 })[0]?.lastmodMs).toBe(123);
    expect(parseChunkEntries(xml)).toEqual([]);
  });

  it("адреса не из разрешённого набора пропускаются, повтор адреса даёт запись с поздней датой", () => {
    const xml = urlset([
      { url: "https://etpgpb.ru/procedures/etp/5-a/", lastmod: "2026-10-10T00:00:00+03:00" },
      { url: "https://etpgpb.ru/procedures/etp/5-a/", lastmod: "2026-10-12T00:00:00+03:00" },
      { url: "https://etpgpb.ru/procedures/etp/6-b/?x=1", lastmod: "2026-10-12T00:00:00+03:00" },
      { url: "https://etpgpb.ru/procedures/page/7-c/", lastmod: "2026-10-12T00:00:00+03:00" },
      { url: "https://etp.gpb.ru/procedures/etp/8-d/", lastmod: "2026-10-12T00:00:00+03:00" },
    ]);
    const entries = parseChunkEntries(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.lastmodMs).toBe(Date.parse("2026-10-12T00:00:00+03:00"));
  });
});

describe("окно просмотра", () => {
  const entries = [
    ...parseChunkEntries(CHUNK_59_XML, { excludeKinds: [] }),
    ...parseChunkEntries(CHUNK_60_XML, { excludeKinds: [] }),
  ];

  it("берёт записи не старше 21 дня, без sale, самые свежие первыми", () => {
    const window = selectEntries(entries, { nowMs: ETPGPB_NOW, lookbackMs: LOOKBACK });
    expect(window.some((e) => e.kind === "sale")).toBe(false);
    // 22.09.2026 старше границы 28.09.2026.
    expect(window.some((e) => e.slug.startsWith("postavka-goryuche-smazochnyh"))).toBe(false);
    for (let i = 1; i < window.length; i += 1) {
      expect(window[i - 1]!.lastmodMs).toBeGreaterThanOrEqual(window[i]!.lastmodMs);
    }
    expect(window[0]?.kind).toBe("etp_click");
    expect(window.map((e) => e.id)).toEqual([
      "2081479", // 17.10 19:23
      "1298399", // 17.10 18:32
      "1299773", // 17.10 15:28
      "259022", // 16.10 17:12
      "1288977", // 16.10 08:00
      "1010438", // 15.10 09:00
      "8736", // 07.10 13:41
    ]);
  });

  it("окно сдвигается вместе с «сейчас»: через десять дней старые записи выпадают", () => {
    const later = selectEntries(entries, { nowMs: ETPGPB_NOW + 10 * DAY_MS, lookbackMs: LOOKBACK });
    expect(later.some((e) => e.id === "8736")).toBe(false);
    expect(later.some((e) => e.id === "2081479")).toBe(true);
  });

  it("при равной дате первым идёт больший номер: порядок не зависит от порядка в чужом файле", () => {
    const same = urlset([
      { url: "https://etpgpb.ru/procedures/etp/10-a/", lastmod: "2026-10-17T00:00:00+03:00" },
      { url: "https://etpgpb.ru/procedures/etp/30-c/", lastmod: "2026-10-17T00:00:00+03:00" },
      { url: "https://etpgpb.ru/procedures/etp/20-b/", lastmod: "2026-10-17T00:00:00+03:00" },
    ]);
    const window = selectEntries(parseChunkEntries(same), { nowMs: ETPGPB_NOW, lookbackMs: LOOKBACK });
    expect(window.map((e) => e.id)).toEqual(["30", "20", "10"]);
  });
});

describe("parseLastmod", () => {
  it("читает дату и дату со временем, нечитаемое — null", () => {
    expect(parseLastmod("2026-10-18")).toBe(Date.parse("2026-10-18"));
    expect(parseLastmod("2026-10-18T03:45:13.415+03:00")).toBe(Date.parse("2026-10-18T00:45:13.415Z"));
    expect(parseLastmod("вчера")).toBeNull();
    expect(parseLastmod("")).toBeNull();
    expect(parseLastmod(null)).toBeNull();
  });
});
