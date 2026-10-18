import deflatorsJson from "./normativesData/forecast-deflators.json";
import ssrJson from "./normativesData/ssr.json";
import type {
  ForecastDeflatorsData,
  ObjectPurpose,
  SsrChapterNorm,
  SsrData,
  SsrReserveRate,
} from "@/domain/estimate/ssrTypes";

/**
 * Справочники ССР и прогнозных дефляторов, перенесённые из 421/пр, 841/пр и письма Минэкономразвития.
 * Файлы собирает `scripts/fsnb/build-ssr.ts` из текстов в `data/fsnb/normatives/sources/`, вручную их не
 * правят. Рабочая копия лежит в `normativesData/` (каталог `data/` на сервер не выкладывается), эталон —
 * `data/fsnb/normatives/*.json`; равенство проверяет `scripts/fsnb/build-ssr.test.ts`.
 */

export const SSR: SsrData = ssrJson as unknown as SsrData;
export const FORECAST_DEFLATORS: ForecastDeflatorsData = deflatorsJson as unknown as ForecastDeflatorsData;

export const PURPOSE_LABELS: Readonly<Record<ObjectPurpose, string>> = {
  NON_PRODUCTION: "Непроизводственного назначения",
  PRODUCTION: "Производственного назначения, линейный объект",
  UNIQUE: "Уникальный, особо опасный или технически сложный",
};

export function chapterNorm(number: number): SsrChapterNorm | null {
  return SSR.chapters.find((chapter) => chapter.number === number) ?? null;
}

export function reserveRate(purpose: ObjectPurpose): SsrReserveRate {
  const rate = SSR.reserve.rates.find((item) => item.id === purpose);
  if (rate === undefined) throw new Error(`В справочнике ССР нет размера резерва для ${purpose}`);
  return rate;
}

/** Наибольший размер резерва, который заказчик вправе взять для объекта данного назначения, %. */
export function reserveLimitPercent(purpose: ObjectPurpose): number {
  return reserveRate(purpose).percent;
}

/** Годовой индекс-дефлятор «Инвестиции в основной капитал» (доля: 112,0 % → 1,12); null — года нет в таблице письма. */
export function annualDeflator(year: number): number | null {
  const found = FORECAST_DEFLATORS.indicators.investments.values.find((item) => item.year === year);
  return found === undefined ? null : found.percent / 100;
}

export function deflatorYears(): { readonly first: number; readonly last: number } {
  const years = FORECAST_DEFLATORS.indicators.investments.values.map((item) => item.year);
  return { first: Math.min(...years), last: Math.max(...years) };
}

/** «письмо Минэкономразвития России от 30.09.2026 № 36459-ПК/Д03и». */
export function forecastLetterLabel(): string {
  const { date, number } = FORECAST_DEFLATORS.letter;
  const [year, month, day] = date.split("-");
  return `письмо Минэкономразвития России от ${day ?? ""}.${month ?? ""}.${year ?? ""} № ${number}`;
}
