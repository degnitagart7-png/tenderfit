import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BimIndicesData } from "../../src/domain/estimate/bimIndicesTypes";
import { parseDocNodes, quarterOfNodeName, yearOfNodeName } from "../../src/lib/fsnb/fgisBimApi";
import {
  collectLetters,
  latestQuarter,
  letterIdOf,
  listBimIndexFiles,
  parseFetchArgs,
  pdftotextExtractor,
  requisitesOfName,
  runFetch,
  type FetchOptions,
  type TextExtractor,
  type TreeLetter,
} from "./fetch-bim-indices";
import type { Downloader } from "./fetch-zone";

/*
  Обход дерева ФГИС ЦС и сборка файла квартала проверены на поддельном дереве: сеть до ФГИС ЦС доступна только с
  российского сервера. Тексты «скачанных» писем — сохранённые письма III квартала 2026 года, поэтому сборка на
  них даёт тот же справочник, что и локальная.
*/

const SOURCES = resolve("data/fsnb/normatives/sources");
const text = (id: string): string => readFileSync(resolve(SOURCES, `bim-indices-2026q3-${id}.txt`), "utf8");

interface Node {
  readonly guid: string;
  readonly name: string;
  readonly filePath?: string;
  readonly date?: string;
  readonly number?: string;
}

/** Корень → годы → кварталы → «по объектам строительства» / «по субъектам» → письма. */
const TREE: Record<string, Node[]> = {
  root: [
    { guid: "y2025", name: "2025 год" },
    { guid: "y2026", name: "2026 год" },
  ],
  y2025: [{ guid: "q2025-4", name: "IV квартал 2025 года" }],
  "q2025-4": [{ guid: "o2025-4", name: "по объектам строительства" }],
  "o2025-4": [{ guid: "l-old", name: "письмо 2025", filePath: "00000000-old", date: "2025-10-20", number: "1-ИФ/09" }],
  y2026: [
    { guid: "q2026-2", name: "II квартал 2026 года" },
    { guid: "q2026-3", name: "III квартал 2026 года" },
  ],
  "q2026-2": [{ guid: "o2026-2", name: "по объектам строительства" }],
  "o2026-2": [{ guid: "l-q2", name: "письмо II кв.", filePath: "00000000-q2", date: "2026-04-20", number: "2-ИФ/09" }],
  "q2026-3": [
    { guid: "o2026-3", name: "по объектам строительства" },
    { guid: "s2026-3", name: "по субъектам Российской Федерации" },
  ],
  "o2026-3": [
    { guid: "l1", name: "О рекомендуемой величине индексов от 23.07.2026 № 45358-ИФ/09", filePath: "d465eb3f-8c79-4289-a7bd-3765632b7c69", date: "2026-07-23", number: "45358-ИФ/09" },
    { guid: "l2", name: "Индексы от 30.07.2026 № 46728-ИФ/09", filePath: "4a127ad8-256f-49d4-9d3c-03cb5048d168" },
  ],
  "s2026-3": [{ guid: "l-subj", name: "письмо по субъектам", filePath: "ffffffff-subj" }],
};

interface Harness {
  readonly download: Downloader;
  readonly extract: TextExtractor;
  readonly calls: string[];
  readonly log: string[];
}

function harness(tree: Record<string, Node[]> = TREE, files: Record<string, string> = { "d465eb3f": text("d465eb3f"), "4a127ad8": text("4a127ad8") }): Harness {
  const calls: string[] = [];
  const log: string[] = [];
  const download: Downloader = async (url, kind) => {
    calls.push(url);
    if (url.includes("NormLegalDocPublished")) {
      const parent = /parentGuid=([^&]+)/.exec(url)?.[1] ?? "root";
      return Buffer.from(JSON.stringify(tree[decodeURIComponent(parent)] ?? []));
    }
    const path = url.split("/GetFileContent/")[1] ?? "";
    expect(kind).toBe("pdf");
    return Buffer.from(`%PDF-1.4 ${path.slice(0, 8)}`);
  };
  const extract: TextExtractor = async (pdf) => {
    const id = Buffer.from(pdf).toString("latin1").slice(-8);
    const found = files[id];
    if (found === undefined) throw new Error(`нет текста для ${id}`);
    return found;
  };
  return { download, extract, calls, log };
}

