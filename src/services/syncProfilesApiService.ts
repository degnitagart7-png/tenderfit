import type { ServerProfile } from "@/domain/syncProfiles";
import { readJsonOrThrow } from "@/lib/readJson";

/** Клиент ручки профилей сбора: отправить набор на сервер. */
export const syncProfilesApiService = {
  async push(token: string, profiles: readonly ServerProfile[]): Promise<number> {
    const response = await fetch("/api/sync-profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-admin-token": token },
      body: JSON.stringify({ profiles }),
    });
    const data = await readJsonOrThrow<{ saved: number }>(response);
    return data.saved;
  },
};
