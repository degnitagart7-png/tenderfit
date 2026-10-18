import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as XLSX from "xlsx";

import {
  buildWageAnchors,
  findFscsrSheets,
  parseFscsr,
  type FscsrData,
} from "../../src/domain/estimate/zoneBuild";
import { parseCsvRecords, splitCsvHeader } from "../../src/lib/fsnb/csv";
import { parseNormsXml, parsePriceCatalogXml } from "../../src/lib/fsnb/fsnbXml";
import { XmlTokenizer, type XmlToken } from "../../src/lib/fsnb/xmlTokenizer";

/**
 * Сборка локальных индексов ФСНБ-2022 из открытых данных ФГИС ЦС.
 *
 * Зачем отдельный шаг. Исходники весят 158 МБ XML плюс XLSX и CSV, а расчёт
 * сметы работает с компактными записями: норма, цена ресурса, ставка разряда.
 * Скрипт один раз превращает сырьё в JSONL, который читает репозиторий базы
 * сметных данных. Ничего из `data/fsnb` в прод не уходит: каталог исключён и из
 * `.gitignore`, и из `.vercelignore`.
 *
 * Четыре решения, которые легко испортить при правке:
 *
 * 1. Чтение XML синхронное, кусками по 1 МиБ, через `StringDecoder`.
 *    `parseNormsXml` принимает `Iterable<XmlToken>`, а не `AsyncIterable`,
 *    поэтому асинхронный генератор сюда не подходит — он упадёт с
 *    «tokens is not iterable». `StringDecoder` обязателен, потому что
 *    `Buffer.toString("utf8", 0, n)` режет многобайтовую кириллицу на границе
 *    куска и портит наименование нормы.
 *
 * 2. Нулевые цены сохраняются как есть. В «ФСБЦ_Маш.xml» десять машин имеют
 *    полную цену 0 ₽, девять из них — землесосы папильонажные рефулерные,
 *    которые встречаются внутри `<Work>` книги «ГЭСН.xml» 63 раза. Отфильтровать
 *    ноль здесь значило бы спрятать проблему от расчёта: вместо пометки
 *    ZERO_PRICE позиция получила бы NO_PRICE и выглядела отсутствующей в
 *    справочнике, хотя она там есть. Решает расчёт, не сборка.
 *
 * 3. Дубли в листе машин ФСЦСР схлопываются по коду, и это не потеря данных.
 *    Измерено по выгрузке: 456 строк, 228 кодов, каждый ровно дважды, других
 *    вариантов нет. Из 228 пар 145 совпадают целиком, а 83 отличаются одной
 *    ячейкой — колонкой электроэнергии, где в одной строке киловатт-часы, а в
 *    другой рубли. Цена, зарплата машинистов, разряд и трудозатраты в парах
 *    совпадают всегда. Расхождение по этим полям всё же считается и попадает в
 *    отчёт: если выгрузка сменится, молча терять данные нельзя.
 *
 * 4. Колонка «Оплата труда машинистов» уже дана за один маш.-ч суммарно по
 *    звену, поэтому в `ResourcePrice.machinistSalary` она уходит без умножения.
 *    Проверка — деление на колонку «Трудозатраты машинистов»: экскаватор
 *    91.01.05-134 даёт 2 250,32 / 2 = 1 125,16 ₽ за разряд 8, ровно якорь шкалы.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/build-index.ts                 — собрать всё
 *   npx tsx scripts/fsnb/build-index.ts --only norms    — только книги норм
 *   npx tsx scripts/fsnb/build-index.ts --books ГЭСН,ГЭСНр
 *
 * Этапы: norms, prices, wages, zones.
 */

const ROOT = resolve(__dirname, "../..");
const RAW = resolve(ROOT, "data/fsnb/raw");
const OUT = resolve(ROOT, "data/fsnb/index");

/** Книги норм в порядке убывания объёма: так прогресс виден раньше. */
const NORM_BOOKS = ["ГЭСН", "ГЭСНм", "ГЭСНр", "ГЭСНп", "ГЭСНмр"] as const;

const MACHINE_CATALOG = "ФСБЦ_Маш.xml";
const MATERIAL_CATALOG = "ФСБЦ_Мат&Оборуд.xml";
const FSCSR_XLSX = "fscsr/amur-z1-3kv2026.xlsx";
const WAGE_REGISTRY = "wages-amur-z1-427.json";
const ZONES_CSV = "price-zones.csv";

