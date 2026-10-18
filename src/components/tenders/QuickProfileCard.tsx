"use client";

import { useEffect, useState } from "react";

import { Button, Card, Field, Input } from "@/components/ui/primitives";
import { RegionPicker } from "@/components/ui/RegionPicker";
import { canonicalRegionNames } from "@/domain/regionCodes";
import type { SearchProfile } from "@/domain/entities";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { createQuickSearchProfile, splitWords } from "@/services/quickProfile";

/**
 * Первый вход без профиля поиска: «что вы ищете?».
 *
 * База закупок общая — это публичные данные, и собирать одно и то же для
 * каждого клиента отдельно незачем. Но лента обязана показывать человеку его
 * темы, а не чужие: без профиля он видел закупки, собранные под профили
 * других (у владельца — стройку в Бурятии). Поэтому сначала вопрос.
 *
 * После ответа: слова и регион сохраняются его профилем (и в аккаунт, если он
 * вошёл), сервер узнаёт о теме для планового сбора, и сразу запускается поиск
 * на площадках по его региону — ждать двухчасового сбора не нужно.
 */

export function QuickProfileCard({
  onSaved,
  onShowAll,
}: {
  /** Профиль сохранён: лента применяет его и перечитывает базу по окончании поиска. */
  onSaved: (profile: SearchProfile, outcome: { jobId: string | null; problem: string | null }) => void;
  /** Человек сам попросил показать всю общую базу. */
  onShowAll: () => void;
}) {
  const [words, setWords] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    try {
      const priority = companyProfileRepository.get().preferences.priorityRegions;
      setRegions(canonicalRegionNames(priority).slice(0, 5));
    } catch {
      // Профиля компании нет — регион человек укажет сам.
    }
  }, []);

  const keywords = splitWords(words);

  const save = async () => {
    if (keywords.length === 0) return;
    setBusy(true);
    setNote(null);

    const { profile, jobId, problem } = await createQuickSearchProfile(keywords, regions);
    if (problem !== null) setNote(problem);
    setBusy(false);
    onSaved(profile, { jobId, problem });
  };

  return (
    <Card title="Что вы ищете?">
      <p className="text-sm text-muted-foreground">
        Покажем только ваши закупки. Напишите, что вы поставляете или выполняете, — через запятую,
        как это называют заказчики. Поиск сразу пойдёт по площадкам в вашем регионе.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Что ищете" hint="Например: ремонт кровли, фасадные работы">
          <Input aria-label="Что ищете" value={words} onChange={(e) => setWords(e.target.value)} />
        </Field>
        <Field label="Регион" hint="Пусто — вся Россия">
          <RegionPicker values={regions} onChange={setRegions} max={5} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={keywords.length === 0 || busy}>
          {busy ? "Запускаю поиск…" : "Сохранить и искать"}
        </Button>
        <button type="button" className="text-sm text-muted-foreground underline hover:text-foreground" onClick={onShowAll}>
          Показать всю базу закупок
        </button>
      </div>
      {note && (
        <p role="status" className="mt-3 text-sm text-mustard-fg">
          {note}
        </p>
      )}
    </Card>
  );
}
