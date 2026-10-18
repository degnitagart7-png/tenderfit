import type { AccessInfo } from "@/domain/access";
import type { SearchProfile } from "@/domain/entities";
import type { AppState } from "@/domain/userDataMerge";
import { readJsonOrThrow } from "@/lib/readJson";
import { createSharedRequestCache } from "@/lib/sharedRequest";

/** Клиент ручек входа по коду и данных аккаунта. Сообщение ошибки — слова сервера. */

export interface AccountState {
  /** `access` — доступ: пробный период, оплата, администратор; старый сервер его не присылает. */
  user: { email: string; access?: AccessInfo } | null;
  /** Вход настроен на сервере; false — страница показывает только гостевой режим. */
  loginEnabled: boolean;
  /** Настроена отправка писем: можно входить по коду из письма. */
  codeLoginEnabled?: boolean;
}

export interface AccountData {
  searchProfiles: SearchProfile[];
  companyProfile: unknown;
  /** Воронка, настройки, отметка онбординга и прочее; старый сервер его не отдаёт. */
  appState?: AppState;
}

async function send<T>(url: string, method: "POST" | "PUT", body: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Любой POST/PUT к аккаунту (вход, выход, регистрация, пароль, данные) мог
  // изменить «кто вошёл»: ответ `me()` до него уже не годится.
  meCache.invalidate();
  return readJsonOrThrow<T>(response);
}

/**
 * Кто вошёл: ответ делят все, кто спросил в одно время.
 *
 * При открытии страницы `/api/auth/me` спрашивали от двух до четырёх раз:
 * оболочка (`useAccessGate`), ссылка на аккаунт (`AccountLink`), синхронизация
 * данных (`accountSync`). Секунды памяти хватает, чтобы они делили один ответ, и
 * не хватает, чтобы показывать человека, который уже вышел: вход, выход и смена
 * пароля сбрасывают ответ сразу.
 */
const ME_TTL_MS = 10_000;
const meCache = createSharedRequestCache<AccountState>(ME_TTL_MS);

export const accountApiService = {
  async me(): Promise<AccountState> {
    return meCache.get("me", async () => {
      const response = await fetch("/api/auth/me");
      return readJsonOrThrow<AccountState>(response);
    });
  },

  /** `code` — код подтверждения из письма; без почтового сервера не нужен. */
  async register(email: string, password: string, consent: boolean, code?: string): Promise<{ email: string }> {
    const body = code === undefined ? { email, password, consent } : { email, password, consent, code };
    const data = await send<{ user: { email: string } }>("/api/auth/register", "POST", body);
    return data.user;
  },

  async requestRegisterCode(email: string, consent: boolean): Promise<void> {
    await send<{ sent: boolean }>("/api/auth/register/code", "POST", { email, consent });
  },

  async login(email: string, password: string): Promise<{ email: string }> {
    const data = await send<{ user: { email: string } }>("/api/auth/login", "POST", { email, password });
    return data.user;
  },

  async changePassword(current: string, next: string): Promise<void> {
    await send<{ ok: boolean }>("/api/auth/password", "POST", { current, next });
  },

  async resetPassword(email: string, code: string, password: string): Promise<{ email: string }> {
    const data = await send<{ user: { email: string } }>("/api/auth/reset", "POST", { email, code, password });
    return data.user;
  },

  /** `purpose: "reset"` — код для восстановления пароля: меняет только текст письма. */
  async requestCode(email: string, consent: boolean, purpose?: "login" | "reset"): Promise<void> {
    const body = purpose === undefined ? { email, consent } : { email, consent, purpose };
    await send<{ sent: boolean }>("/api/auth/request", "POST", body);
  },

  async verifyCode(email: string, code: string): Promise<{ email: string }> {
    const data = await send<{ user: { email: string } }>("/api/auth/verify", "POST", { email, code });
    return data.user;
  },

  async logout(): Promise<void> {
    await send<{ ok: boolean }>("/api/auth/logout", "POST", {});
  },

  async getData(): Promise<AccountData> {
    const response = await fetch("/api/me/data");
    return readJsonOrThrow<AccountData>(response);
  },

  async putData(data: AccountData): Promise<void> {
    await send<{ saved: boolean }>("/api/me/data", "PUT", data);
  },
};
