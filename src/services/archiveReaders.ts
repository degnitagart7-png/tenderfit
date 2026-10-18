/**
 * Чтение архивов rar и 7z. Серверная часть.
 *
 * Зачем отдельный модуль рядом с attachmentParser: rar и 7z тянут wasm-сборки
 * на мегабайты (`node-unrar-js`, `7z-wasm`), и в клиентскую сборку им нельзя.
 * Импорты здесь динамические — вызывающий код платит за библиотеку только когда
 * архив такого формата действительно встретился, а не на каждый pdf.
 *
 * Здесь всё происходит в памяти: конвейер разбора байтовый от начала до конца
 * (`parseAttachment(bytes) → текст`). Для архивов, которые в память не помещаются
 * (комплекты томов, файлы от ~100 МБ), есть дисковый путь через программы 7z и
 * unrar — см. archiveCli.ts; он включается, когда программы есть на машине.
 * Этот модуль — путь без программ и для небольших архивов.
 *
 * Отсюда же следует, что защита от Zip Slip здесь не нужна: путь из архива
 * никуда не подставляется, входы читаются в буфер и уходят в разбор по
 * содержимому. Имя входа используется только для показа и для определения
 * формата, и обе операции безопасны для любого пути.
 *
 * Лицензии. `node-unrar-js` — обёртка MIT над UnRAR, `7z-wasm` — LGPL с
 * ограничением unRAR. Оба разрешают чтение и извлечение; запрещено делать
 * RAR-совместимый упаковщик и восстанавливать алгоритм сжатия RAR — мы не
 * делаем ни того, ни другого. Тексты лицензий лежат в THIRD_PARTY_NOTICES.md и
 * обязаны уехать вместе с продуктом.
 */

