import { isServiceItem, type ZoneAutoServices } from "@/domain/estimate/autoServices";
import { bundledBimIndexBook, type BimIndexBook } from "@/domain/estimate/bimIndices";
import { chooseMethod, detectCustomerMethod, type MethodChoice } from "@/domain/estimate/bimMethod";
import { zoneOfName } from "@/domain/estimate/bimSubjects";
import { buildEstimate, type EstimatePriceBook } from "@/domain/estimate/calculate";
import { buildBimEstimate, selectBimIndices, type BimSelection, type FerResolver } from "@/domain/estimate/calculateBim";
import { parseCustomerBim, type CustomerBim } from "@/domain/estimate/customerBim";
import { CUSTOMER_NORM_BASE_LABEL } from "@/domain/estimate/customerEstimate";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { ferLookupOf, FerBaseUnavailableError, BIM_BUILD_COMMAND, ferKey, loadBimIndexBook, loadFerBase, type FerBase } from "@/repositories/bimRepository";
import { findNorms, normKey, trustedByName, type NormMatch } from "@/domain/estimate/matchNorms";
import { normalizeNormCode } from "@/domain/estimate/normalize";
import {
  resolveNormCode,
  unitsCompatible,
  type NormCatalog,
  type NormCodeHint,
} from "@/domain/estimate/normCodes";
import {
  crossCheckVolumes,
  inheritCustomerPrice,
  matchCustomerRow,
  variantsOf,
} from "@/domain/estimate/volumeCrossCheck";
import { extractDeclaredPriceLevel, priceLevelDifferences } from "@/domain/estimate/customerPriceLevel";
import { zoneNumberIn, type IndexPriceLevel } from "@/domain/estimate/priceLevel";
import type { ContractCheck } from "@/domain/estimate/contractEstimate";
import { summarizeCustomerConditions } from "@/domain/estimate/customerCoefficients";
import type { LsrSourceInfo } from "@/domain/estimate/customerLsrSet";
import { deriveUnitDivisor } from "@/domain/estimate/billExtraction";
import { baseUnitOf } from "@/domain/estimate/units";
import { noVolumesGap } from "@/domain/estimate/noVolumes";
import type {
  AppliedNormative,
  BillOfWorkItem,
  BillOfWorkSection,
  EstimateDocument,
  EstimateGap,
  EstimateParameters,
  EstimatePriceZoneChoice,
  EstimateSource,
  OverheadRate,
  NormRecord,
  SplitAllPrice,
  VolumeFinding,
  VolumeSource,
} from "@/domain/estimate/types";
import { buildRowInfos, type BillRowInfo, type EstimateBillSnapshot } from "@/domain/estimate/billReview";
import type { RejectedBillRow } from "@/domain/estimate/billExtraction";
import { EMPTY_NORM_PICK_STATS, type NormPicker, type NormPickStats } from "@/domain/estimate/normPick";
import { buildDebrisItems } from "@/domain/estimate/debrisItems";
import {
  EMPTY_GENERATED_DEBRIS,
  EMPTY_GENERATED_IMPLIED,
  EMPTY_GENERATED_STATS,
  withGeneratedCosts,
  type GeneratedStats,
} from "@/domain/estimate/generatedItems";
import type { ImpliedProposer } from "@/domain/estimate/impliedWorks";
import { withImpliedWorks } from "@/services/estimateImplied";
import { mergeNormMaterialStats, withNormMaterials } from "@/services/estimateNormMaterial";
import { withNormPicks } from "@/services/estimateNormPick";
import { remoteImpliedProposer } from "@/services/impliedWorksService";
import { remoteNormPicker } from "@/services/normPickService";
import {
  extractBillOfWork,
  remoteBillRows,
  type BillDocumentInput,
  type BillRowsFetcher,
} from "@/services/billOfWorkExtraction";
import {
  loadEstimateBase,
  loadOverheadRateMap,
  loadZoneAuditPrices,
  loadZoneAutoServices,
  type EstimateBase,
} from "@/repositories/estimateBaseRepository";
import type { NorthZone } from "@/domain/estimate/overheadNormatives";
import type { PriceZoneBasis } from "@/domain/estimate/priceZoneResolve";
import { hasLimitedOptions, NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { resolveLimited } from "@/domain/estimate/limitedCosts";
import type { NorthBasis } from "@/domain/estimate/north";

/**
 * Сборка сметы по документации: от текста документов до готового документа.
 *
 * Здесь сходятся три части, каждая из которых уже есть по отдельности: разбор
 * ведомости моделью, подбор норм по ФСНБ и детерминированный расчёт. Сервис не
 * добавляет к ним арифметики — он только связывает их и честно сообщает, что
 * потерялось по дороге.
 *
 * Почему это не идёт в браузер и не пойдёт на Vercel. База ФСНБ — 56 242 нормы
 * и справочники цен, она занимает около 600 МБ памяти и читается с диска за две
 * секунды. В поставку она не входит намеренно, поэтому расчёт живёт там, где
 * лежит каталог индекса: на машине разработчика и на сервере воркера. Если
 * базы нет, сервис не делает вид, что посчитал, а возвращает причину и команду
 * сборки.
 *
 * Делитель единиц назначается здесь, а не при извлечении ведомости: он зависит
 * от единицы найденной нормы («м3» в ведомости против «100 м3» в расценке), а
 * норма известна только после подбора.
 */

/** Почему и как выбрана ценовая зона: основание — в документ, зона Севера — в нормативы НР. */
export interface EstimatePriceZoneInput {
  readonly basis: PriceZoneBasis;
  readonly matched: string | null;
  readonly northZone: NorthZone;
  /** Как определена северность (перечень районов Крайнего Севера); нет — старый вызов. */
  readonly northBasis?: NorthBasis;
  /** Пояснения выбора зоны (например, зона из сметы заказчика не принята): уходят в пробелы документа. */
  readonly notes?: readonly string[];
}

/** Где находится объект: нужно, чтобы определить температурную зону и северность. */
export interface EstimateTenderPlace {
  readonly region: string | null;
  readonly address?: string | null;
  readonly customerName?: string | null;
}

export interface EstimateRequestInput {
  readonly regNumber: string;
  readonly subject: string;
  readonly documents: readonly BillDocumentInput[];
  /** Параметры расчёта: НДС, резервные нормативы, лимитированные затраты. */
  readonly parameters: EstimateParameters;
  readonly now?: Date;
  /** Задание воркера (sync_jobs.id): к нему привязывается расход на модель. */
  readonly jobId?: string;
  /**
   * Ценовая зона ФГИС ЦС, по ценам которой считается смета. Воркер всегда её
   * передаёт; без неё берётся зона по умолчанию (старые вызовы, демо-скрипт).
   */
  readonly priceZoneId?: number;
  /** Как зона выбрана. Без него в документ основание не попадает. */
  readonly priceZoneChoice?: EstimatePriceZoneInput;
  /**
   * Выбор пользователя: вид работ, условия производства работ, сроки. Нет — смета считается без
   * начислений сверх норм, как раньше (нули в `parameters.limited` остаются).
   */
  readonly options?: EstimateOptions;
  /** Место объекта по данным закупки; нужно для температурной зоны зимнего удорожания. */
  readonly place?: EstimateTenderPlace;
  /**
   * Название выбранной ценовой зоны («Республика Бурятия (5 зона)»). Базисно-индексный метод берёт по нему субъект и зону
   * индексов Минстроя: книгу цен зоны он не читает. Нет — берётся регион закупки.
   */
  readonly priceZoneName?: string;
}

/** Как для позиции выбрана норма по шифру: показывается в отчёте о расчёте. */
export interface NormHintNote {
  readonly workName: string;
  /** Шифр, как он прочитан из документа (после замены префикса). */
  readonly rawCode: string;
  /** Код нормы, которая взята. */
  readonly code: string;
  readonly baseType: string;
  /** Цифры шифра исправлены по базе. */
  readonly restored: boolean;
  /** Шифр стоял в самой строке или подсказан сметой заказчика. */
  readonly source: "ITEM" | "CUSTOMER_ESTIMATE";
}

export interface EstimateBuildResult {
  readonly document: EstimateDocument;
  /** Строки, не подтверждённые документом: показываются пользователю. */
  readonly rejected: readonly RejectedBillRow[];
  readonly documentsWithoutBill: readonly string[];
  /** Документы и файлы архивов, которые модель не читала: объёмов в них не видно (`documentRelevance.ts`). Нет — читалось всё. */
  readonly skippedNoVolumes?: readonly { readonly name: string; readonly reason: string; readonly chars: number }[];
  readonly billItems: number;
  readonly tokensUsed: number;
  /** Откуда взяты объёмы расчёта. null — подтверждённых строк нет. */
  readonly volumeSource: VolumeSource | null;
  /** Расхождения ведомости со сметой заказчика: на сумму не влияют. */
  readonly volumeFindings: readonly VolumeFinding[];
  /** Позиции, норма которых взята по шифру, а не найдена поиском. */
  readonly normHints: readonly NormHintNote[];
  /** Документы, попавшие в набор дважды: считались один раз. */
  readonly duplicateDocuments: readonly { readonly name: string; readonly duplicateOf: string }[];
  /** Локальные сметы заказчика, прочитанные кодом, без повторов между документами. */
  readonly customerLsrs: readonly LsrSourceInfo[];
  /** Сверка сметы контракта с ЛСР; null — сверять не с чем. */
  readonly contractCheck: ContractCheck | null;
  /**
   * Ведомость в том виде, в каком она ушла в расчёт, и сведения о подборе норм по каждой позиции.
   * По ней человек правит объёмы и нормы, а пересчёт идёт без модели (`estimateRecalc.ts`).
   */
  readonly bill: EstimateBillSnapshot;
  /**
   * Что сделал «ИИ-сметчик» (`estimateNormPick.ts`): сколько норм принято, отклонено проверкой, откатилось на подбор по наименованию
   * и сколько токенов ушло. Нули — подбор не шёл (нет `deps.normPicker`, шифры у всех позиций, расчёт БИМ).
   */
  readonly normPick: NormPickStats;
  /**
   * Строки, добавленные расчётом сверх ведомости (`generatedItems.ts`): мусор по тоннажу из норм и работы по технологии от ИИ — сколько добавлено, на сколько
   * рублей, что отклонила проверка. Нули — этапы не шли (смета по ЛСР заказчика, опции выключены, расчёт БИМ, нет подборщика).
   */
  readonly generated: GeneratedStats;
}

/** База не собрана: расчёт невозможен, и это надо сказать словами. */
export class EstimateBaseMissingError extends Error {
  constructor(
    message: string,
    readonly indexDir: string,
    readonly command: string,
  ) {
    super(message);
    this.name = "EstimateBaseMissingError";
  }
}

/**
 * Пометки об уровне цен: смета заказчика составлена не в нашей зоне или не в нашем квартале.
 *
 * Не отказ. Раньше расчёт отказывал, если первый «N квартал» или «N зона» где угодно в любом документе не совпадал
 * с книгой цен, — и фраза договора «работы выполняются в IV квартале 2026» закрывала расчёт целиком, а сметы заказчика в
 * более раннем квартале (мы собираем только последний) делали функцию непригодной. Теперь уровень цен читается
 * только из шапок смет заказчика; расхождение — пометка документа `PRICE_LEVEL_DIFFERS`: расчёт идёт в нашем уровне цен,
 * а человек знает, что построчное сравнение цен со сметой заказчика неточно. Нет смет заказчика (или шапка молчит) —
 * сверять нечего и пометок нет. `zoneNotes` — пояснения выбора зоны (зона из сметы заказчика отвергнута).
 */
export function priceLevelGaps(
  documents: readonly BillDocumentInput[],
  ours: IndexPriceLevel,
  zoneNotes: readonly string[] = [],
): EstimateGap[] {
  const messages = [...zoneNotes, ...priceLevelDifferences(extractDeclaredPriceLevel(documents), ours)];
  return messages.map((message) => ({ kind: "PRICE_LEVEL_DIFFERS" as const, message, code: null, baseType: null }));
}

/**
 * Пометка о другой базе норм: смета заказчика составлена по ТСН-2001 Москвы, а наш расчёт идёт по ФСНБ-2022. Норм ТСН у нас нет, поэтому позиции такой
 * сметы подобраны по наименованию (с пометкой «проверьте») либо взяты по цене заказчика, и построчное сравнение норм со сметой заказчика не
 * «like-for-like». Одна пометка на документ, сколько бы смет по ТСН ни нашлось; нет таких смет — пометки нет.
 */
export function customerBaseGaps(lsrs: readonly Pick<LsrSourceInfo, "base" | "number" | "title" | "positions" | "subPositions">[]): EstimateGap[] {
  const tsn = lsrs.filter((info) => info.base === "TSN_2001_MOSCOW");
  if (tsn.length === 0) return [];
  const names = tsn.map((info) => (info.number ?? info.title ?? "без номера").replace(/\s+/g, " ").trim()).join(", ");
  const positions = tsn.reduce((sum, info) => sum + info.positions + info.subPositions, 0);
  return [
    {
      kind: "CUSTOMER_BASE_DIFFERS",
      message:
        `Смета заказчика составлена по ${CUSTOMER_NORM_BASE_LABEL.TSN_2001_MOSCOW} (${tsn.length === 1 ? "смета" : "сметы"} ${names}, позиций: ${String(positions)}), а наша — по ФСНБ-2022: ` +
        "построчное сравнение норм не like-for-like. Норм ТСН у нас нет: работы подобраны по наименованию (в таблице «Ведомость и нормы» помечены «проверьте») " +
        "или, если уверенного подбора нет, взяты по цене заказчика",
      code: null,
      baseType: null,
    },
  ];
}

/** Пропущенные моделью фрагменты (`extractBillOfWork`): потеря строк не молчаливая, а пробел сметы. */
export function unreadChunkGaps(chunks: readonly { readonly message: string }[]): EstimateGap[] {
  return chunks.map((chunk) => ({
    kind: "BILL_CHUNK_UNREAD" as const,
    message: `Ведомость прочитана не целиком: ${chunk.message}; строки этого фрагмента в смету не вошли`,
    code: null,
    baseType: null,
  }));
}

/**
 * Пробел «в документах нет объёмов»: ни одной позиции и ни одного источника объёмов. Смета при этом пуста, и
 * человеку нужно сказать, что просмотрено и что делать, а не оставить ноль рублей без объяснения (`noVolumes.ts`).
 */
export function noVolumeGaps(
  result: Pick<EstimateBuildResult, "billItems" | "volumeSource" | "documentsWithoutBill" | "skippedNoVolumes">,
  documentCount: number,
  unreadChunks: number,
): EstimateGap[] {
  if (result.billItems > 0 || result.volumeSource !== null) return [];
  return [
    noVolumesGap({
      documentCount,
      documentsWithoutBill: result.documentsWithoutBill,
      skippedNoVolumes: result.skippedNoVolumes ?? [],
      unreadChunks,
    }),
  ];
}

function withGaps(result: EstimateBuildResult, gaps: readonly EstimateGap[]): EstimateBuildResult {
  return gaps.length === 0 ? result : { ...result, document: { ...result.document, gaps: [...result.document.gaps, ...gaps] } };
}

/**
 * Назначает единицу и делитель по норме, которую подобрал поиск.
 *
 * У парного объёма («103,65/82,92 м3/т») берётся величина, единица которой
 * совпала с единицей нормы: норма в тоннах возьмёт тонны, в кубометрах — кубометры.
 * Норма не подобрана или ни одна величина не подошла — остаётся первая.
 *
 * Единицы не сошлись — делитель остаётся единицей, а расчёт пометит позицию
 * расхождением. Подставлять догадку нельзя: «м2» и «т» переводятся друг в
 * друга только через плотность, которой в ведомости нет.
 */
export function withUnitDivisor(
  item: BillOfWorkItem,
  base: NormBase,
): BillOfWorkItem {
  const norm = resolveNormFor(item, base)?.norm;
  if (norm === undefined) return item;

  const chosen =
    variantsOf(item).find((variant) => deriveUnitDivisor(variant.unit, norm.unit) !== null) ??
    { quantity: item.quantity, unit: item.quantityUnit };
  const chosenItem: BillOfWorkItem =
    chosen.unit === item.quantityUnit && chosen.quantity === item.quantity
      ? item
      : { ...item, quantity: chosen.quantity, quantityUnit: chosen.unit };

  const divisor = deriveUnitDivisor(chosen.unit, norm.unit);
  if (divisor === null || divisor <= 0) return chosenItem;

  return { ...chosenItem, unitDivisor: divisor };
}

/**
 * Норма под позицию: по коду, если он назначен, иначе поиском по наименованию.
 *
 * Поиск без кода принимается, только когда слов запроса в норме достаточно
 * (`trustedByName`): на живой закупке 001 «Погрузка в автотранспортное средство:
 * гравий» получила норму «Погрузка и выгрузка вручную: изоляторов стеклянных» и
 * 212 тыс. ₽ вместо 5 тыс. ₽ заказчика. Недоверенный подбор — это «нормы нет».
 */
export function resolveNormFor(item: BillOfWorkItem, base: NormBase): NormMatch | null {
  // Материал (поставка) — не работа: расценка по наименованию ему не подбирается никогда (`BillOfWorkItem.materialRow`). Норму назвал человек — она важнее.
  if (item.materialRow !== undefined && item.normCode === null && item.normCodeHint == null) return null;
  // Перевозка и погрузка — услуги по сметным ценам, а не работы: по наименованию к расценке не подбираются (`BillOfWorkItem.serviceRow`).
  if (item.normCode === null && item.normCodeHint == null && isServiceItem(item)) return null;
  // Мусор, добавленный расчётом (`debrisItems.ts`), — услуга или размещение по тарифу, а не работа: «Размещение мусора» по наименованию нашло бы чужую расценку.
  if (item.generated === "DEBRIS" && item.normCode === null && item.normCodeHint == null) return null;
  const found = findNorms(base.searchIndex, {
    workName: item.workName,
    normCode: item.normCode,
    normBaseType: item.normBaseType,
    limit: 1,
  })[0];
  if (found === undefined) return null;
  if (item.normCode === null && !trustedByName(found)) return null;
  return found;
}

/** От базы норм подбору нужен только индекс поиска: так же подбираются расценки ФЕР-2020 (`bimRepository`). */
export type NormBase = Pick<EstimateBase, "searchIndex">;

/** Каталог норм для сверки шифра — поверх индекса поиска, без чтения диска. */
export function catalogOf(base: NormBase): NormCatalog {
  return {
    lookup(code, baseType) {
      if (baseType !== null) {
        const norm = base.searchIndex.byKey.get(normKey(baseType, code));
        return norm === undefined ? [] : [norm];
      }
      return base.searchIndex.byCode.get(normalizeNormCode(code)) ?? [];
    },
  };
}

/**
 * Норма по шифру из документа.
 *
 * Шифр сверяется с базой и при необходимости исправляется (`resolveNormCode`);
 * принятый код и книга кладутся в позицию, и поиск по наименованию для неё уже не
 * нужен. Не нашёлся, неоднозначен или единица нормы не сошлась с единицей строки —
 * позиция остаётся как есть, и норму подберёт поиск, как раньше.
 *
 * Подсказка приходит из самой строки (колонка «Обоснование») либо, когда объёмы
 * взяты из ведомости, из соответствующей строки сметы заказчика.
 */
function withNormHint(
  item: BillOfWorkItem,
  customerRows: readonly BillOfWorkItem[],
  catalog: NormCatalog,
  notes: NormHintNote[],
  /** Базисно-индексный метод: шифр читается как расценка ФЕР (книга — по префиксу «ФЕРм»…), а не ГЭСН. */
  fer = false,
): BillOfWorkItem {
  // Поставка материала считается по справочнику цен, расценка ей не нужна.
  if (item.resourceCode !== null || item.normCode !== null) return item;

  let hint: NormCodeHint | null | undefined = item.normCodeHint;
  let source: NormHintNote["source"] = "ITEM";
  if (hint == null && customerRows.length > 0) {
    const row = matchCustomerRow(item, customerRows);
    hint = row?.normCodeHint;
    source = "CUSTOMER_ESTIMATE";
  }
  if (hint == null) return item;
  // ГЭСН-подсказка в базисно-индексном расчёте и ФЕР-подсказка в ресурсном не годятся: у них разные базы.
  if (fer ? hint.baseType !== null : hint.fer !== undefined) return item;

  const units = variantsOf(item).map((variant) => variant.unit);
  const resolution = resolveNormCode({ code: hint.code, baseType: fer ? (hint.fer?.book ?? null) : hint.baseType }, units, catalog);
  if (resolution.status !== "EXACT" && resolution.status !== "RESTORED") return item;
  // Код есть, но норма измеряется другой величиной: по ней работу не посчитать.
  if (resolution.status === "EXACT" && !unitsCompatible(resolution.norm.unit, units)) return item;

  notes.push({
    workName: item.workName,
    rawCode: hint.raw,
    code: resolution.norm.code,
    baseType: resolution.norm.baseType,
    restored: resolution.status === "RESTORED",
    source,
  });
  return { ...item, normCode: resolution.norm.code, normBaseType: resolution.norm.baseType };
}

/**
 * Чем можно подменить окружение расчёта.
 *
 * База и вызов модели вынесены в зависимости не ради гибкости, а ради
 * проверяемости: настоящая база читается с диска две секунды и занимает 600 МБ,
 * а вызов модели стоит денег. Тест подставляет и то и другое.
 */
export interface EstimateDeps {
  readonly fetcher?: BillRowsFetcher;
  /**
   * Выбор нормы моделью для позиций без шифра (`workerNormPicker`). Нет — только подбор по наименованию, как раньше. Расчёт
   * базисно-индексным методом выбор не использует: кандидаты ищутся по нормам ФСНБ-2022, а не по расценкам ФЕР-2020.
   */
  readonly normPicker?: NormPicker;
  /**
   * Предложение работ по технологии, которых нет в ведомости (`workerImpliedProposer`): леса, защитные сетки, ограждения. Нет — этап не идёт.
   * Нужен и `normPicker`: норму принятому дополнению выбирает тот же «ИИ-сметчик».
   */
  readonly impliedProposer?: ImpliedProposer;
  readonly base?: EstimateBase;
  /**
   * Дочитывание ценовых файлов зоны, которых нет в основной книге: «все цены сплит-формы»
   * (поставки вне норм, цена по индексу) и сметные цены перевозки и погрузки ФГИС ЦС.
   * По умолчанию — с диска для зоны расчёта; при подставленной `base` без этого поля они
   * не читаются (тест не должен зависеть от каталога индекса).
   */
  readonly loadZoneExtras?: (priceZoneId: number | null) => Promise<ZoneExtras>;
  /** Базисно-индексный метод: ФЕР-2020 (подмена в тестах; по умолчанию читаются с диска). */
  readonly fer?: FerBase;
  /** Базисно-индексный метод: индексы Минстроя по кварталам (по умолчанию встроенные и серверные файлы). */
  readonly bimIndices?: BimIndexBook;
  /** Базисно-индексный метод: нормативы НР и СП по указателям (по умолчанию с диска). */
  readonly overheadRates?: ReadonlyMap<string, OverheadRate>;
}

/** Ценовые файлы зоны сверх основной книги. Любой может отсутствовать (зона собрана раньше). */
export interface ZoneExtras {
  readonly splitAll: ReadonlyMap<string, SplitAllPrice> | null;
  readonly services: ZoneAutoServices | null;
}

async function readZoneExtras(priceZoneId: number | null): Promise<ZoneExtras> {
  if (priceZoneId === null) return { splitAll: null, services: null };
  const [splitAll, services] = await Promise.all([loadZoneAuditPrices(priceZoneId), loadZoneAutoServices(priceZoneId)]);
  return { splitAll, services };
}

/**
 * Ценовые файлы зоны для расчёта: подставленные тестом, прочитанные с диска или никакие.
 * Одно правило и для расчёта по документам, и для пересчёта после правок ведомости.
 */
export async function resolveZoneExtras(
  deps: Pick<EstimateDeps, "base" | "loadZoneExtras">,
  priceZoneId: number | null,
): Promise<ZoneExtras> {
  const load =
    deps.loadZoneExtras ?? (deps.base === undefined ? readZoneExtras : async (): Promise<ZoneExtras> => ({ splitAll: null, services: null }));
  return load(priceZoneId);
}

/** Всё, что нужно, чтобы по готовой ведомости собрать сметный документ. */
export interface BillCalculationInput {
  readonly title: string;
  readonly sections: readonly BillOfWorkSection[];
  readonly base: EstimateBase;
  /** Книга цен вместе с ценовыми файлами зоны сверх основной книги. */
  readonly priceBook: EstimatePriceBook;
  readonly parameters: EstimateParameters;
  readonly appliedNormatives: readonly AppliedNormative[];
  readonly sources: readonly EstimateSource[];
  readonly generatedAt: string;
  readonly priceZoneChoice?: EstimatePriceZoneChoice;
  /** Позиции, норму которых выбрал человек: берётся ровно она, без поиска и порога доверия. */
  readonly manualNorm?: ReadonlySet<string>;
}

/**
 * Расчёт по готовой ведомости: документ и сведения о подборе норм.
 *
 * Общая часть двух путей — расчёта по документам (после извлечения ведомости моделью) и
 * пересчёта после правок (без модели). Здесь нет ни модели, ни чтения документов: на входе
 * позиции с уже назначенными шифрами и делителями, на выходе смета.
 *
 * Норма, выбранная человеком, берётся по паре «книга + код» и никак иначе: поиск по коду при
 * промахе подставил бы соседнюю строку таблицы, а выбор человека молча подменять нельзя.
 * Не нашлась — позиция выпадет с пометкой «норма не найдена».
 */
export function calculateBill(input: BillCalculationInput): { document: EstimateDocument; rows: BillRowInfo[] } {
  const { base } = input;
  const manual = input.manualNorm ?? new Set<string>();

  const document = buildEstimate({
    title: input.title,
    sections: input.sections,
    priceBook: input.priceBook,
    parameters: input.parameters,
    appliedNormatives: input.appliedNormatives,
    resolveNorm: (item) => {
      if (manual.has(item.id)) {
        const exact =
          item.normCode === null || item.normBaseType === null
            ? undefined
            : base.searchIndex.byKey.get(normKey(item.normBaseType, item.normCode));
        return exact === undefined ? null : { norm: exact, reasons: [`Норма выбрана вручную: ${exact.baseType} ${exact.code}`] };
      }
      const first = resolveNormFor(item, base);
      if (first === null) return null;
      // Состав ресурсов по строкам ЛСР заказчика вместо состава нормы: цены наши, нормы расхода — его (исключил или заменил материал — не ломает расчёт).
      if (item.customerResources !== undefined && item.customerResources.length > 0) {
        return {
          norm: { ...first.norm, resources: item.customerResources },
          reasons: [...first.reasons, "Состав ресурсов — по строкам ЛСР заказчика, цены наши"],
        };
      }
      return { norm: first.norm, reasons: first.reasons };
    },
    sources: input.sources,
    generatedAt: input.generatedAt,
    disclaimer: ESTIMATE_DISCLAIMER,
    ...(input.priceZoneChoice === undefined ? {} : { priceZoneChoice: input.priceZoneChoice }),
  });

  const lines = new Map(document.sections.flatMap((section) => section.lines).map((line) => [line.itemId, line] as const));
  const rows = buildRowInfos({
    items: input.sections.flatMap((section) => section.items),
    lines,
    index: base.searchIndex,
    manualNorm: manual,
  });
  return { document, rows };
}

/**
 * Шифр услуги автотранспорта для позиции ведомости без своего шифра: из сопоставленной строки
 * сметы заказчика. Только для позиций, похожих на услугу по наименованию: цена берётся по
 * шифру, и подставить его позиции другой работы значило бы посчитать её чужой ценой.
 */
function withServiceCode(item: BillOfWorkItem, customerRows: readonly BillOfWorkItem[]): BillOfWorkItem {
  if (item.serviceCode != null || item.resourceCode !== null || item.normCode !== null || customerRows.length === 0) return item;
  if (!/^\s*(?:перевозк|погрузк|разгрузк|выгрузк)/i.test(item.workName)) return item;
  const code = matchCustomerRow(item, customerRows)?.serviceCode;
  return code == null ? item : { ...item, serviceCode: code };
}

/**
 * Как расчёт зовёт модель на сервере воркера.
 *
 * Через приложение по адресу `SYNC_BASE_URL` — тот же, каким воркер
 * пользуется для глубокого разбора. Раньше здесь было написано, что ключ
 * модели живёт только на Vercel; это перестало быть правдой после переезда:
 * `LLM_API_KEY` лежит в `/etc/tenderfit/app.env` рядом с приложением.
 *
 * Адрес важен не только ради лишнего прыжка за рубеж. Промпт извлечения
 * ведомости живёт в роуте `/api/estimate/bill-rows`, то есть в приложении: на
 * какой адрес смотрит воркер, тем разбором смета и считается. Пока
 * `SYNC_BASE_URL` указывает на Vercel, правки промпта в этом дереве на смету
 * не влияют — см. deploy/README.md.
 */
export function workerBillFetcher(baseUrl: string): BillRowsFetcher {
  return remoteBillRows(baseUrl);
}

/** Выбор нормы моделью через тот же адрес, что и `workerBillFetcher`: ключ модели живёт в приложении, а не у воркера. */
export function workerNormPicker(baseUrl: string): NormPicker {
  return remoteNormPicker(baseUrl);
}

/** Предложение работ по технологии моделью через тот же адрес. */
export function workerImpliedProposer(baseUrl: string): ImpliedProposer {
  return remoteImpliedProposer(baseUrl);
}

const RUB2 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const QTY = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 });

