import { config } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { resolve } from "node:path";

import { compareTender } from "../src/domain/estimate/benchmark";
import { compareBlind, customerPositionsOf, generatedUnpricedOf, ourLinesOf } from "../src/domain/estimate/benchmarkBlind";
import { stripCustomerEstimates } from "../src/domain/estimate/estimateRemoval";
import { resolveWorkerConfig } from "../src/domain/workerSchedule";
import { parseCustomerLsr } from "../src/domain/estimate/customerLsr";
import { buildLsrSet } from "../src/domain/estimate/customerLsrSet";
import { NO_ESTIMATE_OPTIONS, normalizeEstimateOptions } from "../src/domain/estimate/estimateOptions";
import type { EstimateGapKind } from "../src/domain/estimate/types";
import { describeError } from "../src/lib/errors";
import { getSupabaseServerClient } from "../src/lib/supabase";
import { listBuiltZones, loadZoneWageScale, readPriceZoneRecords } from "../src/repositories/estimateBaseRepository";
import { documentRepository } from "../src/repositories/documentRepository";
import { tenderRepository } from "../src/repositories/tenderRepository";
import { ESTIMATE_PARAMETERS } from "../src/services/estimateDefaults";
import { extractDeclaredPriceLevel } from "../src/domain/estimate/customerPriceLevel";
import { resolveZoneTender } from "../src/domain/estimate/documentRegion";
import { chooseEstimateZone, EstimatePriceZoneError } from "../src/services/estimateZone";
import { fingerprintZoneByCustomerPrices } from "../src/services/estimateZoneFingerprint";
import { buildEstimateFromDocuments, EstimateBaseMissingError, workerBillFetcher, workerImpliedProposer, workerNormPicker } from "../src/services/estimateService";
import { NO_NORM_PICKER } from "../src/domain/estimate/normPick";
import type { BillRowsFetcher } from "../src/services/billOfWorkExtraction";
import type { TenderRow } from "../src/types/database";
import {
  buildZoneInput,
  candidateOrFilter,
  documentsOfRows,
  extractLsrHeader,
  formatPriceLevel,
  formatSummary,
  HELP_TEXT,
  LSR_ILIKE,
  parseArgs,
  placeOfTender,
  reportPath,
  statusOfRun,
  type CliArgs,
  type LsrDeclared,
  type TenderReport,
} from "./estimate-benchmark.lib";
import {
  blindJobId,
  expectedModelCalls,
  formatBlindSummary,
  type BlindRemovalReport,
  type BlindStatus,
  type BlindTenderReport,
} from "./estimate-benchmark.blind.lib";
import { aiMaterialsOf } from "./estimate-benchmark.materials.lib";
import {
  e2eJobId,
  formatEstimateOnlySummary,
  ratioToNmck,
  resolveNmck,
  summarizeLines,
  type EstimateOnlyReport,
  type EstimateOnlyStatus,
} from "./estimate-benchmark.estimate.lib";

config({ path: resolve(__dirname, "../.env.local") });

/**
 * Бенчмарк точности сметы: наш расчёт против локальных смет заказчиков (ЛСР формы 421/пр). Только чтение.
 *
 *   npx tsx scripts/estimate-benchmark.ts [--tender <id>]... [--limit N] [--out <dir>] [--from-json <file> --zone <id>]
 *   npx tsx scripts/estimate-benchmark.ts --estimate-only --tender <id> [--tender <id>]... [--out <dir>]
 *
 * Что делает. Для каждой закупки собирает вход расчёта так же, как `runEstimateJob` воркера (документы с текстом,
 * зона по закупке, `ESTIMATE_PARAMETERS`), и вызывает `buildEstimateFromDocuments`. Модель заменена заглушкой, которая
 * возвращает пустой ответ и считает вызовы: когда в документах есть ЛСР, ведомость строится из неё кодом, и модель
 * не нужна; если заглушку всё же позвали, закупка помечена `MODEL_NEEDED`. Дальше `compareTender`
 * (`src/domain/estimate/benchmark.ts`) сравнивает наши строки с позициями ЛСР и раскладывает разницу в рублях.
 *
 * Чего не делает. Не пишет в базу, не собирает недостающие зоны (`ensureZoneBuilt` не зовётся: зоны нет — `NO_ZONE`),
 * не ходит в сеть, кроме чтения Supabase, и не печатает значения переменных окружения. Закупки идут по одной.
 *
 * Результат: `<out>/<закупка>.json` (все строки сравнения) и `<out>/summary.md`.
 *
 * Режим `--blind` (закупки без сметы заказчика). Вход — те же документы закупки, но смета заказчика вырезана из них по отрезкам
 * (`src/domain/estimate/estimateRemoval.ts`: ЛСР формы 421/пр, БИМ-сметы, смета контракта, таблицы НМЦК), остальной текст
 * архива остаётся. Остаток проверяется: разборы смет в нём ничего не находят, иначе закупка получает статус `LEAK` и модель
 * не зовётся. Дальше `buildEstimateFromDocuments` работает как у воркера, с НАСТОЯЩЕЙ моделью: `workerBillFetcher(SYNC_BASE_URL)`,
 * тот же разбор окружения (`resolveWorkerConfig`), без новых секретов. Модель зовётся через прод и тратит токены: прогон идёт только
 * по явным `--tender`, а `--dry-run` вырезает сметы и показывает остаток, не тратя ничего. Эталон — смета заказчика, прочитанная кодом
 * из исходных документов; `compareBlind` (`src/domain/estimate/benchmarkBlind.ts`) сравнивает итоги, покрытие по шифрам нормы, объёмы
 * и называет главные разрывы. Зона выбирается по закупке без шапки сметы заказчика — как у воркера, когда сметы нет.
 *
 * Что пишется в базу в режиме `--blind`: ничего этим скриптом. `buildEstimateFromDocuments` не сохраняет ни смет, ни заданий; прод по
 * ручке `/api/estimate/bill-rows` пишет расход модели в `llm_usage_log` (как при боевом расчёте), поэтому вызовам ставится метка
 * `job_id = bench-blind:<номер закупки>`.
 *
 * Режим `--estimate-only` (закупки без сметы заказчика, эталона нет). Тот же конвейер, что у воркера, без вырезания смет: документы закупки как есть,
 * зона — как её выбрал бы воркер (в том числе регион из документов, `resolveZoneTender`), НАСТОЯЩАЯ модель через прод (`workerBillFetcher`,
 * `workerNormPicker`, `workerImpliedProposer`), работы по технологии и мусор. Если в документах всё же нашлась смета заказчика, это пометка отчёта,
 * расчёт идёт как у воркера (объёмы возьмутся из неё). Отчёт по закупке: статус, зона, источник объёмов, токены, позиции ведомости, строки сметы по
 * источнику цены (норма / норма ИИ / ресурс / цена заказчика / услуга / добавлено расчётом), пробелы по видам, наш итог с НДС, НМЦК (`tenders.price`,
 * иначе фраза «Начальная (максимальная) цена…» из извещения или печатной формы) и отношение итога к ней, 15 главных строк по рублям и добавленные
 * расчётом строки. Пишет `<закупка>.json` и `summary.md` (по умолчанию в `/var/tmp/estimate-benchmark-e2e`). В базу ничего не пишет; прод по ручке
 * `/api/estimate/bill-rows` записывает расход модели в `llm_usage_log` с `job_id = bench-e2e:<номер закупки>`.
 */

