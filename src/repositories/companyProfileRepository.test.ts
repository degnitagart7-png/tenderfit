import { beforeEach, describe, expect, it } from "vitest";
import type { CompanyProfile } from "@/domain/entities";
import {
  companyProfileRepository,
  normalizeSavedProfile,
} from "@/repositories/companyProfileRepository";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { STORAGE_KEYS } from "@/lib/storage";
import { DEFAULT_COST_PROFILE } from "@/domain/estimate/companyCostProfile";
import {
  NO_AMOUNT_LIMIT,
  NO_DAYS_LIMIT,
  emptyCompanyProfile,
  profileDescribesSubject,
} from "@/domain/emptyCompanyProfile";

/**
 * Профили хранятся в localStorage и переживают несколько версий схемы.
 * Запись, сохранённая до появления вида работ СРО, уровня ответственности,
 * штата и сумм опыта, должна читаться, а не ломать приложение и не выдавать
 * выдуманные данные.
 */
const LEGACY_SRO = {
  id: "sro-legacy",
  type: "Строительство, реконструкция, капитальный ремонт",
  number: "СРО-С-000-000001",
  confirmed: true,
};

/*
  Замечание 05.10.2026: в анкете стояли «максимальная цена 0», «обеспечение
  заявки 0» и «обеспечение контракта 0» — пустые поля, сохранённые нулём.
  Оценка читала их как «не дороже 0 ₽», каждая закупка с ценой получала
  «Не подходит» и уходила в «Скрыто». Потолок, равный нулю, смысла не имеет:
  это «без ограничения».
*/
describe("normalizeSavedProfile — нулевые потолки", () => {
  it("потолок цены и обеспечений, равный нулю, читается как «без ограничения»", () => {
    const profile = normalizeSavedProfile({
      restrictions: { maxPrice: 0, minPrice: 0, maxBidSecurity: 0, maxContractSecurity: 0 },
    });

    expect(profile.restrictions.maxPrice).toBe(NO_AMOUNT_LIMIT);
    expect(profile.restrictions.maxBidSecurity).toBe(NO_AMOUNT_LIMIT);
    expect(profile.restrictions.maxContractSecurity).toBe(NO_AMOUNT_LIMIT);
    expect(profile.restrictions.minPrice).toBe(0);
  });

  it("настоящий потолок сохраняется", () => {
    const profile = normalizeSavedProfile({ restrictions: { maxPrice: 5_000_000, maxBidSecurity: 100_000 } });

    expect(profile.restrictions.maxPrice).toBe(5_000_000);
    expect(profile.restrictions.maxBidSecurity).toBe(100_000);
  });

  it("срок оплаты 0 дней тоже не запрет всего: читается как «без ограничения»", () => {
    const profile = normalizeSavedProfile({ restrictions: { maxPaymentTermDays: 0 } });

    expect(profile.restrictions.maxPaymentTermDays).toBe(NO_DAYS_LIMIT);
  });
});

describe("normalizeSavedProfile — допуск СРО старой схемы", () => {
  it("вид работ определяется по наименованию из выписки", () => {
    const profile = normalizeSavedProfile({ sroMemberships: [LEGACY_SRO] });
    const [first] = profile.sroMemberships;
    expect(first?.kind).toBe("CONSTRUCTION");
    expect(first?.type).toBe(LEGACY_SRO.type);
    expect(first?.number).toBe(LEGACY_SRO.number);
    expect(first?.confirmed).toBe(true);
  });

  it("уровень ответственности и лимит не выдумываются", () => {
    const profile = normalizeSavedProfile({ sroMemberships: [LEGACY_SRO] });
    expect(profile.sroMemberships[0]?.responsibilityLevel).toBeNull();
    expect(profile.sroMemberships[0]?.maxContractAmount).toBeNull();
    expect(profile.sroMemberships[0]?.validUntil).toBeNull();
  });

  it("проектирование и изыскания распознаются по наименованию", () => {
    const profile = normalizeSavedProfile({
      sroMemberships: [
        { ...LEGACY_SRO, id: "sro-d", type: "Архитектурно-строительное проектирование" },
        { ...LEGACY_SRO, id: "sro-s", type: "Инженерные изыскания" },
        { ...LEGACY_SRO, id: "sro-o", type: "Пожарная безопасность" },
      ],
    });
    expect(profile.sroMemberships.map((m) => m.kind)).toEqual([
      "DESIGN",
      "SURVEY",
      "OTHER",
    ]);
  });

  it("явный вид работ важнее наименования", () => {
    const profile = normalizeSavedProfile({
      sroMemberships: [{ ...LEGACY_SRO, kind: "DESIGN" }],
    });
    expect(profile.sroMemberships[0]?.kind).toBe("DESIGN");
  });

  it("неподтверждённое членство не становится подтверждённым", () => {
    const profile = normalizeSavedProfile({
      sroMemberships: [
        { ...LEGACY_SRO, id: "a", confirmed: "да" },
        { ...LEGACY_SRO, id: "b", validUntil: "" },
        { ...LEGACY_SRO, id: "c", responsibilityLevel: 0, maxContractAmount: "90000000" },
      ],
    });
    expect(profile.sroMemberships[0]?.confirmed).toBe(false);
    expect(profile.sroMemberships[1]?.validUntil).toBeNull();
    // Нулевой уровень и строка вместо числа — не данные.
    expect(profile.sroMemberships[2]?.responsibilityLevel).toBeNull();
    expect(profile.sroMemberships[2]?.maxContractAmount).toBeNull();
  });

  it("записи без id получают устойчивый идентификатор", () => {
    const profile = normalizeSavedProfile({
      sroMemberships: [{ type: "Строительство" }, null, "мусор"],
    });
    expect(profile.sroMemberships.map((m) => m.id)).toEqual([
      "sro-0",
      "sro-1",
      "sro-2",
    ]);
  });

  it("не массив вместо списка допусков оставляет значение демо-профиля", () => {
    const profile = normalizeSavedProfile({ sroMemberships: "нет" });
    expect(profile.sroMemberships).toEqual(demoCompanyProfile.sroMemberships);
  });
});

