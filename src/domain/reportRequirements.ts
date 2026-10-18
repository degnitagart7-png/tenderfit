import type { ProfileCheck, ProfileCheckStatus } from "@/domain/profileMatch";
import { inferRequirementKind } from "@/domain/profileMatch";
import {
  conditionPhrase,
  lackPhrase,
  requirementAction,
  requirementTitle,
  type RequirementAction,
  type RequirementContext,
} from "@/domain/requirementAction";
import {
  flat,
  norm,
  numbersIn,
  sameNumbers,
  shortenAtWord,
} from "@/domain/reportText";
import type { AnalysisFinding, FindingRequirementKind } from "@/types/database";

/**
 * Чистка таблицы «Можем ли участвовать».
 *
 * Модель разбирает документацию по фрагментам и поэтому повторяется: гарантия
 * 36 месяцев приходит из двух файлов, обеспечение исполнения — из трёх. А часть
 * того, что она называет «требованием», к допуску не относится: обеспечения —
 * это деньги, гарантийный срок — это срок. Правила здесь детерминированные, без
 * модели: один и тот же разбор всегда даёт одну и ту же таблицу.
 */

export interface RequirementRow {
  kind: FindingRequirementKind;
  status: ProfileCheckStatus;
  /** Требование коротко, с посчитанными числами. */
  title: string;
  /** Основная цитата документации; пусто у свёрнутой строки типовых требований. */
  quote: string;
  /** Разделы и файлы, на которых основана строка. */
  sources: string[];
  action: RequirementAction;
  /** Для «Да, если подтвердите: …» и «Нет: не хватает …». */
  condition: string;
  lack: string;
  /** Требование названо блокером: в таблице оно жирным. */
  blocker: boolean;
  /** Строка собрана из нескольких типовых требований. */
  typical: boolean;
}

export interface SplitRequirements {
  /** Требования допуска — их и показывает таблица. */
  admission: ProfileCheck[];
  /** Обеспечения — идут в «Деньги». */
  security: ProfileCheck[];
  /** Гарантийный срок на работы — идёт в «Сроки и гарантия». */
  warranty: ProfileCheck[];
}

const SECURITY_TITLE =
  /обеспечени[а-я]*\s+(?:заявк|исполнени|контракт|договор|гарантийн)|способ[а-я]*\s+обеспечени/iu;

/** Обеспечение (заявки, исполнения, гарантийных обязательств) и «способ обеспечения». */
export function isSecurityFinding(
  f: AnalysisFinding,
  kind: FindingRequirementKind = inferRequirementKind(f),
): boolean {
  if (kind === "SECURITY") return true;
  return SECURITY_TITLE.test(`${f.title} ${f.required_value ?? ""}`);
}

/** Гарантийный срок на работы: «Гарантия 36 месяцев». Само обеспечение сюда не входит. */
export function isWarrantyTerm(
  f: AnalysisFinding,
  kind: FindingRequirementKind = inferRequirementKind(f),
): boolean {
  if (isSecurityFinding(f, kind)) return false;
  const head = `${f.title} ${f.required_value ?? ""}`;
  if (!/гаранти/iu.test(head)) return false;
  return /\d+\s*(?:мес|год|лет)/iu.test(`${head} ${f.detail}`);
}

/** Гарантия в месяцах из текста: «36 месяцев», «5 лет». */
export function warrantyMonths(text: string): number | null {
  const months = /(\d{1,3})\s*(?:мес)/iu.exec(text);
  if (months) return Number(months[1]);
  const years = /(\d{1,2})\s*(?:год|лет)/iu.exec(text);
  return years ? Number(years[1]) * 12 : null;
}

export function splitRequirements(checks: ProfileCheck[]): SplitRequirements {
  const out: SplitRequirements = { admission: [], security: [], warranty: [] };
  for (const check of checks) {
    if (isSecurityFinding(check.finding, check.kind)) out.security.push(check);
    else if (isWarrantyTerm(check.finding, check.kind)) out.warranty.push(check);
    else out.admission.push(check);
  }
  return out;
}

const STATUS_RANK: Record<ProfileCheckStatus, number> = {
  NOT_MET: 0,
  CHECK: 1,
  MET: 2,
};

function worst(a: ProfileCheckStatus, b: ProfileCheckStatus): ProfileCheckStatus {
  return STATUS_RANK[a] <= STATUS_RANK[b] ? a : b;
}

/** Ключ слияния: тот же вид и то же число/срок в самом требовании. */
function numbersOfRequirement(f: AnalysisFinding): Set<string> {
  return numbersIn(`${f.required_value ?? ""} ${f.title}`);
}

function sameRequirement(a: ProfileCheck, b: ProfileCheck): boolean {
  if (a.kind !== b.kind) return false;
  // Статус малого бизнеса один: «только СМП» и «СМП и СОНКО» — одна строка.
  if (a.kind === "SMP") return true;
  if (norm(a.finding.title) === norm(b.finding.title) &&
      norm(a.finding.required_value ?? "") === norm(b.finding.required_value ?? "")) {
    return true;
  }
  const na = numbersOfRequirement(a.finding);
  const nb = numbersOfRequirement(b.finding);
  return sameNumbers(na, nb);
}

