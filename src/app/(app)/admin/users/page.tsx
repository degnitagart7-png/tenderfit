"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, RefreshCw } from "lucide-react";

import type { AccessStatus } from "@/domain/access";
import { sortAdminUsers, type AdminUserRow, type AdminUserSortKey, type JournalItem } from "@/domain/adminUsers";
import type { FunnelPeriod } from "@/domain/adminFunnel";
import { formatRub } from "@/domain/llmCostReport";
import { describeError } from "@/lib/errors";
import { readJsonOrThrow } from "@/lib/readJson";
import { AdminFunnel } from "@/components/admin/AdminFunnel";
import { Badge, Button, Card, Counter } from "@/components/ui/primitives";
import { AdminAccessError, adminUsersApiService } from "@/services/adminUsersApiService";
import type { AdminUsersResponse } from "@/app/api/admin/users/route";
import type { AdminFunnelResponse } from "@/app/api/admin/funnel/route";
import { formatDate, formatDateTime } from "@/utils/format";

/**
 * Админ-панель «Пользователи»: кто зарегистрирован, как часто пользуется, где у
 * него ломается сервис и сколько он стоит в рублях.
 *
 * Страница только читает. Доступ проверяет сервер (ADMIN_EMAILS): тот, кто открыл
 * адрес руками, получает 403 и видит заглушку, а не чужие данные. В меню пункт
 * показан только администратору (AppShell), в кабинете — карточка со ссылкой.
 *
 * Цифры расхода — в рублях по журналу llm_usage_log. Расход до 14.10.2026 и
 * плановые прогоны воркера к человеку не относятся: они в плитке «Без привязки к
 * пользователю», а не размазаны по таблице.
 */

type Tone = "olive" | "mustard" | "brick" | "neutral" | "accent";

const ACCESS_LABELS: Record<AccessStatus, { text: string; tone: Tone }> = {
  admin: { text: "Администратор", tone: "accent" },
  paid: { text: "Оплачен", tone: "olive" },
  trial: { text: "Пробный", tone: "mustard" },
  expired: { text: "Истёк", tone: "brick" },
};

interface Column {
  key: AdminUserSortKey;
  label: string;
  title?: string;
  numeric?: boolean;
}

const COLUMNS: Column[] = [
  { key: "email", label: "Почта" },
  { key: "registeredAt", label: "Регистрация" },
  { key: "lastLoginAt", label: "Последний вход" },
  { key: "accessStatus", label: "Доступ" },
  { key: "activeDays7d", label: "Дней активности 7 / 30", title: "Дней с действиями за последние 7 и 30 суток (по Москве)", numeric: true },
  { key: "deepAnalyses30d", label: "Анализов", title: "Глубоких анализов за 30 дней", numeric: true },
  { key: "estimates30d", label: "Смет", title: "Расчётов и проверок сметы за 30 дней", numeric: true },
  { key: "liveSearches30d", label: "Поисков", title: "Живых поисков за 30 дней", numeric: true },
  { key: "errors7d", label: "Ошибок 7 дн", title: "Ошибки сервиса и упавшие задания за 7 дней", numeric: true },
  { key: "spend30d", label: "₽ 30 дн", title: "Расход на ИИ за 30 дней", numeric: true },
  { key: "spendTotal", label: "₽ всего", title: "Расход на ИИ за всё время", numeric: true },
];

const SORT_DEFAULT_DIRECTION: Record<AdminUserSortKey, "asc" | "desc"> = {
  email: "asc",
  registeredAt: "desc",
  lastLoginAt: "desc",
  lastActivityAt: "desc",
  accessStatus: "asc",
  activeDays7d: "desc",
  activeDays30d: "desc",
  deepAnalyses30d: "desc",
  estimates30d: "desc",
  liveSearches30d: "desc",
  errors7d: "desc",
  spend30d: "desc",
  spendTotal: "desc",
};

interface JournalState {
  loading: boolean;
  error: string | null;
  items: JournalItem[];
  eventsAvailable: boolean;
}

function resultBadge(item: JournalItem): { text: string; tone: Tone } {
  if (item.ok) return { text: "ОК", tone: "olive" };
  // Ошибка сервиса и упавшее задание — «Ошибка»; отказ по лимиту или доступу — «Отказ».
  return item.kind === "error" || item.source !== "event" ? { text: "Ошибка", tone: "brick" } : { text: "Отказ", tone: "mustard" };
}

function TenderLink({ id }: { id: string | null }) {
  if (id === null || id === "") return <span className="muted">—</span>;
  return (
    <Link href={`/tenders/${encodeURIComponent(id)}`} className="text-accent-fg hover:underline">
      {id}
    </Link>
  );
}

