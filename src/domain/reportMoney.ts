import type { Tender } from "@/domain/entities";
import { isPriceKnown } from "@/domain/entities";
import type { ReportCell } from "@/domain/deepAnalysisReport";
import { isSecurityFinding } from "@/domain/reportRequirements";
import { paymentTermOf, isFastPayment, riskTopic } from "@/domain/reportRisks";
import {
  daysBetween,
  firstSentence,
  flat,
  formatDateRu,
  formatPercent,
  formatRubExact,
  norm,
  parseLastDate,
  parsePercent,
  parseRubAmount,
  percentOf,
  round2,
} from "@/domain/reportText";
import { formatDateTime, pluralRu } from "@/utils/format";
import type { AnalysisFinding } from "@/types/database";

/**
 * Разделы «Деньги» и «Сроки и гарантия».
 *
 * Данные берутся из того, что уже извлечено: реквизиты закупки (`financial`,
 * `documentTerms`), находки вида «обеспечение» и условия оплаты из рисков. Чего
 * нет ни там, ни там, строкой не выдумывается: «аванс» без источника — это
 * «неизвестно», а не «нет».
 */

type SecurityKind = "bid" | "contract" | "warranty" | "method";

function securityKind(f: AnalysisFinding): SecurityKind | null {
  const title = norm(f.title);
  if (/способ/u.test(title)) return "method";
  if (/гарантийн/u.test(title)) return "warranty";
  if (/заявк/u.test(title)) return "bid";
  if (/исполнени|контракт|договор/u.test(title)) return "contract";
  const rest = norm(`${f.required_value ?? ""} ${f.evidence_quote}`);
  if (/гарантийн/u.test(rest)) return "warranty";
  if (/заявк/u.test(rest)) return "bid";
  if (/исполнени/u.test(rest)) return "contract";
  return null;
}

/** Сумма из самого требования, потом из цитаты. */
function amountOf(f: AnalysisFinding): number | null {
  return (
    parseRubAmount(f.required_value ?? "") ??
    parseRubAmount(f.title) ??
    parseRubAmount(f.evidence_quote)
  );
}

function percentOfFinding(f: AnalysisFinding): number | null {
  return (
    parsePercent(f.required_value ?? "") ??
    parsePercent(f.title) ??
    parsePercent(f.evidence_quote)
  );
}

export interface MoneyInput {
  tender?: Tender | null;
  findings: AnalysisFinding[];
}

export interface MoneyReport {
  rows: ReportCell[][];
  /** «Заморозится на время контракта: до … ₽ …» — для раздела и для «Итога». */
  total: string | null;
  /** Уточнение к итогу: сумма без снижения цены на 25 % и более. */
  totalNote: string | null;
  /** Платить придётся из своих: аванса нет. */
  advance: "none" | "some" | "unknown";
  /** Срок оплаты после приёмки известен: быстро это или нет. */
  paymentFast: boolean | null;
  /** Есть что показать хотя бы одной строкой кроме НМЦК. */
  hasTerms: boolean;
}

function pctText(value: number): string {
  return formatPercent(Number(value.toFixed(2)));
}

