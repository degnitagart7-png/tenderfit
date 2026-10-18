import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assessOcrPages,
  CommandMissingError,
  CommandTimeoutError,
  createOcrEngine,
  DEFAULT_OCR_LIMITS,
  isScrapPage,
  MIN_WORDS_PER_PAGE,
  ocrHeader,
  type CommandResult,
  type RunCommand,
} from "@/services/ocr";

/**
 * Распознавание сканов. Настоящие pdftoppm и tesseract здесь не запускаются:
 * команды подменяет порт `run`, который пишет «страницы» в настоящий временный
 * каталог — так проверяется и уборка файлов.
 */

/** Страница настоящего документа: сотня слов из трёх и более кириллических букв. */
const WORDS =
  "поставка товара осуществляется силами поставщика согласно условиям контракта ";
const REAL_PAGE = WORDS.repeat(8);

interface FakeOptions {
  /** Тексты страниц по порядку; у картинки — первый. */
  texts?: string[];
  /** Страницы, на которых tesseract «зависает». */
  timeoutPages?: number[];
  /** Страницы, на которых pdftoppm падает. */
  renderFailPages?: number[];
  /** Программы, которых «нет в системе». */
  missing?: string[];
  /** Вывод `tesseract --list-langs`. */
  langs?: string;
  /** Часы: каждая команда сдвигает их на столько миллисекунд. */
  clock?: { now: number; perCommand: number };
}

interface Call {
  file: string;
  args: string[];
  timeoutMs: number;
}

function fakeRun(options: FakeOptions = {}): {
  run: RunCommand;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: RunCommand = async (file, args, { timeoutMs }) => {
    calls.push({ file, args: [...args], timeoutMs });
    if (options.clock) options.clock.now += options.clock.perCommand;
    if (options.missing?.includes(file)) throw new CommandMissingError(file);

    if (file === "tesseract" && args[0] === "--list-langs") {
      return {
        stdout: options.langs ?? "List of available languages (2):\neng\nrus\n",
        stderr: "",
      };
    }
    if (file === "pdftoppm" && args[0] === "-v") {
      return { stdout: "", stderr: "pdftoppm version 24.02.0" };
    }

    if (file === "pdftoppm") {
      const page = Number(args[args.indexOf("-f") + 1]);
      if (options.renderFailPages?.includes(page))
        throw new Error("Syntax Error: Couldn't read xref table");
      const prefix = args[args.length - 1] as string;
      await writeFile(`${prefix}.png`, `page-${page}`);
      return { stdout: "", stderr: "" };
    }

    if (file === "tesseract") {
      const path = args[0] as string;
      const content = await readFile(path, "utf8").catch(() => "");
      const page = content.startsWith("page-") ? Number(content.slice(5)) : 1;
      if (options.timeoutPages?.includes(page))
        throw new CommandTimeoutError(file, timeoutMs);
      const texts = options.texts ?? [REAL_PAGE];
      const stdout = `${texts[page - 1] ?? texts[texts.length - 1] ?? ""}\f`;
      return { stdout, stderr: "" } satisfies CommandResult;
    }
    throw new Error(`Неожиданная команда ${file}`);
  };
  return { run, calls };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tenderfit-ocr-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createOcrEngine — наличие программ", () => {
  it("проверка делается один раз и запоминается", async () => {
    const { run, calls } = fakeRun();
    const engine = createOcrEngine({ run, tmpRoot: root });

    expect(await engine.available("pdf")).toBe(true);
    expect(await engine.available("image")).toBe(true);
    expect(await engine.available("pdf")).toBe(true);

    // Два пробника на весь срок жизни движка: tesseract и pdftoppm.
    expect(calls).toHaveLength(2);
  });

  it("нет tesseract — распознавания нет, это не ошибка", async () => {
    const { run } = fakeRun({ missing: ["tesseract"] });
    const engine = createOcrEngine({ run, tmpRoot: root });

    expect(await engine.available("pdf")).toBe(false);
    expect(await engine.available("image")).toBe(false);
    expect(await engine.recognizePdf(new Uint8Array([1]), 3)).toEqual({
      status: "unavailable",
      reason: "Распознавание на этом сервере недоступно.",
    });
  });

  it("нет pdftoppm — картинки читаются, pdf нет", async () => {
    const { run } = fakeRun({ missing: ["pdftoppm"] });
    const engine = createOcrEngine({ run, tmpRoot: root });

    expect(await engine.available("image")).toBe(true);
    expect(await engine.available("pdf")).toBe(false);
  });

  it("нет языкового пакета rus — распознавание недоступно", async () => {
    const { run } = fakeRun({
      langs: "List of available languages (1):\neng\n",
    });
    const engine = createOcrEngine({ run, tmpRoot: root });

    expect(await engine.available("pdf")).toBe(false);
  });

  it("список языков из stderr (Tesseract 4) тоже годится", async () => {
    const run: RunCommand = async (file, args) => {
      if (file === "tesseract" && args[0] === "--list-langs")
        return {
          stdout: "",
          stderr: "List of available languages (2):\neng\nrus\n",
        };
      return { stdout: "", stderr: "" };
    };
    expect(
      await createOcrEngine({ run, tmpRoot: root }).available("image"),
    ).toBe(true);
  });
});

