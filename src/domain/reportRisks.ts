import {
  daysBetween,
  firstSentence,
  flat,
  formatPercent,
  formatRubExact,
  norm,
  numbersIn,
  parseLastDate,
  parsePercent,
  percentOf,
  shareNumber,
  shortDetail,
  shortenAtWord,
  stemOverlap,
  stems,
  withStop,
  type ReportTone,
} from "@/domain/reportText";
import type { AnalysisFinding } from "@/types/database";

/**
 * Чистка и «что делать» для рисков договора, а также разбор нейтральных находок.
 *
 * Модель складывает в «риски» всё подряд: сведения из сметы (НДС 22 %, индекс
 * инфляции, непредвиденные затраты), одно и то же условие дважды из разных
 * документов, а «длительный срок оплаты» ставит на оплату за 7 рабочих дней —
 * для подрядчика это хорошо. Здесь эти ошибки исправляются правилами, а не
 * просьбой к модели: правило можно проверить тестом и оно не зависит от модели.
 */

/* ============================ Сметные сведения ============================ */

const ESTIMATE_TEXT =
  /(?:^|[^а-яё])ндс(?:[^а-яё]|$)|индекс[а-я]*[^.]{0,30}инфляц|непредвиден|коэффициент|сметн/iu;
const ESTIMATE_SOURCE = /смет|сср|лср|нмцк|обоснован/iu;

/**
 * Сведение из сметы, а не риск договора: по заголовку и цитате (НДС, индекс
 * инфляции, непредвиденные, коэффициент, сметный…) или по разделу и файлу
 * (смета, ССР, ЛСР, НМЦК, обоснование).
 */
export function isEstimateFact(f: AnalysisFinding): boolean {
  if (ESTIMATE_TEXT.test(`${f.title} ${f.evidence_quote}`)) return true;
  return ESTIMATE_SOURCE.test(f.evidence_section);
}

/** Нейтральная находка про смету: шире, чем у рисков, — смотрим и пояснение. */
const ESTIMATE_NEUTRAL =
  /смет|(?:^|[^а-яё])ндс(?:[^а-яё]|$)|индекс|непредвиден|коэффициент|уровн[а-я]*\s+цен|ведомост|(?:^|[^а-яё])вор(?:[^а-яё]|$)|мусор|вывоз|утилизац|человеко|оплат[а-я]*\s+труда|затрат[а-я]*\s+труда|ресурсно|стоимост[а-я]*\s+(?:строительн|монтажн)/iu;

type EstimateTopic =
  | "VAT"
  | "INFLATION"
  | "CONTINGENCY"
  | "COEFFICIENT"
  | "WASTE"
  | "LABOR"
  | "PRICE_LEVEL"
  | "METHOD"
  | "BASIS"
  | "COST"
  | "OTHER";

const ESTIMATE_TOPICS: [EstimateTopic, RegExp][] = [
  ["VAT", /(?:^|[^а-яё])ндс(?:[^а-яё]|$)/iu],
  ["INFLATION", /индекс[а-я]*[^.]{0,30}инфляц|инфляц/iu],
  ["CONTINGENCY", /непредвиден/iu],
  ["COEFFICIENT", /коэффициент/iu],
  ["WASTE", /мусор|вывоз|утилизац/iu],
  ["LABOR", /оплат[а-я]*\s+труда|затрат[а-я]*\s+труда|человеко/iu],
  ["PRICE_LEVEL", /уровн[а-я]*\s+цен/iu],
  ["METHOD", /метод/iu],
  ["BASIS", /основани|ведомост/iu],
  ["COST", /стоимост/iu],
];

function estimateTopic(f: AnalysisFinding): EstimateTopic {
  const text = `${f.title} ${f.detail}`;
  for (const [topic, pattern] of ESTIMATE_TOPICS) if (pattern.test(text)) return topic;
  return "OTHER";
}

