"use client";

import { useMemo, useState } from "react";

import { FileSpreadsheet } from "lucide-react";

import { AppliedNormatives } from "@/components/estimate/AppliedNormatives";
import { CostProfileEditor } from "@/components/estimate/CostProfileEditor";
import { Badge, Button } from "@/components/ui/primitives";
import type { TaxSystem } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import {
  bidHeadline,
  computeBidEconomics,
  evaluateMyPrice,
  QUICK_REDUCTION_PERCENT,
  SAFETY_MARGIN_CAP,
  type BidCostBase,
  type BidFlag,
  type ComparisonBand,
} from "@/domain/estimate/bidEconomics";
import { baseOriginText, TAX_TEXT } from "@/domain/estimate/bidEconomicsText";
import {
  DEFAULT_COST_PROFILE,
  effectiveMinMargin,
  isDefaultCostProfile,
  type CompanyCostProfile,
} from "@/domain/estimate/companyCostProfile";
import type { SsrResult } from "@/domain/estimate/ssr";
import type { EstimateDocument } from "@/domain/estimate/types";
import type { VatStatus } from "@/domain/estimate/vatStatus";
import { cn } from "@/lib/cn";
import { saveBytes, XLSX_MIME } from "@/lib/downloadFile";
import { userFacingError } from "@/lib/userError";

/**
 * Цена участия по индексной смете.
 *
 * Сама смета отвечает «сколько это стоит по нормам и текущим ценам Минстроя».
 * Человеку нужен следующий шаг: какую цену подавать и до какого снижения закупка
 * остаётся выгодной. Блок стоит над сметой, потому что это ответ, ради которого
 * смету и считали, — а сама смета ниже служит его основанием.
 *
 * Все числа считает `computeBidEconomics`, модель здесь не участвует. Допущения
 * (НМЦК с НДС, профиль затрат компании) показаны рядом и переключаются: от них границы
 * зависят сильнее всего, и человек обязан видеть, на чём они стоят.
 *
 * Блок отвечает на два вопроса. «Экономика участия»: безубыточная цена, минимальная цена с вашей маржой и допустимое
 * снижение — крупной строкой сверху. «Моя цена»: человек вводит свою цену (рублями или снижением от НМЦК, быстрыми
 * кнопками −5…−25 %) и видит выручку, себестоимость, налог, прибыль, маржу, вывод и антидемпинговое правило. Основа —
 * либо наша смета (`document`), либо смета заказчика, пересчитанная по ценам зоны (`costBase`, проверка сметы заказчика).
 * Профиль затрат правится здесь же и сохраняется в профиль компании (`onCostProfileChange`).
 */

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rub = (value: number | null): string => (value === null ? "—" : `${RUB.format(Math.round(value))} ₽`);
/** Процент; значение, округляющееся до нуля, печатается без знака («0,0 %», а не «−0,0 %»). */
const percent = (value: number | null, digits = 1): string => {
  if (value === null) return "—";
  const text = value.toFixed(digits);
  const zero = Number(text) === 0;
  return `${(zero ? text.replace("-", "") : text).replace(".", ",")} %`;
};

