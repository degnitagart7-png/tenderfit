/**
 * Скруббер персональных данных: чистит текст документов компании ДО того, как он уйдёт в языковую модель.
 *
 * Почему он нужен. Модель работает через зарубежного провайдера, а данные клиента по 152-ФЗ должны оставаться в России
 * (решение владельца 21.10.2026). В модель уходят только деловые факты компании — виды работ, суммы контрактов, СРО,
 * лицензии, цены. Резюме сотрудников, удостоверения, реестры контрактов и акты несут ещё и сведения о людях: ФИО,
 * телефоны, почту, паспорт, СНИЛС, дату рождения, домашний адрес. Всё это здесь заменяется метками «[ФИО]», «[телефон]»
 * и так далее; название компании, ИНН и ОГРН юрлица (публичные) остаются.
 *
 * Принцип: лучше скрыть лишнее, чем пропустить личное. Но деловой текст ломать нельзя, поэтому каждое правило узкое:
 *  - ФИО — не «любые два слова с большой буквы», а три опоры: отчество («Иванович», «Петровна» и их падежи), инициалы
 *    («Иванов И. И.», «И. И. Иванов») и пара «имя из списка + фамилия по окончанию»; плюс фамилия после должности
 *    («директор Петров»). Названия организаций в кавычках после «ООО», «АО» и т. п. не трогаются, как и улицы, школы
 *    и музеи «имени» кого-то, «Приложение А.» и тому подобное;
 *  - ИНН: десятизначный (юрлицо) остаётся всегда, двенадцатизначный — только если это ИНН самой компании из профиля
 *    (у ИП название и есть ФИО, и оно публично); чужой двенадцатизначный ИНН — личный идентификатор и скрывается;
 *  - адрес скрывается только когда назван личным («зарегистрирован по адресу», «проживает», «место жительства»):
 *    юридический адрес организации — публичный факт;
 *  - дата скрывается только как дата рождения («родился», «д. р.», «1980 г. р.»): даты договоров остаются.
 *
 * Чистая функция: без обращений к сети и часам, один и тот же текст даёт один и тот же результат. Повторный прогон по
 * уже очищенному тексту ничего не меняет (метки правилами не распознаются) — на этом строится защита «в глубину»:
 * браузер чистит текст для предпросмотра, сервер чистит ещё раз перед отправкой в модель.
 *
 * Чего скруббер НЕ умеет и не обещает: имена латиницей, ФИО без отчества и инициалов вне списка частых имён,
 * адреса без метки, «человек по описанию». Поэтому пользователь видит весь очищенный текст до отправки.
 */

export const SCRUB_CATEGORIES = ["fio", "phone", "email", "passport", "snils", "personalInn", "birthDate", "address"] as const;
export type ScrubCategory = (typeof SCRUB_CATEGORIES)[number];

export type ScrubStats = Record<ScrubCategory, number>;

export interface ScrubOptions {
  /** ИНН самой компании (профиль): остаётся в тексте, даже если он двенадцатизначный (ИП). */
  companyInn?: string;
  /** Строки, которые не трогать: название компании (у ИП — её ФИО), если оно известно из профиля. */
  keep?: readonly string[];
}

export interface ScrubResult {
  text: string;
  stats: ScrubStats;
  /** Сколько мест скрыто всего. */
  total: number;
}

/** Метки, на которые заменяется личное. Тексты метки не должны совпадать ни с одним правилом ниже. */
export const SCRUB_MASKS: Record<ScrubCategory, string> = {
  fio: "[ФИО]",
  phone: "[телефон]",
  email: "[email]",
  passport: "[паспорт]",
  snils: "[СНИЛС]",
  personalInn: "[ИНН физлица]",
  birthDate: "[дата рождения]",
  address: "[адрес]",
};

/** Подписи категорий для показа человеку: «ФИО: 12». */
export const SCRUB_LABELS: Record<ScrubCategory, string> = {
  fio: "ФИО",
  phone: "телефонов",
  email: "адресов почты",
  passport: "паспортных данных",
  snils: "СНИЛС",
  personalInn: "ИНН физлиц",
  birthDate: "дат рождения",
  address: "личных адресов",
};

