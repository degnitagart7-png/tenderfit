/**
 * Распознавание текста со сканов: pdf без текстового слоя и картинки. Серверная часть.
 *
 * Модуль тянет `node:child_process` и временные файлы, поэтому его нельзя
 * импортировать из клиентского кода. attachmentParser подключает его
 * динамическим `import()` и только когда встретился скан.
 *
 * Как устроено. Никаких библиотек распознавания в проект не добавлено — на
 * сервере (Ubuntu, 2 ядра, 4 ГБ) стоят два набора программ, и модуль вызывает
 * их бинарники:
 *   - `pdftoppm` из poppler-utils — рисует одну страницу pdf в png;
 *   - `tesseract` с языковым пакетом rus — читает png.
 * Страницы обрабатываются строго по одной: png страницы 200 dpi весит
 * мегабайты, а Tesseract держит ещё несколько копий в памяти.
 *
 * Пределы (владелец проекта, 2026-10-08): страниц не ограничено — читаются все;
 * не больше 90 секунд на страницу; 2 часа на файл — это не рабочий лимит, а
 * аварийная защита от зависшей программы. Раньше было 20 страниц, 60 секунд на
 * страницу и 6 минут на файл, и сканы больше двадцати страниц читались частично.
 * Упёрлись в предел времени — файл читается частично, и это видно по счётчику
 * «N стр. из M».
 *
 * Бинарников нет (локальная машина, чужой сервер) — это не ошибка. Проверка
 * делается один раз и запоминается; файл остаётся «без текстового слоя» с
 * пометкой, что распознавание на этом сервере недоступно.
 *
 * Тесты не запускают распознавание: команды подменяются портом `run`.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OCR_UNAVAILABLE_NOTE } from "@/services/ocrQuality";

export {
  MIN_WORDS_PER_PAGE,
  MIN_WORD_CHAR_RATIO,
  OCR_UNAVAILABLE_NOTE,
  SCRAP_PAGES_SHARE,
  assessOcrPages,
  isScrapPage,
  ocrHeader,
} from "@/services/ocrQuality";
export type { OcrAssessment } from "@/services/ocrQuality";

export interface OcrLimits {
  /** Сколько страниц pdf распознаётся; остальные пропускаются. Infinity — все. */
  maxPages: number;
  /** Сколько миллисекунд отведено на одну страницу (отрисовка и распознавание вместе). */
  pageTimeoutMs: number;
  /** Сколько миллисекунд отведено на файл целиком. */
  totalTimeoutMs: number;
  /** Разрешение отрисовки страницы. 200 dpi — компромисс точности и скорости. */
  dpi: number;
}

export const DEFAULT_OCR_LIMITS: Readonly<OcrLimits> = {
  maxPages: Number.POSITIVE_INFINITY,
  pageTimeoutMs: 90_000,
  totalTimeoutMs: 2 * 60 * 60_000,
  dpi: 200,
};

/** Языки Tesseract: русский основной, английский для артикулов и единиц измерения. */
const OCR_LANGUAGES = "rus+eng";

/** Результат запуска внешней программы. */
export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** Программа не нашлась в PATH. */
export class CommandMissingError extends Error {
  constructor(readonly command: string) {
    super(`Программа ${command} не установлена.`);
    this.name = "CommandMissingError";
  }
}