/** Размер куска при чтении XML. */
const CHUNK_BYTES = 1024 * 1024;

/** Сколько строк копится перед записью: держит буфер в пределах пары мегабайт. */
const WRITE_BUFFER_LINES = 2000;

interface SourceStat {
  readonly source: string;
  readonly bytes: number;
  readonly records: number;
}

interface OutputStat {
  readonly lines: number;
  readonly bytes: number;
}

interface StageResult extends SourceStat {
  readonly outputs: Readonly<Record<string, OutputStat>>;
  readonly notes: readonly string[];
}

interface BuildReport {
  readonly builtAt: string;
  readonly baseEdition: string;
  readonly region: string;
  readonly zone: string;
  readonly period: string;
  readonly decree: string;
  readonly sources: readonly SourceStat[];
  readonly outputs: Readonly<Record<string, OutputStat>>;
  readonly notes: readonly string[];
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Поточная запись JSONL: строки копятся небольшим буфером и уходят на диск. */
class JsonlWriter {
  private readonly fd: number;
  private buffer: string[] = [];
  private written = 0;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "w");
  }

  append(record: unknown): void {
    this.buffer.push(JSON.stringify(record));
    if (this.buffer.length >= WRITE_BUFFER_LINES) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    writeSync(this.fd, `${this.buffer.join("\n")}\n`);
    this.written += this.buffer.length;
    this.buffer = [];
  }

  close(): OutputStat {
    this.flush();
    closeSync(this.fd);
    return { lines: this.written, bytes: statSync(this.path).size };
  }
}

/** Читает XML кусками и отдаёт токены. Синхронно — см. решение 1 в шапке. */
function* streamXmlTokens(path: string): Generator<XmlToken> {
  const fd = openSync(path, "r");
  const chunk = Buffer.alloc(CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  const tokenizer = new XmlTokenizer();
  let position = 0;

  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, CHUNK_BYTES, position);
      if (read === 0) break;
      position += read;
      const text = decoder.write(chunk.subarray(0, read));
      // Обе выгрузки начинаются с BOM: убираем, чтобы не давать её токенайзеру.
      const stripped = position === read && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      yield* tokenizer.push(stripped);
    }
    const tail = decoder.end();
    if (tail.length > 0) yield* tokenizer.push(tail);
    yield* tokenizer.flush();
  } finally {
    closeSync(fd);
  }
}

function requireRaw(relativePath: string): string {
  const path = resolve(RAW, relativePath);
  if (!existsSync(path)) {
    throw new Error(
      `Не найден исходник data/fsnb/raw/${relativePath}. Скачайте открытые данные ФГИС ЦС и повторите сборку.`,
    );
  }
  return path;
}

/**
 * Книги норм → `norms.jsonl`.
 *
 * Идентичность нормы — пара (baseType, code), поэтому запасное имя книги
 * берётся из имени файла и перезаписывается атрибутом `BaseType` корневого
 * элемента, когда он задан.
 */
function buildNorms(books: readonly string[]): StageResult {
  const writer = new JsonlWriter(resolve(OUT, "norms.jsonl"));
  const sources: SourceStat[] = [];
  const notes: string[] = [];
  const perBook: string[] = [];
  let total = 0;
  let emptyCode = 0;
  let totalBytes = 0;

  for (const book of books) {
    const relative = `xml/${book}.xml`;
    const path = requireRaw(relative);
    const before = total;
    const started = Date.now();

    for (const norm of parseNormsXml(streamXmlTokens(path), book)) {
      if (norm.code.length === 0) {
        emptyCode += 1;
        continue;
      }
      writer.append(norm);
      total += 1;
      if (total % 10_000 === 0) log(`  …${total} норм`);
    }

    const count = total - before;
    const bytes = statSync(path).size;
    perBook.push(`${book} ${count}`);
    sources.push({ source: relative, bytes, records: count });
    totalBytes += bytes;
    log(`  ${book}: ${count} норм за ${((Date.now() - started) / 1000).toFixed(1)} с`);
  }

  if (emptyCode > 0) {
    notes.push(
      `Пропущено элементов Work без кода: ${emptyCode}. Норму без шифра нельзя ни найти, ни проверить, поэтому в индекс она не попадает.`,
    );
  }
  notes.push(`Книг ${perBook.length}: ${perBook.join(", ")}.`);
  notes.push(
    "Код нормы уникален только вместе с книгой: в выгрузке 2 784 кода встречаются больше чем в одной книге, и «01-01-001-01» — это одновременно драглайн, токарный станок, синхронный генератор и замок двери шахты лифта.",
  );

  return {
    source: sources.map((item) => item.source).join(", "),
    bytes: totalBytes,
    records: total,
    outputs: { "norms.jsonl": writer.close() },
    notes,
  };
}