/**
 * Что скорее всего скрывается за невидимым остатком позиции ЛСР.
 *
 * Остаток — это материал нормы «по проекту», которого в выгрузке нет: у нормы он записан группой без марки (битум, щебень, доска ПВХ,
 * краска) с расходом или с пометкой «П». Расход у таких ресурсов бывает числом (битум 1,03 т на т) — тогда количество известно по
 * норме; при «П» и совпадении единицы ресурса с единицей позиции предлагается «1 на единицу» с пометкой. Цены на группу в книге нет,
 * поэтому наш вариант (количество × наша цена) посчитать нельзя: строка идёт по сумме заказчика, а подпись называет ресурс, количество и
 * подразумеваемую цену заказчика за единицу — по ней сметчик проверит остаток, не открывая нормы.
 */
export function withUnaccountedHints(sections: readonly BillOfWorkSection[], base: NormBase): BillOfWorkSection[] {
  const byId = new Map(sections.flatMap((section) => section.items).map((item) => [item.id, item] as const));
  return sections.map((section) => ({
    title: section.title,
    items: section.items.map((item): BillOfWorkItem => {
      if (item.unaccountedOf === undefined) return item;
      const parent = byId.get(item.unaccountedOf);
      const amount = item.customerPrice?.total ?? 0;
      if (parent === undefined || parent.normCode === null || parent.normBaseType === null || amount <= 0) return item;
      const norm = base.searchIndex.byKey.get(normKey(parent.normBaseType, parent.normCode));
      if (norm === undefined) return item;
      const hidden = norm.resources.filter((resource) => resource.kind === "MATERIAL" && (resource.projectSpecific || resource.quantityNote !== null));
      if (hidden.length === 0) return item;

      const normQuantity = parent.quantity / (parent.unitDivisor > 0 ? parent.unitDivisor : 1);
      const parts = hidden.map((resource) => {
        const label = resource.name === "" ? resource.code : resource.name;
        if (resource.quantity > 0) {
          const quantity = resource.quantity * normQuantity;
          return { text: `${label} — по норме ${QTY.format(resource.quantity)} ${resource.unit} на ${norm.unit}, на позицию ${QTY.format(quantity)} ${resource.unit}`, quantity, unit: resource.unit };
        }
        const same = baseUnitOf(resource.unit) !== null && baseUnitOf(resource.unit) === baseUnitOf(parent.quantityUnit);
        if (same) {
          return { text: `${label} — расход по проекту, предложено 1 ${resource.unit} на ${resource.unit} позиции: ${QTY.format(parent.quantity)} ${resource.unit} (предложено, проверьте)`, quantity: parent.quantity, unit: resource.unit };
        }
        return { text: `${label} — расход по проекту`, quantity: 0, unit: resource.unit };
      });
      const only = parts.length === 1 && (parts[0] as { quantity: number }).quantity > 0 ? (parts[0] as { quantity: number; unit: string }) : null;
      const implied = only === null ? "" : `; подразумеваемая цена заказчика ≈ ${RUB2.format(Math.round((amount / only.quantity) * 100) / 100)} ₽ за ${only.unit}`;
      return {
        ...item,
        workName: `${item.workName}: ${hidden.map((resource) => (resource.name === "" ? resource.code : resource.name)).join("; ")}`,
        sourceQuote: `${item.sourceQuote ?? ""}. Скорее всего, это ${parts.map((part) => part.text).join("; ")}${implied}. Нашей цены на ресурс без марки нет — строка по сумме заказчика, допущение`,
      };
    }),
  }));
}

