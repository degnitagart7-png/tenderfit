import { extractLlmJson } from "@/lib/llmJson";
import { z } from "zod";

import { clip } from "@/domain/estimate/normCandidates";
import { normalizeText, stem, tableCodeOf, tokenizeForMatch } from "@/domain/estimate/normalize";
import type { NormPickContext } from "@/domain/estimate/normPick";
import { parseUnit } from "@/domain/estimate/units";

/**
 * Работы, которых нет в ведомости, но которые обязана технология: предложение ИИ и проверка кодом.
 *
 * Зачем. Смета по ведомости объёмов пропускает то, что сметчик добавляет сам: на закупке 0134300025826000377 (ремонт утепления фасада) у заказчика
 * «ГЭСН08-07-001-02 Установка и разборка наружных инвентарных лесов высотой до 16 м», 6,1 (100 м2) = 798 700 ₽ — половина сметы; в ведомости были
 * только фасадные работы. Эту работу ведомость не называет, а без неё фасад не отремонтировать.
 *
 * Граница ответственности (как у «ИИ-сметчика», `normPick.ts`). Модель предлагает до 8 дополнений ТОЛЬКО из белого списка категорий (леса и подмости,
 * защитные сетки, временные ограждения и укрытия, подъём материалов, прочее обязательное по технологии) и для каждого называет: наименование работы
 * (поисковая фраза), единицу, объём ФОРМУЛОЙ над объёмами позиций ведомости (`#7`, `+ − × /`, `max()`) и причину. Объём не число, а формула, потому что
 * число модель придумала бы, а формулу код проверяет и считает сам (без `eval`): ссылки только на позиции из присланного списка, единицы ссылок —
 * той же величины, что единица работы, хотя бы одна ссылка обязательна. Норму для принятого дополнения выбирает тот же «ИИ-сметчик» из кандидатов кода
 * (`estimateImplied.ts`): расценку модель придумать не может по построению. Цены и коэффициенты считает расчёт.
 *
 * Модуль чистый: ни сети, ни базы. Вызов модели — `impliedWorksService.ts`, сборка этапа — `estimateImplied.ts`.
 */

/** Дополнений за один расчёт: больше модель не предлагает, лишние отбрасываются. */
export const MAX_IMPLIED_ADDITIONS = 8;
/** Позиций ведомости в запросе: длиннее ведомость обрезается (начало), модель увидит не всё. */
export const MAX_IMPLIED_ITEMS = 80;
/** Длина формулы: короткая арифметика над ссылками, а не программа. */
export const MAX_FORMULA_CHARS = 160;

/* ------------------------------ формула объёма ------------------------------ */

/**
 * Формула объёма: числа (десятичные через точку), ссылки на позиции `#7`, `+`, `−` (и `-`), `×` (и `*`), `/`, скобки и `max(a, b, …)`. Запятая —
 * разделитель аргументов `max`, а не десятичная: «1,2» формулой не является (так «max(#2, 1,2)» не читается двояко). Вычисляется разбором, без `eval`.
 */
export type FormulaNode =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "ref"; readonly id: string }
  | { readonly kind: "neg"; readonly operand: FormulaNode }
  | { readonly kind: "binary"; readonly op: "+" | "-" | "*" | "/"; readonly left: FormulaNode; readonly right: FormulaNode }
  | { readonly kind: "max"; readonly args: readonly FormulaNode[] };

export type FormulaParse =
  | { readonly ok: true; readonly node: FormulaNode; /** Идентификаторы позиций в порядке появления, без повторов. */ readonly refs: readonly string[] }
  | { readonly ok: false; readonly error: string };

type Token =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "ref"; readonly id: string }
  | { readonly type: "op"; readonly value: "+" | "-" | "*" | "/" }
  | { readonly type: "paren"; readonly value: "(" | ")" }
  | { readonly type: "comma" }
  | { readonly type: "max" };

const MAX_TOKENS = 80;
const MAX_DEPTH = 10;