/** Справочники ФСБЦ → `prices-base.jsonl`. */
function buildBasePrices(): StageResult {
  const writer = new JsonlWriter(resolve(OUT, "prices-base.jsonl"));
  const sources: SourceStat[] = [];
  const notes: string[] = [];
  let total = 0;
  let totalBytes = 0;
  let zeroPrices = 0;
  const zeroCodes: string[] = [];

  const catalogs: ReadonlyArray<readonly [string, "machine" | "material"]> = [
    [MACHINE_CATALOG, "machine"],
    [MATERIAL_CATALOG, "material"],
  ];

  for (const [relative, kind] of catalogs) {
    const path = requireRaw(`xml/${relative}`);
    let count = 0;

    for (const item of parsePriceCatalogXml(streamXmlTokens(path), kind)) {
      if (item.price.price === 0) {
        zeroPrices += 1;
        if (zeroCodes.length < 10) zeroCodes.push(item.price.code);
      }
      writer.append(item.price);
      count += 1;
      total += 1;
    }

    const bytes = statSync(path).size;
    sources.push({ source: `xml/${relative}`, bytes, records: count });
    totalBytes += bytes;
    log(`  ${relative}: ${count} цен`);
  }

  if (zeroPrices > 0) {
    notes.push(
      `Цен, равных нулю, ${zeroPrices}; они сохранены как есть — расчёт покажет их пробелом ZERO_PRICE, а не потеряет. Примеры: ${zeroCodes.join(", ")}.`,
    );
  }
  notes.push(
    "В индекс попали только элементы <Price>. Атрибут Cost внутри <ExpendableMaterials> — это стоимость электроэнергии, а не сметная цена маш.-ч: таких атрибутов в «ФСБЦ_Маш.xml» 1 112.",
  );

  return {
    source: sources.map((item) => item.source).join(", "),
    bytes: totalBytes,
    records: total,
    outputs: { "prices-base.jsonl": writer.close() },
    notes,
  };
}

interface FscsrFile extends FscsrData {
  readonly bytes: number;
}

/** XLSX ФСЦСР → текущие цены зоны и якоря ставок машинистов (разбор — `zoneBuild.ts`). */
function readFscsr(): FscsrFile {
  const path = requireRaw(FSCSR_XLSX);
  const workbook = XLSX.readFile(path);
  const names = findFscsrSheets(workbook.SheetNames);
  const machineSheet = names === null ? undefined : workbook.Sheets[names.machines];
  const materialSheet = names === null ? undefined : workbook.Sheets[names.materials];

  if (machineSheet === undefined || materialSheet === undefined) {
    throw new Error(
      `В ${FSCSR_XLSX} ожидаются листы «Машины и механизмы» и «Материалы и оборудование», найдены: ${workbook.SheetNames.join(", ")}`,
    );
  }

  const machineRows = XLSX.utils.sheet_to_json<unknown[]>(machineSheet, { header: 1, defval: "" });
  const materialRows = XLSX.utils.sheet_to_json<unknown[]>(materialSheet, { header: 1, defval: "" });
  return { ...parseFscsr(machineRows, materialRows), bytes: statSync(path).size };
}

/** Текущие цены зоны → `prices-current.jsonl`. */
function buildCurrentPrices(data: FscsrFile): StageResult {
  const writer = new JsonlWriter(resolve(OUT, "prices-current.jsonl"));
  for (const price of [...data.machines, ...data.materials]) writer.append(price);

  return {
    source: FSCSR_XLSX,
    bytes: data.bytes,
    records: data.machines.length + data.materials.length,
    outputs: { "prices-current.jsonl": writer.close() },
    notes: data.notes,
  };
}

