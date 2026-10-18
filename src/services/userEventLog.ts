import {
  EVENT_THROTTLE_MS,
  createEventThrottle,
  normalizeEventDetail,
  normalizeEventEmail,
  throttleKey,
  type UserEventKind,
} from "@/domain/userEvents";
import { getSupabaseServerClient } from "@/lib/supabase";

/**
 * Запись действий пользователей в журнал `user_events` (страница /admin/users).
 *
 * Правило одно: журнал не вправе повлиять на ручку, ради которой ведётся.
 * Поэтому `recordUserEvent` никогда не бросает, а ручки не ждут её (`void`):
 * приложение работает на одном долгоживущем процессе (VPS), запись успевает
 * дойти и после ответа. Ожидание в ручке добавило бы к каждому первому открытию
 * ленты лишний круг до базы в Стокгольме ради строки, от которой ничего не зависит.
 * Вернёт обещание, чтобы тест (и редкий вызывающий) мог дождаться, но оно
 * всегда завершается успешно.
 *
 * Не пишется, когда почты нет: запрос по служебному ключу (воркер, владелец) и
 * режим разработки без входа — это не пользователь. Выключатель
 * `USER_EVENTS_DISABLED=1` нужен тестам: они базу не трогают.
 *
 * Таблица создаётся миграцией 20261014000022_user_events.sql. Пока она не
 * применена, запись молча пропускается, в консоль уходит одно предупреждение.
 */

export interface UserEventInput {
  /** Почта вошедшего; null — служебный запрос, событие не пишется. */
  email: string | null | undefined;
  kind: UserEventKind;
  /** false — действие отказано или закончилось ошибкой. По умолчанию true. */
  ok?: boolean;
  tenderId?: string | null;
  detail?: string | null;
}

let throttle = createEventThrottle();

let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[user-events] ${message}`);
}

/** Для тестов: забыть, что предупреждение уже печаталось, и очистить ограничитель. */
export function resetUserEventLogForTests(): void {
  warned = false;
  throttle = createEventThrottle();
}

export async function recordUserEvent(input: UserEventInput): Promise<void> {
  try {
    if (process.env["USER_EVENTS_DISABLED"] === "1") return;
    const email = normalizeEventEmail(input.email);
    if (email === null) return;

    const windowMs = EVENT_THROTTLE_MS[input.kind];
    if (
      windowMs !== undefined &&
      !throttle.allow(throttleKey(input.kind, email, input.tenderId, input.detail), windowMs)
    ) {
      return;
    }

    const { error } = await getSupabaseServerClient()
      .from("user_events")
      .insert({
        email,
        kind: input.kind,
        ok: input.ok ?? true,
        tender_id: input.tenderId ?? null,
        detail: normalizeEventDetail(input.detail),
      });
    if (error) {
      const code = (error as { code?: string }).code;
      warnOnce(
        code === "42P01" || code === "PGRST205"
          ? "таблицы user_events нет: примените миграцию 20261014000022_user_events.sql, события пока не пишутся"
          : `не удалось записать событие (${input.kind}): ${error.message ?? String(error)}`,
      );
    }
  } catch (error) {
    warnOnce(`не удалось записать событие (${input.kind}): ${error instanceof Error ? error.message : String(error)}`);
  }
}