/** Программа не уложилась в отведённое время и была убита. */
export class CommandTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} не уложился в ${Math.round(timeoutMs / 1000)} с.`);
    this.name = "CommandTimeoutError";
  }
}

/**
 * Порт запуска внешней программы. Реализация по умолчанию — `execFile`;
 * тесты подставляют свою и не запускают ничего настоящего.
 */
export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<CommandResult>;

/** Запуск через `execFile`: без оболочки, поэтому имя файла не может стать командой. */
export const runCommand: RunCommand = (file, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
        // Одна нить Tesseract на странице: на двух ядрах это быстрее, чем
        // четыре нити, дерущиеся за них.
        env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === "ENOENT") {
          reject(new CommandMissingError(file));
          return;
        }
        if (failure.killed === true) {
          reject(new CommandTimeoutError(file, timeoutMs));
          return;
        }
        const tail = String(stderr).trim().split("\n").slice(-2).join(" ");
        reject(new Error(tail.length > 0 ? tail : failure.message));
      },
    );
    // Стандартный ввод закрыт сразу: программе, которая вздумает о чём-то
    // спросить, достанется конец файла, а не вечное ожидание до таймаута.
    child.stdin?.end();
  });

export interface OcrDeps {
  run?: RunCommand;
  /** Каталог временных файлов; по умолчанию os.tmpdir(). */
  tmpRoot?: string;
  /** Часы в миллисекундах. Тесты подставляют свои. */
  now?: () => number;
  limits?: Partial<OcrLimits>;
}

/** Что вернуло распознавание. */
export type OcrResult =
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string }
  | {
      status: "ok";
      /** Текст по страницам; null — страница не распозналась (сбой или время). */
      pages: (string | null)[];
      /** Сколько страниц распознано. */
      recognized: number;
      /** Сколько страниц в файле всего. */
      totalPages: number;
      /** Чем упёрлись: предел страниц, предел времени или ничем. */
      limitedBy: "pages" | "time" | null;
    };

export interface OcrEngine {
  /** Есть ли программы для этого вида файла. Проверяется один раз. */
  available(kind: "pdf" | "image"): Promise<boolean>;
  recognizePdf(bytes: Uint8Array, totalPages: number): Promise<OcrResult>;
  recognizeImage(bytes: Uint8Array, extension: string): Promise<OcrResult>;
}

/** Расширение временного файла картинки; всё незнакомое читается как png. */
function imageFileName(extension: string): string {
  const ext = extension.toLowerCase().replace(/[^a-z]/g, "");
  return ["png", "jpg", "jpeg", "tif", "tiff"].includes(ext)
    ? `input.${ext}`
    : "input.png";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Движок, который не распознаёт ничего: переключатель `TENDERFIT_OCR=off`. */
const disabledEngine: OcrEngine = {
  available: async () => false,
  recognizePdf: async () => ({
    status: "unavailable",
    reason: OCR_UNAVAILABLE_NOTE,
  }),
  recognizeImage: async () => ({
    status: "unavailable",
    reason: OCR_UNAVAILABLE_NOTE,
  }),
};

export function createOcrEngine(deps: OcrDeps = {}): OcrEngine {
  const run = deps.run ?? runCommand;
  const now = deps.now ?? Date.now;
  const limits: OcrLimits = { ...DEFAULT_OCR_LIMITS, ...deps.limits };

  /** Проверка бинарников делается один раз за жизнь движка. */
  let probe: Promise<{ tesseract: boolean; pdftoppm: boolean }> | null = null;

  const probeBinaries = (): Promise<{
    tesseract: boolean;
    pdftoppm: boolean;
  }> => {
    probe ??= (async () => {
      let tesseract = false;
      try {
        const listed = await run("tesseract", ["--list-langs"], {
          timeoutMs: 15_000,
        });
        // Список языков Tesseract 4 печатает в stderr, пятый — в stdout.
        tesseract = /^rus\s*$/m.test(`${listed.stdout}\n${listed.stderr}`);
      } catch {
        tesseract = false;
      }
      let pdftoppm = false;
      try {
        await run("pdftoppm", ["-v"], { timeoutMs: 15_000 });
        pdftoppm = true;
      } catch {
        pdftoppm = false;
      }
      return { tesseract, pdftoppm };
    })();
    return probe;
  };

  const available = async (kind: "pdf" | "image"): Promise<boolean> => {
    const found = await probeBinaries();
    return kind === "pdf" ? found.tesseract && found.pdftoppm : found.tesseract;
  };

  const withTempDir = async <T>(
    work: (dir: string) => Promise<T>,
  ): Promise<T> => {
    const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "tenderfit-ocr-"));
    try {
      return await work(dir);
    } finally {
      // Каталог уезжает целиком при любом исходе: и при ошибке, и при таймауте.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const tesseractArgs = (imagePath: string): string[] => [
    imagePath,
    "stdout",
    "-l",
    OCR_LANGUAGES,
    "--psm",
    "3",
  ];

  return {
    available,

    async recognizePdf(bytes, totalPages) {
      if (!(await available("pdf")))
        return { status: "unavailable", reason: OCR_UNAVAILABLE_NOTE };

      const toDo = Math.min(Math.max(totalPages, 0), limits.maxPages);
      if (toDo === 0)
        return { status: "failed", reason: "В файле нет страниц." };

      return withTempDir(async (dir) => {
        const pdfPath = join(dir, "input.pdf");
        const pagePrefix = join(dir, "page");
        const pagePath = `${pagePrefix}.png`;
        await writeFile(pdfPath, bytes);

        const started = now();
        const pages: (string | null)[] = [];
        let recognized = 0;
        let failuresInRow = 0;
        let lastError = "";
        let limitedBy: "pages" | "time" | null = null;

        for (let page = 1; page <= toDo; page += 1) {
          const spent = now() - started;
          if (spent >= limits.totalTimeoutMs) {
            limitedBy = "time";
            break;
          }
          const pageStart = now();
          const pageBudget = Math.min(
            limits.pageTimeoutMs,
            limits.totalTimeoutMs - spent,
          );

          try {
            // -singlefile: файл называется ровно «page.png», без номера страницы.
            await run(
              "pdftoppm",
              [
                "-r",
                String(limits.dpi),
                "-gray",
                "-png",
                "-singlefile",
                "-f",
                String(page),
                "-l",
                String(page),
                pdfPath,
                pagePrefix,
              ],
              { timeoutMs: pageBudget },
            );
            const left = Math.max(1000, pageBudget - (now() - pageStart));
            const result = await run("tesseract", tesseractArgs(pagePath), {
              timeoutMs: left,
            });
            pages.push(result.stdout.replace(/\f/g, "\n"));
            recognized += 1;
            failuresInRow = 0;
          } catch (err) {
            pages.push(null);
            lastError = messageOf(err);
            failuresInRow += 1;
          } finally {
            // Страница нужна только пока её читает Tesseract.
            await rm(pagePath, { force: true }).catch(() => {});
          }

          // Три сбоя подряд — файл битый или программа сломана: дальше нет смысла.
          if (failuresInRow >= 3) break;
        }

        if (recognized === 0) {
          return {
            status: "failed",
            reason: `Распознавание не удалось${lastError ? `: ${lastError}` : "."}`,
          };
        }

        if (limitedBy === null && toDo < totalPages) limitedBy = "pages";
        return { status: "ok", pages, recognized, totalPages, limitedBy };
      });
    },

    async recognizeImage(bytes, extension) {
      if (!(await available("image")))
        return { status: "unavailable", reason: OCR_UNAVAILABLE_NOTE };

      return withTempDir(async (dir) => {
        const imagePath = join(dir, imageFileName(extension));
        await writeFile(imagePath, bytes);
        try {
          const result = await run("tesseract", tesseractArgs(imagePath), {
            timeoutMs: limits.totalTimeoutMs,
          });
          return {
            status: "ok",
            pages: [result.stdout.replace(/\f/g, "\n")],
            recognized: 1,
            totalPages: 1,
            limitedBy: null,
          };
        } catch (err) {
          return {
            status: "failed",
            reason: `Распознавание не удалось: ${messageOf(err)}`,
          };
        }
      });
    },
  };
}

let sharedEngine: OcrEngine | null = null;

/**
 * Общий движок процесса: проверка бинарников делается один раз.
 * `TENDERFIT_OCR=off` отключает распознавание целиком (и тесты, и сервер без
 * желания тратить на него процессорное время).
 */
export function getOcrEngine(): OcrEngine {
  if (process.env["TENDERFIT_OCR"]?.toLowerCase() === "off")
    return disabledEngine;
  sharedEngine ??= createOcrEngine();
  return sharedEngine;
}
