/**
 * Отбор по ключевым словам профиля для ЭТП ГПБ: по slug адреса и по названию.
 *
 * Зачем два отбора. Карта сайта отдаёт ~20 тысяч адресов на кусок, и каждая
 * карточка — отдельный запрос раз в секунду, поэтому читать «всё свежее» нельзя.
 * Единственное, что видно до запроса карточки, — адрес, а в нём slug: транслит
 * названия процедуры (`…/1289085-vypolnenie-rabot-po-remontu-lineynoy-chasti-…/`).
 * Ключевое слово профиля переводится в тот же транслит и ищется в slug — так
 * отсекается почти всё лишнее ДО обращения к площадке. После чтения карточки то же
 * слово проверяется ещё раз по настоящему русскому названию: транслит неоднозначен
 * (`ts` — это и «ц», и «тс»; `sh` — и «ш», и «сх»), поэтому совпадение в slug лишь
 * повод потратить запрос, а не доказательство, что слово есть в названии.
 *
 * Ограничение, о котором надо знать: у процедур вида `etp` площадка обрезает slug до 112
 * знаков (на живой выдаче два slug длиной ровно 112 оборваны на середине слова). Слово,
 * которое в названии стоит дальше, по slug не находится, и такая процедура не попадает
 * в кандидаты. Читать карточки «на всякий случай» нельзя — это запросы раз в секунду, —
 * поэтому потеря принята осознанно: ключевые слова профилей («ремонт», «строительство»)
 * стоят в начале названия.
 *
 * Правило совпадения у обоих отборов одно и то же и повторяет ленту
 * (`stemRu` из `textSearch.ts`): слово приводится к основе без окончания и ищется как
 * подстрока. Ключевое слово из нескольких слов («капитальный ремонт») — группа:
 * совпасть обязаны все её слова, но не подряд («капитального и текущего ремонта»
 * тоже подходит). Слов в профиле несколько — достаточно любой группы.
 */
import { stemRu } from "@/domain/textSearch";

/**
 * Схема транслитерации площадки.
 *
 * Снята с живой карты сайта и карточек 19.10.2026 (52 пары «название — slug», 51 из них
 * воспроизводятся этой схемой байт в байт): ж→zh, х→h, ц→ts, ч→ch, ш→sh, щ→sch, ю→yu,
 * я→ya, й→y, ы→y, ъ отбрасывается, ё и э → e. Примеры оттуда же: «магистральных» →
 * `magistralnyh`, «жилищник» → `zhilischnik`, «регулирующей» → `reguliruyuschey`,
 * «объекте» → `obekte`, «центрэнергогаз» → `tsentrenergogaz`.
 *
 * Единственное исключение из посимвольности — мягкий знак перед «е»: «Заполярье» →
 * `zapolyarie`, «устьевых» → `ustievyh` (площадка пишет «ие», а не «е»). Перед другими
 * гласными («ьи», «ью», «ья») написание не замерено, и схема их отбрасывает по обычному
 * правилу; отбор по slug при этом перебирает варианты (см. `etpgpbSlugVariants`), чтобы
 * незамеренный случай не стоил закупки. В остальном схема посимвольная, поэтому
 * транслит основы слова — начало транслита любой его формы.
 */
const TRANSLIT: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const SOFT_SIGN_VOWELS = "еёюяи";

/** Как читать мягкий знак перед гласной: по схеме площадки, всегда «i» или никогда. */
type SoftSignMode = "site" | "always" | "never";

function translit(text: string, soft: SoftSignMode): string {
  const lower = text.toLowerCase();
  let out = "";
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower[i] ?? "";
    if (char === "ь") {
      const next = lower[i + 1] ?? "";
      const isI = soft === "always" ? SOFT_SIGN_VOWELS.includes(next) : soft === "site" && (next === "е" || next === "ё");
      if (isI) out += "i";
      continue;
    }
    const mapped = TRANSLIT[char];
    out += mapped === undefined ? char : mapped;
  }
  return out;
}