/*
  Типовые требования: то, что любая действующая компания подтверждает
  декларацией. Их сворачивают в одну строку, а в скобках — перечень коротко.
*/
const TYPICAL_LABELS: [RegExp, string][] = [
  [/ч\.?\s*1\s*ст\.?\s*31|част[а-я]*\s*1\s*стать[а-я]*\s*31/iu, "ч. 1 ст. 31 44-ФЗ"],
  [/санкцион/iu, "санкционные перечни"],
  [/(?:^|[^а-яё])рнп(?:[^а-яё]|$)|недобросовестн/iu, "РНП"],
  [/ликвидац/iu, "нет ликвидации"],
  [/банкрот/iu, "нет банкротства"],
  [/недоимк/iu, "нет недоимки по налогам"],
  [/судимост/iu, "нет судимости"],
  [/дисквалифик/iu, "нет дисквалификации"],
  [/конфликт[а-я]*\s+интерес/iu, "нет конфликта интересов"],
  [/19\.28/iu, "ст. 19.28 КоАП"],
  [/иностранн[а-я]*\s+агент/iu, "не иностранный агент"],
  [/офшор/iu, "не офшорная компания"],
  [/приостановлен/iu, "деятельность не приостановлена"],
];

function typicalLabel(f: AnalysisFinding): string {
  const text = `${f.title} ${f.required_value ?? ""}`;
  for (const [pattern, label] of TYPICAL_LABELS) if (pattern.test(text)) return label;
  return shortenAtWord(f.title, 40);
}

export function typicalRowTitle(findings: AnalysisFinding[]): string {
  const labels = [...new Set(findings.map(typicalLabel))];
  return labels.length > 0
    ? `Типовые требования (${labels.join(", ")})`
    : "Типовые требования к участникам";
}

interface Group {
  primary: ProfileCheck;
  members: ProfileCheck[];
  status: ProfileCheckStatus;
}

/**
 * Строки таблицы из проверок: повторы склеены, типовые свёрнуты, порядок —
 * «Не выполнено → Проверить → Выполнено».
 *
 * `noProfile` — сверки не было: статусы у всех «Проверить», а типовые условия
 * всё равно сворачиваются — декларация подтверждает их независимо от профиля.
 */
export function buildRequirementRows(
  admission: ProfileCheck[],
  context: RequirementContext,
): RequirementRow[] {
  const groups: Group[] = [];
  const typical: ProfileCheck[] = [];
  for (const check of admission) {
    if (check.kind === "DECLARATION") {
      typical.push(check);
      continue;
    }
    const group = groups.find((g) => sameRequirement(g.primary, check));
    if (group) {
      group.members.push(check);
      group.status = worst(group.status, check.status);
      // Показываем самую «тяжёлую» формулировку: та, что хуже по статусу.
      if (STATUS_RANK[check.status] < STATUS_RANK[group.primary.status]) {
        group.primary = check;
      }
    } else {
      groups.push({ primary: check, members: [check], status: check.status });
    }
  }

  const rows: RequirementRow[] = groups.map((g) => {
    const primary: ProfileCheck = { ...g.primary, status: g.status };
    return {
      kind: primary.kind,
      status: g.status,
      title: requirementTitle(primary, context),
      quote: flat(primary.finding.evidence_quote),
      sources: g.members.map((m) => m.finding.evidence_section),
      action: requirementAction(primary, context),
      condition: conditionPhrase(primary, context),
      lack: lackPhrase(primary, context),
      blocker: g.members.some((m) => m.finding.category === "blocker"),
      typical: false,
    };
  });

  // Порядок внутри статуса сохраняется, блокеры выше остальных.
  rows.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      Number(b.blocker) - Number(a.blocker),
  );

  if (typical.length > 0) {
    // Все типовые — «Выполнено» (декларация); без профиля — «Проверить».
    const status = typical.reduce<ProfileCheckStatus>(
      (acc, c) => worst(acc, c.status),
      "MET",
    );
    const first = typical[0]!;
    const action = requirementAction({ ...first, status }, context);
    rows.push({
      kind: "DECLARATION",
      status,
      title: typicalRowTitle(typical.map((c) => c.finding)),
      quote: typical.length === 1 ? flat(first.finding.evidence_quote) : "",
      sources: typical.map((c) => c.finding.evidence_section),
      action,
      condition: "",
      lack: "",
      blocker: false,
      typical: true,
    });
  }
  return rows;
}

/** Требование без сверки (профиль не заполнен): статус «Проверить», причины нет. */
export function pseudoChecks(findings: AnalysisFinding[]): ProfileCheck[] {
  const seen = new Set<string>();
  const checks: ProfileCheck[] = [];
  for (const finding of findings) {
    if (finding.category !== "blocker" && finding.category !== "requirement") continue;
    const key = `${norm(finding.title)}|${finding.required_value ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checks.push({
      finding,
      kind: inferRequirementKind(finding),
      status: "CHECK",
      reason: "",
    });
  }
  return checks;
}
