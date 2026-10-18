"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { SearchProfile } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import {
  konturApiService,
  type KonturSyncResponse,
  type KonturUsageResponse,
} from "@/services/konturApiService";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Counter,
  Field,
  Input,
  Select,
} from "@/components/ui/primitives";
import { formatDate, formatDateTime, joinRuList } from "@/utils/format";
import { freeSourceTitles } from "@/domain/sources";
import {
  konturBlurredFieldLabels,
  konturExpectedSkipReasons,
  konturLimitGroupLabels,
  konturRequestKindLabels,
  konturSkipReasonLabels,
} from "@/lib/labels";
import type { ApiUsageLogRow, KonturRequestKind } from "@/types/database";

const ALL_LAWS: TenderLaw[] = ["FZ_44", "FZ_223", "PP_RF_615", "COMMERCIAL"];

/** Сколько записей журнала показываем. */
const RECENT_LIMIT = 50;

/** Остаток дневного бюджета, при котором стоит предупредить. */
const LOW_BUDGET_LEFT = 10;

/**
 * Бесплатные площадки, которые продолжают наполнять ленту без ключа.
 *
 * Перечень собирает каталог источников: написанный от руки отставал каждый раз,
 * когда подключали новую площадку, и предупреждение об отключённом платном
 * источнике читалось как «закупки больше не собираются вовсе».
 */
const FREE_SOURCES_TEXT = joinRuList(freeSourceTitles());

function statusTone(status: number | null): "olive" | "mustard" | "brick" | "neutral" {
  if (status === null) return "neutral";
  if (status === 429) return "mustard";
  if (status >= 400) return "brick";
  return "olive";
}

function statusLabel(status: number | null): string {
  return status === null ? "нет ответа" : String(status);
}

/** Подпись типа запроса; неизвестное значение показываем как есть. */
function kindLabel(kind: string): string {
  return kind in konturRequestKindLabels
    ? konturRequestKindLabels[kind as KonturRequestKind]
    : kind;
}

/** Подпись группы суточного лимита; неизвестную показываем как есть. */
function limitGroupLabel(group: string): string {
  return konturLimitGroupLabels[group] ?? group;
}

/** Подпись закрашенного поля; неизвестное показываем именем из API. */
function blurredLabel(field: string): string {
  return konturBlurredFieldLabels[field] ?? field;
}

/** Подпись причины отброшенной записи; неизвестную показываем как есть. */
function skipLabel(reason: string): string {
  return konturSkipReasonLabels[reason] ?? reason;
}

/**
 * Причины отброшенных записей со счётчиками, разложенные на штатные и ошибочные.
 *
 * Одна причина повторяется на каждую отброшенную запись, поэтому «отменена,
 * отменена, отменена» сворачиваем в «отменена (3)». Штатные показываем
 * спокойным текстом: отменённая закупка — не потеря данных.
 */
