import type { FitKind, FitRequirement, FitVerdict } from "@/domain/companyFacts/fit";
import type { CompanyFacts } from "@/domain/companyFacts/types";
import { parseMoneyRu, parsePersonnelRequirement } from "@/domain/scoring/admission";

/**
 * Правила сверки, которым нужна осторожность: обеспечение, кадры, что вообще показывать и как не повторяться.
 *
 * Общий принцип всех правил здесь: «не подходит» ставится только там, где цифра прочитана уверенно и сравнивается с цифрой компании
 * из документов. Всё неуверенное — «нужно уточнить». Ложный отказ хуже лишнего вопроса: человек перестаёт верить остальным
 * строкам (замечания живой проверки 21.10.2026: «спецсчёт» к обеспечению исполнения, «штат 23, нужно 1000» из «до 1000 В»).
 */

/** Сколько требований показывает блок: больше — читать никто не станет. Порядок: не подходит → нужно уточнить → подходит. */
export const MAX_SHOWN_REQUIREMENTS = 8;

const rub = (value: number): string => `${Math.round(value).toLocaleString("ru-RU")} ₽`;

/* ------------------------------- Обеспечение ------------------------------- */

const SPECIAL_ACCOUNT_RE = /специальн[а-яё]*\s+(?:банковск[а-яё]*\s+)?сч[её]т|спец\s?сч[её]т/iu;

export type SecurityKind = "application" | "contract";

/** Чьё это обеспечение: заявки или исполнения договора. Заголовок решает раньше пояснения: в пояснении слова «заявка» и «контракт» встречаются вместе. */
export function securityKind(title: string, detail: string): SecurityKind {
  const head = title.toLowerCase();
  if (/заявк/u.test(head)) return "application";
  if (/исполнени|контракт|договор|гаранти/u.test(head)) return "contract";
  return /заявк/u.test(detail.toLowerCase()) && !/исполнени/u.test(detail.toLowerCase()) ? "application" : "contract";
}

/** Процент или сумма обеспечения из текста требования; цена закупки превращает процент в рубли. */
export function securityAmount(text: string, price: number | null): { percent: number | null; amount: number | null } {
  const percentMatch = /(\d{1,3}(?:[.,]\d+)?)\s*(?:%|процент)/iu.exec(text);
  const percent = percentMatch?.[1] === undefined ? null : Number.parseFloat(percentMatch[1].replace(",", "."));
  const money = parseMoneyRu(text);
  const amount = money ?? (percent !== null && price !== null && price > 0 ? (price * percent) / 100 : null);
  return { percent: percent !== null && Number.isFinite(percent) ? percent : null, amount };
}

/**
 * Обеспечение — не допуск: ни при каких условиях не «не подходит».
 *  - Заявка по 44-ФЗ (электронные процедуры): деньги вносятся со специального счёта, либо вместо денег — банковская гарантия.
 *    Спецсчёт открыт — «подходит»; нет — «нужно уточнить: спецсчёт или банковская гарантия».
 *  - Заявка по 223-ФЗ и коммерческим: спецсчёта нет, пока документация сама его не требует. Справочно: деньги или гарантия.
 *  - Исполнение договора: банковской гарантией или деньгами, спецсчёт ни при чём. Справочно, с суммой.
 */
export function evaluateSecurity(input: {
  title: string;
  detail: string;
  required: string;
  law: string | null;
  price: number | null;
  hasSpecialAccount: boolean;
}): { verdict: FitVerdict; basis: string } {
  const text = `${input.title} ${input.required} ${input.detail}`;
  const kind = securityKind(input.title, `${input.required} ${input.detail}`);
  const { percent, amount } = securityAmount(`${input.title} ${input.required}`, input.price);
  const size = amount !== null ? ` — ${rub(amount)}${percent !== null ? ` (${String(percent)} %)` : ""}` : percent !== null ? ` — ${String(percent)} %` : "";

  if (kind === "contract") {
    return {
      verdict: "ok",
      basis: `Обеспечение исполнения договора${size}: банковской гарантией или деньгами. Заранее договоритесь с банком о гарантии.`,
    };
  }
  const needsAccount = input.law === "FZ_44" || SPECIAL_ACCOUNT_RE.test(text);
  if (!needsAccount) {
    return { verdict: "ok", basis: `Обеспечение заявки${size}: деньгами или банковской гарантией.` };
  }
  return input.hasSpecialAccount
    ? { verdict: "ok", basis: `Обеспечение заявки${size}: специальный счёт открыт, деньги вносятся с него.` }
    : { verdict: "check", basis: `Обеспечение заявки${size}: нужен специальный счёт в банке либо банковская гарантия вместо денег — подготовьте одно из двух.` };
}

/* ------------------------------- Кадры ------------------------------- */

