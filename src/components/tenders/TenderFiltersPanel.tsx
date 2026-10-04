"use client";

import { useEffect, useState } from "react";
import { Bookmark, ChevronDown, RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import type {
  PipelineStatus,
  TenderDataSource,
  TenderVerdict,
} from "@/domain/enums";
import type { TenderFilters as Filters } from "@/domain/filtering";
import { defaultFilters } from "@/domain/filtering";
import { countActiveFilters } from "@/domain/filterUrl";
import { scopeShortLabels } from "@/domain/searchRanking";
import { ALL_SCOPES, type SearchScope } from "@/domain/textSearch";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";
import { Button, Checkbox, Field, Input, Select } from "@/components/ui/primitives";
import {
  closingSoonLabel,
  dataSourceLabels,
  pipelineLabels,
  pipelineOrder,
  priceVisibilityHints,
  priceVisibilityLabels,
  searchControlLabels,
  verdictLabels,
} from "@/lib/labels";
import { cn } from "@/lib/cn";

function triState(value: boolean | null): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "all";
}

function parseTriState(v: string): boolean | null {
  if (v === "yes") return true;
  if (v === "no") return false;
  return null;
}

/**
 * Разбирает строку исключений на слова.
 *
 * Разделители — запятая, точка с запятой и перевод строки: пользователь пишет
 * «б/у, аренда» и ждёт два исключения, а не одно длинное.
 */