function tokenize(text: string): Token[] | string {
  const tokens: Token[] = [];
  let position = 0;
  while (position < text.length) {
    if (tokens.length > MAX_TOKENS) return "формула слишком длинная";
    const rest = text.slice(position);
    const char = rest[0] as string;
    if (/\s/u.test(char)) {
      position += 1;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/u.exec(rest);
    if (number !== null) {
      tokens.push({ type: "number", value: Number(number[0]) });
      position += number[0].length;
      continue;
    }
    const ref = /^#(\d{1,4})(?!\d)/u.exec(rest);
    if (ref !== null) {
      tokens.push({ type: "ref", id: ref[1] as string });
      position += ref[0].length;
      continue;
    }
    const fn = /^(?:max|макс)(?![\p{L}\d])/iu.exec(rest);
    if (fn !== null) {
      tokens.push({ type: "max" });
      position += fn[0].length;
      continue;
    }
    if (char === "+") tokens.push({ type: "op", value: "+" });
    else if (char === "-" || char === "−" || char === "–") tokens.push({ type: "op", value: "-" });
    else if (char === "*" || char === "×") tokens.push({ type: "op", value: "*" });
    else if (char === "/" || char === "÷") tokens.push({ type: "op", value: "/" });
    else if (char === "(" || char === ")") tokens.push({ type: "paren", value: char });
    else if (char === ",") tokens.push({ type: "comma" });
    else return `недопустимый знак «${char}» в формуле`;
    position += 1;
    if (tokens.length > MAX_TOKENS) return "формула слишком длинная";
  }
  return tokens;
}

/** Разбор формулы объёма; ошибка — понятная причина для журнала. Ссылки не сверяются со списком позиций: это делает вызывающий код. */
export function parseFormula(raw: string): FormulaParse {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "формула пуста" };
  if (text.length > MAX_FORMULA_CHARS) return { ok: false, error: `формула длиннее ${String(MAX_FORMULA_CHARS)} знаков` };
  const tokens = tokenize(text);
  if (typeof tokens === "string") return { ok: false, error: tokens };

  let at = 0;
  const refs: string[] = [];
  const fail = (message: string): never => {
    throw new FormulaError(message);
  };
  const peek = (): Token | undefined => tokens[at];

  const expression = (depth: number): FormulaNode => {
    if (depth > MAX_DEPTH) return fail("формула вложена слишком глубоко");
    let left = term(depth);
    for (;;) {
      const next = peek();
      if (next === undefined || next.type !== "op" || (next.value !== "+" && next.value !== "-")) return left;
      at += 1;
      left = { kind: "binary", op: next.value, left, right: term(depth) };
    }
  };

  const term = (depth: number): FormulaNode => {
    let left = factor(depth);
    for (;;) {
      const next = peek();
      if (next === undefined || next.type !== "op" || (next.value !== "*" && next.value !== "/")) return left;
      at += 1;
      left = { kind: "binary", op: next.value, left, right: factor(depth) };
    }
  };

  const factor = (depth: number): FormulaNode => {
    const token = peek();
    if (token === undefined) return fail("формула обрывается");
    at += 1;
    if (token.type === "number") return { kind: "number", value: token.value };
    if (token.type === "ref") {
      if (!refs.includes(token.id)) refs.push(token.id);
      return { kind: "ref", id: token.id };
    }
    if (token.type === "op" && token.value === "-") return { kind: "neg", operand: factor(depth + 1) };
    if (token.type === "paren" && token.value === "(") {
      const inner = expression(depth + 1);
      const close = peek();
      if (close === undefined || close.type !== "paren" || close.value !== ")") return fail("не закрыта скобка");
      at += 1;
      return inner;
    }
    if (token.type === "max") {
      const open = peek();
      if (open === undefined || open.type !== "paren" || open.value !== "(") return fail("после max ожидается «(»");
      at += 1;
      const args: FormulaNode[] = [expression(depth + 1)];
      for (;;) {
        const next = peek();
        if (next !== undefined && next.type === "comma") {
          at += 1;
          args.push(expression(depth + 1));
          continue;
        }
        if (next !== undefined && next.type === "paren" && next.value === ")") {
          at += 1;
          return { kind: "max", args };
        }
        return fail("в max ожидается «,» или «)»");
      }
    }
    return fail("лишний знак в формуле");
  };

  try {
    const node = expression(0);
    if (at < tokens.length) return { ok: false, error: "после формулы остался лишний текст" };
    return { ok: true, node, refs };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, error: error.message };
    throw error;
  }
}

class FormulaError extends Error {}

export type FormulaValue = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string };

/** Верхняя граница результата: ошибка в формуле не должна давать объём в миллионы. */
const MAX_FORMULA_VALUE = 10_000_000;

/** Вычисляет формулу; `valueOf` отдаёт объём позиции по идентификатору или undefined. Результат округляется до 0,001. */
export function evaluateFormula(node: FormulaNode, valueOf: (id: string) => number | undefined): FormulaValue {
  const calc = (current: FormulaNode): number => {
    switch (current.kind) {
      case "number":
        return current.value;
      case "ref": {
        const value = valueOf(current.id);
        if (value === undefined) throw new FormulaError(`ссылка #${current.id} на позицию, которой нет в списке`);
        return value;
      }
      case "neg":
        return -calc(current.operand);
      case "max":
        return Math.max(...current.args.map(calc));
      case "binary": {
        const left = calc(current.left);
        const right = calc(current.right);
        if (current.op === "+") return left + right;
        if (current.op === "-") return left - right;
        if (current.op === "*") return left * right;
        if (right === 0) throw new FormulaError("деление на ноль");
        return left / right;
      }
    }
  };
  try {
    const value = Math.round(calc(node) * 1000) / 1000;
    if (!Number.isFinite(value)) return { ok: false, error: "результат формулы не число" };
    if (!(value > 0)) return { ok: false, error: `объём по формуле ${String(value).replace(".", ",")} не положителен` };
    if (value > MAX_FORMULA_VALUE) return { ok: false, error: "объём по формуле неправдоподобно велик" };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, error: error.message };
    throw error;
  }
}

/* ------------------------------ факты об объекте из ТЗ ------------------------------ */

