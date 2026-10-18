import type {
  CompanyProfile,
  Tender,
  TenderRequirement,
} from "@/domain/entities";
import type { RequirementKind } from "@/domain/enums";
import {
  checkExperienceAdmission,
  checkPersonnelAdmission,
  isRequirementSatisfied,
  isSroActive,
} from "@/domain/scoring/admission";
import type { AnalysisFinding, FindingRequirementKind } from "@/types/database";

/**
 * Сверка требований из документации с профилем компании.
 *
 * Разбор документации моделью не знает, чья это компания, и знать не должен:
 * его результат общий для закупки, оплачивается один раз и лежит в базе. А
 * ответ на вопрос «можем ли МЫ участвовать» зависит от профиля, который у
 * каждой компании свой и меняется. Поэтому сверка — отдельный шаг здесь:
 * детерминированный, бесплатный, мгновенный и пересчитываемый при каждой
 * правке профиля. Проверки — те же, что у карточки закупки (`admission`):
 * СРО по виду и лимиту ответственности, опыт по порогам из текста, кадры по
 * НРС и НОПРИЗ. Каждый вывод несёт причину и цитату документа.
 *
 * Модель отмечает вид требования (`requirement_kind`); у разборов, сделанных
 * до этой отметки, вид восстанавливается по тексту — сверка работает и по ним.
 */

export type ProfileCheckStatus = "MET" | "NOT_MET" | "CHECK";

export interface ProfileCheck {
  finding: AnalysisFinding;
  kind: FindingRequirementKind;
  status: ProfileCheckStatus;
  /** Почему такой статус — по-человечески, с данными профиля. */
  reason: string;
}

export type ProfileMatchVerdict =
  /** Профиль не заполнен: сверять не с чем. */
  | "NO_PROFILE"
  /** В документации нет требований к участнику. */
  | "NOTHING_TO_CHECK"
  /** Есть требование, которого в профиле нет. */
  | "BLOCKED"
  /** Явных препятствий нет, но часть требований нужно сверить руками. */
  | "REVIEW"
  /** Все требования закрыты профилем. */
  | "READY";

export interface ProfileMatch {
  verdict: ProfileMatchVerdict;
  headline: string;
  checks: ProfileCheck[];
  met: number;
  notMet: number;
  toCheck: number;
}

/** Порядок показа: сначала то, что мешает участию. */
const STATUS_ORDER: Record<ProfileCheckStatus, number> = {
  NOT_MET: 0,
  CHECK: 1,
  MET: 2,
};

/*
  Вид по тексту — для разборов без отметки модели. Границы слов заданы
  «не буквой», а не `\b`: в JS `\b` знает только латиницу. Порядок важен: «лицензия»
  в требовании к банку-гаранту модель блокером не ставит (промпт), а «опыт» и
  «специалист» встречаются вместе — специалисты проверяются по своей шкале.
*/
const TYPICAL_ADMISSION =
  /недобросовестн|(?:^|[^а-яё])рнп(?:[^а-яё]|$)|ликвидац|банкрот|недоимк|судимост|дисквалифик|конфликт[а-я]* интерес|офшор|иностранн[а-я]* агент|19\.28|ч\.?\s*1\s*ст\.?\s*31|санкцион/iu;

const KIND_HINTS: [FindingRequirementKind, RegExp][] = [
  [
    "SMP",
    /малого предпринимательства|(?:^|[^а-яё])(?:смп|сонко)(?:[^а-яё]|$)/iu,
  ],
  ["SRO", /(?:^|[^а-яё])сро(?:[^а-яё]|$)|саморегулируем/iu],
  ["LICENSE", /лицензи/iu],
  [
    "QUALIFIED_PERSONNEL",
    /специалист|(?:^|[^а-яё])нрс(?:[^а-яё]|$)|нострой|ноприз|квалификац|персонал|сотрудник/iu,
  ],
  ["EXPERIENCE", /опыт|исполненн[а-я]* (?:контракт|договор)/iu],
  [
    "EQUIPMENT",
    /оборудовани|техник[аи](?:[^а-яё]|$)|производственн[а-я]* баз/iu,
  ],
  ["SECURITY", /обеспечени[а-я]* (?:заявк|исполнени|договор|контракт)/iu],
  ["DECLARATION", TYPICAL_ADMISSION],
];

export function inferRequirementKind(
  finding: AnalysisFinding,
): FindingRequirementKind {
  const text = `${finding.title} ${finding.required_value ?? ""} ${finding.detail}`;
  if (finding.requirement_kind === "OTHER") {
    // Модель «не знает» вид, но типовое условие допуска узнаётся по тексту:
    // ч. 1 ст. 31 и санкционные перечни она нередко кладёт в «прочее».
    return TYPICAL_ADMISSION.test(text) ? "DECLARATION" : "OTHER";
  }
  if (finding.requirement_kind) return finding.requirement_kind;
  for (const [kind, pattern] of KIND_HINTS) if (pattern.test(text)) return kind;
  return "OTHER";
}

