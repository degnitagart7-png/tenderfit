/**
 * Разметка подбора норм по наименованию: «верный» значит, что первая найденная норма — та самая
 * таблица ГЭСН, которую выбрал бы сметчик (допустим другой вариант строки внутри таблицы).
 *
 * Собрана заново по живой базе: исходная разметка владельца (37 строк закупки 001 и типового ВОР
 * фасада) в репозитории не хранится. Метки — суждение при чтении найденной нормы; спорные случаи
 * помечены `doubtful`. Пересмотреть метки можно здесь же и перезапустить
 * `npx tsx scripts/fsnb/measure-review.ts`.
 */
export interface MarkupRow {
  readonly name: string;
  /** Первая найденная норма подходит под работу. */
  readonly correct: boolean;
  readonly doubtful?: boolean;
}

export const MARKUP: readonly MarkupRow[] = [
  { name: "Демонтаж наружных стен", correct: false },
  { name: "Кладка стен из кирпича", correct: false },
  { name: "Разборка кирпичных стен", correct: true },
  { name: "Монтаж металлоконструкций", correct: false },
  { name: "Монтаж металлических конструкций каркаса", correct: true, doubtful: true },
  { name: "Демонтаж кирпичной кладки", correct: false },
  { name: "Устройство кирпичной кладки наружных стен", correct: false },
  { name: "Устройство утепления фасада минераловатными плитами", correct: false, doubtful: true },
  { name: "Монтаж алюминиевых витражей", correct: true },
  { name: "Окраска фасада фасадной краской", correct: false },
  { name: "Штукатурка фасадов цементным раствором", correct: false },
  { name: "Монтаж навесных вентилируемых фасадов", correct: true },
  { name: "Демонтаж плитки облицовочной", correct: false },
  { name: "Разборка покрытий кровли из рулонных материалов", correct: true },
  { name: "Устройство кровли из профнастила", correct: false },
  { name: "Погрузка в автотранспортное средство: гравий", correct: false },
  { name: "Вывоз строительного мусора", correct: false },
  { name: "Снос здания", correct: false },
  { name: "Демонтаж оконных блоков", correct: true },
  { name: "Монтаж оконных блоков из ПВХ профилей", correct: false },
  { name: "Устройство бутовых фундаментов", correct: false },
  { name: "Кладка фундаментов из бутового камня", correct: false },
  { name: "Разборка фундаментов бутовых", correct: true },
  { name: "Монтаж ограждения из металлической сетки", correct: false },
  { name: "Установка дверных блоков", correct: true, doubtful: true },
  { name: "Демонтаж перегородок кирпичных", correct: true },
  { name: "Устройство стяжки цементной", correct: false },
  { name: "Разработка грунта экскаватором", correct: true },
  { name: "Засыпка траншей песком", correct: false },
  { name: "Облицовка стен керамической плиткой", correct: false },
  { name: "Демонтаж потолков подвесных", correct: false },
  { name: "Демонтаж кровли из металлочерепицы", correct: false },
  { name: "Монтаж трубопроводов из стальных труб", correct: false },
  { name: "Устройство полов из линолеума", correct: false },
  { name: "Устройство перегородок из гипсокартона", correct: false },
  { name: "Демонтаж кирпичной кладки стен", correct: false },
  { name: "Монтаж лестниц металлических", correct: true, doubtful: true },
  { name: "Устройство отмостки", correct: true, doubtful: true },
  { name: "Демонтаж радиаторов отопления", correct: true },
  { name: "Устройство гидроизоляции фундаментов", correct: true },
  { name: "Разборка деревянных конструкций крыши", correct: true },
  { name: "Покраска стен водоэмульсионной краской", correct: true },
  { name: "Монтаж электропроводки", correct: false },
  { name: "Демонтаж асфальтобетонного покрытия", correct: false },
  { name: "Устройство бетонной подготовки", correct: true },
];
