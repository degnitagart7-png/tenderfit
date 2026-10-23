import type { ProfileCheck } from "@/domain/profileMatch";
import {
  flat,
  formatPercent,
  formatRubExact,
  lowerFirst,
  norm,
  parsePercent,
  parseRubAmount,
  percentOf,
  shortenAtWord,
  stemOverlap,
  stems,
  withStop,
  type ReportTone,
} from "@/domain/reportText";

/**
 * «Что делать» по требованию к участнику — один текст для Word и для сайта.
 *
 * Сверка с профилем (`profileMatch`) отвечает «выполнено / не выполнено /
 * проверить» и пишет причину служебным языком: «Опыт по профилю покрывает
 * требование», «Автоматически не сверяется». Директору небольшой фирмы нужен не
 * статус, а следующий шаг: что приложить, что проверить, когда можно не
 * участвовать. Поэтому здесь причина переписывается в действие по виду
 * требования и статусу, а числа (20 % НМЦК → рубли) считает код, а не модель.
 */

export interface RequirementContext {
  /** НМЦК, ₽; null — цена не опубликована. */
  nmc: number | null;
}

export interface RequirementAction {
  text: string;
  tone: ReportTone;
}

type ActionInput = Pick<ProfileCheck, "finding" | "kind" | "status" | "reason">;

const TONE_BY_STATUS: Record<ProfileCheck["status"], ReportTone> = {
  MET: "good",
  CHECK: "warn",
  NOT_MET: "bad",
};

function textOf(check: ActionInput): string {
  const f = check.finding;
  return `${f.title} ${f.required_value ?? ""} ${f.detail} ${f.evidence_quote}`;
}

/* ============================ Числа опыта ============================ */

export interface ExperienceNumbers {
  /** Доля НМЦК из текста требования: 20 для «не менее 20 %». */
  percent: number | null;
  /** Сумма в рублях: посчитана от НМЦК или названа в документации прямо. */
  amount: number | null;
}

/**
 * Какая сумма опыта требуется. Процент берётся из текста требования, умножает
 * на НМЦК код: «20 % от 2 032 153,32 ₽» не должна считать модель.
 */
export function experienceNumbers(
  check: Pick<ActionInput, "finding">,
  nmc: number | null,
): ExperienceNumbers {
  const f = check.finding;
  const own = `${f.required_value ?? ""} ${f.title}`;
  const all = `${own} ${f.evidence_quote} ${f.detail}`;
  const strictPercent = /не\s+менее\s+(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|процент)/iu.exec(all);
  const percent = strictPercent
    ? Number(strictPercent[1]!.replace(",", "."))
    : parsePercent(own);
  if (percent !== null && nmc !== null && nmc > 0) {
    return { percent, amount: percentOf(nmc, percent) };
  }
  // Сумма названа прямо: «не менее 500 000 рублей».
  const direct = /не\s+менее\s+([^.;]{0,40}?(?:₽|руб))/iu.exec(all);
  const amount = direct ? parseRubAmount(direct[1]!) : null;
  return { percent, amount };
}

function experienceWork(text: string): string {
  const repair = /ремонт/iu.test(text);
  const build = /строительств|реконструкц/iu.test(text);
  if (repair && build) return "ремонт зданий или строительство";
  if (repair) return "ремонт зданий и сооружений";
  if (build) return "строительство, реконструкцию или капремонт";
  return "работы, сопоставимые с предметом закупки";
}

function experiencePeriod(text: string): string | null {
  const words: Record<string, number> = {
    один: 1,
    два: 2,
    три: 3,
    четыре: 4,
    пять: 5,
  };
  const m = /за\s+(?:последни[ехй]+\s+)?(\d{1,2}|один|два|три|четыре|пять)\s+(год[а]?|лет)/iu.exec(
    text,
  );
  if (!m) return null;
  const n = /^\d/.test(m[1]!) ? Number(m[1]) : words[m[1]!.toLowerCase()];
  if (!n) return null;
  return `за последние ${String(n)} ${n === 1 ? "год" : n < 5 ? "года" : "лет"}`;
}

/* ============================ Название требования ============================ */

/**
 * Склейка названия и значения без повтора: если значение уже говорит то же, что
 * название («Наличие техники и оборудования» и «Наличие техники, оборудования,
 * технологий…»), остаётся более полное.
 */