const CANDIDATE_PAGE = 200;

/** Заглушка модели: пустой ответ и счётчик вызовов с именами документов. */
function countingFetcher(): { fetcher: BillRowsFetcher; calls: () => number; documents: () => string[] } {
  const documents = new Set<string>();
  let calls = 0;
  const fetcher: BillRowsFetcher = async (request) => {
    calls += 1;
    documents.add(request.documentName);
    return { rows: [], hasBill: false, tokens: 0, malformed: 0, truncated: false };
  };
  return { fetcher, calls: () => calls, documents: () => [...documents] };
}

/** Закупки, в документах которых есть ЛСР: два признака в `parsed_text`, выбирается только идентификатор. */
async function findCandidates(): Promise<string[]> {
  const supabase = getSupabaseServerClient();
  const ids = new Set<string>();
  let after: string | null = null;
  for (;;) {
    let query = supabase
      .from("tender_documents")
      .select("id, tender_id")
      .ilike("parsed_text", LSR_ILIKE)
      .or(candidateOrFilter())
      .order("id", { ascending: true })
      .limit(CANDIDATE_PAGE);
    if (after !== null) query = query.gt("id", after);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as { id: string; tender_id: string }[];
    for (const row of page) ids.add(row.tender_id);
    if (page.length < CANDIDATE_PAGE) break;
    after = (page[page.length - 1] as { id: string }).id;
  }
  return [...ids].sort();
}

/** Закупка по идентификатору: сначала как uuid, затем как реестровый номер — как в воркере. */
async function findTender(id: string): Promise<TenderRow | null> {
  return (await tenderRepository.findById(id).catch(() => null)) ?? (await tenderRepository.findByRegNumber(id).catch(() => null));
}

interface Context {
  readonly args: CliArgs;
  readonly zones: Awaited<ReturnType<typeof readPriceZoneRecords>>;
  readonly built: Awaited<ReturnType<typeof listBuiltZones>>;
}

function gapCountsOf(gaps: readonly { readonly kind: EstimateGapKind }[]): Partial<Record<EstimateGapKind, number>> {
  const counts: Partial<Record<EstimateGapKind, number>> = {};
  for (const gap of gaps) counts[gap.kind] = (counts[gap.kind] ?? 0) + 1;
  return counts;
}

const emptyReport = (tenderId: string, regNumber: string | null, status: TenderReport["status"], message: string | null, started: number, documents = 0): TenderReport => ({
  tenderId,
  regNumber,
  status,
  message,
  zone: null,
  method: null,
  period: null,
  documents,
  modelCalls: 0,
  modelDocuments: [],
  volumeLevel: null,
  declared: [],
  priceLevelNotes: [],
  zoneNotes: [],
  gapCounts: {},
  comparison: null,
  durationMs: Date.now() - started,
});

/**
 * Зона цен — как у воркера: вход выбора зоны повторяет `runEstimateJob` (scripts/worker.ts), включая зону из шапок смет заказчика
 * (`extractDeclaredPriceLevel`) и по ставкам труда в их ресурсных строках. Документы приходят те, что уйдут в расчёт: в режиме `--blind`
 * смет в них нет, и зона определяется по закупке, как у воркера без сметы. Бросает `EstimatePriceZoneError`, когда выбрать не по чему.
 */
