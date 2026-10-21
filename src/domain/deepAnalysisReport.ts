import { estimateTitle } from "@/domain/estimate/auditEstimateTitle";
import { formatNumber } from "@/utils/format";
import type { MoneyOutlook } from "@/domain/moneyOutlook";
import type { Tender } from "@/domain/entities";
import { UNKNOWN_REGION, isPriceKnown } from "@/domain/entities";
import type { DeepAnalysisSummary } from "@/domain/deepAnalysis";
import { documentArchive, documentSkipMark } from "@/domain/deepAnalysis";
import type { ProfileCheckStatus, ProfileMatch } from "@/domain/profileMatch";
import { SAFETY_MARGIN_CAP, type BidEconomics, type PriceVerdict } from "@/domain/estimate/bidEconomics";
import type { VatStatus } from "@/domain/estimate/vatStatus";
import type { AppliedNormative, VolumeFinding, VolumeSource } from "@/domain/estimate/types";
import { workConditionsSentence } from "@/domain/estimate/workConditions";
import { volumeSourceLine } from "@/domain/estimate/volumeSource";
import type { EstimateConfidence } from "@/domain/estimate/estimateConfidence";
import {
  BASE_PRICES_TEXT,
  describeComparisonEstimate,
  rowDroppedNote,
  lsrRowDetails,
  lsrRowNote,
  rowNote,
  SECTION_VERDICT_NOTE,
  verificationLines,
  type CustomerComparison,
  type SectionVerdict,
  type TotalComparison,
} from "@/domain/estimate/customerComparison";
import { describeEstimateMethod } from "@/domain/estimate/bimMethod";
import type { EstimateDocument } from "@/domain/estimate/types";
import type { AuditReport } from "@/domain/estimate/customerAudit";
import {
  auditBreakdown,
  auditHeadline,
  bimDetailLines,
  isBimReport,
  coverageText,
  formatRub as formatAuditRub,
  notRecognizedLine,
  zoneLabel,
} from "@/domain/estimate/customerAuditText";
import type { NotRecognizedEstimate } from "@/domain/estimate/customerLsr";
import { SSR_FINDING_TITLES, type SsrAuditReport } from "@/domain/estimate/customerSsrAudit";
import type { SsrNmcComparison, SsrResult } from "@/domain/estimate/ssr";
import { SSR } from "@/domain/estimate/ssrNormatives";
import { inflationLine, moneyText, nmcHeadline, rubText as ssrRubText, ssrTableRows } from "@/domain/estimate/ssrText";
import { isPureNoiseNeutral, standardLineToReportSentence } from "@/domain/findingNoise";
import { buildMoney, buildTerms, submissionCountdown, type MoneyReport, type TermsReport } from "@/domain/reportMoney";
import {
  buildRequirementRows,
  pseudoChecks,
  splitRequirements,
  warrantyMonths,
  type RequirementRow,
  type SplitRequirements,
} from "@/domain/reportRequirements";
import {
  cleanRisks,
  estimateFactLines,
  otherFactLines,
  riskAction,
  riskDetail,
  routeNeutral,
  type CleanedRisks,
  type RoutedNeutral,
} from "@/domain/reportRisks";
import {
  flat,
  quoteText,
  shortenAtWord,
  sourceNote,
  type ReportTone,
} from "@/domain/reportText";
import { findingSeverityLabels, lawLabels } from "@/lib/labels";
import type { AnalysisFinding } from "@/types/database";
import { formatDateTime, formatTenderPrice, pluralRu } from "@/utils/format";

export type { ReportTone } from "@/domain/reportText";

/**
 * Структура отчёта о глубоком анализе — отдельно от файла Word.
 *
 * Отчёт читают сверху вниз и бросают на середине, поэтому порядок — порядок
 * вопросов читателя: можно ли участвовать → сколько денег заморозится → какие
 * сроки → выгодно ли → чем опасен договор → что осталось непрочитанным. «Что
 * делать» стоит рядом с каждым выводом — пятым столбцом таблицы, а не отдельным
 * разделом в конце, где оно отрывалось от требования, к которому относится.
 *
 * Здесь — только содержание: разделы, таблицы, тона. Как это превращается в
 * .docx, решает `deepAnalysisExport`; так структуру можно проверить тестом без
 * распаковки файла. Чистку повторов, «что делать» и деньги считают соседние
 * модули (`reportRequirements`, `reportRisks`, `reportMoney`, `requirementAction`).
 */

export interface ReportCell {
  text: string;
  /** Вторая строка ячейки мельче и курсивом: раздел, источник, пояснение. */
  note?: string;
  /** Обычный абзац после текста: «чем грозит» у риска. */
  detail?: string;
  tone?: ReportTone;
  bold?: boolean;
}

export type ReportBlock =
  | { kind: "paragraph"; text: string; tone?: ReportTone; bold?: boolean; small?: boolean; /** Главная строка раздела: крупнее обычного текста. */ large?: boolean }
  | { kind: "bullets"; items: string[] }
  | {
      kind: "table";
      /** Ширины колонок в процентах; в сумме 100. */
      columns: { title: string; width: number }[];
      rows: ReportCell[][];
    };

export interface ReportSection {
  title: string;
  blocks: ReportBlock[];
}

export interface DeepAnalysisReport {
  title: string;
  regNumber: string;
  subject: string;
  /** Карточка закупки: пары «поле — значение» в таблице под заголовком. */
  facts: [string, string][];
  sections: ReportSection[];
}

export interface DeepAnalysisReportInput {
  regNumber: string;
  subject: string;
  summary: DeepAnalysisSummary;
  generatedAt: Date;
  /** Закупка — для карточки: заказчик, цена, сроки, обеспечение. */
  tender?: Tender | null;
  /**
   * «Деньги» по НМЦК, условиям договора и смете заказчика (`moneyOutlook.ts`): запас по
   * цене при снижении, пик замороженных средств, зима. Нет — раздел «Деньги» как раньше.
   */
  moneyOutlook?: MoneyOutlook | null;
  /** Сверка с профилем; нет — раздел показывает требования без статусов. */
  profileMatch?: ProfileMatch | null;
  /**
   * Цена участия по индексной смете. Нет — сметы ещё не считали, и отчёт говорит
   * об этом прямо, а не молчит: без неё вывод об экономике не обоснован.
   */
  bidEconomics?: BidEconomics | null;
  /**
   * Откуда известно про НДС в цене: цитата документации, закон или допущение.
   * Нет — отчёт говорит, что основание не определялось.
   */
  vatStatus?: VatStatus | null;
  /**
   * Сравнение расчёта со сметой заказчика по разделам. Нет — подраздела в отчёте
   * нет: сравнивать не пытались.
   */
  customerComparison?: CustomerComparison | null;
  /**
   * Аудит сметы заказчика (результат задания `audit` с воркера). Нет — подраздела в
   * отчёте нет: проверку не запускали.
   */
  customerAudit?: {
    reports: readonly AuditReport[];
    zone: { zoneName: string };
    period: string;
    notRecognized: readonly NotRecognizedEstimate[];
  } | null;
  /**
   * Сводный расчёт: наш ССР и «наша оценка НМЦК» (`result` — null, когда сметы нет), сравнение с НМЦК закупки и аудит
   * ССР заказчика из документации. Нет — подраздела «Сводный расчёт» и аудита ССР в отчёте нет.
   */
  ssr?: {
    result: SsrResult | null;
    comparison: SsrNmcComparison | null;
    audits: readonly SsrAuditReport[];
  } | null;
  /** Уровень цен расчёта: зона и квартал ФГИС ЦС — без них числа нельзя перепроверить. */
  estimateSource?: {
    priceZone: string;
    period: string;
    baseEdition: string;
    /** Метод расчёта и сведения БИМ; нет — ресурсно-индексный (расчёты до появления БИМ). */
    method?: EstimateDocument["method"];
    bim?: EstimateDocument["bim"];
  } | null;
  /**
   * Откуда взяты объёмы расчёта: ведомость, смета заказчика или таблицы проекта.
   * Нет — расчёт сделан до приоритета источников, и строки в отчёте нет.
   */
  volumeSource?: VolumeSource | null;
  /**
   * Насколько расчёту можно верить (`computeEstimateConfidence`): «Расчёт по смете заказчика» или «Примерная оценка».
   * Нет — строки в отчёте нет.
   */
  estimateConfidence?: EstimateConfidence | null;
  /** Расхождения объёмов ведомости и сметы заказчика: на сумму не влияют. */
  volumeFindings?: readonly VolumeFinding[] | null;
  /**
   * Сколько стоимости СМР посчитано по ценам заказчика из его сметы (нашей нормы или
   * цены нет). Нет — таких позиций нет, и строки в отчёте нет.
   */
  customerPriced?: { amount: number; count: number } | null;
  /**
   * Нормативы сверх норм ГЭСН, на которых стоят начисления: коэффициенты условий работ, зимнее
   * удорожание, временные здания, районы Крайнего Севера — с приказом и пунктом. Нет — их не было.
   */
  appliedNormatives?: readonly AppliedNormative[] | null;
  /**
   * Правки ведомости, после которых пересчитана смета: сколько и что именно изменено по позициям.
   * Нет — ведомость не правили, и строки в отчёте нет.
   */
  billEdits?: { count: number; marks: readonly { title: string; notes: readonly string[] }[] } | null;
}

