import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArchiveRefusedError } from "@/services/archiveReaders";
import {
  concatFiles,
  detectArchiveCli,
  extractArchive,
  listExtractedEntries,
  makeTempDir,
  MAX_DISK_ARCHIVE_UNCOMPRESSED,
  parseSevenZipListing,
  parseUnrarListing,
  type ArchiveCli,
  type CliRunner,
  type CliRunResult,
} from "@/services/archiveCli";
import {
  MAX_ARCHIVE_ENTRIES,
  parseArchiveVolumeFiles,
  parseAttachment,
  parseAttachmentFile,
} from "@/services/attachmentParser";
import { CommandMissingError } from "@/services/ocr";

/**
 * Распаковка через 7z и unrar. Настоящие программы здесь не запускаются: запуск
 * подменяет порт, который «распаковывает» заданные файлы в настоящий временный
 * каталог — так проверяются и аргументы команд, и уборка диска.
 */

const REAL_TEXT = "Проект контракта: срок поставки 30 календарных дней, оплата в течение 15 рабочих дней.";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tenderfit-cli-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Call {
  file: string;
  args: string[];
  timeoutMs: number;
}

interface FakeOptions {
  /** Что «распаковать»: относительное имя → содержимое. */
  files?: Record<string, string>;
  /** Вывод команды просмотра состава. */
  listing?: string;
  /** Код возврата распаковки. */
  extractCode?: number;
  extractOutput?: string;
  /** Программы, которых «нет»: запуск отвечает CommandMissingError. */
  missing?: string[];
}

function fakeCli(options: FakeOptions = {}) {
  const calls: Call[] = [];
  /** Что лежало по пути архива в момент запуска распаковки. */
  const archiveAtExtract: Buffer[] = [];
  const outDirs: string[] = [];

  const run: CliRunner = async (file, args, { timeoutMs }): Promise<CliRunResult> => {
    calls.push({ file, args: [...args], timeoutMs });
    if (options.missing?.includes(file)) throw new CommandMissingError(file);

    const isList = args[0] === "l" || args[0] === "lt";
    if (isList) {
      return { code: 0, stdout: options.listing ?? "", stderr: "" };
    }
    if (args[0] === "x") {
      // 7z: -o<dir>; unrar: последний аргумент — каталог со слэшем.
      const outArg = args.find((arg) => arg.startsWith("-o") && arg.length > 3);
      const outDir = outArg ? outArg.slice(2) : args[args.length - 1]!.replace(/\/$/, "");
      outDirs.push(outDir);
      const archive = file.endsWith("unrar") ? args[args.length - 2]! : args[args.length - 1]!;
      archiveAtExtract.push(await readFile(archive));
      for (const [name, content] of Object.entries(options.files ?? {})) {
        const target = join(outDir, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      return {
        code: options.extractCode ?? 0,
        stdout: options.extractOutput ?? "",
        stderr: "",
      };
    }
    // Проверка наличия программы: любой ответ означает «есть».
    return { code: 0, stdout: "", stderr: "" };
  };

  const cli: ArchiveCli = { sevenZip: "/usr/bin/7z", unrar: "/usr/local/bin/unrar", run, tmpRoot: root };
  return { cli, calls, archiveAtExtract, outDirs };
}

async function writeVolumes(dir: string, names: string[]): Promise<{ name: string; path: string }[]> {
  await mkdir(dir, { recursive: true });
  const out: { name: string; path: string }[] = [];
  for (const [index, name] of names.entries()) {
    const path = join(dir, name);
    await writeFile(path, `часть-${index + 1};`);
    out.push({ name, path });
  }
  return out;
}

/** Каталоги, которые код оставил в корне временных файлов (кроме каталога самого теста). */
async function leftovers(): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith("tenderfit-"));
}