export function emptyScrubStats(): ScrubStats {
  return { fio: 0, phone: 0, email: 0, passport: 0, snils: 0, personalInn: 0, birthDate: 0, address: 0 };
}

export function addScrubStats(a: ScrubStats, b: ScrubStats): ScrubStats {
  const out = emptyScrubStats();
  for (const key of SCRUB_CATEGORIES) out[key] = (a[key] ?? 0) + (b[key] ?? 0);
  return out;
}

export function totalScrubStats(stats: ScrubStats): number {
  return SCRUB_CATEGORIES.reduce((sum, key) => sum + (stats[key] ?? 0), 0);
}

/** «ФИО: 12, телефонов: 3»; пусто — скрывать было нечего. */
export function formatScrubStats(stats: ScrubStats): string {
  return SCRUB_CATEGORIES.filter((key) => (stats[key] ?? 0) > 0)
    .map((key) => `${SCRUB_LABELS[key]}: ${String(stats[key])}`)
    .join(", ");
}

/* ------------------------------- Защищённые места ------------------------------- */

const PLACEHOLDER_OPEN = "";
const PLACEHOLDER_CLOSE = "";

/*
  Организационно-правовая форма перед кавычками: название в кавычках — имя юрлица, а не человека.
  «ООО «Иван Иванович и сыновья»» — редкость, но скрыть название компании хуже, чем оставить такое имя.
*/
const LEGAL_FORM =
  "(?:общество\\s+с\\s+ограниченной\\s+ответственностью|публичное\\s+акционерное\\s+общество|акционерное\\s+общество|закрытое\\s+акционерное\\s+общество|открытое\\s+акционерное\\s+общество|ООО|ПАО|ЗАО|ОАО|НАО|АО|НКО|АНО|МУП|ГУП|ФГУП|МБУ|МКУ|МАУ|ГБУ|ГКУ|ФГБУ|ФКУ|ГБОУ|МБОУ|МБДОУ|ТСЖ|ГСК|СНТ|ПК|КФХ|ТОО|ЧОУ|ЧУП|ИП\\s+КФХ|компания|фирма|завод|фабрика|комбинат|предприятие|организация|учреждение)";
const QUOTED_NAME = new RegExp(`${LEGAL_FORM}\\s*[«"“„][^»"”\\n]{1,120}[»"”]`, "giu");

interface Protected {
  text: string;
  restore: (value: string) => string;
}

/** Прячет места, которые нельзя трогать, за метками; `restore` возвращает их на место. */
function protect(text: string, keep: readonly string[]): Protected {
  const saved: string[] = [];
  const stash = (piece: string): string => {
    saved.push(piece);
    return `${PLACEHOLDER_OPEN}${String(saved.length - 1)}${PLACEHOLDER_CLOSE}`;
  };
  let out = text.replace(QUOTED_NAME, (match) => stash(match));
  // Длинные строки раньше коротких: «ИП Иванов Иван Иванович» — раньше, чем «Иванов Иван».
  const sorted = [...keep].map((k) => k.trim()).filter((k) => k.length >= 3).sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(escaped, "giu"), (match) => stash(match));
  }
  const restore = (value: string): string =>
    value.replace(new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, "gu"), (_all, index: string) => saved[Number(index)] ?? "");
  return { text: out, restore };
}

/* ------------------------------- Простые шаблоны ------------------------------- */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;