describe("recognizePdf", () => {
  it("распознаёт страницы по одной и отдаёт текст по порядку", async () => {
    const { run, calls } = fakeRun({
      texts: ["Страница первая", "Страница вторая", "Страница третья"],
    });
    const engine = createOcrEngine({ run, tmpRoot: root });

    const result = await engine.recognizePdf(new Uint8Array([1, 2, 3]), 3);

    expect(result).toEqual({
      status: "ok",
      pages: ["Страница первая\n", "Страница вторая\n", "Страница третья\n"],
      recognized: 3,
      totalPages: 3,
      limitedBy: null,
    });

    const renders = calls.filter(
      (call) => call.file === "pdftoppm" && call.args[0] !== "-v",
    );
    expect(renders).toHaveLength(3);
    // Команда рендера: 200 dpi, серый, одна страница за вызов, без номера в имени файла.
    expect(renders[0]!.args.slice(0, 5)).toEqual([
      "-r",
      "200",
      "-gray",
      "-png",
      "-singlefile",
    ]);
    expect(renders[1]!.args).toContain("2");
    const tess = calls.filter(
      (call) => call.file === "tesseract" && call.args[0] !== "--list-langs",
    );
    expect(tess[0]!.args.slice(1)).toEqual([
      "stdout",
      "-l",
      "rus+eng",
      "--psm",
      "3",
    ]);
  });

  it("предела страниц нет: читаются все, сколько бы их ни было", async () => {
    const { run, calls } = fakeRun();
    const engine = createOcrEngine({ run, tmpRoot: root });

    const result = await engine.recognizePdf(new Uint8Array([1]), 57);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Раньше здесь было 20 из 57 и limitedBy «pages».
    expect(result.recognized).toBe(57);
    expect(result.totalPages).toBe(57);
    expect(result.limitedBy).toBeNull();
    expect(
      calls.filter((call) => call.file === "pdftoppm" && call.args[0] === "-r"),
    ).toHaveLength(57);
  });

  it("пределы по умолчанию: 90 секунд на страницу и 2 часа на файл", () => {
    expect(DEFAULT_OCR_LIMITS.maxPages).toBe(Number.POSITIVE_INFINITY);
    expect(DEFAULT_OCR_LIMITS.pageTimeoutMs).toBe(90_000);
    expect(DEFAULT_OCR_LIMITS.totalTimeoutMs).toBe(2 * 60 * 60_000);
  });

  it("страница, на которой tesseract завис, пропускается, остальные читаются", async () => {
    const { run, calls } = fakeRun({ timeoutPages: [2] });
    const engine = createOcrEngine({ run, tmpRoot: root });

    const result = await engine.recognizePdf(new Uint8Array([1]), 3);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.recognized).toBe(2);
    expect(result.pages[1]).toBeNull();
    // Таймаут на страницу — 90 с, и он действительно передан программе.
    const tess = calls.filter(
      (call) => call.file === "tesseract" && call.args[0] !== "--list-langs",
    );
    expect(tess.every((call) => call.timeoutMs <= 90_000)).toBe(true);
  });

  it("общий предел времени останавливает чтение: файл читается частично", async () => {
    const clock = { now: 0, perCommand: 50_000 };
    const { run } = fakeRun({ clock });
    const engine = createOcrEngine({
      run,
      tmpRoot: root,
      now: () => clock.now,
      limits: { totalTimeoutMs: 250_000 },
    });

    const result = await engine.recognizePdf(new Uint8Array([1]), 10);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Каждая страница стоит две команды по 50 с: после двух страниц набежало 200 с,
    // после третьей — 300 с > 250 с.
    expect(result.recognized).toBeLessThan(10);
    expect(result.recognized).toBeGreaterThanOrEqual(2);
    expect(result.limitedBy).toBe("time");
  });

  it("три сбоя подряд прекращают работу, и причина попадает в ответ", async () => {
    const { run, calls } = fakeRun({ renderFailPages: [1, 2, 3, 4, 5] });
    const engine = createOcrEngine({ run, tmpRoot: root });

    const result = await engine.recognizePdf(new Uint8Array([1]), 10);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("xref");
    expect(
      calls.filter((call) => call.file === "pdftoppm" && call.args[0] === "-r"),
    ).toHaveLength(3);
  });

  it("временные файлы убираются после успеха", async () => {
    const { run } = fakeRun();
    const engine = createOcrEngine({ run, tmpRoot: root });

    await engine.recognizePdf(new Uint8Array([1]), 3);

    expect(await readdir(root)).toEqual([]);
  });

  it("временные файлы убираются и после сбоя", async () => {
    const { run } = fakeRun({ renderFailPages: [1, 2, 3] });
    const engine = createOcrEngine({ run, tmpRoot: root });

    await engine.recognizePdf(new Uint8Array([1]), 3);

    expect(await readdir(root)).toEqual([]);
  });

  it("временные файлы убираются, даже когда запуск бросает необычную ошибку", async () => {
    const run: RunCommand = async (file, args) => {
      if (file === "tesseract" && args[0] === "--list-langs")
        return { stdout: "rus", stderr: "" };
      if (args[0] === "-v") return { stdout: "", stderr: "" };
      throw new TypeError("boom");
    };
    const engine = createOcrEngine({ run, tmpRoot: root });

    const result = await engine.recognizePdf(new Uint8Array([1]), 2);

    expect(result.status).toBe("failed");
    expect(await readdir(root)).toEqual([]);
  });

  it("страница удаляется сразу после распознавания: на диске не копятся png", async () => {
    let maxFiles = 0;
    const base = fakeRun();
    const run: RunCommand = async (file, args, options) => {
      const result = await base.run(file, args, options);
      if (file === "pdftoppm" && args[0] === "-r") {
        const [dir] = await readdir(root);
        const files = await readdir(join(root, dir!));
        maxFiles = Math.max(maxFiles, files.length);
      }
      return result;
    };
    const engine = createOcrEngine({ run, tmpRoot: root });

    await engine.recognizePdf(new Uint8Array([1]), 5);

    // pdf и одна текущая страница — всегда не больше двух файлов.
    expect(maxFiles).toBeLessThanOrEqual(2);
  });
});