/** Сколько изменённых позиций перечисляется в отчёте: остальные — счётчиком. */
const MAX_EDIT_MARKS_IN_REPORT = 40;

/** Ширины таблиц «требование — статус — основание — что делать» (сумма 100). */
const ACTION_COLUMNS = {
  number: 5,
  subject: 25,
  verdict: 16,
  basis: 28,
  action: 26,
} as const;

const STATUS_TEXT: Record<ProfileCheckStatus, string> = {
  MET: "Выполнено",
  NOT_MET: "Не выполнено",
  CHECK: "Проверить",
};

const STATUS_TONE: Record<ProfileCheckStatus, ReportTone> = {
  MET: "good",
  NOT_MET: "bad",
  CHECK: "warn",
};

const SEVERITY_TONE: Record<AnalysisFinding["severity"], ReportTone> = {
  high: "bad",
  medium: "warn",
  low: "neutral",
};

function count(n: number, forms: [string, string, string]): string {
  return `${String(n)} ${pluralRu(n, forms)}`;
}

/* ============================ Подготовка данных ============================ */

interface Skipped {
  name: string;
  why: string;
  todo: string;
}

interface Prepared {
  now: Date;
  nmc: number | null;
  /** Сверки не было: профиль не заполнен или находок нет. */
  noProfile: boolean;
  split: SplitRequirements;
  rows: RequirementRow[];
  /** Обеспечению нужен специальный счёт, а в профиле его нет. */
  accountMissing: boolean;
  risks: CleanedRisks;
  neutral: RoutedNeutral;
  money: MoneyReport;
  terms: TermsReport;
  /** «Типовые условия 44-ФЗ проверены, отклонений от закона нет: …» — вместо россыпи типовых «рисков». */
  standardSentence: string | null;
  skipped: Skipped[];
  total: number;
  read: number;
  unfinished: boolean;
}

function skipReason(code: string, filename: string): { why: string; todo: string } {
  const ext = /\.([a-z0-9]{2,5})$/iu.exec(filename)?.[1];
  switch (code) {
    // Только старые записи: бюджета знаков на закупку больше нет, новых таких пропусков не бывает.
    // Перечитывает их scripts/reparse-unreadable.ts.
    case "over_char_budget":
      return {
        why: "Файл не прочитан при прежнем ограничении объёма (сейчас оно снято).",
        todo: "Запустите анализ заново или откройте файл вручную: в нём могут быть требования, цены и сроки.",
      };
    case "file_too_large":
      return {
        why: "Файл или комплект томов больше предела размера для автоматического чтения (300 МБ на файл, 2 ГБ на комплект).",
        todo: "Откройте файл вручную.",
      };
    case "unsupported_format":
      return {
        why: ext ? `Формат .${ext.toLowerCase()} сервис пока не читает.` : "Этот формат сервис пока не читает.",
        todo: "Откройте файл вручную: в нём могут быть объёмы работ или требования.",
      };
    case "empty_text":
      return {
        why: "В файле нет текста: это скан, чертёж или картинка.",
        todo: "Откройте файл вручную: в сканах и чертежах бывают объёмы работ и требования.",
      };
    case "download_failed":
      return {
        why: "Файл не удалось скачать с сайта закупок.",
        todo: "Скачайте файл с zakupki.gov.ru и откройте вручную.",
      };
    case "parse_failed":
      return {
        why: "Файл не открылся: он повреждён или устроен необычно.",
        todo: "Откройте файл вручную; если не открывается — запросите его у заказчика.",
      };
    default:
      return { why: "Файл не прочитан.", todo: "Откройте файл вручную." };
  }
}

function prepare(input: DeepAnalysisReportInput): Prepared {
  const { summary, profileMatch, tender } = input;
  const now = input.generatedAt;
  const nmc = tender && isPriceKnown(tender.financial.price) ? tender.financial.price : null;
  const context = { nmc };
  const noProfile = !profileMatch || profileMatch.verdict === "NO_PROFILE";
  const checks = noProfile ? pseudoChecks(summary.findings) : profileMatch.checks;
  const split = splitRequirements(checks);
  const rows = buildRequirementRows(split.admission, context);
  const accountMissing = split.security.some(
    (c) => c.kind === "SECURITY" && c.status === "NOT_MET",
  );

  /*
    Блоки фактов (место работ, сметные сведения, «Деньги», «Сроки») берут находки до
    чистки от шума: размер обеспечения и срок оплаты по 44-ФЗ остаются источником
    чисел, хотя как «риск» не показываются. Служебное neutral (контакты, площадка…)
    не нужно и им.
  */
  const factSource = (summary.allFindings ?? summary.findings).filter((f) => !isPureNoiseNeutral(f));
  const neutral = routeNeutral(factSource, input.subject);
  const risks = cleanRisks(summary.findings, now);
  const money = buildMoney({ tender, findings: factSource });
  const warranty =
    split.warranty
      .map((c) => warrantyMonths(`${c.finding.title} ${c.finding.required_value ?? ""} ${c.finding.detail}`))
      .find((m) => m !== null) ?? null;
  const terms = buildTerms({
    tender,
    findings: factSource,
    warrantyMonths: warranty,
    neutralTerms: neutral.terms,
    now,
  });

  const skipped: Skipped[] = [];
  for (const document of summary.documents) {
    const mark = documentSkipMark(document);
    // Том комплекта прочитан вместе с первым томом — это не пропуск.
    if (!mark || mark.code === "volume_of_set") continue;
    const name = document.filename || (document.raw_json as { title?: string } | null)?.title || "Без названия";
    skipped.push({ name, ...skipReason(mark.code, document.filename) });
  }
  const total = summary.documents.length;

  return {
    now,
    nmc,
    noProfile,
    split,
    rows,
    accountMissing,
    risks,
    neutral,
    money,
    terms,
    standardSentence: standardLineToReportSentence(summary.standardLine),
    skipped,
    total,
    read: total - skipped.length,
    unfinished: summary.state !== "completed",
  };
}

/* ============================ Шапка ============================ */

function placeOfWork(input: DeepAnalysisReportInput, prepared: Prepared): string | null {
  if (prepared.neutral.place) return prepared.neutral.place;
  const address = input.tender?.deliveryAddress?.trim() ?? "";
  return address !== "" && address !== UNKNOWN_REGION ? address : null;
}

function buildFacts(input: DeepAnalysisReportInput, prepared: Prepared): [string, string][] {
  const { tender } = input;
  // Номер и предмет уже стоят в заголовке над таблицей — здесь не повторяются.
  const facts: [string, string][] = [];
  if (tender) {
    if (tender.customerName) facts.push(["Заказчик", tender.customerName]);
    facts.push(["Закон", lawLabels[tender.law]]);
    facts.push(["НМЦК", formatTenderPrice(tender.financial.price, tender.financial.currency)]);
    const countdown = submissionCountdown(tender.deadlines.submissionEnd, input.generatedAt);
    const end = formatDateTime(tender.deadlines.submissionEnd);
    facts.push([
      "Окончание подачи",
      countdown === null ? end : countdown === "срок подачи истёк" ? `${end} — ${countdown}` : `${end} (${countdown})`,
    ]);
  }
  const place = placeOfWork(input, prepared);
  if (place) facts.push(["Место работ", place]);
  facts.push([
    "Отчёт сформирован",
    input.generatedAt.toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" }),
  ]);
  return facts;
}

