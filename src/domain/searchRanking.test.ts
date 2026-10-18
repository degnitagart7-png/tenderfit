import { describe, expect, it } from "vitest";
import type { MatchResult, ParsedQuery } from "@/domain/textSearch";
import {
  CODE_WEIGHT,
  FIT_WEIGHT,
  PHRASE_WEIGHT,
  RELEVANCE_WEIGHT,
  SCOPE_SCORE_CAP,
  SCOPE_WEIGHTS,
  combineRelevanceAndFit,
  rankRows,
  scoreRelevance,
  scopeNouns,
  scopeShortLabels,
} from "@/domain/searchRanking";

/* ============================== Фабрики ============================== */

function query(patch: Partial<ParsedQuery> = {}): ParsedQuery {
  return { terms: [], anyGroups: [], excluded: [], codes: [], phrase: null, ...patch };
}

function match(patch: Partial<MatchResult> = {}): MatchResult {
  return {
    matched: true,
    scopes: [],
    matchedTerms: [],
    matchedCodes: [],
    phraseMatched: false,
    excludedHit: false,
    ...patch,
  };
}

/* ============================== scoreRelevance ============================== */

describe("scoreRelevance", () => {
  it("пустой запрос даёт ноль и не выдумывает причин", () => {
    const result = scoreRelevance({ match: match(), query: query() });
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
    // Делить нечего: запрос без слов считается покрытым целиком, иначе на экране
    // появилось бы «совпало 0 из 0».
    expect(result.termCoverage).toBe(1);
  });

  it("совпадение в названии при полном покрытии слов", () => {
    const result = scoreRelevance({
      match: match({ scopes: ["subject"], matchedTerms: ["вентиля"] }),
      query: query({ terms: ["вентиля"] }),
    });
    expect(result.score).toBe(SCOPE_WEIGHTS.subject);
    expect(result.termCoverage).toBe(1);
    expect(result.reasons.map((r) => r.code)).toEqual(["subject"]);
    expect(result.reasons[0]?.label).toBe("Совпадение в названии закупки");
    expect(result.reasons[0]?.detail).toBe("вентиля");
  });

  it("частичное покрытие слов снижает балл и добавляет честную причину", () => {
    const result = scoreRelevance({
      match: match({
        scopes: ["subject"],
        matchedTerms: ["вентиля", "запорного"],
      }),
      query: query({ terms: ["вентиля", "запорного", "нержавеющей"] }),
    });
    // 40 · 2/3 = 26,67 → 27: округление проверяем отдельно от формулы.
    expect(result.score).toBe(Math.round((SCOPE_WEIGHTS.subject * 2) / 3));
    expect(result.termCoverage).toBeCloseTo(2 / 3);
    expect(result.reasons.map((r) => r.code)).toEqual(["subject", "partial"]);
    expect(result.reasons[1]?.label).toBe("Совпало 2 из 3 слов");
  });

  it("области ранжируются от названия к документации", () => {
    expect(SCOPE_WEIGHTS.subject).toBeGreaterThan(SCOPE_WEIGHTS.items);
    expect(SCOPE_WEIGHTS.items).toBeGreaterThan(SCOPE_WEIGHTS.documents);

    const onlyDocuments = scoreRelevance({
      match: match({ scopes: ["documents"], matchedTerms: ["вентиля"] }),
      query: query({ terms: ["вентиля"] }),
    });
    const onlySubject = scoreRelevance({
      match: match({ scopes: ["subject"], matchedTerms: ["вентиля"] }),
      query: query({ terms: ["вентиля"] }),
    });
    expect(onlyDocuments.score).toBeLessThan(onlySubject.score);
  });

  it("сумма областей не превышает потолок", () => {
    const result = scoreRelevance({
      match: match({
        scopes: ["subject", "items", "documents"],
        matchedTerms: ["вентиля"],
      }),
      query: query({ terms: ["вентиля"] }),
    });
    const uncapped =
      SCOPE_WEIGHTS.subject + SCOPE_WEIGHTS.items + SCOPE_WEIGHTS.documents;
    expect(uncapped).toBeGreaterThan(SCOPE_SCORE_CAP);
    expect(result.score).toBe(SCOPE_SCORE_CAP);
  });

  it("дословная фраза добавляет баллы и собственную причину", () => {
    const withPhrase = scoreRelevance({
      match: match({
        scopes: ["subject"],
        matchedTerms: [],
        phraseMatched: true,
      }),
      query: query({ phrase: "техническое обслуживание" }),
    });
    const withoutPhrase = scoreRelevance({
      match: match({ scopes: ["subject"], matchedTerms: [] }),
      query: query({ phrase: "техническое обслуживание" }),
    });
    expect(withPhrase.score - withoutPhrase.score).toBe(PHRASE_WEIGHT);
    expect(withPhrase.reasons[0]?.code).toBe("phrase");
    expect(withPhrase.reasons[0]?.label).toBe(
      "Фраза «техническое обслуживание» найдена целиком",
    );
  });

  it("совпадение по ОКПД2 считается сильным самостоятельным сигналом", () => {
    const result = scoreRelevance({
      match: match({ matchedCodes: ["30.01"] }),
      query: query({ codes: ["30.01"] }),
    });
    expect(result.score).toBe(CODE_WEIGHT);
    expect(result.reasons.map((r) => r.code)).toEqual(["okpd2"]);
    expect(result.reasons[0]?.label).toBe("ОКПД2 30.01");
  });

  it("несколько совпавших кодов перечисляются в подписи", () => {
    const result = scoreRelevance({
      match: match({ matchedCodes: ["30.01", "43.12"] }),
      query: query({ codes: ["30.01", "43.12"] }),
    });
    expect(result.reasons[0]?.label).toBe("ОКПД2 30.01, 43.12");
  });

  it("балл не выходит за 100 даже когда сработало всё сразу", () => {
    const result = scoreRelevance({
      match: match({
        scopes: ["subject", "items", "documents"],
        matchedTerms: ["вентиля"],
        matchedCodes: ["30.01"],
        phraseMatched: true,
      }),
      query: query({ terms: ["вентиля"], codes: ["30.01"], phrase: "вентиля" }),
    });
    expect(result.score).toBe(100);
  });

  it("отсеянная минус-словом закупка получает ноль без причин", () => {
    const result = scoreRelevance({
      match: match({
        scopes: ["subject"],
        matchedTerms: ["вентиля"],
        excludedHit: true,
        matched: false,
      }),
      query: query({ terms: ["вентиля"], excluded: ["ремонт"] }),
    });
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
    expect(result.termCoverage).toBe(0);
  });

  it("порядок причин фиксирован: фраза, название, объекты, документация, код, часть слов", () => {
    const result = scoreRelevance({
      match: match({
        scopes: ["documents", "items", "subject"],
        matchedTerms: ["вентиля"],
        matchedCodes: ["30.01"],
        phraseMatched: true,
      }),
      query: query({
        terms: ["вентиля", "латунного"],
        codes: ["30.01"],
        phrase: "вентиля",
      }),
    });
    expect(result.reasons.map((r) => r.code)).toEqual([
      "phrase",
      "subject",
      "items",
      "documents",
      "okpd2",
      "partial",
    ]);
  });

  it("подписи областей согласованы между причинами и переключателями", () => {
    expect(scopeShortLabels.subject).toBe("Название");
    expect(scopeShortLabels.items).toBe("Объекты закупки");
    expect(scopeShortLabels.documents).toBe("Документация");
    expect(scopeNouns.items).toBe("номенклатуре");
  });
});