describe("recognizeImage", () => {
  it("читает картинку одним вызовом tesseract", async () => {
    const { run, calls } = fakeRun({
      texts: ["Схема расположения оборудования"],
    });
    const engine = createOcrEngine({ run, tmpRoot: root });

    const result = await engine.recognizeImage(new Uint8Array([1, 2]), "PNG");

    expect(result).toMatchObject({
      status: "ok",
      recognized: 1,
      totalPages: 1,
    });
    const tess = calls.filter(
      (call) => call.file === "tesseract" && call.args[0] !== "--list-langs",
    );
    expect(tess).toHaveLength(1);
    expect(tess[0]!.args[0]).toMatch(/input\.png$/);
    expect(await readdir(root)).toEqual([]);
  });

  it("незнакомое расширение читается как png и не становится частью команды", async () => {
    const { run, calls } = fakeRun();
    const engine = createOcrEngine({ run, tmpRoot: root });

    await engine.recognizeImage(new Uint8Array([1]), "../../etc/passwd");

    const tess = calls.filter(
      (call) => call.file === "tesseract" && call.args[0] !== "--list-langs",
    );
    expect(tess[0]!.args[0]).toMatch(/input\.png$/);
  });

  it("сбой tesseract — причина в ответе, а не исключение", async () => {
    const { run } = fakeRun({ timeoutPages: [1] });
    const engine = createOcrEngine({ run, tmpRoot: root });

    const result = await engine.recognizeImage(new Uint8Array([1]), "jpg");

    expect(result.status).toBe("failed");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("детектор «схема или чертёж»", () => {
  const SCRAP = "А1 ø25 12 450 ГОСТ 3 б/н ↓ 45° Ш—Ш 1:50 2.5 м ± 10 Н В Д К";

  it("страница с настоящим текстом — не обрывки", () => {
    expect(isScrapPage(REAL_PAGE)).toBe(false);
  });

  it("мало слов из трёх букв и больше — обрывки", () => {
    expect(isScrapPage(SCRAP)).toBe(true);
    expect(isScrapPage("")).toBe(true);
    // Ровно на пороге: слов хватает, но знаков вокруг них слишком много.
    const words = Array.from({ length: MIN_WORDS_PER_PAGE }, () => "лист").join(
      " 12 ",
    );
    expect(isScrapPage(`${words} ${"1234567890 ".repeat(50)}`)).toBe(true);
  });

  it("80 и более процентов страниц-обрывков — схема, текст не отдаётся", () => {
    const pages = [SCRAP, SCRAP, SCRAP, SCRAP, REAL_PAGE];
    expect(assessOcrPages(pages)).toEqual({ kind: "scheme" });
  });

  it("меньше 80 процентов — берутся только страницы с текстом", () => {
    const pages = [REAL_PAGE, SCRAP, REAL_PAGE];
    const result = assessOcrPages(pages);
    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.text).toContain("поставка товара");
    expect(result.text).not.toContain("ГОСТ");
  });

  it("страницы, которые не распознались, в оценку не входят", () => {
    expect(assessOcrPages([null, REAL_PAGE, null]).kind).toBe("text");
    expect(assessOcrPages([null, null])).toEqual({ kind: "scheme" });
  });

  it("заголовок распознанного текста", () => {
    expect(ocrHeader(7, 12)).toBe("[Текст распознан со скана: 7 стр. из 12]");
  });
});