function combine(title: string, value: string | null | undefined): string {
  const t = flat(title);
  const v = flat(value ?? "");
  if (v === "") return t;
  if (t === "") return v;
  const nt = norm(t);
  const nv = norm(v);
  if (nv.includes(nt)) return v;
  if (nt.includes(nv)) return t;
  const ts = stems(t);
  if (ts.size > 0 && stemOverlap(ts, stems(v)) / ts.size >= 0.6) {
    return v.length >= t.length ? v : t;
  }
  return `${t}: ${v}`;
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/**
 * Требование коротко и по-человечески, с посчитанными числами:
 * «Только для малого бизнеса (СМП, СОНКО)»,
 * «Опыт: исполненный договор на ремонт зданий или строительство, сумма от
 * 406 430,66 ₽ (20 % НМЦК)».
 */
export function requirementTitle(
  check: Pick<ActionInput, "finding" | "kind">,
  context: RequirementContext,
): string {
  const f = check.finding;
  switch (check.kind) {
    case "SMP":
      return "Только для малого бизнеса (СМП, СОНКО)";
    case "EXPERIENCE": {
      const text = textOf({ ...check, status: "CHECK", reason: "" });
      const { percent, amount } = experienceNumbers(check, context.nmc);
      const parts = [`Опыт: исполненный договор на ${experienceWork(text)}`];
      const period = experiencePeriod(text);
      if (amount !== null && percent !== null && context.nmc !== null) {
        parts.push(
          `сумма от ${formatRubExact(amount)} (${formatPercent(percent)} НМЦК)`,
        );
      } else if (amount !== null) {
        parts.push(`сумма от ${formatRubExact(amount)}`);
      } else if (percent !== null) {
        parts.push(`сумма от ${formatPercent(percent)} НМЦК`);
      }
      if (period) parts.push(period);
      return parts.join(", ");
    }
    default:
      return shortenAtWord(
        capitalize(combine(f.title, f.required_value)),
        160,
      );
  }
}

/* ============================ Что делать ============================ */

function reasonSentence(reason: string): string {
  return withStop(reason);
}

/** Этот текст причины — служебная заглушка, повторять его читателю незачем. */
function isStubReason(reason: string): boolean {
  return (
    reason.trim() === "" ||
    /автоматически не сверяется|условие нестандартное/iu.test(reason)
  );
}

export function requirementAction(
  check: ActionInput,
  context: RequirementContext,
): RequirementAction {
  const { status } = check;
  const tone = TONE_BY_STATUS[status];
  const reason = isStubReason(check.reason) ? "" : reasonSentence(check.reason);
  const say = (...parts: string[]): RequirementAction => ({
    text: parts.filter((p) => p !== "").join(" "),
    tone,
  });

  switch (check.kind) {
    case "SMP":
      if (status === "MET") return say("Ничего: компания подходит как субъект малого бизнеса.");
      if (status === "NOT_MET")
        return say(
          "Участвовать нельзя: закупка только для малого бизнеса, а компания к нему не относится. Выберите другую закупку.",
        );
      return say(
        "Проверьте, что компания есть в реестре МСП (rmsp.nalog.ru). Если нет — участвовать нельзя.",
      );

    case "SRO":
      if (status === "MET")
        return say(
          "Ничего: допуск СРО подходит. Если документация просит, приложите выписку из реестра СРО.",
        );
      if (status === "NOT_MET")
        return say(
          reason,
          "Без допуска СРО нужного вида и уровня заявку не примут: вступите в СРО заранее или пропустите закупку.",
        );
      return say(
        reason,
        "Проверьте, что допуск СРО подходит по виду работ, а лимит ответственности покрывает цену закупки.",
      );

    case "LICENSE":
      if (status === "MET")
        return say(
          `Ничего: ${lowerFirst(reasonSentence(check.reason))}`,
          "Приложите копию лицензии к заявке.",
        );
      if (status === "NOT_MET")
        return say(
          reason,
          "Без этой лицензии заявку не примут, а получить её быстро нельзя — закупку лучше пропустить.",
        );
      return say(
        reason,
        "Откройте документ, найдите, какая именно лицензия нужна, и сверьте со своими.",
      );

    case "EXPERIENCE": {
      const { amount } = experienceNumbers(check, context.nmc);
      const sum = amount !== null ? ` на сумму от ${formatRubExact(amount)}` : "";
      if (status === "MET")
        return say(
          amount !== null
            ? `Ничего: по профилю опыт есть. Приложите к заявке договор и акт${sum}.`
            : "Ничего: по профилю опыт есть. Приложите к заявке исполненный договор и акт выполненных работ.",
        );
      if (status === "NOT_MET")
        return say(
          reason,
          `Без подходящего исполненного договора${sum} заявку не примут: найдите такой договор или пропустите закупку.`,
        );
      return say(
        reason,
        `Найдите свой исполненный договор подходящего предмета${sum} и приложите его к заявке вместе с актом.`,
      );
    }

    case "QUALIFIED_PERSONNEL":
      if (status === "MET")
        return say(
          "Ничего: по профилю нужные специалисты есть. Если документация просит, приложите их дипломы и удостоверения.",
        );
      if (status === "NOT_MET")
        return say(
          reason,
          "Без специалистов нужной квалификации заявку не примут: найдите или оформите их до подачи.",
        );
      return say(
        reason,
        "Посмотрите в документации, сколько специалистов и какой квалификации нужно, и сверьте со своим штатом.",
      );

    case "EQUIPMENT":
      if (status === "MET") return say("Ничего: нужная техника и оборудование по профилю есть.");
      if (status === "NOT_MET")
        return say(
          "В профиле нет техники и оборудования. Если нужная техника не своя, договоритесь об аренде или субподрядчике до подачи.",
        );
      return say(
        "В профиле техника отмечена. Сверьте её с перечнем из документации: хватит ли на весь объём работ. Если нет — договоритесь об аренде заранее.",
      );

    case "DECLARATION":
      return say("Подтверждается декларацией в заявке.");

    case "SECURITY":
      if (status === "MET")
        return say("Ничего: специальный счёт есть. Сумма обеспечения заблокируется на нём.");
      if (status === "NOT_MET")
        return say(
          "Откройте специальный счёт в банке до подачи заявки: без него обеспечение внести нельзя.",
        );
      return say("Проверьте, что у компании есть специальный счёт для обеспечения.");

    default: {
      if (status === "MET") return say("Ничего: условие выполнено.");
      if (status === "NOT_MET")
        return say(reason, "По профилю не выполнено: решите, успеете ли закрыть условие до подачи, иначе закупку лучше пропустить.");
      return say(otherCheckAction(textOf(check)));
    }
  }
}

/**
 * Следующий шаг по требованию без своего вида — одной фразой.
 *
 * Раньше здесь печаталось «Прочитайте пункт «Приложение №1. Техническое задание»
 * документации и убедитесь, что компания это выполнит: сертификаты качества,
 * технические паспорта и иные документы…» — название пункта и само требование,
 * которые на экране уже стоят строкой выше и в цитате ниже (замечание
 * 24.10.2026). Теперь — только действие, по смыслу требования.
 */
export function otherCheckAction(text: string): string {
  const t = norm(text);
  if (/сертификат|паспорт|декларац\S* соответстви|документ\S* о качеств/u.test(t))
    return "Запросите эти документы у поставщиков материалов заранее: без них работы не примут.";
  if (/гаранти\S* срок|гаранти\S* \d|гарантийн/u.test(t))
    return "Учтите гарантийный срок в цене: гарантийный ремонт оплачиваете вы.";
  if (/(срок|график)\S*.{0,40}(выполнен|работ|поставк|оказан)|календарн\S* дн/u.test(t))
    return "Сверьте срок со своим графиком: если не успеваете, закупку лучше пропустить.";
  if (/штраф|пени|неустойк/u.test(t)) return "Заложите риск штрафа в цену и в график работ.";
  if (/представительств|офис|филиал|в регионе/u.test(t))
    return "Проверьте, есть ли у компании присутствие в регионе, которое требует заказчик.";
  if (/материал|оборудован|издели/u.test(t))
    return "Проверьте, что сможете закупить материалы с такими характеристиками, и учтите их в цене.";
  return "Сверьте условие с возможностями компании до подачи заявки.";
}

/* ============================ Для строки «Итог» ============================ */

/** Чего не хватает — для «Нет: не хватает …». */
export function lackPhrase(
  check: Pick<ActionInput, "finding" | "kind">,
  context: RequirementContext,
): string {
  switch (check.kind) {
    case "SMP":
      return "статуса малого бизнеса";
    case "SRO":
      return "допуска СРО нужного вида";
    case "LICENSE":
      return "нужной лицензии";
    case "EXPERIENCE": {
      const { amount } = experienceNumbers(check, context.nmc);
      return amount !== null
        ? `подходящего договора на сумму от ${formatRubExact(amount)}`
        : "подходящего опыта";
    }
    case "QUALIFIED_PERSONNEL":
      return "специалистов нужной квалификации";
    case "EQUIPMENT":
      return "техники и оборудования";
    default:
      return lowerFirst(shortenAtWord(check.finding.title, 70));
  }
}

/** Что подтвердить — для «Да, если подтвердите: …». */
export function conditionPhrase(
  check: Pick<ActionInput, "finding" | "kind">,
  context: RequirementContext,
): string {
  switch (check.kind) {
    case "SMP":
      return "компания есть в реестре МСП (rmsp.nalog.ru)";
    case "SRO":
      return "допуск СРО подходит по виду работ и лимиту";
    case "LICENSE":
      return "у вас есть нужная лицензия";
    case "EXPERIENCE": {
      const { amount } = experienceNumbers(check, context.nmc);
      return amount !== null
        ? `у вас есть исполненный договор на сумму от ${formatRubExact(amount)}`
        : "у вас есть подходящий исполненный договор";
    }
    case "QUALIFIED_PERSONNEL":
      return "у вас есть специалисты нужной квалификации";
    case "EQUIPMENT":
      return "своей техники хватит по перечню из документации";
    default:
      return lowerFirst(shortenAtWord(check.finding.title, 70));
  }
}
