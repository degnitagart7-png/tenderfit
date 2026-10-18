import type { ZoneAutoServices } from "@/domain/estimate/autoServices";
import type { BimIndexBook } from "@/domain/estimate/bimIndices";
import { auditCustomerLsr, type AuditReport } from "@/domain/estimate/customerAudit";
import { parseCustomerBim } from "@/domain/estimate/customerBim";
import { auditCustomerBim, type FerLookup } from "@/domain/estimate/customerBimAudit";
import { CUSTOMER_NORM_BASE_LABEL, type CustomerNormBase, type DocumentText } from "@/domain/estimate/customerEstimate";
import { parseCustomerLsr, type NotRecognizedEstimate } from "@/domain/estimate/customerLsr";
import type { EstimatePriceBook } from "@/domain/estimate/calculate";
import type { NorthZone } from "@/domain/estimate/overheadNormatives";
import type { PriceZoneBasis } from "@/domain/estimate/priceZoneResolve";
import type { OverheadRate } from "@/domain/estimate/types";
import {
  FerBaseUnavailableError,
  ferLookupOf,
  loadBimIndexBook,
  loadFerBase,
} from "@/repositories/bimRepository";
import {
  loadOverheadRateMap,
  loadZoneAuditPrices,
  loadZoneAutoServices,
  loadZonePriceBook,
  type AuditPrice,
} from "@/repositories/estimateBaseRepository";

/**
 * Аудит сметы заказчика на воркере: документы закупки → разбор сметы → переоценка.
 *
 * Метод сметы определяется по самой смете, а не по настройкам: форма 421/пр на ГЭСН/ФСНБ-2022 (ресурсно-индексный метод)
 * переоценивается по ценам выбранной зоны; смета на ФЕР/ТЕР-2001 с индексами (базисно-индексный метод, БИМ) — по ФЕР-2020 и
 * письмам Минстроя с индексами. В одной закупке бывают сметы обоих методов, отчёт строится на каждую.
 *
 * Без модели: токенов 0, сети нет — ни вызова шлюза, ни обращения к продукту. Нужна
 * только ценовая книга зоны (она без норм, 185 МБ справочника не читаются). Зону
 * выбирает вызывающий код (`chooseEstimateZone`), здесь она приходит готовой, чтобы
 * сервис не знал о закупках и оставался проверяемым.
 */

export interface AuditZone {
  readonly priceZoneId: number;
  readonly zoneName: string;
  readonly basis: PriceZoneBasis;
  readonly matched: string | null;
  readonly northZone: NorthZone;
}

export interface CustomerAuditResult {
  readonly reports: readonly AuditReport[];
  readonly zone: AuditZone;
  readonly period: string;
  readonly notRecognized: readonly NotRecognizedEstimate[];
}

/** В документах нет сметы, которую можно проверить построчно: причина — словами. */
export class CustomerAuditUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerAuditUnavailableError";
  }
}

export interface CustomerAuditDeps {
  /** Подмена загрузки ценовой книги — в тестах, чтобы не читать индекс с диска. */
  readonly loadPriceBook?: (priceZoneId: number, northZone: NorthZone) => Promise<EstimatePriceBook>;
  /** Подмена загрузки «всех цен сплит-формы»; null — зона собрана без этого файла. */
  readonly loadAuditPrices?: (priceZoneId: number) => Promise<ReadonlyMap<string, AuditPrice> | null>;
  /** Подмена загрузки цен перевозки и погрузки зоны; null — зона собрана без этих таблиц. */
  readonly loadAutoServices?: (priceZoneId: number) => Promise<ZoneAutoServices | null>;
  /** Подмена загрузки ФЕР-2020 (аудит БИМ); бросает `FerBaseUnavailableError`, если справочник не собран. */
  readonly loadFer?: () => Promise<FerLookup>;
  /** Подмена загрузки индексов Минстроя (аудит БИМ). */
  readonly loadBimIndices?: () => BimIndexBook;
  /** Подмена нормативов НР и СП по указателям (аудит БИМ). */
  readonly loadOverheadRates?: (northZone: NorthZone) => Promise<ReadonlyMap<string, OverheadRate>>;
}

/** Смета БИМ распознана, а проверить нечем: сервер без ФЕР-2020. Причина называет команду сборки. */
function unavailableFerReason(error: unknown): string {
  if (error instanceof FerBaseUnavailableError) return `смета по базисно-индексному методу, но ${error.message}`;
  throw error;
}