/** Один том комплекта: имя, каким его выложил заказчик, и его байты. */
export interface ArchiveVolume {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Вход архива: имя и ленивое чтение содержимого. */
export interface ArchiveEntry {
  readonly name: string;
  /** Размер в распакованном виде, байт. 0 — источник его не сообщил. */
  readonly size: number;
  /** Содержимое входа. Ленивое: обход прерывается по лимитам, не дочитав. */
  bytes(): Promise<Uint8Array>;
  /**
   * Файл на диске (дисковая распаковка): крупный вход разбирается по пути, не
   * поднимаясь в память целиком. Нет — вход живёт только в памяти.
   */
  readonly path?: string;
  /** Убрать вход после чтения: у дисковой распаковки удаляет файл. */
  release?(): Promise<void>;
}

/** Почему архив не читается, хотя формат знаком. */
export type ArchiveRefusal =
  /** Часть многотомного комплекта: одного тома для распаковки не хватает. */
  | "MULTI_VOLUME"
  /** Архив под паролем. */
  | "ENCRYPTED"
  /** Архив распаковывается в объём больше предела: диск воркера не резиновый. */
  | "TOO_LARGE";

/**
 * Отказ читать архив по понятной причине, а не поломка.
 *
 * Отдельный класс нужен, чтобы вызывающий код отличил «этот архив прочитать
 * нельзя и вот почему» от настоящей ошибки распаковщика: первое показывается
 * партнёру как причина пропуска, второе — как сбой.
 */
export class ArchiveRefusedError extends Error {
  constructor(
    readonly refusal: ArchiveRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveRefusedError";
  }
}

/** Распознавание томов живёт в чистом модуле: оно нужно и загрузчику, до скачивания. */
export {
  isVolumeName,
  volumeSetKind,
  volumeSetName,
} from "@/services/fileFormats";

/**
 * Входы архива RAR.
 *
 * Читается из памяти: `createExtractorFromData` не требует файла на диске.
 * Извлечение ленивое только по виду — UnRAR распаковывает при обходе
 * генератора, поэтому содержимое берётся один раз и запоминается: повторный
 * проход по тому же архиву означал бы вторую распаковку целиком.
 */
export async function readRarEntries(
  bytes: Uint8Array,
): Promise<ArchiveEntry[]> {
  const { createExtractorFromData } = await import("node-unrar-js");
  const extractor = await createExtractorFromData({
    data: toArrayBuffer(bytes),
  });

  const list = extractor.getFileList();

  /*
    Признак тома берётся из заголовка архива, а не из имени.

    Заказчик волен назвать том как угодно, а флаг `volume` ставит сам упаковщик.
    Одиночный том без остальных частей UnRAR прочитает лишь частично и молча:
    файлы, продолжающиеся в следующем томе, вернутся обрезанными. Молчаливая
    половина документа хуже честного отказа.
  */
  if (list.arcHeader.flags.volume) {
    throw new ArchiveRefusedError(
      "MULTI_VOLUME",
      "Это том многотомного архива: чтобы его распаковать, нужны все тома комплекта.",
    );
  }

  const headers = [...list.fileHeaders];
  if (headers.some((header) => header.flags.encrypted)) {
    throw new ArchiveRefusedError(
      "ENCRYPTED",
      "Архив под паролем: содержимое прочитать нечем.",
    );
  }

  const extracted = new Map<string, Uint8Array>();
  for (const file of extractor.extract().files) {
    if (file.extraction) extracted.set(file.fileHeader.name, file.extraction);
  }

  /*
    Пустой список заголовков у RAR означает не пустой архив, а нечитаемый.

    UnRAR на оборванной загрузке не бросает исключение: он открывает то, что
    есть, и молча не находит ни одного файла. Отдать это наверх как «архив
    пуст» значило бы списать сбой сети на заказчика, который якобы выложил
    пустой архив. Настоящих пустых rar в документации не бывает.
  */
  if (headers.length === 0) {
    throw new Error(
      "UnRAR не нашёл в архиве ни одного файла: архив повреждён или загружен не целиком.",
    );
  }

  return headers
    .filter((header) => !header.flags.directory)
    .map((header) => ({
      name: header.name,
      size: header.unpSize,
      bytes: async () => extracted.get(header.name) ?? new Uint8Array(),
    }));
}

/**
 * Входы архива 7z.
 *
 * 7z-wasm — это сам 7-Zip, собранный в wasm, и разговаривать с ним приходится
 * как с программой: положить архив в его виртуальную файловую систему, позвать
 * `x`, забрать распакованное. Файловая система здесь тоже в памяти (MEMFS), а
 * не смонтированная папка хоста, — поэтому диск не участвует.
 *
 * Модуль создаётся на каждый архив заново: он держит состояние виртуальной ФС,
 * и переиспользовать один экземпляр между закупками значило бы копить чужие
 * файлы в памяти процесса-долгожителя.
 */
export async function read7zEntries(
  bytes: Uint8Array,
): Promise<ArchiveEntry[]> {
  const factory = (await import("7z-wasm")).default;

  /*
    Вывод 7-Zip перехватывается и не печатается: воркер пишет свой журнал, и
    строки прогресса распаковки в нём только мешают. Ошибку мы узнаём не из
    вывода, а по тому, что распакованного не оказалось.
  */
  const messages: string[] = [];
  const sevenZip = await factory({
    print: (line: string) => void messages.push(line),
    printErr: (line: string) => void messages.push(line),
  });

  sevenZip.FS.writeFile("/archive.7z", bytes);
  sevenZip.FS.mkdir("/out");
  sevenZip.callMain(["x", "/archive.7z", "-o/out", "-y"]);

  const entries: ArchiveEntry[] = [];
  collectFiles(sevenZip.FS, "/out", "", entries);

  if (entries.length === 0) {
    const tail = messages
      .filter((line) => line.trim().length > 0)
      .slice(-3)
      .join(" ");
    throw new Error(
      tail.length > 0
        ? `7-Zip не распаковал архив: ${tail}`
        : "7-Zip не распаковал архив.",
    );
  }

  return entries;
}

/** Обход распакованного дерева в виртуальной ФС. */
function collectFiles(
  fs: Awaited<ReturnType<Awaited<typeof import("7z-wasm")>["default"]>>["FS"],
  dir: string,
  prefix: string,
  out: ArchiveEntry[],
): void {
  for (const name of fs.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    const relative = prefix.length > 0 ? `${prefix}/${name}` : name;
    const stat = fs.stat(path);

    if (fs.isDir(stat.mode)) {
      collectFiles(fs, path, relative, out);
      continue;
    }

    out.push({
      name: relative,
      size: stat.size,
      bytes: async () => fs.readFile(path, { encoding: "binary" }),
    });
  }
}

/**
 * Копия байтов в отдельный ArrayBuffer.
 *
 * `bytes.buffer` отдавать нельзя: Uint8Array часто смотрит в кусок большего
 * буфера (так режет Buffer в Node), и распаковщик получил бы вместе с архивом
 * чужие байты вокруг него.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Тома комплекта по порядку номеров.
 *
 * Сортировка по имени, а не по порядку в списке: заказчик выкладывает тома во
 * вкладке документов как попало, а распаковщику нужен первый. Числа в именах
 * дополнены нулями («part01», «7z.001»), поэтому обычного сравнения строк
 * достаточно.
 */
function sortedVolumes(volumes: readonly ArchiveVolume[]): ArchiveVolume[] {
  return [...volumes].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/**
 * Входы многотомного архива 7z.
 *
 * Тома кладутся в виртуальную файловую систему под своими настоящими именами, и
 * 7-Zip сам находит продолжения рядом с первым томом — ровно так же, как нашёл
 * бы их в папке на диске. Диск при этом не участвует: MEMFS живёт в памяти
 * процесса.
 */
export async function read7zVolumeEntries(
  volumes: readonly ArchiveVolume[],
): Promise<ArchiveEntry[]> {
  const parts = sortedVolumes(volumes);
  if (parts.length === 0) {
    throw new ArchiveRefusedError(
      "MULTI_VOLUME",
      "Комплект томов пуст: распаковывать нечего.",
    );
  }

  const first = parts[0]!;
  if (!/\.7z\.0*1$/i.test(first.name)) {
    throw new ArchiveRefusedError(
      "MULTI_VOLUME",
      `Первого тома комплекта нет: распаковка начинается с «.7z.001», а самый ранний из полученных — «${first.name}».`,
    );
  }

  const factory = (await import("7z-wasm")).default;
  const messages: string[] = [];
  const sevenZip = await factory({
    print: (line: string) => void messages.push(line),
    printErr: (line: string) => void messages.push(line),
  });

  sevenZip.FS.mkdir("/vol");
  for (const part of parts)
    sevenZip.FS.writeFile(`/vol/${part.name}`, part.bytes);
  sevenZip.FS.mkdir("/out");
  sevenZip.callMain(["x", `/vol/${first.name}`, "-o/out", "-y"]);

  const entries: ArchiveEntry[] = [];
  collectFiles(sevenZip.FS, "/out", "", entries);

  if (entries.length === 0) {
    const tail = messages
      .filter((line) => line.trim().length > 0)
      .slice(-3)
      .join(" ");
    throw new Error(
      tail.length > 0
        ? `7-Zip не распаковал комплект томов: ${tail}`
        : "7-Zip не распаковал комплект томов.",
    );
  }

  return entries;
}

/**
 * Входы многотомного архива RAR.
 *
 * Единственное место в разборе, где используется диск, и это вынужденно. UnRAR
 * запрашивает следующий том у файловой системы по имени, которое выводит из
 * имени первого (`open(filename)` в node-unrar-js зовёт `fs.openSync`).
 * Подсунуть ему буферы из памяти нечем: карта томов у чтения из памяти приватна,
 * а собственный экстрактор потребовал бы дотянуться до непубличного синглтона
 * библиотеки и сломался бы на первом же её обновлении.
 *
 * Поэтому тома пишутся во временную папку, и она удаляется в `finally` — вместе
 * с распакованным, при любом исходе.
 */
export async function readRarVolumeEntries(
  volumes: readonly ArchiveVolume[],
): Promise<ArchiveEntry[]> {
  const parts = sortedVolumes(volumes);
  if (parts.length === 0) {
    throw new ArchiveRefusedError(
      "MULTI_VOLUME",
      "Комплект томов пуст: распаковывать нечего.",
    );
  }

  const { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = await mkdtemp(join(tmpdir(), "tenderfit-rar-"));
  const inDir = join(root, "in");
  const outDir = join(root, "out");

  try {
    await mkdir(inDir);
    await mkdir(outDir);
    for (const part of parts)
      await writeFile(join(inDir, part.name), part.bytes);

    const { createExtractorFromFile } = await import("node-unrar-js");
    const extractor = await createExtractorFromFile({
      filepath: join(inDir, parts[0]!.name),
      targetPath: outDir,
    });

    const list = extractor.getFileList();
    const headers = [...list.fileHeaders];
    if (headers.some((header) => header.flags.encrypted)) {
      throw new ArchiveRefusedError(
        "ENCRYPTED",
        "Архив под паролем: содержимое прочитать нечем.",
      );
    }
    if (headers.length === 0) {
      throw new Error(
        "UnRAR не нашёл в комплекте ни одного файла: тома повреждены или неполны.",
      );
    }

    // Генератор ленивый: без обхода распаковка не выполняется вовсе.
    for (const _file of extractor.extract().files) void _file;

    const entries: ArchiveEntry[] = [];
    await collectDiskFiles({ readdir, stat, readFile }, outDir, "", entries);
    return entries;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Обход распакованного на диск. Содержимое читается сразу, а не лениво: папка
 * удаляется вместе с выходом из функции, и отложенное чтение нашло бы пустоту.
 */
async function collectDiskFiles(
  fs: {
    readdir: (path: string) => Promise<string[]>;
    stat: (path: string) => Promise<{ isDirectory(): boolean; size: number }>;
    readFile: (path: string) => Promise<Buffer>;
  },
  dir: string,
  prefix: string,
  out: ArchiveEntry[],
): Promise<void> {
  const { join } = await import("node:path");
  for (const name of await fs.readdir(dir)) {
    const full = join(dir, name);
    const relative = prefix.length > 0 ? `${prefix}/${name}` : name;
    const info = await fs.stat(full);

    if (info.isDirectory()) {
      await collectDiskFiles(fs, full, relative, out);
      continue;
    }

    const bytes = new Uint8Array(await fs.readFile(full));
    out.push({ name: relative, size: info.size, bytes: async () => bytes });
  }
}