function summarizeSkips(skipped: string[]): { expected: string[]; unexpected: string[] } {
  const counts = new Map<string, number>();
  for (const reason of skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const expected: string[] = [];
  const unexpected: string[] = [];
  for (const [reason, count] of counts) {
    const text = `${skipLabel(reason)} (${count})`;
    (konturExpectedSkipReasons.has(reason) ? expected : unexpected).push(text);
  }
  return { expected, unexpected };
}

/**
 * Расход метода за сутки: «3 / 30», а без дневного бюджета — просто «3».
 * Лимит задаётся на каждый метод отдельно, поэтому и строка своя у каждого.
 */
function spentLabel(spent: number, limit: number | null): string {
  return limit ? `${spent} / ${limit}` : String(spent);
}

/**
 * Панель платного источника Контур.Закупки: расход дневного бюджета,
 * ручной запуск синхронизации и журнал обращений к API.
 *
 * ВНИМАНИЕ: ролевой модели в приложении нет. Пункт «Журнал заданий» из меню
 * убран, чтобы платный запуск не попадался обычному пользователю, но страница
 * /admin/jobs доступна по адресу любому вошедшему — и кнопка запуска вместе
 * с ней. Настоящая защита — отсутствие KONTUR_API_KEY в переменных Vercel и
 * дневной бюджет KONTUR_DAILY_REQUEST_LIMIT, который с 24.09.2026 считается
 * на каждый метод отдельно: боевой тариф даёт 30 поисков и 30 карточек в сутки.
 * Подробности: docs/REFERENCE_KONTUR_API.md.
 */
export function KonturSyncPanel() {
  const [usage, setUsage] = useState<KonturUsageResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<SearchProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [limit, setLimit] = useState("20");
  const [saveDocuments, setSaveDocuments] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [report, setReport] = useState<KonturSyncResponse | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    setLoading(true);
    try {
      setUsage(await konturApiService.getUsage(RECENT_LIMIT));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setProfiles(searchProfileRepository.getAll().filter((p) => p.enabled));
    void loadUsage();
  }, [loadUsage]);

  const profile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? profiles[0] ?? null,
    [profiles, profileId],
  );

  const runSync = async () => {
    if (!profile || syncing) return;
    setSyncing(true);
    setSyncError(null);
    setReport(null);
    try {
      const perKeyword = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
      setReport(
        await konturApiService.sync({
          laws: profile.laws.length > 0 ? profile.laws : ALL_LAWS,
          keywords: profile.keywords,
          excludeKeywords: profile.stopWords,
          regions: profile.regions,
          customerInns: profile.customerInns,
          okpd2Codes: profile.okpd2Codes,
          minPrice: profile.minPrice,
          maxPrice: profile.maxPrice,
          limit: perKeyword,
          saveDocuments,
        }),
      );
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
      // Расход и журнал меняются даже при ошибке — обновляем их в любом случае.
      void loadUsage();
    }
  };

  const tariff = usage?.tariff ?? null;
  // Авторитет — счётчик Контур.Закупок (`/limitGroups`, запрос бесплатный):
  // наш журнал расходится с ним, если ключ тратит кто-то ещё. Остаток из
  // KONTUR_DAILY_REQUEST_LIMIT остаётся страховкой, когда тариф не прочитан.
  const budgetLeft = tariff?.available ?? usage?.remainingToday ?? null;
  const lowBudget = budgetLeft !== null && budgetLeft <= LOW_BUDGET_LEFT;
  const skips = summarizeSkips(report?.skipped ?? []);

  return (
    <Card
      title="Контур.Закупки — платный источник"
      actions={
        <Button size="sm" variant="secondary" onClick={() => void loadUsage()} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5" /> Обновить остаток
        </Button>
      }
    >
      {loadError && (
        <p className="mb-3 text-sm text-brick-fg" role="alert">
          {loadError}
        </p>
      )}

      {usage && !usage.configured && (
        <div className="mb-3 flex gap-2 rounded border border-mustard/40 px-3 py-2 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-mustard-fg" aria-hidden />
          <p>
            KONTUR_API_KEY не задан — источник отключён, запросы к платному API не выполняются.
            Закупки продолжают собираться с бесплатных площадок: {FREE_SOURCES_TEXT}. Порядок
            подключения описан в docs/REFERENCE_KONTUR_API.md.
          </p>
        </div>
      )}

      {loading && !usage ? (
        <p className="muted">Загрузка расхода API…</p>
      ) : usage ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {/*
              * Расход по методам, а не одной суммой: тариф даёт 30 запросов в
              * сутки на поиск и 30 на карточки независимо, поэтому «12 / 30»
              * общей строкой вводило бы в заблуждение — кончиться может один
              * метод, а второй остаётся полным.
              */}
            <Counter
              label="Поиск сегодня"
              value={spentLabel(usage.spentTodayByMethod.search, usage.dailyRequestLimit)}
            />
            <Counter
              label="Карточки сегодня"
              value={spentLabel(usage.spentTodayByMethod.card, usage.dailyRequestLimit)}
            />
            <Counter
              label="Остаток по тарифу"
              value={budgetLeft === null ? "нет данных" : String(budgetLeft)}
              tone={lowBudget ? "danger" : "default"}
            />
            <Counter label="Ответов из кэша" value={String(usage.summary.cacheHits)} />
            <Counter label="Сырых ответов в БД" value={String(usage.storedResponses)} />
          </div>

          {lowBudget && (
            <p className="mt-2 text-xs text-brick-fg">
              Дневной бюджет почти исчерпан. Следующая синхронизация прервётся с кодом 429 —
              это защита от лишних списаний, а не ошибка.
            </p>
          )}

          {usage.tariffError && (
            <p className="mt-2 text-xs text-mustard-fg">
              Остаток по тарифу не прочитан: {usage.tariffError}. Журнал обращений и счётчик
              ниже при этом остаются достоверными.
            </p>
          )}

          {tariff && tariff.groups.length > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <h3 className="label mb-2">Остаток суточного лимита по группам тарифа</h3>
              <ul className="grid gap-2 sm:grid-cols-3">
                {tariff.groups.map((group) => (
                  <li key={group.limitGroup} className="rounded border border-border px-3 py-2">
                    <p className="text-sm text-foreground">{limitGroupLabel(group.limitGroup)}</p>
                    <p className="num mt-1 text-lg">
                      {group.availableRequests} / {group.totalLimit}
                    </p>
                    <p className="mt-1 text-xs text-faint">
                      {group.isPeriodic
                        ? "счётчик обнуляется в 00:00"
                        : "лимит исчерпывается навсегда"}
                      {group.modifiers.length > 0 ? ` · ${group.modifiers.join(", ")}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
              {tariff.subscriptionEnd && (
                <p className="muted mt-2">
                  Тариф действует до {formatDate(tariff.subscriptionEnd)}. После этой даты любой
                  запрос вернёт 401: нужен продлённый тариф или новый ключ. Ключом записи служит
                  номер извещения, поэтому смена ключа сохранённые закупки не двоит: тестовый
                  ключ номер скрывает, и парсер восстанавливает его из внутреннего Id источника.
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-3">
            <Field label="Профиль поиска">
              <Select
                className="w-72"
                value={profile?.id ?? ""}
                onChange={(e) => setProfileId(e.target.value)}
                aria-label="Профиль поиска для синхронизации"
              >
                {profiles.length === 0 && <option value="">Нет включённых профилей</option>}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Закупок на слово" hint="Каждое слово — отдельный поиск">
              <Input
                type="number"
                min={1}
                max={100}
                className="w-28"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                aria-label="Сколько закупок запрашивать на одно ключевое слово"
              />
            </Field>

            <div className="pb-6">
              <Checkbox
                label="Сохранять документы"
                checked={saveDocuments}
                onChange={(e) => setSaveDocuments(e.target.checked)}
              />
            </div>

            <div className="pb-5">
              <Button
                onClick={() => void runSync()}
                disabled={syncing || !profile || !usage.configured}
              >
                <RefreshCw className={syncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                {syncing ? "Синхронизация…" : "Синхронизировать сейчас"}
              </Button>
            </div>
          </div>

          {profile && (
            <p className="muted mt-2">
              Запросов к API: до {profile.keywords.length} (по одному на ключевое слово:{" "}
              {profile.keywords.slice(0, 4).join(", ")}
              {profile.keywords.length > 4 ? "…" : ""}). Повторный поиск с теми же фильтрами
              берётся из кэша и бюджет не расходует.
            </p>
          )}

          {syncError && (
            <p className="mt-3 text-sm text-brick-fg" role="alert">
              {syncError}
            </p>
          )}

          {report && (
            <div className="mt-3 rounded border border-border px-3 py-2 text-sm">
              <p className="text-foreground">
                Поисков: {report.searches} · найдено {report.synced} · новых {report.created} ·
                обновлено {report.updated} · документов {report.documents}
              </p>
              <p className="muted mt-1">
                Платных запросов: {report.apiCalls} · из кэша: {report.cacheHits} · всего
                за сегодня: {report.requestsToday}
                {report.availableRequests !== null
                  ? ` · остаток по тарифу: ${report.availableRequests}`
                  : ""}
              </p>
              {skips.expected.length > 0 && (
                <p className="muted mt-1 text-xs">
                  Отброшено штатно: {skips.expected.join(", ")} — участвовать в таких закупках
                  нельзя, это не потеря данных.
                </p>
              )}
              {skips.unexpected.length > 0 && (
                <p className="mt-1 text-xs text-mustard-fg">
                  Ответ не прочитан: {skips.unexpected.join(", ")}. Сырые ответы лежат
                  в kontur_raw_responses — их можно разобрать повторно, ничего не тратя.
                </p>
              )}
              {report.filteredOut > 0 && (
                <p className="muted mt-1 text-xs">
                  Отсеяно фильтром региона или ОКПД2: {report.filteredOut}. Контур.Закупки
                  не принимают эти параметры в поиске, поэтому выдача отбирается уже после
                  ответа; сам запрос при этом оплачен.
                </p>
              )}
              {report.duplicates > 0 && (
                <p className="muted mt-1 text-xs">
                  Уже в базе от другого источника: {report.duplicates}. Контур.Закупки —
                  агрегатор тех же извещений, что публикует ЕИС, поэтому совпадение номера —
                  норма: строку первоисточника мы не перезаписываем и дубль не создаём.
                </p>
              )}
              {report.blurredFields.length > 0 && (
                <p className="mt-1 text-xs text-mustard-fg">
                  Тариф ключа скрывает значения: источник не отдал{" "}
                  {report.blurredFields.map(blurredLabel).join(", ")}
                  {report.blurredDocuments > 0
                    ? ` и ссылки в документах (${report.blurredDocuments} шт.)`
                    : ""}
                  . В сохранённых закупках эти поля пусты — не ошибка разбора, а отсутствие
                  данных: по ним нельзя проверить ни регион, ни заказчика. Боевой тариф отдаёт
                  их целиком, поэтому сообщение означает понижение тарифа или ключ без нужной
                  группы методов.
                </p>
              )}
              {report.documentsError && (
                <p className="mt-1 text-xs text-brick-fg">
                  Документы не сохранены: {report.documentsError}
                </p>
              )}
              {report.errors.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-xs text-brick-fg">
                  {report.errors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="mt-4 border-t border-border pt-3">
            <h3 className="label mb-2">Последние обращения к API</h3>
            {usage.recent.length === 0 ? (
              <p className="muted">
                Обращений ещё не было. Если миграция 20260921000003 не применена, журнал
                и кэш сырых ответов не ведутся.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left muted">
                      <th className="px-2 py-2 font-medium">Время</th>
                      <th className="px-2 py-2 font-medium">Тип</th>
                      <th className="px-2 py-2 font-medium">Статус</th>
                      <th className="px-2 py-2 font-medium">Источник ответа</th>
                      <th className="px-2 py-2 font-medium">Длительность</th>
                      <th className="px-2 py-2 font-medium">Ошибка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.recent.map((entry: ApiUsageLogRow) => (
                      <tr key={entry.id} className="border-b border-border last:border-0">
                        <td className="num whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                          {formatDateTime(entry.requested_at)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-foreground">
                          {kindLabel(entry.kind)}
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge tone={statusTone(entry.status)} dot={false}>
                            {statusLabel(entry.status)}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {entry.from_cache ? "кэш" : "платный запрос"}
                        </td>
                        <td className="num whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                          {entry.duration_ms} мс
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {entry.error ? (
                            <span className="text-brick-fg">{entry.error}</span>
                          ) : (
                            <span className="num text-faint">{entry.url}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </Card>
  );
}
