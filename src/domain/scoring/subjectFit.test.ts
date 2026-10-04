import { describe, expect, it } from "vitest";
import type { CompanyProfile, Tender } from "@/domain/entities";
import {
  computeFitScore,
  computeScores,
  computeSubjectFit,
  detectHardBlockers,
  deriveVerdict,
  SUBJECT_FIT_FLOOR,
} from "@/domain/scoring";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";

/**
 * Регрессии соответствия предмета.
 *
 * Оба дефекта найдены замерами на живой выдаче 28.09.2026 и до этих тестов
 * ничем не удерживались: правка формулы не уронила ни одного из двух тысяч
 * тестов проекта.
 */

const SUBJECT_BLOCKER = "Предмет закупки не совпадает с профилем компании";

/** Профиль с произвольным набором терминов; остальное — рабочий минимум. */
function profileWith(keywords: string[], okpd2: string[] = []): CompanyProfile {
  return {
    organizationId: "org-1",
    legalName: "ООО «Тест»",
    inn: "500100732259",
    legalForm: "OOO",
    taxSystem: "OSNO",
    worksWithVat: true,
    activityDescription: "",
    capabilities: {
      products: [],
      works: [],
      services: [],
      brandsAndModels: [],
      keywords,
      synonyms: [],
      stopWords: [],
      okpd2Codes: okpd2,
    },
    restrictions: {
      minPrice: 0,
      maxPrice: 1_000_000_000,
      maxDistanceKm: null,
      maxPaymentTermDays: 90,
      minDeliveryTermDays: 1,
      minMarginPercent: 0,
      maxBidSecurity: 100_000_000,
      maxContractSecurity: 100_000_000,
      allowNoAdvance: true,
      workRegions: [],
      customerWhitelist: [],
      customerBlacklist: [],
      custom: [],
    },
    licenses: [],
    sroMemberships: [],
    hasPersonnel: true,
    hasEquipment: true,
    hasSpecialAccount: true,
    staff: { total: 10, nrsCount: 0, noprizCount: 0 },
    preferences: {
      priorityRegions: [],
      preferredMinPrice: null,
      preferredMaxPrice: null,
      preferAdvance: false,
      preferShortPaymentTerm: false,
      priorityBrands: [],
      avoidTreasurySupport: false,
      notes: [],
    },
    experience: [],
    experienceTotals: { lastYearAmount: null, last3YearsAmount: null },
    documents: [],
  };
}

function tenderAbout(subject: string, okpd2: string[] = []): Tender {
  const price = 1_000_000;
  return {
    id: "t-1",
    regNumber: "00000000001",
    externalId: null,
    law: "FZ_223",
    placingWay: "OTHER",
    subject,
    customerName: "АО «Заказчик»",
    customerInn: null,
    region: "Москва",
    deliveryAddress: "Москва",
    financial: {
      price,
      currency: "RUB",
      advancePercent: 0,
      advanceAmount: 0,
      paymentTermDays: 30,
      postpaymentDays: null,
      bidSecurityAmount: 0,
      bidSecurityPercent: 0,
      contractSecurityAmount: 0,
      contractSecurityPercent: 0,
      treasurySupport: false,
      expectedMarginPercent: 20,
    },
    deadlines: {
      submissionEnd: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(),
      publicationDate: new Date().toISOString(),
      lastUpdateDate: new Date().toISOString(),
      deliveryTermDays: 30,
      warrantyMonths: 12,
    },
    okpd2Codes: okpd2,
    lots: [],
    requirements: [],
    documents: [],
    nationalRegime: false,
    onlyForSmp: false,
    eisUrl: "",
    dataSource: "MOCK",
    changeLog: [],
  };
}

