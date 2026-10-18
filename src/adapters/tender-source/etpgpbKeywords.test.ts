import { describe, expect, it } from "vitest";
import {
  buildEtpgpbKeywordGroups,
  etpgpbSlugMatches,
  etpgpbSlugVariants,
  etpgpbSlugify,
  etpgpbTitleMatches,
  etpgpbTranslit,
} from "@/adapters/tender-source/etpgpbKeywords";

/**
 * Пары «название — slug» сняты с живой выдачи 19.10.2026 (названия обрезаны до границ
 * тестируемого, slug — как в адресе). Схема транслитерации обязана воспроизводить их
 * байт в байт: на ней держится отбор процедур по ключевому слову до запроса карточки.
 */
const REAL_PAIRS: readonly [title: string, slug: string][] = [
  [
    "поставка расходного материал для бактериологической лаборатории на 2027г (среди субъектов малого и среднего предпринимательства)\n(совместный аукцион)",
    "postavka-rashodnogo-material-dlya-bakteriologicheskoy-laboratorii-na-2027g-sredi-subektov-malogo-i-srednego-predprinimatelstva-sovmestnyy-auktsion",
  ],
  ["Деревянные поддоны", "derevyannye-poddony"],
  ["Мотопомпа пожарная ТАНКЕР-50ПЖ", "motopompa-pozharnaya-tanker-50pzh"],
  ["Бензиновый генератор Steviman GR-6500P", "benzinovyy-generator-steviman-gr-6500p"],
  [
    'Выполнение работ по ремонту линейной части магистральных газопроводов для нужд ООО "Газпром трансгаз Самара" в 2027 году',
    "vypolnenie-rabot-po-remontu-lineynoy-chasti-magistralnyh-gazoprovodov-dlya-nuzhd-ooo-gazprom-transgaz-samara-v-2027-godu",
  ],
  // Мягкий знак перед «е» площадка пишет как «ie».
  ['Запрос цен на поставку КИП для нужд ООО "ГПН-Заполярье"', "zapros-tsen-na-postavku-kip-dlya-nuzhd-ooo-gpn-zapolyarie"],
  [
    "Продажа МТР по лотам \n№ 810 «Элементы подводных устьевых систем»;\n№ 811 «Патрубки, переводники».",
    "prodazha-mtr-po-lotam-810-elementy-podvodnyh-ustievyh-sistem-811-patrubki-perevodniki",
  ],
  // Запятая между цифрами пропадает, а не даёт дефис; кавычки и «№» пропадают без следа.
  [
    "Реализация_Переводников М 114,3; 88,9; 73,02; 89; 60; 177,8; П Батресс, Подгонных патрубков",
    "realizatsiya-perevodnikov-m-1143-889-7302-89-60-1778-p-batress-podgonnyh-patrubkov",
  ],
  [
    "Поставка маргарина, майонеза и масла растительного для нужд филиала «Волгоградское управление по организации общественного питания»ООО «Газпром питание»",
    "postavka-margarina-mayoneza-i-masla-rastitelnogo-dlya-nuzhd-filiala-volgogradskoe-upravlenie-po-organizatsii-obschestvennogo-pitaniyaooo-gazprom-pitanie",
  ],
];

describe("транслитерация площадки", () => {
  it("воспроизводит живые slug целиком", () => {
    for (const [title, slug] of REAL_PAIRS) {
      expect(etpgpbSlugify(title), title.slice(0, 60)).toBe(slug);
    }
  });

  it.each([
    // Примеры из замера 19.10.2026.
    ["магистральных", "magistralnyh"],
    ["жилищник", "zhilischnik"],
    ["регулирующей", "reguliruyuschey"],
    ["объекте", "obekte"],
    ["центрэнергогаз", "tsentrenergogaz"],
    // Остальные буквы схемы.
    ["щука шанс чай цирк юла яма", "schuka shans chay tsirk yula yama"],
    ["ёж эхо", "ezh eho"],
    ["Ёлка", "elka"],
    ["ремонт", "remont"],
    ["строительство", "stroitelstvo"],
    ["Заполярье", "zapolyarie"],
  ])("%s → %s", (word, expected) => {
    expect(etpgpbTranslit(word)).toBe(expected);
  });

  it("латиница и цифры остаются как есть, регистр снижается", () => {
    expect(etpgpbTranslit("LED-лампа 2026")).toBe("led-lampa 2026");
  });

  it("мягкий знак перед другими гласными: основное написание без «i», а в вариантах есть и оно", () => {
    expect(etpgpbTranslit("семья")).toBe("semya");
    expect(etpgpbSlugVariants("семья")).toEqual(expect.arrayContaining(["semya", "semiya"]));
    // Без мягкого знака вариант один: лишних перебором не создаём.
    expect(etpgpbSlugVariants("ремонт")).toEqual(["remont"]);
  });

  it("транслит основы — начало транслита любой формы слова", () => {
    for (const form of ["ремонта", "ремонту", "ремонтом", "ремонте"]) {
      expect(etpgpbTranslit(form).startsWith(etpgpbTranslit("ремон"))).toBe(true);
    }
  });

  it("slug пуст для названия без букв и цифр", () => {
    expect(etpgpbSlugify("«»")).toBe("");
  });
});

