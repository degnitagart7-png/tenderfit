import Link from "next/link";
import type { TenderVerdict } from "@/domain/enums";
import { defaultFilters } from "@/domain/filtering";
import { filtersToSearchParams } from "@/domain/filterUrl";
import type {
  DeadlineDay,
  DeadlineDayTone,
  RejectionReasonCount,
  VerdictShare,
} from "@/domain/todayBoard";
import { URGENT_DEADLINE_DAYS } from "@/domain/scoring";
import { cn } from "@/lib/cn";
import { pluralRu } from "@/utils/format";

/*
  Диаграммы экрана «Сегодня» — чистый CSS без библиотек графиков.

  Recharts на этот экран не тянем: он весит сотни килобайт, а пользователи
  открывают экран на медленном интернете. Столбики и полосы — это div'ы с
  шириной или высотой в процентах, поэтому цвета берутся классами палитры, а не
  дублируются hex-значениями (см. DESIGN_HANDOFF, правило 10.1).

  Цвет не единственный носитель смысла: у каждого элемента рядом число и подпись,
  а у самой диаграммы есть aria-label со всеми значениями.
*/

/**
 * Ссылка в ленту с фильтром по вердикту.
 *
 * Строится тем же сериализатором, которым ленту читают обратно, — так ссылка не
 * разойдётся с тем, что лента понимает. `closed=hide` добавлен намеренно:
 * счётчики экрана считаются по открытым закупкам, а без этого параметра лента
 * показала бы ещё и просроченные, и число в ссылке не совпало бы с числом в списке.
 */
export function verdictHref(verdict: TenderVerdict): string {
  const params = filtersToSearchParams({ ...defaultFilters, verdict, hideClosed: true });
  return `/tenders?${params.toString()}`;
}

/* ============================ Полоса вердиктов ============================ */

const VERDICT_TEXT: Record<TenderVerdict, string> = {
  RECOMMENDED: "Подходит",
  MANUAL_REVIEW: "Нужно посмотреть",
  NOT_RECOMMENDED: "Не подходит",
};

const VERDICT_SEGMENT: Record<TenderVerdict, string> = {
  RECOMMENDED: "bg-olive",
  MANUAL_REVIEW: "bg-mustard",
  NOT_RECOMMENDED: "bg-brick",
};

/** Доля словами: «меньше 1%» вместо «0%» у ненулевого счётчика, иначе доля выглядит пустой. */
function formatShare(count: number, share: number): string {
  if (count === 0) return "0%";
  const percent = Math.round(share * 100);
  return percent === 0 ? "<1%" : `${percent}%`;
}

/**
 * Одна полоса 100% на всех вердиктах открытых закупок.
 *
 * Тремя пилюлями «0 / 1144 / 0» перекос не виден глазами; в полосе он виден
 * сразу. Сегменты нулевой доли не рисуются (ширина 0 оставила бы на полосе
 * тонкую черту), но в легенде они есть: «0» — тоже ответ.
 */