/**
 * Коэффициенты заказчика в ведомости: общий переключатель и пояснения для источника объёмов.
 *
 * Подтверждённые приложением 10 коэффициенты применяются к позициям ЛСР, пока человек не снял «Применять
 * коэффициенты заказчика» (`options.applyCustomerCoefficients === false`): тогда у всех позиций `enabled = false`.
 * Пояснения — сколько позиций получили коэффициенты, какие не подтверждены и на какую сумму — идут в `details` источника.
 */
export function withCustomerConditions(
  sections: readonly BillOfWorkSection[],
  volumeSource: VolumeSource | null,
  options: EstimateOptions,
): { sections: BillOfWorkSection[]; volumeSource: VolumeSource | null } {
  const off = options.applyCustomerCoefficients === false;
  const next = sections.map((section) => ({
    title: section.title,
    items: section.items.map((item): BillOfWorkItem =>
      off && item.customerConditions !== undefined
        ? { ...item, customerConditions: { ...item.customerConditions, enabled: false, forceUnconfirmed: false } }
        : item,
    ),
  }));
  const notes = next.flatMap((section) =>
    section.items.some((item) => item.customerConditions !== undefined)
      ? summarizeCustomerConditions(section.items, section.title.split(". ")[0] ?? section.title).notes
      : [],
  );
  const hasClaims = next.some((section) => section.items.some((item) => item.customerConditions?.confirmed != null));
  const details = [
    ...(volumeSource?.details ?? []),
    ...(off && hasClaims ? ["Применение коэффициентов заказчика отключено в «Условиях работ»: расчёт по нормам без его коэффициентов"] : []),
    ...(off ? [] : notes),
  ];
  return {
    sections: next,
    volumeSource: volumeSource === null || details.length === (volumeSource.details?.length ?? 0) ? volumeSource : { ...volumeSource, details },
  };
}

