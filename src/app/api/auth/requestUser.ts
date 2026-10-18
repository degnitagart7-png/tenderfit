import type { NextRequest } from "next/server";

import type { UserEventInput } from "@/services/userEventLog";
import { recordUserEvent } from "@/services/userEventLog";

/**
 * Кто сделал запрос, для журнала действий (/admin/users).
 *
 * `lookupAccess` уже прочитал сессию, когда ручка проверяла доступ
 * (`requireAccess`), и кладёт почту сюда по самому запросу. Ручке, которой нужна
 * почта только для журнала, не приходится ни читать сессию второй раз (лишний
 * круг до базы на каждый запрос), ни менять проверку доступа: `requireAccess`
 * остаётся как есть и отвечает теми же 401/402/503.
 *
 * Если почты нет (служебный ключ воркера или владельца, режим разработки, ручку
 * вызвали без проверки доступа) — событие не пишется: это не пользователь.
 */

const emails = new WeakMap<object, string>();

/** Запоминает вошедшего по запросу. Зовёт `lookupAccess`; пустую почту не хранит. */
export function rememberRequestEmail(request: object, email: string | null): void {
  if (email !== null && email.trim() !== "") emails.set(request, email.trim().toLowerCase());
}

/** Почта вошедшего, если доступ по этому запросу уже проверен; иначе null. */
export function requestEmail(request: NextRequest): string | null {
  return emails.get(request) ?? null;
}

/**
 * Записать действие вошедшего по этому запросу. Не бросает и не ждёт (см.
 * `recordUserEvent`): вызывать как `recordRequestEvent(request, {...})`.
 */
export function recordRequestEvent(request: NextRequest, event: Omit<UserEventInput, "email">): void {
  void recordUserEvent({ ...event, email: requestEmail(request) });
}
