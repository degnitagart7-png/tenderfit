import { tokenizeForMatch } from "@/domain/estimate/normalize";

/**
 * Семейство материала по словам названия: подобранный материал нормы «по проекту» обязан быть из того же рода, что и ресурс нормы и работа.
 *
 * Зачем. На закупке 0391300028226000005 (кровля) у нормы на листы волнистые битумные группа кода «12.1.02.06» и у нормы на профилированный лист
 * свои группы, а материал дорогого покрытия оказался не на своей позиции: профилированный стальной лист попал под битумные листы. Слова «лист»,
 * «кровельный», «волнистый» у них общие, и поиск по словам не различает материалы. Проверка ниже ловит именно такой обмен.
 *
 * Правило, два шага; оба консервативные: отклоняется только явное несовпадение, а когда сказать нечего — выбор принимается.
 *
 * 1. Род. Слова названия относятся к родам (`FAMILIES`: битумные, металл, полимеры, минеральная вата, бетон и цемент, дерево, керамика, гипс) по корню.
 *    Род нужды берётся из названия ресурса нормы, а если оно рода не называет («Материалы кровельные», «Листы») — из названия работы. Если у нужды
 *    и у материала роды названы и не пересекаются (битумный лист ↔ стальной профилированный), выбор отклоняется; пересекаются — выбор принимается без
 *    шага 2 (разные слова одного рода: «профнастил» и «профилированный лист»). Названы роды не у обеих сторон — шаг ничего не решает.
 * 2. Ключевое слово (когда шаг 1 ничего не решил). У названия материала должно быть хотя бы одно ключевое слово, родственное ключевому слову названия ресурса нормы или работы.
 *    Ключевое слово — слово из букв, не короче четырёх, не из `GENERIC_ROOTS` (лист, материал, кровельный, устройство, размеры и т. п.: они общие для
 *    разных материалов и ничего не доказывают). Слова родственны, когда общая часть начала не короче четырёх знаков и покрывает три четверти более
 *    короткого слова: «битумные» ~ «битумный», «смол» ~ «смолы», но «профнастил» ≁ «профилированный» (это решает шаг 1). Нет ключевых слов у нужды
 *    или у материала — шаг ничего не решает.
 *
 * Модуль чистый.
 */

export type MaterialFamilyId = "BITUMEN" | "METAL" | "POLYMER" | "MINERAL_WOOL" | "CONCRETE" | "WOOD" | "CERAMIC" | "GYPSUM";

interface MaterialFamily {
  readonly id: MaterialFamilyId;
  readonly label: string;
  /** Корни слов: слово названия относится к роду, когда начинается с корня. */
  readonly roots: readonly string[];
}

const FAMILIES: readonly MaterialFamily[] = [
  {
    id: "BITUMEN",
    label: "битумные и наплавляемые",
    roots: ["битум", "ондулин", "рубероид", "пергамин", "гидроизол", "изопласт", "техноэласт", "бикрост", "стеклоизол", "филизол", "унифлекс"],
  },
  {
    id: "METAL",
    label: "металл",
    roots: ["металл", "стал", "оцинкован", "профнастил", "профилирован", "алюмин", "нержавеющ", "чугун", "медн", "цинк"],
  },
  {
    id: "POLYMER",
    label: "полимеры",
    roots: ["пвх", "поливинил", "полиэтилен", "полипропилен", "пластик", "пластмасс", "полимер", "полиуретан", "пенополиуретан", "эпоксид", "акрил", "полистирол", "пенополистирол", "пенопласт", "полиамид", "поликарбонат"],
  },
  { id: "MINERAL_WOOL", label: "минеральная вата", roots: ["минеральн", "минват", "стекловат", "базальт", "ват"] },
  { id: "CONCRETE", label: "бетон, цемент, асбестоцемент", roots: ["бетон", "железобетон", "цемент", "асбест", "шифер"] },
  { id: "WOOD", label: "дерево", roots: ["дерев", "древес", "пиломатериал", "доск", "фанер", "дсп", "осб"] },
  { id: "CERAMIC", label: "керамика и кирпич", roots: ["кирпич", "керамическ", "керамогранит"] },
  { id: "GYPSUM", label: "гипс", roots: ["гипс", "гкл"] },
];

/**
 * Корни слов, которые не называют материал: общие для разных материалов существительные и прилагательные, названия работ, область применения и
 * размеры. «Лист» у битумного листа и стального одинаков, «кровельный» — тоже; ключевым словом они быть не могут.
 */