const PEOPLE_NOUN = "(?:человек|чел(?![а-яё])|специалист[а-яё]*|работник[а-яё]*|сотрудник[а-яё]*|инженер[а-яё]*|рабоч[а-яё]*|монтажник[а-яё]*)";
const PEOPLE_ADJ = "(?:(?:штатных|квалифицированных|аттестованных|постоянных|собственных|рабочих)\\s+)*";
const HEADCOUNT_PATTERNS: RegExp[] = [
  new RegExp(`(?:не\\s+менее|не\\s+меньше|не\\s+ниже|минимум)\\s+(\\d{1,5})(?:\\s*\\([^)]{1,40}\\))?\\s+${PEOPLE_ADJ}${PEOPLE_NOUN}`, "giu"),
  new RegExp(`(?:штат[а-яё]*|численност[а-яё]*)[^.;\\d]{0,40}?(?:не\\s+менее|не\\s+меньше|минимум)\\s+(\\d{1,5})(?![\\d\\s]*(?:в(?![а-яё])|кв|вт|м(?![а-яё])|т(?![а-яё])|кг|%|лет|год|руб|₽|мес))`, "giu"),
];

/**
 * Численность, которую закупка требует, — только когда число стоит при слове о людях («не менее 5 человек»,
 * «в штате не менее 11»). Число рядом с единицей («до 1000 В», «10 м», «30 %», «5 лет») численностью не считается.
 */
export function confidentHeadcount(text: string, onlyStaffPhrases = false): number | null {
  const lower = text.toLowerCase();
  let best: number | null = null;
  // «Не менее 2 специалистов в НРС» — число по реестру, а не штат: тогда считаются только фразы про штат и численность.
  for (const pattern of onlyStaffPhrases ? HEADCOUNT_PATTERNS.slice(1) : HEADCOUNT_PATTERNS) {
    for (const match of lower.matchAll(pattern)) {
      const value = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0 || value > 10_000) continue;
      best = best === null ? value : Math.max(best, value);
    }
  }
  return best;
}

const QUALIFICATION_RE = /допуск|групп[аыуе]\s+по\s+электро|удостоверени|аттестац|квалификац|разряд|образовани/iu;

/**
 * Кадры: «не подходит» — только когда требуемое число людей прочитано уверенно и меньше ЗАЯВЛЕННОГО штата (из документов,
 * иначе из анкеты). Сумма по ролям — нижняя оценка, не штат: она может подтвердить требование, но отказать по ней нельзя.
 * Требование без числа («работники должны иметь допуск») — «нужно уточнить».
 */
export function evaluatePersonnel(input: {
  text: string;
  facts: CompanyFacts | null;
  /** Штат из анкеты; null — не заполнен. */
  profileStaffTotal: number | null;
  nrsCount: number;
  noprizCount: number;
}): { verdict: FitVerdict; basis: string } {
  const registry = parsePersonnelRequirement(input.text);
  const headcount = confidentHeadcount(input.text, registry.minNrs !== null || registry.minNopriz !== null);
  const documented = input.facts?.staffTotal ?? null;
  const roles = (input.facts?.staff ?? []).reduce((sum, item) => sum + item.count, 0);
  const stated = documented ?? input.profileStaffTotal;
  const note =
    documented !== null && input.profileStaffTotal !== null && input.profileStaffTotal !== documented
      ? ` (в анкете ${String(input.profileStaffTotal)}, в документах ${String(documented)})`
      : "";

  const fails: string[] = [];
  const unknown: string[] = [];
  const confirmed: string[] = [];

  if (headcount !== null) {
    if (stated !== null) {
      if (stated < headcount) fails.push(`штат ${String(stated)} чел.${note}, требуется не менее ${String(headcount)}`);
      else confirmed.push(`штат ${String(stated)} чел.${note} при требуемых ${String(headcount)}`);
    } else if (roles > 0) {
      if (roles >= headcount) confirmed.push(`по ролям названо ${String(roles)} чел. при требуемых ${String(headcount)}`);
      else unknown.push(`общий штат в документах не указан, по ролям названо ${String(roles)} чел. при требуемых ${String(headcount)}`);
    } else {
      unknown.push(`нет данных о численности штата (требуется не менее ${String(headcount)})`);
    }
  }
  for (const [key, label, have] of [
    ["minNrs", "НРС", input.nrsCount],
    ["minNopriz", "НОПРИЗ", input.noprizCount],
  ] as const) {
    const need = registry[key];
    if (need === null || need === undefined || need > 1_000) continue;
    if (have >= need) confirmed.push(`в ${label} ${String(have)} спец. при требуемых ${String(need)}`);
    else if (have > 0) fails.push(`в ${label} ${String(have)} спец., требуется не менее ${String(need)}`);
    else unknown.push(`в документах нет данных о специалистах ${label} (требуется не менее ${String(need)})`);
  }

  if (fails.length > 0) return { verdict: "fail", basis: `${capitalize(fails.join("; "))}.` };
  if (unknown.length > 0) return { verdict: "check", basis: `${capitalize(unknown.join("; "))}. Уточните состав кадров.` };
  if (confirmed.length > 0) {
    return QUALIFICATION_RE.test(input.text)
      ? { verdict: "check", basis: `Численность подходит (${confirmed.join("; ")}), но квалификацию и допуски работников нужно подтвердить документами.` }
      : { verdict: "ok", basis: `${capitalize(confirmed.join("; "))}.` };
  }
  const have = documented !== null ? `В документах штат ${String(documented)} чел.` : roles > 0 ? `В документах по ролям названо ${String(roles)} чел.` : "Данных о кадрах в документах нет.";
  return { verdict: "check", basis: `${have} Требование без числа — сверьте квалификацию и допуски работников с документацией.` };
}

