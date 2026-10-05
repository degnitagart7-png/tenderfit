import type { SearchProfile } from "@/domain/entities";
import { readJsonOrThrow } from "@/lib/readJson";

/** Клиент ручек входа по коду и данных аккаунта. Сообщение ошибки — слова сервера. */

export interface AccountState {
  user: { email: string } | null;
  /** Вход настроен на сервере; false — страница показывает только гостевой режим. */
  loginEnabled: boolean;
  /** Настроена отправка писем: можно входить по коду из письма. */
  codeLoginEnabled?: boolean;
}

export interface AccountData {
  searchProfiles: SearchProfile[];
  companyProfile: unknown;
}

async function send<T>(url: string, method: "POST" | "PUT", body: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow<T>(response);
}

export const accountApiService = {
  async me(): Promise<AccountState> {
    const response = await fetch("/api/auth/me");
    return readJsonOrThrow<AccountState>(response);
  },

  async register(email: string, password: string, consent: boolean): Promise<{ email: string }> {
    const data = await send<{ user: { email: string } }>("/api/auth/register", "POST", { email, password, consent });
    return data.user;
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

  async requestCode(email: string, consent: boolean): Promise<void> {
    await send<{ sent: boolean }>("/api/auth/request", "POST", { email, consent });
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