/** Найденное моделью — в форму требования, которую понимают проверки допуска. */
function toRequirement(
  finding: AnalysisFinding,
  kind: RequirementKind,
): TenderRequirement {
  return {
    id: `doc-${finding.title}`,
    kind,
    title: finding.title,
    description: `${finding.detail} ${finding.evidence_quote}`.trim(),
    mandatory: true,
    requiredValue: finding.required_value ?? null,
    evidenceId: null,
  };
}

/*
  Лицензирующие органы и виды лицензий: по ним требование сопоставляется с
  лицензией профиля. Сравнивать строки целиком нельзя — «Лицензия МЧС на
  монтаж…» в профиле и «лицензия на деятельность по монтажу, техническому
  обслуживанию и ремонту средств обеспечения пожарной безопасности» в
  документации описывают одно и то же разными словами.
*/
const LICENSE_TOPICS: [string, RegExp][] = [
  ["МЧС / пожарная безопасность", /мчс|пожарн/iu],
  [
    "ФСБ / шифрование и гостайна",
    /фсб|шифр|криптограф|государственн[а-я]* тайн|гостайн/iu,
  ],
  [
    "ФСТЭК / защита информации",
    /фстэк|техническ[а-я]* защит|защит[а-я]* информаци/iu,
  ],
  [
    "Минкультуры / объекты культурного наследия",
    /минкульт|культурного наследия/iu,
  ],
  ["медицинская деятельность", /медицинск/iu],
  ["образовательная деятельность", /образовательн/iu],
  ["обращение с отходами", /отход/iu],
  [
    "Ростехнадзор / опасные объекты",
    /ростехнадзор|опасн[а-я]* производствен|взрывоопасн/iu,
  ],
  ["геодезия и картография", /геодез|картограф/iu],
  ["перевозки", /перевозк/iu],
  ["фармацевтика", /фармацевт|лекарств/iu],
];

function licenseTopics(text: string): string[] {
  return LICENSE_TOPICS.filter(([, re]) => re.test(text)).map(
    ([label]) => label,
  );
}

function isLicenseValid(validUntil: string | null, now: Date): boolean {
  if (!validUntil) return true;
  const until = new Date(validUntil).getTime();
  return Number.isNaN(until) || until >= now.getTime();
}

function checkLicense(
  finding: AnalysisFinding,
  profile: CompanyProfile,
  now: Date,
) {
  const text = `${finding.required_value ?? ""} ${finding.title} ${finding.detail}`;
  const wanted = licenseTopics(text);
  const valid = profile.licenses.filter(
    (l) => l.confirmed && isLicenseValid(l.validUntil, now),
  );
  if (wanted.length === 0) {
    return valid.length > 0
      ? check(
          "CHECK",
          `Вид лицензии в документе не распознан — сверьте с лицензиями профиля: ${valid.map((l) => l.kind).join("; ")}.`,
        )
      : check("NOT_MET", "В профиле нет подтверждённых лицензий.");
  }
  const match = valid.find((l) =>
    licenseTopics(`${l.kind} ${l.issuer}`).some((t) => wanted.includes(t)),
  );
  if (match)
    return check(
      "MET",
      `Есть лицензия: ${match.kind}${match.number ? ` № ${match.number}` : ""}.`,
    );
  const expired = profile.licenses.find(
    (l) =>
      !isLicenseValid(l.validUntil, now) &&
      licenseTopics(l.kind).some((t) => wanted.includes(t)),
  );
  if (expired)
    return check(
      "NOT_MET",
      `Лицензия «${expired.kind}» истекла ${expired.validUntil}.`,
    );
  return check(
    "NOT_MET",
    `Нужна лицензия (${wanted.join(", ")}) — в профиле такой нет.`,
  );
}

function check(status: ProfileCheckStatus, reason: string) {
  return { status, reason };
}

