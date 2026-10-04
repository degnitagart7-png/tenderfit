"use client";

import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { SearchProfile } from "@/domain/entities";
import { MAX_SEARCHES_PER_PRESS, type KonturPressPlan } from "@/domain/konturPressPlan";
import type {
  KonturDocumentsQueue,
  KonturUsageResponse,
} from "@/services/konturApiService";
import type { KonturSyncReport } from "@/hooks/useTenderData";
import { Button, Field, Select } from "@/components/ui/primitives";
import { konturBlurredFieldLabels } from "@/lib/labels";
import { formatDateTime, pluralRu } from "@/utils/format";
import { cn } from "@/lib/cn";

/**
 * Остаток платных поисков.
 *
 * Авторитет — группа `search` тарифа Контур.Закупок: её читает сам источник
 * (`/limitGroups`, запрос бесплатный), и именно по ней роут отказывает с 429.
 * Когда тариф не прочитан, показываем наш суточный бюджет из
 * `KONTUR_DAILY_REQUEST_LIMIT` — он страховка, а не счётчик источника, поэтому
 * подписан иначе.
 */
function searchBudget(
  usage: KonturUsageResponse | null,
): { available: number | null; total: number | null; fromTariff: boolean } {
  const group = usage?.tariff?.groups.find((item) => item.limitGroup === "search") ?? null;
  if (group) {
    return { available: group.availableRequests, total: group.totalLimit, fromTariff: true };
  }
  return {
    available: usage?.remainingTodayByMethod.search ?? null,
    total: usage?.dailyRequestLimit ?? null,
    fromTariff: false,
  };
}

/** «1 платный поиск», «до 3 платных поисков»: число в панели живое. */
function spendPhrase(spend: number): string {
  return spend === 1
    ? "Потратит 1 платный поиск"
    : `Потратит до ${spend} платных поисков`;
}

/**
 * Вторичный раздел панели: платный поиск в Контур.Закупках.
 *
 * Раздел не обязателен и не опорный: лента пополняется бесплатным прогоном, а
 * этот поиск стоит денег из суточного тарифа и доступен только пока источник
 * настроен. Поэтому он показан ниже основного действия и открывается одной из
 * трёх фраз, когда запустить его нельзя — ключ не задан или нет профиля.
 *
 * Нажатие не тратит бюджет само по себе: план (`konturPressPlan`) считается один
 * раз, показывается до запуска и он же уходит в запрос, поэтому показанное число
 * поисков не может разойтись с фактическим.
 */
