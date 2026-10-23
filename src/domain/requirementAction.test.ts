import { describe, expect, it } from "vitest";
import type { ProfileCheck, ProfileCheckStatus } from "@/domain/profileMatch";
import {
  conditionPhrase,
  experienceNumbers,
  lackPhrase,
  otherCheckAction,
  requirementAction,
  requirementTitle,
} from "@/domain/requirementAction";
import type { AnalysisFinding, FindingRequirementKind } from "@/types/database";

const NMC = 2_032_153.32;
const ctx = { nmc: NMC };
const flat = (text: string) => text.replace(/\s/g, " ");

function check(
  kind: FindingRequirementKind,
  status: ProfileCheckStatus,
  patch: Partial<AnalysisFinding> = {},
  reason = "",
): ProfileCheck {
  return {
    kind,
    status,
    reason,
    finding: {
      category: "requirement",
      title: "Требование",
      detail: "",
      evidence_quote: "",
      evidence_section: "Раздел 4",
      severity: "medium",
      requirement_kind: kind,
      required_value: null,
      ...patch,
    },
  };
}

const EXPERIENCE = {
  title: "Опыт выполнения работ",
  required_value:
    "опыт исполнения договора по текущему ремонту зданий, сооружений или по строительству, цена выполненных работ не менее 20% от НМЦК",
};

describe("опыт: проценты из текста × НМЦК считает код", () => {
  it("20 % от 2 032 153,32 ₽ = 406 430,66 ₽", () => {
    expect(experienceNumbers(check("EXPERIENCE", "MET", EXPERIENCE), NMC)).toEqual({
      percent: 20,
      amount: 406_430.66,
    });
  });

  it("процент берётся из цитаты, если в required_value его нет", () => {
    const c = check("EXPERIENCE", "MET", {
      required_value: "опыт исполнения договора",
      evidence_quote: "цена выполненных работ должна составлять не менее 20 процентов от начальной цены",
    });
    expect(experienceNumbers(c, NMC).amount).toBe(406_430.66);
  });

  it("сумма названа прямо — берётся она", () => {
    const c = check("EXPERIENCE", "MET", { required_value: "договор не менее 500 000 рублей" });
    expect(experienceNumbers(c, NMC)).toEqual({ percent: null, amount: 500_000 });
  });

  it("цена неизвестна — в рубли не переводим, процент остаётся", () => {
    expect(experienceNumbers(check("EXPERIENCE", "MET", EXPERIENCE), null)).toEqual({
      percent: 20,
      amount: null,
    });
    expect(requirementTitle(check("EXPERIENCE", "MET", EXPERIENCE), { nmc: null })).toMatch(
      /сумма от 20.%.НМЦК/,
    );
  });
});