/** Уровни источника объёмов, при которых заказчик уже перечислил всё сам: строки сверх ведомости не добавляются. */
const CUSTOMER_VOLUME_LEVELS: readonly (VolumeSource["level"] | null)[] = ["CUSTOMER_ESTIMATE", "CONTRACT_ESTIMATE"];

/**
 * Строки сверх ведомости: работы по технологии от ИИ (`impliedWorks.ts`) и мусор по тоннажу из норм (`debrisItems.ts`).
 *
 * Порядок — сначала работы по технологии, потом мусор: тоннаж считается по всем нормам расчёта, включая принятые дополнения. Каждый этап отключается
 * опцией пользователя (`generateImplied`, `generateDebris`), не идёт для смет по ЛСР заказчика (`CUSTOMER_ESTIMATE`, `CONTRACT_ESTIMATE`) и не меняет строки
 * ведомости: добавляются отдельные разделы в конце. Сбой модели — не сбой расчёта.
 */
export async function withGeneratedSections(
  sections: readonly BillOfWorkSection[],
  context: {
    readonly base: EstimateBase;
    readonly deps: EstimateDeps;
    readonly options: EstimateOptions;
    readonly volumeLevel: VolumeSource["level"] | null;
    readonly input: EstimateRequestInput;
    readonly services: ZoneAutoServices | null;
  },
): Promise<{ sections: BillOfWorkSection[]; stats: GeneratedStats }> {
  const { base, deps, options, input } = context;
  const customerBased = CUSTOMER_VOLUME_LEVELS.includes(context.volumeLevel);
  const normOf = (item: BillOfWorkItem): NormRecord | null => resolveNormFor(item, base)?.norm ?? null;
  const texts = input.documents.map((document) => document.text);
  let result: BillOfWorkSection[] = [...sections];
  let implied = EMPTY_GENERATED_IMPLIED;
  let debris = EMPTY_GENERATED_DEBRIS;

  if (customerBased) {
    const skipped = "смета заказчика (ЛСР, смета контракта) — заказчик уже перечислил всё";
    return { sections: result, stats: { debris: { ...debris, skipped }, implied: { ...implied, skipped } } };
  }

  if (options.generateImplied !== false) {
    if (deps.impliedProposer === undefined || deps.normPicker === undefined) {
      implied = { ...implied, enabled: true, skipped: deps.impliedProposer === undefined ? "предложение работ по технологии недоступно (нет подборщика)" : "нет подборщика норм" };
    } else {
      const stage = await withImpliedWorks(result, {
        index: base.searchIndex,
        proposer: deps.impliedProposer,
        picker: deps.normPicker,
        context: { regNumber: input.regNumber, subject: input.subject, ...(input.jobId === undefined ? {} : { jobId: input.jobId }) },
        texts,
        normOf,
        finalize: (item) => withUnitDivisor(item, base),
      });
      implied = stage.stats;
      if (stage.section !== null) result = [...result, stage.section];
    }
  }

  if (options.generateDebris !== false) {
    const stage = buildDebrisItems({ sections: result, normOf, texts, services: context.services });
    debris = stage.stats;
    if (stage.section !== null) result = [...result, stage.section];
  }

  return { sections: result, stats: { debris, implied } };
}

