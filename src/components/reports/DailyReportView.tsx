"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { buildDigest, formatDeadline, nextDigestDay, type DigestItem, type DigestPipeline } from "@/domain/digest";
import { resolveDigestSettings, timeZoneCity } from "@/domain/digestSettings";
import { autoAppliedProfile } from "@/domain/searchProfileFilters";
import { FEED_SEEN_KEY, FEED_SEEN_MAX_AGE_MS } from "@/domain/searchMarker";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { pipelineRepository } from "@/repositories/pipelineRepository";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { settingsRepository } from "@/repositories/settingsRepository";
import { accountApiService } from "@/services/accountApiService";
import { useTenderData } from "@/hooks/useTenderData";
import { Card, EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/primitives";
import { FitScore } from "@/components/analysis";
import { RegionBars, VerdictDonut } from "@/components/reports/ReportCharts";
import { formatCompactRub, formatCurrency } from "@/utils/format";

/**
 * Отчёт: то же, что приходит утренним письмом, — новое по профилю, что закрывается в ближайшие
 * 48 часов и что у человека в работе.
 *
 * Собирается тем же `buildDigest`, что и письмо, поэтому состав совпадает. «Новое» — всё, что
 * появилось в базе после прошлого захода в ленту (`tenderfit.feedSeenAt`), а без отметки — за сутки.
 * Сводные графики по всей базе остались ниже: они отвечают на вопрос «как выглядит выдача целиком».
 */

/** Прошлый заход в ленту, мс: отметка ленты (её ставит `takeFeedSeen`). Читаем, но не двигаем: отметка принадлежит ленте. */
function readFeedSeen(now: number): number | null {
  try {
    const raw = window.localStorage.getItem(FEED_SEEN_KEY);
    const at = raw === null ? Number.NaN : Date.parse(raw);
    return Number.isFinite(at) && at < now && now - at <= FEED_SEEN_MAX_AGE_MS ? at : null;
  } catch {
    return null;
  }
}

function priceText(item: DigestItem): string {
  if (item.price === null) return "НМЦК не указана";
  const rub = item.currency === "" || item.currency.toUpperCase() === "RUB";
  return rub ? formatCompactRub(item.price) : formatCurrency(item.price, item.currency);
}

function DigestRow({ item, timeZone }: { item: DigestItem; timeZone: string }) {
  const who = [item.customer, item.region].filter((part) => part.trim() !== "").join(" · ");
  return (
    <li className="rounded-control border border-border bg-panel p-3.5 transition-colors hover:border-border-strong">
      {/* Оценка — справа и с подписью: на ширине ноутбука она переносилась под строку
          цены голым «88», и было непонятно, что это за число. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link href={`/tenders/${encodeURIComponent(item.id)}`} className="text-sm font-medium text-foreground hover:text-accent-fg">
            {item.subject}
          </Link>
          {who !== "" && <p className="muted mt-0.5 text-xs">{who}</p>}
          <p className="muted mt-0.5 text-xs">
            {priceText(item)} · подача до {formatDeadline(item.submissionEnd, timeZone)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <span className="text-[11.5px] text-faint">оценка</span>
          <FitScore value={item.fitScore} size="sm" />
        </div>
      </div>
    </li>
  );
}

function Section({
  title,
  items,
  timeZone,
  empty,
  more,
}: {
  title: string;
  items: DigestItem[];
  timeZone: string;
  empty: string;
  /** Сколько ещё не показано. */
  more?: number;
}) {
  return (
    <Card title={`${title} (${String(items.length + (more ?? 0))})`}>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((item) => (
              <DigestRow key={item.id} item={item} timeZone={timeZone} />
            ))}
          </ul>
          {more !== undefined && more > 0 && (
            <p className="muted mt-3">
              …и ещё {more} в{" "}
              <Link href="/tenders" className="text-accent-fg hover:underline">
                ленте
              </Link>
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export function DailyReportView() {
  const { rows, loading, error, reload } = useTenderData();
  const [now] = useState(() => Date.now());
  /** Почта аккаунта; null — не вошли. */
  const [email, setEmail] = useState<string | null>(null);
  const [emailKnown, setEmailKnown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void accountApiService
      .me()
      .then((state) => {
        if (!cancelled) setEmail(state.user?.email ?? null);
      })
      .catch(() => {
        // Сервер не ответил: отчёт собирается, а строка про почту говорит, что адреса нет.
      })
      .finally(() => {
        if (!cancelled) setEmailKnown(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const settings = useMemo(() => resolveDigestSettings(settingsRepository.get()), []);
  const searchProfiles = useMemo(() => searchProfileRepository.getAll(), []);
  const feedSeen = useMemo(() => readFeedSeen(now), [now]);
  // Не короче суток, как в письме: после недавнего захода в ленту раздел иначе почти всегда пуст.
  const since = Math.min(feedSeen ?? Number.POSITIVE_INFINITY, now - 24 * 3_600_000);

  const digest = useMemo(() => {
    const pipeline: DigestPipeline = Object.fromEntries(
      Object.entries(pipelineRepository.getAll()).map(([id, item]) => [id, { status: item.status }]),
    );
    return buildDigest({
      rows,
      searchProfiles,
      companyProfile: companyProfileRepository.get(),
      pipeline,
      since,
      now,
      minFitScore: settings.minFitScore,
    });
  }, [rows, searchProfiles, since, now, settings.minFitScore]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading) return <LoadingSkeleton rows={8} />;

  const noProfile = autoAppliedProfile(searchProfiles) === null;
  const day = nextDigestDay(settings, null, now);
  const city = timeZoneCity(settings.timeZone);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Отчёт</h1>
        <p className="muted mt-1" data-testid="digest-mail-line">
          {settings.enabled ? (
            emailKnown && email === null ? (
              <>
                Чтобы получать сводку на почту,{" "}
                <Link href="/login" className="text-accent-fg hover:underline">
                  войдите в аккаунт
                </Link>
                .
              </>
            ) : (
              <>
                Сводка придёт {day === "today" ? "сегодня" : "завтра"} в {settings.sendTime} ({city}) на почту{" "}
                {email ?? "аккаунта"}.{" "}
                <Link href="/settings/notifications" className="text-accent-fg hover:underline">
                  Настроить
                </Link>
              </>
            )
          ) : (
            <>
              Сводка на почту выключена —{" "}
              <Link href="/settings/notifications" className="text-accent-fg hover:underline">
                включить
              </Link>
            </>
          )}
        </p>
        <p className="muted mt-1">
          {since === now - 24 * 3_600_000 ? "Новое за последние сутки" : `Новое с вашего прошлого захода в ленту (${formatDeadline(new Date(since).toISOString(), settings.timeZone)})`}
          {" · "}в отчёт попадают закупки с оценкой не ниже {settings.minFitScore}
        </p>
      </div>

      {digest.isEmpty && (
        <EmptyState
          title="Пока нечего сообщить"
          description="Новых закупок по профилю нет, срочных сроков и закупок в работе тоже."
        />
      )}

      <Section
        title="Новые"
        items={digest.fresh}
        more={digest.totalFresh - digest.fresh.length}
        timeZone={settings.timeZone}
        empty={
          noProfile
            ? "Новые закупки собираются по профилю поиска. Добавьте профиль со словами в разделе «Что ищем»."
            : "Новых закупок по вашему профилю нет."
        }
      />
      <Section
        title="Закрываются в 48 часов"
        items={digest.closing}
        timeZone={settings.timeZone}
        empty="Горящих сроков нет."
      />
      <Section
        title="В работе"
        items={digest.inWork}
        timeZone={settings.timeZone}
        empty="В «Моих закупках» нет закупок в работе со сроками впереди."
      />

      {/*
        Сводка по всей базе, а не за день: графики отвечают на вопрос «как
        вообще выглядит выдача», и на экране «Сегодня» они уводили взгляд
        от единственного нужного действия.
      */}
      {rows.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <VerdictDonut rows={rows} />
          <RegionBars rows={rows} />
        </div>
      )}

      {/* Оговорка «оценка — не вероятность победы» стоит в подвале каждой страницы. */}
    </div>
  );
}