export interface ObjectFacts {
  /** Высота здания или фасада по ТЗ, м; null — не найдена. */
  readonly heightM: number | null;
  /** Этажность по ТЗ; null — не найдена. */
  readonly floors: number | null;
  /** Упоминания в ТЗ: фасад, кровля, внутренние работы. */
  readonly mentions: { readonly facade: boolean; readonly roof: boolean; readonly interior: boolean };
  /** Короткие выдержки из ТЗ вокруг слов «высот», «этаж», «фасад», «кровл», «внутренн» (не больше восьми). */
  readonly snippets: readonly string[];
}

export const EMPTY_OBJECT_FACTS: ObjectFacts = { heightM: null, floors: null, mentions: { facade: false, roof: false, interior: false }, snippets: [] };

const MAX_SNIPPETS = 8;
const SNIPPET_CHARS = 160;
const SNIPPETS_PER_WORD = 2;
/** Слова, по которым берутся выдержки (начала слов). */
const FACT_WORDS: readonly RegExp[] = [/высот\p{L}*/giu, /этаж\p{L}*/giu, /фасад\p{L}*/giu, /кровл\p{L}*/giu, /внутренн\p{L}*/giu];
/** «высота здания до 12 м», «высота фасада — 15,5 м», «высотой 9 м»; не «высота этажа», «высота потолков», «высота проёма». */
const HEIGHT_VALUE = /высот\p{L}*([^.\n]{0,40}?)(\d{1,3}(?:[.,]\d{1,2})?)\s*м(?![\p{L}\d²³])/giu;
const NOT_BUILDING_HEIGHT = /этаж|потолк|помещен|проем|окн|двер|ограждени|парапет|цокол|подвал/iu;
const FLOORS_VALUE: readonly RegExp[] = [
  /(\d{1,2})[-‑–\s]*этажн\p{L}*/giu,
  /этажност\p{L}*\s*[:—–=-]*\s*(?:здания\s*)?(\d{1,2})(?!\d)/giu,
  /(\d{1,2})\s*этажей/giu,
];

/** Выдержка: окно вокруг совпадения по границам слов, до `SNIPPET_CHARS` знаков. */
function snippetAround(text: string, at: number, length: number): string {
  const half = Math.max(10, Math.floor((SNIPPET_CHARS - length) / 2));
  const start = Math.max(0, at - half);
  const end = Math.min(text.length, at + length + half);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/gu, " ").trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Короткие сведения об объекте из текстов ТЗ — кодом, без модели: высота, этажность, упоминания фасада, кровли и внутренних работ. Они нужны модели, чтобы
 * решить, нужны ли леса (высота) и какие (фасад, кровля), и ничего не решают сами.
 */
export function extractObjectFacts(texts: readonly string[]): ObjectFacts {
  let heightM: number | null = null;
  let floors: number | null = null;
  const snippets: string[] = [];
  const seen = new Set<string>();
  const counts = FACT_WORDS.map(() => 0);

  for (const text of texts) {
    for (const found of text.matchAll(HEIGHT_VALUE)) {
      if (NOT_BUILDING_HEIGHT.test(found[1] ?? "")) continue;
      const value = Number((found[2] as string).replace(",", "."));
      if (value >= 3 && value <= 150 && (heightM === null || value > heightM)) heightM = value;
    }
    for (const pattern of FLOORS_VALUE) {
      for (const found of text.matchAll(pattern)) {
        const value = Number(found[1]);
        if (value >= 1 && value <= 60 && (floors === null || value > floors)) floors = value;
      }
    }
  }

  const lowered = texts.map((text) => text.toLowerCase());
  const mentions = {
    facade: lowered.some((text) => /фасад/u.test(text)),
    roof: lowered.some((text) => /кровл/u.test(text)),
    interior: lowered.some((text) => /внутренн/u.test(text)),
  };

  FACT_WORDS.forEach((pattern, index) => {
    for (const text of texts) {
      for (const found of text.matchAll(pattern)) {
        if ((counts[index] as number) >= SNIPPETS_PER_WORD || snippets.length >= MAX_SNIPPETS) return;
        const snippet = snippetAround(text, found.index ?? 0, found[0].length);
        const key = normalizeText(snippet).slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        snippets.push(snippet);
        counts[index] = (counts[index] as number) + 1;
      }
    }
  });

  return { heightM, floors, mentions, snippets };
}

/* ------------------------------ категории и запрос к модели ------------------------------ */

/** Белый список категорий: всё, что вне его, код отбрасывает. */
export const IMPLIED_CATEGORIES = ["SCAFFOLD", "PROTECTION", "ENCLOSURE", "HOISTING", "OTHER_TECH"] as const;
export type ImpliedCategory = (typeof IMPLIED_CATEGORIES)[number];