/**
 * Расчёт по ресурсно-индексному методу (ФСНБ-2022, ресурсные цены зоны) — основной путь и запасной для БИМ.
 * Название «Resource» не случайно: у БИМ путь свой, ниже (`buildBimFromDocuments`).
 */
async function buildResourceFromDocuments(
  input: EstimateRequestInput,
  deps: EstimateDeps,
): Promise<EstimateBuildResult> {
  let base: EstimateBase;
  if (deps.base !== undefined) {
    base = deps.base;
  } else {
    try {
      base = await loadEstimateBase({
        priceZoneId: input.priceZoneId,
        northZone: input.priceZoneChoice?.northZone,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new EstimateBaseMissingError(
        reason,
        "data/fsnb/index",
        "npx tsx scripts/fsnb/build-index.ts",
      );
    }
  }

  const extraction = await extractBillOfWork(
    input.documents,
    {
      regNumber: input.regNumber,
      subject: input.subject,
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    },
    deps.fetcher,
  );

  const catalog = catalogOf(base);
  const normHints: NormHintNote[] = [];
  const builtSections: BillOfWorkSection[] = extraction.sections.map((section) => ({
    title: section.title,
    items: section.items.map((item) =>
      withUnitDivisor(
        withNormHint(
          withServiceCode(inheritCustomerPrice(item, extraction.customerReference), extraction.customerReference),
          extraction.customerReference,
          catalog,
          normHints,
        ),
        base,
      ),
    ),
  }));

  // Коэффициенты заказчика, подтверждённые приложением 10, применяются к позициям его ЛСР, пока человек не снял переключатель.
  const prepared = withCustomerConditions(withUnaccountedHints(builtSections, base), extraction.volumeSource, input.options ?? NO_ESTIMATE_OPTIONS);
  const { volumeSource } = prepared;

  /*
    «ИИ-сметчик»: позиции без шифра получают норму, выбранную моделью среди кандидатов кода. После коэффициентов заказчика, чтобы
    переключатель «Применять коэффициенты заказчика» не снимал коэффициенты 571/пр на демонтаж, выбранные при подборе нормы.
    Единицу и делитель позиции с новой нормой назначает `withUnitDivisor`, как для любой нормы.
  */
  const pickContext = { regNumber: input.regNumber, subject: input.subject, ...(input.jobId === undefined ? {} : { jobId: input.jobId }) };
  const { sections: normSections, stats: pickStats } = await withNormPicks(prepared.sections, {
    index: base.searchIndex,
    picker: deps.normPicker,
    context: pickContext,
    finalize: (item) => withUnitDivisor(item, base),
    // Материалы ведомости (поставка, а не работа) получают ресурс справочника цен: наименования ресурсов — в книге цен, не в сплит-форме.
    resources: base.priceBook,
  });

  /*
    Материал нормы «по проекту» (`normMaterial.ts`): нормы позиций уже известны, и тем, чья норма несёт ресурс без марки с числовым расходом (основной
    материал работы: состав из полиуретановых смол, труба, кабель), подбирается материал справочника цен — иначе он выпадал из сметы пробелом. Только ведомость
    без сметы заказчика: у ЛСР заказчика материалы закрывают его ресурсные строки, этот путь не меняется.
  */
  const { sections: pickedSections, stats: materialStats } = await withNormMaterials(normSections, {
    picker: deps.normPicker,
    context: pickContext,
    resources: base.priceBook,
    normOf: (item) => resolveNormFor(item, base)?.norm ?? null,
    skip: CUSTOMER_VOLUME_LEVELS.includes(extraction.volumeSource?.level ?? null) ? "смета заказчика (ЛСР, смета контракта): материалы по его строкам" : null,
  });
  const normPick = mergeNormMaterialStats(pickStats, materialStats);

  // Цены зоны сверх основной книги живут только на время расчёта: в долгоживущую книгу не кладутся.
  const extras = await resolveZoneExtras(deps, input.priceZoneId ?? base.info.priceZoneId ?? null);
  const priceBook = { ...base.priceBook, splitAll: extras.splitAll, services: extras.services };

  /*
    Строки сверх ведомости (`generatedItems.ts`): мусор по тоннажу из норм и работы по технологии от ИИ. После выбора норм — тоннаж и «машины в норме»
    берутся у норм, которые расчёт реально применит, и после таблиц зоны — цену погрузки и перевозки можно проверить заранее. Не для смет по ЛСР заказчика:
    заказчик уже перечислил всё, что хотел оплатить.
  */
  const options = input.options ?? NO_ESTIMATE_OPTIONS;
  const added = await withGeneratedSections(pickedSections, {
    base,
    deps,
    options,
    volumeLevel: extraction.volumeSource?.level ?? null,
    input,
    services: extras.services,
  });
  const sections = added.sections;

  // Сверка идёт по объёмам до подбора нормы: сравниваются числа документов, а не пересчёт.
  const volumeFindings = crossCheckVolumes(extraction.sections.flatMap((section) => section.items), extraction);

  const billItems = sections.reduce(
    (sum, section) => sum + section.items.length,
    0,
  );

  /*
    Нормативы сверх норм — только по выбору пользователя. Без выбора параметры остаются
    теми, что пришли от вызывающего кода (в воркере — нули): смета равна прежней.
  */
  const resolved = resolveLimited(options, {
    region: input.place?.region ?? null,
    address: input.place?.address ?? null,
    customerName: input.place?.customerName ?? null,
    subject: input.subject,
    north:
      input.priceZoneChoice === undefined || input.priceZoneChoice.northBasis === undefined
        ? null
        : {
            zone: input.priceZoneChoice.northZone,
            basis: input.priceZoneChoice.northBasis,
            matched: input.priceZoneChoice.matched,
          },
  });
  const parameters: EstimateParameters = hasLimitedOptions(options)
    ? {
        ...input.parameters,
        limited: resolved.limited,
        ...(resolved.workConditions === undefined ? {} : { workConditions: resolved.workConditions }),
      }
    : input.parameters;

  const generatedAt = (input.now ?? new Date()).toISOString();
  const { document, rows } = calculateBill({
    title: input.subject,
    sections,
    base,
    priceBook,
    parameters,
    appliedNormatives: resolved.appliedNormatives,
    sources: [...base.sources, ...resolved.sources],
    generatedAt,
    priceZoneChoice:
      input.priceZoneChoice === undefined
        ? undefined
        : { basis: input.priceZoneChoice.basis, matched: input.priceZoneChoice.matched },
  });

  // Чем повторить расчёт без модели: зона цен и нормативы, которые от строк не зависят.
  const calcZoneId = input.priceZoneId ?? base.info.priceZoneId;
  const northZone = input.priceZoneChoice?.northZone;
  const bill: EstimateBillSnapshot = {
    version: 1,
    sections,
    rows,
    ...(calcZoneId === undefined || northZone === undefined
      ? {}
      : { calc: { priceZoneId: calcZoneId, northZone, resolvedNormatives: resolved.appliedNormatives } }),
  };

  const result: EstimateBuildResult = {
    document,
    rejected: extraction.rejected,
    documentsWithoutBill: extraction.documentsWithoutBill,
    skippedNoVolumes: extraction.skippedNoVolumes,
    billItems,
    tokensUsed: extraction.tokensUsed,
    volumeSource,
    volumeFindings,
    normHints,
    duplicateDocuments: extraction.duplicateDocuments,
    customerLsrs: extraction.customerLsrs,
    contractCheck: extraction.contractCheck,
    bill,
    normPick,
    // Деньги по добавленным строкам известны только после расчёта.
    generated: withGeneratedCosts(added.stats, document, sections),
  };
  return withGaps(result, [
    ...priceLevelGaps(input.documents, { priceZone: base.priceBook.priceZone, period: base.priceBook.period }, input.priceZoneChoice?.notes),
    ...customerBaseGaps(extraction.customerLsrs),
    ...unreadChunkGaps(extraction.unreadChunks),
    ...noVolumeGaps(result, input.documents.length, extraction.unreadChunks.length),
  ]);
}

/* ------------------------------ Базисно-индексный метод ------------------------------ */

/** Метод БИМ выбран пользователем, а считать им нечем: индексов письма нет или субъект/объект не определились. */
export class EstimateBimIndicesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EstimateBimIndicesError";
  }
}

