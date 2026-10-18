import type {
  EvidenceSource,
  PipelineStatus,
  PlacingWay,
  ProcessingJobStatus,
  ProcessingJobType,
  RequirementKind,
  RiskSeverity,
  SpecialistRegistry,
  TenderDataSource,
  TenderLaw,
  TenderVerdict,
} from "@/domain/enums";
import type { ContractRiskCategory, ManualReviewOutcome, RequirementGroupStatus } from "@/domain/entities";
import type { SortField } from "@/domain/filtering";
import type { FreshnessLayer } from "@/domain/lastSearch";
import type { SearchCriterion } from "@/domain/searchMatching";
import type { DeepAnalysisState } from "@/domain/deepAnalysis";
import type {
  AnalysisFinding,
  JobStatus,
  KonturRequestKind,
  ParsedStatus,
  SyncJobKind,
  SyncJobStatus,
} from "@/types/database";
import { URGENT_DEADLINE_DAYS } from "@/domain/scoring";
import { pluralRu } from "@/utils/format";

/**
 * Подписи вердиктов.
 *
 * Формулировки намеренно бытовые: «Требуется ручная проверка» и
 * «Не рекомендуется участвовать» — язык ведомственной справки, а пользователь
 * читает экран на ходу и должен понимать его без перевода. Значения перечисления
 * (RECOMMENDED / MANUAL_REVIEW / NOT_RECOMMENDED) при этом не меняются: на них
 * завязаны домен, база и тесты.
 */
export const verdictLabels: Record<TenderVerdict, string> = {
  RECOMMENDED: "Можно участвовать",
  MANUAL_REVIEW: "Нужно посмотреть",
  NOT_RECOMMENDED: "Не подходит",
};

/**
 * Короткие подписи вердикта — только для плотной таблицы закупок.
 *
 * «Нужно посмотреть» здесь дословно повторяло verdictLabels, то есть короткий
 * вариант не был коротким: пилюля требовала 151px при 88px доступных и во всех
 * строках обрезалась до «Нужно посм». А это самый частый вердикт в выдаче.
 * Полная формулировка осталась везде, где место есть, — в карточке закупки,
 * счётчиках дашборда и отчётах.
 */
export const verdictShort: Record<TenderVerdict, string> = {
  RECOMMENDED: "Подходит",
  MANUAL_REVIEW: "Проверить",
  NOT_RECOMMENDED: "Не подходит",
};

export const lawLabels: Record<TenderLaw, string> = {
  FZ_44: "44-ФЗ",
  FZ_223: "223-ФЗ",
  PP_RF_615: "ПП РФ 615",
  COMMERCIAL: "Коммерческие",
};

/** Короткое название источника для бейджа в таблице закупок. */
export const dataSourceLabels: Record<TenderDataSource, string> = {
  MOCK: "Демо",
  EIS: "ЕИС",
  IMPORT: "Импорт",
  SBER_AST: "Сбербанк-АСТ",
  KONTUR: "Контур",
  TEK_TORG: "ТЭК-Торг",
  ROSELTORG: "Росэлторг",
  FABRIKANT: "Фабрикант",
};

/** Подпись кнопки перехода к карточке закупки на площадке-источнике. */
export const dataSourceLinkLabels: Record<TenderDataSource, string> = {
  MOCK: "Открыть в ЕИС",
  EIS: "Открыть в ЕИС",
  IMPORT: "Открыть источник",
  SBER_AST: "Открыть в Сбербанк-АСТ",
  KONTUR: "Открыть в Контур.Закупках",
  TEK_TORG: "Открыть в ТЭК-Торге",
  ROSELTORG: "Открыть в Росэлторге",
  FABRIKANT: "Открыть на Фабриканте",
};

/** Тип запроса к платному API Контур.Закупок — для журнала расхода. */
export const konturRequestKindLabels: Record<KonturRequestKind, string> = {
  search: "Поиск",
  card: "Карточка закупки",
  testcard: "Тестовая карточка (бесплатно)",
  limits: "Остаток лимита (бесплатно)",
};