let indexDir = "";
beforeEach(() => {
  indexDir = mkdtempSync(join(tmpdir(), "bim-fetch-"));
});
afterEach(() => {
  rmSync(indexDir, { recursive: true, force: true });
});

const options = (patch: Partial<FetchOptions> = {}): FetchOptions => ({
  indexDir,
  startGuid: null,
  year: null,
  quarter: null,
  force: false,
  dryRun: false,
  dumpDepth: null,
  pauseMs: 0,
  ...patch,
});

describe("узлы дерева", () => {
  it("список узлов терпим к форме ответа: массив, items/data, разные имена полей", () => {
    expect(parseDocNodes([{ guid: "a", name: "2026", filePath: "" }])).toEqual([{ guid: "a", name: "2026", filePath: null, date: null, number: null }]);
    expect(parseDocNodes({ items: [{ id: "b", title: "письмо", filePath: "x/y", number: "1-ИФ/09" }] })[0]).toMatchObject({ guid: "b", name: "письмо", filePath: "x/y", number: "1-ИФ/09" });
    // Живой формат ФГИС ЦС: массив под пустым ключом.
    expect(parseDocNodes({ "": [{ guid: "8b89677f", name: "2026 г.", filePath: null }] })).toEqual([
      { guid: "8b89677f", name: "2026 г.", filePath: null, date: null, number: null },
    ]);
    expect(parseDocNodes({ data: [{ id: "c", shortName: "III квартал" }] })).toHaveLength(1);
    expect(parseDocNodes("мусор")).toEqual([]);
    expect(parseDocNodes([42, null, {}])).toEqual([]);
  });

  it("квартал и год из имени узла", () => {
    expect(quarterOfNodeName("III квартал 2026 года")).toBe(3);
    expect(quarterOfNodeName("3 квартал")).toBe(3);
    expect(quarterOfNodeName("IV кв. 2025")).toBe(4);
    expect(quarterOfNodeName("по объектам строительства")).toBeNull();
    expect(yearOfNodeName("2026 год")).toBe(2026);
    expect(yearOfNodeName("письмо № 12345")).toBeNull();
  });

  it("реквизиты письма — из имени узла", () => {
    expect(requisitesOfName("О рекомендуемой величине индексов от 23.07.2026 № 45358-ИФ/09")).toEqual({ date: "2026-07-23", number: "45358-ИФ/09" });
    expect(requisitesOfName("без реквизитов")).toEqual({ date: null, number: null });
  });
});