describe("requirementTitle: коротко и по-человечески", () => {
  it("СМП", () => {
    expect(requirementTitle(check("SMP", "CHECK", { title: "Участие только для СМП и СОНКО" }), ctx)).toBe(
      "Только для малого бизнеса (СМП, СОНКО)",
    );
  });

  it("опыт: договор на ремонт зданий или строительство, сумма с процентом", () => {
    expect(flat(requirementTitle(check("EXPERIENCE", "MET", EXPERIENCE), ctx))).toBe(
      "Опыт: исполненный договор на ремонт зданий или строительство, сумма от 406 430,66 ₽ (20 % НМЦК)",
    );
  });

  it("опыт: только ремонт; срок «за последние 3 года»", () => {
    const c = check("EXPERIENCE", "MET", {
      title: "Опыт",
      required_value: "опыт ремонта зданий за последние три года, не менее 10% от НМЦК",
    });
    expect(flat(requirementTitle(c, ctx))).toBe(
      "Опыт: исполненный договор на ремонт зданий и сооружений, сумма от 203 215,33 ₽ (10 % НМЦК), за последние 3 года",
    );
  });

  it("название и значение не повторяются, если говорят одно и то же", () => {
    const c = check("EQUIPMENT", "CHECK", {
      title: "Наличие техники и оборудования",
      required_value: "Наличие техники, оборудования, технологий и материалов, прошедших осмотр и сертификацию",
    });
    expect(requirementTitle(c, ctx)).toBe(
      "Наличие техники, оборудования, технологий и материалов, прошедших осмотр и сертификацию",
    );
  });

  it("разные название и значение — через двоеточие; длинное режется по слову", () => {
    const c = check("LICENSE", "NOT_MET", { title: "Лицензия МЧС", required_value: "на монтаж пожарной сигнализации" });
    expect(requirementTitle(c, ctx)).toBe("Лицензия МЧС: на монтаж пожарной сигнализации");
    const long = check("OTHER", "CHECK", { title: "Условие", required_value: "слово ".repeat(60) });
    const title = requirementTitle(long, ctx);
    expect(title.length).toBeLessThanOrEqual(161);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("requirementAction: вид требования × статус", () => {
  it("СМП: проверить в реестре МСП, иначе участвовать нельзя", () => {
    const a = requirementAction(check("SMP", "CHECK"), ctx);
    expect(a).toEqual({
      text: "Проверьте, что компания есть в реестре МСП (rmsp.nalog.ru). Если нет — участвовать нельзя.",
      tone: "warn",
    });
    expect(requirementAction(check("SMP", "NOT_MET"), ctx).tone).toBe("bad");
  });

  it("опыт: выполнено — ничего, но приложите договор и акт на сумму", () => {
    const a = requirementAction(check("EXPERIENCE", "MET", EXPERIENCE, "Опыт по профилю покрывает требование."), ctx);
    expect(a.tone).toBe("good");
    expect(flat(a.text)).toBe(
      "Ничего: по профилю опыт есть. Приложите к заявке договор и акт на сумму от 406 430,66 ₽.",
    );
  });

  it("опыт: не выполнено и «проверить» называют сумму и причину", () => {
    const notMet = requirementAction(
      check("EXPERIENCE", "NOT_MET", EXPERIENCE, "В профиле нет договоров такого вида."),
      ctx,
    );
    expect(flat(notMet.text)).toMatch(/^В профиле нет договоров такого вида\. Без подходящего исполненного договора на сумму от 406 430,66 ₽/);
    const toCheck = requirementAction(check("EXPERIENCE", "CHECK", EXPERIENCE), ctx);
    expect(flat(toCheck.text)).toMatch(/^Найдите свой исполненный договор.*406 430,66 ₽/);
  });

  it("лицензия: причина профиля — основа, затем действие", () => {
    const met = requirementAction(check("LICENSE", "MET", {}, "Есть лицензия: Лицензия МЧС № 5."), ctx);
    expect(met.text).toBe("Ничего: есть лицензия: Лицензия МЧС № 5. Приложите копию лицензии к заявке.");
    const notMet = requirementAction(check("LICENSE", "NOT_MET", {}, "Нужна лицензия (ФСБ) — в профиле такой нет."), ctx);
    expect(notMet.text).toMatch(/^Нужна лицензия \(ФСБ\) — в профиле такой нет\. Без этой лицензии заявку не примут/);
  });

  it("специалисты, техника, СРО", () => {
    expect(requirementAction(check("QUALIFIED_PERSONNEL", "MET"), ctx).text).toMatch(/^Ничего: по профилю нужные специалисты есть/);
    expect(requirementAction(check("EQUIPMENT", "CHECK"), ctx).text).toMatch(/Сверьте её с перечнем из документации/);
    expect(requirementAction(check("EQUIPMENT", "NOT_MET"), ctx).text).toMatch(/аренде/);
    expect(requirementAction(check("SRO", "NOT_MET", {}, "В профиле нет действующего членства в СРО."), ctx).text).toMatch(
      /Без допуска СРО нужного вида и уровня заявку не примут/,
    );
  });

  it("типовое требование — декларация", () => {
    expect(requirementAction(check("DECLARATION", "MET"), ctx)).toEqual({
      text: "Подтверждается декларацией в заявке.",
      tone: "good",
    });
  });

  it("обеспечение: счёт есть / счёта нет", () => {
    expect(requirementAction(check("SECURITY", "MET"), ctx).text).toMatch(/специальный счёт есть/);
    expect(requirementAction(check("SECURITY", "NOT_MET"), ctx).text).toMatch(/Откройте специальный счёт/);
  });

  it("прочее — короткое действие без повтора требования и названия пункта", () => {
    const a = requirementAction(
      check(
        "OTHER",
        "CHECK",
        { required_value: "наличие представительства в регионе", evidence_section: "4. Требования к участникам" },
        "Условие нестандартное — сверьте его с возможностями компании по тексту документации.",
      ),
      ctx,
    );
    expect(a.text).toBe("Проверьте, есть ли у компании присутствие в регионе, которое требует заказчик.");
    expect(a.text).not.toMatch(/Требования к участникам/);
    // Документы о качестве материалов — действие, а не пересказ требования (замечание 24.10.2026).
    const certs = requirementAction(
      check("OTHER", "CHECK", {
        title: "Сертификаты и паспорта на все применяемые материалы",
        required_value: "сертификаты качества, технические паспорта и иные документы на все материалы",
        evidence_section: "Приложение №1. Техническое задание",
      }),
      ctx,
    );
    expect(certs.text).toBe("Запросите эти документы у поставщиков материалов заранее: без них работы не примут.");
    expect(otherCheckAction("Иное нестандартное условие")).toBe("Сверьте условие с возможностями компании до подачи заявки.");
    // Старая служебная причина тоже не повторяется.
    expect(
      requirementAction(check("OTHER", "CHECK", {}, "Автоматически не сверяется — проверьте по документу."), ctx).text,
    ).not.toMatch(/Автоматически/);
  });

  it("фразы для «Нет: не хватает …» и «Да, если подтвердите: …»", () => {
    expect(lackPhrase(check("LICENSE", "NOT_MET"), ctx)).toBe("нужной лицензии");
    expect(flat(lackPhrase(check("EXPERIENCE", "NOT_MET", EXPERIENCE), ctx))).toBe(
      "подходящего договора на сумму от 406 430,66 ₽",
    );
    expect(conditionPhrase(check("SMP", "CHECK"), ctx)).toBe("компания есть в реестре МСП (rmsp.nalog.ru)");
    expect(conditionPhrase(check("EQUIPMENT", "CHECK"), ctx)).toBe("своей техники хватит по перечню из документации");
  });
});
