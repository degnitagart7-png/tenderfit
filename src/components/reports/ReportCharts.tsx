"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";
import type { TenderRow } from "@/domain/filtering";
import { UNKNOWN_REGION, isRegionKnown } from "@/domain/entities";
import { Card } from "@/components/ui/primitives";
import { verdictLabels } from "@/lib/labels";
import { pluralRu } from "@/utils/format";

/**
 * Сводные графики отчёта: структура вердиктов и топ регионов.
 *
 * Жили на экране «Сегодня», переехали сюда: дашборд отвечает на вопрос
 * «что открыть прямо сейчас», а эти графики описывают базу целиком и только
 * уводили взгляд от единственного действия на экране.
 */

/**
 * Палитра графиков — зеркало токенов из globals.css.
 *
 * Значения записаны литералами, а не через rgb(var(--olive)), потому что
 * Recharts отдаёт цвет в презентационный атрибут SVG (fill/stroke), а var()
 * в атрибутах не раскрывается — работает только в CSS-свойствах. Отсюда
 * правило: меняется токен — правится и эта таблица, другого способа держать
 * графики в одной палитре с интерфейсом нет.
 *
 * До этого здесь жил параллельный набор из тринадцати цветов, переживший смену
 * палитры: «Подходит» на графике был защитно-оливковым, а на пилюле рядом —
 * зелёным. Ровно поэтому таблица собрана в одном месте и подписана токенами:
 * следующая смена палитры должна править одну константу, а не искать хардкоды
 * по файлу.
 */
const chartColors = {
  olive: "#067647", // --olive
  mustard: "#CA8A04", // --mustard
  brick: "#D92D20", // --brick
  accent: "#F2541B", // --accent
  foreground: "#1A1816", // --foreground
  faint: "#7A756D", // --faint
  border: "#E9E7E3", // --border
  panel: "#FFFFFF", // --panel
  panelRaised: "#F5F4F1", // --panel-raised
} as const;

/** Цвета вердиктов: те же тона, что у пилюль VerdictBadge. */
const VERDICT_COLORS: Record<string, string> = {
  RECOMMENDED: chartColors.olive,
  MANUAL_REVIEW: chartColors.mustard,
  NOT_RECOMMENDED: chartColors.brick,
};

const VERDICT_ORDER = ["RECOMMENDED", "MANUAL_REVIEW", "NOT_RECOMMENDED"] as const;

/** Segmented bar: компактная визуальная сводка вердиктов. */
export function VerdictDonut({ rows }: { rows: TenderRow[] }) {
  const data = useMemo(() => {
    const counts: Record<string, number> = {
      RECOMMENDED: 0,
      MANUAL_REVIEW: 0,
      NOT_RECOMMENDED: 0,
    };
    for (const r of rows) counts[r.analysis.verdict] = (counts[r.analysis.verdict] ?? 0) + 1;
    const total = rows.length;
    return VERDICT_ORDER.map((v) => {
      const value = counts[v] ?? 0;
      return {
        key: v as string,
        name: verdictLabels[v],
        value,
        percent: total > 0 ? Math.round((value / total) * 100) : 0,
        color: VERDICT_COLORS[v] ?? chartColors.accent,
      };
    });
  }, [rows]);

  const total = rows.length;
  const recommended = data.find((d) => d.key === "RECOMMENDED")?.value ?? 0;
  const recommendedShare = total > 0 ? Math.round((recommended / total) * 100) : 0;

  /* Ширина сегментов пропорциональна значениям. */
  const segments = total > 0 ? data.filter((d) => d.value > 0) : [];

  return (
    <Card
      title="Распределение закупок"
      actions={<span className="text-[12.5px] text-muted-foreground">всего {total}</span>}
    >
      {/* Segmented bar */}
      {segments.length > 0 && (
        <div className="mb-4 flex h-2 w-full overflow-hidden rounded-full bg-panel-raised">
          {segments.map((d) => (
            <div
              key={d.key}
              className="h-full transition-all"
              style={{
                width: `${(d.value / total) * 100}%`,
                backgroundColor: d.color,
              }}
              title={`${d.name}: ${d.value}`}
            />
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4">
        <div className="flex flex-col">
          <span className="num text-2xl font-semibold text-foreground leading-none">
            {recommendedShare}%
          </span>
          <span className="text-[12.5px] text-muted-foreground mt-0.5">можно участвовать</span>
        </div>
        <div className="flex-1 space-y-1.5">
          {data.map((d) => (
            <div key={d.key} className="flex items-center gap-2 text-[13.5px]">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: d.color }}
                aria-hidden
              />
              <span className="text-muted-foreground flex-1 truncate">{d.name}</span>
              <span className="num font-medium text-foreground">{d.value}</span>
              <span className="num text-faint w-8 text-right">{d.percent}%</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** Горизонтальные бары: топ регионов по числу закупок. */
export function RegionBars({ rows }: { rows: TenderRow[] }) {
  const data = useMemo(() => {
    const byRegion = new Map<string, { count: number; price: number }>();
    for (const r of rows) {
      const key = isRegionKnown(r.tender.region) ? r.tender.region : UNKNOWN_REGION;
      const cur = byRegion.get(key) ?? { count: 0, price: 0 };
      cur.count += 1;
      cur.price += r.tender.financial.price;
      byRegion.set(key, cur);
    }
    return [...byRegion.entries()]
      .map(([region, v]) => ({ region, count: v.count, price: v.price }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [rows]);

  return (
    <Card title="Закупки по регионам" actions={<span className="text-[12.5px] text-muted-foreground">топ-6</span>}>
      {data.length === 0 ? (
        <p className="muted">Нет данных для отображения.</p>
      ) : (
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                horizontal={false}
                stroke={chartColors.border}
              />
              <XAxis
                type="number"
                tick={{ fontSize: 10, fill: chartColors.faint }}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <YAxis
                type="category"
                dataKey="region"
                tick={{ fontSize: 11, fill: chartColors.foreground }}
                tickLine={false}
                axisLine={false}
                width={100}
              />
              <Tooltip
                cursor={{ fill: chartColors.panelRaised }}
                contentStyle={{
                  background: chartColors.panel,
                  border: `1px solid ${chartColors.border}`,
                  borderRadius: 6,
                  fontSize: 12,
                  color: chartColors.foreground,
                }}
                labelStyle={{ color: chartColors.faint }}
                itemStyle={{ color: chartColors.foreground }}
                formatter={(value: number) => [
                  `${value} ${pluralRu(value, ["закупка", "закупки", "закупок"])}`,
                  "Количество",
                ]}
              />
              <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={20}>
                {data.map((_, index) => (
                  <Cell key={index} fill={chartColors.accent} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