describe("detectArchiveCli", () => {
  it("находит обе программы по путям из задания", async () => {
    const { cli } = fakeCli();
    const found = await detectArchiveCli(cli.run, {});
    expect(found?.sevenZip).toBe("/usr/bin/7z");
    expect(found?.unrar).toBe("/usr/local/bin/unrar");
  });

  it("нет ни одной программы — null, и разбор пойдёт в памяти", async () => {
    const { cli } = fakeCli({ missing: ["/usr/bin/7z", "7z", "7zz", "/usr/local/bin/unrar", "/usr/bin/unrar", "unrar"] });
    expect(await detectArchiveCli(cli.run, {})).toBeNull();
  });

  it("одной программы достаточно", async () => {
    const { cli } = fakeCli({ missing: ["/usr/local/bin/unrar", "/usr/bin/unrar", "unrar"] });
    const found = await detectArchiveCli(cli.run, {});
    expect(found?.sevenZip).toBe("/usr/bin/7z");
    expect(found?.unrar).toBeNull();
  });

  it("TENDERFIT_ARCHIVE_CLI=off выключает дисковый путь", async () => {
    const { cli } = fakeCli();
    expect(await detectArchiveCli(cli.run, { TENDERFIT_ARCHIVE_CLI: "off" })).toBeNull();
  });

  it("пути можно переопределить переменными окружения", async () => {
    const { cli, calls } = fakeCli();
    await detectArchiveCli(cli.run, {
      TENDERFIT_7Z_PATH: "/opt/7z/7zz",
      TENDERFIT_UNRAR_PATH: "/opt/rar/unrar",
    });
    expect(calls.map((call) => call.file)).toEqual(["/opt/7z/7zz", "/opt/rar/unrar"]);
  });
});

describe("разбор вывода просмотра состава", () => {
  it("7z l -slt: считает файлы и байты, каталоги пропускает", () => {
    const output = [
      "Path = /tmp/a.7z",
      "Type = 7z",
      "Physical Size = 100",
      "",
      "----------",
      "Path = Папка",
      "Folder = +",
      "Size = 0",
      "",
      "Path = Папка/Файл 1.doc",
      "Folder = -",
      "Size = 1500",
      "",
      "Path = Файл 2.pdf",
      "Folder = -",
      "Size = 2500",
      "",
    ].join("\n");
    expect(parseSevenZipListing(output)).toEqual({ files: 2, bytes: 4000 });
  });

  it("unrar lt: считает только файлы", () => {
    const output = [
      "        Name: Папка",
      "        Type: Directory",
      "",
      "        Name: Файл.docx",
      "        Type: File",
      "        Size: 7000",
      "",
    ].join("\n");
    expect(parseUnrarListing(output)).toEqual({ files: 1, bytes: 7000 });
  });

  it("нечитаемый вывод — null", () => {
    expect(parseSevenZipListing("что-то другое")).toBeNull();
    expect(parseUnrarListing("что-то другое")).toBeNull();
  });
});

describe("extractArchive", () => {
  it("7z: команда без оболочки, с таймаутом, вывод в заданный каталог", async () => {
    const { cli, calls } = fakeCli({ files: { "a.txt": REAL_TEXT } });
    const archive = join(root, "a.7z");
    const out = join(root, "out");
    await writeFile(archive, "x");
    await mkdir(out);

    await extractArchive(cli, "7z", archive, out);

    const extract = calls.find((call) => call.args[0] === "x")!;
    expect(extract.file).toBe("/usr/bin/7z");
    expect(extract.args).toEqual(["x", "-y", "-bd", "-aou", `-o${out}`, "--", archive]);
    expect(extract.timeoutMs).toBeGreaterThan(0);
  });

  it("unrar: x -p- -y -o+ архив каталог/", async () => {
    const { cli, calls } = fakeCli({ files: { "a.txt": REAL_TEXT } });
    const archive = join(root, "a.rar");
    const out = join(root, "out");
    await writeFile(archive, "x");
    await mkdir(out);

    await extractArchive(cli, "unrar", archive, out);

    const extract = calls.find((call) => call.args[0] === "x")!;
    expect(extract.file).toBe("/usr/local/bin/unrar");
    expect(extract.args).toEqual(["x", "-y", "-idq", "-p-", "-or", archive, `${out}/`]);
  });

  it("архив, распаковывающийся в больше 5 ГБ, отклоняется до распаковки", async () => {
    const listing = [
      "----------",
      "Path = огромный.bin",
      "Folder = -",
      `Size = ${MAX_DISK_ARCHIVE_UNCOMPRESSED + 1}`,
      "",
    ].join("\n");
    const { cli, calls } = fakeCli({ listing });
    const archive = join(root, "a.7z");
    await writeFile(archive, "x");

    await expect(extractArchive(cli, "7z", archive, join(root, "out"))).rejects.toMatchObject({
      refusal: "TOO_LARGE",
    });
    expect(calls.some((call) => call.args[0] === "x")).toBe(false);
  });

  it("пароль: ошибка распаковки без файлов становится отказом ENCRYPTED", async () => {
    const { cli } = fakeCli({ extractCode: 2, extractOutput: "Can not open encrypted archive. Wrong password?" });
    const archive = join(root, "a.7z");
    const out = join(root, "out");
    await writeFile(archive, "x");
    await mkdir(out);

    await expect(extractArchive(cli, "7z", archive, out)).rejects.toBeInstanceOf(ArchiveRefusedError);
  });

  it("код 1 (предупреждения) — не ошибка", async () => {
    const { cli } = fakeCli({ extractCode: 1, files: { "a.txt": REAL_TEXT } });
    const archive = join(root, "a.7z");
    const out = join(root, "out");
    await writeFile(archive, "x");
    await mkdir(out);
    await expect(extractArchive(cli, "7z", archive, out)).resolves.toBeUndefined();
  });

  it("сбой с частью файлов не роняет разбор: распакованное годно", async () => {
    const { cli } = fakeCli({ extractCode: 2, files: { "a.txt": REAL_TEXT } });
    const archive = join(root, "a.7z");
    const out = join(root, "out");
    await writeFile(archive, "x");
    await mkdir(out);
    await expect(extractArchive(cli, "7z", archive, out)).resolves.toBeUndefined();
  });

  it("сбой без файлов — ошибка с кодом и хвостом вывода", async () => {
    const { cli } = fakeCli({ extractCode: 2, extractOutput: "ERROR: Unexpected end of archive" });
    const archive = join(root, "a.7z");
    const out = join(root, "out");
    await writeFile(archive, "x");
    await mkdir(out);
    await expect(extractArchive(cli, "7z", archive, out)).rejects.toThrow(/код 2.*Unexpected end/s);
  });
});