/* ============================== combineRelevanceAndFit ============================== */

describe("combineRelevanceAndFit", () => {
  it("смешивает баллы в согласованной пропорции", () => {
    expect(RELEVANCE_WEIGHT).toBe(0.6);
    expect(FIT_WEIGHT).toBe(0.4);
    expect(combineRelevanceAndFit(100, 50)).toBe(80);
    expect(combineRelevanceAndFit(0, 100)).toBe(40);
    expect(combineRelevanceAndFit(50, 50)).toBe(50);
  });

  it("релевантность перевешивает Fit Score", () => {
    // Идеальная по профилю, но не по запросу закупка обязана уступить той,
    // что отвечает запросу и лишь наполовину подходит компании.
    const perfectFitWrongSubject = combineRelevanceAndFit(0, 100);
    const onTopicHalfFit = combineRelevanceAndFit(100, 50);
    expect(onTopicHalfFit).toBeGreaterThan(perfectFitWrongSubject);
  });

  it("без запроса порядок полностью определяется Fit Score", () => {
    expect(combineRelevanceAndFit(0, 73)).toBe(Math.round(73 * FIT_WEIGHT));
    expect(combineRelevanceAndFit(0, 90)).toBeGreaterThan(
      combineRelevanceAndFit(0, 73),
    );
  });

  it("результат остаётся в шкале 0..100", () => {
    expect(combineRelevanceAndFit(100, 100)).toBe(100);
    expect(combineRelevanceAndFit(0, 0)).toBe(0);
  });
});