/** Расценка ФЕР под позицию: выбранная человеком (пара «книга + шифр») или подобранная по шифру и наименованию. */
export function ferResolver(base: FerBase, manual: ReadonlySet<string>): FerResolver {
  return (item) => {
    if (manual.has(item.id)) {
      const exact = item.normCode === null || item.normBaseType === null ? undefined : base.rates.get(ferKey(item.normBaseType, item.normCode));
      return exact === undefined ? null : { rate: exact, reasons: [`Расценка выбрана вручную: ${exact.book} ${exact.code}`] };
    }
    const found = resolveNormFor(item, base);
    if (found === null) return null;
    const rate = base.rates.get(ferKey(found.norm.baseType, found.norm.code));
    return rate === undefined ? null : { rate, reasons: found.reasons };
  };
}

/** Позиции ведомости перед БИМ-расчётом: шифры ГЭСН, назначенные раньше, к ФЕР не относятся. */
function withoutGesnCode(item: BillOfWorkItem): BillOfWorkItem {
  if (item.normBaseType === null || !item.normBaseType.startsWith("ГЭСН")) return item;
  return { ...item, normCode: null, normBaseType: null };
}

export const BIM_DISCLAIMER =
  "Расчёт носит информационно-аналитический характер и не является сметной " +
  "документацией. Объёмы работ извлечены из документации закупки автоматически " +
  "и требуют проверки. Стоимость определена базисно-индексным методом: расценки ФЕР-2020 " +
  "в уровне цен 01.01.2000, пересчитанные в текущий уровень индексами Минстроя России " +
  "по субъекту и объекту строительства. Для экспертизы и договора смету составляет и " +
  "подписывает аттестованный сметчик.";

