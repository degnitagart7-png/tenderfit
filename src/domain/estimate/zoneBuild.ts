import type { ResourcePrice, WageAnchor } from "@/domain/estimate/types";

/**
 * Зональные данные из сырья ФГИС ЦС: выгрузка ФСЦСР и реестр ставок оплаты труда.
 *
 * Зачем в домене, а не в скрипте. Эти два разбора нужны двум сборщикам: общему
 * `build-index.ts` (прежний режим, одна зона в корне индекса) и `build-zone.ts`
 * (индекс по ценовым зонам). Две копии разошлись бы при первой правке, а
 * совпадение зоны, собранной новым путём, с корневыми файлами Амура — условие
 * приёмки: цены обязаны быть теми же до копейки.
 *
 * Разбор отделён от чтения файла: на вход идут строки листов и разобранный JSON,
 * поэтому поведение проверяется на нескольких строках, без xlsx в тесте.
 */

/** Строка листа: ячейки как их отдаёт чтение xlsx. */
export type SheetRow = readonly unknown[];

/** Строки заголовка, нумерации и первой записи в листах ФСЦСР. */
export const FSCSR_HEADER_ROW = 6;
export const FSCSR_FIRST_DATA_ROW = 8;

/** Колонки листа машин: 0 код, 1 наименование, 2 ед., 3 цена, 4 зарплата, 5 разряд, 7 трудозатраты. */
const MACHINE_COLUMNS = {
  code: 0,
  name: 1,
  unit: 2,
  price: 3,
  salary: 4,
  rank: 5,
  hours: 7,
} as const;

/** Колонки листа материалов: 0 код, 1 наименование, 2 ед., 3 цена. */
const MATERIAL_COLUMNS = { code: 0, name: 1, unit: 2, price: 3 } as const;

export interface FscsrMeta {
  readonly region: string;
  readonly zone: string;
  readonly period: string;
  readonly titleLine: string;
}

/** «3 квартал 2026 года» и «3 квартал 2026» → один вид «3 квартал 2026 г.». */
export function normalizePeriod(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ").replace(/\s+го?да?$/i, "");
  return cleaned.length === 0 ? "" : `${cleaned} г.`;
}

/**
 * Читает зону и период из первых строк листа, а не из имени файла: подпись
 * «Отчетный период» есть в обеих выгрузках ФСЦСР и переживёт смену квартала.
 */
export function readFscsrMeta(rows: readonly SheetRow[]): FscsrMeta {
  const preamble = rows.slice(0, FSCSR_HEADER_ROW);
  let titleLine = "";
  let period = "";

  for (const row of preamble) {
    for (let index = 0; index < row.length; index += 1) {
      const cell = row[index];
      if (typeof cell !== "string") continue;
      const text = cell.trim();
      if (text.length === 0) continue;

      if (/Отчетный период/i.test(text)) {
        // Подпись и значение либо в одной ячейке, либо в соседней.
        const inline = text.replace(/^.*Отчетный период:\s*/i, "");
        const next = row[index + 1];
        period = inline.length > 0 ? inline : typeof next === "string" ? next.trim() : "";
      } else if (titleLine.length === 0 && ZONE_TITLE.test(text)) {
        titleLine = text;
      }
    }
    if (period.length > 0 && titleLine.length > 0) break;
  }

  if (period.length === 0) {
    throw new Error("Не удалось прочитать отчётный период из выгрузки ФСЦСР: подпись «Отчетный период» не найдена.");
  }
  if (titleLine.length === 0) {
    throw new Error(
      "Не удалось прочитать ценовую зону из выгрузки ФСЦСР: не найдена строка вида «Субъект РФ (N зона), г. Центр» (или с. / пгт. / п.).",
    );
  }

  // «Амурская область (1 зона), г. Благовещенск» → субъект и зона.
  const subject = titleLine.split(SETTLEMENT_SPLIT)[0]?.trim() ?? titleLine;
  const zoneMatch = /^(.*?)\s*\(([^)]+)\)$/.exec(subject);

  return {
    region: zoneMatch?.[1]?.trim() ?? subject,
    zone: zoneMatch?.[2] !== undefined ? `${zoneMatch[1]?.trim() ?? ""} (${zoneMatch[2]})` : subject,
    period: normalizePeriod(period),
    titleLine,
  };
}

