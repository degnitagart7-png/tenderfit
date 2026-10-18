/**
 * Распаковка крупных архивов и комплектов томов через программы 7z и unrar.
 * Серверная часть: тянет child_process и файловую систему, из клиентского кода
 * не импортируется (attachmentParser подключает модуль динамическим import()).
 *
 * Зачем. Распаковщики на wasm (`7z-wasm`, `node-unrar-js`) держат архив и всё
 * распакованное в памяти процесса. Для 300-мегабайтной проектной документации на
 * сервере с 4 ГБ ОЗУ это значит падение процесса. Здесь архив лежит на диске,
 * распаковывается в каталог mkdtemp командой `7z x` или `unrar x`, а файлы потом
 * читаются по одному и удаляются сразу после чтения. Каталог убирается целиком в
 * finally при любом исходе.
 *
 * Программы запускаются без оболочки (execFile), поэтому имя файла не может стать
 * командой; стандартный ввод закрыт, поэтому запрос пароля заканчивается отказом,
 * а не ожиданием; у каждой команды есть таймаут. Распакованное читается через
 * lstat: ссылки и всё, что не обычный файл, пропускаются, так что архив с
 * символической ссылкой на /etc/passwd ничего не вынесет наружу.
 *
 * Нет ни 7z, ни unrar — это не ошибка: `detectArchiveCli` вернёт null, и разбор
 * идёт прежним путём в памяти с прежними пределами.
 *
 * Тесты не запускают программы: команды подменяются портом `run`.
 */

import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { ArchiveRefusedError, type ArchiveEntry } from "@/services/archiveReaders";
import { CommandMissingError, CommandTimeoutError } from "@/services/ocr";

/** Архив и комплект на диске, предел входов и распакованного объёма (дисковый путь). */
export const MAX_DISK_ARCHIVE_ENTRIES = 5000;
export const MAX_DISK_ARCHIVE_UNCOMPRESSED = 5_000_000_000;

/** Файл от этого объёма не держится в памяти: пишется на диск и читается программой. */
export const LARGE_ARCHIVE_BYTES = 100_000_000;

/** Время на распаковку и на просмотр состава. Аварийная защита от зависшей программы. */
export const EXTRACT_TIMEOUT_MS = 60 * 60_000;
export const LIST_TIMEOUT_MS = 10 * 60_000;

export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Порт запуска программы. В отличие от `RunCommand` из ocr.ts ненулевой код
 * возврата — не исключение: у 7z код 1 значит «предупреждения», и распакованное
 * при этом годно. Исключения только для «программы нет» и «не уложилась во время».
 */
export type CliRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<CliRunResult>;

export const runCli: CliRunner = (file, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        // Журнал распаковки не нужен: важны код возврата и последние строки.
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
        // Кодировка имён файлов: в службе без LANG p7zip считает локаль «C» и
        // заменяет русские буквы знаками вопроса — два файла с разными именами
        // получили бы одно. UTF-8 задаётся явно.
        env: { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (failure.code === "ENOENT") {
          reject(new CommandMissingError(file));
          return;
        }
        if (failure.killed === true) {
          reject(new CommandTimeoutError(file, timeoutMs));
          return;
        }
        // Переполнение буфера вывода — не сбой распаковки: файлы уже на диске.
        const code = typeof failure.code === "number" ? failure.code : 2;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    // Ввод закрыт: запрос пароля получит конец файла.
    child.stdin?.end();
  });

/** Найденные распаковщики и всё, что нужно для работы с диском. */
export interface ArchiveCli {
  /** Путь или имя программы 7z; null — нет. */
  sevenZip: string | null;
  /** Путь или имя программы unrar; null — нет. */
  unrar: string | null;
  run: CliRunner;
  /** Корень временных каталогов; по умолчанию os.tmpdir(). */
  tmpRoot?: string;
}

type Env = Record<string, string | undefined>;

function candidates(envName: string, defaults: readonly string[], env: Env): string[] {
  const fromEnv = env[envName]?.trim();
  return fromEnv ? [fromEnv] : [...defaults];
}

async function findProgram(run: CliRunner, list: readonly string[]): Promise<string | null> {
  for (const program of list) {
    try {
      // Без аргументов обе программы печатают справку; код возврата не важен —
      // важно, что программа запустилась.
      await run(program, [], { timeoutMs: 15_000 });
      return program;
    } catch (err) {
      if (err instanceof CommandMissingError) continue;
      // Не уложилась в 15 секунд или иная ошибка запуска: программе доверять нельзя.
      continue;
    }
  }
  return null;
}

/**
 * Какие распаковщики есть на машине. Null — ни одного, либо отключено переменной
 * TENDERFIT_ARCHIVE_CLI=off. Пути можно задать TENDERFIT_7Z_PATH и
 * TENDERFIT_UNRAR_PATH; по умолчанию /usr/bin/7z и /usr/local/bin/unrar, затем PATH.
 */
