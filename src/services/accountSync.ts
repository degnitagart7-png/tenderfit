import { mergeUserData, type AppState, type UserDataSnapshot } from "@/domain/userDataMerge";
import {
  STORAGE_KEYS,
  clearAccountScopedData,
  clearDeviceOwner,
  onLocalWrite,
  ownerTag,
  readDeviceOwner,
  readJSON,
  writeDeviceOwner,
  writeJSON,
} from "@/lib/storage";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { accountApiService } from "@/services/accountApiService";

/**
 * Синхронизация данных устройства с аккаунтом.
 *
 * Данные живут в браузере, а у вошедшего ещё и на сервере, чтобы на другом
 * устройстве (и после выхода и входа) они были такими же: профили поиска,
 * анкета компании, отметка пройденного онбординга, воронка закупок, настройки
 * уведомлений, решения по закупкам, импорт и сохранённые фильтры. При входе
 * данные устройства и аккаунта сливаются без потерь (см. mergeUserData), а
 * после этого каждое сохранение уходит на сервер. Сбой связи не мешает работе:
 * данные устройства уже сохранены, а следующая синхронизация догонит.
 *
 * Данные устройства принадлежат аккаунту (метка `tf.deviceOwner`). Слить можно
 * только данные того же человека; если метки нет или она чужая, данные
 * устройства стираются, а берутся данные сервера: иначе новый аккаунт на общем
 * браузере получал копию чужих профилей, анкеты и воронки. Вход обязателен, а
 * каждое сохранение вошедшего уходит на сервер, поэтому у законного владельца
 * без метки всё нужное уже есть в аккаунте. При выходе данные стираются.
 */

/** Какие ключи устройства соответствуют полям AppState. */
const APP_STATE_KEYS: Record<keyof AppState, string> = {
  onboardingDone: STORAGE_KEYS.onboardingDone,
  tourDone: STORAGE_KEYS.tourDone,
  digestSettings: STORAGE_KEYS.settings,
  pipeline: STORAGE_KEYS.pipeline,
  feedback: STORAGE_KEYS.feedback,
  manualReviews: STORAGE_KEYS.manualReviews,
  importedTenders: STORAGE_KEYS.importedTenders,
  savedFilters: STORAGE_KEYS.savedFilters,
};

const SYNCED_KEYS = new Set<string>([
  STORAGE_KEYS.searchProfiles,
  STORAGE_KEYS.profile,
  ...Object.values(APP_STATE_KEYS),
]);

/** Пауза перед отправкой: несколько сохранений подряд уходят одним запросом. */
const PUSH_DELAY_MS = 1500;

/** Идёт запись данных аккаунта на устройство — это не правка человека, отправлять нечего. */
let applyingServerData = false;

/** Подписки автоотправки, которые ещё живы: выход отключает их все разом. */
const activeAutoPushStops = new Set<() => void>();

function readLocal(): UserDataSnapshot {
  const appState: AppState = {};
  for (const [field, key] of Object.entries(APP_STATE_KEYS) as Array<[keyof AppState, string]>) {
    const value = readJSON<unknown>(key, null);
    if (value !== null) (appState as Record<string, unknown>)[field] = value;
  }
  return {
    searchProfiles: searchProfileRepository.getAll(),
    companyProfile: readJSON<unknown>(STORAGE_KEYS.profile, null),
    appState,
  };
}

function writeLocal(data: UserDataSnapshot): void {
  applyingServerData = true;
  try {
    // Пустой список не пишем: слияние ничего не удаляет, а чистому устройству лишний ключ не нужен.
    if (data.searchProfiles.length > 0) searchProfileRepository.save(data.searchProfiles);
    if (data.companyProfile !== null) writeJSON(STORAGE_KEYS.profile, data.companyProfile);
    for (const [field, value] of Object.entries(data.appState ?? {})) {
      const key = APP_STATE_KEYS[field as keyof AppState];
      if (key !== undefined && value !== undefined) writeJSON(key, value);
    }
  } finally {
    applyingServerData = false;
  }
}