const GENERIC_ROOTS: readonly string[] = [
  "лист",
  "материал",
  "издели",
  "конструкц",
  "элемент",
  "деталь",
  "детали",
  "смесь",
  "смеси",
  "состав",
  "покрыт",
  "слой",
  "слои",
  "систем",
  "комплект",
  "набор",
  "прочи",
  "разны",
  "различн",
  "основ",
  "применя",
  "готов",
  "обычн",
  "стандартн",
  "строительн",
  "общестроительн",
  "кровл",
  "кровел",
  "кровельн",
  "стен",
  "фасад",
  "перекрыт",
  "потол",
  "наружн",
  "внутренн",
  "поверхност",
  "площад",
  "устройств",
  "монтаж",
  "установк",
  "укладк",
  "демонтаж",
  "разборк",
  "ремонт",
  "замен",
  "толщин",
  "размер",
  "диаметр",
  "высот",
  "длин",
  "ширин",
  "масс",
  "класс",
  "марк",
  "тип",
  "вид",
  "гост",
  "проект",
];

/** Слова короче четырёх букв («пк», «лак») и слова с цифрами («с21», «м300») ключевыми не считаются: марки и размеры материал не называют. */
const MIN_KEY_LENGTH = 4;

/** Слова названия из букв без повторов, в нижнем регистре, без служебных слов. */
function wordsOf(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokenizeForMatch(text)) {
    if (!/^[a-zа-я]+$/u.test(token) || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

/** Ключевые слова названия: слова из букв, не короче четырёх, не общие. Порядок сохраняется. */
export function keyMaterialWords(text: string): string[] {
  return wordsOf(text).filter((word) => word.length >= MIN_KEY_LENGTH && !GENERIC_ROOTS.some((root) => word.startsWith(root)));
}

/** Общая часть начала двух слов, знаков. */
function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a[length] === b[length]) length += 1;
  return length;
}

/** Слова родственны: общая часть начала не короче четырёх знаков и покрывает три четверти более короткого слова. */
export function wordsRelated(a: string, b: string): boolean {
  const common = commonPrefixLength(a, b);
  return common >= MIN_KEY_LENGTH && common >= Math.min(a.length, b.length) * 0.75;
}

/** Роды, которым принадлежат слова названия. */
export function materialFamiliesOf(text: string): ReadonlySet<MaterialFamilyId> {
  const found = new Set<MaterialFamilyId>();
  for (const word of wordsOf(text)) {
    for (const family of FAMILIES) {
      if (family.roots.some((root) => word.startsWith(root))) found.add(family.id);
    }
  }
  return found;
}

const labelOf = (families: ReadonlySet<MaterialFamilyId>): string =>
  [...families].map((id) => FAMILIES.find((family) => family.id === id)?.label ?? id).join(", ");

export interface MaterialFamilyInput {
  /** Название подобранного материала справочника. */
  readonly materialName: string;
  /** Название ресурса нормы без марки. */
  readonly resourceName: string;
  readonly workName: string;
  /** Наименование нормы целиком: в проверку не входит, но в род нужды попадает, когда ни ресурс, ни работа его не называют. */
  readonly normName?: string;
}

export type MaterialFamilyVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Проверка рода и ключевого слова (см. описание модуля). Принимает, когда сказать нечего. */
export function checkMaterialFamily(input: MaterialFamilyInput): MaterialFamilyVerdict {
  const quote = input.materialName.length > 60 ? `${input.materialName.slice(0, 60)}…` : input.materialName;

  // Шаг 1: род. Нужда — по названию ресурса нормы, затем по названию работы, затем по названию нормы.
  const pickFamilies = materialFamiliesOf(input.materialName);
  if (pickFamilies.size > 0) {
    for (const source of [input.resourceName, input.workName, input.normName ?? ""]) {
      const need = materialFamiliesOf(source);
      if (need.size === 0) continue;
      if (![...pickFamilies].some((id) => need.has(id))) {
        return { ok: false, reason: `материал «${quote}» другого рода (${labelOf(pickFamilies)}), чем ресурс нормы и работа (${labelOf(need)})` };
      }
      // Род совпал: «профнастил» и «профилированный лист» — один материал под разными словами, шаг 2 их не развёл бы.
      return { ok: true };
    }
  }

  // Шаг 2: общее ключевое слово с названием ресурса нормы или работы.
  const pickWords = keyMaterialWords(input.materialName);
  const needWords = keyMaterialWords(`${input.resourceName} ${input.workName}`);
  if (pickWords.length > 0 && needWords.length > 0 && !pickWords.some((word) => needWords.some((other) => wordsRelated(word, other)))) {
    return { ok: false, reason: `в названии материала «${quote}» нет ключевого слова ни у ресурса нормы, ни у работы (${needWords.slice(0, 4).join(", ")})` };
  }
  return { ok: true };
}