/** Одной строкой: «Непредвиденные затраты — 2 % от стоимости работ». */
function estimateLine(f: AnalysisFinding): string {
  const title = flat(f.title);
  const detail = firstSentence(f.detail, 200).replace(/[.]$/u, "");
  if (detail === "") return title;
  if (norm(detail).includes(norm(title))) return detail;
  return `${title} — ${detail}`;
}

/** Сметные сведения без повторов: одна тема и те же числа — одна строка. */
export function estimateFactLines(findings: AnalysisFinding[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of findings) {
    const topic = estimateTopic(f);
    const numbers = [...numbersIn(`${f.title} ${f.detail}`)].sort().join(",");
    const key = topic === "OTHER" || numbers === "" ? `${topic}|${norm(f.title)}` : `${topic}|${numbers}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(estimateLine(f));
  }
  return lines;
}

/* ============================ Нейтральные находки ============================ */

export interface RoutedNeutral {
  /** Адрес или место работ — в шапку. */
  place: string | null;
  terms: AnalysisFinding[];
  estimate: AnalysisFinding[];
  money: AnalysisFinding[];
  /** Остальное — в приложение. */
  other: AnalysisFinding[];
}

const PLACE_TITLE = /место|адрес|расположен/iu;
const SUBJECT_TITLE = /^(?:предмет\s+(?:закупки|контракта|договора)|нмцк|начальн[а-я]*\s+\(?максимальн)/iu;
const MONEY_TEXT = /обеспечен|аванс|оплат|казначей|штраф|(?:^|[^а-яё])пен[яи]|неустойк|расчет/iu;
const TERM_TITLE = /срок|сроки|период/iu;

/** Адрес из пояснения: «по адресу: Иркутская область, г. Братск…» → без вводных слов. */
function placeOf(f: AnalysisFinding): string {
  const detail = flat(f.detail);
  const after = /(?:по\s+адресу|адрес[а-я]*)\s*:?\s*(.+)$/iu.exec(detail);
  const value = after ? after[1]! : detail || flat(f.title);
  return value.replace(/[.\s]+$/u, "");
}

export function routeNeutral(
  findings: AnalysisFinding[],
  subject: string,
): RoutedNeutral {
  const out: RoutedNeutral = { place: null, terms: [], estimate: [], money: [], other: [] };
  const subjectKey = norm(subject).slice(0, 40);
  for (const f of findings) {
    if (f.category !== "neutral") continue;
    // НМЦК и предмет уже в шапке отчёта — повторять незачем.
    if (SUBJECT_TITLE.test(flat(f.title))) continue;
    if (subjectKey.length >= 20 && norm(f.detail).includes(subjectKey)) continue;
    if (PLACE_TITLE.test(f.title) && out.place === null) {
      out.place = placeOf(f);
      continue;
    }
    const text = `${f.title} ${f.detail}`;
    if (ESTIMATE_NEUTRAL.test(text)) out.estimate.push(f);
    else if (MONEY_TEXT.test(text)) out.money.push(f);
    else if (TERM_TITLE.test(f.title)) out.terms.push(f);
    else out.other.push(f);
  }
  return out;
}

/** Приложение «Прочие сведения»: без повторов, не больше `limit` пунктов. */
export function otherFactLines(findings: AnalysisFinding[], limit = 8): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of findings) {
    const key = norm(f.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = flat(f.detail);
    lines.push(shortenAtWord(detail !== "" ? `${flat(f.title)} — ${detail}` : flat(f.title), 240));
    if (lines.length >= limit) break;
  }
  return lines;
}

/* ============================ Риски ============================ */

type RiskTopic =
  | "TERMINATION"
  | "FINE"
  | "PENALTY"
  | "ACCEPTANCE"
  | "PAYMENT"
  | "SCHEDULE"
  | "WARRANTY"
  | "SECURITY"
  | "TREASURY"
  | "SUBCONTRACT";

/** Порядок важен: «штраф за просрочку» — штраф, а не срок. */
const RISK_TOPICS: [RiskTopic, RegExp][] = [
  [
    "TERMINATION",
    /односторонн[а-я]*\s+(?:\S+\s+){0,3}?отказ|отказ[а-я]*\s+(?:\S+\s+){0,4}?односторонн|расторж/iu,
  ],
  ["TREASURY", /казначей/iu],
  ["SUBCONTRACT", /субподряд|соисполнител/iu],
  ["FINE", /штраф/iu],
  ["PENALTY", /(?:^|[^а-яё])пен[яиюе](?:[^а-яё]|$)|неустойк/iu],
  ["ACCEPTANCE", /приемк|приёмк|экспертиз/iu],
  ["PAYMENT", /оплат|аванс|расчет/iu],
  ["WARRANTY", /гаранти/iu],
  ["SECURITY", /обеспечени/iu],
  ["SCHEDULE", /срок|просрочк|график/iu],
];

/** Одна тема, как её ни назови: все такие риски склеиваются в один. */
const ALWAYS_MERGE: ReadonlySet<RiskTopic> = new Set(["TERMINATION", "TREASURY", "SUBCONTRACT"]);

export function riskTopic(f: AnalysisFinding): RiskTopic | null {
  for (const [topic, pattern] of RISK_TOPICS) if (pattern.test(f.title)) return topic;
  return null;
}

const SEVERITY_RANK: Record<AnalysisFinding["severity"], number> = { high: 0, medium: 1, low: 2 };

function numbersCompatible(a: AnalysisFinding, b: AnalysisFinding): boolean {
  const na = numbersIn(`${a.title} ${a.evidence_quote}`);
  const nb = numbersIn(`${b.title} ${b.evidence_quote}`);
  return na.size === 0 || nb.size === 0 || shareNumber(na, nb);
}

function sameRisk(a: AnalysisFinding, b: AnalysisFinding): boolean {
  const ta = riskTopic(a);
  const tb = riskTopic(b);
  if (ta !== null && ta === tb && ALWAYS_MERGE.has(ta)) return true;
  // Разные числа — разные условия: «штраф 1 %» и «штраф 1 000 ₽» не склеиваются,
  // даже если названы одинаково.
  if (norm(a.title) === norm(b.title)) return numbersCompatible(a, b);
  if (ta === null || ta !== tb) return false;
  if (stemOverlap(stems(a.title), stems(b.title)) < 3) return false;
  return numbersCompatible(a, b);
}

export interface RiskRow {
  finding: AnalysisFinding;
  /** Разделы и файлы всех склеенных находок. */
  sources: string[];
  topic: RiskTopic | null;
}

export interface CleanedRisks {
  /** Высокие и средние — строками таблицы. */
  rows: RiskRow[];
  /** Низкие — одной строкой в конце. */
  low: AnalysisFinding[];
  /** Ушли в раздел «Смета». */
  estimate: AnalysisFinding[];
  /** Убраны как ошибка модели; нужны тесту и отладке. */
  dropped: AnalysisFinding[];
}

/** Срок оплаты из цитаты: «в течение 7 рабочих дней» → { days: 7, working: true }. */
export function paymentTermOf(text: string): { days: number; working: boolean } | null {
  const m =
    /(?:в\s+течение|не\s+позднее\s+чем\s+через|не\s+более)\s+(\d{1,3})\s*(?:\([^)]*\)\s*)?(рабочих|календарных)?\s*(?:дн|рабоч)/iu.exec(
      text,
    );
  if (!m) return null;
  const unit = m[2]?.toLowerCase();
  const working = unit === "рабочих" || (unit === undefined && /рабоч/iu.test(m[0]));
  return { days: Number(m[1]), working };
}

/** Короткий срок оплаты: до 10 рабочих или до 15 календарных дней. */
export function isFastPayment(term: { days: number; working: boolean }): boolean {
  return term.working ? term.days <= 10 : term.days <= 15;
}

const LONG_PAYMENT = /длительн/iu;

function isLongPaymentRisk(f: AnalysisFinding): boolean {
  return LONG_PAYMENT.test(f.title) && /оплат/iu.test(f.title);
}

function isLongExecutionRisk(f: AnalysisFinding): boolean {
  return (
    LONG_PAYMENT.test(f.title) &&
    /срок[а-я]*\s+(?:выполнени|исполнени)|выполнени[а-я]*\s+работ|срок[а-я]*\s+работ/iu.test(f.title)
  );
}

export function cleanRisks(findings: AnalysisFinding[], now: Date): CleanedRisks {
  const estimate: AnalysisFinding[] = [];
  const dropped: AnalysisFinding[] = [];
  const kept: AnalysisFinding[] = [];

  for (const f of findings) {
    if (f.category !== "risk") continue;
    if (isEstimateFact(f)) {
      estimate.push(f);
      continue;
    }
    if (isLongPaymentRisk(f)) {
      const term = paymentTermOf(`${f.evidence_quote} ${f.detail}`);
      // Быстрая оплата — не риск, а плюс: модель путает её с долгой.
      if (term && isFastPayment(term)) {
        dropped.push(f);
        continue;
      }
    }
    if (isLongExecutionRisk(f)) {
      const end = parseLastDate(`${f.evidence_quote} ${f.detail}`);
      // До конца работ меньше 120 дней — срок не длинный, а сжатый.
      if (end && daysBetween(now, end) < 120) {
        dropped.push(f);
        continue;
      }
    }
    kept.push(f);
  }

  // Самые важные первыми: при склейке остаётся наибольшая важность и её формулировка.
  const sorted = [...kept].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const groups: RiskRow[] = [];
  for (const f of sorted) {
    const group = groups.find((g) => sameRisk(g.finding, f));
    if (group) group.sources.push(f.evidence_section);
    else groups.push({ finding: f, sources: [f.evidence_section], topic: riskTopic(f) });
  }

  return {
    rows: groups.filter((g) => g.finding.severity !== "low"),
    low: groups.filter((g) => g.finding.severity === "low").map((g) => g.finding),
    estimate,
    dropped,
  };
}

/* ============================ Что делать по риску ============================ */

export interface RiskContext {
  nmc: number | null;
}

export interface RiskAction {
  text: string;
  tone: ReportTone;
}

/** Самый малый срок «не менее N дней» в тексте — именно с него заказчик вправе действовать. */
function smallestGraceDays(text: string): { days: number; unit: string } | null {
  let best: { days: number; unit: string } | null = null;
  for (const m of text.matchAll(/не\s+менее\s+(\d{1,3})\s*(календарн[а-я]*|рабоч[а-я]*)?\s*дн/giu)) {
    const days = Number(m[1]);
    if (best === null || days < best.days) {
      best = { days, unit: m[2]?.toLowerCase().startsWith("рабоч") ? "рабочих" : "календарных" };
    }
  }
  return best;
}

function plural(n: number, forms: [string, string, string]): string {
  const m = Math.abs(n) % 100;
  const m1 = m % 10;
  if (m > 10 && m < 20) return forms[2];
  if (m1 > 1 && m1 < 5) return forms[1];
  if (m1 === 1) return forms[0];
  return forms[2];
}

/**
 * «Что делать» по теме риска плюс числа из цитаты. Шаблоны короткие и в
 * повелительном наклонении: «Заложите…», «Учтите…», «Прочитайте…».
 */
export function riskAction(f: AnalysisFinding, context: RiskContext): RiskAction {
  const topic = riskTopic(f);
  const quote = `${f.evidence_quote} ${f.detail}`;
  const tone: ReportTone = f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "neutral";
  const done = (text: string): RiskAction => ({ text, tone });

  switch (topic) {
    case "TERMINATION": {
      const grace = smallestGraceDays(quote);
      if (grace) {
        const forms: [string, string, string] =
          grace.unit === "рабочих"
            ? ["рабочий день", "рабочих дня", "рабочих дней"]
            : ["календарный день", "календарных дня", "календарных дней"];
        return done(
          `Заложите в график запас: при просрочке уже на ${String(grace.days)} ${plural(grace.days, forms)} заказчик вправе расторгнуть контракт и потребовать убытки.`,
        );
      }
      return done(
        "Не допускайте просрочек и брака: заказчик вправе расторгнуть контракт без суда. Прочитайте пункт перед подачей.",
      );
    }
    case "PENALTY": {
      if (/трехсотой|трёхсотой|1\/300/iu.test(quote)) {
        return done(
          "Учтите пени 1/300 ключевой ставки в день в резерве цены и не срывайте сроки: пени растут каждый день просрочки.",
        );
      }
      const pct = parsePercent(f.evidence_quote);
      return done(
        pct !== null
          ? `Учтите пени ${formatPercent(pct)} в день в резерве цены и не срывайте сроки.`
          : "Учтите пени за просрочку в резерве цены и не срывайте сроки.",
      );
    }
    case "FINE": {
      const pct = parsePercent(f.evidence_quote);
      if (pct !== null) {
        const sum =
          context.nmc !== null && context.nmc > 0
            ? ` (≈ ${formatRubExact(percentOf(context.nmc, pct))} при цене по НМЦК)`
            : "";
        return done(
          `Штраф ${formatPercent(pct)} цены контракта за каждое нарушение${sum}: заложите резерв в цену и ведите документы без ошибок.`,
        );
      }
      const rub = /(\d{1,3}(?:[  ]\d{3})*)\s*(?:₽|руб)/iu.exec(f.evidence_quote);
      if (rub) {
        return done(
          `Штраф ${rub[1]!.replace(/ /g, " ")} ₽ за каждое нарушение невелик, но нарушений бывает много: следите за мелкими обязательствами.`,
        );
      }
      return done("Учтите штрафы в резерве цены и прочитайте пункт перед подачей.");
    }
    case "ACCEPTANCE":
      return done(
        "Заранее согласуйте с заказчиком порядок приёмки и готовьте исполнительную документацию по ходу работ: задержка приёмки сдвигает оплату.",
      );
    case "PAYMENT":
      return done(
        "Посчитайте оборотные деньги: оплата приходит после приёмки, аванса может не быть. Закладывайте в цену затраты на этот период.",
      );
    case "SCHEDULE":
      return done(
        "Составьте график работ с запасом и сверьте его со сроком в контракте до подачи заявки.",
      );
    case "WARRANTY": {
      const months = /(\d{1,3})\s*мес/iu.exec(quote);
      return done(
        months
          ? `Заложите в цену расходы на устранение дефектов в течение ${months[1]!} мес. гарантии.`
          : "Заложите в цену расходы на устранение дефектов в течение гарантийного срока.",
      );
    }
    case "SECURITY":
      return done(
        "Заранее решите, чем обеспечивать контракт — деньгами или банковской гарантией, и посчитайте, сколько это стоит.",
      );
    case "TREASURY":
      return done(
        "Изучите порядок казначейского сопровождения до подачи: оплата идёт через специальный счёт, и деньги могут приходить дольше.",
      );
    case "SUBCONTRACT":
      return done(
        "Проверьте, можно ли привлекать субподрядчиков и в каком объёме, до подачи заявки.",
      );
    default:
      return done("Прочитайте пункт перед подачей и учтите его в цене и графике работ.");
  }
}

/** Название риска и «чем грозит» простыми словами: 1–2 предложения. */
export function riskDetail(f: AnalysisFinding): string {
  return withStop(shortDetail(f.detail));
}
