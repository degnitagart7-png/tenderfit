import { beforeEach, describe, expect, it, vi } from "vitest";

/** Таблица user_data в памяти: ровно столько интерфейса supabase-js, сколько нужно репозиторию. */
let rows: Record<string, Record<string, unknown>> = {};
let missingColumn = false;
const upserts: Record<string, unknown>[] = [];

function client() {
  return {
    from: () => ({
      select: (columns: string) => ({
        eq: (_column: string, userId: string) => ({
          limit: async () => {
            if (missingColumn && columns.includes("app_state")) return { data: null, error: { message: "column user_data.app_state does not exist" } };
            const row = rows[userId];
            return { data: row === undefined ? [] : [row], error: null };
          },
        }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        if (missingColumn && "app_state" in row) return { error: { message: "Could not find the 'app_state' column" } };
        upserts.push(row);
        const userId = String(row["user_id"]);
        rows[userId] = { ...(rows[userId] ?? { search_profiles: [], company_profile: null }), ...row };
        return { error: null };
      },
    }),
  };
}

vi.mock("@/lib/supabase", () => ({ getSupabaseServerClient: () => client() }));

import {
  AppStateUnavailableError,
  isServerOwnedKey,
  userDataRepository,
  withoutServerOwnedKeys,
} from "@/repositories/userDataRepository";

/*
  Правки ведомости лежат в app_state под ключом bill-edits:<tenderId>. Главное: запись одного
  ключа не трогает остальное, а полная запись данных аккаунта с устройства их не стирает.
*/

beforeEach(() => {
  rows = {};
  missingColumn = false;
  upserts.length = 0;
});

describe("userDataRepository: правки ведомости в app_state", () => {
  it("setAppStateEntry пишет ключ, не трогая профили, анкету и остальное состояние", async () => {
    rows["u1"] = { user_id: "u1", search_profiles: [{ name: "А" }], company_profile: { name: "ООО" }, app_state: { onboardingDone: true } };

    await userDataRepository.setAppStateEntry("u1", "bill-edits:0123", { version: 1, edits: [1] });

    expect(rows["u1"]?.["app_state"]).toEqual({ onboardingDone: true, "bill-edits:0123": { version: 1, edits: [1] } });
    expect(rows["u1"]?.["search_profiles"]).toEqual([{ name: "А" }]);
    // В базу ушли только app_state и метка времени: профили не перезаписывались.
    expect(Object.keys(upserts[0] ?? {}).sort()).toEqual(["app_state", "updated_at", "user_id"]);
  });

  it("у нового пользователя строка создаётся; значение null удаляет ключ", async () => {
    await userDataRepository.setAppStateEntry("u2", "bill-edits:1", { a: 1 });
    expect(rows["u2"]?.["app_state"]).toEqual({ "bill-edits:1": { a: 1 } });

    await userDataRepository.setAppStateEntry("u2", "bill-edits:1", null);
    expect(rows["u2"]?.["app_state"]).toEqual({});
  });

  it("правки восстанавливаются: getAppState отдаёт то, что записали, и только своему пользователю", async () => {
    await userDataRepository.setAppStateEntry("u1", "bill-edits:0123", { x: 1 });
    await userDataRepository.setAppStateEntry("u2", "bill-edits:0123", { x: 2 });

    expect(await userDataRepository.getAppState("u1")).toEqual({ "bill-edits:0123": { x: 1 } });
    expect(await userDataRepository.getAppState("u3")).toBeNull();
  });

  it("полная запись данных с устройства не стирает правки: ключи сервера переносятся", async () => {
    rows["u1"] = { user_id: "u1", search_profiles: [], company_profile: null, app_state: { "bill-edits:0123": { x: 1 }, pipeline: { old: 1 } } };

    await userDataRepository.put("u1", { searchProfiles: [], companyProfile: null, appState: { pipeline: { fresh: 1 } } });

    expect(rows["u1"]?.["app_state"]).toEqual({ pipeline: { fresh: 1 }, "bill-edits:0123": { x: 1 } });
  });

  it("устройство ключей сервера не видит: get их скрывает, и синхронизация не считает их изменением", async () => {
    rows["u1"] = { user_id: "u1", search_profiles: [], company_profile: null, app_state: { "bill-edits:0123": { x: 1 }, onboardingDone: true } };

    const record = await userDataRepository.get("u1");

    expect(record?.appState).toEqual({ onboardingDone: true });
    expect(isServerOwnedKey("bill-edits:5")).toBe(true);
    expect(isServerOwnedKey("pipeline")).toBe(false);
    expect(withoutServerOwnedKeys({ "bill-edits:1": 1, a: 2 })).toEqual({ a: 2 });
  });

  it("колонки app_state нет — запись правок падает понятной ошибкой, а не молча теряется", async () => {
    missingColumn = true;
    await expect(userDataRepository.setAppStateEntry("u1", "bill-edits:1", { a: 1 })).rejects.toBeInstanceOf(AppStateUnavailableError);
    await expect(userDataRepository.getAppState("u1")).rejects.toBeInstanceOf(AppStateUnavailableError);
  });
});