async function selectZone(context: Context, documents: { name: string; text: string }[], tender: TenderRow | null): Promise<ReturnType<typeof chooseEstimateZone>> {
  const level = extractDeclaredPriceLevel(documents);
  const declaredZone = level === null ? null : { subject: level.subject, zoneName: level.zoneName, zoneNumber: level.zoneNumber };
  // Нет региона и адреса в карточке — регион из извещения и карточки закупки, как у воркера.
  const located = resolveZoneTender(tender === null ? null : { region: tender.region, address: tender.delivery_address, customerName: tender.customer_name }, documents);
  const zoneTender: TenderRow | null =
    located.tender === null || located.note === null
      ? tender
      : ({ ...(tender ?? {}), region: located.tender.region, delivery_address: located.tender.address, customer_name: located.tender.customerName } as TenderRow);
  const base = buildZoneInput({ userPriceZoneId: context.args.zone, tender: zoneTender, zones: context.zones, built: context.built, declared: declaredZone });
  // Зона по ставкам труда в ресурсных строках смет заказчика (при ручном выборе не считается): как в `runEstimateJob`.
  const byPrices = context.args.zone === null ? await fingerprintZoneByCustomerPrices(documents, base, loadZoneWageScale) : { fingerprint: null, message: null };
  return chooseEstimateZone({ ...base, fingerprint: byPrices.fingerprint });
}