export async function detectArchiveCli(
  run: CliRunner = runCli,
  env: Env = process.env,
  tmpRoot?: string,
): Promise<ArchiveCli | null> {
  if (env["TENDERFIT_ARCHIVE_CLI"]?.toLowerCase() === "off") return null;

  const sevenZip = await findProgram(
    run,
    candidates("TENDERFIT_7Z_PATH", ["/usr/bin/7z", "7z", "7zz"], env),
  );
  const unrar = await findProgram(
    run,
    candidates("TENDERFIT_UNRAR_PATH", ["/usr/local/bin/unrar", "/usr/bin/unrar", "unrar"], env),
  );
  if (sevenZip === null && unrar === null) return null;
  return { sevenZip, unrar, run, ...(tmpRoot ? { tmpRoot } : {}) };
}

let sharedCli: Promise<ArchiveCli | null> | null = null;

/** Общая проверка процесса: программы ищутся один раз. */
export function getArchiveCli(): Promise<ArchiveCli | null> {
  sharedCli ??= detectArchiveCli();
  return sharedCli;
}

/** Для тестов: забыть запомненный результат поиска программ. */
export function resetArchiveCliForTests(): void {
  sharedCli = null;
}

/* ============================ Временные каталоги ============================ */

export interface TempDir {
  dir: string;
  dispose(): Promise<void>;
}

/**
 * Каталог под одну работу. Убирается dispose() целиком, при любом исходе.
 *
 * Корень — аргумент, иначе TENDERFIT_TMPDIR, иначе системный временный каталог.
 * Переменная нужна, если /tmp на сервере смонтирован в оперативную память
 * (tmpfs): гигабайты распакованного там съели бы ОЗУ вместо диска.
 */