/** Компактные деньги для крупных плиток: «7,02 млн ₽»; до миллиона — рубли целиком. Полные рубли — в таблицах. */
const rubCompact = (value: number | null): string => {
  if (value === null) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(".", ",")} млн ₽`;
  return rub(value);
};

/** Краткий вывод строки таблицы цен. */
const VERDICT_SHORT: Record<"OK" | "BELOW_TARGET_MARGIN" | "LOSS", string> = {
  OK: "выгодно",
  BELOW_TARGET_MARGIN: "ниже маржи",
  LOSS: "убыток",
};

const VERDICT_BAR: Record<"OK" | "BELOW_TARGET_MARGIN" | "LOSS", string> = {
  OK: "bg-olive",
  BELOW_TARGET_MARGIN: "bg-mustard",
  LOSS: "bg-brick",
};

const VERDICT_FG: Record<"OK" | "BELOW_TARGET_MARGIN" | "LOSS", string> = {
  OK: "text-olive-fg",
  BELOW_TARGET_MARGIN: "text-mustard-fg",
  LOSS: "text-brick-fg",
};

/** Метка вывода в стиле остального интерфейса: тонкая цветная полоска, а не плашка. */
function VerdictMark({ verdict }: { verdict: "OK" | "BELOW_TARGET_MARGIN" | "LOSS" }) {
  return <span className={cn("inline-block h-3.5 w-[3px] shrink-0 rounded-full align-middle", VERDICT_BAR[verdict])} aria-hidden />;
}

/** Деньги не переносятся посреди суммы и стоят колонкой. */
const MONEY = "whitespace-nowrap tabular-nums";

/** Плитка-ответ: подпись, крупное значение, при нужде — тон. */
function Tile({ label, value, tone, testId, dataValue }: { label: string; value: string; tone?: "bad" | "accent"; testId: string; dataValue?: number | null }) {
  return (
    <div className="min-w-0 rounded-md border border-border/60 px-3 py-2.5" data-testid={testId} data-value={dataValue === null || dataValue === undefined ? undefined : String(Math.round(dataValue))}>
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className={cn("text-[22px] font-semibold leading-tight", MONEY, tone === "bad" && "text-brick-fg", tone === "accent" && "text-accent-fg")}>{value}</p>
    </div>
  );
}

const BAND_TEXT: Record<ComparisonBand, { label: string; tone: "olive" | "mustard" | "brick" | "neutral" }> = {
  ABOVE_ESTIMATE: { label: "НМЦК выше расчёта", tone: "olive" },
  NEAR_ESTIMATE: { label: "НМЦК на уровне расчёта", tone: "neutral" },
  BELOW_ESTIMATE: { label: "НМЦК ниже расчёта", tone: "mustard" },
  BELOW_COST: { label: "НМЦК ниже себестоимости", tone: "brick" },
  INCOMPLETE: { label: "Расчёт неполный", tone: "mustard" },
  NO_NMC: { label: "Цена не объявлена", tone: "neutral" },
};

/** Запас прочности: «+25,0 %»; у границы поиска — «более +500 %», а не ложно точная цифра. */
const safetyText = (value: number | null): string => {
  if (value === null) return "—";
  if (value >= SAFETY_MARGIN_CAP) return `более +${String(SAFETY_MARGIN_CAP)} %`;
  return value > 0 ? `+${percent(value)}` : percent(0);
};

const ANTI_DUMPING_HINT =
  "44-ФЗ, ст. 37: при снижении цены на 25 % и более от НМЦК обеспечение исполнения контракта увеличивается в 1,5 раза (при НМЦК до 15 млн ₽ можно подтвердить добросовестность исполненными контрактами). Сверьте с актуальной редакцией закона.";

/** Число из поля ввода: пробелы и запятая допускаются; пусто и не число — null. */
function parseNumber(text: string): number | null {
  const cleaned = text.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Откуда известно про НДС в цене: подпись рядом с переключателем. */
function vatBasisText(vat: VatStatus): string {
  if (vat.conflict) return "в документации встречаются оба варианта — проверьте вручную";
  switch (vat.basis) {
    case "DOCUMENT":
      return `из документации: «${vat.quote ?? ""}»${vat.documentName === null ? "" : ` (${vat.documentName})`}`;
    case "LAW_44":
      return "по 44-ФЗ цена контракта включает налоги — допущение, в документации прямо не указано";
    case "ASSUMPTION":
      return "НДС в документации не определён, принято «с НДС» — проверьте";
  }
}

const SEVERITY_ORDER: Record<BidFlag["severity"], number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };

export interface BidEconomicsCardProps {
  /** Наша смета по ведомости. Нет — основа задана `costBase`. */
  readonly document?: EstimateDocument;
  /** Основа по группам затрат: пересчёт сметы заказчика (проверка сметы заказчика). */
  readonly costBase?: BidCostBase;
  /** Доля затрат, которую не удалось переоценить, %: для проверки сметы заказчика. */
  readonly unverifiedPercent?: number;
  readonly nmc: number | null;
  /** НМЦК можно поправить в блоке «Моя цена» (проверка сметы: НМЦК — итог сметы заказчика, а не цена закупки). */
  readonly nmcEditable?: boolean;
  /** «НМЦК с НДС» по умолчанию, когда документации нет (проверка сметы: берётся из сметы заказчика). */
  readonly nmcIncludesVat?: boolean;
  /** Объект или закупка: имя файла Excel и шапка выгрузки. */
  readonly subject?: string;
  /** Второстепенные пояснения вызывающего экрана (откуда НМЦК и т. п.): уходят в «На чём стоят эти числа». */
  readonly notes?: readonly string[];
  /** Профиль затрат компании; нет — смета «как есть». */
  readonly costProfile?: CompanyCostProfile;
  /** Правка профиля затрат: вызывающий код сохраняет его в профиль компании. */
  readonly onCostProfileChange?: (next: CompanyCostProfile) => void;
  readonly billItems: number;
  readonly droppedPositions: number;
  readonly assumedPercent: number;
  readonly unpricedResources: number;
  readonly taxSystem: TaxSystem;
  readonly minMarginPercent: number;
  /** Закон закупки: для 44-ФЗ таблица отмечает снижение от 25 % (антидемпинг). */
  readonly law?: TenderLaw;
  /** Что документация говорит про НДС в цене. Нет — «с НДС» как допущение. */
  readonly vat?: VatStatus;
  /** Сводный расчёт: НМЦК сравнивается с нашей оценкой цены контракта, а не со сметой. */
  readonly ssr?: SsrResult | null;
}

/**
 * Шкала цены: от нуля до НМЦК тремя зонами, только цветом и короткими подписями. Суммы стоят в плитках над шкалой и не
 * повторяются: красная зона — убыток, золотая — прибыль есть, но ниже вашей маржи, зелёная — участие выгодно.
 */
function PriceScale({ nmc, breakEven, minPrice }: { nmc: number; breakEven: number; minPrice: number }) {
  const pct = (value: number) => Math.max(0, Math.min(100, (value / nmc) * 100));
  const loss = pct(breakEven);
  const lowMargin = Math.max(loss, pct(minPrice));
  return (
    <div data-testid="price-scale" className="space-y-1.5">
      <div
        className="flex h-3.5 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`Шкала цены от 0 до НМЦК ${rub(nmc)}: убыток до ${rub(breakEven)}, ниже вашей маржи до ${rub(minPrice)}, выгодно от ${rub(minPrice)}`}
      >
        <span className="bg-brick" style={{ width: `${loss}%` }} />
        <span className="bg-mustard" style={{ width: `${lowMargin - loss}%` }} />
        <span className="flex-1 bg-olive" />
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
        {[
          { bar: "bg-brick", label: "Убыток" },
          { bar: "bg-mustard", label: "Ниже вашей маржи" },
          { bar: "bg-olive", label: "Выгодно" },
        ].map((zone) => (
          <li key={zone.label} className="flex items-center gap-2">
            <span className={cn("h-3 w-[3px] rounded-full", zone.bar)} aria-hidden />
            {zone.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FlagList({ flags }: { flags: readonly { code: string; severity: string; message: string }[] }) {
  return (
    <ul className="space-y-1.5 text-[14px] leading-relaxed">
      {flags.map((flag) => (
        <li
          key={flag.code}
          className={cn(
            flag.severity === "CRITICAL" && "font-medium text-brick-fg",
            flag.severity === "HIGH" && "text-brick-fg",
            flag.severity === "MEDIUM" && "text-mustard-fg",
            flag.severity === "INFO" && "text-muted-foreground",
          )}
        >
          {flag.message}
        </li>
      ))}
    </ul>
  );
}

export function BidEconomicsCard(props: BidEconomicsCardProps) {
  const detectedVat = props.vat?.includesVat ?? props.nmcIncludesVat ?? true;
  // Выбор человека хранится отдельно от найденного в документах: пока он не
  // трогал переключатель, значение следует за документацией, даже если оно
  // появилось позже первого показа.
  const [vatChoice, setVatChoice] = useState<boolean | null>(null);
  const nmcIncludesVat = vatChoice ?? detectedVat;
  const vatOverridden = props.vat !== undefined && nmcIncludesVat !== props.vat.includesVat;

  // Профиль затрат: правка человека поверх того, что пришло из профиля компании; сохраняет её вызывающий код.
  const [costChoice, setCostChoice] = useState<CompanyCostProfile | null>(null);
  const costProfile = costChoice ?? props.costProfile ?? DEFAULT_COST_PROFILE;
  const { onCostProfileChange } = props;
  const changeCostProfile = (next: CompanyCostProfile): void => {
    setCostChoice(next);
    onCostProfileChange?.(next);
  };

  // НМЦК, названная человеком в блоке «Моя цена»; пусто — как пришла.
  const [nmcText, setNmcText] = useState("");
  const typedNmc = parseNumber(nmcText);
  const nmc = typedNmc !== null && typedNmc > 0 ? typedNmc : props.nmc;

  const economics = useMemo(
    () =>
      computeBidEconomics({
        ...(props.document === undefined ? {} : { document: props.document }),
        ...(props.costBase === undefined ? {} : { costBase: props.costBase }),
        ...(props.unverifiedPercent === undefined ? {} : { unverifiedPercent: props.unverifiedPercent }),
        nmc,
        billItems: props.billItems,
        droppedPositions: props.droppedPositions,
        assumedPercent: props.assumedPercent,
        unpricedResources: props.unpricedResources,
        company: { taxSystem: props.taxSystem, minMarginPercent: effectiveMinMargin(props.minMarginPercent) },
        nmcIncludesVat,
        costProfile,
        law: props.law,
        ssr: props.ssr ?? null,
        // Основание описывает то, что нашли в документах: после ручной смены
        // переключателя оно уже не про текущее значение, и пометка остаётся общей.
        ...(props.vat !== undefined && !vatOverridden
          ? { vatBasis: props.vat.basis, vatQuote: props.vat.quote, vatConflict: props.vat.conflict }
          : {}),
      }),
    [props, nmc, nmcIncludesVat, costProfile, vatOverridden],
  );

  // «Моя цена»: что вводил человек — рубли или снижение; второе поле показывает пересчёт.
  const [priceInput, setPriceInput] = useState<{ mode: "price" | "reduction"; text: string }>({ mode: "reduction", text: "" });
  const myPrice = useMemo(() => {
    const value = parseNumber(priceInput.text);
    if (value === null) return null;
    return evaluateMyPrice(economics, priceInput.mode === "price" ? { price: value } : { reductionPercent: value });
  }, [economics, priceInput]);
  const [tableDetails, setTableDetails] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const download = async (): Promise<void> => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const { buildBidWorkbook, bidWorkbookFileName } = await import("@/domain/estimate/bidEconomicsXlsx");
      const subject = props.subject?.trim() === undefined || props.subject.trim() === "" ? "Расчёт цены участия" : props.subject.trim();
      const generatedAt = new Date();
      const bytes = await buildBidWorkbook({ economics, myPrice, subject, generatedAt });
      saveBytes(bytes, bidWorkbookFileName(props.subject ?? "", generatedAt), XLSX_MIME);
    } catch (err) {
      setDownloadError(userFacingError(err, "Не удалось собрать книгу — повторите через минуту."));
    } finally {
      setDownloading(false);
    }
  };

  if (economics.status === "EMPTY") {
    return (
      <section className="rounded-md border border-border p-3" aria-label="Цена участия">
        <h3 className="text-sm font-semibold">Цена участия</h3>
        <p className="mt-1 text-sm text-muted-foreground">{economics.flags[0]?.message}</p>
      </section>
    );
  }

  const band = BAND_TEXT[economics.band];
  const flags = [...economics.flags].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const headline = bidHeadline(economics);
  // На виду — одна самая важная пометка, и только если она предупреждает; остальное — в «На чём стоят эти числа».
  const warning = flags[0] !== undefined && flags[0].severity !== "INFO" ? flags[0] : null;
  const closestRow =
    myPrice === null || myPrice.percentOfNmc === null
      ? null
      : economics.priceTable.reduce<(typeof economics.priceTable)[number] | null>(
          (best, row) =>
            best === null || Math.abs(row.percentOfNmc - (myPrice.percentOfNmc ?? 0)) < Math.abs(best.percentOfNmc - (myPrice.percentOfNmc ?? 0)) ? row : best,
          null,
        );
  const costDelta =
    economics.assumptions.costProfileApplied && economics.basis.costByEstimate > 0
      ? ((economics.basis.cost - economics.basis.costByEstimate) / economics.basis.costByEstimate) * 100
      : null;
  const nmcFieldShown = props.nmc === null || props.nmcEditable === true;
  // Маржа в профиле не задана (0): расчёт взял значение по умолчанию и говорит об этом.
  const marginAssumed = !(props.minMarginPercent > 0);

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Цена участия">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Экономика участия</h3>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={band.tone}>{band.label}</Badge>
          <Badge tone={economics.confidence.score >= 75 ? "olive" : economics.confidence.score >= 50 ? "mustard" : "brick"}>
            Надёжность расчёта {economics.confidence.score}
          </Badge>
        </div>
      </div>

      {headline !== null && (
        <div className="space-y-2" data-testid="bid-headline">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile testId="tile-break-even" label="Безубыточно от" value={rubCompact(economics.breakEvenPrice)} dataValue={economics.breakEvenPrice} />
            <Tile
              testId="tile-min-price"
              label={`С маржой ${percent(economics.minMarginPercent, 0)} — от`}
              value={rubCompact(economics.minAcceptablePrice)}
              dataValue={economics.minAcceptablePrice}
            />
            {economics.maxReductionPercent === null ? (
              <Tile testId="tile-reduction" label="Снижать можно до" value="укажите НМЦК" />
            ) : economics.maxReductionPercent <= 0 ? (
              <Tile testId="tile-reduction" label="Снижать можно до" value="нельзя" tone="bad" dataValue={0} />
            ) : (
              <Tile
                testId="tile-reduction"
                label="Снижать можно до"
                value={`${percent(economics.maxReductionPercent)} от НМЦК`}
                tone="accent"
                dataValue={economics.maxReductionPercent}
              />
            )}
          </div>
          <p className="text-[13px] text-muted-foreground" data-testid="bid-safety">
            НМЦК <span className={MONEY}>{rub(economics.nmc)}</span>
            {economics.ratioToEstimate !== null &&
              ` (${economics.ratioToEstimate.toFixed(2).replace(".", ",")} от ${economics.ssr === null ? "расчёта" : "нашей оценки НМЦК"})`}
            {economics.safetyMarginPercent !== null && (
              <>
                {" · "}Запас прочности при НМЦК {safetyText(economics.safetyMarginPercent)}
                <span className="hidden sm:inline"> — на столько могут вырасти затраты до нулевой прибыли</span>
              </>
            )}
          </p>
        </div>
      )}

      {economics.nmc !== null &&
        economics.nmc > 0 &&
        economics.breakEvenPrice !== null &&
        economics.minAcceptablePrice !== null && (
          <PriceScale nmc={economics.nmc} breakEven={economics.breakEvenPrice} minPrice={economics.minAcceptablePrice} />
        )}

      {warning !== null && (
        <p className={cn("text-[13.5px] leading-snug", warning.severity === "MEDIUM" ? "text-mustard-fg" : "text-brick-fg")} data-testid="bid-warning">
          {warning.message}
        </p>
      )}

      <div className="space-y-3 rounded-md border border-border/60 p-3" data-testid="my-price">
        <p className="text-sm font-semibold">Моя цена</p>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          {nmcFieldShown && (
            <label className="block text-[13px] text-muted-foreground">
              НМЦК, ₽{props.nmc === null ? " (если знаете)" : ""}
              <input
                type="text"
                inputMode="decimal"
                aria-label="НМЦК, ₽"
                value={nmcText}
                placeholder={props.nmc === null ? "не объявлена" : String(Math.round(props.nmc))}
                onChange={(event) => setNmcText(event.target.value)}
                className="input mt-1 block w-44 tabular-nums"
              />
            </label>
          )}
          <label className="block text-[13px] text-muted-foreground">
            Цена, ₽
            <input
              type="text"
              inputMode="decimal"
              aria-label="Моя цена, ₽"
              value={priceInput.mode === "price" ? priceInput.text : myPrice === null ? "" : String(Math.round(myPrice.price))}
              placeholder="например 4 500 000"
              onChange={(event) => setPriceInput({ mode: "price", text: event.target.value })}
              className="input mt-1 block w-44 tabular-nums"
            />
          </label>
          <label className="block text-[13px] text-muted-foreground">
            Снижение от НМЦК, %
            <input
              type="text"
              inputMode="decimal"
              aria-label="Снижение от НМЦК, %"
              disabled={economics.nmc === null}
              value={
                priceInput.mode === "reduction"
                  ? priceInput.text
                  : myPrice?.reductionPercent === null || myPrice === null
                    ? ""
                    : String(myPrice.reductionPercent).replace(".", ",")
              }
              placeholder={economics.nmc === null ? "нужна НМЦК" : "например 12"}
              onChange={(event) => setPriceInput({ mode: "reduction", text: event.target.value })}
              className="input mt-1 block w-36 tabular-nums disabled:opacity-50"
            />
          </label>
          {economics.nmc !== null && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Быстрый выбор снижения">
              {QUICK_REDUCTION_PERCENT.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPriceInput({ mode: "reduction", text: String(value) })}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[13px] tabular-nums transition-colors",
                    priceInput.mode === "reduction" && priceInput.text === String(value)
                      ? "border-accent bg-accent-subtle text-accent-fg"
                      : "border-border text-foreground hover:border-accent-line",
                  )}
                >
                  −{value} %
                </button>
              ))}
            </div>
          )}
        </div>

        {economics.nmc === null && (
          <p className="text-[13px] text-muted-foreground">
            НМЦК не объявлена — введите цену в рублях или укажите НМЦК, если знаете: тогда считаются проценты снижения.
          </p>
        )}

        {myPrice === null ? (
          <p className="text-[13px] text-muted-foreground" data-testid="my-price-empty">
            Введите цену или нажмите «−10 %»: покажем выручку, налог, прибыль и маржу.
          </p>
        ) : (
          <div className="space-y-1.5" data-testid="my-price-result">
            <p className="text-[16px] leading-snug text-foreground" data-testid="my-price-line">
              <VerdictMark verdict={myPrice.verdict} />{" "}
              При <span className={cn("font-semibold", MONEY)}>{rub(myPrice.price)}</span>
              {myPrice.reductionPercent !== null && (
                <span className={MONEY}>{` (${myPrice.reductionPercent > 0 ? "−" : myPrice.reductionPercent < 0 ? "+" : ""}${percent(Math.abs(myPrice.reductionPercent), 0)})`}</span>
              )}
              : прибыль{" "}
              <span className={cn("font-semibold", MONEY, myPrice.profit < 0 && "text-brick-fg")} data-testid="my-price-profit">
                {rub(myPrice.profit)}
              </span>
              {" · "}маржа{" "}
              <span className={cn("font-semibold", MONEY)} data-testid="my-price-margin">
                {percent(myPrice.marginPercent)}
              </span>
              {" — "}
              <span className={cn("font-semibold", VERDICT_FG[myPrice.verdict])} data-testid="my-price-verdict">
                {myPrice.verdict === "OK" ? "выгодно" : myPrice.verdict === "LOSS" ? "убыток" : "ниже вашей цели"}
              </span>
            </p>
            <p className="text-[12.5px] text-muted-foreground" data-testid="my-price-details">
              Выручка <span className={MONEY}>{rub(myPrice.revenue)}</span> · себестоимость <span className={MONEY}>{rub(myPrice.cost)}</span> · налог{" "}
              <span className={MONEY}>{rub(myPrice.tax)}</span>
              {myPrice.verdict === "BELOW_TARGET_MARGIN" && <> · цель по марже {percent(economics.minMarginPercent, 0)}</>}
            </p>
            {myPrice.aboveNmc && (
              <p className="text-[13px] text-brick-fg" data-testid="my-price-above">
                Цена выше НМЦК: по 44-ФЗ такая заявка не принимается.
              </p>
            )}
            {myPrice.antiDumping !== null && (
              <p className="text-[13px] text-mustard-fg" data-testid="my-price-antidumping">
                Антидемпинговая мера: {myPrice.antiDumping.text}
              </p>
            )}
          </div>
        )}
      </div>

      {economics.priceTable.length > 0 && (
        <div className="space-y-2" data-testid="price-table">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[15px] font-semibold tracking-tight text-foreground">Что останется компании при разной цене</p>
            <button
              type="button"
              aria-expanded={tableDetails}
              onClick={() => setTableDetails((open) => !open)}
              className="text-[13px] text-accent-fg underline-offset-2 hover:underline"
            >
              {tableDetails ? "Скрыть выручку, затраты и налог" : "Подробнее: выручка, затраты, налог"}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className={cn("w-full text-[14px] tabular-nums", tableDetails ? "min-w-[760px]" : "min-w-[440px]")}>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="whitespace-nowrap py-2 pr-3 font-medium">Цена</th>
                  {tableDetails && <th className="whitespace-nowrap py-2 pr-3 text-right font-medium">Выручка</th>}
                  {tableDetails && <th className="whitespace-nowrap py-2 pr-3 text-right font-medium">Затраты</th>}
                  {tableDetails && <th className="whitespace-nowrap py-2 pr-3 text-right font-medium">Налог</th>}
                  <th className="whitespace-nowrap py-2 pr-3 text-right font-medium">Прибыль</th>
                  <th className="whitespace-nowrap py-2 pr-3 text-right font-medium">Маржа</th>
                  {tableDetails && (
                    <th
                      className="whitespace-nowrap py-2 pr-3 text-right font-medium"
                      title="На сколько процентов могут вырасти затраты при этой цене до нулевой прибыли"
                    >
                      Запас
                    </th>
                  )}
                  <th className="whitespace-nowrap py-2 font-medium">Итог</th>
                </tr>
              </thead>
              <tbody>
                {economics.priceTable.map((row) => (
                  <tr
                    key={row.percentOfNmc}
                    className={cn("border-t border-border", closestRow === row && "bg-accent-subtle")}
                    aria-current={closestRow === row ? "true" : undefined}
                    data-closest={closestRow === row ? "true" : undefined}
                  >
                    <td className={cn("py-2.5 pr-3", MONEY)}>
                      {row.percentOfNmc} % · {rub(row.price)}
                    </td>
                    {tableDetails && <td className={cn("py-2.5 pr-3 text-right", MONEY)}>{rub(row.revenue)}</td>}
                    {tableDetails && <td className={cn("py-2.5 pr-3 text-right", MONEY)}>{rub(row.cost)}</td>}
                    {tableDetails && <td className={cn("py-2.5 pr-3 text-right", MONEY)}>{rub(row.tax)}</td>}
                    <td className={cn("py-2.5 pr-3 text-right", MONEY, row.profit < 0 && "text-brick-fg")}>{rub(row.profit)}</td>
                    <td className={cn("py-2.5 pr-3 text-right", MONEY)}>{percent(row.marginPercent)}</td>
                    {tableDetails && (
                      <td className={cn("py-2.5 pr-3 text-right", MONEY, row.safetyMarginPercent <= 0 && "text-brick-fg")}>
                        {safetyText(row.safetyMarginPercent)}
                      </td>
                    )}
                    <td className={cn("whitespace-nowrap py-2.5 font-medium", VERDICT_FG[row.verdict])}>
                      <VerdictMark verdict={row.verdict} /> {VERDICT_SHORT[row.verdict]}
                      {row.antiDumping && (
                        <span
                          className="ml-2 cursor-help font-normal text-mustard-fg before:mr-2 before:content-['·']"
                          title={ANTI_DUMPING_HINT}
                        >
                          антидемпинг
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {economics.stress.length > 0 && (
        <details className="rounded-md border border-border/60 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Если затраты окажутся выше расчёта
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">Цена</th>
                  <th className="py-1 pr-3 text-right font-normal">Затраты как в расчёте</th>
                  <th className="py-1 pr-3 text-right font-normal">+10 %</th>
                  <th className="py-1 text-right font-normal">+20 %</th>
                </tr>
              </thead>
              <tbody>
                {[100, 90, 80].map((share) => {
                  const cells = economics.stress.filter((cell) => cell.percentOfNmc === share);
                  return (
                    <tr key={share} className="border-t border-border/60">
                      <td className="py-2.5 pr-3">{share} % НМЦК</td>
                      {cells.map((cell) => (
                        <td
                          key={cell.costOverrunPercent}
                          className={cn("py-1 pr-3 text-right", cell.profit < 0 && "text-brick-fg")}
                        >
                          {rub(cell.profit)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-muted-foreground">Прибыль после налогов при перерасходе затрат.</p>
          </div>
        </details>
      )}

      <details className="rounded-md border border-border/60 px-3 py-2" data-testid="cost-profile">
        <summary className="cursor-pointer text-sm font-medium">
          Мои затраты: скидки, свой труд, субподряд
          <span className="ml-2 text-[13px] font-normal text-muted-foreground">
            {isDefaultCostProfile(costProfile) ? "как в смете" : "поправки применены"}
          </span>
        </summary>
        <div className="mt-3 space-y-2">
          <p className="text-[13px] text-muted-foreground">
            Смета считает затраты «как по нормам». Укажите, чем ваши отличаются, — границы цены пересчитаются под вас и сохранятся в профиле компании.
          </p>
          <CostProfileEditor value={costProfile} onChange={changeCostProfile} idPrefix="bid-cost" />
        </div>
      </details>

      <details className="rounded-md border border-border/60 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">На чём стоят эти числа</summary>
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">
          <p data-testid="bid-base-note">
            Основа: {baseOriginText(economics.baseOrigin)}.
            {costDelta !== null &&
              ` Ваша себестоимость на ${Math.abs(costDelta).toFixed(1).replace(".", ",")} % ${costDelta < 0 ? "ниже" : "выше"} сметной — по профилю затрат.`}
            {marginAssumed && " Минимальная маржа 10 % принята по умолчанию — укажите свою в профиле компании."}
          </p>
          {(props.notes ?? []).map((note) => (
            <p key={note}>{note}</p>
          ))}
          {flags.length > 0 && (
            <div data-testid="bid-flags">
              <FlagList flags={flags.filter((flag) => flag !== warning)} />
            </div>
          )}
          <p>
            Себестоимость {rub(economics.basis.cost)}
            {economics.assumptions.costProfileApplied && ` (как по смете — ${rub(economics.basis.costByEstimate)})`} = прямые
            затраты {rub(economics.basis.directCost)} по смете
            {economics.assumptions.costProfileApplied && " с вашими поправками"} + накладные{" "}
            {rub(economics.basis.costStructure.overhead)}
            {economics.basis.limitedCosts > 0 && ` + лимитированные ${rub(economics.basis.limitedCosts)}`}
            {economics.basis.nonDeductibleVat > 0 && ` + НДС на материалы ${rub(economics.basis.nonDeductibleVat)}`}. Сметная
            прибыль {rub(economics.basis.estimatedProfit)} — это норматив, а не ваши затраты: в себестоимость она не входит.
          </p>
          <p>Налоги: {TAX_TEXT[economics.taxKind]}. Страховые взносы и вычеты не учтены.</p>
          {props.document?.appliedNormatives !== undefined && props.document.appliedNormatives.length > 0 && (
            <div data-testid="bid-normatives">
              <p className="font-medium text-foreground">Нормативы, по которым начислено сверх норм</p>
              <AppliedNormatives normatives={props.document.appliedNormatives} compact />
            </div>
          )}
          {economics.confidence.reasons.length > 0 && (
            <p>Надёжность расчёта: {economics.confidence.reasons.join("; ")}.</p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-foreground">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={nmcIncludesVat}
                onChange={(e) => setVatChoice(e.target.checked)}
                className="h-4 w-4 accent-[rgb(var(--accent))]"
              />
              НМЦК с НДС
            </label>
            {props.vat !== undefined && (
              <span className="text-xs text-muted-foreground" data-testid="vat-basis">
                {vatBasisText(props.vat)}
                {vatOverridden && " · значение изменено вами"}
              </span>
            )}
          </div>
          <p className="text-xs">
            Расчёт информационный: смета по ФСНБ-2022 и текущим ценам Минстроя показывает порядок затрат, а не ваши
            реальные цены поставщиков и субподрядчиков. Для решения о цене проверьте крупные статьи.
          </p>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => void download()} disabled={downloading} className="gap-1.5">
          <FileSpreadsheet className="h-3.5 w-3.5" />
          {downloading ? "Собираем книгу..." : "Скачать расчёт (Excel)"}
        </Button>
        {downloadError !== null && <span className="text-sm text-brick-fg">{downloadError}</span>}
      </div>
    </section>
  );
}