/** Определения категорий по-русски: уходят в промпт как есть. */
export const IMPLIED_CATEGORY_DEFINITIONS: Readonly<Record<ImpliedCategory, string>> = {
  SCAFFOLD:
    "леса, подмости, люльки, вышки — доступ к работам на высоте более 1,8 м на фасадах и кровлях (ремонт, утепление, облицовка, окраска фасада; работы у парапета и карниза). Единица — м2 вертикальной проекции обслуживаемого фасада.",
  PROTECTION:
    "защитные сетки, защитно-улавливающие козырьки, ограждение опасной зоны у стены при работах на фасаде или кровле над проходами и входами. Единица — м2 сетки или м ограждения.",
  ENCLOSURE:
    "временные ограждения и укрытия места работ: инвентарное ограждение зоны работ, защитные экраны и плёнка для закрытия проёмов и оборудования на время работ в эксплуатируемом здании. Единица — м ограждения или м2 укрытия.",
  HOISTING:
    "подъём материалов на высоту: мачтовые и фасадные подъёмники, кран-балки, лебёдки. Только если у позиций, которым нужен подъём (фасад, кровля), в нормах нет машин (в списке «машины: нет») — иначе подъём уже в норме.",
  OTHER_TECH:
    "только ВРЕМЕННЫЕ защитные мероприятия на время работ, без которых работы ведомости нельзя выполнить по охране труда и пожарной безопасности, а в ведомости и нормах позиций их нет: закрытие оконных проёмов, оборудования и полов плёнкой или щитами на время работ, временное защитное укрытие. НЕ новые конструктивные элементы здания (козырьки, навесы, пристройки, перегородки, лестницы, крыльца, отмостка, ограждения кровли и балконов и т. п.): элемент здания — это основная работа, и ведомость называет её сама; «без него удобнее» или «так принято» — не основание. Не основные работы.",
};

/**
 * Правило против перегибов (закупка с «Устройство козырька над сопряжением» за 96 098 ₽ в OTHER_TECH): белый список — это ВРЕМЕННЫЕ меры и технология, а не здание.
 * Выбранная норма обязана читаться как временная или защитная мера (`isTemporaryMeasureNorm`): либо слова категории (леса, сетки, ограждение зоны работ, подъёмник),
 * либо признаки временной меры («установка и разборка», «временн…», «инвентарн…», «защитн…», «укрыти…», «закрыти…», «на время»). Норма постоянной конструкции
 * («Устройство козырьков над входами») вне категорий отклоняется, как бы ни назвала работу модель. У OTHER_TECH слова категории нет, поэтому и наименование
 * предложения должно содержать признак временной меры (`checkAddition`).
 */
const TEMPORARY_MARKER =
  /установка и разборка|устройство и разборка|монтаж и демонтаж|временн|инвентарн|(?<![\p{L}])защитн|улавливающ|укрыти|укрыван|закрыти|закрыван|на время|съемн|предохранит/u;

/** Слова самой категории в наименовании нормы или предложения: «леса», «сетки», «ограждение зоны работ», «подъёмник». */
const CATEGORY_NORM_WORDS: Readonly<Record<ImpliedCategory, RegExp | null>> = {
  SCAFFOLD: /(?<![\p{L}])лес(?:а|ов|ам|ами|ах)?(?![\p{L}])|подмост|люльк|вышк|вышек/u,
  PROTECTION: /сетк|сеток|улавливающ|(?<![\p{L}])защитн\p{L}*\s+(?:козыр|экран)|огражден\p{L}*\s+опасн/u,
  ENCLOSURE: /огражден|укрыти|заборчик|экран|плен[кч]/u,
  HOISTING: /подъемник|подъем\p{L}*\s+материал|мачтов|лебедк|кран-?балк|башенн|подъемн/u,
  OTHER_TECH: null,
};

/** Норма (или наименование работы) читается как временная или защитная мера категории, а не как постоянная конструкция. */
export function isTemporaryMeasureNorm(category: ImpliedCategory, name: string): boolean {
  const text = normalizeText(name);
  const words = CATEGORY_NORM_WORDS[category];
  if (words !== null && words.test(text)) return true;
  return TEMPORARY_MARKER.test(text);
}

/** Позиция ведомости в запросе: идентификатор — короткий номер внутри запроса, формулы ссылаются на него. */
export interface ImpliedItem {
  readonly id: string;
  readonly name: string;
  /** Объём в базовой единице (множитель единицы уже учтён). */
  readonly quantity: number;
  readonly unit: string;
  /** Норма позиции в расчёте; null — нормы нет. */
  readonly norm: { readonly book: string; readonly code: string; readonly name: string } | null;
  /** Есть ли машины в составе нормы; null — норма неизвестна. */
  readonly machines: boolean | null;
}

export interface ImpliedRequest {
  readonly context: NormPickContext;
  readonly facts: ObjectFacts;
  readonly items: readonly ImpliedItem[];
}

const clipped = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().slice(0, max))
    .pipe(z.string().min(1));

/**
 * Схема тела запроса к `/api/estimate/implied-works`. Как у `norm-pick`: промпт собирается на сервере по неизменному шаблону, вход ограничен
 * (до 80 позиций, до 8 выдержек, предел длины каждого поля), длинное обрезается, а не отклоняется.
 */