describe("обход дерева", () => {
  it("берёт письма только из «по объектам строительства» нужного квартала", async () => {
    const h = harness();
    const letters = await collectLetters({ download: h.download, log: () => undefined, startGuid: null, year: 2026, quarter: 3, dumpDepth: null });
    expect(letters.map((letter) => letter.node.guid)).toEqual(["l1", "l2"]);
    expect(letters.every((letter) => letter.path.join("/") === "2026 год/III квартал 2026 года/по объектам строительства")).toBe(true);
    // чужие годы и кварталы не открывались
    expect(h.calls.some((url) => url.includes("o2026-2") || url.includes("o2025-4"))).toBe(false);
  });

  it("без указанного квартала находит все письма, а последний квартал выбирается по пути", async () => {
    const h = harness();
    const letters = await collectLetters({ download: h.download, log: () => undefined, startGuid: null, year: null, quarter: null, dumpDepth: null });
    expect(letters.map((letter) => letter.node.guid).sort()).toEqual(["l-old", "l-q2", "l1", "l2"]);
    expect(latestQuarter(letters)).toEqual({ year: 2026, quarter: 3 });
    expect(latestQuarter([])).toBeNull();
  });

  it("нет папки «по объектам строительства» — обходится весь квартал, и это в журнале", async () => {
    const tree: Record<string, Node[]> = {
      root: [{ guid: "q", name: "III квартал 2026 года" }],
      q: [{ guid: "other", name: "Письма Минстроя" }],
      other: [{ guid: "l", name: "письмо", filePath: "abcdef12-0000" }],
    };
    const h = harness(tree);
    const log: string[] = [];
    const letters = await collectLetters({ download: h.download, log: (m) => log.push(m), startGuid: null, year: null, quarter: null, dumpDepth: null });
    expect(letters).toHaveLength(1);
    expect(log.join("\n")).toContain("не нашлось");
  });

  it("--dump-tree печатает то, что вернул сервер, и ничего не скачивает", async () => {
    const h = harness();
    const log: string[] = [];
    const outcome = await runFetch(options({ dumpDepth: 3 }), { download: h.download, extract: h.extract, log: (m) => log.push(m) });
    expect(outcome.status).toBe("dumped");
    expect(log.join("\n")).toContain("[папка] III квартал 2026 года");
    expect(h.calls.some((url) => url.includes("GetFileContent"))).toBe(false);
  });

  it("идентификатор письма — первые 8 знаков имени файла", () => {
    const letter: TreeLetter = { node: { guid: "g", name: "n", filePath: "d465eb3f-8c79-4289-a7bd-3765632b7c69", date: null, number: null }, path: [], year: 2026, quarter: 3 };
    expect(letterIdOf(letter)).toBe("d465eb3f");
  });
});

