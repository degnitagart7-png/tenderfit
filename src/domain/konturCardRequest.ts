import type { TenderDataSource, TenderLaw } from "@/types/database";

/**
 * Нужна ли закупке платная карточка Контур.Закупок и можно ли её купить сейчас.
 *
 * Правило появилось из живого случая: закупка RH24092600035 (Контур.Закупки,
 * закон COMMERCIAL) попала в очередь глубокого разбора 25.09.2026 в 16:59 МСК,
 * прогон в 17:12 МСК до неё дошёл и сообщил, что ЕИС не публикует вкладку
 * документов для COMMERCIAL. Задача осталась «pending» навсегда, а карточка
 * закупки продолжала обещать догрузку плановой синхронизацией — обещание,
 * которое не выполнится.
 *
 * Отсюда три вопроса, на которые отвечает функция: платить ли вообще (show),
 * можно ли сейчас (allowed) и как назвать отказ (reason).
 *
 * Платный запрос предлагается только там, где бесплатного пути нет: источник
 * Контур.Закупки, закон COMMERCIAL, документов в базе ноль. Для 44-ФЗ и 223-ФЗ
 * те же файлы бесплатно отдаёт ЕИС — предлагать там карточку значит тратить
 * деньги партнёра на то, что через два часа придёт даром.
 *
 * Четвёртое условие — остаток суточного лимита разборов: карточка без разбора
 * моделью даёт только имена файлов, а платный запрос уже списан.
 */

export interface KonturCardOfferInput {
  /** KONTUR_API_KEY задан на сервере. */
  configured: boolean;
  dataSource: TenderDataSource;
  law: TenderLaw;
  /** Идентификатор закупки в Контур.Закупках (`external_id`); по нему открывается карточка. */
  externalId: string | null;
  /** Сколько строк документации уже лежит в базе, включая пропуски без текста. */
  documentsCount: number;
  /**
   * Остаток платных запросов группы `purchase` на сегодня; null — бюджет не
   * ограничен (`KONTUR_DAILY_REQUEST_LIMIT` выключен).
   */
  cardRemaining: number | null;
  /**
   * Сколько разборов моделью ещё можно поставить сегодня.
   *
   * null — задача разбора на эту закупку уже есть в очереди или в работе, то
   * есть покупка карточки не расходует лимит: текст подберёт прежняя задача.
   */
  analysisRemaining: number | null;
}

/**
 * Чем именно отказал блок.
 *
 * Вид отказа нужен роуту (разные коды ответа) и панели (по-разному объясняем):
 * `config` — это к владельцу сервера, `budget` и `analysis` — подождать до
 * завтра, `tender` — у этой закупки карточки нет вовсе.
 */
export type KonturCardRefusal = "config" | "tender" | "budget" | "analysis";

export interface KonturCardOffer {
  /** Показывать ли блок на карточке закупки. */
  show: boolean;
  /** Можно ли купить сейчас. */
  allowed: boolean;
  /** Причина отказа — текст для партнёра; null, когда отказывать нечего. */
  reason: string | null;
  /** Род отказа; null, когда отказывать нечего или блок не показывается. */
  refusalKind: KonturCardRefusal | null;
}

/** Блок не показывается и ничего не объясняет: платный путь не нужен вовсе. */
const NOT_NEEDED: KonturCardOffer = {
  show: false,
  allowed: false,
  reason: null,
  refusalKind: null,
};

function blocked(reason: string, refusalKind: KonturCardRefusal): KonturCardOffer {
  return { show: true, allowed: false, reason, refusalKind };
}

export function konturCardOffer(input: KonturCardOfferInput): KonturCardOffer {
  if (input.dataSource !== "KONTUR") return NOT_NEEDED;
  // Документация уже есть — второй платный запрос ничего не добавит: карточка
  // кэшируется на семь суток, а файлы без текста не читаются по причине, которая
  // записана в строке документа.
  if (input.documentsCount > 0) return NOT_NEEDED;
  if (input.law !== "COMMERCIAL") return NOT_NEEDED;

  if (!input.configured) {
    return blocked(
      "Ключ Контур.Закупок не задан на сервере: карточку купить нечем.",
      "config",
    );
  }

  const externalId = input.externalId?.trim() ?? "";
  if (externalId === "") {
    return blocked(
      "У закупки нет идентификатора в Контур.Закупках — карточку источника не открыть.",
      "tender",
    );
  }

  if (input.cardRemaining !== null && input.cardRemaining <= 0) {
    // Число в тексте не печатаем: предел задаёт KONTUR_DAILY_REQUEST_LIMIT, и
    // зашитая тридцатка разошлась бы с настройкой.
    return blocked(
      "Суточный бюджет карточек Контур.Закупок исчерпан. Следующая попытка — после 00:00 по Москве.",
      "budget",
    );
  }

  // Карточка нужна не сама по себе, а чтобы модель прочитала документацию и
  // пересмотрела вердикт. Купить её при исчерпанном лимите разборов — значит
  // потратить платный запрос и оставить файлы неразобранными до завтра.
  if (input.analysisRemaining !== null && input.analysisRemaining <= 0) {
    return blocked(
      "Суточный лимит разборов исчерпан: документацию некому разобрать, а платный " +
        "запрос пропал бы впустую. Следующая попытка — после 00:00 по Москве.",
      "analysis",
    );
  }

  return { show: true, allowed: true, reason: null, refusalKind: null };
}

/**
 * Состояние блока платной карточки — ответ GET /api/analysis/kontur-card.
 *
 * Форма живёт в домене, а не в серверном сервисе: её читают обе стороны —
 * сервер собирает из своих таблиц, браузер рисует в панели глубокого анализа.
 * Два независимых описания одного ответа разошлись бы молча, потому что лишнее
 * или пропущенное поле в JSON не ломает ни тип другой стороны, ни её тесты.
 */
export interface KonturCardStatus {
  regNumber: string;
  /** Показывать ли блок: для 44-ФЗ и при документах в базе он не нужен. */
  show: boolean;
  /** Можно ли купить сейчас. */
  allowed: boolean;
  /** Причина отказа — текст для партнёра; null, когда отказывать нечего. */
  reason: string | null;
  /** Род отказа: от него зависит подпись в панели. */
  refusalKind: KonturCardRefusal | null;
  /** Готовая подпись расхода: «Карточек Контур.Закупок сегодня: 2 из 30, осталось 28». */
  budgetNote: string;
  /** Сколько карточек куплено сегодня по нашему журналу. */
  cardSpentToday: number;
  /** Суточный предел карточек; null — предел выключен настройкой. */
  cardLimit: number | null;
  /** Сколько разборов ещё можно поставить сегодня; null — задача на эту закупку уже есть. */
  analysisRemaining: number | null;
}

/**
 * Подпись расхода карточек — её партнёр видит до подтверждения покупки.
 *
 * Считается по нашему журналу `api_usage_log`, а не по тарифу источника: журнал
 * читается из базы без платного запроса. Настоящий остаток по группе `purchase`
 * показывает панель «Контур.Закупки».
 */
export function konturCardBudgetNote(spentToday: number, limit: number | null): string {
  if (limit === null) {
    return `Карточек Контур.Закупок сегодня: ${spentToday}, суточного предела нет`;
  }
  const remaining = Math.max(0, limit - spentToday);
  return `Карточек Контур.Закупок сегодня: ${spentToday} из ${limit}, осталось ${remaining}`;
}
