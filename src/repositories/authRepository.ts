import { readJSON, writeJSON, removeKey, STORAGE_KEYS } from "@/lib/storage";

export interface AuthSession {
  email: string;
  name: string;
  since: string;
}

/**
 * Локальная сессия: флаг входа в localStorage, без проверки пароля и без
 * серверной авторизации. Настоящая регистрация появится вместе с ролями —
 * до тех пор интерфейс обязан говорить об этом прямо (см. /login).
 */
export const authRepository = {
  get(): AuthSession | null {
    return readJSON<AuthSession | null>(STORAGE_KEYS.auth, null);
  },
  login(email: string, name = "Пользователь"): AuthSession {
    const session: AuthSession = {
      email,
      name,
      since: new Date().toISOString(),
    };
    writeJSON(STORAGE_KEYS.auth, session);
    return session;
  },
  logout(): void {
    removeKey(STORAGE_KEYS.auth);
  },
};