/** Всё, что нужно, чтобы по готовой ведомости собрать смету по БИМ. */
export interface BimBillInput {
  readonly title: string;
  readonly sections: readonly BillOfWorkSection[];
  readonly fer: FerBase;
  readonly selection: BimSelection;
  readonly overheadRates: ReadonlyMap<string, OverheadRate>;
  readonly parameters: EstimateParameters;
  readonly appliedNormatives: readonly AppliedNormative[];
  readonly sources: readonly EstimateSource[];
  readonly generatedAt: string;
  readonly priceZoneChoice?: EstimatePriceZoneChoice;
  readonly manualNorm?: ReadonlySet<string>;
  readonly region: string;
  readonly priceZone: string;
  readonly method: Pick<MethodChoice, "basis" | "note" | "customerBase">;
}

/** Расчёт БИМ по готовой ведомости: общая часть расчёта по документам и пересчёта после правок. */
export function calculateBimBill(input: BimBillInput): { document: EstimateDocument; rows: BillRowInfo[] } {
  const manual = input.manualNorm ?? new Set<string>();
  const document = buildBimEstimate({
    title: input.title,
    sections: input.sections,
    resolveRate: ferResolver(input.fer, manual),
    fer: ferLookupOf(input.fer),
    selection: input.selection,
    overheadRates: input.overheadRates,
    parameters: input.parameters,
    appliedNormatives: input.appliedNormatives,
    sources: input.sources,
    generatedAt: input.generatedAt,
    disclaimer: BIM_DISCLAIMER,
    region: input.region,
    priceZone: input.priceZone,
    baseEdition: input.fer.info.source === "" ? "ФСНБ-2020 (ФЕР-2001), уровень цен 01.01.2000" : `${input.fer.info.source}, уровень цен ${input.fer.info.priceLevel}`,
    method: input.method,
    ...(input.priceZoneChoice === undefined ? {} : { priceZoneChoice: input.priceZoneChoice }),
  });
  const lines = new Map(document.sections.flatMap((section) => section.lines).map((line) => [line.itemId, line] as const));
  const rows = buildRowInfos({
    items: input.sections.flatMap((section) => section.items),
    lines,
    index: input.fer.searchIndex,
    manualNorm: manual,
  });
  return { document, rows };
}

type BimPreparation =
  | {
      readonly kind: "READY";
      readonly fer: FerBase;
      readonly indices: BimIndexBook;
      readonly selection: BimSelection;
      readonly region: string;
      readonly priceZone: string;
    }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string; readonly error: Error };

/** ФЕР-2020 и индексы Минстроя под закупку: всё ли есть, чтобы считать по БИМ. */
async function prepareBim(
  input: EstimateRequestInput,
  deps: EstimateDeps,
  bimEstimates: readonly CustomerBim[],
): Promise<BimPreparation> {
  let fer: FerBase;
  try {
    fer = deps.fer ?? (await loadFerBase());
  } catch (error) {
    if (!(error instanceof FerBaseUnavailableError)) throw error;
    return {
      kind: "UNAVAILABLE",
      reason: "ФЕР-2020 на сервере не собраны",
      error: new EstimateBaseMissingError(error.message, error.indexDir, BIM_BUILD_COMMAND),
    };
  }
  const indices = deps.bimIndices ?? (deps.fer === undefined ? loadBimIndexBook() : bundledBimIndexBook());
  const place = input.priceZoneName ?? input.place?.region ?? null;
  const text = [input.subject, ...bimEstimates.flatMap((estimate) => [estimate.constructionName, estimate.workName])].filter((part): part is string => part !== null && part !== "").join(". ");
  const picked = selectBimIndices(indices, { subject: place, zone: place === null ? null : zoneOfName(place), text });
  if (!picked.ok) {
    const reason = `индексы Минстроя подобрать не удалось: ${picked.reason}`;
    return { kind: "UNAVAILABLE", reason, error: new EstimateBimIndicesError(reason) };
  }
  const selection = picked.selection;
  return { kind: "READY", fer, indices, selection, region: selection.subject, priceZone: place ?? selection.subject };
}

