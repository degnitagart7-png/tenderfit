import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serviceFileUrls, wagesPageUrl, zoneFileUrls } from "../../src/lib/fsnb/fgisZoneApi";
import { fetchZoneRaw, type Downloader } from "./fetch-zone";

/*
  Скачивание сырья зоны на подменённом `download`: имена файлов, паспорт сырья, обязательные и
  необязательные файлы. Настоящие запросы идут только с российского адреса.
*/

let rawRoot = "";
beforeEach(async () => {
  rawRoot = await mkdtemp(join(tmpdir(), "fetch-zone-"));
});
afterEach(async () => {
  await rm(rawRoot, { recursive: true, force: true });
});

const ID = 246;
const PERIOD = { id: 427, name: "3 квартал 2026 г." };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function downloader(options: { failing?: readonly string[] } = {}): Downloader & { urls: string[] } {
  const urls: string[] = [];
  const files = zoneFileUrls(ID, PERIOD.id);
  const services = serviceFileUrls(ID, PERIOD.id);
  const download = async (url: string): Promise<Uint8Array> => {
    urls.push(url);
    for (const failing of options.failing ?? []) if (url === failing) throw new Error("ФГИС ЦС ответил 404.");
    if (url === files.fscsr) return bytes("fscsr");
    if (url === files.split) return bytes("split");
    if (url === services.transport) return bytes("transport");
    if (url === services.load) return bytes("load");
    if (url === wagesPageUrl(ID, PERIOD.id, 1)) return bytes(JSON.stringify({ total: 2, items: [{ id: 1, code: "1-100-10", salary: "416.29" }, { id: 2, code: "1-100-20", salary: "598.26" }] }));
    throw new Error(`неожиданный запрос ${url}`);
  };
  return Object.assign(download, { urls });
}

const run = (download: Downloader) => fetchZoneRaw(ID, "Иркутская область (1 зона)", { download, rawRoot, periodChoice: PERIOD, log: () => undefined });

describe("fetchZoneRaw", () => {
  it("скачивает пять файлов: три обязательных и две таблицы автотранспорта; адреса в паспорте сырья", async () => {
    const download = downloader();

    const fetched = await run(download);

    expect(fetched).toMatchObject({ priceZoneId: ID, periodId: 427, dir: join(rawRoot, "246", "427"), warnings: [] });
    for (const name of ["fscsr.xlsx", "split.xlsx", "wages.json", "transport-auto.xlsx", "load-auto.xlsx", "meta.json"]) {
      expect(existsSync(join(fetched.dir, name))).toBe(true);
    }
    expect(readFileSync(join(fetched.dir, "transport-auto.xlsx"), "utf8")).toBe("transport");
    const meta = JSON.parse(readFileSync(join(fetched.dir, "meta.json"), "utf8")) as { urls: Record<string, string>; files: Record<string, { bytes: number }>; warnings?: string[] };
    expect(meta.urls.transport).toBe(serviceFileUrls(ID, 427).transport);
    expect(meta.urls.load).toBe(serviceFileUrls(ID, 427).load);
    expect(meta.files["transport-auto.xlsx"]).toEqual({ bytes: 9 });
    expect(meta.warnings).toBeUndefined();
    // Только автомобильные выгрузки: железнодорожных, водных и воздушных запросов нет.
    expect(download.urls.some((url) => /Rail|Water|Air/.test(url))).toBe(false);
  });

  it("перевозка не скачалась — это предупреждение: зона собирается без неё, а ставки и сплит-форма на месте", async () => {
    const failing = serviceFileUrls(ID, PERIOD.id).transport;
    const fetched = await run(downloader({ failing: [failing] }));

    expect(fetched.warnings).toHaveLength(1);
    expect(fetched.warnings[0]).toContain("transport-auto.xlsx");
    expect(existsSync(join(fetched.dir, "transport-auto.xlsx"))).toBe(false);
    expect(existsSync(join(fetched.dir, "load-auto.xlsx"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(fetched.dir, "meta.json"), "utf8")) as { warnings: string[] };
    expect(meta.warnings[0]).toContain("ФГИС ЦС ответил 404");
  });

  it("сплит-форма не скачалась — отказ: зона без неё не собирается", async () => {
    await expect(run(downloader({ failing: [zoneFileUrls(ID, PERIOD.id).split] }))).rejects.toThrow("ФГИС ЦС ответил 404");
  });
});