describe("normalizeSavedProfile — штат и суммы опыта", () => {
  it("отсутствующие разделы заполняются нейтрально, а не из демо-профиля", () => {
    const profile = normalizeSavedProfile({ legalName: "ООО Сохранённое" });
    expect(profile.staff).toEqual({ total: null, nrsCount: 0, noprizCount: 0 });
    expect(profile.experienceTotals).toEqual({
      lastYearAmount: null,
      last3YearsAmount: null,
    });
    // Демо-профиль содержит данные: они не должны протекать в сохранённый.
    expect(demoCompanyProfile.staff.total).not.toBeNull();
  });

  it("значения анкеты контрагента сохраняются как есть", () => {
    const profile = normalizeSavedProfile({
      staff: { total: 11, nrsCount: 2, noprizCount: 2 },
      experienceTotals: { lastYearAmount: 100_000_000, last3YearsAmount: 200_000_000 },
    });
    expect(profile.staff).toEqual({ total: 11, nrsCount: 2, noprizCount: 2 });
    expect(profile.experienceTotals).toEqual({
      lastYearAmount: 100_000_000,
      last3YearsAmount: 200_000_000,
    });
  });

  it("строки и мусор вместо чисел не проходят", () => {
    const profile = normalizeSavedProfile({
      staff: { total: "11", nrsCount: null, noprizCount: 2 },
      experienceTotals: { lastYearAmount: "100000000" },
    });
    expect(profile.staff).toEqual({ total: null, nrsCount: 0, noprizCount: 2 });
    expect(profile.experienceTotals).toEqual({
      lastYearAmount: null,
      last3YearsAmount: null,
    });
  });

  it("нулевая сумма работ отличается от незаполненной", () => {
    const profile = normalizeSavedProfile({
      experienceTotals: { lastYearAmount: 0, last3YearsAmount: 0 },
    });
    expect(profile.experienceTotals).toEqual({
      lastYearAmount: 0,
      last3YearsAmount: 0,
    });
  });
});

describe("normalizeSavedProfile — общий профиль", () => {
  it("вложенные разделы мержатся послойно с пустой основой", () => {
    const profile = normalizeSavedProfile({
      capabilities: { products: ["кирпич"] },
      restrictions: { maxPrice: 90_000_000 },
    });
    expect(profile.capabilities.products).toEqual(["кирпич"]);
    /*
      Незаполненное поле остаётся пустым, а не берётся у примера. Прежде здесь
      стояли коды ОКПД2 «ТехноПоставки» (26.20 и соседние), и поставщик кирпича
      получал закупки на компьютеры, ничего такого не указав.
    */
    expect(profile.capabilities.okpd2Codes).toEqual([]);
    expect(profile.restrictions.maxPrice).toBe(90_000_000);
    expect(profile.restrictions.minPrice).toBe(0);
  });

  it("не объект на входе не роняет приложение", () => {
    expect(() => normalizeSavedProfile(null)).not.toThrow();
    expect(() => normalizeSavedProfile("строка")).not.toThrow();
    const profile = normalizeSavedProfile(undefined);
    expect(profile.legalName).toBe("");
    expect(Array.isArray(profile.sroMemberships)).toBe(true);
  });

  it("массивы старой записи заменяют базовые", () => {
    const profile = normalizeSavedProfile({
      licenses: [],
      experience: [],
      documents: [],
    });
    expect(profile.licenses).toEqual([]);
    expect(profile.experience).toEqual([]);
    expect(profile.documents).toEqual([]);
  });
});