function capitalize(text: string): string {
  return text === "" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/* ------------------------------- Что показывать ------------------------------- */

/**
 * Обязанности исполнителя по договору и канцелярия — не требования к участнику: сертификаты и паспорта на материалы, упаковка и вывоз
 * мусора, согласие работников на обработку ПД, списки лиц и транспорта, СИЗ и инструмент, форма предложения о цене,
 * «приложения не приложены». Скрываются при сверке с компанией (в общем анализе они остаются как были).
 */
const NOISE_RE =
  /(?<![а-яё])сертификат|паспорт[а-яё]*\s+(?:качества|на\s+материал)|упаковк|вывоз|мусор|согласи[ея]\s+(?:работник|на\s+обработк)|персональн[а-яё]*\s+данн|список\s+лиц|транспортн[а-яё]*\s+средств|(?<![а-яё])сиз(?![а-яё])|средств[а-яё]*\s+индивидуальн|инструмент|предложени[а-яё]*\s+о\s+цене|не\s+приложен|приложени[а-яё]*\s+не|ключев[а-яё]*\s+приложени|нов[а-яё]+\s+материал/iu;

/** Признаки требования к участнику или критерия оценки заявки. */
const PARTICIPANT_RE = /участник|заявк|подтвержд|критери|оценк|квалификац|наличи|опыт|в\s+штате|не\s+менее|на\s+праве|допуск|удостоверени|аттестац|разряд|групп[аыуе]\s+по\s+электро/iu;
/** «Прочее» показывается только когда это критерий оценки, дающий баллы, или срок, который может оказаться невыполнимым. */
const EVALUATION_RE = /критери[а-яё]*\s+оценк|показател[а-яё]*\s+оценк|оценк[а-яё]*\s+заявок|(?<![а-яё])балл|невыполним|невозможн|нереальн|не\s+успе/iu;
const DEADLINE_RE = /срок[а-яё]*\s+(?:выполнени|оконча|завершени)/iu;

/** Показывать ли требование: допуск и квалификация, обеспечение, критерии оценки, сроки. Остальное — обязанности по договору. */
export function inScope(kind: FitKind, text: string, blocker = false): boolean {
  if (kind === "SRO" || kind === "LICENSE" || kind === "EXPERIENCE" || kind === "SECURITY" || kind === "REGION" || kind === "SRO_PRICE") return true;
  if (NOISE_RE.test(text)) return false;
  if (kind === "QUALIFIED_PERSONNEL" || kind === "EQUIPMENT") return blocker || PARTICIPANT_RE.test(text);
  return EVALUATION_RE.test(text) || DEADLINE_RE.test(text);
}

/* ------------------------------- Повторы и порядок ------------------------------- */

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^а-яёa-z0-9]+/gu, " ").trim();
}

/** Ключ повтора: вид + суть. У обеспечения суть — чьё оно и сколько, формулировки у разных документов разные. */
export function requirementKey(row: Pick<FitRequirement, "kind" | "title" | "required" | "basis">, securityFacts?: { kind: SecurityKind; percent: number | null; amount: number | null }): string {
  if (row.kind === "SECURITY" && securityFacts !== undefined) {
    return `SECURITY|${securityFacts.kind}|${String(securityFacts.percent ?? Math.round(securityFacts.amount ?? 0))}`;
  }
  return `${row.kind}|${normalizeText(row.title)}|${(row.required ?? "").replace(/\D+/gu, "")}`;
}

const VERDICT_ORDER: Record<FitVerdict, number> = { fail: 0, check: 1, ok: 2 };

/** Порядок «не подходит → нужно уточнить → подходит» (внутри — как пришло) и не больше `MAX_SHOWN_REQUIREMENTS`. */
export function sortAndCap<T extends { verdict: FitVerdict }>(rows: readonly T[], max: number = MAX_SHOWN_REQUIREMENTS): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => VERDICT_ORDER[a.row.verdict] - VERDICT_ORDER[b.row.verdict] || a.index - b.index)
    .slice(0, max)
    .map(({ row }) => row);
}