export function VerdictBar({ shares, total }: { shares: VerdictShare[]; total: number }) {
  const label = `Вердикты по ${total} открытым ${pluralRu(total, ["закупке", "закупкам", "закупкам"])}: ${shares
    .map((s) => `${VERDICT_TEXT[s.verdict].toLowerCase()} — ${s.count}`)
    .join(", ")}`;
  return (
    <div className="card px-4 py-3" data-testid="verdict-bar">
      {/*
        Сегменты внутри role="img" — только для щелчка мышью: tabIndex={-1} и
        пустой текст. Клавиатуре и скринридеру те же ссылки отдаёт легенда ниже.
      */}
      <div
        role="img"
        aria-label={label}
        className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-panel-raised"
      >
        {shares
          .filter((s) => s.count > 0)
          .map((s) => (
            <Link
              key={s.verdict}
              href={verdictHref(s.verdict)}
              tabIndex={-1}
              title={`${VERDICT_TEXT[s.verdict]}: ${s.count} из ${total} (${formatShare(s.count, s.share)})`}
              data-segment={s.verdict}
              style={{ flexGrow: s.count, flexBasis: 0 }}
              className={cn("min-w-[6px] transition-opacity hover:opacity-80", VERDICT_SEGMENT[s.verdict])}
            />
          ))}
      </div>
      <ul className="mt-2.5 grid grid-cols-3 gap-2" aria-label="Вердикты открытых закупок">
        {shares.map((s) => (
          <li key={s.verdict} className="min-w-0">
            <Link
              href={verdictHref(s.verdict)}
              title={`Открыть в ленте: ${VERDICT_TEXT[s.verdict].toLowerCase()}`}
              className="block rounded-control px-1.5 py-1 hover:bg-panel-raised"
            >
              <span className="flex items-start gap-1.5 text-[13.5px] leading-tight text-muted-foreground">
                <span
                  className={cn("mt-[3px] h-2.5 w-2.5 shrink-0 rounded-full", VERDICT_SEGMENT[s.verdict])}
                  aria-hidden
                />
                {VERDICT_TEXT[s.verdict]}
              </span>{" "}
              <span className="mt-0.5 flex items-baseline gap-1.5 pl-4">
                <span className="num text-[18px] font-semibold leading-none text-foreground">
                  {s.count}
                </span>{" "}
                <span className="num text-[12.5px] text-faint">{formatShare(s.count, s.share)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ============================ Подача по дням ============================ */

const WEEKDAY_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;

const TONE_BAR: Record<DeadlineDayTone, string> = {
  today: "bg-brick",
  urgent: "bg-mustard",
  // Спокойный нейтральный тон: цветом выделено только то, что требует спешки.
  later: "bg-faint/45",
};

const TONE_LEGEND: { tone: DeadlineDayTone; label: string }[] = [
  { tone: "today", label: "сегодня" },
  { tone: "urgent", label: `ближайшие ${URGENT_DEADLINE_DAYS} дн.` },
  { tone: "later", label: "позже" },
];

function dayTitle(day: DeadlineDay): string {
  const date = day.date.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const noun = pluralRu(day.count, ["закупка", "закупки", "закупок"]);
  return `${date}: ${day.count} ${noun} закрывают подачу`;
}

/**
 * Столбики «сколько закупок закрывают подачу в каждый из ближайших дней».
 *
 * Высота — по самому высокому столбику, а не по абсолютной шкале: график
 * нужен, чтобы увидеть, на какой день падает пик, а не измерить его. Значение
 * печатается над столбиком, поэтому читать высоту «на глаз» не требуется.
 */
export function DeadlineChart({
  days,
  inWindow,
  beyond,
}: {
  days: DeadlineDay[];
  inWindow: number;
  beyond: number;
}) {
  if (inWindow === 0) {
    return (
      <p className="text-[14.5px] text-muted-foreground">
        В ближайшие {days.length} дней подача не закрывается ни по одной закупке
        {beyond > 0 && <>; ещё {beyond} закрываются позже</>}.
      </p>
    );
  }

  const max = Math.max(1, ...days.map((d) => d.count));
  const summary = days
    .filter((d) => d.count > 0)
    .map((d) => `${d.offset === 0 ? "сегодня" : d.date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })} — ${d.count}`)
    .join(", ");

  return (
    <div data-testid="deadline-chart">
      <div
        role="img"
        aria-label={`Подача по дням на ближайшие ${days.length} дней. Всего ${inWindow}: ${summary}`}
        className="flex h-[132px] items-stretch gap-[3px]"
      >
        {days.map((day) => {
          const heightPct = day.count === 0 ? 0 : Math.max(6, Math.round((day.count / max) * 100));
          return (
            <div
              key={day.offset}
              title={dayTitle(day)}
              data-day-offset={day.offset}
              data-count={day.count}
              className="flex min-w-0 flex-1 flex-col"
            >
              <span
                className={cn(
                  "num h-4 text-center text-[12.5px] leading-4",
                  day.count === 0 ? "text-faint/60" : "font-semibold text-foreground",
                )}
              >
                {day.count}
              </span>
              <div className="flex flex-1 items-end">
                {/* Нулевой день — тонкая засечка на базовой линии: слот на месте, но не кричит. */}
                <div
                  className={cn(
                    "w-full rounded-t-[4px]",
                    day.count === 0 ? "h-0.5 bg-border" : TONE_BAR[day.tone],
                  )}
                  style={day.count === 0 ? undefined : { height: `${heightPct}%` }}
                />
              </div>
              <span
                className={cn(
                  "mt-1 text-center text-[12.5px] leading-none",
                  day.tone === "today" ? "font-semibold text-brick-fg" : "text-faint",
                )}
              >
                {WEEKDAY_SHORT[day.date.getDay()]}{" "}
                <span className="num mt-0.5 block text-[11.5px]">{day.date.getDate()}</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px] text-faint">
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Что означают цвета">
          {TONE_LEGEND.map((item) => (
            <li key={item.tone} className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-sm", TONE_BAR[item.tone])} aria-hidden />
              {item.label}
            </li>
          ))}
        </ul>
        <span>
          <span className="num">{inWindow}</span> за {days.length} дн.
          {beyond > 0 && (
            <>
              {" "}
              · ещё <span className="num">{beyond}</span> позже
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/* ============================ Причины отказа ============================ */

/**
 * Главные причины отказа горизонтальными столбиками.
 *
 * Длина — доля от всех отклонённых, число справа — сколько закупок. Текст
 * причины остаётся текстом, а не подписью на графике: он длинный и должен
 * переноситься, а не обрезаться.
 */
export function RejectionBars({
  reasons,
  total,
}: {
  reasons: RejectionReasonCount[];
  total: number;
}) {
  return (
    <ul className="space-y-2.5" aria-label="Главные причины отказа" data-testid="rejection-bars">
      {reasons.map((item) => {
        const percent = Math.round(item.share * 100);
        const label = `${item.count} из ${total} отклонённых (${percent === 0 ? "<1" : percent}%)`;
        return (
          <li key={item.reason}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-[13.5px] leading-snug text-foreground">{item.reason}</span>
              <span className="num shrink-0 text-[14.5px] font-semibold text-foreground">
                {item.count}
              </span>
            </div>
            <div
              role="img"
              aria-label={`${item.reason}: ${label}`}
              title={label}
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-brick-subtle"
            >
              <div
                className="h-full rounded-full bg-brick"
                style={{ width: `${Math.max(2, Math.round(item.share * 100))}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