export async function runCustomerAudit(
  documents: readonly DocumentText[],
  zone: AuditZone,
  deps: CustomerAuditDeps = {},
): Promise<CustomerAuditResult> {
  const lsrParse = parseCustomerLsr(documents);
  /*
    Смета по ТСН-2001 Москвы читается (позиции, объёмы, итоги идут в ведомость и сравнение), но построчно проверять её нечем: норм и ресурсов
    ТСН у нас нет, а шифры «4.8-61-4» к ФСНБ-2022 не сводятся. Такая смета называется среди не проверенных, а не уходит в аудит с пустым покрытием.
  */
  const parsed = { ...lsrParse, estimates: lsrParse.estimates.filter((estimate) => estimate.base === undefined) };
  const foreignBase = lsrParse.estimates
    .filter((estimate) => estimate.base !== undefined)
    .map((estimate): NotRecognizedEstimate => ({
      documentName: estimate.documentName,
      estimateName: estimate.estimateName,
      reason: `смета по ${CUSTOMER_NORM_BASE_LABEL[estimate.base as CustomerNormBase]}: норм этой базы у нас нет, построчная проверка по ФСНБ-2022 невозможна (итоги и объёмы прочитаны)`,
    }));
  const bimParsed = parseCustomerBim(documents);
  // Таблица БИМ для разбора формы 421/пр «не форма 421/пр»: эти сметы читает разбор БИМ, и «не распознана» про них говорить нельзя.
  const bimKeys = new Set(bimParsed.estimates.map((estimate) => `${estimate.documentName}|${estimate.estimateName ?? ""}`));
  const bimDocuments = new Set(bimParsed.estimates.map((estimate) => estimate.documentName));
  const lsrNotRecognized = parsed.notRecognized.filter(
    (item) => !bimKeys.has(`${item.documentName}|${item.estimateName ?? ""}`) && !(item.estimateName === null && bimDocuments.has(item.documentName)),
  );
  const notRecognized: NotRecognizedEstimate[] = [...lsrNotRecognized, ...foreignBase, ...bimParsed.notRecognized];

  const bimReports: AuditReport[] = [];
  if (bimParsed.estimates.length > 0) {
    try {
      const fer = await (deps.loadFer ?? (async () => ferLookupOf(await loadFerBase())))();
      const indices = (deps.loadBimIndices ?? (() => loadBimIndexBook()))();
      const overheadRates = await (deps.loadOverheadRates ?? ((north: NorthZone) => loadOverheadRateMap({ northZone: north })))(zone.northZone);
      const subject = zone.zoneName.replace(/\s*\(\d+\s*зона\)\s*$/u, "");
      const zoneNumber = /\((\d+)\s*зона\)\s*$/u.exec(zone.zoneName)?.[1];
      for (const estimate of bimParsed.estimates) {
        bimReports.push(
          auditCustomerBim(estimate, {
            fer,
            indices,
            overheadRates,
            subject,
            zone: zoneNumber === undefined ? null : Number.parseInt(zoneNumber, 10),
          }),
        );
      }
    } catch (error) {
      const reason = unavailableFerReason(error);
      for (const estimate of bimParsed.estimates) {
        notRecognized.push({ documentName: estimate.documentName, estimateName: estimate.estimateName ?? estimate.number, reason });
      }
    }
  }

  if (parsed.estimates.length === 0 && bimReports.length === 0) {
    const reasons = notRecognized.map((item) => `«${item.estimateName ?? item.documentName}» — ${item.reason}`);
    throw new CustomerAuditUnavailableError(
      reasons.length === 0
        ? "В документации не найдена локальная смета заказчика (нет строки «ВСЕГО по смете»): проверять нечего"
        : `Ни одна смета заказчика не подошла под форму 421/пр или базисно-индексный метод, построчно проверять нечего: ${reasons.slice(0, 5).join("; ")}`,
    );
  }

  // Ценовая книга зоны нужна только сметам ресурсного метода: у смет БИМ своя база (ФЕР-2020 и письма Минстроя).
  let lsrReports: AuditReport[] = [];
  let period = "";
  if (parsed.estimates.length > 0) {
    const load = deps.loadPriceBook ?? ((id, north) => loadZonePriceBook(id, { northZone: north }));
    const priceBook = await load(zone.priceZoneId, zone.northZone);
    // Основная книга зоны отфильтрована по нормам; кабель и прочие позиции-поставки ищутся в полном
    // списке цен сплит-формы. Старая сборка зоны без него — не ошибка: аудит идёт по книге.
    const auditPrices = await (deps.loadAuditPrices ?? ((id: number) => loadZoneAuditPrices(id)))(zone.priceZoneId);
    // Перевозка и погрузка: шифры услуг сверяются с таблицами ФГИС ЦС зоны, а не уходят в «не проверено».
    // При подставленной книге цен (тест) таблицы с диска не читаются.
    const services = await (
      deps.loadAutoServices ?? (deps.loadPriceBook === undefined ? (id: number) => loadZoneAutoServices(id) : async () => null)
    )(zone.priceZoneId);
    period = priceBook.period;
    lsrReports = parsed.estimates.map((lsr) =>
      auditCustomerLsr(lsr, {
        priceBook,
        auditPrices,
        services,
        northZone: zone.northZone,
        // Субъект — из названия ценовой зоны: «Иркутская область (1 зона)» → «Иркутская область».
        subject: zone.zoneName.replace(/\s*\(\d+\s*зона\)\s*$/u, ""),
      }),
    );
  } else {
    period = (bimReports[0] as AuditReport).period;
  }
  return { reports: [...lsrReports, ...bimReports], zone, period, notRecognized };
}
