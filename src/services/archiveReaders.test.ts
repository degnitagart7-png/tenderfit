import { describe, expect, it } from "vitest";

import {
  ArchiveRefusedError,
  isVolumeName,
  read7zEntries,
  read7zVolumeEntries,
  readRarEntries,
  readRarVolumeEntries,
  volumeSetKind,
  volumeSetName,
} from "@/services/archiveReaders";

/**
 * Настоящий .7z собирается тем же 7z-wasm: архиватор в нём есть, и это
 * единственный способ проверить чтение на живом архиве, а не на заглушке.
 * Для .rar такого способа нет — упаковщика RAR не существует ни в одной
 * свободной библиотеке, и лицензия UnRAR прямо запрещает его делать. Поэтому
 * rar проверяется по отказам и по признаку тома, а чтение живого rar остаётся
 * на ручную проверку.
 */
async function make7z(files: Record<string, string>): Promise<Uint8Array> {
  const factory = (await import("7z-wasm")).default;
  const sevenZip = await factory({ print: () => {}, printErr: () => {} });

  sevenZip.FS.mkdir("/in");
  for (const [name, content] of Object.entries(files)) {
    sevenZip.FS.writeFile(`/in/${name}`, content);
  }
  sevenZip.FS.chdir("/in");
  sevenZip.callMain(["a", "/out.7z", "."]);
  return sevenZip.FS.readFile("/out.7z");
}

describe("isVolumeName", () => {
  it("узнаёт тома rar в обоих принятых написаниях", () => {
    expect(isVolumeName("Документация.part1.rar")).toBe(true);
    expect(isVolumeName("Документация.part02.rar")).toBe(true);
    expect(isVolumeName("Документация.r01")).toBe(true);
  });

  it("узнаёт тома 7z", () => {
    expect(isVolumeName("ПСД.7z.001")).toBe(true);
    expect(isVolumeName("ПСД.7z.014")).toBe(true);
  });

  it("не принимает одиночный архив за том", () => {
    expect(isVolumeName("Документация.rar")).toBe(false);
    expect(isVolumeName("ПСД.7z")).toBe(false);
    expect(isVolumeName("Смета.zip")).toBe(false);
  });

  it("не принимает за том файл, у которого «part» в названии работы", () => {
    expect(isVolumeName("Раздел 3 part проекта.pdf")).toBe(false);
  });
});

describe("volumeSetName", () => {
  it("сводит тома одного комплекта к общему имени", () => {
    expect(volumeSetName("085-0015958 ул.Ротерта.part1.rar")).toBe(
      "085-0015958 ул.Ротерта",
    );
    expect(volumeSetName("085-0015958 ул.Ротерта.part2.rar")).toBe(
      "085-0015958 ул.Ротерта",
    );
    expect(volumeSetName("ПСД.7z.001")).toBe("ПСД");
    expect(volumeSetName("ПСД.7z.002")).toBe("ПСД");
  });

  it("для одиночного архива комплекта нет", () => {
    expect(volumeSetName("Документация.rar")).toBeNull();
  });
});

describe("read7zEntries", () => {
  it("читает входы настоящего архива", async () => {
    const archive = await make7z({
      "contract.txt": "Проект контракта, раздел 5, неустойка 0,5 процента",
      "spec.txt": "Техническое задание",
    });

    const entries = await read7zEntries(archive);
    const names = entries.map((entry) => entry.name).sort();

    expect(names).toEqual(["contract.txt", "spec.txt"]);
  });

  it("отдаёт содержимое входа байтами", async () => {
    const archive = await make7z({ "contract.txt": "Неустойка 0,5 процента" });

    const entries = await read7zEntries(archive);
    const bytes = await entries[0]!.bytes();

    expect(Buffer.from(bytes).toString("utf-8")).toContain("Неустойка");
  });

  it("на не-архиве бросает ошибку, а не возвращает пустой список", async () => {
    await expect(read7zEntries(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});

describe("readRarEntries", () => {
  it("на не-архиве бросает ошибку", async () => {
    await expect(
      readRarEntries(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrow();
  });
});

describe("ArchiveRefusedError", () => {
  it("несёт причину отказа отдельно от текста", () => {
    const error = new ArchiveRefusedError("MULTI_VOLUME", "Нужны все тома");

    expect(error.refusal).toBe("MULTI_VOLUME");
    expect(error.message).toBe("Нужны все тома");
  });
});

/**
 * Многотомные архивы.
 *
 * 7-Zip умеет и собирать тома (`-v`), поэтому комплект 7z проверяется на живом
 * архиве целиком: собрали, разрезали на части, прочитали обратно. Для RAR
 * упаковщика нет и быть не может, поэтому комплект rar проверяется по отказам.
 */
describe("read7zVolumeEntries", () => {
  async function make7zVolumes(
    content: string,
    volumeSize: string,
  ): Promise<{ name: string; bytes: Uint8Array }[]> {
    const factory = (await import("7z-wasm")).default;
    const sevenZip = await factory({ print: () => {}, printErr: () => {} });
    sevenZip.FS.mkdir("/in");
    sevenZip.FS.writeFile("/in/big.txt", content);
    sevenZip.FS.chdir("/in");
    sevenZip.callMain(["a", `-v${volumeSize}`, "-mx=0", "/psd.7z", "big.txt"]);

    return sevenZip.FS.readdir("/")
      .filter((name) => name.startsWith("psd.7z."))
      .sort()
      .map((name) => ({
        name,
        bytes: sevenZip.FS.readFile(`/${name}`, { encoding: "binary" }),
      }));
  }

  it("читает комплект томов как один архив", async () => {
    const content = "Neustoyka 0,5 protsenta. ".repeat(4_000);
    const volumes = await make7zVolumes(content, "40k");

    expect(volumes.length).toBeGreaterThan(1);

    const entries = await read7zVolumeEntries(volumes);
    const bytes = await entries[0]!.bytes();

    expect(entries.map((entry) => entry.name)).toEqual(["big.txt"]);
    expect(Buffer.from(bytes).toString("utf-8")).toContain("Neustoyka");
  });

  it("без первого тома отказывается понятной причиной", async () => {
    const content = "Neustoyka 0,5 protsenta. ".repeat(4_000);
    const volumes = await make7zVolumes(content, "40k");

    await expect(read7zVolumeEntries(volumes.slice(1))).rejects.toThrow(
      ArchiveRefusedError,
    );
  });

  it("пустой комплект — отказ, а не пустой список", async () => {
    await expect(read7zVolumeEntries([])).rejects.toThrow(ArchiveRefusedError);
  });
});

describe("readRarVolumeEntries", () => {
  it("пустой комплект — отказ", async () => {
    await expect(readRarVolumeEntries([])).rejects.toThrow(ArchiveRefusedError);
  });

  it("на мусоре вместо томов бросает ошибку и убирает за собой", async () => {
    await expect(
      readRarVolumeEntries([
        { name: "ПСД.part1.rar", bytes: new Uint8Array([1, 2, 3]) },
        { name: "ПСД.part2.rar", bytes: new Uint8Array([4, 5, 6]) },
      ]),
    ).rejects.toThrow();
  });
});

describe("volumeSetKind", () => {
  it("различает комплекты rar и 7z", () => {
    expect(volumeSetKind("ПСД.part1.rar")).toBe("rar");
    expect(volumeSetKind("ПСД.r01")).toBe("rar");
    expect(volumeSetKind("ПСД.7z.001")).toBe("7z");
    expect(volumeSetKind("ПСД.rar")).toBeNull();
  });
});