/* ============================ 1. Итог ============================ */

function listCapped(items: string[], max = 4): string {
  const shown = items.slice(0, max);
  return items.length > max ? `${shown.join("; ")}; …` : shown.join("; ");
}

function verdictBlock(prepared: Prepared, summary: DeepAnalysisSummary): ReportBlock {
  const { rows, noProfile, accountMissing } = prepared;
  if (summary.findings.length === 0 && prepared.unfinished) {
    return { kind: "paragraph", text: summary.detail, bold: true };
  }
  if (noProfile) {
    return {
      kind: "paragraph",
      text:
        rows.length === 0
          ? "Да: особых требований к участнику в документации не найдено."
          : "Пока не понять, можно ли участвовать: профиль компании не заполнен. Заполните его — отчёт сам отметит, что выполнено.",
      tone: rows.length === 0 ? "good" : "warn",
      bold: true,
    };
  }
  const lacks = rows.filter((r) => r.status === "NOT_MET").map((r) => r.lack);
  if (lacks.length > 0) {
    return {
      kind: "paragraph",
      text: `Нет: не хватает ${listCapped(lacks, 3)}.`,
      tone: "bad",
      bold: true,
    };
  }
  const conditions = rows.filter((r) => r.status === "CHECK" && !r.typical).map((r) => r.condition);
  if (accountMissing) conditions.push("вы откроете специальный счёт для обеспечения");
  if (conditions.length > 0) {
    return {
      kind: "paragraph",
      text: `Да, если подтвердите: ${listCapped(conditions)}.`,
      tone: "warn",
      bold: true,
    };
  }
  return {
    kind: "paragraph",
    text:
      rows.length === 0
        ? "Да: особых требований к участнику в документации не найдено."
        : "Да: по профилю препятствий нет.",
    tone: "good",
    bold: true,
  };
}

/** Три главных действия до подачи: сначала то, что может закрыть участие. */
function mainActions(prepared: Prepared): string[] {
  const actions: string[] = [];
  for (const row of prepared.rows) if (row.status === "NOT_MET") actions.push(row.action.text);
  if (prepared.accountMissing) {
    actions.push("Откройте специальный счёт в банке до подачи заявки: без него обеспечение внести нельзя.");
  }
  for (const row of prepared.rows) {
    if (row.status === "CHECK" && !row.typical) actions.push(row.action.text);
  }
  for (const risk of prepared.risks.rows) {
    if (risk.finding.severity !== "high") continue;
    const action = riskAction(risk.finding, { nmc: prepared.nmc });
    actions.push(`Риск «${shortenAtWord(risk.finding.title, 70)}»: ${action.text}`);
  }
  if (prepared.terms.tight) {
    actions.push(
      `Срок выполнения работ сжатый — ${count(prepared.terms.tight.days, ["день", "дня", "дней"])} с сегодняшнего дня: проверьте, успеете ли.`,
    );
  }
  if (prepared.skipped.length > 0) {
    actions.push(
      `Откройте вручную ${count(prepared.skipped.length, ["непрочитанный файл", "непрочитанных файла", "непрочитанных файлов"])}: выводы по ним не делались.`,
    );
  }
  return [...new Set(actions)].slice(0, 3);
}

function conclusion(input: DeepAnalysisReportInput, prepared: Prepared): ReportSection {
  const { summary } = input;
  const blocks: ReportBlock[] = [verdictBlock(prepared, summary)];

  if (prepared.unfinished && !(summary.findings.length === 0)) {
    blocks.push({
      kind: "paragraph",
      text: `Разбор документации не завершён (${flat(summary.title).replace(/\.$/u, "").toLowerCase()}): выводы предварительные и могут измениться. Сформируйте отчёт позже.`,
      tone: "warn",
    });
  }

  const actions = mainActions(prepared);
  if (actions.length > 0) {
    blocks.push(
      { kind: "paragraph", text: "Главное до подачи:", bold: true },
      { kind: "bullets", items: actions },
    );
  }

  if (prepared.money.total) {
    blocks.push({ kind: "paragraph", text: prepared.money.total });
  }

  if (prepared.skipped.length > 0) {
    const list = prepared.skipped
      .map((s) => `«${shortenAtWord(s.name, 70)}» — ${s.why.replace(/\.$/u, "").replace(/^./u, (c) => c.toLowerCase())}`)
      .join("; ");
    blocks.push({
      kind: "paragraph",
      text: `Прочитано ${String(prepared.read)} из ${String(prepared.total)} файлов. Не прочитаны: ${list}. Выводы построены только на прочитанном.`,
      tone: "warn",
    });
  }

  if (summary.verdictChange) {
    blocks.push({
      kind: "paragraph",
      text: `Вердикт пересмотрен по итогам разбора: ${summary.verdictChange.reason}`,
    });
  }
  return { title: "Итог", blocks };
}

/* ============================ 2. Можем ли участвовать ============================ */

function requirementsSection(prepared: Prepared): ReportSection {
  const title = "Можем ли участвовать";
  const blocks: ReportBlock[] = [];
  if (prepared.noProfile) {
    blocks.push({
      kind: "paragraph",
      text: "Заполните профиль компании — отчёт сам отметит, что выполнено.",
      tone: "warn",
    });
  }
  if (prepared.rows.length === 0) {
    blocks.push({
      kind: "paragraph",
      text: "Особых требований к участнику в документации не найдено.",
    });
    return { title, blocks };
  }
  const { number, subject, verdict, basis, action } = ACTION_COLUMNS;
  blocks.push({
    kind: "table",
    columns: [
      { title: "№", width: number },
      { title: "Требование", width: subject },
      { title: "Статус", width: verdict },
      { title: "Основание", width: basis },
      { title: "Что делать", width: action },
    ],
    rows: prepared.rows.map((row, index) => [
      { text: String(index + 1) },
      { text: row.title, bold: row.blocker },
      { text: STATUS_TEXT[row.status], tone: STATUS_TONE[row.status], bold: true },
      { text: quoteText(row.quote), note: sourceNote(row.sources) },
      { text: row.action.text },
    ]),
  });
  return { title, blocks };
}

/* ============================ 3. Деньги, 4. Сроки ============================ */

function moneySection(prepared: Prepared, outlook: MoneyOutlook | null = null): ReportSection {
  const { money } = prepared;
  const blocks: ReportBlock[] = [];
  if (money.rows.length === 0) {
    blocks.push({
      kind: "paragraph",
      text: "Условия обеспечения и оплаты в прочитанной документации не найдены.",
    });
  } else {
    blocks.push({
      kind: "table",
      columns: [
        { title: "Показатель", width: 30 },
        { title: "Сумма", width: 25 },
        { title: "Пояснение", width: 45 },
      ],
      rows: money.rows,
    });
  }
  if (money.total) {
    blocks.push({
      kind: "paragraph",
      text: money.totalNote ? `${money.total} ${money.totalNote}` : money.total,
      bold: true,
      tone: "warn",
    });
  }
  if (prepared.accountMissing) {
    blocks.push({
      kind: "paragraph",
      text: "Специального счёта для обеспечения в профиле нет: откройте его в банке до подачи заявки, без него обеспечение внести нельзя.",
      tone: "bad",
    });
  }
  const extras = prepared.neutral.money.map((f) =>
    shortenAtWord(f.detail !== "" ? `${flat(f.title)} — ${flat(f.detail)}` : flat(f.title), 240),
  );
  if (extras.length > 0) blocks.push({ kind: "bullets", items: extras });
  if (outlook !== null) blocks.push(...moneyOutlookBlocks(outlook));
  return { title: "Деньги", blocks };
}

