"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { SearchProfile, TenderLaw } from "@/domain/entities";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { Button, Card, Checkbox, Field, Input } from "@/components/ui/primitives";
import { TagListInput } from "@/components/onboarding/TagListInput";
import { RegionPicker } from "@/components/ui/RegionPicker";
import { lawLabels } from "@/lib/labels";
import { formatCompactRub } from "@/utils/format";
import { accountSync } from "@/services/accountSync";
import { demandReporter } from "@/services/demandReporter";

const ALL_LAWS: TenderLaw[] = ["FZ_44", "FZ_223", "PP_RF_615", "COMMERCIAL"];

function emptyProfile(): SearchProfile {
  return {
    id: `sp-${Date.now()}`,
    name: "",
    // Коммерческие включены сразу: это главное отличие сервиса, и профиль без
    // них прятал бы такие закупки из ленты — закон профиля работает как фильтр.
    laws: ["FZ_44", "FZ_223", "COMMERCIAL"],
    keywords: [],
    stopWords: [],
    okpd2Codes: [],
    regions: [],
    customerInns: [],
    minPrice: null,
    maxPrice: null,
    onlyOpenForSubmission: true,
    enabled: true,
  };
}

function SearchProfileForm({
  profile,
  onSave,
  onCancel,
}: {
  profile: SearchProfile;
  onSave: (p: SearchProfile) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<SearchProfile>(profile);
  const patch = (p: Partial<SearchProfile>) => setDraft((d) => ({ ...d, ...p }));
  const nameError = draft.name.trim().length < 2 ? "Укажите название профиля" : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);

  const handleCancel = () => {
    if (
      dirty &&
      !window.confirm("Несохранённые изменения будут потеряны. Закрыть форму?")
    ) {
      return;
    }
    onCancel();
  };

  return (
    <Card
      title={profile.name ? `Профиль: ${profile.name}` : "Новый профиль поиска"}
      actions={
        <div className="flex items-center gap-2">
          {nameError && (
            <span className="text-xs text-mustard-fg">
              Без названия сохранение недоступно
            </span>
          )}
          <Button size="sm" variant="secondary" onClick={handleCancel}>
            Отмена
          </Button>
          <Button size="sm" disabled={nameError !== null} onClick={() => onSave(draft)}>
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Название" error={nameError ?? undefined}>
          <Input
            value={draft.name}
            placeholder="Например: Оргтехника — Москва"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label="Законы">
          <div className="flex gap-4 pt-2">
            {ALL_LAWS.map((law) => (
              <Checkbox
                key={law}
                label={lawLabels[law]}
                checked={draft.laws.includes(law)}
                onChange={() =>
                  patch({
                    laws: draft.laws.includes(law)
                      ? draft.laws.filter((l) => l !== law)
                      : [...draft.laws, law],
                  })
                }
              />
            ))}
          </div>
        </Field>
        <Field label="Ключевые слова">
          <TagListInput
            values={draft.keywords}
            onChange={(v) => patch({ keywords: v })}
            placeholder="Введите слово и нажмите Enter"
          />
        </Field>
        <Field label="Стоп-слова">
          <TagListInput
            values={draft.stopWords}
            onChange={(v) => patch({ stopWords: v })}
            placeholder="Введите слово и нажмите Enter"
          />
        </Field>
        <Field label="ОКПД2" hint="Необязательно. Учитывается при сборе новых закупок.">
          <TagListInput
            values={draft.okpd2Codes}
            onChange={(v) => patch({ okpd2Codes: v })}
            placeholder="Например: 26.20, затем Enter"
          />
        </Field>
        <Field
          label="Регионы"
          hint="Пусто — вся Россия. Не больше пяти."
        >
          <RegionPicker
            values={draft.regions}
            onChange={(v) => patch({ regions: v })}
            max={5}
          />
        </Field>
        <Field
          label="ИНН заказчиков"
          hint="Необязательно, например 7708503727"
        >
          <TagListInput
            values={draft.customerInns}
            onChange={(v) =>
              patch({ customerInns: v.map((x) => x.replace(/\D/g, "")) })
            }
            placeholder="Введите ИНН и нажмите Enter"
          />
        </Field>
        <Field label="Цена от, ₽">
          <Input
            type="number"
            min={0}
            value={draft.minPrice ?? ""}
            onChange={(e) =>
              patch({ minPrice: e.target.value === "" ? null : Number(e.target.value) })
            }
          />
        </Field>
        <Field label="Цена до, ₽">
          <Input
            type="number"
            min={0}
            value={draft.maxPrice ?? ""}
            onChange={(e) =>
              patch({ maxPrice: e.target.value === "" ? null : Number(e.target.value) })
            }
          />
        </Field>
      </div>
      <div className="flex gap-6 pt-3">
        <Checkbox
          label="Только с открытой подачей заявок"
          checked={draft.onlyOpenForSubmission}
          onChange={(e) => patch({ onlyOpenForSubmission: e.target.checked })}
        />
        <Checkbox
          label="Профиль включён"
          checked={draft.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
      </div>
    </Card>
  );
}

export function SearchProfilesView() {
  const [profiles, setProfiles] = useState<SearchProfile[]>([]);
  const [editing, setEditing] = useState<SearchProfile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setProfiles(searchProfileRepository.getAll());
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  const persist = (next: SearchProfile[]) => {
    setProfiles(next);
    searchProfileRepository.save(next);
    void demandReporter.report(next);
    void accountSync.pushIfSignedIn();
  };

  const save = (p: SearchProfile) => {
    const exists = profiles.some((x) => x.id === p.id);
    persist(exists ? profiles.map((x) => (x.id === p.id ? p : x)) : [...profiles, p]);
    setEditing(null);
    setNotice(`Профиль «${p.name}» сохранён`);
  };

  const remove = (id: string) => persist(profiles.filter((p) => p.id !== id));

  const toggle = (id: string) =>
    persist(
      profiles.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)),
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Что ищем</h1>
        <Button onClick={() => setEditing(emptyProfile())} disabled={editing !== null}>
          <Plus className="h-4 w-4" /> Новый профиль
        </Button>
      </div>

      {notice && (
        <div
          role="status"
          className="rounded-md border border-olive/40 bg-olive/10 px-3 py-2 text-sm text-olive-fg"
        >
          {notice}
        </div>
      )}

      {editing && (
        <SearchProfileForm
          profile={editing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {profiles.length === 0 && !editing && (
        <Card>
          <p className="muted">Профилей поиска нет — создайте первый.</p>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {profiles.map((p) => (
          <Card key={p.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-foreground">{p.name}</p>
                <p className="muted text-xs mt-0.5">
                  {p.laws.map((l) => lawLabels[l]).join(", ")} ·{" "}
                  {p.regions.length > 0 ? p.regions.join(", ") : "все регионы"}
                  {p.minPrice != null || p.maxPrice != null
                    ? ` · ${priceRangeText(p.minPrice, p.maxPrice)}`
                    : ""}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Ключевые слова: {p.keywords.join(", ") || "—"}
                </p>
                {p.customerInns.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Заказчики (ИНН): {p.customerInns.join(", ")}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                  Изменить
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Удалить профиль ${p.name}`}
                  onClick={() => remove(p.id)}
                >
                  <Trash2 className="h-4 w-4 text-brick-fg" />
                </Button>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
              <Checkbox
                label="Включён"
                checked={p.enabled}
                onChange={() => toggle(p.id)}
              />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** «1 млн – 9 млн ₽», «до 700 млн ₽», «от 30 тыс ₽»: «1000000—9000000 ₽» приходилось считать по разрядам. */
function priceRangeText(min: number | null, max: number | null): string {
  const from = min != null && min > 0 ? formatCompactRub(min) : null;
  const to = max != null && max > 0 ? formatCompactRub(max) : null;
  if (from !== null && to !== null) return `${from.replace(/ ₽$/, "")} – ${to}`;
  if (to !== null) return `до ${to}`;
  if (from !== null) return `от ${from}`;
  return "любая цена";
}