/** Группа суточного лимита тарифа Контур.Закупок. */
export const konturLimitGroupLabels: Record<string, string> = {
  search: "Поиск закупок",
  purchase: "Получение закупки",
  favorites: "Избранные закупки",
  results: "Результаты закупок",
};

/**
 * Что именно скрыл тариф ключа Контур.Закупок. Список показывается в журнале
 * синхронизации: без него пустой регион или пустой ИНН в закупке выглядит как
 * ошибка разбора, хотя источник просто не отдал значение. Боевой тариф отдаёт
 * эти поля целиком, поэтому непустой список — признак пониженного тарифа.
 *
 * Ключ — `KonturBlurredField` из парсера, но тип здесь не импортируется:
 * словарь намеренно `Record<string, string>`, как у групп лимита. Новое
 * закрашенное поле тогда показывается своим именем, а не ломает сборку.
 */
export const konturBlurredFieldLabels: Record<string, string> = {
  regNumber: "номер закупки",
  customerName: "наименование заказчика",
  customerInn: "ИНН заказчика",
  deliveryPlaces: "места поставки (регион)",
  okpd2: "коды ОКПД2",
  etpLink: "ссылка на ЭТП",
  eisLink: "ссылка на ЕИС",
  contactPerson: "контактное лицо",
  documentUrl: "ссылки на документы",
  applicationGuarantee: "обеспечение заявки",
  contractGuarantee: "обеспечение контракта",
  participants: "участники закупки",
};

/**
 * Почему запись Контур.Закупок не стала закупкой в нашей базе.
 *
 * «Отменена» и «Несостоявшаяся» — обычный исход поиска, а не поломка: такие
 * закупки не нужны ни в каком виде. Остальные причины значат, что ответ не
 * прочитан, и это уже повод смотреть сырые ответы.
 *
 * Ключ — `KonturSkipReason` из парсера; тип не импортируется по той же причине,
 * что и у списка закрашенных полей: `src/lib` ниже `src/adapters` по слоям.
 */
export const konturSkipReasonLabels: Record<string, string> = {
  "not-an-object": "ответ не объект",
  "no-number": "нет номера закупки",
  "no-deadline": "нет срока подачи заявок",
  cancelled: "отменена",
  abandoned: "несостоявшаяся",
};

/**
 * Причины из `konturSkipReasonLabels`, которые не требуют реакции оператора.
 * Отдельный набор, а не часть словаря подписей: панель и скрипт синхронизации
 * обязаны делить причины одинаково, иначе один говорит «отменена — норма»,
 * а другой предупреждает о поломке.
 */
export const konturExpectedSkipReasons: ReadonlySet<string> = new Set(["cancelled", "abandoned"]);

export const placingWayLabels: Record<PlacingWay, string> = {
  ELECTRONIC_AUCTION: "Электронный аукцион",
  OPEN_CONTEST: "Открытый конкурс",
  REQUEST_FOR_QUOTATION: "Запрос котировок",
  REQUEST_FOR_PROPOSALS: "Запрос предложений",
  SOLE_SUPPLIER: "Единственный поставщик",
  OTHER: "Иной способ",
};

export const pipelineLabels: Record<PipelineStatus, string> = {
  NEW: "Новые",
  INTERESTING: "Интересные",
  ANALYZING: "Анализируем",
  PREPARING_APPLICATION: "Готовим заявку",
  SUBMITTED: "Заявка подана",
  WON: "Выиграно",
  LOST: "Проиграно",
  SKIPPED: "Пропущено",
};

export const pipelineOrder: PipelineStatus[] = [
  "NEW",
  "INTERESTING",
  "ANALYZING",
  "PREPARING_APPLICATION",
  "SUBMITTED",
  "WON",
  "LOST",
  "SKIPPED",
];

export const riskSeverityLabels: Record<RiskSeverity, string> = {
  CRITICAL: "Критический",
  HIGH: "Высокий",
  MEDIUM: "Средний",
  LOW: "Низкий",
};