/** Транслит строки: нижний регистр, русские буквы по схеме площадки, остальное как есть. */
export function etpgpbTranslit(text: string): string {
  return translit(text, "site");
}

/**
 * Варианты транслита для поиска в slug. Совпадают с основным, пока в слове нет
 * мягкого знака перед гласной; иначе добавляются «всегда i» и «никогда i» — написание
 * «ьи», «ью», «ья» у площадки не замерено.
 */
export function etpgpbSlugVariants(text: string): string[] {
  return [...new Set([translit(text, "site"), translit(text, "always"), translit(text, "never")])];
}

/**
 * Slug названия так, как его строит площадка (сверено на 52 живых парах, воспроизводится
 * 51): транслит; кавычки «», " и ', знак № выбрасываются без следа; запятая между цифрами
 * тоже («8,0» → `80`); всё остальное, кроме латиницы и цифр, — дефис, повторы схлопнуты,
 * края обрезаны. Единственное расхождение — «с.Белокаменка» площадка склеивает в
 * `sbelokamenka`, а здесь точка даёт дефис.
 *
 * Для вида `etp` площадка обрезает slug до 112 знаков (два замеренных slug длиной ровно
 * 112 оборваны на середине слова), здесь обрезки нет: функция отвечает на вопрос «каким
 * был бы полный slug», а не «что лежит в адресе».
 */
export function etpgpbSlugify(title: string): string {
  return etpgpbTranslit(title)
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[«»"'№]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Одно ключевое слово профиля, разложенное на основы. */
export interface EtpgpbKeywordGroup {
  /** Основы русских слов: ищутся в названии. */
  readonly stems: readonly string[];
  /** Те же основы в транслите, по варианту написания на основу: ищутся в slug адреса. */
  readonly slugStems: readonly (readonly string[])[];
}

/** Слов такой длины и короче («и», «в», «на», «по») в группе не требуем: они не несут темы. */
const STOP_WORD_LENGTH = 2;

/** Нормализация для сравнения: регистр и «ё». */
function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/**
 * Группы по ключевым словам профиля. Пустой список слов — групп нет, и отбор
 * пропускает всё: обход без слов — осознанный режим (см. `fetchTenders`).
 */
export function buildEtpgpbKeywordGroups(
  keywords: readonly string[] | undefined,
): EtpgpbKeywordGroup[] {
  const groups: EtpgpbKeywordGroup[] = [];
  for (const keyword of keywords ?? []) {
    const words = normalize(keyword)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0);
    if (words.length === 0) continue;
    // Служебные слова отбрасываются, но не все: запрос «ИТ» из двух букв не должен
    // превратиться в пустую группу, которая подошла бы любому названию.
    const meaningful = words.filter((word) => word.length > STOP_WORD_LENGTH);
    const kept = meaningful.length > 0 ? meaningful : words;
    const stems = [...new Set(kept.map((word) => stemRu(word)))];
    groups.push({ stems, slugStems: stems.map((stem) => etpgpbSlugVariants(stem)) });
  }
  return groups;
}

/** Совпал ли slug адреса хотя бы с одной группой. Групп нет — совпал. */
export function etpgpbSlugMatches(slug: string, groups: readonly EtpgpbKeywordGroup[]): boolean {
  if (groups.length === 0) return true;
  const haystack = slug.toLowerCase();
  return groups.some((group) =>
    group.slugStems.every((variants) => variants.some((variant) => haystack.includes(variant))),
  );
}

/** Совпало ли настоящее название хотя бы с одной группой. Групп нет — совпало. */
export function etpgpbTitleMatches(title: string, groups: readonly EtpgpbKeywordGroup[]): boolean {
  if (groups.length === 0) return true;
  const haystack = normalize(title);
  return groups.some((group) => group.stems.every((stem) => haystack.includes(stem)));
}