describe("сборка файла квартала", () => {
  it("скачивает письма, разбирает и пишет bim-indices-2026q3.json с письмами и источниками", async () => {
    const h = harness();
    const log: string[] = [];
    const outcome = await runFetch(options(), { download: h.download, extract: h.extract, log: (m) => log.push(m) });
    expect(outcome.status).toBe("built");
    const files = listBimIndexFiles(indexDir);
    expect(files.map((file) => file.split("/").pop())).toEqual(["bim-indices-2026q3.json"]);
    const data = JSON.parse(readFileSync(files[0] as string, "utf8")) as BimIndicesData;
    expect(data.quarter).toEqual({ year: 2026, quarter: 3 });
    expect(data.letters.map((letter) => letter.number)).toEqual(["45358-ИФ/09", "46728-ИФ/09"]);
    expect(data.elements.find((record) => record.subject === "Белгородская область" && record.base === "FER" && record.object === "Многоквартирные жилые дома: Кирпичные")).toMatchObject({
      labour: 47.58,
      materials: 9.58,
      machines: 15.15,
    });
    // тексты писем сохранены рядом: разбор можно повторить без сети
    expect(readdirSync(join(indexDir, "bim-indices", "sources")).sort()).toEqual(["bim-indices-2026q3-4a127ad8.txt", "bim-indices-2026q3-d465eb3f.txt"]);
    // письмо «по субъектам» не скачивалось
    expect(h.calls.some((url) => url.includes("ffffffff"))).toBe(false);
  });

  it("ночной повтор без новых писем ничего не скачивает; новое письмо и --force пересобирают", async () => {
    const h = harness();
    await runFetch(options(), { download: h.download, extract: h.extract, log: () => undefined });
    const before = h.calls.filter((url) => url.includes("GetFileContent")).length;
    expect(before).toBe(2);

    const again = await runFetch(options(), { download: h.download, extract: h.extract, log: () => undefined });
    expect(again.status).toBe("up-to-date");
    expect(h.calls.filter((url) => url.includes("GetFileContent")).length).toBe(before);

    const forced = await runFetch(options({ force: true }), { download: h.download, extract: h.extract, log: () => undefined });
    expect(forced.status).toBe("built");
    expect(h.calls.filter((url) => url.includes("GetFileContent")).length).toBe(before + 2);

    const grown = harness(
      { ...TREE, "o2026-3": [...(TREE["o2026-3"] as Node[]), { guid: "l3", name: "Индексы от 13.08.2026 № 50058-ИФ/09", filePath: "862c733b-d85e-4992-885a-554a72e10675" }] },
      { d465eb3f: text("d465eb3f"), "4a127ad8": text("4a127ad8"), "862c733b": text("862c733b") },
    );
    const outcome = await runFetch(options(), { download: grown.download, extract: grown.extract, log: () => undefined });
    expect(outcome.status).toBe("built");
    const data = JSON.parse(readFileSync(listBimIndexFiles(indexDir)[0] as string, "utf8")) as BimIndicesData;
    expect(data.letters).toHaveLength(3);
    expect(data.letters.find((letter) => letter.id === "862c733b")).toMatchObject({ number: "50058-ИФ/09", date: "2026-08-13" });
  });

  it("--dry-run показывает план и не пишет", async () => {
    const h = harness();
    const outcome = await runFetch(options({ dryRun: true }), { download: h.download, extract: h.extract, log: () => undefined });
    expect(outcome).toMatchObject({ status: "planned", quarter: { year: 2026, quarter: 3 }, letters: ["d465eb3f", "4a127ad8"] });
    expect(existsSync(join(indexDir, "bim-indices"))).toBe(false);
  });

  it("сломанный разбор не затирает прежний файл: записей стало меньше 70 %", async () => {
    const good = harness();
    await runFetch(options(), { download: good.download, extract: good.extract, log: () => undefined });
    const path = listBimIndexFiles(indexDir)[0] as string;
    const before = readFileSync(path, "utf8");

    const broken = harness(TREE, { d465eb3f: text("d465eb3f").slice(0, 120_000), "4a127ad8": text("4a127ad8") });
    const outcome = await runFetch(options({ force: true }), { download: broken.download, extract: broken.extract, log: () => undefined });
    expect(outcome.status).toBe("rejected");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("почти пустой текст (скан без текстового слоя) — ошибка, файла нет", async () => {
    const h = harness(TREE, { d465eb3f: "ничего", "4a127ad8": "ничего" });
    await expect(runFetch(options(), { download: h.download, extract: h.extract, log: () => undefined })).rejects.toThrow(/почти пустой текст/);
    expect(listBimIndexFiles(indexDir)).toEqual([]);
  });

  it("квартала в дереве нет — внятная причина с подсказкой про --dump-tree", async () => {
    const h = harness({ root: [{ guid: "x", name: "Разное" }], x: [] });
    const outcome = await runFetch(options(), { download: h.download, extract: h.extract, log: () => undefined });
    expect(outcome).toMatchObject({ status: "no-letters" });
    expect((outcome as { reason: string }).reason).toContain("--dump-tree");
  });
});

describe("запуск", () => {
  it("аргументы", () => {
    const parsed = parseFetchArgs(["--year", "2026", "--quarter", "3", "--force", "--index", "/tmp/i", "--guid", "abc", "--pause", "0", "--dry-run"]);
    expect(parsed).toMatchObject({ year: 2026, quarter: 3, force: true, indexDir: "/tmp/i", startGuid: "abc", pauseMs: 0, dryRun: true, dumpDepth: null });
    expect(parseFetchArgs(["--dump-tree"]).dumpDepth).toBe(3);
    expect(parseFetchArgs(["--dump-tree", "--depth", "5"]).dumpDepth).toBe(5);
    expect(() => parseFetchArgs(["--year", "2026"])).toThrow(/вместе/);
    expect(() => parseFetchArgs(["--quarter", "7", "--year", "2026"])).toThrow(/от 1 до 4/);
    expect(() => parseFetchArgs(["--зачем"])).toThrow(/Неизвестный флаг/);
  });

  it("нет pdftotext — понятная ошибка с командой установки", async () => {
    await expect(pdftotextExtractor("/nonexistent/pdftotext-binary")(Buffer.from("%PDF-1.4"))).rejects.toThrow(/poppler-utils/);
  });
});