describe("listExtractedEntries", () => {
  it("читает входы с диска, пропускает ссылки, release удаляет файл", async () => {
    const dir = join(root, "tree");
    await mkdir(join(dir, "Папка"), { recursive: true });
    await writeFile(join(dir, "Папка", "a.txt"), "содержимое");
    await symlink("/etc/passwd", join(dir, "ссылка.txt"));

    const entries = await listExtractedEntries(dir);

    expect(entries.map((entry) => entry.name)).toEqual(["Папка/a.txt"]);
    const entry = entries[0]!;
    expect(Buffer.from(await entry.bytes()).toString("utf-8")).toBe("содержимое");
    await entry.release?.();
    expect(existsSync(entry.path!)).toBe(false);
  });
});

describe("concatFiles", () => {
  it("склеивает части по порядку", async () => {
    const parts = await writeVolumes(join(root, "p"), ["a.zip.001", "a.zip.002", "a.zip.003"]);
    const target = join(root, "joined");
    await concatFiles(parts.map((part) => part.path), target);
    expect(await readFile(target, "utf-8")).toBe("часть-1;часть-2;часть-3;");
  });
});

describe("parseArchiveVolumeFiles: комплект томов через CLI", () => {
  it(".7z.001: 7z получает первый том, каталоги убираются", async () => {
    const volumes = await writeVolumes(join(root, "vol"), ["volumes.7z.001", "volumes.7z.002"]);
    const { cli, calls, outDirs } = fakeCli({ files: { "Проект/Спецификация.txt": REAL_TEXT } });

    const result = await parseArchiveVolumeFiles(
      [
        { name: "ПСД.7z.001", path: volumes[0]!.path },
        { name: "ПСД.7z.002", path: volumes[1]!.path },
      ],
      1_000_000,
      { archiveCli: cli },
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("=== Проект/Спецификация.txt ===");
    expect(result.archive).toEqual({ parsed: 1, total: 1 });
    const extract = calls.find((call) => call.args[0] === "x")!;
    expect(extract.file).toBe("/usr/bin/7z");
    expect(extract.args.at(-1)).toBe(volumes[0]!.path);
    // Каталог распаковки убран; каталог с томами принадлежит вызывающему коду и остался.
    expect(existsSync(outDirs[0]!)).toBe(false);
    expect(existsSync(volumes[0]!.path)).toBe(true);
    expect(await leftovers()).toEqual([]);
  });

  it(".part1.rar: unrar x по первому тому", async () => {
    const volumes = await writeVolumes(join(root, "vol"), ["volumes.part1.rar", "volumes.part2.rar"]);
    const { cli, calls } = fakeCli({ files: { "Ведомость.txt": REAL_TEXT } });

    const result = await parseArchiveVolumeFiles(
      [
        { name: "Док.part1.rar", path: volumes[0]!.path },
        { name: "Док.part2.rar", path: volumes[1]!.path },
      ],
      1_000_000,
      { archiveCli: cli },
    );

    expect(result.status).toBe("parsed");
    const extract = calls.find((call) => call.args[0] === "x")!;
    expect(extract.file).toBe("/usr/local/bin/unrar");
    expect(extract.args.slice(0, 5)).toEqual(["x", "-y", "-idq", "-p-", "-or"]);
    expect(extract.args[5]).toBe(volumes[0]!.path);
  });

  it("нарезка .zip.001: тома склеиваются в один файл и уходят распаковщику", async () => {
    const volumes = await writeVolumes(join(root, "vol"), ["volumes.zip.001", "volumes.zip.002"]);
    // Подпись zip в начале склейки: файл читается как архив.
    await writeFile(volumes[0]!.path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("первая;")]));
    await writeFile(volumes[1]!.path, "вторая");
    const { cli, archiveAtExtract } = fakeCli({ files: { "Док.txt": REAL_TEXT } });

    const result = await parseArchiveVolumeFiles(
      [
        { name: "СД.zip.001", path: volumes[0]!.path },
        { name: "СД.zip.002", path: volumes[1]!.path },
      ],
      1_000_000,
      { archiveCli: cli },
    );

    expect(result.status).toBe("parsed");
    expect(archiveAtExtract).toHaveLength(1);
    expect(archiveAtExtract[0]!.subarray(4).toString("utf-8")).toBe("первая;вторая");
    // Склейка и распакованное убраны.
    expect(await leftovers()).toEqual([]);
  });

  it("каталоги убираются и тогда, когда распаковка упала", async () => {
    const volumes = await writeVolumes(join(root, "vol"), ["volumes.7z.001", "volumes.7z.002"]);
    const { cli } = fakeCli({ extractCode: 2, extractOutput: "ERROR: Cannot open volume" });

    const result = await parseArchiveVolumeFiles(
      [
        { name: "ПСД.7z.001", path: volumes[0]!.path },
        { name: "ПСД.7z.002", path: volumes[1]!.path },
      ],
      1_000_000,
      { archiveCli: cli },
    );

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("не распаковал");
    expect(await leftovers()).toEqual([]);
  });

  it("программ нет — отказ с причиной, в память комплект не берётся", async () => {
    const volumes = await writeVolumes(join(root, "vol"), ["volumes.7z.001"]);
    const result = await parseArchiveVolumeFiles(
      [{ name: "ПСД.7z.001", path: volumes[0]!.path }],
      1_000_000,
      { archiveCli: null },
    );
    expect(result.status).toBe("unsupported");
    expect(result.reason).toContain("нет программ 7z и unrar");
  });

  it("не хватает тома посередине — отказ до запуска программ", async () => {
    const volumes = await writeVolumes(join(root, "vol"), ["volumes.part1.rar", "volumes.part3.rar"]);
    const { cli, calls } = fakeCli();
    const result = await parseArchiveVolumeFiles(
      [
        { name: "Док.part1.rar", path: volumes[0]!.path },
        { name: "Док.part3.rar", path: volumes[1]!.path },
      ],
      1_000_000,
      { archiveCli: cli },
    );
    expect(result.status).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("архив больше 5 ГБ в распакованном виде: код file_too_large, а не «формат не читается»", async () => {
    const volumes = await writeVolumes(join(root, "vol"), ["volumes.7z.001"]);
    const listing = [
      "----------",
      "Path = x.bin",
      "Folder = -",
      `Size = ${MAX_DISK_ARCHIVE_UNCOMPRESSED + 10}`,
      "",
    ].join("\n");
    const { cli } = fakeCli({ listing });

    const result = await parseArchiveVolumeFiles(
      [{ name: "ПСД.7z.001", path: volumes[0]!.path }],
      1_000_000,
      { archiveCli: cli },
    );

    expect(result.status).toBe("unsupported");
    expect(result.code).toBe("file_too_large");
    expect(result.reason).toContain("больше предела 5.0 ГБ и не читается");
  });
});

describe("parseAttachmentFile: крупный архив на диске", () => {
  it("архив после распаковки читается по входам; больше 200 входов — читаются все", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_ARCHIVE_ENTRIES + 100; i += 1) {
      files[`Раздел/Файл ${String(i).padStart(4, "0")}.txt`] = `${REAL_TEXT} Номер ${i}.`;
    }
    const archive = join(root, "big.7z");
    // Подпись 7z: формат определяется по содержимому, а не по имени.
    await writeFile(archive, Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]));
    const { cli } = fakeCli({ files });

    // Порог дискового пути — 100 МБ по размеру файла; для теста файл не раздуваем,
    // а проверяем тот же путь через комплект из одного тома.
    const result = await parseArchiveVolumeFiles(
      [{ name: "Комплект.7z.001", path: archive }],
      Number.POSITIVE_INFINITY,
      { archiveCli: cli },
    );

    expect(result.status).toBe("parsed");
    // Раньше обход останавливался на 200 входах и тихо отбрасывал остальные.
    expect(result.archive).toEqual({ parsed: 300, total: 300 });
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("Номер 299.");
  });

  it("маленький файл не архив: читается обычным путём без программ", async () => {
    const path = join(root, "a.txt");
    await writeFile(path, REAL_TEXT);
    const { cli, calls } = fakeCli();
    const result = await parseAttachmentFile(path, "a.txt", null, 1_000_000, { archiveCli: cli });
    expect(result.status).toBe("parsed");
    expect(calls).toHaveLength(0);
  });
});