/** Одна закупка: документы, ЛСР, зона, расчёт, сравнение. Любая ошибка — статус, а не падение прогона. */
async function runTender(context: Context, tenderId: string, tender: TenderRow | null, loadDocuments: () => Promise<{ name: string; text: string }[]>): Promise<TenderReport> {
  const started = Date.now();
  const regNumber = tender?.reg_number ?? null;

  const documents = await loadDocuments();
  if (documents.length === 0) return emptyReport(tenderId, regNumber, "NO_LSR", "нет документов с текстом", started);

  // ЛСР читаются кодом, так же, как внутри расчёта: тот же вход, тот же набор.
  const parsed = parseCustomerLsr(documents);
  const lsrSet = buildLsrSet(parsed.estimates);
  if (lsrSet.entries.length === 0) {
    const reason = parsed.notRecognized.length > 0 ? `не распознана: ${parsed.notRecognized[0]?.reason ?? ""}` : "локальных смет формы 421/пр в документах нет";
    return emptyReport(tenderId, regNumber, "NO_LSR", reason, started, documents.length);
  }

  const textByName = new Map(documents.map((document) => [document.name, document.text] as const));
  const declared: LsrDeclared[] = lsrSet.entries.map((entry, index) => ({
    index: index + 1,
    number: entry.number,
    title: entry.title,
    documentName: entry.documentName,
    header: extractLsrHeader(textByName.get(entry.documentName) ?? "", entry.estimate.estimateName),
    priceLevel: formatPriceLevel(entry.estimate),
    declaredZone: entry.estimate.priceLevel.zone,
    declaredQuarter: entry.estimate.priceQuarter === null ? null : `${String(entry.estimate.priceQuarter.quarter)} кв. ${String(entry.estimate.priceQuarter.year)}`,
  }));
  const withDeclared = (report: TenderReport): TenderReport => ({ ...report, declared });

  // Зона — как у воркера, но без сборки по требованию и без справочника ФГИС ЦС: не собрана — NO_ZONE.
  let zone: ReturnType<typeof chooseEstimateZone>;
  try {
    zone = await selectZone(context, documents, tender);
  } catch (error) {
    if (!(error instanceof EstimatePriceZoneError)) throw error;
    return withDeclared(emptyReport(tenderId, regNumber, "NO_ZONE", error.message, started, documents.length));
  }
  if (zone.built === false) {
    return withDeclared(emptyReport(tenderId, regNumber, "NO_ZONE", `цены зоны «${zone.zoneName}» не собраны на этой машине`, started, documents.length));
  }
  const zoneInfo = { priceZoneId: zone.priceZoneId, zoneName: zone.zoneName, basis: zone.basis, matched: zone.matched };
  const zoneNotes = (zone as { notes?: readonly string[] }).notes ?? [];

  const model = countingFetcher();
  try {
    const result = await buildEstimateFromDocuments(
      {
        regNumber: tenderId,
        subject: "Расчёт по документации",
        documents,
        parameters: ESTIMATE_PARAMETERS,
        priceZoneId: zone.priceZoneId,
        priceZoneName: zone.zoneName,
        priceZoneChoice: { basis: zone.basis, matched: zone.matched, northZone: zone.northZone, northBasis: zone.northBasis },
        options: context.args.method === "resource" ? { ...NO_ESTIMATE_OPTIONS, method: "RESOURCE_INDEX" } : normalizeEstimateOptions(undefined),
        place: placeOfTender(tender),
      },
      // Режим по ЛСР: нормы уже названы шифрами сметы заказчика, «ИИ-сметчик» ничего не выбирает (и не стоит токенов).
      { fetcher: model.fetcher, normPicker: NO_NORM_PICKER },
    );

    const comparison = compareTender({ lsrSet, document: result.document });
    const volumeLevel = result.volumeSource?.level ?? null;
    const status = statusOfRun({ modelCalls: model.calls(), volumeLevel });
    return {
      tenderId,
      regNumber,
      status,
      message:
        status === "OK"
          ? null
          : model.calls() > 0
            ? `заглушка модели вызвана ${String(model.calls())} раз (документы: ${model.documents().join(", ")})`
            : `объёмы расчёта взяты не из ЛСР: ${volumeLevel ?? "источника нет"}`,
      zone: zoneInfo,
      method: result.document.method,
      period: result.document.period,
      documents: documents.length,
      modelCalls: model.calls(),
      modelDocuments: model.documents(),
      volumeLevel,
      declared,
      // Смета заказчика составлена не в нашей зоне или квартале: построчное сравнение цен неточно (пометка документа).
      priceLevelNotes: result.document.gaps.filter((gap) => (gap.kind as string) === "PRICE_LEVEL_DIFFERS").map((gap) => gap.message),
      zoneNotes,
      gapCounts: gapCountsOf(result.document.gaps),
      comparison,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const base = { ...emptyReport(tenderId, regNumber, "ERROR", null, started, documents.length), zone: zoneInfo, declared, modelCalls: model.calls(), modelDocuments: model.documents() };
    // Прежний расчёт отказывал, когда документ объявлял другой уровень цен; нынешний ставит пометку PRICE_LEVEL_DIFFERS
    // и считает дальше. Имя, а не класс: бенчмарк должен работать с обеими редакциями расчёта.
    if (error instanceof EstimatePriceZoneError) return { ...base, status: "NO_ZONE", message: error.message };
    // Базы норм нет: следующие закупки упадут так же, поэтому ошибка идёт наверх, и прогон останавливается.
    if (error instanceof EstimateBaseMissingError) throw error;
    return { ...base, message: describeError(error) };
  }
}

/* ------------------------------ Режим --blind ------------------------------ */

const blindEmpty = (tenderId: string, regNumber: string | null, status: BlindStatus, message: string | null, started: number, extra: Partial<BlindTenderReport> = {}): BlindTenderReport => ({
  tenderId,
  regNumber,
  status,
  message,
  zone: null,
  zoneNotes: [],
  method: null,
  period: null,
  removal: null,
  customer: null,
  volumeLevel: null,
  volumeNote: null,
  volumeDocuments: [],
  tokensUsed: null,
  modelCalls: 0,
  modelDocuments: [],
  billItems: null,
  rejected: null,
  documentsWithoutBill: [],
  gapCounts: {},
  normPick: null,
  aiMaterials: [],
  generated: null,
  comparison: null,
  durationMs: Date.now() - started,
  ...extra,
});

/** Обёртка настоящего источника строк: считает вызовы и документы, ответы и ошибки не трогает. */
function countedFetcher(inner: BillRowsFetcher): { fetcher: BillRowsFetcher; calls: () => number; documents: () => string[] } {
  const documents = new Set<string>();
  let calls = 0;
  const fetcher: BillRowsFetcher = async (request) => {
    calls += 1;
    documents.add(request.documentName);
    return inner(request);
  };
  return { fetcher, calls: () => calls, documents: () => [...documents] };
}

/**
 * Одна закупка «вслепую»: документы, эталон (смета заказчика из исходных документов), вырезание смет из входа, зона, расчёт с настоящей
 * моделью, сравнение. Любая ошибка — статус, а не падение прогона (кроме отсутствия базы норм: следующие закупки упадут так же).
 */
async function runBlindTender(context: Context, tenderId: string, tender: TenderRow | null, baseUrl: string): Promise<BlindTenderReport> {
  const started = Date.now();
  const regNumber = tender?.reg_number ?? null;
  // Документы закупки лежат под реестровым номером (tender_documents.tender_id): так же читает воркер.
  const documentsKey = regNumber ?? tenderId;
  const originals = documentsOfRows(await documentRepository.findByTenderId(documentsKey));
  if (originals.length === 0) return blindEmpty(tenderId, regNumber, "NO_DOCUMENTS", "нет документов с текстом", started);

  // Эталон: ЛСР из исходных документов, тем же разбором, что в обычном режиме.
  const parsed = parseCustomerLsr(originals);
  const lsrSet = buildLsrSet(parsed.estimates);
  if (lsrSet.entries.length === 0) {
    const reason = parsed.notRecognized.length > 0 ? `не распознана: ${parsed.notRecognized[0]?.reason ?? ""}` : "локальных смет формы 421/пр в документах нет";
    return blindEmpty(tenderId, regNumber, "NO_LSR", reason, started);
  }
  const customerPositions = customerPositionsOf(lsrSet);
  // Σ «ВСЕГО по смете» без НДС по сметам, у которых он есть (как `aggregateRows` обычного бенчмарка).
  const totalsExVat = lsrSet.entries.map((entry) => entry.totalExVat).filter((total): total is number => total !== null);
  const textByName = new Map(originals.map((document) => [document.name, document.text] as const));
  const declared = lsrSet.entries.map((entry) => {
    const header = extractLsrHeader(textByName.get(entry.documentName) ?? "", entry.estimate.estimateName);
    return [[header.subject, header.zone].filter((part) => part !== null).join(" / "), formatPriceLevel(entry.estimate)].filter((part) => part !== null && part !== "").join(", ");
  });
  const customer = {
    lsrs: lsrSet.entries.length,
    positions: customerPositions.length,
    totalExVat: totalsExVat.length === 0 ? null : Math.round(totalsExVat.reduce((sum, total) => sum + total, 0) * 100) / 100,
    positionsTotal: Math.round(customerPositions.reduce((sum, position) => sum + (position.total ?? 0), 0) * 100) / 100,
    declared: [...new Set(declared.filter((item) => item !== ""))],
  };

  // Вход расчёта без смет заказчика.
  const stripped = stripCustomerEstimates(originals);
  const used = stripped.documents.map((document) => ({ name: document.name, text: document.text }));
  const removal: BlindRemovalReport = {
    originalDocuments: originals.length,
    originalChars: originals.reduce((sum, document) => sum + document.text.length, 0),
    usedDocuments: stripped.documents.map((document) => ({ name: document.name, chars: document.text.length, originalChars: document.originalChars })),
    remainingChars: used.reduce((sum, document) => sum + document.text.length, 0),
    dropped: stripped.dropped,
    removed: stripped.removed,
    leaks: stripped.leaks,
    warnings: stripped.warnings,
    expectedModelCalls: expectedModelCalls(used),
  };
  const base = { removal, customer };

  if (stripped.leaks.length > 0) {
    const names = [...new Set(stripped.leaks.map((leak) => leak.document))];
    return blindEmpty(tenderId, regNumber, "LEAK", `смета заказчика осталась во входе: ${names.join("; ")} (${stripped.leaks.map((leak) => leak.detail).join("; ")})`, started, base);
  }
  if (used.length === 0) return blindEmpty(tenderId, regNumber, "NO_DOCUMENTS", "после вырезания смет не осталось документов (всё было сметами)", started, base);
  if (context.args.dryRun) return blindEmpty(tenderId, regNumber, "DRY_RUN", `модель не звалась; ожидается около ${String(removal.expectedModelCalls)} вызовов`, started, base);

  // Зона — по закупке, без шапки сметы заказчика: её во входе нет, и это то, что увидел бы воркер без сметы.
  let zone: ReturnType<typeof chooseEstimateZone>;
  try {
    zone = await selectZone(context, used, tender);
  } catch (error) {
    if (!(error instanceof EstimatePriceZoneError)) throw error;
    return blindEmpty(tenderId, regNumber, "NO_ZONE", error.message, started, base);
  }
  if (zone.built === false) return blindEmpty(tenderId, regNumber, "NO_ZONE", `цены зоны «${zone.zoneName}» не собраны на этой машине`, started, base);
  const zoneInfo = { priceZoneId: zone.priceZoneId, zoneName: zone.zoneName, basis: zone.basis, matched: zone.matched };
  const zoneNotes = (zone as { notes?: readonly string[] }).notes ?? [];

  const model = countedFetcher(workerBillFetcher(baseUrl));
  try {
    const result = await buildEstimateFromDocuments(
      {
        regNumber: documentsKey,
        subject: tender?.subject ?? "Расчёт по документации",
        documents: used,
        jobId: blindJobId(documentsKey),
        parameters: ESTIMATE_PARAMETERS,
        priceZoneId: zone.priceZoneId,
        priceZoneName: zone.zoneName,
        priceZoneChoice: { basis: zone.basis, matched: zone.matched, northZone: zone.northZone, northBasis: zone.northBasis, ...(zone.notes === undefined ? {} : { notes: zone.notes }) },
        options: context.args.method === "resource" ? { ...NO_ESTIMATE_OPTIONS, method: "RESOURCE_INDEX" } : normalizeEstimateOptions(undefined),
        place: placeOfTender(tender),
      },
      // Слепой режим — как у воркера: позиции без шифра получают норму от «ИИ-сметчика» через тот же прод, что и ведомость; работы по технологии
      // (леса, сетки, ограждения) предлагает модель через тот же прод, а мусор добавляет код — именно эти строки сверяются со сметой заказчика отдельно.
      { fetcher: model.fetcher, normPicker: workerNormPicker(baseUrl), impliedProposer: workerImpliedProposer(baseUrl) },
    );

    const billItems = result.bill.sections.flatMap((section) => section.items);
    const ours = ourLinesOf(result.document, billItems);
    const comparison = compareBlind({
      customer: customerPositions,
      ours,
      ourWorkTotal: result.document.totals.workCost,
      customerLsrTotal: customer.totalExVat,
      generatedUnpriced: generatedUnpricedOf(result.bill.sections, result.document),
    });
    const noVolumes = result.volumeSource === null || ours.length === 0;
    return blindEmpty(tenderId, regNumber, noVolumes ? "NO_VOLUMES" : "OK", noVolumes ? "объёмов нет ни в одном документе" : null, started, {
      ...base,
      zone: zoneInfo,
      zoneNotes,
      method: result.document.method,
      period: result.document.period,
      volumeLevel: result.volumeSource?.level ?? null,
      volumeNote: result.volumeSource?.note ?? null,
      volumeDocuments: result.volumeSource === null ? [] : [...result.volumeSource.documents],
      // Токены ведомости, подбора норм ИИ и работ по технологии вместе: отчёт показывает, сколько стоил прогон целиком.
      tokensUsed: result.tokensUsed + result.normPick.tokens + result.generated.implied.tokens,
      modelCalls: model.calls(),
      modelDocuments: model.documents(),
      billItems: result.billItems,
      rejected: result.rejected.length,
      documentsWithoutBill: [...result.documentsWithoutBill],
      gapCounts: gapCountsOf(result.document.gaps),
      // Счётчики «ИИ-сметчика» (нормы и материалы) целиком: по ним видно, что дала модель, а что отклонила проверка.
      normPick: { ...result.normPick, notes: [...result.normPick.notes] },
      // Материалы, подобранные ИИ: что выбрано под какую норму, расход, цена, обоснование — по ним видно, на какую позицию попало дорогое покрытие.
      aiMaterials: aiMaterialsOf(result),
      // Строки сверх ведомости: сколько мусора и работ по технологии добавлено, на сколько рублей и что отклонила проверка.
      generated: { debris: { ...result.generated.debris }, implied: { ...result.generated.implied, notes: [...result.generated.implied.notes] } },
      comparison,
    });
  } catch (error) {
    // Базы норм нет: следующие закупки упадут так же, поэтому ошибка идёт наверх, и прогон останавливается.
    if (error instanceof EstimateBaseMissingError) throw error;
    const failed = { ...base, zone: zoneInfo, zoneNotes, modelCalls: model.calls(), modelDocuments: model.documents() };
    if (error instanceof EstimatePriceZoneError) return blindEmpty(tenderId, regNumber, "NO_ZONE", error.message, started, failed);
    return blindEmpty(tenderId, regNumber, "ERROR", describeError(error), started, failed);
  }
}

/* ------------------------------ Режим --estimate-only ------------------------------ */

const e2eEmpty = (tenderId: string, regNumber: string | null, status: EstimateOnlyStatus, message: string | null, started: number, extra: Partial<EstimateOnlyReport> = {}): EstimateOnlyReport => ({
  tenderId,
  regNumber,
  status,
  message,
  notes: [],
  zone: null,
  zoneNotes: [],
  method: null,
  period: null,
  volumeLevel: null,
  volumeNote: null,
  volumeDocuments: [],
  tokens: null,
  modelCalls: 0,
  billItems: null,
  rejected: null,
  documentsWithoutBill: [],
  duplicateDocuments: [],
  pricedLines: null,
  linesBySource: null,
  gapCounts: {},
  totals: null,
  nmck: null,
  ratioToNmck: null,
  topLines: [],
  generatedRows: [],
  normPick: null,
  aiMaterials: [],
  generated: null,
  durationMs: Date.now() - started,
  ...extra,
});

/**
 * Одна закупка без эталона: документы как есть, зона как у воркера, расчёт с настоящей моделью. Любая ошибка — статус, а не падение прогона
 * (кроме отсутствия базы норм: следующие закупки упадут так же).
 */
async function runEstimateOnlyTender(context: Context, tenderId: string, tender: TenderRow | null, baseUrl: string): Promise<EstimateOnlyReport> {
  const started = Date.now();
  const regNumber = tender?.reg_number ?? null;
  const documentsKey = regNumber ?? tenderId;
  const documents = documentsOfRows(await documentRepository.findByTenderId(documentsKey));
  if (documents.length === 0) return e2eEmpty(tenderId, regNumber, "NO_DOCUMENTS", "нет документов с текстом", started);

  const notes: string[] = [];
  // Режим для закупок без сметы заказчика: если она всё же есть, это надо видеть, но расчёт идёт, как у воркера.
  const lsrSet = buildLsrSet(parseCustomerLsr(documents).estimates);
  if (lsrSet.entries.length > 0) {
    notes.push(`в документах есть смета заказчика формы 421/пр (${String(lsrSet.entries.length)} шт.): режим для закупок без неё, объёмы расчёта возьмутся из сметы, как у воркера`);
  }
  const located = resolveZoneTender(tender === null ? null : { region: tender.region, address: tender.delivery_address, customerName: tender.customer_name }, documents);
  if (located.note !== null) notes.push(`зона цен: ${located.note}`);

  const nmck = resolveNmck(tender?.price ?? null, documents);
  const base = { notes, nmck };

  let zone: ReturnType<typeof chooseEstimateZone>;
  try {
    zone = await selectZone(context, documents, tender);
  } catch (error) {
    if (!(error instanceof EstimatePriceZoneError)) throw error;
    return e2eEmpty(tenderId, regNumber, "NO_ZONE", error.message, started, base);
  }
  if (zone.built === false) return e2eEmpty(tenderId, regNumber, "NO_ZONE", `цены зоны «${zone.zoneName}» не собраны на этой машине`, started, base);
  const zoneInfo = { priceZoneId: zone.priceZoneId, zoneName: zone.zoneName, basis: zone.basis, matched: zone.matched };
  const zoneNotes = (zone as { notes?: readonly string[] }).notes ?? [];

  const model = countedFetcher(workerBillFetcher(baseUrl));
  try {
    const result = await buildEstimateFromDocuments(
      {
        regNumber: documentsKey,
        subject: tender?.subject ?? "Расчёт по документации",
        documents,
        jobId: e2eJobId(documentsKey),
        parameters: ESTIMATE_PARAMETERS,
        priceZoneId: zone.priceZoneId,
        priceZoneName: zone.zoneName,
        priceZoneChoice: { basis: zone.basis, matched: zone.matched, northZone: zone.northZone, northBasis: zone.northBasis, ...(zone.notes === undefined ? {} : { notes: zone.notes }) },
        options: context.args.method === "resource" ? { ...NO_ESTIMATE_OPTIONS, method: "RESOURCE_INDEX" } : normalizeEstimateOptions(undefined),
        place: placeOfTender(tender),
      },
      // Ровно зависимости воркера (scripts/worker.ts, runEstimateJob): ведомость, нормы ИИ и работы по технологии — через прод.
      { fetcher: model.fetcher, normPicker: workerNormPicker(baseUrl), impliedProposer: workerImpliedProposer(baseUrl) },
    );

    const lines = summarizeLines(result);
    const totals = result.document.totals;
    const noVolumes = result.volumeSource === null || lines.pricedLines === 0;
    return e2eEmpty(tenderId, regNumber, noVolumes ? "NO_VOLUMES" : "OK", noVolumes ? "объёмов нет ни в одном документе или в смете нет строк" : null, started, {
      ...base,
      zone: zoneInfo,
      zoneNotes,
      method: result.document.method,
      period: result.document.period,
      volumeLevel: result.volumeSource?.level ?? null,
      volumeNote: result.volumeSource?.note ?? null,
      volumeDocuments: result.volumeSource === null ? [] : [...result.volumeSource.documents],
      tokens: {
        bill: result.tokensUsed,
        normPick: result.normPick.tokens,
        implied: result.generated.implied.tokens,
        total: result.tokensUsed + result.normPick.tokens + result.generated.implied.tokens,
      },
      modelCalls: model.calls(),
      billItems: result.billItems,
      rejected: result.rejected.length,
      documentsWithoutBill: [...result.documentsWithoutBill],
      duplicateDocuments: result.duplicateDocuments.map((entry) => ({ ...entry })),
      pricedLines: lines.pricedLines,
      linesBySource: lines.linesBySource,
      gapCounts: gapCountsOf(result.document.gaps),
      totals: { workCost: totals.workCost, beforeVat: totals.beforeVat, vat: totals.vat, total: totals.total },
      ratioToNmck: ratioToNmck(totals.total, nmck),
      topLines: lines.topLines,
      generatedRows: lines.generatedRows,
      normPick: { ...result.normPick, notes: [...result.normPick.notes] },
      aiMaterials: aiMaterialsOf(result),
      generated: { debris: { ...result.generated.debris }, implied: { ...result.generated.implied, notes: [...result.generated.implied.notes] } },
    });
  } catch (error) {
    // Базы норм нет: следующие закупки упадут так же, поэтому ошибка идёт наверх, и прогон останавливается.
    if (error instanceof EstimateBaseMissingError) throw error;
    const failed = { ...base, zone: zoneInfo, zoneNotes, modelCalls: model.calls() };
    if (error instanceof EstimatePriceZoneError) return e2eEmpty(tenderId, regNumber, "NO_ZONE", error.message, started, failed);
    return e2eEmpty(tenderId, regNumber, "ERROR", describeError(error), started, failed);
  }
}

/** Прогон `--estimate-only`: закупки заданы явно; модель зовётся через прод так же, как у воркера. */
async function runEstimateOnly(context: Context, outDir: string): Promise<void> {
  const { args } = context;
  const workerConfig = resolveWorkerConfig(process.env);
  console.log(`Режим --estimate-only: модель будет вызвана через прод, токены тратятся. Закупок: ${String(args.tenders.length)}. Расход пишется в llm_usage_log с меткой job_id «bench-e2e:…».`);

  const reports: EstimateOnlyReport[] = [];
  const counted = new Set<string>();
  for (const [index, tenderId] of args.tenders.entries()) {
    const label = `[${String(index + 1)}/${String(args.tenders.length)}] ${tenderId}`;
    const started = Date.now();
    let report: EstimateOnlyReport;
    let baseMissing = false;
    try {
      const tender = await findTender(tenderId);
      if (tender !== null && counted.has(tender.reg_number)) {
        console.log(`${label}: пропущена, та же закупка ${tender.reg_number} уже посчитана`);
        continue;
      }
      report = await runEstimateOnlyTender(context, tenderId, tender, workerConfig.baseUrl);
      if (tender !== null) counted.add(tender.reg_number);
    } catch (error) {
      report = e2eEmpty(tenderId, null, "ERROR", describeError(error), started);
      baseMissing = error instanceof EstimateBaseMissingError;
    }
    reports.push(report);
    writeReport(outDir, report);
    console.log(
      `${label}: ${report.status}` +
        `${report.tokens === null ? "" : `, токенов ${String(report.tokens.total)}`}` +
        `${report.totals === null ? "" : `, итог с НДС ${String(report.totals.total)}`}` +
        `${report.ratioToNmck === null ? "" : `, к НМЦК ${String(report.ratioToNmck)}`}` +
        `${report.message === null ? "" : ` — ${report.message.slice(0, 200)}`}`,
    );
    if (baseMissing) {
      console.error("База ФСНБ не собрана на этой машине (npx tsx scripts/fsnb/build-index.ts): прогон остановлен.");
      break;
    }
  }

  const summary = formatEstimateOnlySummary(reports, { generatedAt: new Date().toISOString(), topN: 15 });
  writeFileSync(path.join(outDir, "summary.md"), summary, "utf8");
  console.log(`Готово: ${String(reports.length)} закупок, сводка ${path.join(outDir, "summary.md")}`);
}

function writeReport(outDir: string, report: { readonly tenderId: string }): void {
  writeFileSync(reportPath(outDir, report.tenderId), `${JSON.stringify(report, null, 1)}\n`, "utf8");
}

interface FromJsonDocument {
  readonly filename?: unknown;
  readonly parsed_text?: unknown;
  readonly raw_json?: unknown;
}

function readDumpDocuments(file: string): { name: string; text: string }[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${file}: ожидался массив [{filename, parsed_text}]`);
  const rows = (raw as FromJsonDocument[]).map((item) => ({
    filename: typeof item.filename === "string" ? item.filename : "документ",
    parsed_text: typeof item.parsed_text === "string" ? item.parsed_text : null,
    raw_json: item.raw_json,
  }));
  return documentsOfRows(rows);
}

/** Прогон `--blind`: закупки заданы явно; модель зовётся через прод так же, как у воркера. */
async function runBlind(context: Context, outDir: string): Promise<void> {
  const { args } = context;
  // Адрес прода с ручкой извлечения ведомости — из того же разбора окружения, что у воркера; значения не печатаются.
  const workerConfig = resolveWorkerConfig(process.env);
  if (!args.dryRun) {
    console.log(`Режим --blind: модель будет вызвана через прод, токены тратятся. Закупок: ${String(args.tenders.length)}. Расход пишется в llm_usage_log с меткой job_id «bench-blind:…».`);
  }

  const reports: BlindTenderReport[] = [];
  const counted = new Set<string>();
  for (const [index, tenderId] of args.tenders.entries()) {
    const label = `[${String(index + 1)}/${String(args.tenders.length)}] ${tenderId}`;
    const started = Date.now();
    let report: BlindTenderReport;
    let baseMissing = false;
    try {
      const tender = await findTender(tenderId);
      if (tender !== null && counted.has(tender.reg_number)) {
        console.log(`${label}: пропущена, та же закупка ${tender.reg_number} уже посчитана`);
        continue;
      }
      report = await runBlindTender(context, tenderId, tender, workerConfig.baseUrl);
      if (tender !== null) counted.add(tender.reg_number);
    } catch (error) {
      report = blindEmpty(tenderId, null, "ERROR", describeError(error), started);
      baseMissing = error instanceof EstimateBaseMissingError;
    }
    reports.push(report);
    writeReport(outDir, report);
    const delta = report.comparison?.totals.deltaPercentVsPositions;
    const coverage = report.comparison?.coverage.matchedPercent;
    console.log(
      `${label}: ${report.status}` +
        `${report.tokensUsed === null ? "" : `, токенов ${String(report.tokensUsed)}`}` +
        `${delta === null || delta === undefined ? "" : `, Δ ${String(delta)} %`}` +
        `${coverage === null || coverage === undefined ? "" : `, покрытие по шифрам ${String(coverage)} %`}` +
        `${report.message === null ? "" : ` — ${report.message.slice(0, 200)}`}`,
    );
    if (baseMissing) {
      console.error("База ФСНБ не собрана на этой машине (npx tsx scripts/fsnb/build-index.ts): прогон остановлен.");
      break;
    }
  }

  const summary = formatBlindSummary(reports, { generatedAt: new Date().toISOString(), topN: 15 });
  writeFileSync(path.join(outDir, "summary.md"), summary, "utf8");
  console.log(`Готово: ${String(reports.length)} закупок, сводка ${path.join(outDir, "summary.md")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (args.fromJson === null) {
    const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((name) => !process.env[name]);
    if (missing.length > 0) throw new Error(`В .env.local нет ${missing.join(", ")}`);
  }

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  const [built, zones] = await Promise.all([listBuiltZones(), readPriceZoneRecords()]);
  const context: Context = { args, built, zones };

  if (args.blind) {
    await runBlind(context, outDir);
    return;
  }
  if (args.estimateOnly) {
    await runEstimateOnly(context, outDir);
    return;
  }

  let tenderIds: string[];
  if (args.fromJson !== null) tenderIds = [args.tenders[0] ?? path.basename(args.fromJson).replace(/\.[^.]+$/, "")];
  else if (args.tenders.length > 0) tenderIds = [...args.tenders];
  else {
    console.log("Ищу закупки с локальными сметами в tender_documents…");
    tenderIds = await findCandidates();
    console.log(`Найдено закупок-кандидатов: ${String(tenderIds.length)}`);
  }
  if (args.limit !== null) tenderIds = tenderIds.slice(0, args.limit);

  const reports: TenderReport[] = [];
  // Одну закупку могут называть и uuid, и реестровый номер: уже посчитанную по ЛСР второй раз не считаем.
  const counted = new Set<string>();

  for (const [index, tenderId] of tenderIds.entries()) {
    const label = `[${String(index + 1)}/${String(tenderIds.length)}] ${tenderId}`;
    const started = Date.now();
    let report: TenderReport;
    let baseMissing = false;
    try {
      const tender = args.fromJson === null ? await findTender(tenderId) : null;
      if (tender !== null && counted.has(tender.reg_number)) {
        console.log(`${label}: пропущена, та же закупка ${tender.reg_number} уже посчитана`);
        continue;
      }
      const loadDocuments =
        args.fromJson === null
          ? async () => documentsOfRows(await documentRepository.findByTenderId(tenderId))
          : async () => readDumpDocuments(args.fromJson as string);
      report = await runTender(context, tenderId, tender, loadDocuments);
      if (tender !== null && (report.status === "OK" || report.status === "MODEL_NEEDED" || report.status === "PRICE_LEVEL")) counted.add(tender.reg_number);
    } catch (error) {
      report = emptyReport(tenderId, null, "ERROR", describeError(error), started);
      baseMissing = error instanceof EstimateBaseMissingError;
    }
    reports.push(report);
    writeReport(outDir, report);
    const delta = report.comparison?.aggregate.deltaPercent;
    console.log(`${label}: ${report.status}${delta === null || delta === undefined ? "" : `, Δ ${String(delta)} %`}${report.message === null ? "" : ` — ${report.message.slice(0, 160)}`}`);

    if (baseMissing) {
      console.error("База ФСНБ не собрана на этой машине (npx tsx scripts/fsnb/build-index.ts): прогон остановлен.");
      break;
    }
  }

  const summary = formatSummary(reports, {
    generatedAt: new Date().toISOString(),
    source: args.fromJson === null ? "таблица tender_documents (parsed_text)" : `файл ${path.basename(args.fromJson)}`,
    topN: 50,
  });
  writeFileSync(path.join(outDir, "summary.md"), summary.text, "utf8");
  console.log(`Готово: ${String(reports.length)} закупок, сводка ${path.join(outDir, "summary.md")}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Критическая ошибка:", err instanceof Error ? err.message : describeError(err));
    process.exitCode = 1;
  });
}
