import type { CompanyProfile } from "@/domain/entities";

/**
 * «Ограничения нет» для денежных полей профиля, ₽.
 *
 * Схема требует здесь число, а не `null`, поэтому «не задано» приходится
 * выражать величиной, которой не достигает ни одна закупка: триллион рублей
 * при том, что крупнейшие государственные контракты измеряются сотнями
 * миллиардов.
 *
 * Ноль сюда поставить нельзя, и это не вкусовщина: цена выше `maxPrice` даёт
 * критический блокер «Цена вне диапазона профиля» и снимает закупку с
 * рекомендаций. Пустая анкета с нулевым потолком означала бы, что человеку,
 * только что открывшему сервис, не подходит ничего.
 *
 * Правильное решение — сделать поля `number | null`, но они читаются больше
 * чем в семи десятках мест; пока их не перевели, граница держится здесь.
 * Форма показывает это значение пустым полем (см. `NumField`).
 */
export const NO_AMOUNT_LIMIT = 1_000_000_000_000;

/** «Ограничения нет» для полей в днях: сто лет. Причина та же. */
export const NO_DAYS_LIMIT = 36_500;

/**
 * Пустой профиль компании: схема заполнена, содержания нет.
 *
 * Зачем он нужен отдельно от демонстрационного. Раньше основой для любого
 * сохранённого профиля служил пример — вымышленная «ТехноПоставка», торгующая
 * компьютерами. Поле, которого в сохранённой записи не оказалось, молча
 * бралось у неё, и это меняло выдачу: пользователь вписывал название и ИНН,
 * сохранял и продолжал получать закупки на ноутбуки и серверы.
 *
 * Дороже всего обходились стоп-слова. У примера в них стоит «строительство»,
 * и строительная компания отсеивала собственные закупки, ничего об этом не
 * зная: «не подходит» выглядит одинаково и когда закупка действительно чужая,
 * и когда её убрало чужое стоп-слово.
 *
 * Поэтому неполный профиль достраивается пустотой. Пустое поле честно значит
 * «пользователь не сказал», и подбор обязан обращаться с ним как с незаданным
 * — а не как с ответом другой компании.
 *
 * Пример никуда не делся: он лежит в `demoCompanyProfile` и подставляется,
 * когда его просят явно.
 */
export const emptyCompanyProfile: CompanyProfile = {
  organizationId: "org-local",
  legalName: "",
  inn: "",
  legalForm: "OOO",
  taxSystem: "OSNO",
  worksWithVat: true,
  activityDescription: "",
  capabilities: {
    products: [],
    works: [],
    services: [],
    brandsAndModels: [],
    keywords: [],
    synonyms: [],
    stopWords: [],
    okpd2Codes: [],
  },
  restrictions: {
    minPrice: 0,
    maxPrice: NO_AMOUNT_LIMIT,
    maxDistanceKm: null,
    maxPaymentTermDays: NO_DAYS_LIMIT,
    minDeliveryTermDays: 0,
    minMarginPercent: 0,
    maxBidSecurity: NO_AMOUNT_LIMIT,
    maxContractSecurity: NO_AMOUNT_LIMIT,
    /*
      Участие без аванса разрешено, пока не сказано обратное. Значение здесь
      не нейтрально ни в одну сторону, и выбрано менее вредное: запрет по
      умолчанию снял бы с выдачи большинство закупок, а пользователь не
      понял бы, куда они делись — он этого условия не ставил.
    */
    allowNoAdvance: true,
    workRegions: [],
    customerWhitelist: [],
    customerBlacklist: [],
    custom: [],
  },
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
  licenses: [],
  sroMemberships: [],
  hasPersonnel: false,
  hasEquipment: false,
  hasSpecialAccount: false,
  staff: {
    total: null,
    nrsCount: 0,
    noprizCount: 0,
  },
  experience: [],
  experienceTotals: {
    lastYearAmount: null,
    last3YearsAmount: null,
  },
  documents: [],
};

/**
 * Заполнен ли профиль настолько, чтобы подбор что-то значил.
 *
 * Подбор опирается на предмет закупки, а предмет узнаётся по ключевым словам,
 * товарам и кодам ОКПД2. Пока ни одного из них нет, любая оценка соответствия
 * — это оценка пустоты, и честнее сказать об этом прямо, чем показать список,
 * отсортированный неизвестно по чему.
 */
export function profileDescribesSubject(profile: CompanyProfile): boolean {
  const cap = profile.capabilities;
  return (
    cap.keywords.length > 0 ||
    cap.products.length > 0 ||
    cap.works.length > 0 ||
    cap.services.length > 0 ||
    cap.okpd2Codes.length > 0
  );
}