export function KonturPressSection({
  profiles,
  plan,
  usage,
  usageLoading,
  usageError,
  syncing,
  onSelectProfile,
  onRun,
  onCancel,
}: {
  /** Включённые профили поиска из этого браузера. */
  profiles: SearchProfile[];
  plan: KonturPressPlan;
  usage: KonturUsageResponse | null;
  usageLoading: boolean;
  usageError: string | null;
  syncing: boolean;
  onSelectProfile: (id: string) => void;
  onRun: (plan: KonturPressPlan) => void;
  onCancel: () => void;
}) {
  const budget = searchBudget(usage);
  const budgetText =
    budget.available === null
      ? "остаток не прочитан"
      : `остаток ${budget.available}${budget.total === null ? "" : ` из ${budget.total}`}`;

  if (usage?.configured === false) {
    return (
      <div className="flex items-start gap-2 rounded-control border border-mustard/40 px-3 py-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-mustard-fg" aria-hidden />
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Контур.Закупки не подключены: ключ источника не задан на сервере. Лента
          пополняется бесплатными площадками — их опрашивает прогон выше.
        </p>
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="space-y-2 rounded-control border border-border px-4 py-3">
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Нет включённого профиля поиска — платному поиску нечего искать.
        </p>
        <Link href="/settings/search">
          <Button size="sm" variant="secondary">
            Указать, что ищем
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-control border border-border px-4 py-3">
      <div className="space-y-1.5">
        <h3 className="text-[14.5px] font-semibold text-foreground">
          Платный поиск в Контур.Закупках
        </h3>
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Прогон платный: каждое ключевое слово — один поиск из суточного
          тарифа. Источник отвечает серверу напрямую, поэтому результат виден
          сразу, а документацию к найденным закупкам ставит в очередь сервер в
          России.
        </p>
      </div>

      {profiles.length > 1 && (
        <Field label="Профиль поиска">
          <Select
            className="w-full sm:w-80"
            value={plan.profile?.id ?? ""}
            onChange={(event) => onSelectProfile(event.target.value)}
            aria-label="Профиль поиска для прогона"
          >
            {profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <dl className="space-y-1.5 text-[14.5px]">
        {profiles.length === 1 && plan.profile && (
          <PanelRow label="Профиль" value={plan.profile.name} />
        )}
        <PanelRow
          label="Слова в поиск"
          value={
            plan.keywords.length > 0
              ? plan.keywords.join(", ")
              : "без ключевых слов — источник отдаст всё по выбранным законам"
          }
        />
        <PanelRow
          label="Расход"
          value={`${spendPhrase(plan.spend)} · ${budgetText}`}
        />
      </dl>

      {plan.omitted.length > 0 && (
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Ещё {plan.omitted.length}{" "}
          {pluralRu(plan.omitted.length, ["слово", "слова", "слов"])} не участвуют
          (потолок {MAX_SEARCHES_PER_PRESS}{" "}
          {pluralRu(MAX_SEARCHES_PER_PRESS, ["поиск", "поиска", "поисков"])} на
          нажатие): {plan.omitted.slice(0, 3).join(", ")}
          {plan.omitted.length > 3 ? "…" : ""}. Чтобы искать и их, заведите
          отдельный профиль.
        </p>
      )}

      {usageLoading && (
        <p className="text-[13.5px] text-faint">Читаем остаток по тарифу…</p>
      )}
      {usageError && (
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Остаток не прочитан: {usageError}. Прогон при этом возможен — сервер
          сам откажет с кодом 429, если бюджет исчерпан.
        </p>
      )}
      {budget.fromTariff === false && budget.available !== null && (
        <p className="text-[13.5px] text-faint">
          Это наш страховой суточный бюджет, а не счётчик источника.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => onRun(plan)} disabled={syncing || plan.spend <= 0}>
          <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
          {syncing ? "Ищем…" : "Запустить платный поиск"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={syncing}>
          Отмена
        </Button>
      </div>

      <p className="text-[13.5px] text-faint">
        Повторный поиск с теми же словами и фильтрами берётся из кэша и бюджет не
        расходует.
      </p>
    </div>
  );
}

/* Строка панели: подпись слева, значение справа. */
function PanelRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

/**
 * Что стало с документацией найденных закупок.
 *
 * Поисковая выдача Контур.Закупок не содержит списка файлов, а хранилище ЕИС не
 * отвечает зарубежным адресам: файлы качает сервер в России, и прогон ставит их
 * в очередь. Исход постановки показывается как есть, включая отказ очереди, —
 * иначе партнёр ждал бы разбор по закупкам, документация которых не пришла.
 *
 * `null` означает, что ответ пришёл без поля (прогон очередь не просил): тогда
 * не показывается ничего — ни обещания, ни опровержения.
 */
function DocumentsQueueNote({ queue }: { queue: KonturDocumentsQueue | null }) {
  if (!queue) return null;

  if (queue.error) {
    return (
      <p className="mt-1 text-[13.5px] text-mustard-fg">
        Документация не поставлена в очередь: {queue.error}. Закупки сохранены —
        файлы к ним добавит плановый прогон.
      </p>
    );
  }
  if (queue.queued === 0) return null;

  return (
    <p className="mt-1 text-[13.5px] text-muted-foreground">
      Документация {queue.queued}{" "}
      {pluralRu(queue.queued, ["закупки", "закупок", "закупок"])}{" "}
      {queue.deduped ? "уже в очереди — повторно не ставили" : "поставлена в очередь"}:
      её скачает сервер в России. Глубокий разбор кнопка не запускает.
    </p>
  );
}

/**
 * Отчёт о платном прогоне: счётчики из ответа роута без пересчёта на клиенте.
 *
 * Числа показаны как есть, включая неудобные: `duplicates` — закупки, которые
 * уже лежат в базе от более авторитетного источника, `filteredOut` — отсеянные
 * регионом или ОКПД2 после оплаченного запроса. Без них «найдено 0»
 * неотличимо от поломки.
 */
export function KonturPressReport({ report, at }: { report: KonturSyncReport; at: number }) {
  return (
    <div className="rounded-control border border-border bg-panel-raised px-4 py-3">
      <p className="text-[14.5px] font-medium text-foreground">
        Прогон выполнен{at > 0 ? ` в ${formatDateTime(new Date(at).toISOString())}` : ""} ·
        профиль «{report.profileName}»
      </p>
      <p className="num mt-1.5 text-[14.5px] text-muted-foreground">
        найдено {report.synced} · новых {report.created} · обновлено {report.updated}
        {report.duplicates > 0 && ` · уже было от другого источника ${report.duplicates}`}
      </p>
      <p className="num mt-0.5 text-[13.5px] text-muted-foreground">
        платных поисков {report.apiCalls}
        {report.cacheHits > 0 && ` · из кэша ${report.cacheHits}`}
        {report.availableRequests !== null && ` · остаток по тарифу ${report.availableRequests}`}
      </p>

      {report.filteredOut > 0 && (
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
          Отсеяно фильтром региона или ОКПД2: {report.filteredOut}. Контур.Закупки
          не принимают эти параметры в поиске, поэтому выдача отбирается после
          ответа; сам запрос оплачен.
        </p>
      )}
      {report.duplicates > 0 && (
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
          Совпадение номера с бесплатной площадки — норма: строку более
          авторитетного источника мы не перезаписываем и дубль не создаём.
        </p>
      )}
      {report.documentsQueue ? (
        <DocumentsQueueNote queue={report.documentsQueue} />
      ) : (
        // Ответ без поля означает прежнюю версию сервера: обещать очередь
        // нельзя, но и молчать о том, что документов нет, — тоже.
        report.created > 0 && (
          <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
            Документации у новых закупок нет: поисковая выдача Контур.Закупок не
            содержит списка файлов, её добирает отдельный прогон. Глубокий разбор
            кнопка не запускает.
          </p>
        )
      )}
      {report.blurredFields.length > 0 && (
        <p className="mt-1 text-[13.5px] text-mustard-fg">
          Тариф ключа скрывает значения:{" "}
          {report.blurredFields.map((field) => konturBlurredFieldLabels[field] ?? field).join(", ")}.
          В сохранённых закупках эти поля пусты.
        </p>
      )}
      {report.skipped.length > 0 && (
        <p className="mt-1 text-[13.5px] text-mustard-fg">
          Часть записей отброшена: {report.skipped.join(", ")}.
        </p>
      )}
      {report.errors.length > 0 && (
        <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-[13.5px] text-brick-fg">
          {report.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