describe("companyProfileRepository.get — чтение сохранённого профиля", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("без сохранённых данных возвращает пустую анкету", () => {
    expect(companyProfileRepository.get()).toEqual(emptyCompanyProfile);
  });

  it("сохранённый профиль старой схемы приводится к текущей", () => {
    const legacy: Record<string, unknown> = {
      ...demoCompanyProfile,
      legalName: "ООО Старая запись",
      sroMemberships: [LEGACY_SRO],
    };
    delete legacy.staff;
    delete legacy.experienceTotals;
    window.localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(legacy));

    const profile: CompanyProfile = companyProfileRepository.get();
    expect(profile.legalName).toBe("ООО Старая запись");
    expect(profile.sroMemberships[0]?.kind).toBe("CONSTRUCTION");
    expect(profile.staff).toEqual({ total: null, nrsCount: 0, noprizCount: 0 });
    expect(profile.experienceTotals).toEqual({
      lastYearAmount: null,
      last3YearsAmount: null,
    });
  });

  it("повреждённая запись не ломает чтение", () => {
    window.localStorage.setItem(STORAGE_KEYS.profile, "{не json");
    // Пустая анкета, а не пример: подставить чужие данные вместо нечитаемых
    // своих — значит молча сменить компанию, от имени которой идёт подбор.
    expect(companyProfileRepository.get()).toEqual(emptyCompanyProfile);
  });

  it("reset очищает анкету, а не подставляет пример", () => {
    window.localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify({ legalName: "Х" }));
    expect(companyProfileRepository.reset()).toEqual(emptyCompanyProfile);
    expect(companyProfileRepository.get().legalName).toBe("");
  });
});

/**
 * Сохранённый профиль не должен подхватывать чужие данные.
 *
 * Прежде демо-профиль служил основой для любого сохранённого: недостающие
 * поля брались у вымышленной «ТехноПоставки». Пользователь вписывал название
 * и ИНН, сохранял — и продолжал получать закупки на ноутбуки и серверы,
 * потому что ключевые слова, ОКПД2 и стоп-слова оставались чужими.
 *
 * Особенно дорого обходились стоп-слова: у примера в них стоит
 * «строительство», и строительная компания отсеивала собственные закупки,
 * ничего об этом не зная.
 */
describe("профиль пользователя не наследует пример", () => {
  it("ключевые слова примера не подмешиваются", () => {
    const profile = normalizeSavedProfile({
      legalName: "ООО «Мостострой»",
      inn: "032631178302",
      capabilities: { keywords: ["мост", "путепровод"] },
    });

    expect(profile.capabilities.keywords).toEqual(["мост", "путепровод"]);
  });

  it("стоп-слова примера не отсеивают чужие закупки", () => {
    const profile = normalizeSavedProfile({
      legalName: "ООО «Мостострой»",
      capabilities: { keywords: ["мост"] },
    });

    expect(profile.capabilities.stopWords).not.toContain("строительство");
  });

  it("коды ОКПД2 примера не остаются в профиле", () => {
    const profile = normalizeSavedProfile({ legalName: "ООО «Мостострой»" });

    expect(profile.capabilities.okpd2Codes).toEqual([]);
  });

  it("чёрный список и регионы примера не наследуются", () => {
    const profile = normalizeSavedProfile({ legalName: "ООО «Мостострой»" });

    expect(profile.restrictions.customerBlacklist).toEqual([]);
    expect(profile.restrictions.workRegions).toEqual([]);
  });

  it("лицензии и опыт примера не приписываются пользователю", () => {
    const profile = normalizeSavedProfile({ legalName: "ООО «Мостострой»" });

    expect(profile.licenses).toEqual([]);
    expect(profile.experience).toEqual([]);
    expect(profile.sroMemberships).toEqual([]);
  });

  it("то, что пользователь вписал, сохраняется", () => {
    const profile = normalizeSavedProfile({
      legalName: "ООО «Мостострой»",
      inn: "032631178302",
      legalForm: "OOO",
    });

    expect(profile.legalName).toBe("ООО «Мостострой»");
    expect(profile.inn).toBe("032631178302");
    expect(profile.legalForm).toBe("OOO");
  });

  it("пример по-прежнему доступен, когда его просят явно", () => {
    const profile = normalizeSavedProfile(
      { legalName: "ООО «Мостострой»" },
      demoCompanyProfile,
    );

    expect(profile.capabilities.keywords).toContain("ноутбук");
  });
});