describe("computeSubjectFit — полнота профиля не наказывается", () => {
  const tender = tenderAbout(
    "Реконструкция подстанции 220 кВ: строительно-монтажные работы",
  );

  it("добавление направлений, которых нет в закупке, не снижает оценку", () => {
    /*
      Ровно тот замер, что выявил дефект: совпадают всё время два слова,
      меняется только длина списка. Прежняя формула (доля от всех слов
      профиля) давала 33 → 24 → 15 и наказывала за честно заполненный профиль.
    */
    const narrow = computeSubjectFit(tender, profileWith(["реконструкция", "подстанция"]));
    const wide = computeSubjectFit(
      tender,
      profileWith([
        "реконструкция",
        "подстанция",
        "кабельные линии",
        "трансформатор",
        "заземление",
        "молниезащита",
        "видеонаблюдение",
        "вентиляция",
      ]),
    );

    expect(wide).toBe(narrow);
  });

  it("больше совпавших терминов — выше оценка", () => {
    const one = computeSubjectFit(tender, profileWith(["подстанция"]));
    const two = computeSubjectFit(tender, profileWith(["подстанция", "реконструкция"]));
    expect(two).toBeGreaterThan(one);
  });

  it("совпадение по ОКПД2 поднимает оценку", () => {
    const withoutCode = computeSubjectFit(
      tenderAbout("Поставка ноутбуков", ["26.20.11"]),
      profileWith(["ноутбук"]),
    );
    const withCode = computeSubjectFit(
      tenderAbout("Поставка ноутбуков", ["26.20.11"]),
      profileWith(["ноутбук"], ["26.20"]),
    );
    expect(withCode).toBeGreaterThan(withoutCode);
  });

  it("закупка не из профиля остаётся внизу шкалы", () => {
    const alien = computeSubjectFit(tender, profileWith(["ноутбук", "принтер", "сервер"]));
    expect(alien).toBeLessThan(SUBJECT_FIT_FLOOR);
  });
});

describe("Отсечка по предмету", () => {
  const alienTender = tenderAbout("Реконструкция подстанции 220 кВ");
  const computerSupplier = profileWith(["ноутбук", "принтер", "сервер"]);

  it("несовпадение предмета даёт блокер", () => {
    const blockers = detectHardBlockers(alienTender, computerSupplier);
    expect(blockers.some((b) => b.reason === SUBJECT_BLOCKER)).toBe(true);
  });

  it("блокер некритический: слова профиля заполняет человек и может их не дописать", () => {
    const blocker = detectHardBlockers(alienTender, computerSupplier).find(
      (b) => b.reason === SUBJECT_BLOCKER,
    );
    expect(blocker?.critical).toBe(false);
  });

  it("профильная закупка блокера не получает", () => {
    const own = tenderAbout("Поставка ноутбуков и принтеров", ["26.20.11"]);
    const blockers = detectHardBlockers(own, computerSupplier);
    expect(blockers.some((b) => b.reason === SUBJECT_BLOCKER)).toBe(false);
  });
});

describe("Вес предмета в итоговом балле", () => {
  it("закупка без единого препятствия, но не по профилю, не добирает до проходной", () => {
    /*
      Суть дефекта: четыре показателя из пяти начинаются со 100 и падают лишь
      при явном препятствии. Раньше их сумма давала 64 балла поставщику
      компьютеров на реконструкции подстанции — больше, чем у профильных
      закупок конкурентов.
    */
    const alien = tenderAbout("Реконструкция подстанции 220 кВ");
    const profile = profileWith(["ноутбук", "принтер", "сервер"]);
    const scores = computeScores(alien, profile, []);
    expect(computeFitScore(scores)).toBeLessThan(60);
  });

  it("профильная закупка обгоняет непрофильную с тем же отсутствием препятствий", () => {
    const profile = profileWith(["ноутбук", "принтер", "сервер"], ["26.20"]);
    const own = computeFitScore(
      computeScores(
        tenderAbout("Поставка ноутбуков, принтеров и серверов", ["26.20.11"]),
        profile,
        [],
      ),
    );
    const alien = computeFitScore(
      computeScores(tenderAbout("Реконструкция подстанции 220 кВ"), profile, []),
    );
    expect(own - alien).toBeGreaterThan(25);
  });
});

/**
 * Пустой профиль не должен никого блокировать.
 *
 * Жёсткие ограничения профиля дают критические блокеры: цена вне диапазона
 * снимает закупку с рекомендаций совсем. Поэтому незаполненная анкета обязана
 * означать «ограничений нет», а не «ограничение равно нулю»: второе выкосило
 * бы всю выдачу, и человек, только что открывший сервис, увидел бы, что ему
 * не подходит ничего.
 *
 * Это прямое следствие того, что анкета больше не заполняется примером: до
 * правки пустых профилей просто не бывало.
 */