function parseWordList(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * Сколько ограничений включено среди дополнительных.
 *
 * Список ровно соответствует блоку «Ещё фильтры»: основные (регион, вердикт,
 * вилка цены, «закрывается скоро») видны всегда и в счётчик не входят — иначе
 * бейдж утверждал бы, что за свёрнутым блоком спрятано то, что и так на экране.
 */
function countExtraFilters(f: Filters): number {
  let n = 0;
  if ((f.customerInn ?? "") !== "") n += 1;
  if (f.pipelineStatus !== "ALL") n += 1;
  if (f.hasHardBlockers !== null) n += 1;
  if (f.hasAdvance !== null) n += 1;
  if (f.hasSecurity !== null) n += 1;
  if ((f.sources ?? []).length > 0) n += 1;
  if (f.includeNoPrice === false) n += 1;
  if (f.includeForeignCurrency === false) n += 1;
  return n;
}

/**
 * Панель фильтров таблицы закупок. Поддерживает сохранение одного
 * именованного набора фильтров в localStorage.
 *
 * Закона здесь нет: переключатель по закону (LawSwitcher) вынесен над панелью —
 * это самый частый фильтр, и он должен быть виден вместе со счётчиками.
 * Состояние при этом общее: `filters.laws`.
 */
export function TenderFiltersPanel({
  filters,
  onChange,
  regions,
  sources,
  searchProfiles,
  onApplyProfile,
}: {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  regions: string[];
  /** Площадки-источники, которые встретились в текущей выдаче. */
  sources: TenderDataSource[];
  searchProfiles: { id: string; name: string }[];
  onApplyProfile: (id: string) => void;
}) {
  const [saved, setSaved] = useState<Filters | null>(null);
  // Панель свёрнута по умолчанию: пятнадцать контролов над таблицей мешают
  // видеть саму выдачу. Открыта сразу только когда ограничения уже действуют —
  // иначе свёрнутая панель скрывала бы причину короткого списка.
  const [open, setOpen] = useState(() => countActiveFilters(filters) > 0);

  /*
    Сколько дополнительных ограничений уже действует. Считается по самим
    значениям, а не по флагу открытия: свёрнутый блок обязан сообщить, что
    внутри него что-то включено, иначе короткая выдача выглядит беспричинной.
  */
  const extraCount = countExtraFilters(filters);

  // Дополнительные раскрыты сразу, если среди них уже есть действующие —
  // иначе пользователь не нашёл бы, чем именно урезан список.
  const [moreOpen, setMoreOpen] = useState(() => extraCount > 0);

  useEffect(() => {
    setSaved(readJSON<Filters | null>(STORAGE_KEYS.savedFilters, null));
  }, []);

  const dirty = JSON.stringify({ ...filters, page: 1, pageSize: filters.pageSize }) !==
    JSON.stringify({ ...(saved ?? defaultFilters), page: 1, pageSize: filters.pageSize });
  const activeCount = countActiveFilters(filters);

  // Исключения хранятся списком, а человек печатает их через запятую. Черновик
  // держим отдельно, иначе недонабранная запятая тут же исчезала бы из поля.
  const [excludeDraft, setExcludeDraft] = useState(
    () => filters.excludeKeywords.join(", "),
  );
  useEffect(() => {
    // Синхронизация извне — сброс чипа, применение профиля, «Сбросить».
    // Сравниваем разобранные значения, а не текст: совпадают они и в момент,
    // когда пользователь поставил запятую и ещё не начал следующее слово.
    if (parseWordList(excludeDraft).join(",") !== filters.excludeKeywords.join(",")) {
      setExcludeDraft(filters.excludeKeywords.join(", "));
    }
  }, [excludeDraft, filters.excludeKeywords]);

  const onExcludeChange = (value: string) => {
    setExcludeDraft(value);
    onChange({ excludeKeywords: parseWordList(value), page: 1 });
  };

  // Пустой список областей означает «все» — так устроен поиск и так короче
  // ссылка на выдачу. Рисуем при этом все галочки: пустых областей в природе
  // не бывает, а неотмеченная галочка означала бы «здесь не ищем».
  const activeScopes = filters.scopes.length > 0 ? filters.scopes : ALL_SCOPES;

  const toggleScope = (scope: SearchScope) => {
    const next = ALL_SCOPES.filter(
      (s) => (s === scope ? !activeScopes.includes(s) : activeScopes.includes(s)),
    );
    // Снять последнюю область нельзя: «нигде» неотличимо от «везде», и выдача
    // молча превратилась бы в пустую.
    if (next.length === 0) return;
    onChange({
      scopes: next.length === ALL_SCOPES.length ? [] : [...next],
      page: 1,
    });
  };

  return (
    /* p-5: у класса .card своих отступов нет, и без него поля поиска упирались
       в границу карточки — то же расстояние, что у любой другой панели. */
    <div className="card space-y-3 p-5">
      {/* Поиск всегда на виду: это главный способ найти закупку, и прятать его
          за кнопку «Фильтры» — значит оставлять пользователя без инструмента. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-64 grow">
            <Field label={searchControlLabels.query}>
              <div className="relative">
                <Search
                  className="absolute left-2.5 top-2.5 h-4 w-4 text-faint"
                  aria-hidden
                />
                <Input
                  className="w-full pl-8"
                  value={filters.search}
                  placeholder={searchControlLabels.queryPlaceholder}
                  onChange={(e) => onChange({ search: e.target.value, page: 1 })}
                  aria-label={searchControlLabels.query}
                />
              </div>
            </Field>
          </div>
          <div className="min-w-56">
            <Field label={searchControlLabels.exclude} hint="Через запятую">
              <Input
                className="w-full"
                value={excludeDraft}
                placeholder={searchControlLabels.excludePlaceholder}
                onChange={(e) => onExcludeChange(e.target.value)}
                aria-label={searchControlLabels.exclude}
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Checkbox
            label={searchControlLabels.exact}
            checked={filters.exactMatch}
            onChange={(e) => onChange({ exactMatch: e.target.checked, page: 1 })}
          />
          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <legend className="label float-left mr-3">{searchControlLabels.scopes}</legend>
            {ALL_SCOPES.map((scope) => (
              <Checkbox
                key={scope}
                label={scopeShortLabels[scope]}
                checked={activeScopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
            ))}
          </fieldset>
        </div>
        <p className="muted text-[12.5px]">{searchControlLabels.syntaxHint}</p>
      </div>

      <button
        type="button"
        className="flex w-full items-center justify-between border-t border-border pt-3 text-left"
        aria-expanded={open}
        aria-controls="tender-filters-body"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <SlidersHorizontal className="h-4 w-4 text-faint" strokeWidth={1.75} aria-hidden />
          Фильтры
          {activeCount > 0 && (
            <span className="num rounded-full border border-accent-line bg-accent-subtle px-2 py-[1px] text-[12.5px] font-medium text-accent-fg">
              {activeCount}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 text-faint transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open && (
        <div id="tender-filters-body" className="space-y-4 border-t border-border pt-3">
          {/*
            Часто используемые ограничения — регион, вердикт и вилка цены.
            Остальные восемь живут за «Ещё фильтры»: шестнадцать контролов
            разом перекрывали саму выдачу и заставляли искать нужный глазами.
          */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Регион">
              <Select
                value={filters.region}
                onChange={(e) => onChange({ region: e.target.value, page: 1 })}
                aria-label="Регион"
              >
                <option value="">Все регионы</option>
                {regions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Вердикт">
              <Select
                value={filters.verdict}
                onChange={(e) =>
                  onChange({ verdict: e.target.value as Filters["verdict"], page: 1 })
                }
                aria-label="Вердикт"
              >
                <option value="ALL">Любой</option>
                {(Object.keys(verdictLabels) as TenderVerdict[]).map((v) => (
                  <option key={v} value={v}>
                    {verdictLabels[v]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="НМЦК от, ₽">
              <Input
                type="number"
                min={0}
                value={filters.minPrice ?? ""}
                onChange={(e) =>
                  onChange({
                    minPrice: e.target.value === "" ? null : Number(e.target.value),
                    page: 1,
                  })
                }
                aria-label="Минимальная цена"
              />
            </Field>
            <Field label="НМЦК до, ₽">
              <Input
                type="number"
                min={0}
                value={filters.maxPrice ?? ""}
                onChange={(e) =>
                  onChange({
                    maxPrice: e.target.value === "" ? null : Number(e.target.value),
                    page: 1,
                  })
                }
                aria-label="Максимальная цена"
              />
            </Field>
          </div>

          <Checkbox
            label={closingSoonLabel}
            checked={filters.closingSoonOnly}
            onChange={(e) => onChange({ closingSoonOnly: e.target.checked, page: 1 })}
          />

          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-control py-2 text-left"
            aria-expanded={moreOpen}
            aria-controls="tender-filters-more"
            onClick={() => setMoreOpen((v) => !v)}
          >
            <span className="text-[14.5px] font-medium text-accent-fg">
              {moreOpen ? "Скрыть дополнительные" : "Ещё фильтры"}
              {!moreOpen && extraCount > 0 && (
                <span className="num ml-2 rounded-full bg-accent-subtle px-2 py-0.5 text-[12.5px] text-accent-fg">
                  {extraCount}
                </span>
              )}
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-faint transition-transform",
                moreOpen && "rotate-180",
              )}
              aria-hidden
            />
          </button>

          {moreOpen && (
            <div id="tender-filters-more" className="space-y-4 border-t border-border pt-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="ИНН заказчика" hint="Точное совпадение">
                  <Input
                    inputMode="numeric"
                    value={filters.customerInn ?? ""}
                    placeholder="7708503727"
                    onChange={(e) =>
                      onChange({
                        customerInn: e.target.value.replace(/\D/g, "").slice(0, 12),
                        page: 1,
                      })
                    }
                    aria-label="ИНН заказчика"
                  />
                </Field>

                <Field label="Статус воронки">
                  <Select
                    value={filters.pipelineStatus}
                    onChange={(e) =>
                      onChange({
                        pipelineStatus: e.target.value as PipelineStatus | "ALL",
                        page: 1,
                      })
                    }
                    aria-label="Статус воронки"
                  >
                    <option value="ALL">Любой</option>
                    {pipelineOrder.map((s) => (
                      <option key={s} value={s}>
                        {pipelineLabels[s]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Стоп-факторы">
                  <Select
                    value={triState(filters.hasHardBlockers)}
                    onChange={(e) =>
                      onChange({ hasHardBlockers: parseTriState(e.target.value), page: 1 })
                    }
                    aria-label="Наличие блокеров"
                  >
                    <option value="all">Не важно</option>
                    <option value="yes">Есть</option>
                    <option value="no">Нет</option>
                  </Select>
                </Field>

                <Field label="Аванс">
                  <Select
                    value={triState(filters.hasAdvance)}
                    onChange={(e) =>
                      onChange({ hasAdvance: parseTriState(e.target.value), page: 1 })
                    }
                    aria-label="Наличие аванса"
                  >
                    <option value="all">Не важно</option>
                    <option value="yes">Есть</option>
                    <option value="no">Нет</option>
                  </Select>
                </Field>

                <Field label="Обеспечение">
                  <Select
                    value={triState(filters.hasSecurity)}
                    onChange={(e) =>
                      onChange({ hasSecurity: parseTriState(e.target.value), page: 1 })
                    }
                    aria-label="Наличие обеспечения"
                  >
                    <option value="all">Не важно</option>
                    <option value="yes">Есть</option>
                    <option value="no">Нет</option>
                  </Select>
                </Field>

                <Field label="Профиль поиска">
                  <Select
                    aria-label="Профиль поиска"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) onApplyProfile(e.target.value);
                    }}
                  >
                    <option value="">Не выбран</option>
                    {searchProfiles.map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Источник">
                  <Select
                    value={(filters.sources ?? [])[0] ?? ""}
                    onChange={(e) =>
                      onChange({
                        sources: e.target.value ? [e.target.value as TenderDataSource] : [],
                        page: 1,
                      })
                    }
                    aria-label="Площадка-источник"
                  >
                    <option value="">Все площадки</option>
                    {sources.map((source) => (
                      <option key={source} value={source}>
                        {dataSourceLabels[source]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              {/* Переключатели в духе Контур.Закупок: у коммерческих торгов цены
                  часто нет вовсе, и диапазон «от … ₽» не должен их вычёркивать. */}
              <div className="flex flex-col gap-2">
                <Checkbox
                  label={priceVisibilityLabels.includeUnknown}
                  title={priceVisibilityHints.includeUnknown}
                  checked={filters.includeNoPrice ?? true}
                  onChange={(e) => onChange({ includeNoPrice: e.target.checked, page: 1 })}
                />
                <Checkbox
                  label={priceVisibilityLabels.includeForeignCurrency}
                  title={priceVisibilityHints.includeForeignCurrency}
                  checked={filters.includeForeignCurrency ?? true}
                  onChange={(e) =>
                    onChange({ includeForeignCurrency: e.target.checked, page: 1 })
                  }
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                writeJSON(STORAGE_KEYS.savedFilters, filters);
                setSaved(filters);
              }}
            >
              <Bookmark className="h-3.5 w-3.5" /> Сохранить фильтр
            </Button>
            {saved && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onChange({ ...defaultFilters, ...saved, page: 1 })}
                disabled={!dirty}
              >
                Применить сохранённый
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...defaultFilters })}>
              <RotateCcw className="h-3.5 w-3.5" /> Сбросить
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