describe("zip с сотнями входов: пределы зависят от программ на машине", () => {
  async function zipWith(count: number): Promise<Uint8Array> {
    const zip = new JSZip();
    for (let i = 0; i < count; i += 1) {
      zip.file(`Файл ${String(i).padStart(4, "0")}.txt`, `${REAL_TEXT} Номер ${i}.`);
    }
    return zip.generateAsync({ type: "uint8array" });
  }

  it("без программ прежний предел — 200 входов, и обрезка видна", async () => {
    const result = await parseAttachment(await zipWith(250), "Док.zip", null, Number.POSITIVE_INFINITY, {
      archiveCli: null,
    });
    expect(result.archive).toMatchObject({ parsed: MAX_ARCHIVE_ENTRIES, total: 250 });
    // Пятьдесят входов сверх предела названы в отчёте, а не просто пропали.
    expect(result.archive?.skipped).toHaveLength(50);
    expect(result.archive?.skipped?.[0]?.reason).toContain(`больше ${MAX_ARCHIVE_ENTRIES} файлов`);
    expect(result.truncated).toBe(true);
  });

  it("с программами лимит входов — 5000: читаются все 250", async () => {
    const { cli } = fakeCli();
    const result = await parseAttachment(await zipWith(250), "Док.zip", null, Number.POSITIVE_INFINITY, {
      archiveCli: cli,
    });
    expect(result.archive).toEqual({ parsed: 250, total: 250 });
    expect(result.truncated).toBe(false);
  });
});