/* Паспорт: «паспорт 52 15 123456», «паспорт серия 5215 № 123456, выдан … 12.05.2015 г.», «код подразделения 550-001». */
const PASSPORT_FULL_RE =
  /паспорт[а-яё]*[^\d\n]{0,40}\d{2}\s?\d{2}[\s,№N#-]*(?:номер\s*)?\d{6}(?:[,;]?\s*выдан[а-я]*\s+[^\n]{5,120}?\d{2}\.\d{2}\.\d{4}(?:\s*г(?:ода|\.)?)?)?(?:[,;]?\s*код\s+подразделения\s*\d{3}-\d{3})?/giu;
const PASSPORT_SERIES_RE = /(?<![А-Яа-яЁё\d])сери[яи]\s+\d{2}\s?\d{2}\s*(?:№|N|номер)\s*\d{6}/giu;
const PASSPORT_CODE_RE = /код\s+подразделения\s*:?\s*\d{3}-\d{3}/giu;

/* СНИЛС: 123-456-789 01 (и без разделителей, но с меткой). */
const SNILS_RE = /(?<!\d)\d{3}-\d{3}-\d{3}[ -]\d{2}(?!\d)/gu;
const SNILS_LABELLED_RE = /(СНИЛС[\s:№-]*)\d{11}(?!\d)/giu;

/* ИНН двенадцатизначный с меткой. Десятизначный (юрлицо) не трогается. */
const INN12_RE = /(ИНН[\s:№=а-яё]{0,30}?)(\d{12})(?!\d)/giu;

/* Телефоны. */
const PHONE_RE =
  /(?<![\d,])(?:\+7|8|7)[\s\-–(]*\d{3}[\s\-–)]*\d{3}[\s\-–]*\d{2}[\s\-–]*\d{2}(?!\d)/gu;
const PHONE_AREA_RE = /(?<![\d,])\(\d{3,5}\)\s*\d{2,3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/gu;
const PHONE_LABELLED_RE =
  /((?:тел(?:ефон)?|факс|моб(?:ильный)?|сотовый|контактный\s+телефон)\.?[\s:№-]*)(?:\+?\d[\d\s()–-]{4,18}\d)/giu;

/* Дата рождения. */
const MONTHS = "(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)";
const DATE_ANY = `(?:\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}|\\d{1,2}\\s+${MONTHS}\\s+\\d{4}(?:\\s*г(?:ода|\\.)?)?|\\d{4}(?:\\s*г(?:ода|\\.)?)?)`;
const BIRTH_LABELLED_RE = new RegExp(
  `((?:дата\\s+рождения|год\\s+рождения|родил(?:ся|ась)|д\\.\\s?р\\.?)[\\s:,—-]*)${DATE_ANY}`,
  "giu",
);
const BIRTH_SUFFIX_RE = /(?<![\d.])(?:\d{1,2}[./]\d{1,2}[./])?\d{4}\s*(?:г\.\s?р\.?|года\s+рождения|г\.\s*рождения)(?![а-яё])/giu;

/* Личный адрес: от метки до конца строки (не дальше 160 знаков) или до слов, которыми кончается сведение о человеке. */
const ADDRESS_LABELLED_RE =
  /((?:зарегистрирован(?:а|ный|ная)?\s+по\s+адресу|проживающ(?:ий|ая|его|ей)\s+по\s+адресу|проживает\s+по\s+адресу|адрес\s+(?:регистрации|места\s+жительства|проживания|прописки)|место\s+жительства|место\s+регистрации|прописан(?:а)?\s+по\s+адресу)[\s:—-]*)([^\n;]{3,160})/giu;
const ADDRESS_STOP_RE = /,?\s*\[?(?:именуем|далее|паспорт|ИНН|СНИЛС|тел|e-?mail|email|дата\s+рождения)/iu;

/* Хвост паспортных сведений: «выдан УМВД России по Омской области 12.05.2015». */
const PASSPORT_TAIL_RE = /(\[паспорт\])[,;]?\s*(выдан[а-я]*\s+[^\n;]{3,140})/giu;

/** Сокращения в адресах: точка после них не конец предложения. */
const ADDRESS_ABBREVIATIONS = new Set(
  ["г", "ул", "д", "кв", "пр", "пер", "корп", "стр", "оф", "им", "обл", "р-н", "мкр", "пос", "с", "ш", "наб", "пл", "пом", "лит", "тер", "дер", "ст", "п", "рп", "пгт"],
);

/** Индекс конца предложения в `text` (точка и пробел перед заглавной, не после сокращения адреса); нет — длина текста. */
function sentenceEnd(text: string): number {
  for (const match of text.matchAll(/\.\s+(?=[А-ЯЁ[])/gu)) {
    const index = match.index ?? 0;
    const word = /([А-Яа-яЁё-]+)$/u.exec(text.slice(0, index))?.[1]?.toLowerCase() ?? "";
    if (!ADDRESS_ABBREVIATIONS.has(word)) return index;
  }
  return text.length;
}

/* ------------------------------- Имена ------------------------------- */

/** Самые частые русские имена в именительном падеже; падежи достраиваются. */
const GIVEN_NAMES = [
  "Александр", "Алексей", "Анатолий", "Андрей", "Антон", "Аркадий", "Артём", "Артем", "Артур", "Борис", "Вадим", "Валентин",
  "Валерий", "Василий", "Виктор", "Виталий", "Владимир", "Владислав", "Вячеслав", "Геннадий", "Георгий", "Григорий", "Даниил",
  "Денис", "Дмитрий", "Евгений", "Егор", "Иван", "Игорь", "Илья", "Кирилл", "Константин", "Леонид", "Максим", "Михаил", "Никита",
  "Николай", "Олег", "Павел", "Пётр", "Петр", "Роман", "Руслан", "Сергей", "Станислав", "Степан", "Тимофей", "Фёдор", "Федор",
  "Юрий", "Ярослав", "Марат", "Рустам", "Ильдар", "Рамиль", "Азат", "Тимур", "Эдуард", "Назар", "Данил", "Глеб", "Матвей",
  "Анна", "Алина", "Алла", "Анастасия", "Валентина", "Валерия", "Вера", "Виктория", "Галина", "Дарья", "Евгения", "Екатерина",
  "Елена", "Елизавета", "Жанна", "Зоя", "Инна", "Ирина", "Кристина", "Ксения", "Лариса", "Лидия", "Любовь", "Людмила", "Маргарита",
  "Марина", "Мария", "Надежда", "Наталья", "Наталия", "Нина", "Оксана", "Ольга", "Полина", "Раиса", "Светлана", "София", "Софья",
  "Тамара", "Татьяна", "Ульяна", "Юлия", "Яна", "Алёна", "Алена", "Диана", "Эльвира", "Гульнара", "Айгуль", "Лилия", "Регина",
];

function nameForms(name: string): string[] {
  const lower = name.toLowerCase();
  if (lower.endsWith("ия")) {
    const stem = lower.slice(0, -2);
    return [lower, `${stem}ии`, `${stem}ию`, `${stem}ией`];
  }
  if (lower.endsWith("я")) {
    const stem = lower.slice(0, -1);
    return [lower, `${stem}и`, `${stem}е`, `${stem}ю`, `${stem}ей`, `${stem}ею`];
  }
  if (lower.endsWith("а")) {
    const stem = lower.slice(0, -1);
    return [lower, `${stem}ы`, `${stem}и`, `${stem}е`, `${stem}у`, `${stem}ой`, `${stem}ою`];
  }
  if (lower.endsWith("й") || lower.endsWith("ь")) {
    const stem = lower.slice(0, -1);
    return [lower, `${stem}я`, `${stem}ю`, `${stem}ем`, `${stem}е`, `${stem}ём`];
  }
  return [lower, `${lower}а`, `${lower}у`, `${lower}ом`, `${lower}е`];
}

const GIVEN_FORMS = new Set<string>(GIVEN_NAMES.flatMap(nameForms));

function isGivenName(word: string): boolean {
  return GIVEN_FORMS.has(word.toLowerCase());
}

/** Отчество: «Иванович», «Ивановича», «Петровна», «Ильинична» и т. д. */
const PATRONYMIC_RE = /^[А-ЯЁа-яё]{2,}(?:[ое]вич|ьич)(?:а|у|ем|е)?$|^[А-ЯЁа-яё]{2,}(?:[ое]вн|иничн|ьичн|[тл]ичн)(?:а|ы|е|у|ой|ою)$/iu;

function isPatronymic(word: string): boolean {
  return word.length >= 6 && PATRONYMIC_RE.test(word) && !/[а-яё][А-ЯЁ]/u.test(word);
}

/** Окончания фамилий: Иванов(а), Петрова, Сидоренко, Ковальчук, Мартиросян, Толстой, Ленинский… */
const SURNAME_RE =
  /^(?:[А-ЯЁ][а-яё]+|[А-ЯЁ]{3,})(?:(?:ов|ев|ёв|ин|ын)(?:а|у|ым|ом|е|ой|ых)?|(?:ск|цк)(?:ий|ая|ого|ому|им|ой|ую)|(?:енко|ко|чук|ук|юк|ян|дзе|швили|ских|цких)|ов|ев)$/u;

function isSurnameLike(word: string): boolean {
  // Двойная фамилия («Иванов-Петров») — фамилия, если ею выглядит хотя бы одна часть.
  return word.split("-").some((part) => {
    const upper = part === part.toUpperCase();
    const test = upper ? part.charAt(0) + part.slice(1).toLowerCase() : part;
    return test.length >= 4 && SURNAME_RE.test(test);
  });
}

/** Слова с большой буквы, которые не бывают фамилией, хотя стоят рядом с инициалами или именем. */
const NOT_SURNAME = new Set(
  [
    "приложение", "раздел", "таблица", "форма", "лист", "литера", "корпус", "строение", "пункт", "статья", "часть", "глава",
    "рисунок", "схема", "этап", "график", "акт", "договор", "контракт", "лот", "тип", "вид", "марка", "класс", "группа",
    "генеральный", "главный", "уважаемый", "уважаемая", "гражданин", "гражданка", "господин", "госпожа", "директор", "инженер",
    "ооо", "пао", "зао", "оао", "ип", "россия", "российской", "федерации", "область", "улица", "проспект", "переулок",
    "ленинский", "московский", "советский", "центральный", "промышленный", "заказчик", "подрядчик", "исполнитель", "заместитель",
  ],
);

/** Слово перед именем, которое по окончанию — глагол, прилагательное или существительное, а не фамилия: «Подписал», «Утверждено». */
const COMMON_WORD_ENDING_RE = /(?:л|ла|ли|ло|но|ны|ет|ит|ют|ат|ят|ся|ть|ий|ый|ой|ая|ое|ие|ые|ого|ему|ами|ях|ние|ство|ция)$/iu;

/** Должности: после них фамилия без инициалов скрывается. Первая буква — любого регистра («Ответственный — Орлов» в начале строки). */
const ROLE_WORDS = [
  "в\\s+лице", "директор[а-яё]*", "руководител[а-яё]*", "начальник[а-яё]*", "инженер[а-яё]*", "прораб[а-яё]*", "бухгалтер[а-яё]*",
  "представител[а-яё]*", "уполномоченн[а-яё]*", "менеджер[а-яё]*", "подписант[а-яё]*", "контактное\\s+лицо", "ответственн[а-яё]*",
  "мастер[а-яё]*", "геодезист[а-яё]*", "сметчик[а-яё]*",
];
const ROLE_SURNAME_RE = new RegExp(
  `(?<![А-Яа-яЁё])(?:${ROLE_WORDS.map((word) => `[${(word[0] ?? "").toUpperCase()}${word[0] ?? ""}]${word.slice(1)}`).join("|")})(?:\\s+[а-яё]+){0,3}?[\\s:—–-]+([А-ЯЁ][а-яё]+(?:ов|ев|ёв|ин|ын)(?:а|у|ым|ом|е|ой|ых)?)(?![А-Яа-яЁё])`,
  "gu",
);

/** Перед этими словами «фамилия» — это название улицы, школы, музея и т. п., а не человек. */
const STREET_CONTEXT_RE =
  /(?<![А-Яа-яЁё])(?:ул(?:ица|\.)?|пр(?:оспект|-кт|\.)?|пер(?:еулок|\.)?|наб(?:ережная|\.)?|б-р|бульвар|площадь|пл\.|шоссе|ш\.|проезд|пр-д|микрорайон|мкр\.?|парк|сквер|аллея|школа|гимназия|лицей|колледж|университет|институт|музей|театр|им(?:ени|\.)?|памятник|мост|станция|завод)\s*$/iu;

function streetContext(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 24), index);
  return STREET_CONTEXT_RE.test(before);
}

interface Token {
  kind: "word" | "initial";
  text: string;
  start: number;
  end: number;
}

const TOKEN_RE =
  /(?<![А-Яа-яЁёA-Za-z0-9])(?:([А-ЯЁ]\.)|((?:[А-ЯЁ][а-яё]+|[А-ЯЁ]{2,})(?:-(?:[А-ЯЁ][а-яё]+|[А-ЯЁ]{2,}))?)(?![А-Яа-яЁёA-Za-z]))/gu;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    if (match[1] !== undefined) tokens.push({ kind: "initial", text: match[1], start: index, end: index + match[1].length });
    else if (match[2] !== undefined) tokens.push({ kind: "word", text: match[2], start: index, end: index + match[2].length });
  }
  return tokens;
}