/** Деньги сверх таблицы обеспечений: пик замороженного, запас по цене при снижении, зима. */
function moneyOutlookBlocks(outlook: MoneyOutlook): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const rub = (value: number): string => `${formatNumber(Math.round(value))} ₽`;
  const pct = (share: number): string => `${(share * 100).toFixed(1).replace(".", ",")} %`;
  if (outlook.frozenPeak !== null) {
    blocks.push({
      kind: "paragraph",
      text: `Одновременно может быть заморожено до ${rub(outlook.frozenPeak)} (обеспечение контракта и гарантийных обязательств пересекаются на приёмке).`,
    });
  }
  if (outlook.margin !== null) {
    const m = outlook.margin;
    blocks.push({
      kind: "paragraph",
      text: `Запас по цене: в смете заказчика сметная прибыль ${rub(m.profit)} (${pct(m.profit / m.base)}), накладные ${rub(m.overhead)} (${pct(m.overhead / m.base)}).`,
      bold: true,
    });
    blocks.push({
      kind: "table",
      columns: [
        { title: "Снижение", width: 15 },
        { title: "Цена", width: 25 },
        { title: "Что остаётся", width: 60 },
      ],
      rows: m.scenarios.map((sc) => [
        { text: `−${String(Math.round(sc.reduction * 100))} %` },
        { text: rub(sc.price) },
        { text: sc.note, tone: sc.profitLeft >= 0 ? undefined : sc.overheadLeft >= 0 ? "warn" : "bad" },
      ]),
    });
  }
  if (outlook.winter !== null) {
    blocks.push({
      kind: "paragraph",
      text:
        `Работы приходятся на зиму (${outlook.winter.months.join(", ")}). ` +
        (outlook.winter.included === null
          ? "Зимнее удорожание в смете заказчика не начислено — заложите его в цену или задайте вопрос заказчику."
          : `Зимнее удорожание в смете заказчика начислено: ${String(outlook.winter.included.percent).replace(".", ",")} %.`),
      tone: outlook.winter.included === null ? "warn" : undefined,
    });
  }
  return blocks;
}

/* ===================== Противоречия и вопросы заказчику ===================== */

function consolidationSection(summary: DeepAnalysisSummary): ReportSection | null {
  const c = summary.consolidation ?? null;
  if (c === null || (c.conflicts.length === 0 && c.questions.length === 0 && c.summary === "")) return null;
  const blocks: ReportBlock[] = [];
  if (c.summary !== "") blocks.push({ kind: "paragraph", text: c.summary, bold: true });
  if (c.conflicts.length > 0) {
    blocks.push({
      kind: "table",
      columns: [
        { title: "Противоречие", width: 25 },
        { title: "Что написано", width: 40 },
        { title: "Что считать верным", width: 35 },
      ],
      rows: c.conflicts.map((conflict) => [
        { text: conflict.topic, bold: true },
        { text: conflict.values.map((v) => (v.source !== "" ? `${v.value} — ${v.source}` : v.value)).join("; ") },
        {
          text: conflict.needs_question ? `Уточнить у заказчика: ${conflict.resolution}` : conflict.resolution,
          tone: conflict.needs_question ? "warn" : "good",
        },
      ]),
    });
  }
  if (c.questions.length > 0) {
    blocks.push({ kind: "paragraph", text: "Вопросы заказчику (запрос на разъяснения):", bold: true });
    blocks.push({ kind: "bullets", items: c.questions });
  }
  return { title: "Противоречия и вопросы заказчику", blocks };
}

function termsSection(prepared: Prepared): ReportSection {
  const { terms } = prepared;
  if (terms.rows.length === 0) {
    return {
      title: "Сроки и гарантия",
      blocks: [{ kind: "paragraph", text: "Сроки в прочитанной документации не найдены." }],
    };
  }
  return {
    title: "Сроки и гарантия",
    blocks: [
      {
        kind: "table",
        columns: [
          { title: "Что", width: 26 },
          { title: "Срок", width: 26 },
          { title: "Пояснение", width: 48 },
        ],
        rows: terms.rows,
      },
    ],
  };
}

/* ============================ 6. Риски договора ============================ */

function risksSection(prepared: Prepared): ReportSection {
  const { risks } = prepared;
  const title = "Риски договора";
  const standard: ReportBlock[] = prepared.standardSentence
    ? [{ kind: "paragraph", text: prepared.standardSentence, small: true }]
    : [];
  if (risks.rows.length === 0 && risks.low.length === 0) {
    return {
      title,
      blocks: [
        {
          kind: "paragraph",
          text: prepared.standardSentence
            ? "В прочитанной документации отклонений от нормы в условиях договора не найдено."
            : "В прочитанной документации рисков договора не найдено.",
        },
        ...standard,
      ],
    };
  }
  const blocks: ReportBlock[] = [];
  if (risks.rows.length > 0) {
    const { number, subject, verdict, basis, action } = ACTION_COLUMNS;
    blocks.push({
      kind: "table",
      columns: [
        { title: "№", width: number },
        { title: "Риск", width: subject },
        { title: "Важность", width: verdict },
        { title: "Основание", width: basis },
        { title: "Что делать", width: action },
      ],
      rows: risks.rows.map((risk, index) => {
        const f = risk.finding;
        return [
          { text: String(index + 1) },
          { text: flat(f.title), bold: true, detail: riskDetail(f) || undefined },
          { text: findingSeverityLabels[f.severity], tone: SEVERITY_TONE[f.severity], bold: f.severity === "high" },
          { text: quoteText(f.evidence_quote), note: sourceNote(risk.sources) },
          // Нарушение закона или выход за норму: пояснение по закону заменяет шаблонный совет.
          { text: (f as { legal_note?: string | null }).legal_note || riskAction(f, { nmc: prepared.nmc }).text },
        ];
      }),
    });
  }
  if (risks.low.length > 0) {
    blocks.push({
      kind: "paragraph",
      text: `Ещё ${count(risks.low.length, ["условие", "условия", "условий"])} низкой важности: ${risks.low
        .map((f) => flat(f.title))
        .join(", ")}.`,
      small: true,
    });
  }
  blocks.push(...standard);
  return { title, blocks };
}

/* ============================ 7. Документы ============================ */

const READ_TABLE_LIMIT = 10;

function documentsSection(summary: DeepAnalysisSummary, prepared: Prepared): ReportSection {
  const title = "Документы закупки";
  if (summary.documents.length === 0) {
    return { title, blocks: [{ kind: "paragraph", text: "Документов в базе нет." }] };
  }
  const blocks: ReportBlock[] = [
    {
      kind: "paragraph",
      text: `Прочитано ${String(prepared.read)} из ${String(prepared.total)}`,
      bold: true,
      tone: prepared.skipped.length > 0 ? "warn" : "good",
    },
  ];

  if (prepared.skipped.length > 0) {
    blocks.push({
      kind: "table",
      columns: [
        { title: "Файл", width: 40 },
        { title: "Почему не прочитан", width: 30 },
        { title: "Что делать", width: 30 },
      ],
      rows: prepared.skipped.map((s) => [
        { text: s.name },
        { text: s.why, tone: "warn" as const },
        { text: s.todo },
      ]),
    });
  }

  const readDocs = summary.documents.filter((document) => {
    const mark = documentSkipMark(document);
    return !mark || mark.code === "volume_of_set";
  });
  const nameOf = (document: DeepAnalysisSummary["documents"][number]): string =>
    (document.raw_json as { title?: string } | null)?.title ?? document.filename;
  if (readDocs.length > 0 && readDocs.length <= READ_TABLE_LIMIT) {
    blocks.push({
      kind: "table",
      columns: [
        { title: "Прочитанный файл", width: 70 },
        { title: "Результат", width: 30 },
      ],
      rows: readDocs.map((document) => {
        const archive = documentArchive(document);
        const name = nameOf(document);
        return [
          { text: name, note: name !== document.filename ? document.filename : undefined },
          {
            text: "Прочитан",
            tone: "good" as const,
            note: archive ? `Внутри архива прочитано ${String(archive.parsed)} из ${String(archive.total)}` : undefined,
          },
        ];
      }),
    });
  } else if (readDocs.length > READ_TABLE_LIMIT) {
    blocks.push({
      kind: "paragraph",
      text: `Прочитаны: ${readDocs.map(nameOf).join("; ")}.`,
      small: true,
    });
  }
  return { title, blocks };
}

/* ============================ 8. Важно и приложение ============================ */