describe("группы ключевых слов", () => {
  it("слово профиля сводится к основе без окончания", () => {
    const [group] = buildEtpgpbKeywordGroups(["капитальный ремонт"]);
    expect(group?.stems).toEqual(["капитальн", "ремон"]);
    expect(group?.slugStems).toEqual([["kapitaln"], ["remon"]]);
  });

  it("пустой список слов — групп нет, отбор пропускает всё", () => {
    expect(buildEtpgpbKeywordGroups([])).toEqual([]);
    expect(buildEtpgpbKeywordGroups(undefined)).toEqual([]);
    expect(buildEtpgpbKeywordGroups(["  ", ","])).toEqual([]);
    expect(etpgpbSlugMatches("lyuboy-slug", [])).toBe(true);
    expect(etpgpbTitleMatches("Любое название", [])).toBe(true);
  });

  it("служебные слова не требуются, но запрос из одних коротких слов не превращается в пустой", () => {
    const [phrase] = buildEtpgpbKeywordGroups(["ремонт и строительство"]);
    expect(phrase?.stems).toEqual(["ремон", "строительств"]);
    const [short] = buildEtpgpbKeywordGroups(["ИТ"]);
    expect(short?.stems).toEqual(["ит"]);
    expect(etpgpbSlugMatches("postavka-oborudovaniya", buildEtpgpbKeywordGroups(["ИТ"]))).toBe(false);
  });
});

describe("отбор по slug и по названию", () => {
  const groups = buildEtpgpbKeywordGroups(["ремонт", "строительство", "монтаж"]);

  it("слово находит любую свою форму", () => {
    expect(etpgpbSlugMatches("vypolnenie-rabot-po-remontu-lineynoy-chasti", groups)).toBe(true);
    expect(etpgpbSlugMatches("kapitalnyy-remont-krovli", groups)).toBe(true);
    expect(etpgpbSlugMatches("stroitelstvo-doma", groups)).toBe(true);
    expect(etpgpbSlugMatches("montazh-oborudovaniya", groups)).toBe(true);
    expect(etpgpbSlugMatches("postavka-benzina", groups)).toBe(false);
  });

  it("название проверяется тем же правилом: регистр и «ё» роли не играют", () => {
    expect(etpgpbTitleMatches("КАПИТАЛЬНЫЙ РЕМОНТ кровли", groups)).toBe(true);
    expect(etpgpbTitleMatches("Строительство объекта", groups)).toBe(true);
    expect(etpgpbTitleMatches("Поставка бензина", groups)).toBe(false);
    const eGroups = buildEtpgpbKeywordGroups(["вёрстка"]);
    expect(etpgpbTitleMatches("Верстка сайта", eGroups)).toBe(true);
  });

  it("группа из нескольких слов требует всех, но не подряд", () => {
    const phrase = buildEtpgpbKeywordGroups(["капитальный ремонт"]);
    expect(etpgpbSlugMatches("kapitalnogo-i-tekuschego-remonta", phrase)).toBe(true);
    expect(etpgpbSlugMatches("tekuschiy-remont", phrase)).toBe(false);
    expect(etpgpbTitleMatches("Капитального и текущего ремонта", phrase)).toBe(true);
    expect(etpgpbTitleMatches("Текущий ремонт", phrase)).toBe(false);
  });

  it("slug и название дают один ответ на живых парах", () => {
    const remont = buildEtpgpbKeywordGroups(["ремонт"]);
    for (const [title, slug] of REAL_PAIRS) {
      expect(etpgpbSlugMatches(slug, remont), title.slice(0, 40)).toBe(etpgpbTitleMatches(title, remont));
    }
  });

  it("slug совпал, а название нет: slug лишь повод читать карточку (`ts` — это и «ц», и «тс»)", () => {
    const groupsTs = buildEtpgpbKeywordGroups(["цирк"]);
    // «ц» и «тс» дают один и тот же транслит `ts`: `tsirk` встречается и в «тсирк».
    expect(etpgpbSlugMatches("kontsert-tsirk", groupsTs)).toBe(true);
    expect(etpgpbTitleMatches("Концерт", groupsTs)).toBe(false);
  });

  it("мягкий знак перед гласной не стоит закупки: найдётся при любом написании", () => {
    const groupsFamily = buildEtpgpbKeywordGroups(["семья"]);
    expect(etpgpbSlugMatches("podderzhka-semi", groupsFamily)).toBe(true);
    expect(etpgpbSlugMatches("semiya", buildEtpgpbKeywordGroups(["семья"]))).toBe(true);
  });
});
