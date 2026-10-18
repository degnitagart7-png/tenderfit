/**
 * Суточные лимиты глубоких разборов документации.
 *
 * Разбор оплачивается токенами и запускается человеком вручную — переносом
 * кнопки «Запустить глубокий анализ». Поэтому лимит нужен не для экономии (20 разборов
 * стоят около 120 ₽), а как защита от аварии: сорвавшийся скрипт или залипшая
 * кнопка не должны выставить счёт на тысячи разборов за ночь.
 *
 * Число 20 установлено владельцем проекта 2026-09-24; до этого с 22.09.2026
 * действовало 30. С 14.10.2026 (решение владельца) это лимит на одного
 * пользователя, а не на весь сервис: общий лимит 20 при десяти пользователях
 * давал по два разбора на человека в день. С 18.10.2026 (решение владельца) — 15 в сутки
 * на пользователя.
 */
export const DAILY_ANALYSIS_LIMIT = 15;

/**
 * Общий потолок на весь сервис — только защита от аварии (зациклившийся скрипт,
 * массовая регистрация): 300 разборов по ~5 ₽ — около 1 500 ₽ в сутки. Обычной
 * работе не мешает: это 15 пользователей, каждый из которых выбрал свой лимит.
 */
export const GLOBAL_DAILY_ANALYSIS_LIMIT = 300;

/**
 * Часовой пояс, по которому считаются сутки, — Москва: UTC+3, часы не
 * переводятся с 2014 года, поэтому смещение постоянно и не зависит от даты.
 */
const MOSCOW_OFFSET_MS = 3 * 3_600_000;

export interface AnalysisQuota {
  allowed: boolean;
  /** Сколько разборов ещё можно поставить сегодня. */
  remaining: number;
  /** Причина отказа — текст для партнёра. null, когда отказывать нечего. */
  reason: string | null;
}

/**
 * Начало текущих суток по Москве.
 *
 * Сутки считаются не по UTC, а по местному времени владельца: иначе лимит
 * обнулялся бы в три часа ночи, и «30 в день» не совпадало бы с рабочим днём.
 * Дата берётся через сдвиг на постоянное смещение — так правило не зависит от
 * часовых баз операционной системы и проверяется тестом.
 */
export function moscowDayStart(now: Date): Date {
  const moscowDay = new Date(now.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
  return new Date(Date.parse(`${moscowDay}T00:00:00.000Z`) - MOSCOW_OFFSET_MS);
}

/** Можно ли поставить ещё один разбор и что ответить, если нельзя. */
export function analysisQuota(
  usedToday: number,
  limit: number = DAILY_ANALYSIS_LIMIT,
): AnalysisQuota {
  // Остаток ограничен с двух сторон: задачи сверх лимита не дают минус, а
  // отрицательный счётчик (такое возможно при сбое запроса к базе) не даёт
  // остатка больше самого лимита.
  const remaining = Math.max(0, Math.min(limit, limit - usedToday));
  if (remaining > 0) return { allowed: true, remaining, reason: null };

  return {
    allowed: false,
    remaining: 0,
    reason: `Суточный лимит разборов исчерпан: ${limit} за день. Следующий можно поставить после 00:00 по Москве.`,
  };
}

/**
 * Лимит для конкретного человека: его 20 в сутки и общий аварийный потолок.
 * `userUsed` = null — запрос без пользователя (служебный ключ): только общий потолок.
 */
export function userAnalysisQuota(input: { userUsed: number | null; globalUsed: number }): AnalysisQuota {
  const global = analysisQuota(input.globalUsed, GLOBAL_DAILY_ANALYSIS_LIMIT);
  if (!global.allowed) {
    return {
      allowed: false,
      remaining: 0,
      reason: "Сервис сегодня исчерпал общий суточный лимит разборов. Следующий можно поставить после 00:00 по Москве.",
    };
  }
  if (input.userUsed === null) return global;
  const own = analysisQuota(input.userUsed);
  if (!own.allowed) {
    return {
      allowed: false,
      remaining: 0,
      reason: `Ваш суточный лимит разборов исчерпан: ${DAILY_ANALYSIS_LIMIT} за день. Следующий можно поставить после 00:00 по Москве.`,
    };
  }
  return { allowed: true, remaining: Math.min(own.remaining, global.remaining), reason: null };
}