/** Реестр ставок рабочих + якоря машинистов → `wages.jsonl` (разбор — `zoneBuild.ts`). */
function buildWages(data: FscsrFile): StageResult {
  const path = requireRaw(WAGE_REGISTRY);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const built = buildWageAnchors(parsed, data.anchors);

  const writer = new JsonlWriter(resolve(OUT, "wages.jsonl"));
  for (const anchor of built.anchors) writer.append(anchor);
  for (const item of built.machinists) writer.append({ kind: "MACHINIST", ...item });
  for (const item of built.specialists) writer.append({ kind: "SPECIALIST", ...item });

  return {
    source: `${WAGE_REGISTRY} + ${FSCSR_XLSX}`,
    bytes: statSync(path).size,
    records: built.anchors.length + built.machinists.length + built.specialists.length,
    outputs: { "wages.jsonl": writer.close() },
    notes: built.notes,
  };
}

/**
 * Поле записи CSV. `parseCsvRecords` возвращает значения как есть, поэтому
 * схлопывание переносов — задача вызывающего кода: в ценовых зонах название
 * зоны Архангельской области разорвано переводом строки, и без этого оно уехало
 * бы в индекс двумя строками.
 */
function csvCell(row: readonly string[], index: number): string {
  return (row[index] ?? "").replace(/\s+/gu, " ").trim();
}

interface ZoneRecord {
  readonly subjectCode: string;
  readonly subjectName: string;
  readonly zoneName: string;
  readonly center: string;
  readonly municipalities: string;
}

/**
 * Ценовые зоны → `zones.jsonl`. Файл в cp1251, разделитель «;».
 *
 * Разбор идёт через `parseCsvRecords`, а не построчно: название зоны
 * Архангельской области заключено в кавычки и разорвано переносом строки, так
 * что `split("\n")` принял бы первую половину за целую запись, а хвост — за
 * новую строку: в индекс легли бы урезанное название и мусорная запись.
 * Субъекты без ценовой зоны не выбрасываются тихо — они перечисляются в отчёте
 * сборки, иначе расчёт не узнает, почему по такому региону нет ни одной зоны.
 */
function buildZones(): StageResult {
  const path = requireRaw(ZONES_CSV);
  const text = new TextDecoder("windows-1251").decode(readFileSync(path));
  const split = splitCsvHeader(parseCsvRecords(text));
  if (split === null) {
    throw new Error("price-zones.csv пуст или содержит только заголовок.");
  }
  if (!/Код субъекта/i.test(split.header[0] ?? "")) {
    throw new Error(
      `Неожиданный заголовок price-zones.csv: «${split.header[0] ?? ""}». Файл должен быть в cp1251 с разделителем «;».`,
    );
  }

  const writer = new JsonlWriter(resolve(OUT, "zones.jsonl"));
  const subjects = new Set<string>();
  const withoutZone: string[] = [];
  let count = 0;

  for (const cells of split.rows) {
    const record: ZoneRecord = {
      subjectCode: csvCell(cells, 0),
      subjectName: csvCell(cells, 1),
      zoneName: csvCell(cells, 2),
      center: csvCell(cells, 3),
      municipalities: csvCell(cells, 4),
    };
    if (record.zoneName.length === 0) {
      withoutZone.push(`${record.subjectCode} ${record.subjectName}`.trim());
      continue;
    }
    subjects.add(record.subjectCode);
    writer.append(record);
    count += 1;
  }

  return {
    source: ZONES_CSV,
    bytes: statSync(path).size,
    records: count,
    outputs: { "zones.jsonl": writer.close() },
    notes: [
      `Ценовых зон ${count} в ${subjects.size} субъектах РФ.`,
      ...(withoutZone.length > 0
        ? [
            `Без ценовой зоны ${withoutZone.length} субъектов, в индекс не попали: ${withoutZone.join("; ")}.`,
          ]
        : []),
      "Числовых идентификаторов зон ФГИС ЦС в файле нет: соответствие «Амурская область (1 зона)» → priceZoneId 282 установлено по ответу RimWorkerSalaryRegistry и по подписи в выгрузке ФСЦСР.",
    ],
  };
}