/*
  Оговорка в самом файле, а не только на экране: отчёт пересылают, печатают и
  прикладывают к письму, и до читателя такого файла экран не доедет.
*/
function disclaimerSection(summary: DeepAnalysisSummary): ReportSection {
  const blocks: ReportBlock[] = [
    {
      kind: "paragraph",
      text:
        "Выводы сделаны по тексту, который удалось прочитать. Сверка с профилем построена на данных, " +
        "которые компания указала о себе. Отчёт не заменяет чтение документации и не гарантирует допуск " +
        "к закупке: цитаты проверяйте по первоисточнику.",
    },
  ];
  if (summary.modelUsed) {
    blocks.push({
      kind: "paragraph",
      text: `Разбор выполнен моделью ${summary.modelUsed}.`,
      small: true,
    });
  }
  return { title: "Важно", blocks };
}

function appendixSection(prepared: Prepared): ReportSection | null {
  const items = otherFactLines(prepared.neutral.other, 8);
  if (items.length === 0) return null;
  return {
    title: "Прочие сведения из документации",
    blocks: [{ kind: "bullets", items }],
  };
}

/** Сметные сведения: из рисков и нейтральных находок, без повторов. */
function documentEstimateFacts(prepared: Prepared): string[] {
  return estimateFactLines([...prepared.risks.estimate, ...prepared.neutral.estimate]);
}

const RUB_FMT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rubText = (value: number | null): string =>
  value === null ? "—" : `${RUB_FMT.format(Math.round(value))} ₽`;
const pctText = (value: number | null): string =>
  value === null ? "—" : `${value.toFixed(1).replace(".", ",")} %`;

/** Запас прочности: «+25,0 %»; у границы поиска — «более +500 %». */
const safetyText = (value: number | null): string => {
  if (value === null) return "—";
  if (value >= SAFETY_MARGIN_CAP) return `более +${String(SAFETY_MARGIN_CAP)} %`;
  return value > 0 ? `+${pctText(value)}` : pctText(0);
};

/** Строка «НДС в цене»: что принято и на чём это стоит. */
function vatRow(economics: BidEconomics, vat: VatStatus | null): ReportCell[] {
  const value = economics.assumptions.nmcIncludesVat ? "с НДС" : "без НДС";
  if (vat === null) {
    return [{ text: "НДС в цене" }, { text: value, note: "основание не определялось — допущение расчёта", tone: "warn" }];
  }
  if (vat.conflict) {
    return [{ text: "НДС в цене" }, { text: value, note: "в документации встречаются оба варианта — проверьте вручную", tone: "warn" }];
  }
  switch (vat.basis) {
    case "DOCUMENT":
      return [
        { text: "НДС в цене" },
        {
          text: value,
          note: `из документации: «${vat.quote ?? ""}»${vat.documentName === null ? "" : ` (${vat.documentName})`}`,
        },
      ];
    case "LAW_44":
      return [{ text: "НДС в цене" }, { text: value, note: "по 44-ФЗ цена контракта включает налоги — допущение, в документации прямо не указано" }];
    case "ASSUMPTION":
      return [{ text: "НДС в цене" }, { text: value, note: "НДС в документации не определён, принято «с НДС» — проверьте", tone: "warn" }];
  }
}

const signedRubText = (value: number | null): string => {
  if (value === null) return "—";
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${RUB_FMT.format(Math.abs(rounded))} ₽`;
};
const signedPctText = (value: number | null): string => {
  if (value === null) return "—";
  const text = Math.abs(value).toFixed(1).replace(".", ",");
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text} %`;
};

const SECTION_VERDICT_TONE: Record<SectionVerdict, ReportTone | undefined> = {
  CLOSE: undefined,
  OURS_HIGHER: "bad",
  OURS_LOWER: "good",
  MISSING_IN_OURS: "warn",
};

function overallText(total: TotalComparison): string {
  return `Сумма разделов заказчика ${rubText(total.customerAmount)}, наш расчёт ${rubText(total.ourAmount)}, разница ${signedRubText(total.diff)} (${signedPctText(total.diffPercent)}) — ${SECTION_VERDICT_NOTE[total.verdict]}.`;
}

/**
 * Подраздел «Сравнение со сметой заказчика»: те же таблица и строка сверки, что на
 * экране. Сметы в базисных ценах 2001 г., смета без разделов и расчёт без разбивки
 * по разделам объяснены словами — молчание выглядело бы как «расхождений нет».
 */
function customerComparisonBlocks(comparison: CustomerComparison): ReportBlock[] {
  const blocks: ReportBlock[] = [
    { kind: "paragraph", text: "Сравнение со сметой заказчика", bold: true },
  ];
  if (comparison.status === "NO_CUSTOMER_ESTIMATE") {
    blocks.push({ kind: "paragraph", text: "Смета заказчика в документации не найдена — сравнивать не с чем." });
    return blocks;
  }

  if (comparison.estimates.length > 0) {
    const shown = comparison.estimates.slice(0, 5).map(describeComparisonEstimate);
    const more = comparison.estimates.length - shown.length;
    blocks.push(
      { kind: "paragraph", text: "Прочитаны сметы заказчика:" },
      { kind: "bullets", items: more > 0 ? [...shown, `и ещё ${String(more)}`] : shown },
    );
  }
  if (comparison.baseEstimates.length > 0 && comparison.status !== "BASE_PRICES_ONLY") {
    blocks.push({
      kind: "paragraph",
      text: `Не сравниваются (базисные цены): ${String(comparison.baseEstimates.length)}. Они ${BASE_PRICES_TEXT}.`,
    });
  }

  for (const line of verificationLines(comparison.estimates)) {
    blocks.push({ kind: "paragraph", text: line.text, tone: line.ok ? "good" : "warn" });
  }

  if (comparison.status === "BASE_PRICES_ONLY") {
    blocks.push({ kind: "paragraph", text: `Смета заказчика ${BASE_PRICES_TEXT}.`, tone: "warn" });
  } else if (comparison.status === "NO_SECTIONS") {
    blocks.push({
      kind: "paragraph",
      text: "В смете заказчика найдены только итоги, разделов нет — сравнивать по разделам нечего.",
    });
  } else if (comparison.status === "LEGACY_ESTIMATE") {
    blocks.push({
      kind: "paragraph",
      text: "Смета посчитана до появления сравнения по разделам — пересчитайте, чтобы увидеть разбивку. Пока можно сравнить только итоги.",
      tone: "warn",
    });
    if (comparison.overall !== null) blocks.push({ kind: "paragraph", text: overallText(comparison.overall) });
  } else if (comparison.status === "NO_OUR_SECTIONS") {
    blocks.push({
      kind: "paragraph",
      text: "В документах, по которым считались объёмы, разделов нет — сравниваем только итоги.",
    });
    if (comparison.overall !== null) blocks.push({ kind: "paragraph", text: overallText(comparison.overall) });
  } else {
    blocks.push({
      kind: "table",
      columns: [
        { title: "Раздел", width: 24 },
        { title: "У заказчика", width: 15 },
        { title: "У нас", width: 15 },
        { title: "Разница", width: 15 },
        { title: "%", width: 9 },
        { title: "Пометка", width: 22 },
      ],
      rows: [
        ...comparison.rows.map((row) => [
          { text: row.title },
          { text: rubText(row.customerAmount) },
          { text: rubText(row.ourAmount) },
          { text: signedRubText(row.diff) },
          { text: signedPctText(row.diffPercent) },
          {
            text: rowNote(row),
            tone: SECTION_VERDICT_TONE[row.verdict],
            note: rowDroppedNote(row) ?? undefined,
          },
        ]),
        [
          { text: "Итого по сопоставленным разделам", bold: true },
          { text: rubText(comparison.matchedCustomer), bold: true },
          { text: rubText(comparison.matchedOurs), bold: true },
          { text: signedRubText(comparison.diff), bold: true },
          { text: signedPctText(comparison.diffPercent), bold: true },
          {
            text: comparison.verdict === null ? "разделы не сопоставились" : SECTION_VERDICT_NOTE[comparison.verdict],
            tone: comparison.verdict === null ? "warn" : SECTION_VERDICT_TONE[comparison.verdict],
            bold: true,
          },
        ],
      ],
    });

    const notes: string[] = [];
    if (comparison.droppedPositions > 0) {
      notes.push(
        `В нашем расчёте не посчитано позиций: ${String(comparison.droppedPositions)}. Часть разницы может быть из-за этого.`,
      );
    }
    if (comparison.customerOnly.length > 0) {
      notes.push(
        `Разделы заказчика без наших позиций: ${comparison.customerOnly
          .map((row) => `${row.title} (${rubText(row.customerAmount)})`)
          .join("; ")}.`,
      );
    }
    if (comparison.unmatchedOurs.count > 0) {
      notes.push(
        `Наши позиции вне разделов заказчика: ${String(comparison.unmatchedOurs.count)} на ${rubText(comparison.unmatchedOurs.amount)}.`,
      );
    }
    if (notes.length > 0) blocks.push({ kind: "bullets", items: notes });
  }
  blocks.push(...lsrComparisonBlocks(comparison));
  return blocks;
}