export const contractRiskCategoryLabels: Record<ContractRiskCategory, string> = {
  PENALTY: "Штрафы и неустойки",
  ACCEPTANCE: "Приёмка работ",
  UNILATERAL_REFUSAL: "Односторонний отказ",
  WARRANTY: "Гарантийные обязательства",
  TREASURY: "Казначейское сопровождение",
  PAYMENT_TERMS: "Условия оплаты",
  CASH_GAP: "Кассовый разрыв",
};

export const requirementKindLabels: Record<RequirementKind, string> = {
  LICENSE: "Лицензия",
  SRO: "Членство в СРО",
  EXPERIENCE: "Опыт исполнения",
  QUALIFIED_PERSONNEL: "Квалифицированный персонал",
  EQUIPMENT: "Оборудование/техника",
  FINANCIAL_STABILITY: "Финансовая устойчивость",
  NATIONAL_REGIME: "Национальный режим",
  RESTRICTION: "Ограничение для участников",
  PRODUCT_CHARACTERISTIC: "Характеристики товара",
  OTHER: "Иное требование",
};

export const evidenceSourceLabels: Record<EvidenceSource, string> = {
  TENDER_DOCUMENT: "Факт из документа",
  COMPANY_PROFILE: "Данные профиля",
  AI_CONCLUSION: "Вывод AI",
  SYSTEM_RULE: "Правило системы",
};

export const requirementStatusLabels: Record<RequirementGroupStatus, string> = {
  MATCH: "Соответствует",
  REVIEW: "Требуется проверка",
  MISMATCH: "Не соответствует",
};

/**
 * Подписи видов допуска СРО. Источник — src/domain/enums: тот же список
 * используют тексты выводов движка, поэтому отдельная копия здесь не нужна.
 */
export { SRO_KIND_LABELS as sroKindLabels } from "@/domain/enums";

/** Реестры специалистов: НРС строителей и НОПРИЗ проектировщиков/изыскателей. */
export const specialistRegistryLabels: Record<SpecialistRegistry, string> = {
  NRS: "НРС (НОСТРОЙ)",
  NOPRIZ: "НОПРИЗ",
};

export const manualReviewOutcomeLabels: Record<ManualReviewOutcome, string> = {
  CONFIRMED: "Подтверждено вручную",
  REJECTED: "Отклонено вручную",
  CLARIFICATION_REQUESTED: "Нужно запросить разъяснение",
};

export const jobTypeLabels: Record<ProcessingJobType, string> = {
  TENDER_IMPORT: "Импорт закупок",
  DOCUMENT_DOWNLOAD: "Загрузка документов",
  TEXT_EXTRACTION: "Извлечение текста",
  AI_ANALYSIS: "AI-анализ",
  REANALYSIS: "Повторный анализ",
  DIGEST_PREPARATION: "Подготовка отчёта",
};

export const jobStatusLabels: Record<ProcessingJobStatus, string> = {
  QUEUED: "В очереди",
  RUNNING: "Выполняется",
  SUCCEEDED: "Успешно",
  FAILED: "Ошибка",
};

/** Короткое состояние глубокого анализа для бейджа на карточке закупки. */
export const deepAnalysisStateLabels: Record<DeepAnalysisState, string> = {
  unsupported: "Недоступен",
  not_started: "Не запущен",
  queued: "В очереди",
  analyzing: "Разбирается",
  resuming: "Продолжается",
  completed: "Завершён",
  failed: "Ошибка",
};

/** Статусы задачи глубокого анализа документации (analysis_jobs). */
export const analysisJobStatusLabels: Record<JobStatus, string> = {
  pending: "В очереди",
  processing: "Выполняется",
  completed: "Завершено",
  failed: "Ошибка",
};

/**
 * Задания очереди сервера в России (sync_jobs).
 *
 * Подписи нужны на служебной странице, где владелец смотрит, что именно
 * выполняет сервер и чем закончилось задание. В значениях базы при этом
 * остаются `documents` и `full_sync`: на них завязаны воркер и тесты.
 */
export const syncJobKindLabels: Record<SyncJobKind, string> = {
  documents: "Документация закупок",
  full_sync: "Плановый прогон",
  estimate: "Расчёт сметы",
};

