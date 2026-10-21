import { createHash } from "node:crypto";

import { moscowDayStart } from "@/domain/analysisQuota";
import {
  FIT_VERSION,
  assembleFit,
  buildFitPrompt,
  hasCompanyData,
  needsModel,
  noCompanyDataFit,
  parseFitResponse,
  readFit,
  ruleLayer,
  type CompanyFitResult,
  type FitModelAnswer,
  type FitTender,
} from "@/domain/companyFacts/fit";
import { sanitizeFacts } from "@/domain/companyFacts/schema";
import { factsHaveContent, type CompanyFacts } from "@/domain/companyFacts/types";
import { summarizeDeepAnalysis } from "@/domain/deepAnalysis";
import type { CompanyProfile } from "@/domain/entities";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import { describeError } from "@/lib/errors";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { companyFitRepository, type CompanyFitStore } from "@/repositories/companyFitRepository";
import { normalizeSavedProfile } from "@/repositories/companyProfileRepository";
import { documentAnalysisRepository } from "@/repositories/documentAnalysisRepository";
import { documentRepository } from "@/repositories/documentRepository";
import { tenderRepository } from "@/repositories/tenderRepository";
import { userDataRepository } from "@/repositories/userDataRepository";
import { dbRowToTender } from "@/services/tenderApiService";
import { llmChat, type ChatFn } from "@/services/searchAssistService";
import type { AnalysisJobRow, DocumentAnalysisRow, DocumentMeta, TenderRow } from "@/types/database";

/**
 * Сверка компании с закупкой — серверная часть: собрать, что известно о закупке и о человеке, посчитать правилами и одной
 * малой модельной сверкой, запомнить на человека и закупку.
 *
 * Чьи данные. Анкета и факты читаются из `user_data` ПО ИДЕНТИФИКАТОРУ ВОШЕДШЕГО (его даёт сессия), а не из тела запроса:
 * подставить чужие факты или чужую закупку-сверку нельзя. Результат пишется под тем же идентификатором.
 *
 * Когда модель не зовётся. (1) Попадание в кэш: совпали отпечаток анализа закупки, отпечаток данных компании и версия
 * формата — ответ из `company_fit`. (2) Сверять не с чем: ни фактов, ни допусков и опыта в анкете. (3) Правилам нечего
 * отдавать модели и контрактов в фактах нет. Сбой модели сверку не роняет: остаются правила и подбор по словам; такой
 * результат наружу отдаётся, но НЕ запоминается — следующее открытие карточки получит шанс на полный.
 *
 * Лимит. Сверка не расходует суточный лимит глубоких разборов (`analysisQuota`: 15 в сутки на человека): это малый вызов
 * (≈3–5 тыс. токенов на входе и ≈0,6 тыс. на выходе, около 0,1 ₽), а лимит глубокого анализа защищает от счёта на
 * десятки рублей. Отдельная защита: не больше `FIT_DAILY_LIMIT` модельных сверок в сутки на человека (по строкам
 * `company_fit`, обновлённым за сутки по Москве) и лимит частоты на ручке. Повтор по тому же состоянию — из кэша, бесплатно.
 */

/** Модельных сверок в сутки на человека (сутки по Москве). Кэш и сверки без модели в счёт не идут. */
export const FIT_DAILY_LIMIT = 60;

/** Ответ короткий: вердикты по ≤14 требованиям, до пяти контрактов, пара списков. */
export const FIT_MAX_TOKENS = 3_000;
export const FIT_TIMEOUT_MS = 60_000;

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Отпечаток анализа закупки: что и в каком виде требует закупка. Другой разбор документов — другой отпечаток. */
export function analysisFingerprint(tender: FitTender & { law: string | null }, findings: readonly { category: string; title: string; detail: string; required_value?: string | null; requirement_kind?: string | null }[]): string {
  return sha({
    v: FIT_VERSION,
    tender: { subject: tender.subject, region: tender.region, price: tender.price, law: tender.law },
    findings: findings.map((item) => [item.category, item.title, item.detail, item.required_value ?? null, item.requirement_kind ?? null]),
  });
}

/**
 * Отпечаток данных компании: факты целиком (без названий документов и счётчиков скрытого — они на сверку не влияют) и
 * поля анкеты, от которых зависят правила. Правка любого — другой отпечаток, сверка пересчитается.
 */
export function companyFingerprint(profile: CompanyProfile, facts: CompanyFacts | null): string {
  return sha({
    v: FIT_VERSION,
    facts:
      facts === null
        ? null
        : {
            workTypes: facts.workTypes,
            contracts: facts.contracts,
            sro: facts.sro,
            licenses: facts.licenses,
            equipment: facts.equipment,
            staff: facts.staff,
            staffTotal: facts.staffTotal ?? null,
            regions: facts.regions,
            notes: facts.notes,
          },
    profile: {
      sro: profile.sroMemberships.map((item) => [item.kind, item.responsibilityLevel, item.maxContractAmount, item.validUntil, item.confirmed]),
      licenses: profile.licenses.map((item) => [item.kind, item.validUntil, item.confirmed]),
      experience: profile.experience.map((item) => [item.amount, item.completedAt]),
      totals: profile.experienceTotals,
      staff: profile.staff,
      flags: [profile.hasEquipment, profile.hasPersonnel, profile.hasSpecialAccount],
      regions: [...profile.restrictions.workRegions, ...profile.preferences.priorityRegions],
    },
  });
}

export interface FitAnalysisSource {
  jobs: AnalysisJobRow[];
  documents: DocumentMeta[];
  documentAnalyses: DocumentAnalysisRow[];
}

