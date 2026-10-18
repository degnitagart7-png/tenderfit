import { loginUrlWithNext } from "@/domain/loginRedirect";

/**
 * Клиентская часть доступа: что делать странице, когда сервер ответил 401 или 402.
 *
 * Запросов к API в приложении десятки, и каждый обрабатывает ошибки по-своему:
 * показывать в каждом месте «войдите» и «пробный период закончился» значило бы
 * переписать все. Вместо этого `fetch` страницы оборачивается один раз:
 *  - 401 — сессия кончилась или её нет: переход на /login с возвратом сюда;
 *  - 402 — пробный период закончился: страница получает событие и заменяет
 *    содержимое экраном «Пробный период закончился».
 * Ответ при этом отдаётся вызывающему без изменений, поэтому сервисы по-прежнему
 * видят `error` с текстом сервера и не падают на «Unexpected token».
 *
 * Запросы к /api/auth/* не трогаются: там 401 и 402 — обычные ответы формы
 * входа, а не потеря доступа.
 */

export const ACCESS_EXPIRED_EVENT = "tenderfit:access-expired";

export interface AccessFetchHandlers {
  onLoginRequired: () => void;
  onExpired: () => void;
}

/** Переход на вход с возвратом на текущую страницу. */
export function redirectToLogin(): void {
  window.location.assign(loginUrlWithNext(`${window.location.pathname}${window.location.search}`));
}

/** Сообщить оболочке, что доступ закончился. */
export function announceExpired(): void {
  window.dispatchEvent(new CustomEvent(ACCESS_EXPIRED_EVENT));
}

function requestPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin ? url.pathname : null;
  } catch {
    return null;
  }
}

let installed: (() => void) | null = null;

/**
 * Оборачивает `window.fetch`. Повторная установка не вкладывает обёртки друг в
 * друга (React StrictMode в разработке запускает эффект дважды): возвращается
 * снятие уже стоящей. Возвращает функцию, которая возвращает исходный `fetch`.
 */
export function installAccessFetchGuard(
  handlers: AccessFetchHandlers = { onLoginRequired: redirectToLogin, onExpired: announceExpired },
): () => void {
  if (installed !== null) return installed;

  const original = window.fetch;
  const guarded: typeof window.fetch = async (input, init) => {
    const response = await original.call(window, input, init);
    const path = requestPath(input);
    if (path !== null && path.startsWith("/api/") && !path.startsWith("/api/auth/")) {
      if (response.status === 401) handlers.onLoginRequired();
      else if (response.status === 402) handlers.onExpired();
    }
    return response;
  };
  window.fetch = guarded;

  installed = () => {
    if (window.fetch === guarded) window.fetch = original;
    installed = null;
  };
  return installed;
}