export const syncJobStatusLabels: Record<SyncJobStatus, string> = {
  pending: "В очереди",
  processing: "Выполняется",
  completed: "Выполнено",
  failed: "Не выполнено",
};

/**
 * Откуда задание. Причина приходит строкой из `payload.reason`, поэтому
 * неизвестное значение показываем как есть, а не заменяем на «неизвестно»:
 * в журнале важнее точность, чем гладкость подписи.
 */
export const syncJobReasonLabels: Record<string, string> = {
  press: "кнопка «Найти новые закупки»",
  manual: "панель администратора",
};

/** Состояние текста документа: что с ним удалось сделать локально. */
export const parsedStatusLabels: Record<ParsedStatus, string> = {
  pending: "Текст ещё не загружен",
  parsing: "Идёт извлечение текста",
  parsed: "Текст получен",
  needs_ocr: "Скан: нужно распознавание",
  failed: "Текст получить не удалось",
};

/**
 * Документ, который обход вложений не стал читать: не влез в бюджет знаков,
 * весит больше предела, не читается вовсе или оказался сканом без слоя.
 *
 * Отдельная подпись нужна, потому что в базе такая строка хранится с
 * parsed_status = 'failed'. Показывать «Текст получить не удалось» — значит
 * выдать решение обхода за сбой: причина известна заранее, и попытка не делалась.
 */
export const documentSkippedLabel = "Пропущен";

/** Категории факторов, которые модель находит в документации. */
export const findingCategoryLabels: Record<AnalysisFinding["category"], string> = {
  blocker: "Блокирующие факторы",
  risk: "Риски",
  requirement: "Требования к участнику",
  neutral: "Прочие наблюдения",
};

export const findingSeverityLabels: Record<AnalysisFinding["severity"], string> = {
  high: "Высокая",
  medium: "Средняя",
  low: "Низкая",
};

/**
 * Подписи элементов поиска и фильтра цены.
 *
 * Названия областей поиска («Название», «Объекты закупки», «Документация»)
 * здесь намеренно не дублируются: они живут в `searchRanking.scopeShortLabels`
 * рядом со своими родительными формами, из которых домен собирает объяснение
 * «Совпадение в номенклатуре». Две независимые подписи одной области рано или
 * поздно разошлись бы, и подсказка перестала бы совпадать с переключателем.
 */

/**
 * Подписи фильтра «срочно». Число дней берётся из домена (`URGENT_DEADLINE_DAYS`),
 * потому что «срочно» обязано означать одно и то же на экране «Сегодня»,
 * в фильтрах закупок и в чипе активного фильтра. Раньше фильтр обещал «< 24 ч»,
 * а блок на дашборде показывал три дня: одна и та же кнопка вела в разные списки.
 */
export const closingSoonLabel = `Подача закрывается в ближайшие ${URGENT_DEADLINE_DAYS} ${pluralRu(
  URGENT_DEADLINE_DAYS,
  ["день", "дня", "дней"],
)}`;

/** Короткая подпись для чипа активного фильтра — места там мало. */
/** Подпись переключателя: что именно он убирает, а не просто «закрытые». */
export const hideClosedLabel = "Скрыть закрытые (срок подачи прошёл)";
export const hideClosedChipLabel = "Без закрытых";

export const closingSoonChipLabel = `Подача ≤ ${URGENT_DEADLINE_DAYS} дн.`;

/** Переключатели в духе Контур.Закупок: что делать с неполной ценой. */
export const priceVisibilityLabels = {
  includeUnknown: "Включать закупки без НМЦ",
  includeForeignCurrency: "Включать закупки в валюте",
} as const;

/**
 * Пояснение к переключателям. Коммерческие закупки часто объявляют без цены
 * или в валюте, и молча потерять их из выдачи хуже, чем показать с пометкой.
 */
export const priceVisibilityHints = {
  includeUnknown:
    "Запросы цен и коммерческие торги публикуются без НМЦ. Если выключить — они исчезнут из выдачи, как только задан диапазон цены.",
  includeForeignCurrency:
    "Часть коммерческих закупок объявлена в долларах, юанях и других валютах. Их цена не сравнивается с диапазоном в рублях.",
} as const;

