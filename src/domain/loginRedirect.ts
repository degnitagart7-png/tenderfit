/**
 * Куда вести после входа: безопасный `next` или стандартная точка входа.
 *
 * Ссылка вида /login?next=//evil.ru или next=https://evil.ru — классика
 * открытого редиректа: человек входит на нашем сайте и оказывается на чужом.
 * Поэтому принимается только путь внутри сайта: начинается с одного «/», без
 * «//», без «\\» (браузеры читают его как «/»), без схемы и управляющих
 * знаков. Сам /login тоже отклоняется — иначе вход вёл бы на вход.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || value.length > 500) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  // Схема «внутри» пути: /\evil, /%2F/evil и подобные обходы разбираются декодированием.
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  if (value === "/login" || value.startsWith("/login/") || value.startsWith("/login?")) return null;
  return value;
}

/** Адрес входа с возвратом на текущую страницу. */
export function loginUrlWithNext(pathAndQuery: string): string {
  const next = safeNextPath(pathAndQuery);
  return next === null ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
