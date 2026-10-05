"use client";

import { useEffect, useState } from "react";

import { Button, Card, Field, Input } from "@/components/ui/primitives";
import type { SearchProfile } from "@/domain/entities";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { accountSync } from "@/services/accountSync";
import { demandReporter } from "@/services/demandReporter";
import { searchAssistApiService } from "@/services/searchAssistApiService";

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

function splitWords(raw: string): string[] {
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
  const [region, setRegion] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    try {
      const priority = companyProfileRepository.get().preferences.priorityRegions.filter((r) => r.trim() !== "");
      if (priority.length > 0) setRegion(priority.join(", "));
    } catch {
      // Профиля компании нет — регион человек укажет сам.
    }
  }, []);

  const keywords = splitWords(words);
  const regions = splitWords(region);

  const save = async () => {
    const first = keywords[0];
    if (first === undefined) return;
    setBusy(true);
    setNote(null);

    const profile: SearchProfile = {
      id: `sp-${Date.now()}`,
      name: first.length > 40 ? `${first.slice(0, 40)}…` : first,
      laws: ["FZ_44", "FZ_223", "COMMERCIAL"],
      keywords,
      stopWords: [],
      okpd2Codes: [],
      regions,
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
      jobId = (await searchAssistApiService.startLive(first, regions, keywords.slice(1))).jobId;
    } catch (error) {
      // Сервер занят чужим поиском или недоступен: профиль сохранён, тема уйдёт
      // в плановый сбор. Человек должен понимать, почему результатов пока мало.
      problem =
        `${error instanceof Error ? error.message : "Поиск на площадках не запустился."} ` +
        "Профиль сохранён: ваши закупки соберутся при ближайшем плановом сборе.";
      setNote(problem);
    }
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
          <Input aria-label="Регион" value={region} onChange={(e) => setRegion(e.target.value)} />
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