async function pushLocal(expectedOwner?: string): Promise<void> {
  // Без метки владельца или с чужой данные устройства могут быть чужими: на сервер их не отправляем.
  const owner = readDeviceOwner();
  if (owner === null || (expectedOwner !== undefined && owner !== expectedOwner)) return;
  const local = readLocal();
  await accountApiService.putData({
    searchProfiles: local.searchProfiles,
    companyProfile: local.companyProfile,
    appState: local.appState,
  });
}

export const accountSync = {
  /**
   * Вызывается после входа и при открытии страницы вошедшим.
   * `deviceChanged` — данные на устройстве изменились, странице стоит перечитать их.
   */
  async onSignedIn(): Promise<{ deviceChanged: boolean }> {
    try {
      const state = await accountApiService.me();
      if (state.user === null) return { deviceChanged: false };
      const owner = ownerTag(state.user.email);

      const serverData = await accountApiService.getData();
      const server: UserDataSnapshot = {
        searchProfiles: serverData.searchProfiles,
        companyProfile: serverData.companyProfile,
        appState: serverData.appState ?? {},
      };

      if (readDeviceOwner() !== owner) {
        // Данные устройства чужие или без хозяина: не сливаем и не отправляем, берём аккаунт как есть.
        // Всё ниже синхронное, после ответа сервера: отложенная отправка не успеет
        // увидеть пустое устройство и затереть им аккаунт.
        const hadLocal = clearAccountScopedData();
        writeLocal(server);
        writeDeviceOwner(owner);
        const hasServer =
          server.searchProfiles.length > 0 ||
          server.companyProfile !== null ||
          Object.keys(server.appState ?? {}).length > 0;
        return { deviceChanged: hadLocal || hasServer };
      }

      const local = readLocal();
      const result = mergeUserData(local, server);
      if (result.writeToDevice) writeLocal(result.merged);
      if (result.pushToServer) {
        await accountApiService.putData({
          searchProfiles: result.merged.searchProfiles,
          companyProfile: result.merged.companyProfile,
          appState: result.merged.appState,
        });
      }
      return { deviceChanged: result.writeToDevice };
    } catch {
      return { deviceChanged: false };
    }
  },

  /** После сохранения на устройстве: отправить данные на сервер, если человек вошёл. */
  async pushIfSignedIn(): Promise<void> {
    try {
      const state = await accountApiService.me();
      if (state.user === null) return;
      await pushLocal(ownerTag(state.user.email));
    } catch {
      // Данные на устройстве сохранены; сервер получит их при следующей синхронизации.
    }
  },

  /**
   * Выход: отключить автоотправку и стереть с устройства данные аккаунта вместе
   * с меткой владельца, чтобы следующий человек в этом браузере не получил их.
   * Вызывать после запроса выхода на сервер (даже неудачного).
   */
  onSignedOut(): void {
    for (const stop of [...activeAutoPushStops]) stop();
    clearAccountScopedData();
    clearDeviceOwner();
  },

  /**
   * Для вошедшего: каждое сохранение синхронизируемых данных на устройстве
   * через пару секунд уходит в аккаунт. Возвращает отписку (при выходе).
   */
  startAutoPush(): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onLocalWrite((key) => {
      if (applyingServerData || !SYNCED_KEYS.has(key)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Перед отправкой сверяем, что вошёл владелец данных устройства (метка чужая — не отправляем).
        // Сессия могла истечь или пропала связь — данные устройства уже сохранены.
        void accountSync.pushIfSignedIn();
      }, PUSH_DELAY_MS);
    });
    const stop = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unsubscribe();
      activeAutoPushStops.delete(stop);
    };
    activeAutoPushStops.add(stop);
    return stop;
  },
};