/* ============================== rankRows ============================== */

interface FakeRow {
  id: string;
  relevanceScore: number;
  fitScore: number;
}

function relevanceOf(row: FakeRow) {
  return {
    score: row.relevanceScore,
    reasons: [],
    termCoverage: 1,
  };
}

describe("rankRows", () => {
  const rows: FakeRow[] = [
    { id: "a", relevanceScore: 0, fitScore: 100 },
    { id: "b", relevanceScore: 100, fitScore: 50 },
    { id: "c", relevanceScore: 45, fitScore: 80 },
    { id: "d", relevanceScore: 45, fitScore: 60 },
  ];

  it("сортирует по убыванию смешанного балла", () => {
    const ranked = rankRows(rows, relevanceOf, (row) => row.fitScore);
    expect(ranked.map((r) => r.row.id)).toEqual(["b", "c", "d", "a"]);
  });

  it("при равном смешанном балле решает релевантность, затем Fit Score", () => {
    const tied: FakeRow[] = [
      { id: "low-rel", relevanceScore: 20, fitScore: 100 },
      { id: "high-rel", relevanceScore: 100, fitScore: 20 },
    ];
    // 20·0,6 + 100·0,4 = 52 и 100·0,6 + 20·0,4 = 68 — здесь ничьей нет.
    // Ничья достигается парой с одинаковой суммой.
    expect(
      rankRows(tied, relevanceOf, (row) => row.fitScore).map((r) => r.row.id),
    ).toEqual(["high-rel", "low-rel"]);

    const realTie: FakeRow[] = [
      { id: "first", relevanceScore: 40, fitScore: 70 },
      { id: "second", relevanceScore: 60, fitScore: 40 },
    ];
    // 40·0,6 + 70·0,4 = 52 и 60·0,6 + 40·0,4 = 52 — равны, выигрывает
    // более релевантная.
    const ranked = rankRows(realTie, relevanceOf, (row) => row.fitScore);
    expect(ranked[0]?.combined).toBe(ranked[1]?.combined);
    expect(ranked.map((r) => r.row.id)).toEqual(["second", "first"]);
  });

  it("не мутирует исходный массив", () => {
    const source = [...rows];
    rankRows(source, relevanceOf, (row) => row.fitScore);
    expect(source.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("сохраняет в строке релевантность и Fit Score для объяснения", () => {
    const ranked = rankRows(rows, relevanceOf, (row) => row.fitScore);
    const first = ranked[0];
    expect(first?.row.id).toBe("b");
    expect(first?.relevance.score).toBe(100);
    expect(first?.fitScore).toBe(50);
    expect(first?.combined).toBe(80);
  });

  it("пустой вход даёт пустую выдачу", () => {
    expect(rankRows([], relevanceOf, (row) => row.fitScore)).toEqual([]);
  });
});