/** Сравнение по каждой локальной смете заказчика: та же таблица, что на экране. */
function lsrComparisonBlocks(comparison: CustomerComparison): ReportBlock[] {
  const rows = comparison.perLsr ?? [];
  if (rows.length === 0) return [];
  const total = comparison.perLsrTotal ?? null;
  return [
    { kind: "paragraph", text: "По каждой локальной смете заказчика (без НДС)", bold: true },
    {
      kind: "table",
      columns: [
        { title: "Смета", width: 24 },
        { title: "У заказчика", width: 15 },
        { title: "У нас", width: 15 },
        { title: "Разница", width: 15 },
        { title: "%", width: 9 },
        { title: "Пометка", width: 22 },
      ],
      rows: [
        ...rows.map((row) => [
          { text: row.title },
          { text: rubText(row.customerAmount) },
          { text: rubText(row.ourAmount) },
          { text: signedRubText(row.diff) },
          { text: signedPctText(row.diffPercent) },
          {
            text: lsrRowNote(row),
            tone: SECTION_VERDICT_TONE[row.verdict],
            note: lsrRowDetails(row).join("; ") || undefined,
          },
        ]),
        ...(total === null
          ? []
          : [
              [
                { text: "Итого по сметам", bold: true },
                { text: rubText(total.customerAmount), bold: true },
                { text: rubText(total.ourAmount), bold: true },
                { text: signedRubText(total.diff), bold: true },
                { text: signedPctText(total.diffPercent), bold: true },
                { text: SECTION_VERDICT_NOTE[total.verdict], tone: SECTION_VERDICT_TONE[total.verdict], bold: true },
              ],
            ]),
      ],
    },
  ];
}

const VERDICT_REPORT: Record<PriceVerdict, { text: string; tone: ReportTone }> = {
  OK: { text: "выгодно", tone: "good" },
  BELOW_TARGET_MARGIN: { text: "маржа ниже цели", tone: "warn" },
  LOSS: { text: "убыток", tone: "bad" },
};

/**
 * Подраздел «Аудит сметы заказчика»: шапка с выводом, «откуда разница» и 10 позиций
 * с наибольшей разницей. Те же тексты, что на экране (`customerAuditText`).
 */
function customerAuditBlocks(audit: NonNullable<DeepAnalysisReportInput["customerAudit"]>): ReportBlock[] {
  const blocks: ReportBlock[] = [
    { kind: "paragraph", text: "Аудит сметы заказчика", bold: true },
    {
      kind: "paragraph",
      text: audit.reports.length > 0 && audit.reports.every(isBimReport)
        ? "Смета составлена базисно-индексным методом. Проверка без ИИ: базисные цены сверены с ФЕР-2020, индексы — с письмами Минстроя России; объёмы и расход ресурсов заказчика не менялись."
        : `Проверка без ИИ по ценам зоны «${zoneLabel(audit.zone.zoneName, audit.period)}»: объёмы и расход ресурсов заказчика не менялись, пересчитаны цены, нормативы и арифметика.`,
    },
  ];
  for (const report of audit.reports) {
    const title = estimateTitle(report);
    blocks.push({
      kind: "paragraph",
      text: `${title}: ${auditHeadline(report)}`,
      tone: report.verdict === "UNDERSTATED" ? "bad" : report.verdict === "OVERSTATED" ? "good" : undefined,
      bold: true,
    });
    blocks.push({ kind: "paragraph", text: coverageText(report), tone: report.coverage < 0.7 ? "warn" : undefined });
    const lines = auditBreakdown(report);
    if (lines.length > 0) {
      blocks.push({ kind: "paragraph", text: "Откуда разница:" }, { kind: "bullets", items: lines.map((line) => line.text) });
    }
    const bimLines = bimDetailLines(report);
    if (bimLines.length > 0) blocks.push({ kind: "bullets", items: bimLines });
    if (report.top.length > 0) {
      blocks.push({
        kind: "table",
        columns: [
          { title: "№", width: 6 },
          { title: "Обоснование", width: 20 },
          { title: "Наименование", width: 30 },
          { title: "У заказчика", width: 14 },
          { title: "У нас", width: 14 },
          { title: "Разница", width: 16 },
        ],
        rows: report.top.map((position) => [
          { text: String(position.number) },
          { text: position.code === "" ? "—" : position.code },
          { text: position.name.length > 80 ? `${position.name.slice(0, 80)}…` : position.name, note: position.flags.length > 0 ? position.flags.join(", ") : undefined },
          { text: formatAuditRub(position.customerTotal) },
          { text: formatAuditRub(position.ourTotal) },
          { text: formatAuditRub(position.diff, true), tone: position.diff > 0 ? "bad" : "good" },
        ]),
      });
    }
  }
  if (audit.notRecognized.length > 0) {
    blocks.push({ kind: "bullets", items: audit.notRecognized.slice(0, 20).map(notRecognizedLine) });
  }
  return blocks;
}

/**
 * Подраздел «Сводный расчёт»: наш сводный сметный расчёт и «наша оценка НМЦК» (цена контракта по 841/пр) по
 * строкам, сравнение с НМЦК закупки, индекс прогнозной инфляции, допущения. Те же тексты, что на экране
 * (`ssrText`). Без нашего расчёта (сметы нет) подраздела нет.
 */
function ssrBlocks(ssr: NonNullable<DeepAnalysisReportInput["ssr"]>): ReportBlock[] {
  const result = ssr.result;
  if (result === null || result.status === "EMPTY") return [];
  const theirs = ssr.audits.find((audit) => audit.rows.length > 0);
  const byId = new Map((theirs?.rows ?? []).map((row) => [row.id, row] as const));
  const blocks: ReportBlock[] = [
    { kind: "paragraph", text: "Сводный расчёт", bold: true },
    {
      kind: "paragraph",
      text: nmcHeadline(result, ssr.comparison),
      bold: true,
      tone: ssr.comparison === null ? undefined : ssr.comparison.diff > 0 ? "bad" : "good",
    },
    {
      kind: "paragraph",
      text:
        "НМЦК по 44-ФЗ складывается из глав сводного сметного расчёта, резерва на непредвиденные работы и затраты, прогнозной инфляции и НДС " +
        "(421/пр, глава IX; 841/пр, п. 21-23), поэтому НМЦК сравнивается с ценой контракта, а не с голой сметой. Главы 10-12 (служба заказчика, " +
        "эксплуатационные кадры, изыскания, проектирование, экспертиза, авторский надзор) — затраты заказчика и в цену подрядного контракта не входят.",
    },
  ];
  const withTheirs = theirs !== undefined;
  blocks.push({
    kind: "table",
    columns: withTheirs
      ? [
          { title: "Строка", width: 26 },
          { title: "У нас, ₽", width: 16 },
          { title: "У заказчика, ₽", width: 17 },
          { title: "Разница, ₽", width: 15 },
          { title: "Основание", width: 26 },
        ]
      : [
          { title: "Строка", width: 32 },
          { title: "У нас, ₽", width: 20 },
          { title: "Основание", width: 48 },
        ],
    rows: [
      ...result.nmc.rows.map((row): ReportCell[] => {
        const other = byId.get(row.id);
        const cells: ReportCell[] = [{ text: row.label }, { text: moneyText(row.amount) }];
        if (withTheirs) {
          cells.push(
            { text: other?.customer == null ? "—" : moneyText(other.customer) },
            { text: other?.diff == null ? "—" : `${other.diff > 0 ? "+" : other.diff < 0 ? "−" : ""}${moneyText(Math.abs(other.diff))}` },
          );
        }
        cells.push({ text: row.note });
        return cells;
      }),
      withTheirs
        ? [{ text: "Без НДС", bold: true }, { text: moneyText(result.nmc.beforeVat), bold: true }, { text: "" }, { text: "" }, { text: "" }]
        : [{ text: "Без НДС", bold: true }, { text: moneyText(result.nmc.beforeVat), bold: true }, { text: "" }],
      withTheirs
        ? [{ text: "Наша оценка НМЦК с НДС", bold: true }, { text: moneyText(result.nmc.total), bold: true }, { text: "" }, { text: "" }, { text: "" }]
        : [{ text: "Наша оценка НМЦК с НДС", bold: true }, { text: moneyText(result.nmc.total), bold: true }, { text: "" }],
    ],
  });
  blocks.push({ kind: "paragraph", text: inflationLine(result) });
  blocks.push({
    kind: "table",
    columns: [
      { title: "Глава, итог сводного расчёта (текущие цены)", width: 46 },
      { title: "Всего, ₽", width: 18 },
      { title: "Комментарий", width: 36 },
    ],
    rows: ssrTableRows(result).map((row): ReportCell[] => [
      { text: row.label, bold: row.kind !== "chapter" },
      { text: row.amount === null ? "не оценивалась" : moneyText(row.amount), bold: row.kind !== "chapter" },
      { text: row.note },
    ]),
  });
  const notes = [
    `Резерв на непредвиденные: ${String(result.reserve.percent)} % от итога глав 1-12 (${result.reserve.ref}); ${result.purpose.note}. ${SSR.reserve.repairNote}`,
    SSR.vat.rateNote,
    SSR.contract.reserveNote,
    ...result.assumptions.map((assumption) => assumption.text),
  ];
  blocks.push({ kind: "bullets", items: notes });
  return blocks;
}