describe("пустой профиль как вход подбора", () => {
  const tender = tenderAbout("Поставка компьютерной техники", ["26.20"]);

  it("цена закупки не даёт блокера", () => {
    const blockers = detectHardBlockers(tender, emptyCompanyProfile);

    expect(blockers.filter((b) => b.critical).map((b) => b.reason)).not.toContain(
      "Цена вне диапазона профиля",
    );
  });

  it("критических блокеров нет вовсе", () => {
    const blockers = detectHardBlockers(tender, emptyCompanyProfile);

    expect(blockers.filter((b) => b.critical)).toEqual([]);
  });

  it("дорогая закупка тоже не блокируется", () => {
    const expensive = {
      ...tender,
      financial: { ...tender.financial, price: 9_000_000_000 },
    };

    expect(detectHardBlockers(expensive, emptyCompanyProfile).filter((b) => b.critical)).toEqual([]);
  });
});

/**
 * Пустой профиль не даёт вердикта «не подходит».
 *
 * Соответствие предмета считается по словам профиля. Когда слов нет вовсе,
 * совпадений тоже нет — и закупка получала блокер «Предмет закупки не
 * совпадает с профилем компании». На живой ленте это давало «Не подходит» у
 * всех 198 закупок сразу: человек, только что открывший сервис, читал, что
 * ему не подходит вообще ничего.
 *
 * Утверждение при этом ложное. «Не совпало» и «сравнивать не с чем» — разные
 * вещи, и вторую честнее не выдавать за первую.
 */
describe("предмет при пустом профиле", () => {
  const tender = tenderAbout("Реконструкция подстанции 220 кВ");

  it("блокера по предмету нет", () => {
    expect(detectHardBlockers(tender, emptyCompanyProfile).map((b) => b.reason)).not.toContain(
      SUBJECT_BLOCKER,
    );
  });

  it("а при заполненном профиле блокер остаётся", () => {
    expect(
      detectHardBlockers(tender, profileWith(["ноутбук", "принтер"])).map((b) => b.reason),
    ).toContain(SUBJECT_BLOCKER);
  });
});

/**
 * Без профиля вердикт — «решает человек», а не «не подходит».
 *
 * Балл соответствия наполовину состоит из совпадения предмета. Когда профиль
 * пуст, совпадать нечему, балл падает ниже 50 — и правило «score < 50»
 * объявляло закупку неподходящей. На живой ленте это давало «Не подходит» у
 * 198 закупок из 198.
 *
 * Отрицательный вердикт — такое же утверждение, как положительный, и без
 * профиля он ничем не обеспечен. Честный ответ здесь один: оснований судить
 * нет, смотрите сами.
 */
describe("вердикт при пустом профиле", () => {
  const tender = tenderAbout("Реконструкция подстанции 220 кВ");

  it("не «не подходит»", () => {
    const verdict = deriveVerdict({
      fitScore: computeFitScore(computeScores(tender, emptyCompanyProfile, [])),
      hardBlockers: detectHardBlockers(tender, emptyCompanyProfile),
      uncertainties: [],
      requiredDocumentsUnconfirmed: false,
      criticalDeadline: false,
      profileDescribesSubject: false,
    });

    expect(verdict).toBe("MANUAL_REVIEW");
  });

  it("низкий балл при заполненном профиле по-прежнему «не подходит»", () => {
    const profile = profileWith(["ноутбук", "принтер"]);
    const verdict = deriveVerdict({
      fitScore: computeFitScore(computeScores(tender, profile, [])),
      hardBlockers: detectHardBlockers(tender, profile),
      uncertainties: [],
      requiredDocumentsUnconfirmed: false,
      criticalDeadline: false,
      profileDescribesSubject: true,
    });

    expect(verdict).toBe("NOT_RECOMMENDED");
  });

  it("критический блокер сильнее пустого профиля", () => {
    const verdict = deriveVerdict({
      fitScore: 90,
      hardBlockers: [
        { id: "b", reason: "Срок подачи истёк", detail: "", evidenceId: null, critical: true },
      ],
      uncertainties: [],
      requiredDocumentsUnconfirmed: false,
      criticalDeadline: false,
      profileDescribesSubject: false,
    });

    expect(verdict).toBe("NOT_RECOMMENDED");
  });
});
