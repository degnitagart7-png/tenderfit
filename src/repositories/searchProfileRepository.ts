import type { SearchProfile } from "@/domain/entities";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

/**
 * Примеры профилей поиска. В ленту сами не попадают.
 *
 * Раньше репозиторий отдавал их как значение по умолчанию — все три с
 * `enabled: true`, — и лента применяла первый самостоятельно. Человек,
 * впервые открывший «Закупки», видел 1 закупку из 198: остальные убирал
 * чужой набор ключевых слов, регионов и цен, а чипы с условиями он читал как
 * своё прошлое действие, которого не было.
 *
 * Набор оставлен как образец для экрана «Что ищем»: показать, из чего вообще
 * состоит профиль, — не то же самое, что молча по нему фильтровать.
 */
export const searchProfileExamples: SearchProfile[] = [
  {
    id: "sp-computers",
    name: "Компьютеры и оргтехника (Москва)",
    laws: ["FZ_44", "FZ_223"],
    keywords: ["компьютер", "ноутбук", "принтер", "МФУ", "сервер"],
    stopWords: ["аренда", "ремонт помещений"],
    okpd2Codes: ["26.20", "28.23"],
    regions: ["Москва", "Московская область"],
    customerInns: [],
    minPrice: 30_000,
    maxPrice: 5_000_000,
    onlyOpenForSubmission: true,
    enabled: true,
  },
  {
    id: "sp-construction",
    name: "Строительство и ремонт (Москва и МО)",
    laws: ["FZ_44", "FZ_223"],
    keywords: [
      "строительств",
      "капитальный ремонт",
      "реконструкция",
      "монтаж",
      "отделоч",
      "инженерных систем",
      "дорог",
      "водопровод",
    ],
    stopWords: ["поставка компьютеров", "оргтехника"],
    okpd2Codes: ["41.20", "42.11", "42.21", "43.11", "43.21", "43.30", "43.99"],
    regions: ["Москва", "Московская область"],
    customerInns: [],
    minPrice: 30_000_000,
    maxPrice: 200_000_000,
    onlyOpenForSubmission: true,
    enabled: true,
  },
  {
    id: "sp-rzd",
    name: "РЖД — закупки конкретного заказчика (223-ФЗ)",
    laws: ["FZ_223"],
    keywords: [],
    stopWords: [],
    okpd2Codes: [],
    regions: [],
    // ИНН ОАО «РЖД» — открытый реквизит из карточки организации в ЕИС.
    customerInns: ["7708503727"],
    minPrice: null,
    maxPrice: null,
    onlyOpenForSubmission: true,
    enabled: true,
  },
];

/**
 * Профили, сохранённые до появления поля customerInns, дополняются пустым
 * списком — иначе доменная логика упадёт на обращении к undefined.
 */
function withDefaults(profiles: SearchProfile[]): SearchProfile[] {
  return profiles.map((p) => ({ ...p, customerInns: p.customerInns ?? [] }));
}

/** Репозиторий профилей поиска (localStorage). */
export const searchProfileRepository = {
  /** Профили человека. Пока он ни одного не создал — пусто, и лента не фильтруется. */
  getAll(): SearchProfile[] {
    const stored = readJSON<SearchProfile[] | null>(STORAGE_KEYS.searchProfiles, null);
    return stored ? withDefaults(stored) : [];
  },
  save(profiles: SearchProfile[]): void {
    writeJSON(STORAGE_KEYS.searchProfiles, profiles);
  },
  upsert(profile: SearchProfile): void {
    const all = this.getAll();
    const idx = all.findIndex((p) => p.id === profile.id);
    if (idx >= 0) all[idx] = profile;
    else all.push(profile);
    this.save(all);
  },
  remove(id: string): void {
    this.save(this.getAll().filter((p) => p.id !== id));
  },
};
