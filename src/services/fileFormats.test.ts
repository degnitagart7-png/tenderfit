import { describe, expect, it } from "vitest";

import {
  detectFileType,
  isVolumeName,
  sniffFileType,
  volumeNumber,
  volumeSetKind,
  volumeSetName,
  volumeSetProblem,
} from "@/services/fileFormats";

describe("detectFileType — новые форматы", () => {
  it("OpenDocument", () => {
    expect(detectFileType(null, "Ведомость объемов работ.odt")).toBe("odt");
    expect(detectFileType(null, "Ведомость.FODT")).toBe("odt");
    expect(detectFileType(null, "Смета.ods")).toBe("ods");
    expect(detectFileType(null, "Смета.fods")).toBe("ods");
    expect(detectFileType(null, "Презентация.odp")).toBe("odp");
  });

  it("rtf и картинки", () => {
    expect(detectFileType(null, "Информационная карта.rtf")).toBe("rtf");
    expect(detectFileType(null, "схема_из_2_гис.png")).toBe("image");
    expect(detectFileType(null, "Фото.JPG")).toBe("image");
    expect(detectFileType(null, "Фото.jpeg")).toBe("image");
    expect(detectFileType(null, "Скан.tif")).toBe("image");
    expect(detectFileType(null, "Скан.tiff")).toBe("image");
  });

  it("MIME OpenDocument и rtf учитываются, когда он настоящий", () => {
    expect(detectFileType("application/vnd.oasis.opendocument.text")).toBe(
      "odt",
    );
    expect(
      detectFileType("application/vnd.oasis.opendocument.spreadsheet"),
    ).toBe("ods");
    expect(detectFileType("application/rtf")).toBe("rtf");
    expect(detectFileType("image/png")).toBe("image");
  });

  it("всё остальное по-прежнему не поддержано", () => {
    expect(detectFileType(null, "Чертёж.dwg")).toBe("unsupported");
    expect(detectFileType(null, "Схема.bmp")).toBe("unsupported");
  });
});

describe("sniffFileType — картинки", () => {
  it("png, jpeg и tiff в обоих порядках байт", () => {
    expect(
      sniffFileType(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image");
    expect(sniffFileType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image",
    );
    expect(sniffFileType(Uint8Array.from([0x49, 0x49, 0x2a, 0x00]))).toBe(
      "image",
    );
    expect(sniffFileType(Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe(
      "image",
    );
  });
});

describe("тома-нарезки .zip.NNN и .rar.NNN", () => {
  it("распознаются как тома", () => {
    expect(isVolumeName("СД_2-этап_26.08.2026.zip.001")).toBe(true);
    expect(isVolumeName("все_запчасти-2026.zip.002")).toBe(true);
    expect(isVolumeName("Закупочная_документация_изм.rar.003")).toBe(true);
  });

  it("одиночные архивы и «.001» без архивного расширения — не тома", () => {
    expect(isVolumeName("Документация.zip")).toBe(false);
    expect(isVolumeName("Документация.rar")).toBe(false);
    expect(isVolumeName("Лог.txt.001")).toBe(false);
  });

  it("общее имя комплекта сохраняет расширение архива", () => {
    expect(volumeSetName("СД.zip.001")).toBe("СД.zip");
    expect(volumeSetName("СД.zip.007")).toBe("СД.zip");
    expect(volumeSetName("ПД.rar.001")).toBe("ПД.rar");
    // zip и rar с одним именем — разные комплекты.
    expect(volumeSetName("ПД.zip.001")).not.toBe(volumeSetName("ПД.rar.001"));
    // Прежние написания не изменились.
    expect(volumeSetName("ПСД.7z.001")).toBe("ПСД");
    expect(volumeSetName("ул.Ротерта.part2.rar")).toBe("ул.Ротерта");
  });

  it("вид комплекта", () => {
    expect(volumeSetKind("СД.zip.001")).toBe("zip-split");
    expect(volumeSetKind("ПД.rar.001")).toBe("rar-split");
    expect(volumeSetKind("ПСД.7z.001")).toBe("7z");
    expect(volumeSetKind("ПСД.part1.rar")).toBe("rar");
    expect(volumeSetKind("ПСД.r01")).toBe("rar");
    expect(volumeSetKind("ПСД.zip")).toBeNull();
  });

  it("номер тома", () => {
    expect(volumeNumber("СД.zip.007")).toBe(7);
    expect(volumeNumber("ПСД.part03.rar")).toBe(3);
    expect(volumeNumber("ПСД.r01")).toBeNull();
    expect(volumeNumber("Смета.zip")).toBeNull();
  });
});

describe("volumeSetProblem", () => {
  it("полный комплект — без замечаний", () => {
    expect(
      volumeSetProblem(["СД.zip.001", "СД.zip.002", "СД.zip.003"]),
    ).toBeNull();
    expect(volumeSetProblem(["ПСД.part1.rar", "ПСД.part2.rar"])).toBeNull();
  });

  it("не хватает тома посередине — он назван", () => {
    const problem = volumeSetProblem(["ПД.zip.001", "ПД.zip.003"]);
    expect(problem).toContain("не хватает тома 002");
    expect(problem).toContain("«ПД.zip»");
  });

  it("не хватает первого тома", () => {
    expect(volumeSetProblem(["ПД.rar.002", "ПД.rar.003"])).toContain(
      "тома 001",
    );
  });

  it("несколько недостающих — списком, длинный список обрезается", () => {
    const problem = volumeSetProblem(["ПД.zip.001", "ПД.zip.009"]);
    expect(problem).toContain("томов 002, 003, 004, 005, 006 и ещё 2");
  });

  it("старое написание .rNN по номерам не проверяется", () => {
    expect(volumeSetProblem(["ПСД.r00", "ПСД.r02"])).toBeNull();
  });
});