export function buildMoney(input: MoneyInput): MoneyReport {
  const { tender, findings } = input;
  const price =
    tender && isPriceKnown(tender.financial.price) ? tender.financial.price : null;
  const fin = tender?.financial ?? null;
  const docs = tender?.documentTerms ?? null;
  const security = findings.filter(
    (f) =>
      (f.category === "blocker" || f.category === "requirement") &&
      isSecurityFinding(f),
  );
  const of = (kind: SecurityKind) => security.filter((f) => securityKind(f) === kind);

  const rows: ReportCell[][] = [];
  let hasTerms = false;
  const push = (name: string, sum: ReportCell, note: string, tone?: ReportCell["tone"]) => {
    rows.push([{ text: name }, sum, { text: note, tone }]);
    hasTerms = true;
  };

  if (price !== null) {
    rows.push([
      { text: "НМЦК" },
      { text: formatRubExact(price), bold: true },
      { text: "Начальная (максимальная) цена контракта." },
    ]);
  }

  /* ---- Обеспечение заявки ---- */
  let bidAmount: number | null = null;
  if (docs?.bidSecurity && !docs.bidSecurity.required) {
    push("Обеспечение заявки", { text: "Не требуется" }, "Документация прямо пишет, что обеспечение заявки не нужно.");
  } else {
    const found = of("bid")[0];
    const percent = fin?.bidSecurityPercent ?? (found ? percentOfFinding(found) : null);
    bidAmount =
      (fin?.bidSecurityAmount ?? 0) > 0
        ? fin!.bidSecurityAmount
        : (found ? amountOf(found) : null) ??
          (percent !== null && price !== null ? percentOf(price, percent) : null);
    if (bidAmount !== null) {
      const share =
        percent ?? (price !== null ? round2((bidAmount / price) * 100) : null);
      push(
        "Обеспечение заявки",
        { text: `${formatRubExact(bidAmount)}${share !== null ? ` (${pctText(share)} НМЦК)` : ""}` },
        "Блокируется на специальном счёте до подведения итогов закупки.",
      );
    }
  }

  /* ---- Обеспечение исполнения ---- */
  let contractBase: number | null = null;
  let contractMax: number | null = null;
  const contractFinding = of("contract")[0];
  const contractPercent =
    fin?.contractSecurityPercent ??
    (contractFinding ? percentOfFinding(contractFinding) : null);
  const contractExplicit =
    (fin?.contractSecurityAmount ?? 0) > 0
      ? fin!.contractSecurityAmount
      : contractFinding
        ? amountOf(contractFinding)
        : null;
  if (docs?.contractSecurity && !docs.contractSecurity.required) {
    push("Обеспечение исполнения", { text: "Не требуется" }, "Документация прямо пишет, что обеспечение исполнения не нужно.");
  } else if (contractPercent !== null || contractExplicit !== null) {
    contractBase =
      contractPercent !== null && price !== null
        ? percentOf(price, contractPercent)
        : contractExplicit;
    const dumping =
      tender?.law === "FZ_44" ||
      security.some((f) =>
        /полтора|1,5|демпинг|25\s*(?:и\s+более\s+)?процент/iu.test(
          `${f.required_value ?? ""} ${f.evidence_quote}`,
        ),
      );
    // ×1,5 считается от процента, а не от уже округлённой суммы: 45 % от НМЦК, а не 1,5 × 30 %.
    contractMax =
      contractBase === null
        ? null
        : !dumping
          ? contractBase
          : contractPercent !== null && price !== null
            ? percentOf(price, contractPercent * 1.5)
            : round2(contractBase * 1.5);
    const noteParts = [
      "Считается от цены, по которой заключат контракт. Деньги блокируются на счёте заказчика до конца контракта.",
    ];
    if (dumping && contractPercent !== null && contractBase !== null && contractMax !== null && price !== null) {
      noteParts.push(
        `Если цену снизят на 25 % и более, обеспечение в 1,5 раза больше: ${pctText(contractPercent * 1.5)} НМЦК = ${formatRubExact(contractMax)}.`,
      );
    }
    push(
      "Обеспечение исполнения",
      {
        text:
          contractBase !== null
            ? `${formatRubExact(contractBase)}${contractPercent !== null ? ` (${pctText(contractPercent)} НМЦК)` : ""}`
            : `${pctText(contractPercent!)} цены контракта`,
      },
      noteParts.join(" "),
    );
  }

  /* ---- Обеспечение гарантийных обязательств ---- */
  let warrantyAmount: number | null = null;
  const warrantyFinding = of("warranty")[0];
  if (warrantyFinding) {
    const percent = percentOfFinding(warrantyFinding);
    warrantyAmount =
      amountOf(warrantyFinding) ??
      (percent !== null && price !== null ? percentOf(price, percent) : null);
    const share =
      percent ??
      (warrantyAmount !== null && price !== null
        ? round2((warrantyAmount / price) * 100)
        : null);
    if (warrantyAmount !== null || percent !== null) {
      push(
        "Обеспечение гарантийных обязательств",
        {
          text:
            warrantyAmount !== null
              ? `${formatRubExact(warrantyAmount)}${share !== null ? ` (${pctText(share)} НМЦК)` : ""}`
              : `${pctText(percent!)} НМЦК`,
        },
        "Обеспечивает гарантию на выполненные работы — действует весь срок гарантии.",
      );
    }
  }

  /* ---- Способ обеспечения ---- */
  const methodText = of("method")
    .map((f) => `${f.required_value ?? ""} ${f.title} ${f.evidence_quote}`)
    .join(" ");
  const guarantee = /независим[а-я]*\s+гаранти|банковск[а-я]*\s+гаранти/iu.test(methodText);
  const cash = /денежн|деньги|внесени/iu.test(methodText);
  if (guarantee || cash) {
    push(
      "Способ обеспечения",
      {
        text:
          guarantee && cash
            ? "Независимая гарантия или деньги"
            : guarantee
              ? "Независимая гарантия"
              : "Деньги на счёт заказчика",
      },
      guarantee && cash
        ? "Выбираете сами. Деньги блокируются на счёте заказчика; банковская гарантия деньги не замораживает, но банк берёт за неё комиссию."
        : guarantee
          ? "Банковская гарантия деньги не замораживает, но банк берёт за неё комиссию."
          : "Деньги блокируются на счёте заказчика до конца контракта.",
    );
  }

  /* ---- Аванс ---- */
  let advance: MoneyReport["advance"] = "unknown";
  if (docs?.advance && !docs.advance.required) {
    advance = "none";
  } else if (fin && (fin.advancePercent ?? 0) > 0) {
    advance = "some";
  } else if (fin && (fin.advanceAmount ?? 0) > 0) {
    advance = "some";
  }
  if (advance === "none") {
    push("Аванс", { text: "Нет" }, "Работы придётся оплачивать из своих денег до приёмки.", "warn");
  } else if (advance === "some" && fin) {
    const amount =
      (fin.advanceAmount ?? 0) > 0
        ? fin.advanceAmount
        : price !== null && fin.advancePercent
          ? percentOf(price, fin.advancePercent)
          : null;
    push(
      "Аванс",
      {
        text: [
          fin.advancePercent ? pctText(fin.advancePercent) : "",
          amount !== null ? formatRubExact(amount) : "",
        ]
          .filter(Boolean)
          .join(" — "),
      },
      "Часть денег придёт заранее, до приёмки работ.",
    );
  }

  /* ---- Срок оплаты ---- */
  let paymentFast: boolean | null = null;
  const paymentSource = findings.find(
    (f) => /оплат/iu.test(`${f.title} ${f.evidence_quote}`) && paymentTermOf(f.evidence_quote) !== null,
  );
  const term = paymentSource ? paymentTermOf(paymentSource.evidence_quote) : null;
  if (term) {
    paymentFast = isFastPayment(term);
    push(
      "Срок оплаты после приёмки",
      { text: `${String(term.days)} ${term.working ? "рабочих" : "календарных"} дн.` },
      paymentFast
        ? "Деньги придут быстро: ждать оплату долго не придётся."
        : "Оплата не сразу: заложите оборотные деньги на это время.",
      paymentFast ? "good" : "warn",
    );
  } else if (fin && fin.paymentTermDays > 0) {
    paymentFast = fin.paymentTermDays <= 15;
    push(
      "Срок оплаты после приёмки",
      { text: `${String(fin.paymentTermDays)} дн.` },
      paymentFast ? "Деньги придут быстро." : "Оплата не сразу: заложите оборотные деньги на это время.",
      paymentFast ? "good" : "warn",
    );
  }

  /* ---- Казначейское сопровождение ---- */
  const treasury =
    fin?.treasurySupport === true ||
    findings.some((f) => f.category === "risk" && riskTopic(f) === "TREASURY");
  if (treasury) {
    // По 44-ФЗ это обычное условие, которое знает каждый исполнитель: факт без тревоги.
    const statutory = tender?.law === "FZ_44";
    push(
      "Казначейское сопровождение",
      { text: "Есть" },
      statutory
        ? "Типовое условие 44-ФЗ: оплата идёт через казначейский счёт."
        : "Оплата идёт через казначейский счёт: изучите порядок расчётов до подачи, деньги могут приходить дольше.",
      statutory ? undefined : "warn",
    );
  }

  /* ---- Итог ---- */
  const parts: string[] = [];
  if (contractMax !== null) parts.push("исполнение");
  if (warrantyAmount !== null) parts.push("гарантия");
  const frozen = (contractMax ?? 0) + (warrantyAmount ?? 0);
  let total: string | null = null;
  let totalNote: string | null = null;
  if (parts.length > 0) {
    total = `Заморозится на время контракта: до ${formatRubExact(frozen)} (${parts.join(" + ")})`;
    total += bidAmount !== null ? `; плюс заявка ${formatRubExact(bidAmount)} до итогов.` : ".";
    const base = (contractBase ?? 0) + (warrantyAmount ?? 0);
    if (contractBase !== null && contractMax !== null && contractMax !== contractBase) {
      totalNote = `Если цену не снижать на 25 % и более — ${formatRubExact(base)}.`;
    }
  } else if (bidAmount !== null) {
    total = `Заморозится на время подачи: ${formatRubExact(bidAmount)} (обеспечение заявки) до итогов закупки.`;
  }

  return {
    rows,
    total,
    totalNote,
    advance,
    paymentFast,
    hasTerms,
  };
}