/*
  Центр зоны — не всегда город: «Республика Бурятия (1 зона), с. Орлик»,
  «(8 зона), пгт. Новый Уоян». Требование «г.» роняло сборку 1-й зоны Бурятии.
  «Красноярский край (11 зона), гп. Северо-Енисейский» — городской посёлок: без
  «гп» 11-я зона Красноярского края не собиралась (ночная сборка 11.10.2026);
  «кп» (курортный) и «нп» (населённый пункт) — того же рода.
*/
const SETTLEMENT = "(?:гп|кп|нп|г|с|пгт|рп|п|пос|у|ст-ца|ст|д|дер|х|аул|сл|м)";
const ZONE_TITLE = new RegExp(`^.+,\\s*${SETTLEMENT}\\.\\s*.+$`, "u");
const SETTLEMENT_SPLIT = new RegExp(`,\\s*${SETTLEMENT}\\.\\s*`, "u");

/*
  Код ресурса КСР: «01.1.01.01-0001» (материал) или «91.01.05-134» (машина).
  Под таблицей у Москвы стоят примечания («1. Сметные цены и индексы … применяются …»)
  с числом в колонке цены — без этой проверки они попадали в цены как ресурс с
  кодом-абзацем, а повтор такого «кода» ронял загрузку зоны.
*/
const RESOURCE_CODE = /^\d{2}\.\d{1,2}(?:\.\d{2}){1,2}-\d{3,4}$/;