/**
 * Новый пользователь получает пустую анкету, а не чужую.
 *
 * Форма профиля открывалась заполненной вымышленной компанией: название и ИНН
 * пустые, а товары, ключевые слова, ОКПД2, регионы, чёрный список и заметки —
 * от «ТехноПоставки». Человек вписывал своё название, сохранял и был уверен,
 * что заполнил профиль. Всё, что на самом деле управляет подбором, оставалось
 * чужим.
 */
describe("профиль по умолчанию", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("пока ничего не сохранено, анкета пуста", () => {
    const profile = companyProfileRepository.get();

    expect(profile.capabilities.keywords).toEqual([]);
    expect(profile.capabilities.stopWords).toEqual([]);
    expect(profile.legalName).toBe("");
  });

  it("пример подставляется только по явной просьбе", () => {
    const filled = companyProfileRepository.fillWithExample();

    expect(filled.capabilities.keywords).toContain("ноутбук");
    expect(companyProfileRepository.get().capabilities.keywords).toContain("ноутбук");
  });

  it("сброс возвращает пустую анкету, а не пример", () => {
    companyProfileRepository.fillWithExample();
    const profile = companyProfileRepository.reset();

    expect(profile.capabilities.keywords).toEqual([]);
  });
});

/**
 * Пустой профиль подбору сказать нечего, и это надо уметь отличать.
 */
describe("profileDescribesSubject", () => {
  it("пустой профиль предмет не описывает", () => {
    expect(profileDescribesSubject(emptyCompanyProfile)).toBe(false);
  });

  it("одних ключевых слов достаточно", () => {
    expect(
      profileDescribesSubject({
        ...emptyCompanyProfile,
        capabilities: { ...emptyCompanyProfile.capabilities, keywords: ["мост"] },
      }),
    ).toBe(true);
  });

  it("название и ИНН предмета не описывают", () => {
    expect(
      profileDescribesSubject({
        ...emptyCompanyProfile,
        legalName: "ООО «Мостострой»",
        inn: "032631178302",
      }),
    ).toBe(false);
  });
});

/*
  Профиль затрат лежит в профиле компании: хранится вместе с ним, синхронизируется с аккаунтом как часть профиля
  и читается из любой версии схемы (поля может не быть вовсе).
*/
describe("профиль затрат компании", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("у старого профиля поля нет — и поправок нет", () => {
    expect(normalizeSavedProfile({ legalName: "ООО Старый" }).costProfile).toBeUndefined();
    expect(normalizeSavedProfile({ costProfile: null }).costProfile).toBeUndefined();
  });

  it("сохранённое читается, негодное и выходящее за границы приводится к границам", () => {
    const profile = normalizeSavedProfile({ costProfile: { materialDiscountPercent: 12, labourFactorPercent: 900, machinesFactorPercent: "x" } });

    expect(profile.costProfile).toMatchObject({ materialDiscountPercent: 12, labourFactorPercent: 250, machinesFactorPercent: 100, overheadRealizationPercent: 100 });
  });

  it("saveCostProfile: профиль затрат записывается, остальное в профиле не трогается", () => {
    companyProfileRepository.save({ ...demoCompanyProfile, legalName: "ООО Мой" });

    const saved = companyProfileRepository.saveCostProfile({ ...DEFAULT_COST_PROFILE, labourFactorPercent: 85, subcontractSharePercent: 30 });

    expect(saved.legalName).toBe("ООО Мой");
    const read = companyProfileRepository.get();
    expect(read.legalName).toBe("ООО Мой");
    expect(read.costProfile).toEqual({ ...DEFAULT_COST_PROFILE, labourFactorPercent: 85, subcontractSharePercent: 30 });
    expect(read.taxSystem).toBe(demoCompanyProfile.taxSystem);
  });

  it("saveCostProfile нормализует: значение вне границ не попадает в хранилище", () => {
    const saved = companyProfileRepository.saveCostProfile({ ...DEFAULT_COST_PROFILE, materialDiscountPercent: 999 });
    expect(saved.costProfile?.materialDiscountPercent).toBe(50);
  });

  it("профиля ещё нет (ничего не сохранено): профиль затрат создаёт пустой профиль и не подставляет пример", () => {
    const saved = companyProfileRepository.saveCostProfile({ ...DEFAULT_COST_PROFILE, labourFactorPercent: 90 });
    expect(saved.legalName).toBe("");
    expect(saved.capabilities.keywords).toEqual([]);
  });

  it("профиль затрат ездит вместе с профилем в аккаунт: лежит в том же ключе хранилища", () => {
    companyProfileRepository.saveCostProfile({ ...DEFAULT_COST_PROFILE, labourFactorPercent: 90 });
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.profile) ?? "{}") as { costProfile?: { labourFactorPercent: number } };
    expect(raw.costProfile?.labourFactorPercent).toBe(90);
  });
});
