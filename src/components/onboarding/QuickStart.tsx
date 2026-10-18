"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { LogoMark } from "@/components/brand/LogoMark";
import { Button, Card, Field, Input } from "@/components/ui/primitives";
import { RegionPicker } from "@/components/ui/RegionPicker";
import { savePendingFirstSearch } from "@/domain/pendingFirstSearch";
import { canonicalRegionNames } from "@/domain/regionCodes";
import { STORAGE_KEYS, writeJSON } from "@/lib/storage";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { accountSync } from "@/services/accountSync";
import { createQuickSearchProfile, splitWords } from "@/services/quickProfile";

/**
 * «Быстрый старт» вместо восьмишаговой анкеты после регистрации.
 *
 * Владелец: упростить анкету максимально, профиль поиска и компании человек
 * заполнит сам, когда захочет. Поэтому два вопроса — что делаете и где — и
 * сразу лента с поиском на площадках. Лицензии, СРО, персонал и финансы
 * спрашивать на входе незачем: без них лента уже работает, а каждый лишний
 * шаг отсекал людей до первой пользы.
 *
 * Ответ сохраняется так же, как в ленте (`createQuickSearchProfile`), и,
 * кроме того, попадает в профиль компании — но только в пустые поля: то, что
 * человек уже вносил (например, на другом устройстве), не затирается.
 */

const TOUR_TARGET = "/tenders?tour=1";

export function QuickStart() {
  const router = useRouter();
  const [words, setWords] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const priority = companyProfileRepository.get().preferences.priorityRegions;
      setRegions(canonicalRegionNames(priority).slice(0, 5));
    } catch {
      // Профиля компании нет — регион человек укажет сам или оставит пустым.
    }
  }, []);

  /** Отметка онбординга уходит и в аккаунт: после выхода и входа анкету не спрашивают снова. */
  const markDone = (): void => {
    writeJSON(STORAGE_KEYS.onboardingDone, true);
    void accountSync.pushIfSignedIn();
  };

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (busy) return;
    const keywords = splitWords(words);
    if (keywords.length === 0) {
      setError("Напишите, что вы делаете или поставляете, — без этого нечего искать.");
      return;
    }
    setError(null);
    setBusy(true);
    const startedAt = new Date().toISOString();
    const { profile, jobId, problem } = await createQuickSearchProfile(keywords, regions);

    // В профиль компании — только в пустые поля: заполненное человеком важнее ответа на бегу.
    const company = companyProfileRepository.get();
    const priorityRegions = company.preferences.priorityRegions.filter((r) => r.trim() !== "");
    const next = {
      ...company,
      activityDescription: company.activityDescription.trim() === "" ? keywords.join(", ") : company.activityDescription,
      preferences: {
        ...company.preferences,
        priorityRegions: priorityRegions.length === 0 ? [...regions] : company.preferences.priorityRegions,
      },
    };
    companyProfileRepository.save(next);

    // Ленте — следить за запущенным поиском: она другая страница.
    savePendingFirstSearch({ jobId, startedAt, queries: profile.keywords, problem });
    markDone();
    router.push(TOUR_TARGET);
  };

  const skip = (): void => {
    markDone();
    router.push(TOUR_TARGET);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-xl">
        <div className="mb-5 flex justify-center">
          <LogoMark size={40} />
        </div>
        <Card>
          <form onSubmit={(e) => void submit(e)} noValidate>
            <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-foreground">Что вы ищете?</h1>
            <p className="mt-2 text-[15px] text-muted-foreground">
              Два вопроса — и покажем ваши закупки. Профиль компании и лицензии можно заполнить потом.
            </p>
            <div className="mt-5 space-y-4">
              <Field
                label="Что вы делаете или поставляете"
                hint="Через запятую, как называют заказчики: ремонт кровли, фасадные работы"
                error={error ?? undefined}
              >
                <Input
                  aria-label="Что вы делаете или поставляете"
                  aria-required="true"
                  aria-invalid={error !== null}
                  autoFocus
                  value={words}
                  onChange={(e) => {
                    setWords(e.target.value);
                    if (error !== null) setError(null);
                  }}
                />
              </Field>
              <Field label="Регион" hint="Пусто — вся Россия">
                <RegionPicker values={regions} onChange={setRegions} max={5} />
              </Field>
            </div>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button type="submit" size="lg" loading={busy} className="w-full sm:w-auto">
                {busy ? "Запускаю поиск…" : "Показать мои закупки"}
              </Button>
              <button
                type="button"
                onClick={skip}
                disabled={busy}
                className="self-center text-sm text-muted-foreground underline hover:text-foreground disabled:opacity-50"
              >
                Пропустить — заполню позже
              </button>
            </div>
          </form>
        </Card>
      </div>
    </main>
  );
}