/* ============================ Сроки и гарантия ============================ */

export interface TermsInput {
  tender?: Tender | null;
  findings: AnalysisFinding[];
  /** Гарантия в месяцах из требований, ушедших из таблицы допуска. */
  warrantyMonths: number | null;
  neutralTerms: AnalysisFinding[];
  now: Date;
}

export interface TermsReport {
  rows: ReportCell[][];
  /** «сжатый срок»: работы короче ~60 дней — для «Итога». */
  tight: { days: number } | null;
}

/** «осталось 7 дней» / «срок подачи истёк». */
export function submissionCountdown(submissionEnd: string, now: Date): string | null {
  const end = new Date(submissionEnd).getTime();
  if (Number.isNaN(end)) return null;
  const hours = (end - now.getTime()) / 3_600_000;
  if (hours <= 0) return "срок подачи истёк";
  if (hours < 24) return `осталось ${String(Math.max(1, Math.floor(hours)))} ч.`;
  const days = Math.floor(hours / 24);
  return `осталось ${String(days)} ${pluralRu(days, ["день", "дня", "дней"])}`;
}

/** Срок окончания работ: из цитат рисков и фактов («по 30 ноября 2026 г.»). */
function workEnd(findings: AnalysisFinding[]): { date: Date; quote: string } | null {
  for (const f of findings) {
    const head = `${f.title} ${f.evidence_quote}`;
    if (!/срок[а-я]*\s+выполнени[а-я]*\s+работ|выполнени[а-я]*\s+работ[а-я]*\s*:?\s*с\s+момента/iu.test(head)) continue;
    if (/срок[а-я]*\s+исполнени[а-я]*\s+(?:контракт|договор)/iu.test(f.title)) continue;
    const date = parseLastDate(`${f.evidence_quote} ${f.detail}`);
    if (date) return { date, quote: f.evidence_quote };
  }
  return null;
}