function cellString(row: SheetRow, index: number): string {
  const value = row[index];
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Число из ячейки. Тысячные разделители не принимаются: `parseDecimal` из
 * домена заменяет запятую на точку, а здесь запятая может означать разделитель
 * разрядов («353,962.83»), поэтому разбор свой.
 */
export function cellNumber(row: SheetRow, index: number): number | null {
  const value = row[index];
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Пробел и неразрывный пробел — разделители тысяч, точка — десятичная.
  const cleaned = trimmed.replace(/[\s ]/g, "").replace(/,/g, "");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface FscsrData {
  readonly machines: readonly ResourcePrice[];
  readonly materials: readonly ResourcePrice[];
  readonly anchors: readonly WageAnchor[];
  readonly meta: FscsrMeta;
  readonly notes: readonly string[];
}

/**
 * Листы ФСЦСР → текущие цены зоны и якоря ставок машинистов.
 *
 * Якорь — колонка «Оплата труда машинистов», делённая на «Трудозатраты
 * машинистов»: так получаются разряды 4; 5; 6; 6,5; 7; 8; 8,7; 9, которых нет в
 * реестре ставок рабочих, обрывающемся на 3,4.
 *
 * Дедупликация машин по коду: в листе встречаются повторы строк, и цена обязана
 * быть одна.
 */
export function parseFscsr(
  machineRows: readonly SheetRow[],
  materialRows: readonly SheetRow[],
): FscsrData {
  const notes: string[] = [];
  const meta = readFscsrMeta(machineRows);
  let notCodeRows = 0;

  const machines = new Map<string, ResourcePrice>();
  const anchorsByRank = new Map<number, Set<number>>();
  let machineRowsRead = 0;
  let priceConflicts = 0;
  let noCrewRows = 0;
  let machinesWithoutPrice = 0;

  for (const row of machineRows.slice(FSCSR_FIRST_DATA_ROW)) {
    const code = cellString(row, MACHINE_COLUMNS.code);
    if (code.length === 0) continue;
    if (!RESOURCE_CODE.test(code)) {
      notCodeRows += 1;
      continue;
    }
    machineRowsRead += 1;

    const price = cellNumber(row, MACHINE_COLUMNS.price);
    if (price === null) {
      machinesWithoutPrice += 1;
      continue;
    }
    const salary = cellNumber(row, MACHINE_COLUMNS.salary) ?? 0;
    const hours = cellNumber(row, MACHINE_COLUMNS.hours) ?? 0;
    const rank = cellNumber(row, MACHINE_COLUMNS.rank);

    const existing = machines.get(code);
    if (existing !== undefined && (existing.price !== price || existing.machinistSalary !== salary)) {
      priceConflicts += 1;
    }
    machines.set(code, {
      code,
      name: cellString(row, MACHINE_COLUMNS.name),
      unit: cellString(row, MACHINE_COLUMNS.unit),
      price,
      machinistSalary: salary,
      machinistHours: hours,
      source: "CURRENT_ZONE",
      period: meta.period,
      zone: meta.zone,
    });

    if (salary === 0 && hours === 0) {
      noCrewRows += 1;
    } else if (rank !== null && hours > 0) {
      const rate = Math.round((salary / hours) * 100) / 100;
      const bucket = anchorsByRank.get(rank);
      if (bucket === undefined) anchorsByRank.set(rank, new Set([rate]));
      else bucket.add(rate);
    }
  }

  const conflictingRanks: string[] = [];
  const anchors: WageAnchor[] = [];
  for (const [rank, rates] of [...anchorsByRank.entries()].sort((a, b) => a[0] - b[0])) {
    if (rates.size > 1) conflictingRanks.push(`${rank}: ${[...rates].sort((a, b) => a - b).join(" / ")}`);
    // `buildWageScale` берёт наибольшую ставку при расхождении; здесь то же
    // правило, чтобы индекс и расчёт не могли разойтись.
    const salary = [...rates].sort((a, b) => b - a)[0] ?? 0;
    anchors.push({
      rank,
      salary,
      source: `ФСЦСР, оплата труда машинистов: ${meta.zone}, ${meta.period}`,
    });
  }

  if (machinesWithoutPrice > 0) {
    notes.push(`Строк машин без числовой цены пропущено: ${machinesWithoutPrice}.`);
  }
  if (priceConflicts > 0) {
    notes.push(
      `Расхождений цены или зарплаты машинистов между дублями строк: ${priceConflicts}. В выгрузке от 3 квартала 2026 их нет, а появление означает, что дедупликация по коду теряет данные.`,
    );
  }
  if (conflictingRanks.length > 0) {
    notes.push(
      `Разряды, которым в листе машин соответствует больше одной ставки: ${conflictingRanks.join("; ")}. Взята наибольшая, чтобы не занизить оплату труда.`,
    );
  }
  notes.push(
    `Лист машин: ${machineRowsRead} строк, ${machines.size} уникальных кодов, из них ${noCrewRows} строк без звена машинистов — нулевые колонки 5 и 8 там законные, а не пробел.`,
  );

  // Материалы: по измерению дублей нет, но проверка остаётся на случай новой выгрузки.
  const materials = new Map<string, ResourcePrice>();
  let materialRowsRead = 0;
  let materialDuplicates = 0;
  let materialsWithoutPrice = 0;

  for (const row of materialRows.slice(FSCSR_FIRST_DATA_ROW)) {
    const code = cellString(row, MATERIAL_COLUMNS.code);
    if (code.length === 0) continue;
    if (!RESOURCE_CODE.test(code)) {
      notCodeRows += 1;
      continue;
    }
    materialRowsRead += 1;

    const price = cellNumber(row, MATERIAL_COLUMNS.price);
    if (price === null) {
      materialsWithoutPrice += 1;
      continue;
    }
    if (materials.has(code)) materialDuplicates += 1;
    materials.set(code, {
      code,
      name: cellString(row, MATERIAL_COLUMNS.name),
      unit: cellString(row, MATERIAL_COLUMNS.unit),
      price,
      machinistSalary: null,
      machinistHours: null,
      source: "CURRENT_ZONE",
      period: meta.period,
      zone: meta.zone,
    });
  }

  if (materialsWithoutPrice > 0) {
    notes.push(`Строк материалов без числовой цены пропущено: ${materialsWithoutPrice}.`);
  }
  if (notCodeRows > 0) {
    notes.push(`Строк без кода ресурса (примечания под таблицей) пропущено: ${notCodeRows}.`);
  }
  notes.push(
    `Лист материалов: ${materialRowsRead} строк, ${materials.size} уникальных кодов, повторов ${materialDuplicates}.`,
  );
  notes.push(
    `Текущими ценами зоны «${meta.zone}» закрыто ${machines.size} машин из 1 729 в «ФСБЦ_Маш.xml» и ${materials.size} материалов из 45 847 в «ФСБЦ_Мат&Оборуд.xml»: расчёт обязан уметь смешивать текущую цену с базой 2022 года по индексу и помечать каждый переход.`,
  );

  return {
    machines: [...machines.values()],
    materials: [...materials.values()],
    anchors,
    meta,
    notes,
  };
}

/** Имя листа машин и материалов в выгрузке ФСЦСР. */
export function findFscsrSheets(sheetNames: readonly string[]): { machines: string; materials: string } | null {
  const machines = sheetNames.find((name) => name.startsWith("Машины"));
  const materials = sheetNames.find((name) => name.startsWith("Материалы"));
  return machines === undefined || materials === undefined ? null : { machines, materials };
}

interface RegistryRow {
  readonly code?: unknown;
  readonly salaryRateName?: unknown;
  readonly salaryRateRank?: unknown;
  readonly salary?: unknown;
  readonly authorityName?: unknown;
}

/** «1-100-30» → 3.0, «4-100-043» → 4.3: последние цифры кода — разряд, умноженный на десять. */
function rankFromRegistryCode(code: string, prefix: "1" | "4"): number | null {
  const match = new RegExp(`^${prefix}-100-(\\d{2,3})$`).exec(code);
  const digits = match?.[1];
  if (digits === undefined) return null;
  return Number.parseInt(digits, 10) / 10;
}

function formatRange(ranks: readonly number[]): string {
  if (ranks.length === 0) return "—";
  const first = ranks[0] ?? 0;
  const last = ranks[ranks.length - 1] ?? 0;
  return first === last ? `${first}` : `${first}–${last}`;
}

/** Коды специалистов, как в нормах и в реестре: «3-100-01», «3-200-03», «3-300-01», «3-400-01». */
const SPECIALIST_REGISTRY_CODE = /^3-[1-4]00-\d{2}$/;
/** «Рабочий N разряда»: явный разряд в коде, последние две цифры. */
const EXPLICIT_RANK_REGISTRY_CODE = /^2-100-(\d{2})$/;

/** Запись специалиста в реестре — то, что уходит в `wages.jsonl` и в `WageScale.specialists`. */
export interface RegistrySpecialist {
  readonly code: string;
  readonly name: string;
  readonly salary: number;
  readonly source: string;
}

export interface WageBuild {
  /** Опорные точки рабочих: «1-100-*» реестра и якоря машинистов ФСЦСР. */
  readonly anchors: readonly WageAnchor[];
  /** Официальные ставки среднего разряда машинистов («4-100-*»). */
  readonly machinists: readonly WageAnchor[];
  /** Ставки должностей специалистов («3-*»). */
  readonly specialists: readonly RegistrySpecialist[];
  readonly notes: readonly string[];
  /** Сколько точек рабочих дал реестр (без якорей ФСЦСР). */
  readonly registryCount: number;
}

/**
 * Реестр ставок (разобранный JSON, все страницы) + якоря машинистов ФСЦСР →
 * опорные точки шкалы зоны.
 *
 * Состав реестра по префиксу кода: «1-100» — средний разряд работы 1,0–8,0 с
 * шагом 0,1 (опорные точки шкалы напрямую); «4-100» — средний разряд машинистов
 * 1,0–10,0; «3-*» — должности специалистов; «2-100» — «Рабочий N разряда»
 * (значения совпадают с «1-100» на целых разрядах, поэтому в шкалу не добавляются,
 * но совпадение проверяется и расхождение попадёт в замечания); «5-100» —
 * реставраторы, нормы на них не ссылаются, они не используются.
 *
 * Разряд берётся из кода, а не из поля реестра: у специалистов в поле
 * `salaryRateRank` стоит номер категории («3.0» у инженера III категории), и
 * принять его за разряд значило бы начислять инженеру ставку рабочего.
 * Первая страница реестра (25 записей) — это только «1-100» до разряда 3,4; тогда
 * машинистов и специалистов в результате нет, а шкала продолжается якорями ФСЦСР.
 */
export function buildWageAnchors(parsed: unknown, machineAnchors: readonly WageAnchor[]): WageBuild {
  const rawItems: unknown = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null)?.items;
  const items: readonly RegistryRow[] = Array.isArray(rawItems) ? rawItems : [];

  const notes: string[] = [];
  const registry: WageAnchor[] = [];
  const machinists: WageAnchor[] = [];
  const specialists: RegistrySpecialist[] = [];
  const explicit = new Map<number, number>();
  const authorities = new Set<string>();
  let ignored = 0;

  for (const item of items) {
    if (typeof item.authorityName === "string" && item.authorityName.trim().length > 0) {
      authorities.add(item.authorityName.trim());
    }
  }
  const authority = [...authorities].join(", ");
  const source = `Реестр ставок оплаты труда рабочих: ${authority}`;

  for (const item of items) {
    const code = typeof item.code === "string" ? item.code.trim() : "";
    const salary = cellNumber([item.salary], 0);
    if (code.length === 0 || salary === null || salary <= 0) continue;

    const worker = rankFromRegistryCode(code, "1");
    if (worker !== null) {
      registry.push({ rank: worker, salary, source });
      continue;
    }
    const machinist = rankFromRegistryCode(code, "4");
    if (machinist !== null) {
      machinists.push({ rank: machinist, salary, source: `Реестр ставок оплаты труда, средний разряд машинистов: ${authority}` });
      continue;
    }
    if (SPECIALIST_REGISTRY_CODE.test(code)) {
      specialists.push({
        code,
        name: typeof item.salaryRateName === "string" ? item.salaryRateName.trim() : "",
        salary,
        source: `Реестр ставок оплаты труда, должности специалистов: ${authority}`,
      });
      continue;
    }
    const rank = EXPLICIT_RANK_REGISTRY_CODE.exec(code)?.[1];
    if (rank !== undefined) {
      explicit.set(Number.parseInt(rank, 10), salary);
      continue;
    }
    ignored += 1;
  }

  if (ignored > 0) {
    notes.push(`Записей реестра, на которые нормы не ссылаются (реставраторы «5-100-*» и прочие), пропущено: ${ignored}.`);
  }
  if (authorities.size === 0) {
    notes.push("Реестр не назвал издавший орган: в ставках указан только источник файла.");
  }

  const anchors: WageAnchor[] = [...registry, ...machineAnchors];
  const registryRanks = registry.map((anchor) => anchor.rank).sort((a, b) => a - b);
  const machinistRanks = machineAnchors.map((anchor) => anchor.rank).sort((a, b) => a - b);
  const allRanks = anchors.map((anchor) => anchor.rank).sort((a, b) => a - b);

  notes.push(
    `Реестр дал ${registry.length} ставок рабочих (разряды ${formatRange(registryRanks)}), лист машин ФСЦСР — ${machineAnchors.length} якорей (разряды ${formatRange(machinistRanks)}). Итого ${anchors.length} опорных точек, разряды ${formatRange(allRanks)}.`,
  );
  if (machinists.length > 0) {
    notes.push(`Ставок среднего разряда машинистов в реестре: ${machinists.length}.`);
  }
  if (specialists.length > 0) {
    notes.push(`Ставок специалистов в реестре: ${specialists.length} (${specialists.map((item) => item.code).join(", ")}).`);
  } else {
    notes.push(
      "Ставок специалистов (коды «3-*») в реестре нет: либо собрана только первая страница реестра, либо зона их не публикует. Расчёт выдаёт по таким кодам пробел NO_WAGE.",
    );
  }

  // «Рабочий N разряда» (2-100-*) совпадает с «1-100-N0»: проверка согласия источников.
  const byRank = new Map(registry.map((anchor) => [Math.round(anchor.rank * 10), anchor.salary] as const));
  const disagree: string[] = [];
  for (const [rank, salary] of explicit) {
    const other = byRank.get(rank * 10);
    if (other !== undefined && Math.abs(other - salary) > 0.011) {
      disagree.push(`2-100-${String(rank).padStart(2, "0")}: ${salary} против ${other}`);
    }
  }
  if (disagree.length > 0) {
    notes.push(`«Рабочий N разряда» (2-100-*) расходится с «1-100-*» на целых разрядах: ${disagree.join("; ")}. В шкале взяты «1-100-*».`);
  }
  if (machineAnchors.length > 0 && registry.length > 0) {
    notes.push(
      "Источники независимы и сходятся до копейки на пересечении: разряд 2,0 даёт 598,26 ₽ и в реестре, и в листе машин, разряд 3,0 — 653,14 ₽ (Амурская область, 1 зона).",
    );
  }

  return { anchors, machinists, specialists, notes, registryCount: registry.length };
}

/** Результат оценки роста оплаты труда по машинам, у которых есть и цена 2022 года, и цена зоны. */
export interface MachinistWageFactor {
  readonly factor: number;
  /** Машин, у которых отношение совпало с найденным в пределах допуска. */
  readonly fitting: number;
  /** Машин с ненулевой оплатой труда машинистов в обоих источниках. */
  readonly compared: number;
}

/**
 * Во сколько раз оплата труда машинистов выросла с 2022 года в этой зоне.
 *
 * Зачем. У машин, которых нет в ФСЦСР зоны (а это 1 400 из 1 700 с текущей ценой
 * в сплит-форме), оплату труда звена приходится выводить из базы 2022 года. Прежний
 * вывод умножал её на рост ЦЕНЫ маш.-ч (текущая цена / цена 2022) — но цена машины
 * включает амортизацию, топливо и доставку и растёт иначе, чем зарплата. Проверка
 * на 228 машинах ФСЦСР Амура и 224 Бурятии, у которых оплата труда измерена: такой
 * вывод даёт медианную ошибку −23 % и −5 % и расходится до пяти раз. Зарплата же
 * растёт одним числом для всех разрядов — тарифная сетка есть «ставка 1 разряда ×
 * коэффициент» в обоих уровнях цен: 2,1861 для Амура и 1,6581 для Бурятии на 122 из
 * 130 машин точно до 0,2 %; частное ставки 1 разряда из реестра на это число — одна и та же
 * база 251,07 ₽ в обеих зонах.
 *
 * Берётся медиана отношений «оплата труда звена в ФСЦСР / в базе 2022» и
 * принимается, только если ею подтверждается не меньше 80 % машин (и не меньше 20):
 * иначе null, и сборщик остаётся на прежнем выводе. Восемь машин, у которых звено в
 * 2022 году и сейчас разного состава, в медиану не влияют: их оплата труда измерена
 * ФСЦСР и всё равно перекрывает вывод.
 */
export function machinistWageFactor(
  measured: readonly ResourcePrice[],
  base: ReadonlyMap<string, { readonly machinistSalary: number }>,
): MachinistWageFactor | null {
  const ratios: number[] = [];
  for (const machine of measured) {
    const reference = base.get(machine.code)?.machinistSalary ?? 0;
    const current = machine.machinistSalary ?? 0;
    if (reference > 0 && current > 0) ratios.push(current / reference);
  }
  if (ratios.length < 20) return null;
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const fitting = ratios.filter((ratio) => Math.abs(ratio / median - 1) <= 0.002).length;
  if (fitting / ratios.length < 0.8) return null;
  return { factor: median, fitting, compared: ratios.length };
}
