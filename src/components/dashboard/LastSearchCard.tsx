"use client";

import { useMemo } from "react";
import Link from "next/link";
import { isCustomerKnown, isRegionKnown } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import type { LastKonturBatch } from "@/domain/lastSearch";
import { isNewInBatch } from "@/domain/lastSearch";
import { isSubmissionExpired } from "@/domain/scoring";
import { Card } from "@/components/ui/primitives";
import { FitScore, VerdictBadge } from "@/components/analysis";
import { formatDateTime, formatDate, formatTenderPrice, pluralRu } from "@/utils/format";

/** Сколько строк прогона показываем на первом экране; остальные — по ссылке. */
const SHOWN = 5;

/**
 * Что сделал платный поиск: сколько записал и сколько из них в базе впервые.
 *
 * Счётчики самого запуска («найдено 27 · новых 9 · дублей 18») живут только в
 * ответе маршрута и после перезагрузки страницы недоступны. Здесь напечатано
 * лишь то, что действительно видно в данных: строки партии и их даты первого
 * появления. Закупки, которые поиск нашёл, но не записал, потому что они уже
 * лежали в базе от более авторитетного источника, в это число не входят — и
 * подписать его «найдено» значило бы сказать неправду.
 */
function batchSummary(total: number, created: number): string {
  const wrote = `прогон записал ${total} ${pluralRu(total, [
    "закупку",
    "закупки",
    "закупок",
  ])}`;
  if (created === 0) return `${wrote}, новых среди них нет`;
  if (created === total) return `${wrote}, все — впервые`;
  return `${wrote}, ${created} из них впервые`;
}

/**
 * Партия платного поиска отдельным блоком.
 *
 * Компонент не подключён ни к одному экрану: дашборд показывает строки партии
 * внутри карточки «Лучшее из нового», где принадлежность прогону — свойство
 * строки, а не отдельный список, и второй такой список читался бы дважды. Файл
 * сохранён, пока не решено, возвращать ли блок на экран «Закупки» (см.
 * docs/ROADMAP.md).
 *
 * Партия определяется по метке записи (`tenders.synced_at`), а её прогон ставит
 * только строкам платного источника: у бесплатных площадок метки нет, поэтому
 * «последний прогон» по ним не собирается вовсе — блок отвечает на вопрос «куда
 * делся результат платного поиска», а не «что принесла кнопка».
 *
 * Просроченные закупки не прячутся (поиск действительно их вернул), но уходят
 * в конец списка с пометкой: показывать закупку с закрытой подачей как
 * возможность — значит вводить в заблуждение.
 */
export function LastSearchCard({ batch, now }: { batch: LastKonturBatch; now: Date }) {
  const ordered = useMemo(() => {
    const copy = [...batch.rows];
    copy.sort((a, b) => {
      const expired =
        Number(isSubmissionExpired(a.tender.deadlines.submissionEnd, now)) -
        Number(isSubmissionExpired(b.tender.deadlines.submissionEnd, now));
      if (expired !== 0) return expired;
      return b.analysis.fitScore - a.analysis.fitScore;
    });
    return copy;
  }, [batch, now]);

  const created = useMemo(
    () => batch.rows.filter((row) => isNewInBatch(row, batch.stamp)).length,
    [batch],
  );

  const visible = ordered.slice(0, SHOWN);

  return (
    <Card
      title="Результат платного поиска"
      actions={
        <Link
          href={`/tenders?batch=${encodeURIComponent(batch.stamp)}`}
          className="shrink-0 text-[13.5px] text-accent-fg hover:underline"
        >
          Все {batch.rows.length} — показать
        </Link>
      }
    >
      <p className="text-[13.5px] text-muted-foreground">
        {`Контур.Закупки · ${formatDateTime(batch.stamp)} · ${batchSummary(
          batch.rows.length,
          created,
        )}`}
      </p>
      <ul className="mt-3 space-y-2">
        {visible.map((row) => (
          <FoundRow key={row.tender.id} row={row} expired={isSubmissionExpired(row.tender.deadlines.submissionEnd, now)} />
        ))}
      </ul>
      {ordered.length > SHOWN && (
        <p className="mt-3 text-[13.5px] text-muted-foreground">
          Ещё {ordered.length - SHOWN}{" "}
          {pluralRu(ordered.length - SHOWN, ["закупка", "закупки", "закупок"])} — по ссылке
          «Все {batch.rows.length}» вверху блока.
        </p>
      )}
    </Card>
  );
}

/* Строка найденной закупки: название, кто и где, цена, срок, оценка. */
function FoundRow({ row, expired }: { row: TenderRow; expired: boolean }) {
  /*
    Неизвестные заказчик и регион не печатаются заглушками — две заглушки
    подряд читаются как поломка, а не как отсутствие данных. Тот же приём, что
    и в блоке «Откройте сегодня».
  */
  const meta = [
    isCustomerKnown(row.tender.customerName) ? row.tender.customerName : null,
    isRegionKnown(row.tender.region) ? row.tender.region : null,
  ].filter((part): part is string => part !== null);

  return (
    <li className="rounded-control border border-border/70 bg-panel px-4 py-3 shadow-card transition-shadow hover:shadow-card-hover">
      {/*
        На узком экране оценка и вердикт уходят под заголовок, а не встают
        рядом: нерастяжимая пара бейджей забирала 151px из 301px, и на
        название закупки оставалось одно слово с многоточием.
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <Link
            href={`/tenders/${row.tender.id}`}
            className="line-clamp-2 text-[15.5px] font-medium text-foreground hover:text-accent-fg sm:line-clamp-1"
          >
            {row.tender.subject}
          </Link>
          <p className="mt-1 text-[14.5px] text-muted-foreground">
            {meta.length > 0 && <>{meta.join(" · ")} · </>}
            <span className="num">
              {formatTenderPrice(row.tender.financial.price, row.tender.financial.currency)}
            </span>{" "}
            · подача до{" "}
            <span className="num">{formatDate(row.tender.deadlines.submissionEnd)}</span>
            {expired && <span className="text-brick-fg"> · Срок подачи истёк</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <FitScore value={row.analysis.fitScore} size="sm" />
          <VerdictBadge verdict={row.analysis.verdict} short />
        </div>
      </div>
    </li>
  );
}