/** Номер и дата приказа из заголовка справочника ФСБЦ. */
function readDecree(): string {
  const fd = openSync(requireRaw(`xml/${MACHINE_CATALOG}`), "r");
  const chunk = Buffer.alloc(4096);
  const read = readSync(fd, chunk, 0, 4096, 0);
  closeSync(fd);

  const head = chunk.toString("utf8", 0, read);
  const number = /<ApprovingActNumber>([^<]*)<\/ApprovingActNumber>/.exec(head)?.[1]?.trim() ?? "";
  const date = /<ApprovingActDate>([^<]*)<\/ApprovingActDate>/.exec(head)?.[1]?.trim() ?? "";
  return number.length === 0 ? "" : `Приказ Минстроя России № ${number} от ${date}`;
}

interface CliOptions {
  readonly only: string | null;
  readonly books: readonly string[];
}

function parseArgs(argv: readonly string[]): CliOptions {
  let only: string | null = null;
  let books: readonly string[] = NORM_BOOKS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (argv[index + 1] ?? "").trim();
    if (arg === "--only") {
      only = value.length > 0 ? value : null;
      index += 1;
    } else if (arg === "--books") {
      const requested = value.split(",").map((book) => book.trim()).filter((book) => book.length > 0);
      if (requested.length > 0) books = requested;
      index += 1;
    }
  }

  return { only, books };
}

const STAGES = ["norms", "prices", "wages", "zones"] as const;

function main(): void {
  const { only, books } = parseArgs(process.argv.slice(2));
  if (only !== null && !STAGES.includes(only as (typeof STAGES)[number])) {
    throw new Error(`Неизвестный этап «${only}». Доступны: ${STAGES.join(", ")}.`);
  }

  const started = Date.now();
  mkdirSync(OUT, { recursive: true });

  const wanted = (stage: string): boolean => only === null || only === stage;
  const stages: StageResult[] = [];
  const run = (stage: StageResult): void => {
    stages.push(stage);
  };

  // Выгрузка ФСЦСР нужна двум этапам, поэтому читается один раз.
  const fscsr = wanted("prices") || wanted("wages") ? readFscsr() : null;

  if (wanted("norms")) {
    log("— norms");
    run(buildNorms(books));
  }
  if (wanted("prices")) {
    log("— prices");
    const base = buildBasePrices();
    if (fscsr === null) {
      run(base);
    } else {
      const current = buildCurrentPrices(fscsr);
      run({
        source: `${base.source} + ${current.source}`,
        bytes: base.bytes + current.bytes,
        records: base.records + current.records,
        outputs: { ...base.outputs, ...current.outputs },
        notes: [...base.notes, ...current.notes],
      });
    }
  }
  if (wanted("wages")) {
    log("— wages");
    if (fscsr === null) throw new Error("Этап wages не может работать без выгрузки ФСЦСР.");
    run(buildWages(fscsr));
  }
  if (wanted("zones")) {
    log("— zones");
    run(buildZones());
  }

  if (only === null) {
    const report: BuildReport = {
      builtAt: new Date(started).toISOString(),
      baseEdition: "01.01.2022",
      region: fscsr?.meta.region ?? "",
      zone: fscsr?.meta.zone ?? "",
      period: fscsr?.meta.period ?? "",
      decree: readDecree(),
      sources: stages.map(({ source, bytes, records }) => ({ source, bytes, records })),
      outputs: Object.fromEntries(stages.flatMap((stage) => Object.entries(stage.outputs))),
      notes: [
        ...stages.flatMap((stage) => stage.notes),
        "Индексы пересчёта к текущим ценам, нормативы накладных расходов (812/пр) и сметной прибыли (774/пр) опубликованы Минстроем только письмами в PDF и в индекс не входят: расчёт принимает их параметрами и помечает каждую позицию, где их нет.",
      ],
    };
    writeFileSync(resolve(OUT, "build-info.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log("— build-info.json");
  }

  const summary = stages
    .flatMap((stage) => Object.entries(stage.outputs).map(([name, value]) => `${name} ${value.lines}`))
    .join(", ");
  log(`Готово за ${((Date.now() - started) / 1000).toFixed(1)} с: ${summary}`);
}

main();
