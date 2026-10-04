# Модель данных

Полные TypeScript-типы: `src/domain/entities/index.ts`, enum-типы: `src/domain/enums/index.ts`, Zod-схемы: `src/domain/schemas/index.ts`.

## Основные сущности

| Сущность | Назначение | Ключевые поля |
| --- | --- | --- |
| `User` | Пользователь | id, email, fullName, role (`OWNER` в MVP), organizationId |
| `Organization` | Организация пользователя | id, name, inn |
| `CompanyProfile` | Профиль компании — вход для скоринга | legalName, inn, legalForm, taxSystem, worksWithVat, capabilities, restrictions, licenses, sroMemberships, hasPersonnel, hasEquipment, experience |
| `CompanyCapability` | Возможности | products, works, services, brandsAndModels, keywords, synonyms, stopWords, okpd2Codes |
| `CompanyRestriction` | Hard-ограничения и предпочтения | minPrice, maxPrice, maxDistanceKm, maxPaymentTermDays, minDeliveryTermDays, minMarginPercent, maxBidSecurity, maxContractSecurity, allowNoAdvance, workRegions, customerWhitelist/Blacklist, custom |
| `License` / `SroMembership` | Лицензии и допуски | kind/type, number, issuer, validUntil, confirmed |
| `ExperienceRecord` | Исполненный контракт | subject, customer, contractNumber, amount, completedAt, okpd2Code |
| `SearchProfile` | Профиль поиска | name, laws, keywords, stopWords, okpd2Codes, regions, minPrice, maxPrice, onlyOpenForSubmission, enabled |
| `Tender` | Закупка | regNumber, law, placingWay, subject, customerName/Inn, region, deliveryAddress, financial, deadlines, okpd2Codes, lots, requirements, documents, nationalRegime, onlyForSmp, eisUrl, dataSource, changeLog |
| `TenderFinancialTerms` | Финансы | price, advancePercent/Amount, paymentTermDays, postpaymentDays, bidSecurity*, contractSecurity*, treasurySupport, expectedMarginPercent |
| `TenderDeadline` | Сроки | submissionEnd, publicationDate, lastUpdateDate, deliveryTermDays, warrantyMonths |
| `TenderLot` | Лот | number, subject, price, okpd2Codes, deliveryRegion/Address, deliveryTermDays |
| `TenderRequirement` | Требование к участникам | kind, title, description, mandatory, requiredValue, evidenceId |
| `TenderDocument` | Документ | type, title, fileName, url, text, pageCount, lastModified |
| `TenderAnalysis` | Результат анализа | verdict, fitScore, confidence, summary, scores, positive/negativeFactors, hardBlockers, uncertainties, requirements, requiredDocuments, deadlines, financialTerms, contractRisks, nextActions, evidence, analyzedAt |
| `Evidence` | Доказательство вывода | source (`TENDER_DOCUMENT`/`COMPANY_PROFILE`/`AI_CONCLUSION`/`SYSTEM_RULE`), documentId/Title, page, section, quote, confidence |
| `HardBlocker` | Стоп-фактор | reason, detail, evidenceId, critical |
| `Uncertainty` | Неопределённость | question, detail, evidenceId, material |
| `ContractRisk` | Риск контракта | title, detail, severity (CRITICAL/HIGH/MEDIUM/LOW), evidenceId |
| `RequiredDocument` | Обязательный документ | title, confirmedInProfile |
| `PipelineItem` | Позиция воронки | tenderId, status, updatedAt, note |
| `Digest` | Ежедневный отчёт | date, totalNew, recommended[], manualReview[], closingSoon[], excluded[{tenderId, reason}], documentChanges[] |
| `DigestSettings` | Настройки уведомлений | enabled, sendTime, email, minFitScore, urgentEnabled, urgentDeadlineHours, documentChangesEnabled |
| `FeedbackEvent` | Обратная связь по вердикту | tenderId, verdict, useful, comment, createdAt |
| `ProcessingJob` | Фоновое задание | type, status, startedAt, finishedAt, progress, message, error |
| `Notification` | Уведомление | kind, title, body, createdAt, read |

## Статусы (union types)

- `TenderVerdict`: RECOMMENDED | MANUAL_REVIEW | NOT_RECOMMENDED
- `PipelineStatus`: NEW | INTERESTING | ANALYZING | PREPARING_APPLICATION | SUBMITTED | WON | LOST | SKIPPED
- `TenderLaw`: FZ_44 | FZ_223 | PP_RF_615
- `RiskSeverity`: CRITICAL | HIGH | MEDIUM | LOW
- `ProcessingJobStatus`: QUEUED | RUNNING | SUCCEEDED | FAILED

## Валидация

Zod-схема `tenderAnalysisSchema` соответствует разделу 14 ТЗ и проверяет каждый mock-результат анализа при генерации (`analyzeTender`). ИНН валидируется по контрольным числам (10/12 цифр, `isValidInn`).

## Хранение в MVP

localStorage-ключи (`src/lib/storage.ts`): `tf.companyProfile`, `tf.pipeline`, `tf.digestSettings`, `tf.feedback`, `tf.searchProfiles`, `tf.onboardingDraft`, `tf.onboardingDone`, `tf.auth`, `tf.jobs`, `tf.savedFilters`.