export interface FitDeps {
  chat: ChatFn;
  store: CompanyFitStore;
  loadTender: (regNumber: string) => Promise<TenderRow | null>;
  loadAnalysis: (regNumber: string) => Promise<FitAnalysisSource>;
  /** `user_data.company_profile` вошедшего как есть; null — анкеты на сервере нет. */
  loadCompanyProfile: (userId: string) => Promise<unknown>;
  now?: () => Date;
}

export function defaultFitDeps(): FitDeps {
  return {
    chat: llmChat,
    store: companyFitRepository,
    loadTender: (regNumber) => tenderRepository.findByRegNumber(regNumber),
    loadAnalysis: async (regNumber) => {
      const [jobs, documents, documentAnalyses] = await Promise.all([
        analysisJobRepository.findByTenderId(regNumber),
        documentRepository.listMetaByTenderId(regNumber),
        documentAnalysisRepository.findByTenderId(regNumber),
      ]);
      return { jobs, documents, documentAnalyses };
    },
    loadCompanyProfile: async (userId) => (await userDataRepository.get(userId))?.companyProfile ?? null,
  };
}

export type FitOutcome =
  | { status: "ok"; result: CompanyFitResult; cached: boolean; /** Модель не ответила: результат — правила, он не запомнен. */ degraded: boolean }
  | { status: "no_data"; result: CompanyFitResult }
  | { status: "no_tender" }
  | { status: "no_analysis" }
  | { status: "limit"; limit: number };

let warnedStore = false;
function warnStore(error: unknown): void {
  if (warnedStore) return;
  warnedStore = true;
  console.warn(`[company-fit] хранилище сверок недоступно (${describeError(error)}); применена ли миграция 20261021000027? Сверка считается без кэша.`);
}

export async function computeCompanyFit(
  input: { userId: string; tenderId: string; force?: boolean },
  deps: FitDeps,
): Promise<FitOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  const row = await deps.loadTender(input.tenderId);
  if (row === null) return { status: "no_tender" };

  // Выводы анализа — те же, что видит карточка (с правилами закона и чисткой шума).
  const source = await deps.loadAnalysis(input.tenderId);
  const summary = summarizeDeepAnalysis({
    dataSource: row.data_source,
    jobs: source.jobs,
    documents: source.documents,
    documentAnalyses: source.documentAnalyses,
    verdictHistory: [],
    price: row.price,
    law: row.law,
  });
  if (summary.state !== "completed") return { status: "no_analysis" };

  const rawProfile = await deps.loadCompanyProfile(input.userId);
  const profile = rawProfile === null || rawProfile === undefined ? null : normalizeSavedProfile(rawProfile);
  const companyName = profile?.legalName ?? "";
  const storedFacts =
    typeof rawProfile === "object" && rawProfile !== null ? (rawProfile as Record<string, unknown>)["companyFacts"] : undefined;
  // Факты хранятся в анкете, пришедшей с устройства: перед отправкой в модель они проходят проверку на личное заново.
  const facts =
    sanitizeFacts(storedFacts, { scrub: { ...(profile === null ? {} : { companyInn: profile.inn }), keep: [companyName] }, now })?.facts ?? null;

  if (!hasCompanyData(profile, facts)) return { status: "no_data", result: noCompanyDataFit(input.tenderId, now) };

  const tender = dbRowToTender(row);
  const fitTender: FitTender = { regNumber: input.tenderId, subject: tender.subject, region: tender.region, price: tender.financial.price > 0 ? tender.financial.price : null };
  const rules = ruleLayer({ tender, findings: summary.findings, profile: profile ?? emptyCompanyProfile, facts, now });

  const analysisHash = analysisFingerprint({ ...fitTender, law: row.law }, summary.findings);
  const factsHash = companyFingerprint(rules.profile, factsHaveContent(facts) ? facts : null);

  // Кэш: тот же анализ, те же данные компании, тот же формат.
  if (input.force !== true) {
    try {
      const stored = await deps.store.get(input.userId, input.tenderId);
      if (stored !== null && stored.analysisHash === analysisHash && stored.factsHash === factsHash) {
        const result = readFit(stored.result);
        if (result !== null) return { status: "ok", result, cached: true, degraded: false };
      }
    } catch (error) {
      warnStore(error);
    }
  }

  // Модельная сверка: нужна, когда есть что решать или есть контракты для подбора «по теме».
  const wantsModel = rules.requirements.some(needsModel) || (facts?.contracts.length ?? 0) > 0;
  let answer: FitModelAnswer | null = null;
  let degraded = false;
  if (wantsModel && factsHaveContent(facts)) {
    let usedToday = 0;
    try {
      usedToday = await deps.store.countLlmSince(input.userId, moscowDayStart(now).toISOString());
    } catch (error) {
      warnStore(error);
    }
    if (usedToday >= FIT_DAILY_LIMIT) return { status: "limit", limit: FIT_DAILY_LIMIT };
    try {
      const reply = await deps.chat(
        buildFitPrompt({ tender: fitTender, requirements: rules.requirements, facts }),
        FIT_MAX_TOKENS,
        { purpose: "company_fit", tenderId: input.tenderId, userId: input.userId },
        { timeoutMs: FIT_TIMEOUT_MS, reasoning: false },
      );
      answer = parseFitResponse(reply.content);
    } catch (error) {
      degraded = true;
      console.error(`Сверка с компанией по закупке ${input.tenderId}: модель не ответила: ${describeError(error)}`);
    }
  }

  const result = assembleFit({ tender: fitTender, rules, facts, answer, now });

  if (!degraded) {
    try {
      await deps.store.put({
        userId: input.userId,
        tenderId: input.tenderId,
        analysisHash,
        factsHash,
        result,
        overall: result.overall,
        llmUsed: result.llmUsed,
      });
    } catch (error) {
      warnStore(error);
    }
  }
  return { status: "ok", result, cached: false, degraded };
}