export async function makeTempDir(prefix: string, root?: string): Promise<TempDir> {
  const base = root ?? (process.env["TENDERFIT_TMPDIR"]?.trim() || tmpdir());
  // Корень создаётся при необходимости: сервис systemd с PrivateTmp=true видит
  // собственный пустой /var/tmp, и каталог, созданный снаружи, в нём отсутствует.
  // 08.10.2026 из-за этого ни один файл закупки не скачался (ENOENT в mkdtemp).
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(base, prefix));
  return {
    dir,
    dispose: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/* ============================ Состав архива ============================ */

/** Сколько входов и сколько байт распакуется. */
export interface ArchiveListing {
  files: number;
  bytes: number;
}

/**
 * Разбор `7z l -slt`: блоки «Path = … Size = …» после строки «----------».
 * Каталоги (`Folder = +`) не считаются. Нечитаемый вывод — null.
 */
export function parseSevenZipListing(output: string): ArchiveListing | null {
  const marker = output.search(/^-{5,}\s*$/m);
  if (marker < 0) return null;
  const body = output.slice(marker).replace(/^-{5,}\s*$/m, "");
  let files = 0;
  let bytes = 0;
  for (const block of body.split(/\r?\n\r?\n/)) {
    if (!/^Path = /m.test(block)) continue;
    if (/^Folder = \+/m.test(block)) continue;
    if (/^Attributes = D/m.test(block)) continue;
    files += 1;
    const size = /^Size = (\d+)/m.exec(block);
    if (size) bytes += Number(size[1]);
  }
  return { files, bytes };
}

/** Разбор `unrar lt`: блоки «Name: … Type: File … Size: …». */
export function parseUnrarListing(output: string): ArchiveListing | null {
  if (!/^\s*Name: /m.test(output)) return null;
  let files = 0;
  let bytes = 0;
  for (const block of output.split(/\r?\n\r?\n/)) {
    if (!/^\s*Name: /m.test(block)) continue;
    if (!/^\s*Type: File/m.test(block)) continue;
    files += 1;
    const size = /^\s*Size: (\d+)/m.exec(block);
    if (size) bytes += Number(size[1]);
  }
  return { files, bytes };
}

/** Последние непустые строки вывода: причина сбоя для партнёра. */
function tailOf(result: CliRunResult): string {
  return `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3)
    .join(" ");
}

const PASSWORD_HINT = /password|encrypted|парол/i;

/** Какой программой читать архив этого формата; null — подходящей нет. */
export function pickTool(cli: ArchiveCli, kind: "rar" | "7z" | "zip"): "7z" | "unrar" | null {
  if (kind === "rar") return cli.unrar !== null ? "unrar" : cli.sevenZip !== null ? "7z" : null;
  return cli.sevenZip !== null ? "7z" : null;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} ГБ`;
}

/**
 * Распаковывает архив в `outDir`. Первый том комплекта распаковщик сам находит
 * остальные рядом, поэтому все тома обязаны лежать в одном каталоге под теми же
 * именами. Ошибка — исключение; частично распакованное не считается успехом,
 * если не распаковано ничего.
 */
export async function extractArchive(
  cli: ArchiveCli,
  tool: "7z" | "unrar",
  archivePath: string,
  outDir: string,
): Promise<void> {
  const program = tool === "7z" ? cli.sevenZip : cli.unrar;
  if (program === null) throw new Error(`Программа ${tool} не найдена.`);

  // Состав смотрим до распаковки: архив, который развернётся в десятки
  // гигабайт, заполнил бы диск воркера раньше, чем сработал бы любой счётчик.
  const listArgs =
    tool === "7z"
      ? ["l", "-slt", "-bd", "--", archivePath]
      : ["lt", "-p-", "-idq", archivePath];
  try {
    const listed = await cli.run(program, listArgs, { timeoutMs: LIST_TIMEOUT_MS });
    const listing =
      tool === "7z"
        ? parseSevenZipListing(listed.stdout)
        : parseUnrarListing(listed.stdout);
    if (listing !== null && listing.bytes > MAX_DISK_ARCHIVE_UNCOMPRESSED) {
      throw new ArchiveRefusedError(
        "TOO_LARGE",
        `Архив распаковывается в ${gigabytes(listing.bytes)}, это больше предела ` +
          `${gigabytes(MAX_DISK_ARCHIVE_UNCOMPRESSED)} и не читается.`,
      );
    }
  } catch (err) {
    if (err instanceof ArchiveRefusedError) throw err;
    // Просмотр не удался (таймаут, нестандартный вывод) — распаковываем без него:
    // настоящую причину назовёт сама распаковка.
  }

  const args =
    tool === "7z"
      ? // -aou: при совпадении имён файл переименовывается, а не затирает соседа.
        ["x", "-y", "-bd", "-aou", `-o${outDir}`, "--", archivePath]
      : // -or: то же для unrar; -p- — пароль не спрашивать.
        ["x", "-y", "-idq", "-p-", "-or", archivePath, `${outDir}/`];
  const result = await cli.run(program, args, { timeoutMs: EXTRACT_TIMEOUT_MS });

  // Код 0 — всё хорошо, 1 — предупреждения (у 7z: часть файлов недоступна, у
  // unrar: нефатальное). Остальное — сбой, но распакованное годно, если оно есть.
  if (result.code <= 1) return;

  const produced = await countFiles(outDir);
  if (produced > 0) return;

  const output = `${result.stderr}\n${result.stdout}`;
  if (PASSWORD_HINT.test(output)) {
    throw new ArchiveRefusedError("ENCRYPTED", "Архив под паролем: содержимое прочитать нечем.");
  }
  const tail = tailOf(result);
  throw new Error(
    tail.length > 0
      ? `${tool === "7z" ? "7-Zip" : "UnRAR"} не распаковал архив (код ${result.code}): ${tail}`
      : `${tool === "7z" ? "7-Zip" : "UnRAR"} не распаковал архив (код ${result.code}).`,
  );
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const info = await lstat(join(dir, name)).catch(() => null);
    if (info === null) continue;
    if (info.isDirectory()) count += await countFiles(join(dir, name));
    else if (info.isFile()) count += 1;
  }
  return count;
}

/**
 * Входы распакованного каталога. Содержимое не читается — только имена и объёмы:
 * файл читается, когда до него дошла очередь, и удаляется `release()`.
 * Ссылки и не-файлы пропускаются. Пределов здесь нет: их применяет обход.
 */
export async function listExtractedEntries(
  root: string,
  dir: string = root,
  prefix = "",
): Promise<ArchiveEntry[]> {
  const out: ArchiveEntry[] = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const relative = prefix.length > 0 ? `${prefix}/${name}` : name;
    const info = await lstat(full);

    if (info.isDirectory()) {
      out.push(...(await listExtractedEntries(root, full, relative)));
      continue;
    }
    if (!info.isFile()) continue; // ссылки, сокеты, устройства

    out.push({
      name: relative,
      size: info.size,
      path: full,
      bytes: async () => {
        // Без копии: Buffer и Uint8Array смотрят в один и тот же блок памяти.
        const data = await readFile(full);
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      },
      release: async () => {
        await rm(full, { force: true }).catch(() => undefined);
      },
    });
  }
  return out;
}

/** Склейка частей побайтовой нарезки (`.zip.001`, `.rar.001`) в один файл потоком. */
export async function concatFiles(parts: readonly string[], target: string): Promise<void> {
  const out = createWriteStream(target);
  try {
    for (const part of parts) {
      await pipeline(createReadStream(part), out, { end: false });
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
}