async function buildBimFromDocuments(
  input: EstimateRequestInput,
  deps: EstimateDeps,
  choice: MethodChoice,
  ready: Extract<BimPreparation, { kind: "READY" }>,
): Promise<EstimateBuildResult> {
  const { fer, selection } = ready;

  const extraction = await extractBillOfWork(
    input.documents,
    { regNumber: input.regNumber, subject: input.subject, ...(input.jobId === undefined ? {} : { jobId: input.jobId }) },
    deps.fetcher,
  );

  const catalog = catalogOf(fer);
  const normHints: NormHintNote[] = [];
  const sections: BillOfWorkSection[] = extraction.sections.map((section) => ({
    title: section.title,
    items: section.items.map((item) =>
      withUnitDivisor(
        withNormHint(
          withServiceCode(inheritCustomerPrice(withoutGesnCode(item), extraction.customerReference), extraction.customerReference),
          extraction.customerReference,
          catalog,
          normHints,
          true,
        ),
        fer,
      ),
    ),
  }));

  const volumeFindings = crossCheckVolumes(extraction.sections.flatMap((section) => section.items), extraction);
  const billItems = sections.reduce((sum, section) => sum + section.items.length, 0);

  const options = input.options ?? NO_ESTIMATE_OPTIONS;
  const resolved = resolveLimited(options, {
    region: input.place?.region ?? null,
    address: input.place?.address ?? null,
    customerName: input.place?.customerName ?? null,
    subject: input.subject,
    north:
      input.priceZoneChoice === undefined || input.priceZoneChoice.northBasis === undefined
        ? null
        : { zone: input.priceZoneChoice.northZone, basis: input.priceZoneChoice.northBasis, matched: input.priceZoneChoice.matched },
  });
  const parameters: EstimateParameters = hasLimitedOptions(options)
    ? {
        ...input.parameters,
        limited: resolved.limited,
        ...(resolved.workConditions === undefined ? {} : { workConditions: resolved.workConditions }),
      }
    : input.parameters;

  const overheadRates = deps.overheadRates ?? (await loadOverheadRateMap({ northZone: input.priceZoneChoice?.northZone }));
  const generatedAt = (input.now ?? new Date()).toISOString();
  const priceZoneChoice = input.priceZoneChoice === undefined ? undefined : { basis: input.priceZoneChoice.basis, matched: input.priceZoneChoice.matched };
  const { document, rows } = calculateBimBill({
    title: input.subject,
    sections,
    fer,
    selection,
    overheadRates,
    parameters,
    appliedNormatives: resolved.appliedNormatives,
    sources: [...bimSources(), ...resolved.sources],
    generatedAt,
    priceZoneChoice,
    region: ready.region,
    priceZone: ready.priceZone,
    method: choice,
  });

  const northZone = input.priceZoneChoice?.northZone;
  const bill: EstimateBillSnapshot = {
    version: 1,
    sections,
    rows,
    ...(northZone === undefined
      ? {}
      : {
          calc: {
            priceZoneId: input.priceZoneId ?? 0,
            northZone,
            resolvedNormatives: resolved.appliedNormatives,
            bim: { selection, basis: choice.basis, basisNote: choice.note, customerBase: choice.customerBase, region: ready.region, priceZone: ready.priceZone },
          },
        }),
  };

  const result: EstimateBuildResult = {
    document,
    rejected: extraction.rejected,
    documentsWithoutBill: extraction.documentsWithoutBill,
    skippedNoVolumes: extraction.skippedNoVolumes,
    billItems,
    tokensUsed: extraction.tokensUsed,
    volumeSource: extraction.volumeSource,
    volumeFindings,
    normHints,
    duplicateDocuments: extraction.duplicateDocuments,
    customerLsrs: extraction.customerLsrs,
    contractCheck: extraction.contractCheck,
    bill,
    normPick: EMPTY_NORM_PICK_STATS,
    generated: EMPTY_GENERATED_STATS,
  };
  // Наш уровень цен у БИМ — субъект и зона индексов Минстроя и квартал письма: с ним и сверяется смета заказчика.
  const ourZone =
    zoneNumberIn(ready.priceZone) !== null || selection.zone === null
      ? ready.priceZone
      : `${selection.subject} (${String(selection.zone)} зона)`;
  const ourPeriod = `${String(selection.quarter.quarter)} квартал ${String(selection.quarter.year)} г.`;
  return withGaps(result, [
    ...priceLevelGaps(input.documents, { priceZone: ourZone, period: ourPeriod }, input.priceZoneChoice?.notes),
    ...unreadChunkGaps(extraction.unreadChunks),
    ...noVolumeGaps(result, input.documents.length, extraction.unreadChunks.length),
  ]);
}

/** Источники БИМ-расчёта для документа: набор ФСНБ-2020 и письма Минстроя с индексами. */
export function bimSources(): EstimateSource[] {
  return [
    { title: "ФСНБ-2020: ФЕР, ФССЦ (открытые данные ФГИС ЦС)", url: "https://fgiscs.minstroyrf.ru/", edition: "ФЕР-2001 в уровне цен 01.01.2000" },
    { title: "Письма Минстроя России об индексах изменения сметной стоимости строительства (по элементам прямых затрат)", url: "https://fgiscs.minstroyrf.ru/", edition: "по кварталам" },
  ];
}

/**
 * Расчёт сметы по документации: метод определяется по заказчику и выбору пользователя, дальше — путь метода.
 *
 * Базисно-индексный метод (ФЕР-2020 × индексы) не читает ни базу норм ГЭСН, ни ценовую книгу зоны: ему нужны ФЕР-2020 и письма
 * Минстроя. Не получилось (ФЕР не собраны, индексы для субъекта не нашлись) — если метод выбрал пользователь, расчёт отказывает
 * с причиной; если он выведен из документов заказчика, считается ресурсно-индексный с пометкой `BIM_FALLBACK_RIM`: смета лучше отказа,
 * но сказать, что метод не тот, обязаны.
 */
export async function buildEstimateFromDocuments(
  input: EstimateRequestInput,
  deps: EstimateDeps = {},
): Promise<EstimateBuildResult> {
  const options = input.options ?? NO_ESTIMATE_OPTIONS;
  // Если пользователь выбрал ресурсный метод, разбирать смету заказчика под БИМ незачем.
  const bimEstimates = options.method === "RESOURCE_INDEX" ? [] : parseCustomerBim(input.documents).estimates;
  // Ресурсно-индексная ЛСР формы 421/пр у заказчика (ГЭСН, ФСБЦ) БИМ-сметой не бывает: при споре признаков метода она весомее.
  // ТСН-2001 Москвы и сметы с названным в шапке базисно-индексным методом ресурсными не считаются, хотя разбор читает их позиции.
  const rimLsrCount =
    options.method === "RESOURCE_INDEX"
      ? 0
      : parseCustomerLsr(input.documents).estimates.filter((estimate) => estimate.base === undefined && estimate.method !== "BASE_INDEX").length;
  const choice = chooseMethod(options.method, detectCustomerMethod(input.documents, bimEstimates, { rimLsrCount }));

  let fallback: string | null = null;
  if (choice.method === "BASE_INDEX") {
    const ready = await prepareBim(input, deps, bimEstimates);
    if (ready.kind === "READY") return buildBimFromDocuments(input, deps, choice, ready);
    if (choice.basis === "USER") throw ready.error;
    fallback = `${choice.note}, но ${ready.reason}`;
  }

  const result = await buildResourceFromDocuments(input, deps);
  if (fallback === null) return result;
  const gap = {
    kind: "BIM_FALLBACK_RIM" as const,
    message: `Заказчик считает базисно-индексным методом (${fallback}): смета посчитана ресурсно-индексным методом, итоги с его сметой различаются методом`,
    code: null,
    baseType: null,
  };
  return { ...result, document: { ...result.document, gaps: [...result.document.gaps, gap] } };
}

/**
 * Оговорка внутри документа.
 *
 * Файл уходит из интерфейса и живёт дальше сам: его перешлют, приложат к
 * письму, распечатают. Оговорка, оставшаяся на экране, до читателя такого файла
 * не доедет, а решение по ней принимают.
 */
export const ESTIMATE_DISCLAIMER =
  "Расчёт носит информационно-аналитический характер и не является сметной " +
  "документацией. Объёмы работ извлечены из документации закупки автоматически " +
  "и требуют проверки. Стоимость определена ресурсно-индексным методом по " +
  "открытым данным ФГИС ЦС. Для экспертизы и договора смету составляет и " +
  "подписывает аттестованный сметчик.";