export const impliedWorksRequestSchema = z.object({
  regNumber: clipped(64),
  subject: clipped(1000),
  jobId: z.string().min(1).max(64).optional(),
  facts: z.object({
    heightM: z.number().finite().nullable(),
    floors: z.number().finite().nullable(),
    mentions: z.object({ facade: z.boolean(), roof: z.boolean(), interior: z.boolean() }),
    snippets: z.array(clipped(240)).max(MAX_SNIPPETS),
  }),
  items: z
    .array(
      z.object({
        id: clipped(8),
        name: clipped(300),
        quantity: z.number().finite(),
        unit: clipped(16),
        norm: z.object({ book: clipped(16), code: clipped(24), name: clipped(300) }).nullable(),
        machines: z.boolean().nullable(),
      }),
    )
    .min(1)
    .max(MAX_IMPLIED_ITEMS),
});

export type ImpliedRequestBody = z.infer<typeof impliedWorksRequestSchema>;

const NUMBER_FORMAT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });

function renderFacts(facts: ObjectFacts): string {
  const lines = [
    `Высота здания по ТЗ: ${facts.heightM === null ? "не указана" : `${NUMBER_FORMAT.format(facts.heightM)} м`}`,
    `Этажность по ТЗ: ${facts.floors === null ? "не указана" : String(facts.floors)}`,
    `Упоминается в ТЗ: фасад — ${facts.mentions.facade ? "да" : "нет"}; кровля — ${facts.mentions.roof ? "да" : "нет"}; внутренние работы — ${facts.mentions.interior ? "да" : "нет"}`,
  ];
  if (facts.snippets.length > 0) lines.push("Выдержки из ТЗ:", ...facts.snippets.map((snippet) => `- ${snippet}`));
  return lines.join("\n");
}

function renderItem(item: ImpliedItem): string {
  const norm = item.norm === null ? "норма не подобрана" : `норма ${item.norm.book} ${item.norm.code} «${clip(item.norm.name, 110)}»`;
  const machines = item.machines === null ? "машины: неизвестно" : item.machines ? "машины: есть" : "машины: нет";
  return `#${item.id} | ${clip(item.name, 140)} | ${NUMBER_FORMAT.format(item.quantity)} ${item.unit} | ${norm} | ${machines}`;
}

/**
 * Промпт предложения работ по технологии. Шаблон неизменный: ничего, кроме предложения дополнений из белого списка, эта ручка сделать не может.
 */
export function buildImpliedWorksPrompt(request: ImpliedRequest): string {
  const { context, facts, items } = request;
  const categories = IMPLIED_CATEGORIES.map((category) => `- ${category} — ${IMPLIED_CATEGORY_DEFINITIONS[category]}`).join("\n");
  return `Ты — аттестованный сметчик. Проверяешь ведомость объёмов работ перед составлением локальной сметы ресурсно-индексным методом (приказ Минстроя России 421/пр): ведомость называет основные работы, а работы, которые обязана технология, в неё часто не попадают. Нужно назвать такие недостающие работы — только из белого списка ниже.

Закупка № ${context.regNumber}
Предмет закупки: ${context.subject}

## Объект (сведения из ТЗ, извлечены кодом)
${renderFacts(facts)}

## Белый список категорий
${categories}

## Правила
- **Только из белого списка.** Работа вне категорий (основные работы, демонтаж, ремонт, закупка материалов, мобилизация, зимнее удорожание, временные здания, вывоз и погрузка мусора) — не предлагай: мусор, зимнее и временные здания считает код отдельно.
- **Не материалы норм.** Материалы и изделия, которые уже входят в нормы позиций, добавлять нельзя.
- **Не дубли.** Если в ведомости уже есть такая же работа (леса, сетки, ограждение, подъёмник), не предлагай её.
- **Только если нужно.** Леса нужны при работах на высоте более 1,8 м на фасаде или кровле; внутренние работы на небольшой высоте, земляные работы, сети — без них. Сомневаешься — не предлагай: лучше пустой список, чем лишняя строка в смете.
- **Наименование — поисковая фраза в духе ФСНБ-2022** («Устройство и разборка наружных трубчатых инвентарных лесов высотой до 16 м для отделочных работ»): код найдёт по ней нормы. Высоту леса бери из «Объект»; нет высоты — не указывай её.
- **Объём — формула над позициями ведомости, не число.** Допустимо: числа (десятичные через точку), ссылки на позиции вида #7, знаки + − × /, скобки и max(a, b, …); запятая — только разделитель аргументов max. Хотя бы одна ссылка обязательна: число без ссылки отбрасывают. Единица работы — базовая (м2, м3, м, т, шт), и все позиции в формуле должны быть в той же единице: нельзя ссылаться на позицию в м3, когда работа в м2.
- **Площадь лесов — площадь одной обслуживаемой стены, а не сумма работ.** Утепление, облицовка, мембрана и откосы ведутся на одной и той же стене с одних лесов: объём лесов = max по позициям одного фасада, например max(#2, #10), а не #2 + #10. Фасадов несколько и они в разных позициях — сумма по разным фасадам.
- **Леса считаются по поверхности фасада, а не по маленькой позиции.** Площадь лесов — площадь обслуживаемой стены, то есть самая крупная по площади позиция по стенам фасада (штукатурка, окраска, облицовка, утепление всей стены), а не мелкая работа вроде расчистки тяг, ремонта козырька, откосов или нащельников: те ведутся с тех же лесов. Мелкую позицию в формулу не берите, если в списке есть позиция по поверхности стены. Пример: #2 «Расчистка поверхностей тяг» 18 м2, #5 «Окраска фасада» 640 м2, #6 «Ремонт штукатурки стен фасада» 612 м2 → формула max(#5, #6), объём 640 м2; формула «#2» дала бы 18 м2 — в 35 раз меньше леса, чем нужно для фасада.
- **Только временные меры.** Новый элемент здания (козырёк над сопряжением, навес, пристройка, перегородка, лестница) — не работа по технологии, а основная работа; в ведомости её нет, значит, её не заказывали: не предлагай. Из «иное» допустимо лишь временное защитное (закрытие проёмов и оборудования на время работ).
- **Ничего больше не считай.** Цены, нормы, шифры и итоговые числа не называй: код сам посчитает объём по формуле и выберет норму.
- **Не больше ${String(MAX_IMPLIED_ADDITIONS)} дополнений.** reason — одно короткое предложение по-русски (не длиннее 160 знаков): почему работа нужна по технологии.

## Формат ответа
Только JSON, без пояснений вокруг. Нечего добавлять — пустой список:
{"additions": [{"workName": "Устройство и разборка наружных трубчатых инвентарных лесов для отделочных работ", "category": "SCAFFOLD", "unit": "м2", "formula": "max(#2, #10)", "reason": "Фасадные работы на высоте более 1,8 м ведутся с лесов"}]}

## Позиции ведомости (#номер | наименование | объём | норма в расчёте | машины в норме)
${items.map(renderItem).join("\n")}`;
}