/** Серии токенов, между которыми только пробелы: имя пишется «в строку». */
function runsOf(text: string, tokens: Token[]): Token[][] {
  const runs: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    const previous = current[current.length - 1];
    if (previous !== undefined && /^[  \t]*$/u.test(text.slice(previous.end, token.start))) {
      current.push(token);
    } else {
      if (current.length > 0) runs.push(current);
      current = [token];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

type Span = [number, number];

function notSurname(word: string): boolean {
  const lower = word.toLowerCase();
  if (NOT_SURNAME.has(lower)) return true;
  // Аббревиатура капсом короче четырёх знаков — не фамилия.
  return word === word.toUpperCase() && word.length < 4;
}

/** Места ФИО в тексте: [начало, конец) для каждого найденного имени. */
function findFioSpans(text: string): Span[] {
  const spans: Span[] = [];
  const runs = runsOf(text, tokenize(text));

  for (const run of runs) {
    // 1. Отчество — самая надёжная опора.
    run.forEach((token, k) => {
      if (token.kind !== "word" || !isPatronymic(token.text)) return;
      const given = run[k - 1];
      if (given === undefined || given.kind !== "word") return;
      const before = run[k - 2];
      const after = run[k + 1];
      let start = given.start;
      let end = token.end;
      if (before !== undefined && before.kind === "word" && !notSurname(before.text) && isSurnameLike(before.text)) {
        // «Иванов Иван Иванович».
        start = before.start;
      } else if (after !== undefined && after.kind === "word" && isSurnameLike(after.text) && !notSurname(after.text)) {
        // «Иван Иванович Иванов».
        end = after.end;
      } else if (
        before !== undefined &&
        before.kind === "word" &&
        !notSurname(before.text) &&
        isGivenName(given.text) &&
        !COMMON_WORD_ENDING_RE.test(before.text)
      ) {
        // Фамилия без типичного окончания («Мельник Иван Иванович»); глаголы и прилагательные в начале фразы отсеиваются.
        start = before.start;
      }
      spans.push([start, end]);
    });

    // 2. Инициалы: «Иванов И. И.», «И. И. Иванов», «Иванов И.».
    let k = 0;
    while (k < run.length) {
      const token = run[k];
      if (token === undefined || token.kind !== "initial") {
        k += 1;
        continue;
      }
      let last = k;
      while (run[last + 1]?.kind === "initial") last += 1;
      const initials = last - k + 1;
      const first = run[k] as Token;
      const final = run[last] as Token;
      const prev = run[k - 1];
      const next = run[last + 1];
      const acceptable = (word: Token | undefined): word is Token =>
        word !== undefined &&
        word.kind === "word" &&
        !notSurname(word.text) &&
        (initials >= 2 || isSurnameLike(word.text)) &&
        !streetContext(text, word.start);
      if (initials <= 2) {
        if (acceptable(prev) && !(prev.text === prev.text.toUpperCase() && prev.text.length < 5)) spans.push([prev.start, final.end]);
        else if (acceptable(next) && !streetContext(text, first.start)) spans.push([first.start, next.end]);
      }
      k = last + 1;
    }

    // 3. «Имя Фамилия» без отчества: имя из списка и фамилия по окончанию.
    for (let index = 0; index + 1 < run.length; index += 1) {
      const a = run[index] as Token;
      const b = run[index + 1] as Token;
      if (a.kind !== "word" || b.kind !== "word") continue;
      if (streetContext(text, a.start)) continue;
      if (isGivenName(a.text) && isSurnameLike(b.text) && !notSurname(b.text) && !isGivenName(b.text)) spans.push([a.start, b.end]);
      else if (isGivenName(b.text) && isSurnameLike(a.text) && !notSurname(a.text) && !isGivenName(a.text)) spans.push([a.start, b.end]);
    }
  }

  // 4. Фамилия после должности.
  for (const match of text.matchAll(ROLE_SURNAME_RE)) {
    const surname = match[1];
    if (surname === undefined || notSurname(surname)) continue;
    const end = (match.index ?? 0) + match[0].length;
    spans.push([end - surname.length, end]);
  }
  return spans;
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

function maskFio(text: string): { text: string; count: number } {
  const spans = mergeSpans(findFioSpans(text));
  if (spans.length === 0) return { text, count: 0 };
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    out += text.slice(cursor, start) + SCRUB_MASKS.fio;
    cursor = end;
  }
  out += text.slice(cursor);
  return { text: out, count: spans.length };
}

/* ------------------------------- Главная функция ------------------------------- */

/**
 * Заменяет совпадения и считает их. `replacement` получает совпадение и две первые группы (пустая строка, если группы нет)
 * и решает, что поставить; null — оставить как есть и не считать.
 */
function replaceCounting(
  text: string,
  pattern: RegExp,
  replacement: (match: string, group1: string, group2: string) => string | null,
): { text: string; count: number } {
  let count = 0;
  const out = text.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    const group1 = typeof args[1] === "string" ? args[1] : "";
    const group2 = typeof args[2] === "string" ? args[2] : "";
    const next = replacement(match, group1, group2);
    if (next === null) return match;
    count += 1;
    return next;
  });
  return { text: out, count };
}