/** Подписи элементов строки поиска. */
export const searchControlLabels = {
  query: "Поиск по названию, номенклатуре и документации",
  queryPlaceholder: "Например: вентиль 15Б1БК или 30.01.24.190",
  exclude: "Исключить слова",
  excludePlaceholder: "Например: б/у, аренда",
  exact: "Точное совпадение",
  scopes: "Искать в",
  /** Подсказка к синтаксису запроса — как в Контуре, но короче. */
  syntaxHint:
    "Слова ищутся по основе: «вентиля» находит «вентиль» и «вентилей». Минус перед словом исключает его, кавычки задают дословную фразу, код ОКПД2 можно написать в той же строке.",
} as const;

/** Подпись пустой выдачи при поиске: причина обязана быть видимой. */
export const searchEmptyLabel =
  "По запросу ничего не найдено. Попробуйте убрать часть слов, снять ограничение по регионам или выключить точное совпадение.";

/**
 * Пометка закупки, найденной только по документации.
 *
 * Нужна отдельно: текст извещения на 200 страниц содержит почти любое слово,
 * поэтому такое совпадение слабее совпадения в названии, и скрывать эту разницу
 * от пользователя нельзя.
 */
export const documentOnlyMatchLabel = "Совпадение только в документации";

/**
 * Причины, по которым профиль поиска отклоняет закупку.
 *
 * Пустой результат обязан быть объяснён: правило проекта запрещает закупке
 * исчезать молча. Подписи сформулированы так, чтобы по ним было понятно,
 * какое именно поле профиля править.
 */
export const searchCriterionLabels: Record<SearchCriterion, string> = {
  law: "закон закупки не входит в список профиля",
  region: "регион закупки не совпадает с указанными в профиле",
  customerInn: "заказчик не входит в список ИНН профиля",
  price: "цена вне диапазона профиля",
  stopWord: "в предмете закупки есть стоп-слово профиля",
  keyword: "ни одно ключевое слово профиля не встретилось в предмете",
  deadline: "срок подачи заявок истёк",
};

/** Оговорка для закупок, прошедших фильтр с неопределённым регионом. */
export const regionUnknownNote =
  "регион не определён — в выдаче ЕИС регионального поля нет, поэтому такие закупки проходят фильтр по региону с оговоркой";

/**
 * Названия порядка выдачи — для чипа «Порядок: …» и подписей сортировки.
 *
 * Формулировки в виде «по чему»: чип читается как продолжение слова «Порядок»,
 * а «Порядок: цена» звучало бы как обрывок справочника.
 */
export const sortFieldLabels: Record<SortField, string> = {
  freshness: "свежие и подходящие сверху",
  relevance: "по приоритету запроса",
  fitScore: "по соответствию",
  price: "по цене",
  submissionEnd: "по сроку подачи",
  subject: "по предмету",
  analyzedAt: "по дате разбора",
};

/**
 * Заголовки слоёв свежести в ленте.
 *
 * Слои видны пользователю только при порядке по умолчанию: он и объясняет,
 * почему закупка с низким фит-скорингом оказалась выше закупки с высоким. Без
 * разделителя такой порядок читался бы как ошибка сортировки.
 *
 * `LAST_RUN` назван по платному поиску, а не «по кнопке»: партию собирает метка
 * `tenders.synced_at`, а её прогон ставит только строкам платного источника.
 * Подписать слой «последний прогон» значило бы приписать бесплатным площадкам
 * метку, которой у них нет (см. `selectLastKonturBatch`).
 */
export const freshnessLayerLabels: Record<FreshnessLayer, string> = {
  LAST_RUN: "Новые · платный поиск",
  WEEK: "На этой неделе",
  EARLIER: "Раньше",
  EXPIRED: "Срок подачи истёк",
};

export const DISCLAIMER =
  "Оценка отражает соответствие закупки профилю компании и не является вероятностью победы. Сервис носит информационно-аналитический характер и не гарантирует допуск к закупке.";