/** Токенов выходного ответа: до восьми дополнений по сто с небольшим токенов. */
export function impliedWorksMaxTokens(): number {
  return 400 + MAX_IMPLIED_ADDITIONS * 160;
}

/* ------------------------------ разбор ответа ------------------------------ */

/** Дополнение в ответе модели — как пришло, до проверки. */
export interface RawAddition {
  readonly workName: string;
  readonly category: ImpliedCategory;
  readonly unit: string;
  readonly formula: string;
  readonly reason: string;
}

export interface ImpliedResponse {
  readonly additions: readonly RawAddition[];
  readonly tokens: number;
  /** Элементов ответа, не подошедших под схему (в том числе категория вне белого списка). */
  readonly malformed: number;
}

/** Предложение дополнений: подменяется в тестах; в воркере — вызов прода (`remoteImpliedProposer`). */
export type ImpliedProposer = (request: ImpliedRequest) => Promise<ImpliedResponse>;

const additionSchema = z.object({
  workName: z
    .string()
    .transform((value) => value.replace(/\s+/gu, " ").trim().slice(0, 240))
    .pipe(z.string().min(4)),
  category: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.enum(IMPLIED_CATEGORIES)),
  unit: z
    .string()
    .transform((value) => value.trim().slice(0, 16))
    .pipe(z.string().min(1)),
  formula: z
    .string()
    .transform((value) => value.trim().slice(0, 400))
    .pipe(z.string().min(1)),
  reason: z
    .string()
    .nullish()
    .transform((value) => clip(value ?? "", 240)),
});

/**
 * Разбор ответа модели: объект `{"additions": [...]}` или голый массив, с ограждением ``` и без него. Элементы разбираются поодиночке: кривой
 * элемент (нет формулы, категория вне белого списка) стоит одного дополнения. Дополнений больше `MAX_IMPLIED_ADDITIONS` — лишние отбрасываются и считаются.
 */