export function scrubPii(input: string, options: ScrubOptions = {}): ScrubResult {
  const stats = emptyScrubStats();
  const companyInn = (options.companyInn ?? "").replace(/\D/g, "");
  const guarded = protect(input, options.keep ?? []);
  let text = guarded.text;

  const run = (category: ScrubCategory, pattern: RegExp, replacement: (match: string, group1: string, group2: string) => string | null): void => {
    const result = replaceCounting(text, pattern, replacement);
    text = result.text;
    stats[category] += result.count;
  };
  const mask = (category: ScrubCategory) => (): string => SCRUB_MASKS[category];
  /** Метка остаётся, скрывается только хвост: «паспорт» не должен пропасть, пропадает номер. */
  const keepLabel = (category: ScrubCategory) => (_match: string, label: string): string => `${label}${SCRUB_MASKS[category]}`;

  run("email", EMAIL_RE, mask("email"));

  // Паспорт раньше телефонов и СНИЛС: у его номера и телефона общие цифры.
  run("passport", PASSPORT_FULL_RE, mask("passport"));
  run("passport", PASSPORT_SERIES_RE, mask("passport"));
  run("passport", PASSPORT_CODE_RE, mask("passport"));
  // Кем и когда выдан, если номер и орган стоят в другом порядке, чем ждёт первое правило: хвост уходит в ту же метку.
  text = text.replace(PASSPORT_TAIL_RE, (_all, label: string, tail: string) => `${label}${tail.slice(sentenceEnd(tail))}`);

  run("snils", SNILS_LABELLED_RE, keepLabel("snils"));
  run("snils", SNILS_RE, mask("snils"));

  run("personalInn", INN12_RE, (_match, label, digits) => (digits === companyInn ? null : `${label}${SCRUB_MASKS.personalInn}`));

  run("birthDate", BIRTH_LABELLED_RE, keepLabel("birthDate"));
  run("birthDate", BIRTH_SUFFIX_RE, mask("birthDate"));

  run("address", ADDRESS_LABELLED_RE, (_match, label, rest) => {
    const sentence = sentenceEnd(rest);
    const stop = rest.slice(0, sentence).search(ADDRESS_STOP_RE);
    const cut = stop >= 0 ? stop : sentence;
    // Уже скрыто (повторный прогон) или после метки сразу идёт другое сведение — нечего скрывать.
    return cut === 0 || rest.startsWith(SCRUB_MASKS.address) ? null : `${label}${SCRUB_MASKS.address}${rest.slice(cut)}`;
  });

  run("phone", PHONE_LABELLED_RE, keepLabel("phone"));
  run("phone", PHONE_RE, mask("phone"));
  run("phone", PHONE_AREA_RE, mask("phone"));

  const fio = maskFio(text);
  text = fio.text;
  stats.fio += fio.count;

  return { text: guarded.restore(text), stats, total: totalScrubStats(stats) };
}
