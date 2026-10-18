import type { SearchProfile } from "@/domain/entities";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { accountSync } from "@/services/accountSync";
import { demandReporter } from "@/services/demandReporter";
import { searchAssistApiService } from "@/services/searchAssistApiService";

/**
 * Быстрый профиль поиска из ответа на «Что вы ищете?»: слова и регионы.
 *
 * Один путь для двух входов — карточки в ленте (QuickProfileCard) и экрана
 * «Быстрый старт» после регистрации: профиль, сохранение, сообщение серверу о
 * теме для планового сбора, отправка в аккаунт и запуск поиска на площадках.
 * Расходиться им незачем: человек получает одно и то же, где бы ни ответил.
 */

/** Слова через запятую, точку с запятой или перевод строки: без пустых и повторов, не больше десяти. */
export function splitWords(raw: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const part of raw.split(/[,;\n]/)) {
    const word = part.replace(/\s+/g, " ").trim();
    if (word === "" || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    words.push(word);
  }
  return words.slice(0, 10);
}

export interface QuickSearchOutcome {
  profile: SearchProfile;
  /** Задание поиска на площадках; null — не запустилось (см. problem). */
  jobId: string | null;
  /** Почему поиск не запустился, готовым текстом для человека. */
  problem: string | null;
}

/**
 * Создаёт профиль поиска по словам и регионам и запускает поиск на площадках.
 * Слов должно быть хотя бы одно — проверяет вызывающий (кнопка неактивна без них).
 */
export async function createQuickSearchProfile(
  words: readonly string[],
  regions: readonly string[],
): Promise<QuickSearchOutcome> {
  const first = words[0];
  if (first === undefined) throw new Error("Нужно хотя бы одно слово.");

  const profile: SearchProfile = {
    id: `sp-${Date.now()}`,
    name: first.length > 40 ? `${first.slice(0, 40)}…` : first,
    laws: ["FZ_44", "FZ_223", "COMMERCIAL"],
    keywords: [...words],
    stopWords: [],
    okpd2Codes: [],
    regions: [...regions],
    customerInns: [],
    minPrice: null,
    maxPrice: null,
    onlyOpenForSubmission: true,
    enabled: true,
  };
  const all = [...searchProfileRepository.getAll(), profile];
  searchProfileRepository.save(all);
  void demandReporter.report(all);
  void accountSync.pushIfSignedIn();

  let problem: string | null = null;
  let jobId: string | null = null;
  try {
    jobId = (await searchAssistApiService.startLive(first, regions, words.slice(1))).jobId;
  } catch (error) {
    // Сервер занят чужим поиском или недоступен: профиль сохранён, тема уйдёт
    // в плановый сбор. Человек должен понимать, почему результатов пока мало.
    problem =
      `${error instanceof Error ? error.message : "Поиск на площадках не запустился."} ` +
      "Профиль сохранён: ваши закупки соберутся при ближайшем плановом сборе.";
  }
  return { profile, jobId, problem };
}