/** Подраздел «Аудит сводного сметного расчёта заказчика»: находки с пунктами приказов и влиянием на НМЦК. */
function ssrAuditBlocks(audits: readonly SsrAuditReport[]): ReportBlock[] {
  if (audits.length === 0) return [];
  const blocks: ReportBlock[] = [
    { kind: "paragraph", text: "Аудит сводного сметного расчёта заказчика", bold: true },
    {
      kind: "paragraph",
      text: "Проверка без ИИ: резерв на непредвиденные против 421/пр (п. 179), индекс прогнозной инфляции против нашего по срокам (841/пр, п. 22-23), арифметика глав и итогов, НДС, затраты заказчика в цене контракта. Влияние на НМЦК: плюс — НМЦК занижена, минус — завышена.",
    },
  ];
  for (const report of audits) {
    blocks.push({
      kind: "paragraph",
      text: `${estimateTitle(report)}: ${report.conclusion}`,
      bold: true,
      tone: report.warnings > 0 ? "bad" : "good",
    });
    if (report.findings.length > 0) {
      blocks.push({
        kind: "table",
        columns: [
          { title: "Тип", width: 20 },
          { title: "Находка", width: 54 },
          { title: "Влияние на НМЦК", width: 14 },
          { title: "Пункт", width: 12 },
        ],
        rows: report.findings.map((finding): ReportCell[] => [
          { text: SSR_FINDING_TITLES[finding.type] },
          { text: finding.message, tone: finding.severity === "WARNING" ? "warn" : undefined },
          { text: finding.impact === null ? "—" : `${finding.impact < 0 ? "−" : "+"}${ssrRubText(Math.abs(finding.impact))}` },
          { text: finding.ref },
        ]),
      });
    }
  }
  return blocks;
}

/**
 * Нормативы расчёта сверх норм ГЭСН: что начислено, по какому приказу и пункту, и что не начислено
 * из-за неизвестных данных (сумма без этого занижена). Нет нормативов — блоков нет.
 */
function appliedNormativesBlocks(normatives: readonly AppliedNormative[] | null): ReportBlock[] {
  if (normatives === null || normatives.length === 0) return [];
  const blocks: ReportBlock[] = [{ kind: "paragraph", text: "Нормативы расчёта сверх норм", bold: true }];
  const sentence = workConditionsSentence(normatives);
  if (sentence !== null) blocks.push({ kind: "paragraph", text: sentence });
  blocks.push({
    kind: "bullets",
    items: normatives.map((item) => {
      const head = item.applied ? `${item.title}: ${item.value}` : `${item.title}: не начислено — ${item.reason ?? item.value}`;
      const assumption = item.assumption === undefined ? "" : ` Допущение: ${item.assumption}.`;
      return `${head}. ${item.text !== "" && item.applied ? `${item.text}. ` : ""}Источник: ${item.source}.${assumption}`.replace(/\.\.+/gu, ".");
    }),
  });
  return blocks;
}

/**
 * Смета и цена участия.
 *
 * Первичный разбор уже говорит, можно ли участвовать; этот раздел отвечает на
 * следующий вопрос — выгодно ли и до какой цены. Числа посчитаны по ведомости
 * объёмов из документации, нормам ФСНБ-2022 и текущим ценам Минстроя, а не
 * названы моделью.
 */
