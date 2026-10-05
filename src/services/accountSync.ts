import { mergeUserData, type UserDataSnapshot } from "@/domain/userDataMerge";
import { STORAGE_KEYS, readJSON, writeJSON } from "@/lib/storage";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { accountApiService } from "@/services/accountApiService";

/**
 * Синхронизация профилей и анкеты компании с аккаунтом.
 *
 * Данные живут в браузере, а у вошедшего ещё и на сервере, чтобы на другом
 * устройстве они были такими же. При входе данные устройства и аккаунта
 * сливаются без потерь (см. mergeUserData), а после этого каждое сохранение
 * профилей уходит на сервер. Сбой связи не мешает работе: данные устройства
 * уже сохранены, а следующая синхронизация догонит.
 */

function readLocal(): UserDataSnapshot {
  return {
    searchProfiles: searchProfileRepository.getAll(),
    companyProfile: readJSON<unknown>(STORAGE_KEYS.profile, null),
  };
}

function writeLocal(data: UserDataSnapshot): void {
  searchProfileRepository.save(data.searchProfiles);
  if (data.companyProfile !== null) writeJSON(STORAGE_KEYS.profile, data.companyProfile);
}

export const accountSync = {
  /**
   * Вызывается после входа и при открытии страницы вошедшим.
   * `deviceChanged` — данные на устройстве изменились, странице стоит перечитать их.
   */
  async onSignedIn(): Promise<{ deviceChanged: boolean }> {
    try {
      const local = readLocal();
      const serverData = await accountApiService.getData();
      const server: UserDataSnapshot = {
        searchProfiles: serverData.searchProfiles,
        companyProfile: serverData.companyProfile,
      };

      const result = mergeUserData(local, server);
      if (result.writeToDevice) writeLocal(result.merged);
      if (result.pushToServer) {
        await accountApiService.putData({
          searchProfiles: result.merged.searchProfiles,
          companyProfile: result.merged.companyProfile,
        });
      }
      return { deviceChanged: result.writeToDevice };
    } catch {
      return { deviceChanged: false };
    }
  },

  /** После сохранения профилей на устройстве: отправить их на сервер, если человек вошёл. */
  async pushIfSignedIn(): Promise<void> {
    try {
      const state = await accountApiService.me();
      if (state.user === null) return;
      const local = readLocal();
      await accountApiService.putData({
        searchProfiles: local.searchProfiles,
        companyProfile: local.companyProfile,
      });
    } catch {
      // Данные на устройстве сохранены; сервер получит их при следующей синхронизации.
    }
  },
};
