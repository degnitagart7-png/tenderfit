# Схема результата AI-анализа (раздел 14 ТЗ)

Каждый результат анализа строго типизирован и валидируется Zod-схемой `tenderAnalysisSchema` (`src/domain/schemas/index.ts`). Свободный AI-текст без структурированных полей не выводится: `summary` дополняет поля, а не заменяет их.

```jsonc
{
  "verdict": "RECOMMENDED | MANUAL_REVIEW | NOT_RECOMMENDED",
  "fitScore": 0,          // 0..100, взвешенная сумма 5 показателей
  "confidence": 0,        // 0..1, уверенность анализа
  "summary": "",          // 1–3 предложения человеческим языком
  "scores": {
    "subjectFit": 0,      // 0..100
    "legalEligibility": 0,
    "operationalFit": 0,
    "financialFit": 0,
    "contractRisk": 0     // инвертируется в fitScore: 100 − risk
  },
  "positiveFactors": [],  // AnalysisFinding { id, text, evidenceId }
  "negativeFactors": [],
  "hardBlockers": [],     // { id, reason, detail, evidenceId, critical }
  "uncertainties": [],    // { id, question, detail, evidenceId, material }
  "requirements": [],     // TenderRequirement { kind, title, description, mandatory, requiredValue, evidenceId }
  "requiredDocuments": [],// { id, title, confirmedInProfile }
  "deadlines": {},        // TenderDeadline
  "financialTerms": {},   // TenderFinancialTerms
  "contractRisks": [],    // { id, title, detail, severity, evidenceId }
  "nextActions": [],      // string[] — что сделать пользователю
  "evidence": []          // { id, source, documentId, documentTitle, page, section, quote, confidence }
}
```

## Правила заполнения

- Каждый существенный вывод (`hardBlockers`, `uncertainties`, `contractRisks`, ключевые `positiveFactors`) ссылается на `evidenceId`; Evidence указывает документ, страницу/раздел, цитату и уровень уверенности (`HIGH`/`MEDIUM`/`LOW`).
- `hardBlocker.critical = true` — нарушено обязательное ограничение профиля компании → всегда `NOT_RECOMMENDED`.
- `uncertainty.material = true` — блокирует `RECOMMENDED`, переводит в `MANUAL_REVIEW`.
- `requiredDocuments[].confirmedInProfile` сверяется с профилем компании; неподтверждённый обязательный документ блокирует `RECOMMENDED`.
- `contractRisks[].severity ∈ CRITICAL|HIGH|MEDIUM|LOW`; наличие CRITICAL или HIGH блокирует `RECOMMENDED`.
- `nextActions` — конкретные шаги («проверить страну происхождения», «подготовить обеспечение»), не общие фразы.

## Как считается (mock-провайдер)

`analyzeTender()` в `src/adapters/tender-analysis/mockTenderAnalysisProvider.ts` — детерминированный конвейер:

1. `buildTenderText` — склейка предмета и текстов документов.
2. `analyzeContractRisks` — keyword-сканирование (односторонний отказ, казначейское сопровождение, независимая экспертиза, удержания при приёмке, неустойка 0,5%, обеспечение ≥ 30%, постоплата > 60 дней без аванса).
3. Пять показателей (`computeSubjectFit` и др.) → `computeFitScore` с инверсией риска.
4. `detectHardBlockers`, `detectUncertainties`, профильно-зависимые `requiredDocuments`.
5. Генерация Evidence, summary, nextActions.
6. `deriveVerdict` (пороги — в SPEC.md) → `tenderAnalysisSchema.parse()` — невалидный результат бросает исключение, а не уходит в UI.

При замене на LLM-провайдер схема остаётся контрактом: LLM обязана вернуть JSON той же формы, валидация Zod сохраняется.