function estimateSection(input: DeepAnalysisReportInput, documentFacts: string[]): ReportSection {
  const economics = input.bidEconomics ?? null;
  const auditBlocks = [
    ...(input.customerAudit ? customerAuditBlocks(input.customerAudit) : []),
    ...(input.ssr ? ssrAuditBlocks(input.ssr.audits) : []),
  ];
  /*
    Сведения сметного характера, которые модель положила в риски или «прочее»:
    НДС, индексы, непредвиденные, метод, уровень цен. Это не условия договора и не
    требования к участнику — им место рядом со сметой.
  */
  const factsBlocks: ReportBlock[] =
    documentFacts.length > 0
      ? [
          { kind: "paragraph", text: "Из документации заказчика", bold: true },
          { kind: "bullets", items: documentFacts },
        ]
      : [];
  if (economics === null) {
    return {
      title: "Смета и цена участия",
      blocks: [
        {
          kind: "paragraph",
          text:
            "Смета не рассчитана. Нажмите «Рассчитать смету» в карточке закупки — посчитаем стоимость " +
            "по ценам Минстроя, минимальную цену и допустимое снижение.",
          tone: "warn",
        },
        ...auditBlocks,
        ...factsBlocks,
      ],
    };
  }
  if (economics.status === "EMPTY") {
    return {
      title: "Смета и цена участия",
      blocks: [
        { kind: "paragraph", text: economics.flags[0]?.message ?? "Смета пуста.", tone: "warn" },
        ...auditBlocks,
        ...factsBlocks,
      ],
    };
  }

  const blocks: ReportBlock[] = [];
  const confidence = input.estimateConfidence;
  // Первой строкой раздела: до сумм читатель должен знать, насколько им можно верить.
  if (confidence != null && confidence.level !== "unknown") {
    blocks.push({
      kind: "paragraph",
      text: `${confidence.title}${confidence.range === undefined ? "" : `: ${confidence.range.text}`}`,
      bold: true,
      ...(confidence.level === "approximate" ? { tone: "warn" as const } : {}),
    });
    blocks.push({ kind: "paragraph", text: confidence.explanation });
  }
  const source = input.estimateSource;
  if (source) {
    if (source.method === "BASE_INDEX") {
      const method = describeEstimateMethod({ method: "BASE_INDEX", bim: source.bim });
      blocks.push({ kind: "paragraph", text: `${method.title}. ${source.baseEdition}, ${source.period}, «${source.priceZone}».` });
      if (method.lines.length > 0) blocks.push({ kind: "bullets", items: [...method.lines] });
    } else {
      blocks.push({
        kind: "paragraph",
        text: `Расчёт ресурсно-индексным методом: ${source.baseEdition}, текущие цены «${source.priceZone}», ${source.period}.`,
      });
    }
  }

  blocks.push(...appliedNormativesBlocks(input.appliedNormatives ?? null));
  if (input.ssr) blocks.push(...ssrBlocks(input.ssr));

  /*
    Ведомость правили вручную: числа ниже посчитаны по ней, а не по тому, что прочитал расчёт. Это
    надо сказать до чисел и назвать позиции — читатель отчёта видит не экран, где они помечены.
  */
  if (input.billEdits && input.billEdits.count > 0) {
    blocks.push({
      kind: "paragraph",
      text: `Ведомость отредактирована: ${count(input.billEdits.count, ["правка", "правки", "правок"])}. Смета пересчитана по исправленной ведомости.`,
      tone: "warn",
      bold: true,
    });
    const shown = input.billEdits.marks.slice(0, MAX_EDIT_MARKS_IN_REPORT);
    const more = input.billEdits.marks.length - shown.length;
    blocks.push({
      kind: "bullets",
      items: [
        ...shown.map((mark) => `«${mark.title}»: ${mark.notes.join("; ")}`),
        ...(more > 0 ? [`…и ещё изменённых позиций: ${String(more)}`] : []),
      ],
    });
  }

  if (input.volumeSource) {
    blocks.push({ kind: "paragraph", text: volumeSourceLine(input.volumeSource), bold: true });
    // У ведомости пояснять нечего: строка уже называет файл. У остальных уровней — почему не ведомость.
    if (input.volumeSource.level !== "BILL") {
      blocks.push({ kind: "paragraph", text: input.volumeSource.note, tone: "warn" });
    }
    // Какие сметы найдены в нескольких документах, как сошлась смета контракта: то же, что на экране.
    if ((input.volumeSource.details ?? []).length > 0) {
      blocks.push({ kind: "bullets", items: [...(input.volumeSource.details ?? [])] });
    }
  }

  const critical = economics.flags.filter((flag) => flag.severity === "CRITICAL" || flag.severity === "HIGH");
  for (const flag of critical) {
    blocks.push({ kind: "paragraph", text: flag.message, tone: flag.severity === "CRITICAL" ? "bad" : "warn", bold: flag.severity === "CRITICAL" });
  }

  blocks.push({
    kind: "table",
    columns: [
      { title: "Показатель", width: 45 },
      { title: "Значение", width: 55 },
    ],
    rows: [
      [{ text: "НМЦК" }, { text: rubText(economics.nmc), note: economics.ratioToEstimate === null ? undefined : `${economics.ratioToEstimate.toFixed(2).replace(".", ",")} от ${economics.ssr === null ? "расчёта по смете" : "нашей оценки НМЦК"}` }],
      [{ text: "Смета по текущим ценам, без НДС" }, { text: rubText(economics.basis.estimateBeforeVat) }],
      ...(economics.ssr
        ? [
            [
              { text: "Наша оценка НМЦК (цена контракта), без НДС" },
              {
                text: rubText(economics.basis.comparedWithBeforeVat),
                note: `смета, резерв на непредвиденные ${String(economics.ssr.reservePercent)} %${economics.ssr.inflationApplied ? `, индекс прогнозной инфляции ${economics.ssr.inflationIndex.toFixed(4).replace(".", ",")}` : ", без прогнозной инфляции (сроки неизвестны)"}`,
              },
            ],
          ]
        : []),
      ...(input.customerPriced
        ? [
            [
              { text: "в т.ч. по ценам заказчика" },
              {
                text: `${rubText(input.customerPriced.amount)} (${String(input.customerPriced.count)} поз.)`,
                tone: "warn" as const,
                note: "нашей нормы или цены нет; сумма из сметы заказчика, не проверена нашими ценами",
              },
            ],
          ]
        : []),
      [{ text: "Себестоимость исполнения" }, { text: rubText(economics.basis.cost), note: economics.ssr === null ? "прямые затраты, накладные, лимитированные; без сметной прибыли" : `прямые затраты, накладные, лимитированные; без сметной прибыли и без резерва на непредвиденные (деньги заказчика на риск)${economics.ssr.costInflated ? "; в прогнозном уровне цен" : ""}` }],
      [{ text: "Безубыточная цена" }, { text: rubText(economics.breakEvenPrice), note: "прибыль после налогов равна нулю" }],
      [{ text: "Минимальная цена", bold: true }, { text: rubText(economics.minAcceptablePrice), bold: true, note: `маржа ${String(economics.minMarginPercent)} % — минимум из профиля компании` }],
      [{ text: "Допустимое снижение", bold: true }, { text: pctText(economics.maxReductionPercent), bold: true }],
      [{ text: "Запас прочности при НМЦК" }, { text: safetyText(economics.safetyMarginPercent), note: "на столько процентов могут вырасти затраты до нулевой прибыли" }],
      vatRow(economics, input.vatStatus ?? null),
      [{ text: "Надёжность расчёта" }, { text: `${String(economics.confidence.score)} из 100`, note: economics.confidence.reasons.join("; "), tone: economics.confidence.score >= 75 ? "good" : economics.confidence.score >= 50 ? "warn" : "bad" }],
    ],
  });

  if (economics.priceTable.length > 0) {
    blocks.push({
      kind: "table",
      columns: [
        { title: "Цена", width: 26 },
        { title: "Прибыль", width: 22 },
        { title: "Маржа", width: 16 },
        { title: "Налог", width: 18 },
        { title: "Итог", width: 18 },
      ],
      rows: economics.priceTable.map((row) => [
        { text: `${String(row.percentOfNmc)} % НМЦК`, note: rubText(row.price) },
        { text: rubText(row.profit), tone: row.profit < 0 ? "bad" : undefined },
        { text: pctText(row.marginPercent) },
        { text: rubText(row.tax) },
        {
          text: VERDICT_REPORT[row.verdict].text,
          tone: VERDICT_REPORT[row.verdict].tone,
          note: row.antiDumping ? "антидемпинг, ст. 37 44-ФЗ: обеспечение ×1,5" : undefined,
        },
      ]),
    });
  }

  const notes = economics.flags.filter((flag) => flag.severity === "MEDIUM" || flag.severity === "INFO").map((flag) => flag.message);
  if (notes.length > 0) blocks.push({ kind: "bullets", items: notes });

  if (input.customerComparison) blocks.push(...customerComparisonBlocks(input.customerComparison));
  if (input.volumeFindings && input.volumeFindings.length > 0) {
    const onlyInBill = input.volumeFindings.filter((finding) => finding.kind === "BILL_ONLY");
    const differences = input.volumeFindings.filter((finding) => finding.kind !== "BILL_ONLY");
    if (differences.length > 0) {
      blocks.push(
        {
          kind: "paragraph",
          text: `Объёмы ведомости расходятся со сметой заказчика (на сумму расчёта не влияет): ${String(differences.length)}`,
          tone: "warn",
        },
        { kind: "bullets", items: differences.map((finding) => finding.message) },
      );
    }
    if (onlyInBill.length > 0) {
      blocks.push(
        {
          kind: "paragraph",
          text:
            `Работы ведомости, которых нет в смете заказчика (расчёт идёт по смете, их в нём нет — возможно, ` +
            `заказчик их забыл, а включить в цену придётся участнику): ${String(onlyInBill.length)}`,
          tone: "warn",
        },
        { kind: "bullets", items: onlyInBill.map((finding) => finding.message) },
      );
    }
  }
  blocks.push(...auditBlocks);
  blocks.push(...factsBlocks);

  return { title: "Смета и цена участия", blocks };
}

export function buildDeepAnalysisReport(
  input: DeepAnalysisReportInput,
): DeepAnalysisReport {
  const prepared = prepare(input);
  const sections = [
    conclusion(input, prepared),
    consolidationSection(input.summary),
    requirementsSection(prepared),
    moneySection(prepared, input.moneyOutlook ?? null),
    termsSection(prepared),
    // После допуска, денег и сроков: сначала «можно ли и чем рискуем», затем «выгодно ли и до какой цены».
    estimateSection(input, documentEstimateFacts(prepared)),
    risksSection(prepared),
    documentsSection(input.summary, prepared),
    disclaimerSection(input.summary),
    appendixSection(prepared),
  ].filter((section): section is ReportSection => section !== null);

  return {
    title: "Глубокий анализ документации",
    regNumber: input.regNumber,
    subject: input.subject,
    facts: buildFacts(input, prepared),
    sections,
  };
}