function contractEnd(findings: AnalysisFinding[]): Date | null {
  for (const f of findings) {
    if (!/срок[а-я]*\s+(?:исполнени|действи)[а-я]*\s+(?:контракт|договор)/iu.test(f.title)) continue;
    const date = parseLastDate(`${f.evidence_quote} ${f.detail}`);
    if (date) return date;
  }
  return null;
}

const TIGHT_DAYS = 60;

export function buildTerms(input: TermsInput): TermsReport {
  const { tender, findings, now } = input;
  const rows: ReportCell[][] = [];
  let tight: TermsReport["tight"] = null;

  if (tender) {
    const countdown = submissionCountdown(tender.deadlines.submissionEnd, now);
    const closed = countdown === "срок подачи истёк";
    rows.push([
      { text: "Подача заявок" },
      { text: formatDateTime(tender.deadlines.submissionEnd) },
      { text: countdown !== null ? countdown[0]!.toUpperCase() + countdown.slice(1) : "", tone: closed ? "bad" : undefined },
    ]);
  }

  const end = workEnd(findings);
  if (end) {
    const days = daysBetween(now, end.date);
    const isTight = days < TIGHT_DAYS;
    if (isTight && days >= 0) tight = { days };
    rows.push([
      { text: "Выполнение работ" },
      { text: `до ${formatDateRu(end.date)}` },
      {
        text:
          days < 0
            ? "Срок уже прошёл — проверьте даты в документации."
            : isTight
              ? `Осталось ${String(days)} дн. — сжатый срок: проверьте, успеете ли.`
              : `Осталось ${String(days)} дн.`,
        tone: isTight ? "warn" : undefined,
      },
    ]);
  } else if (tender && tender.deadlines.deliveryTermDays != null && tender.deadlines.deliveryTermDays > 0) {
    const days = tender.deadlines.deliveryTermDays;
    const isTight = days < TIGHT_DAYS;
    if (isTight) tight = { days };
    rows.push([
      { text: "Выполнение работ" },
      { text: `${String(days)} дн.` },
      {
        text: isTight ? "Сжатый срок: проверьте, успеете ли." : "С момента заключения контракта.",
        tone: isTight ? "warn" : undefined,
      },
    ]);
  }

  const contract = contractEnd([...input.neutralTerms, ...findings]);
  if (contract) {
    rows.push([
      { text: "Исполнение контракта" },
      { text: `до ${formatDateRu(contract)}` },
      { text: "Контракт действует до этой даты: к ней должны быть закрыты и расчёты." },
    ]);
  }

  const months = input.warrantyMonths ?? tender?.deadlines.warrantyMonths ?? null;
  if (months !== null && months > 0) {
    rows.push([
      { text: "Гарантия на работы" },
      { text: `${String(months)} мес.` },
      { text: "Дефекты в этот срок устраняете за свой счёт. Заложите это в цену." },
    ]);
  }

  // Прочие сроки, найденные моделью, — строкой, без повтора уже показанных.
  const shown = new Set(rows.map((r) => norm(r[0]!.text)));
  for (const f of input.neutralTerms) {
    if (/срок[а-я]*\s+(?:исполнени|действи)[а-я]*\s+(?:контракт|договор)/iu.test(f.title)) continue;
    const key = norm(f.title);
    if (shown.has(key)) continue;
    shown.add(key);
    rows.push([
      { text: flat(f.title) },
      { text: "" },
      { text: firstSentence(f.detail, 200) },
    ]);
  }

  return { rows, tight };
}
