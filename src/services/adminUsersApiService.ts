import type { AdminUsersResponse } from "@/app/api/admin/users/route";
import type { AdminUserEventsResponse } from "@/app/api/admin/users/events/route";
import { readJsonOrThrow } from "@/lib/readJson";

/** Клиент ручек админ-панели «Пользователи». Доступ — по сессии администратора. */

/** Вошёл, но не администратор (403): страница показывает заглушку, а не ошибку. */
export class AdminAccessError extends Error {
  constructor(message = "Раздел только для администратора") {
    super(message);
    this.name = "AdminAccessError";
  }
}

async function read<T>(response: Response): Promise<T> {
  if (response.status === 403) throw new AdminAccessError();
  return readJsonOrThrow<T>(response);
}

export const adminUsersApiService = {
  async list(): Promise<AdminUsersResponse> {
    return read<AdminUsersResponse>(await fetch("/api/admin/users", { cache: "no-store" }));
  },

  async events(email: string): Promise<AdminUserEventsResponse> {
    return read<AdminUserEventsResponse>(
      await fetch(`/api/admin/users/events?email=${encodeURIComponent(email)}`, { cache: "no-store" }),
    );
  },
};