function checkOne(
  finding: AnalysisFinding,
  kind: FindingRequirementKind,
  tender: Tender,
  profile: CompanyProfile,
  now: Date,
): { status: ProfileCheckStatus; reason: string } {
  switch (kind) {
    case "LICENSE":
      return checkLicense(finding, profile, now);
    case "SRO": {
      if (
        isRequirementSatisfied(
          toRequirement(finding, "SRO"),
          tender,
          profile,
          now,
        )
      ) {
        return check(
          "MET",
          "Действующий допуск СРО нужного вида есть, лимит ответственности покрывает цену.",
        );
      }
      const active = profile.sroMemberships.filter((m) => isSroActive(m, now));
      return check(
        "NOT_MET",
        active.length === 0
          ? "В профиле нет действующего членства в СРО."
          : "Допуск СРО есть, но другого вида или с лимитом меньше цены закупки.",
      );
    }
    case "EXPERIENCE": {
      const result = checkExperienceAdmission(
        toRequirement(finding, "EXPERIENCE"),
        tender,
        profile,
        now,
      );
      if (result.inconclusive) return check("CHECK", result.inconclusive);
      return result.satisfied
        ? check("MET", "Опыт по профилю покрывает требование.")
        : check(
            "NOT_MET",
            result.reason ?? "Опыт по профилю не покрывает требование.",
          );
    }
    case "QUALIFIED_PERSONNEL": {
      const result = checkPersonnelAdmission(
        toRequirement(finding, "QUALIFIED_PERSONNEL"),
        profile,
      );
      if (result.inconclusive) return check("CHECK", result.inconclusive);
      return result.satisfied
        ? check("MET", "Кадровый состав профиля покрывает требование.")
        : check(
            "NOT_MET",
            result.reason ?? "Кадровый состав профиля не покрывает требование.",
          );
    }
    case "EQUIPMENT":
      // В профиле только отметка «есть оборудование», без перечня: подтвердить
      // конкретную технику по ней нельзя, опровергнуть — можно.
      return profile.hasEquipment
        ? check(
            "CHECK",
            "В профиле отмечено наличие оборудования — сверьте с конкретным перечнем из документа.",
          )
        : check(
            "NOT_MET",
            "В профиле не отмечено наличие оборудования и техники.",
          );
    case "SECURITY":
      return profile.hasSpecialAccount
        ? check("MET", "Специальный счёт для обеспечения открыт.")
        : check(
            "NOT_MET",
            "Для обеспечения нужен специальный счёт — в профиле он не отмечен.",
          );
    case "SMP":
      // Статуса СМП в профиле нет: по форме и выручке его не вывести надёжно.
      return check(
        "CHECK",
        "Закупка только для СМП — проверьте, что компания есть в реестре МСП.",
      );
    case "DECLARATION":
      return check(
        "MET",
        "Типовое условие допуска — подтверждается декларацией в заявке.",
      );
    default:
      return check(
        "CHECK",
        "Условие нестандартное — сверьте его с возможностями компании по тексту документации.",
      );
  }
}

/** Профиль заполнен настолько, что с ним есть смысл сверять. */
function isProfileFilled(
  profile: CompanyProfile | null,
): profile is CompanyProfile {
  return (
    profile !== null &&
    (profile.inn.trim() !== "" || profile.legalName.trim() !== "")
  );
}

/** Одинаковые требования из разных фрагментов и документов — один раз. */
function dedupe(findings: AnalysisFinding[]): AnalysisFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.title.toLowerCase().replace(/\s+/g, " ").trim()}|${f.required_value ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function matchFindingsWithProfile(
  findings: AnalysisFinding[],
  tender: Tender,
  profile: CompanyProfile | null,
  now: Date = new Date(),
): ProfileMatch {
  const relevant = dedupe(
    findings.filter(
      (f) => f.category === "blocker" || f.category === "requirement",
    ),
  );

  if (!isProfileFilled(profile)) {
    return {
      verdict: "NO_PROFILE",
      headline:
        "Заполните профиль компании — тогда требования документации сверятся с ним",
      checks: [],
      met: 0,
      notMet: 0,
      toCheck: 0,
    };
  }

  const checks = relevant
    .map((finding) => {
      const kind = inferRequirementKind(finding);
      return {
        finding,
        kind,
        ...checkOne(finding, kind, tender, profile, now),
      };
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        Number(b.finding.category === "blocker") -
          Number(a.finding.category === "blocker"),
    );

  const met = checks.filter((c) => c.status === "MET").length;
  const notMet = checks.filter((c) => c.status === "NOT_MET").length;
  const toCheck = checks.length - met - notMet;

  if (checks.length === 0) {
    return {
      verdict: "NOTHING_TO_CHECK",
      headline: "Особых требований к участнику в документации не найдено",
      checks,
      met,
      notMet,
      toCheck,
    };
  }
  if (notMet > 0) {
    return {
      verdict: "BLOCKED",
      headline: `Не хватает по профилю: ${notMet} из ${checks.length} требований`,
      checks,
      met,
      notMet,
      toCheck,
    };
  }
  if (toCheck > 0) {
    return {
      verdict: "REVIEW",
      headline: `Препятствий не найдено, сверить вручную: ${toCheck}`,
      checks,
      met,
      notMet,
      toCheck,
    };
  }
  return {
    verdict: "READY",
    headline: `Профиль закрывает все требования документации (${met})`,
    checks,
    met,
    notMet,
    toCheck,
  };
}