function Journal({ email, state }: { email: string; state: JournalState | undefined }) {
  if (!state || state.loading) return <p className="muted">Загружаю журнал…</p>;
  if (state.error) return <p role="alert" className="text-sm text-brick-fg">{state.error}</p>;
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">Журнал: {email}</p>
      {!state.eventsAvailable && (
        <p className="mb-2 text-sm text-mustard-fg">
          Журнал действий ещё не создан (миграция 20261014000022_user_events.sql): показаны только упавшие задания.
        </p>
      )}
      {state.items.length === 0 ? (
        <p className="muted">Записей пока нет.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left muted">
                <th className="px-2 py-1.5 font-medium">Время</th>
                <th className="px-2 py-1.5 font-medium">Действие</th>
                <th className="px-2 py-1.5 font-medium">Результат</th>
                <th className="px-2 py-1.5 font-medium">Закупка</th>
                <th className="px-2 py-1.5 font-medium">Подробности</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((item, index) => {
                const badge = resultBadge(item);
                return (
                  <tr
                    key={`${item.at}-${item.kind}-${String(index)}`}
                    className={`border-b border-border last:border-0 ${item.ok ? "" : "bg-brick-subtle"}`}
                    data-failed={item.ok ? undefined : "true"}
                  >
                    <td className="px-2 py-1.5 whitespace-nowrap muted">{formatDateTime(item.at)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-foreground">{item.label}</td>
                    <td className="px-2 py-1.5">
                      <Badge tone={badge.tone}>{badge.text}</Badge>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <TenderLink id={item.tenderId} />
                    </td>
                    <td className={`px-2 py-1.5 break-words ${item.ok ? "text-muted-foreground" : "text-brick-fg"}`}>
                      {item.detail ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Воронка читается прямо здесь: сервис админки не входит в набор файлов этой задачи. */
async function fetchFunnel(period: FunnelPeriod): Promise<AdminFunnelResponse> {
  const response = await fetch(`/api/admin/funnel?period=${period}`, { cache: "no-store" });
  const body = await readJsonOrThrow<AdminFunnelResponse>(response);
  if (!Array.isArray(body.steps)) throw new Error("Ответ воронки не распознан");
  return body;
}

export default function AdminUsersPage() {
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: AdminUserSortKey; direction: "asc" | "desc" }>({
    key: "lastActivityAt",
    direction: "desc",
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [journals, setJournals] = useState<Record<string, JournalState>>({});
  const [funnelPeriod, setFunnelPeriod] = useState<FunnelPeriod>("all");
  const [funnel, setFunnel] = useState<AdminFunnelResponse | null>(null);
  const [funnelError, setFunnelError] = useState<string | null>(null);
  const [funnelLoading, setFunnelLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminUsersApiService.list());
      setError(null);
      setForbidden(false);
      // Журналы читались до обновления: показывать их устаревшими хуже, чем подгрузить заново.
      setJournals({});
    } catch (cause) {
      if (cause instanceof AdminAccessError) setForbidden(true);
      else setError(describeError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Воронка грузится отдельно от таблицы: её сбой не должен прятать список людей и наоборот.
  // Устаревший ответ (период успели переключить) отбрасывается.
  const [funnelTick, setFunnelTick] = useState(0);
  useEffect(() => {
    let current = true;
    setFunnelLoading(true);
    fetchFunnel(funnelPeriod)
      .then((result) => {
        if (!current) return;
        setFunnel(result);
        setFunnelError(null);
      })
      .catch((cause: unknown) => {
        if (current) setFunnelError(describeError(cause));
      })
      .finally(() => {
        if (current) setFunnelLoading(false);
      });
    return () => {
      current = false;
    };
  }, [funnelPeriod, funnelTick]);

  const rows = useMemo(() => (data ? sortAdminUsers(data.users, sort.key, sort.direction) : []), [data, sort]);

  const loadJournal = useCallback(async (email: string) => {
    setJournals((prev) => ({ ...prev, [email]: { loading: true, error: null, items: [], eventsAvailable: true } }));
    try {
      const result = await adminUsersApiService.events(email);
      setJournals((prev) => ({
        ...prev,
        [email]: { loading: false, error: null, items: result.items, eventsAvailable: result.eventsAvailable },
      }));
    } catch (cause) {
      setJournals((prev) => ({
        ...prev,
        [email]: { loading: false, error: describeError(cause), items: [], eventsAvailable: true },
      }));
    }
  }, []);

  const toggle = (email: string) => {
    if (expanded === email) {
      setExpanded(null);
      return;
    }
    setExpanded(email);
    if (!journals[email]) void loadJournal(email);
  };

  const changeSort = (key: AdminUserSortKey) => {
    setSort((prev) => (prev.key === key ? { key, direction: prev.direction === "asc" ? "desc" : "asc" } : { key, direction: SORT_DEFAULT_DIRECTION[key] }));
  };

  if (forbidden) {
    return (
      <Card title="Пользователи">
        <p className="text-sm text-muted-foreground">Раздел только для администратора</p>
      </Card>
    );
  }

  const summary = data?.summary;
  const rub = (value: number | undefined) => (value === undefined ? "—" : formatRub(value));
  const num = (value: number | undefined) => (value === undefined ? "—" : String(value));

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Пользователи</h1>
          <p className="muted mt-1">
            Кто зарегистрирован, как часто пользуется, где у него ломается сервис и сколько он стоит в рублях.
            Расход до 14.10.2026 к людям не привязан.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            void load();
            setFunnelTick((tick) => tick + 1);
          }}
          loading={loading}
        >
          <RefreshCw className="h-4 w-4" /> Обновить
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-brick-fg">
          Не удалось загрузить: {error}
        </p>
      )}
      {data?.warnings.map((warning) => (
        <p key={warning} className="text-sm text-mustard-fg">
          {warning}
        </p>
      ))}

      <AdminFunnel
        data={funnel}
        loading={funnelLoading}
        error={funnelError}
        period={funnelPeriod}
        onPeriodChange={setFunnelPeriod}
      />

      {summary && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label="Сводка">
          <Counter label="Пользователей" value={num(summary.usersTotal)} />
          <Counter label="Новых за 7 дней" value={num(summary.newLast7d)} />
          <Counter label="Активны сегодня" value={num(summary.activeToday)} />
          <Counter label="Активны за 7 дней" value={num(summary.active7d)} />
          <Counter label="Активны за 30 дней" value={num(summary.active30d)} />
          <Counter label="Платят" value={num(summary.payingNow)} />
          <Counter label="На пробном" value={num(summary.onTrial)} />
          <Counter label="Пробный истёк" value={num(summary.expired)} tone={summary.expired > 0 ? "warning" : "default"} />
          <Counter label="Ошибок за 7 дней" value={num(summary.errors7d)} tone={summary.errors7d > 0 ? "danger" : "default"} />
          <Counter label="Потрачено на ИИ сегодня" value={rub(summary.spendToday)} />
          <Counter label="Потрачено на ИИ за 7 дней" value={rub(summary.spend7d)} />
          <Counter label="Потрачено на ИИ за 30 дней" value={rub(summary.spend30d)} />
          <Counter label="Потрачено на ИИ всего" value={rub(summary.spendTotal)} />
          <Counter label="Без привязки к пользователю" value={rub(summary.spendUnattributed)} />
        </div>
      )}

      <Card flush>
        {data === null ? (
          <p className="muted p-5">{loading ? "Загружаю…" : "Нет данных."}</p>
        ) : rows.length === 0 ? (
          <p className="muted p-5">Пользователей пока нет.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-border text-left muted">
                  {COLUMNS.map((column) => {
                    const active = sort.key === column.key;
                    return (
                      <th
                        key={column.key}
                        scope="col"
                        title={column.title}
                        aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                        className={`px-3 py-2.5 font-medium ${column.numeric ? "text-right" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() => changeSort(column.key)}
                          className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground"
                        >
                          {column.label}
                          {active && (sort.direction === "asc" ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />)}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <UserRow
                    key={row.email}
                    row={row}
                    open={expanded === row.email}
                    onToggle={() => toggle(row.email)}
                    journal={journals[row.email]}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function UserRow({
  row,
  open,
  onToggle,
  journal,
}: {
  row: AdminUserRow;
  open: boolean;
  onToggle: () => void;
  journal: JournalState | undefined;
}) {
  const access = ACCESS_LABELS[row.accessStatus];
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-border hover:bg-panel-raised ${row.errors7d > 0 ? "bg-brick-subtle" : ""}`}
        data-testid={`user-row-${row.email}`}
      >
        <td className="px-3 py-2.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`Журнал ${row.email}`}
            className="inline-flex items-center gap-1.5 text-left font-medium text-foreground"
          >
            {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
            {row.email}
          </button>
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap muted">{formatDate(row.registeredAt)}</td>
        <td className="px-3 py-2.5 whitespace-nowrap muted">{formatDateTime(row.lastLoginAt)}</td>
        <td className="px-3 py-2.5 whitespace-nowrap" title={row.plan ? `Тариф: ${row.plan}` : undefined}>
          <Badge tone={access.tone}>{access.text}</Badge>
        </td>
        <td className="num px-3 py-2.5 text-right whitespace-nowrap">
          {row.activeDays7d} / {row.activeDays30d}
        </td>
        <td className="num px-3 py-2.5 text-right">{row.deepAnalyses30d}</td>
        <td className="num px-3 py-2.5 text-right">{row.estimates30d}</td>
        <td className="num px-3 py-2.5 text-right">{row.liveSearches30d}</td>
        <td className={`num px-3 py-2.5 text-right ${row.errors7d > 0 ? "font-semibold text-brick-fg" : ""}`}>{row.errors7d}</td>
        <td className="num px-3 py-2.5 text-right whitespace-nowrap">{formatRub(row.spend30d)}</td>
        <td className="num px-3 py-2.5 text-right whitespace-nowrap">{formatRub(row.spendTotal)}</td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-panel-raised">
          <td colSpan={COLUMNS.length} className="px-3 py-3">
            <Journal email={row.email} state={journal} />
          </td>
        </tr>
      )}
    </>
  );
}