describe("без бюджета знаков текст не режется", () => {
  it("3 млн знаков в одном файле читаются целиком и без отметки об обрезке", async () => {
    const text = `${REAL_TEXT}\n`.repeat(40_000); // около 3,5 млн знаков
    const result = await parseAttachment(
      new Uint8Array(Buffer.from(text, "utf-8")),
      "Документация.txt",
      null,
      Number.POSITIVE_INFINITY,
      { archiveCli: null },
    );
    expect(result.status).toBe("parsed");
    expect(result.truncated).toBe(false);
    expect(result.text.length).toBe(text.trim().length);
    expect(result.text.length).toBeGreaterThan(3_000_000);
  });
});

describe("makeTempDir", () => {
  it("корень берётся из TENDERFIT_TMPDIR; каталог убирается целиком", async () => {
    const previous = process.env["TENDERFIT_TMPDIR"];
    process.env["TENDERFIT_TMPDIR"] = root;
    try {
      const dir = await makeTempDir("tenderfit-x-");
      expect(dir.dir.startsWith(root)).toBe(true);
      await writeFile(join(dir.dir, "a.bin"), "x");
      await dir.dispose();
      expect(existsSync(dir.dir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["TENDERFIT_TMPDIR"];
      else process.env["TENDERFIT_TMPDIR"] = previous;
    }
  });

  it("отсутствующий корень создаётся (PrivateTmp у systemd прячет внешний каталог)", async () => {
    const missing = join(root, "not-yet", "deeper");
    expect(existsSync(missing)).toBe(false);
    const dir = await makeTempDir("tenderfit-y-", missing);
    expect(dir.dir.startsWith(missing)).toBe(true);
    await dir.dispose();
  });
});