export function parseImpliedWorksResponse(raw: string): { additions: RawAddition[]; malformed: number } {
  const cleaned = extractLlmJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Модель вернула не JSON при поиске работ по технологии; длина ответа ${String(raw.length)}, начало: ${raw.slice(0, 160).replace(/\s+/gu, " ")}`);
  }
  const list: unknown = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? ((parsed as { additions?: unknown; items?: unknown }).additions ?? (parsed as { items?: unknown }).items)
      : undefined;
  if (!Array.isArray(list)) throw new Error("Ответ модели при поиске работ по технологии не содержит списка additions");

  const additions: RawAddition[] = [];
  let malformed = 0;
  for (const candidate of list) {
    const addition = additionSchema.safeParse(candidate);
    if (!addition.success) {
      malformed += 1;
      continue;
    }
    if (additions.length >= MAX_IMPLIED_ADDITIONS) {
      malformed += 1;
      continue;
    }
    additions.push(addition.data);
  }
  return { additions, malformed };
}

/* ------------------------------ проверка ответа ------------------------------ */

/** Позиция, на которую может сослаться формула: объём в базовой единице. */
export interface ImpliedCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  /** Базовая единица: «м2», «м», «т», «шт». */
  readonly unit: string;
}

/** Принятое кодом дополнение: объём посчитан, единица прочитана; нормы пока нет. */
export interface ImpliedDraft {
  readonly workName: string;
  readonly category: ImpliedCategory;
  readonly unit: string;
  readonly quantity: number;
  readonly formula: string;
  readonly reason: string;
  /** Позиции, на которые ссылается формула, в порядке появления. */
  readonly refs: readonly ImpliedCatalogItem[];
}

export type AdditionCheck =
  | { readonly status: "ACCEPTED"; readonly draft: ImpliedDraft }
  | { readonly status: "REJECTED"; readonly reason: string };

/*
  Дубль дополнения и строки ведомости.

  Было: дубль — любое наименование строки со словом категории («подмост», «козырьк», «лес») где угодно или три общих слова. Так «Установка и разборка
  внутренних трубчатых инвентарных лесов» отклонили как дубль «Расчистка вручную поверхностей тяг от старых покрасок …» (подмости там — место работы,
  «с подмостей»), а «Установка защитно-улавливающих сеток» — как дубль «Замена облицовки подшивки козырька …» (козырёк там — ремонтируемая конструкция).
  Слово в наименовании строки не значит, что строка — это та работа.

  Стало: дубль в двух случаях.
  (а) Норма. Строка ведомости попала в ту же таблицу норм (книга + первые три группы шифра), что и норма, выбранная дополнению (`sameNormTable`).
      Это решается уже после выбора нормы, в `estimateImplied.ts`: до выбора нормы у дополнения её нет.
  (б) Предмет работы. Главное существительное дополнения совпало с главным существительным строки: обе про «леса/подмости», обе про «сетки».
      Предмет — слова до предлога места и цели («… с подмостей», «… на фасаде», «… для отделочных работ»): «Расчистка поверхностей тяг с подмостей» —
      про тяги, а не про подмости. Очень похожая фраза целиком (почти все слова предмета общие) — тоже дубль. Общие слова вроде «установка», «разборка»,
      «инвентарный» дублем не считаются.
*/

/** Предлоги места, цели и источника: после них в наименовании идёт не предмет работы, а обстоятельство. */
const CIRCUMSTANCE = /(?:^|\s)(?:с|со|на|для|при|под|над|по|от|из|в|во|у|через)(?=\s)/u;

/** Предмет работы: наименование до первого предлога обстоятельства («Расчистка поверхностей тяг | с подмостей»). Первое слово предлогом не считается. */
export function workSubject(name: string): string {
  const text = normalizeText(name);
  const first = text.indexOf(" ");
  if (first < 0) return text;
  const rest = CIRCUMSTANCE.exec(text.slice(first));
  return rest === null ? text : text.slice(0, first + rest.index).trim();
}

/** Главные существительные категории: каждое — отдельный предмет. Совпадение предмета дополнения и строки по одному ключу — дубль. */
const SUBJECT_KEYS: Readonly<Record<ImpliedCategory, readonly { readonly key: string; readonly test: (subject: string) => boolean }[]>> = {
  SCAFFOLD: [{ key: "scaffold", test: (subject) => /(?<![\p{L}])лес(?:а|ов|ам|ами|ах)?(?![\p{L}])|подмост|люльк|вышк|вышек/u.test(subject) }],
  PROTECTION: [
    { key: "net", test: (subject) => /сетк|сеток/u.test(subject) },
    // Козырёк — предмет защитной меры только с признаком защиты: «Замена облицовки подшивки козырька» — ремонт здания.
    { key: "canopy", test: (subject) => /козыр(?:ек|ьк)/u.test(subject) && /(?<![\p{L}])защитн|улавливающ|предохранит/u.test(subject) },
    { key: "screen", test: (subject) => /(?<![\p{L}])защитн\p{L}*\s+экран/u.test(subject) },
  ],
  ENCLOSURE: [
    {
      key: "fence",
      // Постоянное ограждение (кровли, балкона, лестницы) — часть здания, а не временная мера.
      test: (subject) =>
        /огражден|заборчик|(?<![\p{L}])забор(?![\p{L}])/u.test(subject) &&
        !/кровл|парапет|балкон|лестн|перил|крыльц|лодж|террас|территори|фундамент/u.test(subject),
    },
    { key: "cover", test: (subject) => /укрыти|укрыван/u.test(subject) },
  ],
  HOISTING: [{ key: "hoist", test: (subject) => /подъемник|подъем\p{L}*\s+материал|мачтов|лебедк|кран-?балк|башенн/u.test(subject) }],
  OTHER_TECH: [],
};

function subjectKeys(category: ImpliedCategory, name: string): Set<string> {
  const subject = workSubject(name);
  return new Set(SUBJECT_KEYS[category].filter((entry) => entry.test(subject)).map((entry) => entry.key));
}

/** Слова, ничего не говорящие о предмете: вид работы и общие эпитеты. Не считаются общими при сравнении фраз. */
const GENERIC_WORDS: ReadonlySet<string> = new Set(
  ["установка", "разборка", "устройство", "монтаж", "демонтаж", "инвентарн", "временн", "наружн", "внутренн", "трубчат", "защитн", "прочих", "отделочн", "ремонт", "замена"].map(stem),
);

function stems(text: string): Set<string> {
  return new Set(
    tokenizeForMatch(text)
      .filter((token) => token.length > 2 && !/^\d/u.test(token))
      .map((token) => stem(token))
      .filter((token) => !GENERIC_WORDS.has(token)),
  );
}

/**
 * Дополнение уже есть в ведомости: возвращает наименование строки-дубля. Только по предмету работы (б); совпадение нормы (а) — `sameNormTable`.
 * Совпавшее общее слово («козырёк», «подмости» как место работы) дублем не считается.
 */
export function duplicateOf(category: ImpliedCategory, workName: string, existingNames: readonly string[]): string | null {
  const mineKeys = subjectKeys(category, workName);
  const mine = stems(workSubject(workName));
  for (const name of existingNames) {
    if (mineKeys.size > 0) {
      for (const key of subjectKeys(category, name)) if (mineKeys.has(key)) return name;
    }
    // Почти та же фраза предмета целиком: три и больше значащих слова и не меньше 80 % слов более короткого предмета.
    const theirs = stems(workSubject(name));
    if (mine.size === 0 || theirs.size === 0) continue;
    let common = 0;
    for (const token of mine) if (theirs.has(token)) common += 1;
    if (common >= 3 && common / Math.min(mine.size, theirs.size) >= 0.8) return name;
  }
  return null;
}

/** Норма в терминах таблицы: книга и код. */
export interface NormRef {
  readonly book: string;
  readonly code: string;
}

/** Таблица норм: книга + первые три группы шифра («ГЭСН 08-07-001»). Нормы одной таблицы — одна и та же работа с разными условиями (высота, тип лесов). */
export function normTableKey(norm: NormRef): string {
  return `${norm.book.trim().toUpperCase()} ${tableCodeOf(norm.code)}`;
}

/** Норма строки ведомости принадлежит той же таблице, что и норма дополнения (а). */
export function sameNormTable(a: NormRef, b: NormRef): boolean {
  return normTableKey(a) === normTableKey(b);
}

const text3 = (value: number): string => String(Number(value.toFixed(3))).replace(".", ",");

/**
 * Проверка одного дополнения: единица, формула, ссылки, единицы ссылок, дубль. Принятое получает объём по формуле; ответ, не прошедший хотя бы одну
 * проверку, отбрасывается целиком — «примерно» объём не угадывается.
 *
 * @param catalog позиции, на которые можно ссылаться (идентификатор → позиция)
 * @param existingNames наименования строк ведомости: дубль не добавляется
 */
export function checkAddition(
  raw: RawAddition,
  catalog: ReadonlyMap<string, ImpliedCatalogItem>,
  existingNames: readonly string[],
): AdditionCheck {
  const label = clip(raw.workName, 60);
  const reject = (reason: string): AdditionCheck => ({ status: "REJECTED", reason: `«${label}»: ${reason}` });

  const unit = parseUnit(raw.unit);
  if (unit === null) return reject(`единица «${raw.unit}» не читается`);
  if (unit.multiplier !== 1) return reject(`единица «${raw.unit}» не базовая (нужна м2, м3, м, т, шт)`);

  const parsed = parseFormula(raw.formula);
  if (!parsed.ok) return reject(`формула «${clip(raw.formula, 60)}»: ${parsed.error}`);
  if (parsed.refs.length === 0) return reject("в формуле нет ссылок на позиции ведомости — объём не из документа");

  const refs: ImpliedCatalogItem[] = [];
  for (const id of parsed.refs) {
    const item = catalog.get(id);
    if (item === undefined) return reject(`ссылка #${id} — такой позиции в списке нет`);
    if (item.unit !== unit.unit) return reject(`позиция #${id} в «${item.unit}», а работа в «${unit.unit}»: единицы разных величин`);
    refs.push(item);
  }

  const value = evaluateFormula(parsed.node, (id) => catalog.get(id)?.quantity);
  if (!value.ok) return reject(value.error);

  // У OTHER_TECH нет слов категории: без признака временной меры в наименовании это, скорее всего, элемент здания («Устройство козырька над сопряжением»).
  if (raw.category === "OTHER_TECH" && !isTemporaryMeasureNorm("OTHER_TECH", raw.workName)) {
    return reject("в «иное по технологии» допускаются только временные защитные меры на время работ, а новый элемент здания — нет");
  }

  const duplicate = duplicateOf(raw.category, raw.workName, existingNames);
  if (duplicate !== null) return reject(`в ведомости уже есть «${clip(duplicate, 60)}»`);

  return {
    status: "ACCEPTED",
    draft: { workName: raw.workName, category: raw.category, unit: unit.unit, quantity: value.value, formula: raw.formula.replace(/\s+/gu, " ").trim(), reason: raw.reason, refs },
  };
}

/**
 * Пояснение к добавленной строке: «добавлено ИИ: <причина>; объём = max(#2, #10) = 199,1 м2 (#2 — «…» 199,1 м2; #10 — «…» 56,5 м2)».
 * Номера в формуле — номера списка, который видела модель: расшифровка в скобках делает формулу проверяемой без него.
 */
export function impliedNote(draft: ImpliedDraft): string {
  const reason = draft.reason === "" ? "причина не названа" : draft.reason.replace(/[.\s]+$/u, "");
  const legend = draft.refs.map((ref) => `#${ref.id} — «${clip(ref.name, 60)}» ${text3(ref.quantity)} ${ref.unit}`).join("; ");
  return `добавлено ИИ: ${reason}; объём = ${draft.formula} = ${text3(draft.quantity)} ${draft.unit} (${legend})`;
}
